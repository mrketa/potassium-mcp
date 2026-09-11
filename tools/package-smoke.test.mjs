import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv, loadSmokeArtifact, parsePackageSmokeArgs, runPackageSmoke, verifySmokeArtifact } from "./package-smoke.mjs";
import { openSdkSmoke } from "./sdk-smoke.mjs";

test("same-version alternate tarball cannot inherit another artifact's smoke evidence", () => {
  const bytes = Buffer.from("package A at version 1.2.3");
  const metadata = { version: "1.2.3", sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  assert.deepEqual(verifySmokeArtifact(bytes, metadata), { sha256: metadata.sha256, integrity: metadata.integrity });
  assert.throws(() => verifySmokeArtifact(Buffer.from("package B at version 1.2.3"), metadata), /SHA-256/);
  assert.throws(() => verifySmokeArtifact(bytes, { ...metadata, integrity: "sha512-invalid" }), /integrity/);
});

test("smoke CLI preserves positional mode and tarball while strictly selecting metadata and output", () => {
  assert.deepEqual(parsePackageSmokeArgs(["soak", "candidate.tgz", "--npm-artifact", "candidate/NPM-ARTIFACT.json", "--output", "candidate/node22"]), {
    mode: "soak", tarball: "candidate.tgz", npmArtifact: "candidate/NPM-ARTIFACT.json", output: "candidate/node22",
  });
  assert.deepEqual(parsePackageSmokeArgs(["--npm-artifact", "candidate/NPM-ARTIFACT.json", "smoke", "--output", "candidate/node24"]), {
    npmArtifact: "candidate/NPM-ARTIFACT.json", mode: "smoke", output: "candidate/node24",
  });
  for (const args of [
    ["smoke", "--npm-artifact"], ["smoke", "--npm-artifact", "--output", "candidate"],
    ["smoke", "--npm-artifact", "a", "--npm-artifact", "b"],
    ["smoke", "--output", "a", "--output", "b"], ["smoke", "--output", ""],
    ["smoke", "--metadata", "a"], ["smoke", "a.tgz", "b.tgz"], ["unknown"],
  ]) assert.throws(() => parsePackageSmokeArgs(args));
});

test("invalid smoke API options and absent explicitly selected metadata cannot write evidence or fall back", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "potassium-smoke-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, "PACKAGE-SMOKE.json");
  await writeFile(evidence, "historical evidence");
  for (const options of [
    { output: directory, unknown: true }, { mode: "unsupported", output: directory },
    { output: "" }, { npmArtifact: "", output: directory },
  ]) await assert.rejects(runPackageSmoke(options));
  const npmArtifact = path.join(directory, "NPM-ARTIFACT.json");
  await assert.rejects(loadSmokeArtifact({ npmArtifact }), { code: "ENOENT" });
  await assert.rejects(loadSmokeArtifact({ npmArtifact, unknown: true }));
  assert.equal(await readFile(evidence, "utf8"), "historical evidence");
  assert.deepEqual(await readdir(directory), ["PACKAGE-SMOKE.json"]);
});

async function openHeaderSmoke(t, mutateHttpHeaders) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "potassium-sdk-headers-"));
  let harness;
  t.after(async () => {
    try { await harness?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const packageRoot = path.join(directory, "node_modules", "@mrketa", "potassium-mcp");
  await mkdir(path.dirname(packageRoot), { recursive: true });
  await symlink(fileURLToPath(new URL("../potassium-mcp/", import.meta.url)), packageRoot, process.platform === "win32" ? "junction" : "dir");
  const binDirectory = path.join(directory, "node_modules", ".bin");
  await mkdir(binDirectory);
  const entry = path.join(packageRoot, "bin", "potassium-mcp.js");
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(path.join(binDirectory, process.platform === "win32" ? "potassium-mcp.cmd" : "potassium-mcp"), process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`, { mode: 0o755 });
  const home = path.join(directory, "home");
  await mkdir(home);
  harness = await openSdkSmoke(packageRoot, directory, isolatedEnv(home), { mutateHttpHeaders });
  return harness;
}

test("HTTP probe cannot borrow stateless or initialize headers for stateful requests", async (t) => {
  let probing = false;
  let strippedStateful = 0;
  let validStateless = 0;
  const harness = await openHeaderSmoke(t, (mode, headers) => {
    if (!probing) return;
    if (mode === "http-stateful") {
      headers.delete("mcp-protocol-version");
      strippedStateful++;
    } else if (headers.get("mcp-protocol-version") === "2025-11-25") {
      validStateless++;
    }
  });
  probing = true;
  try {
    await assert.rejects(harness.probe(), (error) => {
      assert(error instanceof assert.AssertionError);
      assert.equal(error.operator, "strictEqual");
      assert.equal(error.actual, 0);
      assert(error.expected >= 3);
      return true;
    });
    assert(strippedStateful >= 3);
    assert(validStateless >= 3);
  } finally { probing = false; }
});

test("HTTP probes reject one missing header after a passing probe without retaining stale evidence", async (t) => {
  let dropsRemaining = 0;
  const harness = await openHeaderSmoke(t, (mode, headers) => {
    if (mode === "http-stateful" && dropsRemaining > 0) {
      headers.delete("mcp-protocol-version");
      dropsRemaining--;
    }
  });
  const assertProbeHeaders = (observations) => {
    assert.deepEqual(observations.map(({ mode }) => mode), ["stdio", "http-stateless", "http-stateful"]);
    for (const { mode, protocolHeader } of observations) {
      if (mode === "stdio") continue;
      assert.equal(protocolHeader.expected, "2025-11-25");
      assert(protocolHeader.postRequests >= 3);
      assert(protocolHeader.requests >= protocolHeader.postRequests);
      assert.equal(protocolHeader.matchingRequests, protocolHeader.requests);
    }
  };
  assertProbeHeaders(await harness.probe());
  dropsRemaining = 1;
  try {
    await assert.rejects(harness.probe(), (error) => {
      assert(error instanceof assert.AssertionError);
      assert.equal(error.operator, "strictEqual");
      assert(error.expected >= 3);
      assert.equal(error.actual, error.expected - 1);
      return true;
    });
    assert.equal(dropsRemaining, 0);
  } finally { dropsRemaining = 0; }
  assertProbeHeaders(await harness.probe());
});

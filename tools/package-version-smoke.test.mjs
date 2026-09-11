import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parsePackageVersionSmokeArgs, preparePackageVersionSmoke } from "./package-version-smoke.mjs";

// Manifest-only fixture archive: no npm command or distributable runtime involved.
function tarball(manifest) {
  const content = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512 + 1024)]));
}

async function fixture(t, packed = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "potassium-version-select-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = path.join(root, "candidate");
  await mkdir(selected);
  const manifest = { name: "@mrketa/potassium-mcp", version: "1.2.3-beta.1" };
  const bytes = tarball({ ...manifest, ...packed });
  const metadata = {
    ...manifest, filename: "candidate.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  const npmArtifact = path.join(selected, "NPM-ARTIFACT.json");
  const archive = path.join(selected, metadata.filename);
  await writeFile(npmArtifact, JSON.stringify(metadata));
  await writeFile(archive, bytes);
  await writeFile(`${archive}.sha256`, `${metadata.sha256}  ${metadata.filename}\n`);
  return { root, selected, bytes, metadata, archive, npmArtifact, output: path.join(root, "qualification", "node-current") };
}

test("version smoke requires both explicit selectors and refuses ambiguous CLI arguments", () => {
  assert.deepEqual(parsePackageVersionSmokeArgs(["--output", "candidate/results", "--npm-artifact", "candidate/NPM-ARTIFACT.json"]), {
    output: "candidate/results", npmArtifact: "candidate/NPM-ARTIFACT.json",
  });
  for (const args of [
    [], ["--npm-artifact", "candidate.json"], ["--output", "results"],
    ["--npm-artifact", "candidate.json", "--output"],
    ["--npm-artifact", " ", "--output", "results"],
    ["--npm-artifact", "--output", "results"],
    ["candidate.tgz", "--npm-artifact", "candidate.json", "--output", "results"],
    ["--npm-artifact", "candidate.json", "--output", "results", "--output", "other"],
    ["--npm-artifact", "candidate.json", "--output", "results", "--npm-artifact", "other.json"],
    ["--npm-artifact", "candidate.json", "--output", "results", "--unknown", "value"],
  ]) assert.throws(() => parsePackageVersionSmokeArgs(args), /Usage:/);
});

test("version preflight never falls back when selectors are incomplete or selected metadata is absent", async (t) => {
  const f = await fixture(t);
  for (const options of [
    undefined, null, [], {}, { npmArtifact: f.npmArtifact }, { output: f.output },
    { npmArtifact: "", output: f.output }, { npmArtifact: f.npmArtifact, output: " " },
    { npmArtifact: f.npmArtifact, output: f.output, tarball: f.archive },
  ]) await assert.rejects(preparePackageVersionSmoke(options, f.root), /requires explicit/);
  await assert.rejects(preparePackageVersionSmoke({ npmArtifact: path.join(f.selected, "missing.json"), output: f.output }, f.root), { code: "ENOENT" });
  assert.deepEqual(await readdir(f.root), ["candidate"]);
});

test("version preflight binds the selected identity and isolated report path without touching historical output", async (t) => {
  const f = await fixture(t);
  const historical = path.join(f.root, "release-out");
  await mkdir(historical);
  const originals = { "NPM-ARTIFACT.json": "historical metadata", "PACKAGE-VERSION-SMOKE.json": "historical evidence" };
  for (const [name, content] of Object.entries(originals)) await writeFile(path.join(historical, name), content);
  const selected = await preparePackageVersionSmoke({ npmArtifact: f.npmArtifact, output: f.output }, f.root);
  assert.deepEqual(selected.artifact, {
    npmArtifact: f.npmArtifact, tarball: f.archive, name: f.metadata.name, version: f.metadata.version,
    filename: f.metadata.filename, sha256: f.metadata.sha256, integrity: f.metadata.integrity,
  });
  assert.deepEqual(selected.tarballBytes, f.bytes);
  assert.equal(selected.reportPath, path.join(f.output, "PACKAGE-VERSION-SMOKE.json"));
  assert.equal(selected.destination, f.output);
  await assert.rejects(readFile(selected.reportPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(f.root), ["candidate", "release-out"]);
  for (const [name, content] of Object.entries(originals)) assert.equal(await readFile(path.join(historical, name), "utf8"), content);
});

test("version preflight rejects a missing or mismatched adjacent checksum and same-version replacement bytes", async (t) => {
  const f = await fixture(t);
  const options = { npmArtifact: f.npmArtifact, output: f.output };
  await rm(`${f.archive}.sha256`);
  await assert.rejects(preparePackageVersionSmoke(options, f.root), { code: "ENOENT" });
  await writeFile(`${f.archive}.sha256`, `${"0".repeat(64)}  ${f.metadata.filename}\n`);
  await assert.rejects(preparePackageVersionSmoke(options, f.root), /sidecar mismatch/);
  await writeFile(`${f.archive}.sha256`, `${f.metadata.sha256}  ${f.metadata.filename}\n`);
  await writeFile(f.archive, tarball({ name: f.metadata.name, version: f.metadata.version, description: "other bytes" }));
  await assert.rejects(preparePackageVersionSmoke(options, f.root), /checksum mismatch/);
  assert.deepEqual(await readdir(f.root), ["candidate"]);
});

test("version preflight requires archive manifest identity, not just valid receipt hashes", async (t) => {
  const f = await fixture(t, { version: "1.2.4-beta.1" });
  await assert.rejects(preparePackageVersionSmoke({ npmArtifact: f.npmArtifact, output: f.output }, f.root), /tarball name\/version/);
  assert.deepEqual(await readdir(f.root), ["candidate"]);
});

test("version output refuses source overlap, escapes, redirection and artifact overwrite without mutation", async (t) => {
  const f = await fixture(t);
  const options = { npmArtifact: f.npmArtifact };
  for (const output of [f.root, path.dirname(f.root), path.join(f.root, "tools", "evidence"), path.join(f.root, "potassium-mcp")]) {
    await assert.rejects(preparePackageVersionSmoke({ ...options, output }, f.root));
  }
  const linked = path.join(f.root, "redirected");
  await symlink(f.selected, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(preparePackageVersionSmoke({ ...options, output: path.join(linked, "evidence") }, f.root), /regular directories/);
  const reportPath = path.join(f.selected, "PACKAGE-VERSION-SMOKE.json");
  await mkdir(reportPath);
  await assert.rejects(preparePackageVersionSmoke({ ...options, output: f.selected }, f.root), /regular file/);
  await rm(reportPath, { recursive: true });
  const metadataBytes = await readFile(f.npmArtifact);
  await writeFile(reportPath, metadataBytes);
  await assert.rejects(preparePackageVersionSmoke({ npmArtifact: reportPath, output: f.selected }, f.root), /must not replace/);
  assert.deepEqual(await readFile(reportPath), metadataBytes);
  assert.deepEqual(await readFile(f.npmArtifact), metadataBytes);
  assert.deepEqual(await readFile(f.archive), f.bytes);
});

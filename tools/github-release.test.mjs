import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import { main, prepareReleaseSet, releaseAssetAction, validateDraftSelection, verifyReleaseSet } from "./github-release.mjs";
import { checkRelease } from "./release.mjs";
import { BUNDLE_ENTRIES, DOTNET_VERSION, NODE_SHA256, NODE_VERSION } from "./windows-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const identity = { sha: "a".repeat(40), ref: "v1.2.3", name: "@mrketa/potassium-mcp", version: "1.2.3" };
const digest = `sha256:${"a".repeat(64)}`;
const prepared = { bytes: 128, digest };

function npmTarball(manifest) {
  const content = Buffer.from(json(manifest));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512 + 1024)]));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(files, { method = 8, descriptor = false, transformCentral = () => {} } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, input] of Object.entries(files)) {
    const content = Buffer.from(input);
    const encoded = Buffer.from(name);
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const crc = crc32(content);
    const flags = 0x800 | (descriptor ? 8 : 0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    if (!descriptor) {
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(content.length, 22);
    }
    header.writeUInt16LE(encoded.length, 26);
    const receipt = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      receipt.writeUInt32LE(0x08074b50);
      receipt.writeUInt32LE(crc, 4);
      receipt.writeUInt32LE(compressed.length, 8);
      receipt.writeUInt32LE(content.length, 12);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(encoded.length, 28);
    record.writeUInt32LE(offset, 42);
    transformCentral(record, name);
    local.push(header, encoded, compressed, receipt);
    central.push(record, encoded);
    offset += header.length + encoded.length + compressed.length + receipt.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t, zipOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "potassium-release-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const directory = path.join(root, "public");
  const original = path.join(root, "original-windows");
  await mkdir(path.join(sourceRoot, "potassium-mcp/src"), { recursive: true });
  await mkdir(directory);
  await mkdir(original);
  const manifest = { name: identity.name, version: identity.version, dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } };
  const lock = { name: identity.name, version: identity.version, lockfileVersion: 3, packages: { "": manifest } };
  const sourceFiles = {
    "version.txt": `${identity.version}\n`,
    "potassium-mcp/package.json": json(manifest),
    "potassium-mcp/package-lock.json": json(lock),
    "potassium-mcp/src/proxy.js": "export const protocol = 'sealed-release-fixture';\n",
  };
  for (const [name, content] of Object.entries(sourceFiles)) await writeFile(path.join(sourceRoot, name), content);
  await writeFile(path.join(sourceRoot, "release-manifest.json"), json({ schemaVersion: 1, files: ["release-manifest.json", ...Object.keys(sourceFiles)] }));
  const source = await checkRelease(sourceRoot);
  await writeFile(path.join(directory, "RELEASE-EVIDENCE.json"), json(source));
  const npmBytes = npmTarball(manifest);
  const npm = {
    filename: `mrketa-potassium-mcp-${identity.version}.tgz`, name: identity.name, version: identity.version,
    integrity: `sha512-${createHash("sha512").update(npmBytes).digest("base64")}`, sha256: hash(npmBytes),
  };
  await writeFile(path.join(directory, npm.filename), npmBytes);
  await writeFile(path.join(directory, `${npm.filename}.sha256`), `${npm.sha256}  ${npm.filename}\n`);
  await writeFile(path.join(directory, "NPM-ARTIFACT.json"), json(npm));
  const setup = Buffer.alloc(4096, 7);
  setup.writeUInt16LE(0x5a4d);
  setup.writeUInt32LE(128, 0x3c);
  setup.writeUInt32LE(0x00004550, 128);
  setup.writeUInt16LE(0x8664, 132);
  setup.writeUInt16LE(0x20b, 152);
  const runtime = {
    schema: 1, packageVersion: identity.version, nodeVersion: NODE_VERSION, entries: BUNDLE_ENTRIES,
    files: [BUNDLE_ENTRIES.node, BUNDLE_ENTRIES.cli, BUNDLE_ENTRIES.launcher, `${BUNDLE_ENTRIES.packageRoot}/package.json`].map((name) => ({
      path: name, bytes: 4096, sha256: name === BUNDLE_ENTRIES.node ? NODE_SHA256 : hash(name),
    })),
  };
  const runtimeBytes = json(runtime);
  const inventory = {
    schema: 1, packageVersion: identity.version, nodeVersion: NODE_VERSION, nodeSha256: NODE_SHA256,
    dotnetVersion: DOTNET_VERSION, dotnetSdk: "8.0.404", dotnetRestore: "nuget", versionId: hash(runtimeBytes),
    npmArtifact: { filename: npm.filename, sha256: npm.sha256, integrity: npm.integrity }, packageLockSha256: hash(json(lock)),
    runtimeFiles: runtime.files.length, runtimeBytes: runtime.files.reduce((sum, file) => sum + file.bytes, 0),
    runtimeZipSha256: hash("embedded runtime ZIP fixture"), packages: [], dotnetPackages: [],
  };
  const distribution = {
    "BUNDLE-INVENTORY.json": json(inventory), "LICENSES/日本語-LICENSE.txt": "Licensed release fixture\n",
    "Setup.exe": setup, "runtime-bundle.manifest.json": runtimeBytes,
  };
  const zipName = `potassium-mcp-v${identity.version}-windows-setup.zip`;
  const zip = zipArchive(distribution, zipOptions);
  const windows = {
    ...inventory,
    distributionFiles: Object.entries(distribution).map(([name, bytes]) => ({ path: name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })),
    distributionZip: { path: zipName, bytes: zip.length, sha256: hash(zip) }, verification: "embedded-bundle",
    installedRuntimeRequirements: "Windows x64; no system Node, npm or .NET required",
    signing: "Unsigned local build; no Authenticode identity is claimed",
  };
  const qualification = {
    schemaVersion: 1, identity,
    signing: { mode: "unsigned", approved: true, setupStatus: "NotSigned" },
    artifacts: { npmSha256: npm.sha256, setupSha256: hash(setup), windowsZipSha256: hash(zip), windowsVersionId: windows.versionId },
    source: { proxySha256: source.files.find((file) => file.path === "potassium-mcp/src/proxy.js").sha256 },
    checks: {
      source: { passed: true }, node22: { passed: true, nodeVersion: "v22.23.2" }, node24: { passed: true, nodeVersion: "v24.13.0" },
      windows: { passed: true, fresh: true, restrictedUpgrade: true, repair: true, cancelledRemoval: true, remove: true, reinstall: true, coldCheck: true, nativeParser: true, clipboard: true, clipboardScope: "Isolated clipboard helper; no interactive desktop claim" },
      preservation: { passed: true }, rollback: { passed: true }, recovery: { passed: true }, maps: { passed: true },
      soak: { passed: true, elapsedMs: 1800000, requests: 3000, bootstrapCases: 30, p95Ms: 2000, limits: { durationMs: 1800000, heapGrowthBytes: 33554432, handlesGrowth: 8, p95Ms: 2000 } },
    },
    blockers: [], evidenceDigests: [{ id: "qualification-run", sha256: hash("private fixture report, not public raw output") }],
    limitations: ["Unsigned distribution approved explicitly"],
  };
  const sums = () => [...windows.distributionFiles, windows.distributionZip].map((file) => `${file.sha256}  ${file.path}\n`).join("");
  for (const [name, content] of Object.entries({ ...distribution, [zipName]: zip, "WINDOWS-SETUP.json": json(windows), "SHA256SUMS.txt": sums(), ".windows-release-output.json": "private ownership receipt\n" })) {
    await mkdir(path.dirname(path.join(original, name)), { recursive: true });
    await writeFile(path.join(original, name), content);
  }
  for (const name of ["Setup.exe", zipName, "WINDOWS-SETUP.json"]) await copyFile(path.join(original, name), path.join(directory, name));
  await copyFile(path.join(original, "SHA256SUMS.txt"), path.join(directory, "WINDOWS-SHA256SUMS.txt"));
  await writeFile(path.join(directory, "QUALIFICATION.json"), json(qualification));
  const calls = [];
  // Only the actual Windows process boundary is substituted. The production
  // archive reader, hash comparisons, manifests, source and npm gates all run.
  const options = { sourceRoot, windowsVerifier: async (temporary) => {
    calls.push(temporary);
    assert.notEqual(temporary, original);
    assert.notEqual(temporary, directory);
    assert.deepEqual(await readFile(path.join(temporary, "Setup.exe")), setup);
    assert.equal(await readFile(path.join(temporary, "SHA256SUMS.txt"), "utf8"), sums());
    const sealed = JSON.parse(await readFile(path.join(temporary, "BUNDLE-INVENTORY.json"), "utf8"));
    return { valid: true, packageVersion: sealed.packageVersion, versionId: sealed.versionId, npmArtifact: sealed.npmArtifact,
      packageLockSha256: sealed.packageLockSha256, setupSha256: hash(await readFile(path.join(temporary, "Setup.exe"))), distributionZip: zipName };
  } };
  const saveQualification = () => writeFile(path.join(directory, "QUALIFICATION.json"), json(qualification));
  const saveWindows = async (replacementZip = zip) => {
    windows.distributionZip.bytes = replacementZip.length;
    windows.distributionZip.sha256 = hash(replacementZip);
    qualification.artifacts.windowsZipSha256 = hash(replacementZip);
    await writeFile(path.join(directory, zipName), replacementZip);
    await writeFile(path.join(directory, "WINDOWS-SETUP.json"), json(windows));
    await writeFile(path.join(directory, "WINDOWS-SHA256SUMS.txt"), sums());
    await saveQualification();
  };
  return { root, sourceRoot, directory, original, source, npm, setup, zip, zipName, windows, distribution, qualification, options, calls, saveQualification, saveWindows };
}

async function snapshot(directory) {
  const files = {};
  async function visit(relative) {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else files[name] = hash(await readFile(path.join(directory, name)));
    }
  }
  await visit("");
  return files;
}

async function rejectBeforeExecution(f, pattern) {
  await assert.rejects(prepareReleaseSet(f.directory, identity, f.options), pattern);
  assert.equal(f.calls.length, 0, "Unqualified bytes must not reach Setup execution");
  await assert.rejects(readFile(path.join(f.directory, "RELEASE-SET.json")), { code: "ENOENT" });
}

test("only a positively failed empty starter in a draft may be replaced", () => {
  const existing = { id: 42, state: "starter", size: 0, digest: null };
  assert.equal(releaseAssetAction({ ...prepared, draft: true, existing }), "replace-failed-starter");
  for (const candidate of [
    { draft: false, existing }, { draft: undefined, existing }, { draft: true, existing: { ...existing, size: 1 } },
    { draft: true, existing: { ...existing, digest } }, { draft: true, existing: { ...existing, id: undefined } },
    { draft: true, existing: { ...existing, state: "unknown" } },
  ]) assert.throws(() => releaseAssetAction({ ...prepared, ...candidate }));
});

test("uploaded bytes are verified or retained, never replaced even in a draft", () => {
  const existing = { id: 42, state: "uploaded", size: prepared.bytes, digest };
  assert.equal(releaseAssetAction({ ...prepared, draft: true, existing }), "keep");
  assert.equal(releaseAssetAction({ ...prepared, draft: false, existing: { ...existing, digest: null } }), "verify-download");
  assert.throws(() => releaseAssetAction({ ...prepared, draft: true, existing: { ...existing, size: 0 } }), /differs/);
  assert.throws(() => releaseAssetAction({ ...prepared, draft: true, existing: { ...existing, digest: `sha256:${"b".repeat(64)}` } }), /differs/);
  assert.equal(releaseAssetAction({ ...prepared, draft: true }), "upload");
});

test("freshly uploaded starter is no longer disposable after reread", () => {
  const starter = { id: 42, state: "starter", size: 0, digest: null };
  assert.equal(releaseAssetAction({ ...prepared, draft: true, existing: starter }), "replace-failed-starter");
  const reread = { ...starter, state: "uploaded", size: 12 };
  assert.throws(() => releaseAssetAction({ ...prepared, draft: true, existing: reread }), /differs/);
});

test("sealed preparation and restoration preserve every original public and private Windows byte", async (t) => {
  const f = await fixture(t, { descriptor: true });
  const initial = await snapshot(f.directory);
  const originalWindows = await snapshot(f.original);
  const result = await prepareReleaseSet(f.directory, identity, f.options);
  const retained = await snapshot(f.directory);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.setSha256, retained["RELEASE-SET.json"]);
  assert.equal(result.files.some((file) => file.name === "RELEASE-SET.json"), false);
  for (const [name, sha256] of Object.entries(initial)) assert.equal(retained[name], sha256);
  assert.equal(result.qualification.artifacts.setupSha256, hash(f.setup));
  assert.equal(result.npm.integrity, f.npm.integrity);
  const verified = await verifyReleaseSet(f.directory, identity, { ...f.options, expectedSetSha256: result.setSha256 });
  assert.equal(verified.setSha256, result.setSha256);
  assert.deepEqual(await prepareReleaseSet(f.directory, identity, f.options), verified);
  assert.deepEqual(await snapshot(f.directory), retained);
  assert.deepEqual(await snapshot(f.original), originalWindows);
  for (const temporary of f.calls) await assert.rejects(readdir(temporary), { code: "ENOENT" });
});

test("verification needs an external digest and refuses a changed manifest before execution", async (t) => {
  const f = await fixture(t, { method: 0 });
  const result = await prepareReleaseSet(f.directory, identity, f.options);
  f.calls.length = 0;
  await assert.rejects(verifyReleaseSet(f.directory, identity, f.options), /external.*pin/);
  await writeFile(path.join(f.directory, "RELEASE-SET.json"), `${await readFile(path.join(f.directory, "RELEASE-SET.json"), "utf8")} `);
  await assert.rejects(verifyReleaseSet(f.directory, identity, { ...f.options, expectedSetSha256: result.setSha256 }), /external digest/);
  assert.equal(f.calls.length, 0);
});

test("manifest source and canonical membership remain gates even under a new valid digest", async (t) => {
  const f = await fixture(t);
  await prepareReleaseSet(f.directory, identity, f.options);
  const manifest = JSON.parse(await readFile(path.join(f.directory, "RELEASE-SET.json"), "utf8"));
  f.calls.length = 0;
  const changed = structuredClone(manifest);
  changed.identity.sha = "b".repeat(40);
  await writeFile(path.join(f.directory, "RELEASE-SET.json"), json(changed));
  await assert.rejects(verifyReleaseSet(f.directory, identity, { ...f.options, expectedSetSha256: hash(json(changed)) }), /another source/);
  const aliased = structuredClone(manifest);
  aliased.files[0].name = "../Setup.exe";
  await writeFile(path.join(f.directory, "RELEASE-SET.json"), json(aliased));
  await assert.rejects(verifyReleaseSet(f.directory, identity, { ...f.options, expectedSetSha256: hash(json(aliased)) }), /manifest paths/);
  assert.equal(f.calls.length, 0);
});

test("retained asset modification fails without rewriting the original set", async (t) => {
  const f = await fixture(t);
  const result = await prepareReleaseSet(f.directory, identity, f.options);
  const original = await readFile(path.join(f.directory, "RELEASE-SET.json"));
  await writeFile(path.join(f.directory, "Setup.exe"), Buffer.alloc(f.setup.length, 9));
  f.calls.length = 0;
  await assert.rejects(verifyReleaseSet(f.directory, identity, { ...f.options, expectedSetSha256: result.setSha256 }), /incomplete or changed/);
  await assert.rejects(prepareReleaseSet(f.directory, identity, f.options), /incomplete or changed/);
  assert.deepEqual(await readFile(path.join(f.directory, "RELEASE-SET.json")), original);
  assert.equal(f.calls.length, 0);
});

for (const filename of ["Setup.exe", "mrketa-potassium-mcp-1.2.3.tgz", "potassium-mcp-v1.2.3-windows-setup.zip", "RELEASE-EVIDENCE.json", "QUALIFICATION.json"]) {
  test(`missing required artifact ${filename} never reaches Setup`, async (t) => {
    const f = await fixture(t);
    await rm(path.join(f.directory, filename));
    await rejectBeforeExecution(f, /incomplete/);
  });
}

for (const filename of ["Setup.exe", "mrketa-potassium-mcp-1.2.3.tgz", "potassium-mcp-v1.2.3-windows-setup.zip"]) {
  test(`substituted artifact ${filename} cannot be attested by unchanged evidence`, async (t) => {
    const f = await fixture(t);
    await writeFile(path.join(f.directory, filename), "substituted artifact bytes");
    await rejectBeforeExecution(f, /checksum/);
  });
}

test("npm sidecar and embedded package identity are independently verified", async (t) => {
  const f = await fixture(t);
  const bytes = npmTarball({ name: identity.name, version: "9.9.9" });
  f.npm.sha256 = hash(bytes);
  f.npm.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await writeFile(path.join(f.directory, f.npm.filename), bytes);
  await writeFile(path.join(f.directory, "NPM-ARTIFACT.json"), json(f.npm));
  await rejectBeforeExecution(f, /sidecar/);
  await writeFile(path.join(f.directory, `${f.npm.filename}.sha256`), `${f.npm.sha256}  ${f.npm.filename}\n`);
  await rejectBeforeExecution(f, /tarball name\/version/);
});

test("source inventory and source lock roots bind the selected checkout", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "potassium-mcp/src/proxy.js"), "export const protocol = 'changed';\n");
  await rejectBeforeExecution(f, /source inventory/);
  await writeFile(path.join(f.directory, "RELEASE-EVIDENCE.json"), json(await checkRelease(f.sourceRoot)));
  await rejectBeforeExecution(f, /proxy source digest/);
  const lockPath = path.join(f.sourceRoot, "potassium-mcp/package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages[""].version = "2.0.0";
  await writeFile(lockPath, json(lock));
  await rejectBeforeExecution(f, /lock root identity/);
});

test("version.txt and selected canonical package identity must agree", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "version.txt"), "1.2.4\n");
  await rejectBeforeExecution(f, /version.txt/);
  for (const changed of [{ version: "01.2.3", ref: "v01.2.3" }, { version: "1.2.3-rc.1", ref: "v1.2.3-rc.1" }, { ref: "v1.2.4" }, { sha: "main" }, { name: "@other/package" }]) {
    await assert.rejects(prepareReleaseSet(f.directory, { ...identity, ...changed }, f.options));
  }
});

function selectEssentialWindows(qualification) {
  Object.assign(qualification.checks.windows, {
    scope: "essential",
    userApproval: "User selected only essential manual installer checks, not the expanded Windows acceptance matrix.",
    adminStartup: true,
    normalLauncher: true,
    clipboardScope: "Not exercised in the user-selected essential scope.",
    limitations: {
      restrictedUpgrade: "Restricted upgrade not exercised in the selected manual scope.",
      cancelledRemoval: "Removal cancellation not exercised in the selected manual scope.",
      remove: "Confirmed removal not exercised in the selected manual scope.",
      reinstall: "Retained reinstall not exercised in the selected manual scope.",
      nativeParser: "Installed Windows native parser path not exercised in the selected manual scope.",
      clipboard: "GUI clipboard handlers not exercised in the selected manual scope.",
    },
  });
  for (const name of Object.keys(qualification.checks.windows.limitations)) qualification.checks.windows[name] = false;
}

test("essential Windows scope retains omitted checks and reasons through sealed preparation and verification", async (t) => {
  const f = await fixture(t);
  selectEssentialWindows(f.qualification);
  await f.saveQualification();
  const original = await readFile(path.join(f.directory, "QUALIFICATION.json"));
  const result = await prepareReleaseSet(f.directory, identity, f.options);
  const verified = await verifyReleaseSet(f.directory, identity, { ...f.options, expectedSetSha256: result.setSha256 });
  assert.deepEqual(verified.qualification.checks.windows, f.qualification.checks.windows);
  assert.deepEqual(await readFile(path.join(f.directory, "QUALIFICATION.json")), original);
});

const essentialWindowsFailures = [
  ...["passed", "fresh", "repair", "coldCheck", "adminStartup", "normalLauncher"].map((name) => [
    `failed required ${name}`, (q) => { q.checks.windows[name] = false; }, /Windows.*did not pass/,
  ]),
  ["missing startup observation", (q) => { delete q.checks.windows.adminStartup; }, /Windows.*missing or unknown fields/],
  ["missing legacy result", (q) => { delete q.checks.windows.remove; }, /Windows.*missing or unknown fields/],
  ["nonboolean omitted result", (q) => { q.checks.windows.clipboard = "false"; }, /clipboard must be boolean/],
  ["missing user approval", (q) => { delete q.checks.windows.userApproval; }, /Windows.*missing or unknown fields/],
  ["blank user approval", (q) => { q.checks.windows.userApproval = " "; }, /user approval/],
  ["oversized user approval", (q) => { q.checks.windows.userApproval = "x".repeat(1025); }, /user approval/],
  ["unlisted omission", (q) => { delete q.checks.windows.limitations.clipboard; }, /limitations/],
  ["invented omission", (q) => { q.checks.windows.limitations.other = "Not exercised"; }, /limitations/],
  ["passed check listed as omitted", (q) => { q.checks.windows.clipboard = true; }, /limitations/],
  ["blank omission reason", (q) => { q.checks.windows.limitations.clipboard = " "; }, /limitation reasons/],
  ["oversized omission reason", (q) => { q.checks.windows.limitations.clipboard = "x".repeat(1025); }, /limitation reasons/],
  ["private approval text", (q) => { q.checks.windows.userApproval = "See C:\\Users\\private\\approval.json"; }, /local path/],
  ["failed non-Windows preservation", (q) => { q.checks.preservation.passed = false; }, /preservation/],
  ["short essential soak", (q) => { q.checks.soak.elapsedMs--; }, /elapsedMs/],
];
for (const [name, mutate, expected] of essentialWindowsFailures) {
  test(`essential qualification rejects ${name} before Setup execution`, async (t) => {
    const f = await fixture(t);
    selectEssentialWindows(f.qualification);
    mutate(f.qualification);
    await f.saveQualification();
    await rejectBeforeExecution(f, expected);
  });
}

const qualificationFailures = [
  ["short soak", (q) => { q.checks.soak.elapsedMs--; }, /elapsedMs/],
  ["request minimum", (q) => { q.checks.soak.requests--; }, /requests/],
  ["bootstrap minimum", (q) => { q.checks.soak.bootstrapCases--; }, /bootstrapCases/],
  ["slow p95", (q) => { q.checks.soak.p95Ms++; }, /p95Ms/],
  ["weakened limits", (q) => { q.checks.soak.limits.heapGrowthBytes++; }, /limits/],
  ["invented heap measurement", (q) => { q.checks.soak.heapGrowthBytes = 0; }, /unknown fields/],
  ["blocker", (q) => { q.blockers.push("repair failed"); }, /blockers/],
  ["missing unsigned approval", (q) => { delete q.signing.approved; }, /signing/],
  ["claimed signature", (q) => { q.signing.setupStatus = "Valid"; }, /unsigned/],
  ["artifact substitution", (q) => { q.artifacts.setupSha256 = "b".repeat(64); }, /artifact digest/],
  ["missing Windows evidence", (q) => { delete q.checks.windows.repair; }, /Windows/],
  ["failed full Windows clipboard", (q) => { q.checks.windows.clipboard = false; }, /Windows clipboard did not pass/],
  ["failed explicit full Windows result", (q) => { q.checks.windows.scope = "full"; q.checks.windows.remove = false; }, /Windows remove did not pass/],
  ["unknown Windows scope", (q) => { q.checks.windows.scope = "minimal"; }, /Windows scope is unknown/],
  ["failed rollback", (q) => { q.checks.rollback.passed = false; }, /rollback/],
  ["wrong Node runtime", (q) => { q.checks.node24.nodeVersion = "v22.23.2"; }, /Node 24/],
  ["unbounded clipboard scope", (q) => { q.checks.windows.clipboardScope = "x".repeat(513); }, /clipboard scope/],
  ["private local path", (q) => { q.limitations = ["Retained at C:\\Users\\private\\run.json"]; }, /local path/],
  ["credential leak", (q) => { q.limitations = [`Bearer ${"x".repeat(32)}`]; }, /secret/],
  ["unsafe evidence label", (q) => { q.evidenceDigests[0].id = "raw/run.json"; }, /unsafe label/],
  ["missing evidence hash", (q) => { q.evidenceDigests = []; }, /evidence digests/],
];
for (const [name, mutate, expected] of qualificationFailures) {
  test(`qualification rejects ${name} before Setup execution`, async (t) => {
    const f = await fixture(t);
    mutate(f.qualification);
    await f.saveQualification();
    await rejectBeforeExecution(f, expected);
  });
}

for (const name of ["private.log", "PACKAGE-SMOKE.json", "Setup.exe.", "other.zip"]) {
  test(`ambient asset ${name} is rejected rather than silently ignored`, async (t) => {
    const f = await fixture(t);
    if (name.endsWith(".") && process.platform === "win32") {
      await rename(path.join(f.directory, "Setup.exe"), path.join(f.directory, "setup.exe"));
    } else await writeFile(path.join(f.directory, name), "private or aliased data");
    await rejectBeforeExecution(f, /extra or aliased/);
  });
}

test("hardlinked public files are rejected even when bytes match", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.directory, "Setup.exe"));
  await link(path.join(f.original, "Setup.exe"), path.join(f.directory, "Setup.exe"));
  await rejectBeforeExecution(f, /unlinked file/);
});

test("stage directory junctions cannot redirect qualification or generated writes", async (t) => {
  const f = await fixture(t);
  const redirected = path.join(f.root, "redirected");
  await symlink(f.directory, redirected, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareReleaseSet(redirected, identity, f.options), /links or aliases/);
  assert.equal(f.calls.length, 0);
});

test("rehashed ZIP cannot hide corrupted members behind an honest outer digest", async (t) => {
  const f = await fixture(t);
  const changed = { ...f.distribution, "Setup.exe": Buffer.alloc(f.setup.length, 5) };
  await f.saveWindows(zipArchive(changed));
  await rejectBeforeExecution(f, /member checksum/);
});

test("rehashed ZIP cannot traverse outside the private extraction root", async (t) => {
  const f = await fixture(t);
  const changed = { ...f.distribution };
  delete changed["LICENSES/日本語-LICENSE.txt"];
  changed["../escaped.txt"] = "Licensed release fixture\n";
  await f.saveWindows(zipArchive(changed));
  await rejectBeforeExecution(f, /Noncanonical/);
  await assert.rejects(readFile(path.join(f.root, "escaped.txt")), { code: "ENOENT" });
});

test("ZIP links and deceptive expanded sizes are rejected before extraction execution", async (t) => {
  const f = await fixture(t);
  await f.saveWindows(zipArchive(f.distribution, { transformCentral: (record, name) => {
    if (name === "Setup.exe") record.writeUInt32LE(0xa0000000, 38);
  } }));
  await rejectBeforeExecution(f, /linked or nonregular/);
  await f.saveWindows(zipArchive(f.distribution, { transformCentral: (record, name) => {
    if (name === "Setup.exe") record.writeUInt32LE(0x7fffffff, 24);
  } }));
  await rejectBeforeExecution(f, /size-mismatched/);
});

test("sealed inventory runtime identity is checked before the executable boundary", async (t) => {
  const f = await fixture(t);
  const inventory = JSON.parse(f.distribution["BUNDLE-INVENTORY.json"]);
  inventory.packageLockSha256 = "b".repeat(64);
  f.distribution["BUNDLE-INVENTORY.json"] = json(inventory);
  const entry = f.windows.distributionFiles.find((file) => file.path === "BUNDLE-INVENTORY.json");
  entry.sha256 = hash(json(inventory));
  entry.bytes = Buffer.byteLength(json(inventory));
  await f.saveWindows(zipArchive(f.distribution));
  await rejectBeforeExecution(f, /sealed bundle inventory identity/);
});

test("failed actual Setup qualification leaves no manifest or private reconstruction behind", async (t) => {
  const f = await fixture(t);
  let temporary;
  f.options.windowsVerifier = async (directory) => { temporary = directory; throw new Error("actual embedded bundle rejected"); };
  await assert.rejects(prepareReleaseSet(f.directory, identity, f.options), /actual embedded bundle rejected/);
  await assert.rejects(readdir(temporary), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.directory, "RELEASE-SET.json")), { code: "ENOENT" });
});

test("existing generated checksum conflicts are never overwritten", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "Setup.exe.sha256"), "retained conflicting checksum\n");
  await assert.rejects(prepareReleaseSet(f.directory, identity, f.options), /refusing to replace/);
  assert.equal(await readFile(path.join(f.directory, "Setup.exe.sha256"), "utf8"), "retained conflicting checksum\n");
  await assert.rejects(readFile(path.join(f.directory, "RELEASE-SET.json")), { code: "ENOENT" });
});

const draftSelection = () => ({ repository: "mrketa/potassium-mcp", sourceSha: identity.sha, identity,
  release: { id: 42, tag_name: identity.ref, target_commitish: identity.sha, draft: true, prerelease: false, published_at: null } });

test("draft selection binds repository, canonical tag and immutable source commit", () => {
  assert.equal(validateDraftSelection(draftSelection()).draft, true);
  for (const change of [
    { repository: "other/potassium-mcp" }, { release: null }, { sourceSha: "b".repeat(40) },
    { release: { ...draftSelection().release, url: "https://api.github.com/repos/other/potassium-mcp/releases/42" } },
    { release: { ...draftSelection().release, target_commitish: "main" } },
    { release: { ...draftSelection().release, tag_name: "v1.2.4" } },
    { release: { ...draftSelection().release, prerelease: true } },
    { release: { ...draftSelection().release, draft: undefined } },
  ]) assert.throws(() => validateDraftSelection({ ...draftSelection(), ...change }));
});

test("published recovery is explicit and cannot bypass source, tag or asset immutability", () => {
  const selection = draftSelection();
  selection.release.draft = false;
  selection.release.published_at = "2026-09-11T10:00:00Z";
  assert.throws(() => validateDraftSelection(selection), /requires a draft/);
  assert.equal(validateDraftSelection({ ...selection, allowPublishedRecovery: true }).publishedRecovery, true);
  assert.throws(() => validateDraftSelection({ ...selection, allowPublishedRecovery: "true" }), /boolean/);
  assert.throws(() => validateDraftSelection({ ...selection, allowPublishedRecovery: true, release: { ...selection.release, target_commitish: "b".repeat(40) } }), /target/);
  assert.throws(() => releaseAssetAction({ ...prepared, draft: false, existing: { id: 42, state: "starter", size: 0, digest: null } }), /failed draft upload/);
});

test("CLI rejects missing, duplicate, ambient and meaningless options before filesystem work", async () => {
  for (const args of [[], ["publish"], ["prepare"], ["verify", "--directory"], ["prepare", "--directory", "x", "--directory", "y"],
    ["prepare", "--set-sha256", "a".repeat(64)], ["verify", "--sourceRoot", "x"], ["prepare", "--directory", "x", "--source-sha", identity.sha]]) {
    await assert.rejects(main(args));
  }
});

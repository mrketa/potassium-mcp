import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { validateNpmArtifact } from "../potassium-mcp/release-publish.js";
import { checkRelease, projectRoot } from "./release.mjs";
import { checkWindows, safeBundlePath, validateBundleManifest, NODE_SHA256, NODE_VERSION, DOTNET_VERSION } from "./windows-release.mjs";

const hashPattern = /^[a-f0-9]{64}$/;
const digestBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const limits = { metadata: 8 * 1024 * 1024, file: 512 * 1024 * 1024, total: 1024 * 1024 * 1024, files: 25000 };
const soakLimits = { durationMs: 1800000, heapGrowthBytes: 33554432, handlesGrowth: 8, p95Ms: 2000 };

function keys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or unknown fields`);
}

function validateIdentity(identity) {
  keys(identity, ["sha", "ref", "name", "version"], "Release identity");
  assert(typeof identity.sha === "string" && /^[a-f0-9]{40}$/.test(identity.sha), "Release identity requires immutable source SHA");
  assert(typeof identity.version === "string" && identity.version.length <= 128
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.version)
    && identity.version.split(".").every((part) => Number.isSafeInteger(Number(part))), "Release version must be canonical stable X.Y.Z");
  assert.equal(identity.name, "@mrketa/potassium-mcp", "Unexpected release package");
  assert.equal(identity.ref, `v${identity.version}`, "Release tag differs from canonical version");
}

function publicNames(identity) {
  const npm = `mrketa-potassium-mcp-${identity.version}.tgz`;
  const zip = `potassium-mcp-v${identity.version}-windows-setup.zip`;
  const required = [npm, `${npm}.sha256`, "NPM-ARTIFACT.json", "Setup.exe", zip, "WINDOWS-SETUP.json", "WINDOWS-SHA256SUMS.txt", "RELEASE-EVIDENCE.json", "QUALIFICATION.json"].sort(compare);
  const generated = ["Setup.exe.sha256", `${zip}.sha256`, "SHA256SUMS.txt"];
  return { npm, zip, required, generated, all: [...required, ...generated].sort(compare) };
}

async function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  const base = path.parse(absolute).root;
  let current = base;
  for (const part of ["", ...absolute.slice(base.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = await lstat(current);
    const actual = await realpath(current);
    const same = process.platform === "win32" ? actual.toLowerCase() === current.toLowerCase() : actual === current;
    assert(info.isDirectory() && !info.isSymbolicLink() && same, "Release directory must not traverse links or aliases");
  }
  return absolute;
}

async function regularFile(filename, maximum = limits.file) {
  const info = await lstat(filename);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "Release asset must be a regular unlinked file");
  assert(Number.isSafeInteger(info.size) && info.size > 0 && info.size <= maximum, "Release asset exceeds its byte bounds");
  return info;
}

async function recordFile(directory, name) {
  const filename = path.join(directory, name);
  const info = await regularFile(filename, name.endsWith(".zip") ? limits.total : /\.(json|txt|sha256)$/.test(name) ? limits.metadata : limits.file);
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filename)) { digest.update(chunk); size += chunk.length; }
  assert.equal(size, info.size, "Release asset changed while reading");
  return { name, bytes: size, sha256: digest.digest("hex") };
}

async function stageRecords(directory, names, prepared) {
  const actual = (await readdir(directory)).sort(compare);
  const permitted = new Set([...names.all, "RELEASE-SET.json"]);
  assert(actual.every((name) => permitted.has(name)), "Release set contains an extra or aliased asset");
  const mandatory = prepared ? [...names.all, "RELEASE-SET.json"] : names.required;
  assert(mandatory.every((name) => actual.includes(name)), "Release asset set is incomplete");
  if (actual.includes("RELEASE-SET.json")) await regularFile(path.join(directory, "RELEASE-SET.json"), limits.metadata);
  return Promise.all(actual.filter((name) => name !== "RELEASE-SET.json").map((name) => recordFile(directory, name)));
}

async function readJson(directory, name) {
  await regularFile(path.join(directory, name), limits.metadata);
  return JSON.parse(await readFile(path.join(directory, name), "utf8"));
}

function publicText(value, label) {
  if (typeof value === "string") {
    assert(value.length <= limits.metadata && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), `${label} contains unsafe text`);
    assert(!/(?:(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?:^|[\s"'=(])\/(?:[^\s/]+\/)|file:\/\/|\bBearer\s+\S+|\b(?:gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_]{16,}|\b(?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*\S+)/i.test(value), `${label} contains a local path or secret`);
  } else if (Array.isArray(value)) {
    for (const item of value) publicText(item, label);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert(!/^(?:token|secret|password|passwd|api[_-]?key|authorization)$/i.test(key), `${label} contains a secret field`);
      publicText(item, label);
    }
  }
}

async function sourceIdentity(root, identity) {
  root = await canonicalDirectory(root);
  await canonicalDirectory(path.join(root, "potassium-mcp"));
  const metadata = await readJson(path.join(root, "potassium-mcp"), "package.json");
  const lock = await readJson(path.join(root, "potassium-mcp"), "package-lock.json");
  await regularFile(path.join(root, "version.txt"), 256);
  const version = (await readFile(path.join(root, "version.txt"), "utf8")).trim();
  assert.equal(metadata.name, identity.name, "Current source package name mismatch");
  assert.equal(metadata.version, identity.version, "Current source package version mismatch");
  assert.equal(version, identity.version, "version.txt does not match the release");
  assert.equal(lock.lockfileVersion, 3, "Current source lock must be schema 3");
  for (const entry of [lock, lock.packages?.[""]]) {
    assert(entry && entry.name === identity.name && entry.version === identity.version, "Current source lock root identity mismatch");
  }
  assert.deepEqual(lock.packages[""].dependencies, metadata.dependencies, "Current source lock dependencies mismatch");
  const source = await checkRelease(root);
  for (const name of ["version.txt", "potassium-mcp/package.json", "potassium-mcp/package-lock.json", "potassium-mcp/src/proxy.js"]) {
    assert(source.files.some((file) => file.path === name), "Current source inventory lacks required identity files");
  }
  return { source, lockSha256: digestBytes(await readFile(path.join(root, "potassium-mcp/package-lock.json"))) };
}

function validateQualification(value, identity, npm, windows, source) {
  keys(value, ["schemaVersion", "identity", "signing", "artifacts", "source", "checks", "blockers", "evidenceDigests", "limitations"], "Qualification");
  assert.equal(value.schemaVersion, 1, "Qualification schema mismatch");
  assert.deepEqual(value.identity, identity, "Qualification source identity mismatch");
  keys(value.signing, ["mode", "approved", "setupStatus"], "Qualification signing");
  assert.deepEqual(value.signing, { mode: "unsigned", approved: true, setupStatus: "NotSigned" }, "Explicit unsigned approval and NotSigned status are required");
  keys(value.artifacts, ["npmSha256", "setupSha256", "windowsZipSha256", "windowsVersionId"], "Qualification artifacts");
  assert.deepEqual(value.artifacts, {
    npmSha256: npm.sha256, setupSha256: windows.distributionFiles.find((file) => file.path === "Setup.exe").sha256,
    windowsZipSha256: windows.distributionZip.sha256, windowsVersionId: windows.versionId,
  }, "Qualification artifact digest mismatch");
  keys(value.source, ["proxySha256"], "Qualification source");
  assert.equal(value.source.proxySha256, source.files.find((file) => file.path === "potassium-mcp/src/proxy.js").sha256, "Qualification proxy source digest mismatch");
  keys(value.checks, ["source", "node22", "node24", "windows", "preservation", "rollback", "recovery", "maps", "soak"], "Qualification checks");
  for (const name of ["source", "preservation", "rollback", "recovery", "maps"]) {
    keys(value.checks[name], ["passed"], `Qualification ${name}`);
    assert.equal(value.checks[name].passed, true, `Qualification ${name} did not pass`);
  }
  for (const major of [22, 24]) {
    const node = value.checks[`node${major}`];
    keys(node, ["passed", "nodeVersion"], `Qualification Node ${major}`);
    assert(node.passed === true && typeof node.nodeVersion === "string" && new RegExp(`^v${major}\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`).test(node.nodeVersion), `Qualification Node ${major} did not pass on the required runtime`);
  }
  const windowsChecks = ["passed", "fresh", "restrictedUpgrade", "repair", "cancelledRemoval", "remove", "reinstall", "coldCheck", "nativeParser", "clipboard"];
  keys(value.checks.windows, [...windowsChecks, "clipboardScope"], "Qualification Windows");
  for (const name of windowsChecks) assert.equal(value.checks.windows[name], true, `Qualification Windows ${name} did not pass`);
  assert(typeof value.checks.windows.clipboardScope === "string" && value.checks.windows.clipboardScope.trim().length > 0 && value.checks.windows.clipboardScope.length <= 512, "Qualification clipboard scope must be bounded nonempty text");
  const soak = value.checks.soak;
  keys(soak, ["passed", "elapsedMs", "requests", "bootstrapCases", "p95Ms", "limits"], "Qualification soak");
  assert.equal(soak.passed, true, "Qualification soak did not pass");
  assert.deepEqual(soak.limits, soakLimits, "Qualification soak limits mismatch");
  for (const [name, minimum] of [["elapsedMs", soakLimits.durationMs], ["requests", 3000], ["bootstrapCases", 30]]) {
    assert(Number.isSafeInteger(soak[name]) && soak[name] >= minimum, `Qualification soak ${name} is below its required minimum`);
  }
  assert(Number.isFinite(soak.p95Ms) && soak.p95Ms >= 0 && soak.p95Ms <= soakLimits.p95Ms, "Qualification soak p95Ms exceeds its limit");
  assert(Array.isArray(value.blockers) && value.blockers.length === 0, "Qualification has unresolved blockers");
  assert(Array.isArray(value.evidenceDigests) && value.evidenceDigests.length > 0 && value.evidenceDigests.length <= 128, "Qualification requires bounded evidence digests");
  const ids = new Set();
  for (const evidence of value.evidenceDigests) {
    keys(evidence, ["id", "sha256"], "Qualification evidence digest");
    assert(typeof evidence.id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(evidence.id) && !ids.has(evidence.id) && hashPattern.test(evidence.sha256), "Qualification evidence digest has an unsafe label or invalid digest");
    ids.add(evidence.id);
  }
  assert(Array.isArray(value.limitations) && value.limitations.length <= 32 && value.limitations.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 1024), "Qualification limitations must be bounded public text");
  publicText(value, "Qualification");
}

const inventoryKeys = ["schema", "packageVersion", "nodeVersion", "nodeSha256", "dotnetVersion", "dotnetSdk", "dotnetRestore", "versionId", "npmArtifact", "packageLockSha256", "runtimeFiles", "runtimeBytes", "runtimeZipSha256", "packages", "dotnetPackages"];

function validateWindowsEvidence(windows, names, identity, npm, lockSha256, records) {
  keys(windows, [...inventoryKeys, "distributionFiles", "distributionZip", "verification", "installedRuntimeRequirements", "signing"], "Windows evidence");
  assert(windows && windows.schema === 1 && windows.packageVersion === identity.version && windows.nodeVersion === NODE_VERSION
    && windows.nodeSha256 === NODE_SHA256 && windows.dotnetVersion === DOTNET_VERSION && hashPattern.test(windows.versionId)
    && hashPattern.test(windows.runtimeZipSha256), "Windows sealed identity mismatch");
  assert.equal(windows.signing, "Unsigned local build; no Authenticode identity is claimed", "Windows unsigned policy mismatch");
  assert.equal(windows.verification, "embedded-bundle", "Windows embedded qualification is required");
  assert.deepEqual(windows.npmArtifact, { filename: npm.filename, sha256: npm.sha256, integrity: npm.integrity }, "Windows npm artifact identity mismatch");
  assert.equal(windows.packageLockSha256, lockSha256, "Windows source lock digest mismatch");
  assert(typeof windows.dotnetSdk === "string" && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(windows.dotnetSdk)
    && ["nuget", "sha512-verified-local-feed"].includes(windows.dotnetRestore), "Windows toolchain evidence mismatch");
  assert(Number.isSafeInteger(windows.runtimeFiles) && windows.runtimeFiles > 0 && windows.runtimeFiles <= limits.files
    && Number.isSafeInteger(windows.runtimeBytes) && windows.runtimeBytes > 0 && windows.runtimeBytes <= limits.total, "Windows runtime inventory exceeds its bounds");
  assert(typeof windows.installedRuntimeRequirements === "string" && windows.installedRuntimeRequirements.length <= 512, "Windows runtime requirements must be bounded public text");
  for (const [name, fields] of [["packages", ["name", "version", "path", "integrity", "license", "licenseFiles"]], ["dotnetPackages", ["name", "version", "integrity", "licenseFiles"]]]) {
    assert(Array.isArray(windows[name]) && windows[name].length <= limits.files, "Windows dependency inventory exceeds its bounds");
    for (const dependency of windows[name]) {
      keys(dependency, fields, "Windows dependency");
      assert(typeof dependency.name === "string" && dependency.name.length > 0 && dependency.name.length <= 256
        && typeof dependency.version === "string" && dependency.version.length > 0 && dependency.version.length <= 128
        && typeof dependency.integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(dependency.integrity), "Windows dependency identity mismatch");
      if (name === "packages") {
        safeBundlePath(dependency.path);
        assert(dependency.path.startsWith("app/node_modules/") && (dependency.license === null || typeof dependency.license === "string"), "Windows npm dependency metadata mismatch");
      }
      assert(Array.isArray(dependency.licenseFiles) && dependency.licenseFiles.length > 0 && dependency.licenseFiles.length <= 128, "Windows dependency license inventory is missing or oversized");
      for (const license of dependency.licenseFiles) safeBundlePath(license);
    }
  }
  assert(Array.isArray(windows.distributionFiles) && windows.distributionFiles.length >= 4 && windows.distributionFiles.length <= limits.files, "Windows distribution inventory is missing or oversized");
  const seen = new Set();
  let total = 0;
  for (const file of [...windows.distributionFiles, windows.distributionZip]) {
    keys(file, ["path", "bytes", "sha256"], "Windows distribution record");
    safeBundlePath(file.path);
    assert(!seen.has(file.path.toLowerCase()) && Number.isSafeInteger(file.bytes) && file.bytes > 0
      && file.bytes <= (file === windows.distributionZip ? limits.total : limits.file) && hashPattern.test(file.sha256), "Invalid or aliased Windows distribution record");
    seen.add(file.path.toLowerCase());
    if (file !== windows.distributionZip) {
      assert(["Setup.exe", "BUNDLE-INVENTORY.json", "runtime-bundle.manifest.json"].includes(file.path) || file.path.startsWith("LICENSES/"), "Windows ZIP contains a nonpublic distribution member");
      total += file.bytes;
      assert(total <= limits.total, "Windows ZIP extraction exceeds its total byte bound");
      if (file.path.endsWith(".json")) assert(file.bytes <= limits.metadata, "Windows metadata exceeds its byte bound");
    }
  }
  for (const name of seen) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) assert(!seen.has(parts.slice(0, index).join("/")), "Windows distribution file/directory alias");
  }
  for (const required of ["Setup.exe", "BUNDLE-INVENTORY.json", "runtime-bundle.manifest.json"]) assert(windows.distributionFiles.some((file) => file.path === required), "Windows ZIP lacks a required sealed member");
  assert(windows.distributionFiles.some((file) => file.path.startsWith("LICENSES/")), "Windows ZIP lacks bundled licenses");
  assert.equal(windows.distributionZip.path, names.zip, "Windows ZIP name differs from canonical version");
  for (const file of [windows.distributionZip, windows.distributionFiles.find((entry) => entry.path === "Setup.exe")]) {
    const actual = records.find((entry) => entry.name === file.path);
    assert(actual && actual.bytes === file.bytes && actual.sha256 === file.sha256, "Setup or Windows ZIP checksum differs from sealed evidence");
  }
  publicText(windows, "Windows evidence");
}

// Parse the central directory before any extraction. No shell archiver, entry
// execution, links, directory entries, encryption, ZIP64 or unbounded expansion.
function zipEntries(bytes, expected) {
  assert(bytes.length >= 22 && bytes.length <= limits.total, "Windows ZIP is truncated or oversized");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  assert(end >= 0, "Windows ZIP end record is missing");
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  assert(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count
    && count === expected.length && count < 65535 && start + size === end, "Windows ZIP central directory mismatch");
  const wanted = new Map(expected.map((file) => [file.path, file]));
  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index++) {
    assert(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, "Windows ZIP central entry is truncated");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    assert(next <= end && flags >>> 12 === 0 && (flags & ~0x808) === 0 && [0, 8].includes(method)
      && bytes.readUInt16LE(offset + 34) === 0 && compressed !== 0xffffffff && expanded !== 0xffffffff && local !== 0xffffffff,
    "Windows ZIP has unsupported encryption, compression, flags or ZIP64");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    assert(Buffer.from(name, "utf8").equals(nameBytes), "Windows ZIP filename is not valid UTF-8");
    safeBundlePath(name);
    const unixType = (attributes >>> 16) & 0xf000;
    assert((attributes & 0x410) === 0 && [0, 0x8000].includes(unixType), "Windows ZIP member is linked or nonregular");
    const record = wanted.get(name);
    assert(record && expanded === record.bytes, "Windows ZIP has unexpected, duplicate or size-mismatched members");
    wanted.delete(name);
    assert(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags
      && bytes.readUInt16LE(local + 8) === method && bytes.readUInt16LE(local + 26) === nameLength, "Windows ZIP local header mismatch");
    const dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    const dataEnd = dataStart + compressed;
    assert(dataEnd <= start && bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes), "Windows ZIP member escapes its data bounds");
    let memberEnd = dataEnd;
    if (flags & 8) {
      assert(memberEnd + 12 <= start, "Windows ZIP data descriptor is truncated");
      if (bytes.readUInt32LE(memberEnd) === 0x08074b50) memberEnd += 4;
      assert(memberEnd + 12 <= start && bytes.readUInt32LE(memberEnd) === crc && bytes.readUInt32LE(memberEnd + 4) === compressed
        && bytes.readUInt32LE(memberEnd + 8) === expanded, "Windows ZIP data descriptor mismatch");
      memberEnd += 12;
    } else {
      assert(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === expanded, "Windows ZIP local size or checksum mismatch");
    }
    entries.push({ record, method, crc, local, dataStart, dataEnd, memberEnd });
    offset = next;
  }
  assert(offset === end && wanted.size === 0, "Windows ZIP central inventory is incomplete");
  let previous = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    assert.equal(entry.local, previous, "Windows ZIP contains overlapping or unlisted local members");
    previous = entry.memberEnd;
  }
  assert.equal(previous, start, "Windows ZIP contains unlisted trailing data");
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = byte & 1 ? 0xedb88320 ^ (byte >>> 1) : byte >>> 1;
  return byte >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function unsignedWindowsVerifier(directory) {
  assert.equal(process.platform, "win32", "Sealed Setup qualification requires Windows");
  const script = "$ErrorActionPreference = 'Stop'; (Get-AuthenticodeSignature -LiteralPath $env:POTASSIUM_RELEASE_SETUP).Status.ToString()";
  const status = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, POTASSIUM_RELEASE_SETUP: path.join(directory, "Setup.exe") },
  }).trim();
  assert.equal(status, "NotSigned", "Actual Setup Authenticode status violates the approved unsigned policy");
  return checkWindows(directory);
}

async function verifySealedWindows(directory, windows, windowsVerifier) {
  const bytes = await readFile(path.join(directory, windows.distributionZip.path));
  assert.equal(digestBytes(bytes), windows.distributionZip.sha256, "Windows ZIP changed before extraction");
  const entries = zipEntries(bytes, windows.distributionFiles);
  await canonicalDirectory(tmpdir());
  const temporary = await mkdtemp(path.join(tmpdir(), "potassium-release-check-"));
  try {
    for (const { record, method, crc, dataStart, dataEnd } of entries) {
      const compressed = bytes.subarray(dataStart, dataEnd);
      const content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: record.bytes });
      assert(content.length === record.bytes && digestBytes(content) === record.sha256 && crc32(content) === crc, "Windows ZIP member checksum mismatch");
      const target = path.join(temporary, record.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
    const manifestBytes = await readFile(path.join(temporary, "runtime-bundle.manifest.json"));
    assert.equal(digestBytes(manifestBytes), windows.versionId, "Windows runtime manifest digest mismatch");
    const manifest = JSON.parse(manifestBytes);
    validateBundleManifest(manifest);
    assert.equal(manifest.packageVersion, windows.packageVersion, "Windows runtime package mismatch");
    const inventory = await readJson(temporary, "BUNDLE-INVENTORY.json");
    publicText(inventory, "Windows bundle inventory");
    keys(inventory, inventoryKeys, "Windows sealed bundle inventory");
    for (const name of inventoryKeys) {
      assert.deepEqual(inventory[name], windows[name], "Windows sealed bundle inventory identity mismatch");
    }
    assert.equal(inventory.runtimeFiles, manifest.files.length, "Windows runtime file count mismatch");
    assert.equal(inventory.runtimeBytes, manifest.files.reduce((sum, file) => sum + file.bytes, 0), "Windows runtime byte count mismatch");
    await writeFile(path.join(temporary, windows.distributionZip.path), bytes, { flag: "wx" });
    await copyFile(path.join(directory, "WINDOWS-SETUP.json"), path.join(temporary, "WINDOWS-SETUP.json"));
    await copyFile(path.join(directory, "WINDOWS-SHA256SUMS.txt"), path.join(temporary, "SHA256SUMS.txt"));
    const verified = await windowsVerifier(temporary);
    assert(verified?.valid === true && verified.packageVersion === windows.packageVersion && verified.versionId === windows.versionId
      && verified.setupSha256 === windows.distributionFiles.find((file) => file.path === "Setup.exe").sha256
      && verified.distributionZip === windows.distributionZip.path && verified.packageLockSha256 === windows.packageLockSha256,
    "Actual Setup verification differs from the sealed release identity");
    assert.deepEqual(verified.npmArtifact, windows.npmArtifact, "Actual Setup npm identity mismatch");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validateStage(directory, identity, names, records, { sourceRoot = projectRoot, windowsVerifier = unsignedWindowsVerifier } = {}) {
  const metadata = await readJson(directory, "NPM-ARTIFACT.json");
  keys(metadata, ["filename", "name", "version", "integrity", "sha256"], "Npm artifact");
  assert.equal(metadata.filename, names.npm, "Npm artifact filename differs from canonical release");
  const { tarball, ...npm } = await validateNpmArtifact(path.join(directory, "NPM-ARTIFACT.json"), identity);
  const { source: currentSource, lockSha256 } = await sourceIdentity(sourceRoot, identity);
  const source = await readJson(directory, "RELEASE-EVIDENCE.json");
  assert.deepEqual(source, currentSource, "Release source inventory differs from the selected current source");
  publicText(source, "Source evidence");
  const windows = await readJson(directory, "WINDOWS-SETUP.json");
  validateWindowsEvidence(windows, names, identity, npm, lockSha256, records);
  const sums = [...windows.distributionFiles, windows.distributionZip].map((file) => `${file.sha256}  ${file.path}\n`).join("");
  assert.equal(await readFile(path.join(directory, "WINDOWS-SHA256SUMS.txt"), "utf8"), sums, "Original Windows checksum inventory mismatch");
  const qualification = await readJson(directory, "QUALIFICATION.json");
  validateQualification(qualification, identity, npm, windows, source);
  await verifySealedWindows(directory, windows, windowsVerifier);
  return { npm: { ...npm, tag: "latest" }, windows, qualification, source };
}

function derivedFiles(names, records) {
  const byName = new Map(records.map((file) => [file.name, file]));
  const result = new Map();
  for (const name of ["Setup.exe", names.zip]) result.set(`${name}.sha256`, `${byName.get(name).sha256}  ${name}\n`);
  const withSidecars = [...records.filter((file) => !names.generated.includes(file.name)), ...[...result].map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: digestBytes(content) }))].sort((a, b) => compare(a.name, b.name));
  result.set("SHA256SUMS.txt", withSidecars.map((file) => `${file.sha256}  ${file.name}\n`).join(""));
  return result;
}

function optionsCheck(options, verify) {
  assert(options && typeof options === "object" && !Array.isArray(options)
    && Object.keys(options).every((key) => ["sourceRoot", "windowsVerifier", ...(verify ? ["expectedSetSha256"] : [])].includes(key)), "Unknown release verification option");
  assert(options.sourceRoot === undefined || typeof options.sourceRoot === "string", "Invalid source root");
  assert(options.windowsVerifier === undefined || typeof options.windowsVerifier === "function", "Invalid Windows verifier");
}

export async function prepareReleaseSet(directory, identity, options = {}) {
  validateIdentity(identity);
  optionsCheck(options, false);
  directory = await canonicalDirectory(directory);
  const names = publicNames(identity);
  const records = await stageRecords(directory, names, false);
  if ((await readdir(directory)).includes("RELEASE-SET.json")) {
    const expectedSetSha256 = (await recordFile(directory, "RELEASE-SET.json")).sha256;
    return verifyReleaseSet(directory, identity, { ...options, expectedSetSha256 });
  }
  const derived = derivedFiles(names, records);
  for (const [name, content] of derived) {
    if (records.some((file) => file.name === name)) assert.equal(await readFile(path.join(directory, name), "utf8"), content, "Existing release checksum differs; refusing to replace it");
  }
  const report = await validateStage(directory, identity, names, records, options);
  assert.deepEqual(await stageRecords(directory, names, false), records, "Release assets changed during qualification");
  for (const [name, content] of derived) {
    if (!records.some((file) => file.name === name)) await writeFile(path.join(directory, name), content, { flag: "wx" });
  }
  const files = await stageRecords(directory, names, false);
  assert.deepEqual(files.map((file) => file.name), names.all, "Prepared release membership mismatch");
  const expectedFiles = [...records.filter((file) => !names.generated.includes(file.name)), ...[...derived].map(([name, value]) => ({ name, bytes: Buffer.byteLength(value), sha256: digestBytes(value) }))].sort((a, b) => compare(a.name, b.name));
  assert.deepEqual(files, expectedFiles, "Release assets changed while preparing the manifest");
  const manifest = { schemaVersion: 2, identity, files };
  const content = json(manifest);
  await writeFile(path.join(directory, "RELEASE-SET.json"), content, { flag: "wx" });
  return { ...manifest, ...report, setSha256: digestBytes(content) };
}

export async function verifyReleaseSet(directory, identity, options = {}) {
  validateIdentity(identity);
  optionsCheck(options, true);
  assert(typeof options.expectedSetSha256 === "string" && hashPattern.test(options.expectedSetSha256), "Verification requires an external release-set SHA256 pin");
  directory = await canonicalDirectory(directory);
  await regularFile(path.join(directory, "RELEASE-SET.json"), limits.metadata);
  const content = await readFile(path.join(directory, "RELEASE-SET.json"));
  const setSha256 = digestBytes(content);
  assert.equal(setSha256, options.expectedSetSha256, "Release-set external digest mismatch");
  const manifest = JSON.parse(content);
  keys(manifest, ["schemaVersion", "identity", "files"], "Release-set manifest");
  assert.equal(manifest.schemaVersion, 2, "Release-set schema must be 2");
  assert.deepEqual(manifest.identity, identity, "Retained release set belongs to another source/tag/version");
  const names = publicNames(identity);
  assert(Array.isArray(manifest.files) && manifest.files.length === names.all.length, "Release-set manifest membership mismatch");
  for (const file of manifest.files) {
    keys(file, ["name", "bytes", "sha256"], "Release-set file record");
    assert(typeof file.name === "string" && Number.isSafeInteger(file.bytes) && file.bytes > 0 && hashPattern.test(file.sha256), "Invalid release-set file record");
  }
  assert.deepEqual(manifest.files.map((file) => file.name), names.all, "Release-set contains missing, extra or aliased manifest paths");
  const files = await stageRecords(directory, names, true);
  assert.deepEqual(files, manifest.files, "Retained release asset set is incomplete or changed");
  for (const [name, expected] of derivedFiles(names, files)) assert.equal(await readFile(path.join(directory, name), "utf8"), expected, "Release checksum content mismatch");
  const report = await validateStage(directory, identity, names, files, options);
  assert.deepEqual(await stageRecords(directory, names, true), files, "Release assets changed during qualification");
  assert.equal(digestBytes(await readFile(path.join(directory, "RELEASE-SET.json"))), setSha256, "Release-set changed during verification");
  return { ...manifest, ...report, setSha256 };
}

export function validateDraftSelection({ repository, release, sourceSha, identity, allowPublishedRecovery = false }) {
  validateIdentity(identity);
  assert.equal(repository, "mrketa/potassium-mcp", "Draft selection repository mismatch");
  assert.equal(sourceSha, identity.sha, "Draft source SHA differs from release identity");
  assert(release && Number.isSafeInteger(release.id) && release.id > 0, "A selected GitHub release is required");
  if (release.url !== undefined) assert.equal(release.url, `https://api.github.com/repos/${repository}/releases/${release.id}`, "Selected release belongs to another repository");
  assert.equal(release.tag_name, identity.ref, "Selected draft tag/version mismatch");
  assert.equal(release.target_commitish, sourceSha, "Selected draft target must be the exact source commit");
  assert.equal(release.prerelease, false, "Stable release must not be marked prerelease");
  assert(typeof allowPublishedRecovery === "boolean", "Published recovery must be explicitly boolean");
  const draft = release.draft === true && release.published_at == null;
  const recovery = allowPublishedRecovery === true && release.draft === false && typeof release.published_at === "string" && Number.isFinite(Date.parse(release.published_at));
  assert(draft || recovery, "Preparation requires a draft; published recovery requires explicit approval");
  return { releaseId: release.id, draft, publishedRecovery: recovery, identity };
}

// GitHub may retain a zero-byte "starter" asset after a failed upload.
// Only an unpublished draft's positively identified failed starter is disposable.
export function releaseAssetAction({ draft, existing, bytes, digest }) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid prepared release asset identity");
  if (!existing) return "upload";
  if (existing.state === "starter") {
    if (draft === true && existing.size === 0 && existing.digest == null && Number.isSafeInteger(existing.id) && existing.id > 0) return "replace-failed-starter";
    throw new Error("Existing starter asset is not a positively identified failed draft upload");
  }
  if (existing.state !== "uploaded") throw new Error("Existing asset has an unsupported upload state");
  if (existing.size !== bytes || (existing.digest != null && existing.digest !== digest)) throw new Error("Existing uploaded asset differs from prepared bytes");
  return existing.digest == null ? "verify-download" : "keep";
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  assert(["prepare", "verify"].includes(command), "Usage: github-release.mjs prepare|verify --directory D --source-sha SHA --ref vX.Y.Z [--set-sha256 HASH]");
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert(["--directory", "--source-sha", "--ref", ...(command === "verify" ? ["--set-sha256"] : [])].includes(name)
      && !Object.hasOwn(values, name) && typeof args[index + 1] === "string" && args[index + 1].trim() && !args[index + 1].startsWith("--"), "Unknown, duplicate or missing release option");
    values[name] = args[index + 1];
  }
  for (const name of ["--directory", "--source-sha", "--ref", ...(command === "verify" ? ["--set-sha256"] : [])]) assert(Object.hasOwn(values, name), `Missing release option ${name}`);
  const metadata = await readJson(path.join(projectRoot, "potassium-mcp"), "package.json");
  const identity = { sha: values["--source-sha"], ref: values["--ref"], name: metadata.name, version: metadata.version };
  return command === "prepare" ? prepareReleaseSet(values["--directory"], identity)
    : verifyReleaseSet(values["--directory"], identity, { expectedSetSha256: values["--set-sha256"] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((result) => console.log(json(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNpmArtifact } from "../potassium-mcp/release-publish.js";
import { selectPublicFiles } from "./release.mjs";
import { verifyParserHost } from "./parser-host.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NODE_VERSION = "22.23.2";
export const NODE_SHA256 = "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4";
export const DOTNET_VERSION = "8.0.30";
const dotnetArchivePins = Object.freeze([
  ["microsoft.netcore.app.runtime.win-x64", "sha512-7oiBHBIHoEFHkA0jHGrhg9CJ0EegAG5RJMazYl3EEYN7g0b0d7BLzGNCVqtNl+stACQxjQuHsYkmsS8SFABJVg=="],
  ["microsoft.windowsdesktop.app.runtime.win-x64", "sha512-5xYRfW9lhAgCrHMhT3EJVUvd+IILYayjRRHChzEo1AYrSg2VK04mqNodtI/IAagdCLvXwS1d1Dc8qmye0d4KdA=="],
  ["microsoft.net.illink.tasks", "sha512-q8cwD52JNMGzYXGT3KLES6Aoi77QM8DfgGoDeHeJAhmsXcWxyMb0m4ultGeU0QeG7pO4meD9pr/M7ieUF7Il+w=="],
  ["microsoft.aspnetcore.app.runtime.win-x64", "sha512-lC0XlOWsbeFLRPYYIQym85TR+pv5r3GBbGNtr8tu/af0CEGt+D75UQJdoNjyqdZNLAIUhnoF3TW4xbtZ7g7tPQ=="],
]);
export const BUNDLE_ENTRIES = Object.freeze({
  node: "node/node.exe",
  packageRoot: "app/node_modules/@mrketa/potassium-mcp",
  cli: "app/node_modules/@mrketa/potassium-mcp/bin/potassium-mcp.js",
  launcher: "launcher/PotassiumMcp.Launcher.exe",
});
const limits = { files: 25000, fileBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, manifestBytes: 8 * 1024 * 1024 };
const defaultOutput = path.join(root, "release-out", "windows-setup");
const defaultNpmArtifact = path.join(root, "release-out", "NPM-ARTIFACT.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function cachedDotnetFeed(temporary) {
  const archives = [];
  for (const [name, integrity] of dotnetArchivePins) {
    const filename = `${name}.${DOTNET_VERSION}.nupkg`;
    const source = path.join(os.homedir(), ".nuget", "packages", name, DOTNET_VERSION, filename);
    try {
      const info = await regularFile(source);
      if (info.size > limits.fileBytes) throw new Error(`Cached .NET archive exceeds its size limit: ${name}`);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    archives.push({ source, filename, integrity });
  }
  const feed = path.join(temporary, "dotnet-feed");
  await mkdir(feed);
  for (const archive of archives) {
    const bytes = await readFile(archive.source);
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== archive.integrity) throw new Error(`Cached .NET archive integrity mismatch: ${archive.filename}`);
    await writeFile(path.join(feed, archive.filename), bytes);
  }
  return feed;
}

export function safeBundlePath(value) {
  if (typeof value !== "string" || !value || /[\\:\x00-\x1f\x7f<>"|?*]/.test(value)
      || value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Noncanonical Windows bundle path: ${value}`);
  }
  return value;
}

export function validateBundleManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || typeof manifest.packageVersion !== "string" || !manifest.packageVersion
      || manifest.nodeVersion !== NODE_VERSION || !manifest.entries || Object.keys(manifest.entries).length !== Object.keys(BUNDLE_ENTRIES).length
      || Object.entries(BUNDLE_ENTRIES).some(([name, value]) => manifest.entries[name] !== value)
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > limits.files) {
    throw new Error("Invalid schema-1 Windows runtime bundle manifest");
  }
  const seen = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    const name = safeBundlePath(file.path).toLowerCase();
    if (seen.has(name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0 || file.bytes > limits.fileBytes) throw new Error(`Invalid or duplicate bundle record: ${file.path}`);
    seen.add(name);
    bytes += file.bytes;
    if (bytes > limits.totalBytes) throw new Error("Runtime bundle exceeds its total byte limit");
  }
  for (const name of seen) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (seen.has(parts.slice(0, index).join("/"))) throw new Error(`Bundle file/directory alias: ${name}`);
    }
  }
  for (const required of [BUNDLE_ENTRIES.node, BUNDLE_ENTRIES.cli, BUNDLE_ENTRIES.launcher, `${BUNDLE_ENTRIES.packageRoot}/package.json`]) {
    if (!manifest.files.some((file) => file.path === required)) throw new Error(`Missing required runtime entry: ${required}`);
  }
  if (manifest.files.find((file) => file.path === BUNDLE_ENTRIES.node).sha256 !== NODE_SHA256) throw new Error("Runtime Node checksum differs from the immutable pin");
  return { files: seen.size, bytes };
}

async function regularFile(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${filename}`);
  return stat;
}

async function digestFile(filename) {
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(filename)) sha.update(chunk);
  return sha.digest("hex");
}

export async function inventoryTree(directory) {
  const records = [];
  const seen = new Set();
  let totalBytes = 0;
  async function visit(relative) {
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Links/reparse points are not distributable: ${relative}`);
    if (relative) {
      safeBundlePath(relative);
      const folded = relative.toLowerCase();
      if (seen.has(folded)) throw new Error(`Windows path alias: ${relative}`);
      seen.add(folded);
    }
    if (stat.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort(compare)) await visit(relative ? `${relative}/${entry}` : entry);
    } else if (stat.isFile()) {
      totalBytes += stat.size;
      if (stat.size > limits.fileBytes || totalBytes > limits.totalBytes || records.length >= limits.files) throw new Error("Runtime bundle exceeds its resource limits");
      records.push({ path: relative, sha256: await digestFile(absolute), bytes: stat.size });
    } else throw new Error(`Nonregular bundle entry: ${relative}`);
  }
  await visit("");
  return records.sort((a, b) => compare(a.path, b.path));
}

export async function verifyTree(directory, records) {
  const actual = await inventoryTree(directory);
  const expected = [...records].sort((a, b) => compare(a.path, b.path));
  if (actual.length !== expected.length || actual.some((file, index) => {
    const record = expected[index];
    return file.path !== record.path || file.bytes !== record.bytes || file.sha256 !== record.sha256;
  })) {
    throw new Error("Runtime tree contents differ from the verified manifest");
  }
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(program)} failed (${result.error?.message ?? result.status}):\n${result.stderr ?? ""}\n${result.stdout ?? ""}`);
  return result.stdout;
}

function powershell(script, environment = {}) {
  return run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64")], { env: { ...process.env, ...environment } });
}

// File names are passed as UTF-8 JSON, never through the active ANSI code page.
const zipScript = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$spec = [IO.File]::ReadAllText($env:POTASSIUM_ZIP_SPEC, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($env:POTASSIUM_ZIP_MODE -eq 'create') {
  $zip = [IO.Compression.ZipFile]::Open($spec.archive, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $spec.files) {
      $entry = $zip.CreateEntry($file.path, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $entry.ExternalAttributes = 0
      $inputStream = [IO.File]::OpenRead([IO.Path]::Combine($spec.base, $file.path.Replace('/', [IO.Path]::DirectorySeparatorChar)))
      $outputStream = $entry.Open()
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
}
$expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
foreach ($file in $spec.files) { $expected.Add($file.path, $file) }
$zip = [IO.Compression.ZipFile]::OpenRead($spec.archive)
try {
  if ($zip.Entries.Count -ne $expected.Count) { throw 'ZIP entry count differs from its inventory' }
  foreach ($entry in $zip.Entries) {
    if (-not $expected.ContainsKey($entry.FullName)) { throw 'Unexpected or duplicate ZIP entry' }
    $file = $expected[$entry.FullName]
    if ($entry.Length -ne $file.bytes) { throw 'ZIP entry length mismatch' }
    $inputStream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $inputStream.Dispose() }
    if ($digest -cne $file.sha256) { throw 'ZIP entry checksum mismatch' }
    $expected.Remove($entry.FullName) | Out-Null
  }
} finally { $zip.Dispose() }
`;

async function archive(directory, filename, files, temporary, mode = "create") {
  const spec = path.join(temporary, "zip-spec.json");
  await writeFile(spec, json({ base: directory, archive: filename, files }));
  powershell(zipScript, { POTASSIUM_ZIP_SPEC: spec, POTASSIUM_ZIP_MODE: mode });
}

async function download(url, destination, expectedSha256) {
  await assertCanonicalPath(destination);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: "error" });
  if (!response.ok) throw new Error(`Required payload download failed: ${url} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > limits.fileBytes || expectedSha256 && hash(bytes) !== expectedSha256) throw new Error(`Downloaded payload failed verification: ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await assertCanonicalPath(destination);
  await writeFile(destination, bytes, { flag: "wx" });
}

async function ensurePinnedNode() {
  const executable = path.join(root, ".cache", `node-v${NODE_VERSION}`, "node.exe");
  await assertCanonicalPath(executable);
  try { await regularFile(executable); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`, executable, NODE_SHA256);
  }
  if (await digestFile(executable) !== NODE_SHA256) throw new Error(`Cached Node ${NODE_VERSION} fails its immutable SHA-256 pin; remove the corrupt cache explicitly`);
  if (run(executable, ["--version"]).trim() !== `v${NODE_VERSION}`) throw new Error("Pinned Node reports an unexpected version");
  return executable;
}

async function npmToolchain() {
  const cli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await regularFile(cli).catch(() => { throw new Error("Build-time npm is required. Run with a full Node/npm installation or set npm_execpath to npm-cli.js. Installed runtime does not require npm."); });
  const require = createRequire(cli);
  const tar = require("tar");
  if (typeof tar.x !== "function") throw new Error("Build-time npm tar library is unavailable");
  return { cli, tar };
}

function isolatedNpmEnvironment(temporary) {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
  return { ...env, HOME: temporary, USERPROFILE: temporary, APPDATA: path.join(temporary, "AppData", "Roaming"), LOCALAPPDATA: path.join(temporary, "AppData", "Local"), npm_config_userconfig: path.join(temporary, "empty.npmrc"), npm_config_cache: path.join(temporary, "npm-cache"), npm_config_registry: "https://registry.npmjs.org/", CI: "true" };
}

async function verifyCurrentPackage(packageRoot, source, publicFiles) {
  const installed = { ...source };
  delete installed.scripts;
  const expected = publicFiles.filter((file) => file.path.startsWith("potassium-mcp/") && source.files.some((item) => {
    const relative = file.path.slice("potassium-mcp/".length);
    const prefix = item.replace(/\/$/, "");
    return relative === prefix || relative.startsWith(`${prefix}/`);
  })).map((file) => ({ ...file, path: file.path.slice("potassium-mcp/".length) }));
  const packageBytes = Buffer.from(json(installed));
  expected.push({ path: "package.json", sha256: hash(packageBytes), bytes: packageBytes.length });
  await verifyTree(packageRoot, expected);
  if (installed.potassiumMcpRuntime?.ownershipSchema !== 3 || installed.potassiumMcpRuntime?.launcherProtocol !== 1) throw new Error("Package does not support the Windows ownership/launcher contract");
}

async function dependencyInventory(appRoot, lock) {
  const packages = [];
  for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => compare(a, b))) {
    if (!relative || entry.dev) continue;
    safeBundlePath(relative);
    if (!relative.startsWith("node_modules/") || entry.link || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")
        || !entry.resolved?.startsWith("https://registry.npmjs.org/")) throw new Error(`Production dependency is not registry-integrity-locked: ${relative}`);
    const directory = path.join(appRoot, relative);
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT" && entry.optional) continue; throw error; }
    if (manifest.version !== entry.version) throw new Error(`Installed dependency differs from lock: ${relative}`);
    const licenses = (await readdir(directory)).filter((name) => /^(?:licen[cs]e|copying|notice|third[-_ ]?party)(?:[._ -]|$)/i.test(name));
    const regularLicenses = [];
    for (const name of licenses) if ((await lstat(path.join(directory, name))).isFile()) regularLicenses.push(`app/${relative}/${name}`);
    if (!regularLicenses.length) throw new Error(`Production dependency has no distributable license/notice: ${manifest.name}`);
    packages.push({ name: manifest.name, version: manifest.version, path: `app/${relative}`, integrity: entry.integrity, license: manifest.license ?? entry.license ?? null, licenseFiles: regularLicenses.sort(compare) });
  }
  return packages;
}

async function copyDotnetLicenses(nugetRoot, licenseRoot) {
  const packages = ["microsoft.netcore.app.runtime.win-x64", "microsoft.windowsdesktop.app.runtime.win-x64"];
  const evidence = [];
  for (const name of packages) {
    const directory = path.join(nugetRoot, name, DOTNET_VERSION);
    const entries = await readdir(directory);
    const files = entries.filter((file) => /^(?:LICENSE(?:\.TXT)?|THIRD-PARTY-NOTICES\.TXT)$/i.test(file));
    if (!files.some((file) => /^LICENSE(?:\.TXT)?$/i.test(file)) || name.includes("netcore") && !files.some((file) => /^THIRD-PARTY-NOTICES\.TXT$/i.test(file))) throw new Error(`Required .NET runtime license files are absent: ${name}`);
    const target = path.join(licenseRoot, name);
    await mkdir(target, { recursive: true });
    for (const file of files) await cp(path.join(directory, file), path.join(target, file));
    evidence.push({ name, version: DOTNET_VERSION, integrity: `sha512-${(await readFile(path.join(directory, `${name}.${DOTNET_VERSION}.nupkg.sha512`), "utf8")).trim()}`, licenseFiles: files.map((file) => `LICENSES/${name}/${file}`) });
  }
  return evidence;
}

export async function verifyWindowsExecutable(filename) {
  const stat = await regularFile(filename);
  if (stat.size < 4096) throw new Error(`Missing real Windows executable: ${filename}`);
  const file = await open(filename, "r");
  try {
    const dos = Buffer.alloc(64);
    if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`Missing real Windows executable: ${filename}`);
    const offset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(26);
    if (offset > stat.size - pe.length || (await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length
        || pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664
        || pe.readUInt16LE(24) !== 0x20b) throw new Error(`Executable is not Windows x64 PE32+: ${filename}`);
  } finally { await file.close(); }
}

const outputReceiptName = ".windows-release-output.json";
const allocatedDirectories = new Set();
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function assertCanonicalPath(value) {
  const absolute = path.resolve(value);
  const base = path.parse(absolute).root;
  let current = base;
  for (const segment of ["", ...absolute.slice(base.length).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (info.isSymbolicLink() || !samePath(await realpath(current), current)) throw new Error(`Redirected path is not a safe build destination: ${current}`);
  }
  return absolute;
}

async function directoryLayout(directory) {
  const directories = [];
  async function visit(absolute, relative) {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Redirected build subtree: ${absolute}`);
    if (info.isDirectory()) {
      if (!samePath(await realpath(absolute), absolute)) throw new Error(`Redirected build subtree: ${absolute}`);
      if (relative) directories.push(relative);
      for (const name of await readdir(absolute)) await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    } else if (!info.isFile()) throw new Error(`Nonregular build subtree: ${absolute}`);
  }
  await assertCanonicalPath(directory);
  await visit(directory, "");
  return directories.sort(compare);
}

async function allocateTemporary(prefix, parent = os.tmpdir()) {
  await assertCanonicalPath(parent);
  const directory = await mkdtemp(path.join(parent, prefix));
  allocatedDirectories.add(directory);
  return directory;
}

async function removeTemporary(directory) {
  if (!allocatedDirectories.has(directory)) throw new Error(`Refusing to remove an unallocated directory: ${directory}`);
  try {
    await directoryLayout(directory);
    await rm(directory, { recursive: true, force: false });
    allocatedDirectories.delete(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    allocatedDirectories.delete(directory);
  }
}

export async function inspectOutput(output, binding = output) {
  output = await assertCanonicalPath(output);
  let info;
  try { info = await lstat(output); }
  catch (error) { if (error.code === "ENOENT") return { exists: false, snapshot: "absent", files: [] }; throw error; }
  if (!info.isDirectory()) throw new Error("Windows build output must be a directory");
  const names = await readdir(output);
  if (!names.length) return { exists: true, snapshot: "empty", files: [] };
  if (!names.includes(outputReceiptName)) throw new Error("Refusing to replace unowned Windows build output or stage paths");
  const receiptPath = path.join(output, outputReceiptName);
  if ((await regularFile(receiptPath)).size > limits.manifestBytes) throw new Error("Windows output ownership receipt is too large");
  const receiptBytes = await readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  if (receipt.schema !== 1 || receipt.kind !== "potassium-windows-release-output" || !samePath(receipt.output ?? "", path.resolve(binding))
      || !Array.isArray(receipt.files) || !Array.isArray(receipt.directories)) throw new Error("Invalid Windows output ownership receipt");
  const actual = (await inventoryTree(output)).filter((file) => file.path !== outputReceiptName);
  const directories = await directoryLayout(output);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.files) || JSON.stringify(directories) !== JSON.stringify(receipt.directories)) throw new Error("Windows output contains modified or unowned files/directories; nothing was replaced");
  return { exists: true, snapshot: hash(receiptBytes), files: actual };
}

// A sibling rename transaction avoids overwriting foreign files or leaving an
// unowned partial stage. The private schema-versioned receipt is not distributed.
export async function publishOwnedOutput(source, output, expected) {
  output = await assertCanonicalPath(output);
  expected ??= await inspectOutput(output);
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  await assertCanonicalPath(parent);
  const pending = await allocateTemporary(".potassium-windows-publish-", parent);
  let previous;
  let published = false;
  try {
    for (const file of await inventoryTree(source)) {
      if (file.path === outputReceiptName) throw new Error("A new distribution must not supply its own output ownership receipt");
      const target = path.join(pending, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(source, file.path), target);
    }
    const receipt = { schema: 1, kind: "potassium-windows-release-output", output, files: await inventoryTree(pending), directories: await directoryLayout(pending) };
    await writeFile(path.join(pending, outputReceiptName), json(receipt), { flag: "wx" });
    await inspectOutput(pending, output);
    const current = await inspectOutput(output);
    if (current.snapshot !== expected.snapshot) throw new Error("Windows build output changed during staging; nothing was replaced");
    if (current.exists) {
      previous = await allocateTemporary(".potassium-windows-previous-", parent);
      await removeTemporary(previous);
      await rename(output, previous);
      allocatedDirectories.add(previous);
    }
    try {
      await assertCanonicalPath(output);
      await rename(pending, output);
      allocatedDirectories.delete(pending);
      published = true;
    } catch (error) {
      if (previous) {
        await rename(previous, output);
        allocatedDirectories.delete(previous);
        previous = undefined;
      }
      throw error;
    }
    if (previous) {
      await inspectOutput(previous, output);
      await removeTemporary(previous);
      previous = undefined;
    }
  } finally {
    if (!published) await removeTemporary(pending);
    // An unexpected/locked prior output is retained rather than recursively
    // deleting a directory that no longer matches its ownership receipt.
  }
}

async function stageIn(temporary, npmArtifact) {
  const source = JSON.parse(await readFile(path.join(root, "potassium-mcp", "package.json"), "utf8"));
  const artifact = await validateNpmArtifact(npmArtifact, source);
  const publicFiles = await selectPublicFiles(root);
  const lockBytes = await readFile(path.join(root, "potassium-mcp", "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.version !== source.version
      || JSON.stringify(lock.packages[""].dependencies) !== JSON.stringify(source.dependencies)) throw new Error("Current production lock does not match the package");
  const pinnedNode = await ensurePinnedNode();
  const npm = await npmToolchain();
  const dotnetSdk = run("dotnet", ["--version"]).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(dotnetSdk) || Number(dotnetSdk.split(".")[0]) < 8) throw new Error(".NET SDK 8 or newer is required");
  const bundleRoot = path.join(temporary, "bundle");
  const appRoot = path.join(bundleRoot, "app");
  await mkdir(appRoot, { recursive: true });
  await writeFile(path.join(appRoot, "package.json"), json({ name: source.name, version: source.version, private: true, dependencies: source.dependencies }));
  await writeFile(path.join(appRoot, "package-lock.json"), lockBytes);
  const npmEnv = isolatedNpmEnvironment(path.join(temporary, "npm-home"));
  await mkdir(npmEnv.HOME, { recursive: true });
  await writeFile(npmEnv.npm_config_userconfig, "");
  run(process.execPath, [npm.cli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--bin-links=false"], { cwd: appRoot, env: npmEnv });
  run(process.execPath, [npm.cli, "ls", "--omit=dev", "--all", "--json"], { cwd: appRoot, env: npmEnv });
  const packages = await dependencyInventory(appRoot, lock);
  for (const name of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) await rm(path.join(appRoot, name), { force: true });
  const packageRoot = path.join(bundleRoot, BUNDLE_ENTRIES.packageRoot);
  await mkdir(packageRoot, { recursive: true });
  // validateNpmArtifact has already rejected nonregular and ambiguous tar members.
  await npm.tar.x({ file: artifact.tarball, cwd: packageRoot, strip: 1, strict: true, preservePaths: false, noChmod: true });
  await verifyCurrentPackage(packageRoot, source, publicFiles);
  await verifyParserHost(packageRoot, { verifySources: false });
  await mkdir(path.join(bundleRoot, "node"));
  await cp(pinnedNode, path.join(bundleRoot, BUNDLE_ENTRIES.node));
  const licenses = path.join(bundleRoot, "LICENSES");
  await mkdir(licenses);
  for (const [directory, names] of [
    ["native-parser", ["LICENSE-tree-sitter.txt", "LICENSE-tree-sitter-luau.txt", "LICENSE-tree-sitter-lua.txt", "LICENSE-ICU.txt", "LICENSE-ZIG.txt", "LICENSE-MINGW.txt", "THIRD-PARTY-NOTICES-MINGW.txt"]],
    ["parser-host", ["LICENSE-DOTNET.txt", "THIRD-PARTY-NOTICES-DOTNET.txt"]],
  ]) {
    const target = path.join(licenses, directory);
    await mkdir(target);
    const sourceDirectory = path.join(packageRoot, "assets", directory, "win32-x64");
    for (const name of names) await cp(path.join(sourceDirectory, name), path.join(target, name));
  }
  for (const dependency of packages) {
    for (const relative of dependency.licenseFiles) {
      const target = path.join(licenses, "npm", relative.slice("app/node_modules/".length));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(bundleRoot, relative), target);
    }
  }
  await cp(path.join(root, "LICENSE"), path.join(licenses, "Potassium-LICENSE.txt"));
  await download(`https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`, path.join(licenses, "Node-LICENSE.txt"));
  const nuget = path.join(temporary, "nuget");
  const feed = await cachedDotnetFeed(temporary);
  const restoreSources = feed ? [`-p:RestoreSources=${feed}`] : [];
  const launcherOutput = path.join(temporary, "launcher-publish");
  const common = ["-c", "Release", "-r", "win-x64", "--self-contained", "true", "--packages", nuget, ...restoreSources, `-p:RuntimeFrameworkVersion=${DOTNET_VERSION}`, "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-p:DebugType=None", "-p:DebugSymbols=false", "-p:ContinuousIntegrationBuild=true", "-p:Deterministic=true"];
  run("dotnet", ["publish", path.join(root, "app", "PotassiumMcp.Launcher", "PotassiumMcp.Launcher.csproj"), ...common, "-o", launcherOutput]);
  const launcher = path.join(launcherOutput, "PotassiumMcp.Launcher.exe");
  await verifyWindowsExecutable(launcher);
  if (run(launcher, ["--version"]).trim() !== "Potassium MCP Launcher 1.0.0") throw new Error("Stable launcher protocol version is not 1.0.0");
  await mkdir(path.join(bundleRoot, "launcher"));
  await cp(launcher, path.join(bundleRoot, BUNDLE_ENTRIES.launcher));
  // Restore the desktop runtime before sealing the bundle so Setup's licenses ship too.
  run("dotnet", ["restore", path.join(root, "app", "PotassiumMcp.Setup", "PotassiumMcp.Setup.csproj"), "-r", "win-x64", "--packages", nuget, ...restoreSources, `-p:RuntimeFrameworkVersion=${DOTNET_VERSION}`, "-p:SelfContained=true"]);
  const dotnetPackages = await copyDotnetLicenses(nuget, licenses);
  await writeFile(path.join(licenses, "DEPENDENCIES.json"), json({ schema: 1, packages, dotnetPackages }));
  const files = await inventoryTree(bundleRoot);
  if (files.some((file) => /safe[-_]?proxy/i.test(file.path))) throw new Error("Safeproxy must not be included in the Windows distribution");
  const manifest = { schema: 1, packageVersion: source.version, nodeVersion: NODE_VERSION, entries: BUNDLE_ENTRIES, files };
  validateBundleManifest(manifest);
  const manifestBytes = Buffer.from(json(manifest));
  if (manifestBytes.length > limits.manifestBytes) throw new Error("Runtime manifest exceeds its bounded reader limit");
  const versionId = hash(manifestBytes);
  const stageRoot = path.join(temporary, "stage");
  await mkdir(stageRoot);
  await writeFile(path.join(stageRoot, "runtime-bundle.manifest.json"), manifestBytes);
  await archive(bundleRoot, path.join(stageRoot, "runtime-bundle.zip"), files, temporary);
  const evidence = { schema: 1, packageVersion: source.version, nodeVersion: NODE_VERSION, nodeSha256: NODE_SHA256, dotnetVersion: DOTNET_VERSION, dotnetSdk, dotnetRestore: feed ? "sha512-verified-local-feed" : "nuget", versionId, npmArtifact: { filename: artifact.filename, sha256: artifact.sha256, integrity: artifact.integrity }, packageLockSha256: hash(lockBytes), runtimeFiles: files.length, runtimeBytes: files.reduce((sum, file) => sum + file.bytes, 0), runtimeZipSha256: await digestFile(path.join(stageRoot, "runtime-bundle.zip")), packages, dotnetPackages };
  await writeFile(path.join(stageRoot, "STAGE-INVENTORY.json"), json(evidence));
  return { stageRoot, bundleRoot, evidence, common };
}

async function persistStage(staged, destination) {
  await mkdir(path.join(destination, "stage"));
  for (const name of ["runtime-bundle.manifest.json", "runtime-bundle.zip", "STAGE-INVENTORY.json"]) await cp(path.join(staged.stageRoot, name), path.join(destination, "stage", name));
}

export async function stageWindows(output = defaultOutput, { npmArtifact = defaultNpmArtifact } = {}) {
  if (process.platform !== "win32") throw new Error("Windows packaging requires Windows, PowerShell 5+ and the .NET 8+ SDK");
  output = path.resolve(output);
  npmArtifact = path.resolve(npmArtifact);
  const expected = await inspectOutput(output);
  const temporary = await allocateTemporary("potassium-windows-stage-");
  try {
    const staged = await stageIn(temporary, npmArtifact);
    const prepared = path.join(temporary, "output");
    await mkdir(prepared);
    for (const file of expected.files.filter((file) => !file.path.startsWith("stage/"))) {
      await assertCanonicalPath(path.join(output, file.path));
      const target = path.join(prepared, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(output, file.path), target);
    }
    await persistStage(staged, prepared);
    await publishOwnedOutput(prepared, output, expected);
    return staged.evidence;
  } finally { await removeTemporary(temporary); }
}

export async function checkWindows(output = defaultOutput) {
  if (process.platform !== "win32") throw new Error("Windows executable qualification requires Windows");
  output = await assertCanonicalPath(output);
  await directoryLayout(output);
  const evidence = JSON.parse(await readFile(path.join(output, "WINDOWS-SETUP.json"), "utf8"));
  if (evidence.schema !== 1 || !Array.isArray(evidence.distributionFiles) || !evidence.distributionFiles.length) throw new Error("Missing completed Windows distribution inventory");
  for (const file of [...evidence.distributionFiles, evidence.distributionZip]) {
    safeBundlePath(file.path);
    const filename = path.join(output, file.path);
    const stat = await regularFile(filename);
    if (stat.size !== file.bytes || await digestFile(filename) !== file.sha256) throw new Error(`Windows distribution checksum mismatch: ${file.path}`);
  }
  const inventoryRecords = evidence.distributionFiles.filter((file) => file.path === "BUNDLE-INVENTORY.json");
  if (inventoryRecords.length !== 1 || inventoryRecords[0].bytes > limits.manifestBytes) throw new Error("Missing or invalid sealed Windows bundle inventory");
  const inventoryBytes = await readFile(path.join(output, "BUNDLE-INVENTORY.json"));
  if (hash(inventoryBytes) !== inventoryRecords[0].sha256) throw new Error("Windows bundle inventory checksum mismatch");
  const inventory = JSON.parse(inventoryBytes);
  const npmArtifact = inventory?.npmArtifact;
  if (!inventory || inventory.schema !== 1 || inventory.packageVersion !== evidence.packageVersion
      || inventory.versionId !== evidence.versionId || inventory.runtimeZipSha256 !== evidence.runtimeZipSha256
      || !npmArtifact || typeof npmArtifact !== "object" || Array.isArray(npmArtifact)
      || typeof npmArtifact.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/.test(npmArtifact.filename)
      || typeof npmArtifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(npmArtifact.sha256)
      || typeof npmArtifact.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(npmArtifact.integrity)
      || typeof inventory.packageLockSha256 !== "string" || !/^[a-f0-9]{64}$/.test(inventory.packageLockSha256)) {
    throw new Error("Invalid sealed Windows bundle identity");
  }
  if (!evidence.npmArtifact || ["filename", "sha256", "integrity"].some((field) => evidence.npmArtifact[field] !== npmArtifact[field])
      || evidence.packageLockSha256 !== inventory.packageLockSha256) throw new Error("Windows npm/lock identity differs from the sealed bundle inventory");
  const manifestBytes = await readFile(path.join(output, "runtime-bundle.manifest.json"));
  if (manifestBytes.length > limits.manifestBytes || hash(manifestBytes) !== evidence.versionId) throw new Error("Windows runtime manifest digest mismatch");
  const manifest = JSON.parse(manifestBytes);
  validateBundleManifest(manifest);
  if (manifest.packageVersion !== evidence.packageVersion) throw new Error("Windows package identity mismatch");
  const executable = path.join(output, "Setup.exe");
  await verifyWindowsExecutable(executable);
  const actual = JSON.parse(run(executable, ["--verify-bundle"]));
  if (actual.valid !== true || actual.versionId !== evidence.versionId || actual.zipSha256 !== evidence.runtimeZipSha256
      || actual.files !== manifest.files.length || actual.packageVersion !== evidence.packageVersion || actual.nodeVersion !== NODE_VERSION) throw new Error("Actual Setup.exe embedded bundle does not match its verified distribution");
  const temporary = await allocateTemporary("potassium-windows-check-");
  try { await archive(output, path.join(output, evidence.distributionZip.path), evidence.distributionFiles, temporary, "verify"); }
  finally { await removeTemporary(temporary); }
  const checksums = [...evidence.distributionFiles, evidence.distributionZip].map((file) => `${file.sha256}  ${file.path}\n`).join("");
  if (await readFile(path.join(output, "SHA256SUMS.txt"), "utf8") !== checksums) throw new Error("Windows checksum inventory differs");
  return { valid: true, verificationScope: "sealed-distribution-artifact", currentSourceCompared: false, packageVersion: evidence.packageVersion, versionId: evidence.versionId, npmArtifact: { filename: npmArtifact.filename, sha256: npmArtifact.sha256, integrity: npmArtifact.integrity }, packageLockSha256: inventory.packageLockSha256, setupSha256: evidence.distributionFiles.find((file) => file.path === "Setup.exe").sha256, distributionZip: evidence.distributionZip.path, qualification: "Actual x64 Setup.exe embedded payload verified against this distribution's sealed artifact identity, not the current checkout; no installation, harness registration, game execution or publication performed" };
}

export async function buildWindows(output = defaultOutput, { npmArtifact = defaultNpmArtifact } = {}) {
  if (process.platform !== "win32") throw new Error("Windows packaging requires Windows, PowerShell 5+ and the .NET 8+ SDK");
  output = path.resolve(output);
  npmArtifact = path.resolve(npmArtifact);
  const expected = await inspectOutput(output);
  const temporary = await allocateTemporary("potassium-windows-build-");
  try {
    const staged = await stageIn(temporary, npmArtifact);
    const publish = path.join(temporary, "setup-publish");
    run("dotnet", ["publish", path.join(root, "app", "PotassiumMcp.Setup", "PotassiumMcp.Setup.csproj"), ...staged.common, `-p:Version=${staged.evidence.packageVersion}`, `-p:RuntimeBundleDirectory=${staged.stageRoot}`, "-o", publish]);
    const setup = path.join(publish, "PotassiumMcp.Setup.exe");
    await verifyWindowsExecutable(setup);
    const distribution = path.join(temporary, "distribution");
    await mkdir(distribution);
    await cp(setup, path.join(distribution, "Setup.exe"));
    await cp(path.join(staged.stageRoot, "runtime-bundle.manifest.json"), path.join(distribution, "runtime-bundle.manifest.json"));
    await cp(path.join(staged.bundleRoot, "LICENSES"), path.join(distribution, "LICENSES"), { recursive: true });
    await cp(path.join(staged.stageRoot, "STAGE-INVENTORY.json"), path.join(distribution, "BUNDLE-INVENTORY.json"));
    const distributionFiles = await inventoryTree(distribution);
    const zipName = `potassium-mcp-v${staged.evidence.packageVersion}-windows-setup.zip`;
    const zip = path.join(temporary, zipName);
    await archive(distribution, zip, distributionFiles, temporary);
    const distributionZip = { path: zipName, sha256: await digestFile(zip), bytes: (await regularFile(zip)).size };
    const evidence = { ...staged.evidence, distributionFiles, distributionZip, verification: "embedded-bundle", installedRuntimeRequirements: "Windows x64; no system Node, npm or .NET required", signing: "Unsigned local build; no Authenticode identity is claimed" };
    await writeFile(path.join(distribution, "WINDOWS-SETUP.json"), json(evidence));
    await writeFile(path.join(distribution, "SHA256SUMS.txt"), [...distributionFiles, distributionZip].map((file) => `${file.sha256}  ${file.path}\n`).join(""));
    // Qualify the exact EXE and ZIP before publishing the completion inventory.
    await cp(zip, path.join(distribution, zipName));
    const qualified = await checkWindows(distribution);
    await persistStage(staged, distribution);
    await publishOwnedOutput(distribution, output, expected);
    return qualified;
  } finally { await removeTemporary(temporary); }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!["stage", "build", "check"].includes(command)) throw new Error("Usage: node tools/windows-release.mjs <stage|build|check> [--output <directory>] [--npm-artifact <metadata JSON> (stage/build only)]. Stage/build require a sanitized npm artifact; check verifies only the sealed distribution. Never installs or publishes.");
  let output = defaultOutput;
  let npmArtifact = defaultNpmArtifact;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== "--output" && flag !== "--npm-artifact") throw new Error(`Unknown Windows release argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate Windows release argument: ${flag}`);
    seen.add(flag);
    const value = args[index + 1];
    if (typeof value !== "string" || !value.trim() || value.startsWith("-")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--npm-artifact") {
      if (command === "check") throw new Error("--npm-artifact is supported only for stage/build; check verifies the sealed distribution");
      npmArtifact = path.resolve(value);
    } else output = path.resolve(value);
  }
  if (command === "check") return checkWindows(output);
  return ({ stage: stageWindows, build: buildWindows })[command](output, { npmArtifact });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((result) => console.log(json(result))).catch((error) => { console.error(`Windows release failed: ${error.message}`); process.exitCode = 1; });

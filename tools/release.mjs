import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { distTagForVersion, runNpm, validateNpmArtifact } from "../potassium-mcp/release-publish.js";
import { PARSER_HOST_FILES, verifyParserHost } from "./parser-host.mjs";
import { NATIVE_PARSER_FILES, verifyNativeParser } from "./native-parser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");

export function portableRelative(from, target) {
  const relative = path.relative(from, target);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error(`Path escapes its base: ${target}`);
  return relative.split(path.sep).join("/");
}
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const parserHostPrefix = "potassium-mcp/assets/parser-host/win32-x64/";
const parserHostExecutable = `${parserHostPrefix}PotassiumMcp.ParserHost.exe`;
const nativeParserPrefix = "potassium-mcp/assets/native-parser/win32-x64/";
const nativeParserExecutable = `${nativeParserPrefix}PotassiumMcp.LuauParser.exe`;



function assertSafeContent(relative, content) {
  const absolutePath = /(?:^|[\s"'=(])(?:[A-Za-z]:[\\/](?![<>])|\\\\[A-Za-z0-9._-]+[\\/]|\/(?:home|Users|root|tmp)\/[A-Za-z0-9_.-]+)/m;
  if (absolutePath.test(content)) throw new Error(`Absolute local path found in ${relative}`);
  const credentialAssignment = /(?:^|\n)\s*(?:(?:export\s+)?(?:const|let|var|local)\s+)?(?:\$env:)?(?:token|secret|api[_-]?key|password|passwd|authorization)\s*(?::|=)\s*(?:["'](?!(?:test|fixture|example|replace-me)-)[^"'\r\n]{16,}["']|(?!(?:test|fixture|example|replace-me)-)[A-Za-z0-9_+/=-]{32,})/i;
  const bearerLiteral = /\bBearer\s+(?!(?:test|fixture|example|replace-me)-)[A-Za-z0-9._~+/=-]{16,}/i;
  const structuredSecret = /["'](?:token|secret|api[_-]?key|password|passwd|authorization)["']\s*:\s*["'](?!(?:test|fixture|example|replace-me)-)[^"'\r\n]{16,}["']/i;
  if (credentialAssignment.test(content) || bearerLiteral.test(content) || structuredSecret.test(content)) {
    throw new Error(`Potential secret literal found in ${relative}`);
  }
}

export async function loadReleaseManifest(root = projectRoot) {
  const source = await readFile(path.join(root, "release-manifest.json"), "utf8");
  const manifest = JSON.parse(source);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Release manifest must declare schemaVersion 1 and a non-empty files list");
  const files = [...manifest.files].sort();
  if (new Set(files).size !== files.length) throw new Error("Release manifest contains duplicate files");
  for (const file of files) {
    if (typeof file !== "string" || !file || file.includes("\\") || file.includes(":") || file.startsWith("/") || file.split("/").includes("..") || path.posix.normalize(file) !== file) throw new Error(`Invalid release manifest path: ${file}`);
  }
  return { manifest, files };
}

export async function selectPublicFiles(root = projectRoot) {
  const { files } = await loadReleaseManifest(root);
  const records = [];
  for (const relative of files) {
    let full = root;
    let info;
    try {
      for (const segment of relative.split("/")) {
        full = path.join(full, segment);
        info = await lstat(full);
        if (info.isSymbolicLink()) throw new Error(`Release file must not traverse a symbolic link: ${relative}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Release manifest file is missing: ${relative}`);
      throw error;
    }
    if (!info.isFile()) throw new Error(`Release file must be a regular file: ${relative}`);
    const content = await readFile(full);
    if (relative !== parserHostExecutable && relative !== nativeParserExecutable) {
      if (/\.(?:exe|dll|node|wasm)$/i.test(relative)) throw new Error(`Unverified binary release asset: ${relative}`);
      assertSafeContent(relative, content.toString("utf8"));
    }
    records.push({ path: relative, bytes: info.size, sha256: sha256(content) });
  }
  if (files.includes(nativeParserExecutable)) {
    for (const name of NATIVE_PARSER_FILES) if (!files.includes(nativeParserPrefix + name)) throw new Error(`Native parser asset missing from release manifest: ${name}`);
    const seal = await verifyNativeParser(path.join(root, "potassium-mcp"));
    const record = records.find((entry) => entry.path === nativeParserExecutable);
    if (record.sha256 !== seal.executable.sha256 || record.bytes !== seal.executable.bytes) throw new Error("Native parser changed during release verification");
  }
  if (files.includes(parserHostExecutable)) {
    for (const name of PARSER_HOST_FILES) if (!files.includes(parserHostPrefix + name)) throw new Error(`Parser host asset missing from release manifest: ${name}`);
    const seal = await verifyParserHost(path.join(root, "potassium-mcp"));
    const record = records.find((entry) => entry.path === parserHostExecutable);
    if (record.sha256 !== seal.executable.sha256 || record.bytes !== seal.executable.bytes) throw new Error("Parser executable changed during release verification");
  }
  return records;
}

function lockEvidence(lock) {
  const packages = Object.entries(lock.packages ?? {}).map(([name, entry]) => ({ name, version: entry.version ?? null, integrity: entry.integrity ?? null })).sort((a, b) => a.name.localeCompare(b.name));
  return { lockfileVersion: lock.lockfileVersion, packages };
}

export async function checkRelease(root = projectRoot) {
  const files = await selectPublicFiles(root);
  const lock = JSON.parse(await readFile(path.join(root, "potassium-mcp", "package-lock.json"), "utf8"));
  return { schemaVersion: 1, files, sbom: lockEvidence(lock) };
}

export async function validateReleaseOutput(root, destination, sourcePaths = []) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  const relativeDestination = portableRelative(root, destination);
  for (const source of sourcePaths) {
    const relative = path.relative(destination, path.resolve(root, source));
    const inverse = path.relative(path.resolve(root, source), destination);
    const contained = (value) => value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
    if (contained(relative) || contained(inverse)) throw new Error("Release destination overlaps a manifest source");
  }
  let ancestor = root;
  for (const segment of relativeDestination.split("/")) {
    ancestor = path.join(ancestor, segment);
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Release destination must traverse only regular directories");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return destination;
}

export async function packRelease(root = projectRoot, destination = path.join(root, "release-out", "public")) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  await validateReleaseOutput(root, destination);
  const relativeDestination = portableRelative(root, destination);
  const report = await checkRelease(root);
  await validateReleaseOutput(root, destination, report.files.map((record) => record.path));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const record of report.files) {
    const source = path.join(root, record.path);
    const target = path.join(destination, record.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true, verbatimSymlinks: true });
  }
  const evidence = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path.join(destination, "RELEASE-EVIDENCE.json"), evidence, "utf8");
  for (const record of report.files) {
    const copied = await readFile(path.join(destination, record.path));
    if (copied.length !== record.bytes || sha256(copied) !== record.sha256) throw new Error(`Release copy verification failed: ${record.path}`);
  }
  return { destination: relativeDestination, files: report.files.length, evidenceSha256: sha256(evidence) };
}

export async function packNpmRelease(root = projectRoot, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["command", "env", "output"].includes(key))) throw new Error("Invalid npm release options");
  const { command = runNpm, env = process.env, output = path.join(root, "release-out") } = options;
  if (typeof output !== "string" || !output.trim()) throw new Error("Npm release output must be a directory path");
  root = path.resolve(root);
  const source = path.join(root, "potassium-mcp");
  const destination = await validateReleaseOutput(root, output, ["potassium-mcp"]);
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Npm release directory must not be a symbolic link");
  const publicFiles = await selectPublicFiles(root);
  await validateReleaseOutput(root, destination, publicFiles.map((record) => record.path));
  const metadataPath = path.join(destination, "NPM-ARTIFACT.json");
  await mkdir(destination, { recursive: true });
  // A failed rebuild must not leave an old artifact looking publishable.
  await rm(metadataPath, { force: true });
  const manifestSource = await readFile(path.join(source, "package.json"), "utf8");
  const manifestRecord = publicFiles.find((record) => record.path === "potassium-mcp/package.json");
  if (!manifestRecord || sha256(manifestSource) !== manifestRecord.sha256) throw new Error("Npm manifest is missing from, or changed since, the public content gate");
  const manifest = JSON.parse(manifestSource);
  distTagForVersion(manifest.version);
  if (manifest.name !== "@mrketa/potassium-mcp") throw new Error("Unexpected npm package name");
  if (manifest.dependencies?.["@modelcontextprotocol/sdk"] !== "1.30.0") throw new Error("MCP SDK must remain pinned to 1.30.0");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Npm package must declare its runtime files");
  const stage = await mkdtemp(path.join(os.tmpdir(), "potassium-npm-release-"));
  try {
    const runtimePaths = [];
    for (const file of manifest.files) {
      if (typeof file !== "string" || !file || file.includes("\\") || file.includes(":") || file.startsWith("/") || file.split("/").some((part) => part === ".." || part === ".") || /[*?![\]{}]/.test(file)) throw new Error(`Invalid npm runtime path: ${file}`);
      const relative = file.replace(/\/$/, "");
      if (!relative || path.posix.normalize(relative) !== relative) throw new Error(`Invalid npm runtime path: ${file}`);
      if (!publicFiles.some((record) => record.path === `potassium-mcp/${relative}` || record.path.startsWith(`potassium-mcp/${relative}/`))) throw new Error(`Npm runtime path has no public manifest files: ${file}`);
      runtimePaths.push(relative);
    }
    for (const record of publicFiles) {
      if (!record.path.startsWith("potassium-mcp/")) continue;
      const relative = record.path.slice("potassium-mcp/".length);
      if (!runtimePaths.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) continue;
      const target = path.join(stage, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(root, record.path), target, { verbatimSymlinks: true });
      if (!(await lstat(target)).isFile() || sha256(await readFile(target)) !== record.sha256) throw new Error(`Npm input changed after the public content gate: ${record.path}`);
    }
    // Installed packages have no source checkout, release tooling, or test tree.
    // These commands are deliberately source-only, not installed npm commands.
    const installedManifest = { ...manifest };
    delete installedManifest.scripts;
    await writeFile(path.join(stage, "package.json"), `${JSON.stringify(installedManifest, null, 2)}\n`);
    const result = JSON.parse(String(await command(["pack", "--json", "--ignore-scripts"], {
      cwd: stage, env, encoding: "utf8", stdio: "pipe",
    })));
    if (!Array.isArray(result) || result.length !== 1) throw new Error("npm pack must produce exactly one artifact");
    const packed = result[0];
    if (packed.name !== manifest.name || packed.version !== manifest.version || typeof packed.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/.test(packed.filename)) throw new Error("npm pack returned an unexpected artifact identity");
    const stagedTarball = path.join(stage, packed.filename);
    if (!(await lstat(stagedTarball)).isFile()) throw new Error("npm pack must produce a regular tarball");
    const bytes = await readFile(stagedTarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (packed.integrity !== integrity) throw new Error("npm pack integrity does not match the produced tarball");
    const metadata = { filename: packed.filename, name: manifest.name, version: manifest.version, integrity, sha256: sha256(bytes) };
    // Verify the complete output in staging before making metadata discoverable.
    const stagedMetadata = path.join(stage, "NPM-ARTIFACT.json");
    const checksum = `${metadata.sha256}  ${metadata.filename}\n`;
    await writeFile(`${stagedTarball}.sha256`, checksum);
    await writeFile(stagedMetadata, `${JSON.stringify(metadata, null, 2)}\n`);
    await validateNpmArtifact(stagedMetadata, manifest);
    for (const file of [metadata.filename, `${metadata.filename}.sha256`]) {
      const target = path.join(destination, file);
      await rm(target, { force: true });
      await cp(path.join(stage, file), target);
    }
    await cp(stagedMetadata, metadataPath);
    return metadata;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export function parseReleaseArgs(args) {
  const [command, ...flags] = args;
  const usage = "Usage: node tools/release.mjs check | pack | npm-pack [--output <directory>]";
  if (!["check", "pack", "npm-pack"].includes(command)) throw new Error(usage);
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    if (command !== "npm-pack" || flags[index] !== "--output" || !flags[index + 1]?.trim() || flags[index + 1].startsWith("-") || Object.hasOwn(options, "output")) throw new Error(usage);
    options.output = flags[index + 1];
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseReleaseArgs(process.argv.slice(2));
  if (command === "check") console.log(JSON.stringify(await checkRelease(), null, 2));
  else if (command === "pack") console.log(JSON.stringify(await packRelease(), null, 2));
  else console.log(JSON.stringify(await packNpmRelease(projectRoot, options), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`release failed: ${error.message}`); process.exitCode = 1; });

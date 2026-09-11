import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "potassium-mcp");
const sourcePath = "native/luau-parser";
const assetPath = "assets/native-parser/win32-x64";
const executableName = "PotassiumMcp.LuauParser.exe";
const manifestName = "native-parser-manifest.json";
export const NATIVE_PARSER_ZIG_VERSION = "0.14.1";
export const NATIVE_PARSER_FILES = Object.freeze([
  executableName, manifestName, "LICENSE-tree-sitter.txt", "LICENSE-tree-sitter-luau.txt",
  "LICENSE-tree-sitter-lua.txt", "LICENSE-ICU.txt", "LICENSE-ZIG.txt", "LICENSE-MINGW.txt",
  "THIRD-PARTY-NOTICES-MINGW.txt",
]);
export const NATIVE_PARSER_IDENTITY = Object.freeze({ runtime: "tree-sitter", runtimeVersion: "0.25.0", grammar: "tree-sitter-luau", grammarVersion: "1.2.0" });
const compilerPin = Object.freeze({
  version: NATIVE_PARSER_ZIG_VERSION,
  archive: "https://ziglang.org/download/0.14.1/zig-x86_64-windows-0.14.1.zip",
  archiveBytes: 82229343,
  archiveSha256: "554f5378228923ffd558eac35e21af020c73789d87afeabf4bfd16f2e6feed2c",
});
const toolchainDirectory = path.join(root, ".cache", "native-parser-toolchain");
const toolchainFolder = `zig-${NATIVE_PARSER_ZIG_VERSION}`;
const distributionFolder = `zig-x86_64-windows-${NATIVE_PARSER_ZIG_VERSION}`;
const toolchainMarker = "toolchain-manifest.json";
const packagePins = Object.freeze({
  "tree-sitter": { version: "0.25.0", tarball: "https://registry.npmjs.org/tree-sitter/-/tree-sitter-0.25.0.tgz", integrity: "sha512-PGZZzFW63eElZJDe/b/R/LbsjDDYJa5UEjLZJB59RQsMX+fo0j54fqBPn1MGKav/QNa0JR0zBiVaikYDWCj5KQ==", archiveBytes: 179372 },
  "tree-sitter-luau": { version: "1.2.0", tarball: "https://registry.npmjs.org/tree-sitter-luau/-/tree-sitter-luau-1.2.0.tgz", integrity: "sha512-2LBeROsknOCLzryCFyqTgZ6AXiEl4U0/f32ILn7BQWCPABVtNwNh9U+MDnSUrGJRNvFicrfh+KcVRyKtG0ZEuQ==", archiveBytes: 378988 },
});
const authoredSources = Object.freeze(["worker.c", "allocator.h", "runtime.c", "scanner.c", "source-provenance.json", "LICENSE-tree-sitter-lua.txt"]);
const licenseSources = Object.freeze({
  "LICENSE-tree-sitter.txt": "vendor/tree-sitter/LICENSE",
  "LICENSE-tree-sitter-luau.txt": "vendor/tree-sitter-luau/LICENSE",
  "LICENSE-tree-sitter-lua.txt": "LICENSE-tree-sitter-lua.txt",
  "LICENSE-ICU.txt": "vendor/tree-sitter/src/unicode/LICENSE",
});
const importPolicy = "kernel32-msvcrt-ntdll-ucrt-only; dynamic-ws2_32-probe-only";
const allowedDlls = new Set([
  "kernel32.dll", "msvcrt.dll", "ntdll.dll",
  ...["conio", "convert", "environment", "filesystem", "heap", "locale", "math", "multibyte", "private", "process", "runtime", "stdio", "string", "time", "utility"]
    .map((family) => `api-ms-win-crt-${family}-l1-1-0.dll`),
]);
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function regularFile(filename, maximum = 256 * 1024 * 1024) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum ||
      path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase())
    throw new Error(`Native parser input is redirected, oversized or nonregular: ${filename}`);
  return info;
}

async function digest(filename, maximum) {
  const info = await regularFile(filename, maximum);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return { bytes: info.size, sha256: hash.digest("hex") };
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Native parser input contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Native parser input is not a regular file: ${relative}`);
  }
  return files.sort();
}

async function sourceInventory() {
  const directory = path.join(root, sourcePath);
  await regularFile(path.join(directory, "source-provenance.json"), 65536);
  const provenance = JSON.parse(await readFile(path.join(directory, "source-provenance.json"), "utf8"));
  if (provenance.schema !== 1 || provenance.grammarAbi !== 14 || !same(provenance.parser, NATIVE_PARSER_IDENTITY) ||
      !same(provenance.packages, packagePins) || !provenance.files || typeof provenance.files !== "object")
    throw new Error("Native parser published source identity is invalid");
  const vendorNames = Object.keys(provenance.files).sort();
  if (vendorNames.length !== 51) throw new Error("Native parser vendor inventory differs from the qualified source set");
  const expected = [...authoredSources, ...vendorNames].sort();
  if (!same(await listFiles(directory), expected)) throw new Error("Native parser source directory inventory is invalid");
  const sources = {};
  for (const relative of expected) {
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split("/").includes("..")) throw new Error("Native parser source path is invalid");
    const actual = await digest(path.join(directory, relative), 2 * 1024 * 1024);
    if (relative.startsWith("vendor/")) {
      const record = provenance.files[relative];
      const prefix = record.package === "tree-sitter" ? "vendor/tree-sitter/" : record.package === "tree-sitter-luau" ? "vendor/tree-sitter-luau/" : null;
      if (!prefix || !relative.startsWith(prefix) || !record.archivePath?.startsWith("package/") ||
          record.bytes !== actual.bytes || record.sha256 !== actual.sha256)
        throw new Error(`Native parser vendored source digest is invalid: ${relative}`);
    }
    sources[`${sourcePath}/${relative}`] = actual.sha256;
  }
  sources["tools/native-parser.mjs"] = (await digest(path.join(root, "tools/native-parser.mjs"))).sha256;
  return { sources, provenance };
}

async function normalizePeTimestamp(filename) {
  await regularFile(filename, 16 * 1024 * 1024);
  const bytes = await readFile(filename);
  if (bytes.length < 512 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Cannot normalize a non-PE native parser");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe > bytes.length - 264 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 ||
      bytes.readUInt16LE(pe + 20) < 240 || bytes.readUInt16LE(pe + 24) !== 0x20b)
    throw new Error("Cannot normalize an invalid native parser PE header");
  // Only an unsigned build artifact may be normalized. No instructions, imports,
  // directories, section content, or loader hardening flags are changed.
  const certificateDirectory = pe + 24 + 112 + 4 * 8;
  if (bytes.readUInt32LE(certificateDirectory) || bytes.readUInt32LE(certificateDirectory + 4))
    throw new Error("Native parser timestamp normalization refuses a signed artifact");
  bytes.writeUInt32LE(0, pe + 8);
  await writeFile(filename, bytes);
}

/* Inspect PE bytes ourselves: qualification cannot depend on an installed objdump. */
export async function inspectNativeParserPe(filename) {
  await regularFile(filename, 16 * 1024 * 1024);
  const bytes = await readFile(filename);
  const bounded = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset > bytes.length - length) throw new Error("Native parser PE contains an invalid range");
    return offset;
  };
  if (bytes.length < 512 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Native parser is not a PE executable");
  const pe = bounded(bytes.readUInt32LE(0x3c), 24);
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error("Native parser is not Windows x64");
  const sectionCount = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = bounded(pe + 24, optionalSize);
  if (optionalSize < 240 || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt16LE(optional + 68) !== 3)
    throw new Error("Native parser must be a PE32+ console executable");
  if (bytes.readUInt32LE(pe + 8) !== 0) throw new Error("Native parser PE has a nondeterministic timestamp");
  const dllCharacteristics = bytes.readUInt16LE(optional + 70);
  if ((dllCharacteristics & 0x160) !== 0x160) throw new Error("Native parser PE lacks ASLR/high-entropy/NX protections");
  const directories = bytes.readUInt32LE(optional + 108);
  if (directories < 14 || sectionCount < 1 || sectionCount > 96) throw new Error("Native parser PE headers are unsupported");
  const sectionTable = bounded(optional + optionalSize, sectionCount * 40);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const offset = sectionTable + i * 40;
    sections.push({ rva: bytes.readUInt32LE(offset + 12), size: bytes.readUInt32LE(offset + 16), offset: bytes.readUInt32LE(offset + 20) });
  }
  const rvaOffset = (rva, length = 1) => {
    const section = sections.find((entry) => rva >= entry.rva && rva - entry.rva <= entry.size - length);
    if (!section) throw new Error("Native parser PE import points outside a file-backed section");
    return bounded(section.offset + rva - section.rva, length);
  };
  const cstring = (rva) => {
    const start = rvaOffset(rva), end = bytes.indexOf(0, start);
    if (end < start || end - start > 512 || !/^[\x20-\x7e]+$/.test(bytes.toString("ascii", start, end)))
      throw new Error("Native parser PE import name is invalid");
    rvaOffset(rva, end - start + 1);
    return bytes.toString("ascii", start, end);
  };
  const directory = (index) => ({ rva: bytes.readUInt32LE(optional + 112 + index * 8), size: bytes.readUInt32LE(optional + 116 + index * 8) });
  const delay = directory(13);
  if (delay.rva || delay.size) throw new Error("Native parser must not have delayed DLL imports");
  const imports = directory(1), symbols = {};
  if (!imports.rva || imports.size < 20 || imports.size > 65536) throw new Error("Native parser PE import directory is invalid");
  let terminated = false;
  for (let i = 0; (i + 1) * 20 <= imports.size; i++) {
    const entry = rvaOffset(imports.rva + i * 20, 20);
    const lookup = bytes.readUInt32LE(entry), name = bytes.readUInt32LE(entry + 12), address = bytes.readUInt32LE(entry + 16);
    if (!lookup && !name && !address) { terminated = true; break; }
    const dll = cstring(name).toLowerCase();
    if (!allowedDlls.has(dll) || Object.hasOwn(symbols, dll)) throw new Error(`Native parser has an unqualified or duplicate DLL import: ${dll}`);
    const names = [];
    let ended = false;
    for (let j = 0; j < 4096; j++) {
      const value = bytes.readBigUInt64LE(rvaOffset((lookup || address) + j * 8, 8));
      if (!value) { ended = true; break; }
      if (value & (1n << 63n)) names.push(`#${Number(value & 0xffffn)}`);
      else {
        if (value > 0xffffffffn) throw new Error("Native parser PE import RVA overflows");
        names.push(cstring(Number(value) + 2));
      }
    }
    if (!ended) throw new Error("Native parser PE import thunk table is unterminated");
    symbols[dll] = names.sort();
  }
  if (!terminated || !Object.keys(symbols).length) throw new Error("Native parser PE import directory is unterminated");
  const dlls = Object.keys(symbols).sort();
  const canonicalSymbols = Object.fromEntries(dlls.map((dll) => [dll, symbols[dll]]));
  return { dlls, symbols: canonicalSymbols, sha256: hashBytes(JSON.stringify({ dlls, symbols: canonicalSymbols })), policy: importPolicy };
}

async function verifyAssets(directory) {
  const actualNames = (await readdir(directory)).sort(), expectedNames = [...NATIVE_PARSER_FILES].sort();
  if (!same(actualNames, expectedNames)) {
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
    throw new Error(`Native parser asset inventory differs: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected.slice(0, 16))}`);
  }
  await regularFile(path.join(directory, manifestName), 65536);
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), "utf8"));
  if (manifest.schema !== 1 || manifest.platform !== "win32-x64" || !same(manifest.parser, NATIVE_PARSER_IDENTITY) ||
      manifest.build?.zigVersion !== NATIVE_PARSER_ZIG_VERSION || manifest.build?.archiveSha256 !== compilerPin.archiveSha256 ||
      manifest.build?.archiveBytes !== compilerPin.archiveBytes || manifest.build?.target !== "x86_64-windows-gnu" ||
      !same(manifest.provenance?.packages, packagePins)) throw new Error("Native parser manifest identity is invalid");
  if (!same(Object.keys(manifest.files ?? {}).sort(), NATIVE_PARSER_FILES.filter((name) => name !== manifestName).sort()))
    throw new Error("Native parser manifest file inventory is invalid");
  for (const name of NATIVE_PARSER_FILES.filter((name) => name !== manifestName)) {
    if (!same(await digest(path.join(directory, name)), manifest.files[name])) throw new Error(`Native parser asset seal mismatch: ${name}`);
  }
  if (!same(manifest.executable, manifest.files[executableName])) throw new Error("Native parser executable seal is inconsistent");
  if (!same(await inspectNativeParserPe(path.join(directory, executableName)), manifest.imports)) throw new Error("Native parser DLL import seal is inconsistent");
  return manifest;
}

export async function verifyNativeParser(directory = packageRoot, { verifySources = path.resolve(directory) === packageRoot } = {}) {
  const manifest = await verifyAssets(path.join(directory, assetPath));
  if (verifySources) {
    const current = await sourceInventory();
    if (!same(current.sources, manifest.sources) || !same(current.provenance, manifest.provenance)) throw new Error("Native parser source seal is stale");
  }
  return manifest;
}

/* ZIP members are read only after the entire qualified compiler archive is hashed. */
function zipEntries(bytes) {
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < 0) throw new Error("Qualified Zig ZIP has no central directory");
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 65535 || directoryStart + directorySize !== end) throw new Error("Qualified Zig ZIP directory is unsupported");
  const entries = new Map();
  const windowsNames = new Set();
  let expandedBytes = 0;
  let offset = directoryStart;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Qualified Zig ZIP entry is invalid");
    const method = bytes.readUInt16LE(offset + 10), compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    const pieces = name.replace(/\/$/, "").split("/");
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    expandedBytes += size;
    if (windowsNames.has(name.toLowerCase()) || pieces.some((piece) => !piece || piece === "." || piece === ".." ||
        /[:\\]/.test(piece) || /[. ]$/.test(piece) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece)) ||
        (mode & 0xf000) === 0xa000 || expandedBytes > 1024 * 1024 * 1024 ||
        local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50)
      throw new Error("Qualified Zig ZIP member path is invalid");
    windowsNames.add(name.toLowerCase());
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (dataStart + compressedSize > directoryStart || size > 256 * 1024 * 1024) throw new Error("Qualified Zig ZIP member is oversized");
    entries.set(name, () => {
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      const output = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: size || 1 }) : null;
      if (!output || output.length !== size) throw new Error("Qualified Zig ZIP compression is unsupported");
      return output;
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) throw new Error("Qualified Zig ZIP has trailing directory entries");
  return entries;
}

async function qualifiedCompiler(zigPath, zigArchivePath) {
  const actualArchive = await digest(zigArchivePath, compilerPin.archiveBytes);
  if (actualArchive.bytes !== compilerPin.archiveBytes || actualArchive.sha256 !== compilerPin.archiveSha256) throw new Error("Zig compiler archive does not match the qualified SHA256 pin");
  const entries = zipEntries(await readFile(zigArchivePath));
  const prefix = "zig-x86_64-windows-0.14.1/";
  const executable = entries.get(`${prefix}zig.exe`)?.();
  if (!executable) throw new Error("Qualified Zig archive does not contain zig.exe");
  const actualExecutable = await digest(zigPath);
  if (actualExecutable.bytes !== executable.length || actualExecutable.sha256 !== hashBytes(executable)) throw new Error("Installed Zig executable differs from the qualified archive");
  const zigRoot = path.dirname(path.resolve(zigPath));
  const hashes = {};
  const notices = [];
  const seenNotices = new Set();
  const libraryNames = [...entries.keys()].filter((name) => name.startsWith(`${prefix}lib/`) && !name.endsWith("/")).sort();
  if (!same(await listFiles(path.join(zigRoot, "lib")), libraryNames.map((name) => name.slice(`${prefix}lib/`.length))))
    throw new Error("Installed Zig library inventory differs from the qualified archive");
  for (const name of libraryNames) {
    const relative = name.slice(prefix.length), archived = entries.get(name)();
    const expected = hashBytes(archived), actual = await digest(path.join(zigRoot, relative));
    if (actual.bytes !== archived.length || actual.sha256 !== expected) throw new Error(`Installed Zig library differs from the qualified archive: ${relative}`);
    hashes[relative] = expected;
    if (relative.startsWith("lib/libc/mingw/") && /\.[ch]$/.test(relative)) {
      // Retain source copyright/license headers from every bundled MinGW component,
      // including notices of components eliminated by the native linker's dead stripping.
      const leading = archived.toString("utf8").match(/^\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)+/)?.[0]?.trim();
      if (leading && /copyright|license|permission|public domain/i.test(leading) && !seenNotices.has(leading)) {
        seenNotices.add(leading);
        notices.push(`${relative}\n${leading}\n`);
      }
    }
  }
  if (!Object.keys(hashes).length || !notices.length) throw new Error("Qualified Zig library/notice inventory is empty");
  return {
    executable: actualExecutable,
    librariesSha256: hashBytes(JSON.stringify(hashes)),
    libraryFiles: Object.keys(hashes).length,
    licenses: {
      "LICENSE-ZIG.txt": entries.get(`${prefix}LICENSE`)?.(),
      "LICENSE-MINGW.txt": entries.get(`${prefix}lib/libc/mingw/COPYING`)?.(),
      "THIRD-PARTY-NOTICES-MINGW.txt": Buffer.from(`Notices from the qualified Zig ${NATIVE_PARSER_ZIG_VERSION} MinGW source distribution.\nThis inclusive inventory may contain notices for components not linked into this executable.\n\n${notices.join("\n")}`),
    },
  };
}

async function safeDirectoryAncestors(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const info = await lstat(current).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (info && (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(current)).toLowerCase() !== current.toLowerCase()))
      throw new Error(`Native parser toolchain cache has a redirected or non-directory ancestor: ${current}`);
    if (path.dirname(current) === current) break;
  }
}

async function downloadQualifiedCompiler() {
  const response = await fetch(compilerPin.archive, { redirect: "error", signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Qualified Zig download failed: HTTP ${response.status}`);
  const chunks = [];
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > compilerPin.archiveBytes) throw new Error("Qualified Zig download exceeds its pinned size");
    hash.update(chunk); chunks.push(chunk);
  }
  if (size !== compilerPin.archiveBytes || hash.digest("hex") !== compilerPin.archiveSha256)
    throw new Error("Qualified Zig download failed its exact size/SHA256 check");
  return Buffer.concat(chunks, size);
}

async function extractQualifiedCompiler(directory) {
  const bytes = await downloadQualifiedCompiler();
  // No ZIP member is inspected or written before the full archive hash succeeds.
  await writeFile(path.join(directory, "zig.zip"), bytes, { flag: "wx" });
  for (const [name, content] of zipEntries(bytes)) {
    if (name !== `${distributionFolder}/` && !name.startsWith(`${distributionFolder}/`))
      throw new Error("Qualified Zig archive contains an unexpected distribution root");
    const target = path.join(directory, ...name.split("/"));
    if (name.endsWith("/")) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content(), { flag: "wx" });
    }
  }
}

function toolchainPaths(directory) {
  return {
    zigPath: path.join(directory, distributionFolder, "zig.exe"),
    zigArchivePath: path.join(directory, "zig.zip"),
    version: NATIVE_PARSER_ZIG_VERSION,
    archiveSha256: compilerPin.archiveSha256,
  };
}

function toolchainReceipt(compiler) {
  return {
    schema: 1, owner: "PotassiumMcp.NativeParser.Toolchain", pin: compilerPin,
    compilerExecutable: compiler.executable, compilerLibrariesSha256: compiler.librariesSha256,
    compilerLibraryFiles: compiler.libraryFiles,
  };
}

async function cachedToolchain(directory) {
  await safeDirectoryAncestors(directory);
  if (!same((await readdir(directory)).sort(), [distributionFolder, "zig.zip", toolchainMarker].sort()))
    throw new Error("Native parser toolchain cache is not an owned installation");
  await regularFile(path.join(directory, toolchainMarker), 4096);
  const marker = JSON.parse(await readFile(path.join(directory, toolchainMarker), "utf8"));
  if (marker.schema !== 1 || marker.owner !== "PotassiumMcp.NativeParser.Toolchain" || !same(marker.pin, compilerPin))
    throw new Error("Native parser refuses to adopt an unrecognized toolchain cache");
  const paths = toolchainPaths(directory);
  const compiler = await qualifiedCompiler(paths.zigPath, paths.zigArchivePath);
  if (!same(marker, toolchainReceipt(compiler))) throw new Error("Native parser toolchain cache seal is inconsistent");
  return { paths, compiler };
}

async function ensureToolchain() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native parser toolchain provisioning requires Windows x64");
  const installed = path.join(toolchainDirectory, toolchainFolder);
  await safeDirectoryAncestors(installed);
  const existing = await lstat(installed).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) return cachedToolchain(installed);
  await mkdir(toolchainDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(toolchainDirectory, ".provision-"));
  try {
    await extractQualifiedCompiler(temporary);
    const paths = toolchainPaths(temporary);
    const compiler = await qualifiedCompiler(paths.zigPath, paths.zigArchivePath);
    // The marker is written last, after every compiler/library byte is qualified.
    await writeFile(path.join(temporary, toolchainMarker), encode(toolchainReceipt(compiler)), { flag: "wx" });
    try { await rename(temporary, installed); }
    catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      return await cachedToolchain(installed);
    }
    return { paths: toolchainPaths(installed), compiler };
  } finally {
    // This is our fresh staging directory, never an existing installation.
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function provisionNativeParserToolchain() {
  return (await ensureToolchain()).paths;
}

function compilerEnvironment() {
  const allowed = new Set(["systemroot", "systemdrive", "windir", "temp", "tmp"]);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === "string"));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Qualified Zig requires the Windows SystemRoot");
  environment.PATH = path.join(systemRoot, "System32");
  return environment;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 300000, env: compilerEnvironment(), ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native parser build command failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function buildNativeParser({ zigPath = process.env.POTASSIUM_ZIG_PATH, zigArchivePath = process.env.POTASSIUM_ZIG_ARCHIVE } = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native parser build requires qualified Windows x64 Zig");
  let compiler;
  if (!zigPath && !zigArchivePath) {
    const provisioned = await ensureToolchain();
    ({ zigPath, zigArchivePath } = provisioned.paths);
    compiler = provisioned.compiler;
  } else {
    if (!zigPath || !zigArchivePath) throw new Error("Native parser build requires both --zig and --zig-archive when either is supplied");
    zigPath = path.resolve(zigPath); zigArchivePath = path.resolve(zigArchivePath);
    compiler = await qualifiedCompiler(zigPath, zigArchivePath);
  }
  const version = run(zigPath, ["version"]);
  if (version !== NATIVE_PARSER_ZIG_VERSION) throw new Error(`Native parser requires Zig ${NATIVE_PARSER_ZIG_VERSION}; found ${version}`);
  const { sources, provenance } = await sourceInventory();
  const assetRoot = path.join(packageRoot, assetPath);
  await mkdir(path.dirname(assetRoot), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(assetRoot), ".build-"));
  let backup;
  try {
    const staged = path.join(temporary, "assets"); await mkdir(staged);
    const compiled = path.join(temporary, "compiled"); await mkdir(compiled);
    const compiledExecutable = path.join(compiled, executableName);
    const flags = ["cc", "-target", "x86_64-windows-gnu", "-std=c11", "-O2", "-DNDEBUG",
      "-ffunction-sections", "-fdata-sections", "-s",
      `-ffile-prefix-map=${root.replaceAll("\\", "/")}=/_/src`,
      "-I", `${sourcePath}/vendor/tree-sitter/include`, "-I", `${sourcePath}/vendor/tree-sitter/src`, "-I", `${sourcePath}/vendor/tree-sitter-luau/src`,
      `${sourcePath}/worker.c`, `${sourcePath}/runtime.c`, `${sourcePath}/scanner.c`, `${sourcePath}/vendor/tree-sitter-luau/src/parser.c`];
    run(zigPath, [...flags, "-o", compiledExecutable], {
      env: { ...compilerEnvironment(), TEMP: temporary, TMP: temporary,
        ZIG_LIB_DIR: path.join(path.dirname(zigPath), "lib"),
        ZIG_GLOBAL_CACHE_DIR: path.join(temporary, "zig-global-cache"), ZIG_LOCAL_CACHE_DIR: path.join(temporary, "zig-local-cache") },
    });
    await normalizePeTimestamp(compiledExecutable);
    const imports = await inspectNativeParserPe(compiledExecutable);
    await copyFile(compiledExecutable, path.join(staged, executableName));
    for (const [target, source] of Object.entries(licenseSources)) await copyFile(path.join(root, sourcePath, source), path.join(staged, target));
    for (const [target, content] of Object.entries(compiler.licenses)) {
      if (!content?.length) throw new Error(`Qualified compiler license is missing: ${target}`);
      await writeFile(path.join(staged, target), content);
    }
    const files = {};
    for (const name of NATIVE_PARSER_FILES.filter((name) => name !== manifestName)) files[name] = await digest(path.join(staged, name));
    const manifest = {
      schema: 1, platform: "win32-x64", parser: NATIVE_PARSER_IDENTITY,
      executable: files[executableName], files, imports, sources, provenance,
      build: { zigVersion: version, archive: compilerPin.archive, archiveBytes: compilerPin.archiveBytes,
        archiveSha256: compilerPin.archiveSha256, compilerExecutable: compiler.executable,
        compilerLibrariesSha256: compiler.librariesSha256, compilerLibraryFiles: compiler.libraryFiles,
        target: "x86_64-windows-gnu", deterministic: true, symbols: false,
        normalizedPeFields: ["IMAGE_FILE_HEADER.TimeDateStamp=0"],
        flags: flags.map((flag) => flag.startsWith("-ffile-prefix-map=") ? "-ffile-prefix-map=<source-root>=/_/src" : flag) },
      limits: { modules: 32, sourceBytes: 262144, aggregateSourceBytes: 4194304, nodes: 200000, depth: 512, outputBytes: 8388608, allocationBytes: 192 * 1024 * 1024 },
      protocol: { input: "PMCPAST1", schema: 1, probeInput: "PMCPPRB1", sourceExecution: false },
    };
    await writeFile(path.join(staged, manifestName), encode(manifest));
    await verifyAssets(staged);
    const old = await lstat(assetRoot).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (old) {
      if (!old.isDirectory() || old.isSymbolicLink()) throw new Error("Native parser output is not an owned directory");
      await verifyAssets(assetRoot);
      backup = `${assetRoot}.previous-${randomBytes(8).toString("hex")}`;
      await rename(assetRoot, backup);
    }
    try { await rename(staged, assetRoot); }
    catch (error) { if (backup) { await rename(backup, assetRoot); backup = null; } throw error; }
    if (backup) { await rm(backup, { recursive: true }); backup = null; }
    return await verifyNativeParser();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = "check", ...args] = process.argv.slice(2);
  const options = {};
  const usage = "Usage: node tools/native-parser.mjs check | toolchain | build [--zig <zig.exe> --zig-archive <qualified.zip>]";
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i] === "--zig" ? "zigPath" : args[i] === "--zig-archive" ? "zigArchivePath" : null;
    if (!key || !args[i + 1] || options[key]) throw new Error(usage);
    options[key] = args[i + 1];
  }
  const operation = command === "build" ? buildNativeParser(options) :
    command === "toolchain" && !args.length ? provisionNativeParserToolchain() :
      command === "check" && !args.length ? verifyNativeParser() : Promise.reject(new Error(usage));
  operation.then((manifest) => console.log(encode(manifest)), (error) => { console.error(error.message); process.exitCode = 1; });
}

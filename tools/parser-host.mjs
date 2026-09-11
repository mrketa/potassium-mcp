import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeParser } from "./native-parser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "potassium-mcp");
const assetPath = "assets/parser-host/win32-x64";
const executableName = "PotassiumMcp.ParserHost.exe";
const manifestName = "parser-host-manifest.json";
export const PARSER_HOST_SDK_VERSION = "8.0.424";
export const PARSER_HOST_RUNTIME_VERSION = "8.0.30";
export const PARSER_HOST_FILES = Object.freeze([executableName, manifestName, "LICENSE-DOTNET.txt", "THIRD-PARTY-NOTICES-DOTNET.txt"]);
const nativeExecutablePath = "assets/native-parser/win32-x64/PotassiumMcp.LuauParser.exe";
const nativeManifestPath = "assets/native-parser/win32-x64/native-parser-manifest.json";
const sourceFiles = Object.freeze([
  "app/PotassiumMcp.ParserHost/PotassiumMcp.ParserHost.csproj", "app/PotassiumMcp.ParserHost/Native.cs",
  "app/PotassiumMcp.ParserHost/Workspace.cs", "app/PotassiumMcp.ParserHost/Sandbox.cs",
  "app/PotassiumMcp.ParserHost/Program.cs", "tools/parser-host.mjs",
]);
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) throw new Error(`Parser host input is redirected or nonregular: ${filename}`);
  return info;
}

async function digest(filename) {
  const info = await regularFile(filename);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return { bytes: info.size, sha256: hash.digest("hex") };
}

async function runtimeInventory(directory) {
  const manifest = await verifyNativeParser(directory, { verifySources: path.resolve(directory) === packageRoot });
  return {
    [nativeExecutablePath]: manifest.executable.sha256,
    nativeManifestSha256: (await digest(path.join(directory, nativeManifestPath))).sha256,
    nativeImports: manifest.imports,
  };
}

async function verifyPe(filename) {
  const info = await regularFile(filename);
  if (info.size < 4096 || info.size > 256 * 1024 * 1024) throw new Error("Parser host executable size is invalid");
  const file = await open(filename, "r");
  try {
    const dos = Buffer.alloc(64);
    if ((await file.read(dos, 0, 64, 0)).bytesRead !== 64 || dos.readUInt16LE(0) !== 0x5a4d) throw new Error("Parser host is not a Windows PE executable");
    const offset = dos.readUInt32LE(0x3c), pe = Buffer.alloc(26);
    if (offset > info.size - 26 || (await file.read(pe, 0, 26, offset)).bytesRead !== 26 || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b) throw new Error("Parser host is not a Windows x64 executable");
  } finally { await file.close(); }
}

async function verifyAssets(directory) {
  const entries = await readdir(directory);
  if (entries.sort().join("\n") !== [...PARSER_HOST_FILES].sort().join("\n")) throw new Error("Parser host asset inventory differs from its fixed file list");
  const info = await regularFile(path.join(directory, manifestName));
  if (info.size > 65536) throw new Error("Parser host manifest exceeds its limit");
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), "utf8"));
  if (manifest.schema !== 1 || manifest.platform !== "win32-x64" || manifest.build?.sdk !== PARSER_HOST_SDK_VERSION || manifest.build?.runtime !== PARSER_HOST_RUNTIME_VERSION) throw new Error("Parser host manifest identity is invalid");
  for (const name of PARSER_HOST_FILES.filter((name) => name !== manifestName)) {
    const actual = await digest(path.join(directory, name));
    if (manifest.files?.[name]?.bytes !== actual.bytes || manifest.files[name].sha256 !== actual.sha256) throw new Error(`Parser host seal mismatch: ${name}`);
  }
  if (manifest.executable?.sha256 !== manifest.files[executableName].sha256 || manifest.executable.bytes !== manifest.files[executableName].bytes) throw new Error("Parser executable seal is inconsistent");
  await verifyPe(path.join(directory, executableName));
  return manifest;
}

export async function verifyParserHost(directory = packageRoot, { verifyRuntime = true, verifySources = path.resolve(directory) === packageRoot } = {}) {
  const manifest = await verifyAssets(path.join(directory, assetPath));
  if (verifyRuntime) {
    const current = await runtimeInventory(directory);
    if (JSON.stringify(current) !== JSON.stringify(manifest.runtime)) throw new Error("Parser worker/runtime seal is stale");
  }
  if (verifySources) {
    if (Object.keys(manifest.sources ?? {}).sort().join("\n") !== [...sourceFiles].sort().join("\n")) throw new Error("Parser host source inventory is invalid");
    for (const name of sourceFiles) if ((await digest(path.join(root, name))).sha256 !== manifest.sources[name]) throw new Error(`Parser host source seal is stale: ${name}`);
  }
  return manifest;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Parser host build command failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function buildParserHost({ dotnetPath = "dotnet", runtimeFrameworkVersion = PARSER_HOST_RUNTIME_VERSION, nugetRoot = path.join(os.homedir(), ".nuget", "packages") } = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Parser host build requires Windows x64");
  if (runtimeFrameworkVersion !== PARSER_HOST_RUNTIME_VERSION) throw new Error("Parser host .NET runtime pin differs from the release pin");
  const sdk = run(dotnetPath, ["--version"]);
  if (sdk !== PARSER_HOST_SDK_VERSION) throw new Error(`Parser host requires .NET SDK ${PARSER_HOST_SDK_VERSION}; found ${sdk}`);
  const runtime = await runtimeInventory(packageRoot);
  const assetRoot = path.join(packageRoot, assetPath);
    await mkdir(path.dirname(assetRoot), { recursive: true });
    const temporary = await mkdtemp(path.join(path.dirname(assetRoot), ".build-"));
  let backup;
  try {
    const publish = path.join(temporary, "publish");
    run(dotnetPath, ["publish", path.join(root, sourceFiles[0]), "--configuration", "Release", "--runtime", "win-x64", "--self-contained", "true", "--output", publish,
      `-p:RuntimeFrameworkVersion=${runtimeFrameworkVersion}`, "-p:DebugType=None", "-p:DebugSymbols=false", "-p:Deterministic=true", "-p:ContinuousIntegrationBuild=true", `-p:PathMap=${root.replaceAll("\\", "/")}=/_/src`,
      `-p:BaseIntermediateOutputPath=${path.join(temporary, "obj")}${path.sep}`, `-p:BaseOutputPath=${path.join(temporary, "bin")}${path.sep}`,
      `-p:RestorePackagesPath=${nugetRoot}`,
    ], { timeout: 300000 });
    const staged = path.join(temporary, "assets"); await mkdir(staged);
    await copyFile(path.join(publish, executableName), path.join(staged, executableName));
    const packageName = "microsoft.netcore.app.runtime.win-x64";
    const licenses = path.join(nugetRoot, packageName, runtimeFrameworkVersion);
    for (const [source, target] of [["LICENSE.TXT", "LICENSE-DOTNET.txt"], ["THIRD-PARTY-NOTICES.TXT", "THIRD-PARTY-NOTICES-DOTNET.txt"]]) {
      await regularFile(path.join(licenses, source)); await copyFile(path.join(licenses, source), path.join(staged, target));
    }
    const files = {};
    for (const name of PARSER_HOST_FILES.filter((name) => name !== manifestName)) files[name] = await digest(path.join(staged, name));
    const sources = {};
    for (const name of sourceFiles) sources[name] = (await digest(path.join(root, name))).sha256;
    const integrity = `sha512-${(await readFile(path.join(licenses, `${packageName}.${runtimeFrameworkVersion}.nupkg.sha512`), "utf8")).trim()}`;
    const manifest = {
      schema: 1, platform: "win32-x64", executable: files[executableName], files, runtime, sources,
      build: { sdk, runtime: runtimeFrameworkVersion, rid: "win-x64", selfContained: true, deterministic: true, symbols: false, runtimePackage: { name: packageName, integrity } },
      boundary: { appContainer: "standard", capabilities: [], uiRestrictions: "0x00ff", childProcesses: "atomic-job-active-process-limit-no-breakaway", filesystem: "read-only staged native worker plus own AppContainer profile and Windows AppContainer-public resources", activeProcesses: 1, processMemoryBytes: 256 * 1024 * 1024, jobMemoryBytes: 256 * 1024 * 1024, cpuMilliseconds: 5000, wallMilliseconds: 10000, inputBytes: 16 * 1024 * 1024, outputBytes: 8 * 1024 * 1024 },
      probes: { cpuMilliseconds: 1000, wallMilliseconds: 10000 },
    };
    await writeFile(path.join(staged, manifestName), encode(manifest));
    await verifyAssets(staged);
    await mkdir(path.dirname(assetRoot), { recursive: true });
    const old = await lstat(assetRoot).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (old) {
      if (!old.isDirectory() || old.isSymbolicLink()) throw new Error("Parser host output is not an owned directory");
      await verifyAssets(assetRoot);
      backup = `${assetRoot}.previous-${randomBytes(8).toString("hex")}`;
      await rename(assetRoot, backup);
    }
    try { await rename(staged, assetRoot); }
    catch (error) { if (backup) { await rename(backup, assetRoot); backup = null; } throw error; }
    if (backup) { await rm(backup, { recursive: true }); backup = null; }
    return await verifyParserHost();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "check";
  const operation = command === "build" ? buildParserHost() : command === "check" ? verifyParserHost() : Promise.reject(new Error("Usage: node tools/parser-host.mjs build|check"));
  operation.then((manifest) => console.log(encode(manifest)), (error) => { console.error(error.message); process.exitCode = 1; });
}

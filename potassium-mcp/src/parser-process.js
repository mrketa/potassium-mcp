import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeNativeSourcePackage } from "./code-tree-adapter.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostRoot = path.join(packageRoot, "assets", "parser-host", "win32-x64");
const hostExecutable = path.join(hostRoot, "PotassiumMcp.ParserHost.exe");
const inputLimit = 16 * 1024 * 1024;
const outputLimit = 8 * 1024 * 1024;

function parserError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function plainFile(filename) {
  const full = path.resolve(filename);
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(full)).toLowerCase() !== full.toLowerCase()) {
    throw parserError("PARSER_BACKEND_UNAVAILABLE", "Parser runtime file is redirected");
  }
  return info;
}

async function executable() {
  try {
    const manifestPath = path.join(hostRoot, "parser-host-manifest.json");
    const manifestInfo = await plainFile(manifestPath);
    if (manifestInfo.size > 65536) throw new Error("manifest size");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const info = await plainFile(hostExecutable);
    if (manifest.schema !== 1 || manifest.platform !== "win32-x64" || manifest.executable?.bytes !== info.size || !/^[a-f0-9]{64}$/.test(manifest.executable?.sha256)) throw new Error("manifest shape");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(hostExecutable)) hash.update(bytes);
    if (hash.digest("hex") !== manifest.executable.sha256) throw new Error("executable seal");
    return hostExecutable;
  } catch (error) {
    if (error.code === "PARSER_BACKEND_UNAVAILABLE") throw error;
    throw parserError("PARSER_BACKEND_UNAVAILABLE", "Bundled Windows parser backend is missing or its seal is invalid");
  }
}

function requestBytes(modules) {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 32) throw parserError("PARSER_INPUT_LIMIT", "Parser module count is outside its limit");
  let totalBytes = 0;
  const clean = modules.map((module) => {
    if (!module || typeof module.id !== "string" || module.id.length < 1 || module.id.length > 128 || typeof module.source !== "string" || typeof module.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(module.sha256) || module.logicalPath !== undefined && (typeof module.logicalPath !== "string" || module.logicalPath.length > 512)) throw parserError("PARSER_INPUT_INVALID", "Parser module input is invalid");
    const bytes = Buffer.byteLength(module.source);
    totalBytes += bytes;
    if (bytes > 256 * 1024 || totalBytes > 4 * 1024 * 1024) throw parserError("PARSER_INPUT_LIMIT", "Parser source byte limit exceeded");
    return { id: module.id, logicalPath: module.logicalPath, source: module.source, sha256: module.sha256 };
  });
  const bytes = Buffer.from(JSON.stringify({ schema: 1, modules: clean }));
  if (bytes.length > inputLimit) throw parserError("PARSER_INPUT_LIMIT", "Parser input byte limit exceeded");
  return bytes;
}

function hostEnvironment() {
  const environment = {};
  // Do not forward NODE_OPTIONS, NODE_PATH, DOTNET_*, credentials, MCP config,
  // source-root paths, or PATH to the trusted helper, much less its child.
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "SystemDrive"]) {
    const actual = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (actual && process.env[actual]) environment[name] = process.env[actual];
  }
  return environment;
}

function invokeHost(host, bytes, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(parserError("PARSER_CANCELLED", "Parser request cancelled")); return; }
    const child = spawn(host, [], {
      cwd: hostRoot, env: hostEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let failure;
    let settled = false;
    let forced;
    const stop = (error) => {
      if (settled) return;
      failure ??= error;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      // EOF normally lets the host kill its job and remove its profile/runtime.
      // A crashed/hung host is killed only after grace; job KILL_ON_JOB_CLOSE
      // still terminates the worker, and its private journal is recovered next run.
      forced ??= setTimeout(() => child.kill(), 5000);
      forced.unref();
    };
    const abort = () => stop(parserError("PARSER_CANCELLED", "Parser request cancelled"));
    const timeout = setTimeout(() => stop(parserError("PARSER_HOST_TIMEOUT", "Parser host wall-time limit exceeded")), 25000);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    const complete = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(forced);
      signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      if (error) reject(error); else resolve(value);
    };
    child.once("error", () => complete(parserError("PARSER_BACKEND_UNAVAILABLE", "Windows parser backend could not be started")));
    child.stdin.on("error", () => stop(parserError("PARSER_PROTOCOL_ERROR", "Parser input channel closed")));
    child.stdout.on("error", () => stop(parserError("PARSER_PROTOCOL_ERROR", "Parser output channel failed")));
    child.stderr.on("error", () => stop(parserError("PARSER_PROTOCOL_ERROR", "Parser diagnostic channel failed")));
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) stop(parserError("PARSER_OUTPUT_LIMIT", "Parser output limit exceeded"));
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 65536) stop(parserError("PARSER_OUTPUT_LIMIT", "Parser diagnostic output limit exceeded"));
    });
    child.once("close", (code) => {
      if (failure) { complete(failure); return; }
      if (code !== 0) { complete(parserError("PARSER_WORKER_EXIT", "Parser host exited before returning a result")); return; }
      try {
        const envelope = JSON.parse(Buffer.concat(chunks, outputBytes).toString("utf8"));
        if (envelope?.schema !== 1 || Boolean(envelope.trees) === Boolean(envelope.error)) throw new Error("envelope");
        if (envelope.error) {
          const error = envelope.error;
          if (typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) || typeof error.message !== "string" || error.message.length > 1024) throw new Error("error");
          complete(parserError(error.code, error.message));
        } else {
          if (!envelope.parser || typeof envelope.parser !== "object" || !Array.isArray(envelope.trees) || envelope.truncated !== false) throw new Error("result");
          complete(null, envelope);
        }
      } catch { complete(parserError("PARSER_PROTOCOL_ERROR", "Parser returned an invalid result")); }
    });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    child.stdin.write(header);
    child.stdin.write(bytes);
    if (signal?.aborted) abort();
  });
}

/** Parse supplied source as data in the bundled OS-confined worker. */
export async function parseSourcePackage(modules, { signal } = {}) {
  if (signal?.aborted) throw parserError("PARSER_CANCELLED", "Parser request cancelled");
  if (process.platform !== "win32" || process.arch !== "x64") throw parserError("PARSER_BACKEND_UNAVAILABLE", "Windows x64 AppContainer parser backend is unavailable on this platform");
  const bytes = requestBytes(modules);
  const host = await executable();
  if (signal?.aborted) throw parserError("PARSER_CANCELLED", "Parser request cancelled");
  const trees = await invokeHost(host, bytes, signal);
  if (signal?.aborted) throw parserError("PARSER_CANCELLED", "Parser request cancelled");
  return analyzeNativeSourcePackage(modules, trees);
}

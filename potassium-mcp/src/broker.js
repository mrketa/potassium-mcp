import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants, closeSync, lstatSync, openSync, readSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isJSONRPCRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { PotassiumBridge } from "./bridge.js";
import { AdminAuditRecorder } from "./admin-audit.js";
import { commandConfigPath, createToolServer, isMainModule, loadConfig, parseConfig } from "./server.js";
import packageMetadata from "../package.json" with { type: "json" };
import { createAsyncArtifactStore } from "./async-artifact-store.js";
import { createCompactResultStore } from "./compact-results.js";
import { createCodeIndexService } from "./code-index.js";
import { createGameContextService } from "./game-context.js";
import { createMapContextService } from "./map-context.js";
import { createMapRecordingService } from "./map-recording.js";
import { createSessionStats } from "./session-stats.js";
import { createStatefulHttpSessionRegistry, MCP_SESSION_HEADER } from "./stateful-http.js";
import { createBuiltinFallbackClient } from "./builtin-fallback.js";
import { createNativeEditorClient } from "./native-editor.js";
import { resolveHostPolicy, TOOL_NAMES } from "./host-policy.js";
import { resolveConfigPath } from "./paths.js";
import { acquireInstallLock, readRepairDrainCredentials, verifyInstallLease } from "./install.js";
import { supportsRuntime } from "./hosts.js";
import { MAX_PENDING_MCP_REQUESTS } from "./request-id-transport.js";
import { WINDOWS_POWERSHELL_PRELUDE, windowsPowerShellEnvironment } from "./windows-powershell.js";

const PROXY_PROTOCOL = 1;
const PROXY_DOMAIN = "potassium-mcp/proxy/v1";
const BROKER_STATE_FILE = "broker-state.json";
const BROKER_STOPPED_FILE = "broker-stopped.json";
const STOPPED_IDENTITY_KEYS = ["instanceId", "pid", "configDigest", "nodeExecutable", "brokerPath", "configPath"];
const BROKER_STATE_SCHEMA = 1;
const DEFAULT_RESTART_WAIT_MS = 30000;
const MAX_PROXY_CONNECTIONS = 64;

const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function writeAtomic(target, value, beforePublish) {
  const staged = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      if (beforePublish) await beforePublish();
      try { await rename(staged, target); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 4) throw error;
        // Windows readers can briefly deny atomic replacement. Retry only the
        // same already-written publication; never rerun a bridge operation.
        await delay(20 * (attempt + 1));
      }
    }
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {});
    throw error;
  }
}

function installPaths(options = {}) {
  const configPath = resolveConfigPath(options);
  const installRoot = path.dirname(configPath);
  let runtimeRoot = options.defaultRuntimeRoot ?? path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp");
  try {
    const ownership = JSON.parse(readFileSync(path.join(installRoot, "ownership.json"), "utf8"));
    if (ownership?.schema === 2) runtimeRoot = path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp");
    if (ownership?.schema === 3 && typeof ownership.runtime?.root === "string" && path.isAbsolute(ownership.runtime.root)) runtimeRoot = ownership.runtime.root;
  } catch {}
  const paths = {
    installRoot,
    statePath: path.join(installRoot, BROKER_STATE_FILE),
    stoppedPath: path.join(installRoot, BROKER_STOPPED_FILE),
    configPath,
    brokerPath: path.join(runtimeRoot, "src", "broker.js"),
    proxyPath: path.join(runtimeRoot, "src", "proxy.js"),
    runtimeRoot,
    cliPath: path.join(runtimeRoot, "bin", "potassium-mcp.js"),
    ownershipPath: path.join(installRoot, "ownership.json"),
  };
  paths.identity = Object.fromEntries(["brokerPath", "configPath"]
    .map((key) => [key, canonicalPath(paths[key])]));
  paths.executables = installedExecutables(paths);
  return paths;
}

async function readState(statePath) {
  if (!await exists(statePath)) return null;
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (value?.schema !== BROKER_STATE_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      throw new Error("invalid broker state");
    }
    return value;
  } catch (error) {
    throw new Error(`Unable to read broker state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    return realpathSync.native(value);
  } catch {
    return null;
  }
}

function fileDigest(target) {
  let descriptor;
  try {
    descriptor = openSync(target, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(65536);
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function installedExecutables(paths) {
  let ownership;
  try {
    ownership = JSON.parse(readFileSync(paths.ownershipPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") return [];
    try { lstatSync(paths.ownershipPath); return []; }
    catch (missing) { if (missing.code !== "ENOENT") return []; }
    const executable = canonicalPath(process.execPath);
    return executable ? [executable] : [];
  }
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (ownership?.schema === 3) {
    const runtime = ownership.runtime;
    const executable = canonicalPath(runtime?.nodeExecutable);
    const cli = canonicalPath(paths.cliPath);
    if (ownership.status !== "active" || runtime?.mode !== "external"
      || !canonicalPath(paths.installRoot) || canonicalPath(ownership.installRoot) !== canonicalPath(paths.installRoot)
      || !paths.identity.configPath || canonicalPath(ownership.configPath) !== paths.identity.configPath
      || !canonicalPath(paths.runtimeRoot) || canonicalPath(runtime.root) !== canonicalPath(paths.runtimeRoot)
      || !executable || !/^[a-f0-9]{64}$/.test(runtime.nodeSha256 ?? "") || fileDigest(executable) !== runtime.nodeSha256
      || !cli || !object(ownership.hosts)) return [];
    try {
      if (!supportsRuntime(JSON.parse(readFileSync(path.join(paths.runtimeRoot, "package.json"), "utf8")))) return [];
    } catch { return []; }
    for (const [hostId, record] of Object.entries(ownership.hosts)) {
      if (!hostId || !object(record) || record.id !== hostId || !object(record.launcher)) return [];
      const { command, args, type } = record.launcher;
      if (type !== "stdio" || canonicalPath(command) !== executable || !Array.isArray(args) || args.length !== 6
        || canonicalPath(args[0]) !== cli || args[1] !== "serve" || args[2] !== "--config"
        || canonicalPath(args[3]) !== paths.identity.configPath || args[4] !== "--host-id" || args[5] !== hostId) return [];
    }
    return [executable];
  }
  if (!object(ownership) || ownership.schema !== 2
    || canonicalPath(ownership.installRoot) !== canonicalPath(paths.installRoot)
    || canonicalPath(ownership.appPath) !== canonicalPath(path.join(paths.installRoot, "app"))
    || !paths.identity.configPath || canonicalPath(ownership.configPath) !== paths.identity.configPath
    || !object(ownership.hosts)) return [];
  const proxy = canonicalPath(paths.proxyPath);
  if (!proxy) return [];
  const executables = new Set();
  for (const [hostId, record] of Object.entries(ownership.hosts)) {
    if (!hostId || !object(record) || record.id !== hostId || !object(record.launcher)) return [];
    const { command, args, type } = record.launcher;
    const executable = canonicalPath(command);
    if (type !== "stdio" || !executable || !Array.isArray(args) || args.length !== 5
      || canonicalPath(args[0]) !== proxy || args[1] !== "--config"
      || canonicalPath(args[2]) !== paths.identity.configPath
      || args[3] !== "--host-id" || args[4] !== hostId) return [];
    executables.add(executable);
  }
  return [...executables].sort();
}

function verifiedExecutable(paths, value) {
  const current = installedExecutables(paths);
  if (current.length !== paths.executables.length
    || current.some((entry, index) => entry !== paths.executables[index])) return null;
  const executable = value === undefined ? current[0] : canonicalPath(value);
  return executable && current.includes(executable) ? executable : null;
}

export async function resolveBrokerLaunch(options = {}) {
  if (typeof options.configFile !== "string" || !path.isAbsolute(options.configFile)) throw new Error("Broker configuration path must be absolute");
  const paths = installPaths({ ...options, defaultRuntimeRoot: fileURLToPath(new URL("..", import.meta.url)) });
  const command = verifiedExecutable(paths);
  if (!command || !paths.identity.configPath || !paths.identity.brokerPath) throw new Error("Broker runtime ownership or configuration could not be verified");
  return { command, args: [paths.identity.brokerPath, "--config", options.configFile] };
}

function expectedState(paths, state) {
  if (!state || state.schema !== BROKER_STATE_SCHEMA || !/^[a-f0-9]{32}$/.test(state.instanceId ?? "")
    || typeof state.nodeExecutable !== "string" || !/^[a-f0-9]{64}$/i.test(state.configDigest ?? "")) return false;
  return verifiedExecutable(paths, state.nodeExecutable) !== null && ["brokerPath", "configPath"].every((key) => {
    const expected = paths.identity[key];
    return expected !== null && canonicalPath(paths[key]) === expected && canonicalPath(state[key]) === expected;
  });
}

// Windows argv[0] has different quoting rules from the remaining CRT arguments.
function windowsArgv(commandLine) {
  if (typeof commandLine !== "string" || !commandLine.length
    || commandLine.length > 32767 || commandLine.includes("\0")) return null;
  const argv = [];
  let index = 0;
  const whitespace = (character) => character === " " || character === "\t";
  while (whitespace(commandLine[index])) index += 1;
  let quoted = false;
  let executable = "";
  while (index < commandLine.length) {
    const character = commandLine[index];
    if (!quoted && whitespace(character)) break;
    if (character === '"') quoted = !quoted;
    else executable += character;
    index += 1;
  }
  if (quoted || !executable) return null;
  argv.push(executable);
  while (index < commandLine.length) {
    while (whitespace(commandLine[index])) index += 1;
    if (index === commandLine.length) break;
    let argument = "";
    quoted = false;
    while (index < commandLine.length) {
      if (!quoted && whitespace(commandLine[index])) break;
      let slashes = 0;
      while (commandLine[index] === "\\") { slashes += 1; index += 1; }
      if (commandLine[index] === '"') {
        argument += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) argument += '"';
        else if (quoted && commandLine[index + 1] === '"') {
          argument += '"';
          index += 1;
        } else quoted = !quoted;
        index += 1;
      } else {
        argument += "\\".repeat(slashes);
        if (index === commandLine.length || (!quoted && whitespace(commandLine[index]))) break;
        argument += commandLine[index++];
      }
    }
    if (quoted) return null;
    argv.push(argument);
  }
  return argv;
}

function linuxProcessExited(pid) {
  let fd;
  try {
    fd = openSync(`/proc/${pid}/stat`, "r");
    const buffer = Buffer.alloc(4096);
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === buffer.length) return false;
    const stat = buffer.toString("utf8", 0, count);
    return stat.startsWith(`${pid} (`) && /^[ZXx] /.test(stat.slice(stat.lastIndexOf(")") + 2));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function processInfoForPid(pid) {
  const exited = () => {
    try { process.kill(pid, 0); return process.platform === "linux" && linuxProcessExited(pid); }
    catch (error) {
      if (error.code === "ESRCH") return true;
      throw new Error(`Unable to inspect broker process ${pid}: ${error.message}`);
    }
  };
  if (exited()) return { exited: true };
  let info = null;
  try {
    if (process.platform === "win32") {
      // Allow cold Windows PowerShell/CIM startup for this OS observation, not an RPC deadline.
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        WINDOWS_POWERSHELL_PRELUDE + `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ executable = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`,
      ], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536, env: windowsPowerShellEnvironment() });
      if (result.status === 0 && result.stdout.trim()) info = JSON.parse(result.stdout);
    } else {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (raw.endsWith("\0")) {
        info = { executable: readlinkSync(`/proc/${pid}/exe`), argv: raw.slice(0, -1).split("\0") };
      }
    }
  } catch {}
  return exited() ? { exited: true } : info;
}

function processIdentity(state, paths, inspect = processInfoForPid) {
  if (!expectedState(paths, state)) return "mismatch";
  const info = inspect(state.pid);
  if (info?.exited === true) return "gone";
  const argv = info?.argv ?? windowsArgv(info?.commandLine);
  if (!Array.isArray(argv) || argv.length !== 4 || argv[2] !== "--config") return "mismatch";
  const executable = verifiedExecutable(paths, state.nodeExecutable);
  return executable !== null && canonicalPath(info.executable) === executable
    && canonicalPath(argv[0]) === executable
    && canonicalPath(argv[1]) === canonicalPath(paths.brokerPath)
    && canonicalPath(argv[3]) === canonicalPath(paths.configPath) ? "running" : "mismatch";
}

function sameGeneration(left, right) {
  return left?.instanceId === right?.instanceId && left?.pid === right?.pid;
}
function readiness(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ready) => { socket.removeAllListeners(); socket.destroy(); resolve(ready); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function publicState(state, status, ready) {
  return {
    status,
    pid: state?.pid ?? null,
    version: state?.version ?? null,
    readiness: ready ? "ready" : (status === "running" ? "unreachable" : "unknown"),
    configDigest: state?.configDigest ?? null,
    active: state?.active ?? null,
    activeRequests: state?.activeRequests ?? [],
    recovering: state?.recovering ?? false,
    draining: state?.draining ?? false,
    startedAt: state?.startedAt ?? null,
    streamableHttp: state?.streamableHttp ?? null,
  };
}

async function lifecycleSnapshot(paths, options) {
  const state = await readState(paths.statePath);
  if (!state) return { state: null, status: publicState(null, "absent", false) };
  if (processIdentity(state, paths, options.processInfoForPid) !== "running") {
    const stopped = await hasStoppedReceipt(paths, state, options);
    if (stopped) {
      const current = await readState(paths.statePath);
      if (!current || !STOPPED_IDENTITY_KEYS.every((key) => current[key] === state[key])) return { state: current, status: publicState(current ?? state, "stale", false) };
      return { state: current, status: publicState({ ...current, active: null, activeRequests: [], recovering: false, draining: false }, "stopped", false) };
    }
    return { state, status: publicState(state, "stale", false) };
  }
  const ready = await (options.probeReadiness ?? readiness)(state.proxyHost, state.proxyPort);
  const current = await readState(paths.statePath);
  if (!sameGeneration(state, current)
    || processIdentity(current, paths, options.processInfoForPid) !== "running") {
    return { state: current, status: publicState(current ?? state, "stale", false) };
  }
  return { state: current, status: publicState(current, "running", ready), ready };
}

export async function brokerStatus(options = {}) {
  return (await lifecycleSnapshot(installPaths(options), options)).status;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function repairDrainCredentials(paths, owner, options) {
  if (!options.installLease || !options.repairContext || owner.configDigest !== options.repairContext.ownedConfigSha256) {
    throw new Error("Repair drain is not bound to the original owned broker configuration");
  }
  const verifyOwner = async () => {
    const current = await readState(paths.statePath);
    if (!sameGeneration(owner, current) || current.configDigest !== owner.configDigest
      || processIdentity(current, paths, options.processInfoForPid) !== "running") {
      throw new Error("Repair drain broker identity or configuration changed");
    }
  };
  await verifyOwner();
  const credentials = await readRepairDrainCredentials(paths.configPath, options.installLease, options.repairContext);
  await verifyOwner();
  return credentials;
}

async function drainOwnedBroker(paths, owner, deadline, options = {}) {
  const config = options.repairContext
    ? await repairDrainCredentials(paths, owner, options)
    : await loadConfig(paths.configPath);
  const clientNonce = randomBytes(32).toString("hex");
  const leaseId = randomBytes(16).toString("hex");
  const hostId = "omp";
  const host = owner.proxyHost === "::1" ? "[::1]" : owner.proxyHost;
  if ((owner.proxyHost !== "127.0.0.1" && owner.proxyHost !== "::1")
    || !Number.isInteger(owner.proxyPort) || owner.proxyPort < 1 || owner.proxyPort > 65535) throw new Error("refusing broker drain: invalid loopback endpoint");
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${owner.proxyPort}`, { maxPayload: config.proxyMaxFrameBytes });
    let phase = "challenge";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Broker drain was not confirmed before its deadline; no signal sent. Inspect draining status before retrying.")), Math.max(1, deadline - Date.now()));
    socket.on("error", () => finish(new Error("Authenticated broker drain connection failed; no signal sent")));
    socket.once("close", () => finish(new Error("Broker closed before confirming its drain; no signal sent")));
    socket.once("open", () => socket.send(JSON.stringify({ type: "proxy-hello", protocol: PROXY_PROTOCOL, hostId, clientNonce })));
    socket.on("message", (raw, binary) => {
      if (settled) return;
      let message;
      try { message = binary ? null : JSON.parse(raw.toString("utf8")); } catch {}
      if (phase === "challenge" && message?.type === "proxy-challenge"
        && message.protocol === PROXY_PROTOCOL && /^[a-f0-9]{64}$/i.test(message.serverNonce ?? "")
        && proofMatches(message.proof, proxyProof(config.token, "server", clientNonce, message.serverNonce, hostId))) {
        phase = "ready";
        socket.send(JSON.stringify({ type: "proxy-ack", proof: proxyProof(config.token, "client", clientNonce, message.serverNonce, hostId) }));
      } else if (phase === "ready" && message?.type === "proxy-ready") {
        phase = "drain";
        socket.send(JSON.stringify({ type: "broker-drain", instanceId: owner.instanceId, leaseId }));
      } else if (phase === "drain" && message?.type === "broker-drained" && message.instanceId === owner.instanceId && message.leaseId === leaseId) {
        finish();
      } else {
        finish(new Error("Broker does not support or did not accept an exact-generation authenticated drain; no signal sent"));
      }
    });
  });
}

async function hasStoppedReceipt(paths, state, options) {
  if (!state) return false;
  const receipt = await readState(paths.stoppedPath);
  if (receipt?.stopped !== true || !/^[a-f0-9]{32}$/.test(receipt.instanceId ?? "")
    || !/^[a-f0-9]{64}$/i.test(receipt.configDigest ?? "")
    || !["nodeExecutable", "brokerPath", "configPath"].every((key) => typeof receipt[key] === "string" && path.isAbsolute(receipt[key]))
    || !paths.identity.configPath || canonicalPath(receipt.configPath) !== paths.identity.configPath
    || !STOPPED_IDENTITY_KEYS.every((key) => receipt[key] === state[key])) return false;
  return (options.processInfoForPid ?? processInfoForPid)(state.pid)?.exited === true;
}

async function waitUntilIdle(paths, options, action, deadline) {
  let snapshot = await lifecycleSnapshot(paths, options);
  if (snapshot.status.status === "stale") {
    throw new Error(`refusing to ${action}: broker state is stale or process identity could not be verified`);
  }
  const owner = snapshot.state;
  while (snapshot.status.active || snapshot.status.recovering) {
    if (Date.now() >= deadline) throw new Error(`refusing to ${action} while a broker request is active`);
    await delay(Math.min(100, deadline - Date.now()));
    snapshot = await lifecycleSnapshot(paths, options);
    if (snapshot.status.status !== "running" || !sameGeneration(owner, snapshot.state)) {
      throw new Error(`refusing to ${action}: broker ownership changed while waiting`);
    }
  }
  return snapshot;
}

async function signalOwnedBroker(paths, options, owner, action) {
  const current = await readState(paths.statePath);
  if (!sameGeneration(owner, current)
    || processIdentity(current, paths, options.processInfoForPid) !== "running") {
    throw new Error(`refusing to ${action}: broker process identity or ownership changed`);
  }
  if (action === "stop" && options.repairContext) await repairDrainCredentials(paths, owner, options);
  // CIM inspection may take time. Re-read ownership after it, without yielding
  // between the last state/identity check and the signal.
  const latest = JSON.parse(readFileSync(paths.statePath, "utf8"));
  if (!sameGeneration(owner, latest) || !expectedState(paths, latest)) {
    throw new Error(`refusing to ${action}: broker process identity or ownership changed`);
  }
  if (latest.active || latest.recovering) throw new Error(`refusing to ${action} while a broker request is active`);
  (options.signalProcess ?? process.kill)(latest.pid, "SIGTERM");
}

function lifecycleDeadline(options) {
  const waitMs = options.waitMs ?? DEFAULT_RESTART_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw new Error("waitMs must be an integer between 0 and 120000");
  return { waitMs, deadline: Date.now() + waitMs };
}

async function validateStartupLease(lease, installRoot, borrowed = false) {
  const root = canonicalPath(installRoot);
  if (!root || canonicalPath(lease?.installRoot) !== root) throw new Error("Internal install lease does not match the selected private root");
  await verifyInstallLease(lease, { requireCommittedJournal: borrowed });
}

export async function restartBroker(options = {}) {
  const paths = installPaths(options);
  if (options.installLease) await validateStartupLease(options.installLease, paths.installRoot, true);
  const { waitMs, deadline } = lifecycleDeadline(options);
  const initial = await waitUntilIdle(paths, options, "restart", deadline);
  const owner = initial.state;
  const stopped = initial.status.status === "stopped";
  if (owner && !stopped) {
    await (options.drainBroker ?? drainOwnedBroker)(paths, owner, deadline);
    await signalOwnedBroker(paths, options, owner, "restart");
    for (;;) {
      const identity = processIdentity(owner, paths, options.processInfoForPid);
      if (identity === "gone") break;
      const current = await readState(paths.statePath);
      if (identity !== "running" || (current && !expectedState(paths, current))) {
        throw new Error("refusing to restart: broker process identity or ownership changed during shutdown");
      }
      if (current && !sameGeneration(owner, current)) {
        if (processIdentity(current, paths, options.processInfoForPid) !== "running") {
          throw new Error("refusing to restart: replacement broker identity could not be verified");
        }
        break;
      }
      if (Date.now() >= deadline) throw new Error("broker did not stop before restart deadline");
      await delay(Math.min(100, deadline - Date.now()));
    }
  }
  const readyDeadline = Date.now() + waitMs;
  let spawned = false;
  // A proxy may win the startup race. Adopt only a newly verified generation;
  // never signal it, and never compete with one already recorded as starting.
  do {
    const current = await readState(paths.statePath);
    const replacement = current && (!owner || !sameGeneration(owner, current));
    const recordedStopped = stopped && current && sameGeneration(owner, current);
    if (recordedStopped && !await hasStoppedReceipt(paths, current, options)) throw new Error("refusing to restart: stopped broker ownership changed");
    if (replacement) {
      if (owner && current.instanceId === owner.instanceId) {
        throw new Error("refusing to restart: replacement broker ownership changed without a new generation");
      }
      if (!expectedState(paths, current)
        || processIdentity(current, paths, options.processInfoForPid) !== "running") {
        throw new Error("refusing to restart: replacement broker identity could not be verified");
      }
      const snapshot = await lifecycleSnapshot(paths, options);
      if (!sameGeneration(current, snapshot.state) || snapshot.status.status !== "running") {
        throw new Error("refusing to restart: replacement broker ownership changed");
      }
      if (snapshot.ready) return snapshot.status;
    } else if (current && !recordedStopped && (!owner || !expectedState(paths, current)
      || processIdentity(current, paths, options.processInfoForPid) !== "gone")) {
      throw new Error("refusing to restart: broker process identity or ownership changed before launch");
    } else if (!spawned) {
      const executable = verifiedExecutable(paths, stopped ? undefined : owner?.nodeExecutable);
      if (!executable || !["brokerPath", "configPath"].every((key) =>
        paths.identity[key] !== null && canonicalPath(paths[key]) === paths.identity[key])) {
        throw new Error("installed broker runtime or configuration is missing");
      }
      const childEnv = { ...process.env, POTASSIUM_MCP_BROKER_STATE: paths.statePath };
      delete childEnv.POTASSIUM_MCP_INSTALL_LEASE;
      if (options.installLease) {
        await validateStartupLease(options.installLease, paths.installRoot, true);
        const lease = Object.fromEntries(["schema", "pid", "hostname", "installRoot", "nonce"].map((key) => [key, options.installLease[key]]));
        childEnv.POTASSIUM_MCP_INSTALL_LEASE = JSON.stringify(lease);
        if (Buffer.byteLength(childEnv.POTASSIUM_MCP_INSTALL_LEASE) > 1024) throw new Error("Internal install lease exceeds its byte limit");
      }
      const child = (options.spawnProcess ?? spawn)(executable, [paths.brokerPath, "--config", paths.configPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: childEnv,
      });
      child.unref();
      spawned = true;
    }
    if (Date.now() >= readyDeadline) break;
    await delay(Math.min(50, readyDeadline - Date.now()));
  } while (Date.now() <= readyDeadline);
  throw new Error("restarted broker did not become ready before restart deadline");
}

export async function stopBroker(options = {}) {
  const paths = installPaths(options);
  const { deadline } = lifecycleDeadline(options);
  const initial = await waitUntilIdle(paths, options, "stop", deadline);
  if (!initial.state || initial.status.status === "stopped") return initial.status;
  const owner = initial.state;
  await (options.drainBroker ?? drainOwnedBroker)(paths, owner, deadline, options);
  await signalOwnedBroker(paths, options, owner, "stop");
  for (;;) {
    const current = await readState(paths.statePath);
    if (current && (!sameGeneration(owner, current) || !expectedState(paths, current))) {
      throw new Error("refusing to stop: broker ownership changed during shutdown");
    }
    const identity = processIdentity(owner, paths, options.processInfoForPid);
    if (identity === "gone") {
      await writeAtomic(paths.stoppedPath, {
        schema: BROKER_STATE_SCHEMA, stopped: true,
        ...Object.fromEntries(STOPPED_IDENTITY_KEYS.map((key) => [key, owner[key]])),
      });
      // Never remove the active state: a concurrently started proxy may publish
      // a replacement between any check and unlink. Only this receipt is ours.
      const latest = await readState(paths.statePath);
      if (latest && (!sameGeneration(owner, latest) || !expectedState(paths, latest))) throw new Error("refusing to stop: broker ownership changed during shutdown");
      return publicState(owner, "stopped", false);
    }
    if (identity !== "running") throw new Error("refusing to stop: broker process identity changed during shutdown");
    if (Date.now() >= deadline) throw new Error("broker did not stop before stop deadline");
    await delay(Math.min(100, deadline - Date.now()));
  }
}

async function createDetachedStateTracker(broker, configPath, statePath, validateStartup) {
  const rawConfig = await readFile(configPath, "utf8");
  const instanceId = broker.instanceId;
  const proxyAddress = broker.listener.address();
  const state = {
    schema: BROKER_STATE_SCHEMA,
    instanceId,
    pid: process.pid,
    nodeExecutable: process.execPath,
    brokerPath: path.resolve(process.argv[1]),
    configPath: path.resolve(configPath),
    configDigest: digest(rawConfig),
    version: packageMetadata.version,
    proxyHost: broker.config.proxyHost,
    proxyPort: typeof proxyAddress === "object" ? proxyAddress.port : broker.config.proxyPort,
    readiness: "ready",
    active: null,
    startedAt: new Date().toISOString(),
    streamableHttp: broker.streamableHttp ?? null,
  };
  let writing = Promise.resolve();
  let starting = true;
  let publicationFailed = false;
  const snapshot = () => {
    const status = broker.bridge.status();
    return {
      ...state,
      active: status.active,
      activeRequests: status.activeRequests,
      recovering: status.recovering,
      draining: status.draining,
    };
  };
  const flush = () => {
    const value = snapshot();
    const next = writing.then(() => writeAtomic(statePath, value, starting ? validateStartup : undefined));
    writing = next.then(
      () => { publicationFailed = false; },
      () => { publicationFailed = true; },
    );
    return next;
  };
  const onActivity = () => { void flush().catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "UNKNOWN";
    console.error("[potassium-broker] Unable to update detached broker state:", code);
  }); };
  broker.bridge.on("activity", onActivity);
  try { await flush(); } catch (error) { broker.bridge.off("activity", onActivity); throw error; }
  starting = false;
  const ownsState = (current) => current && STOPPED_IDENTITY_KEYS.every((key) => current[key] === state[key]);
  const validateOwnership = async () => {
    if (!ownsState(await readState(statePath))) throw new Error("Detached broker state ownership changed during shutdown");
  };
  return {
    async close() {
      broker.bridge.off("activity", onActivity);
      await writing;
      const current = await readState(statePath);
      if (!ownsState(current)) return;
      // Activity writes keep the queue alive after errors. A failed last write
      // must not turn stale state into a successful shutdown receipt.
      if (publicationFailed) await writeAtomic(statePath, snapshot(), validateOwnership);
      await writeAtomic(path.join(path.dirname(configPath), BROKER_STOPPED_FILE), {
        schema: BROKER_STATE_SCHEMA, stopped: true,
        ...Object.fromEntries(STOPPED_IDENTITY_KEYS.map((key) => [key, state[key]])),
      }, validateOwnership);
    },
  };
}

function logger() {
  return {
    info: (...args) => console.error("[potassium-broker]", ...args),
    error: (...args) => console.error("[potassium-broker]", ...args),
  };
}

export function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function proxyProof(token, role, clientNonce, serverNonce, hostId = "") {
  const transcript = `${PROXY_DOMAIN}|${role}|${hostId}|${clientNonce}|${serverNonce}`;
  return createHmac("sha256", token).update(createHash("sha256").update(transcript, "utf8").digest()).digest("base64");
}

export function proofMatches(actual, expected) {
  try {
    const left = Buffer.from(actual, "base64");
    const right = Buffer.from(expected, "base64");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function bearerMatches(authorization, token) {
  if (typeof authorization !== "string") return false;
  const actual = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return isLoopback(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

function mcpFailure(response, status, message, headers = {}, code = -32600) {
  response.status(status).set(headers).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function writeMcpFailure(response, status, message, headers = {}, code = -32600) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function closeListener(listener) {
  if (!listener) return Promise.resolve();
  for (const socket of listener.clients ?? []) socket.terminate?.();
  for (const socket of listener.mcpClients ?? []) socket.destroy();
  listener.closeAllConnections?.();
  return new Promise((resolve) => listener.close(() => resolve())).catch(() => {});
}

function endpointFor(host, port) {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp`;
}


export class WebSocketMcpTransport {
  constructor(socket, maxFrameBytes, lifecycle = {}) {
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;
    this.pendingResponses = new Map();
    this.onResponseActivity = lifecycle.onActivity;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    socket.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data) > maxFrameBytes) return socket.close(1009, "invalid MCP frame");
      try {
        const message = JSON.parse(data.toString("utf8"));
        if (message?.type === "broker-drain" && lifecycle.onControl) return lifecycle.onControl(message);
        if (!JSONRPCMessageSchema.safeParse(message).success) return socket.close(1007, "invalid MCP message");
        if (typeof message?.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
          if (this.pendingResponses.has(message.id)) return socket.close(1008, "duplicate MCP request ID");
          if (lifecycle.isDraining?.() || lifecycle.isAtCapacity?.() || this.pendingResponses.size >= MAX_PENDING_MCP_REQUESTS) {
            void this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Broker is draining or at request capacity; request was not dispatched" } }).catch(() => socket.close(1011, "MCP response failed"));
            return;
          }
          this.pendingResponses.set(message.id, "waiting");
          this.onResponseActivity?.();
        }
        this.onmessage?.(message);
      } catch { socket.close(1007, "invalid JSON"); }
    });
    socket.once("error", (error) => this.onerror?.(error));
    socket.once("close", () => {
      this.pendingResponses.clear();
      this.onResponseActivity?.();
      this.onclose?.();
    });
  }
  get hasPendingResponses() { return this.pendingResponses.size > 0; }
  cancelRequest(id) {
    if (this.pendingResponses.get(id) !== "waiting") return;
    this.pendingResponses.delete(id);
    this.onResponseActivity?.();
  }
  async start() {}
  async send(message) {
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new Error("MCP frame exceeds proxy limit");
    if (this.socket.readyState !== 1) throw new Error("Proxy connection is closed");
    const response = Object.hasOwn(message, "result") || Object.hasOwn(message, "error");
    if (response && this.pendingResponses.has(message.id)) this.pendingResponses.set(message.id, "sending");
    await new Promise((resolve, reject) => this.socket.send(frame, (error) => error ? reject(error) : resolve()));
    if (response && this.pendingResponses.delete(message.id)) this.onResponseActivity?.();
  }
  async close() { if (this.socket.readyState < 2) this.socket.close(); }
}

export async function createBroker(inputConfig, { configFile, gameContextService, mapContextService, mapRecordingService, nativeEditor } = {}) {
  if (inputConfig === undefined) configFile = resolveConfigPath({ configFile });
  const config = inputConfig === undefined ? await loadConfig(configFile) : await parseConfig(inputConfig);
  const log = logger();
  const bridge = new PotassiumBridge(config, log);
  const instanceId = randomBytes(16).toString("hex");
  const mcpTransports = new Set();
  const httpResponses = new Map();
  const httpResponseOwners = new Map();
  const httpScopes = new Map();
  const createHttpScope = (scope, stateful = false) => {
    const stats = { scope, stateful, members: 0, retained: 0, handlers: 0, dispatches: 0, groups: new Set(), closed: false, retiring: false, retireRequested: false };
    httpScopes.set(scope, stats);
    return stats;
  };
  let httpResponseMembers = 0;
  const responseWaiters = new Set();
  let activeToolHandlers = 0;
  let pendingDispatches = 0;
  const responseActivity = () => { for (const check of responseWaiters) check(); };
  const releaseHttpGroups = (stats) => {
    for (const group of stats.groups) {
      if (!group.finished) continue;
      let settled = true;
      for (const state of group.members.values()) if (state === "waiting") settled = false;
      if (!settled && (stats.handlers > 0 || stats.dispatches > 0)) continue;
      httpResponses.delete(group.response);
      httpResponseMembers -= group.members.size;
      stats.members -= group.members.size;
      if (stats.stateful && !stats.closed && group.hasCancellation) stats.retained += group.members.size;
      const owners = httpResponseOwners.get(group.scope);
      for (const id of group.members.keys()) if (owners?.get(id) === group) owners.delete(id);
      if (owners?.size === 0) httpResponseOwners.delete(group.scope);
      stats.groups.delete(group);
    }
    if (!stats.stateful && stats.groups.size === 0 && stats.handlers === 0 && stats.dispatches === 0 && httpScopes.get(stats.scope) === stats) httpScopes.delete(stats.scope);
    if ((stats.retained >= MAX_PENDING_MCP_REQUESTS || stats.retireRequested) && stats.members === 0 && stats.handlers === 0 && stats.dispatches === 0 && !stats.closed && !stats.retiring) {
      stats.retiring = true;
      void stats.retire?.().catch(() => log.error("stateful HTTP cancellation retention cleanup failed"));
    }
    responseActivity();
  };
  const startHttpWork = (stats, field, start) => {
    const finish = start();
    stats[field] += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      stats[field] -= 1;
      releaseHttpGroups(stats);
      finish();
    };
  };
  const completeHttpResponse = (scope, id, state, closeStream) => {
    const owners = httpResponseOwners.get(scope);
    const group = owners?.get(id);
    if (!group || group.members.get(id) !== "waiting") return;
    group.members.set(id, state);
    if (state === "cancelled") group.hasCancellation = true;
    if (group.hasCancellation && !group.closing) {
      let complete = true;
      for (const member of group.members.values()) if (member === "waiting") complete = false;
      if (complete) {
        for (const requestId of group.members.keys()) {
          // A canceled ID may have been reused on another response stream.
          // Never close that successor via the native request-ID correlation.
          if (owners.get(requestId) !== group) continue;
          group.closing = true;
          closeStream(requestId);
          break;
        }
      }
    }
    releaseHttpGroups(group.stats);
  };
  const onRequestStart = () => {
    if (pendingDispatches >= MAX_PENDING_MCP_REQUESTS) throw Object.assign(new Error("Broker request dispatch capacity exceeded"), { code: "CAPACITY", submissionIndeterminate: false });
    pendingDispatches += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      pendingDispatches -= 1;
      responseActivity();
    };
  };
  const onToolStart = () => {
    if (activeToolHandlers >= MAX_PENDING_MCP_REQUESTS) throw Object.assign(new Error("Broker tool handler capacity exceeded"), { code: "CAPACITY", submissionIndeterminate: false });
    activeToolHandlers += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      activeToolHandlers -= 1;
      responseActivity();
    };
  };
  const responsesIdle = () => {
    if (activeToolHandlers > 0 || pendingDispatches > 0 || httpResponses.size > 0) return false;
    for (const transport of mcpTransports) if (transport.hasPendingResponses) return false;
    return true;
  };
  const drain = async (signal) => {
    await bridge.drain(signal);
    if (signal?.aborted) throw new Error("Broker drain cancelled");
    if (responsesIdle()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { responseWaiters.delete(check); signal?.removeEventListener("abort", abort); };
      const check = () => { if (responsesIdle()) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(new Error("Broker drain cancelled")); };
      responseWaiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  };
  let drainLease;
  let terminalDraining = false;
  const handleDrain = (socket, message) => {
    if (message.instanceId !== instanceId || !/^[a-f0-9]{32}$/.test(message.leaseId ?? "")
      || (drainLease && !drainLease.committing)) {
      socket.send(JSON.stringify({ type: "broker-drain-rejected" }));
      return;
    }
    const lease = { socket, leaseId: message.leaseId, committing: Boolean(drainLease?.committing), abort: new AbortController() };
    drainLease = lease;
    const release = () => {
      if (drainLease !== lease || lease.committing) return;
      drainLease = undefined;
      lease.abort.abort();
      if (!terminalDraining) bridge.resumeAdmission();
    };
    socket.once("close", release);
    void drain(lease.abort.signal).then(() => {
      if (drainLease !== lease || socket.readyState !== WebSocket.OPEN) { release(); return; }
      // Once an acknowledgment send is attempted it may reach the manager even
      // if the callback fails. Never reopen admission after that uncertainty.
      lease.committing = true;
      socket.send(JSON.stringify({ type: "broker-drained", instanceId, leaseId: lease.leaseId }), (error) => {
        if (error) socket.close(1011, "broker drain acknowledgment failed");
      });
    }).catch(() => { release(); });
  };
  const audit = new AdminAuditRecorder({ path: config.adminAuditPath });
  const artifactRoot = config.artifactRoots.find((root) => root.recursive);
  const artifactStore = artifactRoot
    ? createAsyncArtifactStore({ root: artifactRoot, clock: { now: () => Date.now() }, randomBytes })
    : undefined;
  const compactResultStore = createCompactResultStore();
  const codeIndexService = createCodeIndexService();
  gameContextService ??= configFile === undefined ? undefined : createGameContextService({ configFile: path.resolve(configFile) });
  mapContextService ??= configFile === undefined ? undefined : createMapContextService({
    configFile: path.resolve(configFile), gameContextService,
  });
  mapRecordingService ??= mapContextService === undefined ? undefined : createMapRecordingService({ mapContextService });
  const sharedHttpSessionStats = createSessionStats({ toolNames: TOOL_NAMES });
  const builtinFallback = config.builtinFallbackEnabled
    ? createBuiltinFallbackClient({ tokenFile: config.builtinFallbackTokenFile })
    : undefined;
  nativeEditor ??= config.nativeEditorEnabled ? createNativeEditorClient({ tokenFile: config.nativeEditorTokenFile }) : undefined;
  let listener;
  let httpListener;
  let statefulSessions;
  try {
    await bridge.start();
    listener = new WebSocketServer({
      host: config.proxyHost,
      port: config.proxyPort,
      maxPayload: config.proxyMaxFrameBytes,
      perMessageDeflate: false,
    });
  listener.on("connection", (socket, request) => {
    if (listener.clients.size > MAX_PROXY_CONNECTIONS) return socket.close(1013, "proxy connection capacity exceeded");
    if (!isLoopback(request.socket.remoteAddress)) return socket.close(1008, "loopback required");
    socket.on("error", () => {});
    let authenticated = false;
    let timer = setTimeout(() => socket.close(1008, "handshake timeout"), config.proxyHandshakeTimeoutMs);
    timer.unref();
    socket.once("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data) > config.proxyMaxFrameBytes) return socket.close(1009, "invalid handshake frame");
      let hello;
      try { hello = JSON.parse(data.toString("utf8")); } catch { return socket.close(1007, "invalid JSON"); }
      if (hello?.type !== "proxy-hello" || hello.protocol !== PROXY_PROTOCOL || !/^[a-f0-9]{64}$/i.test(hello.clientNonce ?? "") || typeof hello.hostId !== "string") return socket.close(1008, "invalid hello");
      let policy;
      try {
        policy = resolveHostPolicy(hello.hostId, config.policies.hosts);
      } catch {
        return socket.close(1008, "unknown host");
      }
      const serverNonce = randomBytes(32).toString("hex");
      const challenge = JSON.stringify({ type: "proxy-challenge", protocol: PROXY_PROTOCOL, serverNonce, proof: proxyProof(config.token, "server", hello.clientNonce, serverNonce, hello.hostId) });
      socket.once("message", async (ack, ackBinary) => {
        if (ackBinary || Buffer.byteLength(ack) > config.proxyMaxFrameBytes) return socket.close(1009, "invalid proof frame");
        let payload;
        try { payload = JSON.parse(ack.toString("utf8")); } catch { return socket.close(1007, "invalid JSON"); }
        const expected = proxyProof(config.token, "client", hello.clientNonce, serverNonce, hello.hostId);
        if (payload?.type !== "proxy-ack" || !proofMatches(payload.proof, expected)) return socket.close(1008, "authentication failed");
        authenticated = true;
        clearTimeout(timer);
        const sessionId = randomBytes(16).toString("hex");
        const transport = new WebSocketMcpTransport(socket, config.proxyMaxFrameBytes, {
          onControl: (message) => handleDrain(socket, message),
          onActivity: responseActivity,
          isDraining: () => terminalDraining || bridge.draining,
          isAtCapacity: () => activeToolHandlers >= MAX_PENDING_MCP_REQUESTS || pendingDispatches >= MAX_PENDING_MCP_REQUESTS,
        });
        mcpTransports.add(transport);
        socket.once("close", () => { mcpTransports.delete(transport); responseActivity(); });
        const server = createToolServer(config, bridge, {
          audit, sessionId, hostId: hello.hostId, policy, artifactStore, builtinFallback, nativeEditor, compactResultStore, codeIndexService, gameContextService, mapContextService, mapRecordingService, onToolStart, onRequestStart,
          onRequestCancelled: (id) => transport.cancelRequest(id),
        });
        try {
          await server.connect(transport);
          socket.send(JSON.stringify({ type: "proxy-ready" }));
        } catch (error) {
          log.error("proxy MCP session failed", error);
          await server.close().catch(() => {});
          socket.close(1011, "MCP session failed");
        }
      });
      socket.send(challenge);
    });
    socket.once("close", () => { clearTimeout(timer); if (!authenticated) return; });
  });
    await new Promise((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });
    if (config.streamableHttpEnabled || config.statefulHttpEnabled) {
      const app = createMcpExpressApp({ host: config.streamableHttpHost });
      app.use((request, response, next) => {
        const messages = Array.isArray(request.body) ? request.body : [request.body];
        const cancellation = request.method === "POST" && messages.length > 0 && messages.every((message) => message?.method === "notifications/cancelled" && !Object.hasOwn(message, "id"));
        if ((terminalDraining || bridge.draining) && !cancellation) return mcpFailure(response, 503, "Broker is draining; request was not dispatched");
        const sessionId = request.path === "/mcp/session" ? request.headers[MCP_SESSION_HEADER] : undefined;
        if (request.method === "POST" && !cancellation) {
          const scope = typeof sessionId === "string" ? sessionId : response;
          let stats = httpScopes.get(scope);
          if (stats?.retiring || stats?.closed) return mcpFailure(response, 404, "MCP session expired after reaching its cancellation retention limit");
          const owners = httpResponseOwners.get(scope) ?? new Map();
          const members = new Map();
          for (const message of messages) {
            if (!isJSONRPCRequest(message)) continue;
            const prior = owners.get(message.id);
            if (members.has(message.id) || (prior && prior.members.get(message.id) !== "cancelled")) return mcpFailure(response, 400, "Duplicate active MCP request ID");
            if (members.size >= MAX_PENDING_MCP_REQUESTS) return mcpFailure(response, 429, "Broker request capacity exceeded; request was not dispatched");
            members.set(message.id, "waiting");
          }
          if (stats?.stateful && stats.retained > 0 && (stats.retireRequested || stats.members + stats.retained + members.size > MAX_PENDING_MCP_REQUESTS)) {
            stats.retireRequested = true;
            releaseHttpGroups(stats);
            return mcpFailure(response, stats.retiring ? 404 : 429, "MCP session cancellation retention limit reached; request was not dispatched");
          }
          if (httpResponses.size >= MAX_PENDING_MCP_REQUESTS || httpResponseMembers + members.size > MAX_PENDING_MCP_REQUESTS
            || (stats?.members ?? 0) + (stats?.retained ?? 0) + members.size > MAX_PENDING_MCP_REQUESTS
            || activeToolHandlers >= MAX_PENDING_MCP_REQUESTS || pendingDispatches >= MAX_PENDING_MCP_REQUESTS) return mcpFailure(response, 429, "Broker request capacity exceeded; request was not dispatched");
          stats ??= createHttpScope(scope);
          const group = { scope, response, stats, members, hasCancellation: false, closing: false, finished: false };
          httpResponses.set(response, group);
          httpResponseMembers += members.size;
          stats.members += members.size;
          stats.groups.add(group);
          for (const id of members.keys()) owners.set(id, group);
          if (owners.size > 0) httpResponseOwners.set(scope, owners);
          const finish = () => {
            response.off("finish", finish);
            response.off("close", finish);
            group.finished = true;
            releaseHttpGroups(stats);
          };
          response.once("finish", finish);
          response.once("close", finish);
        }
        next();
      });
      if (config.streamableHttpEnabled) {
        app.post("/mcp", async (request, response) => {
          const stats = httpResponses.get(response)?.stats ?? createHttpScope(response);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const closeStream = (id) => transport.closeSSEStream(id);
          const server = createToolServer(config, bridge, {
            audit,
            sessionId: randomBytes(16).toString("hex"),
            hostId: "http",
            policy: config.policies.http,
            artifactStore,
            builtinFallback,
            nativeEditor,
            compactResultStore,
            codeIndexService,
            gameContextService,
            mapContextService,
            mapRecordingService,
            sessionStats: sharedHttpSessionStats,
            releaseSessionStatsOnClose: false,
            resultScopeId: "http-stateless",
            releaseResultScopeOnClose: false,
            retainedSession: false,
            onToolStart: () => startHttpWork(stats, "handlers", onToolStart),
            onRequestStart: () => startHttpWork(stats, "dispatches", onRequestStart),
            onRequestCancelled: (id) => completeHttpResponse(response, id, "cancelled", closeStream),
            onResponseSent: (id) => completeHttpResponse(response, id, "sent", closeStream),
          });
          try {
            await server.connect(transport);
            await transport.handleRequest(request, response, request.body);
          } catch (error) {
            log.error("streamable HTTP MCP request failed", error);
            if (!response.headersSent) mcpFailure(response, 500, "Internal server error");
          } finally {
            await server.close().catch(() => {});
            stats.closed = true;
            releaseHttpGroups(stats);
          }
        });
        app.all("/mcp", (_request, response) => mcpFailure(response, 405, "Method not allowed", { Allow: "POST" }));
      } else {
        app.all("/mcp", (_request, response) => mcpFailure(response, 404, "Stateless HTTP is disabled"));
      }
      if (config.statefulHttpEnabled) {
        statefulSessions = createStatefulHttpSessionRegistry({
          serverFactory: async ({ sessionId: httpSessionId }) => {
            const stats = createHttpScope(httpSessionId, true);
            const closeStream = (id) => statefulSessions.closeResponseStream(httpSessionId, id, server);
            const server = createToolServer(config, bridge, {
              audit,
              sessionId: randomBytes(16).toString("hex"),
              hostId: "http",
              policy: config.policies.http,
              artifactStore,
              builtinFallback,
              nativeEditor,
              compactResultStore,
              codeIndexService,
              gameContextService,
              mapContextService,
              mapRecordingService,
              resultScopeId: httpSessionId,
              onToolStart: () => startHttpWork(stats, "handlers", onToolStart),
              onRequestStart: () => startHttpWork(stats, "dispatches", onRequestStart),
              onRequestCancelled: (id) => completeHttpResponse(httpSessionId, id, "cancelled", closeStream),
              onResponseSent: (id) => completeHttpResponse(httpSessionId, id, "sent", closeStream),
            });
            stats.server = server;
            stats.retire = () => statefulSessions.close(httpSessionId, server);
            return server;
          },
          onSessionClosed: (sessionId, server) => {
            const stats = httpScopes.get(sessionId);
            if (!stats || stats.server !== server) return;
            stats.closed = true;
            httpScopes.delete(sessionId);
            releaseHttpGroups(stats);
          },
        });
        app.all("/mcp/session", (request, response) => statefulSessions.handleRequest(request, response, request.body));
      } else {
        app.all("/mcp/session", (_request, response) => mcpFailure(response, 404, "Stateful HTTP is disabled"));
      }
      app.use((error, _request, response, _next) => {
        if (response.headersSent) return;
        if (error?.type === "entity.parse.failed") {
          mcpFailure(response, 400, "Parse error", {}, -32700);
          return;
        }
        if (error?.type === "entity.too.large" || error?.status === 413) {
          mcpFailure(response, 413, "Request body too large");
          return;
        }
        log.error("streamable HTTP middleware failed", error);
        mcpFailure(response, 500, "Internal server error");
      });
      httpListener = createHttpServer((request, response) => {
        const requestPath = request.url?.split("?")[0];
        if (requestPath !== "/mcp" && requestPath !== "/mcp/session") {
          writeMcpFailure(response, 404, "MCP endpoint not found");
          return;
        }
        if (!isLoopback(request.socket.remoteAddress)) {
          writeMcpFailure(response, 403, "Loopback connection required");
          return;
        }
        if (!bearerMatches(request.headers.authorization, config.token)) {
          writeMcpFailure(response, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
          return;
        }
        const origin = request.headers.origin;
        if (origin && !isLoopbackOrigin(origin)) {
          writeMcpFailure(response, 403, "Loopback origin required");
          return;
        }
        app(request, response);
      });
      httpListener.requestTimeout = 10000;
      httpListener.headersTimeout = 5000;
      httpListener.keepAliveTimeout = 5000;
      httpListener.maxHeadersCount = 64;
      httpListener.maxConnections = 64;
      httpListener.mcpClients = new Set();
      httpListener.on("connection", (socket) => {
        httpListener.mcpClients.add(socket);
        socket.once("close", () => httpListener.mcpClients.delete(socket));
      });
      httpListener.listen(config.streamableHttpPort, config.streamableHttpHost);
      await new Promise((resolve, reject) => {
        httpListener.once("listening", resolve);
        httpListener.once("error", reject);
      });
    }
  } catch (error) {
    compactResultStore.clear();
    codeIndexService.clear();
    sharedHttpSessionStats.clear();
    await gameContextService?.close();
    await mapContextService?.close();
    await mapRecordingService?.close();
    await closeListener(httpListener);
    await bridge.close().catch(() => {});
    await closeListener(listener);
    throw error;
  }
  const httpAddress = httpListener?.address();
  const httpPath = config.streamableHttpEnabled ? "/mcp" : "/mcp/session";
  const streamableHttp = httpAddress && typeof httpAddress !== "string"
    ? {
      host: config.streamableHttpHost, port: httpAddress.port, path: httpPath,
      endpoint: `${endpointFor(config.streamableHttpHost, httpAddress.port)}${config.streamableHttpEnabled ? "" : "/session"}`,
      statelessEndpoint: config.streamableHttpEnabled ? endpointFor(config.streamableHttpHost, httpAddress.port) : null,
      statefulEndpoint: config.statefulHttpEnabled ? `${endpointFor(config.streamableHttpHost, httpAddress.port)}/session` : null,
    }
    : undefined;
  let closed;
  return {
    config, bridge, listener, httpListener, streamableHttp, instanceId,
    drain() { terminalDraining = true; return drain(); },
    close() {
      terminalDraining = true;
      for (const socket of listener.clients) socket.terminate();
      closed ??= Promise.allSettled([
        statefulSessions?.closeAll(),
        closeListener(httpListener),
        closeListener(listener),
        bridge.close(),
        gameContextService?.close(),
        mapContextService?.close(),
        mapRecordingService?.close(),
      ]).then((results) => {
        compactResultStore.clear();
        codeIndexService.clear();
        sharedHttpSessionStats.clear();
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      });
      return closed;
    },
  };
}

export async function main() {
  const configPath = resolveConfigPath({ configFile: commandConfigPath() });
  const installRoot = path.dirname(configPath);
  if (!await exists(configPath)) await loadConfig(configPath);
  const leaseText = process.env.POTASSIUM_MCP_INSTALL_LEASE;
  delete process.env.POTASSIUM_MCP_INSTALL_LEASE;
  let lease;
  if (leaseText !== undefined) {
    if (Buffer.byteLength(leaseText) > 1024) throw new Error("Internal install lease exceeds its byte limit");
    try { lease = JSON.parse(leaseText); } catch { throw new Error("Internal install lease is invalid"); }
  }
  let release;
  let broker;
  let tracker;
  try {
    try {
      if (leaseText === undefined) {
        release = await acquireInstallLock({ installRoot }, { recover: false });
        lease = release.lease;
      }
      const validate = () => validateStartupLease(lease, installRoot, leaseText !== undefined);
      await validate();
      const paths = installPaths({ configFile: configPath, defaultRuntimeRoot: fileURLToPath(new URL("..", import.meta.url)) });
      if (!verifiedExecutable(paths, process.execPath) || canonicalPath(process.argv[1]) !== paths.identity.brokerPath) {
        throw new Error("Broker startup runtime identity could not be verified");
      }
      broker = await createBroker(undefined, { configFile: configPath });
      const statePath = process.env.POTASSIUM_MCP_BROKER_STATE
        ? path.resolve(process.env.POTASSIUM_MCP_BROKER_STATE)
        : path.join(installRoot, BROKER_STATE_FILE);
      tracker = await createDetachedStateTracker(broker, configPath, statePath, validate);
    } finally {
      await release?.();
    }
  } catch (error) {
    if (tracker) await tracker.close().catch(() => {});
    if (broker) await broker.close().catch(() => {});
    throw error;
  }
  const httpNotice = broker.streamableHttp ? `; Streamable HTTP listening on ${broker.streamableHttp.endpoint}` : "";
  console.error(`[potassium-broker] Potassium listening on ${broker.bridge.status().endpoint}; proxy listening on ${broker.config.proxyHost}:${broker.listener.address().port}${httpNotice}`);
  let shutdown;
  const close = () => {
    // Finish every queued publication and the exact stopped receipt while the
    // old listeners still exclude a replacement. Never unlink active state.
    shutdown ??= broker.drain().then(async () => {
      try { await tracker.close(); } finally { await broker.close(); }
    });
    return shutdown;
  };
  const stop = () => close().catch((error) => { console.error("[potassium-broker] Shutdown failed:", error); process.exitCode = 1; });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

if (isMainModule(process.argv[1], import.meta.url)) main().catch((error) => { console.error("[potassium-broker] Fatal:", error); process.exitCode = 1; });

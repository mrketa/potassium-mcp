import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { PotassiumBridge } from "./bridge.js";
import { AdminAuditRecorder } from "./admin-audit.js";
import { defaults } from "./install.js";
import { commandConfigPath, createToolServer, isMainModule, loadConfig, parseConfig } from "./server.js";
import packageMetadata from "../package.json" with { type: "json" };
import { createAsyncArtifactStore } from "./async-artifact-store.js";
import { createStatefulHttpSessionRegistry, MCP_SESSION_HEADER } from "./stateful-http.js";
import { createBuiltinFallbackClient } from "./builtin-fallback.js";
import { resolveHostPolicy } from "./host-policy.js";

const PROXY_PROTOCOL = 1;
const PROXY_DOMAIN = "potassium-mcp/proxy/v1";
const BROKER_STATE_FILE = "broker-state.json";
const BROKER_STATE_SCHEMA = 1;
const DEFAULT_RESTART_WAIT_MS = 30000;
const MAX_PROXY_CONNECTIONS = 64;

const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function writeAtomic(target, value) {
  const staged = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(staged, target);
}

function installPaths(options = {}) {
  const installRoot = path.resolve(options.installRoot ?? defaults(options.cwd).installRoot);
  const runtimeRoot = path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp");
  return {
    installRoot,
    statePath: path.join(installRoot, BROKER_STATE_FILE),
    configPath: path.join(installRoot, "config.json"),
    brokerPath: path.join(runtimeRoot, "src", "broker.js"),
  };
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

function expectedState(paths, state) {
  return state.brokerPath === paths.brokerPath
    && state.configPath === paths.configPath
    && path.isAbsolute(state.nodeExecutable ?? "")
    && typeof state.instanceId === "string"
    && /^[a-f0-9]{64}$/i.test(state.configDigest ?? "");
}

function commandLineForPid(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
    ], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

function processMatches(state, paths, commandLine = commandLineForPid) {
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error(`Unable to inspect broker process ${state.pid}: ${error.message}`);
  }
  const line = commandLine(state.pid);
  if (!line) return false;
  return line.includes(state.nodeExecutable) && line.includes(paths.brokerPath) && line.includes(paths.configPath) && line.includes("--config");
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
    configDigest: state?.configDigest ?? null,
    readiness: ready ? "ready" : (state?.readiness ?? "unknown"),
    active: state?.active ?? null,
    startedAt: state?.startedAt ?? null,
    streamableHttp: state?.streamableHttp ?? null,
  };
}

export async function brokerStatus(options = {}) {
  const paths = installPaths(options);
  const state = await readState(paths.statePath);
  if (!state) return publicState(null, "absent", false);
  if (!expectedState(paths, state) || !processMatches(state, paths, options.commandLineForPid)) {
    return publicState(state, "stale", false);
  }
  const ready = await (options.probeReadiness ?? readiness)(state.proxyHost, state.proxyPort);
  return publicState(state, "running", ready);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function restartBroker(options = {}) {
  const paths = installPaths(options);
  const waitMs = options.waitMs ?? DEFAULT_RESTART_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw new Error("waitMs must be an integer between 0 and 120000");
  const matchesProcess = options.processMatches ?? processMatches;
  let status = await brokerStatus(options);
  if (status.status === "stale") throw new Error("refusing to restart: broker state is stale or process identity could not be verified");
  const deadline = Date.now() + waitMs;
  while (status.status === "running" && status.active) {
    if (Date.now() >= deadline) throw new Error("refusing to restart while a broker request is active");
    await delay(Math.min(100, deadline - Date.now()));
    status = await brokerStatus(options);
  }
  if (status.status === "running") {
    const state = await readState(paths.statePath);
    if (!matchesProcess(state, paths, options.commandLineForPid)) {
      throw new Error("refusing to restart: broker process identity could not be verified");
    }
    (options.signalProcess ?? process.kill)(state.pid, "SIGTERM");
    while (matchesProcess(state, paths, options.commandLineForPid)) {
      if (Date.now() >= deadline) throw new Error("broker did not stop before restart deadline");
      await delay(Math.min(100, deadline - Date.now()));
    }
  }
  if (!await exists(paths.brokerPath) || !await exists(paths.configPath)) {
    throw new Error("installed broker runtime or configuration is missing");
  }
  const child = (options.spawnProcess ?? spawn)(process.execPath, [paths.brokerPath, "--config", paths.configPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, POTASSIUM_MCP_BROKER_STATE: paths.statePath },
  });
  child.unref();
  const readyDeadline = Date.now() + waitMs;
  do {
    await delay(50);
    status = await brokerStatus(options);
    if (status.status === "running" && status.readiness === "ready") return status;
  } while (Date.now() < readyDeadline);
  throw new Error("restarted broker did not become ready before restart deadline");
}

export async function stopBroker(options = {}) {
  const paths = installPaths(options);
  const waitMs = options.waitMs ?? DEFAULT_RESTART_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw new Error("waitMs must be an integer between 0 and 120000");
  const matchesProcess = options.processMatches ?? processMatches;
  let status = await brokerStatus(options);
  if (status.status === "absent") return status;
  if (status.status === "stale") throw new Error("refusing to stop: broker state is stale or process identity could not be verified");
  const deadline = Date.now() + waitMs;
  while (status.active) {
    if (Date.now() >= deadline) throw new Error("refusing to stop while a broker request is active");
    await delay(Math.min(100, deadline - Date.now()));
    status = await brokerStatus(options);
  }
  const state = await readState(paths.statePath);
  if (!matchesProcess(state, paths, options.commandLineForPid)) {
    throw new Error("refusing to stop: broker process identity could not be verified");
  }
  (options.signalProcess ?? process.kill)(state.pid, "SIGTERM");
  while (matchesProcess(state, paths, options.commandLineForPid)) {
    if (Date.now() >= deadline) throw new Error("broker did not stop before stop deadline");
    await delay(Math.min(100, deadline - Date.now()));
  }
  return publicState(state, "stopped", false);
}

async function createDetachedStateTracker(broker, configPath, statePath) {
  const rawConfig = await readFile(configPath, "utf8");
  const instanceId = randomBytes(16).toString("hex");
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
  const flush = () => {
    const active = broker.bridge.status().active;
    state.active = active ? { method: active.method, startedAt: active.startedAt } : null;
    writing = writing.then(() => writeAtomic(statePath, state)).catch((error) => {
      console.error("[potassium-broker] Unable to update detached broker state:", error);
    });
    return writing;
  };
  await flush();
  const onActivity = () => { void flush(); };
  broker.bridge.on("activity", onActivity);
  return {
    async close() {
      broker.bridge.off("activity", onActivity);
      await writing;
      const current = await readState(statePath).catch(() => null);
      if (current?.instanceId === instanceId) await rm(statePath, { force: true });
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
  constructor(socket, maxFrameBytes) {
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    socket.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data) > maxFrameBytes) return socket.close(1009, "invalid MCP frame");
      try { this.onmessage?.(JSON.parse(data.toString("utf8"))); } catch { socket.close(1007, "invalid JSON"); }
    });
    socket.once("error", (error) => this.onerror?.(error));
    socket.once("close", () => this.onclose?.());
  }
  async start() {}
  async send(message) {
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new Error("MCP frame exceeds proxy limit");
    if (this.socket.readyState !== 1) throw new Error("Proxy connection is closed");
    await new Promise((resolve, reject) => this.socket.send(frame, (error) => error ? reject(error) : resolve()));
  }
  async close() { if (this.socket.readyState < 2) this.socket.close(); }
}

export async function createBroker(inputConfig) {
  const config = inputConfig === undefined ? await loadConfig() : await parseConfig(inputConfig);
  const log = logger();
  const bridge = new PotassiumBridge(config, log);
  const audit = new AdminAuditRecorder({ path: config.adminAuditPath });
  const artifactRoot = config.artifactRoots.find((root) => root.recursive);
  const artifactStore = artifactRoot
    ? createAsyncArtifactStore({ root: artifactRoot, clock: { now: () => Date.now() }, randomBytes })
    : undefined;
  const builtinFallback = config.builtinFallbackEnabled
    ? createBuiltinFallbackClient({ tokenFile: config.builtinFallbackTokenFile })
    : undefined;
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
    await new Promise((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });
    if (config.streamableHttpEnabled || config.statefulHttpEnabled) {
      const app = createMcpExpressApp({ host: config.streamableHttpHost });
      if (config.streamableHttpEnabled) {
        app.post("/mcp", async (request, response) => {
          const server = createToolServer(config, bridge, {
            audit,
            sessionId: randomBytes(16).toString("hex"),
            hostId: "http",
            policy: config.policies.http,
            artifactStore,
            builtinFallback,
          });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          try {
            await server.connect(transport);
            await transport.handleRequest(request, response, request.body);
          } catch (error) {
            log.error("streamable HTTP MCP request failed", error);
            if (!response.headersSent) mcpFailure(response, 500, "Internal server error");
          } finally {
            await server.close().catch(() => {});
          }
        });
        app.all("/mcp", (_request, response) => mcpFailure(response, 405, "Method not allowed", { Allow: "POST" }));
      } else {
        app.all("/mcp", (_request, response) => mcpFailure(response, 404, "Stateless HTTP is disabled"));
      }
      if (config.statefulHttpEnabled) {
        statefulSessions = createStatefulHttpSessionRegistry({
          serverFactory: async () => createToolServer(config, bridge, {
            audit,
            sessionId: randomBytes(16).toString("hex"),
            hostId: "http",
            policy: config.policies.http,
            artifactStore,
            builtinFallback,
          }),
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
    await closeListener(httpListener);
    await bridge.close().catch(() => {});
    await closeListener(listener);
    throw error;
  }
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
        const transport = new WebSocketMcpTransport(socket, config.proxyMaxFrameBytes);
        const server = createToolServer(config, bridge, { audit, sessionId, hostId: hello.hostId, policy, artifactStore, builtinFallback });
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
  const httpAddress = httpListener?.address();
  const streamableHttp = httpAddress && typeof httpAddress !== "string"
    ? { host: config.streamableHttpHost, port: httpAddress.port, path: "/mcp", endpoint: endpointFor(config.streamableHttpHost, httpAddress.port) }
    : undefined;
  let closed;
  return {
    config, bridge, listener, httpListener, streamableHttp,
    close() {
      for (const socket of listener.clients) socket.terminate();
      closed ??= Promise.allSettled([
        statefulSessions?.closeAll(),
        closeListener(httpListener),
        closeListener(listener),
        bridge.close(),
      ]).then((results) => { const failure = results.find((result) => result.status === "rejected"); if (failure) throw failure.reason; });
      return closed;
    },
  };
}

export async function main() {
  const configPath = commandConfigPath()
    ?? process.env.POTASSIUM_MCP_CONFIG
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config.json");
  const broker = await createBroker();
  const statePath = process.env.POTASSIUM_MCP_BROKER_STATE
    ? path.resolve(process.env.POTASSIUM_MCP_BROKER_STATE)
    : path.join(path.dirname(configPath), BROKER_STATE_FILE);
  const tracker = await createDetachedStateTracker(broker, configPath, statePath);
  const httpNotice = broker.streamableHttp ? `; Streamable HTTP listening on ${broker.streamableHttp.endpoint}` : "";
  console.error(`[potassium-broker] Potassium listening on ${broker.bridge.status().endpoint}; proxy listening on ${broker.config.proxyHost}:${broker.listener.address().port}${httpNotice}`);
  let shutdown;
  const close = () => {
    shutdown ??= Promise.allSettled([broker.close(), tracker.close()]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    return shutdown;
  };
  const stop = () => close().catch((error) => { console.error("[potassium-broker] Shutdown failed:", error); process.exitCode = 1; });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

if (isMainModule(process.argv[1], import.meta.url)) main().catch((error) => { console.error("[potassium-broker] Fatal:", error); process.exitCode = 1; });

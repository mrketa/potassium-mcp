import { EventEmitter } from "node:events";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PROTOCOL = 2;
const NONCE_BYTES = 32;
const NONCE_HEX_LENGTH = NONCE_BYTES * 2;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 15_000;
const MAX_EXECUTOR_CONNECTIONS = 64;
const READ_METHODS = new Set([
  "capabilities", "async_job_status", "async_job_result", "async_job_console",
  "client_state", "list_children", "inspect_instance", "find_instances", "read_properties",
  "list_tags", "diagnostic_snapshot", "script_fingerprint", "script_inventory",
  "remote_inventory", "performance_snapshot", "spatial_query", "ui_inventory", "signal_inventory",
  "attribute_inventory", "observe_logs", "observe_changes", "snapshot_diff", "multi_read_properties", "instance_ancestry",
  "class_summary", "overlap_query", "subtree_summary",
]);

function tokensMatch(expected, actual) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual));
  return left.length === right.length && timingSafeEqual(left, right);
}
function isHex(value, length = NONCE_HEX_LENGTH) {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/i.test(value);
}
function isClientId(value) { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
function isProof(value) { return typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value); }
function handshakeProof(token, role, clientNonce, serverNonce) {
  const transcript = `potassium-mcp/v${PROTOCOL}|${role}|${clientNonce}|${serverNonce}`;
  const hash = createHash("sha256").update(transcript, "utf8").digest("hex");
  return createHmac("sha256", token).update(hash, "utf8").digest("base64");
}
function primitive(value) { return value === null || ["string", "number", "boolean"].includes(typeof value); }
function requestTransportError(error, submissionIndeterminate) {
  const wrapped = new Error(error instanceof Error ? error.message : String(error));
  wrapped.submissionIndeterminate = submissionIndeterminate;
  return wrapped;
}
function sanitizeClientInfo(client) {
  const info = { protocol: client.protocol };
  for (const key of ["executor", "version", "placeId"]) if (primitive(client[key])) info[key] = client[key];
  return info;
}

export class PotassiumBridge extends EventEmitter {
  constructor(config, logger = console) {
    super();
    this.config = config;
    this.logger = logger;
    this.server = null;
    // Compatibility aliases: populated only when exactly one authenticated client exists.
    this.client = null;
    this.clientInfo = null;
    this.clients = new Map();
    this.sockets = new Set();
    this.authTimers = new Map();
    this.closeReasons = new Map();
    this.nextRequestId = 1;
    this.startPromise = null;
    this.closePromise = null;
    this.recoveryGeneration = 0;
    this.metrics = { connects: 0, disconnects: 0, timeouts: 0, lateResponses: 0, rejectedOrigins: 0, protocolErrors: 0, lastCloseCode: null, lastCloseReason: null, connectedSince: null };
  }

  async start() {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    if (this.closePromise) { await this.closePromise; return this.start(); }
    if (this.config.host !== "127.0.0.1" && this.config.host !== "::1") throw new Error("Potassium bridge must bind to a loopback address");
    this.startPromise = this.#start();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }
  async #start() {
    const server = new WebSocketServer({ host: this.config.host, port: this.config.port, maxPayload: this.config.maxMessageBytes, perMessageDeflate: false });
    server.on("connection", (socket, request) => this.#accept(socket, request));
    server.on("error", (error) => this.#reportError(error));
    try {
      await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      this.server = server;
    } catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  }

  status() {
    const address = this.server?.address();
    const port = address && typeof address === "object" ? address.port : this.config.port;
    const host = this.config.host === "::1" ? "[::1]" : this.config.host;
    const clients = this.listClients();
    const sole = clients.length === 1 ? this.clients.get(clients[0].clientId) : null;
    const activeRequests = [...this.clients.values()]
      .filter((session) => session.activeMethod)
      .map((session) => ({ clientId: session.clientId, method: session.activeMethod, startedAt: session.activeStartedAt }));
    return {
      connected: clients.length > 0,
      client: sole?.info ?? null,
      pendingRequests: [...this.clients.values()].reduce((count, session) => count + session.pending.size, 0),
      activeMethod: sole?.activeMethod ?? null,
      activeStartedAt: sole?.activeStartedAt ?? null,
      active: activeRequests[0] ?? null,
      activeRequests,
      clients,
      recoveryGeneration: this.recoveryGeneration,
      recovering: [...this.clients.values()].some((session) => session.recoveryRequestId !== null),
      endpoint: `ws://${host}:${port}`,
      ...this.metrics,
    };
  }
  listClients() {
    return [...this.clients.values()].map((session) => ({
      clientId: session.clientId, generation: session.generation, connectedSince: session.connectedSince,
      client: session.info, pendingRequests: session.pending.size, activeMethod: session.activeMethod,
    }));
  }
  getClientInfo(clientId) {
    return this.#selectClient(clientId).info;
  }

  async request(method, params = {}, timeoutMs = this.config.requestTimeoutMs, clientId) {
    const session = this.#selectClient(clientId);
    if (session.recoveryRequestId !== null) throw new Error("Potassium executor is recovering from a timed-out request");
    if (session.pending.size >= this.config.maxPendingRequests) throw new Error("Potassium request limit reached");
    const id = String(this.nextRequestId++);
    let serialized;
    try { serialized = JSON.stringify({ type: "request", id, method, params }); } catch { throw new Error("Potassium request is not serializable"); }
    if (Buffer.byteLength(serialized, "utf8") > this.config.maxMessageBytes) throw new Error("Potassium request exceeds maximum message size");
    return new Promise((resolve, reject) => {
      session.pending.set(id, { id, resolve, reject, serialized, timeoutMs, method, read: READ_METHODS.has(method), timer: null, sendAttempted: false });
      session.queue.push(id);
      this.#dispatch(session);
    });
  }
  #selectClient(clientId) {
    if (clientId !== undefined && clientId !== null) {
      if (!isClientId(clientId)) throw requestTransportError("Invalid Potassium clientId", false);
      const selected = this.clients.get(clientId);
      if (!selected) throw requestTransportError("Potassium client is not connected", false);
      return selected;
    }
    if (this.clients.size === 0) throw requestTransportError("Potassium is not connected", false);
    if (this.clients.size !== 1) throw requestTransportError("Potassium client selection required", false);
    return this.clients.values().next().value;
  }

  recover(expectedRecoveryGeneration) {
    if (!Number.isSafeInteger(expectedRecoveryGeneration) || expectedRecoveryGeneration !== this.recoveryGeneration) throw new Error("Potassium recovery generation does not match the current bridge state");
    this.recoveryGeneration += 1;
    const connected = this.clients.size > 0;
    for (const session of [...this.clients.values()]) {
      this.#rejectSession(session, new Error("Potassium executor transport was reset by an administrator"));
      this.#closeSocket(session.socket, 1000, "Administrator reset executor transport");
    }
    return { recoveryGeneration: this.recoveryGeneration, transportDisconnected: connected, forcedTermination: false, note: "The executor transport was disconnected. This does not forcibly terminate arbitrary Luau already running in the client." };
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    try { await this.closePromise; } finally { this.closePromise = null; }
  }
  async #close() {
    if (this.startPromise) { try { await this.startPromise; } catch {} }
    const server = this.server; this.server = null;
    for (const session of [...this.clients.values()]) {
      clearInterval(session.heartbeatTimer);
      this.#rejectSession(session, new Error("Potassium bridge stopped"));
    }
    this.clients.clear(); this.#refreshCompatibilityAliases();
    const sockets = new Set(this.sockets);
    for (const socket of sockets) this.#closeSocket(socket, 1001, "Bridge stopped");
    if (!server) return;
    let timer;
    const closed = new Promise((resolve) => server.close(resolve));
    const forced = new Promise((resolve) => { timer = setTimeout(() => { for (const socket of sockets) socket.terminate(); resolve(); }, this.config.shutdownGraceMs); timer.unref?.(); });
    if (await Promise.race([closed.then(() => true), forced.then(() => false)])) { clearTimeout(timer); return; }
    return;
  }

  #accept(socket, request) {
    if (this.sockets.size >= MAX_EXECUTOR_CONNECTIONS) {
      this.#closeSocket(socket, 1013, "Executor connection capacity exceeded");
      return;
    }
    this.sockets.add(socket);
    socket.on("error", (error) => this.#reportError(error));
    let session = null;
    socket.on("close", (code) => {
      clearTimeout(this.authTimers.get(socket)); this.authTimers.delete(socket); this.sockets.delete(socket);
      const reason = this.closeReasons.get(socket) ?? "Peer closed connection"; this.closeReasons.delete(socket);
      this.metrics.disconnects += 1; this.metrics.lastCloseCode = code; this.metrics.lastCloseReason = reason;
      if (!session || this.clients.get(session.clientId) !== session) return;
      clearInterval(session.heartbeatTimer); this.clients.delete(session.clientId); this.#rejectSession(session, new Error("Potassium disconnected"));
      this.#refreshCompatibilityAliases(); this.emit("disconnected", session.info);
    });
    const origin = String(request.headers.origin ?? "").trim();
    const address = this.server?.address(); const port = address && typeof address === "object" ? address.port : this.config.port;
    const expectedOrigin = `ws://${this.config.host === "::1" ? "[::1]" : this.config.host}:${port}`;
    if (origin !== "" && origin !== expectedOrigin) { this.metrics.rejectedOrigins += 1; this.#closeSocket(socket, 1008, "Origin not allowed"); return; }
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1") { this.#closeSocket(socket, 1008, "Loopback clients only"); return; }
    let authenticated = false; let handshake = null;
    const authTimer = setTimeout(() => this.#closeSocket(socket, 1008, "Handshake timeout"), 5_000); this.authTimers.set(socket, authTimer);
    socket.on("message", (data, isBinary) => {
      if (isBinary) { this.metrics.protocolErrors += 1; this.#closeSocket(socket, 1003, "Text messages only"); return; }
      let message; try { message = JSON.parse(data.toString("utf8")); } catch { this.metrics.protocolErrors += 1; this.#closeSocket(socket, 1007, "Invalid JSON"); return; }
      if (!authenticated) {
        if (!handshake) {
          if (message?.type !== "hello") { this.#closeSocket(socket, 1008, "Expected client hello"); return; }
          if (Object.hasOwn(message, "token")) { this.#closeSocket(socket, 1008, "Bearer token not allowed in hello"); return; }
          if (message.protocol !== PROTOCOL || message.client?.protocol !== PROTOCOL) { this.metrics.protocolErrors += 1; this.#closeSocket(socket, 1002, "Protocol mismatch"); return; }
          if (!isHex(message.clientNonce) || !isClientId(message.clientId) || !Number.isSafeInteger(message.generation)) { this.#closeSocket(socket, 1008, "Invalid client identity"); return; }
          const serverNonce = randomBytes(NONCE_BYTES).toString("hex");
          handshake = { client: message.client, clientId: message.clientId, generation: message.generation, clientNonce: message.clientNonce, serverNonce };
          socket.send(JSON.stringify({ type: "challenge", protocol: PROTOCOL, clientNonce: handshake.clientNonce, serverNonce, proof: handshakeProof(this.config.token, "server", handshake.clientNonce, serverNonce) }), (error) => { if (error) this.#closeSocket(socket, 1011, "Failed to send challenge"); });
          return;
        }
        if (message?.type !== "ack" || message.protocol !== PROTOCOL || message.clientNonce !== handshake.clientNonce || message.serverNonce !== handshake.serverNonce || !isProof(message.proof) || !tokensMatch(handshakeProof(this.config.token, "client", handshake.clientNonce, handshake.serverNonce), message.proof)) { this.#closeSocket(socket, 1008, "Client proof verification failed"); return; }
        const prior = this.clients.get(handshake.clientId);
        if (prior && prior.socket !== socket) {
          if (prior.pending.size > 0 || prior.activeReads > 0 || prior.mutationActive || prior.recoveryRequestId !== null) {
            this.#closeSocket(socket, 1008, "Previous Potassium session is busy");
            return;
          }
          clearInterval(prior.heartbeatTimer);
          this.#rejectSession(prior, new Error("Potassium disconnected"));
          this.#closeSocket(prior.socket, 1000, "Reconnected by the same Potassium client");
        }
        clearTimeout(authTimer); this.authTimers.delete(socket);
        session = { clientId: handshake.clientId, generation: handshake.generation, socket, info: sanitizeClientInfo(handshake.client), connectedSince: new Date().toISOString(), pending: new Map(), queue: [], activeReads: 0, mutationActive: false, activeMethod: null, activeStartedAt: null, recoveryRequestId: null, lastPongAt: Date.now(), heartbeatTimer: null };
        this.clients.set(session.clientId, session);
        session.heartbeatTimer = setInterval(() => this.#heartbeat(session), HEARTBEAT_INTERVAL_MS); session.heartbeatTimer.unref?.();
        socket.send(JSON.stringify({ type: "ready", protocol: PROTOCOL, clientNonce: handshake.clientNonce, serverNonce: handshake.serverNonce, clientId: session.clientId, generation: session.generation }), (error) => { if (error) this.#closeSocket(socket, 1011, "Failed to confirm authentication"); });
        authenticated = true; this.metrics.connects += 1; this.metrics.connectedSince ??= session.connectedSince; this.#refreshCompatibilityAliases(); this.emit("connected", session.info); return;
      }
      this.#handleAuthenticatedMessage(session, message);
    });
  }
  #heartbeat(session) {
    if (this.clients.get(session.clientId) !== session || session.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - session.lastPongAt > HEARTBEAT_STALE_MS) { this.#closeSocket(session.socket, 1001, "Heartbeat stale"); return; }
    const nonce = randomBytes(16).toString("hex"); session.lastPing = nonce;
    try { session.socket.send(JSON.stringify({ type: "ping", nonce })); } catch { this.#closeSocket(session.socket, 1011, "Heartbeat failed"); }
  }
  #handleAuthenticatedMessage(session, message) {
    if (message?.type === "pong" && message.nonce === session.lastPing) { session.lastPongAt = Date.now(); return; }
    if (message?.type !== "response" || typeof message.id !== "string") { this.metrics.protocolErrors += 1; return; }
    if (session.recoveryRequestId === message.id) {
      session.recoveryRequestId = null;
      this.metrics.lateResponses += 1;
      this.#dispatch(session);
      return;
    }
    const pending = session.pending.get(message.id);
    if (!pending) { this.metrics.lateResponses += 1; return; }
    this.#settle(session, pending, message.ok ? message.result : new Error(message.error?.message ?? "Potassium request failed"), !message.ok);
  }
  #dispatch(session) {
    if (this.clients.get(session.clientId) !== session || session.recoveryRequestId !== null) return;
    while (session.queue.length > 0) {
      const first = session.pending.get(session.queue[0]);
      if (!first) {
        session.queue.shift();
        continue;
      }
      // A mutation at the head is never bypassed; it runs only after every active read completes.
      if (!first.read) {
        if (session.mutationActive || session.activeReads > 0) return;
        session.queue.shift();
        this.#send(session, first);
        continue;
      }
      if (session.mutationActive || session.activeReads >= 4) return;
      session.queue.shift();
      this.#send(session, first);
    }
  }
  #send(session, pending) {
    if (pending.read) session.activeReads += 1; else session.mutationActive = true;
    session.activeMethod = pending.method; session.activeStartedAt = new Date().toISOString();
    this.#emitActivity();
    pending.timer = setTimeout(() => {
      if (!session.pending.has(pending.id)) return;
      this.metrics.timeouts += 1; session.recoveryRequestId = pending.id;
      this.#rejectSession(session, requestTransportError(`Potassium request timed out after ${pending.timeoutMs} ms`, pending.sendAttempted), true);
    }, pending.timeoutMs);
    pending.sendAttempted = true;
    try { session.socket.send(pending.serialized, (error) => { if (error && session.pending.has(pending.id)) this.#settle(session, pending, requestTransportError(error, true), true); }); }
    catch (error) { this.#settle(session, pending, requestTransportError(error, true), true); }
  }
  #settle(session, pending, value, reject) {
    if (!session.pending.has(pending.id)) return;
    clearTimeout(pending.timer); session.pending.delete(pending.id);
    if (pending.read) session.activeReads = Math.max(0, session.activeReads - 1); else session.mutationActive = false;
    if (session.pending.size === 0) { session.activeMethod = null; session.activeStartedAt = null; }
    this.#emitActivity();
    if (reject) pending.reject(value); else pending.resolve(value);
    this.#dispatch(session);
  }
  #rejectSession(session, error, retainRecovery = false) {
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(requestTransportError(error, pending.sendAttempted)); }
    session.pending.clear(); session.queue = []; session.activeReads = 0; session.mutationActive = false; session.activeMethod = null; session.activeStartedAt = null;
    if (!retainRecovery) session.recoveryRequestId = null;
    this.#emitActivity();
  }
  #emitActivity() {
    const active = this.status().active;
    this.emit("activity", active ? { method: active.method, startedAt: active.startedAt, clientId: active.clientId } : null);
  }
  #refreshCompatibilityAliases() {
    const session = this.clients.size === 1 ? this.clients.values().next().value : null;
    this.client = session?.socket ?? null;
    this.clientInfo = session?.info ?? null;
    this.metrics.connectedSince = session?.connectedSince ?? null;
  }
  #closeSocket(socket, code, reason) { this.closeReasons.set(socket, reason); if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, reason); }
  #reportError(error) { if (this.listenerCount("error") > 0) this.emit("error", error); else this.logger.error?.("Potassium bridge socket error"); }
}

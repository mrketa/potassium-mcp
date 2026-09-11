import { EventEmitter } from "node:events";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PROTOCOL = 2;
const NONCE_BYTES = 32;
const NONCE_HEX_LENGTH = NONCE_BYTES * 2;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 15_000;
const MAX_EXECUTOR_CONNECTIONS = 64;
const MAX_PENDING_CONTROLS = 4;
// Control requests bypass raw-execution barriers; authorization belongs to host policy.
const CONTROL_METHODS = new Set([
  "capabilities", "watch_start", "watch_poll", "watch_stop", "async_job_list", "async_job_cancel", "instance_references_release",
  "remote_capture_poll", "remote_capture_stop",
]);
const READ_METHODS = new Set([
  ...CONTROL_METHODS,
  "async_job_status", "async_job_result", "async_job_console",
  "client_state", "list_children", "inspect_instance", "find_instances", "read_properties",
  "list_tags", "diagnostic_snapshot", "script_fingerprint", "script_inventory",
  "remote_inventory", "performance_snapshot", "spatial_query", "ui_inventory", "signal_inventory",
  "attribute_inventory", "observe_logs", "observe_changes", "snapshot_diff", "multi_read_properties", "instance_ancestry",
  "class_summary", "overlap_query", "subtree_summary", "batch_read",
  "game_context", "map_observe", "map_probe",
  "map_recording",
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
function requestTransportError(error, submissionIndeterminate, code = error?.code) {
  const wrapped = new Error(error instanceof Error ? error.message : String(error));
  wrapped.submissionIndeterminate = submissionIndeterminate;
  if (code) wrapped.code = code;
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
    this.clients = new Map();
    this.sockets = new Set();
    this.rejectedSockets = new Set();
    this.authTimers = new Map();
    this.closeReasons = new Map();
    this.nextRequestId = 1;
    this.startPromise = null;
    this.closePromise = null;
    this.recoveryGeneration = 0;
    this.draining = false;
    this.metrics = { connects: 0, disconnects: 0, handshakeFailures: 0, timeouts: 0, lateResponses: 0, rejectedOrigins: 0, protocolErrors: 0, lastCloseCode: null, lastCloseReason: null, lastHandshakeFailureCode: null, lastHandshakeFailureReason: null, connectedSince: null };
  }

  async start() {
    if (this.closePromise) { await this.closePromise; return this.start(); }
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
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
      this.draining = false;
    } catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  }

  status() {
    const address = this.server?.address();
    const port = address && typeof address === "object" ? address.port : this.config.port;
    const host = this.config.host === "::1" ? "[::1]" : this.config.host;
    const clients = this.listClients();
    const sole = clients.length === 1 ? this.clients.get(clients[0].clientId) : null;
    const activeRequests = [...this.clients.values()].flatMap((session) => this.#activeRequests(session));
    const soleActive = sole ? activeRequests.find((request) => request.clientId === sole.clientId) : null;
    return {
      connected: clients.length > 0,
      client: sole?.info ?? null,
      openSockets: this.sockets.size + this.rejectedSockets.size,
      pendingHandshakes: this.authTimers.size,
      pendingRequests: [...this.clients.values()].reduce((count, session) => count + session.pending.size, 0),
      activeMethod: soleActive?.method ?? null,
      activeStartedAt: soleActive?.startedAt ?? null,
      active: activeRequests[0] ?? null,
      activeRequests,
      clients,
      recoveryGeneration: this.recoveryGeneration,
      recovering: [...this.clients.values()].some((session) => session.recoveryRequestIds.size > 0),
      draining: this.draining,
      queuedRequests: [...this.clients.values()].reduce((count, session) => count + session.queue.length, 0),
      endpoint: `ws://${host}:${port}`,
      ...this.metrics,
    };
  }
  listClients() {
    return [...this.clients.values()].map((session) => ({
      clientId: session.clientId, generation: session.generation, connectedSince: session.connectedSince,
      client: session.info, pendingRequests: session.pending.size, activeMethod: this.#activeRequests(session)[0]?.method ?? null,
    }));
  }
  getClientInfo(clientId) {
    return this.#selectClient(clientId).info;
  }
  #activeRequests(session) {
    const active = [...session.recoveryRequestIds.values()];
    for (const pending of session.pending.values()) {
      if (pending.sendAttempted) active.push({ clientId: session.clientId, method: pending.method, startedAt: pending.startedAt });
    }
    return active;
  }

  async drain(signal) {
    if (signal?.aborted) throw new Error("Broker drain cancelled");
    this.draining = true;
    this.#emitActivity();
    const idle = () => {
      const status = this.status();
      return status.pendingRequests === 0 && !status.recovering;
    };
    if (idle()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.off("activity", onActivity);
        signal?.removeEventListener("abort", onAbort);
      };
      const onActivity = () => {
        if (!idle()) return;
        cleanup();
        resolve();
      };
      const onAbort = () => { cleanup(); reject(new Error("Broker drain cancelled")); };
      this.on("activity", onActivity);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort(); else onActivity();
    });
  }

  resumeAdmission() {
    this.draining = false;
    this.#emitActivity();
  }

  async request(method, params = {}, timeoutMs = this.config.requestTimeoutMs, clientId, signal) {
    if (signal?.aborted) throw requestTransportError("Potassium request cancelled before dispatch", false, "CANCELLED");
    if (this.draining) throw requestTransportError("Potassium bridge is draining", false, "DRAINING");
    const session = this.#selectClient(clientId);
    if (session.recoveryRequestIds.size > 0) throw requestTransportError("Potassium executor is recovering from an indeterminate request", false);
    const control = CONTROL_METHODS.has(method)
      || (method === "observe_action" && ["poll", "stop"].includes(params?.operation))
      || (method === "map_recording" && ["poll", "mark", "stop", "release"].includes(params?.operation));
    const pendingLimit = this.config.maxPendingRequests + (control ? MAX_PENDING_CONTROLS : 0);
    if (session.pending.size >= pendingLimit || (control && session.pendingControls >= MAX_PENDING_CONTROLS)) {
      throw requestTransportError("Potassium request limit reached", false);
    }
    const id = String(this.nextRequestId++);
    let serialized;
    try { serialized = JSON.stringify({ type: "request", id, method, params }); } catch { throw requestTransportError("Potassium request is not serializable", false); }
    if (Buffer.byteLength(serialized, "utf8") > this.config.maxMessageBytes) throw requestTransportError("Potassium request exceeds maximum message size", false);
    return new Promise((resolve, reject) => {
      const pending = { id, resolve, reject, serialized, timeoutMs, deadlineAt: Date.now() + timeoutMs, method, read: control || READ_METHODS.has(method), control, timer: null, sendAttempted: false, signal, onAbort: null };
      session.pending.set(id, pending);
      if (control) session.pendingControls += 1;
      session.queue.push(id);
      const cancel = (message, code) => {
        if (!session.pending.has(id)) return;
        const error = requestTransportError(message, pending.sendAttempted, code);
        if (pending.sendAttempted) this.#enterRecovery(session, error);
        else this.#settle(session, pending, error, true);
      };
      pending.onAbort = () => cancel("Potassium request cancelled", "CANCELLED");
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      pending.timer = setTimeout(() => {
        if (!session.pending.has(id)) return;
        this.metrics.timeouts += 1;
        cancel(`Potassium request timed out after ${timeoutMs} ms`, pending.sendAttempted ? "TIMEOUT" : "QUEUE_TIMEOUT");
      }, timeoutMs);
      if (signal?.aborted) { pending.onAbort(); return; }
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
    this.clients.clear(); this.#refreshConnectedSince();
    const sockets = [...this.sockets, ...this.rejectedSockets];
    const socketsClosed = Promise.all(sockets.map((socket) => new Promise((resolve) => socket.once("close", resolve))));
    for (const socket of sockets) this.#closeSocket(socket, 1001, "Bridge stopped");
    if (!server) return socketsClosed;
    let timer;
    const closed = Promise.all([socketsClosed, new Promise((resolve) => server.close(resolve))]);
    const forced = new Promise((resolve) => { timer = setTimeout(() => { for (const socket of sockets) socket.terminate(); resolve(); }, this.config.shutdownGraceMs); timer.unref?.(); });
    if (await Promise.race([closed.then(() => true), forced.then(() => false)])) { clearTimeout(timer); return; }
    await closed;
  }

  #accept(socket, request) {
    const capacityExceeded = this.sockets.size >= MAX_EXECUTOR_CONNECTIONS;
    const sockets = capacityExceeded ? this.rejectedSockets : this.sockets;
    sockets.add(socket);
    socket.on("error", (error) => this.#reportError(error));
    let session = null; let authenticated = false;
    socket.once("close", (code) => {
      clearTimeout(this.authTimers.get(socket)); this.authTimers.delete(socket); sockets.delete(socket);
      const reason = this.closeReasons.get(socket) ?? "Peer closed connection"; this.closeReasons.delete(socket);
      if (authenticated) {
        this.metrics.disconnects += 1; this.metrics.lastCloseCode = code; this.metrics.lastCloseReason = reason;
      } else {
        this.metrics.handshakeFailures += 1; this.metrics.lastHandshakeFailureCode = code; this.metrics.lastHandshakeFailureReason = reason;
      }
      if (!session || this.clients.get(session.clientId) !== session) return;
      clearInterval(session.heartbeatTimer); this.clients.delete(session.clientId); this.#rejectSession(session, new Error("Potassium disconnected"));
      this.#refreshConnectedSince(); this.emit("disconnected", session.info);
    });
    if (capacityExceeded) { this.#closeSocket(socket, 1013, "Executor connection capacity exceeded"); return; }
    const origin = String(request.headers.origin ?? "").trim();
    const address = this.server?.address(); const port = address && typeof address === "object" ? address.port : this.config.port;
    const expectedOrigin = `ws://${this.config.host === "::1" ? "[::1]" : this.config.host}:${port}`;
    if (origin !== "" && origin !== expectedOrigin) { this.metrics.rejectedOrigins += 1; this.#closeSocket(socket, 1008, "Origin not allowed"); return; }
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1") { this.#closeSocket(socket, 1008, "Loopback clients only"); return; }
    let handshake = null;
    const authTimer = setTimeout(() => this.#closeSocket(socket, 1008, "Handshake timeout"), 5_000); this.authTimers.set(socket, authTimer);
    socket.on("message", (data, isBinary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
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
          if (prior.pending.size > 0 || prior.activeReads > 0 || prior.mutationActive || prior.recoveryRequestIds.size > 0) {
            this.#closeSocket(socket, 1008, "Previous Potassium session is busy");
            return;
          }
          clearInterval(prior.heartbeatTimer);
          this.#rejectSession(prior, new Error("Potassium disconnected"));
          this.#closeSocket(prior.socket, 1000, "Reconnected by the same Potassium client");
        }
        clearTimeout(authTimer); this.authTimers.delete(socket);
        session = { clientId: handshake.clientId, generation: handshake.generation, socket, info: sanitizeClientInfo(handshake.client), connectedSince: new Date().toISOString(), pending: new Map(), pendingControls: 0, queue: [], activeReads: 0, activeControls: 0, mutationActive: false, recoveryRequestIds: new Map(), lastPongAt: Date.now(), heartbeatTimer: null };
        this.clients.set(session.clientId, session);
        session.heartbeatTimer = setInterval(() => this.#heartbeat(session), HEARTBEAT_INTERVAL_MS); session.heartbeatTimer.unref?.();
        socket.send(JSON.stringify({ type: "ready", protocol: PROTOCOL, clientNonce: handshake.clientNonce, serverNonce: handshake.serverNonce, clientId: session.clientId, generation: session.generation }), (error) => { if (error) this.#closeSocket(socket, 1011, "Failed to confirm authentication"); });
        authenticated = true; this.metrics.connects += 1; this.metrics.connectedSince ??= session.connectedSince; this.#refreshConnectedSince(); this.emit("connected", session.info); return;
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
    if (session.recoveryRequestIds.delete(message.id)) {
      this.metrics.lateResponses += 1;
      this.#emitActivity();
      this.#dispatch(session);
      return;
    }
    const pending = session.pending.get(message.id);
    if (!pending || !pending.sendAttempted) { this.metrics.lateResponses += 1; return; }
    const error = message.ok ? undefined : new Error(message.error?.message ?? "Potassium request failed");
    if (error && typeof message.error?.code === "string"
      && /^MAP_(?:CONTEXT_(?:UNAVAILABLE|INVALID_INPUT|INVALID_DATA|STORAGE|BUSY|CANCELLED|NOT_FOUND|CLIENT_CHANGED|SOURCE_UNAVAILABLE|IMAGE_UNAVAILABLE|LIMIT)|RECORDING_(?:LIMIT|UNAVAILABLE|TERMINAL))$/.test(message.error.code)) {
      error.code = message.error.code;
    }
    this.#settle(session, pending, message.ok ? message.result : error, !message.ok);
  }
  #dispatch(session) {
    if (this.clients.get(session.clientId) !== session || session.recoveryRequestIds.size > 0) return;
    while (session.queue.length > 0) {
      const first = session.pending.get(session.queue[0]);
      if (!first) {
        session.queue.shift();
        continue;
      }
      // Preserve ordinary read/mutation FIFO barriers without letting controls starve mutations.
      if (!first.read && !session.mutationActive && session.activeReads === session.activeControls) {
        session.queue.shift();
        this.#send(session, first);
        continue;
      }
      if (first.read && !session.mutationActive && session.activeReads < 5
        && (first.control ? session.activeControls < MAX_PENDING_CONTROLS : session.activeReads - session.activeControls < 4)) {
        session.queue.shift();
        this.#send(session, first);
        continue;
      }
      // Native reserves a fifth execution slot for controls even when all four
      // ordinary read slots are occupied. Mutations still count toward that cap.
      if (session.activeReads + Number(session.mutationActive) >= 5 || session.activeControls >= MAX_PENDING_CONTROLS) return;
      const controlIndex = session.queue.findIndex((id) => session.pending.get(id)?.control);
      if (controlIndex < 0) return;
      const control = session.pending.get(session.queue[controlIndex]);
      session.queue.splice(controlIndex, 1);
      this.#send(session, control);
    }
  }
  #send(session, pending) {
    if (pending.signal?.aborted || Date.now() >= pending.deadlineAt) {
      const message = pending.signal?.aborted ? "Potassium request cancelled before dispatch" : `Potassium request timed out after ${pending.timeoutMs} ms`;
      if (!pending.signal?.aborted) this.metrics.timeouts += 1;
      this.#settle(session, pending, requestTransportError(message, false, pending.signal?.aborted ? "CANCELLED" : "QUEUE_TIMEOUT"), true);
      return;
    }
    if (pending.read) session.activeReads += 1; else session.mutationActive = true;
    if (pending.control) session.activeControls += 1;
    pending.startedAt = new Date().toISOString();
    pending.sendAttempted = true;
    this.#emitActivity();
    if (!session.pending.has(pending.id)) return;
    try { session.socket.send(pending.serialized, (error) => { if (error && session.pending.has(pending.id)) this.#enterRecovery(session, error); }); }
    catch (error) { if (session.pending.has(pending.id)) this.#enterRecovery(session, error); }
  }
  #enterRecovery(session, error) {
    for (const pending of session.pending.values()) {
      if (pending.sendAttempted) session.recoveryRequestIds.set(pending.id, {
        clientId: session.clientId, method: pending.method, startedAt: pending.startedAt,
      });
    }
    this.#rejectSession(session, error, true);
  }
  #settle(session, pending, value, reject) {
    if (!session.pending.has(pending.id)) return;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    session.pending.delete(pending.id);
    if (pending.sendAttempted) {
      if (pending.read) session.activeReads = Math.max(0, session.activeReads - 1); else session.mutationActive = false;
      if (pending.control) session.activeControls = Math.max(0, session.activeControls - 1);
    } else {
      const queueIndex = session.queue.indexOf(pending.id);
      if (queueIndex >= 0) session.queue.splice(queueIndex, 1);
    }
    if (pending.control) session.pendingControls = Math.max(0, session.pendingControls - 1);
    this.#emitActivity();
    if (reject) pending.reject(value); else pending.resolve(value);
    this.#dispatch(session);
  }
  #rejectSession(session, error, retainRecovery = false) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(requestTransportError(error, pending.sendAttempted));
    }
    session.pending.clear(); session.pendingControls = 0; session.queue = []; session.activeReads = 0; session.activeControls = 0; session.mutationActive = false;
    if (!retainRecovery) session.recoveryRequestIds.clear();
    this.#emitActivity();
  }
  #emitActivity() {
    const active = this.status().active;
    this.emit("activity", active ? { method: active.method, startedAt: active.startedAt, clientId: active.clientId } : null);
  }
  #refreshConnectedSince() {
    const session = this.clients.size === 1 ? this.clients.values().next().value : null;
    this.metrics.connectedSince = session?.connectedSince ?? null;
  }
  #closeSocket(socket, code, reason) {
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
    clearTimeout(this.authTimers.get(socket)); this.authTimers.delete(socket);
    this.closeReasons.set(socket, reason);
    socket.close(code, reason);
  }
  #reportError(error) { if (this.listenerCount("error") > 0) this.emit("error", error); else this.logger.error?.("Potassium bridge socket error"); }
}

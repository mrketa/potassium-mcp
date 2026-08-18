import { EventEmitter } from "node:events";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PROTOCOL = 2;
const NONCE_BYTES = 32;
const NONCE_HEX_LENGTH = NONCE_BYTES * 2;

function tokensMatch(expected, actual) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual));
  return left.length === right.length && timingSafeEqual(left, right);
}

function isHex(value, length = NONCE_HEX_LENGTH) {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/i.test(value);
}
function isProof(value) {
  return typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value);
}

function handshakeProof(token, role, clientNonce, serverNonce) {
  const transcript = `potassium-mcp/v${PROTOCOL}|${role}|${clientNonce}|${serverNonce}`;
  const transcriptHash = createHash("sha256").update(transcript, "utf8").digest("hex");
  return createHmac("sha256", token).update(transcriptHash, "utf8").digest("base64");
}

function primitive(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function sanitizeClientInfo(client) {
  const info = { protocol: client.protocol };
  for (const key of ["executor", "version", "placeId"]) {
    if (primitive(client[key])) info[key] = client[key];
  }
  return info;
}


export class PotassiumBridge extends EventEmitter {
  constructor(config, logger = console) {
    super();
    this.config = config;
    this.logger = logger;
    this.server = null;
    this.client = null;
    this.clientInfo = null;
    this.pending = new Map();
    this.requestQueue = [];
    this.activeRequestId = null;
    this.recoveryRequestId = null;
    this.activeMethod = null;
    this.activeStartedAt = null;
    this.recoveryGeneration = 0;
    this.sockets = new Set();
    this.authTimers = new Map();
    this.closeReasons = new Map();
    this.nextRequestId = 1;
    this.startPromise = null;
    this.closePromise = null;
    this.metrics = {
      connects: 0,
      disconnects: 0,
      timeouts: 0,
      lateResponses: 0,
      rejectedOrigins: 0,
      protocolErrors: 0,
      lastCloseCode: null,
      lastCloseReason: null,
      connectedSince: null,
    };
  }

  async start() {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    if (this.closePromise) {
      await this.closePromise;
      return this.start();
    }
    if (this.config.host !== "127.0.0.1" && this.config.host !== "::1") {
      throw new Error("Potassium bridge must bind to a loopback address");
    }

    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    const server = new WebSocketServer({
      host: this.config.host,
      port: this.config.port,
      maxPayload: this.config.maxMessageBytes,
      perMessageDeflate: false,
    });
    server.on("connection", (socket, request) => this.#accept(socket, request));
    server.on("error", (error) => this.#reportError(error));

    try {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          server.off("error", onStartError);
          resolve();
        };
        const onStartError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onStartError);
      });
      this.server = server;
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      throw error;
    }
  }

  status() {
    const address = this.server?.address();
    const port = address && typeof address === "object" ? address.port : this.config.port;
    const host = this.config.host === "::1" ? "[::1]" : this.config.host;
    const active = this.activeRequestId === null ? null : {
      method: this.activeMethod,
      startedAt: this.activeStartedAt,
    };
    return {
      connected: this.client?.readyState === WebSocket.OPEN,
      client: this.clientInfo,
      pendingRequests: this.pending.size,
      activeMethod: this.activeMethod,
      activeStartedAt: this.activeStartedAt,
      active,
      recoveryGeneration: this.recoveryGeneration,
      recovering: this.recoveryRequestId !== null,
      endpoint: `ws://${host}:${port}`,
      ...this.metrics,
    };
  }

  async request(method, params = {}, timeoutMs = this.config.requestTimeoutMs) {
    if (!this.client || this.client.readyState !== WebSocket.OPEN || !this.clientInfo) {
      throw new Error("Potassium is not connected");
    }
    if (this.recoveryRequestId !== null) {
      throw new Error("Potassium executor is recovering from a timed-out request");
    }
    if (this.pending.size >= this.config.maxPendingRequests) {
      throw new Error("Potassium request limit reached");
    }

    const id = String(this.nextRequestId++);
    let serialized;
    try {
      serialized = JSON.stringify({ type: "request", id, method, params });
    } catch {
      throw new Error("Potassium request is not serializable");
    }
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > this.config.maxMessageBytes) {
      throw new Error("Potassium request exceeds maximum message size");
    }
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, serialized, timeoutMs, method, timer: null });
      this.requestQueue.push(id);
      this.#sendNextRequest();
    });
  }

  recover(expectedRecoveryGeneration) {
    if (!Number.isSafeInteger(expectedRecoveryGeneration) || expectedRecoveryGeneration !== this.recoveryGeneration) {
      throw new Error("Potassium recovery generation does not match the current bridge state");
    }
    this.recoveryGeneration += 1;
    this.#rejectPending(new Error("Potassium executor transport was reset by an administrator"));
    const client = this.client;
    if (client) this.#closeSocket(client, 1000, "Administrator reset executor transport");
    return {
      recoveryGeneration: this.recoveryGeneration,
      transportDisconnected: client !== null,
      forcedTermination: false,
      note: "The executor transport was disconnected. This does not forcibly terminate arbitrary Luau already running in the client.",
    };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  async #close() {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // A failed bind has already closed its temporary server.
      }
    }

    this.#rejectPending(new Error("Potassium bridge stopped"));
    const server = this.server;
    this.server = null;
    this.client = null;
    this.clientInfo = null;
    this.metrics.connectedSince = null;

    const sockets = new Set(this.sockets);
    for (const socket of sockets) {
      this.#closeSocket(socket, 1001, "Bridge stopped");
    }
    if (!server) return;

    let graceTimer;
    const closed = new Promise((resolve) => server.close(resolve));
    const forced = new Promise((resolve) => {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        for (const socket of sockets) socket.terminate();
        resolve();
      }, this.config.shutdownGraceMs);
      graceTimer.unref?.();
    });
    const graceful = await Promise.race([
      closed.then(() => true),
      forced.then(() => false),
    ]);
    if (graceful) {
      clearTimeout(graceTimer);
      return;
    }
    await closed;
  }

  #accept(socket, request) {
    this.sockets.add(socket);
    socket.on("error", (error) => this.#reportError(error));
    socket.on("close", (code) => {
      const timer = this.authTimers.get(socket);
      clearTimeout(timer);
      this.authTimers.delete(socket);
      this.sockets.delete(socket);
      const reason = this.closeReasons.get(socket) ?? "Peer closed connection";
      this.closeReasons.delete(socket);
      this.metrics.disconnects += 1;
      this.metrics.lastCloseCode = code;
      this.metrics.lastCloseReason = reason;
      if (this.client !== socket) return;
      this.client = null;
      this.clientInfo = null;
      this.metrics.connectedSince = null;
      this.#rejectPending(new Error("Potassium disconnected"));
      this.emit("disconnected");
    });

    const origin = String(request.headers.origin ?? "").trim();
    const address = this.server?.address();
    const port = address && typeof address === "object" ? address.port : this.config.port;
    const host = this.config.host === "::1" ? "[::1]" : this.config.host;
    const expectedOrigin = `ws://${host}:${port}`;
    if (origin !== "" && origin !== expectedOrigin) {
      this.metrics.rejectedOrigins += 1;
      this.#closeSocket(socket, 1008, "Origin not allowed");
      return;
    }
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1") {
      this.#closeSocket(socket, 1008, "Loopback clients only");
      return;
    }

    let authenticated = false;
    let handshake = null;
    const authTimer = setTimeout(() => this.#closeSocket(socket, 1008, "Handshake timeout"), 5000);
    this.authTimers.set(socket, authTimer);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.metrics.protocolErrors += 1;
        this.#closeSocket(socket, 1003, "Text messages only");
        return;
      }

      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        this.metrics.protocolErrors += 1;
        this.#closeSocket(socket, 1007, "Invalid JSON");
        return;
      }

      if (!authenticated) {
        if (!handshake) {
          if (message?.type !== "hello") {
            this.#closeSocket(socket, 1008, "Expected client hello");
            return;
          }
          if (Object.hasOwn(message, "token")) {
            this.#closeSocket(socket, 1008, "Bearer token not allowed in hello");
            return;
          }
          if (message.protocol !== PROTOCOL || message.client?.protocol !== PROTOCOL) {
            this.metrics.protocolErrors += 1;
            this.#closeSocket(socket, 1002, "Protocol mismatch");
            return;
          }
          if (!isHex(message.clientNonce)) {
            this.#closeSocket(socket, 1008, "Invalid client nonce");
            return;
          }

          const serverNonce = randomBytes(NONCE_BYTES).toString("hex");
          handshake = { client: message.client, clientNonce: message.clientNonce, serverNonce };
          socket.send(JSON.stringify({
            type: "challenge",
            protocol: PROTOCOL,
            clientNonce: handshake.clientNonce,
            serverNonce,
            proof: handshakeProof(this.config.token, "server", handshake.clientNonce, serverNonce),
          }), (error) => {
            if (error) this.#closeSocket(socket, 1011, "Failed to send challenge");
          });
          return;
        }

        if (message?.type !== "ack" || message.protocol !== PROTOCOL) {
          this.#closeSocket(socket, 1008, "Expected client acknowledgement");
          return;
        }
        if (
          message.clientNonce !== handshake.clientNonce
          || message.serverNonce !== handshake.serverNonce
          || !isProof(message.proof)
          || !tokensMatch(handshakeProof(this.config.token, "client", handshake.clientNonce, handshake.serverNonce), message.proof)
        ) {
          this.#closeSocket(socket, 1008, "Client proof verification failed");
          return;
        }

        if (this.client && this.client !== socket && this.activeRequestId !== null) {
          this.#closeSocket(socket, 1008, "Potassium executor is busy");
          return;
        }
        clearTimeout(authTimer);
        this.authTimers.delete(socket);
        if (this.client && this.client !== socket) {
          this.#closeSocket(this.client, 1000, "Replaced by a new Potassium session");
        }
        this.#rejectPending(new Error("Potassium session replaced"));
        this.client = socket;
        this.clientInfo = sanitizeClientInfo(handshake.client);
        try {
          socket.send(JSON.stringify({
            type: "ready",
            protocol: PROTOCOL,
            clientNonce: handshake.clientNonce,
            serverNonce: handshake.serverNonce,
          }));
        } catch {
          this.client = null;
          this.clientInfo = null;
          this.#closeSocket(socket, 1011, "Failed to confirm authentication");
          return;
        }
        authenticated = true;
        this.metrics.connects += 1;
        this.metrics.connectedSince = new Date().toISOString();
        this.emit("connected", this.clientInfo);
        return;
      }

      this.#handleAuthenticatedMessage(socket, message);
    });
  }

  #handleAuthenticatedMessage(socket, message) {
    if (socket !== this.client || message?.type !== "response" || typeof message.id !== "string") {
      this.metrics.protocolErrors += 1;
      return;
    }
    if (this.recoveryRequestId === message.id && this.activeRequestId === message.id) {
      this.recoveryRequestId = null;
      this.activeRequestId = null;
      this.activeMethod = null;
      this.activeStartedAt = null;
      this.metrics.lateResponses += 1;
      this.emit("activity", null);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || this.activeRequestId !== message.id) {
      this.metrics.lateResponses += 1;
      return;
    }
    if (message.ok) this.#settleRequest(message.id, pending.resolve, message.result);
    else this.#settleRequest(message.id, pending.reject, new Error(message.error?.message ?? "Potassium request failed"));
  }

  #sendNextRequest() {
    if (this.activeRequestId !== null) return;

    const id = this.requestQueue.shift();
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) {
      this.#sendNextRequest();
      return;
    }
    if (!this.client || this.client.readyState !== WebSocket.OPEN || !this.clientInfo) {
      this.#rejectPending(new Error("Potassium disconnected"));
      return;
    }

    this.activeRequestId = id;
    this.activeMethod = pending.method;
    this.activeStartedAt = new Date().toISOString();
    this.emit("activity", { method: this.activeMethod, startedAt: this.activeStartedAt });
    pending.timer = setTimeout(() => {
      if (!this.pending.has(id) || this.activeRequestId !== id) return;
      this.metrics.timeouts += 1;
      this.recoveryRequestId = id;
      this.#rejectPending(new Error(`Potassium request timed out after ${pending.timeoutMs} ms`), true);
    }, pending.timeoutMs);

    try {
      this.client.send(pending.serialized, (error) => {
        const active = this.pending.get(id);
        if (!error || !active || this.activeRequestId !== id) return;
        this.#settleRequest(id, active.reject, error);
      });
    } catch (error) {
      this.#settleRequest(id, pending.reject, error);
    }
  }

  #settleRequest(id, settle, value) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (this.activeRequestId === id) {
      this.activeRequestId = null;
      this.activeMethod = null;
      this.activeStartedAt = null;
      this.emit("activity", null);
    }
    settle(value);
    this.#sendNextRequest();
  }

  #closeSocket(socket, code, reason) {
    this.closeReasons.set(socket, reason);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  #reportError(error) {
    if (this.listenerCount("error") > 0) this.emit("error", error);
    else this.logger.error?.("Potassium bridge socket error");
  }

  #rejectPending(error, retainActiveRequest = false) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.requestQueue = [];
    if (!retainActiveRequest) {
      this.activeRequestId = null;
      this.activeMethod = null;
      this.activeStartedAt = null;
      this.recoveryRequestId = null;
      this.emit("activity", null);
    }
  }
}

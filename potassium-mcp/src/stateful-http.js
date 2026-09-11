import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const MCP_SESSION_HEADER = "mcp-session-id";
export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_IDLE_TTL_MS = 900_000;

function headerValue(headers, name) {
  const value = typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendFailure(response, status, message) {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Owns the paired server and Streamable HTTP transport for each MCP session.
 * The broker remains responsible for authenticating requests before this handler.
 */
export class StatefulHttpSessionRegistry {
  constructor({
    serverFactory,
    transportFactory = (options) => new StreamableHTTPServerTransport(options),
    now = () => Date.now(),
    idGenerator = () => crypto.randomUUID(),
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    onSessionClosed,
  } = {}) {
    if (typeof serverFactory !== "function") throw new TypeError("serverFactory must be a function");
    if (typeof transportFactory !== "function") throw new TypeError("transportFactory must be a function");
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError("maxSessions must be a positive integer");
    if (!Number.isFinite(idleTtlMs) || idleTtlMs < 0) throw new RangeError("idleTtlMs must be a non-negative number");
    this.serverFactory = serverFactory;
    this.transportFactory = transportFactory;
    this.onSessionClosed = onSessionClosed;
    this.now = now;
    this.idGenerator = idGenerator;
    this.maxSessions = maxSessions;
    this.idleTtlMs = idleTtlMs;
    this.sessions = new Map();
    this.shuttingDown = false;
    this.closePromise = null;
  }

  get size() { return this.sessions.size; }

  closeResponseStream(sessionId, requestId, expectedServer) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closeRequested || session.server !== expectedServer
      || typeof session.transport?.closeSSEStream !== "function") return false;
    session.transport.closeSSEStream(requestId);
    return true;
  }

  async handleRequest(request, response, body = request.body) {
    if (this.shuttingDown) return sendFailure(response, 503, "MCP sessions are shutting down");
    await this.expireIdleSessions();
    if (this.shuttingDown) return sendFailure(response, 503, "MCP sessions are shutting down");
    const sessionId = headerValue(request.headers, MCP_SESSION_HEADER);
    if (request.method === "POST" && !sessionId) return this.#handleInitialize(request, response, body);
    if (!["POST", "GET", "DELETE"].includes(request.method)) return sendFailure(response, 405, "Method not allowed");
    const session = this.sessions.get(sessionId);
    if (!session || session.initializing || session.closeRequested) return sendFailure(response, 404, "MCP session not found");
    await this.#serve(session, request, response, body);
    if (request.method === "DELETE" && !(response.statusCode >= 400)) await this.close(sessionId);
  }

  async close(sessionId, expectedServer) {
    const session = this.sessions.get(sessionId);
    if (!session || (expectedServer !== undefined && session.server !== expectedServer)) return false;
    if (session.closePromise) return session.closePromise;
    session.closeRequested = true;
    session.closePromise = Promise.resolve().then(async () => {
      await session.initialization.catch(() => {});
      await Promise.allSettled([
        Promise.resolve().then(() => session.server?.close?.()),
        Promise.resolve().then(() => session.transport?.close?.()),
      ]);
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.onSessionClosed?.(sessionId, session.server);
      return true;
    });
    return session.closePromise;
  }

  closeAll() {
    this.shuttingDown = true;
    this.closePromise ??= Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId)));
    return this.closePromise;
  }

  async expireIdleSessions() {
    const cutoff = this.now() - this.idleTtlMs;
    await Promise.all([...this.sessions.entries()]
      .filter(([, session]) => !session.initializing && session.activeRequests === 0 && session.lastActivity <= cutoff)
      .map(([sessionId]) => this.close(sessionId)));
  }

  async #handleInitialize(request, response, body) {
    if (!isInitializeRequest(body)) return sendFailure(response, 400, "Initialization request required");
    if (this.sessions.size >= this.maxSessions) return sendFailure(response, 429, "Too many MCP sessions");
    const id = this.idGenerator();
    if (typeof id !== "string" || !id) throw new TypeError("idGenerator must return a non-empty string");
    if (this.sessions.has(id)) throw new Error("idGenerator returned an active session ID");
    const session = { initializing: true, activeRequests: 0, lastActivity: this.now(), closeRequested: false };
    this.sessions.set(id, session);
    session.initialization = Promise.resolve().then(async () => {
      session.server = await this.serverFactory({ sessionId: id });
      if (session.closeRequested) return;
      session.transport = this.transportFactory({ sessionIdGenerator: () => id });
      // SDK Server.close also closes its transport. Share the same close operation
      // with registry cleanup, including failed/partial server.connect calls.
      const closeTransport = session.transport.close?.bind(session.transport);
      let transportClose;
      session.transport.close = () => transportClose ??= Promise.resolve().then(() => closeTransport?.());
      const onclose = session.transport.onclose;
      session.transport.onclose = (...args) => {
        try { onclose?.(...args); } finally { void this.close(id); }
      };
      await session.server.connect(session.transport);
    });
    try {
      await session.initialization;
      session.initializing = false;
      if (session.closeRequested || this.shuttingDown || request.aborted || response.destroyed || response.writableEnded) {
        await this.close(id);
        return sendFailure(response, 503, "MCP session initialization was interrupted");
      }
      await this.#serve(session, request, response, body);
      if (response.statusCode >= 400) await this.close(id);
    } catch (error) {
      await this.close(id);
      throw error;
    }
  }

  async #serve(session, request, response, body) {
    session.activeRequests += 1;
    session.lastActivity = this.now();
    const observesResponse = typeof response.once === "function";
    let handled = false;
    let ended = false;
    let released = false;
    const release = () => {
      if (released || !handled || !ended) return;
      released = true;
      response.off?.("finish", onEnd);
      response.off?.("close", onEnd);
      session.activeRequests -= 1;
      session.lastActivity = this.now();
    };
    const onEnd = () => { ended = true; release(); };
    if (observesResponse) {
      response.once("finish", onEnd);
      response.once("close", onEnd);
    }
    try {
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      ended = true;
      throw error;
    } finally {
      handled = true;
      ended ||= !observesResponse || response.writableEnded || response.destroyed;
      release();
    }
  }
}

export function createStatefulHttpSessionRegistry(options) {
  return new StatefulHttpSessionRegistry(options);
}

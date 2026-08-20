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
  if (response.headersSent || response.writableEnded) return;
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
  } = {}) {
    if (typeof serverFactory !== "function") throw new TypeError("serverFactory must be a function");
    if (typeof transportFactory !== "function") throw new TypeError("transportFactory must be a function");
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError("maxSessions must be a positive integer");
    if (!Number.isFinite(idleTtlMs) || idleTtlMs < 0) throw new RangeError("idleTtlMs must be a non-negative number");
    this.serverFactory = serverFactory;
    this.transportFactory = transportFactory;
    this.now = now;
    this.idGenerator = idGenerator;
    this.maxSessions = maxSessions;
    this.idleTtlMs = idleTtlMs;
    this.sessions = new Map();
    this.pendingSessions = 0;
  }

  get size() { return this.sessions.size; }

  async handleRequest(request, response, body = request.body) {
    await this.expireIdleSessions();
    const sessionId = headerValue(request.headers, MCP_SESSION_HEADER);
    if (request.method === "POST") return this.#handlePost(request, response, body, sessionId);
    if (request.method === "GET") return this.#handleExisting(request, response, body, sessionId);
    if (request.method === "DELETE") return this.#handleDelete(request, response, body, sessionId);
    sendFailure(response, 405, "Method not allowed");
  }

  async close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (session.closePromise) return session.closePromise;
    session.closePromise = Promise.allSettled([
      session.transport.close?.(),
      session.server.close?.(),
    ]).then(() => true);
    return session.closePromise;
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId)));
  }

  async expireIdleSessions() {
    const cutoff = this.now() - this.idleTtlMs;
    await Promise.all([...this.sessions.entries()]
      .filter(([, session]) => session.lastActivity <= cutoff)
      .map(([sessionId]) => this.close(sessionId)));
  }

  async #handlePost(request, response, body, sessionId) {
    if (sessionId) return this.#handleExisting(request, response, body, sessionId);
    if (!isInitializeRequest(body)) return sendFailure(response, 400, "Initialization request required");
    if (this.sessions.size + this.pendingSessions >= this.maxSessions) return sendFailure(response, 429, "Too many MCP sessions");
    this.pendingSessions += 1;
    try {
      const id = this.idGenerator();
      if (typeof id !== "string" || !id) throw new TypeError("idGenerator must return a non-empty string");
      if (this.sessions.has(id)) throw new Error("idGenerator returned an active session ID");

      const server = await this.serverFactory({ sessionId: id });
      const transport = this.transportFactory({ sessionIdGenerator: () => id });
      const session = { server, transport, lastActivity: this.now(), closePromise: undefined };
      this.sessions.set(id, session);
      try {
        await server.connect(transport);
        const onclose = transport.onclose;
        transport.onclose = (...args) => {
          try { onclose?.(...args); } finally { void this.close(id); }
        };
        await transport.handleRequest(request, response, body);
      } catch (error) {
        await this.close(id);
        throw error;
      }
    } finally {
      this.pendingSessions -= 1;
    }
  }

  async #handleExisting(request, response, body, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return sendFailure(response, 404, "MCP session not found");
    session.lastActivity = this.now();
    await session.transport.handleRequest(request, response, body);
  }

  async #handleDelete(request, response, body, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return sendFailure(response, 404, "MCP session not found");
    session.lastActivity = this.now();
    try {
      await session.transport.handleRequest(request, response, body);
    } finally {
      await this.close(sessionId);
    }
  }
}

export function createStatefulHttpRequestHandler(options) {
  const registry = options instanceof StatefulHttpSessionRegistry ? options : new StatefulHttpSessionRegistry(options);
  const handler = async (request, response, next) => {
    try {
      await registry.handleRequest(request, response, request.body);
    } catch (error) {
      if (next) return next(error);
      sendFailure(response, 500, "Internal server error");
    }
  };
  handler.registry = registry;
  handler.close = () => registry.closeAll();
  return handler;
}

export function createStatefulHttpSessionRegistry(options) {
  return new StatefulHttpSessionRegistry(options);
}

import { readFile } from "node:fs/promises";

export const BUILTIN_FALLBACK_URL = "http://127.0.0.1:8225/mcp";
export const BUILTIN_FALLBACK_TIMEOUT_MS = 3000;
export const BUILTIN_FALLBACK_MAX_RESPONSE_BYTES = 64 * 1024;

const allowedTools = new Set([
  "list_clients",
  "read_console",
]);

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
};

function failure(message) {
  return new Error(`Built-in fallback unavailable: ${message}`);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function validateBuiltinFallbackUrl(url = BUILTIN_FALLBACK_URL) {
  if (typeof url !== "string" || url !== BUILTIN_FALLBACK_URL) {
    throw failure("endpoint must be the fixed loopback MCP URL");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "8225"
    || parsed.pathname !== "/mcp"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw failure("endpoint must be the fixed loopback MCP URL");
  }
  return parsed.href;
}

export function validateBuiltinFallbackToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 4096
    || /[\u0000-\u001f\u007f\s]/.test(token)) {
    throw failure("token file does not contain one valid bearer token");
  }
  return token;
}

async function loadToken(tokenFile, readToken) {
  if (typeof tokenFile !== "string" || tokenFile.length === 0 || tokenFile.length > 4096) {
    throw failure("a separate token file is required");
  }
  let token;
  try {
    token = (await readToken(tokenFile, "utf8")).trim();
  } catch {
    throw failure("could not read token file");
  }
  return validateBuiltinFallbackToken(token);
}

async function readChunk(reader, signal) {
  if (signal.aborted) throw failure("request timed out");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(failure("request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedBody(response, signal) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > BUILTIN_FALLBACK_MAX_RESPONSE_BYTES) {
      throw failure("response exceeds the 65536-byte limit");
    }
  }

  if (!response.body?.getReader) throw failure("response body is missing");
  const reader = response.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure("response body is invalid");
      bytes += value.byteLength;
      if (bytes > BUILTIN_FALLBACK_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw failure("response exceeds the 65536-byte limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
  } catch {
    throw failure("response is not valid UTF-8");
  }
}

function parseSsePayload(body) {
  const events = [];
  let data = [];
  const emit = () => {
    if (data.length > 0) events.push(data.join("\n"));
    data = [];
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") {
      emit();
    } else if (!line.startsWith(":") && line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  emit();
  if (events.length !== 1) throw failure("SSE response does not contain exactly one message");
  try {
    return JSON.parse(events[0]);
  } catch {
    throw failure("SSE response is not valid JSON");
  }
}

function parseResponsePayload(body, contentType) {
  if (/^application\/json(?:\s*;|$)/i.test(contentType)) {
    try {
      return JSON.parse(body);
    } catch {
      throw failure("response is not valid JSON");
    }
  }
  if (/^text\/event-stream(?:\s*;|$)/i.test(contentType)) return parseSsePayload(body);
  throw failure("response content type is not JSON or SSE");
}

function boundedToolMetadata(result) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.tools)) {
    throw failure("tools/list response is invalid");
  }
  return result.tools
    .filter((tool) => tool !== null && typeof tool === "object" && allowedTools.has(tool.name))
    .map((tool) => ({ name: tool.name }));
}


function redactToken(value, token) {
  if (typeof value === "string") return value.split(token).join("[redacted]");
  if (Array.isArray(value)) return value.map((entry) => redactToken(entry, token));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactToken(entry, token)]));
  }
  return value;
}

function validateToolResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.content)
    || !result.content.every((entry) => entry !== null && typeof entry === "object"
      && entry.type === "text" && typeof entry.text === "string")) {
    throw failure("tool response is invalid");
  }
}

function validateConsoleArguments(pid, options) {
  if (typeof pid !== "string" || !/^[1-9]\d{0,10}$/.test(pid)) {
    throw new TypeError("pid must be a positive decimal process identifier");
  }
  if (options === undefined) return { pid };
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("console options must be an object");
  const { afterCursor, limit, waitMs, ...unknown } = options;
  if (Object.keys(unknown).length > 0) throw new TypeError("console options contain an unknown field");
  if (afterCursor !== undefined && (!Number.isSafeInteger(afterCursor) || afterCursor < 0)) throw new TypeError("afterCursor must be a non-negative integer");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw new TypeError("limit must be an integer from 1 through 200");
  if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > BUILTIN_FALLBACK_TIMEOUT_MS)) throw new TypeError("waitMs must be an integer from 0 through 3000");
  return {
    pid,
    ...(afterCursor === undefined ? {} : { after_cursor: afterCursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(waitMs === undefined ? {} : { wait_ms: waitMs }),
  };
}

function responseResult(payload, id) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
    || payload.jsonrpc !== "2.0" || payload.id !== id || !("result" in payload)
    || "error" in payload) {
    throw failure("received an invalid JSON-RPC response");
  }
  return payload.result;
}

function validateInitialize(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || typeof result.protocolVersion !== "string") {
    throw failure("initialize response is invalid");
  }
}

export class BuiltinFallbackClient {
  #fetch;
  #clock;
  #tokenFile;
  #readToken;
  #url;
  #nextId = 1;

  constructor({ tokenFile, fetch: fetchImplementation = globalThis.fetch, clock = systemClock, readToken = readFile, url = BUILTIN_FALLBACK_URL } = {}) {
    if (typeof fetchImplementation !== "function") throw new TypeError("fetch must be a function");
    if (!clock || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") throw new TypeError("clock must provide setTimeout and clearTimeout");
    this.#fetch = fetchImplementation;
    this.#clock = clock;
    this.#tokenFile = tokenFile;
    this.#readToken = readToken;
    this.#url = validateBuiltinFallbackUrl(url);
  }

  async #request(token, method, params) {
    const id = this.#nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (byteLength(body) > BUILTIN_FALLBACK_MAX_RESPONSE_BYTES) throw failure("request exceeds the 65536-byte limit");
    const controller = new AbortController();
    const timeout = this.#clock.setTimeout(() => controller.abort(), BUILTIN_FALLBACK_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body,
          signal: controller.signal,
        });
      } catch {
        throw failure(controller.signal.aborted ? "request timed out" : "request failed");
      }
      if (!response || response.status !== 200) throw failure("server returned a non-success status");
      const contentType = response.headers?.get?.("content-type") ?? "";
      const payload = parseResponsePayload(await readBoundedBody(response, controller.signal), contentType);
      return responseResult(payload, id);
    } finally {
      this.#clock.clearTimeout(timeout);
    }
  }

  async #discover() {
    const token = await loadToken(this.#tokenFile, this.#readToken);
    const initialized = await this.#request(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "potassium-builtin-fallback", version: "1" },
    });
    validateInitialize(initialized);
    const listed = await this.#request(token, "tools/list", {});
    return { token, tools: boundedToolMetadata(listed) };
  }

  async #call(toolName, arguments_) {
    if (!allowedTools.has(toolName)) throw failure("tool is not an allowed diagnostic method");
    const { token, tools } = await this.#discover();
    if (!tools.some((tool) => tool.name === toolName)) {
      throw failure(`required diagnostic tool ${toolName} is unavailable`);
    }
    const result = await this.#request(token, "tools/call", { name: toolName, arguments: arguments_ });
    validateToolResult(result);
    return redactToken(result, token);
  }
  status() {
    return this.#discover().then(({ tools }) => ({ reachable: true, tools }));
  }

  listClients() {
    return this.#call("list_clients", {});
  }

  readConsole(pid, options) {
    return this.#call("read_console", validateConsoleArguments(pid, options));
  }
}
export function createBuiltinFallbackClient(options) {
  return new BuiltinFallbackClient(options);
}

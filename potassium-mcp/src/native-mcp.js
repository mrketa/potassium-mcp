import { readFile } from "node:fs/promises";

export const NATIVE_MCP_URL = "http://127.0.0.1:8225/mcp";
export const NATIVE_MCP_TIMEOUT_MS = 3000;

const systemClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class NativeMcpTransportError extends Error {
  constructor(prefix, message, kind = "unavailable") {
    super(`${prefix}: ${message}`);
    this.name = "NativeMcpTransportError";
    this.kind = kind;
    this.dispatched = false;
  }
}

export function validateNativeMcpUrl(url = NATIVE_MCP_URL, failure) {
  if (typeof url !== "string" || url !== NATIVE_MCP_URL) {
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

export function redactNativeToken(value, token) {
  if (typeof value === "string") return value.split(token).join("[redacted]");
  if (Array.isArray(value)) return value.map((entry) => redactNativeToken(entry, token));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactNativeToken(key, token), redactNativeToken(entry, token)]));
  }
  return value;
}

async function loadToken(tokenFile, readToken, failure) {
  if (typeof tokenFile !== "string" || tokenFile.length === 0 || tokenFile.length > 4096) {
    throw failure("a separate token file is required");
  }
  let token;
  try {
    token = (await readToken(tokenFile, "utf8")).trim();
  } catch {
    throw failure("could not read token file");
  }
  if (typeof token !== "string" || token.length < 32 || token.length > 4096
    || /[\u0000-\u001f\u007f\s]/.test(token)) {
    throw failure("token file does not contain one valid bearer token");
  }
  return token;
}

async function beforeAbort(operation, signal, failure) {
  if (signal.aborted) throw failure("request timed out");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(failure("request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedBody(response, signal, maxBytes, failure) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw failure(`response exceeds the ${maxBytes}-byte limit`, "too-large");
    }
  }
  if (!response.body?.getReader) throw failure("response body is missing");
  const reader = response.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await beforeAbort(() => reader.read(), signal, failure);
      } catch {
        throw failure(signal.aborted ? "request timed out" : "response body could not be read");
      }
      const { done, value } = chunk;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure("response body is invalid");
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure(`response exceeds the ${maxBytes}-byte limit`, "too-large");
      parts.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
  } catch {
    throw failure("response is not valid UTF-8");
  }
}

function parseSsePayload(body, failure) {
  const events = [];
  let data = [];
  const emit = () => {
    if (data.length > 0) events.push(data.join("\n"));
    data = [];
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") emit();
    else if (!line.startsWith(":") && line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  emit();
  if (events.length !== 1) throw failure("SSE response does not contain exactly one message");
  try {
    return JSON.parse(events[0]);
  } catch {
    throw failure("SSE response is not valid JSON");
  }
}

function parseResponsePayload(body, contentType, failure) {
  if (/^application\/json(?:\s*;|$)/i.test(contentType)) {
    try {
      return JSON.parse(body);
    } catch {
      throw failure("response is not valid JSON");
    }
  }
  if (/^text\/event-stream(?:\s*;|$)/i.test(contentType)) return parseSsePayload(body, failure);
  throw failure("response content type is not JSON or SSE");
}

function responseResult(payload, id, failure) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
    || payload.jsonrpc !== "2.0" || payload.id !== id) {
    throw failure("received an invalid JSON-RPC response");
  }
  if ("error" in payload) {
    const error = payload.error;
    const refused = !("result" in payload) && error !== null && typeof error === "object"
      && Number.isSafeInteger(error.code) && typeof error.message === "string";
    throw failure("received an invalid JSON-RPC response", refused ? "refused" : "unavailable");
  }
  if (!("result" in payload)) throw failure("received an invalid JSON-RPC response");
  return payload.result;
}

class NativeMcpTransport {
  #fetch;
  #clock;
  #tokenFile;
  #readToken;
  #url;
  #maxBytes;
  #failure;
  #nextId = 1;

  constructor({ tokenFile, fetch: fetchImplementation = globalThis.fetch, clock = systemClock, readToken = readFile,
    url = NATIVE_MCP_URL, maxBytes = 64 * 1024, errorPrefix = "Native MCP unavailable" } = {}) {
    if (typeof fetchImplementation !== "function") throw new TypeError("fetch must be a function");
    if (!clock || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") throw new TypeError("clock must provide setTimeout and clearTimeout");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
    this.#failure = (message, kind) => new NativeMcpTransportError(errorPrefix, message, kind);
    this.#fetch = fetchImplementation;
    this.#clock = clock;
    this.#tokenFile = tokenFile;
    this.#readToken = readToken;
    this.#url = validateNativeMcpUrl(url, this.#failure);
    this.#maxBytes = maxBytes;
  }

  async request(token, method, params, { signal } = {}) {
    if (signal?.aborted) throw this.#failure("request cancelled", "cancelled");
    const id = this.#nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(body, "utf8") > this.#maxBytes) throw this.#failure(`request exceeds the ${this.#maxBytes}-byte limit`, "too-large");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = this.#clock.setTimeout(() => controller.abort(), NATIVE_MCP_TIMEOUT_MS);
    let response;
    let dispatched = false;
    try {
      try {
        response = await beforeAbort(() => {
          dispatched = true;
          const pending = Promise.resolve(this.#fetch(this.#url, {
            method: "POST",
            redirect: "error",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body,
            signal: controller.signal,
          }));
          // A non-cooperative fetch can finish after the deadline. Discard its receipt.
          void pending.then((late) => {
            if (controller.signal.aborted && late?.body && !late.body.locked) void late.body.cancel().catch(() => {});
          }, () => {});
          return pending;
        }, controller.signal, this.#failure);
      } catch {
        throw this.#failure(controller.signal.aborted ? "request timed out" : "request failed");
      }
      if (!response || response.status !== 200 || response.redirected) throw this.#failure("server returned a non-success status");
      const contentType = response.headers?.get?.("content-type") ?? "";
      const payload = parseResponsePayload(await readBoundedBody(response, controller.signal, this.#maxBytes, this.#failure), contentType, this.#failure);
      return responseResult(payload, id, this.#failure);
    } catch (error) {
      const safe = signal?.aborted ? this.#failure("request cancelled", "cancelled")
        : error instanceof NativeMcpTransportError ? error : this.#failure("response could not be processed");
      safe.dispatched = dispatched;
      throw safe;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      this.#clock.clearTimeout(timeout);
    }
  }

  async discover(clientName, options = {}) {
    if (options.signal?.aborted) throw this.#failure("request cancelled", "cancelled");
    const token = await loadToken(this.#tokenFile, this.#readToken, this.#failure);
    const initialized = await this.request(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    }, options);
    if (initialized === null || typeof initialized !== "object" || Array.isArray(initialized)
      || typeof initialized.protocolVersion !== "string") {
      throw this.#failure("initialize response is invalid");
    }
    const listed = await this.request(token, "tools/list", {}, options);
    if (listed === null || typeof listed !== "object" || !Array.isArray(listed.tools)) {
      throw this.#failure("tools/list response is invalid");
    }
    return { token, tools: listed.tools };
  }
}

export function createNativeMcpTransport(options) {
  return new NativeMcpTransport(options);
}

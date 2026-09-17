import { createHash } from "node:crypto";
import { createNativeMcpTransport, NativeMcpTransportError } from "./native-mcp.js";

export const NATIVE_EDITOR_MAX_CONTENT_BYTES = 262144;
export const NATIVE_EDITOR_MAX_WIRE_BYTES = 2 * 1024 * 1024;

const errorDetails = {
  unavailable: "the native editor is unavailable or returned an invalid response",
  conflict: "the tab changed; read it again before submitting a replacement",
  "too-large": "content or native response exceeds the supported size limit",
  refused: "the native editor refused the operation",
  cancelled: "the operation was cancelled before mutation dispatch",
  indeterminate: "the mutation may have occurred; inspect the editor state before deciding whether to retry",
};

export class NativeEditorError extends Error {
  constructor(code, detail = errorDetails[code]) {
    super(`Native editor ${code}: ${detail}`);
    this.name = "NativeEditorError";
    this.code = code;
  }
}

function checkCancellation(signal) {
  if (signal?.aborted) throw new NativeEditorError("cancelled");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function argumentsObject(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new NativeEditorError("refused", "arguments must contain only the supported fields");
  }
  return value;
}

function inputString(value, limit, field, nonempty = false) {
  if (typeof value !== "string" || (nonempty && value.length === 0) || value.length > limit) {
    throw new NativeEditorError("refused", `${field} is not a valid bounded string`);
  }
  return value;
}

function contentString(value, input = false) {
  if (typeof value !== "string") throw new NativeEditorError(input ? "refused" : "unavailable");
  if (Buffer.byteLength(value, "utf8") > NATIVE_EDITOR_MAX_CONTENT_BYTES) throw new NativeEditorError("too-large");
  return value;
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function metadataString(value, limit, token, nonempty = false) {
  if (typeof value !== "string" || value.length > limit || (nonempty && value.length === 0) || value.includes(token)) {
    throw new NativeEditorError("unavailable");
  }
  return value;
}

function tabInfo(value, token, expectedId) {
  if (!object(value) || typeof value.dirty !== "boolean" || typeof value.active !== "boolean" || typeof value.pinned !== "boolean") {
    throw new NativeEditorError("unavailable");
  }
  const tab = {
    id: metadataString(value.id, 256, token, true),
    title: metadataString(value.title, 1024, token),
    kind: metadataString(value.kind, 64, token),
    dirty: value.dirty,
    active: value.active,
    pinned: value.pinned,
    ...(value.path === undefined ? {} : { path: metadataString(value.path, 4096, token) }),
  };
  if (expectedId !== undefined && tab.id !== expectedId) throw new NativeEditorError("unavailable");
  return tab;
}

function nativePayload(result) {
  if (!object(result)) throw new NativeEditorError("unavailable");
  if (result.isError !== undefined && typeof result.isError !== "boolean") throw new NativeEditorError("unavailable");
  if (result.content !== undefined && (!Array.isArray(result.content)
    || !result.content.every((entry) => object(entry) && entry.type === "text" && typeof entry.text === "string"))) {
    throw new NativeEditorError("unavailable");
  }
  if (result.isError === true) {
    if (!Array.isArray(result.content)) throw new NativeEditorError("unavailable");
    throw new NativeEditorError("refused");
  }
  let payload;
  if (result.structuredContent !== undefined) {
    payload = result.structuredContent;
  } else {
    if (result.content?.length !== 1) throw new NativeEditorError("unavailable");
    try {
      payload = JSON.parse(result.content[0].text);
    } catch {
      throw new NativeEditorError("unavailable");
    }
  }
  if (!object(payload) || typeof payload.message !== "string") throw new NativeEditorError("unavailable");
  return payload;
}

function transportError(error) {
  if (error instanceof NativeEditorError) return error;
  if (error instanceof NativeMcpTransportError && error.kind === "too-large") return new NativeEditorError("too-large");
  if (error instanceof NativeMcpTransportError && error.kind === "cancelled") return new NativeEditorError("cancelled");
  return new NativeEditorError("unavailable");
}

class NativeEditorClient {
  #transport;
  #tabs = new Map();

  constructor(options) {
    try {
      this.#transport = createNativeMcpTransport({
        ...options,
        maxBytes: NATIVE_EDITOR_MAX_WIRE_BYTES,
        errorPrefix: "Native editor unavailable",
      });
    } catch (error) {
      throw transportError(error);
    }
  }

  async #withTab(id, signal, operation) {
    checkCancellation(signal);
    const previous = this.#tabs.get(id) ?? Promise.resolve();
    const result = previous.then(() => {
      checkCancellation(signal);
      return operation();
    });
    // Store a fulfilled tail so failed edits never poison subsequent operations.
    const tail = result.then(() => {}, () => {});
    this.#tabs.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.#tabs.get(id) === tail) this.#tabs.delete(id);
    }
  }

  async #call(action, arguments_, mutation, project, signal) {
    checkCancellation(signal);
    let discovered;
    try {
      discovered = await this.#transport.discover("potassium-native-editor", { signal });
      checkCancellation(signal);
      if (!discovered.tools.some((tool) => object(tool) && tool.name === "tabs")) {
        throw new NativeEditorError("unavailable");
      }
    } catch (error) {
      throw transportError(error);
    }
    const { token } = discovered;
    if (mutation && Object.values(arguments_).some((value) => typeof value === "string" && value.includes(token))) {
      throw new NativeEditorError("refused", "arguments contain a protected credential");
    }
    let result;
    try {
      result = await this.#transport.request(token, "tools/call", { name: "tabs", arguments: { action, ...arguments_ } }, { signal });
    } catch (error) {
      // Any transport failure after a mutation might conceal a committed change.
      // A JSON-RPC error is not proof that native application state stayed intact.
      if (mutation && (!(error instanceof NativeMcpTransportError) || error.dispatched)) {
        throw new NativeEditorError("indeterminate");
      }
      throw transportError(error);
    }
    try {
      if (mutation && signal?.aborted) throw new NativeEditorError("indeterminate");
      checkCancellation(signal);
      return project(nativePayload(result), token);
    } catch (error) {
      if (error instanceof NativeEditorError && error.code === "refused") throw error;
      // Never report a malformed or stale mutation receipt as a definite failure.
      if (mutation) throw new NativeEditorError("indeterminate");
      throw transportError(error);
    }
  }

  #read(id, signal) {
    return this.#call("read", { id }, false, (payload, token) => {
      const tab = tabInfo(payload.tab, token, id);
      const content = contentString(payload.content);
      // Reject a reflected credential instead of silently changing source/hash semantics.
      if (content.includes(token)) throw new NativeEditorError("unavailable");
      return { tab, content, sha256: sha256(content) };
    }, signal);
  }

  async listTabs({ signal } = {}) {
    return this.#call("list", {}, false, (payload, token) => {
      if (!Array.isArray(payload.tabs)) throw new NativeEditorError("unavailable");
      if (payload.tabs.length > 512) throw new NativeEditorError("too-large");
      const ids = new Set();
      const tabs = payload.tabs.map((value) => {
        const tab = tabInfo(value, token);
        if (ids.has(tab.id)) throw new NativeEditorError("unavailable");
        ids.add(tab.id);
        return tab;
      });
      return { tabs };
    }, signal);
  }

  async readTab(arguments_, { signal } = {}) {
    const { id } = argumentsObject(arguments_, ["id"]);
    inputString(id, 256, "id", true);
    return this.#withTab(id, signal, () => this.#read(id, signal));
  }

  async openTab(arguments_ = {}, { signal } = {}) {
    const { title, content } = argumentsObject(arguments_, ["title", "content"]);
    if (title !== undefined) inputString(title, 1024, "title");
    if (content !== undefined) contentString(content, true);
    return this.#call("open", {
      ...(title === undefined ? {} : { title }),
      ...(content === undefined ? {} : { content }),
    }, true, (payload, token) => {
      const tab = tabInfo(payload.tab, token);
      if (!tab.active || (payload.content !== undefined && payload.content !== (content ?? ""))) throw new NativeEditorError("unavailable");
      return { tab };
    }, signal);
  }

  async writeTab(arguments_, { signal } = {}) {
    const { id, content, expectedSha256 } = argumentsObject(arguments_, ["id", "content", "expectedSha256"]);
    inputString(id, 256, "id", true);
    contentString(content, true);
    if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new NativeEditorError("refused", "expectedSha256 must be a lowercase SHA-256 digest");
    }
    return this.#withTab(id, signal, async () => {
      const current = await this.#read(id, signal);
      checkCancellation(signal);
      if (current.sha256 !== expectedSha256) throw new NativeEditorError("conflict");
      return this.#call("write", { id, content }, true, (payload, token) => {
        const tab = tabInfo(payload.tab, token, id);
        if (payload.content !== undefined && payload.content !== content) throw new NativeEditorError("unavailable");
        return { tab, sha256: sha256(content), preconditionAtomic: false };
      }, signal);
    });
  }

  async activateTab(arguments_, { signal } = {}) {
    const { id } = argumentsObject(arguments_, ["id"]);
    inputString(id, 256, "id", true);
    return this.#withTab(id, signal, () => this.#call("activate", { id }, true, (payload, token) => {
      const tab = tabInfo(payload.tab, token, id);
      if (!tab.active) throw new NativeEditorError("unavailable");
      return { tab };
    }, signal));
  }

  async closeTab(arguments_, { signal } = {}) {
    const { id } = argumentsObject(arguments_, ["id"]);
    inputString(id, 256, "id", true);
    return this.#withTab(id, signal, () => this.#call("close", { id }, true, (payload, token) => {
      if (payload.tab !== undefined) tabInfo(payload.tab, token, id);
      return { id: metadataString(id, 256, token, true), closed: true };
    }, signal));
  }
}

export function createNativeEditorClient(options) {
  return new NativeEditorClient(options);
}

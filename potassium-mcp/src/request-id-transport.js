import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

export const MAX_PENDING_MCP_REQUESTS = 256;

/** Preserve wire IDs while giving the pinned SDK uniformly truthy request IDs. */
export class RequestIdTransport {
  #transport;
  #external = new Map();
  #internal = new Map();
  #dispatches = new Set();
  #nextId = 0n;
  #closed = false;
  #closePromise;
  #maximum;
  #onRequestCancelled;
  #onRequestStart;
  #onResponseSent;

  constructor(transport, { maxPendingRequests = MAX_PENDING_MCP_REQUESTS, onRequestCancelled, onRequestStart, onResponseSent } = {}) {
    if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > MAX_PENDING_MCP_REQUESTS) {
      throw new RangeError(`maxPendingRequests must be an integer from 1 to ${MAX_PENDING_MCP_REQUESTS}`);
    }
    this.#transport = transport;
    this.#maximum = maxPendingRequests;
    this.#onRequestCancelled = onRequestCancelled;
    this.#onRequestStart = onRequestStart;
    this.#onResponseSent = onResponseSent;
    const previousMessage = transport.onmessage;
    const previousClose = transport.onclose;
    const previousError = transport.onerror;
    transport.onmessage = (message, extra) => {
      previousMessage?.(message, extra);
      this.#receive(message, extra);
    };
    transport.onclose = () => {
      try { previousClose?.(); } finally { this.#didClose(); }
    };
    transport.onerror = (error) => {
      try { previousError?.(error); } finally { this.onerror?.(error); }
    };
  }

  get sessionId() { return this.#transport.sessionId; }
  setProtocolVersion(version) { return this.#transport.setProtocolVersion?.(version); }

  async start() {
    try { await this.#transport.start(); }
    catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  #retire(record) {
    this.#external.delete(record.externalId);
    this.#internal.delete(record.internalId);
  }

  #finishDispatch(record) {
    if (!this.#dispatches.delete(record)) return;
    try { record.settle?.(); } catch (error) { this.onerror?.(error); }
  }

  #responseSent(id) {
    try { this.#onResponseSent?.(id); } catch (error) { this.onerror?.(error); }
  }

  async #rejectRequest(id, message) {
    try {
      await this.#transport.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
      this.#responseSent(id);
    } catch (error) { this.onerror?.(error); }
  }

  #receive(message, extra) {
    if (this.#closed) return;
    if (message.method === "notifications/cancelled" && !Object.hasOwn(message, "id")) {
      if (!CancelledNotificationSchema.safeParse(message).success) return;
      const record = this.#external.get(message.params.requestId);
      if (!record) return;
      this.#retire(record);
      this.onmessage?.({ ...message, params: { ...message.params, requestId: record.internalId } }, extra);
      // Release the wire ID synchronously, but retain the independent dispatch
      // fence until the SDK's queued abort has run.
      queueMicrotask(() => this.#finishDispatch(record));
      try { this.#onRequestCancelled?.(record.externalId); }
      catch (error) { this.onerror?.(error); }
      return;
    }
    if (typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
      if (this.#external.has(message.id)) {
        this.onerror?.(new Error("Duplicate active MCP request ID"));
        void this.close().catch((error) => this.onerror?.(error));
        return;
      }
      if (this.#dispatches.size >= this.#maximum) {
        void this.#rejectRequest(message.id, "MCP request capacity exceeded; request was not dispatched");
        return;
      }
      let settle;
      try { settle = this.#onRequestStart?.(); }
      catch (error) {
        const reason = error?.code === "DRAINING" ? "MCP server is draining"
          : error?.code === "CAPACITY" ? "MCP request capacity exceeded" : "MCP request admission failed";
        void this.#rejectRequest(message.id, `${reason}; request was not dispatched`);
        return;
      }
      const record = { externalId: message.id, internalId: `request-${++this.#nextId}`, settle };
      this.#dispatches.add(record);
      this.#external.set(record.externalId, record);
      this.#internal.set(record.internalId, record);
      this.onmessage?.({ ...message, id: record.internalId }, extra);
      return;
    }
    // Responses to server-initiated requests are in the opposite ID namespace.
    this.onmessage?.(message, extra);
  }

  async send(message, options) {
    let outgoing = message;
    let outgoingOptions = options;
    let response;
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      response = this.#internal.get(message.id);
      // A cancelled request may finish after its ID was reused on the wire.
      if (!response) return;
      outgoing = { ...message, id: response.externalId };
    }
    if (options?.relatedRequestId !== undefined) {
      const related = this.#internal.get(options.relatedRequestId);
      if (!related) return;
      outgoingOptions = { ...options, relatedRequestId: related.externalId };
    }
    if (this.#closed) throw new Error("MCP transport is closed");
    // From this point the response is flushing, not cancellable. The underlying
    // transport's send/flush accounting remains responsible for drain safety.
    if (response) {
      this.#retire(response);
      this.#finishDispatch(response);
    }
    await this.#transport.send(outgoing, outgoingOptions);
    if (response) this.#responseSent(response.externalId);
  }

  #didClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#external.clear();
    this.#internal.clear();
    try { this.onclose?.(); }
    finally { for (const record of this.#dispatches) this.#finishDispatch(record); }
  }

  async close() {
    if (this.#closed) return;
    this.#closePromise ??= Promise.resolve().then(() => this.#transport.close()).finally(() => this.#didClose());
    return this.#closePromise;
  }
}

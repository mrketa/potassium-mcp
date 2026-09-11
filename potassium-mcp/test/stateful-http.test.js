import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MCP_SESSION_HEADER, StatefulHttpSessionRegistry } from "../src/stateful-http.js";
const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};


function response() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: undefined,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; this.writableEnded = true; },
  };
}

function request(method, sessionId, body) {
  return {
    method,
    body: arguments.length < 3 ? initializeBody : body,
    headers: sessionId ? { [MCP_SESSION_HEADER]: sessionId } : {},
  };
}

function harness(options = {}) {
  const servers = [];
  const transports = [];
  let nextId = 0;
  const registry = new StatefulHttpSessionRegistry({
    serverFactory: ({ sessionId }) => {
      const server = { sessionId, connected: undefined, closes: 0, async connect(transport) { this.connected = transport; }, async close() { this.closes += 1; } };
      servers.push(server);
      return server;
    },
    transportFactory: (transportOptions) => {
      const transport = {
        transportOptions,
        requests: [],
        closes: 0,
        onclose: undefined,
        async handleRequest(incoming, outgoing, body) { this.requests.push({ incoming, outgoing, body }); },
        async close() { this.closes += 1; this.onclose?.(); },
      };
      transports.push(transport);
      return transport;
    },
    idGenerator: () => `session-${++nextId}`,
    ...options,
  });
  return { registry, servers, transports };
}


test("DELETE dispatches then cleans up a session and closing is idempotent", async () => {
  const { registry, servers, transports } = harness();
  await registry.handleRequest(request("POST"), response());
  await registry.handleRequest(request("DELETE", "session-1", undefined), response(), undefined);

  assert.equal(registry.size, 0);
  assert.equal(transports[0].closes, 1);
  assert.equal(servers[0].closes, 1);
  assert.equal(await registry.close("session-1"), false);
  assert.equal(transports[0].closes, 1);
  assert.equal(servers[0].closes, 1);
});

test("rejects session operations with an invalid session ID", async () => {
  const { registry } = harness();
  for (const method of ["POST", "GET", "DELETE"]) {
    const result = response();
    await registry.handleRequest(request(method, "missing"), result);
    assert.equal(result.statusCode, 404);
  }
});

test("enforces the session cap without creating another server", async () => {
  const { registry, servers } = harness({ maxSessions: 1 });
  await registry.handleRequest(request("POST"), response());
  const result = response();
  await registry.handleRequest(request("POST"), result);

  assert.equal(result.statusCode, 429);
  assert.equal(registry.size, 1);
  assert.equal(servers.length, 1);
});

test("expires idle sessions before routing and closes both paired resources", async () => {
  let clock = 1_000;
  const { registry, servers, transports } = harness({ now: () => clock, idleTtlMs: 100 });
  await registry.handleRequest(request("POST"), response());
  clock += 100;
  const result = response();
  await registry.handleRequest(request("GET", "session-1", undefined), result, undefined);

  assert.equal(result.statusCode, 404);
  assert.equal(registry.size, 0);
  assert.equal(transports[0].closes, 1);
  assert.equal(servers[0].closes, 1);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("shutdown waits for an asynchronous server factory and prevents late session admission", async () => {
  const entered = deferred();
  const factory = deferred();
  let closes = 0;
  let transports = 0;
  const { registry } = harness({
    serverFactory: () => { entered.resolve(); return factory.promise; },
    transportFactory: () => { transports += 1; throw new Error("must not create a shutdown transport"); },
  });
  const result = response();
  const initializing = registry.handleRequest(request("POST"), result);
  await entered.promise;
  let closed = false;
  const shutdown = registry.closeAll().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  const rejected = response();
  await registry.handleRequest(request("POST"), rejected);
  assert.equal(rejected.statusCode, 503);
  factory.resolve({ async close() { closes += 1; } });
  await Promise.all([initializing, shutdown]);
  assert.equal(result.statusCode, 503);
  assert.equal(transports, 0);
  assert.equal(closes, 1);
  assert.equal(registry.size, 0);
  await registry.closeAll();
  assert.equal(closes, 1);
});

test("transport factory failure releases its already created server and capacity", async () => {
  let attempts = 0;
  const { registry, servers } = harness({
    maxSessions: 1,
    transportFactory: () => {
      if (++attempts === 1) throw new Error("transport factory failed");
      return { async handleRequest() {}, async close() {} };
    },
  });
  await assert.rejects(registry.handleRequest(request("POST"), response()), /transport factory failed/);
  assert.equal(servers[0].closes, 1);
  const next = response();
  await registry.handleRequest(request("POST"), next);
  assert.notEqual(next.statusCode, 429);
  assert.equal(registry.size, 1);
  await registry.closeAll();
});

test("duplicate session IDs cannot overwrite an initializing server", async () => {
  const entered = deferred();
  const factory = deferred();
  let creates = 0;
  const { registry } = harness({
    maxSessions: 2, idGenerator: () => "same-id",
    serverFactory: () => { creates += 1; entered.resolve(); return factory.promise; },
  });
  const first = registry.handleRequest(request("POST"), response());
  await entered.promise;
  await assert.rejects(registry.handleRequest(request("POST"), response()), /active session ID/);
  factory.resolve({ async connect() {}, async close() {} });
  await first;
  assert.equal(creates, 1);
  assert.equal(registry.size, 1);
  await registry.closeAll();
});

test("concurrent registry and SDK server close share one transport shutdown", async () => {
  const release = deferred();
  let transportCloses = 0;
  let serverCloses = 0;
  const { registry } = harness({
    serverFactory: () => ({
      async connect(transport) { this.transport = transport; },
      async close() { serverCloses += 1; await this.transport.close(); },
    }),
    transportFactory: () => ({
      async handleRequest() {},
      async close() { transportCloses += 1; this.onclose?.(); await release.promise; },
    }),
  });
  await registry.handleRequest(request("POST"), response());
  const first = registry.close("session-1");
  const second = registry.close("session-1");
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(serverCloses, 1);
  assert.equal(transportCloses, 1);
  assert.equal(await registry.close("session-1"), false);
});

test("close during server connect prevents handling the initialization request", async () => {
  let handled = 0;
  const { registry } = harness({
    serverFactory: () => ({
      async connect(transport) { this.transport = transport; await transport.close(); },
      async close() { await this.transport.close(); },
    }),
    transportFactory: () => ({
      async handleRequest() { handled += 1; },
      async close() { this.onclose?.(); },
    }),
  });
  const result = response();
  await registry.handleRequest(request("POST"), result);
  assert.equal(result.statusCode, 503);
  assert.equal(handled, 0);
  assert.equal(registry.size, 0);
});

test("idle expiry waits for active requests and starts TTL when the response finishes", async () => {
  let clock = 0;
  const entered = deferred();
  const release = deferred();
  const { registry } = harness({
    now: () => clock, idleTtlMs: 100,
    transportFactory: () => ({
      async handleRequest(incoming) {
        if (incoming.body?.method === "tools/call") { entered.resolve(); await release.promise; }
      },
      async close() {},
    }),
  });
  await registry.handleRequest(request("POST"), response());
  const pending = registry.handleRequest(request("POST", "session-1", { method: "tools/call" }), response());
  await entered.promise;
  clock = 1000;
  await registry.expireIdleSessions();
  assert.equal(registry.size, 1);
  release.resolve();
  await pending;
  clock = 1099;
  await registry.expireIdleSessions();
  assert.equal(registry.size, 1);
  clock = 1100;
  await registry.expireIdleSessions();
  assert.equal(registry.size, 0);
});

test("open GET SSE streams remain active until response close and release listeners", async () => {
  let clock = 0;
  const { registry } = harness({ now: () => clock, idleTtlMs: 100 });
  await registry.handleRequest(request("POST"), response());
  const stream = Object.assign(new EventEmitter(), response());
  await registry.handleRequest(request("GET", "session-1", undefined), stream);
  clock = 1000;
  await registry.expireIdleSessions();
  assert.equal(registry.size, 1);
  stream.emit("close");
  stream.emit("finish");
  assert.equal(stream.listenerCount("close"), 0);
  assert.equal(stream.listenerCount("finish"), 0);
  clock = 1099;
  await registry.expireIdleSessions();
  assert.equal(registry.size, 1);
  clock = 1100;
  await registry.expireIdleSessions();
  assert.equal(registry.size, 0);
});

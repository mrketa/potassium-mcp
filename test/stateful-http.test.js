import test from "node:test";
import assert from "node:assert/strict";
import { MCP_SESSION_HEADER, StatefulHttpSessionRegistry, createStatefulHttpRequestHandler } from "../src/stateful-http.js";
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

test("creates isolated paired server and transport sessions and routes session POSTs", async () => {
  const { registry, servers, transports } = harness();
  await registry.handleRequest(request("POST"), response());
  await registry.handleRequest(request("POST"), response());
  await registry.handleRequest(request("POST", "session-1", { request: 3 }), response());

  assert.equal(registry.size, 2);
  assert.equal(servers[0].sessionId, "session-1");
  assert.equal(servers[1].sessionId, "session-2");
  assert.equal(servers[0].connected, transports[0]);
  assert.equal(servers[1].connected, transports[1]);
  assert.equal(transports[0].transportOptions.sessionIdGenerator(), "session-1");
  assert.deepEqual(transports[0].requests.map(({ body }) => body), [initializeBody, { request: 3 }]);
  assert.equal(transports[1].requests.length, 1);
});

test("routes session GET requests to the existing transport for SSE", async () => {
  const { registry, transports } = harness();
  await registry.handleRequest(request("POST"), response());
  const sse = response();
  await registry.handleRequest(request("GET", "session-1", undefined), sse, undefined);

  assert.equal(transports[0].requests[1].incoming.method, "GET");
  assert.equal(transports[0].requests[1].body, undefined);
});

test("DELETE dispatches then cleans up a session and closing is idempotent", async () => {
  const { registry, servers, transports } = harness();
  await registry.handleRequest(request("POST"), response());
  await registry.handleRequest(request("DELETE", "session-1", undefined), response(), undefined);

  assert.equal(transports[0].requests.at(-1).incoming.method, "DELETE");
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
    assert.equal(result.payload.error.message, "MCP session not found");
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

test("request handler exposes its registry and forwards middleware failures", async () => {
  const { registry } = harness();
  const handler = createStatefulHttpRequestHandler(registry);
  const result = response();
  await handler(request("POST"), result);

  assert.equal(handler.registry, registry);
  assert.equal(registry.size, 1);
  await handler.close();
  assert.equal(registry.size, 0);
});

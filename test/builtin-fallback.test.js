import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_FALLBACK_MAX_RESPONSE_BYTES,
  BUILTIN_FALLBACK_URL,
  BuiltinFallbackClient,
  createBuiltinFallbackClient,
  validateBuiltinFallbackUrl,
} from "../src/builtin-fallback.js";

const token = "t".repeat(32);

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rpc(id, result) {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function clientWith(fetch, options = {}) {
  return createBuiltinFallbackClient({
    tokenFile: "separate-fallback-token",
    readToken: async () => `${token}\n`,
    fetch,
    ...options,
  });
}

function diagnosticFetch({ callResult = { content: [{ type: "text", text: "ok" }], structuredContent: { connected: true } }, sse = false } = {}) {
  const requests = [];
  return {
    requests,
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push({ request, init });
      let result;
      if (request.method === "initialize") result = { protocolVersion: "2025-06-18" };
      else if (request.method === "tools/list") {
        result = { tools: [
          { name: "list_clients" },
          { name: "read_console" },
          { name: "execute_script" },
        ] };
      } else if (request.method === "tools/call") result = callResult;
      else throw new Error(`unexpected method ${request.method}`);
      if (!sse) return rpc(request.id, result);
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  };
}

test("builtin fallback uses the built-in direct diagnostic surface and never exposes execute_script", async () => {
  const transport = diagnosticFetch();
  const client = clientWith(transport.fetch);
  const expected = { content: [{ type: "text", text: "ok" }], structuredContent: { connected: true } };
  assert.deepEqual(await client.status(), { reachable: true, tools: [{ name: "list_clients" }, { name: "read_console" }] });
  assert.deepEqual(await client.listClients(), expected);
  assert.deepEqual(await client.readConsole("1234", { afterCursor: 7, limit: 2, waitMs: 100 }), expected);

  assert.equal(Object.getOwnPropertyNames(BuiltinFallbackClient.prototype).sort().join(","), "constructor,listClients,readConsole,status");
  const toolCalls = transport.requests.filter(({ request }) => request.method === "tools/call");
  assert.deepEqual(toolCalls.map(({ request }) => request.params), [
    { name: "list_clients", arguments: {} },
    { name: "read_console", arguments: { pid: "1234", after_cursor: 7, limit: 2, wait_ms: 100 } },
  ]);
  for (const { request, init } of transport.requests) {
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.match(init.headers.accept, /application\/json/);
    assert.match(init.headers.accept, /text\/event-stream/);
    assert.equal(request.method === "initialize" || request.method === "tools/list" || request.method === "tools/call", true);
    assert.notEqual(request.params?.name, "execute_script");
  }
  assert.equal(JSON.stringify(await client.status()).includes("execute_script"), false);
});

test("builtin fallback safely accepts a bounded SSE response", async () => {
  const transport = diagnosticFetch({ sse: true });
  assert.deepEqual(await clientWith(transport.fetch).listClients(), { content: [{ type: "text", text: "ok" }], structuredContent: { connected: true } });
});

test("builtin fallback validates read_console PID and cursor arguments before dispatch", async () => {
  const client = clientWith(async () => { throw new Error("must not dispatch"); });
  assert.throws(() => client.readConsole("0"), /positive decimal/);
  assert.throws(() => client.readConsole("abc"), /positive decimal/);
  assert.throws(() => client.readConsole("1", { afterCursor: -1 }), /afterCursor/);
  assert.throws(() => client.readConsole("1", { limit: 201 }), /limit/);
  assert.throws(() => client.readConsole("1", { waitMs: 3001 }), /waitMs/);
});

test("builtin fallback rejects non-fixed URLs and malformed authentication inputs before dispatch", async () => {
  assert.equal(validateBuiltinFallbackUrl(), BUILTIN_FALLBACK_URL);
  assert.throws(() => validateBuiltinFallbackUrl("http://localhost:8225/mcp"), /fixed loopback/);
  assert.throws(() => clientWith(async () => { throw new Error("must not dispatch"); }, { url: "http://127.0.0.1:8225/mcp?x=1" }), /fixed loopback/);
  const noToken = createBuiltinFallbackClient({ tokenFile: "separate", readToken: async () => "bad token", fetch: async () => { throw new Error("must not dispatch"); } });
  await assert.rejects(noToken.status(), /valid bearer token/);
});

test("builtin fallback rejects malformed, non-success, and oversized responses without exposing the token", async () => {
  const malformed = clientWith(async () => jsonResponse({ jsonrpc: "2.0", id: 99, result: {} }));
  await assert.rejects(malformed.status(), /invalid JSON-RPC response/);

  const nonSuccess = clientWith(async () => jsonResponse({}, { status: 401 }));
  await assert.rejects(nonSuccess.status(), /non-success status/);

  const oversized = clientWith(async () => new Response("x".repeat(BUILTIN_FALLBACK_MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "application/json" } }));
  await assert.rejects(oversized.status(), /65536-byte limit/);

  const leaked = diagnosticFetch({ callResult: { content: [{ type: "text", text: `token=${token}` }], structuredContent: { token } } });
  const result = await clientWith(leaked.fetch).status();
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("builtin fallback bounds a stalled request at three seconds", async () => {
  let timeout;
  const clock = {
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 3000);
      timeout = callback;
      return 1;
    },
    clearTimeout() {},
  };
  const client = clientWith((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), { clock });
  const pending = client.status();
  await new Promise((resolve) => setImmediate(resolve));
  timeout();
  await assert.rejects(pending, /request timed out/);
});

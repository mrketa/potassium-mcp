import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { Server as HttpServer } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = (name) => process.env.POTASSIUM_MCP_TRANSPORT_SOURCE_ROOT
  ? pathToFileURL(resolve(process.env.POTASSIUM_MCP_TRANSPORT_SOURCE_ROOT, name))
  : new URL(`../src/${name}`, import.meta.url);
const { PotassiumBridge } = await import(source("bridge.js"));
const { StatefulHttpSessionRegistry } = await import(source("stateful-http.js"));
const { runProxy, connect, authenticate } = await import(source("proxy.js"));
const { createBroker, WebSocketMcpTransport } = await import(source("broker.js"));
const token = "transport-audit-token-with-at-least-thirty-two-characters";
const config = {
  host: "127.0.0.1", port: 0, token, requestTimeoutMs: 1000,
  maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 100,
  proxyHost: "127.0.0.1", proxyPort: 0, proxyMaxFrameBytes: 65536,
  proxyHandshakeTimeoutMs: 500, streamableHttpHost: "127.0.0.1", streamableHttpPort: 0,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

class Peer extends EventEmitter {
  readyState = 1;
  frames = [];
  send(frame, callback) { this.frames.push(JSON.parse(frame)); callback?.(); }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code);
  }
  terminate() { this.close(); }
  pause() {}
  resume() {}
  receive(frame) { this.emit("message", Buffer.from(JSON.stringify(frame)), false); }
}

test("transport audit: duplicate active MCP IDs fail closed without a second dispatch", async () => {
  const peer = new Peer();
  const transport = new WebSocketMcpTransport(peer, config.proxyMaxFrameBytes);
  const accepted = [];
  transport.onmessage = (message) => accepted.push(message);
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} };
  peer.receive(request);
  peer.receive(request);
  assert.equal(accepted.length, 1);
  assert.equal(peer.readyState, 3);
});

test("transport audit: accepted MCP response tracking has bounded admission", async () => {
  const peer = new Peer();
  const transport = new WebSocketMcpTransport(peer, config.proxyMaxFrameBytes);
  let accepted = 0;
  transport.onmessage = () => { accepted += 1; };
  for (let id = 0; id <= 256; id += 1) peer.receive({ jsonrpc: "2.0", id, method: "tools/call", params: {} });
  assert.equal(accepted, 256);
  assert.equal(peer.frames.at(-1).id, 256);
  assert.equal(peer.frames.at(-1).error.code, -32000);
  await transport.send({ jsonrpc: "2.0", id: 0, result: {} });
  peer.receive({ jsonrpc: "2.0", id: 257, method: "tools/call", params: {} });
  assert.equal(accepted, 257);
  await transport.close();
});

async function bridgeFixture(t, Bridge = PotassiumBridge) {
  const bridge = new Bridge(config, { error() {} });
  await bridge.start();
  t.after(() => bridge.close());
  const peer = new Peer();
  bridge.server.emit("connection", peer, { headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  const clientNonce = "b".repeat(64);
  peer.receive({ type: "hello", protocol: 2, clientId: "a".repeat(32), generation: 1, clientNonce, client: { protocol: 2 } });
  const challenge = peer.frames.at(-1);
  const transcript = `potassium-mcp/v2|client|${clientNonce}|${challenge.serverNonce}`;
  const hash = createHash("sha256").update(transcript, "utf8").digest("hex");
  const proof = createHmac("sha256", token).update(hash, "utf8").digest("base64");
  peer.receive({ type: "ack", protocol: 2, clientNonce, serverNonce: challenge.serverNonce, proof });
  assert.equal(peer.frames.at(-1).type, "ready");
  peer.frames.length = 0;
  return { bridge, peer };
}

export async function measureRejectedExecutorRetention(Bridge = PotassiumBridge, rounds = 32) {
  const bridge = new Bridge(config, { error() {} });
  await bridge.start();
  const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  try {
    for (let index = 0; index < 64; index += 1) bridge.server.emit("connection", new Peer(), request);
    for (let index = 0; index < rounds; index += 1) bridge.server.emit("connection", new Peer(), request);
    return { rounds, retainedRejectedSockets: bridge.closeReasons.size };
  } finally {
    await bridge.close();
  }
}

test("transport audit: recovery waits for every in-flight read before admitting a mutation", async (t) => {
  const { bridge, peer } = await bridgeFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = bridge.request("client_state", {}, 10);
  const second = bridge.request("read_properties", {}, 100);
  const queued = bridge.request("execute_luau_async", { code: "return 1" }, 100);
  const rejected = Promise.allSettled([first, second, queued]);
  const [firstFrame, secondFrame] = peer.frames;
  t.mock.timers.tick(10);
  const outcomes = await rejected;
  assert.deepEqual(outcomes.map(({ status }) => status), ["rejected", "rejected", "rejected"]);
  assert.deepEqual(outcomes.map(({ reason }) => reason.submissionIndeterminate), [true, true, false]);
  peer.receive({ type: "response", id: firstFrame.id, ok: true, result: null });
  assert.equal(bridge.status().recovering, true);
  await assert.rejects(bridge.request("execute_luau_async", { code: "return 2" }), /recovering/);
  peer.receive({ type: "response", id: secondFrame.id, ok: true, result: null });
  assert.equal(bridge.status().recovering, false);
  const resumed = bridge.request("execute_luau_async", { code: "return 3" });
  peer.receive({ type: "response", id: peer.frames.at(-1).id, ok: true, result: { jobId: "c".repeat(32), state: "queued" } });
  assert.deepEqual(await resumed, { jobId: "c".repeat(32), state: "queued" });
});

test("transport audit: pre-dispatch cancellation and queue deadlines never reach the executor", async (t) => {
  const { bridge, peer } = await bridgeFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(bridge.request("execute_luau", {}, 1000, undefined, alreadyAborted.signal), { submissionIndeterminate: false });
  assert.equal(peer.frames.length, 0);

  const active = bridge.request("execute_luau", {}, 1000);
  const cancelled = new AbortController();
  const queuedCancel = bridge.request("client_state", {}, 1000, undefined, cancelled.signal);
  const cancelResult = assert.rejects(queuedCancel, { submissionIndeterminate: false });
  cancelled.abort();
  await cancelResult;
  const queuedDeadline = bridge.request("read_properties", {}, 10);
  const deadlineResult = assert.rejects(queuedDeadline, { submissionIndeterminate: false });
  t.mock.timers.tick(10);
  await deadlineResult;
  assert.equal(bridge.status().recovering, false);
  assert.equal(bridge.status().pendingRequests, 1);
  assert.deepEqual(peer.frames.map(({ method }) => method), ["execute_luau"]);
  peer.receive({ type: "response", id: peer.frames[0].id, ok: true, result: "completed" });
  assert.equal(await active, "completed");
  const next = bridge.request("client_state");
  assert.deepEqual(peer.frames.map(({ method }) => method), ["execute_luau", "client_state"]);
  peer.receive({ type: "response", id: peer.frames[1].id, ok: true, result: "fresh" });
  assert.equal(await next, "fresh");
});

test("transport audit: sent cancellation and drain retain every uncertain request until its own response", async (t) => {
  const { bridge, peer } = await bridgeFixture(t);
  const abort = new AbortController();
  const first = bridge.request("client_state", {}, 1000, undefined, abort.signal);
  const second = bridge.request("read_properties");
  const queued = bridge.request("execute_luau");
  const outcomes = Promise.allSettled([first, second, queued]);
  assert.deepEqual(bridge.status().activeRequests.map(({ method }) => method), ["client_state", "read_properties"]);
  abort.abort();
  assert.deepEqual((await outcomes).map(({ reason }) => reason.submissionIndeterminate), [true, true, false]);
  let drained = false;
  const drain = bridge.drain().then(() => { drained = true; });
  await assert.rejects(bridge.request("execute_luau"), { submissionIndeterminate: false });
  peer.receive({ type: "response", id: peer.frames[1].id, ok: true, result: null });
  peer.receive({ type: "response", id: peer.frames[1].id, ok: true, result: null });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.deepEqual(bridge.status().activeRequests.map(({ method }) => method), ["client_state"]);
  assert.equal(bridge.status().recovering, true);
  peer.receive({ type: "response", id: peer.frames[0].id, ok: true, result: null });
  await drain;
  assert.equal(bridge.status().active, null);
  assert.equal(bridge.status().recovering, false);
  assert.equal(peer.frames.some(({ method }) => method === "execute_luau"), false);
});

test("transport audit: duplicate or premature responses cannot release a mutation barrier", async (t) => {
  const { bridge, peer } = await bridgeFixture(t);
  const active = bridge.request("execute_luau");
  const queued = bridge.request("client_state");
  const activeId = peer.frames[0].id;
  const queuedId = String(Number(activeId) + 1);
  peer.receive({ type: "response", id: queuedId, ok: true, result: "premature" });
  assert.deepEqual(peer.frames.map(({ method }) => method), ["execute_luau"]);
  peer.receive({ type: "response", id: activeId, ok: true, result: "active" });
  assert.equal(await active, "active");
  peer.receive({ type: "response", id: activeId, ok: true, result: "duplicate" });
  assert.equal(bridge.status().activeMethod, "client_state");
  peer.receive({ type: "response", id: queuedId, ok: true, result: "queued" });
  assert.equal(await queued, "queued");
});

test("transport audit: drain rejects new admission but waits for accepted queued RPCs", async (t) => {
  const { bridge, peer } = await bridgeFixture(t);
  const active = bridge.request("execute_luau");
  const queued = bridge.request("client_state");
  const drain = bridge.drain();
  await assert.rejects(bridge.request("read_properties"), { submissionIndeterminate: false });
  peer.receive({ type: "response", id: peer.frames[0].id, ok: true, result: "first" });
  assert.equal(await active, "first");
  assert.equal(peer.frames[1].method, "client_state");
  peer.receive({ type: "response", id: peer.frames[1].id, ok: true, result: "second" });
  assert.equal(await queued, "second");
  await drain;
  assert.equal(bridge.status().pendingRequests, 0);
});

test("transport audit: capability preflight shares the bounded control lane during raw execution", async (t) => {
  const { bridge, peer } = await bridgeFixture(t);
  const active = bridge.request("execute_luau");
  const preflight = bridge.request("capabilities");
  assert.deepEqual(peer.frames.map(({ method }) => method), ["execute_luau", "capabilities"]);
  peer.receive({ type: "response", id: peer.frames[1].id, ok: true, result: { asyncJobs: { version: 2 } } });
  assert.deepEqual(await preflight, { asyncJobs: { version: 2 } });
  const control = bridge.request("async_job_cancel", { jobId: "d".repeat(32) });
  assert.equal(peer.frames.at(-1).method, "async_job_cancel");
  peer.receive({ type: "response", id: peer.frames.at(-1).id, ok: true, result: { cancellationRequested: true } });
  assert.deepEqual(await control, { cancellationRequested: true });
  assert.equal(bridge.status().activeMethod, "execute_luau");
  peer.receive({ type: "response", id: peer.frames[0].id, ok: true, result: "complete" });
  assert.equal(await active, "complete");
});

test("transport audit: start during initial shutdown reopens a usable listener", async (t) => {
  const bridge = new PotassiumBridge(config, { error() {} });
  t.after(() => bridge.close());
  const starting = bridge.start();
  const closing = bridge.close();
  const restarted = bridge.start();
  await Promise.all([starting, closing, restarted]);
  const socket = await connect(bridge.status().endpoint, config.maxMessageBytes, 500);
  socket.terminate();
});

test("transport audit: rejected executor connections release retained socket metadata", async () => {
  const result = await measureRejectedExecutorRetention();
  assert.equal(result.retainedRejectedSockets, 0);
});

const initializeBody = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "transport-audit", version: "1" } },
};
function response() {
  return {
    statusCode: 200, headersSent: false, writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; this.writableEnded = true; return this; },
  };
}
function request(method = "POST", sessionId, body = initializeBody) {
  return { method, body, headers: sessionId ? { "mcp-session-id": sessionId } : {} };
}
function httpFixture(handleRequest, maxSessions = 1) {
  let nextId = 0;
  return new StatefulHttpSessionRegistry({
    maxSessions,
    idGenerator: () => `audit-session-${++nextId}`,
    serverFactory: () => ({ async connect() {}, async close() {} }),
    transportFactory: () => ({ handleRequest, async close() { this.onclose?.(); } }),
  });
}

async function httpBrokerFixture(t) {
  const broker = await createBroker({ ...config, statefulHttpEnabled: true });
  t.after(() => broker.close());
  return (method, body, headers = {}) => fetch(broker.streamableHttp.statefulEndpoint, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("transport audit: failed HTTP initialization does not consume session capacity", async (t) => {
  const call = await httpBrokerFixture(t);
  for (let index = 0; index < 32; index += 1) {
    const rejected = await call("POST", initializeBody, { accept: "application/json" });
    await rejected.text();
    assert.equal(rejected.status, 406);
  }
  const accepted = await call("POST", initializeBody);
  await accepted.text();
  assert.equal(accepted.status, 200);
  assert.ok(accepted.headers.get("mcp-session-id"));
});

test("transport audit: in-progress HTTP initialization counts against capacity only once", async (t) => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const registry = httpFixture(async () => {
    calls += 1;
    if (calls === 1) { entered.resolve(); await release.promise; }
  }, 2);
  t.after(() => registry.closeAll());
  const first = registry.handleRequest(request(), response());
  await entered.promise;
  try {
    const second = response();
    await registry.handleRequest(request(), second);
    assert.equal(second.statusCode, 200);
    const third = response();
    await registry.handleRequest(request(), third);
    assert.equal(third.statusCode, 429);
  } finally {
    release.resolve();
    await first;
  }
});

test("transport audit: rejected HTTP DELETE preserves the session for a corrected request", async (t) => {
  const call = await httpBrokerFixture(t);
  const initialized = await call("POST", initializeBody);
  await initialized.text();
  assert.equal(initialized.status, 200);
  const headers = { "mcp-session-id": initialized.headers.get("mcp-session-id") };
  const rejected = await call("DELETE", undefined, { ...headers, "mcp-protocol-version": "1900-01-01" });
  await rejected.text();
  assert.equal(rejected.status, 400);
  const continued = await call("POST", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
  const payload = await continued.text();
  assert.equal(continued.status, 200);
  const message = JSON.parse(payload.split(/\r?\n/).find((line) => line.startsWith("data:")).slice(5));
  assert.equal(message.result.tools.some(({ name }) => name === "potassium_status"), true);
});

async function proxyFixture(t, stdout = new PassThrough()) {
  const peer = new Peer();
  const stdin = new PassThrough();
  const running = runProxy({
    config, hostId: "omp", stdin, stdout, logError() {},
    connectOrStart: async () => peer,
    authenticate: async () => {},
  });
  await new Promise((done) => setImmediate(done));
  t.after(async () => { peer.close(); await running; stdin.destroy(); stdout.destroy(); });
  return { peer, stdin, stdout, running };
}

export async function measureProxyBackpressure(Proxy = runProxy, rounds = 32) {
  const peer = new Peer();
  peer.send = (frame, callback) => { peer.frames.push({ message: JSON.parse(frame), callback }); };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = Proxy({ config, hostId: "omp", stdin, stdout, logError() {}, connectOrStart: async () => peer, authenticate: async () => {} });
  await new Promise((done) => setImmediate(done));
  try {
    for (let index = 0; index < rounds; index += 1) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list" })}\n`);
    const pendingBeforeDrain = peer.frames.length;
    const delivered = [];
    for (let index = 0; index < rounds; index += 1) {
      const frame = peer.frames[index];
      if (!frame) throw new Error(`Frame ${index} was not delivered after drain`);
      delivered.push(frame.message.id);
      frame.callback?.();
      await new Promise((done) => setImmediate(done));
    }
    return { rounds, pendingBeforeDrain, delivered };
  } finally {
    peer.close();
    await running;
    stdin.destroy();
    stdout.destroy();
  }
}

test("transport audit: proxy applies upstream backpressure without dropping or reordering frames", async () => {
  const measured = await measureProxyBackpressure();
  assert.equal(measured.pendingBeforeDrain, 1);
  assert.deepEqual(measured.delivered, Array.from({ length: measured.rounds }, (_, index) => index));
});

test("transport audit: buffered broker frames use one drain continuation", async (t) => {
  const output = [];
  const callbacks = [];
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) { output.push(chunk.toString("utf8")); callbacks.push(callback); },
  });
  const { peer } = await proxyFixture(t, stdout);
  let resumes = 0;
  peer.resume = () => { resumes += 1; };
  for (let id = 1; id <= 3; id += 1) peer.receive({ jsonrpc: "2.0", id, result: {} });
  const drained = once(stdout, "drain");
  while (callbacks.length) callbacks.shift()();
  await drained;
  assert.deepEqual(output.map((frame) => JSON.parse(frame).id), [1, 2, 3]);
  assert.equal(resumes, 1);
});

test("transport audit: proxy exits when authentication completes after the broker has closed", { timeout: 1000 }, async () => {
  const peer = new Peer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  try {
    await runProxy({ config, hostId: "omp", stdin, stdout, connectOrStart: async () => peer, authenticate: async () => peer.close() });
  } finally {
    stdin.destroy();
    stdout.destroy();
  }
});

test("transport audit: proxy authentication is ready while the HTTP listener is starting", { timeout: 3000 }, async (t) => {
  const originalListen = HttpServer.prototype.listen;
  const held = deferred();
  const ports = [];
  let calls = 0;
  let releaseHttp;
  t.mock.method(HttpServer.prototype, "listen", function (...args) {
    calls += 1;
    if (calls === 3) {
      releaseHttp = () => originalListen.apply(this, args);
      held.resolve();
      return this;
    }
    this.once("listening", () => ports.push(this.address().port));
    return originalListen.apply(this, args);
  });
  const starting = createBroker({ ...config, statefulHttpEnabled: true });
  await held.promise;
  let socket;
  try {
    socket = await connect(`ws://127.0.0.1:${ports[1]}`, config.proxyMaxFrameBytes, 500);
    await authenticate(socket, config, "omp");
  } finally {
    socket?.terminate();
    releaseHttp();
    const broker = await starting;
    await broker.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { brokerStatus, createBroker, proxyProof, restartBroker, stopBroker } from "../src/broker.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { human } from "../bin/potassium-mcp.js";

const token = "test-token-that-is-longer-than-thirty-two-characters";
const config = () => ({ host: "127.0.0.1", port: 0, token, requestTimeoutMs: 100, maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 1000, proxyPort: 0, proxyMaxFrameBytes: 65536, proxyHandshakeTimeoutMs: 1000, streamableHttpEnabled: false, streamableHttpHost: "127.0.0.1", streamableHttpPort: 0 });

async function session(port, hostId = "omp") {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "proxy-hello", protocol: 1, clientNonce, hostId }));
  const [challengeFrame] = await once(socket, "message");
  const challenge = JSON.parse(challengeFrame.toString());
  assert.equal(challenge.proof, proxyProof(token, "server", clientNonce, challenge.serverNonce, hostId));
  socket.send(JSON.stringify({ type: "proxy-ack", proof: proxyProof(token, "client", clientNonce, challenge.serverNonce, hostId) }));
  const [readyFrame] = await once(socket, "message");
  assert.equal(JSON.parse(readyFrame.toString()).type, "proxy-ready");
  return socket;
}

function request(socket, id, method, params = {}) {
  const reply = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP reply timeout for ${method} (${id})`)), 1000);
    const handler = (frame) => { const message = JSON.parse(frame.toString()); if (message.id === id) { clearTimeout(timeout); socket.off("message", handler); resolve(message); } };
    socket.on("message", handler);
  });
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return reply;
}

async function initialize(socket, id) {
  const response = await request(socket, id, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(response.result.serverInfo.name, "potassium-mcp");
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
}

async function httpRequest(endpoint, method, body, headers = {}) {
  return fetch(endpoint, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", accept: "application/json, text/event-stream" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function httpConfig(overrides = {}) {
  return { ...config(), streamableHttpEnabled: true, streamableHttpPort: 0, ...overrides };
}

async function requestWithHost(endpoint, host) {
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, {
      method: "POST",
      headers: {
        host,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  });
}

async function mcpJson(response) {
  const payload = await response.text();
  const data = payload.split(/\r?\n/).find((line) => line.startsWith("data:"));
  return JSON.parse(data ? data.slice(5).trim() : payload);
}

test("broker shares one bridge across isolated authenticated MCP sessions", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  assert.equal(broker.bridge.status().endpoint.includes("://127.0.0.1:"), true);
  const port = broker.listener.address().port;
  const [first, second] = await Promise.all([session(port), session(port)]);
  t.after(() => { first.close(); second.close(); });
  await Promise.all([initialize(first, 1), initialize(second, 2)]);
  const firstTools = await request(first, 3, "tools/list");
  assert.equal(firstTools.result.tools.some(({ name }) => name === "potassium_status"), true);
  first.close();
  await once(first, "close");
  const secondTools = await request(second, 4, "tools/list");
  assert.equal(secondTools.result.tools.some(({ name }) => name === "potassium_status"), true);
});
test("broker enforces independent per-host execute policies", async (t) => {
  const broker = await createBroker({
    ...config(),
    allowUnsafeExecute: true,
    hostPolicies: {
      omp: { read: true, admin: true, execute: true },
      codex: { read: true, admin: false, execute: false },
    },
  });
  t.after(() => broker.close());
  const port = broker.listener.address().port;
  const [trusted, readOnly] = await Promise.all([session(port, "omp"), session(port, "codex")]);
  t.after(() => { trusted.close(); readOnly.close(); });
  await Promise.all([initialize(trusted, 20), initialize(readOnly, 21)]);
  const trustedTools = (await request(trusted, 22, "tools/list")).result.tools.map(({ name }) => name);
  const readOnlyTools = (await request(readOnly, 23, "tools/list")).result.tools.map(({ name }) => name);
  assert.equal(trustedTools.includes("potassium_execute_luau_async"), true);
  assert.equal(readOnlyTools.includes("potassium_execute_luau_async"), false);
  assert.equal(readOnlyTools.includes("potassium_admin_recover"), false);
  assert.equal(readOnlyTools.includes("potassium_status"), true);
});


test("broker rejects invalid proof and oversized proxy frames", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  const port = broker.listener.address().port;
  const bad = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(bad, "open");
  bad.send(JSON.stringify({ type: "proxy-hello", protocol: 1, clientNonce: randomBytes(32).toString("hex"), hostId: "omp" }));
  await once(bad, "message");
  bad.send(JSON.stringify({ type: "proxy-ack", proof: "invalid" }));
  const [badCode] = await once(bad, "close");
  assert.equal(badCode, 1008);
  const oversized = new WebSocket(`ws://127.0.0.1:${port}`);
  oversized.once("error", () => {});
  await once(oversized, "open");
  oversized.send("x".repeat(70000));
  const [largeCode] = await once(oversized, "close");
  assert.equal(largeCode, 1009);
});

test("broker leaves Streamable HTTP disabled by default", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  assert.equal(broker.httpListener, undefined);
  assert.equal(broker.streamableHttp, undefined);
});

test("broker serves authenticated stateless Streamable HTTP alongside the proxy", async (t) => {
  const broker = await createBroker(httpConfig());
  t.after(() => broker.close());
  assert.equal(broker.streamableHttp.endpoint.includes(token), false);
  const endpoint = broker.streamableHttp.endpoint;

  const missing = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), "Bearer");
  const wrong = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer wrong" });
  assert.equal(wrong.status, 401);
  const origin = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: `Bearer ${token}`, origin: "https://example.com" });
  assert.equal(origin.status, 403);
  const normalizedBypass = await httpRequest(`${endpoint}/`, "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: `Bearer ${token}` });
  assert.equal(normalizedBypass.status, 404);
  assert.equal(await requestWithHost(endpoint, "example.com"), 403);
  const method = await httpRequest(endpoint, "GET");
  assert.equal(method.status, 401);
  assert.equal((await mcpJson(method)).jsonrpc, "2.0");
  const authenticatedMethod = await httpRequest(endpoint, "GET", undefined, { authorization: `Bearer ${token}` });
  assert.equal(authenticatedMethod.status, 405);
  assert.equal((await mcpJson(authenticatedMethod)).error.message, "Method not allowed");
  const malformed = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await mcpJson(malformed)).error.code, -32700);
  const oversized = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ value: "x".repeat(110000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await mcpJson(oversized)).error.message, "Request body too large");
  const initialized = await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }, { authorization: `Bearer ${token}` });
  assert.equal((await mcpJson(initialized)).result.serverInfo.name, "potassium-mcp");
  const tools = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, { authorization: `Bearer ${token}` });
  const toolNames = (await mcpJson(tools)).result.tools.map(({ name }) => name);
  assert.equal(toolNames.includes("potassium_status"), true);
  assert.equal(toolNames.includes("potassium_execute_luau"), false);

  const socket = await session(broker.listener.address().port);
  t.after(() => socket.close());
  await initialize(socket, 4);
  assert.equal((await request(socket, 5, "tools/list")).result.tools.some(({ name }) => name === "potassium_status"), true);
});
test("broker serves bounded authenticated stateful HTTP sessions independently of stateless HTTP", async (t) => {
  const broker = await createBroker({
    ...httpConfig(),
    streamableHttpEnabled: false,
    statefulHttpEnabled: true,
  });
  t.after(() => broker.close());
  const stateless = broker.streamableHttp.endpoint;
  const endpoint = stateless.replace(/\/mcp$/, "/mcp/session");
  const disabled = await httpRequest(stateless, "POST", { jsonrpc: "2.0", id: 30, method: "initialize", params: {} }, { authorization: `Bearer ${token}` });
  assert.equal(disabled.status, 404);
  const initialized = await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0",
    id: 31,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stateful-test", version: "1" } },
  }, { authorization: `Bearer ${token}` });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.match(sessionId, /^[a-f0-9-]{16,}$/i);
  const tools = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 32, method: "tools/list", params: {} }, {
    authorization: `Bearer ${token}`,
    "mcp-session-id": sessionId,
  });
  assert.equal((await mcpJson(tools)).result.tools.some(({ name }) => name === "potassium_status"), true);
  const deleted = await httpRequest(endpoint, "DELETE", undefined, {
    authorization: `Bearer ${token}`,
    "mcp-session-id": sessionId,
  });
  assert.equal(deleted.status, 200);
});

test("broker closes Streamable HTTP and rolls back a failed HTTP bind", async (t) => {
  const broker = await createBroker(httpConfig());
  const endpoint = broker.streamableHttp.endpoint;
  await broker.close();
  await assert.rejects(fetch(endpoint));

  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => reservation.close(resolve)));
  const port = reservation.address().port;
  await assert.rejects(createBroker(httpConfig({ streamableHttpPort: port })));
});

async function lifecycleFixture(t, active = null) {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "potassium-broker-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const brokerPath = path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp", "src", "broker.js");
  const configPath = path.join(installRoot, "config.json");
  await mkdir(path.dirname(brokerPath), { recursive: true });
  await Promise.all([writeFile(brokerPath, ""), writeFile(configPath, "{}")]);
  await writeFile(path.join(installRoot, "broker-state.json"), `${JSON.stringify({
    schema: 1,
    instanceId: "a".repeat(32),
    pid: process.pid,
    nodeExecutable: process.execPath,
    brokerPath,
    configPath,
    configDigest: "b".repeat(64),
    version: "test",
    proxyHost: "127.0.0.1",
    proxyPort: 32146,
    readiness: "ready",
    active,
  })}\n`);
  return {
    installRoot,
    commandLineForPid: () => `${process.execPath} ${brokerPath} --config ${configPath}`,
    probeReadiness: async () => true,
  };
}

test("broker lifecycle distinguishes absent, running, and stale state without exposing configuration", async (t) => {
  const fixture = await lifecycleFixture(t);
  const running = await brokerStatus(fixture);
  assert.deepEqual(
    { status: running.status, pid: running.pid, readiness: running.readiness, configDigest: running.configDigest },
    { status: "running", pid: process.pid, readiness: "ready", configDigest: "b".repeat(64) },
  );
  await writeFile(path.join(fixture.installRoot, "broker-state.json"), `${JSON.stringify({
    schema: 1, instanceId: "a".repeat(32), pid: 99999999, nodeExecutable: process.execPath,
    brokerPath: path.join(fixture.installRoot, "app", "node_modules", "@mrketa", "potassium-mcp", "src", "broker.js"),
    configPath: path.join(fixture.installRoot, "config.json"), configDigest: "b".repeat(64),
  })}\n`);
  assert.equal((await brokerStatus(fixture)).status, "stale");
  await assert.rejects(restartBroker(fixture), /state is stale/);
  await rm(path.join(fixture.installRoot, "broker-state.json"));
  assert.equal((await brokerStatus(fixture)).status, "absent");
});

test("broker restart refuses an active request when its documented wait is exhausted", async (t) => {
  const fixture = await lifecycleFixture(t, { method: "potassium_execute_luau", startedAt: "2026-01-01T00:00:00.000Z" });
  await assert.rejects(
    restartBroker({ ...fixture, waitMs: 0 }),
    /while a broker request is active/,
  );
});

test("broker stop refuses active and stale brokers without signaling either", async (t) => {
  const activeFixture = await lifecycleFixture(t, { method: "potassium_execute_luau", startedAt: "2026-01-01T00:00:00.000Z" });
  await assert.rejects(stopBroker({ ...activeFixture, waitMs: 0 }), /while a broker request is active/);

  const staleFixture = await lifecycleFixture(t);
  const brokerPath = path.join(staleFixture.installRoot, "app", "node_modules", "@mrketa", "potassium-mcp", "src", "broker.js");
  const configPath = path.join(staleFixture.installRoot, "config.json");
  await writeFile(path.join(staleFixture.installRoot, "broker-state.json"), JSON.stringify({
    schema: 1, instanceId: "a".repeat(32), pid: 99999999, nodeExecutable: process.execPath,
    brokerPath, configPath, configDigest: "b".repeat(64),
  }));
  await assert.rejects(stopBroker(staleFixture), /state is stale/);
});

test("broker restart relaunches the installed broker with its recorded configuration", async (t) => {
  const fixture = await lifecycleFixture(t);
  const calls = [];
  let running = true;
  const result = await restartBroker({
    ...fixture,
    waitMs: 1000,
    processMatches: () => running,
    signalProcess: () => { running = false; },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });
  assert.equal(result.status, "running");
  assert.deepEqual(calls[0].args, [
    path.join(fixture.installRoot, "app", "node_modules", "@mrketa", "potassium-mcp", "src", "broker.js"),
    "--config",
    path.join(fixture.installRoot, "config.json"),
  ]);
  assert.equal(calls[0].options.detached, true);
});

test("broker human output identifies status without serializing state internals", () => {
  assert.equal(
    human({ status: "running", pid: 42, version: "1.2.3", configDigest: "c".repeat(64), readiness: "ready", active: null }, "broker"),
    `Broker running: PID 42; version 1.2.3; config ${"c".repeat(64)}; readiness ready`,
  );
});

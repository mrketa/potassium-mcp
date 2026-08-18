import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { brokerStatus, createBroker, httpBearer, proxyProof, restartBroker } from "../src/broker.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { human } from "../bin/potassium-mcp.js";

const token = "test-token-that-is-longer-than-thirty-two-characters";
const config = () => ({ host: "127.0.0.1", port: 0, token, requestTimeoutMs: 100, maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 1000, proxyPort: 0, proxyMaxFrameBytes: 65536, proxyHandshakeTimeoutMs: 1000 });

async function session(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "proxy-hello", protocol: 1, clientNonce }));
  const [challengeFrame] = await once(socket, "message");
  const challenge = JSON.parse(challengeFrame.toString());
  assert.equal(challenge.proof, proxyProof(token, "server", clientNonce, challenge.serverNonce));
  socket.send(JSON.stringify({ type: "proxy-ack", proof: proxyProof(token, "client", clientNonce, challenge.serverNonce) }));
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

test("broker shares one bridge across isolated authenticated MCP sessions", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  assert.equal(broker.bridge.status().endpoint.includes("://127.0.0.1:"), true);
  assert.deepEqual(broker.httpStatus(), { enabled: false, host: null, port: null, sessions: 0 });
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

test("broker's opt-in Streamable HTTP transport authenticates and bounds isolated MCP sessions without leaking its master token", async (t) => {
  const broker = await createBroker({ ...config(), httpEnabled: true, httpPort: 0, httpMaxBodyBytes: 16384, httpMaxSessions: 1, httpAllowedOrigins: ["https://desktop.example"] });
  t.after(() => broker.close());
  const port = broker.httpListener.address().port;
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const post = (body, headers = {}) => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const unauthorized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.text()).includes(token), false);
  const invalidOrigin = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, {
    Authorization: `Bearer ${httpBearer(token)}`, Origin: "https://untrusted.example",
  });
  assert.equal(invalidOrigin.status, 403);
  const initialized = await post({
    jsonrpc: "2.0", id: 3, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-test", version: "1" } },
  }, { Authorization: `Bearer ${httpBearer(token)}`, Origin: "https://desktop.example" });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, "potassium-mcp");
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.match(sessionId, /^[a-f0-9]{32}$/);
  const tools = await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, {
    Authorization: `Bearer ${httpBearer(token)}`, "Mcp-Session-Id": sessionId,
  });
  assert.equal((await tools.json()).result.tools.some(({ name }) => name === "potassium_status"), true);
  assert.equal(broker.httpStatus().sessions, 1);
  const oversized = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${httpBearer(token)}`, "Content-Type": "application/json", "Content-Length": "20000" },
    body: "x".repeat(20000),
  });
  assert.equal(oversized.status, 413);
  const closed = await fetch(endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${httpBearer(token)}`, "Mcp-Session-Id": sessionId } });
  assert.equal(closed.status, 200);
  assert.equal(broker.httpStatus().sessions, 0);
});

test("broker rejects invalid proof and oversized proxy frames", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  const port = broker.listener.address().port;
  const bad = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(bad, "open");
  bad.send(JSON.stringify({ type: "proxy-hello", protocol: 1, clientNonce: randomBytes(32).toString("hex") }));
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

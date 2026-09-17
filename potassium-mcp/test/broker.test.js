import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { brokerStatus, createBroker, proxyProof, resolveBrokerLaunch, restartBroker, stopBroker } from "../src/broker.js";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { AdminAuditRecorder } from "../src/admin-audit.js";
import { createGameContextService } from "../src/game-context.js";
import { listAllTools } from "./helpers/list-tools.js";

const token = "test-token-that-is-longer-than-thirty-two-characters";
const config = () => ({ host: "127.0.0.1", port: 0, token, requestTimeoutMs: 100, maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 1000, proxyPort: 0, proxyMaxFrameBytes: 65536, proxyHandshakeTimeoutMs: 1000, streamableHttpEnabled: false, streamableHttpHost: "127.0.0.1", streamableHttpPort: 0 });

async function session(port, hostId = "omp", socketOptions) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, socketOptions);
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

async function executorSession(t, broker) {
  const socket = new WebSocket(broker.bridge.status().endpoint);
  t.after(() => socket.terminate());
  await once(socket, "open");
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "hello", protocol: 2, clientId: "c".repeat(32), generation: 1, clientNonce, client: { protocol: 2 } }));
  const [raw] = await once(socket, "message");
  const challenge = JSON.parse(raw.toString());
  const transcript = `potassium-mcp/v2|client|${clientNonce}|${challenge.serverNonce}`;
  const hash = createHash("sha256").update(transcript).digest("hex");
  const proof = createHmac("sha256", token).update(hash).digest("base64");
  socket.send(JSON.stringify({ type: "ack", protocol: 2, clientNonce, serverNonce: challenge.serverNonce, proof }));
  const [ready] = await once(socket, "message");
  assert.equal(JSON.parse(ready.toString()).type, "ready");
  return socket;
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

async function listSocketTools(socket, id) {
  return listAllTools(async (cursor) => (await request(socket, id, "tools/list", cursor === undefined ? {} : { cursor })).result);
}

async function listHttpTools(endpoint, headers, id = 3) {
  return listAllTools(async (cursor) => (await mcpJson(await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id, method: "tools/list", params: cursor === undefined ? {} : { cursor },
  }, headers))).result);
}

test("broker shares one bridge across isolated authenticated MCP sessions", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  assert.equal(broker.bridge.status().endpoint.includes("://127.0.0.1:"), true);
  const port = broker.listener.address().port;
  const [first, second] = await Promise.all([session(port), session(port)]);
  t.after(() => { first.close(); second.close(); });
  await Promise.all([initialize(first, 1), initialize(second, 2)]);
  const firstTools = await listSocketTools(first, 3);
  assert.equal(firstTools.tools.some(({ name }) => name === "potassium_status"), true);
  first.close();
  await once(first, "close");
  const secondTools = await listSocketTools(second, 4);
  assert.equal(secondTools.tools.some(({ name }) => name === "potassium_status"), true);
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
  const trustedTools = (await listSocketTools(trusted, 22)).tools.map(({ name }) => name);
  const readOnlyTools = (await listSocketTools(readOnly, 23)).tools.map(({ name }) => name);
  assert.equal(trustedTools.includes("potassium_execute_luau_async"), true);
  assert.equal(readOnlyTools.includes("potassium_execute_luau_async"), false);
  assert.equal(readOnlyTools.includes("potassium_admin_recover"), false);
  assert.equal(readOnlyTools.includes("potassium_status"), true);
});

test("native editor is shared across authorized agents and HTTP transports without blocking execution", async (t) => {
  const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  const tabs = new Map();
  let nextId = 0, editorUnavailable = false, finishWrite, signalWrite;
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  const writeGate = new Promise((resolve) => { finishWrite = resolve; });
  t.after(() => finishWrite());
  const nativeEditor = {
    async listTabs() {
      if (editorUnavailable) throw new Error("private native response must not escape");
      return { tabs: [...tabs.values()].map(({ tab }) => ({ ...tab })) };
    },
    async readTab({ id }) {
      const entry = tabs.get(id);
      return { tab: { ...entry.tab }, content: entry.content, sha256: digest(entry.content) };
    },
    async openTab({ title = "", content = "" }) {
      for (const entry of tabs.values()) entry.tab.active = false;
      const tab = { id: `desktop-${++nextId}`, title, kind: "script", dirty: content !== "", active: true, pinned: false };
      tabs.set(tab.id, { tab, content });
      return { tab: { ...tab } };
    },
    async writeTab({ id, content, expectedSha256 }) {
      const entry = tabs.get(id);
      assert.equal(expectedSha256, digest(entry.content));
      signalWrite();
      await writeGate;
      entry.content = content;
      entry.tab.dirty = true;
      return { tab: { ...entry.tab }, sha256: digest(content), preconditionAtomic: false };
    },
    async activateTab({ id }) {
      for (const entry of tabs.values()) entry.tab.active = entry.tab.id === id;
      return { tab: { ...tabs.get(id).tab } };
    },
    async closeTab({ id }) {
      assert.equal(tabs.get(id).tab.dirty, false);
      tabs.delete(id);
      return { id, closed: true };
    },
  };
  const grants = { read: true, admin: false, execute: true };
  const broker = await createBroker({
    ...httpConfig(), statefulHttpEnabled: true, allowUnsafeExecute: true,
    nativeEditorEnabled: true, nativeEditorTokenFile: "unused-editor-token",
    hostPolicies: { omp: grants, codex: grants }, httpPolicy: grants,
  }, { nativeEditor });
  t.after(() => broker.close());
  const [first, second] = await Promise.all([session(broker.listener.address().port, "omp"), session(broker.listener.address().port, "codex")]);
  t.after(() => { first.terminate(); second.terminate(); });
  await Promise.all([initialize(first, 1), initialize(second, 1)]);
  const statelessEndpoint = broker.streamableHttp.statelessEndpoint;
  const statefulEndpoint = broker.streamableHttp.statefulEndpoint;
  const headers = { authorization: `Bearer ${token}` };
  const retainedHeaders = await statefulHeaders(statefulEndpoint);
  const initialized = await httpRequest(statelessEndpoint, "POST", {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-test", version: "1" } },
  }, headers);
  await mcpJson(initialized);
  let requestId = 10;
  const callers = [
    (name, args = {}) => request(first, ++requestId, "tools/call", { name, arguments: args }).then((response) => response.result),
    (name, args = {}) => request(second, ++requestId, "tools/call", { name, arguments: args }).then((response) => response.result),
    async (name, args = {}) => (await mcpJson(await httpRequest(statelessEndpoint, "POST", {
      jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args },
    }, headers))).result,
    async (name, args = {}) => (await mcpJson(await httpRequest(statefulEndpoint, "POST", {
      jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args },
    }, retainedHeaders))).result,
  ];
  assert.equal(broker.bridge.status().connected, false);
  const ids = [];
  for (const [index, call] of callers.entries()) {
    const opened = await call("potassium_editor_open_tab", { title: `Agent ${index}`, content: `return ${index}` });
    assert.equal(opened.isError, undefined);
    ids.push(opened.structuredContent.tab.id);
    const read = await call("potassium_editor_read_tab", { id: ids[index] });
    assert.equal(read.structuredContent.content, `return ${index}`);
    assert.equal(read.structuredContent.sha256, digest(`return ${index}`));
    assert.equal((await call("potassium_editor_activate_tab", { id: ids[index] })).structuredContent.tab.active, true);
    const clean = await call("potassium_editor_open_tab");
    assert.deepEqual((await call("potassium_editor_close_tab", { id: clean.structuredContent.tab.id })).structuredContent, {
      id: clean.structuredContent.tab.id, closed: true,
    });
  }
  for (const call of callers) {
    assert.deepEqual((await call("potassium_editor_list_tabs")).structuredContent.tabs.map(({ id }) => id), ids);
  }
  const executor = await executorSession(t, broker);
  const executions = [];
  executor.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type !== "request") return;
    let result;
    if (frame.method === "capabilities") result = {
      methods: ["execute_luau_async", "remote_call", "interaction_call", "interaction_inventory"], asyncJobs: { version: 2 },
      remoteActions: { version: 1 }, interactionActions: { version: 1 }, interactionInventory: { version: 1 },
    };
    else {
      executions.push(frame.method);
      result = frame.method === "execute_luau" ? { count: 1, values: [42] }
        : frame.method === "interaction_inventory" ? {
          view: "summary", snapshotId: "e".repeat(32), generation: 1,
          root: { name: "Workspace", className: "Workspace", path: "Workspace" },
          observedAt: 1, visited: 1, matchedVisited: 0, retained: 0,
          coverage: "complete", truncated: false, stopReasons: [], expiresInMs: 120000,
          counts: { click: 0, prompt: 0, touch: 0 }, touchCoverage: "observed-transmitters-not-exhaustive",
        } : { jobId: "d".repeat(32), state: "queued" };
    }
    executor.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
  });
  const pendingWrite = callers[3]("potassium_editor_write_tab", { id: ids[0], content: "return 99", expectedSha256: digest("return 0") });
  await writeStarted;
  editorUnavailable = true;
  for (const call of callers) {
    const unavailable = await call("potassium_editor_list_tabs");
    assert.equal(unavailable._meta.error.code, "NATIVE_EDITOR_UNAVAILABLE");
    assert.equal(JSON.stringify(unavailable).includes("private native"), false);
    const sync = await call("potassium_execute_luau", { code: "return 42" });
    assert.deepEqual(sync.structuredContent.values, [42]);
    const inventory = await call("potassium_interaction_inventory");
    assert.equal(inventory.structuredContent.coverage, "complete");
    assert.equal(inventory.structuredContent.touchCoverage, "observed-transmitters-not-exhaustive");
    const invalidTouch = await call("potassium_interaction_call", {
      kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: 1,
    });
    assert.equal(invalidTouch._meta.error.code, "INVALID_INPUT");
    for (const [name, args] of [
      ["potassium_execute_luau_async", { code: "return 42" }],
      ["potassium_remote_call", { target: "workspace.Remote", method: "FireServer", arguments: [] }],
      ["potassium_interaction_call", { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: false }],
    ]) {
      const response = await call(name, args);
      assert.equal(response.isError, undefined);
      assert.equal(response.structuredContent.jobId, "d".repeat(32));
    }
  }
  assert.equal(executions.filter((method) => method === "execute_luau").length, 4);
  assert.equal(executions.filter((method) => method === "execute_luau_async").length, 4);
  assert.equal(executions.filter((method) => method === "remote_call").length, 4);
  assert.equal(executions.filter((method) => method === "interaction_call").length, 4);
  assert.equal(executions.filter((method) => method === "interaction_inventory").length, 4);
  finishWrite();
  const written = await pendingWrite;
  assert.equal(written.structuredContent.sha256, digest("return 99"));
  assert.equal(written.structuredContent.preconditionAtomic, false);
  for (const call of callers.slice(1)) {
    assert.equal((await call("potassium_editor_read_tab", { id: ids[0] })).structuredContent.content, "return 99");
  }
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
  await authenticatedMethod.arrayBuffer();
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
  await oversized.arrayBuffer();
  const initialized = await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }, { authorization: `Bearer ${token}` });
  assert.equal((await mcpJson(initialized)).result.serverInfo.name, "potassium-mcp");
  const tools = await listHttpTools(endpoint, { authorization: `Bearer ${token}` });
  const toolNames = tools.tools.map(({ name }) => name);
  assert.equal(toolNames.includes("potassium_status"), true);
  assert.equal(toolNames.includes("potassium_execute_luau"), false);

  const socket = await session(broker.listener.address().port);
  t.after(() => socket.close());
  await initialize(socket, 4);
  assert.equal((await listSocketTools(socket, 5)).tools.some(({ name }) => name === "potassium_status"), true);
});
test("broker serves bounded authenticated stateful HTTP sessions independently of stateless HTTP", async (t) => {
  const broker = await createBroker({
    ...httpConfig(),
    streamableHttpEnabled: false,
    statefulHttpEnabled: true,
  });
  t.after(() => broker.close());
  const endpoint = broker.streamableHttp.endpoint;
  const stateless = endpoint.replace(/\/mcp\/session$/, "/mcp");
  assert.equal(broker.streamableHttp.path, "/mcp/session");
  assert.equal(broker.streamableHttp.statefulEndpoint, endpoint);
  assert.equal(broker.streamableHttp.statelessEndpoint, null);
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
  const tools = await listHttpTools(endpoint, { authorization: `Bearer ${token}`, "mcp-session-id": sessionId }, 32);
  assert.equal(tools.tools.some(({ name }) => name === "potassium_status"), true);
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
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "potassium broker "));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const brokerPath = path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp", "src", "broker.js");
  const configPath = path.join(installRoot, "config.json");
  await mkdir(path.dirname(brokerPath), { recursive: true });
  await Promise.all([writeFile(brokerPath, ""), writeFile(configPath, "{}")]);
  const statePath = path.join(installRoot, "broker-state.json");
  const state = {
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
  };
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  const processes = new Map([[process.pid, {
    executable: process.execPath, argv: [process.execPath, brokerPath, "--config", configPath],
  }]]);
  return {
    installRoot, statePath, state, processes, env: {},
    setState(next) { this.state = next; writeFileSync(statePath, `${JSON.stringify(next)}\n`); },
    processInfoForPid: (pid) => processes.get(pid) ?? { exited: true },
    probeReadiness: async () => true,
    drainBroker: async () => {},
  };
}

async function installedLauncherFixture(fixture, commands) {
  const proxyPath = path.join(path.dirname(fixture.state.brokerPath), "proxy.js");
  await writeFile(proxyPath, "");
  const ownership = {
    schema: 2,
    installRoot: fixture.installRoot,
    appPath: path.join(fixture.installRoot, "app"),
    configPath: fixture.state.configPath,
    hosts: Object.fromEntries(commands.map((command, index) => {
      const id = `host-${index}`;
      return [id, { id, kind: "manual", launcher: {
        type: "stdio", command, args: [proxyPath, "--config", fixture.state.configPath, "--host-id", id],
      } }];
    })),
  };
  const ownershipPath = path.join(fixture.installRoot, "ownership.json");
  await writeFile(ownershipPath, JSON.stringify(ownership));
  return { ownership, ownershipPath };
}

test("broker recognizes and restarts with each persisted Node executable independently of the CLI Node", async (t) => {
  const fixture = await lifecycleFixture(t);
  const installedNode = path.join(fixture.installRoot, path.basename(process.execPath));
  await copyFile(process.execPath, installedNode);
  await installedLauncherFixture(fixture, [process.execPath, installedNode]);
  assert.equal((await brokerStatus(fixture)).status, "running");
  fixture.setState({ ...fixture.state, nodeExecutable: installedNode });
  fixture.processes.set(process.pid, {
    executable: installedNode, argv: [installedNode, fixture.state.brokerPath, "--config", fixture.state.configPath],
  });
  assert.equal((await brokerStatus(fixture)).status, "running");
  const nextPid = process.pid + 1;
  const result = await restartBroker({
    ...fixture, waitMs: 1000,
    signalProcess: (pid) => fixture.processes.delete(pid),
    spawnProcess: (command, args) => {
      assert.equal(command, installedNode);
      fixture.processes.set(nextPid, { executable: command, argv: [command, ...args] });
      fixture.setState({ ...fixture.state, pid: nextPid, instanceId: "c".repeat(32) });
      return { unref() {} };
    },
  });
  assert.equal(result.status, "running");
  assert.equal(result.pid, nextPid);
});

test("broker refuses mismatched state, OS executable, and argv0 even when both Nodes are installed", async (t) => {
  const fixture = await lifecycleFixture(t);
  const otherNode = path.join(fixture.installRoot, path.basename(process.execPath));
  await copyFile(process.execPath, otherNode);
  await installedLauncherFixture(fixture, [process.execPath, otherNode]);
  for (const [executable, argv0] of [[otherNode, process.execPath], [process.execPath, otherNode], [otherNode, otherNode]]) {
    fixture.processes.set(process.pid, {
      executable, argv: [argv0, fixture.state.brokerPath, "--config", fixture.state.configPath],
    });
    assert.equal((await brokerStatus(fixture)).status, "stale");
  }
});

test("broker fails closed on present invalid ownership instead of falling back to the CLI Node", async (t) => {
  const fixture = await lifecycleFixture(t);
  const { ownership, ownershipPath } = await installedLauncherFixture(fixture, [process.execPath]);
  const original = JSON.stringify(ownership);
  const invalid = ["{", "null", "[]", JSON.stringify({ ...ownership, schema: 1 }), JSON.stringify({ ...ownership, hosts: {} })];
  for (const mutate of [
    (value) => { value.hosts["host-0"].launcher.command = `${process.execPath}.missing`; },
    (value) => { value.hosts["host-0"].launcher.command = "node"; },
    (value) => { value.hosts["host-0"].launcher.args[0] = fixture.state.brokerPath; },
    (value) => { value.hosts["host-0"].launcher.args[2] = `${fixture.state.configPath}.missing`; },
    (value) => { value.hosts["host-0"].launcher.args[4] = "other-host"; },
    (value) => { value.hosts["host-0"].launcher.args.push("--extra"); },
  ]) {
    const value = JSON.parse(original);
    mutate(value);
    invalid.push(JSON.stringify(value));
  }
  for (const value of invalid) {
    await writeFile(ownershipPath, value);
    const options = { ...fixture,
      signalProcess: () => assert.fail("must not signal with invalid installed ownership"),
      spawnProcess: () => assert.fail("must not spawn with invalid installed ownership"),
    };
    assert.equal((await brokerStatus(options)).status, "stale");
    await assert.rejects(restartBroker(options), /state is stale/);
    await assert.rejects(stopBroker(options), /state is stale/);
  }
  await rm(fixture.statePath);
  await assert.rejects(restartBroker({
    ...fixture, waitMs: 0, spawnProcess: () => assert.fail("must not use CLI fallback"),
  }), /installed broker runtime or configuration is missing/);
});

test("broker stop treats a confirmed unreaped Linux zombie as exited", { skip: process.platform !== "linux" }, async (t) => {
  const fixture = await lifecycleFixture(t);
  await writeFile(fixture.state.brokerPath, "setInterval(() => {}, 1000);\n");
  const script = [
    "import os, signal, sys, time",
    "pid = os.fork()",
    "if pid == 0: os.execv(sys.argv[1], sys.argv[1:])",
    "def finish(*args):",
    "    os.waitpid(pid, 0)",
    "    sys.exit(0)",
    "signal.signal(signal.SIGTERM, finish)",
    "for attempt in range(500):",
    "    with open('/proc/%d/cmdline' % pid, 'rb') as source: command = source.read()",
    "    if os.readlink('/proc/%d/exe' % pid) == os.path.realpath(sys.argv[1]) and command.split(b'\\0')[1:2] == [sys.argv[2].encode()]: break",
    "    time.sleep(0.01)",
    "print(pid, flush=True)",
    "time.sleep(30)",
    "os.waitpid(pid, 0)",
  ].join("\n");
  const parent = spawn("python3", ["-c", script, process.execPath, fixture.state.brokerPath, "--config", fixture.state.configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try { await once(parent, "spawn"); }
  catch (error) { if (error.code === "ENOENT") { t.skip("python3 is required to retain an unreaped child"); return; } throw error; }
  let pid;
  t.after(async () => {
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
    if (parent.exitCode === null) { const exited = once(parent, "exit"); parent.kill(); await exited; }
  });
  let output = "";
  for await (const chunk of parent.stdout) {
    output += chunk;
    if (output.includes("\n")) break;
  }
  pid = Number(output.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  fixture.setState({ ...fixture.state, pid });
  const result = await stopBroker({ ...fixture, processInfoForPid: undefined, waitMs: 2000 });
  assert.equal(result.status, "stopped");
  process.kill(pid, 0);
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  assert.match(stat.slice(stat.lastIndexOf(")") + 2), /^Z /);
});

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

test("broker restart relaunches only after exit and waits for a new ready generation", async (t) => {
  const fixture = await lifecycleFixture(t);
  const calls = [];
  const nextPid = process.pid + 1;
  let probes = 0;
  const result = await restartBroker({
    ...fixture,
    waitMs: 1000,
    signalProcess: (pid, signal) => {
      calls.push({ pid, signal });
      fixture.processes.delete(pid);
    },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      fixture.processes.set(nextPid, { executable: command, argv: [command, ...args] });
      fixture.setState({ ...fixture.state, pid: nextPid, instanceId: "c".repeat(32) });
      return { unref() {} };
    },
    probeReadiness: async () => ++probes !== 2,
  });
  assert.equal(result.status, "running");
  assert.equal(result.pid, nextPid);
  assert.equal(probes, 3);
  assert.deepEqual(calls[0], { pid: process.pid, signal: "SIGTERM" });
  assert.deepEqual(calls[1].args, [fixture.state.brokerPath, "--config", fixture.state.configPath]);
  assert.equal(calls[1].options.detached, true);
});

test("broker identity follows the installed junction to the recorded real runtime", async (t) => {
  const fixture = await lifecycleFixture(t);
  const linkedRuntime = path.dirname(path.dirname(fixture.state.brokerPath));
  const realRuntime = path.join(fixture.installRoot, "developer checkout");
  await rename(linkedRuntime, realRuntime);
  await symlink(realRuntime, linkedRuntime, process.platform === "win32" ? "junction" : "dir");
  const realBroker = path.join(realRuntime, "src", "broker.js");
  fixture.setState({ ...fixture.state, brokerPath: realBroker });
  fixture.processes.set(process.pid, {
    executable: process.execPath,
    argv: [process.execPath, realBroker, "--config", fixture.state.configPath],
  });
  assert.equal((await brokerStatus(fixture)).status, "running");
  let signaled;
  const stopped = await stopBroker({
    ...fixture, waitMs: 1000,
    signalProcess: (pid, signal) => { signaled = { pid, signal }; fixture.processes.delete(pid); },
  });
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(signaled, { pid: process.pid, signal: "SIGTERM" });
});

test("broker accepts canonical config and executable aliases without lexical equality", async (t) => {
  const fixture = await lifecycleFixture(t);
  const installAlias = path.join(fixture.installRoot, "install alias");
  const nodeAlias = path.join(fixture.installRoot, "node alias");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(fixture.installRoot, installAlias, linkType);
  await symlink(path.dirname(process.execPath), nodeAlias, linkType);
  fixture.setState({
    ...fixture.state,
    configPath: path.join(installAlias, "config.json"),
    nodeExecutable: path.join(nodeAlias, path.basename(process.execPath)),
  });
  fixture.processes.set(process.pid, {
    executable: fixture.state.nodeExecutable,
    argv: [fixture.state.nodeExecutable, fixture.state.brokerPath, "--config", fixture.state.configPath],
  });
  assert.equal((await brokerStatus(fixture)).status, "running");
});

test("broker canonical identity rejects relative, missing, and decoy identities without side effects", async (t) => {
  const fixture = await lifecycleFixture(t);
  const original = fixture.state;
  const decoyBroker = `${original.brokerPath}.decoy`;
  const decoyConfig = `${original.configPath}.decoy`;
  const decoyExecutable = path.join(fixture.installRoot, "node-decoy.exe");
  await Promise.all([decoyBroker, decoyConfig, decoyExecutable].map((file) => writeFile(file, "")));
  for (const overrides of [
    { brokerPath: path.basename(original.brokerPath) },
    { configPath: path.basename(original.configPath) },
    { nodeExecutable: path.basename(original.nodeExecutable) },
    { brokerPath: `${original.brokerPath}.missing` },
    { configPath: `${original.configPath}.missing` },
    { nodeExecutable: `${original.nodeExecutable}.missing` },
    { brokerPath: decoyBroker }, { configPath: decoyConfig }, { nodeExecutable: decoyExecutable },
  ]) {
    fixture.setState({ ...original, ...overrides });
    const options = { ...fixture,
      signalProcess: () => assert.fail("must not signal an unowned process"),
      spawnProcess: () => assert.fail("must not spawn from unowned state"),
    };
    assert.equal((await brokerStatus(options)).status, "stale");
    await assert.rejects(restartBroker(options), /state is stale/);
    await assert.rejects(stopBroker(options), /state is stale/);
  }
});

test("broker identity requires exact argv slots rather than lookalikes, wrappers, or embedded commands", async (t) => {
  const fixture = await lifecycleFixture(t);
  const { brokerPath, configPath } = fixture.state;
  const valid = [process.execPath, brokerPath, "--config", configPath];
  const fakeExecutable = path.join(fixture.installRoot, "wrapper.exe");
  await writeFile(fakeExecutable, "");
  const decoys = [
    [process.execPath, "-e", valid.join(" ")],
    [process.execPath, "wrapper.js", ...valid.slice(1)],
    [process.execPath, `${brokerPath}.decoy`, "--config", configPath],
    [process.execPath, brokerPath, "--config", `${configPath}.decoy`],
    [process.execPath, brokerPath, "--config-extra", configPath],
    [process.execPath, brokerPath, configPath, "--config"],
    [...valid, "--extra"],
    [process.execPath, `${brokerPath} --config ${configPath}`],
    [process.execPath, brokerPath, "--config", path.relative(process.cwd(), configPath)],
  ];
  for (const argv of decoys) {
    fixture.processes.set(process.pid, { executable: process.execPath, argv });
    const options = { ...fixture,
      signalProcess: () => assert.fail("must not signal decoys"),
      spawnProcess: () => assert.fail("must not spawn with decoy ownership"),
    };
    assert.equal((await brokerStatus(options)).status, "stale");
    await assert.rejects(restartBroker(options), /state is stale/);
  }
  fixture.processes.set(process.pid, { executable: fakeExecutable, argv: valid });
  assert.equal((await brokerStatus(fixture)).status, "stale");
  fixture.processes.set(process.pid, null);
  assert.equal((await brokerStatus(fixture)).status, "stale");
});

test("broker parses Windows quoted argv without treating escaped quotes or backslashes as delimiters", async (t) => {
  const fixture = await lifecycleFixture(t);
  const { brokerPath, configPath } = fixture.state;
  const commandLine = `"${process.execPath}" "${brokerPath}" --config "${configPath}"`;
  fixture.processes.set(process.pid, { executable: process.execPath, commandLine });
  assert.equal((await brokerStatus(fixture)).status, "running");
  for (const invalid of [
    `${commandLine} extra`,
    `"${process.execPath}" "${brokerPath} --config ${configPath}"`,
    `"${process.execPath}" "${brokerPath}\\" --config "${configPath}"`,
    `"${process.execPath}" "${brokerPath}"" --config "${configPath}"`,
    `"${process.execPath}" "${brokerPath}" --config "${configPath}`,
    `${commandLine}\0ignored`,
  ]) {
    fixture.processes.set(process.pid, { executable: process.execPath, commandLine: invalid });
    assert.equal((await brokerStatus(fixture)).status, "stale", invalid);
  }
});

test("broker reads real OS process identity with spaced argv paths and rejects a real eval decoy", async (t) => {
  const fixture = await lifecycleFixture(t);
  const { brokerPath, configPath } = fixture.state;
  await writeFile(brokerPath, "setInterval(() => {}, 1000);\n");
  for (const args of [
    [brokerPath, "--config", configPath],
    ["-e", "setInterval(() => {}, 1000)", "--", brokerPath, "--config", configPath],
  ]) {
    const child = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
    await once(child, "spawn");
    t.after(() => { if (child.exitCode === null) child.kill(); });
    fixture.setState({ ...fixture.state, pid: child.pid });
    const status = await brokerStatus({ ...fixture, processInfoForPid: undefined });
    assert.equal(status.status, args[0] === brokerPath ? "running" : "stale");
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

test("broker refuses ownership and policy changes during active-request waits", async (t) => {
  for (const operation of [restartBroker, stopBroker]) {
    for (const change of ["generation", "pid", "config", "missing"]) {
      const fixture = await lifecycleFixture(t, { method: "read_properties" });
      let probes = 0;
      const options = { ...fixture, waitMs: 1000,
        probeReadiness: async () => {
          if (++probes === 2) {
            const next = { ...fixture.state, active: null };
            if (change === "generation") next.instanceId = "d".repeat(32);
            if (change === "pid") next.pid += 1;
            if (change === "config") next.configPath += ".decoy";
            if (change === "missing") await rm(fixture.statePath);
            else fixture.setState(next);
          }
          return true;
        },
        signalProcess: () => assert.fail("must not signal after ownership changes"),
        spawnProcess: () => assert.fail("must not spawn after ownership changes"),
      };
      await assert.rejects(operation(options), /ownership changed/);
    }
  }
});

test("broker rechecks ownership after readiness and immediately before signaling", async (t) => {
  for (const operation of [restartBroker, stopBroker]) {
    for (const changedAt of [2, 3]) {
      const fixture = await lifecycleFixture(t);
      let inspections = 0;
      const options = { ...fixture,
        processInfoForPid: (pid) => {
          if (++inspections === changedAt) fixture.setState({ ...fixture.state, instanceId: "d".repeat(32) });
          return fixture.processInfoForPid(pid);
        },
        signalProcess: () => assert.fail("must not signal replacement"),
        spawnProcess: () => assert.fail("must not spawn after ownership changes"),
      };
      await assert.rejects(operation(options), /identity or ownership changed/);
    }
  }
});

test("broker refuses a junction retargeted while inspecting readiness", async (t) => {
  const fixture = await lifecycleFixture(t);
  const linkedRuntime = path.dirname(path.dirname(fixture.state.brokerPath));
  const originalRuntime = path.join(fixture.installRoot, "original runtime");
  const replacementRuntime = path.join(fixture.installRoot, "replacement runtime");
  await rename(linkedRuntime, originalRuntime);
  await mkdir(path.join(replacementRuntime, "src"), { recursive: true });
  await writeFile(path.join(replacementRuntime, "src", "broker.js"), "");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(originalRuntime, linkedRuntime, linkType);
  await assert.rejects(restartBroker({
    ...fixture,
    probeReadiness: async () => {
      await rm(linkedRuntime);
      await symlink(replacementRuntime, linkedRuntime, linkType);
      return true;
    },
    signalProcess: () => assert.fail("must not signal retargeted runtime"),
    spawnProcess: () => assert.fail("must not spawn retargeted runtime"),
  }), /state is stale/);
});

test("broker restart adopts a verified proxy replacement without spawning or signaling it", async (t) => {
  for (const oldStillExiting of [false, true]) {
    const fixture = await lifecycleFixture(t);
    const nextPid = process.pid + 1;
    const signals = [];
    let probes = 0;
    const result = await restartBroker({
      ...fixture, waitMs: 1000,
      probeReadiness: async () => ++probes !== 2,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (!oldStillExiting) fixture.processes.delete(pid);
        fixture.processes.set(nextPid, fixture.processes.get(pid) ?? {
          executable: process.execPath,
          argv: [process.execPath, fixture.state.brokerPath, "--config", fixture.state.configPath],
        });
        fixture.setState({ ...fixture.state, pid: nextPid, instanceId: "e".repeat(32) });
      },
      spawnProcess: () => assert.fail("must adopt the ready replacement instead of competing"),
    });
    assert.equal(result.pid, nextPid);
    assert.equal(result.status, "running");
    assert.equal(probes, 3);
    assert.deepEqual(signals, [{ pid: process.pid, signal: "SIGTERM" }]);
  }
});

test("broker restart refuses an unverified replacement and stop never signals a replacement", async (t) => {
  for (const operation of [restartBroker, stopBroker]) {
    const fixture = await lifecycleFixture(t);
    const signals = [];
    await assert.rejects(operation({
      ...fixture, waitMs: 1000,
      signalProcess: (pid) => {
        signals.push(pid);
        fixture.processes.delete(pid);
        fixture.setState({ ...fixture.state, pid: pid + 1, instanceId: "f".repeat(32) });
      },
      spawnProcess: () => assert.fail("must not spawn over unverified replacement"),
    }), /identity could not be verified|ownership changed/);
    assert.deepEqual(signals, [process.pid]);
  }
});

test("broker never mistakes an unchanged exited generation for a successful restart", async (t) => {
  const fixture = await lifecycleFixture(t);
  await assert.rejects(restartBroker({
    ...fixture, waitMs: 0,
    signalProcess: (pid) => fixture.processes.delete(pid),
    spawnProcess: () => ({ unref() {} }),
  }), /did not become ready/);
});

test("broker refuses a request becoming active during final process inspection", async (t) => {
  for (const operation of [restartBroker, stopBroker]) {
    const fixture = await lifecycleFixture(t);
    let inspections = 0;
    await assert.rejects(operation({
      ...fixture,
      processInfoForPid: (pid) => {
        if (++inspections === 3) fixture.setState({ ...fixture.state, active: { method: "read_properties" } });
        return fixture.processInfoForPid(pid);
      },
      signalProcess: () => assert.fail("must not interrupt the new active request"),
      spawnProcess: () => assert.fail("must not spawn while active"),
    }), /while a broker request is active/);
  }
});

test("broker resolves a hostless external runtime only with active exact ownership", async (t) => {
  const fixture = await lifecycleFixture(t);
  const root = path.join(fixture.installRoot, "external package");
  const nodeExecutable = path.join(fixture.installRoot, "external node.exe");
  const nodeBytes = Buffer.from("isolated node identity fixture");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "src", "broker.js"), ""),
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@mrketa/potassium-mcp", version: "0.10.0-beta.1" })),
    writeFile(path.join(root, "bin", "potassium-mcp.js"), ""),
    writeFile(nodeExecutable, nodeBytes),
  ]);
  const ownershipPath = path.join(fixture.installRoot, "ownership.json");
  const ownership = {
    schema: 3, status: "active", installRoot: fixture.installRoot, configPath: fixture.state.configPath,
    runtime: { mode: "external", root, nodeExecutable, nodeSha256: createHash("sha256").update(nodeBytes).digest("hex") },
    hosts: {},
  };
  await writeFile(ownershipPath, JSON.stringify(ownership));
  await assert.rejects(resolveBrokerLaunch({ configFile: fixture.state.configPath }), /could not be verified/);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "@mrketa/potassium-mcp", version: "0.10.0-beta.1",
    potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 },
  }));
  const launch = await resolveBrokerLaunch({ configFile: fixture.state.configPath });
  assert.equal(launch.command, nodeExecutable);
  assert.deepEqual(launch.args, [path.join(root, "src", "broker.js"), "--config", fixture.state.configPath]);
  for (const invalid of [
    { ...ownership, status: "retained" },
    { ...ownership, runtime: { ...ownership.runtime, nodeSha256: "0".repeat(64) } },
    { ...ownership, configPath: path.join(root, "missing.json") },
  ]) {
    await writeFile(ownershipPath, JSON.stringify(invalid));
    await assert.rejects(resolveBrokerLaunch({ configFile: fixture.state.configPath }), /could not be verified/);
  }
  await writeFile(ownershipPath, JSON.stringify(ownership));
  await writeFile(nodeExecutable, "replaced executable");
  await assert.rejects(resolveBrokerLaunch({ configFile: fixture.state.configPath }), /could not be verified/);
});

test("broker launch preserves installed legacy runtime identity instead of the invoking package", async (t) => {
  const fixture = await lifecycleFixture(t);
  await installedLauncherFixture(fixture, [process.execPath]);
  const launch = await resolveBrokerLaunch({ configFile: fixture.state.configPath });
  assert.deepEqual(launch.args, [fixture.state.brokerPath, "--config", fixture.state.configPath]);
  assert.equal(launch.command.toLowerCase(), process.execPath.toLowerCase());
});

test("broker stop refuses unresolved recovery even without a legacy active field", async (t) => {
  const fixture = await lifecycleFixture(t);
  fixture.setState({ ...fixture.state, active: null, recovering: true });
  await assert.rejects(stopBroker({
    ...fixture, waitMs: 0,
    signalProcess: () => assert.fail("must not signal unresolved recovery"),
  }), /while a broker request is active/);
});


test("broker readiness probe cannot inherit a persisted ready value", async (t) => {
  const fixture = await lifecycleFixture(t);
  const status = await brokerStatus({ ...fixture, probeReadiness: async () => false });
  assert.equal(status.status, "running");
  assert.equal(status.readiness, "unreachable");
});

test("authenticated management drain fences generation, closes admission, and waits for RPC completion", async (t) => {
  const broker = await createBroker({ ...config(), requestTimeoutMs: 5000 });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const manager = await session(broker.listener.address().port);
  t.after(() => manager.terminate());
  const wrong = once(manager, "message");
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: "0".repeat(32), leaseId: "d".repeat(32) }));
  assert.equal(JSON.parse((await wrong)[0].toString()).type, "broker-drain-rejected");
  assert.equal(broker.bridge.status().draining, false);
  const sent = once(executor, "message");
  const active = broker.bridge.request("client_state");
  const activeId = JSON.parse((await sent)[0].toString()).id;
  const admissionClosed = once(broker.bridge, "activity");
  const acknowledged = once(manager, "message");
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "e".repeat(32) }));
  await admissionClosed;
  assert.equal(broker.bridge.status().draining, true);
  await assert.rejects(broker.bridge.request("execute_luau"), { code: "DRAINING", submissionIndeterminate: false });
  executor.send(JSON.stringify({ type: "response", id: activeId, ok: true, result: "complete" }));
  assert.equal(await active, "complete");
  assert.deepEqual(JSON.parse((await acknowledged)[0].toString()), { type: "broker-drained", instanceId: broker.instanceId, leaseId: "e".repeat(32) });
  const closed = once(manager, "close");
  manager.close();
  await closed;
  assert.equal(broker.bridge.status().draining, true);
  const replacement = await session(broker.listener.address().port);
  t.after(() => replacement.terminate());
  const adopted = once(replacement, "message");
  replacement.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "f".repeat(32) }));
  assert.equal(JSON.parse((await adopted)[0].toString()).type, "broker-drained");
  const replacementClosed = once(replacement, "close");
  replacement.close();
  await replacementClosed;
  assert.equal(broker.bridge.status().draining, true);
});

test("abandoned unacknowledged drain leases reopen admission without releasing the active request", async (t) => {
  const broker = await createBroker({ ...config(), requestTimeoutMs: 5000 });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const manager = await session(broker.listener.address().port);
  t.after(() => manager.terminate());
  const sent = once(executor, "message");
  const active = broker.bridge.request("execute_luau");
  const activeId = JSON.parse((await sent)[0].toString()).id;
  const admissionClosed = once(broker.bridge, "activity");
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "a".repeat(32) }));
  await admissionClosed;
  const contender = await session(broker.listener.address().port);
  const rejected = once(contender, "message");
  contender.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "b".repeat(32) }));
  assert.equal(JSON.parse((await rejected)[0].toString()).type, "broker-drain-rejected");
  const contenderClosed = once(contender, "close");
  contender.close();
  await contenderClosed;
  assert.equal(broker.bridge.status().draining, true);
  const resumed = once(broker.bridge, "activity");
  manager.close();
  await resumed;
  assert.equal(broker.bridge.status().draining, false);
  assert.equal(broker.bridge.status().activeMethod, "execute_luau");
  const queued = broker.bridge.request("client_state");
  const next = once(executor, "message");
  executor.send(JSON.stringify({ type: "response", id: activeId, ok: true, result: "done" }));
  await active;
  const queuedId = JSON.parse((await next)[0].toString()).id;
  executor.send(JSON.stringify({ type: "response", id: queuedId, ok: true, result: "resumed" }));
  assert.equal(await queued, "resumed");
});

test("lifecycle stop obtains real authenticated drain before an injected signal despite an idle disk snapshot", async (t) => {
  const fixture = await lifecycleFixture(t);
  const broker = await createBroker({ ...config(), requestTimeoutMs: 5000 });
  t.after(() => broker.close());
  await writeFile(fixture.state.configPath, JSON.stringify(config()));
  fixture.setState({ ...fixture.state, instanceId: broker.instanceId, proxyPort: broker.listener.address().port });
  const executor = await executorSession(t, broker);
  const sent = once(executor, "message");
  const active = broker.bridge.request("client_state");
  const activeId = JSON.parse((await sent)[0].toString()).id;
  const admissionClosed = once(broker.bridge, "activity");
  let signals = 0;
  const stopping = stopBroker({
    ...fixture, drainBroker: undefined, waitMs: 5000,
    signalProcess: () => {
      assert.equal(broker.bridge.status().draining, true);
      assert.equal(broker.bridge.status().pendingRequests, 0);
      signals += 1;
      fixture.processes.delete(process.pid);
    },
  });
  await admissionClosed;
  assert.equal(signals, 0);
  executor.send(JSON.stringify({ type: "response", id: activeId, ok: true, result: "done" }));
  await active;
  assert.equal((await stopping).status, "stopped");
  assert.equal(signals, 1);
});

test("lifecycle refuses a legacy broker without the drain protocol rather than signaling it", async (t) => {
  const fixture = await lifecycleFixture(t);
  const legacy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(legacy, "listening");
  t.after(() => { for (const socket of legacy.clients) socket.terminate(); return new Promise((resolve) => legacy.close(resolve)); });
  legacy.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "proxy-hello") {
      const serverNonce = "f".repeat(64);
      socket.send(JSON.stringify({ type: "proxy-challenge", protocol: 1, serverNonce, proof: proxyProof(token, "server", message.clientNonce, serverNonce, message.hostId) }));
    } else if (message.type === "proxy-ack") socket.send(JSON.stringify({ type: "proxy-ready" }));
    else socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }));
  }));
  await writeFile(fixture.state.configPath, JSON.stringify(config()));
  fixture.setState({ ...fixture.state, proxyPort: legacy.address().port });
  await assert.rejects(stopBroker({
    ...fixture, drainBroker: undefined, waitMs: 1000,
    signalProcess: () => assert.fail("must not signal a broker without a drain acknowledgment"),
  }), /authenticated drain; no signal sent/);
});

test("management uses environment-selected config and install roots without touching the default broker", async (t) => {
  for (const setting of ["POTASSIUM_MCP_CONFIG", "POTASSIUM_MCP_INSTALL_ROOT"]) {
    for (const operation of [brokerStatus, stopBroker, restartBroker]) {
      const fixture = await lifecycleFixture(t, { method: "execute_luau" });
      const env = { [setting]: setting === "POTASSIUM_MCP_CONFIG" ? fixture.state.configPath : fixture.installRoot };
      const options = {
        ...fixture, installRoot: undefined, env, waitMs: 0,
        signalProcess: () => assert.fail("must not signal an environment-selected active request or a default broker"),
        spawnProcess: () => assert.fail("must not start another broker"),
      };
      if (operation === brokerStatus) assert.equal((await operation(options)).active.method, "execute_luau");
      else await assert.rejects(operation(options), /while a broker request is active/);
    }
  }
});

test("management explicit config overrides both root and environment selection", async (t) => {
  const fixture = await lifecycleFixture(t);
  const status = await brokerStatus({
    ...fixture, configFile: fixture.state.configPath,
    installRoot: path.join(fixture.installRoot, "wrong explicit root"),
    env: { POTASSIUM_MCP_CONFIG: path.join(fixture.installRoot, "wrong.json"), POTASSIUM_MCP_INSTALL_ROOT: path.join(fixture.installRoot, "wrong env root") },
  });
  assert.equal(status.status, "running");
  assert.equal(status.pid, process.pid);
});

test("management drain waits for accepted async identity audit and MCP response flush", async (t) => {
  let releaseAudit;
  let enterAudit;
  const auditHeld = new Promise((resolve) => { releaseAudit = resolve; });
  const auditEntered = new Promise((resolve) => { enterAudit = resolve; });
  t.mock.method(AdminAuditRecorder.prototype, "finish", async () => { enterAudit(); await auditHeld; });
  t.after(() => releaseAudit());
  const broker = await createBroker({
    ...config(), requestTimeoutMs: 5000, allowUnsafeExecute: true,
    hostPolicies: { omp: { read: true, admin: true, execute: true } },
  });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const caller = await session(broker.listener.address().port);
  const manager = await session(broker.listener.address().port);
  t.after(() => { caller.terminate(); manager.terminate(); });
  await initialize(caller, 100);
  const capabilityFrame = once(executor, "message");
  const submitted = request(caller, 101, "tools/call", { name: "potassium_execute_luau_async", arguments: { code: "return 42" } });
  const capabilities = JSON.parse((await capabilityFrame)[0].toString());
  const submissionFrame = once(executor, "message");
  executor.send(JSON.stringify({ type: "response", id: capabilities.id, ok: true, result: { asyncJobs: { version: 2 }, methods: ["execute_luau_async"] } }));
  const submission = JSON.parse((await submissionFrame)[0].toString());
  const jobId = "d".repeat(32);
  executor.send(JSON.stringify({ type: "response", id: submission.id, ok: true, result: { jobId, state: "queued" } }));
  await auditEntered;
  assert.equal(broker.bridge.status().pendingRequests, 0);
  const admissionClosed = once(broker.bridge, "activity");
  let acknowledged = false;
  const acknowledgment = once(manager, "message").then(([raw]) => { acknowledged = true; return JSON.parse(raw.toString()); });
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "c".repeat(32) }));
  await admissionClosed;
  const rejected = await request(caller, 102, "tools/list");
  assert.equal(rejected.error.code, -32000);
  assert.equal(acknowledged, false);
  releaseAudit();
  assert.equal((await submitted).result.structuredContent.jobId, jobId);
  assert.equal((await acknowledgment).type, "broker-drained");
});

test("confirmed stop receipts permit restart without deleting the old or replacement state", async (t) => {
  const fixture = await lifecycleFixture(t);
  const owner = { ...fixture.state };
  await stopBroker({ ...fixture, signalProcess: () => fixture.processes.delete(owner.pid), waitMs: 1000 });
  assert.equal(JSON.parse(await readFile(fixture.statePath, "utf8")).instanceId, owner.instanceId);
  const replacement = { ...owner, pid: owner.pid + 1, instanceId: "b".repeat(32) };
  const restarted = await restartBroker({
    ...fixture, waitMs: 1000,
    signalProcess: () => assert.fail("must not signal an already stopped owner"),
    spawnProcess: (command, args) => {
      fixture.processes.set(replacement.pid, { executable: command, argv: [command, ...args] });
      fixture.setState(replacement);
      return { unref() {} };
    },
  });
  assert.equal(restarted.status, "running");
  assert.equal(restarted.pid, replacement.pid);
  assert.equal(JSON.parse(await readFile(fixture.statePath, "utf8")).instanceId, replacement.instanceId);
});

test("stop receipt publication never removes a concurrently published replacement generation", async (t) => {
  const fixture = await lifecycleFixture(t);
  const owner = { ...fixture.state };
  const replacement = { ...owner, pid: owner.pid + 1, instanceId: "b".repeat(32) };
  let signaled = false;
  let replaced = false;
  await assert.rejects(stopBroker({
    ...fixture, waitMs: 1000,
    signalProcess: () => { signaled = true; fixture.processes.delete(owner.pid); },
    processInfoForPid: (pid) => {
      if (signaled && !replaced && pid === owner.pid) {
        replaced = true;
        fixture.setState(replacement);
        fixture.processes.set(replacement.pid, { executable: process.execPath, argv: [process.execPath, replacement.brokerPath, "--config", replacement.configPath] });
      }
      return fixture.processInfoForPid(pid);
    },
  }), /ownership changed during shutdown/);
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, "utf8")), replacement);
});

test("a stopped receipt cannot authorize a different stale generation", async (t) => {
  const fixture = await lifecycleFixture(t);
  await stopBroker({ ...fixture, signalProcess: () => fixture.processes.delete(fixture.state.pid), waitMs: 1000 });
  fixture.setState({ ...fixture.state, instanceId: "c".repeat(32) });
  await assert.rejects(restartBroker({
    ...fixture, waitMs: 0,
    spawnProcess: () => assert.fail("must not launch for a mismatched stop receipt"),
    signalProcess: () => assert.fail("must not signal stale identity"),
  }), /state is stale/);
});

test("stopped receipts permit a verified runtime upgrade without requiring the retired files or Node", async (t) => {
  const fixture = await lifecycleFixture(t);
  const owner = { ...fixture.state };
  await stopBroker({ ...fixture, signalProcess: () => fixture.processes.delete(owner.pid), waitMs: 1000 });
  const root = path.join(fixture.installRoot, "upgraded runtime");
  const nodeExecutable = path.join(fixture.installRoot, "upgraded node.exe");
  const nodeBytes = Buffer.from("new verified executable fixture");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "src", "broker.js"), ""),
    writeFile(path.join(root, "package.json"), JSON.stringify({ potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 } })),
    writeFile(path.join(root, "bin", "potassium-mcp.js"), ""),
    writeFile(nodeExecutable, nodeBytes),
  ]);
  await rm(owner.brokerPath);
  await writeFile(path.join(fixture.installRoot, "ownership.json"), JSON.stringify({
    schema: 3, status: "active", installRoot: fixture.installRoot, configPath: owner.configPath,
    runtime: { mode: "external", root, nodeExecutable, nodeSha256: createHash("sha256").update(nodeBytes).digest("hex") },
    hosts: {},
  }));
  const restarted = await restartBroker({
    ...fixture, waitMs: 1000,
    signalProcess: () => assert.fail("must never signal a receipted stopped PID"),
    spawnProcess: (command, args) => {
      const replacement = { ...owner, pid: owner.pid + 1, instanceId: "b".repeat(32), nodeExecutable: command, brokerPath: args[0] };
      fixture.processes.set(replacement.pid, { executable: command, argv: [command, ...args] });
      fixture.setState(replacement);
      return { unref() {} };
    },
  });
  assert.equal(restarted.status, "running");
  assert.equal(fixture.state.nodeExecutable, nodeExecutable);
  assert.equal(fixture.state.brokerPath, path.join(root, "src", "broker.js"));
});

test("an unresponsive management peer cannot extend drain timeout with a WebSocket close handshake", { timeout: 5000 }, async (t) => {
  const fixture = await lifecycleFixture(t);
  let peer;
  let upgraded = false;
  let disconnected;
  const peerDisconnected = new Promise((resolve) => { disconnected = resolve; });
  const listener = net.createServer((socket) => {
    peer = socket;
    socket.on("end", disconnected);
    socket.on("error", () => {});
    let headers = "";
    socket.on("data", (chunk) => {
      if (upgraded) return; // Deliberately consume frames without replying, including close.
      headers += chunk.toString("utf8");
      if (!headers.includes("\r\n\r\n")) return;
      const key = headers.match(/sec-websocket-key: ([^\r\n]+)/i)?.[1];
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
    });
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => { peer?.destroy(); return new Promise((resolve) => listener.close(resolve)); });
  await writeFile(fixture.state.configPath, JSON.stringify(config()));
  fixture.setState({ ...fixture.state, proxyPort: listener.address().port });
  await assert.rejects(stopBroker({
    ...fixture, drainBroker: undefined, waitMs: 1000,
    signalProcess: () => assert.fail("must not signal without authenticated drain"),
  }), /not confirmed before its deadline/);
  assert.equal(upgraded, true);
  let timer;
  const closedPromptly = await Promise.race([
    peerDisconnected.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 500); }),
  ]);
  clearTimeout(timer);
  assert.equal(closedPromptly, true, "the stalled close handshake must not retain the manager socket");
});

test("incomplete stopped receipts cannot authenticate incomplete stale records", async (t) => {
  const fixture = await lifecycleFixture(t);
  fixture.processes.delete(fixture.state.pid);
  const incomplete = { schema: 1, pid: fixture.state.pid };
  fixture.setState(incomplete);
  await writeFile(path.join(fixture.installRoot, "broker-stopped.json"), JSON.stringify({ ...incomplete, stopped: true }));
  await assert.rejects(restartBroker({
    ...fixture, waitMs: 0,
    spawnProcess: () => assert.fail("incomplete identity is not proof of an owned stop"),
    signalProcess: () => assert.fail("must not signal an unverified identity"),
  }), /state is stale/);
});

for (const requestId of [0, "", 201]) test(`cancelled MCP ID ${JSON.stringify(requestId)} drains after executor recovery and held audit`, async (t) => {
  let releaseAudit;
  let enterAudit;
  const auditHeld = new Promise((resolve) => { releaseAudit = resolve; });
  const auditEntered = new Promise((resolve) => { enterAudit = resolve; });
  t.mock.method(AdminAuditRecorder.prototype, "finish", async () => { enterAudit(); await auditHeld; });
  t.after(() => releaseAudit());
  const broker = await createBroker({
    ...config(), requestTimeoutMs: 5000, allowUnsafeExecute: true,
    hostPolicies: { omp: { read: true, admin: true, execute: true } },
  });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const caller = await session(broker.listener.address().port);
  const manager = await session(broker.listener.address().port);
  t.after(() => { caller.terminate(); manager.terminate(); });
  await initialize(caller, 200);
  const responses = [];
  caller.on("message", (raw) => responses.push(JSON.parse(raw.toString())));
  const sent = once(executor, "message");
  caller.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "potassium_execute_luau", arguments: { code: "return 42" } } }));
  const execution = JSON.parse((await sent)[0].toString());
  caller.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } }));
  await auditEntered;
  assert.equal(broker.bridge.status().recovering, true);
  const admissionClosed = once(broker.bridge, "activity");
  let acknowledged = false;
  const acknowledgment = once(manager, "message").then(([raw]) => { acknowledged = true; return JSON.parse(raw.toString()); });
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "e".repeat(32) }));
  await admissionClosed;
  const recovered = once(broker.bridge, "activity");
  executor.send(JSON.stringify({ type: "response", id: execution.id, ok: true, result: { values: [42] } }));
  await recovered;
  assert.equal(broker.bridge.status().recovering, false);
  assert.equal((await request(caller, 202, "tools/list")).error.code, -32000);
  assert.equal(acknowledged, false);
  releaseAudit();
  assert.equal((await acknowledgment).type, "broker-drained");
  assert.equal(caller.readyState, WebSocket.OPEN);
  assert.equal(responses.some(({ id }) => id === requestId), false);
});

for (const requestId of [0, "", 400]) test(`stateful HTTP cancellation ID ${JSON.stringify(requestId)} is session-bound and waits for audit`, async (t) => {
  let releaseAudit;
  let enterAudit;
  const held = new Promise((resolve) => { releaseAudit = resolve; });
  const entered = new Promise((resolve) => { enterAudit = resolve; });
  t.mock.method(AdminAuditRecorder.prototype, "finish", async () => { enterAudit(); await held; });
  t.after(() => releaseAudit());
  const broker = await createBroker({
    ...config(), requestTimeoutMs: 5000, statefulHttpEnabled: true, allowUnsafeExecute: true,
    httpPolicy: { read: true, admin: true, execute: true },
  });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const endpoint = broker.streamableHttp.statefulEndpoint;
  const openSession = async (id) => {
    const initialized = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cancel-test", version: "1" } } }, { authorization: `Bearer ${token}` });
    await initialized.text();
    return { authorization: `Bearer ${token}`, "mcp-session-id": initialized.headers.get("mcp-session-id") };
  };
  const firstHeaders = await openSession(1);
  const secondHeaders = await openSession(2);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const sent = once(executor, "message");
  const original = fetch(endpoint, {
    method: "POST", signal: controller.signal,
    headers: { ...firstHeaders, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "potassium_execute_luau", arguments: { code: "return 42" } } }),
  }).then((response) => response.text()).catch(() => undefined);
  const execution = JSON.parse((await sent)[0].toString());
  const cancellation = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } };
  const unrelated = await httpRequest(endpoint, "POST", cancellation, secondHeaders);
  await unrelated.text();
  assert.equal(broker.bridge.status().pendingRequests, 1);
  const duplicate = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: requestId, method: "tools/list" }, firstHeaders);
  await duplicate.text();
  assert.equal(duplicate.status, 400);
  const cancelled = await httpRequest(endpoint, "POST", cancellation, firstHeaders);
  await cancelled.text();
  await entered;
  const manager = await session(broker.listener.address().port);
  t.after(() => manager.terminate());
  let acknowledged = false;
  const acknowledgment = once(manager, "message").then(([raw]) => { acknowledged = true; return JSON.parse(raw.toString()); });
  const admissionClosed = once(broker.bridge, "activity");
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "f".repeat(32) }));
  await admissionClosed;
  const recovered = once(broker.bridge, "activity");
  executor.send(JSON.stringify({ type: "response", id: execution.id, ok: true, result: { values: [42] } }));
  await recovered;
  const rejected = await httpRequest(endpoint, "GET", undefined, firstHeaders);
  await rejected.text();
  assert.equal(rejected.status, 503);
  assert.equal(acknowledged, false);
  releaseAudit();
  assert.equal((await acknowledgment).type, "broker-drained");
  controller.abort();
  await original;
});

test("terminal drain cannot be reopened by an abandoned management lease", async (t) => {
  const broker = await createBroker({ ...config(), requestTimeoutMs: 5000 });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const manager = await session(broker.listener.address().port);
  t.after(() => manager.terminate());
  const sent = once(executor, "message");
  const active = broker.bridge.request("client_state");
  const frame = JSON.parse((await sent)[0].toString());
  const leased = once(broker.bridge, "activity");
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "a".repeat(32) }));
  await leased;
  const terminal = broker.drain();
  const abandoned = once(manager, "close");
  manager.close();
  await abandoned;
  const probe = await session(broker.listener.address().port);
  t.after(() => probe.terminate());
  assert.equal((await request(probe, 1, "tools/list")).error.code, -32000);
  assert.equal(broker.bridge.status().draining, true);
  executor.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result: { placeId: 1 } }));
  await active;
  await terminal;
  assert.equal((await request(probe, 2, "tools/list")).error.code, -32000);
});

async function statefulHeaders(endpoint, id = 1) {
  const initialized = await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "batch-cancel", version: "1" } },
  }, { authorization: `Bearer ${token}` });
  assert.equal(initialized.status, 200);
  await initialized.text();
  return { authorization: `Bearer ${token}`, "mcp-session-id": initialized.headers.get("mcp-session-id") };
}

async function sseMessages(response) {
  return (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
}

test("stateful mixed batches deliver completed replies and close only cancelled response groups", { timeout: 15000 }, async (t) => {
  const broker = await createBroker({ ...config(), statefulHttpEnabled: true });
  t.after(() => broker.close());
  const endpoint = broker.streamableHttp.statefulEndpoint;
  const headers = await statefulHeaders(endpoint);
  const mixed = await httpRequest(endpoint, "POST", [
    { jsonrpc: "2.0", id: 0, method: "ping" },
    { jsonrpc: "2.0", id: "", method: "ping" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "" } },
  ], headers);
  assert.equal(mixed.status, 200);
  assert.deepEqual(await sseMessages(mixed), [{ jsonrpc: "2.0", id: 0, result: {} }]);
  const next = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: "", method: "ping" }, headers);
  assert.deepEqual(await sseMessages(next), [{ jsonrpc: "2.0", id: "", result: {} }]);
  const manager = await session(broker.listener.address().port);
  t.after(() => manager.terminate());
  const acknowledged = once(manager, "message");
  manager.send(JSON.stringify({ type: "broker-drain", instanceId: broker.instanceId, leaseId: "b".repeat(32) }));
  assert.equal(JSON.parse((await acknowledged)[0].toString()).type, "broker-drained");
});

for (const pairsPerBatch of [1, 10]) test(`stateful cancellation retention retires only its idle session for ${pairsPerBatch * 2}-member batches`, { timeout: 30000 }, async (t) => {
  const broker = await createBroker({ ...config(), requestTimeoutMs: 30000, statefulHttpEnabled: true });
  t.after(() => broker.close());
  const endpoint = broker.streamableHttp.statefulEndpoint;
  const headers = await statefulHeaders(endpoint);
  const otherHeaders = await statefulHeaders(endpoint, 2);
  const executor = await executorSession(t, broker);
  const sent = once(executor, "message");
  const other = httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 1000, method: "tools/call", params: { name: "potassium_client_state", arguments: {} } }, otherHeaders).then(sseMessages);
  const held = JSON.parse((await sent)[0].toString());
  for (let index = 0; index < Math.floor(256 / (pairsPerBatch * 2)); index += 1) {
    const messages = [];
    const expected = [];
    for (let pair = 0; pair < pairsPerBatch; pair += 1) {
      const completedId = 1000 + (index * pairsPerBatch + pair) * 2;
      const cancelledId = completedId + 1;
      messages.push(
        { jsonrpc: "2.0", id: completedId, method: "ping" },
        { jsonrpc: "2.0", id: cancelledId, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancelledId } },
      );
      expected.push({ jsonrpc: "2.0", id: completedId, result: {} });
    }
    const response = await httpRequest(endpoint, "POST", messages, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(await sseMessages(response), expected);
  }
  if (pairsPerBatch === 10) {
    const impossible = await httpRequest(endpoint, "POST", Array.from({ length: 257 }, (_, index) => ({ jsonrpc: "2.0", id: 40000 + index, method: "ping" })), headers);
    await impossible.text();
    assert.equal(impossible.status, 429);
    const stillUsable = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 30000, method: "ping" }, headers);
    assert.deepEqual(await sseMessages(stillUsable), [{ jsonrpc: "2.0", id: 30000, result: {} }]);
  }
  const nextBatch = Array.from({ length: pairsPerBatch * 2 }, (_, index) => ({ jsonrpc: "2.0", id: 9999 + index, method: "ping" }));
  const expired = await httpRequest(endpoint, "POST", nextBatch, headers);
  await expired.text();
  assert.equal(expired.status, 404);
  assert.equal(broker.bridge.status().pendingRequests, 1, "another session's accepted work must not be retired");
  executor.send(JSON.stringify({ type: "response", id: held.id, ok: true, result: { placeId: 123 } }));
  assert.equal((await other)[0].result.structuredContent.placeId, 123);
  const freshHeaders = await statefulHeaders(endpoint, 3);
  const fresh = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, freshHeaders);
  assert.deepEqual(await sseMessages(fresh), [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

test("broker retains stateless pages across POST closures while isolating WS and stateful scopes", { timeout: 15000 }, async (t) => {
  const broker = await createBroker(httpConfig({ statefulHttpEnabled: true, requestTimeoutMs: 2000 }));
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  const value = { text: "é\\\"😀".repeat(2500) };
  executor.on("message", (frame) => {
    const request = JSON.parse(frame.toString());
    if (request.type === "request") executor.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: value }));
  });
  let id = 10;
  const httpCall = async (endpoint, headers, name, args = {}) => (await mcpJson(await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args },
  }, headers))).result;
  const stateless = broker.streamableHttp.statelessEndpoint;
  const stateful = broker.streamableHttp.statefulEndpoint;
  const statelessHeaders = { authorization: `Bearer ${token}` };
  const firstHeaders = await statefulHeaders(stateful);
  const secondHeaders = await statefulHeaders(stateful, 2);
  const descriptor = (await httpCall(stateless, statelessHeaders, "potassium_client_state")).structuredContent;
  assert.equal(descriptor.kind, "potassium/result");
  const pageArgs = { resultId: descriptor.resultId, view: "text", maxBytes: 4096 };
  const first = await httpCall(stateless, statelessHeaders, "potassium_result_read", pageArgs);
  const replay = await httpCall(stateless, statelessHeaders, "potassium_result_read", pageArgs);
  assert.deepEqual(replay.structuredContent, first.structuredContent);
  assert.equal(first.structuredContent.text, JSON.stringify(value).slice(0, first.structuredContent.text.length));
  assert.equal(Buffer.byteLength(JSON.stringify(first)) <= 8192, true);
  const forbiddenOrigin = await httpRequest(stateless, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "potassium_result_read", arguments: pageArgs },
  }, { ...statelessHeaders, origin: "https://example.com" });
  assert.equal(forbiddenOrigin.status, 403);
  await forbiddenOrigin.text();
  assert.equal((await httpCall(stateful, firstHeaders, "potassium_result_read", pageArgs))._meta.error.code, "RESULT_NOT_FOUND");
  const socket = await session(broker.listener.address().port);
  t.after(() => socket.terminate());
  await initialize(socket, 1);
  const wsRead = await request(socket, 2, "tools/call", { name: "potassium_result_read", arguments: pageArgs });
  assert.equal(wsRead.result._meta.error.code, "RESULT_NOT_FOUND");
  const owned = (await httpCall(stateful, firstHeaders, "potassium_client_state")).structuredContent;
  const ownedArgs = { resultId: owned.resultId };
  assert.equal((await httpCall(stateful, firstHeaders, "potassium_result_read", ownedArgs)).isError, undefined);
  assert.equal((await httpCall(stateful, secondHeaders, "potassium_result_read", ownedArgs))._meta.error.code, "RESULT_NOT_FOUND");
  assert.equal((await httpCall(stateless, statelessHeaders, "potassium_result_read", ownedArgs))._meta.error.code, "RESULT_NOT_FOUND");
  const deleted = await httpRequest(stateful, "DELETE", undefined, firstHeaders);
  assert.equal(deleted.status, 200);
  await deleted.text();
  const expiredSession = await httpRequest(stateful, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "potassium_result_read", arguments: ownedArgs },
  }, firstHeaders);
  assert.equal(expiredSession.status, 404);
  await expiredSession.text();
});

test("broker negotiates lazy discovery only for the initialized retained HTTP session", { timeout: 15000 }, async (t) => {
  const broker = await createBroker(httpConfig({ statefulHttpEnabled: true }));
  t.after(() => broker.close());
  let id = 1;
  const optIn = { experimental: { "potassium/tool-discovery": { version: 1, listChanged: true } } };
  const open = async (endpoint, capabilities) => {
    const response = await httpRequest(endpoint, "POST", {
      jsonrpc: "2.0", id: id++, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "discovery-http", version: "1" } },
    }, { authorization: `Bearer ${token}` });
    await mcpJson(response);
    const sessionId = response.headers.get("mcp-session-id");
    const headers = { authorization: `Bearer ${token}`, ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
    const initialized = await httpRequest(endpoint, "POST", { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
    await initialized.text();
    return headers;
  };
  const list = async (endpoint, headers) => (await listHttpTools(endpoint, headers, id++)).tools.map((tool) => tool.name);
  const stateful = broker.streamableHttp.statefulEndpoint;
  const stateless = broker.streamableHttp.statelessEndpoint;
  const lazy = await open(stateful, optIn);
  const ordinary = await open(stateful, {});
  const statelessHeaders = await open(stateless, optIn);
  assert.deepEqual((await list(stateful, lazy)).sort(), ["potassium_result_read", "potassium_status", "potassium_tool_catalog"]);
  assert.equal((await list(stateful, ordinary)).includes("potassium_remote_inventory"), true);
  assert.equal((await list(stateless, statelessHeaders)).includes("potassium_remote_inventory"), true);
  const activated = await httpRequest(stateful, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call",
    params: { name: "potassium_tool_catalog", arguments: { enable: ["potassium_remote_inventory"], limit: 1 } },
  }, lazy);
  assert.deepEqual((await mcpJson(activated)).result.structuredContent.activated, ["potassium_remote_inventory"]);
  assert.equal((await list(stateful, lazy)).includes("potassium_remote_inventory"), true);
  const interaction = await httpRequest(stateful, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call",
    params: { name: "potassium_tool_catalog", arguments: { enable: ["potassium_interaction_inventory"], limit: 1 } },
  }, lazy);
  assert.deepEqual((await mcpJson(interaction)).result.structuredContent.activated, ["potassium_interaction_inventory"]);
  assert.equal((await list(stateful, lazy)).includes("potassium_interaction_inventory"), true);
  assert.equal((await list(stateless, statelessHeaders)).includes("potassium_interaction_inventory"), true);
});

test("same-read WebSocket cancel and immediate ID reuse deliver only the successor response", async (t) => {
  const broker = await createBroker(config());
  t.after(() => broker.close());
  const port = broker.listener.address().port;
  let connection;
  const caller = await session(port, "omp", {
    createConnection: () => {
      connection = net.connect({ host: "127.0.0.1", port });
      return connection;
    },
  });
  t.after(() => caller.terminate());
  await initialize(caller, 700);
  const replies = [];
  caller.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
  const first = once(caller, "message");
  connection.cork();
  caller.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }));
  caller.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } }));
  caller.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }));
  connection.uncork();
  assert.deepEqual(JSON.parse((await first)[0].toString()), { jsonrpc: "2.0", id: 0, result: {} });
  await request(caller, 701, "tools/list");
  assert.equal(replies.filter(({ id }) => id === 0).length, 1);
  assert.equal(caller.readyState, WebSocket.OPEN);
});

test("full discovery fits unchanged proxy frames and stateless continuation survives POST server closures", async (t) => {
  const broker = await createBroker(httpConfig({
    proxyMaxFrameBytes: 16384,
    allowUnsafeExecute: true,
    hostPolicies: { omp: { read: true, admin: true, execute: true } },
    httpPolicy: { read: true, admin: true, execute: true },
  }));
  t.after(() => broker.close());
  const socket = await session(broker.listener.address().port);
  t.after(() => socket.terminate());
  await initialize(socket, 1);
  let framePages = 0;
  const wsTools = await listAllTools(async (cursor) => {
    const response = await request(socket, 2, "tools/list", cursor === undefined ? {} : { cursor });
    assert.equal(Buffer.byteLength(JSON.stringify(response)) <= broker.config.proxyMaxFrameBytes, true);
    assert.equal(Buffer.byteLength(JSON.stringify(response.result)) <= broker.config.proxyMaxFrameBytes - 8192, true);
    framePages += 1;
    return response.result;
  });
  assert.equal(framePages > 1, true);
  const httpTools = await listHttpTools(broker.streamableHttp.statelessEndpoint, { authorization: `Bearer ${token}` });
  assert.deepEqual(httpTools.tools, wsTools.tools);
  assert.equal(new Set(wsTools.tools.map((tool) => tool.name)).size, wsTools.tools.length);
  assert.equal(wsTools.tools.some(({ name }) => name === "potassium_map_mechanics"), true);
  assert.equal(wsTools.tools.some(({ name }) => name === "potassium_map_recording"), true);
  for (const name of ["potassium_map_motion", "potassium_map_recording_read"]) assert.ok(wsTools.tools.some((tool) => tool.name === name));
});

test("session metrics isolate retained transports and label stateless HTTP aggregation without an executor", async (t) => {
  const broker = await createBroker(httpConfig({ statefulHttpEnabled: true }));
  t.after(() => broker.close());
  const stateless = broker.streamableHttp.statelessEndpoint;
  const stateful = broker.streamableHttp.statefulEndpoint;
  const headers = { authorization: `Bearer ${token}` };
  const retainedHeaders = await statefulHeaders(stateful);
  let id = 20;
  const call = async (endpoint, requestHeaders, name) => (await mcpJson(await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: {} },
  }, requestHeaders))).result;
  const status = await call(stateless, headers, "potassium_status");
  const shared = (await call(stateless, headers, "potassium_session_stats")).structuredContent;
  assert.equal(shared.scope, "broker-shared-http-policy");
  assert.equal(shared.calls, 2);
  assert.equal(shared.inFlight, 1);
  assert.equal(shared.resultBytes, Buffer.byteLength(JSON.stringify(status)));
  const retained = (await call(stateful, retainedHeaders, "potassium_session_stats")).structuredContent;
  assert.equal(retained.scope, "retained-mcp-session");
  assert.equal(retained.calls, 1);
  assert.equal(retained.resultBytes, 0);
  const socket = await session(broker.listener.address().port);
  t.after(() => socket.terminate());
  await initialize(socket, 1);
  const wsStats = (await request(socket, 2, "tools/call", { name: "potassium_session_stats", arguments: {} })).result.structuredContent;
  assert.equal(wsStats.scope, "retained-mcp-session");
  assert.equal(wsStats.calls, 1);
  assert.equal(wsStats.resultBytes, 0);
  const rejectedOrigin = await httpRequest(stateless, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "potassium_session_stats", arguments: {} },
  }, { ...headers, origin: "https://example.com" });
  assert.equal(rejectedOrigin.status, 403);
  await rejectedOrigin.text();
  const next = (await call(stateless, headers, "potassium_session_stats")).structuredContent;
  assert.equal(next.calls, 3);
  assert.equal(next.protocolErrors, 0);
  assert.equal(broker.bridge.status().connected, false);
});

test("overlong remote arguments reject before recursively validating a deeply nested seventeenth value", async (t) => {
  const broker = await createBroker(httpConfig({
    allowUnsafeExecute: true, httpPolicy: { read: true, admin: false, execute: true },
  }));
  t.after(() => broker.close());
  const depth = 1500;
  const nested = '{"type":"Array","values":['.repeat(depth) + "null" + "]}".repeat(depth);
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"potassium_remote_call","arguments":'
    + '{"target":"workspace.Echo","method":"InvokeServer","arguments":['
    + "null,".repeat(16) + nested + "]}}}";
  const response = await fetch(broker.streamableHttp.statelessEndpoint, {
    method: "POST", body,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  });
  assert.equal(response.status, 200);
  const result = (await mcpJson(response)).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta.error.code, "INVALID_INPUT");
  assert.equal(broker.bridge.status().pendingRequests, 0);
  const statsResponse = await httpRequest(broker.streamableHttp.statelessEndpoint, "POST", {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "potassium_session_stats", arguments: {} },
  }, { authorization: `Bearer ${token}` });
  const stats = (await mcpJson(statsResponse)).result.structuredContent;
  assert.equal(stats.calls, 1);
  assert.equal(stats.protocolErrors, 1);
  assert.equal(stats.inFlight, 1);
});

test("config-owned game contexts are shared offline by proxy, stateless HTTP, and retained HTTP sessions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "potassium-broker-context-"));
  const configFile = path.join(directory, "config.json");
  await writeFile(configFile, "{}");
  const seed = createGameContextService({ configFile });
  const scene = {
    schema: 2, sourceSnapshotId: "d".repeat(32), root: "workspace", place: { placeId: 123 }, player: { present: false },
    coverage: "complete", truncated: false, visited: 1, stopReasons: [], parts: [],
    facetCoverage: {
      geometry: { visited: 0, coverage: "complete", truncated: false, stopReasons: [] },
      ui: { visited: 0, coverage: "complete", truncated: false, stopReasons: [] },
      remotes: { visited: 1, coverage: "complete", truncated: false, stopReasons: [] },
    },
    ui: { coverage: "complete", truncated: false, entries: [] }, atomicSnapshot: false,
    remotes: { root: "game.ReplicatedStorage", coverage: "complete", truncated: false, entries: [
      { name: "Update", path: "game.ReplicatedStorage.Update", className: "RemoteEvent" },
    ] },
  };
  const saved = await seed.capture({ screenshot: false, map: false }, {
    client: { clientId: "c".repeat(32), generation: 1 }, isCurrent: () => true,
    clientCount: 1, imageBudget: 0, collect: async () => scene,
  });
  seed.close();
  const broker = await createBroker(httpConfig({ statefulHttpEnabled: true }), { configFile });
  const socket = await session(broker.listener.address().port);
  t.after(async () => { socket.terminate(); await broker.close(); await rm(directory, { recursive: true, force: true }); });
  await initialize(socket, 1);
  const ws = await request(socket, 2, "tools/call", { name: "potassium_game_context", arguments: { view: "read", contextId: saved.contextId } });
  assert.equal(ws.result.structuredContent.capturedAt, saved.capturedAt);
  assert.equal(ws.result.structuredContent.place.placeId, 123);
  const statelessHeaders = { authorization: `Bearer ${token}` };
  const retainedHeaders = await statefulHeaders(broker.streamableHttp.statefulEndpoint);
  let id = 10;
  const call = async (endpoint, headers, args) => (await mcpJson(await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "potassium_game_context", arguments: args },
  }, headers))).result;
  const listed = await call(broker.streamableHttp.statelessEndpoint, statelessHeaders, { view: "list" });
  assert.equal(listed.structuredContent.contexts[0].contextId, saved.contextId);
  const retained = await call(broker.streamableHttp.statefulEndpoint, retainedHeaders, { view: "read", contextId: saved.contextId, section: "remotes" });
  assert.deepEqual(retained.structuredContent.entries, scene.remotes.entries);
  assert.equal(retained.structuredContent.capturedAt, saved.capturedAt);
  const builtMap = await request(socket, 4, "tools/call", { name: "potassium_map_context", arguments: { contextIds: [saved.contextId] } });
  assert.equal(builtMap.result.isError, undefined);
  const { mapId, revision } = builtMap.result.structuredContent;
  assert.equal(revision, 1);
  const callMap = async (endpoint, headers, args, name = "potassium_map_context") => (await mcpJson(await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args },
  }, headers))).result;
  const listedMaps = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, { view: "list" });
  assert.equal(listedMaps.structuredContent.maps[0].mapId, mapId);
  const retainedMap = await callMap(broker.streamableHttp.statefulEndpoint, retainedHeaders, { view: "read", mapId });
  assert.equal(retainedMap.structuredContent.mapId, mapId);
  assert.equal(retainedMap.structuredContent.revision, revision);
  const released = await call(broker.streamableHttp.statelessEndpoint, statelessHeaders, { view: "release", contextId: saved.contextId });
  assert.equal(released.structuredContent.released, true);
  const missing = await request(socket, 3, "tools/call", { name: "potassium_game_context", arguments: { view: "read", contextId: saved.contextId } });
  assert.equal(missing.result._meta.error.code, "GAME_CONTEXT_NOT_FOUND");
  const independentMap = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, { view: "read", mapId });
  assert.equal(independentMap.structuredContent.mapId, mapId);
  const appliedMechanics = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, {
    view: "apply", mapId, supportModes: ["floor", "ceiling"], transitions: [],
  }, "potassium_map_mechanics");
  assert.equal(appliedMechanics.isError, undefined);
  const mechanicsMapId = appliedMechanics.structuredContent.mapId;
  assert.notEqual(mechanicsMapId, mapId);
  assert.equal(appliedMechanics.structuredContent.parentMapId, mapId);
  assert.equal(appliedMechanics.structuredContent.revision, 2);
  const retainedMechanics = await callMap(broker.streamableHttp.statefulEndpoint, retainedHeaders, {
    mapId: mechanicsMapId,
  }, "potassium_map_mechanics");
  assert.deepEqual(retainedMechanics.structuredContent.mechanics, { supportModes: ["floor", "ceiling"], transitions: [] });
  const proxyMechanics = await request(socket, 6, "tools/call", {
    name: "potassium_map_mechanics", arguments: { mapId: mechanicsMapId },
  });
  assert.deepEqual(proxyMechanics.result.structuredContent, retainedMechanics.structuredContent);
  const originalMechanics = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, { mapId }, "potassium_map_mechanics");
  assert.deepEqual(originalMechanics.structuredContent.mechanics, { supportModes: ["floor"], transitions: [] });
  const invalidSelector = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, {
    mapId: mechanicsMapId, clientId: "c".repeat(32),
  }, "potassium_map_mechanics");
  assert.equal(invalidSelector._meta.error.code, "INVALID_INPUT");
  const geometry = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, { mapId }, "potassium_map_geometry");
  assert.equal(geometry.isError, undefined);
  assert.deepEqual(geometry.structuredContent.entries, []);
  assert.equal(geometry.structuredContent.section, "parts");
  const navigation = await callMap(broker.streamableHttp.statefulEndpoint, retainedHeaders, { mapId }, "potassium_map_navigation");
  assert.equal(navigation.isError, undefined);
  assert.deepEqual(navigation.structuredContent.entries, []);
  assert.equal(navigation.structuredContent.section, "links");
  const releasedMap = await callMap(broker.streamableHttp.statefulEndpoint, retainedHeaders, { view: "release", mapId });
  assert.equal(releasedMap.structuredContent.released, true);
  const missingMap = await request(socket, 5, "tools/call", { name: "potassium_map_context", arguments: { view: "read", mapId } });
  assert.equal(missingMap.result._meta.error.code, "MAP_CONTEXT_NOT_FOUND");
  const stillRetained = await callMap(broker.streamableHttp.statelessEndpoint, statelessHeaders, { mapId: mechanicsMapId }, "potassium_map_mechanics");
  assert.equal(stillRetained.structuredContent.mapId, mechanicsMapId);
  assert.equal(broker.bridge.status().pendingRequests, 0);
  assert.equal(broker.bridge.status().connected, false);
});

test("one broker recorder survives transport closures and serves archived evidence after executor disconnect", async (t) => {
  const recordingId = "a".repeat(32), mapId = `map-${"b".repeat(32)}`;
  const receivedAt = "2026-09-09T12:00:00.000Z";
  let metadata = {
    recordingId, state: "recording", ready: true, clock: "client-monotonic-seconds", atomicSnapshot: false,
    acceptedAt: 10, startedAt: 10, firstSampleAt: 10, readyAt: 10, lastSampleAt: 10, now: 10,
    durationMs: 30000, intervalMs: 100, elapsedMs: 0, remainingMs: 30000,
    frameCount: 1, sampleCount: 1, eventCount: 0, markerCount: 0, missedIntervals: 0, retainedDrops: 0,
    sampleBytes: 180, eventBytes: 0, coverage: "complete", stopReasons: [],
    targets: [{ sourceSnapshotId: "d".repeat(32), sourceObjectId: "e".repeat(32), path: "Workspace.Platform",
      className: "Part", size: { x: 4, y: 1, z: 4 }, anchored: true, canCollide: true }],
  };
  let active, archived, closed = 0;
  const recorder = {
    async start(_args, options) {
      assert.equal(closed, 0);
      active = await options.collect("map_recording", { operation: "start", targets: metadata.targets.map(({ sourceSnapshotId, sourceObjectId }) => ({ sourceSnapshotId, sourceObjectId })) });
      return { operation: "start", ...active, receivedAt };
    },
    async poll(args, options) {
      assert.equal(closed, 0);
      assert.equal(active.metadata.recordingId, args.recordingId);
      return { operation: "poll", ...await options.collect("map_recording", { ...args, operation: "poll" }), receivedAt };
    },
    async stop(args, options) {
      assert.equal(closed, 0);
      active = await options.collect("map_recording", { ...args, operation: "stop" });
      return { operation: "stop", ...active, receivedAt };
    },
    async save() {
      assert.equal(closed, 0);
      assert.equal(active.metadata.state, "stopped");
      archived = { recordingId, receivedAt, client: { clientId: "c".repeat(32), generation: 1 }, metadata: active.metadata };
      return { operation: "save", mapId, revision: 2, recordingId };
    },
    async read() {
      assert.equal(closed, 0);
      return { operation: "read", mapId, revision: 2, view: "summary", recordings: [archived] };
    },
    close() { closed += 1; },
  };
  const broker = await createBroker(httpConfig({ statefulHttpEnabled: true, proxyMaxFrameBytes: 16384 }), { mapRecordingService: recorder });
  t.after(() => broker.close());
  const executor = await executorSession(t, broker);
  let collections = 0;
  executor.on("message", (payload) => {
    const message = JSON.parse(payload.toString());
    if (message.type === "ping") { executor.send(JSON.stringify({ type: "pong", nonce: message.nonce })); return; }
    let result;
    if (message.method === "capabilities") result = {
      protocol: 2, executor: "Potassium", methods: ["map_recording"], mapRecording: { version: 1 },
    };
    else {
      assert.equal(message.method, "map_recording");
      collections += 1;
      if (message.params.operation === "stop") metadata = {
        ...metadata, state: "stopped", ready: false, now: 11, stoppedAt: 11, expiresAt: 131,
        elapsedMs: 1000, remainingMs: 0, stopReasons: ["user-stop"],
      };
      result = message.params.operation === "poll"
        ? { metadata, view: "summary", cursor: 0, nextCursor: 0, hasMore: false } : { metadata };
    }
    executor.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
  });
  const socket = await session(broker.listener.address().port);
  t.after(() => socket.terminate());
  await initialize(socket, 1);
  const started = await request(socket, 2, "tools/call", { name: "potassium_map_recording", arguments: {
    operation: "start", mapId, objectIds: ["platform"], clientId: "c".repeat(32),
  } });
  assert.equal(started.result.structuredContent.metadata.ready, true);
  let id = 10;
  const call = async (endpoint, headers, args) => (await mcpJson(await httpRequest(endpoint, "POST", {
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: args.operation === "read" ? "potassium_map_recording_read" : "potassium_map_recording", arguments: args },
  }, headers))).result;
  const headers = { authorization: `Bearer ${token}` };
  const polled = await call(broker.streamableHttp.statelessEndpoint, headers, { operation: "poll", recordingId });
  assert.equal(polled.structuredContent.metadata.recordingId, recordingId);
  const retainedHeaders = await statefulHeaders(broker.streamableHttp.statefulEndpoint);
  const stopped = await call(broker.streamableHttp.statefulEndpoint, retainedHeaders, { operation: "stop", recordingId });
  assert.equal(stopped.structuredContent.metadata.ready, false);
  assert.equal(stopped.structuredContent.metadata.expiresAt, 131);
  const saved = await call(broker.streamableHttp.statelessEndpoint, headers, { operation: "save", mapId, recordingId });
  assert.equal(saved.structuredContent.revision, 2);
  const disconnected = once(broker.bridge, "disconnected");
  executor.close();
  await disconnected;
  for (const endpoint of [broker.streamableHttp.statelessEndpoint, broker.streamableHttp.statefulEndpoint]) {
    const result = await call(endpoint, endpoint === broker.streamableHttp.statelessEndpoint ? headers : retainedHeaders, { operation: "read", mapId });
    assert.deepEqual(result.structuredContent.recordings, [archived]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  }
  const proxyRead = await request(socket, 3, "tools/call", { name: "potassium_map_recording_read", arguments: { operation: "read", mapId } });
  assert.deepEqual(proxyRead.result.structuredContent.recordings, [archived]);
  assert.equal(collections, 3);
  assert.equal(closed, 0, "closing stateless requests must not close the broker-owned recorder");
  await broker.close();
  await broker.close();
  assert.equal(closed, 1);
});

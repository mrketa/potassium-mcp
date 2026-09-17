import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { z } from "zod";
import WebSocket from "ws";
import { createServer, createToolServer, formatToolResult, loadConfig, parseConfig } from "../src/server.js";
import { AdminAuditRecorder } from "../src/admin-audit.js";
import { createCompactResultStore } from "../src/compact-results.js";
import { createCodeIndexService } from "../src/code-index.js";
import { createGameContextService } from "../src/game-context.js";
import { createMapContextService } from "../src/map-context.js";
import { analyzeNativeSourcePackage } from "../src/code-tree-adapter.js";
import { listAllTools } from "./helpers/list-tools.js";
import { parseAuthoredModules } from "./helpers/code-parser.js";
import { createNativeEditorClient, NativeEditorError } from "../src/native-editor.js";

const testToken = "test-token-that-is-longer-than-thirty-two-characters";

const testProtocol = 2;

function testProof(role, clientNonce, serverNonce) {
  const transcript = `potassium-mcp/v${testProtocol}|${role}|${clientNonce}|${serverNonce}`;
  const transcriptHash = createHash("sha256").update(transcript, "utf8").digest("hex");
  return createHmac("sha256", testToken).update(transcriptHash, "utf8").digest("base64");
}

async function authenticate(socket, identity = {}) {
  const clientNonce = randomBytes(32).toString("hex");
  const clientId = identity.clientId ?? randomBytes(16).toString("hex");
  const generation = identity.generation ?? 1;
  socket.send(JSON.stringify({
    type: "hello",
    protocol: testProtocol,
    clientId,
    generation,
    clientNonce,
    client: { executor: "Potassium", protocol: testProtocol },
  }));
  const [challengePayload] = await once(socket, "message");
  const challenge = JSON.parse(challengePayload.toString());
  assert.equal(challenge.proof, testProof("server", clientNonce, challenge.serverNonce));
  socket.send(JSON.stringify({
    type: "ack",
    protocol: testProtocol,
    clientNonce,
    serverNonce: challenge.serverNonce,
    proof: testProof("client", clientNonce, challenge.serverNonce),
  }));
  const [readyPayload] = await once(socket, "message");
  assert.deepEqual(JSON.parse(readyPayload.toString()), {
    type: "ready",
    protocol: testProtocol,
    clientNonce,
    serverNonce: challenge.serverNonce,
    clientId,
    generation,
  });
  return { clientId, generation };
}

function baseConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    token: testToken,
    requestTimeoutMs: 100,
    maxMessageBytes: 65536,
    maxPendingRequests: 8,
    shutdownGraceMs: 1000,
    ...overrides,
  };
}

const featureCapabilities = {
  protocol: 2, executor: "Potassium", version: "fixture",
  methods: [
    "execute_luau_async", "async_job_status", "async_job_result", "async_job_console",
    "async_job_list", "async_job_cancel", "batch_read", "instance_references_release",
    "list_children", "read_properties", "watch_start", "watch_poll", "watch_stop",
    "remote_inventory", "remote_capture_start", "remote_capture_poll", "remote_capture_stop",
    "remote_call", "observe_action", "diagnostic_snapshot", "game_context", "map_observe", "map_probe", "map_recording",
    "interaction_inventory", "interaction_call",
  ],
  asyncJobs: { version: 2 }, batchRead: { version: 1 },
  instanceReferences: { version: 1 }, watches: { version: 1 },
  remoteInventory: { version: 4 }, remoteCapture: { version: 2, available: true }, gameContext: { version: 2 }, mapObservation: { version: 1 },
  remoteActions: { version: 1 }, actionObservation: { version: 1 }, diagnosticSnapshot: { version: 2 },
  mapRecording: { version: 1 },
  interactionInventory: { version: 1 }, interactionActions: { version: 1 },
};

function captureReceipt(overrides = {}) {
  return {
    captureId: "d".repeat(32), generation: 1, state: "active",
    coverage: "selected-outbound-namecall-only", directions: ["outbound"], recordsValues: false, recordsReturns: false,
    incomingCalls: false, incomingRemoteFunctions: false, directMethodCalls: false, nativeSemanticsVerified: false,
    unsupportedInboundTargets: [], observed: 0, retained: 0, bufferedBytes: 2048,
    byteAccounting: "conservative-metadata-bound", expiresInMs: 5000,
    dropped: { events: 0, shapes: 0, observationErrors: 0, examples: 0 },
    exampleSampling: { attempts: 0, maxAttempts: 200, truncated: false },
    ...overrides,
  };
}

function detailReceipt(overrides = {}) {
  return {
    view: "detail", generation: 1,
    instance: { name: "Echo", className: "RemoteEvent", path: "Workspace.Echo" },
    metadataTiming: "live-non-atomic", associationMeaning: "metadata-not-call-arguments",
    attributes: { ok: true, values: [{ name: "Enabled", ok: true, value: false }], total: 1, truncated: false },
    valueAssociations: { children: [], siblings: [], siblingsRequested: false, siblingMeaning: "shared-parent-only" },
    visited: 0, truncated: false, coverage: "complete", stopReasons: [],
    ...overrides,
  };
}

function interactionRowReceipt(overrides = {}) {
  return {
    id: "f".repeat(32), kind: "click", name: "Switch", className: "ClickDetector",
    path: "Workspace.Panel.Switch", parent: "Workspace.Panel",
    host: { name: "Panel", className: "Part", path: "Workspace.Panel" },
    properties: [{ name: "MaxActivationDistance", ok: true, value: 0 }, { name: "CursorIcon", ok: true, value: "" }],
    position: { ok: true, value: { type: "Vector3", x: 3, y: 4, z: 0 } }, positionSource: "base-part-position",
    distanceStuds: { ok: true, value: 5 },
    ...overrides,
  };
}

function interactionSnapshotReceipt(overrides = {}) {
  return {
    view: "summary", snapshotId: "e".repeat(32), generation: 1,
    root: { name: "Workspace", className: "Workspace", path: "Workspace" },
    observedAt: 12.5, visited: 2, matchedVisited: 1, retained: 1,
    coverage: "complete", truncated: false, stopReasons: [], expiresInMs: 120000,
    counts: { click: 1, prompt: 0, touch: 0 }, touchCoverage: "observed-transmitters-not-exhaustive",
    ...overrides,
  };
}

async function receiveFeatureRequest(socket) {
  const [probePayload] = await once(socket, "message");
  const probe = JSON.parse(probePayload.toString());
  assert.equal(probe.method, "capabilities");
  socket.send(JSON.stringify({ type: "response", id: probe.id, ok: true, result: featureCapabilities }));
  const [payload] = await once(socket, "message");
  return JSON.parse(payload.toString());
}

async function connectToolFixture(t, {
  config = {}, policy, audit, artifactStore, compactResultStore, resultScopeId, releaseResultScopeOnClose, retainedSession,
  codeIndexService, gameContextService, mapContextService, mapRecordingService, sessionStats, releaseSessionStatsOnClose, nativeEditor,
  clients = [{ clientId: "c".repeat(32), generation: 1, client: { executor: "Potassium", protocol: 2 } }],
  capabilities = () => featureCapabilities,
  request = async () => ({ ok: true }),
  client = new Client({ name: "tool-contract-test", version: "1.0.0" }),
} = {}) {
  const requests = [];
  const bridge = {
    status: () => ({ connected: clients.length > 0, clients, pendingRequests: 0, recoveryGeneration: 0, recovering: false }),
    listClients: () => clients,
    getClientInfo(clientId) {
      if (clients.length === 0) throw new Error("Potassium is not connected");
      if (clientId === undefined && clients.length !== 1) throw new Error("Potassium client selection required");
      const selected = clientId === undefined ? clients[0] : clients.find((client) => client.clientId === clientId);
      if (!selected) throw new Error("Potassium client is not connected");
      return selected.client;
    },
    recover: () => ({ recovered: true }),
    async request(method, params, timeoutMs, clientId, signal) {
      requests.push({ method, params, clientId });
      return method === "capabilities" ? capabilities(clientId) : request(method, params, clientId, signal);
    },
  };
  const server = createToolServer(await parseConfig(baseConfig(config)), bridge, {
    policy, audit, artifactStore, compactResultStore, resultScopeId, releaseResultScopeOnClose, retainedSession,
    codeIndexService, gameContextService, mapContextService, mapRecordingService, sessionStats, releaseSessionStatsOnClose, nativeEditor,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, requests };
}

const editorConfig = { nativeEditorEnabled: true, nativeEditorTokenFile: resolve("private-editor-token") };
const editorDigest = (content) => createHash("sha256").update(content, "utf8").digest("hex");
function editorFixture(content = "") {
  const tabs = new Map([["original", {
    tab: { id: "original", title: "Original", kind: "script", dirty: false, active: true, pinned: false }, content,
  }]]);
  let counter = 0;
  const requireTab = (id) => {
    const entry = tabs.get(id);
    if (!entry) throw new NativeEditorError("refused", "Tab not found.");
    return entry;
  };
  const nativeEditor = {
    async listTabs() { return { tabs: [...tabs.values()].map(({ tab }) => ({ ...tab })) }; },
    async readTab({ id }) {
      const entry = requireTab(id);
      return { tab: { ...entry.tab }, content: entry.content, sha256: editorDigest(entry.content) };
    },
    async openTab({ title = "", content = "" }) {
      for (const entry of tabs.values()) entry.tab.active = false;
      const tab = { id: `draft-${++counter}`, title, kind: "script", dirty: content !== "", active: true, pinned: false };
      tabs.set(tab.id, { tab, content });
      return { tab: { ...tab } };
    },
    async writeTab({ id, content, expectedSha256 }) {
      const entry = requireTab(id);
      if (editorDigest(entry.content) !== expectedSha256) throw new NativeEditorError("conflict", "Content changed.");
      entry.content = content;
      entry.tab.dirty = true;
      return { tab: { ...entry.tab }, sha256: editorDigest(content), preconditionAtomic: false };
    },
    async activateTab({ id }) {
      const entry = requireTab(id);
      for (const row of tabs.values()) row.tab.active = row === entry;
      return { tab: { ...entry.tab } };
    },
    async closeTab({ id }) {
      if (requireTab(id).tab.dirty) throw new NativeEditorError("refused", "Dirty tab.");
      tabs.delete(id);
      return { id, closed: true };
    },
  };
  return nativeEditor;
}

test("native desktop tools work with no Roblox client or ambiguous clients and preserve exact script reads", async (t) => {
  for (const clients of [[], [
    { clientId: "a".repeat(32), generation: 1, client: {} },
    { clientId: "b".repeat(32), generation: 1, client: {} },
  ]]) {
    await t.test(`clients ${clients.length}`, async (t) => {
      const { client, requests } = await connectToolFixture(t, {
        config: { ...editorConfig, allowUnsafeExecute: true }, clients, nativeEditor: editorFixture(),
      });
      const tools = (await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined))).tools;
      const editorTools = tools.filter(({ name }) => name.startsWith("potassium_editor_"));
      assert.equal(editorTools.length, 6);
      for (const tool of editorTools) {
        assert.equal("clientId" in tool.inputSchema.properties, false);
        assert.equal(tool.annotations.readOnlyHint, /_(?:list_tabs|read_tab)$/.test(tool.name));
      }
      const call = (name, args = {}) => client.callTool({ name: `potassium_editor_${name}`, arguments: args });
      assert.deepEqual((await call("list_tabs")).structuredContent.tabs.map(({ id }) => id), ["original"]);
      const source = `-- token-like-string-not-the-broker-token\r\nlocal password = "snow 雪😀"\0\nreturn password`;
      const opened = await call("open_tab", { title: "Draft", content: source });
      assert.equal(opened.structuredContent.tab.active, true);
      assert.equal("content" in opened.structuredContent, false);
      const id = opened.structuredContent.tab.id;
      const read = await call("read_tab", { id });
      assert.equal(read.structuredContent.content, source);
      assert.equal(read.structuredContent.sha256, editorDigest(source));
      const replacement = "return 'replacement'\r\n";
      const written = await call("write_tab", { id, content: replacement, expectedSha256: read.structuredContent.sha256 });
      assert.equal(written.structuredContent.sha256, editorDigest(replacement));
      assert.equal(written.structuredContent.preconditionAtomic, false);
      assert.equal("content" in written.structuredContent, false);
      assert.equal((await call("read_tab", { id })).structuredContent.content, replacement);
      assert.equal((await call("activate_tab", { id: "original" })).structuredContent.tab.active, true);
      const refused = await call("close_tab", { id });
      assert.equal(refused._meta.error.code, "NATIVE_EDITOR_REFUSED");
      assert.deepEqual((await call("close_tab", { id: "original" })).structuredContent, { id: "original", closed: true });
      assert.deepEqual(requests, [], "desktop actions must not probe or dispatch to Roblox");
    });
  }
});

test("native editor input bounds and required hash reject before service dispatch", async (t) => {
  let calls = 0;
  const nativeEditor = Object.fromEntries(["listTabs", "readTab", "openTab", "writeTab", "activateTab", "closeTab"]
    .map((name) => [name, async () => { calls += 1; throw new Error("must not dispatch"); }]));
  const { client } = await connectToolFixture(t, {
    config: { ...editorConfig, allowUnsafeExecute: true }, nativeEditor, clients: [],
  });
  for (const [name, arguments_] of [
    ["list_tabs", { clientId: "a".repeat(32) }],
    ["read_tab", { id: "" }],
    ["activate_tab", { id: "x".repeat(257) }],
    ["close_tab", {}],
    ["open_tab", { title: "x".repeat(1025) }],
    ["open_tab", { content: "😀".repeat(65537) }],
    ["write_tab", { id: "original", content: "" }],
    ["write_tab", { id: "original", content: "", expectedSha256: "A".repeat(64) }],
    ["write_tab", { id: "original", content: "", expectedSha256: `${"a".repeat(64)}\n` }],
    ["write_tab", { id: "original", content: "é".repeat(131073), expectedSha256: "a".repeat(64) }],
  ]) assert.equal((await client.callTool({ name: `potassium_editor_${name}`, arguments: arguments_ })).isError, true);
  assert.equal(calls, 0);
});

test("disabled native editor does not expose desktop tools or remove execution tools", async (t) => {
  const { client } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true }, nativeEditor: editorFixture(),
  });
  const names = (await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined))).tools.map(({ name }) => name);
  assert.equal(names.some((name) => name.startsWith("potassium_editor_")), false);
  for (const name of ["potassium_execute_luau", "potassium_execute_luau_async", "potassium_remote_call"]) assert.equal(names.includes(name), true);
});

test("native editor errors never echo service bodies and malformed mutation receipts remain indeterminate", async (t) => {
  const secret = `private-script ${testToken} private-editor-token`;
  const nativeEditor = editorFixture();
  nativeEditor.listTabs = async () => { throw new Error(secret); };
  nativeEditor.readTab = async () => { throw new NativeEditorError("too-large", secret); };
  nativeEditor.openTab = async () => { throw new Error(secret); };
  nativeEditor.writeTab = async () => { throw new NativeEditorError("conflict", secret); };
  nativeEditor.activateTab = async () => ({ tab: { content: secret } });
  nativeEditor.closeTab = async () => ({ toJSON() { throw new Error(secret); } });
  const { client, server } = await connectToolFixture(t, {
    config: { ...editorConfig, allowUnsafeExecute: true }, nativeEditor,
  });
  for (const [name, args, code, indeterminate] of [
    ["list_tabs", {}, "UNAVAILABLE", false],
    ["read_tab", { id: "original" }, "TOO_LARGE", false],
    ["open_tab", {}, "INDETERMINATE", true],
    ["write_tab", { id: "original", content: "private-script replacement", expectedSha256: "a".repeat(64) }, "CONFLICT", false],
    ["activate_tab", { id: "original" }, "INDETERMINATE", true],
    ["close_tab", { id: "original" }, "INDETERMINATE", true],
  ]) {
    const result = await client.callTool({ name: `potassium_editor_${name}`, arguments: args });
    assert.equal(result._meta.error.code, `NATIVE_EDITOR_${code}`);
    assert.equal(result._meta.error.submissionIndeterminate, indeterminate);
    assert.equal(JSON.stringify(result).includes("private-script"), false);
    assert.equal(JSON.stringify(result).includes(testToken), false);
  }
  assert.equal(JSON.stringify(server.sessionStats.snapshot()).includes("private-script"), false);
});

test("retained editor text stays exact and read-permission bound without script-bearing statistics or audit", async (t) => {
  const source = `-- token-like-string-not-the-broker-token\r\nlocal path = "${editorConfig.nativeEditorTokenFile}"\nlocal secret = "private-editor-source 雪😀"\n`.repeat(200);
  const nativeEditor = editorFixture(source);
  const audit = new AdminAuditRecorder();
  const { client, server } = await connectToolFixture(t, {
    config: { ...editorConfig, allowUnsafeExecute: true }, nativeEditor, audit, clients: [],
  });
  const result = await client.callTool({ name: "potassium_editor_read_tab", arguments: { id: "original" } });
  assert.equal(result.structuredContent.kind, "potassium/result");
  const resultId = result.structuredContent.resultId;
  let json = "", offsetBytes = 0;
  for (;;) {
    const response = await client.callTool({ name: "potassium_result_read", arguments: { resultId, view: "text", offsetBytes, maxBytes: 4096 } });
    const page = response.structuredContent;
    assert.equal(page.toolName, "potassium_editor_read_tab");
    json += page.text;
    if (!page.hasMore) break;
    offsetBytes = page.nextOffsetBytes;
  }
  assert.equal(JSON.parse(json).content, source);
  assert.equal(JSON.parse(json).sha256, editorDigest(source));
  const statistics = await client.callTool({ name: "potassium_session_stats", arguments: {} });
  for (const text of [JSON.stringify(statistics), JSON.stringify(server.sessionStats.snapshot()), JSON.stringify(audit.history(100))]) {
    assert.equal(text.includes("private-editor-source"), false);
    assert.equal(text.includes(testToken), false);
  }
  server.policy = { read: false, admin: true, execute: true };
  const denied = await client.callTool({ name: "potassium_result_read", arguments: { resultId } });
  assert.equal(denied._meta.error.code, "RESULT_ORIGIN_DENIED");
});

test("actual broker credentials are refused without mutating or retaining editor script text", async (t) => {
  let writes = 0, reads = 0;
  const nativeEditor = editorFixture(`local password = "${testToken}"`);
  const readTab = nativeEditor.readTab;
  nativeEditor.readTab = async (args) => { reads += 1; return readTab(args); };
  nativeEditor.openTab = nativeEditor.writeTab = async () => { writes += 1; throw new Error("must not dispatch"); };
  const { client, server } = await connectToolFixture(t, {
    config: { ...editorConfig, allowUnsafeExecute: true }, nativeEditor,
    compactResultStore: { put() { assert.fail("Protected content must not enter retention"); }, releaseScope() {} },
  });
  for (const [name, args] of [
    ["read_tab", { id: "original" }],
    ["open_tab", { content: `return "${testToken}"` }],
    ["open_tab", { title: testToken }],
    ["write_tab", { id: "original", content: testToken, expectedSha256: "a".repeat(64) }],
  ]) {
    const result = await client.callTool({ name: `potassium_editor_${name}`, arguments: args });
    assert.equal(result._meta.error.code, "EDITOR_SENSITIVE_CONTENT");
    assert.equal(result._meta.error.submissionIndeterminate, false);
    assert.equal(JSON.stringify(result).includes(testToken), false);
  }
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(server.sessionStats.snapshot()).includes(testToken), false);
});

test("standalone server exposes configured native editor without connecting a Roblox client", async (t) => {
  const lifecycle = await createServer(baseConfig({ ...editorConfig, allowUnsafeExecute: true }), { nativeEditor: editorFixture("return 17") });
  t.after(() => lifecycle.close());
  const client = new Client({ name: "standalone-editor-test", version: "1" });
  t.after(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await lifecycle.server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal(lifecycle.bridge.status().connected, false);
  const read = await client.callTool({ name: "potassium_editor_read_tab", arguments: { id: "original" } });
  assert.equal(read.structuredContent.content, "return 17");
});

test("standalone native editor construction is lazy and does not disable existing execution", async (t) => {
  const lifecycle = await createServer(baseConfig({ ...editorConfig, allowUnsafeExecute: true }));
  t.after(() => lifecycle.close());
  const client = new Client({ name: "standalone-editor-construction", version: "1" });
  t.after(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await lifecycle.server.connect(serverTransport);
  await client.connect(clientTransport);
  const names = (await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined))).tools.map(({ name }) => name);
  assert.equal(names.filter((name) => name.startsWith("potassium_editor_")).length, 6);
  for (const name of ["potassium_execute_luau", "potassium_execute_luau_async", "potassium_remote_call"]) assert.equal(names.includes(name), true);
});

test("successful editor mutation followed by retention failure is never reported as safe to retry", async (t) => {
  let calls = 0;
  const nativeEditor = editorFixture();
  const openTab = nativeEditor.openTab;
  nativeEditor.openTab = async () => { calls += 1; return openTab({ title: "x".repeat(1024) }); };
  const { client } = await connectToolFixture(t, {
    config: { ...editorConfig, allowUnsafeExecute: true, maxMessageBytes: 1024 }, nativeEditor,
    compactResultStore: {
      put() { throw new Error("private mutation result storage failure"); },
      releaseScope() {},
    },
  });
  const response = await client.callTool({ name: "potassium_editor_open_tab", arguments: {} });
  assert.equal(response._meta.error.code, "NATIVE_EDITOR_INDETERMINATE");
  assert.equal(response._meta.error.submissionIndeterminate, true);
  assert.equal(JSON.stringify(response).includes("private mutation"), false);
  assert.equal(calls, 1);
});

test("SDK cancellation removes a queued shared-editor write without blocking another agent's execution", { timeout: 5000 }, async (t) => {
  let content = "original", releaseWrite, signalWrite, signalQueued, signalCancelled, signalSettled;
  const heldWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  const queued = new Promise((resolve) => { signalQueued = resolve; });
  const cancelled = new Promise((resolve) => { signalCancelled = resolve; });
  const settled = new Promise((resolve) => { signalSettled = resolve; });
  t.after(() => releaseWrite());
  const writes = [];
  const tab = { id: "shared", title: "Draft", kind: "script", dirty: false, active: true, pinned: false };
  const editor = createNativeEditorClient({
    tokenFile: "unused-native-token", readToken: async () => "n".repeat(64),
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      let result;
      if (request.method === "initialize") result = { protocolVersion: "2025-06-18" };
      else if (request.method === "tools/list") result = { tools: [{ name: "tabs" }] };
      else {
        assert.equal(request.method, "tools/call");
        assert.equal(request.params.name, "tabs");
        const args = request.params.arguments;
        if (args.action === "read") result = { structuredContent: { message: "read", tab: { ...tab }, content }, content: [] };
        else {
          assert.equal(args.action, "write");
          writes.push(args.content);
          signalWrite();
          await heldWrite;
          content = args.content;
          tab.dirty = true;
          result = { structuredContent: { message: "written", tab: { ...tab } }, content: [] };
        }
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
    },
  });
  const nativeEditor = Object.fromEntries(["listTabs", "readTab", "openTab", "writeTab", "activateTab", "closeTab"]
    .map((method) => [method, editor[method].bind(editor)]));
  nativeEditor.writeTab = (args, options) => {
    const operation = editor.writeTab(args, options);
    if (args.content === "cancelled-overwrite") {
      options.signal.addEventListener("abort", signalCancelled, { once: true });
      signalQueued();
      operation.then(signalSettled, signalSettled);
    }
    return operation;
  };
  const fixtureOptions = {
    config: { ...editorConfig, allowUnsafeExecute: true }, nativeEditor,
    policy: { read: true, admin: false, execute: true },
    request: async () => ({ count: 1, values: [42] }),
  };
  const first = await connectToolFixture(t, fixtureOptions);
  const second = await connectToolFixture(t, fixtureOptions);
  const writing = first.client.callTool({
    name: "potassium_editor_write_tab", arguments: { id: "shared", content: "first-write", expectedSha256: editorDigest("original") },
  });
  await writeStarted;
  const controller = new AbortController();
  const pending = second.client.callTool({
    name: "potassium_editor_write_tab",
    arguments: { id: "shared", content: "cancelled-overwrite", expectedSha256: editorDigest("first-write") },
  }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await queued;
  controller.abort();
  await rejected;
  await cancelled;
  const executed = await second.client.callTool({ name: "potassium_execute_luau", arguments: { code: "return 42" } });
  assert.deepEqual(executed.structuredContent.values, [42]);
  releaseWrite();
  assert.equal((await writing).structuredContent.sha256, editorDigest("first-write"));
  await settled;
  const read = await second.client.callTool({ name: "potassium_editor_read_tab", arguments: { id: "shared" } });
  assert.equal(read.structuredContent.content, "first-write");
  assert.deepEqual(writes, ["first-write"]);
  const resumed = await second.client.callTool({
    name: "potassium_editor_write_tab", arguments: { id: "shared", content: "resumed", expectedSha256: editorDigest("first-write") },
  });
  assert.equal(resumed.structuredContent.sha256, editorDigest("resumed"));
  assert.deepEqual(writes, ["first-write", "resumed"]);
});

test("rejects invalid config bounds and conflicting token sources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "token.txt"), testToken);

  for (const [name, config] of [
    ["non-loopback host", baseConfig({ host: "0.0.0.0" })],
    ["port below range", baseConfig({ port: -1 })],
    ["port above range", baseConfig({ port: 65536 })],
    ["zero timeout", baseConfig({ requestTimeoutMs: 0 })],
    ["small message limit", baseConfig({ maxMessageBytes: 1023 })],
    ["zero pending requests", baseConfig({ maxPendingRequests: 0 })],
    ["short shutdown grace", baseConfig({ shutdownGraceMs: 99 })],
    ["both token sources", baseConfig({ tokenFile: "token.txt" })],
    ["short token", baseConfig({ token: "x".repeat(31) })],
    ["unexpected field", baseConfig({ unexpected: true })],
    ["missing token source", baseConfig({ token: undefined })],
  ]) {
    const configPath = join(directory, `${name.replaceAll(" ", "-")}.json`);
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(() => loadConfig(configPath), /Invalid configuration/);
  }

  const maximumsPath = join(directory, "maximums.json");
  await writeFile(maximumsPath, JSON.stringify(baseConfig({
    host: "::1",
    port: 65535,
    requestTimeoutMs: 120000,
    maxMessageBytes: 16 * 1024 * 1024,
    maxPendingRequests: 1024,
    shutdownGraceMs: 30000,
  })));
  const maximums = await loadConfig(maximumsPath);
  assert.equal(maximums.port, 65535);
  assert.equal(maximums.maxPendingRequests, 1024);
});


test("resolves and trims a relative token file without retaining its path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "token.txt"), `  ${testToken} \n`);
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(baseConfig({
    token: undefined,
    tokenFile: "token.txt",
  })));

  const config = await loadConfig(configPath);
  assert.equal(config.token, testToken);
  assert.equal("tokenFile" in config, false);
});


test("keeps redacted admin execution history bounded", async () => {
  const audit = new AdminAuditRecorder();
  const bridge = { status: () => ({ client: { executor: "Potassium", protocol: 2 } }) };
  const timeout = audit.begin({ code: "secret source", bridge, sessionId: "session" });
  await audit.finish(timeout, "timeout", new Error("Potassium request timed out after 1 ms"));
  assert.equal(audit.history(1)[0].outcome, "timeout");
  assert.equal(audit.history(1)[0].errorClass, "timeout");
  assert.equal(audit.history(1)[0].mode, "sync");
  const failed = audit.begin({ code: "bad source", bridge, sessionId: "session" });
  await audit.finish(failed, "error", new Error("executor rejected request"));
  assert.equal(audit.history(1)[0].outcome, "error");
  assert.equal(audit.history(1)[0].errorClass, "error");
  for (let index = 0; index < 100; index += 1) {
    await audit.finish(audit.begin({ code: `return ${index}`, bridge, sessionId: "session" }), "success");
  }
  const entries = audit.history(100);
  assert.equal(entries.length, 100);
  assert.equal(entries[0].outcome, "success");
  assert.equal(entries.some((entry) => entry.code === "secret source" || Object.hasOwn(entry, "result")), false);
  assert.equal(entries.some((entry) => entry.errorClass === "timeout"), false);
  const asyncOperation = audit.begin({
    code: "async secret source",
    bridge,
    sessionId: "session",
    mode: "async",
    executorJobId: "a".repeat(32),
    hostId: "omp",
    client: { executor: "Potassium", protocol: 2, placeId: 123 },
  });
  await audit.finish(asyncOperation, "success");
  const asyncEntry = audit.history(1)[0];
  assert.equal(asyncEntry.mode, "async");
  assert.equal(asyncEntry.hostId, "omp");
  assert.equal(asyncEntry.client.placeId, 123);
  assert.equal(asyncEntry.executorJobId, "a".repeat(32));
  assert.equal(JSON.stringify(asyncEntry).includes("async secret source"), false);
});

const serverPath = process.env.POTASSIUM_MCP_TEST_SERVER ?? resolve("src/server.js");

test("completes MCP initialization with the bounded public tool set", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mcp-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(baseConfig()));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, POTASSIUM_MCP_CONFIG: configPath },
    stderr: "inherit",
  });
  const client = new Client({ name: "potassium-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);

  const tools = await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.equal(names.includes("potassium_status"), true);
  assert.equal(names.includes("potassium_remote_inventory"), true);
  assert.equal(names.includes("potassium_game_context"), true);
  for (const name of ["potassium_map_context", "potassium_map_geometry", "potassium_map_navigation", "potassium_map_motion", "potassium_map_mechanics", "potassium_map_recording", "potassium_map_recording_read"]) assert.equal(names.includes(name), true);
  assert.equal(names.includes("potassium_result_read"), true);
  assert.equal(names.includes("potassium_tool_catalog"), true);
  assert.equal(names.includes("potassium_execute_luau"), false);
  assert.equal(names.includes("potassium_remote_capture_start"), false);
  for (const tool of tools.tools) {
    assert.equal(tool.outputSchema.type, "object");
    assert.deepEqual(tool.annotations, {
      readOnlyHint: ![
        "potassium_watch_start", "potassium_watch_stop", "potassium_batch_read",
        "potassium_find_instances", "potassium_list_children", "potassium_inspect_instance",
        "potassium_instance_references_release", "potassium_remote_inventory", "potassium_interaction_inventory",
        "potassium_admin_recover", "potassium_tool_catalog",
        "potassium_code_index", "potassium_code_query", "potassium_diagnostic_snapshot", "potassium_game_context", "potassium_map_context", "potassium_map_mechanics", "potassium_map_recording",
      ].includes(tool.name),
      destructiveHint: tool.name === "potassium_admin_recover",
      idempotentHint: !["potassium_watch_start", "potassium_admin_recover", "potassium_remote_inventory", "potassium_interaction_inventory", "potassium_code_index", "potassium_game_context", "potassium_map_context", "potassium_map_mechanics", "potassium_map_recording"].includes(tool.name),
      openWorldHint: ["potassium_http_get", "potassium_place_metadata"].includes(tool.name),
    });
  }

  const result = await client.callTool({ name: "potassium_status", arguments: {} });
  assert.equal(result.isError, undefined);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.connected, false);
  assert.match(status.endpoint, /^ws:\/\/127\.0\.0\.1:/);

  const disconnected = await client.callTool({ name: "potassium_capabilities", arguments: {} });
  assert.equal(disconnected.isError, true);
});

test("exposes and forwards unrestricted Luau only when explicitly enabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mcp-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(baseConfig({ allowUnsafeExecute: true, requestTimeoutMs: 2000 })));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, POTASSIUM_MCP_CONFIG: configPath },
    stderr: "inherit",
  });
  const client = new Client({ name: "potassium-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);

  const tools = await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
  const execute = tools.tools.find((tool) => tool.name === "potassium_execute_luau");
  const executeAsync = tools.tools.find((tool) => tool.name === "potassium_execute_luau_async");
  const asyncStatus = tools.tools.find((tool) => tool.name === "potassium_async_job_status");
  const asyncResult = tools.tools.find((tool) => tool.name === "potassium_async_job_result");
  assert.ok(executeAsync);
  assert.ok(asyncStatus);
  assert.ok(asyncResult);
  assert.equal(executeAsync.inputSchema.additionalProperties, false);
  assert.equal(asyncStatus.inputSchema.additionalProperties, false);
  const asyncConsole = tools.tools.find((tool) => tool.name === "potassium_async_job_console");
  assert.ok(asyncConsole);
  assert.equal(asyncConsole.inputSchema.additionalProperties, false);
  assert.ok(execute);
  assert.deepEqual(execute.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  const adminStatus = tools.tools.find((tool) => tool.name === "potassium_admin_status");
  const adminHistory = tools.tools.find((tool) => tool.name === "potassium_admin_history");
  const adminRecover = tools.tools.find((tool) => tool.name === "potassium_admin_recover");
  assert.ok(adminStatus);
  assert.ok(adminHistory);
  assert.ok(adminRecover);
  assert.deepEqual(adminStatus.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(adminRecover.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });

  const status = JSON.parse((await client.callTool({ name: "potassium_status", arguments: {} })).content[0].text);
  const socket = new WebSocket(status.endpoint);
  t.after(() => socket.close());
  await once(socket, "open");
  await authenticate(socket);

  const resultPromise = client.callTool({
    name: "potassium_execute_luau",
    arguments: { code: "return 6 * 7" },
  });
  const [payload] = await once(socket, "message");
  const request = JSON.parse(payload.toString());
  assert.equal(request.method, "execute_luau");
  assert.deepEqual(request.params, { code: "return 6 * 7" });
  socket.send(JSON.stringify({
    type: "response",
    id: request.id,
    ok: true,
    result: { count: 1, values: [42] },
  }));
  const result = await resultPromise;
  assert.equal(result.content[0].text, "{\"count\":1,\"values\":[42]}");
  const history = JSON.parse((await client.callTool({
    name: "potassium_admin_history",
    arguments: { limit: 1 },
  })).content[0].text);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].outcome, "success");
  assert.equal(history.entries[0].mode, "sync");
  assert.equal(history.entries[0].utf8Bytes, Buffer.byteLength("return 6 * 7"));
  assert.match(history.entries[0].codeSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(history).includes("return 6 * 7"), false);
  assert.equal(Object.hasOwn(history.entries[0], "result"), false);
  const jobId = "a".repeat(32);
  const submitPromise = client.callTool({
    name: "potassium_execute_luau_async",
    arguments: { code: "return task.wait()" },
  });
  const submitRequest = await receiveFeatureRequest(socket);
  assert.equal(submitRequest.method, "execute_luau_async");
  assert.deepEqual(submitRequest.params, { code: "return task.wait()" });
  socket.send(JSON.stringify({
    type: "response",
    id: submitRequest.id,
    ok: true,
    result: { jobId, state: "queued" },
  }));
  const submitResult = await submitPromise;
  assert.deepEqual(submitResult.structuredContent, { jobId, state: "queued" });
  const statusPromise = client.callTool({
    name: "potassium_async_job_status",
    arguments: { jobId },
  });
  const statusRequest = await receiveFeatureRequest(socket);
  assert.equal(statusRequest.method, "async_job_status");
  assert.deepEqual(statusRequest.params, { jobId });
  socket.send(JSON.stringify({
    type: "response",
    id: statusRequest.id,
    ok: true,
    result: { jobId, state: "running", submittedAt: "2026-01-01T00:00:00.000Z" },
  }));
  assert.equal((await statusPromise).structuredContent.state, "running");
  const asyncResultPromise = client.callTool({
    name: "potassium_async_job_result",
    arguments: { jobId },
  });
  const asyncResultRequest = await receiveFeatureRequest(socket);
  assert.equal(asyncResultRequest.method, "async_job_result");
  assert.deepEqual(asyncResultRequest.params, { jobId });
  socket.send(JSON.stringify({
    type: "response",
    id: asyncResultRequest.id,
    ok: true,
    result: { jobId, state: "succeeded", ready: true, result: { count: 1, values: [42] } },
  }));
  assert.deepEqual((await asyncResultPromise).structuredContent, {
    jobId,
    state: "succeeded",
    ready: true,
    result: { count: 1, values: [42] },
  });
  const asyncHistory = JSON.parse((await client.callTool({
    name: "potassium_admin_history",
    arguments: { limit: 1 },
  })).content[0].text);
  assert.equal(asyncHistory.entries[0].mode, "async");
  assert.equal(asyncHistory.entries[0].executorJobId, jobId);
  assert.equal(JSON.stringify(asyncHistory).includes("return task.wait()"), false);
  const invalidJobId = await client.callTool({
    name: "potassium_async_job_status",
    arguments: { jobId: "A".repeat(32) },
  });
  assert.equal(invalidJobId.isError, true);
  const consolePromise = client.callTool({
    name: "potassium_async_job_console",
    arguments: { jobId, afterCursor: 3, limit: 2 },
  });
  const consoleRequest = await receiveFeatureRequest(socket);
  assert.equal(consoleRequest.method, "async_job_console");
  assert.deepEqual(consoleRequest.params, { jobId, afterCursor: 3, limit: 2 });
  socket.send(JSON.stringify({
    type: "response",
    id: consoleRequest.id,
    ok: true,
    result: {
      jobId,
      entries: [{ cursor: 4, text: "[redacted]", messageType: "MessageOutput", timestamp: 1 }],
      nextCursor: 4,
    },
  }));
  assert.deepEqual((await consolePromise).structuredContent, {
    jobId,
    entries: [{ cursor: 4, text: "[redacted]", messageType: "MessageOutput", timestamp: 1 }],
    nextCursor: 4,
  });
  // Capability preflight must not prevent controls from passing a raw mutation.
  const heldExecution = client.callTool({ name: "potassium_execute_luau", arguments: { code: "return 1" } });
  const [heldPayload] = await once(socket, "message");
  const heldRequest = JSON.parse(heldPayload.toString());
  assert.equal(heldRequest.method, "execute_luau");
  const listPromise = client.callTool({ name: "potassium_async_job_list", arguments: {} });
  const listRequest = await receiveFeatureRequest(socket);
  assert.equal(listRequest.method, "async_job_list");
  socket.send(JSON.stringify({ type: "response", id: listRequest.id, ok: true, result: { jobs: [], truncated: false } }));
  assert.deepEqual((await listPromise).structuredContent, { jobs: [], truncated: false });
  socket.send(JSON.stringify({ type: "response", id: heldRequest.id, ok: true, result: { count: 1, values: [1] } }));
  assert.deepEqual((await heldExecution).structuredContent, { count: 1, values: [1] });
  const extraAsyncArgument = await client.callTool({
    name: "potassium_async_job_result",
    arguments: { jobId, extra: true },
  });
  assert.equal(extraAsyncArgument.isError, true);

  const oversized = await client.callTool({
    name: "potassium_execute_luau",
    arguments: { code: "x".repeat(32769) },
  });
  assert.equal(oversized.isError, true);
  const multibyte = await client.callTool({
    name: "potassium_execute_luau",
    arguments: { code: `--${"é".repeat(20000)}` },
  });
  assert.equal(multibyte.isError, true);
});
test("async submission errors preserve technical causes and authoritative indeterminacy", async (t) => {
  for (const [name, args] of [
    ["potassium_execute_luau_async", { code: "return 1" }],
    ["potassium_remote_call", { target: "workspace.Echo", method: "InvokeServer", arguments: [] }],
    ["potassium_interaction_call", { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: false }],
  ]) {
    for (const failure of [
      Object.assign(new Error("Potassium request timed out after 30000 ms"), { code: "TIMEOUT", submissionIndeterminate: true }),
      Object.assign(new Error("Potassium disconnected"), { submissionIndeterminate: true }),
      Object.assign(new Error("Potassium is not connected"), { submissionIndeterminate: false }),
    ]) {
      const { client, requests } = await connectToolFixture(t, {
        config: { allowUnsafeExecute: true },
        request: async () => { throw failure; },
      });
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      assert.equal(response._meta.error.message, failure.message);
      assert.equal(response._meta.error.submissionIndeterminate, failure.submissionIndeterminate);
      assert.equal(response._meta.error.code, failure.code ?? (failure.submissionIndeterminate ? "SUBMISSION_INDETERMINATE" : "NO_CLIENT"));
      assert.equal(requests.filter(({ method }) => method === name.slice("potassium_".length)).length, 1);
    }
  }
});


test("rejects invalid bounds and conflicting read-only tool inputs before dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mcp-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(baseConfig()));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, POTASSIUM_MCP_CONFIG: configPath },
    stderr: "inherit",
  });
  const client = new Client({ name: "potassium-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);

  const statusResult = await client.callTool({ name: "potassium_status", arguments: {} });
  const { endpoint } = JSON.parse(statusResult.content[0].text);
  const socket = new WebSocket(endpoint);
  t.after(() => socket.close());
  await once(socket, "open");
  await authenticate(socket);

  const requests = [];
  socket.on("message", (payload) => {
    const request = JSON.parse(payload.toString());
    if (request.type !== "request") return;
    requests.push(request);
    socket.send(JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result: { method: request.method, params: request.params },
    }));
  });


  const invalidTags = await client.callTool({
    name: "potassium_list_tags",
    arguments: { path: "workspace", tag: "Collectible" },
  });
  assert.equal(invalidTags.isError, true);
  assert.match(invalidTags.content[0].text, /Provide exactly one of path or tag/);
  const invalidFind = await client.callTool({
    name: "potassium_find_instances",
    arguments: { root: "workspace", limit: 201 },
  });
  assert.equal(invalidFind.isError, true);
  assert.match(invalidFind.content[0].text, /Invalid arguments/);
  assert.equal(requests.length, 0);
  const invalidSpatial = await client.callTool({
    name: "potassium_spatial_query",
    arguments: { mode: "raycast", origin: { x: 0, y: 0, z: 0 } },
  });
  assert.equal(invalidSpatial.isError, true);
  assert.match(invalidSpatial.content[0].text, /Invalid arguments/);
  const invalidObserve = await client.callTool({
    name: "potassium_observe_changes",
    arguments: { path: "workspace.Part", durationMs: 99 },
  });
  assert.equal(invalidObserve.isError, true);
  assert.match(invalidObserve.content[0].text, /Invalid arguments/);
  assert.equal(requests.length, 0);
  const invalidFingerprint = await client.callTool({
    name: "potassium_script_fingerprint",
    arguments: { path: "" },
  });
  assert.equal(invalidFingerprint.isError, true);
  assert.match(invalidFingerprint.content[0].text, /Invalid arguments/);
  const invalidFingerprintProperty = await client.callTool({
    name: "potassium_script_fingerprint",
    arguments: { path: "workspace.Controller", unexpected: true },
  });
  assert.equal(invalidFingerprintProperty.isError, true);
  assert.match(invalidFingerprintProperty.content[0].text, /Invalid arguments/);
  for (const [name, arguments_] of [
    ["potassium_overlap_query", { path: "workspace.Part", maxResults: 201 }],
    ["potassium_attribute_inventory", { path: "workspace.Part", attributeNames: Array(33).fill("Flag") }],
    ["potassium_subtree_summary", { path: "workspace.Model", maxDepth: 9 }],
    ["potassium_observe_logs", { durationMs: 99 }],
  ]) {
    const invalid = await client.callTool({ name, arguments: arguments_ });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Invalid arguments/);
  }
  assert.equal(requests.length, 0);
  for (const [name, arguments_] of [
    ["potassium_snapshot_diff", { path: "workspace.Model", maxChanges: 501 }],
    ["potassium_multi_read_properties", { requests: Array(21).fill({ path: "workspace.A", properties: ["Name"] }) }],
    ["potassium_instance_ancestry", { path: "workspace.A", maxDepth: 33 }],
    ["potassium_class_summary", { path: "workspace", maxClasses: 201 }],
    ["potassium_trace_query", { path: "records.jsonl", maxRows: 501 }],
    ["potassium_place_metadata", { kind: "place", id: "0" }],
  ]) {
    const invalid = await client.callTool({ name, arguments: arguments_ });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Invalid arguments/);
  }
  assert.equal(requests.length, 0);

  const batchRow = { path: "workspace.Part", properties: ["Name"] };
  for (const arguments_ of [
    { requests: [] },
    { requests: Array(21).fill(batchRow) },
    { requests: [batchRow], unexpected: true },
    { requests: [batchRow], includeReferences: true, _maxResultBytes: 65536 },
    { requests: [{ ...batchRow, unexpected: true }] },
    { requests: [{ path: "workspace.Part" }] },
    { requests: [{ path: "", children: {} }] },
    { requests: [{ path: "workspace.Part", properties: [] }] },
    { requests: [{ path: "workspace.Part", properties: ["Name\n"] }] },
    { requests: [{ path: "workspace.Part", properties: ["Parent.Name"] }] },
    { requests: [{ path: "workspace.Part", properties: Array(33).fill("Name") }] },
    { requests: [{ path: "workspace.Part", attributes: { unexpected: true } }] },
    { requests: [{ path: "workspace.Part", attributes: { names: [""] } }] },
    { requests: [{ path: "workspace.Part", attributes: { names: Array(33).fill("Flag") } }] },
    { requests: [{ path: "workspace.Part", attributes: { limit: 33 } }] },
    { requests: [{ path: "workspace.Part", children: { recursive: true } }] },
    { requests: [{ path: "workspace.Part", children: { limit: 101 } }] },
    { requests: [batchRow], maxTotalValues: 0 },
    { requests: [batchRow], maxTotalValues: 201 },
    { requests: [batchRow], includeReferences: "true" },
  ]) {
    const invalid = await client.callTool({ name: "potassium_batch_read", arguments: arguments_ });
    assert.equal(invalid.isError, true, JSON.stringify(arguments_));
  }
  const reference = `instance://${"a".repeat(32)}`;
  for (const arguments_ of [
    { references: [] },
    { references: Array(129).fill(reference) },
    { references: [reference], unexpected: true },
    { references: [`${reference}.Part`] },
    { references: [`${reference}\n`] },
    { references: [reference.toUpperCase()] },
    { references: [` ${reference}`] },
    { references: ["workspace.Part"] },
  ]) {
    const invalid = await client.callTool({ name: "potassium_instance_references_release", arguments: arguments_ });
    assert.equal(invalid.isError, true, JSON.stringify(arguments_));
  }
  for (const [name, target] of [
    ["potassium_find_instances", { root: "workspace" }],
    ["potassium_list_children", { path: "workspace" }],
    ["potassium_inspect_instance", { path: "workspace" }],
  ]) {
    const invalid = await client.callTool({ name, arguments: { ...target, includeReferences: "true" } });
    assert.equal(invalid.isError, true);
  }
  assert.equal(requests.length, 0, "invalid requests must never reach the executor");
});

test("registration and calls honor all independent read admin execute axes", async (t) => {
  for (let bits = 0; bits < 8; bits += 1) {
    for (const allowUnsafeExecute of [false, true]) {
      await t.test(`grants ${bits}, unsafe ${allowUnsafeExecute}`, async (t) => {
        const policy = { read: Boolean(bits & 1), admin: Boolean(bits & 2), execute: Boolean(bits & 4) };
        const { client, requests } = await connectToolFixture(t, {
          config: { ...editorConfig, allowUnsafeExecute }, policy, nativeEditor: editorFixture(),
          mapRecordingService: {
            read: async () => ({ operation: "read", view: "summary", mapId: mapSummary().mapId, revision: 1, recordings: [] }),
            release: async () => ({ operation: "release", recordingId: "a".repeat(32), released: false }),
          },
          mapContextService: { read: async () => ({
            view: "read", section: "tracks", mapId: mapSummary().mapId, revision: 1, offset: 0, total: 0, entries: [], coverage: "partial", warnings: [],
          }) },
          request: async (method) => method === "execute_luau" ? { count: 1, values: [42] }
            : method === "interaction_inventory" ? interactionSnapshotReceipt()
              : ["execute_luau_async", "interaction_call"].includes(method) ? { jobId: "a".repeat(32), state: "queued" } : { loaded: true },
        });
        const names = new Set((await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name));
        for (const [name, args, allowed, method] of [
          ["potassium_client_state", {}, policy.read, "client_state"],
          ["potassium_map_recording_read", { operation: "read", mapId: mapSummary().mapId }, policy.read, undefined],
          ["potassium_map_recording", { operation: "release", recordingId: "a".repeat(32) }, policy.read, undefined],
          ["potassium_map_motion", { mapId: mapSummary().mapId }, policy.read, undefined],
          ["potassium_admin_status", {}, policy.admin, undefined],
          ["potassium_execute_luau", { code: "return 42" }, policy.execute && allowUnsafeExecute, "execute_luau"],
          ["potassium_execute_luau_async", { code: "return 42" }, policy.execute && allowUnsafeExecute, "execute_luau_async"],
          ["potassium_interaction_call", { kind: "prompt", target: "Workspace.Prompt" }, policy.execute && allowUnsafeExecute, "interaction_call"],
          ["potassium_interaction_inventory", {}, policy.read, "interaction_inventory"],
          ["potassium_editor_list_tabs", {}, policy.read, undefined],
          ["potassium_editor_read_tab", { id: "original" }, policy.read, undefined],
          ["potassium_editor_open_tab", {}, policy.execute && allowUnsafeExecute, undefined],
          ["potassium_editor_write_tab", { id: "original", content: "", expectedSha256: editorDigest("") }, policy.execute && allowUnsafeExecute, undefined],
          ["potassium_editor_activate_tab", { id: "original" }, policy.execute && allowUnsafeExecute, undefined],
          ["potassium_editor_close_tab", { id: "draft-1" }, policy.execute && allowUnsafeExecute, undefined],
        ]) {
          assert.equal(names.has(name), allowed);
          const response = await client.callTool({ name, arguments: args });
          assert.equal(response.isError === true, !allowed);
          if (!allowed) assert.equal(response._meta.error.code, "POLICY_DENIED");
          if (method) assert.equal(requests.filter((request) => request.method === method).length, allowed ? 1 : 0);
        }
      });
    }
  }
});

test("accepted async jobs retain identity after local audit and formatting failures", async (t) => {
  const jobId = "a".repeat(32);
  const secret = `private ${testToken}`;
  for (const failure of ["audit begin", "audit finish", "serialization", "serialized identity", "retention failure", "invalid state"]) {
    await t.test(failure, async (t) => {
      const result = failure === "serialization"
        ? { jobId, state: "queued", toJSON() { throw new Error(secret); } }
        : failure === "serialized identity" ? { jobId, state: "queued", toJSON() { return {}; } }
          : { jobId, state: failure === "invalid state" ? "future-state" : "queued", extra: failure === "retention failure" ? "é\\\"".repeat(4096) : undefined };
      const audit = {
        begin() { if (failure === "audit begin") throw new Error(secret); return {}; },
        async finish() { if (failure === "audit finish") throw new Error(secret); },
      };
      const { client, requests } = await connectToolFixture(t, {
        config: { allowUnsafeExecute: true, maxMessageBytes: 1024 }, audit,
        request: async () => result,
        ...(failure === "retention failure" ? { compactResultStore: {
          put() { throw Object.assign(new Error("Capacity unavailable"), { code: "RESULT_STORE_CAPACITY" }); },
          releaseScope() {},
        } } : {}),
      });
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_execute_luau_async" });
      const response = await client.callTool({ name: "potassium_execute_luau_async", arguments: { code: "return 42" } });
      assert.equal(response.isError, undefined);
      assert.equal(response.structuredContent.jobId, jobId);
      assert.equal(response.structuredContent.accepted, true);
      assert.equal(response.structuredContent.warning, failure.startsWith("audit") ? "AUDIT_FAILED" : "RESULT_FORMAT_FAILED");
      assert.equal(requests.filter((request) => request.method === "execute_luau_async").length, 1);
      assert.equal(Buffer.byteLength(JSON.stringify(response)) <= 1024, true);
      assert.equal(JSON.stringify(response).includes(testToken), false);
    });
  }
});

test("artifact storage failure preserves the completed job rather than suggesting resubmission", async (t) => {
  const jobId = "a".repeat(32);
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true },
    artifactStore: { async store() { throw new Error(`write failed: ${testToken} C:\\private\\results`); } },
    request: async () => ({ jobId, ready: true, state: "succeeded", result: { values: ["sensitive result"] } }),
  });
  const response = await client.callTool({ name: "potassium_async_job_result", arguments: { jobId } });
  assert.equal(response.isError, true);
  assert.equal(response._meta.error.code, "ARTIFACT_FAILED");
  assert.equal(response._meta.jobId, jobId);
  assert.equal(response._meta.state, "succeeded");
  assert.equal(JSON.stringify(response).includes("sensitive result"), false);
  assert.equal(JSON.stringify(response).includes(testToken), false);
  assert.equal(requests.some((request) => request.method === "execute_luau_async"), false);
});

test("feature preflight uses only the selected client without caching or global hiding", async (t) => {
  const old = { clientId: "a".repeat(32), generation: 1, client: { executor: "Potassium", protocol: 2 } };
  const current = { clientId: "b".repeat(32), generation: 2, client: { executor: "Potassium", protocol: 2 } };
  let currentFeatures = featureCapabilities;
  const result = { requestCount: 1, valueCount: 0, truncated: false, results: [
    { index: 1, ok: false, error: { code: "TARGET_UNAVAILABLE", message: "Target unavailable" } },
  ] };
  const { client, requests } = await connectToolFixture(t, {
    clients: [old, current],
    capabilities: (clientId) => clientId === old.clientId ? { protocol: 2, executor: "Potassium", methods: [] } : currentFeatures,
    request: async (method) => method === "batch_read" ? result : { loaded: true },
  });
  const initialNames = (await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name);
  const batchArgs = { requests: [{ path: "workspace.Part", properties: ["Name"] }] };
  const rejected = await client.callTool({ name: "potassium_batch_read", arguments: { ...batchArgs, clientId: old.clientId } });
  assert.equal(rejected._meta.error.code, "INCOMPATIBLE_CLIENT");
  assert.equal(requests.some((request) => request.method === "batch_read"), false);
  const accepted = await client.callTool({ name: "potassium_batch_read", arguments: { ...batchArgs, clientId: current.clientId } });
  assert.deepEqual(accepted.structuredContent, result);
  currentFeatures = { ...featureCapabilities, batchRead: { version: 0 } };
  const downgraded = await client.callTool({ name: "potassium_batch_read", arguments: { ...batchArgs, clientId: current.clientId } });
  assert.equal(downgraded._meta.error.code, "INCOMPATIBLE_CLIENT");
  assert.equal(requests.filter((request) => request.method === "batch_read").length, 1);
  assert.equal(requests.find((request) => request.method === "batch_read").clientId, current.clientId);
  assert.deepEqual((await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name), initialNames);
  const ordinaryRead = await client.callTool({ name: "potassium_client_state", arguments: { clientId: old.clientId } });
  assert.equal(ordinaryRead.structuredContent.loaded, true);
});

test("generation changes and indeterminate capability probes never submit async execution", async (t) => {
  for (const failure of ["generation", "probe transport", "unsupported capabilities"]) {
    await t.test(failure, async (t) => {
      const clients = [{ clientId: "a".repeat(32), generation: 1, client: { protocol: 2 } }];
      const { client, requests } = await connectToolFixture(t, {
        clients, config: { allowUnsafeExecute: true },
        capabilities() {
          if (failure === "probe transport") throw Object.assign(new Error("Potassium request timed out after 100 ms"), { submissionIndeterminate: true });
          if (failure === "unsupported capabilities") throw new Error("Unknown method");
          clients[0].generation += 1;
          return featureCapabilities;
        },
      });
      const result = await client.callTool({ name: "potassium_execute_luau_async", arguments: { code: "return 42" } });
      assert.equal(result.isError, true);
      const expectedCode = { generation: "CLIENT_CHANGED", "probe transport": "TIMEOUT", "unsupported capabilities": "INCOMPATIBLE_CLIENT" }[failure];
      assert.equal(result._meta.error.code, expectedCode);
      assert.equal(result._meta.error.submissionIndeterminate, false);
      assert.equal(requests.some((request) => request.method === "execute_luau_async"), false);
    });
  }
});

test("versioned references watches and async controls reject old feature levels before dispatch", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true },
    capabilities: () => ({ ...featureCapabilities, asyncJobs: { version: 1 }, instanceReferences: {}, watches: {} }),
  });
  for (const [name, args] of [
    ["potassium_async_job_list", {}],
    ["potassium_async_job_cancel", { jobId: "a".repeat(32) }],
    ["potassium_read_properties", { path: `instance://${"b".repeat(32)}`, properties: ["Name"] }],
    ["potassium_list_children", { path: "workspace", includeReferences: true }],
    ["potassium_watch_start", { path: "workspace" }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result._meta.error.code, "INCOMPATIBLE_CLIENT");
  }
  assert.equal(requests.every((request) => request.method === "capabilities"), true);
});

test("critical output schemas reject malformed discriminants without exposing returned data", async (t) => {
  const jobId = "a".repeat(32);
  const reference = `instance://${"b".repeat(32)}`;
  for (const [name, args, result] of [
    ["potassium_batch_read", { requests: [{ path: "workspace", properties: ["Name"] }] },
      { requestCount: 1, valueCount: 0, truncated: false, results: [{ index: 1, ok: "private-result" }] }],
    ["potassium_batch_read", { requests: [{ path: "workspace", properties: ["Name"] }] },
      { requestCount: 1, valueCount: 0, truncated: false, results: [] }],
    ["potassium_instance_references_release", { references: [reference] },
      { results: [{ reference, released: "private-result" }] }],
    ["potassium_async_job_result", { jobId }, { jobId, ready: false, state: "succeeded", result: "private-result" }],
  ]) {
    await t.test(name, async (t) => {
      const { client } = await connectToolFixture(t, {
        config: { allowUnsafeExecute: true }, request: async () => result,
      });
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: name });
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      assert.equal(response._meta.error.code, "RESULT_INVALID");
      assert.equal(response.structuredContent, undefined);
      assert.deepEqual(JSON.parse(response.content[0].text), response._meta);
      assert.equal(JSON.stringify(response).includes("private-result"), false);
    });
  }
});

test("tool formatting agrees with wire JSON for undefined scalars arrays and escaped UTF-8", () => {
  for (const [value, expected] of [
    [undefined, { value: null }], [null, { value: null }], [42, { value: 42 }],
    [["é", "\"\\"], { value: ["é", "\"\\"] }],
    [{ value: undefined, nested: { text: "é\"\\", absent: undefined } }, { nested: { text: "é\"\\" } }],
  ]) {
    const result = formatToolResult(value);
    assert.deepEqual(result.structuredContent, expected);
    const text = JSON.parse(result.content[0].text);
    assert.deepEqual(text !== null && typeof text === "object" && !Array.isArray(text) ? text : { value: text }, expected);
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(formatToolResult(cyclic)._meta.error.code, "RESULT_INVALID");
});

test("SDK cancellation reaches the active bridge operation", { timeout: 2000 }, async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  const { client } = await connectToolFixture(t, {
    request: (_method, _params, _clientId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled(); reject(new Error("Request cancelled")); }, { once: true });
      entered();
    }),
  });
  const controller = new AbortController();
  const response = client.callTool({ name: "potassium_client_state", arguments: {} }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(response, /cancel|abort/i);
  await started;
  controller.abort();
  await rejected;
  await cancellation;
});

test("overlapping server contexts keep cancellation and authority isolated after another server closes", { timeout: 5000 }, async (t) => {
  const firstEntered = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const releaseSecond = Promise.withResolvers();
  const dispatched = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const makeService = (entered, release, beforeCollect) => ({
    async observe(_args, options) {
      entered.resolve();
      await release.promise;
      await beforeCollect?.();
      await options.collect("map_observe", { sourceSnapshotId: "d".repeat(32), objectIds: ["e".repeat(32)], durationMs: 100, intervalMs: 50 });
      return mapSummary("observe");
    },
  });
  const first = await connectToolFixture(t, {
    clients: [{ clientId: "a".repeat(32), generation: 1, client: { protocol: 2 } }],
    policy: { read: true, admin: true, execute: true },
    mapContextService: makeService(firstEntered, releaseFirst, async () => {
      const nested = await second.client.callTool({ name: "potassium_status", arguments: { clientId: "b".repeat(32) } });
      assert.equal(nested.structuredContent.connected, true);
    }),
    request: (_method, _params, _clientId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled.resolve(); reject(new Error("Cancelled")); }, { once: true });
      dispatched.resolve();
    }),
  });
  let secondCollections = 0;
  const second = await connectToolFixture(t, {
    clients: [{ clientId: "b".repeat(32), generation: 1, client: { protocol: 2 } }],
    policy: { read: true, admin: false, execute: false },
    mapContextService: makeService(secondEntered, releaseSecond),
    request: async (_method, _params, clientId, signal) => {
      if (!signal || signal.aborted || clientId !== "b".repeat(32)) throw new Error("Wrong request context");
      secondCollections++;
      return {};
    },
  });
  const controller = new AbortController();
  const args = { view: "observe", mapId: mapSummary().mapId, objectIds: ["part"] };
  const firstResponse = first.client.callTool({ name: "potassium_map_context", arguments: { ...args, clientId: "a".repeat(32) } }, undefined, { signal: controller.signal });
  const firstRejected = assert.rejects(firstResponse, /cancel|abort/i);
  await firstEntered.promise;
  const secondResponse = second.client.callTool({ name: "potassium_map_context", arguments: { ...args, clientId: "b".repeat(32) } });
  await secondEntered.promise;
  const denied = await second.client.callTool({ name: "potassium_admin_recover", arguments: {} });
  assert.equal(denied.isError, true, "another server's admin grant must not authorize this session");
  releaseFirst.resolve();
  await dispatched.promise;
  controller.abort();
  await firstRejected;
  await cancelled.promise;
  await first.client.close();
  await first.server.close();
  releaseSecond.resolve();
  const result = await secondResponse;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.view, "observe");
  assert.equal(secondCollections, 1, "closing the cancelled server must not cancel or redirect another server's deferred collection");
});

test("configured secrets are redacted from structured and text errors", async (t) => {
  const privateRoot = resolve("private-artifacts");
  const { client } = await connectToolFixture(t, {
    config: { artifactRoots: [{ name: "private", path: privateRoot, recursive: false, extensions: [".txt"] }] },
    request: async () => { throw new Error(`${testToken} ${privateRoot}`); },
  });
  const result = await client.callTool({ name: "potassium_client_state", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes(testToken), false);
  assert.equal(result.content[0].text.includes(privateRoot), false);
  assert.equal(result._meta.error.message.includes(privateRoot), false);
});

test("audit replay admits only bounded metadata and isolates malformed rows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-audit-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "history.ndjson");
  const audit = new AdminAuditRecorder();
  await audit.finish(audit.begin({
    code: "return 42", sessionId: "trusted-session", hostId: "project_a",
    bridge: { status: () => ({ client: { executor: "Potassium", protocol: 2, placeId: 123 } }) },
  }), "success");
  const valid = audit.history(1)[0];
  const forged = {
    ...valid, sessionId: testToken,
    code: "private source", result: "private result", token: testToken, path: "C:\\private",
    client: { ...valid.client, token: testToken, source: "private source", version: "C:\\private\\executor" },
  };
  await writeFile(path, [
    "x".repeat(500000), JSON.stringify(forged), "{malformed",
    JSON.stringify({ ...valid, durationMs: -1, result: "invalid metadata" }),
    JSON.stringify({ ...valid, utf8Bytes: 65537, sessionId: "oversized-input" }),
    JSON.stringify({ ...valid, sessionId: "last-valid" }),
  ].join("\n"));
  const replayed = new AdminAuditRecorder({ path });
  const history = replayed.history(100);
  assert.deepEqual(history.map((entry) => entry.sessionId), ["last-valid", testToken]);
  assert.equal(JSON.stringify(history).includes("private source"), false);
  assert.equal(JSON.stringify(history).includes("private result"), false);
  assert.equal(JSON.stringify(history).includes("C:\\\\private"), false);
  assert.throws(() => { history[0].result = "new secret"; }, TypeError);
  assert.throws(() => { history[0].client.token = "new secret"; }, TypeError);
  const { client } = await connectToolFixture(t, { audit: replayed });
  const response = await client.callTool({ name: "potassium_admin_history", arguments: { limit: 100 } });
  assert.equal(response.isError, undefined);
  assert.equal(JSON.stringify(response).includes(testToken), false);
  assert.equal(response.structuredContent.entries[0].hostId, "project_a");
});

test("durable audit write failure preserves accepted and completed execution and later writes recover", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-audit-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "blocked.ndjson");
  await mkdir(path);
  const audit = new AdminAuditRecorder({ path });
  const jobId = "a".repeat(32);
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true, maxMessageBytes: 1024 }, audit,
    request: async (method) => method === "execute_luau_async" ? { jobId, state: "queued" } : { count: 1, values: [42] },
  });
  const accepted = await client.callTool({ name: "potassium_execute_luau_async", arguments: { code: "return 42" } });
  assert.equal(accepted.structuredContent.jobId, jobId);
  assert.equal(accepted.structuredContent.accepted, true);
  assert.equal(accepted.structuredContent.warning, "AUDIT_FAILED");
  const completed = await client.callTool({ name: "potassium_execute_luau", arguments: { code: "return 42" } });
  assert.equal(completed.structuredContent.executionCompleted, true);
  assert.deepEqual(completed.structuredContent.result.values, [42]);
  assert.equal(JSON.stringify(completed).includes(path), false);
  await rm(path, { recursive: true });
  const later = await client.callTool({ name: "potassium_execute_luau_async", arguments: { code: "return 7" } });
  assert.equal(later.structuredContent.warning, undefined);
  assert.equal(new AdminAuditRecorder({ path }).history(100).length, 3);
  assert.deepEqual(requests.filter((request) => request.method.startsWith("execute_")).map((request) => request.method),
    ["execute_luau_async", "execute_luau", "execute_luau_async"]);
});

test("missing configuration and credentials fail without exposing credential contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-missing-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await assert.rejects(loadConfig(path));
  await writeFile(path, JSON.stringify(baseConfig({ token: undefined, tokenFile: "missing-secret-token.txt" })));
  await assert.rejects(loadConfig(path), (error) => {
    assert.equal(error.message.includes("missing-secret-token.txt"), false);
    return true;
  });
  await writeFile(path, `{"token":"${testToken}" invalid}`);
  await assert.rejects(loadConfig(path), (error) => {
    assert.equal(error.message.includes(testToken), false);
    return true;
  });
});

test("selection errors distinguish missing and ambiguous clients before capability dispatch", async (t) => {
  for (const [clients, code] of [
    [[], "NO_CLIENT"],
    [[{ clientId: "a".repeat(32), generation: 1 }, { clientId: "b".repeat(32), generation: 1 }], "AMBIGUOUS_CLIENT"],
  ]) {
    await t.test(code, async (t) => {
      const { client, requests } = await connectToolFixture(t, { clients });
      const response = await client.callTool({ name: "potassium_capabilities", arguments: {} });
      assert.equal(response._meta.error.code, code);
      assert.equal(requests.length, 0);
    });
  }
});

test("metadata diagnostics redact escaped credentials consistently in both representations", async (t) => {
  const secret = `${testToken}"\\é`;
  const { client } = await connectToolFixture(t, {
    config: { token: secret },
    capabilities: () => ({ ...featureCapabilities, version: secret }),
  });
  const response = await client.callTool({ name: "potassium_capabilities", arguments: {} });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.version, "[redacted]");
  assert.equal(JSON.parse(response.content[0].text).version, "[redacted]");
});

test("trailing-backslash credentials and artifact roots preserve diagnostic JSON", async (t) => {
  for (const kind of ["token", "artifact root"]) {
    await t.test(kind, async (t) => {
      const secret = kind === "token" ? `${testToken}\\` : resolve("C:\\");
      const config = kind === "token" ? { token: secret } : {
        artifactRoots: [{ name: "private", path: secret, recursive: false, extensions: [".txt"] }],
      };
      const { client } = await connectToolFixture(t, {
        config,
        clients: [{ clientId: "c".repeat(32), generation: 1, client: { executor: "Potassium", protocol: 2, version: secret } }],
        capabilities: () => ({ ...featureCapabilities, version: secret }),
        request: async () => { throw new Error(`Diagnostic ${secret} suffix`); },
      });
      const capabilities = await client.callTool({ name: "potassium_capabilities", arguments: {} });
      assert.equal(capabilities.isError, undefined);
      assert.equal(capabilities.structuredContent.version, "[redacted]");
      assert.deepEqual(JSON.parse(capabilities.content[0].text), capabilities.structuredContent);
      const clients = await client.callTool({ name: "potassium_list_clients", arguments: {} });
      assert.equal(clients.structuredContent.value[0].client.version, "[redacted]");
      assert.deepEqual(JSON.parse(clients.content[0].text), clients.structuredContent.value);
      const error = await client.callTool({ name: "potassium_client_state", arguments: {} });
      assert.equal(error.isError, true);
      assert.equal(error._meta.error.message, "Diagnostic [redacted] suffix");
      assert.deepEqual(JSON.parse(error.content[0].text), error._meta);
    });
  }
});

test("escaped error envelopes honor the minimum response budget without losing uncertainty", async (t) => {
  for (const indeterminate of [false, true]) {
    await t.test(`indeterminate ${indeterminate}`, async (t) => {
      const failure = new Error(`Instance not found at segment: ${"\"".repeat(134)}`);
      if (indeterminate) Object.assign(failure, { code: "TIMEOUT", submissionIndeterminate: true });
      const { client } = await connectToolFixture(t, {
        config: { maxMessageBytes: 1024 },
        request: async () => { throw failure; },
      });
      const response = await client.callTool({ name: "potassium_client_state", arguments: {} });
      assert.equal(response.isError, true);
      assert.equal(Buffer.byteLength(JSON.stringify(response), "utf8") <= 1024, true);
      assert.deepEqual(JSON.parse(response.content[0].text), response._meta);
      if (indeterminate) {
        assert.equal(response._meta.error.code, "TIMEOUT");
        assert.equal(response._meta.error.submissionIndeterminate, true);
      }
    });
  }
});

test("an admitted missing instance target is not reported as a policy denial", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    policy: { read: true, admin: false, execute: false },
    request: async () => { throw new Error("Instance not found at segment: Missing"); },
  });
  const response = await client.callTool({
    name: "potassium_read_properties",
    arguments: { path: "workspace.Missing", properties: ["Name"] },
  });
  assert.equal(response.isError, true);
  assert.equal(response._meta.error.code, "TARGET_UNAVAILABLE");
  assert.deepEqual(JSON.parse(response.content[0].text), response._meta);
  assert.deepEqual(requests.map((request) => request.method), ["read_properties"]);
});

test("repeated discovery revalidates changed output constraints across reconnects", async (t) => {
  const client = new Client({ name: "output-revision-test", version: "1.0.0" });
  for (const [outputSchema, valid, invalid] of [
    [z.object({ revision: z.literal(1), value: z.number().max(10) }).strict(),
      { revision: 1, value: 5 }, { revision: 1, value: 25 }],
    [z.object({ revision: z.literal(2), value: z.number().min(20) }).strict(),
      { revision: 2, value: 25 }, { revision: 2, value: 5 }],
  ]) {
    const { server } = await connectToolFixture(t, { client });
    let reply = valid;
    server.registerTool("potassium_builtin_status", { outputSchema }, async () => formatToolResult(reply));
    // Return a deliberately inconsistent wire result through the public handler
    // API: the stock SDK client, not server-side Zod, must enforce discovery.
    server.server.setRequestHandler(CallToolRequestSchema, async () => formatToolResult(reply));
    for (let iteration = 0; iteration < 3; iteration += 1) {
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_builtin_status" });
      reply = valid;
      const response = await client.callTool({ name: "potassium_builtin_status", arguments: {} });
      assert.deepEqual(response.structuredContent, valid);
      reply = invalid;
      await assert.rejects(client.callTool({ name: "potassium_builtin_status", arguments: {} }), (error) => {
        assert.equal(error.code, ErrorCode.InvalidParams);
        return true;
      });
    }
    await client.close();
    await server.close();
  }
});

test("SDK validates full and compact critical results and losslessly pages redacted JSON under transport budgets", async (t) => {
  for (const maxMessageBytes of [1024, 65536]) {
    await t.test(`transport ${maxMessageBytes}`, async (t) => {
      const clients = [{ clientId: "c".repeat(32), generation: 1, client: { executor: "Potassium", protocol: 2 } }];
      const { client } = await connectToolFixture(t, { config: { maxMessageBytes }, clients });
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_status" });
      const small = await client.callTool({ name: "potassium_status", arguments: {} });
      assert.equal(small.structuredContent.connected, true);
      clients[0].client.version = `${testToken} ${"é\\\"\n😀".repeat(2000)}`;
      const large = await client.callTool({ name: "potassium_status", arguments: {} });
      const descriptor = large.structuredContent;
      assert.equal(large.isError, undefined);
      assert.equal(descriptor.kind, "potassium/result");
      assert.equal(Buffer.byteLength(JSON.stringify(large)) <= Math.min(8192, maxMessageBytes), true);
      let text = "", offsetBytes = 0;
      do {
        const args = { resultId: descriptor.resultId, view: "text", offsetBytes, maxBytes: 4096 };
        const result = await client.callTool({ name: "potassium_result_read", arguments: args });
        const page = result.structuredContent;
        assert.equal(result.isError, undefined);
        assert.equal(Buffer.byteLength(JSON.stringify(result)) <= Math.min(8192, maxMessageBytes), true);
        assert.equal(page.text.includes("\ufffd"), false);
        if (offsetBytes === 0) {
          const replay = await client.callTool({ name: "potassium_result_read", arguments: args });
          assert.deepEqual(replay.structuredContent, page);
        }
        text += page.text;
        if (!page.hasMore) break;
        assert.equal(page.nextOffsetBytes > offsetBytes, true);
        offsetBytes = page.nextOffsetBytes;
      } while (true);
      assert.equal(Buffer.byteLength(text), descriptor.bytes);
      assert.equal(createHash("sha256").update(text).digest("hex"), descriptor.sha256);
      assert.equal(text.includes(testToken), false);
      assert.equal(JSON.parse(text).clients[0].client.version, clients[0].client.version.replace(testToken, "[redacted]"));
      const subtree = await client.callTool({
        name: "potassium_result_read", arguments: { resultId: descriptor.resultId, pointer: "/clients/0/generation" },
      });
      assert.equal(subtree.structuredContent.selections[0].value, 1);
    });
  }
});

test("large malformed critical results cannot become successful descriptors", async (t) => {
  const { client } = await connectToolFixture(t, {
    client: new Client({ name: "structured-invalid-output", version: "1" }, {
      capabilities: { experimental: { "potassium/structured-results": { version: 1 } } },
    }),
    request: async () => ({
      requestCount: 1, valueCount: 0, truncated: false, results: [],
      secret: "private malformed output".repeat(2000),
    }),
    compactResultStore: {
      put() { assert.fail("Malformed original output must not enter retention"); },
      releaseScope() {},
    },
  });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
  const response = await client.callTool({
    name: "potassium_batch_read", arguments: { requests: [{ path: "workspace", properties: ["Name"] }] },
  });
  assert.equal(response._meta.error.code, "RESULT_INVALID");
  assert.equal(JSON.stringify(response).includes("private malformed output"), false);
});

test("accepted async jobs keep authoritative identity alongside retained oversized acceptance data", async (t) => {
  const jobId = "a".repeat(32);
  const original = { jobId, state: "queued", metadata: "large acceptance".repeat(2000) };
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true, maxMessageBytes: 1024 }, request: async () => original,
  });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_execute_luau_async" });
  const response = await client.callTool({ name: "potassium_execute_luau_async", arguments: { code: "return 42" } });
  assert.equal(response.structuredContent.kind, "potassium/result");
  assert.equal(response.structuredContent.jobId, jobId);
  assert.equal(response.structuredContent.accepted, true);
  assert.equal(Buffer.byteLength(JSON.stringify(response)) <= 1024, true);
  const page = await client.callTool({
    name: "potassium_result_read", arguments: { resultId: response.structuredContent.resultId, pointer: "/jobId" },
  });
  assert.equal(page.structuredContent.selections[0].value, jobId);
  assert.equal(requests.filter((entry) => entry.method === "execute_luau_async").length, 1);
});

test("retained results are session-isolated, origin-policy checked, and released on close", async (t) => {
  const compactResultStore = createCompactResultStore();
  const owner = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true }, compactResultStore, resultScopeId: "owner",
    request: async () => ({ value: "sensitive execution result".repeat(2000) }),
  });
  const other = await connectToolFixture(t, { compactResultStore, resultScopeId: "other" });
  const result = await owner.client.callTool({ name: "potassium_execute_luau", arguments: { code: "return 1" } });
  const args = { resultId: result.structuredContent.resultId };
  const foreign = await other.client.callTool({ name: "potassium_result_read", arguments: args });
  assert.equal(foreign._meta.error.code, "RESULT_NOT_FOUND");
  const allowed = await owner.client.callTool({ name: "potassium_result_read", arguments: args });
  assert.equal(allowed.structuredContent.toolName, "potassium_execute_luau");
  owner.server.policy = { read: true, admin: false, execute: false };
  const denied = await owner.client.callTool({ name: "potassium_result_read", arguments: args });
  assert.equal(denied._meta.error.code, "RESULT_ORIGIN_DENIED");
  await owner.server.close();
  const replacement = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true }, compactResultStore, resultScopeId: "owner",
  });
  const released = await replacement.client.callTool({ name: "potassium_result_read", arguments: args });
  assert.equal(released._meta.error.code, "RESULT_NOT_FOUND");
});

test("SDK lazy discovery atomically activates typed tools, denies disabled calls, and remains session-local", async (t) => {
  const lazyClient = () => new Client({ name: "lazy-test", version: "1" }, {
    capabilities: { experimental: { "potassium/tool-discovery": { version: 1, listChanged: true } } },
  });
  const first = await connectToolFixture(t, {
    client: lazyClient(), policy: { read: true, admin: false, execute: false },
  });
  const second = await connectToolFixture(t, { client: lazyClient() });
  const core = ["potassium_result_read", "potassium_status", "potassium_tool_catalog"];
  assert.deepEqual((await listAllTools((cursor) => first.client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name).sort(), core);
  const disabled = await first.client.callTool({ name: "potassium_read_properties", arguments: { path: "workspace", properties: ["Name"] } });
  assert.equal(disabled._meta.error.code, "POLICY_DENIED");
  const atomic = await first.client.callTool({
    name: "potassium_tool_catalog", arguments: { enable: ["potassium_read_properties", "potassium_admin_recover"] },
  });
  assert.equal(atomic._meta.error.code, "POLICY_DENIED");
  assert.deepEqual((await listAllTools((cursor) => first.client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name).sort(), core);
  const enabled = await first.client.callTool({
    name: "potassium_tool_catalog", arguments: { enable: ["potassium_read_properties"], query: "read_properties" },
  });
  assert.deepEqual(enabled.structuredContent.activated, ["potassium_read_properties"]);
  await first.client.notification({ method: "notifications/initialized" });
  const list = await listAllTools((cursor) => first.client.listTools(cursor === undefined ? undefined : { cursor }));
  assert.equal(list.tools.some((tool) => tool.name === "potassium_read_properties" && tool.inputSchema.properties.path), true);
  const invalid = await first.client.callTool({ name: "potassium_read_properties", arguments: { path: "workspace", properties: [] } });
  assert.equal(invalid.isError, true);
  assert.equal(first.requests.length, 0);
  const valid = await first.client.callTool({ name: "potassium_read_properties", arguments: { path: "workspace", properties: ["Name"] } });
  assert.equal(valid.structuredContent.ok, true);
  assert.deepEqual((await listAllTools((cursor) => second.client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name).sort(), core);
  await first.client.callTool({ name: "potassium_tool_catalog", arguments: { enableAll: true, limit: 1 } });
  const restored = (await listAllTools((cursor) => first.client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name);
  assert.equal(restored.includes("potassium_remote_inventory"), true);
  assert.equal(restored.includes("potassium_admin_recover"), false);
});

test("SDK list-change refresh receives one coalesced activation notification and no redundant update", { timeout: 5000 }, async (t) => {
  const refreshes = [];
  let refreshed;
  const client = new Client({ name: "refresh-test", version: "1" }, {
    capabilities: { experimental: { "potassium/tool-discovery": { version: 1, listChanged: true } } },
    listChanged: { tools: { autoRefresh: true, debounceMs: 0, onChanged(error, tools) {
      assert.ifError(error);
      refreshes.push(tools.map((tool) => tool.name));
      refreshed?.();
    } } },
  });
  await connectToolFixture(t, { client });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
  await new Promise((resolve) => setImmediate(resolve));
  refreshes.length = 0;
  const changed = new Promise((resolve) => { refreshed = resolve; });
  const enable = ["potassium_read_properties", "potassium_remote_inventory", "potassium_capabilities"];
  await client.callTool({ name: "potassium_tool_catalog", arguments: { enable, limit: 1 } });
  await changed;
  assert.equal(refreshes.length, 1);
  assert.equal(enable.every((name) => refreshes[0].includes(name)), true);
  await client.callTool({ name: "potassium_tool_catalog", arguments: { enable, limit: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes.length, 1);
});

test("lazy discovery requires exact retained-client opt-in and works for admin-only grants", async (t) => {
  for (const [retainedSession, optIn] of [
    [true, undefined], [true, { version: 2, listChanged: true }],
    [true, { version: 1, listChanged: false }], [false, { version: 1, listChanged: true }],
  ]) {
    const client = new Client({ name: "fallback-test", version: "1" }, {
      capabilities: { experimental: optIn ? { "potassium/tool-discovery": optIn } : {} },
    });
    await connectToolFixture(t, { client, retainedSession });
    const tools = (await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools.map((tool) => tool.name);
    assert.equal(tools.includes("potassium_read_properties"), true);
    assert.equal(tools.includes("potassium_remote_inventory"), true);
  }
  const admin = await connectToolFixture(t, {
    policy: { read: false, admin: true, execute: false },
    client: new Client({ name: "admin-lazy-test", version: "1" }, {
      capabilities: { experimental: { "potassium/tool-discovery": { version: 1, listChanged: true } } },
    }),
  });
  await admin.client.callTool({ name: "potassium_tool_catalog", arguments: { enable: ["potassium_admin_status"] } });
  const status = await admin.client.callTool({ name: "potassium_admin_status", arguments: {} });
  assert.equal(status.structuredContent.connected, true);
  assert.equal((await listAllTools((cursor) => admin.client.listTools(cursor === undefined ? undefined : { cursor }))).tools.some((tool) => tool.name === "potassium_read_properties"), false);
});

test("remote workflow probes version gates before dispatch and retains capture coverage typing", async (t) => {
  let capabilities = { ...featureCapabilities, remoteInventory: { version: 2 }, remoteCapture: { version: 1 } };
  const captureId = "d".repeat(32);
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true }, capabilities: () => capabilities,
    request: async (method) => method === "remote_inventory" ? { snapshotId: "e".repeat(32), coverage: "partial" } : captureReceipt(),
  });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
  for (const [name, args] of [
    ["potassium_remote_inventory", {}],
    ["potassium_remote_capture_start", { targets: ["workspace.Remote"] }],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }],
    ["potassium_remote_capture_stop", { captureId }],
  ]) {
    const incompatible = await client.callTool({ name, arguments: args });
    assert.equal(incompatible._meta.error.code, "INCOMPATIBLE_CLIENT");
  }
  assert.equal(requests.every((entry) => entry.method === "capabilities"), true);
  capabilities = featureCapabilities;
  const inventory = await client.callTool({ name: "potassium_remote_inventory", arguments: { view: "rows", fields: ["name"], includeReferences: false } });
  assert.equal(inventory.structuredContent.coverage, "partial");
  const capture = await client.callTool({ name: "potassium_remote_capture_start", arguments: { targets: ["workspace.Remote"] } });
  assert.equal(capture.structuredContent.coverage, "selected-outbound-namecall-only");
  assert.equal(capture.structuredContent.recordsValues, false);
  const beforeInvalid = requests.length;
  for (const [name, args] of [
    ["potassium_remote_inventory", { view: "diff", snapshotId: "e".repeat(32) }],
    ["potassium_remote_inventory", { cursor: "unbound" }],
    ["potassium_remote_inventory", { classNames: ["Folder"] }],
    ["potassium_remote_capture_start", { targets: [] }],
    ["potassium_remote_capture_poll", { captureId, after: -1 }],
    ["potassium_remote_capture_stop", { captureId, code: "not allowed" }],
  ]) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.equal(requests.length, beforeInvalid);
});

test("remote discovery rejects incompatible selectors and sampling controls before any dispatch", async (t) => {
  const { client, requests } = await connectToolFixture(t, { config: { allowUnsafeExecute: true } });
  const snapshotId = "e".repeat(32), rowId = "f".repeat(32);
  for (const [name, args] of [
    ["potassium_remote_inventory", { view: "detail" }],
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo", snapshotId, rowId }],
    ["potassium_remote_inventory", { view: "detail", snapshotId }],
    ["potassium_remote_inventory", { view: "detail", rowId }],
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo", limit: 51 }],
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo", attributeNames: Array(33).fill("Name") }],
    ["potassium_remote_inventory", { view: "rows", snapshotId, rowId }],
    ["potassium_remote_inventory", { includeSiblingValues: false }],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"], directions: [] }],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"], directions: ["outbound", "outbound"] }],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"], directions: ["OnClientInvoke"] }],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"], maxExamplesPerVariant: 2 }],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"], includeValueExamples: true, maxExamplesPerVariant: 4 }],
    ["potassium_observe_action", { operation: "start", requests: [{ path: "workspace", properties: ["Name"] }], includeValueExamples: true }],
    ...["cursor", "compareTo", "nameContains", "pathContains", "classNames", "fields"].map((key) => [
      "potassium_remote_inventory", { view: "detail", root: "workspace.Echo", [key]: key === "compareTo" ? snapshotId : ["classNames", "fields"].includes(key) ? [] : "x" },
    ]),
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(result._meta.error.code, "INVALID_INPUT");
  }
  assert.deepEqual(requests, []);
});

test("remote detail preserves identity selection and explicit metadata values without granting sibling or target references by default", async (t) => {
  const snapshotId = "e".repeat(32), rowId = "f".repeat(32);
  const associationReference = `instance://${"b".repeat(32)}`;
  const objectValue = {
    name: "Destination", className: "ObjectValue", path: "Workspace.Echo.Destination",
    value: { ok: true, value: { type: "Instance", className: "Part", name: "Part", path: "Workspace.Part" } },
  };
  const { client, requests } = await connectToolFixture(t, {
    request: async (_method, params) => detailReceipt({
      ...(params.snapshotId ? { snapshotId, rowId } : {}),
      attributes: { ok: true, total: 3, truncated: false, values: [
        { name: "Enabled", ok: true, value: false },
        { name: "Token", ok: true, value: "[redacted]", redacted: true },
        { name: "Missing", ok: true, value: { type: "nil" } },
      ] },
      valueAssociations: {
        children: [{ ...objectValue, ...(params.includeReferences ? { reference: associationReference } : {}) }],
        siblings: [], siblingsRequested: params.includeSiblingValues, siblingMeaning: "shared-parent-only",
      },
    }),
  });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_remote_inventory" });
  const fresh = await client.callTool({ name: "potassium_remote_inventory", arguments: { view: "detail", root: "workspace.Echo" } });
  assert.equal(fresh.isError, undefined);
  assert.equal(fresh.structuredContent.attributes.values[0].value, false);
  assert.deepEqual(fresh.structuredContent.attributes.values[2].value, { type: "nil" });
  assert.equal(fresh.structuredContent.associationMeaning, "metadata-not-call-arguments");
  assert.equal(fresh.structuredContent.valueAssociations.siblingsRequested, false);
  assert.equal(fresh.structuredContent.instance.reference, undefined);
  assert.equal(fresh.structuredContent.valueAssociations.children[0].value.value.reference, undefined);
  const retained = await client.callTool({ name: "potassium_remote_inventory", arguments: { view: "detail", snapshotId, rowId, includeSiblingValues: true } });
  assert.equal(retained.structuredContent.snapshotId, snapshotId);
  assert.equal(retained.structuredContent.rowId, rowId);
  assert.equal(retained.structuredContent.valueAssociations.siblingsRequested, true);
  const submitted = requests.filter(({ method }) => method === "remote_inventory");
  assert.equal(submitted[1].params.root, undefined);
  assert.equal(submitted[1].params.rowId, rowId);
  const referenced = await client.callTool({
    name: "potassium_remote_inventory", arguments: { view: "detail", root: "workspace.Echo", includeReferences: true },
  });
  assert.equal(referenced.isError, undefined);
  assert.equal(referenced.structuredContent.valueAssociations.children[0].reference, associationReference);
  assert.equal(referenced.structuredContent.valueAssociations.children[0].value.value.reference, undefined);
});

test("capture profiles preserve opt-in values and nil slots while summary remains value-free", async (t) => {
  let valuesEnabled = false;
  const group = {
    targetId: "01", direction: "inbound", method: "OnClientEvent", argc: 4,
    argumentTypes: ["nil", "boolean", "Instance", "table"], typesTruncated: false, count: 7,
    firstSeenMs: 1, lastSeenMs: 8, exampleCount: 1,
  };
  const example = {
    argc: 4, arguments: [
      { type: "nil" }, { type: "boolean", value: false }, { type: "Instance" },
      { type: "table", entries: [{ key: { type: "string", value: "Token" }, value: { type: "string", redacted: true } }], truncated: false },
    ], truncated: false, firstSeenMs: 1, lastSeenMs: 6, count: 3,
  };
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true, proxyMaxFrameBytes: 16384 },
    request: async (method, params) => {
      if (method === "remote_capture_start") {
        valuesEnabled = params.includeValueExamples;
        if (!valuesEnabled) return captureReceipt();
        assert.equal(params.maxExamplesPerVariant, 2);
      }
      return captureReceipt({
        directions: ["inbound"], coverage: "selected-inbound-events-only", incomingCalls: true,
        recordsValues: valuesEnabled, observed: 7, retained: 7,
        exampleSampling: { attempts: 3, maxAttempts: 200, truncated: false },
        ...(method === "remote_capture_poll" ? params.view === "profiles"
          ? { profiles: [{ ...group, examples: [example] }] } : { groups: [group] } : {}),
      });
    },
  });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_remote_capture_poll" });
  const plain = await client.callTool({ name: "potassium_remote_capture_start", arguments: { targets: ["workspace.Echo"] } });
  assert.equal(plain.structuredContent.recordsValues, false);
  assert.equal(plain.structuredContent.recordsReturns, false);
  assert.deepEqual(plain.structuredContent.directions, ["outbound"]);
  assert.equal(requests.find(({ method }) => method === "remote_capture_start").params.maxExamplesPerVariant, undefined);
  const started = await client.callTool({
    name: "potassium_remote_capture_start", arguments: { targets: ["workspace.Echo"], directions: ["inbound"], includeValueExamples: true },
  });
  assert.equal(started.structuredContent.incomingRemoteFunctions, false);
  const args = { captureId: started.structuredContent.captureId };
  const profile = await client.callTool({ name: "potassium_remote_capture_poll", arguments: { ...args, view: "profiles" } });
  assert.equal(profile.isError, undefined);
  assert.deepEqual(profile.structuredContent.profiles[0].examples[0], example);
  assert.equal(profile.structuredContent.profiles[0].count, 7);
  const summary = await client.callTool({ name: "potassium_remote_capture_poll", arguments: args });
  assert.equal(summary.structuredContent.profiles, undefined);
  assert.equal(summary.structuredContent.groups[0].examples, undefined);
  assert.equal(summary.structuredContent.groups[0].exampleCount, 1);
});

test("malformed remote discovery results fail before retention and never expose rejected values", async (t) => {
  const captureId = "d".repeat(32);
  const profile = (node, groupOverrides = {}) => captureReceipt({
    recordsValues: true, observed: 1, retained: 1, exampleSampling: { attempts: 1, maxAttempts: 200, truncated: false }, profiles: [{
      targetId: "01", direction: "outbound", method: "FireServer", argc: 1, argumentTypes: [node.type], typesTruncated: false,
      count: 1, firstSeenMs: 0, lastSeenMs: 0, exampleCount: 1,
      examples: [{ argc: 1, arguments: [node], truncated: false, firstSeenMs: 0, lastSeenMs: 0, count: 1 }],
      ...groupOverrides,
    }],
  });
  const leaked = "private malformed sample";
  for (const [name, args, output] of [
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo" }, detailReceipt({
      attributes: { ok: true, truncated: false, values: [{ name: "Token", ok: true, redacted: true, value: leaked }] },
    })],
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo" }, detailReceipt({ associationMeaning: "call-arguments" })],
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo", limit: 50, includeSiblingValues: true }, detailReceipt({
      valueAssociations: {
        children: Array.from({ length: 26 }, () => ({ name: "Count", className: "IntValue", path: "Workspace.Echo.Count", value: { ok: true, value: 0 } })),
        siblings: Array.from({ length: 25 }, () => ({ name: "Count", className: "IntValue", path: "Workspace.Count", value: { ok: true, value: 0 } })),
        siblingsRequested: true, siblingMeaning: "shared-parent-only",
      },
    })],
    ["potassium_remote_inventory", { view: "detail", root: "workspace.Echo" }, { snapshotId: "e".repeat(32), view: "rows" }],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"] }, captureReceipt({ recordsReturns: true })],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"] }, captureReceipt({ incomingRemoteFunctions: true })],
    ["potassium_remote_capture_start", { targets: ["workspace.Echo"] }, captureReceipt({ recordsValues: true })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, captureReceipt()],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, profile({ type: "nil" }, { count: undefined })],
    ["potassium_remote_capture_poll", { captureId, view: "events" }, captureReceipt({
      observed: 1, retained: 1, groups: [], events: [{
        targetId: "01", direction: "outbound", method: "FireServer", argc: 1, argumentTypes: ["nil"], typesTruncated: false,
        sequence: 1, elapsedMs: 0, count: 1,
      }],
    })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, profile({ type: "Instance", value: leaked })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, profile({ type: "string", redacted: true, value: leaked })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, profile({ type: "string", value: "é".repeat(65) })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, profile({ type: "string", value: "\ud800" })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, profile({
      type: "table", entries: [{ key: { type: "table", entries: [], truncated: false }, value: { type: "nil" } }], truncated: false,
    })],
    ["potassium_remote_capture_poll", { captureId, view: "profiles" }, { ...profile({ type: "string", value: leaked }), recordsValues: false }],
    ["potassium_remote_capture_poll", { captureId, view: "summary" }, profile({ type: "string", value: leaked })],
  ]) {
    await t.test(`${name}: ${JSON.stringify(output).slice(0, 80)}`, async (t) => {
      const { client } = await connectToolFixture(t, {
        config: { allowUnsafeExecute: true, maxMessageBytes: 1024 },
        request: async () => output,
        compactResultStore: { put() { assert.fail("Malformed remote output must never enter retention"); }, releaseScope() {} },
      });
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      assert.equal(response._meta.error.code, "RESULT_INVALID");
      assert.equal(response.structuredContent, undefined);
      assert.equal(JSON.stringify(response).includes(leaked), false);
      assert.deepEqual(JSON.parse(response.content[0].text), response._meta);
    });
  }
});

test("offline remote candidates keep SDK typing and scoped origin ownership without executor dispatch", async (t) => {
  const codeIndexService = createCodeIndexService({ parse: parseAuthoredModules });
  const owner = await connectToolFixture(t, { clients: [], codeIndexService, resultScopeId: "remote-owner" });
  const other = await connectToolFixture(t, { clients: [], codeIndexService, resultScopeId: "remote-other" });
  await listAllTools((cursor) => owner.client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_code_query" });
  const indexed = await owner.client.callTool({
    name: "potassium_code_index", arguments: { modules: [{ id: "Main", logicalPath: "Client/Main", source: "script.Parent.Echo:FireServer(false, nil)" }] },
  });
  const args = { indexId: indexed.structuredContent.indexId, view: "remote_callsites", remote: { logicalPath: "Client/Echo" } };
  const queried = await owner.client.callTool({ name: "potassium_code_query", arguments: args });
  assert.equal(queried.isError, undefined);
  assert.equal(queried.structuredContent.correlation, "static-candidates-only");
  assert.equal(queried.structuredContent.rows[0].argumentExpressionCount, 2);
  assert.equal(queried.structuredContent.rows[0].receiverIdentity, "unverified");
  assert.equal(queried.structuredContent.rows[0].matchKind, "static-logical-path");
  assert.equal((await other.client.callTool({ name: "potassium_code_query", arguments: args }))._meta.error.code, "CODE_NOT_FOUND");
  owner.server.policy = { read: false, admin: false, execute: false };
  assert.equal((await owner.client.callTool({ name: "potassium_code_query", arguments: args })).isError, true);
  owner.server.policy = { read: true, admin: false, execute: false };
  await owner.client.callTool({ name: "potassium_code_query", arguments: { indexId: args.indexId, view: "release" } });
  assert.equal((await owner.client.callTool({ name: "potassium_code_query", arguments: args }))._meta.error.code, "CODE_NOT_FOUND");
  assert.deepEqual(owner.requests, []);
  assert.deepEqual(other.requests, []);
});

test("remote candidate selector errors never call the index service or executor", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    clients: [], codeIndexService: { query() { assert.fail("Invalid selectors must not reach the index service"); }, releaseScope() {} },
  });
  for (const args of [
    { view: "remote_callsites" }, { view: "remote_callsites", remote: {} }, { view: "calls", remote: { name: "Echo" } },
    { view: "remote_callsites", remote: { name: "Echo" }, query: "Echo" },
    { view: "remote_callsites", remote: { name: "Echo" }, callsiteId: "call" },
    { view: "remote_callsites", remote: { logicalPath: "Client//Echo" } },
    { view: "remote_callsites", remote: { logicalPath: "instance://deadbeef" } },
    { view: "remote_callsites", remote: { name: "Echo\n" } },
  ]) {
    const response = await client.callTool({ name: "potassium_code_query", arguments: { indexId: "a".repeat(32), ...args } });
    assert.equal(response._meta.error.code, "INVALID_INPUT");
  }
  assert.deepEqual(requests, []);
});

test("malformed offline candidate pages cannot evade original-result validation or enter retention", async (t) => {
  for (const output of [
    { indexId: "a".repeat(32), view: "calls", rows: [] },
    {
      indexId: "a".repeat(32), view: "remote_callsites", rows: [], total: 0, hasMore: false, truncated: false,
      correlation: "verified-live-receiver", execution: "not-executed", receiverIdentity: "unverified",
      completeness: { syntax: true, bounded: true, semantic: "conservative", execution: "not-executed" },
      limits: { maxRows: 50, maxReceiverDepth: 8, maxReceiverNodes: 32, retainedNameTruncationAt: 128 },
      limitations: [], secret: "private malformed candidate".repeat(2000),
    },
  ]) {
    const { client, requests } = await connectToolFixture(t, {
      clients: [], codeIndexService: { query: () => output, releaseScope() {} },
      compactResultStore: { put() { assert.fail("Malformed source output must not enter retention"); }, releaseScope() {} },
    });
    const response = await client.callTool({
      name: "potassium_code_query", arguments: { indexId: "a".repeat(32), view: "remote_callsites", remote: { name: "Echo" } },
    });
    assert.equal(response.isError, true);
    assert.equal(response._meta.error.code, "RESULT_INVALID");
    assert.equal(response.structuredContent, undefined);
    assert.equal(JSON.stringify(response).includes("private malformed candidate"), false);
    assert.deepEqual(requests, []);
  }
});

test("SDK-generated input errors and result-page failures stay bounded without recursive retention", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    config: { maxMessageBytes: 1024 },
    compactResultStore: {
      read() { throw Object.assign(new Error("Invalid result offset"), { code: "RESULT_INVALID_OFFSET" }); },
      put() { assert.fail("Errors must never be retained"); },
      releaseScope() {},
    },
  });
  const malformed = await client.callTool({
    name: "potassium_tool_catalog",
    arguments: { [`${testToken}${"é\\\"".repeat(3000)}`]: true },
  });
  assert.equal(malformed.isError, true);
  assert.equal(malformed._meta.error.code, "INVALID_INPUT");
  assert.equal(Buffer.byteLength(JSON.stringify(malformed)) <= 1024, true);
  assert.equal(JSON.stringify(malformed).includes(testToken), false);
  assert.equal(requests.length, 0);
  const page = await client.callTool({
    name: "potassium_result_read", arguments: { resultId: "f".repeat(32), offsetBytes: Number.MAX_SAFE_INTEGER },
  });
  assert.equal(page._meta.error.code, "RESULT_INVALID_OFFSET");
  assert.equal(Buffer.byteLength(JSON.stringify(page)) <= 1024, true);
});

test("minimum-frame standard discovery preserves every typed definition and SDK target-page output validation", async (t) => {
  const ordinary = await connectToolFixture(t);
  const normalPage = await ordinary.client.listTools();
  assert.equal(normalPage.nextCursor, undefined);
  const constrained = await connectToolFixture(t, { config: { proxyMaxFrameBytes: 16384 } });
  const pages = [];
  const all = await listAllTools(async (cursor) => {
    const page = await constrained.client.listTools(cursor === undefined ? undefined : { cursor });
    assert.equal(Buffer.byteLength(JSON.stringify(page)) <= 16384 - 8192, true);
    pages.push(page);
    return page;
  }, { forTool: "potassium_status" });
  assert.equal(pages.some((page) => page.nextCursor !== undefined), true);
  assert.deepEqual(all.tools, normalPage.tools);
  assert.equal(new Set(all.tools.map((tool) => tool.name)).size, all.tools.length);
  // Deliberately bypass server output validation: re-fetching the target page
  // must leave the real SDK client's public validation path effective.
  constrained.server.server.setRequestHandler(CallToolRequestSchema, async () => formatToolResult({ connected: "invalid" }));
  await assert.rejects(constrained.client.callTool({ name: "potassium_status", arguments: {} }), (error) => error.code === ErrorCode.InvalidParams);
});

test("discovery cursors bind session and catalog revision across lazy activation", async (t) => {
  const open = () => connectToolFixture(t, {
    config: { proxyMaxFrameBytes: 16384 },
    client: new Client({ name: "paged-lazy", version: "1" }, {
      capabilities: { experimental: { "potassium/tool-discovery": { version: 1, listChanged: true } } },
    }),
  });
  const first = await open();
  const second = await open();
  const enable = [
    "potassium_batch_read", "potassium_remote_inventory", "potassium_capabilities",
    "potassium_watch_start", "potassium_watch_poll", "potassium_watch_stop",
    "potassium_find_instances", "potassium_inspect_instance", "potassium_read_properties",
    "potassium_subtree_summary", "potassium_ui_inventory", "potassium_spatial_query",
  ];
  for (const fixture of [first, second]) {
    await fixture.client.callTool({ name: "potassium_tool_catalog", arguments: { enable, limit: 1 } });
  }
  const page = await first.client.listTools();
  assert.equal(typeof page.nextCursor, "string");
  const following = await first.client.listTools({ cursor: page.nextCursor });
  assert.deepEqual((await first.client.listTools({ cursor: page.nextCursor })), following);
  await assert.rejects(second.client.listTools({ cursor: page.nextCursor }), (error) => error.code === ErrorCode.InvalidParams);
  await assert.rejects(first.client.listTools({ cursor: "not-a-cursor" }), (error) => error.code === ErrorCode.InvalidParams);
  const tampered = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"));
  tampered[2] += 1;
  await assert.rejects(first.client.listTools({ cursor: Buffer.from(JSON.stringify(tampered)).toString("base64url") }), (error) => error.code === ErrorCode.InvalidParams);
  await first.client.callTool({ name: "potassium_tool_catalog", arguments: { enable: ["potassium_client_state"], limit: 1 } });
  await assert.rejects(first.client.listTools({ cursor: page.nextCursor }), (error) => error.code === ErrorCode.InvalidParams);
  const refreshed = await listAllTools((cursor) => first.client.listTools(cursor === undefined ? undefined : { cursor }));
  assert.equal(refreshed.tools.some((tool) => tool.name === "potassium_client_state"), true);
});

test("an individual unpageable typed definition produces a clear bounded discovery error", async (t) => {
  const { client, server } = await connectToolFixture(t, { config: { proxyMaxFrameBytes: 16384 } });
  server.registerTool("potassium_builtin_status", {
    inputSchema: z.object({ query: z.string().describe("Required schema detail. ".repeat(2048)) }).strict(),
  }, async () => formatToolResult({ ok: true }));
  await assert.rejects(listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor })), (error) => {
    assert.equal(error.code, ErrorCode.InternalError);
    assert.equal(error.data.code, "TOOL_SCHEMA_TOO_LARGE");
    assert.equal(error.data.toolName, "potassium_builtin_status");
    return true;
  });
});

test("SDK multi-pointer pages preserve value typing under the complete response budget", async (t) => {
  const { client } = await connectToolFixture(t, {
    config: { maxMessageBytes: 1024 },
    request: async () => ({ count: 0, flag: false, text: "é😀".repeat(4000) }),
  });
  const descriptor = (await client.callTool({ name: "potassium_client_state", arguments: {} })).structuredContent;
  const args = { resultId: descriptor.resultId, pointers: ["/count", "/flag", "/text"], maxBytes: 4096 };
  const result = await client.callTool({ name: "potassium_result_read", arguments: args });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.selections.slice(0, 2), [
    { pointer: "/count", kind: "value", value: 0 }, { pointer: "/flag", kind: "value", value: false },
  ]);
  assert.equal(result.structuredContent.hasMore, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) <= 1024, true);
  assert.equal(result.structuredContent.kind, undefined);
  const auto = await client.callTool({
    name: "potassium_result_read", arguments: { resultId: descriptor.resultId, pointer: "/flag", view: "auto" },
  });
  assert.deepEqual(auto.structuredContent.selections, [{ pointer: "/flag", kind: "value", value: false }]);
  const invalid = await client.callTool({
    name: "potassium_result_read", arguments: { ...args, pointers: ["/count", "/missing"] },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  const replay = await client.callTool({ name: "potassium_result_read", arguments: args });
  assert.deepEqual(replay.structuredContent, result.structuredContent);
});

test("session metrics count final result bytes and rejected inputs separately without executor access", async (t) => {
  const { client, requests } = await connectToolFixture(t, { clients: [] });
  const status = await client.callTool({ name: "potassium_status", arguments: {} });
  const invalid = await client.callTool({ name: "potassium_read_properties", arguments: { path: "workspace", properties: [] } });
  assert.equal(invalid.isError, true);
  const stats = (await client.callTool({ name: "potassium_session_stats", arguments: {} })).structuredContent;
  assert.equal(stats.scope, "retained-mcp-session");
  assert.equal(stats.calls, 2);
  assert.equal(stats.inFlight, 1);
  assert.equal(stats.protocolErrors, 1);
  assert.equal(stats.errors, 0);
  assert.equal(stats.resultBytes, Buffer.byteLength(JSON.stringify(status)));
  assert.equal(stats.perTool.find((row) => row.toolName === "potassium_status").resultBytes, stats.resultBytes);
  assert.deepEqual(requests, []);
  const other = await connectToolFixture(t, { clients: [] });
  const isolated = (await other.client.callTool({ name: "potassium_session_stats", arguments: {} })).structuredContent;
  assert.equal(isolated.calls, 1);
  assert.equal(isolated.resultBytes, 0);
  assert.equal(isolated.protocolErrors, 0);
});

test("offline source tools reject unavailable roots and indexes without consulting Roblox", async (t) => {
  const { client, requests } = await connectToolFixture(t, { clients: [] });
  const index = await client.callTool({
    name: "potassium_code_index", arguments: { modules: [{ id: "missing", root: "unknown", path: "Main.luau" }] },
  });
  assert.equal(index.isError, true);
  assert.equal(index._meta.error.code, "CODE_SOURCE_DENIED");
  const query = await client.callTool({ name: "potassium_code_query", arguments: { indexId: "a".repeat(32) } });
  assert.equal(query._meta.error.code, "CODE_NOT_FOUND");
  assert.deepEqual(requests, []);
});

test("SDK cancellation reaches offline parser work without a connected executor", { timeout: 3000 }, async (t) => {
  let enter, observeAbort;
  const entered = new Promise((resolve) => { enter = resolve; });
  const aborted = new Promise((resolve) => { observeAbort = resolve; });
  const codeIndexService = createCodeIndexService({
    parse: (_modules, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observeAbort();
        reject(Object.assign(new Error("Source parsing cancelled"), { code: "CODE_CANCELLED" }));
      }, { once: true });
      enter();
    }),
  });
  const { client, requests } = await connectToolFixture(t, { clients: [], codeIndexService });
  const controller = new AbortController();
  const pending = client.callTool({
    name: "potassium_code_index", arguments: { modules: [{ id: "Main", source: "return 1" }] },
  }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await entered;
  controller.abort();
  await rejected;
  await aborted;
  assert.deepEqual(requests, []);
});

test("remote acceptance remains authoritative after local formatting failure and fits minimum discovery frames", async (t) => {
  const jobId = "d".repeat(32);
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true, maxMessageBytes: 1024, proxyMaxFrameBytes: 16384 },
    request: async () => ({ jobId, state: "queued", toJSON() { throw new Error("Local serialization failed"); } }),
  });
  const tools = (await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools;
  const remoteTool = tools.find((tool) => tool.name === "potassium_remote_call");
  assert.equal(remoteTool.annotations.readOnlyHint, false);
  assert.equal(remoteTool.annotations.destructiveHint, true);
  assert.equal(remoteTool.annotations.openWorldHint, true);
  const result = await client.callTool({
    name: "potassium_remote_call", arguments: {
      target: "workspace.Echo", method: "InvokeServer",
      arguments: [false, { type: "Array", values: [null, { type: "Vector3", x: 1, y: 2, z: 3 }] }, null],
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.jobId, jobId);
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(result.structuredContent.warning, "RESULT_FORMAT_FAILED");
  assert.equal(Buffer.byteLength(JSON.stringify(result)) <= 1024, true);
  const submissions = requests.filter(({ method }) => method === "remote_call");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].params.argumentCount, 3);
  assert.deepEqual(submissions[0].params.arguments[2], { type: "nil" });
  assert.deepEqual(submissions[0].params.arguments[1].values[0], { type: "nil" });
});

test("remote typed validation rejects unknown envelopes and bounded-work excess before dispatch", async (t) => {
  const { client, requests } = await connectToolFixture(t, { config: { allowUnsafeExecute: true } });
  let deep = null;
  for (let depth = 0; depth < 6; depth += 1) deep = { type: "Array", values: [deep] };
  for (const values of [
    [{ type: "nil" }], [{ type: "Instance", reference: "workspace.Part" }],
    [{ type: "Vector3", x: 1, y: 2, z: 3, extra: true }],
    [{ type: "CFrame", components: [1, 2] }], [deep],
    [{ type: "Array", values: Array.from({ length: 256 }, () => true) }],
    Array.from({ length: 16 }, () => "x".repeat(4096)),
  ]) {
    const result = await client.callTool({
      name: "potassium_remote_call", arguments: { target: "workspace.Echo", method: "InvokeServer", arguments: values },
    });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(requests, []);
});

test("new runtime feature gates remain per-client while overview keeps legacy compatibility", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true },
    capabilities: () => ({ ...featureCapabilities, remoteActions: {}, actionObservation: {}, diagnosticSnapshot: { version: 1 } }),
    request: async () => ({ place: { placeId: 123 } }),
  });
  for (const [name, args] of [
    ["potassium_remote_call", { target: "workspace.Echo", method: "FireServer", arguments: [] }],
    ["potassium_observe_action", { operation: "start", requests: [{ path: "workspace", properties: ["Name"] }] }],
    ["potassium_diagnostic_snapshot", { view: "nearby", radius: 16, limit: 2 }],
  ]) {
    const denied = await client.callTool({ name, arguments: args });
    assert.equal(denied._meta.error.code, "INCOMPATIBLE_CLIENT");
    assert.equal(denied._meta.error.submissionIndeterminate, false);
  }
  assert.equal(requests.every(({ method }) => method === "capabilities"), true);
  const overview = await client.callTool({ name: "potassium_diagnostic_snapshot", arguments: {} });
  assert.deepEqual(overview.structuredContent, { place: { placeId: 123 } });
  assert.deepEqual(requests.filter(({ method }) => method === "diagnostic_snapshot").map(({ params }) => params), [{}]);
  const oldReferences = await connectToolFixture(t, {
    capabilities: () => ({ ...featureCapabilities, instanceReferences: {} }),
  });
  const rejected = await oldReferences.client.callTool({
    name: "potassium_diagnostic_snapshot", arguments: { view: "character" },
  });
  assert.equal(rejected._meta.error.code, "INCOMPATIBLE_CLIENT");
  assert.equal(oldReferences.requests.every(({ method }) => method === "capabilities"), true);
});

test("remote execution input audit survives replay above the raw-Luau limit without retaining arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-remote-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.ndjson");
  const audit = new AdminAuditRecorder({ path });
  const jobId = "d".repeat(32);
  const secret = "private-remote-value".repeat(180);
  const { client, requests } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true }, audit,
    request: async () => ({ jobId, state: "queued" }),
  });
  const response = await client.callTool({
    name: "potassium_remote_call",
    arguments: { target: "workspace.Echo", method: "InvokeServer", arguments: Array.from({ length: 12 }, () => secret) },
  });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.jobId, jobId);
  assert.equal(response.structuredContent.warning, undefined);
  const request = requests.find(({ method }) => method === "remote_call");
  const serialized = JSON.stringify(request.params);
  const history = new AdminAuditRecorder({ path }).history(1);
  assert.equal(history.length, 1);
  assert.equal(history[0].utf8Bytes > 32768, true);
  assert.equal(history[0].utf8Bytes, Buffer.byteLength(serialized));
  assert.equal(history[0].codeSha256, createHash("sha256").update(serialized).digest("hex"));
  assert.equal((await readFile(path, "utf8")).includes(secret), false);
  assert.equal((await client.callTool({
    name: "potassium_execute_luau", arguments: { code: "x".repeat(32769) },
  })).isError, true);
  assert.equal(requests.some(({ method }) => method === "execute_luau"), false);
});

test("SDK source indexing preserves malformed native parser tree errors", async (t) => {
  const codeIndexService = createCodeIndexService({
    parse: async (modules) => analyzeNativeSourcePackage(modules, null),
  });
  const { client, requests } = await connectToolFixture(t, { clients: [], codeIndexService });
  const result = await client.callTool({
    name: "potassium_code_index",
    arguments: { modules: [{ id: "Main", logicalPath: "Main.luau", source: "return 1" }] },
  });
  assert.equal(result.isError, true);
  assert.equal(result._meta.error.code, "PARSER_TREE_INVALID");
  assert.equal(result.structuredContent, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result._meta);
  assert.deepEqual(requests, []);
});

test("structured results opt-in avoids duplicate retention while text clients can recover the entire canonical payload", async (t) => {
  const payload = { position: { x: 0, y: 2, z: 3 }, label: "loaded".repeat(900) };
  for (const version of [undefined, 2, 1]) {
    await t.test(`structured capability ${version ?? "absent"}`, async (t) => {
      const client = new Client({ name: "structured-result-test", version: "1" }, {
        capabilities: version === undefined ? {} : { experimental: { "potassium/structured-results": { version } } },
      });
      const fixture = await connectToolFixture(t, { client, request: async () => payload });
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_client_state" });
      const result = await client.callTool({ name: "potassium_client_state", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
      if (version === 1) {
        assert.deepEqual(result.structuredContent, payload);
        assert.ok(Buffer.byteLength(result.content[0].text) < 100);
      } else {
        const descriptor = JSON.parse(result.content[0].text);
        assert.equal(descriptor.kind, "potassium/result");
        let text = "", offsetBytes = 0;
        do {
          const pageResult = await client.callTool({
            name: "potassium_result_read", arguments: { resultId: descriptor.resultId, view: "text", offsetBytes, maxBytes: 4096 },
          });
          const page = JSON.parse(pageResult.content[0].text);
          text += page.text;
          if (!page.hasMore) break;
          assert.ok(page.nextOffsetBytes > offsetBytes);
          offsetBytes = page.nextOffsetBytes;
        } while (true);
        assert.deepEqual(JSON.parse(text), payload);
        assert.equal(createHash("sha256").update(text).digest("hex"), descriptor.sha256);
      }
      payload.label += "larger".repeat(1500);
      const large = await client.callTool({ name: "potassium_client_state", arguments: {} });
      assert.equal(large.structuredContent.kind, "potassium/result");
      const selected = await client.callTool({
        name: "potassium_result_read", arguments: { resultId: large.structuredContent.resultId, pointer: "/position" },
      });
      assert.deepEqual(selected.structuredContent.selections, [{ pointer: "/position", kind: "value", value: payload.position }]);
      assert.equal(fixture.requests.filter(({ method }) => method === "client_state").length, 2);
      payload.label = "loaded".repeat(900);
    });
  }
});

test("capabilities summary and sections reduce public payloads without narrowing feature preflight", async (t) => {
  const capabilities = { ...featureCapabilities, bootstrap: { build: "lifecycle-3", generation: 4 }, remoteInventory: { version: 4, query: { scope: "retained-rows" } }, notes: "detail".repeat(2000) };
  const { client, requests } = await connectToolFixture(t, { capabilities: () => capabilities, request: async () => ({ view: "summary" }) });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_capabilities" });
  const full = await client.callTool({ name: "potassium_capabilities", arguments: { view: "full" } });
  assert.equal(full.structuredContent.kind, "potassium/result");
  const summary = await client.callTool({ name: "potassium_capabilities", arguments: {} });
  assert.deepEqual(summary.structuredContent.features.remoteInventory, { version: 4 });
  assert.equal(summary.structuredContent.methodCount, capabilities.methods.length);
  assert.deepEqual(summary.structuredContent.bootstrap, capabilities.bootstrap);
  assert.equal(summary.structuredContent.notes, undefined);
  const section = await client.callTool({ name: "potassium_capabilities", arguments: { view: "section", section: "remoteInventory" } });
  assert.deepEqual(section.structuredContent.value, capabilities.remoteInventory);
  const scan = await client.callTool({ name: "potassium_remote_inventory", arguments: {} });
  assert.equal(scan.isError, undefined);
  assert.ok(requests.filter(({ method }) => method === "capabilities").every(({ params }) => Object.keys(params).length === 0));
  const before = requests.length;
  for (const args of [{ section: "methods" }, { view: "section" }, { view: "summary", section: "methods" }]) {
    assert.equal((await client.callTool({ name: "potassium_capabilities", arguments: args })).isError, true);
  }
  assert.equal(requests.length, before);
});

test("retained inventory query validates selectors and gates version four without changing ordinary version-three scans", async (t) => {
  const old = { clientId: "a".repeat(32), generation: 1, client: { protocol: 2 } };
  const current = { clientId: "b".repeat(32), generation: 1, client: { protocol: 2 } };
  const snapshotId = "d".repeat(32);
  const { client, requests } = await connectToolFixture(t, {
    clients: [old, current],
    capabilities: (clientId) => ({ ...featureCapabilities, remoteInventory: { version: clientId === old.clientId ? 3 : 4 } }),
    request: async (_method, params) => params.query === undefined ? { view: "summary" }
      : { view: "rows", snapshotId, queryScope: "retained-rows", queryMatched: 1, rows: [{ rowId: "e".repeat(32), name: "Selected" }], visited: 50, retained: 12, coverage: "partial" },
  });
  const valid = { clientId: current.clientId, view: "rows", snapshotId, query: { nameContains: "Selected" } };
  for (const args of [
    { ...valid, snapshotId: undefined }, { ...valid, view: "diff", compareTo: "f".repeat(32) },
    { ...valid, view: "release" }, { ...valid, view: "detail", rowId: "e".repeat(32) },
    { ...valid, query: { nameContains: "x".repeat(257) } }, { ...valid, query: { pathContains: "x".repeat(513) } },
    { ...valid, query: { classNames: ["Part"] } }, { ...valid, query: { unknown: true } },
  ]) assert.equal((await client.callTool({ name: "potassium_remote_inventory", arguments: args })).isError, true);
  assert.deepEqual(requests, []);
  const rejected = await client.callTool({ name: "potassium_remote_inventory", arguments: { ...valid, clientId: old.clientId } });
  assert.equal(rejected._meta.error.code, "INCOMPATIBLE_CLIENT");
  assert.equal(requests.some(({ method }) => method === "remote_inventory"), false);
  const ordinary = await client.callTool({ name: "potassium_remote_inventory", arguments: { clientId: old.clientId } });
  assert.equal(ordinary.isError, undefined);
  const filtered = await client.callTool({ name: "potassium_remote_inventory", arguments: valid });
  assert.equal(filtered.structuredContent.queryMatched, 1);
  assert.equal(filtered.structuredContent.visited, 50);
  assert.equal(filtered.structuredContent.retained, 12);
  assert.equal(filtered.structuredContent.rows[0].rowId, "e".repeat(32));
});

function contextScene() {
  return {
    schema: 2, sourceSnapshotId: "d".repeat(32), root: "workspace", place: { placeId: 123, placeVersion: 1, name: "Loaded place" },
    player: { present: true, position: { x: 0, y: 5, z: 0 } },
    coverage: "partial", truncated: true, visited: 3, stopReasons: ["maxVisited"],
    facetCoverage: {
      geometry: { visited: 1, coverage: "partial", truncated: true, stopReasons: ["maxVisited"] },
      ui: { visited: 0, coverage: "complete", truncated: false, stopReasons: [] },
      remotes: { visited: 2, coverage: "partial", truncated: true, stopReasons: ["maxVisited"] },
    },
    parts: [{
      sourceObjectId: "e".repeat(32), name: "Observed floor", path: "workspace.Floor", className: "Part", shape: "Block",
      cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      size: { x: 20, y: 1, z: 20 }, anchored: true, canCollide: true,
    }],
    ui: { coverage: "complete", truncated: false, entries: [] }, atomicSnapshot: false,
    remotes: { root: "game.ReplicatedStorage", coverage: "partial", truncated: true, entries: [
      { name: testToken, path: "game.ReplicatedStorage.Update", className: "RemoteEvent" },
      { name: "Query", path: "game.ReplicatedStorage.Query", className: "RemoteFunction" },
    ] },
  };
}

test("game contexts persist across closed sessions and service recreation for read-authorized offline reuse", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-context-sdk-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, "{}");
  const service = createGameContextService({ configFile });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  const scene = contextScene();
  const owner = await connectToolFixture(t, { gameContextService: service, request: async () => scene });
  const captured = await owner.client.callTool({ name: "potassium_game_context", arguments: { screenshot: false, map: false, remoteLimit: 2 } });
  assert.equal(captured.isError, undefined);
  const { contextId, capturedAt } = captured.structuredContent;
  assert.match(contextId, /^gc-[a-f0-9]{32}$/);
  scene.parts[0].name = "Changed after capture";
  scene.remotes.entries[0].name = "Changed after capture";
  assert.equal(captured.structuredContent.counts.remotes, 2);
  await owner.server.close();
  service.close();
  const reopened = createGameContextService({ configFile });
  t.after(() => reopened.close());
  const reader = await connectToolFixture(t, {
    clients: [], gameContextService: reopened, policy: { read: true, admin: false, execute: false },
    request: async () => assert.fail("Offline context views must not consult the executor"),
  });
  const listed = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "list" } });
  assert.equal(listed.structuredContent.contexts[0].contextId, contextId);
  assert.equal(listed.structuredContent.contexts[0].counts.remotes, 2);
  const parts = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "read", contextId, section: "parts" } });
  assert.equal(parts.structuredContent.entries[0].name, "Observed floor");
  assert.equal(parts.structuredContent.entries[0].sourceObjectId, undefined);
  assert.equal(parts.structuredContent.entries[0].shape, undefined);
  assert.equal(parts.structuredContent.capturedAt, capturedAt);
  const remotes = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "read", contextId, section: "remotes", limit: 1 } });
  assert.deepEqual(remotes.structuredContent.entries, [{ name: "[redacted]", path: "game.ReplicatedStorage.Update", className: "RemoteEvent" }]);
  assert.equal(remotes.structuredContent.capturedAt, capturedAt);
  assert.equal(remotes.structuredContent.sectionCoverage, "partial");
  assert.equal(remotes.structuredContent.sectionTruncated, true);
  const secondReader = await connectToolFixture(t, {
    clients: [], gameContextService: reopened, policy: { read: true, admin: false, execute: false },
    request: async () => assert.fail("Shared remote metadata must remain offline"),
  });
  const remaining = await secondReader.client.callTool({ name: "potassium_game_context", arguments: { view: "read", contextId, section: "remotes", offset: remotes.structuredContent.nextOffset } });
  assert.deepEqual(remaining.structuredContent.entries, [{ name: "Query", path: "game.ReplicatedStorage.Query", className: "RemoteFunction" }]);
  assert.deepEqual(secondReader.requests, []);
  const image = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "image", contextId, kind: "map" } });
  assert.equal(image._meta.error.code, "GAME_CONTEXT_IMAGE_UNAVAILABLE");
  reader.server.policy = { read: false, admin: true, execute: false };
  const denied = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "list" } });
  assert.equal(denied._meta.error.code, "POLICY_DENIED");
  reader.server.policy = { read: true, admin: false, execute: false };
  const released = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "release", contextId } });
  assert.equal(released.structuredContent.released, true);
  const missing = await reader.client.callTool({ name: "potassium_game_context", arguments: { view: "read", contextId } });
  assert.equal(missing._meta.error.code, "GAME_CONTEXT_NOT_FOUND");
  assert.deepEqual(reader.requests, []);
});

test("context capture refuses generation replacement and missing storage without publishing a snapshot", async (t) => {
  const unavailable = await connectToolFixture(t, { clients: [] });
  const missing = await unavailable.client.callTool({ name: "potassium_game_context", arguments: { view: "list" } });
  assert.equal(missing._meta.error.code, "GAME_CONTEXT_UNAVAILABLE");
  assert.deepEqual(unavailable.requests, []);
  const directory = await mkdtemp(join(tmpdir(), "potassium-context-fence-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, "{}");
  const service = createGameContextService({ configFile });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  const clients = [{ clientId: "c".repeat(32), generation: 1, client: { protocol: 2 } }];
  let gameContextVersion = 1;
  const owner = await connectToolFixture(t, {
    clients, gameContextService: service,
    capabilities: () => ({ ...featureCapabilities, gameContext: { version: gameContextVersion } }),
    request: async () => { clients[0].generation += 1; return contextScene(); },
  });
  const incompatible = await owner.client.callTool({ name: "potassium_game_context", arguments: { screenshot: false, map: false } });
  assert.equal(incompatible._meta.error.code, "INCOMPATIBLE_CLIENT");
  assert.equal(owner.requests.some(({ method }) => method === "game_context"), false);
  gameContextVersion = 2;
  const changed = await owner.client.callTool({ name: "potassium_game_context", arguments: { screenshot: false, map: false } });
  assert.equal(changed._meta.error.code, "GAME_CONTEXT_CLIENT_CHANGED");
  const list = await owner.client.callTool({ name: "potassium_game_context", arguments: { view: "list" } });
  assert.deepEqual(list.structuredContent.contexts, []);
});

// A baseline 1x1 JPEG with a valid COM segment exercises media transport, not native capture.
const contextJpeg = Buffer.concat([
  Buffer.from("ffd8fffe2712", "hex"), Buffer.alloc(10000, 0x61),
  Buffer.from("ffdb004300", "hex"), Buffer.alloc(64, 1),
  Buffer.from("ffc0000b080001000101011100ffc40026", "hex"),
  Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0]),
  Buffer.from([0x10, 1]), Buffer.alloc(15), Buffer.from([0]),
  Buffer.from("ffda0008010100003f003fffd9", "hex"),
]);

function contextImageMetadata() {
  return {
    view: "image", contextId: `gc-${"a".repeat(32)}`, capturedAt: "2026-09-09T12:00:00.000Z",
    client: { clientId: "c".repeat(32), generation: 1 }, place: { placeId: 123, name: testToken },
    player: { present: false }, root: "workspace", coverage: "complete", truncated: false, visited: 0, stopReasons: [],
    counts: { parts: 0, ui: 0, remotes: 0 },
    images: {
      screenshot: { status: "not-requested", reason: "not-requested" },
      map: { status: "available", mimeType: "image/jpeg", width: 1, height: 1, bytes: contextJpeg.length, sha256: createHash("sha256").update(contextJpeg).digest("hex"), provider: "transport-fixture" },
    },
    partial: false, static: true, atomicSnapshot: false, warnings: ["Transport fixture, not a native screenshot or schematic."], kind: "map",
  };
}

test("SDK images survive the media lane once without weakening metadata validation, redaction, or ordinary limits", async (t) => {
  for (const structured of [false, true]) {
    await t.test(`structured ${structured}`, async (t) => {
      let metadata = contextImageMetadata();
      const image = { data: contextJpeg, mimeType: "image/jpeg", width: 1, height: 1 };
      const client = new Client({ name: "image-transport", version: "1" }, {
        capabilities: structured ? { experimental: { "potassium/structured-results": { version: 1 } } } : {},
      });
      const { requests } = await connectToolFixture(t, {
        client, clients: [], gameContextService: { image: async () => ({ metadata, image }) },
        compactResultStore: { put() { assert.fail("Images or invalid results must never become JSON descriptors"); }, releaseScope() {} },
      });
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_game_context" });
      const args = { view: "image", kind: "map", contextId: metadata.contextId };
      const result = await client.callTool({ name: "potassium_game_context", arguments: args });
      assert.equal(result.isError, undefined);
      const images = result.content.filter(({ type }) => type === "image");
      assert.equal(images.length, 1);
      assert.deepEqual(Buffer.from(images[0].data, "base64"), contextJpeg);
      const wire = JSON.stringify(result);
      assert.ok(Buffer.byteLength(wire) > 8192 && Buffer.byteLength(wire) <= 65536);
      assert.equal(wire.split(contextJpeg.toString("base64")).length, 2);
      assert.equal(result.structuredContent.place.name, "[redacted]");
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      metadata = { ...metadata, unexpected: "rejected private metadata" };
      const invalid = await client.callTool({ name: "potassium_game_context", arguments: args });
      assert.equal(invalid._meta.error.code, "RESULT_INVALID");
      assert.equal(invalid.content.some(({ type }) => type === "image"), false);
      assert.equal(JSON.stringify(invalid).includes("rejected private metadata"), false);
      metadata = contextImageMetadata();
      metadata.images.map.sha256 = "0".repeat(64);
      const corrupt = await client.callTool({ name: "potassium_game_context", arguments: args });
      assert.equal(corrupt._meta.error.code, "RESULT_INVALID");
      assert.equal(corrupt.content.some(({ type }) => type === "image"), false);
      assert.deepEqual(requests, []);
    });
  }
  const metadata = contextImageMetadata();
  const image = { data: contextJpeg, mimeType: "image/jpeg", width: 1, height: 1 };
  const limited = await connectToolFixture(t, {
    config: { maxMessageBytes: 8192 }, gameContextService: { image: async () => ({ metadata, image }) },
    request: async () => ({ text: "ordinary metadata".repeat(1000) }),
  });
  const tooLarge = await limited.client.callTool({ name: "potassium_game_context", arguments: { view: "image", kind: "map", contextId: metadata.contextId } });
  assert.equal(tooLarge._meta.error.code, "GAME_CONTEXT_IMAGE_UNAVAILABLE");
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) <= 8192);
  assert.equal(tooLarge.content.some(({ type }) => type === "image"), false);
  const ordinary = await limited.client.callTool({ name: "potassium_client_state", arguments: {} });
  assert.equal(ordinary.structuredContent.kind, "potassium/result");
  assert.ok(Buffer.byteLength(JSON.stringify(ordinary)) <= 8192);
});

test("validated capture identity remains usable when metadata is compacted or retention fails", async (t) => {
  const { kind: _kind, ...metadata } = contextImageMetadata();
  metadata.view = "capture";
  for (const failRetention of [false, true]) {
    await t.test(`retention failure ${failRetention}`, async (t) => {
      const compactResultStore = failRetention ? {
        put() { throw Object.assign(new Error("Store unavailable"), { code: "RESULT_STORE_UNAVAILABLE" }); }, releaseScope() {},
      } : createCompactResultStore();
      const { client } = await connectToolFixture(t, {
        config: { maxMessageBytes: 1024 }, compactResultStore,
        gameContextService: { capture: async () => metadata },
      });
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_game_context" });
      const result = await client.callTool({ name: "potassium_game_context", arguments: { screenshot: false, map: false } });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.contextId, metadata.contextId);
      assert.equal(result.structuredContent.accepted, true);
      assert.equal(result.structuredContent.capturedAt, metadata.capturedAt);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
      if (failRetention) assert.equal(result.structuredContent.warning, "RESULT_STORE_UNAVAILABLE");
      else assert.equal(result.structuredContent.kind, "potassium/result");
    });
  }
  Object.defineProperty(metadata, "toJSON", { value: () => ({}) });
  const formatting = await connectToolFixture(t, { gameContextService: { capture: async () => metadata } });
  const failed = await formatting.client.callTool({ name: "potassium_game_context", arguments: { screenshot: false, map: false } });
  assert.equal(failed.isError, true);
  assert.equal(failed._meta.error.code, "RESULT_INVALID");
  assert.equal(failed._meta.accepted, true);
  assert.equal(failed._meta.contextId, metadata.contextId);
});

function mapSummary(view = "build") {
  return {
    view, mapId: `map-${"a".repeat(32)}`, revision: 1, createdAt: "2026-09-09T12:00:00.000Z",
    chunkSize: 64,
    sourceContextIds: [`gc-${"b".repeat(32)}`],
    counts: { parts: 1, surfaces: 1, chunks: 1, links: 0, tracks: 0, hazards: 0 },
    scope: { placeId: 123, clientId: "c".repeat(32), generation: 1 },
    coverage: "partial", profileSource: "assumed", stopReasons: [], warnings: [],
  };
}

function mapMechanics(view = "apply") {
  return {
    view, mapId: `map-${"f".repeat(32)}`, revision: 2, parentMapId: mapSummary().mapId,
    mechanics: {
      supportModes: ["floor", "ceiling"],
      transitions: [{
        id: "reported-switch", partId: "reported-pad", fromMode: "floor", toMode: "ceiling",
        evidence: { kind: "user-report", note: "The pad turns the world toward the ceiling.", reportedAt: "2026-09-09T12:00:00.000Z" },
      }],
    },
    coverage: "partial", warnings: [],
  };
}

test("map mechanics apply stays offline across SDK sessions and retains reports after source eviction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-map-sdk-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, "{}");
  let now = Date.parse("2026-09-09T12:00:00.000Z");
  const contexts = createGameContextService({ configFile, clock: { now: () => ++now } });
  const maps = createMapContextService({ configFile, gameContextService: contexts });
  t.after(async () => { maps.close(); contexts.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = await contexts.capture({ screenshot: false, map: false, remoteLimit: 2 }, {
    client: { clientId: "c".repeat(32), generation: 1 }, isCurrent: () => true,
    clientCount: 1, imageBudget: 0, collect: async () => contextScene(),
  });
  const { client, server, requests } = await connectToolFixture(t, {
    clients: [], mapContextService: maps, policy: { read: true, admin: false, execute: false },
    config: { proxyMaxFrameBytes: 16384 },
  });
  const discovery = await listAllTools(async (cursor) => {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    return page;
  });
  for (const name of ["potassium_map_context", "potassium_map_geometry", "potassium_map_navigation", "potassium_map_motion", "potassium_map_mechanics", "potassium_map_recording", "potassium_map_recording_read"]) assert.ok(discovery.tools.some((tool) => tool.name === name));
  const built = await client.callTool({ name: "potassium_map_context", arguments: { contextIds: [saved.contextId] } });
  assert.equal(built.isError, undefined);
  const { mapId } = built.structuredContent;
  assert.match(mapId, /^map-[a-f0-9]{32}$/);
  assert.equal(built.structuredContent.revision, 1);
  const updated = await client.callTool({ name: "potassium_map_context", arguments: { view: "update", mapId, contextIds: [saved.contextId] } });
  assert.equal(updated.isError, undefined);
  assert.notEqual(updated.structuredContent.mapId, mapId);
  assert.equal(updated.structuredContent.parentMapId, mapId);
  assert.equal(updated.structuredContent.revision, 2);
  const original = await client.callTool({ name: "potassium_map_context", arguments: { view: "read", mapId } });
  assert.equal(original.structuredContent.revision, 1);
  const replaced = await connectToolFixture(t, {
    mapContextService: maps,
    clients: [{ clientId: "c".repeat(32), generation: 2, client: { protocol: 2 } }],
  });
  const mismatched = await replaced.client.callTool({
    name: "potassium_map_context",
    arguments: { view: "probe", mapId, center: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 10, z: 10 } },
  });
  assert.equal(mismatched._meta.error.code, "MAP_CONTEXT_CLIENT_CHANGED");
  assert.deepEqual(replaced.requests, []);
  for (let replacement = 0; replacement < 8; replacement += 1) {
    await contexts.capture({ screenshot: false, map: false, remoteLimit: 2 }, {
      client: { clientId: "c".repeat(32), generation: 1 }, isCurrent: () => true,
      clientCount: 1, imageBudget: 0, collect: async () => contextScene(),
    });
  }
  await assert.rejects(contexts.read({ contextId: saved.contextId }), { code: "GAME_CONTEXT_NOT_FOUND" });
  const parts = await client.callTool({ name: "potassium_map_geometry", arguments: { mapId } });
  const partId = parts.structuredContent.entries[0].id;
  const applyArgs = {
    view: "apply", mapId, supportModes: ["floor", "ceiling"],
    transitions: [{ partId, fromMode: "floor", toMode: "ceiling", note: "Walking onto this pad turns the world toward the ceiling." }],
  };
  const beforeWrongPart = await client.callTool({ name: "potassium_map_context", arguments: { view: "list" } });
  const wrongPart = await client.callTool({
    name: "potassium_map_mechanics",
    arguments: { ...applyArgs, transitions: [{ ...applyArgs.transitions[0], partId: "part-from-another-map" }] },
  });
  assert.equal(wrongPart._meta.error.code, "MAP_CONTEXT_INVALID_INPUT");
  assert.equal(wrongPart._meta.accepted, undefined);
  const afterWrongPart = await client.callTool({ name: "potassium_map_context", arguments: { view: "list" } });
  assert.deepEqual(afterWrongPart.structuredContent, beforeWrongPart.structuredContent);
  const annotated = await client.callTool({ name: "potassium_map_mechanics", arguments: applyArgs });
  assert.equal(annotated.isError, undefined);
  assert.notEqual(annotated.structuredContent.mapId, mapId);
  assert.equal(annotated.structuredContent.parentMapId, mapId);
  assert.equal(annotated.structuredContent.revision, 2);
  const reported = annotated.structuredContent.mechanics.transitions[0];
  assert.equal(reported.partId, partId);
  assert.equal(reported.evidence.kind, "user-report");
  assert.equal(reported.evidence.note, applyArgs.transitions[0].note);
  assert.equal(Number.isFinite(Date.parse(reported.evidence.reportedAt)), true);
  await server.close();
  const reader = await connectToolFixture(t, { clients: [], mapContextService: maps });
  const readMechanics = await reader.client.callTool({ name: "potassium_map_mechanics", arguments: { mapId: annotated.structuredContent.mapId } });
  assert.equal(readMechanics.isError, undefined);
  assert.deepEqual(readMechanics.structuredContent.mechanics, annotated.structuredContent.mechanics);
  const oldMechanics = await reader.client.callTool({ name: "potassium_map_mechanics", arguments: { mapId } });
  assert.deepEqual(oldMechanics.structuredContent.mechanics, { supportModes: ["floor"], transitions: [] });
  const orientedSurfaces = await reader.client.callTool({
    name: "potassium_map_geometry", arguments: { mapId: annotated.structuredContent.mapId, section: "surfaces" },
  });
  assert.equal(orientedSurfaces.isError, undefined);
  assert.deepEqual(new Set(orientedSurfaces.structuredContent.entries.map((surface) => surface.supportMode)), new Set(["floor", "ceiling"]));
  const cleared = await reader.client.callTool({
    name: "potassium_map_mechanics",
    arguments: { view: "apply", mapId: annotated.structuredContent.mapId, supportModes: ["floor"], transitions: [] },
  });
  assert.equal(cleared.isError, undefined);
  assert.equal(cleared.structuredContent.revision, 3);
  assert.deepEqual(cleared.structuredContent.mechanics, { supportModes: ["floor"], transitions: [] });
  const retainedReport = await reader.client.callTool({ name: "potassium_map_mechanics", arguments: { mapId: annotated.structuredContent.mapId } });
  assert.deepEqual(retainedReport.structuredContent.mechanics.transitions, [reported]);
  const page = await reader.client.callTool({ name: "potassium_map_geometry", arguments: { mapId } });
  assert.equal(page.structuredContent.entries[0].name, "Observed floor");
  assert.equal(page.structuredContent.entries[0].sourceObjectId, "e".repeat(32));
  const surfaces = await reader.client.callTool({ name: "potassium_map_geometry", arguments: { mapId, section: "surfaces" } });
  assert.equal(surfaces.structuredContent.entries[0].partId, page.structuredContent.entries[0].id);
  const chunks = await reader.client.callTool({ name: "potassium_map_geometry", arguments: { mapId, section: "chunks" } });
  assert.ok(chunks.structuredContent.entries.some((chunk) => chunk.surfaceIds.includes(surfaces.structuredContent.entries[0].id)));
  for (const section of ["links", "tracks", "hazards"]) {
    const navigation = await reader.client.callTool({ name: section === "links" ? "potassium_map_navigation" : "potassium_map_motion", arguments: { mapId, section } });
    assert.equal(navigation.isError, undefined);
    assert.equal(navigation.structuredContent.section, section);
  }
  const surfaceId = surfaces.structuredContent.entries[0].id;
  const route = await reader.client.callTool({ name: "potassium_map_navigation", arguments: { view: "route", mapId, from: surfaceId, to: surfaceId } });
  assert.equal(route.isError, undefined);
  assert.equal(route.structuredContent.status, "found");
  assert.equal(route.structuredContent.duration, 0);
  assert.equal(route.structuredContent.timing, "modeled");
  assert.deepEqual(route.structuredContent.steps, []);
  reader.server.policy = { read: false, admin: true, execute: false };
  const denied = await reader.client.callTool({ name: "potassium_map_context", arguments: { view: "list" } });
  assert.equal(denied._meta.error.code, "POLICY_DENIED");
  const deniedMechanics = await reader.client.callTool({ name: "potassium_map_mechanics", arguments: { mapId } });
  assert.equal(deniedMechanics._meta.error.code, "POLICY_DENIED");
  reader.server.policy = { read: true, admin: false, execute: false };
  const released = await reader.client.callTool({ name: "potassium_map_context", arguments: { view: "release", mapId } });
  assert.equal(released.structuredContent.released, true);
  assert.deepEqual([...requests, ...reader.requests], []);
});

test("map selectors and offline clientId fail without calling a service or executor", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    clients: [], mapContextService: new Proxy({}, { get() { assert.fail("Invalid selection reached map service"); } }),
  });
  const mapId = mapSummary().mapId;
  for (const args of [
    { view: "list", clientId: "c".repeat(32) },
    { view: "observe", mapId, objectIds: ["part"], clientId: `${"c".repeat(32)}\n` },
    { view: "read", mapId, contextIds: [`gc-${"b".repeat(32)}`] },
    { view: "read", mapId, section: "parts" },
    { view: "read", mapId, offset: 0 },
    { view: "route", mapId, from: "surface", to: "surface" },
    { view: "build", contextIds: [`gc-${"b".repeat(32)}`], section: "parts" },
    { view: "observe", mapId, objectIds: ["part"], durationMs: 5001 },
    { view: "probe", mapId, center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, columns: 9 },
    { view: "probe", mapId, center: { x: 1e7 + 1, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
    { view: "probe", mapId, center: { x: 0, y: 0, z: 0 }, size: { x: 10001, y: 1, z: 1 } },
    { view: "image", mapId, minY: 2, maxY: 1 },
    { view: "read", mapId, supportModes: ["floor"] },
    { view: "build", contextIds: [`gc-${"b".repeat(32)}`], transitions: [] },
  ]) {
    const result = await client.callTool({ name: "potassium_map_context", arguments: args });
    assert.equal(result.isError, true);
  }
  for (const [name, args] of [
    ["potassium_map_geometry", { mapId, clientId: "c".repeat(32) }],
    ["potassium_map_navigation", { mapId, clientId: "c".repeat(32) }],
    ["potassium_map_geometry", { mapId, section: "tracks" }],
    ["potassium_map_navigation", { mapId, section: "parts" }],
    ["potassium_map_navigation", { mapId, section: "tracks" }],
    ["potassium_map_navigation", { mapId, view: "summary" }],
    ["potassium_map_motion", { mapId, section: "links" }],
    ["potassium_map_motion", { mapId, view: "route", from: "surface", to: "surface" }],
    ["potassium_map_motion", { mapId, clientId: "c".repeat(32) }],
    ["potassium_map_geometry", { view: "route", mapId, from: "surface", to: "surface" }],
    ["potassium_map_navigation", { view: "route", mapId, from: "surface", to: "surface", section: "links" }],
    ["potassium_map_navigation", { view: "route", mapId, from: "surface", to: "surface", limit: 1 }],
    ["potassium_map_navigation", { mapId, from: "surface", to: "surface" }],
    ["potassium_map_mechanics", { mapId, clientId: "c".repeat(32) }],
    ["potassium_map_mechanics", { mapId, section: "links" }],
    ["potassium_map_mechanics", { mapId, supportModes: ["floor"] }],
    ["potassium_map_mechanics", { mapId, transitions: [] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor", "ceiling"] }],
    ["potassium_map_mechanics", { view: "apply", mapId, transitions: [] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor", "floor"], transitions: [] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: [], transitions: [] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor"], transitions: [{ partId: "pad", fromMode: "floor", toMode: "ceiling", note: "reported" }] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor", "ceiling"], transitions: [{ partId: "pad", fromMode: "floor", toMode: "floor", note: "reported" }] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor", "ceiling"], transitions: [{ partId: "pad", fromMode: "floor", toMode: "ceiling", note: "x".repeat(257) }] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor", "ceiling"], transitions: [{ partId: "pad", fromMode: "floor", toMode: "ceiling", note: "reported", reportedAt: "2026-09-09T12:00:00.000Z" }] }],
    ["potassium_map_mechanics", { view: "apply", mapId, supportModes: ["floor"], transitions: [], contextIds: [`gc-${"b".repeat(32)}`] }],
  ]) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  assert.deepEqual(requests, []);
  const missing = await connectToolFixture(t, { clients: [] });
  for (const [name, args] of [
    ["potassium_map_context", { view: "list" }],
    ["potassium_map_geometry", { mapId }],
    ["potassium_map_navigation", { mapId }],
    ["potassium_map_motion", { mapId }],
    ["potassium_map_mechanics", { mapId }],
  ]) {
    const unavailable = await missing.client.callTool({ name, arguments: args });
    assert.equal(unavailable._meta.error.code, "MAP_CONTEXT_UNAVAILABLE");
  }
  assert.deepEqual(missing.requests, []);
});

test("map live collection gates selected capabilities and fences replaced generations before accepting evidence", async (t) => {
  const clients = [{ clientId: "c".repeat(32), generation: 1, client: { protocol: 2 } }];
  let version = 0, committed = 0;
  const mapContextService = {
    async observe(_args, options) {
      await options.collect("map_observe", { sourceSnapshotId: "d".repeat(32), objectIds: ["e".repeat(32)], durationMs: 100, intervalMs: 50 });
      committed += 1;
      return mapSummary("observe");
    },
  };
  const { client, requests } = await connectToolFixture(t, {
    clients, mapContextService,
    capabilities: () => ({ ...featureCapabilities, mapObservation: { version } }),
    request: async () => { clients[0].generation += 1; return {}; },
  });
  const args = { view: "observe", mapId: mapSummary().mapId, objectIds: ["part"], clientId: clients[0].clientId };
  const old = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(old._meta.error.code, "MAP_CONTEXT_SOURCE_UNAVAILABLE");
  assert.equal(requests.some(({ method }) => method === "map_observe"), false);
  version = 1;
  const changed = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(changed._meta.error.code, "MAP_CONTEXT_CLIENT_CHANGED");
  assert.equal(committed, 0);
});

test("native map errors preserve only allowlisted message prefixes without committing evidence", async (t) => {
  let nativeMessage = "MAP_CONTEXT_LIMIT: observation target retention";
  const { client } = await connectToolFixture(t, {
    mapContextService: {
      async observe(_args, options) {
        await options.collect("map_observe", { sourceSnapshotId: "d".repeat(32), objectIds: ["e".repeat(32)] });
        assert.fail("Failed collection cannot accept a map revision");
      },
    },
    request: async () => { throw new Error(nativeMessage); },
  });
  const args = { view: "observe", mapId: mapSummary().mapId, objectIds: ["part"] };
  const limited = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(limited._meta.error.code, "MAP_CONTEXT_LIMIT");
  assert.equal(limited._meta.accepted, undefined);
  nativeMessage = "MAP_CONTEXT_UNTRUSTED: not a documented error code";
  const unknown = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(unknown._meta.error.code, "MAP_CONTEXT_SOURCE_UNAVAILABLE");
});

test("SDK cancellation reaches bounded map observation without accepting a revision", { timeout: 3000 }, async (t) => {
  let entered, observeAbort, committed = false;
  const started = new Promise((resolve) => { entered = resolve; });
  const aborted = new Promise((resolve) => { observeAbort = resolve; });
  const { client } = await connectToolFixture(t, {
    mapContextService: {
      async observe(_args, options) {
        await options.collect("map_observe", { sourceSnapshotId: "d".repeat(32), objectIds: ["e".repeat(32)] });
        committed = true;
        return mapSummary("observe");
      },
    },
    request: (_method, _params, _clientId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { observeAbort(); reject(Object.assign(new Error("Cancelled"), { code: "CANCELLED" })); }, { once: true });
      entered();
    }),
  });
  const controller = new AbortController();
  const pending = client.callTool({
    name: "potassium_map_context", arguments: { view: "observe", mapId: mapSummary().mapId, objectIds: ["part"] },
  }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await started;
  controller.abort();
  await rejected;
  await aborted;
  assert.equal(committed, false);
});

test("accepted map writes survive small frames, retention errors, and formatting failures", async (t) => {
  for (const [name, value, args, method] of [
    ["potassium_map_context", mapSummary(), { contextIds: mapSummary().sourceContextIds }, "build"],
    ["potassium_map_mechanics", mapMechanics(), {
      view: "apply", mapId: mapSummary().mapId, supportModes: ["floor", "ceiling"],
      transitions: [{ partId: "reported-pad", fromMode: "floor", toMode: "ceiling", note: "Reported turn." }],
    }, "mechanics"],
  ]) {
    await t.test(name, async (t) => {
      value.warnings = Array.from({ length: 8 }, () => "Partial evidence ".repeat(12));
      for (const failRetention of [false, true]) {
        const compactResultStore = failRetention ? {
          put() { throw Object.assign(new Error("Store unavailable"), { code: "RESULT_STORE_UNAVAILABLE" }); }, releaseScope() {},
        } : createCompactResultStore();
        const { client, requests } = await connectToolFixture(t, {
          clients: [], config: { maxMessageBytes: 1024, proxyMaxFrameBytes: 16384 }, compactResultStore,
          mapContextService: { [method]: async () => value },
        });
        await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: name });
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.mapId, value.mapId);
        assert.equal(result.structuredContent.revision, value.revision);
        assert.equal(result.structuredContent.accepted, true);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
        if (failRetention) assert.equal(result.structuredContent.warning, "RESULT_STORE_UNAVAILABLE");
        else {
          assert.equal(result.structuredContent.kind, "potassium/result");
          const retained = await client.callTool({
            name: "potassium_result_read", arguments: { resultId: result.structuredContent.resultId, pointers: ["/mapId", "/revision"] },
          });
          assert.deepEqual(retained.structuredContent.selections, [
            { pointer: "/mapId", kind: "value", value: value.mapId }, { pointer: "/revision", kind: "value", value: value.revision },
          ]);
        }
        assert.deepEqual(requests, []);
      }
      for (const failure of ["serialization", "formatted identity", "finishing"]) {
        const metadata = structuredClone(value);
        if (failure === "serialization") Object.defineProperty(metadata, "toJSON", { value() { throw new Error("Serialization failed"); } });
        if (failure === "formatted identity") Object.defineProperty(metadata, "toJSON", { value: () => ({ ...value, mapId: `map-${"e".repeat(32)}` }) });
        const formatting = await connectToolFixture(t, { clients: [], mapContextService: { [method]: async () => metadata } });
        if (failure === "finishing") formatting.server.finishToolResult = async () => { throw Object.assign(new Error("Formatting failed"), { code: "MAP_CONTEXT_INVALID_DATA" }); };
        const failed = await formatting.client.callTool({ name, arguments: args });
        assert.equal(failed.isError, true);
        assert.equal(failed._meta.error.code, "MAP_CONTEXT_INVALID_DATA");
        assert.equal(failed._meta.mapId, value.mapId);
        assert.equal(failed._meta.revision, value.revision);
        assert.equal(failed._meta.accepted, true);
      }
    });
  }
});

test("SDK cancellation after mechanics commit leaves the accepted immutable revision readable offline", { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mechanics-cancel-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, "{}");
  const contexts = createGameContextService({ configFile });
  const maps = createMapContextService({ configFile, gameContextService: contexts });
  t.after(async () => { maps.close(); contexts.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = await contexts.capture({ screenshot: false, map: false }, {
    client: { clientId: "c".repeat(32), generation: 1 }, isCurrent: () => true,
    clientCount: 1, imageBudget: 0, collect: async () => contextScene(),
  });
  const parent = await maps.build({ contextIds: [saved.contextId] });
  await contexts.release({ contextId: saved.contextId });
  let committed, observedAbort, finishResponse;
  const accepted = new Promise((resolve) => { committed = resolve; });
  const aborted = new Promise((resolve) => { observedAbort = resolve; });
  const responseGate = new Promise((resolve) => { finishResponse = resolve; });
  t.after(() => finishResponse());
  const { client, requests } = await connectToolFixture(t, {
    clients: [], mapContextService: {
      async mechanics(args, options) {
        const result = await maps.mechanics(args, options);
        options.signal.addEventListener("abort", observedAbort, { once: true });
        committed(result);
        await responseGate;
        return result;
      },
    },
  });
  const controller = new AbortController();
  const pending = client.callTool({
    name: "potassium_map_mechanics",
    arguments: { view: "apply", mapId: parent.mapId, supportModes: ["floor", "ceiling"], transitions: [] },
  }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  const result = await accepted;
  controller.abort();
  await rejected;
  await aborted;
  finishResponse();
  const reader = await connectToolFixture(t, { clients: [], mapContextService: maps });
  const retained = await reader.client.callTool({ name: "potassium_map_mechanics", arguments: { mapId: result.mapId } });
  assert.equal(retained.isError, undefined);
  assert.equal(retained.structuredContent.revision, result.revision);
  assert.equal(retained.structuredContent.parentMapId, parent.mapId);
  assert.deepEqual(retained.structuredContent.mechanics, { supportModes: ["floor", "ceiling"], transitions: [] });
  const catalog = await reader.client.callTool({ name: "potassium_map_context", arguments: { view: "list" } });
  assert.deepEqual(new Set(catalog.structuredContent.maps.map((entry) => entry.mapId)), new Set([parent.mapId, result.mapId]));
  assert.deepEqual([...requests, ...reader.requests], []);
});

test("malformed typed map rows cannot enter retention or claim accepted state", async (t) => {
  const { client, requests } = await connectToolFixture(t, {
    clients: [],
    compactResultStore: { put() { assert.fail("Invalid map output entered retention"); }, releaseScope() {} },
    mapContextService: {
      read: async () => ({
        view: "read", mapId: mapSummary().mapId, revision: 1, section: "tracks", offset: 0, total: 1,
        coverage: "partial", warnings: [],
        entries: [{ ...mapSummary(), model: "invented-live-safety", samples: "malformed private track data" }],
      }),
    },
  });
  const result = await client.callTool({ name: "potassium_map_motion", arguments: { view: "read", mapId: mapSummary().mapId, section: "tracks" } });
  assert.equal(result.isError, true);
  assert.equal(result._meta.error.code, "MAP_CONTEXT_INVALID_DATA");
  assert.equal(result._meta.accepted, undefined);
  assert.equal(JSON.stringify(result).includes("malformed private track data"), false);
  assert.deepEqual(requests, []);
});

test("oriented map results preserve typed modes and unknown timing through standard SDK discovery", async (t) => {
  const mapId = mapSummary().mapId;
  const surface = {
    id: "ceiling-surface", partId: "ceiling-part", supportMode: "ceiling",
    center: { x: 0, y: 10, z: 0 }, normal: { x: 0, y: -1, z: 0 },
    vertices: [{ x: -5, y: 10, z: -5 }, { x: 5, y: 10, z: -5 }, { x: 5, y: 10, z: 5 }, { x: -5, y: 10, z: 5 }],
    bounds: { min: { x: -5, y: 10, z: -5 }, max: { x: 5, y: 10, z: 5 } },
    geometry: "block", standable: "modeled", reasons: [],
  };
  const link = {
    id: "reported-switch-link", from: "floor-surface", to: surface.id, action: "mode-switch",
    fromMode: "floor", toMode: "ceiling", transitionId: "reported-switch",
    takeoff: { x: 0, y: 0, z: 0 }, landing: { x: 0, y: 10, z: 0 },
    duration: null, status: "candidate", reasons: ["User-reported switch; trajectory and timing are unobserved."],
  };
  const page = (section, entry) => ({
    view: "read", mapId, revision: 2, section, offset: 0, total: 1, entries: [entry], coverage: "partial", warnings: [],
  });
  const itinerary = {
    view: "route", mapId, revision: 2, status: "found", steps: [link],
    timing: "unknown", duration: null, arrival: null, reasons: ["Unobserved transfer timing."],
  };
  for (const [label, name, args, valid, invalidations, invalidWire] of [
    ["surface", "potassium_map_geometry", { mapId, section: "surfaces" }, page("surfaces", surface), [
      (copy) => { copy.entries[0].supportMode = "wall"; },
      (copy) => { copy.entries[0].vertices[0].x = 1e9 + 1; },
    ], (copy) => { copy.entries[0].supportMode = "wall"; }],
    ["switch", "potassium_map_navigation", { mapId, section: "links" }, page("links", link), [
      (copy) => { copy.entries[0].action = "walk"; copy.entries[0].toMode = "floor"; delete copy.entries[0].transitionId; },
      (copy) => { copy.entries[0].duration = 0; },
      (copy) => { copy.entries[0].status = "modeled"; },
      (copy) => { copy.entries[0].windows = [{ start: 0, end: 1 }]; },
      (copy) => { delete copy.entries[0].transitionId; },
      (copy) => { copy.entries[0].toMode = "floor"; },
    ], (copy) => { copy.entries[0].duration = "unknown"; }],
    ["route", "potassium_map_navigation", { view: "route", mapId, from: link.from, to: link.to }, itinerary, [
      (copy) => { copy.arrival = 0; },
      (copy) => { copy.duration = 0; },
      (copy) => { copy.timing = "modeled"; },
    ], (copy) => { copy.arrival = "unknown"; }],
    ["mechanics", "potassium_map_mechanics", {
      view: "apply", mapId, supportModes: ["floor", "ceiling"],
      transitions: [{ partId: "reported-pad", fromMode: "floor", toMode: "ceiling", note: "Reported turn." }],
    }, mapMechanics(), [
      (copy) => { copy.mechanics.transitions[0].evidence.kind = "engine"; },
      (copy) => { copy.mechanics.transitions[0].toMode = "floor"; },
      (copy) => { copy.mechanics.transitions.push(structuredClone(copy.mechanics.transitions[0])); },
      (copy) => { copy.mechanics.supportModes = ["floor"]; },
      (copy) => { copy.mechanics.transitions[0].evidence.reportedAt = "yesterday"; },
    ], (copy) => { copy.mechanics.transitions[0].evidence.kind = "engine"; }],
  ]) {
    await t.test(label, async (t) => {
      let output = valid;
      const { client, server, requests } = await connectToolFixture(t, {
        clients: [], config: { proxyMaxFrameBytes: 16384 },
        compactResultStore: { put() { assert.fail("Small typed map results must not enter retention"); }, releaseScope() {} },
        mapContextService: { read: async () => output, route: async () => output, mechanics: async () => output },
      });
      await listAllTools(async (cursor) => {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor });
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
        return result;
      }, { forTool: name });
      assert.deepEqual((await client.callTool({ name, arguments: args })).structuredContent, valid);
      for (const invalidate of invalidations) {
        output = structuredClone(valid);
        invalidate(output);
        const rejected = await client.callTool({ name, arguments: args });
        assert.equal(rejected.isError, true);
        assert.equal(rejected._meta.error.code, "MAP_CONTEXT_INVALID_DATA");
        assert.equal(rejected._meta.accepted, undefined);
        assert.equal(rejected.structuredContent, undefined);
      }
      // The stock client must enforce the advertised output even without the server's original-result guard.
      server.server.setRequestHandler(CallToolRequestSchema, async () => formatToolResult(output));
      output = structuredClone(valid);
      invalidWire(output);
      await assert.rejects(client.callTool({ name, arguments: args }), { code: ErrorCode.InvalidParams });
      assert.deepEqual(requests, []);
    });
  }
});

test("map images use one standard media lane and reject corrupt digest, dimensions, and oversized frames offline", async (t) => {
  const metadataFor = () => ({
    view: "image", mapId: mapSummary().mapId, revision: 1, coverage: "partial", warnings: [testToken],
    image: {
      mimeType: "image/jpeg", bytes: contextJpeg.length, width: 1, height: 1,
      sha256: createHash("sha256").update(contextJpeg).digest("hex"), provider: "client-visible-box-schematic",
      rendering: {
        coverage: "partial", selectedParts: 1, unrenderedParts: 0, selectedPrimitives: 0,
        unrenderedPrimitives: 0, omittedLabels: 0, warnings: [],
      },
    },
  });
  let metadata = metadataFor();
  let image = { data: contextJpeg, mimeType: "image/jpeg", width: 1, height: 1 };
  const { client, requests } = await connectToolFixture(t, {
    clients: [], mapContextService: { image: async () => ({ metadata, image }) },
    compactResultStore: { put() { assert.fail("Map image must never be retained as JSON"); }, releaseScope() {} },
  });
  await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_map_context" });
  const args = { view: "image", mapId: metadata.mapId };
  const result = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.filter(({ type }) => type === "image").length, 1);
  assert.deepEqual(Buffer.from(result.content.find(({ type }) => type === "image").data, "base64"), contextJpeg);
  assert.equal(JSON.stringify(result).split(contextJpeg.toString("base64")).length, 2);
  assert.equal(JSON.stringify(result.structuredContent).includes(contextJpeg.toString("base64")), false);
  assert.deepEqual(result.structuredContent.warnings, ["[redacted]"]);
  metadata.image.sha256 = "0".repeat(64);
  const corrupt = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(corrupt._meta.error.code, "MAP_CONTEXT_INVALID_DATA");
  assert.equal(corrupt.content.some(({ type }) => type === "image"), false);
  metadata = metadataFor();
  metadata.image.width = 2;
  image = { ...image, width: 2 };
  const falseDimensions = await client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(falseDimensions._meta.error.code, "MAP_CONTEXT_INVALID_DATA");
  assert.equal(falseDimensions.content.some(({ type }) => type === "image"), false);
  metadata = metadataFor();
  image = { ...image, width: 1 };
  const limited = await connectToolFixture(t, {
    clients: [], config: { maxMessageBytes: 8192, proxyMaxFrameBytes: 16384 },
    mapContextService: { image: async () => ({ metadata, image }) },
  });
  const tooLarge = await limited.client.callTool({ name: "potassium_map_context", arguments: args });
  assert.equal(tooLarge._meta.error.code, "MAP_CONTEXT_IMAGE_UNAVAILABLE");
  assert.equal(tooLarge.content.some(({ type }) => type === "image"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) <= 8192);
  assert.deepEqual([...requests, ...limited.requests], []);
});

test("compact discovery schemas preserve shared constraints and instance-valued const/default metadata", async (t) => {
  const instance = {
    properties: { type: "object", additionalProperties: true },
    anyOf: [{ type: "string", minLength: 0 }],
    const: { type: "number" }, default: { type: "array" },
  };
  const shared = z.object({
    timestamp: z.string().datetime(),
    position: z.object({ x: z.number().min(-10).max(10), y: z.number().min(-10).max(10) }).strict(),
  }).strict();
  const outputSchema = z.object({
    left: shared, right: shared,
    configuration: z.object({}).passthrough().meta({ const: instance, default: instance, examples: [instance] }),
    properties: z.object({ const: z.string().min(1), default: z.number().int().positive() }).strict(),
  }).strict();
  const value = {
    left: { timestamp: "2026-09-09T12:00:00.000Z", position: { x: 1, y: 2 } },
    right: { timestamp: "2026-09-09T12:00:00.000Z", position: { x: 3, y: 4 } },
    configuration: instance, properties: { const: "instance field", default: 1 },
  };
  let response = value;
  const { client, server } = await connectToolFixture(t);
  server.registerTool("potassium_builtin_status", { outputSchema }, async () => formatToolResult(response));
  // Exercise the SDK validator independently of the server's original-result guard.
  server.server.setRequestHandler(CallToolRequestSchema, async () => formatToolResult(response));
  const listed = await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }), { forTool: "potassium_builtin_status" });
  const wire = listed.tools.find(({ name }) => name === "potassium_builtin_status").outputSchema;
  const annotated = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "default") && Array.isArray(node.examples)) annotated.push(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(wire);
  assert.equal(annotated.length, 1);
  assert.deepEqual(annotated[0].const, instance);
  assert.deepEqual(annotated[0].default, instance);
  assert.deepEqual(annotated[0].examples, [instance]);
  assert.deepEqual((await client.callTool({ name: "potassium_builtin_status", arguments: {} })).structuredContent, value);
  for (const change of [
    (copy) => { copy.right.position.x = 11; },
    (copy) => { copy.configuration.properties.additionalProperties = false; },
    (copy) => { copy.properties.const = ""; },
  ]) {
    response = structuredClone(value);
    change(response);
    await assert.rejects(client.callTool({ name: "potassium_builtin_status", arguments: {} }), { code: ErrorCode.InvalidParams });
  }
});

test("compact output discovery preserves scoped references and recursive validation", async (t) => {
  const scopedId = "urn:potassium:test:bounded-scalar";
  const scoped = z.object({
    declared: z.number().min(1).max(3).meta({ $id: scopedId }),
    referenced: z.unknown().meta({ $ref: scopedId }),
  }).strict();
  const recursive = z.lazy(() => z.object({
    value: z.number().min(0).max(5), next: recursive.optional(),
  }).strict());
  for (const [name, outputSchema, valid, invalid] of [
    ["scoped", scoped, { declared: 1, referenced: 3 }, { declared: 1, referenced: 4 }],
    ["recursive", z.object({ first: recursive, second: recursive }).strict(),
      { first: { value: 1, next: { value: 2 } }, second: { value: 3 } },
      { first: { value: 1, next: { value: 6 } }, second: { value: 3 } }],
  ]) {
    await t.test(name, async (t) => {
      let response = valid;
      const { client, server } = await connectToolFixture(t, { config: { proxyMaxFrameBytes: 16384 } });
      server.registerTool("potassium_builtin_status", { outputSchema }, async () => formatToolResult(response));
      server.server.setRequestHandler(CallToolRequestSchema, async () => formatToolResult(response));
      await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
      assert.deepEqual((await client.callTool({ name: "potassium_builtin_status", arguments: {} })).structuredContent, valid);
      response = invalid;
      await assert.rejects(client.callTool({ name: "potassium_builtin_status", arguments: {} }), { code: ErrorCode.InvalidParams });
    });
  }
});

function recordingMetadata(overrides = {}) {
  return {
    recordingId: "a".repeat(32), state: "recording", ready: true,
    clock: "client-monotonic-seconds", atomicSnapshot: false,
    acceptedAt: 100, startedAt: 100, firstSampleAt: 100, readyAt: 100, lastSampleAt: 100, now: 100,
    durationMs: 30000, intervalMs: 100, elapsedMs: 0, remainingMs: 30000,
    frameCount: 1, sampleCount: 1, eventCount: 0, markerCount: 0,
    missedIntervals: 0, retainedDrops: 0, sampleBytes: 180, eventBytes: 0,
    coverage: "complete", stopReasons: [],
    targets: [{ sourceSnapshotId: "d".repeat(32), sourceObjectId: "e".repeat(32),
      path: "Workspace.Platform", className: "Part", size: { x: 4, y: 1, z: 4 }, anchored: true, canCollide: true }],
    ...overrides,
  };
}

test("SDK recording start waits for the native first-sample receipt and preserves terminal retention clocks", { timeout: 5000 }, async (t) => {
  let entered, sample;
  const dispatched = new Promise((resolve) => { entered = resolve; });
  const firstSample = new Promise((resolve) => { sample = resolve; });
  let metadata = recordingMetadata();
  const { client, requests } = await connectToolFixture(t, {
    mapContextService: { prepareRecording: async () => ({
      scope: { clientId: "c".repeat(32), generation: 1 }, targets: metadata.targets,
    }) },
    request: async (_method, params) => {
      if (params.operation === "start") { entered(); await firstSample; return { metadata }; }
      if (params.operation === "stop") {
        metadata = { ...metadata, state: "stopped", ready: false, now: 101, stoppedAt: 101, expiresAt: 221,
          elapsedMs: 1000, remainingMs: 0, stopReasons: ["user-stop"] };
        return { metadata };
      }
      if (params.view === "frames") return {
        metadata, view: "frames", cursor: 0, nextCursor: 1, hasMore: false,
        frames: [{ sequence: 1, t: 0, samples: [{ sourceObjectId: metadata.targets[0].sourceObjectId, t: 0,
          cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: metadata.targets[0].size }] }],
      };
      return { metadata: { ...metadata, now: 150 }, view: "summary", cursor: 0, nextCursor: 0, hasMore: false };
    },
  });
  let finished = false;
  const pending = client.callTool({ name: "potassium_map_recording", arguments: {
    operation: "start", mapId: mapSummary().mapId, objectIds: ["platform"], clientId: "c".repeat(32),
  } }).then((value) => { finished = true; return value; });
  await dispatched;
  assert.equal(finished, false, "host scheduling alone must not produce ready");
  sample();
  const started = await pending;
  assert.equal(started.isError, undefined);
  assert.deepEqual(started.structuredContent.metadata, metadata);
  assert.equal(Number.isFinite(Date.parse(started.structuredContent.receivedAt)), true);
  assert.equal(requests.find(({ method }) => method === "map_recording").clientId, "c".repeat(32));
  const args = { recordingId: metadata.recordingId };
  const stopped = await client.callTool({ name: "potassium_map_recording", arguments: { ...args, operation: "stop" } });
  const later = await client.callTool({ name: "potassium_map_recording", arguments: { ...args, operation: "poll" } });
  assert.equal(stopped.structuredContent.metadata.ready, false);
  assert.equal(later.structuredContent.metadata.expiresAt, stopped.structuredContent.metadata.expiresAt);
  assert.equal(later.structuredContent.metadata.stoppedAt, 101);
  assert.equal(later.structuredContent.metadata.now, 150);
  const evidence = await client.callTool({ name: "potassium_map_recording_read", arguments: { ...args, operation: "poll", view: "frames" } });
  assert.equal(evidence.isError, undefined);
  assert.equal(evidence.structuredContent.frames[0].samples[0].sourceObjectId, metadata.targets[0].sourceObjectId);
  assert.equal(evidence.structuredContent.nextCursor, 1);
  assert.equal(requests.filter(({ method, params }) => method === "map_recording" && params.operation === "start").length, 1);
});

test("recording selectors reject ignored arguments before services and enforce selected feature generations", async (t) => {
  const invalid = await connectToolFixture(t, {
    mapRecordingService: new Proxy({}, { get() { assert.fail("Invalid selectors reached recorder"); } }),
  });
  const mapId = mapSummary().mapId, recordingId = "a".repeat(32);
  for (const args of [
    { operation: "start", mapId, objectIds: ["part"], durationMs: 999 },
    { operation: "start", mapId, objectIds: ["part", "part"] },
    { operation: "start", mapId, objectIds: ["part"], recordingId },
    { operation: "poll", recordingId, afterCursor: 0 },
    { operation: "poll", recordingId, view: "frames", limit: 21 },
    { operation: "read", mapId, view: "frames" },
    { operation: "read", mapId, clientId: "c".repeat(32) },
    { operation: "stop", recordingId, label: "ignored" },
    { operation: "mark", recordingId, label: "mark", clientId: `${"c".repeat(32)}\n` },
    { operation: "save", mapId, recordingId, objectIds: ["part"] },
    { operation: "release", recordingId, view: "summary" },
  ]) {
    const name = args.operation === "read" || (args.operation === "poll" && args.view === "frames")
      ? "potassium_map_recording_read" : "potassium_map_recording";
    assert.equal((await invalid.client.callTool({ name, arguments: args })).isError, true);
  }
  for (const [name, args] of [
    ["potassium_map_recording", { operation: "read", mapId }],
    ["potassium_map_recording", { operation: "poll", recordingId, view: "frames" }],
    ["potassium_map_recording_read", { operation: "start", mapId, objectIds: ["part"] }],
    ["potassium_map_recording_read", { operation: "poll", recordingId, view: "summary" }],
  ]) {
    assert.equal((await invalid.client.callTool({ name, arguments: args })).isError, true);
  }
  assert.deepEqual(invalid.requests, []);
  const clients = [{ clientId: "c".repeat(32), generation: 1, client: { protocol: 2 } }];
  let version = 0;
  const gated = await connectToolFixture(t, {
    clients,
    capabilities: () => ({ ...featureCapabilities, mapRecording: { version } }),
    mapContextService: { prepareRecording: async () => ({
      scope: { clientId: clients[0].clientId, generation: clients[0].generation }, targets: recordingMetadata().targets,
    }) },
    request: async () => { clients[0].generation += 1; return { metadata: recordingMetadata() }; },
  });
  const args = { operation: "start", mapId, objectIds: ["part"] };
  const old = await gated.client.callTool({ name: "potassium_map_recording", arguments: args });
  assert.equal(old._meta.error.code, "MAP_RECORDING_SOURCE_UNAVAILABLE");
  assert.equal(gated.requests.some(({ method }) => method === "map_recording"), false);
  version = 1;
  const replaced = await gated.client.callTool({ name: "potassium_map_recording", arguments: args });
  assert.equal(replaced._meta.error.code, "MAP_RECORDING_CLIENT_CHANGED");
  assert.equal(replaced._meta.accepted, undefined);
});

test("recording errors retain only documented codes and invalid readiness cannot enter retention", async (t) => {
  let response = () => { throw Object.assign(new Error("Recording capacity exhausted"), { code: "MAP_RECORDING_LIMIT" }); };
  const { client } = await connectToolFixture(t, {
    mapContextService: { prepareRecording: async () => ({
      scope: { clientId: "c".repeat(32), generation: 1 }, targets: recordingMetadata().targets,
    }) },
    compactResultStore: { put() { assert.fail("Invalid recording entered retention"); }, releaseScope() {} },
    request: async () => response(),
  });
  const args = { operation: "start", mapId: mapSummary().mapId, objectIds: ["part"] };
  const limited = await client.callTool({ name: "potassium_map_recording", arguments: args });
  assert.equal(limited._meta.error.code, "MAP_RECORDING_LIMIT");
  response = () => { throw new Error("MAP_RECORDING_UNTRUSTED: invented code"); };
  const unknown = await client.callTool({ name: "potassium_map_recording", arguments: args });
  assert.equal(unknown._meta.error.code, "MAP_RECORDING_SOURCE_UNAVAILABLE");
  response = () => ({ metadata: recordingMetadata({ frameCount: 0, sampleCount: 0 }) });
  const premature = await client.callTool({ name: "potassium_map_recording", arguments: args });
  assert.equal(premature._meta.error.code, "MAP_RECORDING_INVALID_DATA");
  assert.equal(premature._meta.accepted, undefined);
});

test("accepted recorder receipts survive compact retention failures and serialization changes", async (t) => {
  const start = { operation: "start", metadata: recordingMetadata(), receivedAt: "2026-09-09T12:00:00.000Z" };
  start.metadata.targets[0].path = `Workspace.${"p".repeat(900)}`;
  for (const failRetention of [false, true]) {
    const compactResultStore = failRetention ? {
      put() { throw Object.assign(new Error("Retention failed"), { code: "RESULT_STORE_UNAVAILABLE" }); }, releaseScope() {},
    } : createCompactResultStore();
    const { client } = await connectToolFixture(t, {
      config: { maxMessageBytes: 1024, proxyMaxFrameBytes: 16384 }, compactResultStore,
      mapRecordingService: { start: async () => start },
    });
    const tools = await listAllTools(async (cursor) => {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
      return page;
    });
    assert.ok(tools.tools.some(({ name }) => name === "potassium_map_recording"));
    const result = await client.callTool({ name: "potassium_map_recording", arguments: {
      operation: "start", mapId: mapSummary().mapId, objectIds: ["part"],
    } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.recordingId, start.metadata.recordingId);
    assert.equal(result.structuredContent.ready, true);
    assert.equal(result.structuredContent.receivedAt, start.receivedAt);
    assert.equal(result.structuredContent.accepted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
    if (failRetention) assert.equal(result.structuredContent.warning, "RESULT_STORE_UNAVAILABLE");
    else {
      const retained = await client.callTool({ name: "potassium_result_read", arguments: {
        resultId: result.structuredContent.resultId, pointers: ["/metadata/firstSampleAt"],
      } });
      assert.equal(retained.structuredContent.selections[0].value, 100);
    }
  }
  for (const operation of ["start", "save"]) {
    for (const failure of ["serialize", "identity", "finish"]) {
      const value = operation === "start" ? structuredClone(start)
        : { operation: "save", mapId: mapSummary().mapId, revision: 2, recordingId: start.metadata.recordingId, released: true };
      if (failure === "serialize") Object.defineProperty(value, "toJSON", { value() { throw new Error("Cannot format"); } });
      if (failure === "identity") Object.defineProperty(value, "toJSON", { value: () => operation === "start"
        ? { ...start, metadata: { ...start.metadata, recordingId: "b".repeat(32) } }
        : { ...value, mapId: `map-${"b".repeat(32)}` } });
      const fixture = await connectToolFixture(t, { mapRecordingService: { [operation]: async () => value } });
      if (failure === "finish") fixture.server.finishToolResult = async () => { throw new Error("Formatting failed"); };
      const result = await fixture.client.callTool({ name: "potassium_map_recording", arguments: {
        operation, mapId: mapSummary().mapId, ...(operation === "start" ? { objectIds: ["part"] } : { recordingId: start.metadata.recordingId }),
      } });
      assert.equal(result.isError, true);
      assert.equal(result._meta.accepted, true);
      assert.equal(result._meta.recordingId, start.metadata.recordingId);
      if (operation === "start") assert.equal(result._meta.ready, true);
      else {
        assert.equal(result._meta.mapId, value.mapId);
        assert.equal(result._meta.revision, 2);
        assert.equal(result._meta.released, true);
      }
    }
  }
});

test("archived recording frames and accepted save retries work without any executor", async (t) => {
  const recordingId = "a".repeat(32), mapId = mapSummary().mapId;
  const metadata = recordingMetadata({ state: "stopped", ready: false, now: 101, stoppedAt: 101,
    expiresAt: 221, elapsedMs: 1000, remainingMs: 0, stopReasons: ["user-stop"] });
  const frames = [{ sequence: 1, t: 0, samples: [{ sourceObjectId: "e".repeat(32), t: 0,
    cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: { x: 4, y: 1, z: 4 } }] }];
  const { client, requests } = await connectToolFixture(t, {
    clients: [],
    mapContextService: {
      findRecordingReceipt: async ({ clientId }) => {
        if (clientId !== undefined && clientId !== "c".repeat(32)) throw Object.assign(new Error("Wrong receipt owner"), { code: "MAP_CONTEXT_CLIENT_CHANGED" });
        return { mapId, revision: 2, released: true };
      },
      readRecording: async () => ({ view: "frames", mapId, revision: 2, recordingId, metadata,
        frames, cursor: 0, nextCursor: 1, hasMore: false }),
    },
  });
  const read = await client.callTool({ name: "potassium_map_recording_read", arguments: { operation: "read", mapId, recordingId, view: "frames" } });
  assert.deepEqual(read.structuredContent.frames, frames);
  assert.equal(read.structuredContent.metadata.clock, "client-monotonic-seconds");
  const saved = await client.callTool({ name: "potassium_map_recording", arguments: { operation: "save", mapId, recordingId } });
  assert.deepEqual(saved.structuredContent, { operation: "save", mapId, revision: 2, recordingId, released: true });
  const mismatched = await client.callTool({ name: "potassium_map_recording", arguments: {
    operation: "save", mapId, recordingId, clientId: "f".repeat(32),
  } });
  assert.equal(mismatched._meta.error.code, "MAP_CONTEXT_CLIENT_CHANGED");
  assert.deepEqual(requests, []);
});

test("offline SDK selectors bind whole-row cursors and project tracks without weakening full sample reads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-selected-sdk-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, "{}");
  const contexts = createGameContextService({ configFile });
  const maps = createMapContextService({ configFile, gameContextService: contexts });
  t.after(async () => { maps.close(); contexts.close(); await rm(directory, { recursive: true, force: true }); });
  const scene = contextScene(), source = scene.parts[0];
  const identity = { clientId: "c".repeat(32), generation: 1 };
  const captured = await contexts.capture({ screenshot: false, map: false }, {
    client: identity, isCurrent: () => true, clientCount: 1, imageBudget: 0, collect: async () => scene,
  });
  const base = await maps.build({ contextIds: [captured.contextId] });
  const partId = (await maps.read({ view: "read", mapId: base.mapId, section: "parts" })).entries[0].id;
  const observed = await maps.observe({ mapId: base.mapId, objectIds: [partId], durationMs: 200, intervalMs: 100 }, {
    client: identity, isCurrent: () => true,
    collect: async () => ({
      schema: 1, sourceSnapshotId: scene.sourceSnapshotId, durationMs: 200, intervalMs: 100,
      clock: "observation-relative-seconds", events: [], coverage: "complete", truncated: false, stopReasons: [],
      tracks: [{ sourceObjectId: source.sourceObjectId, path: source.path, className: source.className,
        size: source.size, canCollide: true, anchored: true,
        samples: [0, 0.1, 0.2].map((time) => ({ t: time, cframe: source.cframe, size: source.size })) }],
    }),
  });
  const annotated = await maps.mechanics({ view: "apply", mapId: observed.mapId, supportModes: ["floor", "ceiling"], transitions: [] });
  const mapId = annotated.mapId;
  const { client, requests } = await connectToolFixture(t, { clients: [], mapContextService: maps });
  const call = (name, args) => client.callTool({ name, arguments: { mapId, ...args } });
  const full = await call("potassium_map_motion", { section: "tracks" });
  assert.equal(full.isError, undefined);
  const track = full.structuredContent.entries[0];
  assert.equal(track.samples.length, 3);
  const summary = await call("potassium_map_motion", { view: "summary", query: { ids: [track.id], partId } });
  assert.equal(summary.isError, undefined);
  assert.equal(summary.structuredContent.view, "summary");
  assert.equal(summary.structuredContent.presentation, "summary");
  assert.equal(summary.structuredContent.totalMatched, 1);
  assert.deepEqual(summary.structuredContent.entries.map(({ id, sampleCount, model }) => ({ id, sampleCount, model })),
    [{ id: track.id, sampleCount: 3, model: track.model }]);
  assert.equal(summary.structuredContent.entries[0].samples, undefined);
  assert.equal(summary.structuredContent.entries[0].maxGap, 0.1);
  const stillFull = await call("potassium_map_motion", { section: "tracks", query: { ids: [track.id] } });
  assert.deepEqual(stillFull.structuredContent.entries[0].samples, track.samples);
  const surfaces = await call("potassium_map_geometry", { section: "surfaces" });
  assert.deepEqual(new Set(surfaces.structuredContent.entries.map(({ supportMode }) => supportMode)), new Set(["floor", "ceiling"]));
  const ceiling = await call("potassium_map_geometry", { section: "surfaces", query: { supportMode: "ceiling" } });
  assert.deepEqual(ceiling.structuredContent.entries, surfaces.structuredContent.entries.filter(({ supportMode }) => supportMode === "ceiling"));
  const query = { ids: surfaces.structuredContent.entries.map(({ id }) => id).reverse() };
  const first = await call("potassium_map_geometry", { section: "surfaces", query, limit: 1 });
  assert.equal(first.structuredContent.totalMatched, 2);
  assert.equal(first.structuredContent.nextOffset, undefined);
  const cursor = first.structuredContent.nextCursor;
  assert.equal(typeof cursor, "string");
  const second = await call("potassium_map_geometry", { section: "surfaces", query, cursor, limit: 1 });
  assert.deepEqual([...first.structuredContent.entries, ...second.structuredContent.entries], surfaces.structuredContent.entries);
  const wrongQuery = await call("potassium_map_geometry", { section: "surfaces", query: { ...query, supportMode: "ceiling" }, cursor });
  assert.equal(wrongQuery.isError, true);
  const wrongMap = await call("potassium_map_geometry", { mapId: observed.mapId, section: "surfaces", query, cursor });
  assert.equal(wrongMap.isError, true);
  assert.deepEqual(requests, []);
});

test("compacted input discovery preserves wire bounds, scoped references, runtime defaults and refinements", async (t) => {
  const { client, server } = await connectToolFixture(t);
  const bounded = z.number().int().min(1).max(3);
  server.registerTool("potassium_builtin_status", {
    inputSchema: z.object({ lower: bounded.default(2), upper: bounded }).strict().superRefine((value, context) => {
      if (value.lower > value.upper) context.addIssue({ code: "custom", message: "Bounds are reversed" });
    }),
  }, async ({ lower, upper }) => formatToolResult({ span: upper - lower }));
  const declaredId = "urn:potassium:test:input-scope";
  server.registerTool("potassium_builtin_list_clients", {
    inputSchema: z.object({
      declared: bounded.meta({ $id: declaredId }),
      referenced: z.unknown().meta({ $ref: declaredId }),
    }).strict(),
  }, async ({ declared, referenced }) => formatToolResult({ equal: declared === referenced }));
  const tools = (await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools;
  const validator = new AjvJsonSchemaValidator();
  const bounds = tools.find(({ name }) => name === "potassium_builtin_status").inputSchema;
  const scoped = tools.find(({ name }) => name === "potassium_builtin_list_clients").inputSchema;
  assert.notEqual(bounds.$id, scoped.$id);
  const validateBounds = validator.getValidator(bounds);
  const validateScoped = validator.getValidator(scoped);
  assert.equal(validateBounds({ upper: 3 }).valid, true);
  assert.equal(validateBounds({ upper: 4 }).valid, false);
  assert.equal(validateBounds({ upper: 3, ignored: true }).valid, false);
  assert.equal(validateScoped({ declared: 1, referenced: 3 }).valid, true);
  assert.equal(validateScoped({ declared: 1, referenced: 4 }).valid, false);
  const defaulted = await client.callTool({ name: "potassium_builtin_status", arguments: { upper: 3 } });
  assert.deepEqual(defaulted.structuredContent, { span: 1 });
  const reversed = await client.callTool({ name: "potassium_builtin_status", arguments: { lower: 3, upper: 2 } });
  assert.equal(reversed.isError, true);
  assert.equal(reversed._meta.error.code, "INVALID_INPUT");
});

test("shared input schemas validate through pointer-only consumers before SDK dispatch", async (t) => {
  const { client, server } = await connectToolFixture(t, { config: { proxyMaxFrameBytes: 16384 } });
  const shared = z.object({
    value: z.number().int().min(1).max(3),
    label: z.string().min(1).max(20),
  }).strict();
  server.registerTool("potassium_builtin_status", {
    inputSchema: z.object({ first: shared, second: shared }).strict(),
  }, async ({ first, second }) => formatToolResult({ total: first.value + second.value }));
  const tools = (await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }))).tools;
  const wire = tools.find(({ name }) => name === "potassium_builtin_status").inputSchema;
  // Model consumers that resolve document pointers, not nested $id fragments.
  const expand = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (node.$ref !== undefined) {
      if (!node.$ref.startsWith("#/")) throw new Error(`Unresolved input reference: ${node.$ref}`);
      const target = node.$ref.slice(2).split("/").reduce(
        (value, token) => value?.[token.replace(/~1/g, "/").replace(/~0/g, "~")], wire,
      );
      if (target === undefined) throw new Error(`Unresolved input reference: ${node.$ref}`);
      const { $ref, ...siblings } = node;
      return { ...expand(target), ...expand(siblings) };
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expand(value)]));
  };
  const validate = new AjvJsonSchemaValidator().getValidator(expand(wire));
  const valid = { first: { value: 1, label: "first" }, second: { value: 3, label: "second" } };
  assert.equal(validate(valid).valid, true);
  assert.deepEqual((await client.callTool({ name: "potassium_builtin_status", arguments: valid })).structuredContent, { total: 4 });
  for (const second of [
    { value: 4, label: "second" },
    { value: 2, label: "" },
    { value: 2, label: "second", ignored: true },
  ]) {
    const arguments_ = { ...valid, second };
    assert.equal(validate(arguments_).valid, false);
    const rejected = await client.callTool({ name: "potassium_builtin_status", arguments: arguments_ });
    assert.equal(rejected.isError, true);
    assert.equal(rejected._meta.error.code, "INVALID_INPUT");
  }
});

test("interaction inputs reject irrelevant selectors and native argument coercions before any dispatch", async (t) => {
  const { client, requests } = await connectToolFixture(t, { config: { allowUnsafeExecute: true } });
  const tools = (await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined))).tools;
  const validateCall = new AjvJsonSchemaValidator().getValidator(tools.find(({ name }) => name === "potassium_interaction_call").inputSchema);
  for (const args of [
    { kind: "click", target: "Workspace.Click", signal: "MouseHoverEnter", distance: 0 },
    { kind: "prompt", target: "Workspace.Prompt", clientId: "c".repeat(32) },
    { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: false },
  ]) assert.equal(validateCall(args).valid, true);
  const snapshotId = "e".repeat(32), rowId = "f".repeat(32);
  for (const args of [
    { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: 0 },
    { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: 1 },
    { kind: "touch", source: "Workspace.A", target: "Workspace.B" },
    { kind: "touch", target: "Workspace.B", touch: false },
    { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: true, signal: "MouseClick" },
    { kind: "click", target: "Workspace.Click", distance: -1 },
    { kind: "click", target: "Workspace.Click", distance: Infinity },
    { kind: "click", target: "Workspace.Click", distance: NaN },
    { kind: "click", target: "Workspace.Click", distance: null },
    { kind: "click", target: "Workspace.Click", signal: "Touched" },
    { kind: "click", target: "Workspace.Click", source: "Workspace.Part" },
    { kind: "prompt", target: "Workspace.Prompt", distance: 0 },
    { kind: "prompt", target: "Workspace.Prompt", touch: false },
    { kind: "prompt", target: "Workspace.Prompt", holdDuration: 0 },
    { kind: "prompt", target: "x".repeat(1025) },
    { kind: "prompt", target: "" },
  ]) {
    assert.equal(validateCall(JSON.parse(JSON.stringify(args))).valid, false, JSON.stringify(args));
    const result = await client.callTool({ name: "potassium_interaction_call", arguments: args });
    assert.equal(result._meta.error.code, "INVALID_INPUT", JSON.stringify(args));
  }
  for (const args of [
    { view: "diff", snapshotId }, { view: "summary", limit: 20 },
    { view: "detail" }, { view: "detail", root: "Workspace.Click", snapshotId, rowId },
    { view: "detail", snapshotId }, { view: "rows", rowId },
    { cursor: "unbound" }, { view: "rows", cursor: "unbound" },
    { snapshotId, cursor: "rows-only" }, { query: {} },
    { snapshotId, query: { classNames: ["ClickDetector"] } },
    { kinds: [] }, { kinds: ["touch", "touch"] },
    { nameContains: "é".repeat(129) }, { pathContains: "\ud800" },
    { view: "rows", limit: 201 }, { maxVisited: 20001 },
    ...["root", "kinds", "nameContains", "pathContains", "maxVisited"].map((key) => ({
      snapshotId, [key]: key === "kinds" ? ["click"] : key === "maxVisited" ? 5000 : "Workspace",
    })),
    ...["cursor", "kinds", "query", "limit"].map((key) => ({
      view: "detail", root: "Workspace.Click", [key]: key === "kinds" ? ["click"] : key === "query" ? {} : key === "limit" ? 1 : "cursor",
    })),
    { view: "release" },
    ...["root", "rowId", "cursor", "query", "limit", "maxVisited", "includeReferences"].map((key) => ({
      view: "release", snapshotId, [key]: key === "query" ? {} : key === "includeReferences" ? false
        : ["limit", "maxVisited"].includes(key) ? 1 : key === "rowId" ? rowId : "Workspace",
    })),
  ]) {
    const result = await client.callTool({ name: "potassium_interaction_inventory", arguments: args });
    assert.equal(result._meta.error.code, "INVALID_INPUT", JSON.stringify(args));
  }
  assert.deepEqual(requests, []);
});

test("interaction features, touch source references, and generation changes fail before submission", async (t) => {
  const current = { clientId: "c".repeat(32), generation: 1, client: { protocol: 2 } };
  const old = { clientId: "b".repeat(32), generation: 1, client: { protocol: 2 } };
  for (const [label, features, name, args] of [
    ["inventory", { interactionInventory: {} }, "potassium_interaction_inventory", {}],
    ["actions", { interactionActions: {} }, "potassium_interaction_call", { kind: "prompt", target: "Workspace.Prompt" }],
    ["async v2", { asyncJobs: { version: 1 } }, "potassium_interaction_call", { kind: "click", target: "Workspace.Click" }],
    ["source references", { instanceReferences: {} }, "potassium_interaction_call", {
      kind: "touch", source: `instance://${"d".repeat(32)}`, target: "Workspace.B", touch: false,
    }],
    ["inventory references", { instanceReferences: {} }, "potassium_interaction_inventory", { includeReferences: true }],
    ["method", { methods: featureCapabilities.methods.filter((method) => method !== "interaction_call") },
      "potassium_interaction_call", { kind: "prompt", target: "Workspace.Prompt" }],
  ]) {
    await t.test(label, async (t) => {
      const { client, requests } = await connectToolFixture(t, {
        config: { allowUnsafeExecute: true }, clients: [old, current],
        capabilities: (clientId) => clientId === old.clientId ? { ...featureCapabilities, ...features } : featureCapabilities,
        request: async (method) => method === "interaction_inventory" ? interactionSnapshotReceipt() : { jobId: "a".repeat(32), state: "queued" },
      });
      const rejected = await client.callTool({ name, arguments: { ...args, clientId: old.clientId } });
      assert.equal(rejected._meta.error.code, "INCOMPATIBLE_CLIENT");
      if (name === "potassium_interaction_call") assert.equal(rejected._meta.error.submissionIndeterminate, false);
      assert.equal(requests.every(({ method }) => method === "capabilities"), true);
      const accepted = await client.callTool({ name, arguments: { ...args, clientId: current.clientId } });
      assert.equal(accepted.isError, undefined);
    });
  }
  const clients = [structuredClone(current)];
  const changed = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true }, clients,
    capabilities() { clients[0].generation += 1; return featureCapabilities; },
  });
  const rejected = await changed.client.callTool({
    name: "potassium_interaction_call", arguments: { kind: "prompt", target: "Workspace.Prompt" },
  });
  assert.equal(rejected._meta.error.code, "CLIENT_CHANGED");
  assert.equal(rejected._meta.error.submissionIndeterminate, false);
  assert.equal(changed.requests.every(({ method }) => method === "capabilities"), true);
});

test("interaction inventory preserves observed metadata, retained query coverage, and expired identity errors", async (t) => {
  const snapshotId = "e".repeat(32), rowId = "f".repeat(32);
  const row = interactionRowReceipt({
    referenceUnavailable: true, host: { name: "Panel", className: "Part", path: "Workspace.Panel", referenceUnavailable: true },
    properties: [{ name: "MaxActivationDistance", ok: true, value: 0 }, { name: "CursorIcon", ok: false, error: "Property unavailable" }],
    position: { ok: false, error: "Host unavailable" }, positionSource: "base-part-position",
    distanceStuds: { ok: false, error: "Local character unavailable" },
  });
  let expired = false;
  const { client, requests } = await connectToolFixture(t, {
    request: async (_method, params) => {
      if (params.view === "release") return { view: "release", snapshotId, generation: 1, released: false };
      if (expired) throw new Error("Interaction snapshot unavailable: expired, released, evicted, or another generation");
      if (params.view === "detail") {
        const { id, ...instance } = row;
        return { view: "detail", generation: 1, snapshotId, rowId, observedAt: 20, metadataTiming: "live-non-atomic",
          instance, visited: 1, coverage: "partial", truncated: true, stopReasons: ["metadata-unavailable"],
          touchCoverage: "observed-transmitters-not-exhaustive" };
      }
      if (params.snapshotId === undefined) return interactionSnapshotReceipt();
      const filtered = params.query !== undefined;
      return interactionSnapshotReceipt({
        view: params.view, observedAt: 12.5, expiresInMs: 500, visited: 5000, matchedVisited: 2, retained: 1,
        coverage: "partial", truncated: true, stopReasons: ["visit-limit", "metadata-unavailable"],
        counts: { click: filtered ? 0 : 1, prompt: 0, touch: 0 },
        ...(filtered ? { queryScope: "retained-rows", queryMatched: 0 } : {}),
        ...(params.view === "rows" ? { rows: filtered ? [] : [row], hasMore: false } : {}),
      });
    },
  });
  const name = "potassium_interaction_inventory";
  await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined), { forTool: name });
  const complete = await client.callTool({ name, arguments: {} });
  assert.equal(complete.structuredContent.coverage, "complete");
  const observed = await client.callTool({ name, arguments: { snapshotId, view: "rows", includeReferences: true } });
  assert.equal(observed.structuredContent.rows[0].properties[0].value, 0);
  assert.deepEqual(observed.structuredContent.rows[0].position, { ok: false, error: "Host unavailable" });
  assert.equal(observed.structuredContent.rows[0].referenceUnavailable, true);
  assert.equal(observed.structuredContent.rows[0].host.referenceUnavailable, true);
  const filtered = await client.callTool({ name, arguments: { snapshotId, view: "rows", query: { kinds: ["prompt"] } } });
  assert.deepEqual(filtered.structuredContent.rows, []);
  assert.equal(filtered.structuredContent.queryMatched, 0);
  assert.equal(filtered.structuredContent.retained, 1);
  assert.equal(filtered.structuredContent.coverage, "partial");
  assert.equal(filtered.structuredContent.observedAt, observed.structuredContent.observedAt);
  assert.equal(filtered.structuredContent.expiresInMs, observed.structuredContent.expiresInMs);
  const detail = await client.callTool({ name, arguments: { view: "detail", snapshotId, rowId } });
  assert.equal(detail.structuredContent.instance.properties[1].ok, false);
  assert.equal(detail.structuredContent.metadataTiming, "live-non-atomic");
  expired = true;
  const missing = await client.callTool({ name, arguments: { snapshotId, view: "rows" } });
  assert.equal(missing._meta.error.code, "REQUEST_FAILED");
  const released = await client.callTool({ name, arguments: { view: "release", snapshotId } });
  assert.equal(released.structuredContent.released, false);
  assert.equal(requests.filter(({ method, params }) => method === "interaction_inventory" && params.snapshotId === undefined).length, 1);
});

test("malformed interaction metadata fails before compact retention instead of inventing usable targets", async (t) => {
  const valid = interactionSnapshotReceipt({ view: "rows", rows: [interactionRowReceipt()], hasMore: false });
  const secret = "malformed-private-value";
  for (const mutate of [
    (copy) => { copy.rows[0].properties[0] = { name: "MaxActivationDistance", ok: false, value: 0 }; },
    (copy) => { copy.rows[0].properties[1] = { name: "CursorIcon", ok: true, value: secret, redacted: true }; },
    (copy) => { copy.rows[0].properties[0].name = "Source"; },
    (copy) => { copy.rows[0].position.value = { type: "Vector3", x: 0, y: 0 }; },
    (copy) => { copy.rows[0].position.value = 0; },
    (copy) => { copy.rows[0].positionSource = "unavailable"; },
    (copy) => { copy.rows[0].distanceStuds.value = "0"; },
    (copy) => { copy.rows[0].distanceStuds.value = -1; },
    (copy) => { copy.rows[0].reference = `instance://${"a".repeat(32)}`; copy.rows[0].referenceUnavailable = true; },
    (copy) => { copy.rows[0].helperTarget = "Workspace.Other"; },
    (copy) => { copy.rows[0].className = "Folder"; },
    (copy) => { copy.coverage = "complete"; copy.truncated = true; copy.stopReasons = ["visit-limit"]; },
    (copy) => { copy.retained = 513; },
    (copy) => { copy.counts.click = 0; },
    (copy) => { copy.hasMore = true; },
    (copy) => { copy.rows.push({ ...copy.rows[0], id: "b".repeat(32) }); copy.retained = 2; copy.matchedVisited = 2; copy.counts.click = 2; },
    (copy) => { copy.unrequested = secret; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const { client } = await connectToolFixture(t, {
      config: { maxMessageBytes: 1024 }, request: async () => invalid,
      compactResultStore: { put() { assert.fail("Invalid interaction metadata entered retention"); }, releaseScope() {} },
    });
    const result = await client.callTool({ name: "potassium_interaction_inventory", arguments: { view: "rows", limit: 1 } });
    assert.equal(result._meta.error.code, "RESULT_INVALID");
    assert.equal(result.structuredContent, undefined);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("accepted native jobs survive audit, serialization, finishing, and compact-storage faults without replay", async (t) => {
  const jobId = "a".repeat(32);
  for (const failure of ["audit begin", "audit finish", "serialization", "serialized identity", "invalid state", "finishing", "retention failure", "compact success"]) {
    await t.test(failure, async (t) => {
      const payload = { jobId, state: failure === "invalid state" ? "unknown" : "queued" };
      if (failure === "serialization") payload.toJSON = () => { throw new Error(testToken); };
      if (failure === "serialized identity") payload.toJSON = () => ({});
      if (["retention failure", "compact success"].includes(failure)) payload.metadata = "large acceptance".repeat(2000);
      const { client, server, requests } = await connectToolFixture(t, {
        config: { allowUnsafeExecute: true, maxMessageBytes: 1024 },
        audit: {
          begin() { if (failure === "audit begin") throw new Error(testToken); return {}; },
          async finish() { if (failure === "audit finish") throw new Error(testToken); },
        },
        request: async () => payload,
        ...(failure === "retention failure" ? { compactResultStore: {
          put() { throw new Error(testToken); }, releaseScope() {},
        } } : {}),
      });
      await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined), { forTool: "potassium_interaction_call" });
      if (failure === "finishing") server.finishToolResult = async () => { throw new Error(testToken); };
      const result = await client.callTool({
        name: "potassium_interaction_call", arguments: { kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: false },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.jobId, jobId);
      assert.equal(result.structuredContent.accepted, true);
      assert.equal(Buffer.byteLength(JSON.stringify(result)) <= 1024, true);
      assert.equal(JSON.stringify(result).includes(testToken), false);
      assert.equal(requests.filter(({ method }) => method === "interaction_call").length, 1);
      if (failure === "compact success") {
        assert.equal(result.structuredContent.kind, "potassium/result");
        const page = await client.callTool({
          name: "potassium_result_read", arguments: { resultId: result.structuredContent.resultId, pointer: "/jobId" },
        });
        assert.equal(page.structuredContent.selections[0].value, jobId);
      } else {
        assert.equal(result.structuredContent.warning, failure.startsWith("audit") ? "AUDIT_FAILED" : "RESULT_FORMAT_FAILED");
      }
    });
  }
});

test("native terminal receipts retain dispatch-only meaning through existing async readers", async (t) => {
  const jobId = "a".repeat(32);
  const status = { jobId, kind: "interaction_call", state: "succeeded", dispatchStarted: true, cancellationRequested: true };
  const receipt = { count: 0, values: [], dispatchStarted: true, dispatched: true, serverAcknowledged: false, interactionKind: "touch" };
  const { client } = await connectToolFixture(t, {
    config: { allowUnsafeExecute: true },
    request: async (method) => method === "async_job_result" ? { ...status, ready: true, result: receipt }
      : method === "async_job_list" ? { jobs: [status], truncated: false } : status,
  });
  await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined), { forTool: "potassium_async_job_result" });
  const terminal = await client.callTool({ name: "potassium_async_job_result", arguments: { jobId } });
  assert.equal(terminal.structuredContent.ready, true);
  assert.equal(terminal.structuredContent.state, "succeeded");
  assert.equal(terminal.structuredContent.cancellationRequested, true);
  assert.deepEqual(terminal.structuredContent.result, receipt);
  const listed = await client.callTool({ name: "potassium_async_job_list", arguments: {} });
  assert.equal(listed.structuredContent.jobs[0].kind, "interaction_call");
  const cancelled = await client.callTool({ name: "potassium_async_job_cancel", arguments: { jobId } });
  assert.equal(cancelled.structuredContent.state, "succeeded");
  assert.equal(cancelled.structuredContent.dispatchStarted, true);
  receipt.serverAcknowledged = true;
  const falseAcknowledgement = await client.callTool({ name: "potassium_async_job_result", arguments: { jobId } });
  assert.equal(falseAcknowledgement._meta.error.code, "RESULT_INVALID");
  receipt.serverAcknowledged = false;
  receipt.values = ["invented helper success"];
  const helperReturn = await client.callTool({ name: "potassium_async_job_result", arguments: { jobId } });
  assert.equal(helperReturn._meta.error.code, "RESULT_INVALID");
});

test("interaction touch metadata distinguishes observed transmitters from explicitly selected parts", async (t) => {
  const body = {
    kind: "touch", name: "Pad", className: "Part", path: "Workspace.Pad", parent: "Workspace",
    touchEvidence: "explicit-part", host: { name: "Pad", className: "Part", path: "Workspace.Pad" },
    properties: ["CanTouch", "CanCollide", "CanQuery", "Anchored"].map((name) => ({ name, ok: true, value: name !== "CanCollide" })),
    position: { ok: true, value: { type: "Vector3", x: 0, y: 2, z: 0 } }, positionSource: "base-part-position",
    distanceStuds: { ok: true, value: 2 }, reference: `instance://${"a".repeat(32)}`,
  };
  const { client } = await connectToolFixture(t, {
    request: async (_method, params) => params.view === "detail" ? {
      view: "detail", generation: 1, observedAt: 124.5, metadataTiming: "live-non-atomic",
      touchCoverage: "observed-transmitters-not-exhaustive", instance: body,
      visited: 1, truncated: false, coverage: "complete", stopReasons: [],
    } : interactionSnapshotReceipt({
      view: "rows", counts: { click: 0, prompt: 0, touch: 1 }, rows: [{
        ...body, id: "f".repeat(32), name: "TouchInterest", className: "TouchTransmitter",
        path: "Workspace.Pad.TouchInterest", parent: "Workspace.Pad", touchEvidence: "transmitter-observed",
        reference: `instance://${"b".repeat(32)}`, host: { ...body.host, reference: body.reference },
      }], hasMore: false,
    }),
  });
  const name = "potassium_interaction_inventory";
  await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined), { forTool: name });
  const rows = await client.callTool({ name, arguments: { view: "rows", includeReferences: true } });
  const detail = await client.callTool({ name, arguments: { view: "detail", root: "Workspace.Pad", includeReferences: true } });
  assert.equal(rows.structuredContent.rows[0].touchEvidence, "transmitter-observed");
  assert.notEqual(rows.structuredContent.rows[0].reference, detail.structuredContent.instance.reference);
  assert.equal(rows.structuredContent.rows[0].host.reference, detail.structuredContent.instance.reference);
  assert.equal(detail.structuredContent.instance.touchEvidence, "explicit-part");
  assert.equal(detail.structuredContent.instance.properties[1].value, false);
});

test("interaction prompt metadata accepts whole-value redaction but rejects partially exposed text", async (t) => {
  const actionText = { name: "ActionText", ok: true, value: "[redacted]", redacted: true };
  const { id, ...instance } = interactionRowReceipt({
    kind: "prompt", name: "Prompt", className: "ProximityPrompt", path: "Workspace.Panel.Prompt",
    properties: [
      { name: "Enabled", ok: true, value: true }, actionText,
      { name: "ObjectText", ok: true, value: "Panel" }, { name: "HoldDuration", ok: true, value: 0 },
      { name: "MaxActivationDistance", ok: true, value: 10 }, { name: "RequiresLineOfSight", ok: true, value: false },
      { name: "KeyboardKeyCode", ok: true, value: { type: "EnumItem", value: "Enum.KeyCode.E" } },
      { name: "GamepadKeyCode", ok: true, value: { type: "EnumItem", value: "Enum.KeyCode.ButtonX" } },
      { name: "Exclusivity", ok: true, value: { type: "EnumItem", value: "Enum.ProximityPromptExclusivity.OnePerButton" } },
      { name: "Style", ok: true, value: { type: "EnumItem", value: "Enum.ProximityPromptStyle.Default" } },
    ],
  });
  const { client } = await connectToolFixture(t, {
    request: async (_method, params) => params.view === "detail" ? {
      view: "detail", generation: 1, observedAt: 20, metadataTiming: "live-non-atomic",
      touchCoverage: "observed-transmitters-not-exhaustive", instance,
      visited: 1, coverage: "complete", truncated: false, stopReasons: [],
    } : interactionSnapshotReceipt({
      view: "rows", counts: { click: 0, prompt: 1, touch: 0 }, rows: [{ ...instance, id }], hasMore: false,
    }),
    compactResultStore: { put() { assert.fail("Rejected prompt metadata must not enter retention"); }, releaseScope() {} },
  });
  const name = "potassium_interaction_inventory";
  await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined), { forTool: name });
  for (const args of [{ view: "rows" }, { view: "detail", root: "Workspace.Panel.Prompt" }]) {
    const valid = await client.callTool({ name, arguments: args });
    assert.equal(valid.isError, undefined);
    const properties = args.view === "rows" ? valid.structuredContent.rows[0].properties : valid.structuredContent.instance.properties;
    assert.deepEqual(properties.find(({ name }) => name === "ActionText"), actionText);
    actionText.value = "Open [redacted]";
    const malformed = await client.callTool({ name, arguments: args });
    assert.equal(malformed._meta.error.code, "RESULT_INVALID");
    assert.equal(JSON.stringify(malformed).includes("Open [redacted]"), false);
    actionText.value = "[redacted]";
  }
});

test("advertised interaction views preserve strict contracts through SDK and local-reference consumers", async (t) => {
  const { client, requests } = await connectToolFixture(t, { config: { proxyMaxFrameBytes: 16384 } });
  const name = "potassium_interaction_inventory";
  const tools = (await listAllTools((cursor) => client.listTools(cursor ? { cursor } : undefined), { forTool: name })).tools;
  const wire = tools.find((tool) => tool.name === name).outputSchema;
  // As in the pointer-only input consumer, expand local refs before validation.
  // Outputs also publish local fragment IDs; resolve their declared definitions,
  // then strip the inlined IDs so a pointer-only consumer needs no anchor support.
  const definitions = Object.values(wire.definitions ?? {});
  const expand = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (node.$ref !== undefined) {
      const target = node.$ref.startsWith("#/")
        ? node.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], wire)
        : definitions.find((definition) => definition.$id === node.$ref);
      if (target === undefined) throw new Error(`Unresolved output reference: ${node.$ref}`);
      const { $ref, $id, ...siblings } = node;
      return { ...expand(target), ...expand(siblings) };
    }
    const { $id, ...unscoped } = node;
    return Object.fromEntries(Object.entries(unscoped).map(([key, value]) => [key, expand(value)]));
  };
  const validateSdk = new AjvJsonSchemaValidator().getValidator(wire);
  const validateLocal = new AjvJsonSchemaValidator().getValidator(expand(wire));
  const { id, ...instance } = interactionRowReceipt();
  const summary = interactionSnapshotReceipt();
  const rows = interactionSnapshotReceipt({ view: "rows", rows: [{ ...instance, id }], hasMore: false });
  const detail = {
    view: "detail", generation: 1, observedAt: 20, metadataTiming: "live-non-atomic",
    touchCoverage: "observed-transmitters-not-exhaustive", instance,
    visited: 1, coverage: "complete", truncated: false, stopReasons: [],
  };
  const release = { view: "release", generation: 1, snapshotId: summary.snapshotId, released: false };
  for (const valid of [summary, rows, detail, release]) {
    assert.equal(validateSdk(valid).valid, true, valid.view);
    assert.equal(validateLocal(valid).valid, true, valid.view);
  }
  for (const [base, mutate] of [
    [summary, (value) => { delete value.root; }],
    [rows, (value) => { delete value.rows; }],
    [rows, (value) => { delete value.hasMore; }],
    [release, (value) => { value.counts = summary.counts; }],
    [detail, (value) => { value.touchEvidence = "explicit-part"; }],
    [detail, (value) => { delete value.metadataTiming; }],
    [rows, (value) => { value.rows[0].position.value = { type: "Vector2", x: 0, y: 0 }; }],
    [rows, (value) => { value.rows[0].distanceStuds.value = -1; }],
    [rows, (value) => { value.rows[0].unknown = true; }],
    [rows, (value) => { value.rows[0].path = ""; }],
    [rows, (value) => { value.rows[0].properties[0].value = { type: "Vector3", x: 0, y: 0, z: 0 }; }],
    [rows, (value) => { delete value.rows[0].id; }],
    [detail, (value) => { value.instance.id = id; }],
  ]) {
    const invalid = structuredClone(base);
    mutate(invalid);
    assert.equal(validateSdk(invalid).valid, false, JSON.stringify(invalid));
    assert.equal(validateLocal(invalid).valid, false, JSON.stringify(invalid));
  }
  assert.deepEqual(requests, []);
});

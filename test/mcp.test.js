import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { actionableToolError, formatToolResult, loadConfig } from "../src/server.js";
import { AdminAuditRecorder } from "../src/admin-audit.js";

const testToken = "test-token-that-is-longer-than-thirty-two-characters";

const testProtocol = 2;

function testProof(role, clientNonce, serverNonce) {
  const transcript = `potassium-mcp/v${testProtocol}|${role}|${clientNonce}|${serverNonce}`;
  const transcriptHash = createHash("sha256").update(transcript, "utf8").digest("hex");
  return createHmac("sha256", testToken).update(transcriptHash, "utf8").digest("base64");
}

async function authenticate(socket) {
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({
    type: "hello",
    protocol: testProtocol,
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
  assert.equal(JSON.parse(readyPayload.toString()).type, "ready");
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
  const defaultsPath = join(directory, "defaults.json");
  await writeFile(defaultsPath, JSON.stringify(baseConfig()));
  assert.equal((await loadConfig(defaultsPath)).allowUnsafeExecute, false);
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

test("returns a compact actionable error for oversized tool results", () => {
  const result = formatToolResult({ value: "x".repeat(4096) }, 1024);
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Result exceeds the 1024-byte response limit. "
      + "Narrow path or filters, or reduce limit, maxVisited, maxResults, or maxClasses.",
  );
  assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") < 1024, true);

  const bounded = formatToolResult({ ok: true }, 1024);
  assert.equal(bounded.content[0].text, "{\"ok\":true}");
  assert.deepEqual(bounded.structuredContent, { ok: true });
  const array = formatToolResult(["a"], 1024);
  assert.deepEqual(array.structuredContent, { value: ["a"] });
});

test("keeps redacted admin execution history bounded", async () => {
  const audit = new AdminAuditRecorder();
  const bridge = { status: () => ({ client: { executor: "Potassium", protocol: 2 } }) };
  const timeout = audit.begin({ code: "secret source", bridge, sessionId: "session" });
  await audit.finish(timeout, "timeout", new Error("Potassium request timed out after 1 ms"));
  assert.equal(audit.history(1)[0].outcome, "timeout");
  assert.equal(audit.history(1)[0].errorClass, "timeout");
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

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "potassium_artifact_read",
    "potassium_attribute_inventory",
    "potassium_capabilities",
    "potassium_class_summary",
    "potassium_client_state",
    "potassium_diagnostic_snapshot",
    "potassium_find_instances",
    "potassium_http_get",
    "potassium_inspect_instance",
    "potassium_instance_ancestry",
    "potassium_list_children",
    "potassium_list_tags",
    "potassium_multi_read_properties",
    "potassium_observe_changes",
    "potassium_observe_logs",
    "potassium_overlap_query",
    "potassium_performance_snapshot",
    "potassium_place_metadata",
    "potassium_read_properties",
    "potassium_remote_inventory",
    "potassium_script_fingerprint",
    "potassium_script_inventory",
    "potassium_signal_inventory",
    "potassium_snapshot_diff",
    "potassium_spatial_query",
    "potassium_status",
    "potassium_subtree_summary",
    "potassium_trace_query",
    "potassium_trace_summary",
    "potassium_ui_inventory",
  ]);
  for (const tool of tools.tools) {
    assert.match(tool.title, /^Potassium /);
    assert.equal(tool.outputSchema.type, "object");
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: ["potassium_http_get", "potassium_place_metadata"].includes(tool.name),
    });
  }
  assert.equal(tools.tools.find(({ name }) => name === "potassium_http_get").title, "Potassium HTTP Get");
  assert.equal(tools.tools.find(({ name }) => name === "potassium_ui_inventory").title, "Potassium UI Inventory");

  const result = await client.callTool({ name: "potassium_status", arguments: {} });
  assert.equal(result.isError, undefined);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.connected, false);
  assert.match(status.endpoint, /^ws:\/\/127\.0\.0\.1:/);

  const disconnected = await client.callTool({ name: "potassium_capabilities", arguments: {} });
  assert.equal(disconnected.isError, true);
  assert.deepEqual(disconnected.content, [{
    type: "text",
    text: "Potassium is not connected. Start or re-attach Potassium, then call potassium_status.",
  }]);
});

test("exposes and forwards unrestricted Luau only when explicitly enabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-mcp-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(baseConfig({ allowUnsafeExecute: true })));
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

  const tools = await client.listTools();
  const execute = tools.tools.find((tool) => tool.name === "potassium_execute_luau");
  assert.ok(execute);
  assert.deepEqual(execute.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(execute.inputSchema.properties.code, {
    type: "string",
    minLength: 1,
    maxLength: 32768,
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
  assert.equal(history.entries[0].utf8Bytes, Buffer.byteLength("return 6 * 7"));
  assert.match(history.entries[0].codeSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(history).includes("return 6 * 7"), false);
  assert.equal(Object.hasOwn(history.entries[0], "result"), false);

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
test("timeout recovery guidance waits for the late response before narrowing retries", () => {
  assert.equal(
    actionableToolError(new Error("Potassium executor is recovering from a timed-out request")),
    "Potassium executor is recovering from a timed-out request. Await the late response, call potassium_status, restart Potassium if recovery is stuck, then retry with narrower bounds.",
  );
  assert.equal(
    actionableToolError(new Error("Potassium request timed out after 30000 ms")),
    "Potassium request timed out after 30000 ms. Await the late response, call potassium_status, restart Potassium if recovery is stuck, then retry with a narrower path or lower limit, maxVisited, maxResults, or maxClasses.",
  );
});


test("validates and forwards bounded read-only inventory tools", async (t) => {
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

  const tools = await client.listTools();
  const findInstances = tools.tools.find((tool) => tool.name === "potassium_find_instances");
  const readProperties = tools.tools.find((tool) => tool.name === "potassium_read_properties");
  const listTags = tools.tools.find((tool) => tool.name === "potassium_list_tags");
  const performanceSnapshot = tools.tools.find((tool) => tool.name === "potassium_performance_snapshot");
  const overlapQuery = tools.tools.find((tool) => tool.name === "potassium_overlap_query");
  const attributeInventory = tools.tools.find((tool) => tool.name === "potassium_attribute_inventory");
  const subtreeSummary = tools.tools.find((tool) => tool.name === "potassium_subtree_summary");
  const spatialQuery = tools.tools.find((tool) => tool.name === "potassium_spatial_query");
  const uiInventory = tools.tools.find((tool) => tool.name === "potassium_ui_inventory");
  const signalInventory = tools.tools.find((tool) => tool.name === "potassium_signal_inventory");
  const observeChanges = tools.tools.find((tool) => tool.name === "potassium_observe_changes");
  const observeLogs = tools.tools.find((tool) => tool.name === "potassium_observe_logs");
  const scriptFingerprint = tools.tools.find((tool) => tool.name === "potassium_script_fingerprint");
  assert.deepEqual(findInstances.inputSchema.properties.limit, {
    type: "integer", minimum: 1, maximum: 200, default: 100,
  });
  assert.deepEqual(findInstances.inputSchema.properties.maxVisited, {
    type: "integer", minimum: 1, maximum: 20000, default: 5000,
  });
  assert.deepEqual(readProperties.inputSchema.properties.properties, {
    type: "array",
    minItems: 1,
    maxItems: 32,
    items: { type: "string", maxLength: 64, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
  });
  assert.deepEqual(scriptFingerprint.inputSchema.properties.path, {
    type: "string", minLength: 1, maxLength: 1024,
  });
  assert.equal(scriptFingerprint.inputSchema.additionalProperties, false);
  assert.deepEqual(listTags.inputSchema.properties.limit, {
    type: "integer", minimum: 1, maximum: 200, default: 100,
  });
  assert.deepEqual(performanceSnapshot.inputSchema.properties.maxVisited, {
    type: "integer", minimum: 1, maximum: 20000, default: 5000,
  });
  assert.deepEqual(performanceSnapshot.inputSchema.properties.maxClassCounts, {
    type: "integer", minimum: 1, maximum: 500, default: 200,
  });
  assert.deepEqual(overlapQuery.inputSchema.properties.maxResults, {
    type: "integer", minimum: 1, maximum: 200, default: 100,
  });
  assert.deepEqual(overlapQuery.inputSchema.properties.excludePaths, {
    type: "array", maxItems: 16, default: [], items: { type: "string", minLength: 1, maxLength: 1024 },
  });
  assert.deepEqual(attributeInventory.inputSchema.properties.attributeNames, {
    type: "array", maxItems: 32, default: [], items: { type: "string", minLength: 1, maxLength: 128 },
  });
  assert.deepEqual(attributeInventory.inputSchema.properties.limit, {
    type: "integer", minimum: 1, maximum: 500, default: 100,
  });
  assert.deepEqual(attributeInventory.inputSchema.properties.maxVisited, {
    type: "integer", minimum: 1, maximum: 10000, default: 3000,
  });
  assert.deepEqual(subtreeSummary.inputSchema.properties.maxDepth, {
    type: "integer", minimum: 0, maximum: 8, default: 4,
  });
  assert.deepEqual(subtreeSummary.inputSchema.properties.maxSummaryEntries, {
    type: "integer", minimum: 1, maximum: 500, default: 200,
  });
  assert.deepEqual(spatialQuery.inputSchema.properties.maxDistance, {
    type: "number", minimum: 0.1, maximum: 10000, default: 1000,
  });
  assert.deepEqual(spatialQuery.inputSchema.properties.maxResults, {
    type: "integer", minimum: 1, maximum: 200, default: 100,
  });
  assert.deepEqual(uiInventory.inputSchema.properties.roots, {
    type: "string", enum: ["player_gui", "core_gui", "both"], default: "player_gui",
  });
  assert.deepEqual(signalInventory.inputSchema.properties.limitPerSignal, {
    type: "integer", minimum: 1, maximum: 200, default: 100,
  });
  assert.deepEqual(observeChanges.inputSchema.properties.durationMs, {
    type: "integer", minimum: 100, maximum: 5000, default: 1000,
  });
  assert.deepEqual(observeChanges.inputSchema.properties.properties, {
    type: "array",
    maxItems: 16,
    default: [],
    items: { type: "string", maxLength: 64, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
  });
  assert.deepEqual(observeLogs.inputSchema.properties.durationMs, {
    type: "integer", minimum: 100, maximum: 5000, default: 1000,
  });
  assert.deepEqual(observeLogs.inputSchema.properties.maxEvents, {
    type: "integer", minimum: 1, maximum: 200, default: 100,
  });
  assert.deepEqual(observeLogs.inputSchema.properties.minLevel, {
    type: "string", enum: ["output", "info", "warning", "error"], default: "output",
  });

  for (const [name, arguments_] of [
    ["potassium_find_instances", { root: "workspace", nameContains: "Widget" }],
    ["potassium_read_properties", { path: "workspace.Part", properties: ["Name", "Position"] }],
    ["potassium_list_tags", { tag: "Collectible" }],
    ["potassium_diagnostic_snapshot", {}],
    ["potassium_script_fingerprint", { path: "workspace.Controller" }],
    ["potassium_script_inventory", { scope: "loaded" }],
    ["potassium_remote_inventory", { root: "ReplicatedStorage" }],
    ["potassium_performance_snapshot", {}],
    ["potassium_overlap_query", { path: "workspace.Part" }],
    ["potassium_attribute_inventory", { path: "workspace.Part" }],
    ["potassium_subtree_summary", { path: "workspace.Model" }],
    ["potassium_spatial_query", { mode: "radius", center: { x: 1, y: 2, z: 3 }, radius: 10 }],
    ["potassium_ui_inventory", {}],
    ["potassium_signal_inventory", { path: "workspace.Part", signals: ["Changed"] }],
    ["potassium_observe_changes", { path: "workspace.Part" }],
    ["potassium_observe_logs", {}],
  ]) {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, undefined);
  }

  assert.deepEqual(
    requests.map(({ method, params }) => ({ method, params })),
    [
      {
        method: "find_instances",
        params: { root: "workspace", nameContains: "Widget", limit: 100, maxVisited: 5000 },
      },
      { method: "read_properties", params: { path: "workspace.Part", properties: ["Name", "Position"] } },
      { method: "list_tags", params: { tag: "Collectible", limit: 100 } },
      { method: "diagnostic_snapshot", params: {} },
      { method: "script_fingerprint", params: { path: "workspace.Controller" } },
      { method: "script_inventory", params: { scope: "loaded", limit: 100, maxVisited: 5000 } },
      { method: "remote_inventory", params: { root: "ReplicatedStorage", limit: 100, maxVisited: 5000 } },
      {
        method: "performance_snapshot",
        params: { maxVisited: 5000, maxClassCounts: 200 },
      },
      {
        method: "overlap_query",
        params: { path: "workspace.Part", maxResults: 100, excludePaths: [] },
      },
      {
        method: "attribute_inventory",
        params: {
          path: "workspace.Part",
          recursive: false,
          attributeNames: [],
          limit: 100,
          maxVisited: 3000,
        },
      },
      {
        method: "subtree_summary",
        params: { path: "workspace.Model", maxDepth: 4, maxVisited: 5000, maxSummaryEntries: 200 },
      },
      {
        method: "spatial_query",
        params: {
          mode: "radius",
          center: { x: 1, y: 2, z: 3 },
          radius: 10,
          maxDistance: 1000,
          maxResults: 100,
        },
      },
      {
        method: "ui_inventory",
        params: { roots: "player_gui", includeText: false, limit: 100, maxVisited: 3000 },
      },
      {
        method: "signal_inventory",
        params: { path: "workspace.Part", signals: ["Changed"], limitPerSignal: 100 },
      },
      {
        method: "observe_changes",
        params: {
          path: "workspace.Part",
          durationMs: 1000,
          maxEvents: 100,
          properties: [],
          includeAttributes: true,
          includeChildren: true,
        },
      },
      {
        method: "observe_logs",
        params: { durationMs: 1000, maxEvents: 100, minLevel: "output" },
      },
    ],
  );

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
  assert.equal(requests.length, 16);
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
  assert.equal(requests.length, 16);
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
  assert.equal(requests.length, 16);
  const newTools = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(newTools.potassium_multi_read_properties.inputSchema.properties.maxTotalValues, {
    type: "integer", minimum: 1, maximum: 200, default: 200,
  });

  for (const [name, arguments_] of [
    ["potassium_client_state", {}],
    ["potassium_snapshot_diff", { path: "workspace.Model" }],
    ["potassium_multi_read_properties", { requests: [{ path: "workspace.A", properties: ["Name"] }] }],
    ["potassium_instance_ancestry", { path: "workspace.A" }],
    ["potassium_class_summary", { path: "workspace" }],
  ]) {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(
    requests.slice(-5).map(({ method, params }) => ({ method, params })),
    [
      { method: "client_state", params: {} },
      { method: "snapshot_diff", params: { path: "workspace.Model", properties: ["Name"], includeAttributes: true, includeTags: true, maxDepth: 1, maxVisited: 100, durationMs: 250, maxChanges: 100 } },
      { method: "multi_read_properties", params: { requests: [{ path: "workspace.A", properties: ["Name"] }], maxTotalValues: 200 } },
      { method: "instance_ancestry", params: { path: "workspace.A", maxDepth: 16 } },
      { method: "class_summary", params: { path: "workspace", maxDepth: 4, maxVisited: 5000, maxClasses: 100 } },
    ],
  );
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
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { respondHttps } from "./helpers/safe-read-https.js";

const source = process.env.MCP_READ_POLICY_SOURCE_DIR ?? new URL("../src/", import.meta.url);
const load = (name) => import(source instanceof URL ? new URL(name, source) : pathToFileURL(join(resolve(source), name)));
const { readArtifact, queryTrace, getAllowedHttps } = await load("safe-read.js");
const { createAsyncArtifactStore, ASYNC_ARTIFACT_INLINE_BYTES, ASYNC_ARTIFACT_MAX_COUNT } = await load("async-artifact-store.js");
const { parseHostPolicies, parseHttpPolicy } = await load("host-policy.js");
const { createBuiltinFallbackClient } = await load("builtin-fallback.js");
const { AdminAuditRecorder } = await load("admin-audit.js");
const token = "synthetic-diagnostic-bearer-0123456789";

async function directory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "potassium-read-policy-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function traceConfig(root) {
  return { token, artifactRoots: [{ name: "trace_records", path: root, recursive: false, extensions: [".ndjson"] }] };
}

function fallbackClient(fetch, extra = {}) {
  return createBuiltinFallbackClient({ tokenFile: "synthetic-only", readToken: async () => token, fetch, ...extra });
}

function diagnosticFetch(result) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result:
      request.method === "initialize" ? { protocolVersion: "2025-06-18" }
        : request.method === "tools/list" ? { tools: [{ name: "list_clients" }] } : result,
    }), { headers: { "content-type": "application/json" } });
  };
}

test("trace rows preserve null and own prototype-named data without inheriting metadata", async (t) => {
  const root = await directory(t);
  await fs.writeFile(join(root, "rows.ndjson"), '{"kind":"observed","optional":null,"__proto__":{"kind":"forged"}}\n');
  const result = await queryTrace({ path: "rows.ndjson" }, traceConfig(root));
  assert.equal(result.rows[0].optional, null);
  assert.equal(Object.hasOwn(result.rows[0], "__proto__"), true);
  assert.equal(result.rows[0].kind, "observed");
  assert.equal(Object.getPrototypeOf(result.rows[0]), Object.prototype);
});

test("trace secret-key values and tokens crossing truncation boundaries remain redacted", async (t) => {
  const root = await directory(t);
  await fs.writeFile(join(root, "rows.ndjson"), `${JSON.stringify({
    kind: "observed", credentials: { value: "synthetic-private-value" },
    message: `${"x".repeat(4080)}${token}`, nested: { password: ["synthetic-password"] },
  })}\n`);
  const { rows } = await queryTrace({ path: "rows.ndjson" }, traceConfig(root));
  assert.equal(rows[0].credentials, "[REDACTED]");
  assert.equal(rows[0].nested.password, "[REDACTED]");
  assert.equal(rows[0].message, `${"x".repeat(4080)}[REDACTED]`);
});

test("HTTP JSON redacts structured secret values while preserving safe fields", async () => {
  const result = await getAllowedHttps({ url: "https://example.com/data" }, { token, httpAllowedHosts: ["example.com"] }, {
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    httpsRequest: respondHttps(async () => new Response(JSON.stringify({ ok: true, credentials: { value: "synthetic-private-value" }, password: ["synthetic-password"] }), {
      headers: { "content-type": "application/problem+json" },
    })),
  });
  assert.equal(result.text.includes("synthetic-private-value"), false);
  assert.equal(result.text.includes("synthetic-password"), false);
  assert.match(result.text, /"ok":true/);
});

test("cross-drive resolved artifacts cannot escape a recursive Windows root", { skip: process.platform !== "win32" }, async () => {
  let opened = false;
  await assert.rejects(readArtifact({ root: "audits", path: "linked.json" }, {
    artifactRoots: [{ name: "audits", path: "C:\\synthetic-root", recursive: true, extensions: [".json"] }],
  }, {
    realpath: async (path) => path === "C:\\synthetic-root" ? path : "D:\\outside\\data.json",
    stat: async () => ({ isDirectory: () => true, dev: 1n, ino: 1n }),
    open: async () => { opened = true; return { read: async (buffer) => { buffer.write("{}"); return { bytesRead: 2 }; }, close: async () => {} }; },
  }), /escapes/);
  assert.equal(opened, false);
});

test("policy parsers reject explicit null grants", () => {
  assert.throws(() => parseHostPolicies({ omp: { execute: null } }), TypeError);
  assert.throws(() => parseHttpPolicy({ read: null }), TypeError);
});

test("artifact allocation exhaustion never returns another result's descriptor", async (t) => {
  const root = await directory(t);
  const store = createAsyncArtifactStore({ root: { name: "artifacts", path: root }, clock: { now: () => 1_700_000_000_000 }, randomBytes: (size) => Buffer.alloc(size, 1) });
  const first = await store.store({ text: "a".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
  await assert.rejects(store.store({ text: "b".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }), /allocate/);
  assert.equal(JSON.parse(await fs.readFile(join(root, first.artifact.path), "utf8")).text, "a".repeat(ASYNC_ARTIFACT_INLINE_BYTES));
});

test("capacity pruning retains the descriptor just returned even with tied timestamps", async (t) => {
  const root = await directory(t);
  const time = 1_700_000_000_000;
  const folder = join(root, "async-results");
  await fs.mkdir(folder);
  for (let index = 0; index < ASYNC_ARTIFACT_MAX_COUNT; index += 1) {
    const file = join(folder, `${time}-${(index + 1).toString(16).padStart(32, "f")}.json`);
    await fs.writeFile(file, "{}");
    await fs.utimes(file, time / 1000, time / 1000);
  }
  const store = createAsyncArtifactStore({ root: { name: "artifacts", path: root }, clock: { now: () => time }, randomBytes: (size) => Buffer.alloc(size) });
  const result = await store.store({ text: "new".padEnd(ASYNC_ARTIFACT_INLINE_BYTES, "x") });
  assert.equal(JSON.parse(await fs.readFile(join(root, result.artifact.path), "utf8")).text, "new".padEnd(ASYNC_ARTIFACT_INLINE_BYTES, "x"));
  assert.equal((await fs.readdir(folder)).filter((name) => name.endsWith(".json")).length, ASYNC_ARTIFACT_MAX_COUNT);
});

test("fallback redacts authentication tokens from both result keys and values", async () => {
  const client = fallbackClient(diagnosticFetch({ content: [{ type: "text", text: "diagnostic" }], structuredContent: { [token]: token, safe: true } }));
  const result = await client.listClients();
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(result.structuredContent.safe, true);
});

test("fallback refuses redirect-following transport rather than leaving its fixed endpoint", async () => {
  const client = fallbackClient(async (_url, init) => {
    if (init.redirect === "error") throw new TypeError("redirect rejected");
    return diagnosticFetch({ content: [{ type: "text", text: "redirected" }] })(_url, init);
  });
  await assert.rejects(client.status(), /request failed/);
});

test("fallback cancels rejected response bodies and does not await stalled cancellation", async () => {
  let canceled = false;
  const client = fallbackClient(async () => new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }), { status: 401 }));
  await assert.rejects(client.status(), /non-success/);
  assert.equal(canceled, true);
});

test("fallback bounds oversized streams even when their cancellation never settles", { timeout: 1000 }, async () => {
  let canceled = false;
  const client = fallbackClient(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { canceled = true; return new Promise(() => {}); },
  }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(client.status(), /65536-byte limit/);
  assert.equal(canceled, true);
});

test("overlapping admin completions replay every durable record in completion order", async (t) => {
  const root = await directory(t);
  const path = join(root, "audit.ndjson");
  const audit = new AdminAuditRecorder({ path });
  const bridge = { status: () => ({ client: { executor: "synthetic" } }) };
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const originalWriteFile = fs.writeFile;
  let calls = 0;
  let durableContents;
  fs.writeFile = async (_path, contents) => {
    calls += 1;
    if (calls === 1) { firstStarted(); await gate; }
    durableContents = contents;
  };
  syncBuiltinESMExports();
  try {
    const first = audit.finish(audit.begin({ code: "return 1", bridge, sessionId: "first" }), "success");
    await started;
    const second = audit.finish(audit.begin({ code: "return 2", bridge, sessionId: "second" }), "success");
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);
  } finally {
    releaseFirst?.();
    fs.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }
  await fs.writeFile(path, durableContents);
  const replayed = new AdminAuditRecorder({ path });
  assert.deepEqual(replayed.history(2).map((entry) => entry.sessionId), ["second", "first"]);
});

test("safe HTTP rejection remains bounded when response cancellation never settles", { timeout: 1000 }, async () => {
  let canceled = false;
  let resolveCancellation;
  const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
  await assert.rejects(getAllowedHttps({ url: "https://example.com/data", maxBytes: 4 }, { httpAllowedHosts: ["example.com"] }, {
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    httpsRequest: respondHttps(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { canceled = true; resolveCancellation(); return new Promise(() => {}); },
    }), { headers: { "content-type": "text/plain" } })),
  }), /maxBytes/);
  await cancellation;
  assert.equal(canceled, true);
});

test("artifact allocation never deletes a staging file owned by another writer", async (t) => {
  const root = await directory(t);
  const time = 1_700_000_000_000;
  const hex = "01".repeat(16);
  const folder = join(root, "async-results");
  await fs.mkdir(folder);
  const staged = join(folder, `.${time}-${hex}.json.${hex}.tmp`);
  await fs.writeFile(staged, "another writer's pending bytes");
  const store = createAsyncArtifactStore({ root: { name: "artifacts", path: root }, clock: { now: () => time }, randomBytes: (size) => Buffer.alloc(size, 1) });
  await assert.rejects(store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }), /allocate/);
  assert.equal(await fs.readFile(staged, "utf8"), "another writer's pending bytes");
});

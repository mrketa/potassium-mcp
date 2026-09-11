import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink, open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeIndexService, CODE_INDEX_LIMITS } from "../src/code-index.js";
import { parseAuthoredModules } from "./helpers/code-parser.js";

function fixture(options = {}) {
  const clock = { value: 1000, now() { return this.value; } };
  const service = createCodeIndexService({ parse: parseAuthoredModules, clock, ...options });
  const index = (source, options = {}, config = {}) => service.index({ scopeId: "a", modules: [{ id: "Main", logicalPath: "Root/Main", source }], ...options }, config);
  const query = (indexId, options = {}, permission = () => true) => service.query({ scopeId: "a", indexId, ...options }, permission);
  return { service, clock, index, query };
}

async function sourceRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), "potassium-source-雪 "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "sources");
  await mkdir(root);
  return { directory, root, config: { sourceRoots: [{ name: "owned", path: root, recursive: false, extensions: [".luau"] }] } };
}

test("inline indexing is executor-independent, immutable and isolated by scope and origin permission", async () => {
  const { service, index, query } = fixture();
  const source = "local function run(value) consume(value) end\nrun('hidden')";
  const created = await index(source);
  assert.equal(created.files[0].sha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(created.completeness.execution, "not-executed");
  created.files[0].id = "changed";
  const page = query(created.indexId, { view: "functions" });
  assert.equal(page.rows[0].name, "run");
  page.rows[0].name = "changed";
  assert.equal(query(created.indexId, { view: "functions" }).rows[0].name, "run");
  assert.throws(() => query(created.indexId, { scopeId: "b" }, () => assert.fail("foreign policy must not be consulted")), { code: "CODE_NOT_FOUND" });
  assert.throws(() => query(created.indexId, {}, () => false), { code: "CODE_ORIGIN_DENIED" });
  assert.throws(() => query(created.indexId, {}, () => Promise.resolve(true)), { code: "CODE_ORIGIN_DENIED" });
  assert.equal(query(created.indexId, {}, (tool) => tool === "potassium_code_index").files[0].id, "Main");
  service.releaseScope("a");
  assert.throws(() => query(created.indexId), { code: "CODE_NOT_FOUND" });
});

test("query cursors preserve selection, reject tampering and retain exact pagination across page-size changes", async () => {
  const { index, query } = fixture();
  const created = await index("first()\nsecond()\nthird()");
  const first = query(created.indexId, { view: "calls", limit: 1 });
  const next = query(created.indexId, { view: "calls", cursor: first.cursor, limit: 2 });
  assert.deepEqual([...first.rows, ...next.rows].map((row) => row.callee), ["first", "second", "third"]);
  assert.equal(next.hasMore, false);
  assert.throws(() => query(created.indexId, { view: "calls", query: "first", cursor: first.cursor }), { code: "CODE_INVALID_CURSOR" });
  assert.throws(() => query(created.indexId, { view: "calls", cursor: `${first.cursor}x` }), { code: "CODE_INVALID_CURSOR" });
  const another = await index("first()\nsecond()");
  assert.throws(() => query(another.indexId, { view: "calls", cursor: first.cursor }), { code: "CODE_INVALID_CURSOR" });
});

test("redacted source pages preserve lines and hide multiline literals, comments, credentials and numeric values", async () => {
  const { index, query } = fixture();
  const token = "IdentifierCredential";
  const source = `local IdentifierCredential = [=[first-secret\nsecond-secret]=]\n-- comment-secret\nconsume(IdentifierCredential, 123456789123456789)`;
  const created = await index(source, {}, { token });
  const rows = [];
  let cursor;
  do {
    const page = query(created.indexId, { view: "source", moduleId: "Main", limit: 1, cursor });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(rows.map((row) => row.line), [1, 2, 3, 4]);
  const displayed = JSON.stringify(rows) + JSON.stringify(query(created.indexId, { view: "calls" }));
  for (const secret of [token, "first-secret", "second-secret", "comment-secret", "123456789123456789"]) assert.equal(displayed.includes(secret), false);
  assert.equal(created.files[0].sha256, createHash("sha256").update(source).digest("hex"));
});

test("origins expand aliases only to the requested depth and stop at captured uncertainty", async () => {
  const { index, query } = fixture();
  const created = await index("local a = 1\nlocal b = a\nlocal c = b\nconsume(c)\nlocal function f() consume(c) end");
  const calls = query(created.indexId, { view: "calls", query: "consume" }).rows;
  const shallow = query(created.indexId, { view: "origins", callsiteId: calls[0].id, depth: 1 }).rows[0].arguments[0].origin;
  assert.equal(shallow.from.reason, "query-depth-limit");
  const deep = query(created.indexId, { view: "origins", callsiteId: calls[0].id, depth: 8 }).rows[0].arguments[0].origin;
  assert.equal(deep.from.from.from.literalType, "number");
  const captured = query(created.indexId, { view: "origins", callsiteId: calls[1].id, depth: 8 }).rows[0].arguments[0].origin;
  assert.equal(captured.reason, "captured-upvalue");
  assert.equal(captured.from, undefined);
});

test("remote callsites correlate exact retained logical paths and names without claiming live identity or runtime arity", async () => {
  const { index, query } = fixture();
  const source = `local channel = script.Parent.Send
local alias = channel
alias:FireServer("payload-secret", nil, expand())
script.Parent.Send.InvokeServer(script.Parent.Send, nil)
script.Parent.Send:FireClient(player, payload)
script.Parent.Send:FireAllClients()
script.Parent.Send:InvokeClient(player)
script.Parent.Other.Send:FireServer()
Send:FireServer()
Sender:FireServer()
script.Parent.Send:Destroy()
local function FireServer() end
FireServer()
local literal = "Send:FireServer('not-a-call')"
-- script.Parent.Send:InvokeServer("comment-secret")
`;
  const created = await index(source);
  const path = query(created.indexId, { view: "remote_callsites", remote: { logicalPath: "Root/Send" }, limit: 50 });
  assert.deepEqual(path.rows.map((row) => row.method), ["FireServer", "InvokeServer", "FireClient", "FireAllClients", "InvokeClient"]);
  assert.deepEqual(path.rows.map((row) => row.argumentExpressionCount), [3, 2, 2, 0, 1]);
  assert.equal(path.correlation, "static-candidates-only");
  assert.equal(path.execution, "not-executed");
  assert.equal(path.receiverIdentity, "unverified");
  assert.equal(path.completeness.semantic, "conservative");
  for (const row of path.rows) {
    assert.equal(row.matchKind, "static-logical-path");
    assert.equal(row.confidence, "inferred");
    assert.equal(row.receiverIdentity, "unverified");
    assert.equal(row.sha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(row.argumentsTruncated, false);
    assert(row.uncertainty.includes("runtime-arity-unverified"));
    assert(source.slice(row.span.start.offset, row.span.end.offset).includes(row.method));
  }
  const names = query(created.indexId, { view: "remote_callsites", remote: { name: "Send" }, limit: 50 });
  assert.equal(names.total, 7);
  assert(names.rows.every((row) => row.matchKind === "receiver-name-heuristic" && row.confidence === "heuristic"));
  assert.equal(names.rows.some((row) => source.slice(row.span.start.offset, row.span.end.offset).startsWith("Sender:")), false);
  const combined = query(created.indexId, { view: "remote_callsites", remote: { name: "Send", logicalPath: "Root/Send" }, limit: 50 });
  assert.equal(combined.total, 5, "an explicit path cannot broaden into unrelated same-name receivers");
  assert(combined.rows.every((row) => row.matchKind === "static-logical-path"));
  assert.equal(query(created.indexId, { view: "remote_callsites", remote: { name: "Other", logicalPath: "Root/Send" } }).total, 0);
  assert.equal(query(created.indexId, { view: "remote_callsites", remote: { logicalPath: "Root.Send" } }).total, 0);
  assert.equal(query(created.indexId, { view: "remote_callsites", remote: { logicalPath: "Root/Send/FireServer" } }).total, 0);
  const displayed = JSON.stringify(combined);
  for (const secret of ["payload-secret", "not-a-call", "comment-secret"]) assert.equal(displayed.includes(secret), false);
});

test("remote callsites preserve captured, dynamic, returned and branch uncertainty without crossing receiver members or lexical scopes", async () => {
  const { index, query } = fixture();
  const created = await index(`local Send = script.Parent.Send
do
  local Send = script.Parent.Other
  Send:FireServer()
end
local alias = Send
local function captured() alias:FireServer() end
local dynamic = channels[key]
dynamic:FireServer()
channels[key]:FireServer()
local returned = obtain()
returned:InvokeServer()
obtain().Send:FireServer()
local nameAlias = Remote
nameAlias:FireAllClients()
local nested = registry.Other
nested:InvokeClient()
if flag then Send = script.Parent.Other end
Send:FireServer()`);
  const candidates = (remote) => query(created.indexId, { view: "remote_callsites", remote, limit: 50 });
  assert.equal(candidates({ logicalPath: "Root/Send" }).total, 0);
  assert.equal(candidates({ logicalPath: "Root/Other" }).total, 1);
  for (const [name, reason] of [["alias", "captured-upvalue"], ["dynamic", "dynamic-member"], ["returned", "return-derived"]]) {
    const page = candidates({ name });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].matchKind, "receiver-name-heuristic");
    assert(page.rows[0].uncertainty.includes(reason));
  }
  const send = candidates({ name: "Send" });
  assert.equal(send.total, 2);
  assert(send.rows.some((row) => row.uncertainty.includes("return-derived")));
  assert(send.rows.some((row) => row.uncertainty.includes("branch-merge")));
  assert.equal(candidates({ name: "Remote" }).total, 1, "binding aliases retain the receiver's exact origin name");
  assert.equal(candidates({ name: "registry" }).total, 0, "an enclosing table name is not the receiver name");
  assert.equal(candidates({ name: "channels" }).total, 0, "dynamic indexing does not invent a receiver name");
});

test("remote callsite resolution reports bounded aliases and never equates truncated identifiers with exact names", async () => {
  const { index, query } = fixture();
  const prefix = "R".repeat(128);
  const chain = Array.from({ length: 10 }, (_, index) => `local alias${index} = ${index ? `alias${index - 1}` : "Remote"}`).join("\n");
  const created = await index(`${chain}\nalias9:FireServer()\n${prefix}Suffix:FireServer()\nRemote:FireServer(${Array.from({ length: 33 }, () => "nil").join(", ")})`);
  const bounded = query(created.indexId, { view: "remote_callsites", remote: { name: "alias9" } });
  assert.equal(bounded.total, 1);
  assert(bounded.rows[0].uncertainty.includes("receiver-resolution-limit"));
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.completeness.bounded, false);
  assert.equal(query(created.indexId, { view: "remote_callsites", remote: { name: prefix } }).total, 0);
  const remote = query(created.indexId, { view: "remote_callsites", remote: { name: "Remote" } });
  assert.equal(remote.total, 1, "a depth-limited alias chain cannot become an exact origin match");
  assert.equal(remote.rows[0].argumentExpressionCount, 33);
  assert.equal(remote.rows[0].argumentsTruncated, true);
  assert(remote.rows[0].uncertainty.includes("argument-list-truncated"));
});

test("remote selector cursors are immutable, session scoped, permission checked and fixed-expiry without reindexing", async () => {
  let parses = 0;
  const { service, clock, index, query } = fixture({ ttlMs: 100, parse: async (modules) => { parses += 1; return parseAuthoredModules(modules); } });
  const created = await index("", { modules: [
    { id: "Main", logicalPath: "Root/Main", source: "script.Parent.Send:FireServer()\nscript.Parent.Send:InvokeServer()\nscript.Parent.Send:FireAllClients()" },
    { id: "Other", logicalPath: "Other/Main", source: "script.Parent.Send:FireServer()" },
  ] });
  const selection = { view: "remote_callsites", moduleId: "Main", remote: { name: "Send", logicalPath: "Root/Send" } };
  const first = query(created.indexId, { ...selection, limit: 1 });
  const firstId = first.rows[0].callsiteId;
  first.rows[0].method = "mutated";
  const next = query(created.indexId, { ...selection, remote: { logicalPath: "Root/Send", name: "Send" }, cursor: first.cursor, limit: 2 });
  assert.deepEqual([firstId, ...next.rows.map((row) => row.callsiteId)], query(created.indexId, selection).rows.map((row) => row.callsiteId));
  assert.equal(query(created.indexId, selection).rows[0].method, "FireServer");
  assert.equal(next.hasMore, false);
  for (const changed of [{ remote: { name: "Send" } }, { remote: { name: "Other", logicalPath: "Root/Send" } }, { remote: { name: "Send", logicalPath: "Other/Send" } }, { moduleId: "Other" }]) {
    assert.throws(() => query(created.indexId, { ...selection, ...changed, cursor: first.cursor }), { code: "CODE_INVALID_CURSOR" });
  }
  assert.throws(() => query(created.indexId, { ...selection, scopeId: "b" }, () => assert.fail("foreign policy must not be consulted")), { code: "CODE_NOT_FOUND" });
  assert.throws(() => query(created.indexId, selection, () => false), { code: "CODE_ORIGIN_DENIED" });
  assert.throws(() => query(created.indexId, selection, () => Promise.resolve(true)), { code: "CODE_ORIGIN_DENIED" });
  clock.value += 99;
  assert.equal(query(created.indexId, selection).total, 3);
  clock.value += 1;
  assert.throws(() => query(created.indexId, selection), { code: "CODE_NOT_FOUND" });
  const released = await index("Send:FireServer()");
  service.releaseScope("a");
  assert.throws(() => query(released.indexId, { view: "remote_callsites", remote: { name: "Send" } }), { code: "CODE_NOT_FOUND" });
  assert.equal(parses, 2);
});

test("remote callsite selectors never echo credentials and reject unrelated or malformed selections", async () => {
  const { index, query } = fixture();
  const token = "IdentifierCredential";
  const created = await index(`script.Parent.IdentifierCredential:FireServer("literal-secret", 123456789)\nscript.Parent.IdentifierCredential:InvokeServer()`, {}, { token });
  const remote = { name: token, logicalPath: `Root/${token}` };
  const first = query(created.indexId, { view: "remote_callsites", remote, limit: 1 });
  const second = query(created.indexId, { view: "remote_callsites", remote, cursor: first.cursor, limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(second.rows[0].method, "InvokeServer");
  for (const secret of [token, "literal-secret", "123456789"]) assert.equal(JSON.stringify([first, second]).includes(secret), false);
  const hiddenName = await index("IdentifierCredential:FireServer()", {}, { token });
  assert.equal(query(hiddenName.indexId, { view: "remote_callsites", remote: { name: "[REDACTED]" } }).total, 0, "a redaction marker is not an exact receiver identifier");
  const hiddenMethod = await index("script.Parent.Send:FireServer()", {}, { token: "FireServer" });
  assert.equal(query(hiddenMethod.indexId, { view: "remote_callsites", remote: { logicalPath: "Root/Send" } }).total, 0);
  for (const remote of [undefined, null, {}, [], { extra: "secret" }, { name: "" }, { name: "x".repeat(257) }, { logicalPath: "Root/../Send" }, { logicalPath: "Root//Send" }, { logicalPath: "Root\\Send" }, { logicalPath: "instance://secret" }, { name: "secret\n" }]) {
    assert.throws(() => query(created.indexId, { view: "remote_callsites", remote }), { code: "CODE_INVALID_INPUT" });
  }
  for (const options of [{ view: "calls", remote }, { view: "remote_callsites", remote, query: "secret" }, { view: "remote_callsites", remote, callsiteId: first.rows[0].callsiteId }]) {
    assert.throws(() => query(created.indexId, options), { code: "CODE_INVALID_INPUT" });
  }
});

test("TTL does not slide and aggregate entry capacity evicts oldest indexes across scopes", async () => {
  const { index, query, clock } = fixture({ ttlMs: 100, maxIndexes: 2 });
  const first = await index("first()");
  const second = await index("second()", { scopeId: "b" });
  query(first.indexId);
  const third = await index("third()");
  assert.throws(() => query(first.indexId), { code: "CODE_NOT_FOUND" });
  assert.equal(query(second.indexId, { scopeId: "b" }).indexId, second.indexId);
  clock.value += 99;
  query(third.indexId);
  clock.value += 1;
  assert.throws(() => query(third.indexId), { code: "CODE_NOT_FOUND" });
});

test("scope release fences an in-flight parse so it cannot resurrect closed session data", async () => {
  let finish;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const { service, index } = fixture({ parse: async (modules) => { const result = await parseAuthoredModules(modules); began(); return new Promise((resolve) => { finish = () => resolve(result); }); } });
  const pending = index("consume()");
  await started;
  service.releaseScope("a");
  finish();
  await assert.rejects(pending, { code: "CODE_CANCELLED" });
});

test("malformed intake and hash mismatches fail before parser admission", async () => {
  const { index } = fixture({ parse: () => assert.fail("invalid source must not reach parser") });
  await assert.rejects(index("x".repeat(CODE_INDEX_LIMITS.maxFileBytes + 1)), { code: "CODE_SOURCE_TOO_LARGE" });
  await assert.rejects(index("\ud800"), { code: "CODE_INVALID_INPUT" });
  await assert.rejects(index("", { modules: [{ id: "A", source: "", sha256: "0".repeat(64) }] }), { code: "CODE_HASH_MISMATCH" });
  await assert.rejects(index("", { modules: [{ id: "A", source: "" }, { id: "A", source: "" }] }), { code: "CODE_INVALID_INPUT" });
  await assert.rejects(index("", { modules: [{ id: "A", logicalPath: "Root/../A", source: "" }] }), { code: "CODE_INVALID_INPUT" });
  await assert.rejects(index("", { modules: [{ id: "A", source: "", root: "owned", path: "a.luau" }] }), { code: "CODE_INVALID_INPUT" });
});

test("configured-source intake reads only explicit allowed UTF-8 files and honors root extension and recursion limits", async (t) => {
  const { root, config } = await sourceRoot(t);
  await writeFile(join(root, "module.luau"), "local a = 1\nconsume(a)");
  await writeFile(join(root, "module.lua"), "consume()");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "module.luau"), "nested()");
  const { service, query } = fixture();
  const request = (path, rootName = "owned") => ({ scopeId: "a", modules: [{ id: "A", logicalPath: "Root/A", root: rootName, path }] });
  const created = await service.index(request("module.luau"), config);
  assert.deepEqual(query(created.indexId, { view: "calls" }).rows.map((row) => row.callee), ["consume"]);
  for (const path of ["../module.luau", "module.luau:stream", "module.lua", "nested/module.luau", "/module.luau", "module.luau.", "CON.luau"]) await assert.rejects(service.index(request(path), config), { code: "CODE_SOURCE_DENIED" });
  await assert.rejects(service.index(request("module.luau", "unknown"), config), { code: "CODE_SOURCE_DENIED" });
  const recursive = { sourceRoots: [{ ...config.sourceRoots[0], recursive: true }] };
  const nested = await service.index(request("nested/module.luau"), recursive);
  assert.equal(query(nested.indexId, { view: "calls" }).rows[0].callee, "nested");
});

test("junction or symlink redirection is rejected even when its destination is another allowed file", async (t) => {
  const { directory, root, config } = await sourceRoot(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "module.luau"), "hidden()");
  await symlink(outside, join(root, "redirect"), process.platform === "win32" ? "junction" : "dir");
  const { service } = fixture();
  await assert.rejects(service.index({ scopeId: "a", modules: [{ id: "A", root: "owned", path: "redirect/module.luau" }] }, { sourceRoots: [{ ...config.sourceRoots[0], recursive: true }] }), { code: "CODE_SOURCE_IDENTITY" });
});

test("opened-file version changes are rejected rather than indexing a mixed source snapshot", async (t) => {
  const { root, config } = await sourceRoot(t);
  const target = join(root, "module.luau");
  await writeFile(target, "first()");
  const { service } = fixture({ io: { open: async (...args) => {
    const handle = await openFile(...args);
    return {
      stat: (...values) => handle.stat(...values),
      close: () => handle.close(),
      read: async (...values) => { const result = await handle.read(...values); await writeFile(target, "changedAfterRead()"); return result; },
    };
  } } });
  await assert.rejects(service.index({ scopeId: "a", modules: [{ id: "A", root: "owned", path: "module.luau" }] }, config), { code: "CODE_SOURCE_IDENTITY" });
});

test("parse errors keep diagnostics but cannot expose recovered source through display queries", async () => {
  const { index, query } = fixture();
  const created = await index("local value = 'unterminated-secret");
  assert.equal(created.completeness.syntax, false);
  assert.equal(query(created.indexId, { view: "calls" }).rows.length, 0);
  assert.throws(() => query(created.indexId, { view: "source", moduleId: "Main" }), { code: "CODE_SOURCE_DISPLAY_UNAVAILABLE" });
});

test("unstoreable indexes and identifier collisions cannot evict an existing usable index", async () => {
  const limited = fixture({ maxSourceBytes: 10 });
  const first = await limited.index("one()");
  await assert.rejects(limited.index("aLongerFunction()"), { code: "CODE_STORE_CAPACITY" });
  assert.equal(limited.query(first.indexId, { view: "calls" }).rows[0].callee, "one");
  const colliding = fixture({ randomBytes: (size) => Buffer.alloc(size, 7) });
  const original = await colliding.index("original()");
  await assert.rejects(colliding.index("replacement()"), { code: "CODE_STORE_CAPACITY" });
  assert.equal(colliding.query(original.indexId, { view: "calls" }).rows[0].callee, "original");
});

test("foreign parser fact identities fail closed before source retention", async () => {
  const { index } = fixture({ parse: async (modules) => {
    const result = await parseAuthoredModules(modules);
    result.facts.calls[0].sha256 = "0".repeat(64);
    return result;
  } });
  await assert.rejects(index("consume()"), { code: "CODE_PARSE_RESULT_INVALID" });
});

test("source hash preserves the original UTF-8 BOM rather than hashing a silently normalized file", async (t) => {
  const { root, config } = await sourceRoot(t);
  const bytes = Buffer.from("\ufeffconsume()");
  await writeFile(join(root, "bom.luau"), bytes);
  const { service } = fixture();
  const result = await service.index({ scopeId: "a", modules: [{ id: "A", root: "owned", path: "bom.luau", sha256: createHash("sha256").update(bytes).digest("hex") }] }, config);
  assert.equal(result.files[0].sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.files[0].bytes, bytes.length);
});

test("function query names never copy literals or comments from assignment targets and declarations", async () => {
  const { index, query } = fixture();
  const created = await index(`registry["private-key"] = function() end
registry[selectKey("dynamic-secret")] = function() end
obtain("receiver-secret").callback = function() end
registry[123456789123456789] = function() end
function registry -- declaration-secret
  .safe() end
local ordinary = function() end`);
  const page = query(created.indexId, { view: "functions", limit: 50 });
  assert.equal(page.rows.length, 6);
  const displayed = JSON.stringify(page);
  for (const secret of ["private-key", "dynamic-secret", "receiver-secret", "123456789123456789", "declaration-secret"]) assert.equal(displayed.includes(secret), false);
  assert.ok(page.rows.some((row) => row.name === "registry.safe"));
  assert.ok(page.rows.some((row) => row.name === "ordinary"));
});

test("configured credentials are redacted from function parameter arrays", async () => {
  const { index, query } = fixture();
  const token = "IdentifierCredential";
  const created = await index("local function f(IdentifierCredential, ordinary) end", {}, { token });
  const page = query(created.indexId, { view: "functions" });
  assert.equal(JSON.stringify(page).includes(token), false);
  assert.equal(page.rows[0].parameters[1], "ordinary");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createNativeEditorClient,
  NativeEditorError,
  NATIVE_EDITOR_MAX_CONTENT_BYTES,
  NATIVE_EDITOR_MAX_WIRE_BYTES,
} from "../src/native-editor.js";

const token = "editor-test-bearer-".repeat(3);
const privatePath = "C:\\private-editor-store\\bearer.txt";
const source = "-- private source\r\nprint('日本語 🙂')\nlocal code = \"keep this field\"\n";
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const info = (id, properties = {}) => ({ id, title: "Draft", kind: "script", dirty: false, active: true, pinned: false, ...properties });
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
const rpc = (id, result) => json({ jsonrpc: "2.0", id, result });
const result = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const turn = () => new Promise((resolve) => setImmediate(resolve));

function clientWith(fetch, options = {}) {
  return createNativeEditorClient({ tokenFile: privatePath, readToken: async () => `${token}\n`, fetch, ...options });
}

function nativeFixture({ content = source, structured = false, sse = false, onCall, tools = [{ name: "tabs" }] } = {}) {
  const tabs = new Map([["one", { tab: info("one"), content }]]);
  const calls = [];
  const requests = [];
  let nextId = 2;
  const fetch = async (url, init) => {
    assert.equal(url, "http://127.0.0.1:8225/mcp");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    const request = JSON.parse(init.body);
    requests.push(request);
    let reply;
    if (request.method === "initialize") reply = { protocolVersion: "2025-06-18" };
    else if (request.method === "tools/list") reply = { tools };
    else {
      assert.equal(request.method, "tools/call");
      assert.equal(request.params.name, "tabs");
      const args = request.params.arguments;
      calls.push(args);
      const custom = await onCall?.({ args, request, tabs, init });
      if (custom !== undefined) return custom;
      const current = tabs.get(args.id);
      let payload;
      if (args.action === "list") payload = { message: "listed", tabs: [...tabs.values()].map(({ tab }) => ({ ...tab, content: source, arbitrary: token })), content: source };
      else if (args.action === "open") {
        for (const value of tabs.values()) value.tab.active = false;
        const tab = info(String(nextId++), { title: args.title ?? "Draft", dirty: Boolean(args.content) });
        tabs.set(tab.id, { tab, content: args.content ?? "" });
        payload = { message: "opened", tab, content: args.content ?? "" };
      } else if (!current) {
        reply = { isError: true, content: [{ type: "text", text: `missing tab ${args.id}; ${token}; ${source}` }] };
      } else if (args.action === "read") payload = { message: "read", tab: current.tab, content: current.content };
      else if (args.action === "write") {
        current.content = args.content;
        current.tab.dirty = true;
        payload = { message: "written", tab: current.tab, content: args.content };
      } else if (args.action === "activate") {
        for (const value of tabs.values()) value.tab.active = false;
        current.tab.active = true;
        payload = { message: "activated", tab: current.tab };
      } else if (args.action === "close") {
        if (current.tab.dirty) reply = { isError: true, content: [{ type: "text", text: `refusing dirty tab; ${source}; ${token}` }] };
        else {
          tabs.delete(args.id);
          payload = { message: "closed" };
        }
      } else assert.fail("unsupported native action");
      if (payload) reply = structured ? { structuredContent: payload, content: [] } : result(payload);
    }
    if (sse) return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: reply })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return rpc(request.id, reply);
  };
  return { fetch, calls, requests, tabs };
}

function hasCode(code) {
  return (error) => {
    assert.ok(error instanceof NativeEditorError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes(token), false);
    assert.equal(String(error.stack).includes(privatePath), false);
    assert.equal(String(error.stack).includes(source), false);
    return true;
  };
}

test("editor returns whitelisted metadata and exact UTF8 source/hash across all six methods", async () => {
  const native = nativeFixture();
  const editor = clientWith(native.fetch);
  assert.deepEqual(await editor.listTabs(), { tabs: [info("one")] });
  assert.deepEqual(await editor.readTab({ id: "one" }), { tab: info("one"), content: source, sha256: digest(source) });
  const opened = await editor.openTab({ title: "Unicode draft", content: "print('draft')" });
  assert.deepEqual(opened, { tab: info("2", { title: "Unicode draft", dirty: true }) });
  assert.deepEqual(await editor.activateTab({ id: "one" }), { tab: info("one") });
  const written = await editor.writeTab({ id: "one", content: "replacement\r\n🙂", expectedSha256: digest(source) });
  assert.deepEqual(written, { tab: info("one", { dirty: true }), sha256: digest("replacement\r\n🙂"), preconditionAtomic: false });
  assert.equal(JSON.stringify(written).includes("replacement"), false);
  assert.equal(native.tabs.get("one").content, "replacement\r\n🙂");
  const clean = await editor.openTab();
  assert.deepEqual(await editor.closeTab({ id: clean.tab.id }), { id: clean.tab.id, closed: true });
  assert.equal(native.tabs.has(clean.tab.id), false);
  assert.deepEqual(native.calls.find(({ action }) => action === "write"), { action: "write", id: "one", content: "replacement\r\n🙂" });
});

test("editor accepts structured and SSE native results without altering source", async () => {
  for (const options of [{ structured: true }, { sse: true }]) {
    const native = nativeFixture(options);
    const read = await clientWith(native.fetch).readTab({ id: "one" });
    assert.equal(read.content, source);
    assert.equal(read.sha256, digest(source));
  }
});

test("editor enforces exact UTF8 byte limits while allowing worst-case JSON escaping", async () => {
  const escaped = "\u0000".repeat(NATIVE_EDITOR_MAX_CONTENT_BYTES);
  const native = nativeFixture({ content: escaped });
  const editor = clientWith(native.fetch);
  assert.equal((await editor.readTab({ id: "one" })).sha256, digest(escaped));
  await editor.writeTab({ id: "one", content: escaped, expectedSha256: digest(escaped) });
  assert.equal(native.tabs.get("one").content, escaped);
  const multibyte = "🙂".repeat(NATIVE_EDITOR_MAX_CONTENT_BYTES / 4);
  await editor.openTab({ content: multibyte });
  const calls = native.calls.length;
  await assert.rejects(editor.openTab({ content: `${multibyte}x` }), hasCode("too-large"));
  await assert.rejects(editor.writeTab({ id: "one", content: `${multibyte}x`, expectedSha256: digest(escaped) }), hasCode("too-large"));
  assert.equal(native.calls.length, calls);
});

test("editor refuses malformed arguments and requires a lowercase hash before dispatch", async () => {
  let dispatched = 0;
  const editor = clientWith(async () => { dispatched++; throw new Error("unexpected dispatch"); });
  for (const args of [undefined, { id: "" }, { id: "x".repeat(257) }, { id: "one", unknown: true }]) {
    await assert.rejects(editor.readTab(args), hasCode("refused"));
  }
  for (const expectedSha256 of [undefined, "", digest(source).toUpperCase(), "0".repeat(63)]) {
    await assert.rejects(editor.writeTab({ id: "one", content: "new", expectedSha256 }), hasCode("refused"));
  }
  await assert.rejects(editor.openTab({ title: "x".repeat(1025) }), hasCode("refused"));
  await assert.rejects(editor.openTab({ content: null }), hasCode("refused"));
  assert.equal(dispatched, 0);
});

test("editor hash conflicts do not dispatch a write or echo source", async () => {
  const native = nativeFixture();
  const editor = clientWith(native.fetch);
  await assert.rejects(editor.writeTab({ id: "one", content: "new", expectedSha256: digest("stale") }), hasCode("conflict"));
  assert.deepEqual(native.calls.map(({ action }) => action), ["read"]);
  assert.equal(native.tabs.get("one").content, source);
});

test("shared editor service serializes competing writers and releases failed queue entries", async () => {
  let releaseRead;
  let firstRead;
  const readStarted = new Promise((resolve) => { firstRead = resolve; });
  const blocked = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  const native = nativeFixture({ onCall: async ({ args }) => {
    if (args.action === "read" && reads++ === 0) {
      firstRead();
      await blocked;
    }
  } });
  const editor = clientWith(native.fetch);
  const first = editor.writeTab({ id: "one", content: "first", expectedSha256: digest(source) });
  await readStarted;
  const second = editor.writeTab({ id: "one", content: "second", expectedSha256: digest(source) });
  const secondFailure = assert.rejects(second, hasCode("conflict"));
  const queuedRead = editor.readTab({ id: "one" });
  await turn();
  assert.deepEqual(native.calls.map(({ action }) => action), ["read"]);
  releaseRead();
  await first;
  await secondFailure;
  assert.equal((await queuedRead).content, "first");
  assert.equal(native.tabs.get("one").content, "first");
  assert.deepEqual(native.calls.map(({ action }) => action), ["read", "write", "read", "read"]);
  await editor.writeTab({ id: "one", content: "third", expectedSha256: digest("first") });
  assert.equal((await editor.readTab({ id: "one" })).content, "third");
});

test("cancelled queued writes preserve the predecessor barrier and never modify the tab", async () => {
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  let reads = 0;
  const native = nativeFixture({ onCall: async ({ args }) => {
    if (args.action === "read" && reads++ === 0) { started(); await blocked; }
  } });
  const editor = clientWith(native.fetch);
  const first = editor.readTab({ id: "one" });
  await reading;
  const controller = new AbortController();
  const cancelled = editor.writeTab({ id: "one", content: "must not be written", expectedSha256: digest(source) }, { signal: controller.signal });
  const rejection = assert.rejects(cancelled, hasCode("cancelled"));
  controller.abort(new Error(`${token} ${source}`));
  const following = editor.readTab({ id: "one" });
  await turn();
  assert.deepEqual(native.calls.map(({ action }) => action), ["read"]);
  release();
  await first;
  await rejection;
  assert.equal((await following).content, source);
  assert.equal(native.tabs.get("one").content, source);
  assert.deepEqual(native.calls.map(({ action }) => action), ["read", "read"]);
  await editor.writeTab({ id: "one", content: "later authorized edit", expectedSha256: digest(source) });
  assert.equal(native.tabs.get("one").content, "later authorized edit");
});

test("cancellation during write preflight aborts native HTTP without dispatching the mutation", async () => {
  let release;
  let started;
  let nativeSignal;
  const blocked = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  const native = nativeFixture({ onCall: async ({ args, init }) => {
    if (args.action === "read") { nativeSignal = init.signal; started(); await blocked; }
  } });
  const controller = new AbortController();
  const editor = clientWith(native.fetch);
  const pending = editor.writeTab({ id: "one", content: "must not be written", expectedSha256: digest(source) }, { signal: controller.signal });
  await reading;
  controller.abort(new Error(`${token} ${source}`));
  await assert.rejects(pending, hasCode("cancelled"));
  assert.equal(nativeSignal.aborted, true);
  release();
  await turn();
  assert.deepEqual(native.calls.map(({ action }) => action), ["read"]);
  assert.equal(native.tabs.get("one").content, source);
});

test("already-cancelled work never dispatches and cancellation after mutation dispatch is indeterminate", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  let attempts = 0;
  const inactive = clientWith(async () => { attempts++; assert.fail("must not dispatch"); });
  await assert.rejects(inactive.openTab({ content: source }, { signal: cancelled.signal }), hasCode("cancelled"));
  await assert.rejects(inactive.writeTab({ id: "one", content: "new", expectedSha256: digest(source) }, { signal: cancelled.signal }), hasCode("cancelled"));
  assert.equal(attempts, 0);

  let release;
  let started;
  let nativeSignal;
  const blocked = new Promise((resolve) => { release = resolve; });
  const dispatch = new Promise((resolve) => { started = resolve; });
  const native = nativeFixture({ onCall: async ({ init }) => { nativeSignal = init.signal; started(); await blocked; } });
  const controller = new AbortController();
  const pending = clientWith(native.fetch).activateTab({ id: "one" }, { signal: controller.signal });
  await dispatch;
  controller.abort(new Error(`${token} ${source}`));
  await assert.rejects(pending, hasCode("indeterminate"));
  assert.equal(nativeSignal.aborted, true);
  release();
  await turn();
  assert.equal(native.calls.length, 1);
});

test("different tabs are not blocked by another tab's pending read", async () => {
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  const native = nativeFixture({ onCall: async ({ args }) => {
    if (args.action === "read" && args.id === "one") { started(); await pending; }
  } });
  native.tabs.set("two", { tab: info("two"), content: "second tab" });
  const editor = clientWith(native.fetch);
  const first = editor.readTab({ id: "one" });
  await reading;
  assert.equal((await editor.readTab({ id: "two" })).content, "second tab");
  release();
  await first;
});

test("native dirty-close and missing-tab refusals never become successful receipts", async () => {
  const native = nativeFixture();
  native.tabs.get("one").tab.dirty = true;
  const editor = clientWith(native.fetch);
  await assert.rejects(editor.closeTab({ id: "one" }), hasCode("refused"));
  assert.equal(native.tabs.has("one"), true);
  await assert.rejects(editor.readTab({ id: "missing" }), hasCode("refused"));
  await assert.rejects(editor.activateTab({ id: "missing" }), hasCode("refused"));
  native.tabs.get("one").tab.dirty = false;
  assert.deepEqual(await editor.closeTab({ id: "one" }), { id: "one", closed: true });
});

test("native capability checks are lazy, missing tabs/offline/token failures are safe", async () => {
  let attempts = 0;
  const offline = clientWith(async () => { attempts++; throw new Error(`${privatePath} ${token} ${source}`); });
  assert.equal(attempts, 0);
  await assert.rejects(offline.listTabs(), hasCode("unavailable"));
  await assert.rejects(offline.openTab({ content: source }), hasCode("unavailable"));
  assert.equal(attempts, 2);
  const absent = nativeFixture({ tools: [{ name: "execute_script" }] });
  await assert.rejects(clientWith(absent.fetch).listTabs(), hasCode("unavailable"));
  assert.deepEqual(absent.calls, []);
  const invalid = clientWith(async () => assert.fail("must not dispatch"), { readToken: async () => "not a bearer" });
  await assert.rejects(invalid.listTabs(), hasCode("unavailable"));
  const unreadable = clientWith(async () => assert.fail("must not dispatch"), { readToken: async () => { throw new Error(privatePath); } });
  await assert.rejects(unreadable.listTabs(), hasCode("unavailable"));
  assert.throws(() => clientWith(async () => {}, { url: "http://localhost:8225/mcp" }), hasCode("unavailable"));
});

test("malformed or stale native responses cannot leak bodies or identify another tab", async () => {
  const malformed = [
    () => new Response(`${token} ${source}`, { headers: { "content-type": "application/json" } }),
    ({ request }) => rpc(request.id + 1, result({ message: token, tabs: [] })),
    ({ request }) => rpc(request.id, result({ message: token, tab: info("wrong"), content: source })),
    ({ request }) => rpc(request.id, result({ message: token, tab: info("one", { dirty: "false" }), content: source })),
    ({ request }) => rpc(request.id, { content: [{ type: "image", data: token }] }),
    ({ request }) => rpc(request.id, result({ tab: info("one"), content: source })),
  ];
  for (const onCall of malformed) {
    const native = nativeFixture({ onCall });
    await assert.rejects(clientWith(native.fetch).readTab({ id: "one" }), hasCode("unavailable"));
  }
  const invalidUtf8 = nativeFixture({ onCall: () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(clientWith(invalidUtf8.fetch).readTab({ id: "one" }), hasCode("unavailable"));
});

test("native wire, content, tab-count and metadata limits are enforced", async () => {
  for (const onCall of [
    () => new Response("x".repeat(NATIVE_EDITOR_MAX_WIRE_BYTES + 1), { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(NATIVE_EDITOR_MAX_WIRE_BYTES + 1) } }),
  ]) {
    await assert.rejects(clientWith(nativeFixture({ onCall }).fetch).listTabs(), hasCode("too-large"));
  }
  const oversizeContent = nativeFixture({ content: "x".repeat(NATIVE_EDITOR_MAX_CONTENT_BYTES + 1) });
  await assert.rejects(clientWith(oversizeContent.fetch).readTab({ id: "one" }), hasCode("too-large"));
  const tooMany = nativeFixture({ onCall: ({ request }) => rpc(request.id, result({ message: "listed", tabs: Array.from({ length: 513 }, (_, index) => info(String(index))) })) });
  await assert.rejects(clientWith(tooMany.fetch).listTabs(), hasCode("too-large"));
  for (const properties of [{ title: "x".repeat(1025) }, { kind: "x".repeat(65) }, { path: "x".repeat(4097) }, { id: "x".repeat(257) }]) {
    const native = nativeFixture({ onCall: ({ request }) => rpc(request.id, result({ message: "listed", tabs: [info("one", properties)] })) });
    await assert.rejects(clientWith(native.fetch).listTabs(), hasCode("unavailable"));
  }
});

test("native token reflection is refused without changing intentional script content", async () => {
  const leakedContent = nativeFixture({ content: `${source}\n${token}` });
  await assert.rejects(clientWith(leakedContent.fetch).readTab({ id: "one" }), hasCode("unavailable"));
  const leakedMetadata = nativeFixture({ onCall: ({ request }) => rpc(request.id, result({ message: "listed", tabs: [info("one", { title: token })] })) });
  await assert.rejects(clientWith(leakedMetadata.fetch).listTabs(), hasCode("unavailable"));
  const intentional = `${privatePath}\nlocal source = 'not redacted'; local code = 'unchanged'`;
  const native = nativeFixture({ content: intentional });
  const read = await clientWith(native.fetch).readTab({ id: "one" });
  assert.equal(read.content, intentional);
  assert.equal(read.sha256, digest(intentional));
});

test("editor refuses native credentials in mutation strings without dispatching a mutation", async () => {
  const native = nativeFixture();
  const editor = clientWith(native.fetch);
  await assert.rejects(editor.openTab({ content: `local credential = '${token}'` }), hasCode("refused"));
  await assert.rejects(editor.openTab({ title: token }), hasCode("refused"));
  await assert.rejects(editor.writeTab({ id: "one", content: token, expectedSha256: digest(source) }), hasCode("refused"));
  await assert.rejects(editor.activateTab({ id: token }), hasCode("refused"));
  await assert.rejects(editor.closeTab({ id: token }), hasCode("refused"));
  assert.deepEqual(native.calls.map(({ action }) => action), ["read"]);
  assert.equal(native.tabs.get("one").content, source);
});

test("ambiguous mutation responses are indeterminate, not replayed or echoed", async () => {
  for (const onCall of [
    () => { throw new Error(`${source} ${token} ${privatePath}`); },
    ({ request }) => rpc(request.id + 1, result({ message: "opened", tab: info("new") })),
    ({ request }) => rpc(request.id, result({ message: "opened", tab: { id: "new" } })),
    ({ request }) => rpc(request.id, { isError: true }),
    ({ request }) => rpc(request.id, { isError: true, content: "malformed native error" }),
    ({ request }) => json({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: `${source} ${token}` } }),
    () => new Response("private failure", { status: 500 }),
    () => new Response("x".repeat(NATIVE_EDITOR_MAX_WIRE_BYTES + 1), { headers: { "content-type": "application/json" } }),
  ]) {
    const native = nativeFixture({ onCall });
    await assert.rejects(clientWith(native.fetch).openTab({ content: source }), hasCode("indeterminate"));
    assert.equal(native.calls.length, 1);
  }
  const stale = nativeFixture({ onCall: ({ args, request }) => args.action === "write"
    ? rpc(request.id, result({ message: "written", tab: info("wrong"), content: "different" })) : undefined });
  await assert.rejects(clientWith(stale.fetch).writeTab({ id: "one", content: "new", expectedSha256: digest(source) }), hasCode("indeterminate"));
});

test("mutation deadline discards late receipts even when fetch ignores abort", async () => {
  let expire;
  let finish;
  let started;
  const calling = new Promise((resolve) => { started = resolve; });
  const native = nativeFixture({ onCall: ({ args }) => {
    if (args.action === "open") { started(); return new Promise((resolve) => { finish = resolve; }); }
  } });
  const editor = clientWith(native.fetch, {
    clock: { setTimeout(callback, milliseconds) { assert.equal(milliseconds, 3000); expire = callback; return 1; }, clearTimeout() {} },
  });
  const pending = editor.openTab({ content: source });
  await calling;
  expire();
  await assert.rejects(pending, hasCode("indeterminate"));
  finish(rpc(native.requests.at(-1).id, result({ message: "opened", tab: info("late") })));
  await turn();
  assert.equal(native.calls.length, 1);
  assert.equal((await editor.listTabs()).tabs[0].id, "one");
});

test("mutation body failures and stalled reads retain safe outcome classification", async () => {
  const failing = nativeFixture({ onCall: () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(`${token} ${privatePath} ${source}`)); },
  }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(clientWith(failing.fetch).activateTab({ id: "one" }), hasCode("indeterminate"));
  let expire;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const stalled = nativeFixture({ onCall: () => new Response(new ReadableStream({ pull() { started(); } }), { headers: { "content-type": "application/json" } }) });
  const editor = clientWith(stalled.fetch, { clock: { setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {} } });
  const pending = editor.readTab({ id: "one" });
  await reading;
  expire();
  await assert.rejects(pending, hasCode("unavailable"));
});

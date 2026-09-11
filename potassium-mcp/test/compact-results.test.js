import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCompactResultStore } from "../src/compact-results.js";

function fixture(options = {}) {
  const clock = { value: 1_700_000_000_000, now() { return this.value; } };
  let sequence = 0;
  const randomBytes = (size) => {
    const value = Buffer.alloc(size);
    value.writeUInt32BE(++sequence);
    return value;
  };
  const store = createCompactResultStore({ clock, randomBytes, ...options });
  const put = (json, scopeId = "session-a") => store.put({ scopeId, toolName: "potassium_trace_query", json });
  const read = (resultId, options = {}, allowed = () => true) => store.read({ scopeId: "session-a", resultId, ...options }, allowed);
  return { clock, store, put, read };
}

function envelope(page) {
  return JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: page });
}

test("retention overrides cannot raise memory or lifetime ceilings", () => {
  assert.throws(() => createCompactResultStore({ maxEntries: 65 }), { code: "RESULT_INVALID_INPUT" });
  assert.throws(() => createCompactResultStore({ maxBytes: 8388609 }), { code: "RESULT_INVALID_INPUT" });
  assert.throws(() => createCompactResultStore({ maxEntryBytes: 1048577 }), { code: "RESULT_INVALID_INPUT" });
  assert.throws(() => createCompactResultStore({ ttlMs: 120001 }), { code: "RESULT_INVALID_INPUT" });
});

test("compact reads isolate scopes and recheck the originating capability on every page", () => {
  const { put, read } = fixture();
  const result = put('{"text":"private result"}');
  assert.throws(() => read(result.resultId, { scopeId: "session-b" }, () => {
    assert.fail("foreign records must not expose their originating tool to policy callbacks");
  }), { code: "RESULT_NOT_FOUND" });
  assert.throws(() => read("f".repeat(32)), { code: "RESULT_NOT_FOUND" });
  assert.throws(() => read(result.resultId, {}, (toolName) => toolName === "potassium_result_read"), { code: "RESULT_ORIGIN_DENIED" });
  const first = read(result.resultId, { view: "text", maxBytes: 8 }, (toolName) => toolName === "potassium_trace_query");
  assert.equal(first.text, '{"text":');
  assert.throws(() => read(result.resultId, { offsetBytes: first.nextOffsetBytes }, () => false), { code: "RESULT_ORIGIN_DENIED" });
  assert.throws(() => read(result.resultId, {}, () => Promise.resolve(true)), { code: "RESULT_ORIGIN_DENIED" });
});

test("TTL expires exactly at its boundary without being extended by reads", () => {
  const { clock, put, read } = fixture({ ttlMs: 100 });
  const result = put('{"ok":true}');
  clock.value += 99;
  assert.deepEqual(read(result.resultId).selections[0].value, { ok: true });
  clock.value += 1;
  assert.throws(() => read(result.resultId), { code: "RESULT_NOT_FOUND" });
  const replacement = put('{"ok":false}');
  assert.deepEqual(read(replacement.resultId).selections[0].value, { ok: false });
});

test("entry capacity is global across scopes and evicts oldest insertion rather than most recently read", () => {
  const { put, read } = fixture({ maxEntries: 2 });
  const first = put('"first"');
  const second = put('"second"', "session-b");
  assert.equal(read(first.resultId).selections[0].value, "first");
  const third = put('"third"', "session-c");
  assert.throws(() => read(first.resultId), { code: "RESULT_NOT_FOUND" });
  assert.equal(read(second.resultId, { scopeId: "session-b" }).selections[0].value, "second");
  assert.equal(read(third.resultId, { scopeId: "session-c" }).selections[0].value, "third");
});

test("byte capacity counts UTF-8 bytes and rejects unstoreable input without evicting valid records", () => {
  const { put, read, store } = fixture({ maxBytes: 14, maxEntryBytes: 14 });
  const first = put('"€€"');
  const second = put('"éé"', "session-b");
  assert.equal(read(first.resultId).selections[0].value, "€€");
  assert.throws(() => put('"€€€€€"'), { code: "RESULT_TOO_LARGE" });
  assert.throws(() => put('{"bad":'), { code: "RESULT_INVALID_JSON" });
  assert.equal(read(first.resultId).selections[0].value, "€€");
  assert.equal(read(second.resultId, { scopeId: "session-b" }).selections[0].value, "éé");
  const third = put('"x"');
  assert.throws(() => read(first.resultId), { code: "RESULT_NOT_FOUND" });
  store.releaseScope("session-b");
  assert.throws(() => read(second.resultId, { scopeId: "session-b" }), { code: "RESULT_NOT_FOUND" });
  const fourth = put('"€€"');
  assert.equal(read(third.resultId).selections[0].value, "x");
  assert.equal(read(fourth.resultId).selections[0].value, "€€");
  store.clear();
  assert.throws(() => read(third.resultId), { code: "RESULT_NOT_FOUND" });
  assert.throws(() => read(fourth.resultId), { code: "RESULT_NOT_FOUND" });
});

test("random-source collisions fail closed instead of replacing an existing scoped result", () => {
  const { put, read } = fixture({ randomBytes: (size) => Buffer.alloc(size, 7) });
  const first = put('{"keep":true}');
  assert.throws(() => put('{"overwrite":true}', "session-b"), { code: "RESULT_STORE_CAPACITY" });
  assert.deepEqual(read(first.resultId).selections[0].value, { keep: true });
});

test("pages reconstruct immutable JSON and fit the escaped complete MCP envelope", () => {
  const { put, read } = fixture();
  const json = JSON.stringify({ text: '\\"\n\u0001€😀'.repeat(2000) });
  const result = put(json);
  let offsetBytes = 0;
  let restored = "";
  do {
    const page = read(result.resultId, { view: "text", offsetBytes, maxBytes: 4096 });
    assert.ok(Buffer.byteLength(envelope(page)) <= 8192);
    assert.ok(Buffer.byteLength(page.text) <= 4096);
    assert.equal(page.text.includes("�"), false);
    assert.equal(page.nextOffsetBytes, offsetBytes + Buffer.byteLength(page.text));
    assert.deepEqual(read(result.resultId, { view: "text", offsetBytes, maxBytes: 4096 }), page);
    restored += page.text;
    offsetBytes = page.nextOffsetBytes;
    if (!page.hasMore) break;
  } while (offsetBytes < result.bytes);
  assert.equal(restored, json);
  assert.equal(createHash("sha256").update(restored).digest("hex"), result.sha256);
  assert.equal(read(result.resultId, { view: "text", offsetBytes: result.bytes }).text, "");
});

test("pointer selection accepts escaped own JSON keys but cannot traverse prototypes or array properties", () => {
  const { put, read } = fixture();
  const result = put('{"a/b":{"~key":[{"__proto__":{"value":"own only"}}]},"":false}');
  assert.equal(read(result.resultId, { pointer: "/a~1b/~0key/0/__proto__/value" }).selections[0].value, "own only");
  assert.equal(read(result.resultId, { pointer: "/" }).selections[0].value, false);
  for (const pointer of ["/constructor", "/toString", "/a~1b/~0key/length", "/a~1b/~0key/00", "/a~1b/~0key/-", "/a~1b/~0key/0/__proto__/constructor", "/bad~2", "not/a/pointer", `/${"x".repeat(512)}`]) {
    assert.throws(() => read(result.resultId, { pointer }), { code: "RESULT_INVALID_POINTER" });
  }
  const deep = put(`${'{"a":'.repeat(65)}0${"}".repeat(65)}`);
  assert.throws(() => read(deep.resultId, { pointer: "/a".repeat(65) }), { code: "RESULT_INVALID_POINTER" });
});

test("pages reject split UTF-8 cursors and byte ceilings that cannot fit the next character", () => {
  const { put, read } = fixture();
  const result = put('"€😀"');
  assert.equal(read(result.resultId, { view: "text", offsetBytes: 1, maxBytes: 3 }).text, "€");
  assert.equal(read(result.resultId, { view: "text", offsetBytes: 4, maxBytes: 4 }).text, "😀");
  for (const offsetBytes of [-1, 0.5, 2, 3, 5, 6, 7, 10, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => read(result.resultId, { offsetBytes }), { code: "RESULT_INVALID_OFFSET" });
  }
  assert.throws(() => read(result.resultId, { offsetBytes: 1, maxBytes: 2 }), { code: "RESULT_PAGE_TOO_SMALL" });
  for (const maxBytes of [0, 4097, Infinity]) {
    assert.throws(() => read(result.resultId, { maxBytes }), { code: "RESULT_INVALID_INPUT" });
  }
  assert.throws(() => put('"\uD800"'), { code: "RESULT_INVALID_JSON" });
});

test("escaped long pointers share the same inline envelope budget as the selected page", () => {
  const { put, read } = fixture();
  const key = "\u0001".repeat(511);
  const text = '\\"€'.repeat(3000);
  const result = put(JSON.stringify({ [key]: text }));
  const page = read(result.resultId, { view: "text", pointer: `/${key}`, maxBytes: 4096 });
  assert.ok(Buffer.byteLength(envelope(page)) <= 8192);
  assert.ok(Buffer.byteLength(page.text) < 4096);
  assert.equal(page.totalBytes, Buffer.byteLength(JSON.stringify(text)));
  assert.equal(page.text, Buffer.from(JSON.stringify(text)).subarray(0, page.nextOffsetBytes).toString("utf8"));
});

test("summaries remain deterministic bounded metadata without scalar or nested-value disclosure", () => {
  const { put } = fixture();
  const privateValue = "must-not-appear-in-summary";
  const fields = Array.from({ length: 50 }, (_, index) => [`field-${String(index).padStart(2, "0")}-${"x".repeat(70)}`, { nested: privateValue }]);
  const first = put(JSON.stringify(Object.fromEntries(fields)));
  const reversed = put(JSON.stringify(Object.fromEntries([...fields].reverse())));
  assert.deepEqual(first.summary, reversed.summary);
  assert.ok(Buffer.byteLength(JSON.stringify(first.summary)) <= 512);
  assert.equal(JSON.stringify(first.summary).includes(privateValue), false);
  assert.equal(JSON.stringify(first.summary).includes("nested"), false);
  assert.equal(first.summary.count, 50);
  assert.equal(first.summary.omittedFields + first.summary.fields.length, 50);
  assert.ok(first.summary.omittedFields > 0);
  assert.ok(Buffer.byteLength(envelope(first)) <= 8192);
});

test("single and multiple selectors default to complete JSON values while explicit text preserves paging", () => {
  const { put, read } = fixture();
  const result = put('{"a/b":{"~key":[null,false,3]},"value":"雪"}');
  const page = read(result.resultId, { pointers: ["/a~1b/~0key", "/value"] });
  assert.deepEqual(page, {
    resultId: result.resultId, toolName: "potassium_trace_query",
    selections: [
      { pointer: "/a~1b/~0key", kind: "value", value: [null, false, 3] },
      { pointer: "/value", kind: "value", value: "雪" },
    ],
    hasMore: false,
  });
  assert.deepEqual(read(result.resultId, { pointer: "/value" }).selections, [page.selections[1]]);
  assert.equal(read(result.resultId, { pointer: "/value", view: "text" }).text, '"雪"');
  assert.deepEqual(read(result.resultId, { pointer: "/value", view: "auto" }).selections, [page.selections[1]]);
  assert.equal(read(result.resultId, { pointers: ["/value"], view: "text" }).selections[0].kind, "text");
});

test("multi-selection rejects malformed selections and later invalid offsets atomically", () => {
  const { put, read } = fixture();
  const result = put('{"good":"€😀","array":[1],"__proto__":{"own":true}}');
  for (const options of [
    { pointers: [] }, { pointers: Array(9).fill("/good") }, { pointers: ["/good", "/good"] },
    { pointers: ["/good", 2] }, { pointers: Array(1) }, { pointers: [`/${"x".repeat(512)}`] },
    { pointers: ["/" + "a".repeat(511), "/" + "b".repeat(511), "/x"] },
    { pointers: ["/good", "/missing"] }, { pointers: ["/good", "/constructor"] },
    { pointers: ["/good", "/array/length"] }, { pointers: ["/good", "/array/00"] },
    { pointers: ["/good", "/bad~2"] }, { pointer: null },
  ]) {
    assert.throws(() => read(result.resultId, options), { code: "RESULT_INVALID_POINTER" });
  }
  for (const options of [
    { pointers: ["/good"], pointer: "" }, { pointers: ["/good"], offsetBytes: 0 },
    { offsets: [0] }, { pointers: ["/good"], view: "other" },
  ]) {
    assert.throws(() => read(result.resultId, options), { code: "RESULT_INVALID_INPUT" });
  }
  for (const offsets of [[0], [0, -1], [0, 0.5], [0, 2], [0, 99], [0, null], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => read(result.resultId, { pointers: ["/array", "/good"], offsets }), { code: "RESULT_INVALID_OFFSET" });
  }
  assert.throws(() => read(result.resultId, { offsetBytes: null }), { code: "RESULT_INVALID_OFFSET" });
  assert.deepEqual(read(result.resultId, { pointers: ["/__proto__/own", "/array/0"] }).selections, [
    { pointer: "/__proto__/own", kind: "value", value: true },
    { pointer: "/array/0", kind: "value", value: 1 },
  ]);
});

test("multi-selection shares a byte budget and unfinished pointers replay independently", () => {
  const { put, read } = fixture();
  const data = { first: '\\\"\n€😀'.repeat(60), second: "雪".repeat(40), small: false };
  const result = put(JSON.stringify(data));
  let pointers = ["/first", "/second", "/small"];
  let offsets = [0, 0, 0];
  const restored = new Map(pointers.map((pointer) => [pointer, ""]));
  let pageCount = 0;
  let sawPending = false;
  while (pointers.length > 0) {
    assert.ok(++pageCount < 200, "all unfinished pointers must advance to completion");
    const page = read(result.resultId, { pointers, offsets, maxBytes: 23 });
    assert.deepEqual(read(result.resultId, { pointers, offsets, maxBytes: 23 }), page);
    let bytes = 0;
    const unfinished = [];
    const nextOffsets = [];
    for (const selection of page.selections) {
      if (selection.kind === "value") {
        const text = JSON.stringify(selection.value);
        bytes += Buffer.byteLength(text);
        restored.set(selection.pointer, text);
      } else {
        if (selection.kind === "text") {
          bytes += Buffer.byteLength(selection.text);
          assert.equal(selection.text.includes("�"), false);
          assert.equal(selection.nextOffsetBytes, selection.offsetBytes + Buffer.byteLength(selection.text));
          restored.set(selection.pointer, restored.get(selection.pointer) + selection.text);
        } else {
          sawPending = true;
          assert.equal(selection.nextOffsetBytes, offsets[pointers.indexOf(selection.pointer)]);
        }
        if (selection.hasMore) {
          unfinished.push(selection.pointer);
          nextOffsets.push(selection.nextOffsetBytes);
        }
      }
    }
    assert.ok(bytes > 0 && bytes <= 23);
    assert.ok(Buffer.byteLength(envelope(page)) <= 8192);
    assert.equal(page.hasMore, unfinished.length > 0);
    pointers = unfinished;
    offsets = nextOffsets;
  }
  assert.equal(sawPending, true);
  for (const [pointer, text] of restored) assert.equal(text, JSON.stringify(data[pointer.slice(1)]));
});

test("shared paging can serve a later selection when the first UTF-8 character cannot fit", () => {
  const { put, read } = fixture();
  const result = put('{"large":"€","tiny":1}');
  const page = read(result.resultId, { pointers: ["/large", "/tiny"], offsets: [1, 0], maxBytes: 1 });
  assert.deepEqual(page.selections, [
    { pointer: "/large", kind: "pending", nextOffsetBytes: 1, hasMore: true },
    { pointer: "/tiny", kind: "value", value: 1 },
  ]);
  assert.equal(page.hasMore, true);
  assert.throws(() => read(result.resultId, { pointers: ["/large"], offsets: [1], maxBytes: 2 }), { code: "RESULT_PAGE_TOO_SMALL" });
  const done = read(result.resultId, { pointers: ["/large"], offsets: [5], maxBytes: 1 });
  assert.equal(done.hasMore, false);
  assert.equal(done.selections[0].text, "");
});

test("response ceilings count complete escaped envelopes and never recursively retain result pages", () => {
  const { put, read, store } = fixture({ maxEntries: 1 });
  const data = { a: '\\\"\n\u0001€😀'.repeat(400), b: "b".repeat(200) };
  const result = put(JSON.stringify(data));
  for (const options of [
    { pointer: "/a" }, { pointer: "/a", view: "auto" },
    { pointers: ["/a", "/b"] }, { pointers: ["/a", "/b"], view: "text" },
  ]) {
    const page = store.read({ scopeId: "session-a", resultId: result.resultId, maxBytes: 4096, ...options }, () => true, { maxResponseBytes: 1024 });
    assert.ok(Buffer.byteLength(envelope(page)) <= 1024);
    assert.equal(page.kind, undefined);
    const selections = page.selections ?? [page];
    assert.ok(selections.some((selection) => selection.text?.length > 0));
  }
  assert.throws(() => store.read({ scopeId: "session-a", resultId: result.resultId, pointers: ["/a", "/b"] }, () => true, { maxResponseBytes: 1 }), { code: "RESULT_PAGE_TOO_SMALL" });
  assert.throws(() => store.read({ scopeId: "session-a", resultId: result.resultId }, () => true, { maxResponseBytes: 8193 }), { code: "RESULT_INVALID_INPUT" });
  assert.equal(read(result.resultId, { pointer: "/b", view: "auto" }).selections[0].value, data.b);
});

test("auto values can fit a response whose pending metadata would not fit", () => {
  const { put, store } = fixture();
  const data = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`f${index}`, index]));
  const result = put(JSON.stringify(data));
  const pointers = Object.keys(data).map((key) => `/${key}`);
  const expected = {
    resultId: result.resultId, toolName: "potassium_trace_query",
    selections: pointers.map((pointer, index) => ({ pointer, kind: "value", value: index })), hasMore: false,
  };
  const maxResponseBytes = Buffer.byteLength(envelope(expected));
  assert.deepEqual(store.read({ scopeId: "session-a", resultId: result.resultId, pointers, maxBytes: 8 }, () => true, { maxResponseBytes }), expected);
});

test("multi and auto reads preserve scope, origin policy, expiry, and release isolation", () => {
  const { clock, put, read, store } = fixture({ ttlMs: 10 });
  const result = put('{"a":1,"b":2}');
  const options = { pointers: ["/a", "/b"] };
  assert.throws(() => read(result.resultId, { ...options, scopeId: "foreign" }, () => assert.fail("foreign policy lookup")), { code: "RESULT_NOT_FOUND" });
  assert.throws(() => read(result.resultId, options, () => false), { code: "RESULT_ORIGIN_DENIED" });
  assert.equal(read(result.resultId, options).hasMore, false);
  clock.value += 10;
  assert.throws(() => read(result.resultId, options), { code: "RESULT_NOT_FOUND" });
  const next = put('{"a":1,"b":2}');
  store.releaseScope("session-a");
  assert.throws(() => read(next.resultId, { pointer: "/a", view: "auto" }), { code: "RESULT_NOT_FOUND" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNativeSourcePackage } from "../src/code-tree-adapter.js";
import { createCodeIndexService } from "../src/code-index.js";
import { authoredModule, nativePayloadForAuthoredModules, parseAuthoredModules } from "./helpers/code-parser.js";

async function fixture(source = "local value = 1\nconsume(value)") {
  const modules = [authoredModule(source)];
  return { modules, payload: await nativePayloadForAuthoredModules(modules) };
}
const invalid = (modules, payload) => assert.throws(() => analyzeNativeSourcePackage(modules, payload), { code: "PARSER_TREE_INVALID" });

test("native UTF-8 tree data preserves UTF-16 spans, typed semantics and redactions", async () => {
  const { modules, payload } = await fixture('-- 雪😀\r\nlocal value: string = "雪😀"; consume(value)\r\nlocal function f<T>(x: T): T return x end\r\nf(value)');
  const expected = await parseAuthoredModules(modules);
  const actual = analyzeNativeSourcePackage(modules, payload);
  assert.deepEqual(actual.facts, expected.facts);
  assert.deepEqual(actual.files, expected.files);
  assert.deepEqual(actual.diagnostics, expected.diagnostics);
  const call = actual.facts.calls.find((fact) => fact.callee === "consume");
  assert.equal(call.span.start.offset, modules[0].source.indexOf("consume"));
  assert.equal(call.span.start.column, modules[0].source.split("\n")[1].indexOf("consume") + 1);
  assert.equal(actual.parser.runtime, "tree-sitter");
});

test("analyzed native-shaped trees retain the no-executor index/query contract", async () => {
  const service = createCodeIndexService({ parse: async (modules) => analyzeNativeSourcePackage(modules, await nativePayloadForAuthoredModules(modules)) });
  const result = await service.index({ scopeId: "native-fixture", modules: [{ id: "Main", source: 'local secret = "not-displayed"\nremote:InvokeServer(secret)' }] });
  const calls = service.query({ scopeId: "native-fixture", indexId: result.indexId, view: "calls" }, () => true);
  assert.equal(calls.rows[0].method, "InvokeServer");
  assert.equal(calls.rows[0].receiverIdentity, "unverified");
  assert.equal(JSON.stringify(calls).includes("not-displayed"), false);
  assert.equal(calls.rows[0].span.start.line, 2);
});

test("UTF-8 continuation-byte positions are rejected before semantic analysis", async () => {
  const { modules, payload } = await fixture('consume("雪😀")');
  const content = payload.trees[0].nodes.find((node) => node.type === "string_content");
  content.startByte += 1;
  content.startByteColumn += 1;
  invalid(modules, payload);
});

test("native byte columns and line numbers must agree with the original source", async () => {
  const { modules, payload } = await fixture();
  const call = payload.trees[0].nodes.find((node) => node.type === "function_call");
  call.startRow = 0;
  call.startByteColumn = call.startByte;
  invalid(modules, payload);
  const second = await fixture('-- 雪\nconsume()');
  second.payload.trees[0].nodes.find((node) => node.type === "function_call").startByteColumn = 1;
  invalid(second.modules, second.payload);
});

test("native children must be single-parent, ordered and contained within their parent", async () => {
  const first = await fixture();
  const root = first.payload.trees[0].nodes[0];
  root.children.push(root.children[0]);
  invalid(first.modules, first.payload);
  const second = await fixture();
  second.payload.trees[0].nodes[0].children.reverse();
  invalid(second.modules, second.payload);
  const third = await fixture();
  const nested = third.payload.trees[0].nodes.find((node) => node.type === "function_call");
  nested.startByte = 0;
  nested.startRow = 0;
  nested.startByteColumn = 0;
  invalid(third.modules, third.payload);
});

test("native field references cannot point outside direct children or repeat a child", async () => {
  const first = await fixture();
  const nodes = first.payload.trees[0].nodes;
  nodes[0].fields.name = [nodes.length - 1];
  invalid(first.modules, first.payload);
  const second = await fixture();
  const call = second.payload.trees[0].nodes.find((node) => node.type === "function_call");
  call.fields.name.push(call.fields.name[0]);
  invalid(second.modules, second.payload);
});

test("disconnected cycles and trees exceeding the native depth limit are rejected", async () => {
  const { modules, payload } = await fixture("");
  const empty = payload.trees[0].nodes[0];
  payload.trees[0].nodes = [
    { ...empty, children: [] },
    { ...empty, children: [2] },
    { ...empty, children: [1] },
  ];
  invalid(modules, payload);
  payload.trees[0].nodes = Array.from({ length: 514 }, (_, index) => ({ ...empty, children: index === 513 ? [] : [index + 1], fields: {} }));
  invalid(modules, payload);
});

test("native parser identity, complete-result status and source hashes are mandatory", async () => {
  const first = await fixture();
  first.payload.parser.runtimeVersion = "untrusted";
  invalid(first.modules, first.payload);
  const second = await fixture();
  second.payload.truncated = true;
  invalid(second.modules, second.payload);
  const third = await fixture();
  third.modules[0].sha256 = "0".repeat(64);
  assert.throws(() => analyzeNativeSourcePackage(third.modules, third.payload), { code: "PARSER_INVALID_INPUT" });
});

test("native syntax errors retain diagnostics without exposing recovered-source facts", async () => {
  const { modules, payload } = await fixture("local value = 'unterminated-secret");
  const result = analyzeNativeSourcePackage(modules, payload);
  assert.equal(result.files[0].parseErrors, true);
  assert.equal(result.files[0].redactions, undefined);
  assert.equal(result.facts.calls.length, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PARSE_ERROR"));
  assert.equal(JSON.stringify(result).includes("unterminated-secret"), false);
});

test("one direct child cannot be assigned to multiple native fields", async () => {
  const { modules, payload } = await fixture("consume(slots[value])");
  const member = payload.trees[0].nodes.find((node) => node.type === "bracket_index_expression");
  member.fields.field = [...member.fields.table];
  invalid(modules, payload);
});

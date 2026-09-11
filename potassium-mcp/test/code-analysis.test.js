import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_LIMITS, analyzeSourcePackage } from "../src/code-analysis.js";
import { authoredModule, parseAuthoredModules, terminalOrigin } from "./helpers/code-parser.js";

const analyze = (source) => parseAuthoredModules([authoredModule(source)]);
const originOf = (result, call, argument = 0) => terminalOrigin(result, call.arguments[argument].origin);

test("real Luau grammar handles typed generics, continue, update assignment and method spans", async () => {
  const source = `type Box<T> = { value: T }
local function unwrap<T>(box: Box<T>): T
  return box.value
end
local count: number = 0
for i = 1, 3 do
  if i == 2 then continue end
  count += i
end
local result = remote:InvokeServer(unwrap({ value = count }))`;
  const result = await analyze(source);
  assert.equal(result.files[0].parseErrors, false);
  const fn = result.facts.functions.find((fact) => fact.name === "unwrap");
  assert.deepEqual(fn.parameters, ["box"]);
  const call = result.facts.calls.find((fact) => fact.method === "InvokeServer");
  assert.equal(source.slice(call.span.start.offset, call.span.end.offset), "remote:InvokeServer(unwrap({ value = count }))");
  assert.equal(call.receiverIdentity, "unverified");
  assert.equal(call.confidence, "unresolved");
  assert.equal(originOf(result, call).reason, "return-derived");
  assert.ok(result.facts.bindings.some((fact) => fact.origin.reason === "update-assignment"));
});

test("lexical shadowing and simultaneous assignments preserve the correct source binding", async () => {
  const result = await analyze(`local a = 1
local b = "secret"
do
  local a = b
  consume(a)
end
consume(a)
a, b = b, a
consume(a, b)
local a = a
consume(a)`);
  const calls = result.facts.calls.filter((fact) => fact.callee === "consume");
  assert.equal(originOf(result, calls[0]).literalType, "string");
  assert.equal(originOf(result, calls[1]).literalType, "number");
  assert.equal(originOf(result, calls[2]).literalType, "string");
  assert.equal(originOf(result, calls[2], 1).literalType, "number");
  assert.equal(originOf(result, calls[3]).literalType, "string");
});

test("function aliases resolve before reassignment and stop claiming identity after a branch", async () => {
  const result = await analyze(`local function original() end
local alias = original
alias()
alias = other
alias()
local candidate = original
if enabled then candidate = other end
candidate()`);
  const fn = result.facts.functions.find((fact) => fact.name === "original");
  const calls = result.facts.calls.filter((fact) => fact.callee === "alias" || fact.callee === "candidate");
  assert.equal(calls[0].targetFunctionId, fn.id);
  assert.equal(calls[1].targetFunctionId, undefined);
  assert.equal(calls[2].targetFunctionId, undefined);
  assert.equal(terminalOrigin(result, calls[2].calleeOrigin).reason, "branch-merge");
});

test("static hierarchy requires resolve supplied modules only and respect require/script shadowing", async () => {
  const source = `local imported = require(script.Parent.Shared)
local fetch = require
fetch(script.Parent.Shared)
require(script.Parent.Missing)
require(selectModule())
do
  local require = function(value) return value end
  require(script.Parent.Shared)
end
do
  local script = unknown
  require(script.Parent.Shared)
end`;
  const result = await parseAuthoredModules([authoredModule(source), authoredModule("return {}", "Shared")]);
  const edges = result.facts.dependencies;
  assert.equal(edges.length, 5);
  assert.deepEqual(edges.slice(0, 2).map((edge) => edge.targetModuleId), ["Shared", "Shared"]);
  assert.equal(edges[2].reason, "module-not-supplied");
  assert.equal(edges[3].reason, "dynamic-require");
  assert.equal(edges[4].reason, "dynamic-require");
});

test("captured values, possible closure writes, multiple returns and reflection remain unresolved", async () => {
  const result = await analyze(`local value = 1
local function mutate()
  consume(value)
  value = 2
end
mutate()
consume(value)
local first, second = produce()
consume(first, second)
setfenv(1, {})
require(script.Parent.Shared)`);
  const calls = result.facts.calls.filter((fact) => fact.callee === "consume");
  assert.equal(originOf(result, calls[0]).reason, "captured-upvalue");
  assert.equal(originOf(result, calls[1]).reason, "possible-captured-write");
  assert.equal(originOf(result, calls[2]).reason, "return-derived");
  assert.equal(originOf(result, calls[2], 1).reason, "multiple-return");
  assert.equal(result.facts.dependencies.length, 0);
  assert.ok(result.diagnostics.some((fact) => fact.code === "ENVIRONMENT_EFFECT"));
});

test("loop merges are uncertain while repeat conditions see body-local declarations", async () => {
  const result = await analyze(`local value = 1
while condition do value = 2 end
consume(value)
repeat
  local current = "hidden"
until check(current)
consume(current)`);
  const calls = result.facts.calls;
  assert.equal(originOf(result, calls.find((fact) => fact.callee === "consume")).reason, "loop-merge");
  assert.equal(originOf(result, calls.find((fact) => fact.callee === "check")).literalType, "string");
  assert.equal(originOf(result, calls.filter((fact) => fact.callee === "consume")[1]).reason, "global-or-unbound");
});

test("comments, strings and numeric secrets are redacted without inventing calls from text", async () => {
  const result = await analyze(`-- hiddenRemote:FireServer("comment-secret")
local text = "imaginary:InvokeServer('string-secret')"
remote:FireServer("actual-secret", 123456789123456789)`);
  assert.deepEqual(result.facts.calls.map((fact) => fact.callee), ["FireServer"]);
  const visible = JSON.stringify(result.facts);
  for (const secret of ["comment-secret", "string-secret", "actual-secret", "123456789123456789"]) assert.equal(visible.includes(secret), false);
  assert.match(result.facts.calls[0].snippet, /\[string\]/);
});

test("invalid syntax returns diagnostics without making semantic claims for recovered trees", async () => {
  const result = await analyze("local function broken(\n remote:FireServer('hidden')");
  assert.equal(result.files[0].parseErrors, true);
  assert.equal(result.files[0].complete, false);
  assert.equal(result.facts.calls.length, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PARSE_ERROR"));
  assert.equal(result.files[0].redactions, undefined);
});

test("excessive AST depth stops analysis explicitly instead of traversing an unbounded expression", async () => {
  const source = `consume(${"(".repeat(ANALYSIS_LIMITS.maxDepth + 10)}value${")".repeat(ANALYSIS_LIMITS.maxDepth + 10)})`;
  const result = await analyze(source);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].complete, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ANALYSIS_LIMIT"));
});

test("loop callsites do not mistake initial values for loop-carried argument origins", async () => {
  const result = await analyze("local value = 1\nwhile condition do\n  consume(value)\n  value = 2\nend");
  const call = result.facts.calls.find((fact) => fact.callee === "consume");
  assert.equal(originOf(result, call).reason, "loop-carried");
});

test("loop function declarations and first global writes invalidate later-iteration identities", async () => {
  const result = await analyze(`local f = function() end
while condition do
  consume(f)
  function f() end
end
while condition do
  require(script.Parent.Shared)
  require = function() end
end`);
  const consume = result.facts.calls.find((call) => call.callee === "consume");
  assert.equal(originOf(result, consume).reason, "loop-carried");
  assert.equal(result.facts.dependencies.length, 0);
});

test("closure first writes to implicit globals invalidate builtin require after a possible call", async () => {
  const result = await parseAuthoredModules([
    authoredModule("local function mutate() require = function() end end\nmutate()\nrequire(script.Parent.Shared)"),
    authoredModule("return {}", "Shared"),
  ]);
  assert.equal(result.facts.dependencies.length, 0);
  const requireCall = result.facts.calls.find((call) => call.callee === "require");
  assert.equal(terminalOrigin(result, requireCall.calleeOrigin).reason, "possible-captured-write");
});

test("comments cannot shift assignment values or argument positions", async () => {
  const result = await analyze(`local a, b = 1, -- assignment comment
  "hidden"
consume(-- argument comment
  a, -- another argument comment
  b)`);
  const call = result.facts.calls.find((fact) => fact.callee === "consume");
  assert.equal(call.argumentCount, 2);
  assert.equal(originOf(result, call, 0).literalType, "number");
  assert.equal(originOf(result, call, 1).literalType, "string");
});

test("computed assignment indices observe pre-commit bindings", async () => {
  const result = await analyze('local i = "old"\ni, slots[consume(i)] = 2, 3\nconsume(i)');
  const calls = result.facts.calls.filter((call) => call.callee === "consume");
  assert.equal(originOf(result, calls[0]).literalType, "string");
  assert.equal(originOf(result, calls[1]).literalType, "number");
});

test("loop-local shadow assignments do not invalidate untouched outer bindings", async () => {
  const result = await analyze('local value = "outer"\nwhile condition do local value = 1; value = 2 end\nconsume(value)');
  const call = result.facts.calls.find((fact) => fact.callee === "consume");
  assert.equal(originOf(result, call).literalType, "string");
});

test("scope-copy work is capped even when AST size and emitted fact counts remain small", async () => {
  const declarations = Array.from({ length: 1000 }, (_, index) => `local value${index} = nil`).join("\n");
  const result = await analyze(`${declarations}\n${"if condition then end\n".repeat(1000)}`);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].complete, false);
  assert.ok(result.budgets.nodes < ANALYSIS_LIMITS.maxNodes);
  assert.ok(result.budgets.facts < ANALYSIS_LIMITS.maxFacts);
  assert.ok(result.budgets.scopeWork > ANALYSIS_LIMITS.maxScopeWork);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ANALYSIS_LIMIT"));
});

test("semantic visits stop repeated field traversal independently of AST and scope-copy limits", () => {
  // Defense in depth below the native adapter: a deliberately malformed, short
  // synthetic AST associates each child with both member operands.
  let nextId = 0;
  function node(type, fields = {}, children = [...new Set(Object.values(fields))]) {
    return {
      id: nextId++, type, text: "", startIndex: 0, endIndex: 0,
      startPosition: { row: 0, column: 0 }, endPosition: { row: 0, column: 0 },
      isNamed: true, isMissing: false, hasError: false, children, namedChildren: children, childCount: children.length,
      child: (index) => children[index] ?? null,
      childForFieldName: (name) => fields[name] ?? null,
      childrenForFieldName: (name) => fields[name] ? [fields[name]] : [],
    };
  }
  let operand = node("number");
  for (let level = 0; level < 18; level += 1) operand = node("bracket_index_expression", { table: operand, field: operand });
  const argumentsNode = node("arguments", {}, [operand]);
  const call = node("function_call", { name: node("number"), arguments: argumentsNode });
  const result = analyzeSourcePackage([authoredModule("")], [{ rootNode: node("chunk", {}, [call]) }], { name: "synthetic-adversarial-tree" });
  assert.equal(result.truncated, true);
  assert.ok(result.budgets.nodes < ANALYSIS_LIMITS.maxNodes);
  assert.ok(result.budgets.scopeWork < ANALYSIS_LIMITS.maxScopeWork);
  assert.ok(result.budgets.semanticVisits > ANALYSIS_LIMITS.maxSemanticVisits);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ANALYSIS_LIMIT"));
});

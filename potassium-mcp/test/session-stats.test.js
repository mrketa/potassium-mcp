import assert from "node:assert/strict";
import test from "node:test";
import { createSessionStats } from "../src/session-stats.js";

const toolNames = ["potassium_find_instances", "potassium_read_properties", "potassium_result_read", "potassium_session_stats", "potassium_execute_luau", "potassium_code_query"];
function fixture(options = {}) {
  const clock = { value: 100, now() { return this.value; } };
  return { clock, stats: createSessionStats({ clock, toolNames, ...options }) };
}
function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
const okay = result({ okay: true });

function call(stats, name, args, output = okay) {
  stats.begin(name, args)(output);
}

test("admitted calls count complete logical result bytes, final errors, compaction, detail reads, and duration exactly once", () => {
  const { stats, clock } = fixture();
  const finishScan = stats.begin("potassium_find_instances", { path: "Workspace" });
  const finishDetail = stats.begin("potassium_result_read", { resultId: "f".repeat(32) });
  stats.recordProtocolError();
  assert.equal(stats.snapshot().calls, 2);
  assert.equal(stats.snapshot().inFlight, 2);
  assert.equal(stats.snapshot().resultBytes, 0);
  assert.equal(stats.snapshot().detailReads, 1);
  clock.value += 12.9;
  const compact = result({ kind: "potassium/result", resultId: "a".repeat(32), summary: { type: "object" } });
  finishScan(compact);
  finishScan(result({ overwritten: "must not count" }));
  clock.value += 8.1;
  const failure = { content: [{ type: "text", text: "private failure 雪\n" }], isError: true, _meta: { code: "RESULT_NOT_FOUND" } };
  finishDetail(failure);
  const snapshot = stats.snapshot();
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.protocolErrors, 1);
  assert.equal(snapshot.resultBytes, Buffer.byteLength(JSON.stringify(compact)) + Buffer.byteLength(JSON.stringify(failure)));
  assert.equal(snapshot.compactResponses, 1);
  assert.equal(snapshot.detailReads, 1);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.totalDurationMs, 33);
  assert.equal(snapshot.maxDurationMs, 21);
  assert.equal(snapshot.perTool.find((row) => row.toolName === "potassium_result_read").errors, 1);
  assert.equal(snapshot.perTool.find((row) => row.toolName === "potassium_find_instances").resultBytes, Buffer.byteLength(JSON.stringify(compact)));
});

test("a statistics read sees its own admission and in-flight state but not its unfinished response bytes", () => {
  const { stats } = fixture();
  call(stats, "potassium_find_instances", { path: "Workspace" });
  const finish = stats.begin("potassium_session_stats", {});
  const visible = stats.snapshot();
  assert.equal(visible.calls, 2);
  assert.equal(visible.inFlight, 1);
  assert.equal(visible.resultBytes, Buffer.byteLength(JSON.stringify(okay)));
  const response = result(visible);
  finish(response);
  assert.equal(stats.snapshot().resultBytes, visible.resultBytes + Buffer.byteLength(JSON.stringify(response)));
  assert.equal(stats.snapshot().inFlight, 0);
});

test("repeated scans normalize object order and omitted optional fields but preserve scope, cursor, and selection distinctions", () => {
  const { stats } = fixture();
  call(stats, "potassium_find_instances", { path: "Workspace", clientId: "one", options: { name: "A", limit: 2 } });
  call(stats, "potassium_find_instances", { options: { limit: 2, name: "A", unused: undefined }, clientId: "one", path: "Workspace" });
  assert.equal(stats.snapshot().repeatedScanRequests, 1);
  call(stats, "potassium_find_instances", { path: "Workspace", clientId: "two", options: { name: "A", limit: 2 } });
  call(stats, "potassium_find_instances", { path: "Workspace", clientId: "one", options: { name: "A", limit: 3 } });
  call(stats, "potassium_find_instances", { path: "Workspace", clientId: "one", cursor: "next", options: { name: "A", limit: 2 } });
  call(stats, "potassium_read_properties", { path: "Workspace", clientId: "one", options: { name: "A", limit: 2 } });
  assert.equal(stats.snapshot().repeatedScanRequests, 1);
  call(stats, "potassium_read_properties", { properties: ["Name", "ClassName"] });
  call(stats, "potassium_read_properties", { properties: ["ClassName", "Name"] });
  assert.equal(stats.snapshot().repeatedScanRequests, 1);
});

test("bounded scan key retention evicts least recently used requests without exporting keys or request values", () => {
  const { stats } = fixture({ maxScanKeys: 2 });
  for (const path of ["private-A", "private-B", "private-A", "private-C", "private-B"]) {
    call(stats, "potassium_find_instances", { path });
  }
  assert.equal(stats.snapshot().repeatedScanRequests, 1);
  call(stats, "potassium_find_instances", { path: "private-C" });
  assert.equal(stats.snapshot().repeatedScanRequests, 2);
  const serialized = JSON.stringify(stats.snapshot());
  assert.equal(serialized.includes("private-"), false);
  assert.equal(/[a-f0-9]{64}/.test(serialized), false);
  assert.equal(/sha|hash|digest|args|payload|salt/i.test(serialized), false);
});

test("non-scan operations, release actions, and over-budget selections cannot create misleading repetition matches", () => {
  const { stats } = fixture();
  const nested = {}; let cursor = nested;
  for (let depth = 0; depth < 10; depth += 1) cursor = cursor.child = {};
  const cycle = {}; cycle.self = cycle;
  const wide = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, index]));
  const oversized = [nested, cycle, wide, { path: "x".repeat(4097) }, { fields: Array(257).fill(1) }, { values: Array(8).fill("x".repeat(3000)) }];
  for (const args of oversized) {
    call(stats, "potassium_find_instances", args);
    call(stats, "potassium_find_instances", args);
  }
  for (let index = 0; index < 2; index += 1) {
    call(stats, "potassium_execute_luau", { code: "private execution code" });
    call(stats, "potassium_result_read", { resultId: "b".repeat(32) });
    call(stats, "potassium_code_query", { indexId: "c".repeat(32), view: "release" });
  }
  assert.equal(stats.snapshot().repeatedScanRequests, 0);
  assert.equal(stats.snapshot().detailReads, 2);
  call(stats, "potassium_find_instances", { path: "bounded" });
  call(stats, "potassium_find_instances", { path: "bounded" });
  assert.equal(stats.snapshot().repeatedScanRequests, 1);
});

test("statistics never retain mutable request/result objects or expose arbitrary tool metadata", () => {
  const { stats } = fixture({ maxTools: 3, toolNames: ["potassium_find_instances", "potassium_result_read", "potassium_session_stats"] });
  const args = { path: "sensitive original path" };
  const finish = stats.begin("potassium_find_instances", args);
  args.path = "mutated private path";
  const output = result({ secret: "sensitive result" });
  finish(output);
  output.structuredContent.secret = "mutated result";
  call(stats, "potassium_find_instances", { path: "sensitive original path" });
  for (let index = 0; index < 1000; index += 1) call(stats, `arbitrary-secret-${index}`, { token: "credential" });
  const snapshot = stats.snapshot();
  assert.equal(snapshot.repeatedScanRequests, 1);
  assert.ok(snapshot.perTool.length <= 3);
  assert.equal(snapshot.perTool.find((row) => row.toolName === "unknown").calls, 1000);
  const serialized = JSON.stringify(snapshot);
  assert.equal(/sensitive|private|mutated|arbitrary|credential|secret/.test(serialized), false);
  snapshot.perTool[0].calls = 0;
  snapshot.calls = 0;
  assert.equal(stats.snapshot().calls, 1002);
  assert.equal(stats.snapshot().perTool.find((row) => row.toolName === "potassium_find_instances").calls, 2);
});

test("clear fences unfinished calls, removes repetition state, and separates independent statistics scopes", () => {
  const { stats, clock } = fixture();
  const other = fixture().stats;
  call(stats, "potassium_find_instances", { path: "A" });
  call(other, "potassium_find_instances", { path: "A" });
  assert.equal(other.snapshot().repeatedScanRequests, 0);
  const previous = stats.begin("potassium_find_instances", { path: "A" });
  stats.recordProtocolError();
  stats.clear();
  const current = stats.begin("potassium_find_instances", { path: "A" });
  clock.value += 5;
  previous(result({ ignored: "old generation" }));
  assert.equal(stats.snapshot().inFlight, 1);
  assert.equal(stats.snapshot().resultBytes, 0);
  assert.equal(stats.snapshot().protocolErrors, 0);
  assert.equal(stats.snapshot().repeatedScanRequests, 0);
  current(okay);
  assert.equal(stats.snapshot().calls, 1);
  assert.equal(stats.snapshot().totalDurationMs, 5);
  assert.equal(stats.snapshot().resultBytes, Buffer.byteLength(JSON.stringify(okay)));
  assert.equal(other.snapshot().calls, 1);
});

test("duration totals saturate safely and backward clocks cannot make counters negative", () => {
  const { stats, clock } = fixture();
  clock.value = 0;
  const first = stats.begin("potassium_find_instances", {});
  const second = stats.begin("potassium_find_instances", {});
  clock.value = Number.MAX_SAFE_INTEGER;
  first(okay);
  second(okay);
  assert.equal(stats.snapshot().totalDurationMs, Number.MAX_SAFE_INTEGER);
  assert.equal(stats.snapshot().maxDurationMs, Number.MAX_SAFE_INTEGER);
  const backward = stats.begin("potassium_find_instances", {});
  clock.value = 0;
  backward(okay);
  assert.equal(stats.snapshot().totalDurationMs, Number.MAX_SAFE_INTEGER);
  assert.equal(stats.snapshot().inFlight, 0);
  assert.equal(Number.isSafeInteger(stats.snapshot().totalDurationMs), true);
});

test("configuration cannot increase statistics metadata or fingerprint ceilings", () => {
  assert.throws(() => createSessionStats({ maxTools: 129 }), RangeError);
  assert.throws(() => createSessionStats({ maxTools: 0 }), RangeError);
  assert.throws(() => createSessionStats({ maxScanKeys: 65 }), RangeError);
  assert.throws(() => createSessionStats({ toolNames: ["unbounded name with spaces"] }), TypeError);
  const { stats } = fixture({ maxScanKeys: 0 });
  call(stats, "potassium_find_instances", { path: "A" });
  call(stats, "potassium_find_instances", { path: "A" });
  assert.equal(stats.snapshot().repeatedScanRequests, 0);
});

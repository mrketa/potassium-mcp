import test from "node:test";
import assert from "node:assert/strict";
import {
  allowsTool,
  assertHostId,
  parseHostPolicies,
  parseHttpPolicy,
  parsePolicyConfig,
  resolveHostPolicy,
  toolCapability,
} from "../src/host-policy.js";

test("host policies default every known host to read-only without cross-host inheritance", () => {
  const policies = parseHostPolicies({
    omp: { read: true, admin: true, execute: true },
    codex: { read: true, admin: false, execute: false },
  });

  assert.deepEqual(policies.omp, { read: true, admin: true, execute: true });
  assert.deepEqual(policies.codex, { read: true, admin: false, execute: false });
  assert.deepEqual(policies.cursor, { read: true, admin: false, execute: false });
  assert.equal(Object.isFrozen(policies), true);
  assert.equal(Object.isFrozen(policies.omp), true);
  assert.throws(() => { policies.omp.execute = false; }, TypeError);
});

test("partial explicit policy never inherits omitted privileges", () => {
  const policy = resolveHostPolicy("omp", { omp: { read: true } });
  assert.deepEqual(policy, { read: true, admin: false, execute: false });
});

test("host parsing rejects malformed IDs, fields, and non-boolean grants", () => {
  assert.throws(() => parseHostPolicies({ Unknown: {} }), /hostId/);
  assert.throws(() => parseHostPolicies({ omp: { read: true, write: true } }), /unsupported key/);
  assert.throws(() => parseHostPolicies({ omp: { execute: 1 } }), /must be a boolean/);
  assert.throws(() => resolveHostPolicy("unknown"), /unsupported MCP host/);
});

test("HTTP policy is independent and immutable", () => {
  const config = parsePolicyConfig({
    hostPolicies: { omp: { read: true, admin: true, execute: true } },
    httpPolicy: { read: false, admin: true, execute: false },
  });

  assert.deepEqual(config.http, { read: false, admin: true, execute: false });
  assert.deepEqual(parseHttpPolicy(), { read: true, admin: false, execute: false });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.http), true);
});

test("tool capability predicates deny unknown tools and require global execute opt-in", () => {
  const executePolicy = { read: true, admin: true, execute: true };

  assert.equal(toolCapability("potassium_list_children"), "read");
  assert.equal(toolCapability("potassium_admin_recover"), "admin");
  assert.equal(toolCapability("potassium_execute_luau_async"), "execute");
  assert.equal(toolCapability("unrecognized"), undefined);
  assert.equal(allowsTool(executePolicy, "potassium_list_children"), true);
  assert.equal(allowsTool(executePolicy, "potassium_admin_recover"), true);
  assert.equal(allowsTool(executePolicy, "potassium_execute_luau"), false);
  assert.equal(allowsTool(executePolicy, "potassium_execute_luau", { allowUnsafeExecute: true }), true);
  assert.equal(allowsTool(executePolicy, "unrecognized", { allowUnsafeExecute: true }), false);
});

test("persistent watch lifecycle requires read permission rather than execute or admin", () => {
  const readOnly = resolveHostPolicy("codex", { codex: { read: true } });
  const noRead = resolveHostPolicy("codex", { codex: { read: false, admin: true, execute: true } });
  for (const tool of ["potassium_watch_start", "potassium_watch_poll", "potassium_watch_stop"]) {
    assert.equal(allowsTool(readOnly, tool), true, `${tool} must be usable by a read-only host`);
    assert.equal(allowsTool(noRead, tool, { allowUnsafeExecute: true }), false, `${tool} must not inherit permission from execute or admin`);
  }
});

test("mixed reads and shared reference bookkeeping require read permission only", () => {
  const readOnly = resolveHostPolicy("codex", { codex: { read: true } });
  const noRead = resolveHostPolicy("codex", { codex: { read: false, admin: true, execute: true } });
  for (const tool of [
    "potassium_batch_read", "potassium_instance_references_release",
    "potassium_find_instances", "potassium_list_children", "potassium_inspect_instance",
    "potassium_code_index", "potassium_code_query",
  ]) {
    assert.equal(allowsTool(readOnly, tool), true, `${tool} must not require unsafe execution`);
    assert.equal(allowsTool(noRead, tool, { allowUnsafeExecute: true }), false, `${tool} must not inherit admin or execute permission`);
  }
});

test("async job enumeration and cancellation require both execute permission and unsafe opt-in", () => {
  const executeOnly = resolveHostPolicy("omp", { omp: { read: false, admin: false, execute: true } });
  const noExecute = resolveHostPolicy("omp", { omp: { read: true, admin: true, execute: false } });
  for (const tool of ["potassium_async_job_list", "potassium_async_job_cancel"]) {
    assert.equal(allowsTool(executeOnly, tool), false, `${tool} must honor the global unsafe-execute gate`);
    assert.equal(allowsTool(noExecute, tool, { allowUnsafeExecute: true }), false, `${tool} must not inherit permission from read or admin`);
    assert.equal(allowsTool(executeOnly, tool, { allowUnsafeExecute: true }), true, `${tool} must be usable without unrelated grants`);
  }
});

test("configured project identities do not inherit another adapter or project grants", () => {
  const policies = parseHostPolicies({
    "codex-project-a": { execute: true },
    "codex-project-b": { admin: true },
  });
  assert.deepEqual(resolveHostPolicy("codex-project-a", policies), { read: false, admin: false, execute: true });
  assert.deepEqual(resolveHostPolicy("codex-project-b", policies), { read: false, admin: true, execute: false });
  assert.deepEqual(resolveHostPolicy("codex", policies), { read: true, admin: false, execute: false });
  assert.throws(() => resolveHostPolicy("codex-project-c", policies), /unsupported MCP host/);
  assert.throws(() => resolveHostPolicy("constructor"), /unsupported MCP host/);
  assert.equal(assertHostId("project_a-1"), "project_a-1");
  for (const hostId of ["", " Project", "project ", "__proto__", "a".repeat(65), "Project", "project\n"]) {
    assert.throws(() => assertHostId(hostId), /hostId/);
  }
});

test("only the registered built-in console name receives read permission", () => {
  const readOnly = { read: true, admin: false, execute: false };
  assert.equal(allowsTool(readOnly, "potassium_builtin_read_console"), true);
  assert.equal(allowsTool(readOnly, "potassium_read_console"), false);
});

test("remote capture always requires execute permission and the independent global gate", () => {
  for (const name of ["potassium_remote_capture_start", "potassium_remote_capture_poll", "potassium_remote_capture_stop", "potassium_remote_call", "potassium_observe_action"]) {
    assert.equal(allowsTool({ read: true, admin: true, execute: false }, name, { allowUnsafeExecute: true }), false);
    assert.equal(allowsTool({ read: false, admin: false, execute: true }, name), false);
    assert.equal(allowsTool({ read: false, admin: false, execute: true }, name, { allowUnsafeExecute: true }), true);
  }
});

test("result and discovery utilities require some effective capability without granting an origin", () => {
  for (const name of ["potassium_result_read", "potassium_tool_catalog", "potassium_session_stats"]) {
    assert.equal(allowsTool({ read: false, admin: false, execute: false }, name, { allowUnsafeExecute: true }), false);
    assert.equal(allowsTool({ read: false, admin: false, execute: true }, name), false);
    assert.equal(allowsTool({ read: false, admin: false, execute: true }, name, { allowUnsafeExecute: true }), true);
    assert.equal(allowsTool({ read: false, admin: true, execute: false }, name), true);
    assert.equal(allowsTool({ read: true, admin: false, execute: false }, name), true);
  }
  assert.equal(allowsTool({ read: true, admin: false, execute: false }, "potassium_remote_inventory"), true);
});

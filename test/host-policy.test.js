import test from "node:test";
import assert from "node:assert/strict";
import {
  allowsTool,
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

test("host parsing rejects unknown hosts, fields, and non-boolean grants", () => {
  assert.throws(() => parseHostPolicies({ unknown: {} }), /unsupported host/);
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

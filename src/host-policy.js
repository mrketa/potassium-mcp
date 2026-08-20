import { HOST_IDS } from "./hosts.js";

export const POLICY_CAPABILITIES = Object.freeze(["read", "admin", "execute"]);

const DEFAULT_POLICY = Object.freeze({ read: true, admin: false, execute: false });
const KNOWN_HOSTS = new Set(HOST_IDS);
const ADMIN_TOOLS = new Set([
  "potassium_admin_status",
  "potassium_admin_history",
  "potassium_admin_recover",
]);
const EXECUTE_TOOLS = new Set([
  "potassium_execute_luau",
  "potassium_execute_luau_async",
  "potassium_async_job_status",
  "potassium_async_job_result",
  "potassium_async_job_console",
]);
const READ_TOOLS = new Set([
  "potassium_status",
  "potassium_capabilities",
  "potassium_client_state",
  "potassium_list_children",
  "potassium_inspect_instance",
  "potassium_find_instances",
  "potassium_read_properties",
  "potassium_list_tags",
  "potassium_diagnostic_snapshot",
  "potassium_script_fingerprint",
  "potassium_script_inventory",
  "potassium_remote_inventory",
  "potassium_performance_snapshot",
  "potassium_overlap_query",
  "potassium_attribute_inventory",
  "potassium_subtree_summary",
  "potassium_observe_logs",
  "potassium_spatial_query",
  "potassium_ui_inventory",
  "potassium_signal_inventory",
  "potassium_observe_changes",
  "potassium_artifact_read",
  "potassium_http_get",
  "potassium_trace_query",
  "potassium_trace_summary",
  "potassium_place_metadata",
  "potassium_snapshot_diff",
  "potassium_multi_read_properties",
  "potassium_instance_ancestry",
  "potassium_class_summary",
  "potassium_list_clients",
  "potassium_read_console",
  "potassium_builtin_status",
  "potassium_builtin_list_clients",
  "potassium_builtin_read_console",
]);
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
}

function assertKnownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name} contains unsupported key: ${key}`);
  }
}

function normalizePolicy(value, name, fallback = DEFAULT_POLICY) {
  if (value === undefined) return fallback;
  assertPlainObject(value, name);
  assertKnownKeys(value, POLICY_CAPABILITIES, name);

  const normalized = {};
  for (const capability of POLICY_CAPABILITIES) {
    const enabled = value[capability] ?? false;
    if (typeof enabled !== "boolean") throw new TypeError(`${name}.${capability} must be a boolean`);
    normalized[capability] = enabled;
  }
  return Object.freeze(normalized);
}

/** Parse a host-policy map without allowing one host's privileges to affect another. */
export function parseHostPolicies(value = undefined) {
  if (value !== undefined) {
    assertPlainObject(value, "hostPolicies");
    for (const hostId of Object.keys(value)) {
      if (!KNOWN_HOSTS.has(hostId)) throw new TypeError(`hostPolicies contains unsupported host: ${hostId}`);
    }
  }

  const normalized = {};
  for (const hostId of HOST_IDS) {
    normalized[hostId] = normalizePolicy(value?.[hostId], `hostPolicies.${hostId}`);
  }
  return Object.freeze(normalized);
}

/** Resolve one known host policy, rejecting unknown proxy identities. */
export function resolveHostPolicy(hostId, policies = undefined) {
  if (typeof hostId !== "string" || !KNOWN_HOSTS.has(hostId)) {
    throw new TypeError(`unsupported MCP host: ${String(hostId)}`);
  }
  return parseHostPolicies(policies)[hostId];
}

/** Parse HTTP's independent policy; it never inherits a proxy host's privileges. */
export function parseHttpPolicy(value = undefined) {
  return normalizePolicy(value, "httpPolicy");
}

/** Build the immutable, transport-neutral policy set consumed by broker and server layers. */
export function parsePolicyConfig({ hostPolicies = undefined, httpPolicy = undefined } = {}) {
  return Object.freeze({
    hosts: parseHostPolicies(hostPolicies),
    http: parseHttpPolicy(httpPolicy),
  });
}

export function hasCapability(policy, capability) {
  if (!POLICY_CAPABILITIES.includes(capability)) {
    throw new TypeError(`unsupported policy capability: ${String(capability)}`);
  }
  return policy?.[capability] === true;
}

/** Return the sole capability required for a registered policy-controlled tool. */
export function toolCapability(toolName) {
  if (EXECUTE_TOOLS.has(toolName)) return "execute";
  if (ADMIN_TOOLS.has(toolName)) return "admin";
  if (READ_TOOLS.has(toolName)) return "read";
  return undefined;
}

/**
 * Determine whether a policy may expose a registered tool. Execute tools require
 * both the per-transport execute bit and the independent global unsafe opt-in.
 */
export function allowsTool(policy, toolName, { allowUnsafeExecute = false } = {}) {
  const capability = toolCapability(toolName);
  if (capability === undefined) return false;
  if (capability === "execute") return allowUnsafeExecute === true && hasCapability(policy, capability);
  return hasCapability(policy, capability);
}

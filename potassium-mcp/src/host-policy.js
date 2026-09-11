import { HOST_IDS } from "./hosts.js";

export const POLICY_CAPABILITIES = Object.freeze(["read", "admin", "execute"]);

const DEFAULT_POLICY = Object.freeze({ read: true, admin: false, execute: false });
const KNOWN_HOSTS = new Set(HOST_IDS);

export function assertHostId(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(value)) {
    throw new TypeError("hostId must be 1-64 lowercase letters, digits, underscores, or hyphens, starting with a letter");
  }
  return value;
}
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
  "potassium_async_job_list",
  "potassium_async_job_cancel",
  "potassium_remote_capture_start",
  "potassium_remote_capture_poll",
  "potassium_remote_capture_stop",
  "potassium_remote_call",
  "potassium_observe_action",
]);
const READ_TOOLS = new Set([
  "potassium_status",
  "potassium_capabilities",
  "potassium_client_state",
  "potassium_game_context",
  "potassium_map_context",
  "potassium_map_geometry",
  "potassium_map_navigation",
  "potassium_map_motion",
  "potassium_map_mechanics",
  "potassium_map_recording",
  "potassium_map_recording_read",
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
  "potassium_watch_start",
  "potassium_watch_poll",
  "potassium_watch_stop",
  "potassium_artifact_read",
  "potassium_http_get",
  "potassium_trace_query",
  "potassium_trace_summary",
  "potassium_place_metadata",
  "potassium_snapshot_diff",
  "potassium_multi_read_properties",
  "potassium_batch_read",
  "potassium_instance_references_release",
  "potassium_instance_ancestry",
  "potassium_class_summary",
  "potassium_list_clients",
  "potassium_builtin_status",
  "potassium_builtin_list_clients",
  "potassium_builtin_read_console",
  "potassium_code_index",
  "potassium_code_query",
]);
const UTILITY_TOOLS = new Set(["potassium_result_read", "potassium_tool_catalog", "potassium_session_stats"]);
export const TOOL_NAMES = Object.freeze([...ADMIN_TOOLS, ...EXECUTE_TOOLS, ...READ_TOOLS, ...UTILITY_TOOLS]);
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
    const enabled = value[capability] === undefined ? false : value[capability];
    if (typeof enabled !== "boolean") throw new TypeError(`${name}.${capability} must be a boolean`);
    normalized[capability] = enabled;
  }
  return Object.freeze(normalized);
}

/** Parse a host-policy map without allowing one host's privileges to affect another. */
export function parseHostPolicies(value = undefined) {
  if (value !== undefined) {
    assertPlainObject(value, "hostPolicies");
    for (const hostId of Object.keys(value)) assertHostId(hostId);
  }

  return Object.freeze(Object.fromEntries(
    [...new Set([...HOST_IDS, ...Object.keys(value ?? {})])].map((hostId) => [
      hostId, normalizePolicy(value && Object.hasOwn(value, hostId) ? value[hostId] : undefined, `hostPolicies.${hostId}`),
    ]),
  ));
}

/** Resolve a built-in or explicitly configured host; the shared token trusts its launcher identity. */
export function resolveHostPolicy(hostId, policies = undefined) {
  assertHostId(hostId);
  if (!KNOWN_HOSTS.has(hostId) && !(policies && Object.hasOwn(policies, hostId))) {
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

/** Return the required capability, or utility for tools usable with any effective grant. */
export function toolCapability(toolName) {
  if (EXECUTE_TOOLS.has(toolName)) return "execute";
  if (ADMIN_TOOLS.has(toolName)) return "admin";
  if (READ_TOOLS.has(toolName)) return "read";
  if (UTILITY_TOOLS.has(toolName)) return "utility";
  return undefined;
}

/**
 * Determine whether a policy may expose a registered tool. Execute tools require
 * both the per-transport execute bit and the independent global unsafe opt-in.
 */
export function allowsTool(policy, toolName, { allowUnsafeExecute = false } = {}) {
  const capability = toolCapability(toolName);
  if (capability === undefined) return false;
  if (capability === "utility") {
    return hasCapability(policy, "read") || hasCapability(policy, "admin")
      || (allowUnsafeExecute === true && hasCapability(policy, "execute"));
  }
  if (capability === "execute") return allowUnsafeExecute === true && hasCapability(policy, capability);
  return hasCapability(policy, capability);
}

import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

const MAX_TOOLS = 128;
const MAX_SCAN_KEYS = 64;
const MAX_SCAN_NODES = 256;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_BYTES = 16384;
const MAX_SCAN_STRING = 4096;
const MAX_SCAN_FIELDS = 64;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const UNKNOWN_TOOL = "unknown";
const SCAN_TOOLS = new Set([
  "potassium_list_children", "potassium_inspect_instance", "potassium_find_instances",
  "potassium_read_properties", "potassium_multi_read_properties", "potassium_batch_read",
  "potassium_list_tags", "potassium_diagnostic_snapshot", "potassium_script_fingerprint",
  "potassium_script_inventory", "potassium_remote_inventory", "potassium_performance_snapshot",
  "potassium_overlap_query", "potassium_attribute_inventory", "potassium_subtree_summary",
  "potassium_spatial_query", "potassium_ui_inventory", "potassium_signal_inventory",
  "potassium_trace_query", "potassium_trace_summary", "potassium_instance_ancestry",
  "potassium_class_summary", "potassium_code_query",
]);

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function add(value, amount = 1) {
  return Math.min(MAX_COUNTER, value + amount);
}

function counters() {
  return {
    calls: 0, errors: 0, resultBytes: 0, compactResponses: 0, detailReads: 0,
    repeatedScanRequests: 0, inFlight: 0, totalDurationMs: 0, maxDurationMs: 0,
  };
}

// Over-budget or non-JSON selections are excluded, never truncated into false
// matches. Canonical fragments are consumed immediately; only salted keys live
// beyond begin(). This measures repeated requests, not redundant work/cache hits.
function scanKey(toolName, args, salt) {
  const hash = createHash("sha256").update(salt).update(toolName).update("\0");
  const active = new WeakSet();
  let nodes = 0;
  let bytes = 0;
  function fragment(text) {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_SCAN_BYTES) throw new RangeError("Scan byte limit");
    hash.update(text);
  }
  function visit(value, depth) {
    if (++nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) throw new RangeError("Scan shape limit");
    if (value === null || typeof value === "boolean") return fragment(JSON.stringify(value));
    if (typeof value === "number" && Number.isFinite(value)) return fragment(JSON.stringify(value));
    if (typeof value === "string") {
      if (value.length > MAX_SCAN_STRING) throw new RangeError("Scan string limit");
      return fragment(JSON.stringify(value));
    }
    if (typeof value !== "object" || active.has(value)) throw new TypeError("Scan selection is not JSON");
    active.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_SCAN_NODES - nodes) throw new RangeError("Scan array limit");
      fragment("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) fragment(",");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Scan array is not JSON");
        visit(descriptor.value, depth + 1);
      }
      fragment("]");
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Scan object is not JSON");
      const keys = [];
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (keys.length >= MAX_SCAN_FIELDS || key.length > MAX_SCAN_STRING) throw new RangeError("Scan field limit");
        keys.push(key);
      }
      keys.sort();
      fragment("{");
      let first = true;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Scan object is not JSON");
        // Optional validated fields have the same meaning as omission.
        if (descriptor.value === undefined) continue;
        if (!first) fragment(",");
        first = false;
        fragment(JSON.stringify(key));
        fragment(":");
        visit(descriptor.value, depth + 1);
      }
      fragment("}");
    }
    active.delete(value);
  }
  try {
    visit(args === undefined ? {} : args, 0);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/** Aggregate metadata for admitted calls in one host-owned MCP scope. */
export function createSessionStats({ clock = performance, maxTools = MAX_TOOLS, maxScanKeys = MAX_SCAN_KEYS, toolNames = [] } = {}) {
  boundedInteger(maxTools, 1, MAX_TOOLS, "maxTools");
  boundedInteger(maxScanKeys, 0, MAX_SCAN_KEYS, "maxScanKeys");
  if (typeof clock?.now !== "function") throw new TypeError("Statistics clock must provide now()");
  if (!Array.isArray(toolNames) || toolNames.length > MAX_TOOLS
    || Array.from(toolNames).some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(name))) {
    throw new TypeError("toolNames must be a bounded array of registered tool names");
  }
  const registered = new Set([...new Set(toolNames)].filter((name) => name !== UNKNOWN_TOOL).sort().slice(0, maxTools - 1));
  const perTool = new Map();
  const scanKeys = new Map();
  let totals = counters();
  let protocolErrors = 0;
  let salt = randomBytes(32);
  let generation = Symbol();

  function now() {
    const value = clock.now();
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(MAX_COUNTER, value)) : 0;
  }

  // Defined outside begin's activation so outstanding finish functions cannot
  // keep its args or canonicalization temporaries alive.
  function completion(row, startedAt, epoch) {
    let finished = false;
    return function finish(result) {
      if (finished) return;
      finished = true;
      if (epoch !== generation) return;
      let resultBytes = 0;
      let error = result?.isError === true;
      try {
        resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      } catch {
        // A malformed logical result has no measurable serialized payload.
        error = true;
      }
      const durationMs = Math.floor(Math.max(0, now() - startedAt));
      const compact = result?.structuredContent?.kind === "potassium/result";
      for (const target of [totals, row]) {
        target.inFlight = Math.max(0, target.inFlight - 1);
        target.resultBytes = add(target.resultBytes, resultBytes);
        target.totalDurationMs = add(target.totalDurationMs, durationMs);
        target.maxDurationMs = Math.max(target.maxDurationMs, durationMs);
        if (error) target.errors = add(target.errors);
        if (compact) target.compactResponses = add(target.compactResponses);
      }
    };
  }

  return {
    begin(toolName, args) {
      const startedAt = now();
      const known = registered.has(toolName);
      const name = known ? toolName : UNKNOWN_TOOL;
      let row = perTool.get(name);
      if (!row) {
        row = counters();
        perTool.set(name, row);
      }
      for (const target of [totals, row]) {
        target.calls = add(target.calls);
        target.inFlight = add(target.inFlight);
        if (known && toolName === "potassium_result_read") target.detailReads = add(target.detailReads);
      }
      if (known && maxScanKeys > 0 && SCAN_TOOLS.has(toolName)
        && !(toolName === "potassium_code_query" && args?.view === "release")) {
        const key = scanKey(toolName, args, salt);
        if (key !== undefined) {
          if (scanKeys.has(key)) {
            totals.repeatedScanRequests = add(totals.repeatedScanRequests);
            row.repeatedScanRequests = add(row.repeatedScanRequests);
            scanKeys.delete(key);
          } else if (scanKeys.size >= maxScanKeys) {
            scanKeys.delete(scanKeys.keys().next().value);
          }
          scanKeys.set(key, true);
        }
      }
      return completion(row, startedAt, generation);
    },

    recordProtocolError() {
      protocolErrors = add(protocolErrors);
    },

    snapshot() {
      return {
        ...totals, protocolErrors,
        perTool: [...perTool.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([toolName, row]) => ({ toolName, ...row })),
      };
    },

    clear() {
      generation = Symbol();
      totals = counters();
      protocolErrors = 0;
      perTool.clear();
      scanKeys.clear();
      salt.fill(0);
      salt = randomBytes(32);
    },
  };
}

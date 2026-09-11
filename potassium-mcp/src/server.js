import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PotassiumBridge } from "./bridge.js";
import { AdminAuditRecorder } from "./admin-audit.js";
import {
  getAllowedHttps,
  getPlaceMetadata,
  queryTrace,
  readArtifact,
  summarizeTrace,
} from "./safe-read.js";
import { allowsTool, parsePolicyConfig, toolCapability, TOOL_NAMES } from "./host-policy.js";
import { resolveConfigPath } from "./paths.js";
import { RequestIdTransport } from "./request-id-transport.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { COMPACT_RESULT_INLINE_BYTES, createCompactResultStore } from "./compact-results.js";
import { createCodeIndexService } from "./code-index.js";
import { createGameContextService, gameContextInputSchema, gameContextOutputSchema } from "./game-context.js";
import { createMapContextService } from "./map-context.js";
import { createMapRecordingService } from "./map-recording.js";
import {
  mapRecordingInputSchema, mapRecordingOutputSchema, mapRecordingReadInputSchema, mapRecordingReadOutputSchema,
} from "./map-recording-schemas.js";
import {
  mapContextInputSchema, mapContextOutputSchema, mapGeometryInputSchema, mapGeometryOutputSchema,
  mapNavigationInputSchema, mapNavigationOutputSchema, mapMotionInputSchema, mapMotionOutputSchema,
  mapMechanicsInputSchema, mapMechanicsOutputSchema,
} from "./map-schemas.js";
import { imageDimensions } from "./game-context-images.js";
import { createSessionStats } from "./session-stats.js";


const here = dirname(fileURLToPath(import.meta.url));
export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url, canonicalize = realpathSync) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return canonicalize(argvPath) === canonicalize(modulePath);
  } catch {
    return resolve(argvPath) === resolve(modulePath);
  }
}
export function commandConfigPath(argv = process.argv.slice(2)) {
  const indices = argv.reduce((found, value, index) => value === "--config" ? [...found, index] : found, []);
  if (indices.length === 0) return undefined;
  if (indices.length !== 1) throw new Error("--config may be specified only once");
  const index = indices[0];
  if (index === argv.length - 1 || argv[index + 1].startsWith("--")) throw new Error("--config requires a path");
  return resolve(argv[index + 1]);
}
const loopbackHosts = ["127.0.0.1", "::1"];

export const configSchema = z.object({
  host: z.enum(loopbackHosts),
  port: z.number().int().min(0).max(65535),
  token: z.string().min(32).max(4096).optional(),
  tokenFile: z.string().min(1).max(4096).optional(),
  requestTimeoutMs: z.number().int().min(1).max(120000),
  maxMessageBytes: z.number().int().min(1024).max(16 * 1024 * 1024),
  maxPendingRequests: z.number().int().min(1).max(1024),
  shutdownGraceMs: z.number().int().min(100).max(30000),
  proxyHost: z.enum(loopbackHosts).optional(),
  proxyPort: z.number().int().min(0).max(65535).default(32146),
  proxyMaxFrameBytes: z.number().int().min(16 * 1024).max(16 * 1024 * 1024).default(1024 * 1024),
  proxyHandshakeTimeoutMs: z.number().int().min(100).max(30000).default(5000),
  streamableHttpEnabled: z.boolean().default(false),
  statefulHttpEnabled: z.boolean().default(false),
  streamableHttpHost: z.enum(loopbackHosts).default("127.0.0.1"),
  streamableHttpPort: z.number().int().min(0).max(65535).default(32147),
  artifactRoots: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    path: z.string().min(1).max(4096),
    recursive: z.boolean().default(false),
    extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,16}$/i)).min(1).max(16),
  }).strict()).max(16).default([]),
  sourceRoots: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}(?![\s\S])/),
    path: z.string().min(1).max(4096),
    recursive: z.boolean().default(false),
    extensions: z.array(z.enum([".lua", ".luau"])).min(1).max(2).default([".lua", ".luau"]),
  }).strict()).max(16).default([]),
  httpAllowedHosts: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i)).max(32).default([]),
  adminAuditPath: z.string().min(1).max(4096).optional(),
  allowUnsafeExecute: z.boolean().default(false),
  hostPolicies: z.record(z.string(), z.object({
    read: z.boolean().optional(),
    admin: z.boolean().optional(),
    execute: z.boolean().optional(),
  }).strict()).optional(),
  httpPolicy: z.object({
    read: z.boolean().optional(),
    admin: z.boolean().optional(),
    execute: z.boolean().optional(),
  }).strict().optional(),
  builtinFallbackEnabled: z.boolean().default(false),
  builtinFallbackTokenFile: z.string().min(1).max(4096).optional(),
}).strict().superRefine((config, context) => {
  if ((config.token === undefined) === (config.tokenFile === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Specify exactly one of token or tokenFile",
      path: ["token"],
    });
  }
  if (new Set(config.artifactRoots.map(({ name }) => name)).size !== config.artifactRoots.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Artifact root names must be unique",
      path: ["artifactRoots"],
    });
  }
  if (new Set(config.sourceRoots.map(({ name }) => name)).size !== config.sourceRoots.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source root names must be unique", path: ["sourceRoots"] });
  }
  for (const [index, root] of config.sourceRoots.entries()) {
    if (new Set(root.extensions).size !== root.extensions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Source root extensions must be unique", path: ["sourceRoots", index, "extensions"] });
    }
  }
  if (new Set(config.httpAllowedHosts.map((host) => host.toLowerCase())).size !== config.httpAllowedHosts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "HTTP allowed hosts must be unique",
      path: ["httpAllowedHosts"],
    });
  }
  try {
    parsePolicyConfig(config);
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: ["hostPolicies"] });
  }
  if (config.builtinFallbackEnabled && !config.builtinFallbackTokenFile) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "builtinFallbackTokenFile is required when builtinFallbackEnabled", path: ["builtinFallbackTokenFile"] });
  }
  if (config.streamableHttpEnabled || config.statefulHttpEnabled) {
    const endpoints = [
      ["executor", config.host, config.port],
      ["proxy", config.proxyHost ?? config.host, config.proxyPort],
    ];
    for (const [name, host, port] of endpoints) {
      if (host === config.streamableHttpHost && port === config.streamableHttpPort && port !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Streamable HTTP endpoint must not share the ${name} endpoint`,
          path: ["streamableHttpPort"],
        });
      }
    }
  }
});

// Canonical normalized payload is independent of client-specific presentation.
const canonicalResultJson = new WeakMap();
const resultImages = new WeakMap();

export function formatToolResult(value) {
  let text, normalized;
  try {
    text = JSON.stringify(value);
    if (text === undefined) text = '{"value":null}';
    normalized = JSON.parse(text);
  } catch {
    return toolError(Object.assign(new Error("Result could not be serialized; the operation may already have completed."), { code: "RESULT_INVALID" }));
  }
  const result = {
    content: [{ type: "text", text }],
    structuredContent: normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)
      ? normalized : { value: normalized },
  };
  canonicalResultJson.set(result, text);
  return result;
}

const sourceErrorCodes = new Set([
  "CODE_INVALID_INPUT", "CODE_SOURCE_UNAVAILABLE", "CODE_SOURCE_IDENTITY", "CODE_SOURCE_DENIED",
  "CODE_SOURCE_TOO_LARGE", "CODE_HASH_MISMATCH", "CODE_PARSE_RESULT_INVALID", "CODE_STORE_CAPACITY",
  "CODE_STORE_UNAVAILABLE", "CODE_NOT_FOUND", "CODE_ORIGIN_DENIED", "CODE_INVALID_CURSOR",
  "CODE_CANCELLED", "CODE_SOURCE_DISPLAY_UNAVAILABLE",
  "PARSER_INPUT_LIMIT", "PARSER_INVALID_INPUT", "PARSER_ASSET_INVALID", "PARSER_PARSE_FAILED",
  "PARSER_OUTPUT_LIMIT", "PARSER_WORKER_FAILED", "PARSER_BACKEND_UNAVAILABLE", "PARSER_CANCELLED",
  "PARSER_INPUT_INVALID", "PARSER_INPUT_TIMEOUT", "PARSER_PROTOCOL_ERROR", "PARSER_HOST_TIMEOUT",
  "PARSER_HOST_ARGUMENTS", "PARSER_WALL_LIMIT", "PARSER_CPU_LIMIT", "PARSER_WORKER_EXIT", "PARSER_CLEANUP_FAILED",
  "PARSER_TREE_INVALID",
]);
const mapErrorCodePattern = /^MAP_CONTEXT_(?:UNAVAILABLE|INVALID_INPUT|INVALID_DATA|STORAGE|BUSY|CANCELLED|NOT_FOUND|CLIENT_CHANGED|SOURCE_UNAVAILABLE|IMAGE_UNAVAILABLE|LIMIT)$/;
const recordingErrorCodePattern = /^MAP_RECORDING_(?:UNAVAILABLE|INVALID_INPUT|INVALID_DATA|STORAGE|BUSY|CANCELLED|NOT_FOUND|CLIENT_CHANGED|SOURCE_UNAVAILABLE|LIMIT|NOT_TERMINAL|TERMINAL)$/;
function nativeMapErrorCode(error) {
  if (typeof error?.code === "string" && (mapErrorCodePattern.test(error.code) || recordingErrorCodePattern.test(error.code))) return error.code;
  const prefix = typeof error?.message === "string" ? /^(MAP_(?:CONTEXT|RECORDING)_[A-Z_]+)(?::|$)/.exec(error.message)?.[1] : undefined;
  return prefix && (mapErrorCodePattern.test(prefix) || recordingErrorCodePattern.test(prefix)) ? prefix : undefined;
}

function errorCode(error) {
  if (sourceErrorCodes.has(error?.code) || error?.code === "INVALID_INPUT") return error.code;
  if (typeof error?.code === "string" && /^GAME_CONTEXT_(?:UNAVAILABLE|STORAGE|INVALID_INPUT|INVALID_DATA|BUSY|CANCELLED|CLIENT_CHANGED|NOT_FOUND|IMAGE_UNAVAILABLE|SECTION_UNAVAILABLE)$/.test(error.code)) return error.code;
  const mapCode = nativeMapErrorCode(error);
  if (mapCode) return mapCode;
  if (typeof error?.code === "string" && /^(?:RESULT_(?:INVALID|LIMIT|UNAVAILABLE|NOT_FOUND|ORIGIN_DENIED|INVALID_INPUT|INVALID_POINTER|INVALID_OFFSET|PAGE_TOO_SMALL|TOO_LARGE|STORE_CAPACITY|INVALID_JSON|STORE_UNAVAILABLE)|INCOMPATIBLE_CLIENT|CLIENT_CHANGED|AUDIT_FAILED|ARTIFACT_FAILED|QUEUE_TIMEOUT|TIMEOUT|DRAINING|TARGET_UNAVAILABLE|CAPACITY|CANCELLED)$/.test(error.code)) return error.code;
  if (error?.submissionIndeterminate === true) return "SUBMISSION_INDETERMINATE";
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Instance not found at segment: ") || message === "Instance reference unavailable") return "TARGET_UNAVAILABLE";
  if (/not connected|not found.*client|unknown.*client/i.test(message)) return "NO_CLIENT";
  if (/multiple.*client|specify.*clientId|select.*clientId|client selection required/i.test(message)) return "AMBIGUOUS_CLIENT";
  if (message.startsWith("UNSUPPORTED")) return "UNSUPPORTED";
  if (message === "Tool is not permitted by the session policy"
    || /^(?:MCP error -\d+: )?Tool [\s\S]+ (?:not found|disabled)$/.test(message)) return "POLICY_DENIED";
  if (/recover/i.test(message)) return "RECOVERY_REQUIRED";
  if (/queue.*timed out|timed out.*queue/i.test(message)) return "QUEUE_TIMEOUT";
  if (/timed out/i.test(message)) return "TIMEOUT";
  if (/cancel|abort/i.test(message)) return "CANCELLED";
  if (/capacity|request limit|busy/i.test(message)) return "CAPACITY";
  if (/Input validation|must |invalid|Provide exactly|requires/i.test(message)) return "INVALID_INPUT";
  return "REQUEST_FAILED";
}

export function asyncSubmissionToolError(error) {
  return toolError(error);
}

function toolError(error, context = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const details = { code: errorCode(error), message };
  if (typeof error?.submissionIndeterminate === "boolean") details.submissionIndeterminate = error.submissionIndeterminate;
  const payload = { ...context, error: details };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    _meta: payload,
  };
}

const objectOutputSchema = z.object({}).catchall(z.unknown());
const identifiedOutputSchemas = new WeakMap();

function identifyOutputSchema(schema) {
  const cached = identifiedOutputSchemas.get(schema);
  if (cached) return cached;
  const source = typeof schema.meta === "function" ? schema : z.object(schema);
  // Match the pinned SDK's public Zod conversion and metadata-clone semantics.
  const wireSchema = z.toJSONSchema(source.meta({}), { target: "draft-7", io: "output" });
  delete wireSchema.$id;
  const canonical = JSON.stringify(wireSchema, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  // $id is JSON Schema metadata, not a strongly registered Zod registry id.
  const identified = source.meta({ $id: `urn:potassium:mcp:output-schema:sha256:${digest}` });
  identifiedOutputSchemas.set(schema, identified);
  return identified;
}

const resourceIdOutput = z.string().regex(/^[a-f0-9]{32}(?![\s\S])/);
const contextIdOutput = z.string().regex(/^gc-[a-f0-9]{32}(?![\s\S])/);
const contextAcceptanceOutput = z.object({
  view: z.literal("capture"), contextId: contextIdOutput, accepted: z.literal(true),
  capturedAt: z.string().datetime(), warning: z.string(),
}).strict();
const mapIdOutput = z.string().regex(/^map-[a-f0-9]{32}(?![\s\S])/);
const mapWriteViews = new Set(["build", "update", "observe", "probe"]);
const offlineMapTools = new Set(["potassium_map_geometry", "potassium_map_navigation", "potassium_map_motion", "potassium_map_mechanics"]);
const recordingTools = new Set(["potassium_map_recording", "potassium_map_recording_read"]);
const mapTools = new Set(["potassium_map_context", ...recordingTools, ...offlineMapTools]);
const isMapWrite = (name, view) => name === "potassium_map_context" ? mapWriteViews.has(view)
  : name === "potassium_map_mechanics" && view === "apply";
const mapAcceptanceOutput = z.object({
  mapId: mapIdOutput, revision: z.number().int().positive(), accepted: z.literal(true), warning: z.string(),
}).strict();
const recordingStateOutput = z.enum(["accepted", "starting", "recording", "stopped", "failed"]);
const recordingAcceptanceOutput = z.object({
  operation: z.literal("start"), recordingId: resourceIdOutput, state: recordingStateOutput,
  ready: z.boolean(), receivedAt: z.iso.datetime(), accepted: z.literal(true), warning: z.string(),
}).strict();
const recordingSaveAcceptanceOutput = z.object({
  operation: z.literal("save"), mapId: mapIdOutput, revision: z.number().int().positive(),
  recordingId: resourceIdOutput, released: z.boolean().optional(), accepted: z.literal(true), warning: z.string(),
}).strict();
function recordingAcceptance(result) {
  if (result.operation === "save") return {
    operation: "save", mapId: result.mapId, revision: result.revision, recordingId: result.recordingId,
    ...(result.released === undefined ? {} : { released: result.released }), accepted: true,
  };
  return {
    operation: "start", recordingId: result.metadata.recordingId, state: result.metadata.state,
    ready: result.metadata.ready, receivedAt: result.receivedAt, accepted: true,
  };
}
const compactDescriptorOutput = z.object({
  kind: z.literal("potassium/result"), resultId: resourceIdOutput, toolName: z.string().min(1).max(128),
  bytes: z.number().int().positive().max(1048576), sha256: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  expiresAt: z.string().datetime(), summary: z.object({
    type: z.enum(["null", "boolean", "number", "string", "array", "object"]),
  }).passthrough(),
  contextId: contextIdOutput.optional(), capturedAt: z.string().datetime().optional(), accepted: z.literal(true).optional(),
  mapId: mapIdOutput.optional(), revision: z.number().int().positive().optional(),
}).passthrough();
const resultPageOutput = z.object({
  resultId: resourceIdOutput, toolName: z.string(), pointer: z.string(),
  offsetBytes: z.number().int().nonnegative(), nextOffsetBytes: z.number().int().nonnegative(),
  hasMore: z.boolean(), totalBytes: z.number().int().nonnegative(), text: z.string(),
}).strict();
const selectedResultPageOutput = z.object({
  resultId: resourceIdOutput, toolName: z.string(),
  selections: z.array(z.discriminatedUnion("kind", [
    z.object({ pointer: z.string(), kind: z.literal("value"), value: z.unknown() }).strict(),
    z.object({
      pointer: z.string(), kind: z.literal("text"), text: z.string(),
      offsetBytes: z.number().int().nonnegative(), nextOffsetBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(), hasMore: z.boolean(),
    }).strict(),
    z.object({
      pointer: z.string(), kind: z.literal("pending"),
      nextOffsetBytes: z.number().int().nonnegative(), hasMore: z.literal(true),
    }).strict(),
  ])).min(1).max(8),
  hasMore: z.boolean(),
}).strict();
const compactOutputSchemas = new WeakMap();
const outputUnionBranches = new WeakMap();

const schemaMaps = ["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"];
const schemaChildren = ["items", "additionalItems", "additionalProperties", "anyOf", "allOf", "oneOf", "not", "contains", "if", "then", "else", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "prefixItems"];

function mapSchemaNodes(node, visit) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => mapSchemaNodes(child, visit));
  for (const key of schemaMaps) {
    if (node[key]) for (const name of Object.keys(node[key])) node[key][name] = mapSchemaNodes(node[key][name], visit);
  }
  for (const key of schemaChildren) if (Object.hasOwn(node, key)) node[key] = mapSchemaNodes(node[key], visit);
  if (node.dependencies) {
    for (const name of Object.keys(node.dependencies)) {
      if (!Array.isArray(node.dependencies[name])) node.dependencies[name] = mapSchemaNodes(node.dependencies[name], visit);
    }
  }
  // default/examples/const/enum and property-name maps are data, never schemas.
  return visit(node);
}

function compactWireSchema(wire, { pointerRefs = false } = {}) {
  const originalDefinitions = wire.definitions ?? {};
  let scoped = false;
  mapSchemaNodes(wire, (node) => {
    if ((node !== wire && (node.$id !== undefined || node.$anchor !== undefined || node.id !== undefined))
      || (node.$ref !== undefined && (!node.$ref.startsWith("#/definitions/")
        || !Object.hasOwn(originalDefinitions, node.$ref.slice(14))))) scoped = true;
    return node;
  });
  // Do not reinterpret local identifiers, external refs, or other dialect scopes.
  if (scoped) return wire;
  const names = new Map(Object.keys(originalDefinitions).map((name, index) => [name, index.toString(36)]));
  const definitions = Object.fromEntries(Object.entries(originalDefinitions).map(([name, schema]) => [names.get(name), schema]));
  wire.definitions = definitions;
  mapSchemaNodes(wire, (node) => {
    if (node.$ref) node.$ref = `#/definitions/${names.get(node.$ref.slice(14))}`;
    if (Object.keys(node).length === 1 && (node.allOf?.length === 1 || node.anyOf?.length === 1)) {
      return (node.allOf ?? node.anyOf)[0];
    }
    if (node.additionalProperties === true) delete node.additionalProperties;
    if (node.minLength === 0) delete node.minLength;
    if (node.minItems === 0) delete node.minItems;
    if (node.required?.length === 0) delete node.required;
    const matchesType = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value) === node.type
      || (node.type === "integer" && Number.isInteger(value));
    if ((Object.hasOwn(node, "const") && matchesType(node.const))
      || (node.enum?.length > 0 && node.enum.every(matchesType))) delete node.type;
    return node;
  });
  for (const [name, schema] of Object.entries(definitions)) {
    const reference = `#/definitions/${name}`;
    let uses = 0, hasSiblings = false, recursive = false;
    mapSchemaNodes(wire, (node) => {
      if (node.$ref === reference) { uses += 1; if (Object.keys(node).length !== 1) hasSiblings = true; }
      return node;
    });
    mapSchemaNodes(schema, (node) => { if (node.$ref) recursive = true; return node; });
    // Inline leaves when cheaper, including single-use definitions. Keep recursive graphs intact.
    if (!hasSiblings && !recursive && (uses === 1 || JSON.stringify(schema).length <= JSON.stringify({ $ref: reference }).length)) {
      delete definitions[name];
      mapSchemaNodes(wire, (node) => node.$ref === reference ? structuredClone(schema) : node);
    }
  }
  const groups = new Map();
  const minimumReferenceBytes = JSON.stringify({ $ref: pointerRefs ? "#/definitions/0" : "#d0" }).length;
  mapSchemaNodes(wire, (node) => {
    if (node !== wire && !node.$ref) {
      const key = JSON.stringify(node);
      if (key.length > minimumReferenceBytes) {
        const group = groups.get(key) ?? [];
        group.push(node);
        groups.set(key, group);
      }
    }
    return node;
  });
  let nextName = 0;
  // Extract children first so shared parents retain their already compact descendants.
  for (const [, group] of [...groups].sort(([left], [right]) => left.length - right.length)) {
    if (group.length < 2) continue;
    const json = JSON.stringify(group[0]);
    let name;
    do { name = (nextName++).toString(36); } while (Object.hasOwn(definitions, name));
    const fragment = pointerRefs ? `#/definitions/${name}` : `#d${name}`;
    const reference = { $ref: fragment };
    const referenceBytes = JSON.stringify(reference).length;
    const definition = pointerRefs ? JSON.parse(json) : { ...JSON.parse(json), $id: fragment };
    // Factor only when the chosen reference syntax saves its complete definition cost.
    if ((json.length - referenceBytes) * group.length <= JSON.stringify(definition).length + name.length + 4) continue;
    definitions[name] = definition;
    for (const node of group) {
      for (const key of Object.keys(node)) delete node[key];
      Object.assign(node, reference);
    }
  }
  // Outputs support short fragment IDs; input consumers require local JSON Pointers.
  if (!pointerRefs) {
    const fragments = new Map();
    for (const [name, schema] of Object.entries(definitions)) {
      if (schema && typeof schema === "object") {
        const fragment = `#d${name}`;
        schema.$id = fragment;
        fragments.set(`#/definitions/${name}`, fragment);
      }
    }
    mapSchemaNodes(wire, (node) => {
      if (fragments.has(node.$ref)) node.$ref = fragments.get(node.$ref);
      return node;
    });
  }
  if (Object.keys(definitions).length === 0) delete wire.definitions;
  return wire;
}

function compactInputSchema(original) {
  const source = typeof original?.meta === "function" ? original : z.object(original);
  const wire = compactWireSchema(z.toJSONSchema(source, { target: "draft-7", io: "input", reused: "ref" }), { pointerRefs: true });
  if (wire.$id === undefined && wire.id === undefined) {
    const canonical = JSON.stringify(wire, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
    });
    wire.$id = `urn:potassium:in:${createHash("sha256").update(canonical).digest("hex")}`;
  }
  // Metadata changes only the SDK's advertised JSON Schema. The original Zod
  // object retains its strict keys, refinements, defaults, and runtime parser.
  return source.meta(wire);
}

function objectUnionOutput(schemas) {
  // Compose canonical Zod branches, not metadata containing root-relative refs.
  const branches = z.union(schemas.map((schema) => outputUnionBranches.get(schema) ?? schema));
  const wire = compactWireSchema(z.toJSONSchema(branches, { target: "draft-7", io: "output", reused: "ref" }));
  // The SDK normalizes only object roots. Retain both runtime and wire branches.
  const schema = z.object({}).passthrough().superRefine(async (value, context) => {
    if (!(await branches.safeParseAsync(value)).success) {
      context.addIssue({ code: "custom", message: "Invalid result envelope" });
    }
  }).meta({ anyOf: wire.anyOf, ...(wire.definitions ? { definitions: wire.definitions } : {}) });
  outputUnionBranches.set(schema, branches);
  return schema;
}

function compactOutputSchema(original) {
  if (original === objectOutputSchema) return original;
  const cached = compactOutputSchemas.get(original);
  if (cached) return cached;
  const schema = objectUnionOutput([
    original, compactDescriptorOutput, ...(original === gameContextOutputSchema ? [contextAcceptanceOutput] : []),
    ...(original === mapContextOutputSchema || original === mapMechanicsOutputSchema ? [mapAcceptanceOutput] : []),
    ...(original === mapRecordingOutputSchema ? [recordingAcceptanceOutput, recordingSaveAcceptanceOutput] : []),
  ]);
  compactOutputSchemas.set(original, schema);
  return schema;
}

function acceptedJobFallback(result, warning = "RESULT_FORMAT_FAILED") {
  return formatToolResult({
    jobId: result.jobId, ...(jobStateOutput.safeParse(result.state).success ? { state: result.state } : {}),
    accepted: true, warning,
  });
}
function acceptedContextFallback(result, warning = "RESULT_FORMAT_FAILED") {
  return formatToolResult({
    view: "capture", contextId: result.contextId, capturedAt: result.capturedAt, accepted: true, warning,
  });
}
function acceptedMapFallback(result, warning = "RESULT_FORMAT_FAILED") {
  return formatToolResult({ mapId: result.mapId, revision: result.revision, accepted: true, warning });
}
function acceptedRecordingFallback(result, warning = "RESULT_FORMAT_FAILED") {
  return formatToolResult({ ...recordingAcceptance(result), warning });
}
const jobStateOutput = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const jobOutput = z.object({ jobId: resourceIdOutput, state: jobStateOutput }).passthrough();
const acceptanceOutput = z.object({
  jobId: resourceIdOutput, state: jobStateOutput.optional(), accepted: z.literal(true).optional(),
}).passthrough();
const statusOutput = z.object({
  connected: z.boolean(), pendingRequests: z.number().int().nonnegative(),
  openSockets: z.number().int().nonnegative().optional(), pendingHandshakes: z.number().int().nonnegative().optional(),
  handshakeFailures: z.number().int().nonnegative().optional(),
  lastHandshakeFailureCode: z.number().int().nullable().optional(), lastHandshakeFailureReason: z.string().nullable().optional(),
  recoveryGeneration: z.number().int().nonnegative(), recovering: z.boolean(),
  clients: z.array(z.object({ clientId: resourceIdOutput, generation: z.number().int().nonnegative() }).passthrough()),
}).passthrough();
const capabilityIdentityOutput = z.object({
  server: z.object({ packageVersion: z.string() }),
  selectedClient: z.object({ clientId: resourceIdOutput, generation: z.number().int().nonnegative() }).optional(),
});
const fullCapabilitiesOutput = capabilityIdentityOutput.extend({
  protocol: z.number().int(), executor: z.string(), methods: z.array(z.string()),
}).passthrough();
const capabilitiesOutput = objectUnionOutput([
  fullCapabilitiesOutput,
  capabilityIdentityOutput.extend({
    view: z.literal("summary"), protocol: z.number().int(), executor: z.string(),
    version: z.string().optional(),
    bootstrap: z.object({ build: z.string(), generation: z.number().int().nonnegative() }).strict().optional(),
    methodCount: z.number().int().nonnegative(),
    features: z.record(z.string(), z.object({ version: z.number().int() }).strict()),
  }).strict(),
  capabilityIdentityOutput.extend({
    view: z.literal("section"), section: z.string().min(1).max(64), value: z.unknown(),
  }).strict(),
]);
// These schemas guarantee the envelope and discriminants, not arbitrary engine values.
const criticalOutputSchemas = {
  potassium_status: statusOutput,
  potassium_admin_status: statusOutput,
  potassium_capabilities: capabilitiesOutput,
  potassium_execute_luau_async: acceptanceOutput,
  potassium_remote_call: acceptanceOutput,
  potassium_async_job_status: jobOutput,
  potassium_async_job_cancel: jobOutput,
  potassium_async_job_list: z.object({ jobs: z.array(jobOutput).max(40), truncated: z.boolean() }).passthrough(),
  potassium_async_job_result: jobOutput.extend({ ready: z.boolean() }).superRefine((result, context) => {
    if (result.ready === ["queued", "running"].includes(result.state)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "ready must agree with the terminal job state", path: ["ready"] });
    }
  }),
  potassium_async_job_console: z.object({
    jobId: resourceIdOutput, entries: z.array(z.object({
      cursor: z.number().int().positive(), text: z.string(), messageType: z.string(),
      timestamp: z.number().finite(),
    }).passthrough()).max(200),
    nextCursor: z.number().int().nonnegative(),
  }).passthrough(),
  potassium_batch_read: z.object({
    requestCount: z.number().int().min(1).max(20), valueCount: z.number().int().min(0).max(200),
    truncated: z.boolean(),
    results: z.array(z.discriminatedUnion("ok", [
      z.object({ index: z.number().int().min(1).max(20), ok: z.literal(true), instance: objectOutputSchema, truncated: z.boolean() }).passthrough(),
      z.object({ index: z.number().int().min(1).max(20), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).passthrough() }).passthrough(),
    ])).max(20),
  }).passthrough().superRefine((result, context) => {
    if (result.results.length !== result.requestCount || result.results.some((row, index) => row.index !== index + 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Batch rows must preserve request count and order", path: ["results"] });
    }
  }),
  potassium_instance_references_release: z.object({
    results: z.array(z.object({
      reference: z.string().regex(/^instance:\/\/[a-f0-9]{32}(?![\s\S])/), released: z.boolean(),
    }).passthrough()).max(128),
  }).passthrough(),
};

const remoteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const remoteClass = z.enum(["RemoteEvent", "RemoteFunction", "UnreliableRemoteEvent"]);
const remoteDirection = z.enum(["outbound", "inbound"]);
const remoteDirections = z.array(remoteDirection).min(1).max(2)
  .refine((values) => new Set(values).size === values.length, "directions must be unique");
const captureType = z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/);
const captureScalar = z.union([z.boolean(), z.number().finite(), z.string().max(128)
  .refine((value) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 128, "Example string must be valid Unicode within 128 UTF-8 bytes")]);
const captureOmission = z.enum(["string-limit", "invalid-utf8", "non-finite", "depth-limit", "cycle", "node-limit", "byte-limit", "unsupported-key"]);
// One bounded node representation serves values and keys; the preflight below
// restricts keys to primitives before Zod follows any recursive structure.
const captureNode = z.lazy(() => z.object({
  type: captureType, value: captureScalar.optional(), redacted: z.literal(true).optional(), omitted: captureOmission.optional(),
  entries: z.array(z.object({ key: captureNode, value: captureNode }).strict()).max(8).optional(),
  truncated: z.boolean().optional(),
}).strict());
function boundedCaptureArguments(values, context) {
  if (Array.isArray(values) && values.length > 8) {
    context.addIssue({ code: "custom", message: "Example exceeds eight arguments" });
    return z.NEVER;
  }
  const pending = Array.isArray(values) ? values.map((value) => ({ value, depth: 0, key: false })) : [];
  let nodes = 0;
  while (pending.length) {
    const { value, depth, key } = pending.pop();
    if (++nodes > 32 || depth > 2 || !value || typeof value !== "object" || Array.isArray(value)) {
      context.addIssue({ code: "custom", message: "Example exceeds bounded typed-node limits" });
      return z.NEVER;
    }
    const modes = ["value", "redacted", "omitted", "entries"].filter((field) => value[field] !== undefined);
    const primitive = ["boolean", "number", "string"].includes(value.type);
    if (modes.length > 1 || (key && !primitive)
      || (value.value !== undefined && (!primitive || typeof value.value !== value.type))
      || (primitive && modes.length === 0)
      || (value.entries !== undefined && (value.type !== "table" || typeof value.truncated !== "boolean"))
      || (value.truncated !== undefined && value.entries === undefined)
      || (value.type === "table" && modes.length === 0)) {
      context.addIssue({ code: "custom", message: "Example node payload does not match its type" });
      return z.NEVER;
    }
    if (Array.isArray(value.entries)) {
      if (value.entries.length > 8 || depth >= 2) {
        context.addIssue({ code: "custom", message: "Example table exceeds entry or depth limits" });
        return z.NEVER;
      }
      for (const entry of value.entries) {
        pending.push({ value: entry?.key, depth: depth + 1, key: true }, { value: entry?.value, depth: depth + 1, key: false });
      }
    }
  }
  return values;
}
const captureExample = z.object({
  argc: remoteCount,
  arguments: z.preprocess(boundedCaptureArguments, z.array(captureNode).max(8)),
  truncated: z.boolean(), firstSeenMs: remoteCount, lastSeenMs: remoteCount, count: remoteCount,
}).strict().superRefine((example, context) => {
  if (example.arguments.length > example.argc || (!example.truncated && example.arguments.length !== example.argc)
    || example.firstSeenMs > example.lastSeenMs || example.count < 1
    || Buffer.byteLength(JSON.stringify(example), "utf8") > 1024) {
    context.addIssue({ code: "custom", message: "Invalid bounded example observation" });
  }
});
const captureShapeFields = {
  targetId: z.string().regex(/^(?:0[1-9]|1[0-6])$/), direction: remoteDirection,
  method: z.enum(["FireServer", "InvokeServer", "OnClientEvent"]), argc: remoteCount,
  argumentTypes: z.array(captureType).max(8), typesTruncated: z.boolean(),
};
function refineCaptureShape(value, context) {
  if (value.argumentTypes.length !== Math.min(value.argc, 8) || value.typesTruncated !== (value.argc > 8)
    || ((value.direction === "inbound") !== (value.method === "OnClientEvent"))) {
    context.addIssue({ code: "custom", message: "Observed direction, method, and arity must agree" });
  }
}
const captureGroup = z.object({
  ...captureShapeFields, count: remoteCount, firstSeenMs: remoteCount, lastSeenMs: remoteCount,
  exampleCount: z.number().int().min(0).max(3),
}).strict().superRefine(refineCaptureGroup);
function refineCaptureGroup(group, context) {
  refineCaptureShape(group, context);
  if (group.count < 1 || group.exampleCount > group.count || group.firstSeenMs > group.lastSeenMs || (group.examples !== undefined
    && (group.exampleCount !== group.examples.length || group.examples.some((example) => example.argc !== group.argc
      || example.count > group.count || example.firstSeenMs < group.firstSeenMs || example.lastSeenMs > group.lastSeenMs)))) {
    context.addIssue({ code: "custom", message: "Profile examples must agree with cumulative group observations" });
  }
}
// Poll shares one strict row shape. Refinements preserve the distinct group,
// profile, and event contracts without repeating their common fields on the wire.
const capturePollRow = z.object({
  ...captureShapeFields, count: remoteCount.optional(), firstSeenMs: remoteCount.optional(), lastSeenMs: remoteCount.optional(),
  exampleCount: z.number().int().min(0).max(3).optional(), examples: z.array(captureExample).max(3).optional(),
  sequence: remoteCount.optional(), elapsedMs: remoteCount.optional(),
}).strict().superRefine((row, context) => {
  const groupFields = ["count", "firstSeenMs", "lastSeenMs", "exampleCount"];
  if (row.sequence === undefined) {
    if (row.elapsedMs !== undefined || groupFields.some((field) => row[field] === undefined)) {
      context.addIssue({ code: "custom", message: "A profile group requires cumulative counts and times, not event timing" });
    } else refineCaptureGroup(row, context);
  } else {
    refineCaptureShape(row, context);
    if (row.elapsedMs === undefined || row.examples !== undefined || groupFields.some((field) => row[field] !== undefined)) {
      context.addIssue({ code: "custom", message: "An event requires elapsed timing and cannot contain profile fields" });
    }
  }
});
const captureBaseOutput = z.object({
  captureId: resourceIdOutput, generation: remoteCount,
  state: z.enum(["active", "stopped", "expired", "limited", "interrupted"]), reason: z.string().max(128).optional(),
  coverage: z.enum(["selected-outbound-namecall-only", "selected-inbound-events-only", "selected-outbound-namecall-and-inbound-events"]),
  directions: remoteDirections, recordsValues: z.boolean(), recordsReturns: z.literal(false),
  incomingCalls: z.boolean(), incomingRemoteFunctions: z.literal(false), directMethodCalls: z.literal(false), nativeSemanticsVerified: z.literal(false),
  unsupportedInboundTargets: z.array(z.object({
    targetId: captureShapeFields.targetId, reason: z.literal("remote-function-callback-not-observed"),
  }).strict()).max(16),
  observed: remoteCount, retained: z.number().int().min(0).max(200), bufferedBytes: z.number().int().min(0).max(65536),
  byteAccounting: z.literal("conservative-metadata-bound"), expiresInMs: remoteCount,
  dropped: z.object({ events: remoteCount, shapes: remoteCount, observationErrors: remoteCount, examples: remoteCount }).strict(),
  exampleSampling: z.object({ attempts: z.number().int().min(0).max(200), maxAttempts: z.literal(200), truncated: z.boolean() }).strict(),
  hookCleanup: z.string().max(128).optional(),
}).strict().superRefine((capture, context) => {
  const inbound = capture.directions.includes("inbound"), outbound = capture.directions.includes("outbound");
  const coverage = inbound ? (outbound ? "selected-outbound-namecall-and-inbound-events" : "selected-inbound-events-only") : "selected-outbound-namecall-only";
  if (capture.coverage !== coverage || capture.incomingCalls !== inbound
    || (!inbound && capture.unsupportedInboundTargets.length !== 0)
    || capture.groups?.some((group) => group.examples !== undefined || group.sequence !== undefined)
    || capture.profiles?.some((group) => group.examples === undefined || group.sequence !== undefined)
    || [capture.groups, capture.profiles, capture.events].some((rows) => rows?.some((row) => !capture.directions.includes(row.direction)))
    || [capture.groups, capture.profiles].some((rows) => rows?.some((group) => group.count > capture.observed
      || (!capture.recordsValues && group.exampleCount !== 0)))
    || capture.events?.some((event) => event.sequence === undefined || event.sequence < 1 || event.sequence > capture.observed)
    || (!capture.recordsValues && (capture.exampleSampling.attempts !== 0 || capture.exampleSampling.truncated))) {
    context.addIssue({ code: "custom", message: "Capture coverage and value opt-in must agree with retained observations" });
  }
});
const captureStopOutput = captureBaseOutput.safeExtend({
  groups: z.array(captureGroup).max(32).optional(),
  targets: z.array(z.object({
    targetId: captureShapeFields.targetId, className: remoteClass, name: z.string().max(256), path: z.string().max(256),
    method: z.enum(["FireServer", "InvokeServer"]),
  }).strict()).max(16).optional(),
});
const capturePollOutput = captureStopOutput.safeExtend({
  groups: z.array(capturePollRow).max(32).optional(),
  profiles: z.array(capturePollRow).max(32).optional(),
  events: z.array(capturePollRow).max(20).optional(),
  oldestSequence: remoteCount.optional(), droppedAfter: remoteCount.optional(), nextAfter: remoteCount.optional(), hasMore: z.boolean().optional(),
});
const captureOutputs = {
  remote_capture_start: captureBaseOutput,
  remote_capture_stop: captureStopOutput,
  remote_capture_poll: capturePollOutput,
};

const metadataNumber = z.number().finite();
const metadataPair = z.union([
  z.object({ x: metadataNumber, y: metadataNumber }).strict(),
  z.object({ scale: metadataNumber, offset: metadataNumber }).strict(),
]);
const metadataTag = z.object({
  type: z.string().min(1).max(64), value: z.string().max(4096).optional(),
  x: z.union([metadataNumber, metadataPair]).optional(), y: z.union([metadataNumber, metadataPair]).optional(), z: metadataNumber.optional(),
  r: metadataNumber.optional(), g: metadataNumber.optional(), b: metadataNumber.optional(),
  scale: metadataNumber.optional(), offset: metadataNumber.optional(), components: z.array(metadataNumber).length(12).optional(),
  min: z.union([metadataNumber, metadataPair]).optional(), max: z.union([metadataNumber, metadataPair]).optional(),
  number: metadataNumber.optional(), name: z.string().max(4096).optional(), className: z.string().max(128).optional(), path: z.string().max(4096).optional(),
}).strict().superRefine((value, context) => {
  const fields = {
    nil: [], number: ["value"], Vector3: ["x", "y", "z"], Vector2: ["x", "y"], Color3: ["r", "g", "b"],
    CFrame: ["components"], UDim: ["scale", "offset"], UDim2: ["x", "y"], Rect: ["min", "max"],
    BrickColor: ["number", "name"], NumberRange: ["min", "max"], Instance: ["className", "name", "path"], EnumItem: ["value"],
  };
  const expected = Object.hasOwn(fields, value.type) ? fields[value.type] : ["value"];
  const numeric = ["Vector3", "Vector2", "Color3", "UDim", "NumberRange"].includes(value.type);
  const pairFields = value.type === "UDim2" ? ["x", "y"] : value.type === "Rect" ? ["min", "max"] : [];
  if (expected.some((key) => value[key] === undefined) || Object.keys(value).some((key) => key !== "type" && !expected.includes(key))
    || (numeric && expected.some((key) => typeof value[key] !== "number"))
    || pairFields.some((key) => typeof value[key] !== "object" || value[key] === null
      || !Object.hasOwn(value[key], value.type === "UDim2" ? "scale" : "x"))
    || (value.type === "number" && !["nan", "inf", "-inf"].includes(value.value))) {
    context.addIssue({ code: "custom", message: "Invalid serialized metadata value" });
  }
});
const metadataValue = z.union([z.boolean(), metadataNumber, z.string().max(4096), metadataTag]);
const metadataValueResult = z.object({
  ok: z.boolean(), value: metadataValue.optional(), error: z.string().max(4096).optional(), redacted: z.literal(true).optional(),
}).strict().superRefine((result, context) => {
  if (result.ok ? result.value === undefined || result.error !== undefined : result.error === undefined || result.value !== undefined || result.redacted !== undefined) {
    context.addIssue({ code: "custom", message: "Metadata value must preserve success/error status" });
  }
  if (result.redacted && result.value !== "[redacted]") context.addIssue({ code: "custom", message: "Redacted metadata must not retain its value" });
});
const remoteAssociationOutput = z.object({
  name: z.string().max(4096), className: z.string().max(128), path: z.string().max(4096),
  value: metadataValueResult, reference: z.string().regex(/^instance:\/\/[a-f0-9]{32}(?![\s\S])/).optional(),
}).strict();
const remoteDetailFields = {
  view: z.literal("detail"), generation: remoteCount, snapshotId: resourceIdOutput.optional(), rowId: resourceIdOutput.optional(),
  instance: z.object({
    name: z.string().max(4096), className: remoteClass, path: z.string().max(4096),
    reference: z.string().regex(/^instance:\/\/[a-f0-9]{32}(?![\s\S])/).optional(), referenceUnavailable: z.literal(true).optional(),
  }).strict(),
  metadataTiming: z.literal("live-non-atomic"), associationMeaning: z.literal("metadata-not-call-arguments"),
  attributes: z.object({
    ok: z.boolean(), values: z.array(metadataValueResult.safeExtend({ name: z.string().max(4096) })).max(32),
    total: remoteCount.optional(), truncated: z.boolean(), error: z.string().max(4096).optional(),
  }).strict(),
  valueAssociations: z.object({
    children: z.array(remoteAssociationOutput).max(50),
    siblings: z.array(remoteAssociationOutput).max(50),
    siblingsRequested: z.boolean(), siblingMeaning: z.literal("shared-parent-only"),
  }).strict(),
  visited: z.number().int().min(0).max(20000), truncated: z.boolean(), coverage: z.enum(["complete", "partial"]), stopReasons: z.array(z.string().max(128)).max(32),
};
const remoteDetailOutput = z.object(remoteDetailFields).strict().superRefine((result, context) => {
  if ((result.snapshotId === undefined) !== (result.rowId === undefined)
    || result.valueAssociations.children.length + result.valueAssociations.siblings.length > 50
    || (!result.valueAssociations.siblingsRequested && result.valueAssociations.siblings.length !== 0)
    || (result.attributes.ok ? result.attributes.error !== undefined : result.attributes.error === undefined)
    || (result.coverage === "partial") !== result.truncated) {
    context.addIssue({ code: "custom", message: "Invalid detail identity or metadata coverage" });
  }
});
// Preserve older snapshot views while validating every detail facet before retention.
const inventoryOutput = z.object(Object.fromEntries(Object.entries(remoteDetailFields).map(([key, schema]) => [key, schema.optional()])))
  .safeExtend({
    view: z.enum(["summary", "rows", "diff", "detail"]).optional(),
    queryScope: z.literal("retained-rows").optional(), queryMatched: remoteCount.optional(),
  }).passthrough()
  .superRefine((result, context) => {
    if (result.view === "detail" && !remoteDetailOutput.safeParse(result).success) {
      context.addIssue({ code: "custom", message: "Invalid remote detail result" });
    }
    if ((result.queryScope === undefined) !== (result.queryMatched === undefined)
      || (result.queryScope !== undefined && !["summary", "rows"].includes(result.view))) {
      context.addIssue({ code: "custom", message: "Retained query metadata requires a rows or summary view" });
    }
  });

const sourcePosition = z.object({ line: remoteCount, column: remoteCount, offset: remoteCount }).strict();
const remoteCallsitesOutput = z.object({
  indexId: resourceIdOutput, view: z.literal("remote_callsites"), total: remoteCount, hasMore: z.boolean(),
  cursor: z.string().min(1).max(256).optional(), truncated: z.boolean(),
  correlation: z.literal("static-candidates-only"), execution: z.literal("not-executed"), receiverIdentity: z.literal("unverified"),
  completeness: z.object({ syntax: z.boolean(), bounded: z.boolean(), semantic: z.literal("conservative"), execution: z.literal("not-executed") }).strict(),
  limits: z.object({ maxRows: z.literal(50), maxReceiverDepth: z.literal(8), maxReceiverNodes: z.literal(32), retainedNameTruncationAt: z.literal(128) }).strict(),
  limitations: z.array(z.string().max(256)).max(32),
  rows: z.array(z.object({
    callsiteId: z.string().min(1).max(128), moduleId: z.string().min(1).max(128), sha256: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
    span: z.object({ start: sourcePosition, end: sourcePosition }).strict(),
    method: z.enum(["FireServer", "InvokeServer", "FireClient", "FireAllClients", "InvokeClient"]),
    matchKind: z.enum(["static-logical-path", "receiver-name-heuristic"]), confidence: z.enum(["inferred", "heuristic"]),
    receiverIdentity: z.literal("unverified"), argumentExpressionCount: remoteCount, argumentsTruncated: z.boolean(),
    uncertainty: z.array(z.string().max(256)).max(32), snippet: z.string().max(160),
  }).strict()).max(50),
}).strict().superRefine((result, context) => {
  if (result.rows.length > result.total || result.hasMore !== (result.cursor !== undefined)
    || result.rows.some((row) => (row.matchKind === "static-logical-path") !== (row.confidence === "inferred")
      || row.span.start.offset > row.span.end.offset)) {
    context.addIssue({ code: "custom", message: "Invalid static candidate page" });
  }
});

function requiredFeatures(method, params) {
  const required = [];
  if (method === "execute_luau_async" || method.startsWith("async_job_")) {
    required.push(["asyncJobs", ["async_job_list", "async_job_cancel"].includes(method) ? 2 : 1]);
  }
  if (method.startsWith("watch_")) required.push(["watches", 1]);
  if (method === "batch_read") required.push(["batchRead", 1]);
  if (method === "remote_inventory") required.push(["remoteInventory", params?.query === undefined ? 3 : 4]);
  if (method === "game_context") required.push(["gameContext", 2]);
  if (method === "map_observe" || method === "map_probe") required.push(["mapObservation", 1]);
  if (method === "map_recording") required.push(["mapRecording", 1]);
  if (method.startsWith("remote_capture_")) required.push(["remoteCapture", 2]);
  if (method === "remote_call") required.push(["remoteActions", 1], ["asyncJobs", 2]);
  if (method === "observe_action") required.push(["actionObservation", 1]);
  if (method === "diagnostic_snapshot" && params?.view && params.view !== "overview") {
    required.push(["diagnosticSnapshot", 2], ["instanceReferences", 1]);
  }
  const paths = [params?.path, params?.root, params?.otherPath, params?.target, ...(params?.excludePaths ?? []),
    ...(params?.targets ?? []), ...(params?.remotes ?? []), ...(params?.requests ?? []).map((request) => request.path)];
  const visitArgument = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "Instance") paths.push(value.reference);
    if (value.type === "Array") for (const child of value.values) visitArgument(child);
    if (value.type === "Table") for (const entry of value.entries) visitArgument(entry.value);
  };
  if (method === "remote_call") for (const argument of params.arguments) visitArgument(argument);
  if (method === "instance_references_release" || params?.includeReferences === true
    || paths.some((path) => typeof path === "string" && path.startsWith("instance://"))) {
    required.push(["instanceReferences", 1]);
  }
  return required;
}
const openWorldTools = new Set(["potassium_http_get", "potassium_place_metadata"]);
const metadataTools = new Set([
  "potassium_status", "potassium_list_clients", "potassium_capabilities",
  "potassium_admin_status", "potassium_admin_history", "potassium_admin_recover",
  "potassium_builtin_status", "potassium_builtin_list_clients",
  "potassium_game_context", ...mapTools,
]);
const titleWords = new Map([["http", "HTTP"], ["ui", "UI"]]);

function potassiumToolTitle(name) {
  const words = name.replace(/^potassium_/, "").split("_");
  return `Potassium ${words.map((word) =>
    titleWords.get(word) ?? `${word[0].toUpperCase()}${word.slice(1)}`).join(" ")}`;
}

const fullAccessPolicy = Object.freeze({ read: true, admin: true, execute: true });
const discoveryCapability = "potassium/tool-discovery";
const structuredResultsCapability = "potassium/structured-results";
const discoveryCoreTools = new Set(["potassium_tool_catalog", "potassium_result_read", "potassium_status"]);

class PotassiumMcpServer extends McpServer {
  toolCatalog = new Map();
  lazyDiscovery = false;
  resultScopeClosed = false;
  catalogRevision = 0;

  paginateToolList(result, cursor) {
    const serialized = JSON.stringify(result);
    if (cursor === undefined && Buffer.byteLength(serialized) <= this.discoveryResultBytes) return result;
    const revision = createHash("sha256").update(this.resultScopeId).update("\0")
      .update(String(this.catalogRevision)).update("\0").update(serialized).digest("hex");
    const encodeCursor = (offset) => {
      const digest = createHash("sha256").update(revision).update("\0").update(String(offset)).digest("hex");
      return Buffer.from(JSON.stringify([1, digest, offset])).toString("base64url");
    };
    let offset = 0;
    if (cursor !== undefined) {
      let decoded;
      try {
        if (typeof cursor !== "string" || cursor.length > 160 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1
          || !Number.isSafeInteger(decoded[2]) || decoded[2] < 1 || decoded[2] >= result.tools.length
          || encodeCursor(decoded[2]) !== cursor) throw new Error();
        offset = decoded[2];
      } catch {
        throw new McpError(ErrorCode.InvalidParams, "Invalid or stale tools/list cursor.");
      }
    }
    const pageAt = (end) => ({
      ...result, tools: result.tools.slice(offset, end),
      ...(end < result.tools.length ? { nextCursor: encodeCursor(end) } : {}),
    });
    if (cursor !== undefined) {
      const remaining = pageAt(result.tools.length);
      if (Buffer.byteLength(JSON.stringify(remaining)) <= this.discoveryResultBytes) return remaining;
    }
    let lower = offset + 1, upper = result.tools.length, best;
    while (lower <= upper) {
      const end = Math.floor((lower + upper) / 2);
      const page = pageAt(end);
      if (Buffer.byteLength(JSON.stringify(page)) <= this.discoveryResultBytes) {
        best = page;
        lower = end + 1;
      } else upper = end - 1;
    }
    if (best) return best;
    throw new McpError(ErrorCode.InternalError, "A tool definition exceeds the configured discovery response budget.", {
      code: "TOOL_SCHEMA_TOO_LARGE", toolName: result.tools[offset]?.name,
    });
  }

  releaseResults() {
    if (this.resultScopeClosed) return;
    this.resultScopeClosed = true;
    if (this.releaseResultScopeOnClose) {
      this.compactResultStore.releaseScope(this.resultScopeId);
      this.codeIndexService.releaseScope(this.resultScopeId);
    }
    if (this.releaseSessionStatsOnClose) this.sessionStats.clear();
    this.ownedGameContextService?.close();
    this.ownedMapContextService?.close();
    this.ownedMapRecordingService?.close();
  }

  async close() {
    this.releaseResults();
    return super.close();
  }

  connect(transport) {
    return super.connect(new RequestIdTransport(transport, {
      onRequestCancelled: this.onRequestCancelled,
      onRequestStart: this.onRequestStart,
      onResponseSent: this.onResponseSent,
    }));
  }

  createToolError(message) {
    if (/^(?:MCP error -\d+: )?Output validation error:/.test(message)) {
      return this.redactToolResult(toolError(Object.assign(new Error("Client result does not match the documented output contract."), { code: "RESULT_INVALID" })));
    }
    this.sessionStats.recordProtocolError();
    return this.redactToolResult(toolError(new Error(message)));
  }

  registerTool(name, config, handler) {
    if (this.policy && !allowsTool(this.policy, name, { allowUnsafeExecute: this.allowUnsafeExecute })) return undefined;
    const clientId = z.string().regex(/^[a-f0-9]{32}(?![\s\S])/, "clientId must be a lowercase 32-hex identifier").optional();
    const inputSchema = offlineMapTools.has(name) || recordingTools.has(name) ? config.inputSchema : typeof config.inputSchema?.safeExtend === "function"
      ? config.inputSchema.safeExtend({ clientId })
      : typeof config.inputSchema?.extend === "function"
        ? config.inputSchema.extend({ clientId })
        : config.inputSchema && typeof config.inputSchema === "object"
          ? { ...config.inputSchema, clientId }
          : z.object({ clientId }).strict();
    const source = config.outputSchema ?? criticalOutputSchemas[name] ?? objectOutputSchema;
    const originalOutput = typeof source.safeParseAsync === "function" ? source : z.object(source);
    const title = config.title ?? potassiumToolTitle(name);
    const registered = super.registerTool(name, {
      title: potassiumToolTitle(name),
      ...config,
      inputSchema: compactInputSchema(inputSchema),
      outputSchema: identifyOutputSchema(name === "potassium_result_read" ? originalOutput : compactOutputSchema(originalOutput)),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: openWorldTools.has(name),
        ...config.annotations,
      },
    }, async (args, extra) => this.clientContext.run({ clientId: args?.clientId, signal: extra?.signal }, async () => {
      if (extra?.signal?.aborted) {
        this.sessionStats.recordProtocolError();
        return this.redactToolResult(toolError(Object.assign(new Error("Request cancelled before the tool callback"), {
          code: mapTools.has(name) ? "MAP_CONTEXT_CANCELLED" : "CANCELLED", submissionIndeterminate: false,
        })));
      }
      if (!allowsTool(this.policy, name, { allowUnsafeExecute: this.allowUnsafeExecute })) {
        this.sessionStats.recordProtocolError();
        return this.redactToolResult(toolError(new Error("Tool is not permitted by the session policy")));
      }
      let settle;
      try { settle = this.onToolStart?.(); }
      catch (error) {
        this.sessionStats.recordProtocolError();
        return this.redactToolResult(toolError(error));
      }
      const finish = this.sessionStats.begin(name, args);
      let result, acceptedMap, acceptedRecording;
      try {
        try {
          const handled = await handler(args, extra);
          if (isMapWrite(name, handled.structuredContent?.view) && !handled.isError
            && (await originalOutput.safeParseAsync(handled.structuredContent)).success) {
            acceptedMap = { mapId: handled.structuredContent.mapId, revision: handled.structuredContent.revision, accepted: true };
          }
          if (name === "potassium_map_recording" && ["start", "save"].includes(handled.structuredContent?.operation)
            && !handled.isError && (await originalOutput.safeParseAsync(handled.structuredContent)).success) {
            acceptedRecording = recordingAcceptance(handled.structuredContent);
          }
          result = await this.finishToolResult(name, originalOutput, handled);
          if (result.isError && acceptedMap) result = this.redactToolResult(toolError(
            Object.assign(new Error("Map committed, but response formatting failed."), { code: "MAP_CONTEXT_INVALID_DATA" }), acceptedMap,
          ));
          if (result.isError && acceptedRecording) result = this.redactToolResult(toolError(
            Object.assign(new Error("Recording operation accepted, but response formatting failed."), { code: "MAP_CONTEXT_INVALID_DATA" }), acceptedRecording,
          ));
        } catch (error) {
          result = this.redactToolResult(toolError(error, acceptedRecording ?? acceptedMap));
        }
        return result;
      } finally {
        finish(result);
        settle?.();
      }
    }));
    const update = registered.update;
    registered.update = (updates) => {
      update(updates);
      this.catalogRevision += 1;
    };
    this.catalogRevision += 1;
    this.toolCatalog.set(name, {
      name, title, description: (config.description ?? "").split(/(?<=\.)\s/, 1)[0].slice(0, 160),
      category: toolCapability(name), handle: registered,
    });
    if (this.lazyDiscovery && !discoveryCoreTools.has(name)) registered.disable();
    return registered;
  }
}

export async function parseConfig(config, directory = here) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }

  const { tokenFile, artifactRoots, sourceRoots, httpAllowedHosts, adminAuditPath, builtinFallbackTokenFile, ...resolved } = parsed.data;
  let token = resolved.token;
  if (tokenFile !== undefined) {
    try {
      token = (await readFile(resolve(directory, tokenFile), "utf8")).trim();
    } catch {
      throw new Error("Unable to read the configured private token file.");
    }
  }
  if (token.length < 32 || token.length > 4096) {
    throw new Error("Config token must contain between 32 and 4096 characters");
  }

  return {
    ...resolved,
    token,
    proxyHost: resolved.proxyHost ?? resolved.host,
    policies: parsePolicyConfig(resolved),
    artifactRoots: artifactRoots.map((root) => ({
      ...root,
      path: resolve(directory, root.path),
      extensions: root.extensions.map((extension) => extension.toLowerCase()),
    })),
    sourceRoots: sourceRoots.map((root) => ({ ...root, path: resolve(directory, root.path) })),
    httpAllowedHosts: httpAllowedHosts.map((host) => host.toLowerCase()),
    ...(adminAuditPath === undefined ? {} : { adminAuditPath: resolve(directory, adminAuditPath) }),
    ...(builtinFallbackTokenFile === undefined ? {} : { builtinFallbackTokenFile: resolve(directory, builtinFallbackTokenFile) }),
  };
}

export async function loadConfig(path = resolveConfigPath()) {
  let config, rawConfigBytes;
  try {
    rawConfigBytes = await readFile(path);
    config = JSON.parse(rawConfigBytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Configuration not found at ${path}.`);
    }
    throw new Error("Unable to read configuration or parse its JSON.");
  }
  const parsed = await parseConfig(config, dirname(path));
  // Import only at call time: the installer consumes this module's config schema.
  const { isOwnedLegacyConfig } = await import("./install.js");
  const legacy = await isOwnedLegacyConfig(resolve(path), rawConfigBytes);
  if (!legacy || parsed.allowUnsafeExecute) return parsed;
  const policies = parsePolicyConfig({
    hostPolicies: Object.fromEntries(Object.entries(parsed.policies.hosts)
      .map(([hostId, grants]) => [hostId, { ...grants, admin: false }])),
    httpPolicy: { ...parsed.policies.http, admin: false },
  });
  return { ...parsed, hostPolicies: policies.hosts, httpPolicy: policies.http, policies };
}

export function createToolServer(config, bridge, {
  audit = new AdminAuditRecorder({ path: config.adminAuditPath }), sessionId = randomBytes(16).toString("hex"),
  hostId = "standalone", policy = fullAccessPolicy, artifactStore, builtinFallback,
  compactResultStore = createCompactResultStore(), resultScopeId = sessionId,
  releaseResultScopeOnClose = true, retainedSession = true,
  codeIndexService = createCodeIndexService(), gameContextService, mapContextService, mapRecordingService, configFile,
  sessionStats = createSessionStats({ toolNames: TOOL_NAMES }), releaseSessionStatsOnClose = true,
  onToolStart, onRequestCancelled, onRequestStart, onResponseSent,
} = {}) {
  const ownedGameContextService = gameContextService === undefined && configFile !== undefined
    ? createGameContextService({ configFile: resolve(configFile) }) : undefined;
  gameContextService ??= ownedGameContextService;
  const ownedMapContextService = mapContextService === undefined && configFile !== undefined
    ? createMapContextService({ configFile: resolve(configFile), gameContextService }) : undefined;
  mapContextService ??= ownedMapContextService;
  const ownedMapRecordingService = mapRecordingService === undefined && mapContextService !== undefined
    ? createMapRecordingService({ mapContextService }) : undefined;
  mapRecordingService ??= ownedMapRecordingService;
  const clientContext = new AsyncLocalStorage();
  const rawBridge = bridge;
  const selectedClientId = (clientId) => clientId ?? clientContext.getStore()?.clientId;
  const selectedClient = (clientId) => {
    try { return rawBridge.getClientInfo(selectedClientId(clientId)); } catch { return undefined; }
  };
  bridge = {
    async request(method, params, timeoutMs, clientId) {
      const { clientId: parameterClientId, ...requestParams } = params ?? {};
      let target = selectedClientId(clientId) ?? parameterClientId;
      const signal = clientContext.getStore()?.signal;
      const required = requiredFeatures(method, requestParams);
      if (required.length > 0 || method === "capabilities") {
        // Pin the selected client and generation across the probe and dispatch.
        // No cache: reconnects must never inherit a different bootstrap's features.
        rawBridge.getClientInfo(target);
        const clients = rawBridge.listClients();
        const selected = clients.find((client) => client.clientId === target) ?? (target === undefined && clients.length === 1 ? clients[0] : undefined);
        const selectedGeneration = selected?.generation;
        target = selected?.clientId ?? target;
        let capabilities;
        try {
          capabilities = await rawBridge.request("capabilities", {}, timeoutMs, target, signal);
        } catch (error) {
          if (error?.message === "Unknown method") {
            throw Object.assign(new Error("Selected client cannot report capabilities; its feature versions are unreported."), { code: "INCOMPATIBLE_CLIENT", submissionIndeterminate: false });
          }
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: error?.code, submissionIndeterminate: false });
        }
        if (selected && !rawBridge.listClients().some((client) => client.clientId === target && client.generation === selectedGeneration)) {
          throw Object.assign(new Error("Selected client generation changed during capability inspection."), { code: "CLIENT_CHANGED", submissionIndeterminate: false });
        }
        if (method === "capabilities") {
          return {
            ...capabilities,
            server: { packageVersion: packageMetadata.version },
            ...(selected ? { selectedClient: { clientId: target, generation: selectedGeneration } } : {}),
          };
        }
        const missing = required.find(([feature, version]) => !Number.isInteger(capabilities?.[feature]?.version) || capabilities[feature].version < version);
        if (missing || !Array.isArray(capabilities?.methods) || !capabilities.methods.includes(method)) {
          const requirement = missing ? `${missing[0]} version ${missing[1]} (current: ${Number.isInteger(capabilities?.[missing[0]]?.version) ? capabilities[missing[0]].version : "unreported"})` : `method ${method}`;
          throw Object.assign(new Error(
            `Selected client does not support ${requirement}.`,
          ), { code: "INCOMPATIBLE_CLIENT", submissionIndeterminate: false });
        }
      }
      return rawBridge.request(method, requestParams, timeoutMs, target, signal);
    },
    status: rawBridge.status.bind(rawBridge),
    listClients: rawBridge.listClients.bind(rawBridge),
    recover: rawBridge.recover.bind(rawBridge),
    getClientInfo: rawBridge.getClientInfo.bind(rawBridge),
  };
  const transportResultBytes = Math.min(config.maxMessageBytes, config.proxyMaxFrameBytes - 8192);
  const maxResultBytes = Math.min(COMPACT_RESULT_INLINE_BYTES, transportResultBytes);
  const imageBudget = Math.max(0, Math.min(128 * 1024, Math.floor((transportResultBytes - 4096) * 3 / 4)));
  // Reserve the MCP envelope; 12x covers Lua-to-JS number spelling expansion,
  // duplicated text/structured JSON, and escaping before references are committed.
  const referenceResultBytes = Math.max(1, Math.min(65536, Math.floor((transportResultBytes - 128) / 12)));
  const server = new PotassiumMcpServer({ name: "potassium-mcp", version: packageMetadata.version }, {
    capabilities: { experimental: { [discoveryCapability]: { version: 1 }, [structuredResultsCapability]: { version: 1 } } },
    debouncedNotificationMethods: ["notifications/tools/list_changed"],
  });
  // Discovery travels only over MCP, never the executor's maxMessageBytes lane.
  server.discoveryResultBytes = config.proxyMaxFrameBytes - 8192;
  // Wrap the SDK's public list registration, retaining its exact typed definitions.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => setRequestHandler(schema,
    schema === ListToolsRequestSchema
      ? async (request, extra) => server.paginateToolList(await handler(request, extra), request.params?.cursor)
      : handler);
  server.compactResultStore = compactResultStore;
  server.codeIndexService = codeIndexService;
  server.ownedGameContextService = ownedGameContextService;
  server.ownedMapContextService = ownedMapContextService;
  server.ownedMapRecordingService = ownedMapRecordingService;
  server.sessionStats = sessionStats;
  server.releaseSessionStatsOnClose = releaseSessionStatsOnClose;
  server.resultScopeId = resultScopeId;
  server.releaseResultScopeOnClose = releaseResultScopeOnClose;
  server.server.onclose = () => server.releaseResults();
  server.server.oninitialized = () => {
    server.structuredResults = server.server.getClientCapabilities()?.experimental?.[structuredResultsCapability]?.version === 1;
    const optIn = server.server.getClientCapabilities()?.experimental?.[discoveryCapability];
    if (server.lazyDiscovery || !retainedSession || optIn?.version !== 1 || optIn.listChanged !== true
      || !server.toolCatalog.has("potassium_tool_catalog")) return;
    server.lazyDiscovery = true;
    for (const entry of server.toolCatalog.values()) {
      if (!discoveryCoreTools.has(entry.name) && entry.handle.enabled) entry.handle.disable();
    }
  };
  server.policy = policy;
  server.allowUnsafeExecute = config.allowUnsafeExecute;
  server.clientContext = clientContext;
  server.onToolStart = onToolStart;
  server.onRequestCancelled = onRequestCancelled;
  server.onRequestStart = onRequestStart;
  server.onResponseSent = onResponseSent;
  const errorSecrets = [config.token, config.adminAuditPath, config.builtinFallbackTokenFile,
    ...(config.artifactRoots ?? []).map((root) => root.path),
    ...(config.sourceRoots ?? []).map((root) => root.path)].filter((value) => typeof value === "string" && value.length > 0);
  const redactValue = (_key, value) => {
    if (typeof value !== "string") return value;
    for (const secret of errorSecrets) value = value.split(secret).join("[redacted]");
    return value;
  };
  server.redactToolResult = (result) => {
    // Decode first: replacing serialized substrings can split JSON escape sequences.
    const payload = JSON.parse(canonicalResultJson.get(result) ?? result.content[0].text, redactValue);
    if (!result.isError) {
      const sanitized = formatToolResult(payload);
      if (resultImages.has(result)) resultImages.set(sanitized, resultImages.get(result));
      return sanitized;
    }
    const sanitized = {
      ...result,
      _meta: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
    if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > maxResultBytes) {
      // Only the message is unbounded; retain code, uncertainty, and job identity.
      const message = payload.error.message;
      const renderPrefix = (length) => {
        if (length > 0 && length < message.length
          && message.charCodeAt(length - 1) >= 0xd800 && message.charCodeAt(length - 1) <= 0xdbff
          && message.charCodeAt(length) >= 0xdc00 && message.charCodeAt(length) <= 0xdfff) length -= 1;
        payload.error.message = `${message.slice(0, length)}...`;
        sanitized.content[0].text = JSON.stringify(payload);
      };
      let lower = 0, upper = message.length;
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        renderPrefix(middle);
        if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= maxResultBytes) lower = middle;
        else upper = middle - 1;
      }
      renderPrefix(lower);
    }
    return sanitized;
  };
  const permitsTool = (name) => allowsTool(server.policy, name, { allowUnsafeExecute: server.allowUnsafeExecute });
  const responseFits = (result) => Buffer.byteLength(JSON.stringify(result), "utf8") <= maxResultBytes;
  const presentResult = (result) => {
    if (!server.structuredResults) return result;
    const presented = {
      ...result,
      content: [{ type: "text", text: "Complete result in structuredContent." }],
    };
    canonicalResultJson.set(presented, canonicalResultJson.get(result));
    return presented;
  };
  server.finishToolResult = async (name, originalOutput, result) => {
    if (result.isError) return server.redactToolResult(result);
    if (!(await originalOutput.safeParseAsync(result.structuredContent)).success) {
      if (mapTools.has(name)) throw Object.assign(new Error("Map result does not match its output contract."), { code: "MAP_CONTEXT_INVALID_DATA" });
      return server.createToolError("Output validation error: original result");
    }
    if (metadataTools.has(name)) {
      result = server.redactToolResult(result);
      if (!(await originalOutput.safeParseAsync(result.structuredContent)).success) {
        if (mapTools.has(name)) throw Object.assign(new Error("Redacted map result does not match its output contract."), { code: "MAP_CONTEXT_INVALID_DATA" });
        return server.createToolError("Output validation error: redacted result");
      }
    }
    const image = resultImages.get(result);
    if (image !== undefined) {
      // Metadata retains the ordinary cap; only ImageContent may use the media lane.
      if (!["potassium_game_context", "potassium_map_context"].includes(name) || !responseFits(result)) {
        throw Object.assign(new Error("Image metadata exceeds the ordinary response budget."), {
          code: name === "potassium_map_context" ? "MAP_CONTEXT_IMAGE_UNAVAILABLE" : "RESULT_LIMIT",
        });
      }
      if (imageBudget < 1 || image.data.length > imageBudget) {
        throw Object.assign(new Error("Image cannot fit the configured transport budget."), {
          code: name === "potassium_map_context" ? "MAP_CONTEXT_IMAGE_UNAVAILABLE" : "GAME_CONTEXT_IMAGE_UNAVAILABLE",
        });
      }
      const media = { ...result, content: [...result.content, { type: "image", mimeType: image.mimeType, data: image.data.toString("base64") }] };
      if (Buffer.byteLength(JSON.stringify(media), "utf8") > transportResultBytes) {
        throw Object.assign(new Error("Image response exceeds the configured transport budget."), {
          code: name === "potassium_map_context" ? "MAP_CONTEXT_IMAGE_UNAVAILABLE" : "RESULT_LIMIT",
        });
      }
      return media;
    }
    const presented = presentResult(result);
    if (responseFits(presented)) return presented;
    if (name === "potassium_result_read") {
      return server.redactToolResult(toolError(Object.assign(new Error("Result page exceeds the transport response budget."), { code: "RESULT_LIMIT" })));
    }
    const original = result.structuredContent;
    try {
      if (server.resultScopeClosed) throw Object.assign(new Error("Result session is closed."), { code: "RESULT_UNAVAILABLE" });
      const descriptor = compactResultStore.put({
        scopeId: resultScopeId, toolName: name,
        json: canonicalResultJson.get(result) ?? JSON.stringify(result.structuredContent),
      });
      if (name === "potassium_execute_luau_async" || name === "potassium_remote_call") {
        Object.assign(descriptor, { jobId: original.jobId, accepted: true });
      }
      if (name === "potassium_game_context" && original.view === "capture") {
        Object.assign(descriptor, { contextId: original.contextId, capturedAt: original.capturedAt, accepted: true });
      }
      if (isMapWrite(name, original.view)) {
        Object.assign(descriptor, { mapId: original.mapId, revision: original.revision, accepted: true });
      }
      if (name === "potassium_map_recording" && ["start", "save"].includes(original.operation)) {
        Object.assign(descriptor, recordingAcceptance(original));
      }
      const compact = presentResult(formatToolResult(descriptor));
      if (!responseFits(compact)) {
        // Summary is advisory metadata; retained JSON and its digest are unchanged.
        descriptor.summary = { type: descriptor.summary.type };
        const minimal = presentResult(formatToolResult(descriptor));
        if (responseFits(minimal)) return minimal;
        throw Object.assign(new Error("Retained result descriptor exceeds the transport response budget."), { code: "RESULT_LIMIT" });
      }
      return compact;
    } catch (error) {
      if (name === "potassium_execute_luau_async" || name === "potassium_remote_call") return acceptedJobFallback(original);
      if (name === "potassium_game_context" && original.view === "capture") {
        return acceptedContextFallback(original, errorCode(error));
      }
      if (isMapWrite(name, original.view)) {
        return acceptedMapFallback(original, errorCode(error));
      }
      if (name === "potassium_map_recording" && ["start", "save"].includes(original.operation)) {
        return acceptedRecordingFallback(original, errorCode(error));
      }
      const identity = resourceIdOutput.safeParse(original.jobId).success ? {
        jobId: original.jobId, ...(jobStateOutput.safeParse(original.state).success ? { state: original.state } : {}),
        ...(typeof original.ready === "boolean" ? { ready: original.ready } : {}),
      } : {};
      return server.redactToolResult(toolError(error, identity));
    }
  };
  const boundedPath = z.string().min(1).max(1024);
  const instancePath = boundedPath.describe("Roblox dotted path or instance://32-lowercase-hex reference in the selected bootstrap generation.");
  const includeReferences = z.boolean().default(false).describe("Include generation-scoped stable references; shared quota 1024 until release or teardown.");
  const propertyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/).max(64);
  const trustedCode = z.string().min(1).max(32768).refine(
    (code) => Buffer.byteLength(code, "utf8") <= 32768,
    "code exceeds 32768 UTF-8 bytes",
  );
  const finiteVector = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }).strict();
  const batchSelection = z.object({
    path: instancePath,
    properties: z.array(propertyName).min(1).max(32).optional(),
    attributes: z.object({
      names: z.array(z.string().min(1).max(128)).max(32).optional().describe("Omitted or empty selects scalar-safe attributes within limit."),
      limit: z.number().int().min(1).max(32).default(32),
    }).strict().optional(),
    children: z.object({ limit: z.number().int().min(1).max(100).default(100) }).strict().optional(),
  }).strict().superRefine((request, context) => {
    if (request.properties === undefined && request.attributes === undefined && request.children === undefined) {
      context.addIssue({ code: "custom", message: "Provide at least one of properties, attributes, or children" });
    }
  });
  const submitAsync = async (method, params, code, clientId) => {
    let result;
    try {
      result = await bridge.request(method, params, config.requestTimeoutMs, clientId);
    } catch (error) {
      return asyncSubmissionToolError(error);
    }
    if (!resourceIdOutput.safeParse(result?.jobId).success) {
      return asyncSubmissionToolError(Object.assign(new Error("Invalid async acceptance response"), { submissionIndeterminate: true }));
    }
    let auditFailed = false;
    try {
      const operation = audit.begin({
        code, bridge, sessionId, hostId, client: selectedClient(clientId),
        mode: "async", executorJobId: result.jobId,
      });
      await audit.finish(operation, "success");
    } catch {
      auditFailed = true;
    }
    const formatted = jobStateOutput.safeParse(result.state).success ? formatToolResult(result) : undefined;
    if (!auditFailed && formatted && !formatted.isError
      && acceptanceOutput.safeParse(formatted.structuredContent).success
      && formatted.structuredContent.jobId === result.jobId) return formatted;
    return acceptedJobFallback(result, auditFailed ? "AUDIT_FAILED" : "RESULT_FORMAT_FAILED");
  };
  if (builtinFallback) {
    server.registerTool(
      "potassium_builtin_status",
      { description: "Report optional loopback built-in diagnostic fallback availability." },
      async () => {
        try { return formatToolResult(await builtinFallback.status()); } catch (error) { return toolError(error); }
      },
    );
    server.registerTool(
      "potassium_builtin_list_clients",
      { description: "List clients through the optional read-only built-in diagnostic fallback." },
      async () => {
        try { return formatToolResult(await builtinFallback.listClients()); } catch (error) { return toolError(error); }
      },
    );
    server.registerTool(
      "potassium_builtin_read_console",
      {
        description: "Read bounded console diagnostics through the optional built-in fallback.",
        inputSchema: z.object({ pid: z.string().regex(/^[1-9]\d{0,10}$/), afterCursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(), waitMs: z.number().int().min(0).max(3000).optional() }).strict(),
      },
      async ({ pid, afterCursor, limit, waitMs }) => {
        try { return formatToolResult(await builtinFallback.readConsole(pid, { afterCursor, limit, waitMs })); } catch (error) { return toolError(error); }
      },
    );
  }
  server.registerTool(
    "potassium_result_read",
    {
      description: "Read selected JSON pointers or UTF-8 pages from a retained result; origin permissions and expiry apply.",
      inputSchema: z.object({
        resultId: resourceIdOutput,
        pointer: z.string().max(512).optional().describe("One RFC 6901 pointer, at most 512 characters; omitted selects the root. Excludes pointers/offsets."),
        offsetBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe("UTF-8 byte offset within the selected JSON, default 0; excludes pointers/offsets."),
        pointers: z.array(z.string().max(512)).min(1).max(8).optional().describe("1..8 unique pointers, at most 1024 combined characters; excludes pointer/offsetBytes."),
        offsets: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(8).optional().describe("One UTF-8 byte offset per pointer, in order; requires pointers. Omitted means all zero."),
        view: z.enum(["auto", "text"]).default("auto").describe("auto returns complete typed values when they fit, otherwise bounded text selections; text explicitly requests legacy UTF-8 paging."),
        maxBytes: z.number().int().min(1).max(4096).default(2048).describe("Shared selected-JSON byte budget, 1..4096, default 2048; the complete response also obeys transport bounds."),
      }).strict().superRefine((args, context) => {
        if (args.pointers !== undefined) {
          if (args.pointer !== undefined || args.offsetBytes !== undefined) {
            context.addIssue({ code: "custom", message: "pointers is mutually exclusive with pointer and offsetBytes" });
          }
          if (new Set(args.pointers).size !== args.pointers.length || args.pointers.reduce((sum, pointer) => sum + pointer.length, 0) > 1024) {
            context.addIssue({ code: "custom", message: "pointers must be unique and total at most 1024 characters" });
          }
          if (args.offsets && args.offsets.length !== args.pointers.length) {
            context.addIssue({ code: "custom", message: "offsets must match pointers length" });
          }
        } else if (args.offsets !== undefined) {
          context.addIssue({ code: "custom", message: "offsets requires pointers" });
        }
      }),
      outputSchema: objectUnionOutput([resultPageOutput, selectedResultPageOutput]),
    },
    async ({ clientId: _clientId, ...args }) => formatToolResult(compactResultStore.read({
      ...args, scopeId: resultScopeId,
    }, permitsTool, { maxResponseBytes: maxResultBytes })),
  );

  server.registerTool(
    "potassium_tool_catalog",
    {
      description: "Search permitted tool metadata and activate typed tools in retained sessions; ordinary and stateless clients retain the full catalog.",
      inputSchema: z.object({
        query: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(20).default(10),
        enable: z.array(z.string().min(1).max(128)).max(12).optional(),
        enableAll: z.boolean().default(false),
      }).strict(),
      annotations: { readOnlyHint: false },
    },
    async ({ query, limit, enable = [], enableAll }) => {
      // Validate the complete request before changing any SDK handle.
      const requested = [...new Set(enable)];
      if (requested.some((name) => !server.toolCatalog.has(name) || !permitsTool(name))) {
        throw new Error("Tool is not permitted by the session policy");
      }
      const allowed = [...server.toolCatalog.values()].filter((entry) => permitsTool(entry.name));
      const selected = enableAll ? allowed : requested.map((name) => server.toolCatalog.get(name));
      const activated = [];
      for (const entry of selected) {
        if (!entry.handle.enabled) { entry.handle.enable(); activated.push(entry.name); }
      }
      const needle = query?.toLowerCase() ?? "";
      const matches = allowed.filter((entry) => `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(needle));
      return formatToolResult({
        mode: server.lazyDiscovery ? "lazy" : "full", activated,
        tools: matches.slice(0, limit).map(({ name, title, description, category, handle }) => ({
          name, title, description, category, active: handle.enabled,
        })),
        hasMore: matches.length > limit,
      });
    },
  );
  server.registerTool(
    "potassium_session_stats",
    { description: "Report admitted tool calls, logical result bytes, timing, errors, and repeated scan selections for this scope." },
    async () => formatToolResult({
      scope: retainedSession ? "retained-mcp-session" : "broker-shared-http-policy",
      ...sessionStats.snapshot(),
    }),
  );

  const sourceModule = z.object({
    id: z.string().min(1).max(128),
    logicalPath: z.string().min(1).max(512).optional(),
    source: z.string().max(262144).optional(),
    root: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    path: z.string().min(1).max(4096).optional(),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}(?![\s\S])/).optional(),
  }).strict().superRefine((module, context) => {
    if (module.source === undefined ? module.root === undefined || module.path === undefined : module.root !== undefined || module.path !== undefined) {
      context.addIssue({ code: "custom", message: "Provide source or both root and path" });
    }
    if (module.source !== undefined && Buffer.byteLength(module.source, "utf8") > 262144) {
      context.addIssue({ code: "custom", message: "source exceeds 262144 UTF-8 bytes" });
    }
  });
  server.registerTool(
    "potassium_code_index",
    {
      description: "Index supplied Luau modules or explicit configured source files with isolated static parsing; returns scoped index identity and coverage.",
      inputSchema: z.object({
        modules: z.array(sourceModule).min(1).max(32),
        provenance: z.string().max(128).optional(),
      }).strict().superRefine(({ modules }, context) => {
        if (modules.reduce((bytes, module) => bytes + Buffer.byteLength(module.source ?? "", "utf8"), 0) > 4194304) {
          context.addIssue({ code: "custom", message: "modules exceed 4194304 aggregate source bytes" });
        }
      }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ modules, provenance }, extra) => formatToolResult(await codeIndexService.index({
      scopeId: resultScopeId, modules, provenance,
    }, config, { signal: extra?.signal })),
  );
  server.registerTool(
    "potassium_code_query",
    {
      description: "Query or release a retained Luau index, including explicitly selected static remote-callsite candidates; never executes code or verifies live receiver identity.",
      inputSchema: z.object({
        indexId: resourceIdOutput,
        view: z.enum(["summary", "calls", "functions", "dependencies", "origins", "source", "release", "remote_callsites"]).default("summary"),
        moduleId: z.string().min(1).max(128).optional(),
        query: z.string().max(128).optional(),
        callsiteId: z.string().min(1).max(128).optional(),
        remote: z.object({
          name: z.string().min(1).max(256).refine((value) => value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value), "Invalid remote name").optional(),
          logicalPath: z.string().min(1).max(512).refine((value) => value.isWellFormed()
            && !/[\u0000-\u001f\u007f\\:]/.test(value)
            && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Invalid logical path").optional(),
        }).strict().refine((remote) => remote.name !== undefined || remote.logicalPath !== undefined, "Provide at least one remote selector").optional(),
        cursor: z.string().min(1).max(256).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        depth: z.number().int().min(1).max(8).default(4),
      }).strict().superRefine((args, context) => {
        if ((args.view === "remote_callsites") !== (args.remote !== undefined)) {
          context.addIssue({ code: "custom", message: "remote selectors are required only for remote_callsites", path: ["remote"] });
        }
        if (args.view === "remote_callsites" && (args.query !== undefined || args.callsiteId !== undefined)) {
          context.addIssue({ code: "custom", message: "remote_callsites uses remote selectors, not query or callsiteId" });
        }
      }),
      outputSchema: objectOutputSchema.superRefine((result, context) => {
        if (result.view === "remote_callsites" && !remoteCallsitesOutput.safeParse(result).success) {
          context.addIssue({ code: "custom", message: "Invalid static remote candidate result" });
        }
      }).meta({
        if: { properties: { view: { const: "remote_callsites" } }, required: ["view"] },
        then: z.toJSONSchema(remoteCallsitesOutput, { target: "draft-7", io: "output" }),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ clientId: _clientId, ...args }) => {
      const result = await codeIndexService.query({
        ...args, scopeId: resultScopeId,
      }, (name) => permitsTool(name) && permitsTool("potassium_code_query"));
      if (args.view === "remote_callsites" && result?.view !== "remote_callsites") {
        throw Object.assign(new Error("Invalid static remote candidate result"), { code: "RESULT_INVALID" });
      }
      return formatToolResult(result);
    },
  );


  server.registerTool(
    "potassium_status",
    { description: "Report whether the local Potassium bootstrap is connected." },
    async () => formatToolResult(bridge.status()),
  );

  server.registerTool(
    "potassium_list_clients",
    { description: "List authenticated bootstrap clients and their clientId selection identifiers." },
    async () => formatToolResult(bridge.listClients()),
  );

  server.registerTool(
    "potassium_capabilities",
    {
      description: "Probe the selected executor's capabilities; summary returns feature versions, section returns one full facet, and full preserves the complete report.",
      inputSchema: z.object({
        view: z.enum(["full", "summary", "section"]).default("summary").describe("summary (default) returns core identity and feature versions; full includes methods and all limits; section selects one complete facet."),
        section: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional()
          .describe("Top-level capability key, 1..64 characters; required only with view section."),
      }).strict().superRefine((args, context) => {
        if ((args.view === "section") !== (args.section !== undefined)) {
          context.addIssue({ code: "custom", message: "section is required only with view section", path: ["section"] });
        }
      }),
    },
    async ({ view, section }) => {
      const capabilities = await bridge.request("capabilities");
      if (!fullCapabilitiesOutput.safeParse(capabilities).success) {
        return server.createToolError("Output validation error: original capabilities");
      }
      if (view === "full") return formatToolResult(capabilities);
      const identity = { server: capabilities.server, ...(capabilities.selectedClient ? { selectedClient: capabilities.selectedClient } : {}) };
      if (view === "section") {
        if (!Object.hasOwn(capabilities, section)) {
          throw Object.assign(new Error("Selected capability section is unavailable."), { code: "INVALID_INPUT" });
        }
        return formatToolResult({ view, section, value: capabilities[section], ...identity });
      }
      const features = Object.fromEntries(Object.entries(capabilities)
        .filter(([, value]) => Number.isInteger(value?.version))
        .map(([key, value]) => [key, { version: value.version }]));
      return formatToolResult({
        view, protocol: capabilities.protocol, executor: capabilities.executor,
        ...(typeof capabilities.version === "string" ? { version: capabilities.version } : {}),
        ...(capabilities.bootstrap === undefined ? {} : { bootstrap: { build: capabilities.bootstrap.build, generation: capabilities.bootstrap.generation } }),
        methodCount: capabilities.methods.length, features, ...identity,
      });
    },
  );

  server.registerTool(
    "potassium_game_context",
    {
      description: "Capture shared static game context; other views offline. Window images or box schematics.",
      inputSchema: gameContextInputSchema,
      outputSchema: gameContextOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ clientId, ...args }, extra) => {
      if (!gameContextService) {
        throw Object.assign(new Error("Game context storage requires an explicit configuration identity or shared service."), { code: "GAME_CONTEXT_UNAVAILABLE" });
      }
      if (args.view === "image") {
        const { metadata, image } = await gameContextService.image(args);
        if (!(await gameContextOutputSchema.safeParseAsync(metadata)).success) {
          return server.createToolError("Output validation error: image metadata");
        }
        const facet = metadata.images?.[args.kind];
        if (!Buffer.isBuffer(image?.data) || image.mimeType !== "image/jpeg" || image.data.length < 4
          || image.data[0] !== 0xff || image.data[1] !== 0xd8
          || image.data.at(-2) !== 0xff || image.data.at(-1) !== 0xd9
          || !Number.isInteger(image.width) || image.width < 1 || image.width > 4096
          || !Number.isInteger(image.height) || image.height < 1 || image.height > 4096
          || metadata.view !== "image" || metadata.kind !== args.kind || metadata.contextId !== args.contextId
          || facet?.status !== "available" || facet.mimeType !== image.mimeType
          || facet.width !== image.width || facet.height !== image.height || facet.bytes !== image.data.length
          || facet.sha256 !== createHash("sha256").update(image.data).digest("hex")) {
          throw Object.assign(new Error("Game context image is not a valid bounded JPEG payload."), { code: "RESULT_INVALID" });
        }
        const result = formatToolResult(metadata);
        resultImages.set(result, image);
        return result;
      }
      if (args.view !== "capture") {
        return formatToolResult(await (args.view === "list" ? gameContextService.list() : gameContextService[args.view](args)));
      }
      rawBridge.getClientInfo(clientId);
      const clients = rawBridge.listClients();
      const selected = clients.find((client) => client.clientId === clientId) ?? (clientId === undefined && clients.length === 1 ? clients[0] : undefined);
      if (!selected || !resourceIdOutput.safeParse(selected.clientId).success || !Number.isSafeInteger(selected.generation)) {
        throw Object.assign(new Error("Selected game context client identity is unavailable."), { code: "CLIENT_CHANGED" });
      }
      const client = Object.freeze({ clientId: selected.clientId, generation: selected.generation });
      const isCurrent = () => !extra?.signal?.aborted && rawBridge.listClients()
        .some((current) => current.clientId === client.clientId && current.generation === client.generation);
      const captured = await gameContextService.capture(args, {
        client, isCurrent, clientCount: clients.length, imageBudget, signal: extra?.signal,
        collect: async (params) => {
          if (!isCurrent()) throw Object.assign(new Error("Selected client changed before context collection."), { code: "GAME_CONTEXT_CLIENT_CHANGED" });
          const scene = await bridge.request("game_context", {
            ...params, _maxResultBytes: Math.max(1, Math.min(32768, config.maxMessageBytes - 1024)),
          }, config.requestTimeoutMs, client.clientId);
          // Persist only the same redacted metadata that read-authorized callers can see.
          return JSON.parse(JSON.stringify(scene), redactValue);
        },
      });
      const formatted = formatToolResult(captured);
      if ((formatted.isError || !gameContextOutputSchema.safeParse(formatted.structuredContent).success
        || formatted.structuredContent.contextId !== captured.contextId || formatted.structuredContent.capturedAt !== captured.capturedAt)
        && gameContextOutputSchema.safeParse(captured).success) {
        return toolError(Object.assign(new Error("Context capture completed, but its metadata could not be formatted."), { code: "RESULT_INVALID" }), {
          contextId: captured.contextId, capturedAt: captured.capturedAt, accepted: true,
        });
      }
      return formatted;
    },
  );

  server.registerTool(
    "potassium_map_context",
    {
      description: "Saved maps; bounded live observe/probe.",
      inputSchema: mapContextInputSchema,
      outputSchema: mapContextOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ clientId, ...args }, extra) => {
      const fail = (code, message) => Object.assign(new Error(message), { code: `MAP_CONTEXT_${code}` });
      const live = args.view === "observe" || args.view === "probe";
      if (!live && clientId !== undefined) throw fail("INVALID_INPUT", "clientId is only valid for observe and probe.");
      if (!mapContextService) throw fail("UNAVAILABLE", "Map context storage requires an explicit configuration identity or shared service.");
      const options = { signal: extra?.signal };
      let value;
      if (args.view === "image") {
        const { metadata, image } = await mapContextService.image(args, { ...options, imageBudget });
        const facet = metadata?.image;
        const dimensions = Buffer.isBuffer(image?.data) ? imageDimensions(image.data) : null;
        if (!(await mapContextOutputSchema.safeParseAsync(metadata)).success
          || metadata.view !== "image" || metadata.mapId !== args.mapId
          || !Buffer.isBuffer(image?.data) || image.mimeType !== "image/jpeg"
          || image.data.length < 4 || image.data.length > 128 * 1024
          || image.data[0] !== 0xff || image.data[1] !== 0xd8
          || image.data.at(-2) !== 0xff || image.data.at(-1) !== 0xd9
          || !Number.isInteger(image.width) || image.width < 1 || image.width > 4096
          || !Number.isInteger(image.height) || image.height < 1 || image.height > 4096
          || dimensions?.width !== image.width || dimensions?.height !== image.height
          || facet.mimeType !== image.mimeType || facet.bytes !== image.data.length
          || facet.width !== image.width || facet.height !== image.height
          || facet.sha256 !== createHash("sha256").update(image.data).digest("hex")) {
          throw fail("INVALID_DATA", "Map image metadata does not match a bounded JPEG payload.");
        }
        const result = formatToolResult(metadata);
        resultImages.set(result, image);
        return result;
      }
      // Offline operations deliberately return before all client selection and capability probes.
      if (!live) {
        value = await (args.view === "list" ? mapContextService.list() : mapContextService[args.view](args, options));
      } else {
        try { rawBridge.getClientInfo(clientId); }
        catch { throw fail("CLIENT_CHANGED", "Select one connected client matching the saved map scope."); }
        const clients = rawBridge.listClients();
        const selected = clients.find((client) => client.clientId === clientId)
          ?? (clientId === undefined && clients.length === 1 ? clients[0] : undefined);
        if (!selected || !resourceIdOutput.safeParse(selected.clientId).success
          || !Number.isSafeInteger(selected.generation) || selected.generation < 0) {
          throw fail("CLIENT_CHANGED", "Selected map client identity is unavailable.");
        }
        const client = Object.freeze({ clientId: selected.clientId, generation: selected.generation });
        const isCurrent = () => !extra?.signal?.aborted && rawBridge.listClients()
          .some((current) => current.clientId === client.clientId && current.generation === client.generation);
        const fence = () => {
          if (extra?.signal?.aborted) throw fail("CANCELLED", "Map collection was cancelled.");
          if (!isCurrent()) throw fail("CLIENT_CHANGED", "Selected client changed during map collection.");
        };
        value = await mapContextService[args.view](args, {
          ...options, client, isCurrent,
          collect: async (method, params) => {
            if (method !== (args.view === "observe" ? "map_observe" : "map_probe")) {
              throw fail("INVALID_INPUT", "Invalid map collection method.");
            }
            fence();
            let data;
            try {
              data = await bridge.request(method, {
                ...params, _maxResultBytes: Math.max(1, Math.min(method === "map_observe" ? 65536 : 32768, config.maxMessageBytes - 1024)),
              }, config.requestTimeoutMs, client.clientId);
            } catch (error) {
              fence();
              if (error?.code === "INCOMPATIBLE_CLIENT") throw fail("SOURCE_UNAVAILABLE", error.message);
              if (error?.code === "CANCELLED") throw fail("CANCELLED", "Map collection was cancelled.");
              const code = nativeMapErrorCode(error);
              if (code) throw Object.assign(error instanceof Error ? error : new Error(error.message), { code });
              throw fail("SOURCE_UNAVAILABLE", error instanceof Error ? error.message : "Map collection is unavailable.");
            }
            fence();
            return JSON.parse(JSON.stringify(data), redactValue);
          },
        });
      }
      const formatted = formatToolResult(value);
      if (mapWriteViews.has(args.view) && (await mapContextOutputSchema.safeParseAsync(value)).success
        && (formatted.isError || !(await mapContextOutputSchema.safeParseAsync(formatted.structuredContent)).success
          || formatted.structuredContent.mapId !== value.mapId || formatted.structuredContent.revision !== value.revision)) {
        return toolError(fail("INVALID_DATA", "Map committed, but its metadata could not be formatted."), {
          mapId: value.mapId, revision: value.revision, accepted: true,
        });
      }
      return formatted;
    },
  );

  server.registerTool(
    "potassium_map_mechanics",
    {
      description: "Read or replace user-reported floor/ceiling mechanics in an immutable saved-map revision, entirely offline.",
      inputSchema: mapMechanicsInputSchema,
      outputSchema: mapMechanicsOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args, extra) => {
      const fail = (code, message) => Object.assign(new Error(message), { code: `MAP_CONTEXT_${code}` });
      if (!mapContextService) throw fail("UNAVAILABLE", "Map context storage requires an explicit configuration identity or shared service.");
      const value = await mapContextService.mechanics(args, { signal: extra?.signal });
      const formatted = formatToolResult(value);
      if (args.view === "apply" && (await mapMechanicsOutputSchema.safeParseAsync(value)).success
        && (formatted.isError || !(await mapMechanicsOutputSchema.safeParseAsync(formatted.structuredContent)).success
          || formatted.structuredContent.mapId !== value.mapId || formatted.structuredContent.revision !== value.revision)) {
        return toolError(fail("INVALID_DATA", "Map committed, but its metadata could not be formatted."), {
          mapId: value.mapId, revision: value.revision, accepted: true,
        });
      }
      return formatted;
    },
  );

  for (const [name, inputSchema, outputSchema, description] of [
    ["potassium_map_recording", mapRecordingInputSchema, mapRecordingOutputSchema,
      "Start one continuous bounded native recording, inspect its status, mark or stop capture, and save retained evidence. Ready describes the native receipt at its reported time."],
    ["potassium_map_recording_read", mapRecordingReadInputSchema, mapRecordingReadOutputSchema,
      "Page retained native recording frames or events, or read archived recording summaries and evidence without an executor."],
  ]) server.registerTool(
    name,
    {
      description, inputSchema, outputSchema,
      annotations: { readOnlyHint: name === "potassium_map_recording_read", idempotentHint: name === "potassium_map_recording_read" },
    },
    async ({ clientId, ...args }, extra) => {
      const fail = (code, message) => Object.assign(new Error(message), { code: `MAP_RECORDING_${code}` });
      if (args.operation === "read" && clientId !== undefined) throw fail("INVALID_INPUT", "clientId is not valid for archived reads.");
      if (!mapRecordingService) throw fail("UNAVAILABLE", "Map recording requires configured map storage or a shared service.");
      const acquire = () => {
        try { rawBridge.getClientInfo(clientId); }
        catch { throw fail("CLIENT_CHANGED", "Select one connected client matching the recording scope."); }
        const clients = rawBridge.listClients();
        const selected = clients.find((current) => current.clientId === clientId)
          ?? (clientId === undefined && clients.length === 1 ? clients[0] : undefined);
        if (!selected || !resourceIdOutput.safeParse(selected.clientId).success
          || !Number.isSafeInteger(selected.generation) || selected.generation < 0) {
          throw fail("CLIENT_CHANGED", "Selected recording client identity is unavailable.");
        }
        const client = Object.freeze({ clientId: selected.clientId, generation: selected.generation });
        const isCurrent = () => !extra?.signal?.aborted && rawBridge.listClients()
          .some((current) => current.clientId === client.clientId && current.generation === client.generation);
        const fence = () => {
          if (extra?.signal?.aborted) throw fail("CANCELLED", "Recording request was cancelled.");
          if (!isCurrent()) throw fail("CLIENT_CHANGED", "Selected client changed during recording request.");
        };
        const nativeBytes = Math.max(1, Math.min(65536, config.maxMessageBytes - 1024));
        return {
          signal: extra?.signal, client, isCurrent, maxResultBytes: nativeBytes,
          collect: async (method, params) => {
            if (method !== "map_recording" || params?.operation !== (args.operation === "save" ? "poll" : args.operation)) {
              throw fail("INVALID_INPUT", "Invalid recording collection operation.");
            }
            fence();
            let data;
            try {
              data = await bridge.request(method, {
                ...params, _maxResultBytes: Math.min(nativeBytes, params._maxResultBytes ?? nativeBytes),
              }, config.requestTimeoutMs, client.clientId);
            } catch (error) {
              fence();
              if (error?.code === "INCOMPATIBLE_CLIENT") throw fail("SOURCE_UNAVAILABLE", error.message);
              const code = nativeMapErrorCode(error);
              if (code) throw Object.assign(error instanceof Error ? error : new Error(error.message), { code });
              throw fail("SOURCE_UNAVAILABLE", error instanceof Error ? error.message : "Recording source is unavailable.");
            }
            fence();
            return data;
          },
        };
      };
      // Historical reads and already accepted save receipts must not discover,
      // probe, or require a current executor. Only a new save acquires one.
      const value = args.operation === "read" ? await mapRecordingService.read(args)
        : args.operation === "save" ? await mapRecordingService.save(args, { signal: extra?.signal, clientId, acquire })
          : await mapRecordingService[args.operation](args, acquire());
      const accepted = ["start", "save"].includes(args.operation)
        && (await mapRecordingOutputSchema.safeParseAsync(value)).success ? recordingAcceptance(value) : undefined;
      const formatted = formatToolResult(value);
      if (accepted && (formatted.isError || !(await mapRecordingOutputSchema.safeParseAsync(formatted.structuredContent)).success
        || JSON.stringify(recordingAcceptance(formatted.structuredContent)) !== JSON.stringify(accepted))) {
        return toolError(fail("INVALID_DATA", "Recording operation accepted, but its receipt could not be formatted."), accepted);
      }
      return formatted;
    },
  );

  for (const [name, inputSchema, outputSchema, description] of [
    ["potassium_map_geometry", mapGeometryInputSchema, mapGeometryOutputSchema, "Read bounded parts, surfaces, or chunks from an immutable saved map; no live client required."],
    ["potassium_map_navigation", mapNavigationInputSchema, mapNavigationOutputSchema, "Read saved links or plan a modeled route offline. Models are not safety guarantees."],
    ["potassium_map_motion", mapMotionInputSchema, mapMotionOutputSchema, "Read saved tracks or hazards, or compact track summaries offline; full retained samples remain available."],
  ]) {
    server.registerTool(name, { description, inputSchema, outputSchema }, async (args, extra) => {
      if (!mapContextService) throw Object.assign(new Error("Map context storage requires an explicit configuration identity or shared service."), { code: "MAP_CONTEXT_UNAVAILABLE" });
      const value = args.view === "route"
        ? await mapContextService.route(args, { signal: extra?.signal })
        : await mapContextService.read({
          ...args, view: "read", section: args.section ?? (name === "potassium_map_motion" ? "tracks" : "links"),
          ...(args.view === "summary" ? { presentation: "summary" } : {}),
        });
      return formatToolResult(args.view === "summary" ? { ...value, view: "summary" } : value);
    });
  }

  if (config.allowUnsafeExecute) {
    server.registerTool(
      "potassium_execute_luau",
      {
        description: "Execute Luau in the selected client and return its result; requires execute permission and allowUnsafeExecute.",
        inputSchema: z.object({
          code: trustedCode,
          clientId: z.string().regex(/^[a-f0-9]{32}$/, "clientId must be a lowercase 32-hex identifier").optional(),
        }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ code, clientId }) => {
        const operation = audit.begin({ code, bridge, sessionId, hostId, client: selectedClient(clientId) });
        let result;
        try {
          result = await bridge.request("execute_luau", { code }, config.requestTimeoutMs, clientId);
        } catch (error) {
          const outcome = String(error instanceof Error ? error.message : error).includes("timed out after")
            ? "timeout"
            : "error";
          try { await audit.finish(operation, outcome, error); } catch { /* Preserve the execution outcome. */ }
          return toolError(error);
        }
        try {
          await audit.finish(operation, "success");
        } catch {
          const formatted = formatToolResult({ executionCompleted: true, warning: "AUDIT_FAILED", result });
          return formatted.isError ? formatToolResult({
            executionCompleted: true, warning: "AUDIT_FAILED",
            resultAvailable: false,
          }) : formatted;
        }
        return formatToolResult(result);
      },
    );

    server.registerTool(
      "potassium_execute_luau_async",
      {
        description: "Queue Luau for serialized execution and return a job ID; local potassiumJob = ... provides cancellation checkpoints.",
        inputSchema: z.object({
          code: trustedCode,
          clientId: z.string().regex(/^[a-f0-9]{32}$/, "clientId must be a lowercase 32-hex identifier").optional(),
        }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ code, clientId }) => submitAsync("execute_luau_async", { code }, code, clientId),
    );
    const remoteString = z.string().max(4096).refine((value) => Buffer.byteLength(value, "utf8") <= 4096, "string exceeds 4096 UTF-8 bytes");
    const tableKey = z.union([remoteString, z.number().finite(), z.boolean()]);
    const remoteValue = z.lazy(() => z.union([
      z.null(), remoteString, z.number().finite(), z.boolean(),
      z.discriminatedUnion("type", [
        finiteVector.extend({ type: z.literal("Vector3") }),
        z.object({ type: z.literal("CFrame"), components: z.array(z.number().finite()).length(12) }).strict(),
        z.object({ type: z.literal("Instance"), reference: z.string().regex(/^instance:\/\/[a-f0-9]{32}(?![\s\S])/) }).strict(),
        z.object({ type: z.literal("Array"), values: z.array(remoteValue).max(256) }).strict(),
        z.object({ type: z.literal("Table"), entries: z.array(z.object({ key: tableKey, value: remoteValue }).strict()).max(128) }).strict(),
      ]),
    ]));
    const remoteArguments = z.preprocess((values, context) => {
      if (!Array.isArray(values)) return values;
      if (values.length > 16) {
        context.addIssue({ code: "custom", message: "arguments exceed 16 entries" });
        return z.NEVER;
      }
      const pending = values.map((value) => ({ value, depth: 1 }));
      let nodes = 0;
      while (pending.length > 0) {
        const { value, depth } = pending.pop();
        if (++nodes > 256 || depth > 6) {
          context.addIssue({ code: "custom", message: "arguments exceed 256 nodes or depth 6" });
          return z.NEVER;
        }
        if (!value || typeof value !== "object") continue;
        if (value.type === "Vector3") nodes += 3;
        if (value.type === "CFrame") nodes += 12;
        const children = value.type === "Array" ? value.values : value.type === "Table" ? value.entries : undefined;
        if (Array.isArray(children)) {
          if (children.length > 256 || pending.length + children.length + nodes > 256) {
            context.addIssue({ code: "custom", message: "arguments exceed 256 nodes" });
            return z.NEVER;
          }
          for (const child of children) {
            if (value.type === "Table") nodes += 1;
            pending.push({ value: value.type === "Table" ? child?.value : child, depth: depth + 1 });
          }
        }
      }
      if (nodes > 256) {
        context.addIssue({ code: "custom", message: "arguments exceed 256 nodes" });
        return z.NEVER;
      }
      return values;
    }, z.array(remoteValue).max(16));
    const normalizeRemoteValue = (value) => {
      if (value === null) return { type: "nil" };
      if (value?.type === "Array") return { type: "Array", values: value.values.map(normalizeRemoteValue) };
      if (value?.type === "Table") return {
        type: "Table", entries: value.entries.map(({ key, value }) => ({ key, value: normalizeRemoteValue(value) })),
      };
      return value;
    };
    server.registerTool(
      "potassium_remote_call",
      {
        description: "Queue one FireServer or InvokeServer call with explicit typed arguments; returns an async job ID.",
        inputSchema: z.object({
          target: instancePath, method: z.enum(["FireServer", "InvokeServer"]), arguments: remoteArguments,
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ target, method, arguments: values, clientId }) => {
        const params = { target, method, arguments: values.map(normalizeRemoteValue), argumentCount: values.length };
        const serialized = JSON.stringify(params);
        if (Buffer.byteLength(serialized, "utf8") > 65536) {
          throw Object.assign(new Error("Remote call exceeds 65536 serialized bytes"), { code: "INVALID_INPUT", submissionIndeterminate: false });
        }
        return submitAsync("remote_call", params, serialized, clientId);
      },
    );

    server.registerTool(
      "potassium_observe_action",
      {
        description: "Start, poll, or stop a bounded before/after observation with optional selected remote metadata and temporal correlation.",
        inputSchema: z.object({
          operation: z.enum(["start", "poll", "stop"]),
          requests: z.array(batchSelection).min(1).max(16).optional(),
          remotes: z.array(instancePath).min(1).max(16).optional(),
          durationMs: z.number().int().min(1000).max(30000).optional(),
          observationId: resourceIdOutput.optional(),
        }).strict().superRefine((args, context) => {
          if (args.operation === "start") {
            if (!args.requests || args.observationId !== undefined) context.addIssue({ code: "custom", message: "start requires requests and excludes observationId" });
          } else if (args.observationId === undefined || args.requests !== undefined || args.remotes !== undefined || args.durationMs !== undefined) {
            context.addIssue({ code: "custom", message: "poll and stop require only observationId" });
          }
        }),
        outputSchema: z.object({
          observationId: resourceIdOutput, state: z.enum(["active", "completing", "completed", "interrupted"]),
          correlation: z.literal("temporal").optional(),
        }).passthrough(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation, requests, remotes, durationMs, observationId }) => formatToolResult(await bridge.request(
        "observe_action", operation === "start"
          ? { operation, requests, remotes, durationMs: durationMs ?? 5000 }
          : { operation, observationId },
      )),
    );
    const asyncJobId = z.string().regex(/^[a-f0-9]{32}$/, "jobId must be a lowercase 32-hex identifier");
    const bridgeClientId = z.string().regex(/^[a-f0-9]{32}$/, "clientId must be a lowercase 32-hex identifier").optional();
    server.registerTool(
      "potassium_async_job_status",
      {
        description: "Read an accepted job's state, timestamps, and cancellation status within its bootstrap generation.",
        inputSchema: z.object({ jobId: asyncJobId, clientId: bridgeClientId }).strict(),
      },
      async ({ jobId, clientId }) => {
        try {
          return formatToolResult(await bridge.request("async_job_status", { jobId }, config.requestTimeoutMs, clientId));
        } catch (error) {
          return toolError(error);
        }
      },
    );
    server.registerTool(
      "potassium_async_job_list",
      {
        description: "List generation-shared async jobs ordered by submission time and job ID.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(40).default(40),
          clientId: bridgeClientId,
        }).strict(),
      },
      async ({ limit, clientId }) => {
        try {
          return formatToolResult(await bridge.request("async_job_list", { limit }, config.requestTimeoutMs, clientId));
        } catch (error) {
          return toolError(error);
        }
      },
    );
    server.registerTool(
      "potassium_async_job_cancel",
      {
        description: "Cancel queued work or request running-job cancellation; execution is not forcibly terminated and terminal outcomes remain available.",
        inputSchema: z.object({ jobId: asyncJobId, clientId: bridgeClientId }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      async ({ jobId, clientId }) => {
        try {
          return formatToolResult(await bridge.request("async_job_cancel", { jobId }, config.requestTimeoutMs, clientId));
        } catch (error) {
          return toolError(error);
        }
      },
    );
    server.registerTool(
      "potassium_async_job_result",
      {
        description: "Read a retained async job outcome; ready=false identifies pending work.",
        inputSchema: z.object({ jobId: asyncJobId, clientId: bridgeClientId }).strict(),
      },
      async ({ jobId, clientId }) => {
        let result;
        try {
          result = await bridge.request("async_job_result", { jobId }, config.requestTimeoutMs, clientId);
        } catch (error) {
          return toolError(error);
        }
        const formatted = formatToolResult(result);
        if (formatted.isError) return formatted;
        if (!criticalOutputSchemas.potassium_async_job_result.safeParse(formatted.structuredContent).success) {
          return server.createToolError("Output validation error: original job result");
        }
        if (!artifactStore || result.ready !== true || result.state !== "succeeded") return formatted;
        try {
          const stored = await artifactStore.store(result);
          return formatToolResult(stored.kind === "inline" ? stored.value : { ...result, result: stored });
        } catch {
          return toolError(Object.assign(new Error("Job result could not be stored."), { code: "ARTIFACT_FAILED" }), {
            jobId, ready: result.ready, state: result.state,
          });
        }
      },
    );
    server.registerTool(
      "potassium_async_job_console",
      {
        description: "Read paged console output from a job's execution window, including potentially unrelated engine messages.",
        inputSchema: z.object({
          jobId: asyncJobId,
          afterCursor: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          clientId: bridgeClientId,
        }).strict(),
      },
      async ({ jobId, afterCursor, limit, clientId }) => {
        try {
          return formatToolResult(await bridge.request("async_job_console", { jobId, afterCursor, limit }, config.requestTimeoutMs, clientId));
        } catch (error) {
          return toolError(error);
        }
      },
    );

  }

    server.registerTool(
      "potassium_admin_status",
      {
        description: "Report executor transport activity and recovery state.",
      },
      async () => formatToolResult(bridge.status()),
    );
    server.registerTool(
      "potassium_admin_history",
      {
        description: "Read recent redacted execution audit metadata, excluding code and returned values.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).default(20),
        }).strict(),
      },
      async ({ limit }) => formatToolResult({ entries: audit.history(limit) }),
    );
    server.registerTool(
      "potassium_admin_recover",
      {
        description: "Reset executor transport by expected recovery generation; running Luau is not forcibly terminated.",
        inputSchema: z.object({
          expectedRecoveryGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      async ({ expectedRecoveryGeneration }) => {
        try {
          return formatToolResult(bridge.recover(expectedRecoveryGeneration));
        } catch (error) {
          return toolError(error);
        }
      },
    );


  server.registerTool(
    "potassium_client_state",
    { description: "Read PlaceId, JobId presence, player state, character state, and position." },
    async () => {
      try {
        return formatToolResult(await bridge.request("client_state"));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_list_children",
    {
      description: "List direct children of an instance path or reference.",
      inputSchema: {
        path: instancePath,
        limit: z.number().int().min(1).max(1000).default(200),
        includeReferences,
      },
      annotations: { readOnlyHint: false },
    },
    async ({ path, limit, includeReferences }) => {
      try {
        return formatToolResult(await bridge.request("list_children", {
          path, limit, includeReferences, _maxResultBytes: includeReferences ? referenceResultBytes : undefined,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_inspect_instance",
    {
      description: "Inspect identity, attributes, selected properties, and optionally descendants of a Roblox instance.",
      inputSchema: {
        path: instancePath,
        depth: z.number().int().min(0).max(3).default(0),
        childLimit: z.number().int().min(1).max(500).default(100),
        includeReferences,
      },
      annotations: { readOnlyHint: false },
    },
    async ({ path, depth, childLimit, includeReferences }) => {
      try {
        return formatToolResult(await bridge.request("inspect_instance", {
          path, depth, childLimit, includeReferences, _maxResultBytes: includeReferences ? referenceResultBytes : undefined,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_find_instances",
    {
      description: "Find Roblox instances with bounded traversal and optional name, path, and class filters.",
      inputSchema: {
        root: instancePath,
        nameContains: z.string().max(128).optional(),
        pathContains: z.string().max(128).optional(),
        classNames: z.array(z.string().max(64)).max(16).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        includeReferences,
      },
      annotations: { readOnlyHint: false },
    },
    async ({ root, nameContains, pathContains, classNames, limit, maxVisited, includeReferences }) => {
      try {
        return formatToolResult(await bridge.request("find_instances", {
          root, nameContains, pathContains, classNames, limit, maxVisited, includeReferences,
          _maxResultBytes: includeReferences ? referenceResultBytes : undefined,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_read_properties",
    {
      description: "Read an allowlisted set of properties from a Roblox instance.",
      inputSchema: {
        path: instancePath,
        properties: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64)).min(1).max(32),
      },
    },
    async ({ path, properties }) => {
      try {
        return formatToolResult(await bridge.request("read_properties", { path, properties }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_list_tags",
    {
      description: "List CollectionService tags or bounded summaries of instances carrying one tag.",
      inputSchema: z.object({
        path: instancePath.optional(),
        tag: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }).strict().superRefine(({ path, tag }, context) => {
        if ((path === undefined) === (tag === undefined)) {
          context.addIssue({
            code: "custom",
            message: "Provide exactly one of path or tag",
          });
        }
      }),
    },
    async ({ path, tag, limit }) => {
      if ((path === undefined) === (tag === undefined)) {
        return toolError("Provide exactly one of path or tag");
      }
      try {
        return formatToolResult(await bridge.request("list_tags", { path, tag, limit }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_diagnostic_snapshot",
    {
      description: "Read overview, character, UI, or nearby diagnostics with bounded view-specific coverage.",
      inputSchema: z.object({
        view: z.enum(["overview", "character", "ui", "nearby"]).default("overview"),
        root: z.enum(["player_gui", "core_gui", "both"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        radius: z.number().finite().min(1).max(128).optional(),
      }).strict().superRefine((args, context) => {
        if (args.root !== undefined && args.view !== "ui") context.addIssue({ code: "custom", message: "root requires ui view" });
        if (args.radius !== undefined && args.view !== "nearby") context.addIssue({ code: "custom", message: "radius requires nearby view" });
        if (args.limit !== undefined && !["ui", "nearby"].includes(args.view)) context.addIssue({ code: "custom", message: "limit requires ui or nearby view" });
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ view, root, limit, radius }) => {
      try {
        const params = view === "overview" ? {} : { view, _maxResultBytes: referenceResultBytes,
          ...(view === "ui" ? { root: root ?? "player_gui", limit: limit ?? 10 } : {}),
          ...(view === "nearby" ? { radius: radius ?? 32, limit: limit ?? 10 } : {}),
        };
        return formatToolResult(await bridge.request("diagnostic_snapshot", params));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_script_fingerprint",
    {
      description: "Fingerprint one Script, LocalScript, or ModuleScript without returning source or bytecode.",
      inputSchema: z.object({
        path: instancePath,
      }).strict(),
    },
    async ({ path }) => {
      try {
        return formatToolResult(await bridge.request("script_fingerprint", { path }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_script_inventory",
    {
      description: "Inventory script metadata without reading source, bytecode, constants, or upvalues.",
      inputSchema: {
        scope: z.enum(["descendants", "loaded", "running"]),
        root: instancePath.optional(),
        limit: z.number().int().min(1).max(200).default(100),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
      },
    },
    async ({ scope, root, limit, maxVisited }) => {
      try {
        return formatToolResult(await bridge.request("script_inventory", { scope, root, limit, maxVisited }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_remote_inventory",
    {
      description: "Summarize, page, compare, or release remote snapshots, or inspect one remote's live metadata and bounded ValueBase associations; associations are not call arguments.",
      inputSchema: z.object({
        root: instancePath.optional().describe("Defaults to game for fresh scans or the original root for retained snapshots."),
        view: z.enum(["summary", "rows", "diff", "release", "detail"]).default("summary"),
        snapshotId: resourceIdOutput.optional().describe("Retained snapshot identity; required for query, diff, release, and cursors."),
        rowId: resourceIdOutput.optional(),
        attributeNames: z.array(z.string().min(1).max(128)).max(32).optional(),
        includeSiblingValues: z.boolean().optional(),
        compareTo: resourceIdOutput.optional(),
        cursor: z.string().min(1).max(256).optional().describe("Opaque retained-page cursor, 1..256 characters; repeat the same snapshot, query and selection."),
        nameContains: z.string().max(256).optional(),
        pathContains: z.string().max(512).optional(),
        classNames: z.array(z.enum(["RemoteEvent", "RemoteFunction", "UnreliableRemoteEvent"])).max(3).optional(),
        query: z.object({
          nameContains: z.string().max(256).optional(),
          pathContains: z.string().max(512).optional(),
          classNames: z.array(remoteClass).max(3).optional(),
        }).strict().optional().describe("Filters already retained rows, not a new scan; requires snapshotId with rows or summary. Does not change snapshot coverage or expiry."),
        limit: z.number().int().min(1).max(200).default(20),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        fields: z.array(z.enum(["name", "className", "path", "parent"])).max(4).optional(),
        includeReferences,
      }).strict().superRefine((args, context) => {
        if (args.query !== undefined && (args.snapshotId === undefined || !["rows", "summary"].includes(args.view))) {
          context.addIssue({ code: "custom", message: "query requires snapshotId and rows or summary view", path: ["query"] });
        }
        if (args.view === "detail") {
          if (args.root !== undefined ? args.snapshotId !== undefined || args.rowId !== undefined : args.snapshotId === undefined || args.rowId === undefined) {
            context.addIssue({ code: "custom", message: "detail requires exactly root or snapshotId with rowId" });
          }
          for (const key of ["compareTo", "cursor", "nameContains", "pathContains", "classNames", "fields"]) {
            if (args[key] !== undefined) context.addIssue({ code: "custom", message: `${key} is unavailable in detail view`, path: [key] });
          }
          if (args.limit > 50) context.addIssue({ code: "custom", message: "detail limit must not exceed 50", path: ["limit"] });
        } else {
          for (const key of ["rowId", "attributeNames", "includeSiblingValues"]) {
            if (args[key] !== undefined) context.addIssue({ code: "custom", message: `${key} requires detail view`, path: [key] });
          }
        }
        if (args.view === "release" && args.cursor !== undefined) {
          context.addIssue({ code: "custom", message: "release does not accept cursor", path: ["cursor"] });
        }
        if ((args.view === "diff" || args.view === "release" || args.cursor !== undefined) && !args.snapshotId) {
          context.addIssue({ code: "custom", message: "This view or cursor requires snapshotId", path: ["snapshotId"] });
        }
        if (args.view === "diff" && !args.compareTo) {
          context.addIssue({ code: "custom", message: "diff requires compareTo", path: ["compareTo"] });
        }
        if (args.compareTo !== undefined && args.view !== "diff") {
          context.addIssue({ code: "custom", message: "compareTo requires diff view", path: ["compareTo"] });
        }
      }),
      outputSchema: inventoryOutput,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const result = await bridge.request("remote_inventory", {
          ...args, root: args.root ?? (args.snapshotId === undefined ? "game" : undefined),
          ...(args.view === "detail" ? { includeSiblingValues: args.includeSiblingValues ?? false } : {}),
          _maxResultBytes: referenceResultBytes,
        });
        if (args.view === "detail" && result?.view !== "detail") {
          throw Object.assign(new Error("Invalid remote detail result"), { code: "RESULT_INVALID" });
        }
        if (args.query !== undefined && (result?.queryScope !== "retained-rows" || !remoteCount.safeParse(result.queryMatched).success)) {
          throw Object.assign(new Error("Invalid retained inventory query result"), { code: "RESULT_INVALID" });
        }
        return formatToolResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  for (const [method, description, inputSchema, annotations] of [
    ["remote_capture_start",
      "Passively capture selected outbound namecalls and/or inbound events, with optional bounded redacted value examples; never captures returns or inbound RemoteFunction callbacks.",
      z.object({
        targets: z.array(instancePath).min(1).max(16),
        durationMs: z.number().int().min(1000).max(30000).default(5000),
        maxEvents: z.number().int().min(1).max(200).default(100),
        directions: remoteDirections.default(["outbound"]),
        includeValueExamples: z.boolean().default(false),
        maxExamplesPerVariant: z.number().int().min(1).max(3).optional(),
      }).strict().superRefine((args, context) => {
        if (args.maxExamplesPerVariant !== undefined && !args.includeValueExamples) {
          context.addIssue({ code: "custom", message: "maxExamplesPerVariant requires includeValueExamples", path: ["maxExamplesPerVariant"] });
        }
      }), { readOnlyHint: false, idempotentHint: false }],
    ["remote_capture_poll",
      "Read bounded observed argument profiles, value-free summaries, or replayable event pages; profiles are observations, not server signatures.",
      z.object({
        captureId: resourceIdOutput, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
        limit: z.number().int().min(1).max(20).default(20), view: z.enum(["summary", "events", "profiles"]).default("summary"),
      }).strict(), { readOnlyHint: true }],
    ["remote_capture_stop",
      "Stop the owned metadata capture and report cleanup state; in-flight invocations remain independent.",
      z.object({ captureId: resourceIdOutput }).strict(), { readOnlyHint: false }],
  ]) {
    server.registerTool(`potassium_${method}`, {
      description, inputSchema, outputSchema: captureOutputs[method],
      annotations: { destructiveHint: false, openWorldHint: false, ...annotations },
    }, async (args) => {
      const params = method === "remote_capture_start" && args.includeValueExamples
        ? { ...args, maxExamplesPerVariant: args.maxExamplesPerVariant ?? 2 } : args;
      const result = await bridge.request(method, params);
      if ((method === "remote_capture_start" && (result?.recordsValues !== args.includeValueExamples
        || !Array.isArray(result?.directions) || result.directions.length !== args.directions.length
        || args.directions.some((direction) => !result.directions.includes(direction))))
        || (method === "remote_capture_poll" && (args.view === "profiles"
          ? !Array.isArray(result?.profiles) || result.groups !== undefined
          : result?.profiles !== undefined || !Array.isArray(result?.groups) || (args.view === "events" && !Array.isArray(result?.events))))) {
        throw Object.assign(new Error("Invalid capture observation view or opt-in"), { code: "RESULT_INVALID" });
      }
      return formatToolResult(result);
    });
  }


  const spatialQuerySchema = z.object({
    mode: z.enum(["raycast", "radius", "box"]),
    origin: finiteVector.optional(),
    direction: finiteVector.optional(),
    center: finiteVector.optional(),
    size: finiteVector.optional(),
    radius: z.number().finite().min(0.1).max(5000).optional(),
    maxDistance: z.number().finite().min(0.1).max(10000).default(1000),
    maxResults: z.number().int().min(1).max(200).default(100),
    excludePaths: z.array(z.string().max(1024).describe(instancePath.description)).max(16).optional(),
  }).strict().superRefine((value, context) => {
    const required = value.mode === "raycast"
      ? ["origin", "direction"]
      : value.mode === "radius"
        ? ["center", "radius"]
        : ["center", "size"];
    for (const field of required) {
      if (value[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required when mode is ${value.mode}`,
          path: [field],
        });
      }
    }
  });

  server.registerTool(
    "potassium_performance_snapshot",
    {
      description: "Read bounded performance, memory, network, workspace, and class-count statistics.",
      inputSchema: z.object({
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        maxClassCounts: z.number().int().min(1).max(500).default(200),
      }).strict(),
    },
    async ({ maxVisited, maxClassCounts }) => {
      try {
        return formatToolResult(await bridge.request("performance_snapshot", { maxVisited, maxClassCounts }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_overlap_query",
    {
      description: "Query overlapping parts for a BasePart target.",
      inputSchema: z.object({
        path: instancePath,
        maxResults: z.number().int().min(1).max(200).default(100),
        excludePaths: z.array(instancePath).max(16).default([]),
      }).strict(),
    },
    async ({ path, maxResults, excludePaths }) => {
      try {
        return formatToolResult(await bridge.request("overlap_query", { path, maxResults, excludePaths }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_attribute_inventory",
    {
      description: "Inventory bounded scalar-safe attributes for an instance or subtree.",
      inputSchema: z.object({
        path: instancePath,
        recursive: z.boolean().default(false),
        attributeNames: z.array(z.string().min(1).max(128)).max(32).default([]),
        limit: z.number().int().min(1).max(500).default(100),
        maxVisited: z.number().int().min(1).max(10000).default(3000),
      }).strict(),
    },
    async ({ path, recursive, attributeNames, limit, maxVisited }) => {
      try {
        return formatToolResult(await bridge.request(
          "attribute_inventory",
          { path, recursive, attributeNames, limit, maxVisited },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_subtree_summary",
    {
      description: "Summarize a bounded subtree with deterministic class, tag, attribute, and structural digest data.",
      inputSchema: z.object({
        path: instancePath,
        maxDepth: z.number().int().min(0).max(8).default(4),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        maxSummaryEntries: z.number().int().min(1).max(500).default(200),
      }).strict(),
    },
    async ({ path, maxDepth, maxVisited, maxSummaryEntries }) => {
      try {
        return formatToolResult(await bridge.request(
          "subtree_summary",
          { path, maxDepth, maxVisited, maxSummaryEntries },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_observe_logs",
    {
      description: "Capture bounded redacted LogService output for a duration, then disconnect.",
      inputSchema: z.object({
        durationMs: z.number().int().min(100).max(5000).default(1000),
        maxEvents: z.number().int().min(1).max(200).default(100),
        minLevel: z.enum(["output", "info", "warning", "error"]).default("output"),
      }).strict(),
    },
    async ({ durationMs, maxEvents, minLevel }) => {
      try {
        return formatToolResult(await bridge.request("observe_logs", { durationMs, maxEvents, minLevel }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_spatial_query",
    {
      description: "Query Workspace by raycast, radius, or box.",
      inputSchema: spatialQuerySchema,
    },
    async ({ mode, origin, direction, center, size, radius, maxDistance, maxResults, excludePaths }) => {
      const required = mode === "raycast"
        ? [origin, direction]
        : mode === "radius"
          ? [center, radius]
          : [center, size];
      if (required.some((value) => value === undefined)) {
        return toolError(`Required spatial query fields are missing for mode ${mode}`);
      }
      try {
        return formatToolResult(await bridge.request("spatial_query", {
          mode, origin, direction, center, size, radius, maxDistance, maxResults, excludePaths,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_ui_inventory",
    {
      description: "Inventory bounded PlayerGui and CoreGui metadata.",
      inputSchema: {
        roots: z.enum(["player_gui", "core_gui", "both"]).default("player_gui"),
        includeText: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
        maxVisited: z.number().int().min(1).max(10000).default(3000),
      },
    },
    async ({ roots, includeText, limit, maxVisited }) => {
      try {
        return formatToolResult(await bridge.request("ui_inventory", { roots, includeText, limit, maxVisited }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_signal_inventory",
    {
      description: "Inspect connection metadata for named RBXScriptSignal properties.",
      inputSchema: {
        path: instancePath,
        signals: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64)).min(1).max(16),
        limitPerSignal: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ path, signals, limitPerSignal }) => {
      try {
        return formatToolResult(await bridge.request("signal_inventory", { path, signals, limitPerSignal }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_observe_changes",
    {
      description: "Observe bounded instance changes for a duration, then disconnect listeners.",
      inputSchema: {
        path: instancePath,
        durationMs: z.number().int().min(100).max(5000).default(1000),
        maxEvents: z.number().int().min(1).max(200).default(100),
        properties: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64)).max(16).default([]),
        includeAttributes: z.boolean().default(true),
        includeChildren: z.boolean().default(true),
      },
    },
    async ({ path, durationMs, maxEvents, properties, includeAttributes, includeChildren }) => {
      try {
        return formatToolResult(await bridge.request(
          "observe_changes",
          { path, durationMs, maxEvents, properties, includeAttributes, includeChildren },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const watchId = z.string().regex(/^[a-f0-9]{32}$/, "watchId must be a lowercase 32-hex identifier");
  server.registerTool(
    "potassium_watch_start",
    {
      description: "Start a generation-scoped instance watch; bounded events persist until idle expiry or explicit stop.",
      inputSchema: z.object({
        path: instancePath,
        properties: z.array(propertyName).max(16).default([]),
        includeAttributes: z.boolean().default(true),
        includeChildren: z.boolean().default(true),
        maxEvents: z.number().int().min(1).max(200).default(100),
        ttlSeconds: z.number().int().min(10).max(300).default(60),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ path, properties, includeAttributes, includeChildren, maxEvents, ttlSeconds }) => {
      try {
        return formatToolResult(await bridge.request("watch_start", { path, properties, includeAttributes, includeChildren, maxEvents, ttlSeconds }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "potassium_watch_poll",
    {
      description: "Read a replayable watch page with cursor-eviction reporting; polling renews active watches.",
      inputSchema: z.object({
        watchId,
        afterCursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      }).strict(),
    },
    async ({ watchId, afterCursor, limit }) => {
      try {
        return formatToolResult(await bridge.request("watch_poll", { watchId, afterCursor, limit }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "potassium_watch_stop",
    {
      description: "Stop a watch and disconnect listeners; buffered events remain available during retention.",
      inputSchema: z.object({ watchId }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ watchId }) => {
      try {
        return formatToolResult(await bridge.request("watch_stop", { watchId }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_artifact_read",
    {
      description: "Read a bounded UTF-8 text artifact from a configured local root.",
      inputSchema: z.object({
        root: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        path: z.string().min(1).max(4096),
        offsetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        maxBytes: z.number().int().min(1).max(262144).default(4096),
      }).strict(),
    },
    async (args) => {
      try {
        return formatToolResult(await readArtifact(args, config));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_http_get",
    {
      description: "GET bounded text, JSON, or XML from an explicitly configured HTTPS host.",
      inputSchema: z.object({
        url: z.string().url().max(4096),
        timeoutMs: z.number().int().min(1).max(10000).default(5000),
        maxBytes: z.number().int().min(1).max(262144).default(65536),
      }).strict(),
    },
    async (args) => {
      try {
        return formatToolResult(await getAllowedHttps(args, config));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const traceTime = z.union([z.number().finite().min(0), z.string().datetime().max(64)]);
  const traceQuerySchema = z.object({
    path: boundedPath,
    eventType: z.string().min(1).max(128).optional(),
    since: traceTime.optional(),
    until: traceTime.optional(),
    maxRows: z.number().int().min(1).max(500).default(20),
    maxBytes: z.number().int().min(1).max(262144).default(8192),
  }).strict();
  const placeMetadataSchema = z.object({
    kind: z.enum(["universe", "place", "thumbnail", "user"]),
    id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    size: z.enum(["150x150", "256x256", "512x512"]).optional(),
    timeoutMs: z.number().int().min(1).max(10000).default(5000),
    maxBytes: z.number().int().min(1).max(262144).default(65536),
  }).strict().superRefine(({ kind, size }, context) => {
    if (kind !== "thumbnail" && size !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "size is only valid for thumbnail metadata", path: ["size"] });
    }
  });

  server.registerTool(
    "potassium_trace_query",
    { description: "Query bounded redacted records from configured traces.", inputSchema: traceQuerySchema },
    async (args) => {
      try { return formatToolResult(await queryTrace(args, config)); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_trace_summary",
    { description: "Summarize bounded redacted trace records; raw rows are omitted unless includeRows is true.", inputSchema: traceQuerySchema.extend({ includeRows: z.boolean().default(false) }) },
    async (args) => {
      try { return formatToolResult(await summarizeTrace(args, config)); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_place_metadata",
    { description: "Fetch bounded public Roblox metadata for one numeric universe, place, thumbnail, or user identifier.", inputSchema: placeMetadataSchema },
    async (args) => {
      try { return formatToolResult(await getPlaceMetadata(args, config)); } catch (error) { return toolError(error); }
    },
  );

  server.registerTool(
    "potassium_snapshot_diff",
    {
      description: "Compare bounded instance snapshots over a duration and return a limited deterministic diff.",
      inputSchema: z.object({
        path: instancePath,
        properties: z.array(propertyName).max(16).default(["Name"]),
        includeAttributes: z.boolean().default(true),
        includeTags: z.boolean().default(true),
        maxDepth: z.number().int().min(0).max(3).default(1),
        maxVisited: z.number().int().min(1).max(500).default(100),
        durationMs: z.number().int().min(50).max(2000).default(250),
        maxChanges: z.number().int().min(1).max(500).default(100),
      }).strict(),
    },
    async (args) => {
      try { return formatToolResult(await bridge.request("snapshot_diff", args)); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_multi_read_properties",
    {
      description: "Read allowlisted properties from a bounded list of Roblox instance paths.",
      inputSchema: z.object({
        requests: z.array(z.object({ path: instancePath, properties: z.array(propertyName).min(1).max(32) }).strict()).min(1).max(20),
        maxTotalValues: z.number().int().min(1).max(200).default(200),
      }).strict().superRefine(({ requests, maxTotalValues }, context) => {
        if (requests.reduce((total, request) => total + request.properties.length, 0) > maxTotalValues) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "Requested properties exceed maxTotalValues", path: ["requests"] });
        }
      }),
    },
    async ({ requests, maxTotalValues }) => {
      try { return formatToolResult(await bridge.request("multi_read_properties", { requests, maxTotalValues })); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_batch_read",
    {
      description: "Read properties, scalar attributes, and direct-child summaries for up to 20 targets under shared quotas; coverage is non-atomic.",
      inputSchema: z.object({
        requests: z.array(batchSelection).min(1).max(20),
        maxTotalValues: z.number().int().min(1).max(200).default(200),
        includeReferences,
      }).strict(),
      annotations: { readOnlyHint: false },
    },
    async ({ requests, maxTotalValues, includeReferences }) => {
      try {
        return formatToolResult(await bridge.request("batch_read", {
          requests, maxTotalValues, includeReferences, _maxResultBytes: referenceResultBytes,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "potassium_instance_references_release",
    {
      description: "Release generation-shared instance references and registry listeners; absent references return released=false.",
      inputSchema: z.object({
        references: z.array(z.string().regex(/^instance:\/\/[a-f0-9]{32}(?![\s\S])/, "reference must be instance:// followed by 32 lowercase hex digits")).min(1).max(128),
      }).strict(),
      annotations: { readOnlyHint: false },
    },
    async ({ references }) => {
      try {
        return formatToolResult(await bridge.request("instance_references_release", { references }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "potassium_instance_ancestry",
    {
      description: "Read one or two bounded instance ancestry chains.",
      inputSchema: z.object({ path: instancePath, otherPath: instancePath.optional(), maxDepth: z.number().int().min(1).max(32).default(16) }).strict(),
    },
    async ({ path, otherPath, maxDepth }) => {
      try { return formatToolResult(await bridge.request("instance_ancestry", { path, otherPath, maxDepth })); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_class_summary",
    {
      description: "Summarize Roblox classes under a bounded traversal path.",
      inputSchema: z.object({
        path: instancePath,
        maxDepth: z.number().int().min(0).max(8).default(4),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        maxClasses: z.number().int().min(1).max(200).default(100),
      }).strict(),
    },
    async (args) => {
      try { return formatToolResult(await bridge.request("class_summary", args)); } catch (error) { return toolError(error); }
    },
  );


  // SDK registration is lazy; deny-all still has a defined discovery/denial contract.
  const canExposeTools = ["potassium_status", "potassium_admin_status", "potassium_execute_luau"]
    .some((name) => allowsTool(policy, name, { allowUnsafeExecute: config.allowUnsafeExecute }));
  if (!canExposeTools) {
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    server.server.setRequestHandler(CallToolRequestSchema, () => {
      sessionStats.recordProtocolError();
      return toolError(new Error("Tool is not permitted by the session policy"));
    });
  }
  return server;
}

export async function createServer(config, { configFile, gameContextService, mapContextService, mapRecordingService } = {}) {
  if (config === undefined) configFile = resolveConfigPath({ configFile });
  config = config === undefined ? await loadConfig(configFile) : await parseConfig(config);
  gameContextService ??= configFile === undefined ? undefined : createGameContextService({ configFile: resolve(configFile) });
  mapContextService ??= configFile === undefined ? undefined : createMapContextService({
    configFile: resolve(configFile), gameContextService,
  });
  mapRecordingService ??= mapContextService === undefined ? undefined : createMapRecordingService({ mapContextService });
  const logger = {
    info: (...args) => console.error("[potassium-mcp]", ...args),
    error: (...args) => console.error("[potassium-mcp]", ...args),
  };
  const bridge = new PotassiumBridge(config, logger);
  const audit = new AdminAuditRecorder({ path: config.adminAuditPath });
  const policy = config.hostPolicies === undefined ? fullAccessPolicy : config.policies.hosts.omp;
  const server = createToolServer(config, bridge, { audit, hostId: "omp", policy, gameContextService, mapContextService, mapRecordingService });
  let closePromise;
  const close = () => {
    closePromise ??= Promise.allSettled([server.close(), bridge.close(), gameContextService?.close(), mapContextService?.close(), mapRecordingService?.close()]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    return closePromise;
  };
  try {
    await bridge.start();
    bridge.on("connected", () => logger.info("Potassium connected"));
    bridge.on("disconnected", () => logger.info("Potassium disconnected"));
    bridge.on("error", (error) => logger.error(error));
    return { server, bridge, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export async function main() {
  let lifecycle;
  try {
    lifecycle = await createServer(undefined, { configFile: resolveConfigPath({ configFile: commandConfigPath() }) });
    const { server, bridge, close } = lifecycle;
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[potassium-mcp] WebSocket listening on ${bridge.status().endpoint}`);

    let shutdownPromise;
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return shutdownPromise ?? Promise.resolve();
      shuttingDown = true;
      const fallback = setTimeout(() => {
        console.error("[potassium-mcp] Shutdown timed out");
        process.exit(1);
      }, bridge.config.shutdownGraceMs);
      fallback.unref();
      shutdownPromise = close().finally(() => clearTimeout(fallback));
      return shutdownPromise;
    };
    const onShutdown = () => {
      void shutdown().catch((error) => {
        console.error("[potassium-mcp] Shutdown failed:", error);
        process.exitCode = 1;
      });
    };
    transport.onclose = onShutdown;
    process.stdin.once("end", onShutdown);
    process.stdin.once("close", onShutdown);
    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
  } catch (error) {
    await lifecycle?.close().catch(() => {});
    throw error;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error("[potassium-mcp] Fatal:", error);
    process.exitCode = 1;
  });
}

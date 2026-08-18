import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
const configPath = commandConfigPath() ?? process.env.POTASSIUM_MCP_CONFIG ?? resolve(here, "../config.json");
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
  httpEnabled: z.boolean().default(false),
  httpHost: z.enum(loopbackHosts).optional(),
  httpPort: z.number().int().min(0).max(65535).default(32147),
  httpMaxBodyBytes: z.number().int().min(16 * 1024).max(16 * 1024 * 1024).default(1024 * 1024),
  httpMaxSessions: z.number().int().min(1).max(1024).default(32),
  httpAllowedOrigins: z.array(z.string().url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  }, "HTTP allowed origins must be absolute HTTP(S) origins without a path")).max(32).default([]),
  artifactRoots: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    path: z.string().min(1).max(4096),
    recursive: z.boolean().default(false),
    extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,16}$/i)).min(1).max(16),
  }).strict()).max(16).default([]),
  httpAllowedHosts: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i)).max(32).default([]),
  adminAuditPath: z.string().min(1).max(4096).optional(),
  allowUnsafeExecute: z.boolean().default(false),
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
  if (new Set(config.httpAllowedHosts.map((host) => host.toLowerCase())).size !== config.httpAllowedHosts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "HTTP allowed hosts must be unique",
      path: ["httpAllowedHosts"],
    });
  }
});

export function formatToolResult(value, maxMessageBytes) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return toolError("Result could not be serialized. Narrow the request and retry.");
  }

  if (text === undefined) text = JSON.stringify({ value: null });
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : { value };
  const result = {
    content: [{ type: "text", text }],
    structuredContent,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxMessageBytes) {
    return toolError(
      `Result exceeds the ${maxMessageBytes}-byte response limit. `
      + "Narrow path or filters, or reduce limit, maxVisited, maxResults, or maxClasses.",
    );
  }

  return result;
}

export function actionableToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Potassium is not connected") {
    return `${message}. Start or re-attach Potassium, then call potassium_status.`;
  }
  if (message.includes("recovering from a timed-out request")) {
    return `${message}. Await the late response, call potassium_status, restart Potassium if recovery is stuck, then retry with narrower bounds.`;
  }
  if (message.includes("timed out after")) {
    return `${message}. Await the late response, call potassium_status, restart Potassium if recovery is stuck, then retry with a narrower path or lower limit, maxVisited, maxResults, or maxClasses.`;
  }
  if (message.includes("request limit reached") || message.includes("Request capacity exceeded")) {
    return `${message}. Wait for the active request to finish, then retry once.`;
  }
  if (message.includes("maximum message size") || message.includes("Result too large")) {
    return `${message}. Narrow path or filters, or reduce limit, maxVisited, maxResults, or maxClasses.`;
  }
  return message;
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: actionableToolError(error) }],
  };
}

const objectOutputSchema = z.object({}).catchall(z.unknown());
const openWorldTools = new Set(["potassium_http_get", "potassium_place_metadata"]);
const titleWords = new Map([["http", "HTTP"], ["ui", "UI"]]);

function potassiumToolTitle(name) {
  const words = name.replace(/^potassium_/, "").split("_");
  return `Potassium ${words.map((word) =>
    titleWords.get(word) ?? `${word[0].toUpperCase()}${word.slice(1)}`).join(" ")}`;
}

class PotassiumMcpServer extends McpServer {
  registerTool(name, config, handler) {
    return super.registerTool(name, {
      title: potassiumToolTitle(name),
      ...config,
      outputSchema: config.outputSchema ?? objectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: openWorldTools.has(name),
        ...config.annotations,
      },
    }, handler);
  }
}

export async function parseConfig(config, directory = here) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }

  const { tokenFile, artifactRoots, httpAllowedHosts, httpAllowedOrigins, adminAuditPath, ...resolved } = parsed.data;
  const token = tokenFile === undefined
    ? resolved.token
    : (await readFile(resolve(directory, tokenFile), "utf8")).trim();
  if (token.length < 32 || token.length > 4096) {
    throw new Error("Config token must contain between 32 and 4096 characters");
  }

  return {
    ...resolved,
    token,
    proxyHost: resolved.proxyHost ?? resolved.host,
    httpHost: resolved.httpHost ?? resolved.host,
    artifactRoots: artifactRoots.map((root) => ({
      ...root,
      path: resolve(directory, root.path),
      extensions: root.extensions.map((extension) => extension.toLowerCase()),
    })),
    httpAllowedHosts: httpAllowedHosts.map((host) => host.toLowerCase()),
    httpAllowedOrigins: httpAllowedOrigins.map((origin) => new URL(origin).origin),
    ...(adminAuditPath === undefined ? {} : { adminAuditPath: resolve(directory, adminAuditPath) }),
  };
}

export async function loadConfig(path = configPath) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(config, dirname(path));
}

export function createToolServer(config, bridge, { audit = new AdminAuditRecorder({ path: config.adminAuditPath }), sessionId = randomBytes(16).toString("hex") } = {}) {
  // Reserve space for the JSON-RPC envelope, request ID, and UTF-8 escaping.
  const maxResultBytes = Math.min(config.maxMessageBytes, config.proxyMaxFrameBytes - 8192);
  const server = new PotassiumMcpServer({ name: "potassium-mcp", version: packageMetadata.version });
  const boundedPath = z.string().min(1).max(1024);
  const propertyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64);
  const trustedCode = z.string().min(1).max(32768).refine(
    (code) => Buffer.byteLength(code, "utf8") <= 32768,
    "code exceeds 32768 UTF-8 bytes",
  );
  const finiteVector = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }).strict();

  server.registerTool(
    "potassium_status",
    { description: "Report whether the local Potassium bootstrap is connected." },
    async () => formatToolResult(bridge.status(), maxResultBytes),
  );

  server.registerTool(
    "potassium_capabilities",
    { description: "Probe the connected Potassium executor's supported bridge capabilities." },
    async () => {
      try {
        return formatToolResult(await bridge.request("capabilities"), maxResultBytes);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (config.allowUnsafeExecute) {
    server.registerTool(
      "potassium_execute_luau",
      {
        description: "Execute trusted Luau in the connected Potassium client. This unrestricted admin tool is disabled unless allowUnsafeExecute is explicitly enabled in the local authenticated configuration.",
        inputSchema: {
          code: trustedCode,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ code }) => {
        const operation = audit.begin({ code, bridge, sessionId });
        try {
          const result = await bridge.request("execute_luau", { code });
          await audit.finish(operation, "success");
          return formatToolResult(result, maxResultBytes);
        } catch (error) {
          const outcome = String(error instanceof Error ? error.message : error).includes("timed out after")
            ? "timeout"
            : "error";
          await audit.finish(operation, outcome, error);
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "potassium_admin_status",
      {
        description: "Report bridge activity and recovery state for the local admin executor transport. Status never includes code, results, or secrets.",
      },
      async () => formatToolResult(bridge.status(), maxResultBytes),
    );
    server.registerTool(
      "potassium_admin_history",
      {
        description: "Read recent redacted execute_luau audit metadata. Entries never include code or returned values.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).default(20),
        }).strict(),
      },
      async ({ limit }) => formatToolResult({ entries: audit.history(limit) }, maxResultBytes),
    );
    server.registerTool(
      "potassium_admin_recover",
      {
        description: "Compare-and-swap reset the executor transport. Disconnecting transport does not forcibly terminate arbitrary Luau already running in the client.",
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
          return formatToolResult(bridge.recover(expectedRecoveryGeneration), maxResultBytes);
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }


  server.registerTool(
    "potassium_client_state",
    { description: "Read PlaceId, JobId presence, player state, character state, and position." },
    async () => {
      try {
        return formatToolResult(await bridge.request("client_state"), maxResultBytes);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_list_children",
    {
      description: "List direct children of a Roblox instance resolved from a dotted path.",
      inputSchema: {
        path: z.string().min(1).max(1024).describe("Example: workspace.AdminAbuse"),
        limit: z.number().int().min(1).max(1000).default(200),
      },
    },
    async ({ path, limit }) => {
      try {
        return formatToolResult(await bridge.request("list_children", { path, limit }), maxResultBytes);
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
        path: z.string().min(1).max(1024),
        depth: z.number().int().min(0).max(3).default(0),
        childLimit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ path, depth, childLimit }) => {
      try {
        return formatToolResult(await bridge.request("inspect_instance", { path, depth, childLimit }), maxResultBytes);
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
        root: z.string().min(1).max(1024),
        nameContains: z.string().max(128).optional(),
        pathContains: z.string().max(128).optional(),
        classNames: z.array(z.string().max(64)).max(16).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
      },
    },
    async ({ root, nameContains, pathContains, classNames, limit, maxVisited }) => {
      try {
        return formatToolResult(
          await bridge.request("find_instances", { root, nameContains, pathContains, classNames, limit, maxVisited }),
          maxResultBytes,
        );
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
        path: z.string().min(1).max(1024),
        properties: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64)).min(1).max(32),
      },
    },
    async ({ path, properties }) => {
      try {
        return formatToolResult(await bridge.request("read_properties", { path, properties }), maxResultBytes);
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
        path: z.string().min(1).max(1024).optional(),
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
        return formatToolResult(await bridge.request("list_tags", { path, tag, limit }), maxResultBytes);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_diagnostic_snapshot",
    { description: "Read a passive snapshot of the place, workspace, local character, and physics state." },
    async () => {
      try {
        return formatToolResult(await bridge.request("diagnostic_snapshot"), maxResultBytes);
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
        path: z.string().min(1).max(1024),
      }).strict(),
    },
    async ({ path }) => {
      try {
        return formatToolResult(await bridge.request("script_fingerprint", { path }), maxResultBytes);
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
        root: z.string().min(1).max(1024).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
      },
    },
    async ({ scope, root, limit, maxVisited }) => {
      try {
        return formatToolResult(
          await bridge.request("script_inventory", { scope, root, limit, maxVisited }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_remote_inventory",
    {
      description: "Inventory remote metadata without firing or invoking remotes.",
      inputSchema: {
        root: z.string().min(1).max(1024),
        limit: z.number().int().min(1).max(200).default(100),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
      },
    },
    async ({ root, limit, maxVisited }) => {
      try {
        return formatToolResult(
          await bridge.request("remote_inventory", { root, limit, maxVisited }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );


  const spatialQuerySchema = z.object({
    mode: z.enum(["raycast", "radius", "box"]),
    origin: finiteVector.optional(),
    direction: finiteVector.optional(),
    center: finiteVector.optional(),
    size: finiteVector.optional(),
    radius: z.number().finite().min(0.1).max(5000).optional(),
    maxDistance: z.number().finite().min(0.1).max(10000).default(1000),
    maxResults: z.number().int().min(1).max(200).default(100),
    excludePaths: z.array(z.string().max(1024)).max(16).optional(),
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
      description: "Read a bounded passive snapshot of Roblox performance, memory, workspace, network, and class-count statistics.",
      inputSchema: z.object({
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        maxClassCounts: z.number().int().min(1).max(500).default(200),
      }).strict(),
    },
    async ({ maxVisited, maxClassCounts }) => {
      try {
        return formatToolResult(
          await bridge.request("performance_snapshot", { maxVisited, maxClassCounts }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_overlap_query",
    {
      description: "Perform a bounded read-only overlap query for a BasePart target.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024),
        maxResults: z.number().int().min(1).max(200).default(100),
        excludePaths: z.array(z.string().min(1).max(1024)).max(16).default([]),
      }).strict(),
    },
    async ({ path, maxResults, excludePaths }) => {
      try {
        return formatToolResult(
          await bridge.request("overlap_query", { path, maxResults, excludePaths }),
          maxResultBytes,
        );
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
        path: z.string().min(1).max(1024),
        recursive: z.boolean().default(false),
        attributeNames: z.array(z.string().min(1).max(128)).max(32).default([]),
        limit: z.number().int().min(1).max(500).default(100),
        maxVisited: z.number().int().min(1).max(10000).default(3000),
      }).strict(),
    },
    async ({ path, recursive, attributeNames, limit, maxVisited }) => {
      try {
        return formatToolResult(
          await bridge.request(
            "attribute_inventory",
            { path, recursive, attributeNames, limit, maxVisited },
          ),
          maxResultBytes,
        );
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
        path: z.string().min(1).max(1024),
        maxDepth: z.number().int().min(0).max(8).default(4),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        maxSummaryEntries: z.number().int().min(1).max(500).default(200),
      }).strict(),
    },
    async ({ path, maxDepth, maxVisited, maxSummaryEntries }) => {
      try {
        return formatToolResult(
          await bridge.request(
            "subtree_summary",
            { path, maxDepth, maxVisited, maxSummaryEntries },
          ),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_observe_logs",
    {
      description: "Temporarily capture bounded redacted LogService output and disconnect before returning.",
      inputSchema: z.object({
        durationMs: z.number().int().min(100).max(5000).default(1000),
        maxEvents: z.number().int().min(1).max(200).default(100),
        minLevel: z.enum(["output", "info", "warning", "error"]).default("output"),
      }).strict(),
    },
    async ({ durationMs, maxEvents, minLevel }) => {
      try {
        return formatToolResult(
          await bridge.request("observe_logs", { durationMs, maxEvents, minLevel }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_spatial_query",
    {
      description: "Perform a bounded read-only Workspace raycast, radius, or box query.",
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
        return formatToolResult(
          await bridge.request("spatial_query", {
            mode, origin, direction, center, size, radius, maxDistance, maxResults, excludePaths,
          }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_ui_inventory",
    {
      description: "Inventory bounded PlayerGui and CoreGui metadata without interacting with UI.",
      inputSchema: {
        roots: z.enum(["player_gui", "core_gui", "both"]).default("player_gui"),
        includeText: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
        maxVisited: z.number().int().min(1).max(10000).default(3000),
      },
    },
    async ({ roots, includeText, limit, maxVisited }) => {
      try {
        return formatToolResult(
          await bridge.request("ui_inventory", { roots, includeText, limit, maxVisited }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_signal_inventory",
    {
      description: "Inspect bounded connection metadata for named RBXScriptSignal properties without invoking them.",
      inputSchema: {
        path: z.string().min(1).max(1024),
        signals: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64)).min(1).max(16),
        limitPerSignal: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ path, signals, limitPerSignal }) => {
      try {
        return formatToolResult(
          await bridge.request("signal_inventory", { path, signals, limitPerSignal }),
          maxResultBytes,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "potassium_observe_changes",
    {
      description: "Temporarily observe bounded safe instance changes and disconnect all listeners before returning.",
      inputSchema: {
        path: z.string().min(1).max(1024),
        durationMs: z.number().int().min(100).max(5000).default(1000),
        maxEvents: z.number().int().min(1).max(200).default(100),
        properties: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64)).max(16).default([]),
        includeAttributes: z.boolean().default(true),
        includeChildren: z.boolean().default(true),
      },
    },
    async ({ path, durationMs, maxEvents, properties, includeAttributes, includeChildren }) => {
      try {
        return formatToolResult(
          await bridge.request(
            "observe_changes",
            { path, durationMs, maxEvents, properties, includeAttributes, includeChildren },
          ),
          maxResultBytes,
        );
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
        maxBytes: z.number().int().min(1).max(262144).default(65536),
      }).strict(),
    },
    async (args) => {
      try {
        return formatToolResult(await readArtifact(args, config), maxResultBytes);
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
        return formatToolResult(await getAllowedHttps(args, config), maxResultBytes);
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
    maxRows: z.number().int().min(1).max(500).default(100),
    maxBytes: z.number().int().min(1).max(262144).default(65536),
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
    { description: "Read a bounded, redacted query of configured trace records without accessing arbitrary files.", inputSchema: traceQuerySchema },
    async (args) => {
      try { return formatToolResult(await queryTrace(args, config), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_trace_summary",
    { description: "Summarize bounded, redacted configured trace records without accessing arbitrary files.", inputSchema: traceQuerySchema },
    async (args) => {
      try { return formatToolResult(await summarizeTrace(args, config), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_place_metadata",
    { description: "Fetch bounded public Roblox metadata for one numeric universe, place, thumbnail, or user identifier.", inputSchema: placeMetadataSchema },
    async (args) => {
      try { return formatToolResult(await getPlaceMetadata(args, config), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );

  server.registerTool(
    "potassium_snapshot_diff",
    {
      description: "Observe a bounded safe snapshot and report a deterministic limited diff without mutation.",
      inputSchema: z.object({
        path: boundedPath,
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
      try { return formatToolResult(await bridge.request("snapshot_diff", args), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_multi_read_properties",
    {
      description: "Read allowlisted properties from a bounded list of Roblox instance paths.",
      inputSchema: z.object({
        requests: z.array(z.object({ path: boundedPath, properties: z.array(propertyName).min(1).max(32) }).strict()).min(1).max(20),
        maxTotalValues: z.number().int().min(1).max(200).default(200),
      }).strict().superRefine(({ requests, maxTotalValues }, context) => {
        if (requests.reduce((total, request) => total + request.properties.length, 0) > maxTotalValues) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "Requested properties exceed maxTotalValues", path: ["requests"] });
        }
      }),
    },
    async ({ requests, maxTotalValues }) => {
      try { return formatToolResult(await bridge.request("multi_read_properties", { requests, maxTotalValues }), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_instance_ancestry",
    {
      description: "Read one or two bounded Roblox instance ancestry chains without mutation.",
      inputSchema: z.object({ path: boundedPath, otherPath: boundedPath.optional(), maxDepth: z.number().int().min(1).max(32).default(16) }).strict(),
    },
    async ({ path, otherPath, maxDepth }) => {
      try { return formatToolResult(await bridge.request("instance_ancestry", { path, otherPath, maxDepth }), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );
  server.registerTool(
    "potassium_class_summary",
    {
      description: "Summarize Roblox classes under a bounded traversal path without mutation.",
      inputSchema: z.object({
        path: boundedPath,
        maxDepth: z.number().int().min(0).max(8).default(4),
        maxVisited: z.number().int().min(1).max(20000).default(5000),
        maxClasses: z.number().int().min(1).max(200).default(100),
      }).strict(),
    },
    async (args) => {
      try { return formatToolResult(await bridge.request("class_summary", args), maxResultBytes); } catch (error) { return toolError(error); }
    },
  );


  return server;
}

export async function createServer(config) {
  config = config === undefined ? await loadConfig() : await parseConfig(config);
  const logger = {
    info: (...args) => console.error("[potassium-mcp]", ...args),
    error: (...args) => console.error("[potassium-mcp]", ...args),
  };
  const bridge = new PotassiumBridge(config, logger);
  const audit = new AdminAuditRecorder({ path: config.adminAuditPath });
  const server = createToolServer(config, bridge, { audit });
  let closePromise;
  const close = () => {
    closePromise ??= Promise.allSettled([server.close(), bridge.close()]).then((results) => {
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
    lifecycle = await createServer();
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

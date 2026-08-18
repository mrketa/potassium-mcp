import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { findNodeAtLocation, parse as parseJsonc, parseTree } from "jsonc-parser";

export const HOST_IDS = Object.freeze([
  "codex",
  "claude-code",
  "claude-desktop",
  "vscode",
  "cursor",
  "gemini",
  "manual",
]);

const MANAGED_CODEX_HEADER = "# potassium-mcp managed; do not edit";
const INSERTED_SEPARATOR = "# potassium-mcp inserted separator";
const DEFAULT_SCOPES = Object.freeze({
  codex: "user",
  "claude-code": "user",
  "claude-desktop": "user",
  vscode: "user",
  cursor: "user",
  gemini: "user",
  manual: "user",
});

function assertHost(hostId) {
  if (!HOST_IDS.includes(hostId)) throw new Error(`unsupported MCP host: ${hostId}`);
}

function pathApi(cwd) {
  return /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes("\\") ? path.win32 : path;
}

function home(env, api) {
  const value = env.USERPROFILE ?? env.HOME;
  if (!value) throw new Error("USERPROFILE or HOME is required to resolve a user-scoped host configuration");
  return value;
}

function appData(env, api) {
  return env.APPDATA ?? api.join(home(env, api), "AppData", "Roaming");
}

function requireScope(scope, supported, hostId) {
  if (!supported.includes(scope)) throw new Error(`${hostId} does not support the ${scope} scope`);
}

function jsonTarget(id, api, cwd, env, scope) {
  switch (id) {
    case "claude-code":
      requireScope(scope, ["project"], id);
      return { path: api.join(cwd, ".mcp.json"), key: "mcpServers", type: "stdio" };
    case "claude-desktop":
      requireScope(scope, ["user"], id);
      return { path: api.join(appData(env, api), "Claude", "claude_desktop_config.json"), key: "mcpServers" };
    case "vscode":
      requireScope(scope, ["user", "project"], id);
      return {
        path: scope === "project"
          ? api.join(cwd, ".vscode", "mcp.json")
          : api.join(appData(env, api), "Code", "User", "mcp.json"),
        key: "servers",
        type: "stdio",
      };
    case "cursor":
      requireScope(scope, ["user", "project"], id);
      return {
        path: scope === "project" ? api.join(cwd, ".cursor", "mcp.json") : api.join(home(env, api), ".cursor", "mcp.json"),
        key: "mcpServers",
        type: "stdio",
      };
    case "gemini":
      requireScope(scope, ["user", "project"], id);
      return {
        path: scope === "project" ? api.join(cwd, ".gemini", "settings.json") : api.join(home(env, api), ".gemini", "settings.json"),
        key: "mcpServers",
      };
    default:
      throw new Error(`no JSON target for ${id}`);
  }
}

/** Resolve a host to its documented configuration surface without touching the filesystem. */
export function resolveHost(hostId, options = {}) {
  assertHost(hostId);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const scope = options.scope ?? DEFAULT_SCOPES[hostId];
  const api = pathApi(cwd);
  if (hostId === "manual") return { id: hostId, kind: "manual", scope, writable: false };
  if (hostId === "codex") {
    requireScope(scope, ["user"], hostId);
    return {
      id: hostId,
      kind: "toml",
      scope,
      path: options.configPath ?? api.join(home(env, api), ".codex", "config.toml"),
      writable: true,
    };
  }
  if (hostId === "claude-code" && scope !== "project") {
    requireScope(scope, ["user", "local"], hostId);
    return { id: hostId, kind: "cli", scope, writable: false, command: "claude" };
  }
  const target = jsonTarget(hostId, api, cwd, env, scope);
  return {
    id: hostId,
    kind: "json",
    scope,
    path: options.configPath ?? target.path,
    key: target.key,
    type: target.type,
    writable: true,
  };
}

function assertLauncher(launcher) {
  if (
    !launcher
    || launcher.type !== "stdio"
    || typeof launcher.command !== "string"
    || !path.isAbsolute(launcher.command)
    || !Array.isArray(launcher.args)
    || !launcher.args.every((value) => typeof value === "string")
  ) throw new Error("launcher must be a normalized stdio launcher with an absolute command and string args");
}

function entryFor(target, launcher) {
  const base = { command: launcher.command, args: launcher.args };
  if (target.type) return { type: target.type, ...base };
  return base;
}

function parseObject(source) {
  if (source === undefined || source === null || source === "") return {};
  const errors = [];
  const value = parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new Error("host configuration is not valid JSON or JSONC");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host configuration must be a JSON object");
  }
  return value;
}

function parseDocument(source) {
  const text = source || "{}";
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !tree) {
    throw new Error("host configuration is not valid JSON or JSONC");
  }
  if (tree.type !== "object") throw new Error("host configuration must be a JSON object");
  return { text, tree, value: parseObject(text) };
}

function insertJsonProperty(text, parent, name, value) {
  const first = parent.children?.[0];
  const lineStart = text.lastIndexOf("\n", parent.offset) + 1;
  const parentIndent = /^[ \t]*/.exec(text.slice(lineStart, parent.offset))[0];
  const childIndent = `${parentIndent}  `;
  const serialized = JSON.stringify(value, null, 2).replace(/\n/g, `\n${childIndent}`);
  const property = `${JSON.stringify(name)}: ${serialized}`;
  if (!first) {
    const offset = parent.offset + 1;
    return `${text.slice(0, offset)}${property}${text.slice(offset)}`;
  }
  return `${text.slice(0, first.offset)}${property},\n${childIndent}${text.slice(first.offset)}`;
}

function removeJsonProperty(text, parent, property) {
  const siblings = parent.children;
  const index = siblings.indexOf(property);
  if (siblings.length === 1) {
    return `${text.slice(0, property.offset)}${text.slice(property.offset + property.length)}`;
  }
  if (index < siblings.length - 1) {
    return `${text.slice(0, property.offset)}${text.slice(siblings[index + 1].offset)}`;
  }
  const previousEnd = siblings[index - 1].offset + siblings[index - 1].length;
  const comma = text.indexOf(",", previousEnd);
  return `${text.slice(0, comma)}${text.slice(property.offset + property.length)}`;
}

function jsonTransform(target, source, launcher) {
  const { text, tree, value: config } = parseDocument(source);
  const servers = config[target.key] === undefined ? {} : config[target.key];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`${target.key} must be a JSON object`);
  }
  const entry = entryFor(target, launcher);
  const existing = servers.potassium;
  if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
    throw new Error("refusing to replace an unmanaged potassium entry");
  }
  if (isDeepStrictEqual(existing, entry)) return { content: source, changed: false, entry };
  const serversNode = findNodeAtLocation(tree, [target.key]);
  const content = serversNode
    ? insertJsonProperty(text, serversNode, "potassium", entry)
    : insertJsonProperty(text, tree, target.key, { potassium: entry });
  return { content, changed: true, entry };
}

function escapeToml(value) {
  return JSON.stringify(value);
}

function codexBlock(launcher) {
  const timeout = Number.isFinite(launcher.timeout) ? Math.ceil(launcher.timeout / 1000) : undefined;
  return `${MANAGED_CODEX_HEADER}\n[mcp_servers.potassium]\ncommand = ${escapeToml(launcher.command)}\nargs = ${JSON.stringify(launcher.args)}${timeout === undefined ? "" : `\nstartup_timeout_sec = ${timeout}`}\n`;
}

function potassiumTable(source) {
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:potassium|"potassium"|'potassium')\s*\]\s*(?:#.*)?$/m.exec(source);
}

function managedCodexSection(source, launcher) {
  const block = codexBlock(launcher);
  const blockStart = source.indexOf(block);
  if (blockStart < 0) return null;
  const separator = `\n${INSERTED_SEPARATOR}\n`;
  const hasInsertedSeparator = source.slice(blockStart - separator.length, blockStart) === separator;
  const start = hasInsertedSeparator ? blockStart - separator.length : blockStart;
  return { start, end: blockStart + block.length, text: source.slice(start, blockStart + block.length) };
}

/** Return a non-mutating install operation for a host. */
export function createInstallPlan(hostId, launcher, options = {}) {
  assertLauncher(launcher);
  const target = resolveHost(hostId, options);
  if (target.kind === "manual") {
    return {
      ...target,
      json: renderJsonSnippet(launcher),
      toml: codexBlock(launcher).trimEnd(),
      http: [
        "Optional Streamable HTTP is disabled by default.",
        "Enable it only in the protected runtime configuration, keep it on loopback, and use its configured endpoint with Authorization: Bearer <credential supplied by a secure credential provider>.",
        "Do not put credentials in copied configuration, command lines, logs, or chat. If the client cannot inject an Authorization bearer credential securely, use the stdio configuration above instead.",
      ].join(" "),
    };
  }
  if (target.kind === "cli") {
    return {
      ...target,
      args: ["mcp", "add", "potassium", "--scope", target.scope, "--", launcher.command, ...launcher.args],
    };
  }
  return { ...target, operation: "write" };
}

/** Merge a launcher into host configuration content, refusing foreign potassium entries. */
export function transformConfig(hostId, source, launcher, options = {}) {
  assertLauncher(launcher);
  const target = resolveHost(hostId, options);
  if (target.kind === "manual" || target.kind === "cli") {
    throw new Error(`${hostId} does not support direct configuration mutation for this scope`);
  }
  if (target.kind === "json") return jsonTransform(target, source, launcher);

  const text = source ?? "";
  const managed = managedCodexSection(text, launcher);
  if (managed) return { content: text, changed: false, entry: codexBlock(launcher) };
  if (potassiumTable(text)) {
    throw new Error("refusing to replace an unmanaged potassium Codex section");
  }
  const block = codexBlock(launcher);
  const separator = text && !text.endsWith("\n") ? `\n${INSERTED_SEPARATOR}\n` : "";
  return { content: `${text}${separator}${block}`, changed: true, entry: block };
}

/** Confirm whether the exact launcher is owned by this adapter. */
export function verifyOwnership(hostId, source, launcher, options = {}) {
  assertLauncher(launcher);
  const target = resolveHost(hostId, options);
  if (target.kind === "manual" || target.kind === "cli") {
    return { owned: false, reason: "no-direct-config" };
  }
  try {
    if (target.kind === "toml") {
      return { owned: managedCodexSection(source ?? "", launcher) !== null };
    }
    const config = parseObject(source);
    return { owned: isDeepStrictEqual(config[target.key]?.potassium, entryFor(target, launcher)) };
  } catch (error) {
    return { owned: false, error: error.message };
  }
}

/** Remove only an entry verified as owned; unrelated content remains untouched. */
export function removeConfig(hostId, source, launcher, options = {}) {
  assertLauncher(launcher);
  const target = resolveHost(hostId, options);
  if (target.kind === "manual" || target.kind === "cli") {
    throw new Error(`${hostId} does not support direct configuration mutation for this scope`);
  }
  if (!verifyOwnership(hostId, source, launcher, options).owned) {
    throw new Error("refusing to remove a potassium entry without proven ownership");
  }
  if (target.kind === "toml") {
    const section = managedCodexSection(source, launcher);
    return {
      content: `${source.slice(0, section.start)}${source.slice(section.end)}`,
      changed: true,
    };
  }
  const { text, tree } = parseDocument(source);
  const servers = findNodeAtLocation(tree, [target.key]);
  const property = servers?.children?.find((node) => node.children?.[0]?.value === "potassium");
  return { content: removeJsonProperty(text, servers, property), changed: true };
}

/** Produce a doctor-friendly view without performing I/O or mutation. */
export function inspectHost(hostId, source, launcher, options = {}) {
  const plan = createInstallPlan(hostId, launcher, options);
  const ownership = plan.kind === "manual" || plan.kind === "cli"
    ? { owned: false, reason: "no-direct-config" }
    : verifyOwnership(hostId, source, launcher, options);
  return { ...plan, configured: ownership.owned, ownership };
}

function renderJsonSnippet(launcher) {
  return JSON.stringify({ mcpServers: { potassium: { ...launcher } } }, null, 2);
}

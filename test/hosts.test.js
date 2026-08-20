import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { HOST_IDS, createInstallPlan, inspectHost, removeConfig, resolveHost, transformConfig, verifyOwnership } from "../src/hosts.js";
import { human } from "../bin/potassium-mcp.js";

const cwd = "C:\\work\\project";
const env = { USERPROFILE: "C:\\Users\\Ada", APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" };
const launcher = { type: "stdio", command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Potassium\\MCP\\src\\proxy.js", "--config", "C:\\Potassium\\MCP\\config.json"], timeout: 40000 };

const cases = [
  ["omp", "project", "C:\\work\\project\\.omp\\mcp.json", "mcpServers", true],
  ["claude-code", "project", "C:\\work\\project\\.mcp.json", "mcpServers", true],
  ["claude-desktop", "user", "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json", "mcpServers", false],
  ["vscode", "user", "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\mcp.json", "servers", true],
  ["vscode", "project", "C:\\work\\project\\.vscode\\mcp.json", "servers", true],
  ["cursor", "user", "C:\\Users\\Ada\\.cursor\\mcp.json", "mcpServers", true],
  ["cursor", "project", "C:\\work\\project\\.cursor\\mcp.json", "mcpServers", true],
  ["gemini", "user", "C:\\Users\\Ada\\.gemini\\settings.json", "mcpServers", false],
  ["gemini", "project", "C:\\work\\project\\.gemini\\settings.json", "mcpServers", false],
];

test("exports stable host IDs", () => assert.deepEqual(HOST_IDS, ["omp", "codex", "claude-code", "claude-desktop", "vscode", "cursor", "gemini", "manual"]));
test("resolves documented Windows user and project configuration paths", () => {
  for (const [id, scope, expected, key, type] of cases) {
    const target = resolveHost(id, { cwd, env, scope });
    assert.equal(target.path, expected, id);
    assert.equal(target.key, key, id);
    assert.equal(target.type === "stdio", type, id);
  }
  assert.equal(resolveHost("codex", { cwd, env, scope: "user" }).path, "C:\\Users\\Ada\\.codex\\config.toml");
  assert.throws(() => resolveHost("omp", { cwd, env, scope: "user" }), /does not support/);
  assert.equal(resolveHost("claude-desktop", { cwd, env }).scope, "user");
  assert.equal(resolveHost("claude-code", { cwd, env }).kind, "cli");
  assert.equal(resolveHost("omp", { cwd, env }).scope, "project");
});

test("JSON adapters preserve unrelated content and enforce ownership", () => {
  for (const [id, scope, , key, type] of cases) {
    const source = JSON.stringify({ unrelated: { retained: true }, [key]: { other: { command: "keep" } } });
    const transformed = transformConfig(id, source, launcher, { cwd, env, scope });
    const parsed = JSON.parse(transformed.content);
    assert.deepEqual(parsed.unrelated, { retained: true }, id);
    assert.deepEqual(parsed[key].other, { command: "keep" }, id);
    assert.equal(parsed[key].potassium.type === "stdio", type, id);
    assert.equal(verifyOwnership(id, transformed.content, launcher, { cwd, env, scope }).owned, true, id);
    const removed = removeConfig(id, transformed.content, launcher, { cwd, env, scope });
    assert.deepEqual(JSON.parse(removed.content), { unrelated: { retained: true }, [key]: { other: { command: "keep" } } }, id);
  }
  const desktop = transformConfig("claude-desktop", "{}", launcher, { cwd, env });
  assert.deepEqual(JSON.parse(desktop.content).mcpServers.potassium, {
    command: launcher.command,
    args: launcher.args,
  });
  const cursor = transformConfig("cursor", "{}", launcher, { cwd, env });
  assert.deepEqual(JSON.parse(cursor.content).mcpServers.potassium, {
    type: "stdio",
    command: launcher.command,
    args: launcher.args,
  });
});
test("host configuration remains the exact token-free stdio launcher", () => {
  const configured = transformConfig("omp", "{}", launcher, { cwd, env }).content;
  const entry = JSON.parse(configured).mcpServers.potassium;
  assert.deepEqual(entry, launcher);
  assert.doesNotMatch(configured, /streamable|token|32147/i);
});


test("JSON adapters refuse foreign potassium entries and malformed input", () => {
  assert.throws(() => transformConfig("omp", '{"mcpServers":{"potassium":{"command":"foreign"}}}', launcher, { cwd, env }), /unmanaged/);
  assert.throws(() => transformConfig("omp", "not json", launcher, { cwd, env }), /valid JSON/);
  assert.throws(() => transformConfig("omp", "[]", launcher, { cwd, env }), /JSON object/);
  assert.throws(() => removeConfig("omp", '{"mcpServers":{"potassium":{"command":"foreign"}}}', launcher, { cwd, env }), /proven ownership/);
});

test("VS Code JSONC edits preserve comments, trailing commas, and unrelated text", () => {
  const source = `{
  // retained comment
  "servers": {
    "other": { "command": "keep" },
  },
}
`;
  const installed = transformConfig("vscode", source, launcher, { cwd, env, scope: "project" });
  assert.match(installed.content, /retained comment/);
  assert.match(installed.content, /"other": \{ "command": "keep" \}/);
  assert.equal(verifyOwnership("vscode", installed.content, launcher, { cwd, env, scope: "project" }).owned, true);
  const removed = removeConfig("vscode", installed.content, launcher, { cwd, env, scope: "project" });
  assert.match(removed.content, /retained comment/);
  assert.match(removed.content, /"other": \{ "command": "keep" \}/);
  assert.doesNotThrow(() => transformConfig("vscode", removed.content, launcher, { cwd, env, scope: "project" }));
});

test("JSON ownership ignores object key order but rejects extra fields", () => {
  const entry = {
    command: launcher.command,
    args: launcher.args,
    type: "stdio",
    timeout: launcher.timeout,
  };
  const reordered = JSON.stringify({ mcpServers: { potassium: entry } });
  assert.equal(verifyOwnership("omp", reordered, launcher, { cwd, env }).owned, true);
  assert.equal(transformConfig("omp", reordered, launcher, { cwd, env }).changed, false);
  assert.doesNotThrow(() => removeConfig("omp", reordered, launcher, { cwd, env }));
  const extra = JSON.stringify({ mcpServers: { potassium: { ...entry, env: {} } } });
  assert.equal(verifyOwnership("omp", extra, launcher, { cwd, env }).owned, false);
});

test("Codex owns only its delimited managed TOML block", () => {
  const source = "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n";
  const transformed = transformConfig("codex", source, launcher, { cwd, env, scope: "user" });
  assert.match(transformed.content, /^model = "o3"/);
  assert.match(transformed.content, /\[mcp_servers\.other\]\ncommand = "keep"/);
  assert.match(transformed.content, /# potassium-mcp managed; do not edit\n\[mcp_servers\.potassium\]/);
  assert.equal(verifyOwnership("codex", transformed.content, launcher, { cwd, env, scope: "user" }).owned, true);
  const removed = removeConfig("codex", transformed.content, launcher, { cwd, env, scope: "user" });
  assert.equal(removed.content, source);
  assert.throws(() => transformConfig("codex", "[mcp_servers.potassium]\ncommand = \"foreign\"\n", launcher, { cwd, env, scope: "user" }), /unmanaged/);
});

test("Codex ownership survives following tables and restores no-newline input exactly", () => {
  const source = "model = \"o3\"";
  const installed = transformConfig("codex", source, launcher, { cwd, env, scope: "user" });
  const extended = `${installed.content}\n[features]\nkeep = true\n`;
  assert.equal(verifyOwnership("codex", extended, launcher, { cwd, env, scope: "user" }).owned, true);
  const removed = removeConfig("codex", extended, launcher, { cwd, env, scope: "user" });
  assert.equal(removed.content, `${source}\n[features]\nkeep = true\n`);
  const roundTrip = removeConfig("codex", installed.content, launcher, { cwd, env, scope: "user" });
  assert.equal(roundTrip.content, source);
});

test("Codex refuses semantically equivalent quoted foreign tables", () => {
  const source = "[mcp_servers.\"potassium\"]\ncommand = \"foreign\"\n";
  assert.throws(
    () => transformConfig("codex", source, launcher, { cwd, env, scope: "user" }),
    /unmanaged/,
  );
});

test("Claude Code user and local scopes are official CLI operation plans", () => {
  for (const scope of ["user", "local"]) {
    const plan = createInstallPlan("claude-code", launcher, { cwd, env, scope });
    assert.deepEqual(plan.args, ["mcp", "add", "potassium", "--scope", scope, "--", launcher.command, ...launcher.args]);
    assert.equal(plan.kind, "cli");
  }
});

test("manual output is rendered without a filesystem operation", () => {
  const plan = createInstallPlan("manual", launcher, { cwd, env });
  assert.equal(plan.kind, "manual");
  assert.match(plan.json, /"mcpServers"/);
  assert.match(plan.toml, /\[mcp_servers\.potassium\]/);
  assert.throws(() => transformConfig("manual", "", launcher, { cwd, env }), /does not support/);
  assert.equal(inspectHost("manual", "", launcher, { cwd, env }).configured, false);
});

test("human CLI output includes complete manual JSON and TOML snippets", () => {
  const plan = createInstallPlan("manual", launcher, { cwd, env });
  const output = human({
    installRoot: "C:\\Potassium\\MCP",
    workspaceRoot: "C:\\Potassium\\workspace",
    hosts: [{ ...plan, id: "manual" }],
  }, "install");
  assert.match(output, /Manual configuration required: manual/);
  assert.match(output, /JSON:\n\{/);
  assert.match(output, /"mcpServers"/);
  assert.match(output, /TOML:\n# potassium-mcp managed/);
  assert.match(output, /\[mcp_servers\.potassium\]/);
});

test("configPath overrides resolved defaults and launcher must be normalized", () => {
  assert.equal(resolveHost("vscode", { cwd, env, scope: "user", configPath: "D:\\shared\\mcp.json" }).path, "D:\\shared\\mcp.json");
  assert.throws(() => createInstallPlan("omp", { ...launcher, command: "node" }, { cwd, env }), /normalized/);
  assert.equal(path.win32.basename(resolveHost("omp", { cwd, env }).path), "mcp.json");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliRegistrationMatches, doctor } from "../src/doctor.js";
import { transformConfig } from "../src/hosts.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (target, value) => writeFile(target, JSON.stringify(value));
const readJson = async (target) => JSON.parse(await readFile(target, "utf8"));
const check = (result, name) => result.checks.find((entry) => entry.name === name);

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "potassium-doctor-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const workspaceRoot = path.join(root, "workspace");
  const autoexecRoot = path.join(root, "autoexec");
  const installRoot = path.join(root, "MCP");
  const configFile = path.join(installRoot, "config.json");
  const statePath = path.join(installRoot, "ownership.json");
  const tokenPath = path.join(workspaceRoot, ".potassium-mcp-token");
  const nodeExecutable = path.join(root, "node.exe");
  await Promise.all([
    mkdir(path.join(runtimeRoot, "assets"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "src"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "bin"), { recursive: true }),
    mkdir(workspaceRoot), mkdir(autoexecRoot), mkdir(installRoot),
  ]);
  await Promise.all([
    writeFile(nodeExecutable, "fixture node"),
    writeFile(tokenPath, "a".repeat(64)),
    writeFile(path.join(runtimeRoot, "src", "proxy.js"), "// fixture proxy"),
    writeFile(path.join(runtimeRoot, "src", "broker.js"), "// fixture broker"),
    writeFile(path.join(runtimeRoot, "bin", "potassium-mcp.js"), "// fixture public CLI"),
    json(path.join(runtimeRoot, "package.json"), {
      name: "@mrketa/potassium-mcp", version: "1.2.3",
      potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 },
    }),
  ]);
  const files = [];
  for (const [name, source, target, content] of [
    ["bootstrap", "potassium_mcp_bootstrap.lua", path.join(workspaceRoot, ".potassium-mcp-bootstrap.lua"), 'local ENDPOINT = "ws://127.0.0.1:32145"\n-- bootstrap'],
    ["autoexec", "potassium_mcp_autoexec.lua", path.join(autoexecRoot, "potassium_mcp_autoexec.lua"), "autoexec"],
  ]) {
    await writeFile(path.join(runtimeRoot, "assets", source), content);
    await writeFile(target, content);
    files.push({ name, target, sha256: hash(content), bytes: Buffer.byteLength(content) });
  }
  await json(configFile, {
    host: "127.0.0.1", port: 32145, proxyHost: "127.0.0.1", proxyPort: 32146,
    tokenFile: tokenPath, requestTimeoutMs: 30000, maxMessageBytes: 1048576,
    maxPendingRequests: 64, shutdownGraceMs: 5000, artifactRoots: [], httpAllowedHosts: [],
  });
  await json(statePath, {
    schema: 3, status: "active", installRoot, workspaceRoot, configPath: configFile,
    tokenPath, tokenSha256: hash(await readFile(tokenPath)), configSha256: hash(await readFile(configFile)),
    serverSha256: hash(await readFile(path.join(runtimeRoot, "src", "proxy.js"))),
    runtime: { mode: "external", root: runtimeRoot, nodeExecutable, nodeSha256: hash(await readFile(nodeExecutable)) },
    scripts: files.map(({ target, sha256 }) => ({ target, sha256 })), hosts: {},
  });
  await json(path.join(installRoot, "deploy-state.json"), { schema: 3, files });
  return {
    root, runtimeRoot, workspaceRoot, autoexecRoot, installRoot, configFile, statePath, tokenPath, nodeExecutable,
    options: { installRoot, configFile, packageRoot: runtimeRoot, cwd: root, env: { HOME: root, USERPROFILE: root } },
  };
}

async function addHost(value, { id = "omp", adapter = id, kind = "json", scope = "project" } = {}) {
  const state = await readJson(value.statePath);
  const launcher = {
    type: "stdio", command: value.nodeExecutable,
    args: [path.join(value.runtimeRoot, "bin", "potassium-mcp.js"), "serve", "--config", value.configFile, "--host-id", id],
    timeout: 40000,
  };
  const owned = { id, adapter, kind, scope, launcher };
  if (kind === "cli") {
    owned.command = "claude";
    owned.args = ["mcp", "add", "potassium", "--scope", scope, "--", launcher.command, ...launcher.args];
    if (scope === "local") owned.cwd = value.root;
  }
  if (kind === "json" || kind === "toml") {
    owned.configPath = path.join(value.root, `${id}.${kind === "toml" ? "toml" : "json"}`);
    const transformed = transformConfig(adapter, undefined, launcher, {
      ...value.options, scope, configPath: owned.configPath,
    });
    await writeFile(owned.configPath, transformed.content);
  }
  state.hosts[id] = owned;
  await json(value.statePath, state);
  return owned;
}

async function changeConfig(value, changes) {
  const config = await readJson(value.configFile);
  Object.assign(config, changes);
  await json(value.configFile, config);
  const state = await readJson(value.statePath);
  state.configSha256 = hash(await readFile(value.configFile));
  await json(value.statePath, state);
}

async function recordBootstrap(value, content) {
  const target = path.join(value.workspaceRoot, ".potassium-mcp-bootstrap.lua");
  await writeFile(target, content);
  const state = await readJson(value.statePath);
  state.scripts.find((script) => script.target === target).sha256 = hash(content);
  await json(value.statePath, state);
  const deployPath = path.join(value.installRoot, "deploy-state.json");
  const deployment = await readJson(deployPath);
  Object.assign(deployment.files.find((file) => file.target === target), {
    sha256: hash(content), bytes: Buffer.byteLength(content),
  });
  await json(deployPath, deployment);
}

async function brokerRecord(value, changes = {}) {
  await json(path.join(value.installRoot, "broker-state.json"), {
    schema: 1, pid: 12345, instanceId: "fixture", nodeExecutable: value.nodeExecutable,
    brokerPath: path.join(value.runtimeRoot, "src", "broker.js"), configPath: value.configFile,
    configDigest: hash(await readFile(value.configFile)), version: "1.2.3", readiness: "ready",
    ...changes,
  });
}

test("doctor reports optional editor credential availability without exposing or probing native content", async (t) => {
  const value = await fixture(t);
  const editorToken = path.join(value.installRoot, "private-editor-credential");
  const secret = "native-secret-".repeat(4);
  await writeFile(editorToken, secret);
  await changeConfig(value, { nativeEditorEnabled: true, nativeEditorTokenFile: "private-editor-credential" });
  const configured = await doctor(value.options);
  assert.equal(configured.ok, true);
  assert.equal(check(configured, "native-editor").ok, true);
  assert.equal(JSON.stringify(configured).includes(secret), false);
  assert.equal(JSON.stringify(configured).includes(editorToken), false);
  await rm(editorToken);
  const missing = await doctor(value.options);
  assert.equal(missing.ok, false);
  assert.equal(check(missing, "native-editor").ok, false);
  await changeConfig(value, { nativeEditorEnabled: false });
  const disabled = await doctor(value.options);
  assert.equal(disabled.ok, true);
  assert.equal(check(disabled, "native-editor").ok, true);
});

test("hostless schema-3 setup is ready without claiming host configuration or a live connection", async (t) => {
  const value = await fixture(t);
  const result = await doctor(value.options);
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.configured, false);
  assert.equal(result.actuallyChecked, false);
  assert.deepEqual(result.hosts, []);
  assert.equal(result.runtime.mode, "external");
  assert.equal(result.runtime.root, value.runtimeRoot);
  assert.equal(result.broker.status, "not-checked");
});

test("an applying installer journal blocks readiness while committed cleanup preserves independent checks", async (t) => {
  const value = await fixture(t);
  await addHost(value);
  const journalPath = `${value.installRoot}.transaction.json`;
  const journal = {
    schema: 1, installRoot: value.installRoot, phase: "applying",
    baseline: { phase: "committed", privateEvidence: "private-baseline-sentinel" },
  };
  await json(journalPath, journal);
  const applying = await doctor(value.options);
  assert.equal(applying.ok, false);
  assert.equal(applying.ready, false);
  assert.equal(applying.hostStatus[0].ready, false);
  assert.equal(check(applying, "installer-transaction").ok, false);
  assert.equal(JSON.stringify(applying).includes("private-baseline-sentinel"), false);
  journal.phase = "committed";
  await json(journalPath, journal);
  const committed = await doctor(value.options);
  assert.equal(committed.ok, true);
  assert.equal(committed.ready, true);
  assert.equal(check(committed, "installer-transaction").cleanupRequired, true);
  await writeFile(path.join(value.autoexecRoot, "potassium_mcp_autoexec.lua"), "corrupt");
  const corrupt = await doctor(value.options);
  assert.equal(corrupt.ready, false);
  assert.equal(check(corrupt, "script-parity").ok, false);
});

test("ambiguous or oversized transaction journals cannot establish installation readiness", async (t) => {
  const value = await fixture(t);
  const journalPath = `${value.installRoot}.transaction.json`;
  await writeFile(journalPath, `{"schema":1,"installRoot":${JSON.stringify(value.installRoot)},"phase":"applying","phase":"committed"}`);
  const ambiguous = await doctor(value.options);
  assert.equal(ambiguous.ready, false);
  assert.equal(check(ambiguous, "installer-transaction").ok, false);
  await writeFile(journalPath, " ".repeat(1024 * 1024 + 1));
  const oversized = await doctor(value.options);
  assert.equal(oversized.ready, false);
  assert.equal(check(oversized, "installer-transaction").ok, false);
});

test("doctor reports the public config selection and its precedence without falling back to another config", async (t) => {
  const value = await fixture(t);
  const env = { ...value.options.env, POTASSIUM_MCP_CONFIG: path.join(value.root, "missing.json") };
  const explicit = await doctor({ ...value.options, env });
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.selectedConfig, { path: value.configFile, source: "--config" });
  const selectedEnv = await doctor({ ...value.options, configFile: undefined, installRoot: undefined, env });
  assert.equal(selectedEnv.configPath, env.POTASSIUM_MCP_CONFIG);
  assert.equal(selectedEnv.configSource, "POTASSIUM_MCP_CONFIG");
  assert.equal(check(selectedEnv, "runtime-config").ok, false);
  const selectedRoot = await doctor({ ...value.options, configFile: undefined, env });
  assert.equal(selectedRoot.configSource, "--install-root");
  assert.equal(selectedRoot.configPath, value.configFile);
  assert.equal(selectedRoot.ok, true);
  const configOnly = await doctor({ ...value.options, installRoot: undefined });
  assert.equal(configOnly.ok, true);
  assert.equal(configOnly.installRoot, value.installRoot);
  const rootEnv = { ...value.options.env, POTASSIUM_MCP_INSTALL_ROOT: path.join(value.root, "other-root") };
  const explicitOverRootEnv = await doctor({ ...value.options, installRoot: undefined, env: rootEnv });
  assert.equal(explicitOverRootEnv.ok, true);
  assert.equal(explicitOverRootEnv.installRoot, value.installRoot);
  const configEnvOverRootEnv = await doctor({
    ...value.options, installRoot: undefined, configFile: undefined,
    env: { ...rootEnv, POTASSIUM_MCP_CONFIG: value.configFile },
  });
  assert.equal(configEnvOverRootEnv.ok, true);
  assert.equal(configEnvOverRootEnv.installRoot, value.installRoot);
  assert.equal(configEnvOverRootEnv.configSource, "POTASSIUM_MCP_CONFIG");
});

test("exact public launcher ownership supports a policy host ID distinct from its adapter", async (t) => {
  const value = await fixture(t);
  await changeConfig(value, { hostPolicies: { analysis: { read: true } } });
  await addHost(value, { id: "analysis", adapter: "omp" });
  await addHost(value, { id: "manual", kind: "manual", scope: "user" });
  const result = await doctor({ ...value.options, hostId: "analysis" });
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.actuallyChecked, false);
  assert.deepEqual(result.hosts, ["analysis"]);
  assert.equal(result.hostStatus[0].adapter, "omp");
});

test("custom launcher identities require an explicit policy, including deliberately all-false partial policies", async (t) => {
  const value = await fixture(t);
  await changeConfig(value, { hostPolicies: { analysis: { read: true } } });
  await addHost(value, { id: "analysis", adapter: "omp" });
  await changeConfig(value, { hostPolicies: {} });
  const missing = await doctor(value.options);
  assert.equal(missing.ok, false);
  assert.equal(missing.configured, false);
  assert.equal(missing.hostStatus[0].ready, false);
  assert.equal(check(missing, "host-launcher").ok, false);
  await changeConfig(value, { hostPolicies: { analysis: { read: false } } });
  const denied = await doctor(value.options);
  assert.equal(denied.ok, true);
  assert.equal(denied.configured, true);
  assert.equal(denied.hostStatus[0].ready, true);
});

test("manual snippets never count as configured or checked even when probes are requested", async (t) => {
  const value = await fixture(t);
  await addHost(value, { id: "manual", kind: "manual", scope: "user" });
  const result = await doctor({
    ...value.options, probe: true,
    verifyCliRegistration: () => { throw new Error("manual hosts cannot be probed as CLI registrations"); },
    brokerLifecycle: { brokerStatus: async () => ({ status: "running", readiness: "ready", version: "1.2.3" }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.configured, false);
  assert.equal(result.hostStatus[0].configured, false);
  assert.equal(result.hostStatus[0].actuallyChecked, false);
  assert.equal(result.broker.actuallyChecked, true);
});

test("static CLI diagnosis never invokes a host command, verifier, or broker probe", async (t) => {
  const value = await fixture(t);
  await addHost(value, { id: "claude-code", kind: "cli", scope: "user" });
  const forbidden = () => { throw new Error("static diagnosis executed a live probe"); };
  const result = await doctor({ ...value.options, runCommand: forbidden, verifyCliRegistration: forbidden, brokerLifecycle: { brokerStatus: forbidden } });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.configured, false);
  assert.equal(result.actuallyChecked, false);
  assert.equal(result.hostStatus[0].actuallyChecked, false);
  assert.equal(check(result, "host-launcher").skipped, true);
});

test("explicit probe proves CLI registration without claiming an executor connection", async (t) => {
  const value = await fixture(t);
  const host = await addHost(value, { id: "claude-code", kind: "cli", scope: "user" });
  const result = await doctor({
    ...value.options, probe: true,
    runCommand: async () => ({ status: 0, stdout: JSON.stringify({ type: "stdio", command: host.launcher.command, args: host.launcher.args }) }),
    brokerLifecycle: { brokerStatus: async () => ({ status: "running", readiness: "ready" }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.actuallyChecked, true);
  assert.equal(result.hostStatus[0].configured, true);
  assert.equal(result.hostStatus[0].actuallyChecked, true);
  assert.equal("connected" in result.hostStatus[0], false);
});

test("local CLI probes check the owned project rather than the invoking directory", async (t) => {
  const value = await fixture(t);
  const owned = await addHost(value, { id: "claude-code", kind: "cli", scope: "local" });
  const otherProject = path.join(value.root, "other-project");
  await mkdir(otherProject);
  const registrations = new Map([[owned.cwd, owned.launcher]]);
  const result = await doctor({
    ...value.options, cwd: otherProject, probe: true,
    runCommand: async (_command, _args, executionOptions) => registrations.has(executionOptions?.cwd)
      ? { status: 0, stdout: JSON.stringify(registrations.get(executionOptions.cwd)) }
      : { status: 1, stdout: "No registration in this project" },
    brokerLifecycle: { brokerStatus: async () => ({ status: "running", readiness: "ready" }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.hostStatus[0].actuallyChecked, true);
});

test("local CLI ownership without a canonical project cannot be inferred from invocation", async (t) => {
  const value = await fixture(t);
  await addHost(value, { id: "claude-code", kind: "cli", scope: "local" });
  const state = await readJson(value.statePath);
  delete state.hosts["claude-code"].cwd;
  await json(value.statePath, state);
  const result = await doctor(value.options);
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.equal(check(result, "host-launcher").ok, false);
});

test("doctor rejects an exact CLI launcher reported under a different registration scope", async (t) => {
  const value = await fixture(t);
  const owned = await addHost(value, { id: "claude-code", kind: "cli", scope: "user" });
  const result = await doctor({
    ...value.options, probe: true,
    runCommand: async () => ({ status: 0, stdout: JSON.stringify({ ...owned.launcher, scope: "local" }) }),
    brokerLifecycle: { brokerStatus: async () => ({ status: "running", readiness: "ready" }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.equal(result.hostStatus[0].actuallyChecked, true);
  assert.equal(check(result, "host-launcher").ok, false);
});

test("probe failures remain actionable and cannot be mistaken for configured hosts", async (t) => {
  const value = await fixture(t);
  await addHost(value, { id: "claude-code", kind: "cli", scope: "user" });
  const result = await doctor({
    ...value.options, probe: true,
    runCommand: async () => ({ status: 1, stdout: "registration unavailable" }),
    brokerLifecycle: { brokerStatus: async () => ({ status: "absent", readiness: "unknown" }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ready, false);
  assert.equal(result.configured, false);
  assert.equal(result.actuallyChecked, true);
  assert.equal(check(result, "host-launcher").ok, false);
  assert.equal(check(result, "broker-probe").ok, false);
});

test("CLI ownership requires an exact argument vector rather than tokens appearing somewhere in output", () => {
  const launcher = { command: "C:\\Program Files\\node.exe", args: ["C:\\MCP\\bin.js", "serve", "--config", "C:\\MCP\\config.json", "--host-id", "analysis"] };
  assert.equal(cliRegistrationMatches({ status: 0, stdout: JSON.stringify({ type: "stdio", ...launcher }) }, launcher), true);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: JSON.stringify({ name: "potassium", transport: { type: "stdio", ...launcher } }) }, launcher), true);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: `Command: ${launcher.command}\nArgs: ${launcher.args.join(" ")}` }, launcher), true);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: [launcher.command, ...launcher.args].join("\n") }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: `Command: ${launcher.command}.foreign\nArgs: ${launcher.args.join(" ")}` }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: `Command: ${launcher.command}\nArgs: ${launcher.args.join(" ")} --foreign` }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: JSON.stringify({ ...launcher, args: [...launcher.args].reverse() }) }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: JSON.stringify({ ...launcher, env: { NODE_OPTIONS: "--require foreign.js" } }) }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: "", stderr: JSON.stringify(launcher) }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 1, stdout: JSON.stringify(launcher) }, launcher), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: `Command: ${launcher.command}\nArgs: ${launcher.args.join(" ")}\nCommand: other` }, launcher), false);
});

test("CLI ownership distinguishes reported registration scope from an identical launcher elsewhere", () => {
  const launcher = { command: "/runtime/node", args: ["/runtime/cli.js", "serve"] };
  const human = "Command: /runtime/node\nArgs: /runtime/cli.js serve";
  assert.equal(cliRegistrationMatches({ stdout: human }, launcher, "user"), false);
  assert.equal(cliRegistrationMatches({ stdout: `Scope: User config (available in all your projects)\n${human}` }, launcher, "user"), true);
  assert.equal(cliRegistrationMatches({ stdout: `Scope: Local config (private to you in this project)\n${human}` }, launcher, "local"), true);
  assert.equal(cliRegistrationMatches({ stdout: `Scope: project\n${human}` }, launcher, "project"), true);
  assert.equal(cliRegistrationMatches({ stdout: `Scope: local\n${human}` }, launcher, "user"), false);
  assert.equal(cliRegistrationMatches({ stdout: `Scope: user\nScope: local\n${human}` }, launcher, "user"), false);
  assert.equal(cliRegistrationMatches({ stdout: `Scope: User config (actually local)\n${human}` }, launcher, "user"), false);
  assert.equal(cliRegistrationMatches({ stdout: JSON.stringify({ ...launcher, scope: "user" }) }, launcher, "user"), true);
  assert.equal(cliRegistrationMatches({ stdout: JSON.stringify({ ...launcher, scope: "local" }) }, launcher, "user"), false);
  assert.equal(cliRegistrationMatches({ stdout: JSON.stringify({ scope: "user", transport: { ...launcher, scope: "local" } }) }, launcher, "user"), false);
  assert.equal(cliRegistrationMatches({ stdout: JSON.stringify(launcher) }, launcher, "user"), true);
});

test("human CLI output cannot prove whitespace-bearing or empty argument boundaries", () => {
  const expected = { command: "/runtime/node", args: ["a b", "c"] };
  const human = { status: 0, stdout: "Command: /runtime/node\nArgs: a b c" };
  assert.equal(cliRegistrationMatches(human, expected), false);
  assert.equal(cliRegistrationMatches(human, { ...expected, args: ["a", "b c"] }), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: "Command: /runtime/node\nArgs: " }, { ...expected, args: [""] }), false);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: JSON.stringify(expected) }, expected), true);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: 'Command: /runtime/node\nArgs: ["a b","c"]' }, expected), true);
  assert.equal(cliRegistrationMatches({ status: 0, stdout: 'Command: /runtime/node\nArgs: ["a","b c"]' }, expected), false);
});

test("doctor preserves exact file ownership and does not accept an added host environment", async (t) => {
  const value = await fixture(t);
  const owned = await addHost(value);
  const config = await readJson(owned.configPath);
  config.mcpServers.potassium.env = { NODE_OPTIONS: "--require foreign.js" };
  await json(owned.configPath, config);
  const result = await doctor(value.options);
  assert.equal(check(result, "host-launcher").ok, false);
  assert.equal(result.configured, false);
});

test("a requested unowned host never borrows another registration", async (t) => {
  const value = await fixture(t);
  await addHost(value);
  const result = await doctor({ ...value.options, hosts: ["cursor"] });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.deepEqual(result.hosts, ["cursor"]);
});

test("schema-3 launchers cannot bypass the public serve command or change their policy identity", async (t) => {
  const value = await fixture(t);
  const owned = await addHost(value);
  const state = await readJson(value.statePath);
  state.hosts.omp.launcher.args = [path.join(value.runtimeRoot, "src", "proxy.js"), "--config", value.configFile, "--host-id", "other"];
  await json(value.statePath, state);
  await json(owned.configPath, { mcpServers: { potassium: state.hosts.omp.launcher } });
  const result = await doctor(value.options);
  assert.equal(check(result, "host-launcher").ok, false);
  assert.equal(result.configured, false);
});

test("launcher timeout must outlive the effective executor deadline", async (t) => {
  const value = await fixture(t);
  await addHost(value);
  await changeConfig(value, { requestTimeoutMs: 40000 });
  const result = await doctor(value.options);
  assert.equal(check(result, "runtime-config").ok, true);
  assert.equal(check(result, "host-launcher").ok, false);
});

test("schema-3 host deadlines scale with the effective executor timeout", async (t) => {
  const value = await fixture(t);
  const host = await addHost(value);
  await changeConfig(value, { requestTimeoutMs: 60000 });
  const stale = await doctor(value.options);
  assert.equal(check(stale, "host-launcher").ok, false);
  const state = await readJson(value.statePath);
  state.hosts.omp.launcher.timeout = 70000;
  await json(value.statePath, state);
  await json(host.configPath, { mcpServers: { potassium: state.hosts.omp.launcher } });
  const updated = await doctor(value.options);
  assert.equal(updated.ok, true);
  assert.equal(updated.ready, true);
  assert.equal(updated.configured, true);
});

test("missing or changed external Node identity is not ready", async (t) => {
  const value = await fixture(t);
  await writeFile(value.nodeExecutable, "replacement node");
  const changed = await doctor(value.options);
  assert.equal(changed.ready, false);
  assert.equal(check(changed, "runtime-integrity").ok, false);
  await rm(value.nodeExecutable);
  const missing = await doctor(value.options);
  assert.equal(missing.ready, false);
  assert.equal(check(missing, "runtime-integrity").ok, false);
});

test("doctor accepts the full installed artifact-root range rather than requiring exactly one", async (t) => {
  const value = await fixture(t);
  const empty = await doctor(value.options);
  assert.equal(check(empty, "runtime-config").ok, true);
  await changeConfig(value, {
    artifactRoots: Array.from({ length: 16 }, (_, index) => ({
      name: `root_${index}`, path: path.join(value.root, `artifacts-${index}`), recursive: true, extensions: [".json"],
    })),
  });
  assert.equal((await doctor(value.options)).ok, true);
});

test("enabled HTTP transport with a zero port remains an installation error", async (t) => {
  const value = await fixture(t);
  await changeConfig(value, { streamableHttpEnabled: true, streamableHttpPort: 0 });
  const result = await doctor(value.options);
  assert.equal(result.ready, false);
  assert.equal(check(result, "streamable-http").ok, false);
});

test("a missing workspace is diagnosed without throwing", async (t) => {
  const value = await fixture(t);
  await rm(value.workspaceRoot, { recursive: true });
  const result = await doctor(value.options);
  assert.equal(result.ready, false);
  assert.equal(check(result, "workspace").ok, false);
});

test("schema-3 bootstrap parity renders IPv4 and IPv6 endpoints without changing package source", async (t) => {
  const value = await fixture(t);
  const source = path.join(value.runtimeRoot, "assets", "potassium_mcp_bootstrap.lua");
  const before = await readFile(source);
  for (const [host, port, url] of [
    ["127.0.0.1", 33123, "ws://127.0.0.1:33123"],
    ["::1", 33445, "ws://[::1]:33445"],
  ]) {
    await changeConfig(value, { host, port });
    const stale = await doctor(value.options);
    assert.equal(check(stale, "script-parity").ok, false);
    assert.equal(check(stale, "deploy-state").ok, true);
    await recordBootstrap(value, `local ENDPOINT = "${url}"\n-- bootstrap`);
    const updated = await doctor(value.options);
    assert.equal(updated.ok, true);
    assert.equal(updated.ready, true);
    assert.equal(check(updated, "script-parity").ok, true);
    assert.equal(check(updated, "deploy-state").ok, true);
    assert.deepEqual(await readFile(source), before);
  }
});

test("bootstrap parity rejects missing or ambiguous render markers even with matching deployment evidence", async (t) => {
  const value = await fixture(t);
  const source = path.join(value.runtimeRoot, "assets", "potassium_mcp_bootstrap.lua");
  for (const content of [
    "-- missing endpoint declaration",
    'local ENDPOINT = "ws://127.0.0.1:32145"\nlocal ENDPOINT = "ws://127.0.0.1:32145"',
  ]) {
    await writeFile(source, content);
    await recordBootstrap(value, content);
    const result = await doctor(value.options);
    assert.equal(result.ready, false);
    assert.equal(check(result, "script-parity").ok, false);
    assert.equal(check(result, "deploy-state").ok, true);
  }
});

test("script corruption fails both canonical parity and deployment-byte evidence", async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.autoexecRoot, "potassium_mcp_autoexec.lua"), "changed");
  const result = await doctor(value.options);
  assert.equal(check(result, "script-parity").ok, false);
  assert.equal(check(result, "deploy-state").ok, false);
  assert.equal(result.ready, false);
});

test("duplicate deploy-state records cannot stand in for the second canonical script", async (t) => {
  const value = await fixture(t);
  const target = path.join(value.installRoot, "deploy-state.json");
  const deployment = await readJson(target);
  deployment.files[1] = { ...deployment.files[0] };
  await json(target, deployment);
  const result = await doctor(value.options);
  assert.equal(check(result, "script-parity").ok, true);
  assert.equal(check(result, "deploy-state").ok, false);
});

test("deploy-state byte counts are checked independently of matching hashes", async (t) => {
  const value = await fixture(t);
  const target = path.join(value.installRoot, "deploy-state.json");
  const deployment = await readJson(target);
  deployment.files[0].bytes += 1;
  await json(target, deployment);
  assert.equal(check(await doctor(value.options), "deploy-state").ok, false);
});

test("ownership must identify both exact deployment targets", async (t) => {
  const value = await fixture(t);
  const state = await readJson(value.statePath);
  state.scripts[1] = { ...state.scripts[0] };
  await json(value.statePath, state);
  const result = await doctor(value.options);
  assert.equal(check(result, "ownership").ok, false);
  assert.equal(result.ready, false);
});

test("malformed ownership remains a structured diagnostic rather than an implicit OMP installation", async (t) => {
  const value = await fixture(t);
  await writeFile(value.statePath, "{invalid");
  const result = await doctor(value.options);
  assert.equal(result.ok, false);
  assert.equal(check(result, "ownership").ok, false);
  assert.deepEqual(result.hosts, []);
});

test("retained config and token are not reported as an active deployment", async (t) => {
  const value = await fixture(t);
  const state = await readJson(value.statePath);
  state.status = "retained";
  for (const script of state.scripts) await rm(script.target);
  await json(value.statePath, state);
  await rm(path.join(value.installRoot, "deploy-state.json"));
  await rm(value.runtimeRoot, { recursive: true });
  const result = await doctor(value.options);
  assert.equal(result.ok, true);
  assert.equal(result.status, "retained");
  assert.equal(result.ready, false);
  assert.equal(result.configured, false);
  assert.equal(check(result, "deploy-state").skipped, true);
});

test("retained installations tolerate recorded broker state after the external runtime is removed", async (t) => {
  const value = await fixture(t);
  await brokerRecord(value);
  const state = await readJson(value.statePath);
  state.status = "retained";
  for (const script of state.scripts) await rm(script.target);
  await json(value.statePath, state);
  await rm(path.join(value.installRoot, "deploy-state.json"));
  await rm(value.runtimeRoot, { recursive: true });
  await rm(value.nodeExecutable);
  const result = await doctor(value.options);
  assert.equal(result.ok, true);
  assert.equal(result.status, "retained");
  assert.equal(result.ready, false);
  assert.equal(result.configured, false);
  assert.equal(result.actuallyChecked, false);
  assert.equal(result.broker.status, "recorded-unverified");
  assert.equal(result.restartRequired, false);
  assert.equal(check(result, "broker-version").ok, true);
});

test("matching versions do not make an old runtime without the launcher compatibility marker ready", async (t) => {
  const value = await fixture(t);
  const metadataPath = path.join(value.runtimeRoot, "package.json");
  const metadata = await readJson(metadataPath);
  delete metadata.potassiumMcpRuntime;
  await json(metadataPath, metadata);
  const result = await doctor(value.options);
  assert.equal(result.runtime.version, result.runtime.invokedVersion);
  assert.equal(result.versionDrift, false);
  assert.equal(check(result, "runtime-compatibility").ok, false);
  assert.equal(result.ready, false);
  assert.equal(result.ok, false);
});

test("package version drift is reported separately from host configuration", async (t) => {
  const value = await fixture(t);
  await addHost(value);
  const otherPackage = path.join(value.root, "other-package");
  await mkdir(otherPackage);
  await json(path.join(otherPackage, "package.json"), { version: "2.0.0" });
  const result = await doctor({ ...value.options, packageRoot: otherPackage });
  assert.equal(result.versionDrift, true);
  assert.equal(result.ready, false);
  assert.equal(result.configured, true);
  assert.equal(result.runtime.version, "1.2.3");
  assert.equal(result.runtime.invokedVersion, "2.0.0");
  assert.equal(result.restartRequired, false);
});

test("recorded broker version drift requires restart but does not assert that a process is running", async (t) => {
  const value = await fixture(t);
  await brokerRecord(value, { version: "1.0.0" });
  const result = await doctor(value.options);
  assert.equal(result.versionDrift, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.ready, false);
  assert.equal(result.actuallyChecked, false);
  assert.equal(result.broker.status, "recorded-unverified");
});

test("explicit probe uses current broker evidence instead of an older recorded version", async (t) => {
  const value = await fixture(t);
  await brokerRecord(value, { version: "1.0.0" });
  const result = await doctor({
    ...value.options, probe: true,
    brokerLifecycle: { brokerStatus: async () => ({
      status: "running", readiness: "ready", version: "1.2.3",
      configDigest: hash(await readFile(value.configFile)),
    }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.versionDrift, false);
  assert.equal(result.restartRequired, false);
  assert.equal(result.ready, true);
  assert.equal(result.broker.actuallyChecked, true);
});

test("an explicit broker probe detects version drift without relying on a prior state file", async (t) => {
  const value = await fixture(t);
  const result = await doctor({
    ...value.options, probe: true,
    brokerLifecycle: { brokerStatus: async () => ({
      status: "running", readiness: "ready", version: "1.0.0",
      configDigest: hash(await readFile(value.configFile)),
    }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.versionDrift, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.ready, false);
});

test("changed config requires broker restart even when package versions agree", async (t) => {
  const value = await fixture(t);
  await brokerRecord(value);
  await changeConfig(value, { requestTimeoutMs: 20000 });
  const result = await doctor(value.options);
  assert.equal(result.versionDrift, false);
  assert.equal(result.restartRequired, true);
  assert.equal(check(result, "broker-version").ok, false);
});

test("an in-place runtime update cannot retain stale integrity and broker readiness", async (t) => {
  const value = await fixture(t);
  await brokerRecord(value);
  await writeFile(path.join(value.runtimeRoot, "src", "proxy.js"), "// updated proxy");
  const result = await doctor(value.options);
  assert.equal(result.versionDrift, true);
  assert.equal(result.restartRequired, true);
  assert.equal(check(result, "runtime-integrity").ok, false);
});

async function historicalFixture(t, linked = false) {
  const value = await fixture(t);
  const host = await addHost(value);
  const copiedRoot = path.join(value.installRoot, "app", "node_modules", "@mrketa", "potassium-mcp");
  await mkdir(path.dirname(copiedRoot), { recursive: true });
  if (linked) await symlink(value.runtimeRoot, copiedRoot, process.platform === "win32" ? "junction" : "dir");
  else await cp(value.runtimeRoot, copiedRoot, { recursive: true });
  const metadataPath = path.join(copiedRoot, "package.json");
  const metadata = await readJson(metadataPath);
  delete metadata.potassiumMcpRuntime;
  await json(metadataPath, metadata);
  const state = await readJson(value.statePath);
  state.schema = 2;
  state.appPath = path.join(value.installRoot, "app");
  delete state.status;
  delete state.runtime;
  delete state.hosts.omp.adapter;
  state.hosts.omp.launcher.args = [path.join(copiedRoot, "src", "proxy.js"), "--config", value.configFile];
  await json(value.statePath, state);
  await json(host.configPath, { mcpServers: { potassium: state.hosts.omp.launcher } });
  return value;
}

test("historical schema-2 copied proxy launchers remain diagnosable without migration", async (t) => {
  const value = await historicalFixture(t);
  const before = await readFile(value.statePath, "utf8");
  const result = await doctor(value.options);
  assert.equal(result.ok, true);
  assert.equal(result.schema, 2);
  assert.equal(result.legacy, true);
  assert.equal(result.runtime.mode, "copy");
  assert.equal(result.configured, true);
  assert.equal(await readFile(value.statePath, "utf8"), before);
});

test("historical package junctions are classified read-only and left intact", async (t) => {
  const value = await historicalFixture(t, true);
  const before = await readFile(value.statePath, "utf8");
  const result = await doctor(value.options);
  assert.equal(result.ok, true);
  assert.equal(result.runtime.mode, "junction");
  assert.equal(await realpath(result.runtime.root), value.runtimeRoot);
  assert.equal(await readFile(value.statePath, "utf8"), before);
});

test("static diagnosis accepts a canonical historical broker alias without hiding identity or ownership drift", async (t) => {
  const value = await historicalFixture(t, true);
  await brokerRecord(value, { instanceId: "a".repeat(32) });
  const calls = [];
  const forbidden = () => { calls.push("live action"); throw new Error("static diagnosis executed a live action"); };
  const options = {
    ...value.options,
    runCommand: forbidden,
    verifyCliRegistration: forbidden,
    brokerLifecycle: {
      brokerStatus: forbidden, startBroker: forbidden, stopBroker: forbidden, restartBroker: forbidden,
    },
  };
  const accepted = await doctor(options);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ready, true);
  assert.equal(accepted.runtime.mode, "junction");
  assert.equal(accepted.broker.status, "recorded-unverified");
  assert.equal(accepted.actuallyChecked, false);
  assert.equal(check(accepted, "broker-version").ok, true);

  const otherBroker = path.join(value.root, "other-broker.js");
  await writeFile(otherBroker, await readFile(path.join(value.runtimeRoot, "src", "broker.js")));
  await brokerRecord(value, { brokerPath: otherBroker });
  const mismatched = await doctor(options);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.ready, false);
  assert.equal(check(mismatched, "broker-version").ok, false);

  await brokerRecord(value);
  await writeFile(path.join(value.runtimeRoot, "src", "proxy.js"), "// unowned proxy update");
  const changed = await doctor(options);
  assert.equal(changed.ok, false);
  assert.equal(changed.ready, false);
  assert.equal(check(changed, "runtime-integrity").ok, false);
  assert.equal(changed.restartRequired, true);
  assert.deepEqual(calls, []);
});

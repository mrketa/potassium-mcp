import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXECUTOR_REQUEST_TIMEOUT_MS, install, installationPaths, launcher, MCP_LAUNCHER_TIMEOUT_MS, repair, rotateToken, uninstall } from "../src/install.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-install-")); t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "MCP"); const workspaceRoot = path.join(root, "workspace"); const mcpConfigPath = path.join(root, ".omp", "mcp.json"); await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(path.dirname(mcpConfigPath), { recursive: true })]); await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { existing: { command: "keep" } }, preserved: true }));
  const nodeExecutable = path.join(root, "node.exe");
  await writeFile(nodeExecutable, "");
  const installPackage = async ({ stage }) => { const runtime = path.join(stage, "node_modules", "@mrketa", "potassium-mcp"); await mkdir(path.join(runtime, "src"), { recursive: true }); await cp(path.resolve("assets"), path.join(runtime, "assets"), { recursive: true }); await writeFile(path.join(runtime, "src", "server.js"), "// fixture server\n"); await writeFile(path.join(runtime, "src", "proxy.js"), "// fixture proxy\n"); await writeFile(path.join(runtime, "src", "broker.js"), "// fixture broker\n"); };
  return { root, installRoot, workspaceRoot, mcpConfigPath, installPackage, nodeExecutable, run: () => ({ status: 0 }), compileProbe: () => {} };
}
test("launcher derives a testable absolute executable without the test runner path", () => {
  const nodeExecutable = path.join(os.tmpdir(), "potassium-test-node.exe");
  assert.deepEqual(
    launcher("C:\\stable\\server.js", "C:\\stable\\config.json", nodeExecutable),
    { type: "stdio", command: nodeExecutable, args: ["C:\\stable\\server.js", "--config", "C:\\stable\\config.json", "--host-id", "omp"], timeout: MCP_LAUNCHER_TIMEOUT_MS },
  );
  assert.throws(() => launcher("server.js", "config.json", "node"), /absolute path/);
});
test("fresh path resolution defaults to Potassium workspace and separate autoexec", () => {
  const value = installationPaths();
  assert.equal(value.workspaceRoot, path.join(path.dirname(path.dirname(value.workspaceRoot)), "Potassium", "workspace"));
  assert.equal(value.autoexecRoot, path.join(path.dirname(path.dirname(value.autoexecRoot)), "Potassium", "autoexec"));
});
test("install refuses a missing workspace without creating it", async (t) => { const value = await fixture(t); await rm(value.workspaceRoot, { recursive: true }); await assert.rejects(install(value), /workspace does not exist/); });
test("install rejects overlapping managed paths before mutation", async (t) => {
  const value = await fixture(t);
  await assert.rejects(install({ ...value, installRoot: value.workspaceRoot }), /must not overlap/);
  await assert.rejects(install({ ...value, mcpConfigPath: path.join(value.installRoot, "mcp.json") }), /must be outside/);
});
test("fresh install and repair preserve unrelated MCP configuration and stable launcher arguments", async (t) => { const value = await fixture(t); const first = await install(value); const config = JSON.parse(await readFile(value.mcpConfigPath, "utf8")); const runtime = JSON.parse(await readFile(path.join(value.installRoot, "config.json"), "utf8")); assert.deepEqual(config.mcpServers.existing, { command: "keep" }); assert.equal(config.mcpServers.potassium.command, value.nodeExecutable); assert.deepEqual(config.mcpServers.potassium.args.slice(1), ["--config", path.join(value.installRoot, "config.json"), "--host-id", "omp"]); assert.equal(config.mcpServers.potassium.timeout, MCP_LAUNCHER_TIMEOUT_MS); assert.ok(MCP_LAUNCHER_TIMEOUT_MS > EXECUTOR_REQUEST_TIMEOUT_MS); assert.equal(runtime.hostPolicies.omp.read, true); assert.equal(first.hosts[0].id, "omp"); assert.equal(first.doctor.ok, true); const second = await repair(value); assert.equal(second.doctor.ok, true); });
test("installer requires an explicit flag for unrestricted Luau execution and generates a workspace-local audit log", async (t) => {
  const disabled = await fixture(t);
  await install(disabled);
  const disabledConfig = JSON.parse(await readFile(path.join(disabled.installRoot, "config.json"), "utf8"));
  assert.equal(disabledConfig.allowUnsafeExecute, false);
  assert.equal(disabledConfig.adminAuditPath, path.join(disabled.workspaceRoot, "potassium-mcp-admin-audit.ndjson"));

  const enabled = await fixture(t);
  await install({ ...enabled, allowUnsafeExecute: true });
  const enabledConfig = JSON.parse(await readFile(path.join(enabled.installRoot, "config.json"), "utf8"));
  assert.equal(enabledConfig.allowUnsafeExecute, true);
  assert.equal(enabledConfig.adminAuditPath, path.join(enabled.workspaceRoot, "potassium-mcp-admin-audit.ndjson"));

  await repair(enabled);
  const repairedConfig = JSON.parse(await readFile(path.join(enabled.installRoot, "config.json"), "utf8"));
  assert.equal(repairedConfig.allowUnsafeExecute, true);
  assert.equal(repairedConfig.adminAuditPath, path.join(enabled.workspaceRoot, "potassium-mcp-admin-audit.ndjson"));
  await repair({ ...enabled, allowUnsafeExecute: false });
  const revokedConfig = JSON.parse(await readFile(path.join(enabled.installRoot, "config.json"), "utf8"));
  assert.equal(revokedConfig.allowUnsafeExecute, false);
});
test("installer persists independent read, admin, and execute grants per host", async (t) => {
  const value = await fixture(t);
  await install({
    ...value,
    host: ["omp"],
    allowUnsafeExecute: true,
    adminHost: ["omp"],
    denyReadHost: ["omp"],
  });
  const runtime = JSON.parse(await readFile(path.join(value.installRoot, "config.json"), "utf8"));
  assert.deepEqual(runtime.hostPolicies.omp, { read: false, admin: true, execute: true });
});
test("token rotation stops the owned broker, updates the private token, and requires executor reattach", async (t) => {
  const value = await fixture(t);
  await install(value);
  const tokenPath = path.join(value.workspaceRoot, ".potassium-mcp-token");
  const before = await readFile(tokenPath, "utf8");
  const calls = [];
  const brokerLifecycle = {
    brokerStatus: async () => ({ status: "running" }),
    stopBroker: async () => { calls.push("stop"); },
    restartBroker: async () => { calls.push("restart"); },
  };
  const result = await rotateToken({ ...value, brokerLifecycle });
  const after = await readFile(tokenPath, "utf8");
  assert.notEqual(after, before);
  assert.deepEqual(calls, ["stop", "restart"]);
  assert.deepEqual(result, { rotated: true, executorReattachRequired: true });
});

test("failed token rotation restores the prior token and ownership state", async (t) => {
  const value = await fixture(t);
  await install(value);
  const tokenPath = path.join(value.workspaceRoot, ".potassium-mcp-token");
  const statePath = path.join(value.installRoot, "ownership.json");
  const beforeToken = await readFile(tokenPath);
  const beforeState = await readFile(statePath);
  let restartCalls = 0;
  const brokerLifecycle = {
    brokerStatus: async () => ({ status: "running" }),
    stopBroker: async () => {},
    restartBroker: async () => {
      restartCalls += 1;
      if (restartCalls === 1) throw new Error("restart failed");
    },
  };
  await assert.rejects(rotateToken({ ...value, brokerLifecycle }), /restart failed/);
  assert.deepEqual(await readFile(tokenPath), beforeToken);
  assert.deepEqual(await readFile(statePath), beforeState);
  assert.equal(restartCalls, 2);
});
test("token rotation releases the install lock when lifecycle preflight fails", async (t) => {
  const value = await fixture(t);
  await install(value);
  const poisoned = { ...value };
  Object.defineProperty(poisoned, "brokerLifecycle", {
    get() { throw new Error("lifecycle unavailable"); },
  });
  await assert.rejects(rotateToken(poisoned), /lifecycle unavailable/);
  const result = await rotateToken({
    ...value,
    brokerLifecycle: {
      brokerStatus: async () => ({ status: "absent" }),
      stopBroker: async () => {},
      restartBroker: async () => {},
    },
  });
  assert.equal(result.rotated, true);
});
test("built-in fallback requires a distinct non-aliased private token", async (t) => {
  const value = await fixture(t);
  const fallbackToken = path.join(value.root, "builtin-token");
  await writeFile(fallbackToken, `${"b".repeat(64)}\n`);
  await install({ ...value, builtinFallbackTokenFile: fallbackToken });
  const runtime = JSON.parse(await readFile(path.join(value.installRoot, "config.json"), "utf8"));
  assert.equal(runtime.builtinFallbackEnabled, true);
  assert.equal(runtime.builtinFallbackTokenFile, fallbackToken);

  const copied = path.join(value.root, "builtin-token-copy");
  await writeFile(copied, await readFile(path.join(value.workspaceRoot, ".potassium-mcp-token")));
  await assert.rejects(
    repair({ ...value, builtinFallbackTokenFile: copied }),
    /must be distinct from the custom broker token/,
  );
  const alias = path.join(value.root, "builtin-token-alias");
  try {
    await link(path.join(value.workspaceRoot, ".potassium-mcp-token"), alias);
  } catch {
    t.skip("hard links are unavailable in this environment");
    return;
  }
  await assert.rejects(
    repair({ ...value, builtinFallbackTokenFile: alias }),
    /must be distinct from the custom broker token/,
  );
});
test("streamable HTTP is explicit, defaults disabled, and repair preserves it unless explicitly disabled", async (t) => {
  const disabled = await fixture(t);
  await install(disabled);
  const disabledConfig = JSON.parse(await readFile(path.join(disabled.installRoot, "config.json"), "utf8"));
  assert.deepEqual(
    [disabledConfig.streamableHttpEnabled, disabledConfig.streamableHttpHost, disabledConfig.streamableHttpPort],
    [false, "127.0.0.1", 32147],
  );

  const enabled = await fixture(t);
  await install({ ...enabled, streamableHttpEnabled: true, streamableHttpPort: 32148 });
  const enabledConfig = JSON.parse(await readFile(path.join(enabled.installRoot, "config.json"), "utf8"));
  assert.deepEqual(
    [enabledConfig.streamableHttpEnabled, enabledConfig.streamableHttpHost, enabledConfig.streamableHttpPort],
    [true, "127.0.0.1", 32148],
  );
  await repair(enabled);
  const repairedConfig = JSON.parse(await readFile(path.join(enabled.installRoot, "config.json"), "utf8"));
  assert.equal(repairedConfig.streamableHttpEnabled, true);
  await repair({ ...enabled, streamableHttpEnabled: false });
  const disabledAgain = JSON.parse(await readFile(path.join(enabled.installRoot, "config.json"), "utf8"));
  assert.equal(disabledAgain.streamableHttpEnabled, false);
  const invalid = await fixture(t);
  await assert.rejects(
    install({ ...invalid, streamableHttpPort: 32148 }),
    /requires --streamable-http/,
  );
});
test("repair migrates a proven legacy launcher to the absolute Node executable and outer deadline", async (t) => {
  const value = await fixture(t);
  await install(value);
  const config = JSON.parse(await readFile(value.mcpConfigPath, "utf8"));
  const statePath = path.join(value.installRoot, "ownership.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const legacy = { ...config.mcpServers.potassium, command: "node", timeout: EXECUTOR_REQUEST_TIMEOUT_MS };
  config.mcpServers.potassium = legacy;
  state.hosts.omp.launcher = legacy;
  await writeFile(value.mcpConfigPath, JSON.stringify(config));
  await writeFile(statePath, JSON.stringify(state));

  await repair(value);
  const migrated = JSON.parse(await readFile(value.mcpConfigPath, "utf8")).mcpServers.potassium;
  assert.equal(migrated.command, value.nodeExecutable);
  assert.equal(migrated.timeout, MCP_LAUNCHER_TIMEOUT_MS);
});
test("uninstall validates the persisted absolute launcher instead of the current process executable", async (t) => {
  const value = await fixture(t);
  await install(value);
  await uninstall({ ...value, nodeExecutable: undefined });
  const config = JSON.parse(await readFile(value.mcpConfigPath, "utf8"));
  assert.deepEqual(config.mcpServers, { existing: { command: "keep" } });
});
test("uninstall preserves token, artifacts, and unrelated MCP servers", async (t) => { const value = await fixture(t); await install(value); const token = path.join(value.workspaceRoot, ".potassium-mcp-token"); const artifact = path.join(value.workspaceRoot, "potassium-mcp-artifacts", "keep.txt"); await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, "keep"); await uninstall(value); const config = JSON.parse(await readFile(value.mcpConfigPath, "utf8")); assert.deepEqual(config.mcpServers, { existing: { command: "keep" } }); assert.equal(await readFile(token, "utf8"), await readFile(token, "utf8")); assert.equal(await readFile(artifact, "utf8"), "keep"); });
test("uninstall removes an installer-created MCP config but preserves token and artifacts", async (t) => {
  const value = await fixture(t);
  await rm(value.mcpConfigPath);
  await install(value);
  const tokenPath = path.join(value.workspaceRoot, ".potassium-mcp-token");
  await access(path.join(value.workspaceRoot, "potassium-mcp-artifacts"));

  await repair(value);
  await uninstall(value);
  await assert.rejects(readFile(value.mcpConfigPath, "utf8"), { code: "ENOENT" });
  assert.ok((await readFile(tokenPath, "utf8")).trim().length >= 32);
});
test("fresh install refuses unmanaged fixed resources and package option injection", async (t) => {
  const tokenCollision = await fixture(t);
  await writeFile(path.join(tokenCollision.workspaceRoot, ".potassium-mcp-token"), "a".repeat(64));
  await assert.rejects(install(tokenCollision), /without proven ownership/);

  const launcherCollision = await fixture(t);
  await writeFile(launcherCollision.mcpConfigPath, JSON.stringify({
    mcpServers: { potassium: { command: "unmanaged" } },
  }));
  await assert.rejects(install(launcherCollision), /launcher already exist/);

  const sourceInjection = await fixture(t);
  await assert.rejects(install({ ...sourceInjection, packageSource: "--prefix=C:\\victim" }), /must not begin/);
});

test("install preserves MCP config ACL and ignores post-commit cleanup failures", async (t) => {
  const value = await fixture(t);
  const copied = [];
  const result = await install({
    ...value,
    copyAcl: async (operation) => copied.push(operation),
    remove: async () => { throw new Error("cleanup locked"); },
  });
  assert.equal(result.doctor.ok, true);
  assert.equal(copied.length, 1);
  assert.match(copied[0].source, /\.backup$/);
  assert.match(copied[0].target, /\.tmp$/);
});

test("install compare-and-swap preserves a concurrent MCP config update", async (t) => {
  const value = await fixture(t);
  const concurrent = JSON.stringify({ mcpServers: { concurrent: { command: "keep-new" } } });
  await assert.rejects(install({
    ...value,
    beforeMcpCommit: async ({ operation }) => {
      if (operation === "install") await writeFile(value.mcpConfigPath, concurrent);
    },
  }), /changed during installation/);
  assert.equal(await readFile(value.mcpConfigPath, "utf8"), concurrent);
});

test("operation lock and strict ownership state prevent concurrent or redirected deletion", async (t) => {
  const locked = await fixture(t);
  await writeFile(`${locked.installRoot}.lock`, "held");
  await assert.rejects(install(locked), /another Potassium MCP operation/);

  const value = await fixture(t);
  await install(value);
  const statePath = path.join(value.installRoot, "ownership.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const victim = path.join(value.root, "victim.txt");
  await writeFile(victim, "keep");
  state.scripts[0].target = victim;
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(uninstall(value), /ownership is ambiguous/);
  assert.equal(await readFile(victim, "utf8"), "keep");
});

test("failed MCP config commit restores quarantined uninstall resources", async (t) => {
  const value = await fixture(t);
  await install(value);
  await assert.rejects(uninstall({
    ...value,
    copyAcl: async () => { throw new Error("ACL copy failed"); },
  }), /ACL copy failed/);
  await access(path.join(value.workspaceRoot, ".potassium-mcp-bootstrap.lua"));
  await access(path.join(value.installRoot, "app"));
  await access(path.join(value.installRoot, "ownership.json"));
});

test("multi-host install, repair, doctor, and selective uninstall share one runtime safely", async (t) => {
  const value = await fixture(t);
  const env = {
    USERPROFILE: path.join(value.root, "user"),
    APPDATA: path.join(value.root, "appdata"),
  };
  let cliInstalled = false;
  const runCommand = (_command, args) => {
    if (args[1] === "get") {
      return cliInstalled
        ? { status: 0, stdout: `${value.nodeExecutable} potassium proxy`, stderr: "" }
        : { status: 1, stdout: "", stderr: "not found" };
    }
    if (args[1] === "add") cliInstalled = true;
    if (args[1] === "remove") cliInstalled = false;
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = {
    ...value,
    mcpConfigPath: undefined,
    cwd: value.root,
    env,
    host: ["omp", "vscode", "codex", "claude-code", "manual"],
    runCommand,
    verifyCliRegistration: () => true,
  };
  const installed = await install(options);
  assert.deepEqual(
    installed.hosts.map(({ id }) => id).sort(),
    ["claude-code", "codex", "manual", "omp", "vscode"],
  );
  const state = JSON.parse(await readFile(path.join(value.installRoot, "ownership.json"), "utf8"));
  assert.equal(state.schema, 2);
  assert.deepEqual(Object.keys(state.hosts).sort(), ["claude-code", "codex", "manual", "omp", "vscode"]);
  assert.match(await readFile(path.join(env.USERPROFILE, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.potassium\]/);
  assert.match(await readFile(path.join(env.APPDATA, "Code", "User", "mcp.json"), "utf8"), /"potassium"/);
  assert.equal(installed.hosts.find(({ id }) => id === "manual").json.includes("mcpServers"), true);

  const repaired = await repair(options);
  assert.equal(repaired.doctor.ok, true);
  const removedOne = await uninstall({ ...options, host: ["vscode"] });
  assert.equal(removedOne.sharedRetained, true);
  assert.equal(await access(value.installRoot).then(() => true).catch(() => false), true);
  const afterOne = JSON.parse(await readFile(path.join(value.installRoot, "ownership.json"), "utf8"));
  assert.equal(afterOne.hosts.vscode, undefined);
  assert.ok(afterOne.hosts.omp);

  const removedAll = await uninstall({ ...options, all: true });
  assert.equal(removedAll.sharedRetained, false);
  assert.equal(await access(value.appPath).then(() => true).catch(() => false), false);
});

test("multi-host collision aborts before mutating shared runtime or other hosts", async (t) => {
  const value = await fixture(t);
  const env = {
    USERPROFILE: path.join(value.root, "user"),
    APPDATA: path.join(value.root, "appdata"),
  };
  const vscodePath = path.join(env.APPDATA, "Code", "User", "mcp.json");
  await mkdir(path.dirname(vscodePath), { recursive: true });
  await writeFile(vscodePath, JSON.stringify({ servers: { potassium: { command: "foreign" } } }));
  const ompBefore = await readFile(value.mcpConfigPath, "utf8");
  await assert.rejects(
    install({
      ...value,
      mcpConfigPath: undefined,
      cwd: value.root,
      env,
      host: ["omp", "vscode"],
    }),
    /already exists without proven ownership/,
  );
  assert.equal(await access(value.installRoot).then(() => true).catch(() => false), false);
  assert.equal(await readFile(value.mcpConfigPath, "utf8"), ompBefore);
  assert.match(await readFile(vscodePath, "utf8"), /foreign/);
});
test("owned non-default autoexec paths resolve for repair and uninstall without path flags", async (t) => {
  const value = await fixture(t);
  const autoexecRoot = path.join(value.root, "custom-autoexec");
  await mkdir(autoexecRoot);
  await install({ ...value, autoexecRoot });
  const state = JSON.parse(await readFile(path.join(value.installRoot, "ownership.json"), "utf8"));
  assert.equal(state.autoexecRoot, autoexecRoot);
  await access(path.join(autoexecRoot, "potassium_mcp_autoexec.lua"));
  delete state.autoexecRoot;
  await writeFile(path.join(value.installRoot, "ownership.json"), JSON.stringify(state));

  await repair({ ...value, workspaceRoot: undefined, autoexecRoot: undefined });
  await assert.rejects(
    repair({ ...value, autoexecRoot: path.join(value.root, "wrong-autoexec") }),
    /does not match owned installation/,
  );
  await uninstall({ ...value, workspaceRoot: undefined, autoexecRoot: undefined, all: true });
  await assert.rejects(access(path.join(value.installRoot, "app")), { code: "ENOENT" });
});
test("uninstall refuses modified owned scripts and install rolls back a late doctor failure", async (t) => { const value = await fixture(t); await install(value); await writeFile(path.join(value.workspaceRoot, ".potassium-mcp-bootstrap.lua"), "modified"); await assert.rejects(uninstall(value), /ownership is ambiguous/); const failed = await fixture(t); await assert.rejects(install({ ...failed, installPackage: async ({ stage }) => { await failed.installPackage({ stage }); await rm(path.join(stage, "node_modules", "@mrketa", "potassium-mcp", "assets", "potassium_mcp_autoexec.lua")); } }), /missing required/); });

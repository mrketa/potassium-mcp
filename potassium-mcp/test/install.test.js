import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, chmod, cp, link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, repair, registerHost, removeHost, printConfig, launcher, readRepairDrainCredentials, rotateToken, uninstall } from "../src/install.js";
import { transformConfig } from "../src/hosts.js";
import { allowsTool, parsePolicyConfig } from "../src/host-policy.js";
import { loadConfig } from "../src/server.js";
import { doctor } from "../src/doctor.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (target) => JSON.parse(await readFile(target, "utf8"));
const present = (target) => access(target).then(() => true).catch(() => false);
const originalPackage = fileURLToPath(new URL("../", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-setup-雪 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "npm package");
  await mkdir(workspaceRoot);
  await mkdir(path.join(runtimeRoot, "src"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "bin"));
  await cp(path.join(originalPackage, "assets"), path.join(runtimeRoot, "assets"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "package.json"), JSON.stringify({ name: "@mrketa/potassium-mcp", version: "1.0.0", potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 } }));
  await writeFile(path.join(runtimeRoot, "src", "proxy.js"), "// fixture proxy v1\n");
  await writeFile(path.join(runtimeRoot, "src", "broker.js"), "// fixture broker\n");
  await writeFile(path.join(runtimeRoot, "bin", "potassium-mcp.js"), "// fixture public launcher\n");
  return { root, cwd: root, installRoot: path.join(root, "private MCP"), workspaceRoot, runtimeRoot,
    nodeExecutable: await realpath(process.execPath), run: () => ({ status: 0 }),
    brokerLifecycle: { brokerStatus: async () => ({ status: "absent" }), stopBroker: async () => { throw new Error("unexpected stop"); }, restartBroker: async () => { throw new Error("unexpected restart"); } } };
}

const statePath = (value) => path.join(value.installRoot, "ownership.json");
const configPath = (value) => path.join(value.installRoot, "config.json");
const tokenPath = (value) => path.join(value.workspaceRoot, ".potassium-mcp-token");
const bootstrapPath = (value) => path.join(value.workspaceRoot, ".potassium-mcp-bootstrap.lua");
const hostOptions = (value, id = "omp", target = path.join(value.root, ".omp", "mcp.json")) => ({ ...value, host: "omp", hostId: id, mcpConfigPath: target });

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(files, await filesBelow(target));
    else if (entry.isFile()) files[target] = await readFile(target, "base64");
    else files[target] = `link:${await realpath(target)}`;
  }
  return files;
}

async function addManualHost(value, id = "omp") {
  const state = await readJson(statePath(value));
  const config = await readJson(configPath(value));
  state.hosts[id] = { id, adapter: "manual", kind: "manual", scope: "user",
    launcher: launcher(path.join(state.runtime.root, "bin", "potassium-mcp.js"), state.configPath, state.runtime.nodeExecutable, id, config.requestTimeoutMs) };
  await writeFile(statePath(value), JSON.stringify(state));
}

async function legacyFixture(t, linked = false) {
  const value = await fixture(t);
  await setup(value);
  const state = await readJson(statePath(value));
  const legacyRoot = path.join(value.installRoot, "app", "node_modules", "@mrketa", "potassium-mcp");
  await mkdir(path.dirname(legacyRoot), { recursive: true });
  if (linked) await symlink(value.runtimeRoot, legacyRoot, process.platform === "win32" ? "junction" : "dir");
  else await cp(value.runtimeRoot, legacyRoot, { recursive: true });
  const mcpConfigPath = path.join(value.root, ".omp", "mcp.json");
  await mkdir(path.dirname(mcpConfigPath));
  const launcher = { type: "stdio", command: value.nodeExecutable, args: [path.join(legacyRoot, "src", "proxy.js"), "--config", configPath(value), "--host-id", "omp"], timeout: 40000 };
  await writeFile(mcpConfigPath, transformConfig("omp", '{"unrelated":true,"mcpServers":{"other":{"command":"keep"}}}', launcher, { configPath: mcpConfigPath, scope: "project" }).content);
  const { runtime, status, ...old } = state;
  await writeFile(statePath(value), JSON.stringify({ ...old, schema: 2, appPath: path.join(value.installRoot, "app"), hosts: { omp: { id: "omp", kind: "json", scope: "project", configPath: mcpConfigPath, configCreated: false, launcher } } }));
  return { value, legacyRoot, mcpConfigPath };
}

test("setup is hostless and uses an external package without copying package files", async (t) => {
  const value = await fixture(t);
  const result = await setup(value);
  const state = await readJson(statePath(value));
  assert.equal(result.configured, true);
  assert.deepEqual(state.hosts, {});
  assert.equal(state.runtime.root, await realpath(value.runtimeRoot));
  assert.equal(state.runtime.nodeSha256, digest(await readFile(value.nodeExecutable)));
  assert.equal(await present(path.join(value.installRoot, "app")), false);
  assert.equal(await present(path.join(value.root, ".omp")), false);
  assert.equal(state.status, "active");
  assert.equal(state.scripts.length, 2);
  const config = await readJson(configPath(value));
  const sources = path.join(value.workspaceRoot, "potassium-mcp-sources");
  assert.deepEqual(config.sourceRoots, [{ name: "sources", path: sources, recursive: true, extensions: [".lua", ".luau"] }]);
  assert.equal((await stat(sources)).isDirectory(), true);
  assert.equal(config.artifactRoots.some((root) => root.extensions.includes(".luau")), false);
});

test("missing workspace and overlapping roots are rejected without creating managed paths", async (t) => {
  const value = await fixture(t);
  await rm(value.workspaceRoot, { recursive: true });
  await assert.rejects(setup(value), /workspace does not exist/);
  assert.equal(await present(value.installRoot), false);
  await assert.rejects(setup({ ...value, workspaceRoot: value.installRoot }), /must not overlap/);
  await assert.rejects(setup({ ...value, workspaceRoot: undefined }), /workspace is required/);
});

test("setup dry-run produces concrete plans without locks, credentials, ACL or deployment calls", async (t) => {
  const value = await fixture(t);
  const before = await filesBelow(value.root);
  const fail = () => { throw new Error("dry-run mutated external state"); };
  const result = await setup({ ...value, dryRun: true, run: fail, copyAcl: fail, compileProbe: fail, onDeploymentActivation: fail, brokerLifecycle: new Proxy({}, { get: fail }) });
  assert.equal(result.dryRun, true);
  assert.equal(result.operations.find((operation) => operation.operation === "create-private-token").path, tokenPath(value));
  assert.deepEqual(await filesBelow(value.root), before);
  assert.equal(await present(`${value.installRoot}.lock`), false);
});

test("manual config output neither registers hosts nor grants custom policy identities", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, readHost: ["project-a"] });
  const before = await filesBelow(value.root);
  const entry = await printConfig({ ...value, hostId: "project-a" });
  assert.deepEqual(entry, { command: value.nodeExecutable, args: [path.join(await realpath(value.runtimeRoot), "bin", "potassium-mcp.js"), "serve", "--config", configPath(value), "--host-id", "project-a"], env: {} });
  await assert.rejects(printConfig({ ...value, hostId: "not-configured" }), /unsupported|configured|unknown/i);
  await assert.rejects(printConfig({ ...value, hostId: "Bad ID" }), /host/i);
  assert.deepEqual(await filesBelow(value.root), before);
  assert.deepEqual((await readJson(statePath(value))).hosts, {});
});

test("manual hosts survive runtime, Node and deadline repair without managing user registrations or granting access", async (t) => {
  const value = await fixture(t);
  const id = "project-a";
  await setup({ ...value, allowUnsafeExecute: true, denyReadHost: [id] });
  await addManualHost(value, id);
  const mcpConfigPath = hostOptions(value).mcpConfigPath;
  await mkdir(path.dirname(mcpConfigPath));
  const wrapper = '{\n  // user-managed wrapper and unrelated server\n  "mcpServers":{"potassium":{"command":"custom-wrapper","args":["keep"]},"other":{"command":"keep"}}\n}\n';
  await writeFile(mcpConfigPath, wrapper);
  const token = await readFile(tokenPath(value));
  const config = await readJson(configPath(value));
  config.requestTimeoutMs = 60000;
  const configBytes = `${JSON.stringify(config, null, 4)}\n\n`;
  await writeFile(configPath(value), configBytes);
  const runtimeRoot = path.join(value.root, "npm version 2");
  const nodeExecutable = path.join(value.root, path.basename(value.nodeExecutable));
  await cp(value.runtimeRoot, runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, "src", "proxy.js"), "// fixture v2\n");
  await cp(value.nodeExecutable, nodeExecutable);
  const unexpected = () => { throw new Error("manual host registration must remain user-managed"); };
  const options = { ...value, runtimeRoot, nodeExecutable, runCommand: unexpected, verifyCliRegistration: unexpected, beforeMcpCommit: unexpected };
  await repair(options);
  const printed = await printConfig({ ...options, hostId: id });
  assert.equal(printed.command, await realpath(nodeExecutable));
  assert.deepEqual(printed.args, [path.join(await realpath(runtimeRoot), "bin", "potassium-mcp.js"), "serve", "--config", configPath(value), "--host-id", id]);
  const result = await doctor({ ...options, packageRoot: runtimeRoot, configFile: configPath(value) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.hostStatus, [{ id, adapter: "manual", kind: "manual", ready: true, configured: false, actuallyChecked: false }]);
  assert.equal(result.configured, false);
  assert.equal(result.actuallyChecked, false);
  await repair(options);
  assert.deepEqual(await printConfig({ ...options, hostId: id }), printed);
  assert.equal(await readFile(mcpConfigPath, "utf8"), wrapper);
  assert.equal(await readFile(configPath(value), "utf8"), configBytes);
  assert.deepEqual(await readFile(tokenPath(value)), token);
  const loaded = await loadConfig(configPath(value));
  for (const tool of ["potassium_status", "potassium_admin_status", "potassium_execute_luau"]) {
    assert.equal(allowsTool(loaded.policies.hosts[id], tool, loaded), false);
  }
});

test("invalid manual adapter, kind and missing scope refuse repair and config output without mutation", async (t) => {
  const value = await fixture(t);
  await setup(value);
  await addManualHost(value);
  const state = await readJson(statePath(value));
  for (const changes of [{ adapter: "omp" }, { kind: "json" }, { scope: undefined }]) {
    const invalid = structuredClone(state);
    Object.assign(invalid.hosts.omp, changes);
    await writeFile(statePath(value), JSON.stringify(invalid));
    const before = await filesBelow(value.root);
    await assert.rejects(repair(value));
    await assert.rejects(printConfig({ ...value, hostId: "omp" }));
    assert.deepEqual(await filesBelow(value.root), before);
  }
});

test("manual ownership metadata cannot introduce an unconfigured policy identity", async (t) => {
  const value = await fixture(t);
  await setup(value);
  await addManualHost(value, "project-a");
  const before = await filesBelow(value.root);
  await assert.rejects(repair(value));
  await assert.rejects(printConfig({ ...value, hostId: "project-a" }));
  assert.equal((await loadConfig(configPath(value))).policies.hosts["project-a"], undefined);
  assert.deepEqual(await filesBelow(value.root), before);
});

test("host registration/removal leaves bootstrap, credential and config bytes unchanged", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const configBefore = await readFile(configPath(value));
  const tokenBefore = await readFile(tokenPath(value));
  const deploymentBefore = await readFile(path.join(value.installRoot, "deploy-state.json"));
  const mcpConfigPath = path.join(value.root, "host.json");
  const unrelated = '{\n  // keep this comment\n  "preserved":true,"mcpServers":{"other":{"command":"keep"}}\n}\n';
  await writeFile(mcpConfigPath, unrelated);
  const options = hostOptions(value, "omp", mcpConfigPath);
  await registerHost({ ...options, onDeploymentActivation: () => { throw new Error("unexpected deployment"); } });
  const owned = (await readJson(statePath(value))).hosts.omp;
  assert.equal(owned.adapter, "omp");
  assert.equal(owned.launcher.args[1], "serve");
  assert.match(await readFile(mcpConfigPath, "utf8"), /keep this comment/);
  await removeHost(options);
  assert.equal(await readFile(mcpConfigPath, "utf8"), unrelated);
  assert.deepEqual(await readFile(configPath(value)), configBefore);
  assert.deepEqual(await readFile(tokenPath(value)), tokenBefore);
  assert.deepEqual(await readFile(path.join(value.installRoot, "deploy-state.json")), deploymentBefore);
  assert.equal((await readJson(statePath(value))).status, "active");
});

test("distinct same-adapter projects require unique explicitly configured policy IDs", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, readHost: ["project-a", "project-b"] });
  const first = hostOptions(value, "project-a", path.join(value.root, "a.json"));
  const second = hostOptions(value, "project-b", path.join(value.root, "b.json"));
  await registerHost(first);
  await registerHost(second);
  await assert.rejects(registerHost({ ...first, mcpConfigPath: second.mcpConfigPath }), /another scope or project/);
  await assert.rejects(registerHost({ ...second, mcpConfigPath: first.mcpConfigPath }), /another scope or project|another host ID/);
  await removeHost(first);
  const state = await readJson(statePath(value));
  assert.deepEqual(Object.keys(state.hosts), ["project-b"]);
  assert.equal((await readJson(second.mcpConfigPath)).mcpServers.potassium.args.at(-1), "project-b");
});

test("host dry-runs do not change files or run host CLI queries", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const before = await filesBelow(value.root);
  const runCommand = () => { throw new Error("host command executed in dry-run"); };
  const added = await registerHost({ ...value, host: "claude-code", hostId: "claude-code", dryRun: true, runCommand });
  assert.deepEqual(added.operations[0].args.slice(0, 5), ["mcp", "add", "potassium", "--scope", "user"]);
  assert.deepEqual(await filesBelow(value.root), before);
  await registerHost(hostOptions(value));
  const registered = await filesBelow(value.root);
  await removeHost({ ...hostOptions(value), dryRun: true, runCommand });
  await uninstall({ ...value, all: true, dryRun: true, runCommand });
  assert.deepEqual(await filesBelow(value.root), registered);
});

test("repair ignores fresh access initialization and preserves all valid user settings and config formatting", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const config = await readJson(configPath(value));
  delete config.sourceRoots;
  Object.assign(config, { port: 33451, proxyPort: 33452, requestTimeoutMs: 18000, maxPendingRequests: 37, proxyMaxFrameBytes: 65536,
    artifactRoots: [{ name: "custom", path: "../custom-root", recursive: false, extensions: [".txt"] }], httpAllowedHosts: ["example.com"], adminAuditPath: "../audit.ndjson",
    streamableHttpEnabled: true, streamableHttpPort: 33453, hostPolicies: { omp: { read: false, admin: true, execute: false } }, httpPolicy: { read: false, admin: true, execute: false } });
  const bytes = `${JSON.stringify(config, null, 4)}\n\n`;
  await writeFile(configPath(value), bytes);
  const token = await readFile(tokenPath(value));
  await repair({ ...value, initialFullAccessHost: "agent" });
  assert.equal(await readFile(configPath(value), "utf8"), bytes);
  assert.deepEqual(await readFile(tokenPath(value)), token);
  await repair({ ...value, initialFullAccessHost: "agent", streamableHttpEnabled: false });
  assert.deepEqual(await readJson(configPath(value)), { ...config, streamableHttpEnabled: false });
});

test("unknown or invalid user configuration is a conflict, never reset to defaults", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const config = await readJson(configPath(value));
  const invalid = JSON.stringify({ ...config, typoSecurityOption: true });
  await writeFile(configPath(value), invalid);
  const stateBefore = await readFile(statePath(value));
  await assert.rejects(repair(value), /invalid.*refusing to reset/s);
  assert.equal(await readFile(configPath(value), "utf8"), invalid);
  assert.deepEqual(await readFile(statePath(value)), stateBefore);
});

test("read, admin and execute grants are independent and only execute needs unsafe opt-in", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, adminHost: ["admin-project"], denyReadHost: ["admin-project"] });
  let config = await readJson(configPath(value));
  let policies = parsePolicyConfig(config);
  assert.equal(allowsTool(policies.hosts["admin-project"], "potassium_admin_status", config), true);
  assert.equal(allowsTool(policies.hosts["admin-project"], "potassium_status", config), false);
  await assert.rejects(repair({ ...value, executeHost: ["admin-project"] }), /execute grants require/);
  await repair({ ...value, allowUnsafeExecute: true, executeHost: ["admin-project"] });
  config = await readJson(configPath(value));
  policies = parsePolicyConfig(config);
  assert.equal(allowsTool(policies.hosts["admin-project"], "potassium_execute_luau", config), true);
  assert.equal(allowsTool(policies.hosts["admin-project"], "potassium_status", config), false);
  await assert.rejects(repair({ ...value, readHost: ["admin-project"], denyReadHost: ["admin-project"] }), /both/);
});

test("upgrade downgrade and retained reinstall never reinitialize restricted access or replace credentials and artifacts", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, allowUnsafeExecute: true, denyReadHost: ["agent"] });
  const config = await readFile(configPath(value));
  await registerHost(hostOptions(value));
  const token = await readFile(tokenPath(value));
  const artifacts = path.join(value.workspaceRoot, "potassium-mcp-artifacts", "keep.txt");
  await writeFile(artifacts, "user artifact");
  const secondRoot = path.join(value.root, "npm version 2");
  await cp(value.runtimeRoot, secondRoot, { recursive: true });
  await writeFile(path.join(secondRoot, "src", "proxy.js"), "// fixture v2\n");
  await repair({ ...value, runtimeRoot: secondRoot, initialFullAccessHost: "agent" });
  assert.deepEqual(await readFile(configPath(value)), config);
  assert.equal((await readJson(statePath(value))).runtime.root, await realpath(secondRoot));
  await repair({ ...value, initialFullAccessHost: "agent" });
  assert.deepEqual(await readFile(configPath(value)), config);
  assert.equal((await readJson(statePath(value))).runtime.root, await realpath(value.runtimeRoot));
  await removeHost(hostOptions(value));
  await assert.rejects(uninstall(value), /requires --all/);
  await uninstall({ ...value, all: true });
  assert.equal((await readJson(statePath(value))).status, "retained");
  assert.equal(await present(bootstrapPath(value)), false);
  assert.equal(await present(path.join(value.runtimeRoot, "bin", "potassium-mcp.js")), true);
  await assert.rejects(printConfig({ ...value, hostId: "omp" }), /active external setup/);
  await setup({ ...value, initialFullAccessHost: "agent" });
  assert.deepEqual(await readFile(configPath(value)), config);
  assert.deepEqual(await readFile(tokenPath(value)), token);
  assert.equal(await readFile(artifacts, "utf8"), "user artifact");
  assert.equal((await readJson(statePath(value))).status, "active");
});

test("reinstall refuses unknown retained tokens or altered retained evidence", async (t) => {
  const unknown = await fixture(t);
  await writeFile(tokenPath(unknown), "a".repeat(64));
  await assert.rejects(setup(unknown), /without proven ownership/);
  const value = await fixture(t);
  await setup(value);
  await uninstall({ ...value, all: true });
  await writeFile(tokenPath(value), "b".repeat(64));
  await assert.rejects(setup(value), /token ownership is ambiguous/);
  assert.equal(await readFile(tokenPath(value), "utf8"), "b".repeat(64));
});

test("package preflight failure never changes setup or calls npm", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const before = await filesBelow(value.root);
  await assert.rejects(repair({ ...value, runtimeRoot: path.join(value.root, "not installed") }), /ENOENT/);
  assert.deepEqual(await filesBelow(value.root), before);
  await assert.rejects(setup({ ...value, packageSource: "--prefix=victim" }), /npm owns package/);
});

test("failed deployment activation rolls back config, scripts, ownership and file ACLs", async (t) => {
  const value = await fixture(t);
  await setup(value);
  if (process.platform !== "win32") await chmod(bootstrapPath(value), 0o640);
  const before = await filesBelow(value.root);
  const mode = (await stat(bootstrapPath(value))).mode;
  await assert.rejects(repair({ ...value, allowUnsafeExecute: true, onDeploymentActivation: (name) => { if (name === "autoexec") throw new Error("activation failed"); } }), /activation failed/);
  assert.deepEqual(await filesBelow(value.root), before);
  assert.equal((await stat(bootstrapPath(value))).mode, mode);
  assert.equal(await present(`${value.installRoot}.lock`), false);
});

test("failed host ACL commit restores unrelated bytes and all shared setup files", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const options = hostOptions(value, "omp", path.join(value.root, "host.json"));
  await writeFile(options.mcpConfigPath, '{"mcpServers":{"other":{"command":"keep"}}}');
  const before = await filesBelow(value.root);
  await assert.rejects(registerHost({
    ...options, copyAcl: ({ source }) => {
      if (source.startsWith(`${options.mcpConfigPath}.`)) throw new Error("ACL copy failed");
    },
  }), (error) => {
    assert.equal(error.code, "MCP_ACL_PRESERVE_FAILED");
    assert.equal(error.acl.path, options.mcpConfigPath);
    assert.equal(error.acl.message, "ACL copy failed");
    assert.equal(error.acl.requiresElevation, false);
    return true;
  });
  assert.deepEqual(await filesBelow(value.root), before);
  await registerHost(options);
  const registered = await filesBelow(value.root);
  await assert.rejects(uninstall({ ...value, all: true, copyAcl: () => { throw new Error("ACL copy failed"); } }), (error) => {
    assert.equal(error.acl.path, `${value.installRoot}.transaction.json`);
    assert.equal(error.acl.message, "ACL copy failed");
    assert.equal(error.acl.requiresElevation, false);
    return true;
  });
  assert.deepEqual(await filesBelow(value.root), registered);
});

test("ACL failure during rollback retains the original failure and recoverable journal", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const before = await filesBelow(value.root);
  let activationFailed = false;
  const original = new Error("deployment activation failed");
  await assert.rejects(repair({
    ...value, allowUnsafeExecute: true,
    brokerLifecycle: {
      brokerStatus: async () => ({ status: "running" }), stopBroker: async () => {},
      restartBroker: async () => { throw new Error("must not restart without recorded rollback"); },
    },
    onDeploymentActivation: () => { activationFailed = true; throw original; },
    copyAcl: ({ source }) => {
      if (activationFailed && source === `${value.installRoot}.transaction.json`) throw new Error("rollback journal ACL unavailable");
    },
  }), (error) => {
    assert.equal(error.cause, original);
    assert.equal(error.acl.path, `${value.installRoot}.transaction.json`);
    assert.equal(error.acl.message, "rollback journal ACL unavailable");
    assert.equal(error.acl.requiresElevation, false);
    assert.match(error.message, /deployment activation failed/);
    assert.match(error.message, /recovery required/);
    return true;
  });
  const after = await filesBelow(value.root);
  const journalPath = `${value.installRoot}.transaction.json`;
  assert.equal(Object.hasOwn(after, journalPath), true);
  delete after[journalPath];
  assert.deepEqual(after, before);
});

test("host compare-and-swap preserves concurrent foreign edits", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const options = hostOptions(value, "omp", path.join(value.root, "host.json"));
  await writeFile(options.mcpConfigPath, '{"mcpServers":{}}');
  const state = await readFile(statePath(value));
  const concurrent = '{"mcpServers":{"concurrent":{"command":"new"}}}';
  await assert.rejects(registerHost({ ...options, beforeMcpCommit: () => writeFile(options.mcpConfigPath, concurrent) }), /changed during register/);
  assert.equal(await readFile(options.mcpConfigPath, "utf8"), concurrent);
  assert.deepEqual(await readFile(statePath(value)), state);
});

test("uncertain replacement startup preserves committed credentials rather than rolling them back underneath a possible child", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const beforeToken = await readFile(tokenPath(value));
  let childCredential;
  const brokerLifecycle = {
    brokerStatus: async () => ({ status: "running" }),
    stopBroker: async () => {},
    restartBroker: async () => {
      childCredential = await readFile(tokenPath(value));
      throw new Error("readiness timed out after spawning the replacement");
    },
  };
  await assert.rejects(rotateToken({ ...value, brokerLifecycle }), { code: "BROKER_STARTUP_UNCERTAIN" });
  const committedToken = await readFile(tokenPath(value));
  assert.notDeepEqual(committedToken, beforeToken);
  assert.deepEqual(committedToken, childCredential);
  assert.equal((await readJson(statePath(value))).tokenSha256, digest(committedToken));
  const journal = await readJson(`${value.installRoot}.transaction.json`);
  assert.equal(journal.phase, "committed");
  assert.equal(await present(journal.entries.find(({ target }) => target === tokenPath(value)).backup), true);
});

test("token rotation success changes only credential identity and preserves active config", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const oldToken = await readFile(tokenPath(value));
  const oldConfig = await readFile(configPath(value));
  assert.deepEqual(await rotateToken(value), { rotated: true, executorReattachRequired: true });
  const token = await readFile(tokenPath(value));
  assert.notDeepEqual(token, oldToken);
  assert.deepEqual(await readFile(configPath(value)), oldConfig);
  assert.equal((await readJson(statePath(value))).tokenSha256, digest(token));
});

test("held or malformed locks remain untouched, and only a dead verified owner can recover", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const lockPath = `${value.installRoot}.lock`;
  const owner = { schema: 1, pid: process.pid, hostname: os.hostname(), installRoot: value.installRoot, nonce: "a".repeat(32) };
  await writeFile(lockPath, JSON.stringify(owner));
  await assert.rejects(repair(value), /owner is live/);
  assert.deepEqual(await readJson(lockPath), owner);
  await writeFile(lockPath, "foreign lock");
  await assert.rejects(repair(value), /owner cannot be verified/);
  assert.equal(await readFile(lockPath, "utf8"), "foreign lock");
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  await writeFile(lockPath, JSON.stringify({ ...owner, pid: Number(exited.stdout) }));
  await repair(value);
  assert.equal(await present(lockPath), false);
});


test("legacy copied setup migrates public registrations without deleting package data", async (t) => {
  const { value, legacyRoot, mcpConfigPath } = await legacyFixture(t);
  const token = await readFile(tokenPath(value));
  const legacyBytes = await filesBelow(legacyRoot);
  const migrated = await setup(value);
  assert.equal(migrated.classification, "copy");
  assert.equal((await readJson(statePath(value))).schema, 3);
  assert.equal((await readJson(mcpConfigPath)).mcpServers.potassium.args[1], "serve");
  assert.deepEqual(await filesBelow(legacyRoot), legacyBytes);
  assert.deepEqual(await readFile(tokenPath(value)), token);
});

test("legacy junction requires deliberate migration and never deletes its target", async (t) => {
  const { value, legacyRoot } = await legacyFixture(t, true);
  const before = await filesBelow(value.runtimeRoot);
  await assert.rejects(setup({ ...value, runtimeRoot: undefined }), /junction runtime requires explicit/);
  const migrated = await setup(value);
  assert.equal(migrated.classification, "junction");
  assert.equal((await lstat(legacyRoot)).isSymbolicLink(), true);
  await uninstall({ ...value, all: true });
  assert.deepEqual(await filesBelow(value.runtimeRoot), before);
  assert.equal((await lstat(legacyRoot)).isSymbolicLink(), true);
});

test("current custom-wrapper shape is a conflict even with explicit junction migration", async (t) => {
  const { value, legacyRoot, mcpConfigPath } = await legacyFixture(t, true);
  const config = await readJson(mcpConfigPath);
  const original = config.mcpServers.potassium;
  config.mcpServers.potassium = { ...original, args: [path.join(value.root, "mcp-safe-proxy", "dist", "index.js"), "--log-file", path.join(value.root, "wrapper.log"), "--", original.command, ...original.args] };
  await writeFile(mcpConfigPath, JSON.stringify(config));
  const before = await filesBelow(value.root);
  await assert.rejects(setup(value), /user-managed wrappers/);
  assert.deepEqual(await filesBelow(value.root), before);
  assert.equal((await lstat(legacyRoot)).isSymbolicLink(), true);
});

test("redirected token and script targets cannot authorize foreign file changes", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const outside = path.join(value.root, "foreign-token");
  await writeFile(outside, await readFile(tokenPath(value)));
  await rm(tokenPath(value));
  await link(outside, tokenPath(value));
  await assert.rejects(repair(value), /hard-linked managed/);
  const victim = path.join(value.root, "victim.txt");
  await writeFile(victim, "keep");
  const state = await readJson(statePath(value));
  state.scripts[0].target = victim;
  await writeFile(statePath(value), JSON.stringify(state));
  await assert.rejects(uninstall({ ...value, all: true }), /ownership state is invalid/);
  assert.equal(await readFile(victim, "utf8"), "keep");
});

test("built-in fallback requires a separate credential, including hard-link aliases", async (t) => {
  const value = await fixture(t);
  const fallback = path.join(value.root, "builtin-token");
  await writeFile(fallback, "f".repeat(64));
  await setup({ ...value, builtinFallbackTokenFile: fallback });
  const config = await readJson(configPath(value));
  assert.equal(config.builtinFallbackTokenFile, fallback);
  assert.equal(config.builtinFallbackEnabled, true);
  const duplicate = path.join(value.root, "duplicate-token");
  await writeFile(duplicate, await readFile(tokenPath(value)));
  await assert.rejects(repair({ ...value, builtinFallbackTokenFile: duplicate }), /must be distinct/);
  const alias = path.join(value.root, "alias-token");
  await link(tokenPath(value), alias);
  await assert.rejects(repair({ ...value, builtinFallbackTokenFile: alias }), /hard-linked managed/);
});

test("orphan reclamation serializes competing repair callers before replacing the dead owner's lock", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const lockPath = `${value.installRoot}.lock`;
  await writeFile(lockPath, JSON.stringify({ schema: 1, pid: Number(exited.stdout), hostname: os.hostname(), installRoot: value.installRoot, nonce: "c".repeat(32) }));
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const first = repair({ ...value, beforeLockRecovery: async () => { entered.resolve(); await resume.promise; } });
  await entered.promise;
  try {
    await assert.rejects(repair(value), /recovering/);
    assert.equal((await readJson(lockPath)).pid, Number(exited.stdout));
  } finally { resume.resolve(); }
  await first;
  assert.equal(await present(lockPath), false);
  assert.equal((await readJson(statePath(value))).status, "active");
});

test("preserved long executor deadlines migrate and register host deadlines outside the request window", async (t) => {
  const value = await fixture(t);
  await setup(value);
  await registerHost(hostOptions(value));
  const config = await readJson(configPath(value));
  config.requestTimeoutMs = 60000;
  await writeFile(configPath(value), JSON.stringify(config));
  await repair(value);
  const state = await readJson(statePath(value));
  assert.equal(state.hosts.omp.launcher.timeout, 70000);
  assert.equal((await readJson(hostOptions(value).mcpConfigPath)).mcpServers.potassium.timeout, 70000);
  await removeHost(hostOptions(value));
  await registerHost(hostOptions(value));
  assert.equal((await readJson(statePath(value))).hosts.omp.launcher.timeout, 70000);
  assert.equal((await readJson(configPath(value))).requestTimeoutMs, 60000);
});

test("repair deploys the configured IPv6 loopback endpoint without modifying npm-owned assets", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const canonicalPath = path.join(value.runtimeRoot, "assets", "potassium_mcp_bootstrap.lua");
  const canonical = await readFile(canonicalPath);
  const config = await readJson(configPath(value));
  Object.assign(config, { host: "::1", port: 33451 });
  await writeFile(configPath(value), JSON.stringify(config));
  await repair(value);
  assert.match(await readFile(bootstrapPath(value), "utf8"), /^local ENDPOINT = "ws:\/\/\[::1\]:33451"$/m);
  assert.deepEqual(await readFile(canonicalPath), canonical);
  assert.equal((await readJson(statePath(value))).scripts.find(({ target }) => target === bootstrapPath(value)).sha256, digest(await readFile(bootstrapPath(value))));
});

test("unchanged private configuration edited during deployment is never adopted into ownership", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const state = await readFile(statePath(value));
  const script = await readFile(bootstrapPath(value));
  const foreign = "{ not valid user configuration";
  await assert.rejects(repair({ ...value, onDeploymentActivation: async (name) => { if (name === "bootstrap") await writeFile(configPath(value), foreign); } }), /managed file changed/);
  assert.equal(await readFile(configPath(value), "utf8"), foreign);
  assert.deepEqual(await readFile(statePath(value)), state);
  assert.deepEqual(await readFile(bootstrapPath(value)), script);
});

test("unchanged credentials edited during deployment are not silently authorized by a new ownership hash", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const state = await readFile(statePath(value));
  const foreign = "z".repeat(64);
  await assert.rejects(repair({ ...value, onDeploymentActivation: async (name) => { if (name === "bootstrap") await writeFile(tokenPath(value), foreign); } }), /managed file changed/);
  assert.equal(await readFile(tokenPath(value), "utf8"), foreign);
  assert.deepEqual(await readFile(statePath(value)), state);
});

test("removing a configured custom identity conflicts unless an explicit setup overlay restores it", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, readHost: ["project-a"] });
  const options = hostOptions(value, "project-a");
  await registerHost(options);
  const state = await readFile(statePath(value));
  const config = await readJson(configPath(value));
  delete config.hostPolicies["project-a"];
  await writeFile(configPath(value), JSON.stringify(config));
  await assert.rejects(repair(value), /unsupported|configured|unknown/i);
  assert.deepEqual(await readFile(statePath(value)), state);
  await repair({ ...value, readHost: ["project-a"] });
  assert.equal((await printConfig({ ...value, hostId: "project-a" })).args.at(-1), "project-a");
});

test("same-version packages without the public runtime capability marker are incompatible before mutation", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const metadataPath = path.join(value.runtimeRoot, "package.json");
  const metadata = await readJson(metadataPath);
  delete metadata.potassiumMcpRuntime;
  await writeFile(metadataPath, JSON.stringify(metadata));
  const before = await filesBelow(value.root);
  await assert.rejects(repair(value), /external runtime is incompatible/);
  assert.deepEqual(await filesBelow(value.root), before);
});

test("schema-2 migration preserves effective dormant admin denial rather than expanding authority", async (t) => {
  const { value } = await legacyFixture(t);
  const config = await readJson(configPath(value));
  config.allowUnsafeExecute = false;
  config.hostPolicies = { omp: { read: true, admin: true, execute: false } };
  config.httpPolicy = { read: true, admin: true, execute: false };
  await writeFile(configPath(value), JSON.stringify(config));
  const state = await readJson(statePath(value));
  state.configSha256 = digest(await readFile(configPath(value)));
  await writeFile(statePath(value), JSON.stringify(state));
  const beforeConfig = await readFile(configPath(value));
  const beforeState = await readFile(statePath(value));
  const legacy = await loadConfig(configPath(value));
  assert.equal(legacy.policies.hosts.omp.admin, false);
  assert.equal(legacy.policies.hosts.omp.read, true);
  assert.equal(legacy.policies.http.admin, false);
  assert.deepEqual(await readFile(configPath(value)), beforeConfig);
  assert.deepEqual(await readFile(statePath(value)), beforeState);
  await writeFile(configPath(value), JSON.stringify({ ...config, allowUnsafeExecute: true }));
  state.configSha256 = digest(await readFile(configPath(value)));
  await writeFile(statePath(value), JSON.stringify(state));
  assert.equal((await loadConfig(configPath(value))).policies.hosts.omp.admin, true);
  await writeFile(configPath(value), beforeConfig);
  await writeFile(statePath(value), beforeState);
  const manualPath = path.join(value.root, "manual-config.json");
  await writeFile(manualPath, beforeConfig);
  assert.equal((await loadConfig(manualPath)).policies.hosts.omp.admin, true);
  await setup(value);
  const migrated = await readJson(configPath(value));
  assert.equal(migrated.hostPolicies.omp.admin, false);
  assert.equal(migrated.httpPolicy.admin, false);
  await repair({ ...value, adminHost: ["omp"], httpAdmin: true });
  const explicit = await readJson(configPath(value));
  assert.equal(explicit.hostPolicies.omp.admin, true);
  assert.equal(explicit.httpPolicy.admin, true);
  assert.equal((await loadConfig(configPath(value))).policies.hosts.omp.admin, true);
  const claimed = await readJson(statePath(value));
  claimed.configSha256 = "0".repeat(64);
  await writeFile(statePath(value), JSON.stringify(claimed));
  await assert.rejects(loadConfig(configPath(value)), /conflicts with existing ownership/);
});

test("setup never rebinds the workspace credential to inline or alternate config-relative tokens", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const config = await readJson(configPath(value));
  const state = await readFile(statePath(value));
  const token = await readFile(tokenPath(value), "utf8");
  const { tokenFile, ...inline } = config;
  await writeFile(configPath(value), JSON.stringify({ ...inline, token: token.trim() }));
  await assert.rejects(repair(value), /token path is not owned/);
  const alternative = path.join(value.installRoot, "other-token");
  await writeFile(alternative, token);
  await writeFile(configPath(value), JSON.stringify({ ...config, tokenFile: "./other-token" }));
  await assert.rejects(repair(value), /token path is not owned/);
  assert.equal(await readFile(alternative, "utf8"), token);
  assert.deepEqual(await readFile(statePath(value)), state);
});

test("a held validated repair can authenticate unchanged credentials despite an intentional config hash edit", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const credential = (await readFile(tokenPath(value), "utf8")).trim();
  const config = await readJson(configPath(value));
  Object.assign(config, { port: 33451, proxyPort: 33452, requestTimeoutMs: 60000 });
  const edited = JSON.stringify(config);
  await writeFile(configPath(value), edited);
  await assert.rejects(loadConfig(configPath(value)), /conflicts with existing ownership/);
  const brokerLifecycle = {
    brokerStatus: async () => ({ status: "running" }),
    stopBroker: async ({ installLease, repairContext }) => {
      const proven = await readRepairDrainCredentials(configPath(value), installLease, repairContext);
      assert.equal(proven.token, credential);
    },
    restartBroker: async () => {},
  };
  await repair({ ...value, brokerLifecycle });
  assert.equal(await readFile(configPath(value), "utf8"), edited);
  const active = await loadConfig(configPath(value));
  assert.equal(active.port, 33451);
  assert.equal(active.proxyPort, 33452);
  assert.equal(active.requestTimeoutMs, 60000);
});

test("validated repair drain rejects a second config edit after preflight without adopting foreign bytes", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const state = await readFile(statePath(value));
  const config = await readJson(configPath(value));
  config.requestTimeoutMs = 60000;
  await writeFile(configPath(value), JSON.stringify(config));
  const foreign = JSON.stringify({ ...config, requestTimeoutMs: 61000 });
  const brokerLifecycle = {
    brokerStatus: async () => { await writeFile(configPath(value), foreign); return { status: "running" }; },
    stopBroker: async ({ installLease, repairContext }) => { await readRepairDrainCredentials(configPath(value), installLease, repairContext); },
    restartBroker: async () => { throw new Error("must not restart after failed drain proof"); },
  };
  await assert.rejects(repair({ ...value, brokerLifecycle }), /changed after repair preflight/);
  assert.equal(await readFile(configPath(value), "utf8"), foreign);
  assert.deepEqual(await readFile(statePath(value)), state);
});

test("failed precommit repair with unavailable old config retains explicit resume evidence instead of claiming old restart", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const token = await readFile(tokenPath(value));
  const config = await readJson(configPath(value));
  config.requestTimeoutMs = 60000;
  const edited = JSON.stringify(config);
  await writeFile(configPath(value), edited);
  const brokerLifecycle = {
    brokerStatus: async () => ({ status: "running" }),
    stopBroker: async ({ installLease, repairContext }) => { await readRepairDrainCredentials(configPath(value), installLease, repairContext); },
    restartBroker: async () => { throw new Error("old in-memory configuration must not be guessed"); },
  };
  await assert.rejects(repair({ ...value, brokerLifecycle, beforeRestart: () => { throw new Error("failure before restart"); } }), /original running configuration bytes are unavailable/);
  assert.equal(await readFile(configPath(value), "utf8"), edited);
  assert.deepEqual(await readFile(tokenPath(value)), token);
  assert.equal((await readJson(`${value.installRoot}.transaction.json`)).phase, "committed");
  await assert.rejects(loadConfig(configPath(value)), /conflicts with existing ownership/);
});

test("journal unlink failure after commit reports cleanup pending without reverting already-published state", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const journalPath = `${value.installRoot}.transaction.json`;
  const result = await repair({
    ...value, allowUnsafeExecute: true,
    remove: async (target, options) => {
      if (target === journalPath) throw new Error("journal unlink denied");
      await rm(target, options);
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.cleanupPending, true);
  assert.equal((await loadConfig(configPath(value))).allowUnsafeExecute, true);
  const journal = await readJson(journalPath);
  assert.equal(journal.phase, "committed");
  for (const { backup } of journal.entries) if (backup) assert.equal(await present(backup), false);
});

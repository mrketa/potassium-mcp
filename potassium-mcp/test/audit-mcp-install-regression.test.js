import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parse as parseJsonc } from "jsonc-parser";

const packageRoot = process.env.POTASSIUM_INSTALL_AUDIT_ROOT
  ? pathToFileURL(`${path.resolve(process.env.POTASSIUM_INSTALL_AUDIT_ROOT)}${path.sep}`)
  : new URL("../", import.meta.url);
const { setup, repair, registerHost, removeHost } = await import(new URL("src/install.js", packageRoot));
const { deploy, rejectUnsafePaths } = await import(new URL("src/deploy.js", packageRoot));
const { doctor } = await import(new URL("src/doctor.js", packageRoot));
const { removeConfig, transformConfig, verifyOwnership } = await import(new URL("src/hosts.js", packageRoot));
const { allowsTool, parsePolicyConfig } = await import(new URL("src/host-policy.js", packageRoot));
const { distTagForVersion } = await import(new URL("release-publish.js", packageRoot));
const packageMetadata = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-install-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "MCP");
  const workspaceRoot = path.join(root, "workspace");
  const mcpConfigPath = path.join(root, ".omp", "mcp.json");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(path.dirname(mcpConfigPath), { recursive: true });
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
  const nodeExecutable = path.join(root, "node.exe");
  await writeFile(nodeExecutable, "");
  const runtimeRoot = path.join(root, "runtime");
  await Promise.all(["bin", "src", "assets"].map((directory) => mkdir(path.join(runtimeRoot, directory), { recursive: true })));
  await writeFile(path.join(runtimeRoot, "package.json"), JSON.stringify({
    name: "@mrketa/potassium-mcp", version: packageMetadata.version,
    potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 },
  }));
  await writeFile(path.join(runtimeRoot, "bin", "potassium-mcp.js"), "// inert CLI fixture\n");
  for (const name of ["proxy", "broker"]) {
    await writeFile(path.join(runtimeRoot, "src", `${name}.js`), `// inert ${name} fixture\n`);
  }
  await writeFile(path.join(runtimeRoot, "assets", "potassium_mcp_bootstrap.lua"), 'local ENDPOINT = "ws://127.0.0.1:32145"\nreturn {}\n');
  await writeFile(path.join(runtimeRoot, "assets", "potassium_mcp_autoexec.lua"), "return true\n");
  return {
    root, cwd: root, installRoot, workspaceRoot, runtimeRoot, nodeExecutable,
    env: { USERPROFILE: path.join(root, "user"), APPDATA: path.join(root, "appdata") },
    run: () => ({ status: 0 }),
    runCommand: () => { throw new Error("unexpected host CLI invocation"); },
    brokerLifecycle: {
      brokerStatus: async () => ({ status: "absent" }),
      restartBroker: async () => { throw new Error("unexpected broker restart"); },
      stopBroker: async () => { throw new Error("unexpected broker stop"); },
    },
  };
}

const runtimeConfig = async (value) => JSON.parse(await readFile(path.join(value.installRoot, "config.json"), "utf8"));

function cliQueryResult(registered) {
  return registered
    ? { status: 0, stdout: JSON.stringify({ name: "potassium", type: "stdio", command: registered[0], args: registered.slice(1) }), stderr: "" }
    : { status: 1, stdout: "", stderr: "No MCP server found with name: potassium" };
}

test("audit install: refusing a held lock preserves the active deployment state", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const statePath = path.join(value.installRoot, "deploy-state.json");
  await writeFile(`${value.installRoot}.lock`, "owned by another operation");
  const before = await readFile(statePath);
  await assert.rejects(setup(value), /holds/);
  assert.deepEqual(await readFile(statePath), before);
  assert.equal(await readFile(`${value.installRoot}.lock`, "utf8"), "owned by another operation");
});

test("audit install: failed repair preparation preserves deployment evidence and releases its lock", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const statePath = path.join(value.installRoot, "deploy-state.json");
  const before = await readFile(statePath);
  const requiredPath = path.join(value.runtimeRoot, "bin", "potassium-mcp.js");
  const requiredBytes = await readFile(requiredPath);
  await rm(requiredPath);
  await assert.rejects(repair(value), /external runtime is missing required file/);
  assert.deepEqual(await readFile(statePath), before);
  await assert.rejects(readFile(`${value.installRoot}.lock`), { code: "ENOENT" });
  await writeFile(requiredPath, requiredBytes);
  await repair(value);
  assert.equal((await doctor(value)).ok, true);
});

test("audit install: rollback failure still releases the lock and removes atomic temporary files", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const bootstrap = path.join(value.workspaceRoot, ".potassium-mcp-bootstrap.lua");
  const beforeBootstrap = await readFile(bootstrap);
  const foreignPath = path.join(bootstrap, "foreign.txt");
  await assert.rejects(repair({
    ...value,
    onDeploymentActivation: async (name) => {
      if (name !== "bootstrap") return;
      await rm(bootstrap);
      await mkdir(bootstrap);
      await writeFile(foreignPath, "foreign deployment output\n");
      throw new Error("deployment activation failed");
    },
  }), /deployment activation failed; recovery required/);
  await assert.rejects(readFile(`${value.installRoot}.lock`), { code: "ENOENT" });
  assert.deepEqual((await readdir(value.workspaceRoot)).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(await readFile(foreignPath, "utf8"), "foreign deployment output\n");
  const journal = JSON.parse(await readFile(`${value.installRoot}.transaction.json`, "utf8"));
  const bootstrapEntry = journal.entries.find(({ target }) => target === bootstrap);
  assert.deepEqual(await readFile(bootstrapEntry.backup), beforeBootstrap);
});

test("audit install: a config override is refused for a CLI host without touching that file", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const mcpConfigPath = path.join(value.root, ".omp", "mcp.json");
  const before = await readFile(mcpConfigPath);
  await assert.rejects(registerHost({ ...value, host: "claude-code", hostId: "claude-code", mcpConfigPath }), /file-backed host/);
  assert.deepEqual(await readFile(mcpConfigPath), before);
});

test("audit install: separate Windows drives are not overlapping managed roots", { skip: process.platform !== "win32" }, async (t) => {
  const value = await fixture(t);
  const currentDrive = path.parse(value.workspaceRoot).root[0].toUpperCase();
  let otherRoot;
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (letter === currentDrive) continue;
    try {
      otherRoot = await realpath(`${letter}:\\`);
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ENXIO", "EINVAL", "EIO"].includes(error.code)) throw error;
    }
  }
  if (!otherRoot) {
    t.skip("requires a second existing Windows drive for canonical cross-volume planning");
    return;
  }
  const result = await setup({
    ...value,
    installRoot: path.join(otherRoot, path.basename(value.root), "private"),
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.runtime.root, value.runtimeRoot);
});

test("audit install: project Claude registration remains repairable and removable without repeating scope", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const configPath = path.join(value.root, ".mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
  await registerHost({ ...value, host: "claude-code", hostId: "claude-code", scope: "project" });
  await repair(value);
  assert.equal((await doctor(value)).ok, true);
  assert.equal((await removeHost({ ...value, hostId: "claude-code" })).sharedRetained, true);
  assert.equal((await doctor(value)).ok, true);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { mcpServers: { other: { command: "keep" } } });
});

test("audit install: changing one policy axis preserves independent read denials and execute grants", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, allowUnsafeExecute: true, adminHost: [], executeHost: ["omp"], httpRead: false, httpAdmin: true, httpExecute: true });
  await repair({ ...value, allowUnsafeExecute: true, denyReadHost: ["omp"], httpAdmin: true });
  const config = await runtimeConfig(value);
  const policies = parsePolicyConfig(config);
  assert.equal(allowsTool(policies.hosts.omp, "potassium_status", config), false);
  assert.equal(allowsTool(policies.hosts.omp, "potassium_admin_status", config), false);
  assert.equal(allowsTool(policies.hosts.omp, "potassium_execute_luau", config), true);
  assert.equal(allowsTool(policies.http, "potassium_status", config), false);
  assert.equal(allowsTool(policies.http, "potassium_execute_luau", config), true);
});

test("audit install: repair grants a selected host capability while preserving existing host restrictions", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, denyReadHost: ["omp"], adminHost: [] });
  await repair({ ...value, adminHost: ["manual"] });
  const config = await runtimeConfig(value);
  const policies = parsePolicyConfig(config);
  assert.equal(allowsTool(policies.hosts.omp, "potassium_status", config), false);
  assert.equal(allowsTool(policies.hosts.manual, "potassium_admin_status", config), true);
});

test("audit install: redirected managed token paths are refused even when their bytes match", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const tokenPath = path.join(value.workspaceRoot, ".potassium-mcp-token");
  const outside = path.join(value.root, "outside");
  await mkdir(outside);
  const before = await readFile(tokenPath);
  await writeFile(path.join(outside, ".potassium-mcp-token"), before);
  await rm(tokenPath);
  try {
    await symlink(path.join(outside, ".potassium-mcp-token"), tokenPath, "file");
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    t.skip("file symlinks require local privilege");
    return;
  }
  await assert.rejects(repair(value), /linked managed path/);
  assert.deepEqual(await readFile(path.join(outside, ".potassium-mcp-token")), before);
});

const hostOptions = { cwd: process.cwd(), scope: "project" };
const hostLauncher = { type: "stdio", command: process.execPath, args: ["proxy.js", "--config", "config.json"], timeout: 40000 };
const vscodeEntry = JSON.stringify({ type: "stdio", command: hostLauncher.command, args: hostLauncher.args });

for (const [label, servers, expected] of [
  ["sole trailing-comma property", `"potassium":${vscodeEntry}, /* retained, comment */`, {}],
  ["final property following a comment comma", `"other":{"command":"keep"} /* retained, comment */, "potassium":${vscodeEntry},`, { other: { command: "keep" } }],
  ["first property followed by an unrelated comment", `"potassium":${vscodeEntry}, /* retained, comment */ "other":{"command":"keep"}`, { other: { command: "keep" } }],
]) {
  test(`audit hosts: removing ${label} preserves valid JSONC and unrelated comments`, () => {
    const source = `{"servers":{${servers}},"unrelated":true}`;
    const removed = removeConfig("vscode", source, hostLauncher, hostOptions).content;
    const errors = [];
    const parsed = parseJsonc(removed, errors, { allowTrailingComma: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(parsed, { servers: expected, unrelated: true });
    assert.ok(removed.includes("/* retained, comment */"));
  });
}

for (const [label, source] of [
  ["duplicate server entries", `{"servers":{"potassium":{"command":"foreign"},"potassium":${vscodeEntry}}}`],
  ["duplicate server containers", `{"servers":{"potassium":{"command":"foreign"}},"servers":{"potassium":${vscodeEntry}}}`],
]) {
  test(`audit hosts: ${label} cannot establish ownership or remove a foreign entry`, () => {
    assert.equal(verifyOwnership("vscode", source, hostLauncher, hostOptions).owned, false);
    assert.throws(() => transformConfig("vscode", source, hostLauncher, hostOptions));
    assert.throws(() => removeConfig("vscode", source, hostLauncher, hostOptions));
  });
}

test("audit deploy: staging failure leaves no staging files or activated scripts", async (t) => {
  const value = await fixture(t);
  const source = path.join(value.root, "scripts");
  await mkdir(source);
  await writeFile(path.join(source, "potassium_mcp_bootstrap.lua"), "return {}\n");
  await writeFile(path.join(source, "potassium_mcp_autoexec.lua"), "return true\n");
  const autoexecRoot = path.join(value.root, "autoexec");
  await mkdir(autoexecRoot);
  await assert.rejects(deploy({
    scriptSourceRoot: source,
    workspaceRoot: value.workspaceRoot,
    autoexecRoot,
    compileProbe: async () => {
      await rm(autoexecRoot, { recursive: true });
      await writeFile(autoexecRoot, "not a directory");
    },
  }));
  assert.deepEqual(await readdir(value.workspaceRoot), []);
  assert.equal(await readFile(autoexecRoot, "utf8"), "not a directory");
});

test("audit deploy: nonexisting descendants of a linked source ancestor cannot be targets", async (t) => {
  const value = await fixture(t);
  const source = path.join(value.root, "scripts");
  const alias = path.join(value.root, "source-alias");
  await mkdir(source);
  await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
  const workspaceRoot = path.join(alias, "not-created");
  await assert.rejects(rejectUnsafePaths({
    scriptSourceRoot: source,
    workspaceRoot,
    autoexecRoot: path.join(value.root, "autoexec"),
    statePath: path.join(value.root, "state.json"),
    targets: [path.join(workspaceRoot, "bootstrap.lua")],
  }), /must not overlap/);
});

test("audit doctor: duplicate deployment records cannot substitute for the missing canonical record", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const statePath = path.join(value.installRoot, "deploy-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.files[1] = { ...state.files[0] };
  await writeFile(statePath, JSON.stringify(state));
  const result = await doctor(value);
  assert.equal(result.checks.find(({ name }) => name === "deploy-state").ok, false);
});

test("audit CLI: a following flag is rejected as a missing path value", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("bin/potassium-mcp.js", packageRoot)), "setup", "--install-root", "--json"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).ok, false);
});

test("audit release: build metadata cannot reroute a stable version from latest", () => {
  assert.equal(distTagForVersion("1.2.3+build-sha.abc"), "latest");
});

test("audit hosts: managed-looking TOML inside a multiline value does not prove ownership", () => {
  const options = { cwd: process.cwd(), env: { HOME: os.homedir() }, scope: "user" };
  const block = transformConfig("codex", "", hostLauncher, options).content;
  const source = `notes = '''\n${block}'''\n`;
  assert.equal(verifyOwnership("codex", source, hostLauncher, options).owned, false);
  assert.throws(() => removeConfig("codex", source, hostLauncher, options));
});

test("audit hosts: quoted Codex parent tables cannot be overwritten as unmanaged sections", () => {
  const source = `["mcp_servers"."potassium"]\ncommand = "foreign"\n`;
  assert.throws(() => transformConfig("codex", source, hostLauncher, {
    cwd: process.cwd(), env: { HOME: os.homedir() }, scope: "user",
  }), /unmanaged/);
});

test("audit install: adding another host cannot reset an unselected host read denial", async (t) => {
  const value = await fixture(t);
  await setup({ ...value, denyReadHost: ["omp"] });
  await registerHost({ ...value, host: "omp", hostId: "omp", mcpConfigPath: path.join(value.root, ".omp", "mcp.json") });
  const before = await readFile(path.join(value.installRoot, "config.json"));
  await registerHost({ ...value, host: "vscode", hostId: "vscode", mcpConfigPath: path.join(value.root, "vscode", "mcp.json") });
  assert.deepEqual(await readFile(path.join(value.installRoot, "config.json")), before);
  const config = await runtimeConfig(value);
  assert.equal(allowsTool(parsePolicyConfig(config).hosts.omp, "potassium_status", config), false);
});

test("audit install: CLI repair updates a moved executable and restores it after a failed replacement", async (t) => {
  const value = await fixture(t);
  let registered;
  let rejectNextAdd = false;
  const runCommand = (_command, args) => {
    if (args[1] === "get") return cliQueryResult(registered);
    if (args[1] === "remove") {
      if (!registered) return cliQueryResult(undefined);
      registered = undefined;
    }
    if (args[1] === "add") {
      if (rejectNextAdd) {
        rejectNextAdd = false;
        return { status: 1 };
      }
      registered = args.slice(args.indexOf("--") + 1);
    }
    return { status: 0 };
  };
  const options = { ...value, runCommand };
  await setup(options);
  await registerHost({ ...options, host: "claude-code", hostId: "claude-code" });
  const movedExecutable = path.join(value.root, "updated-node.exe");
  await writeFile(movedExecutable, "");
  await repair({ ...options, nodeExecutable: movedExecutable });
  assert.equal((await doctor({ ...options, nodeExecutable: movedExecutable })).ok, true);
  assert.equal(registered[0], movedExecutable);
  const before = [...registered];
  rejectNextAdd = true;
  await assert.rejects(repair(options), /CLI registration failed/);
  assert.deepEqual(registered, before);
  assert.equal((await doctor({ ...options, nodeExecutable: movedExecutable })).ok, true);
});

test("audit install: a CLI permission error cannot prove absence or authorize an add", async (t) => {
  const value = await fixture(t);
  await setup(value);
  const statePath = path.join(value.installRoot, "ownership.json");
  const before = await readFile(statePath);
  const calls = [];
  await assert.rejects(registerHost({
    ...value, host: "claude-code", hostId: "claude-code",
    runCommand: (_command, args) => {
      calls.push(args[1]);
      return { status: 1, stdout: "", stderr: "Permission denied" };
    },
  }), /absence cannot be proved/);
  assert.deepEqual(calls, ["get"]);
  assert.deepEqual(await readFile(statePath), before);
});

test("audit install: CLI ownership changes after preflight cannot authorize replacement", async (t) => {
  const value = await fixture(t);
  let registered;
  const foreign = ["foreign-node", "foreign-server.js"];
  const mutations = [];
  const runCommand = (_command, args) => {
    if (args[1] === "get") return cliQueryResult(registered);
    mutations.push(args[1]);
    if (args[1] === "remove") {
      if (!registered) return cliQueryResult(undefined);
      registered = undefined;
    }
    if (args[1] === "add") registered = args.slice(args.indexOf("--") + 1);
    return { status: 0 };
  };
  const options = { ...value, runCommand };
  await setup(options);
  await registerHost({ ...options, host: "claude-code", hostId: "claude-code" });
  const statePath = path.join(value.installRoot, "ownership.json");
  const before = await readFile(statePath);
  const movedExecutable = path.join(value.root, "updated-node.exe");
  await writeFile(movedExecutable, "");
  mutations.length = 0;
  await assert.rejects(repair({
    ...options, nodeExecutable: movedExecutable,
    beforeMcpCommit: ({ kind, host, operation }) => {
      if (kind === "cli" && host === "claude-code" && operation === "setup") registered = [...foreign];
    },
  }), /host ownership changed before CLI replacement/);
  assert.deepEqual(registered, foreign);
  assert.deepEqual(mutations, []);
  assert.deepEqual(await readFile(statePath), before);
  await assert.rejects(readFile(`${value.installRoot}.lock`), { code: "ENOENT" });
});

test("audit install: failed CLI replacement preserves a foreign registration created during add", async (t) => {
  const value = await fixture(t);
  let registered;
  let replaceWithForeign = false;
  const foreign = ["foreign-node", "foreign-server.js"];
  const mutations = [];
  const runCommand = (_command, args) => {
    if (args[1] === "get") return cliQueryResult(registered);
    mutations.push(args[1]);
    if (args[1] === "remove") {
      if (!registered) return cliQueryResult(undefined);
      registered = undefined;
    }
    if (args[1] === "add") {
      if (replaceWithForeign) {
        registered = [...foreign];
        return { status: 1, stderr: "registration changed concurrently" };
      }
      registered = args.slice(args.indexOf("--") + 1);
    }
    return { status: 0 };
  };
  const options = { ...value, runCommand };
  await setup(options);
  await registerHost({ ...options, host: "claude-code", hostId: "claude-code" });
  const statePath = path.join(value.installRoot, "ownership.json");
  const before = await readFile(statePath);
  const movedExecutable = path.join(value.root, "updated-node.exe");
  await writeFile(movedExecutable, "");
  mutations.length = 0;
  replaceWithForeign = true;
  await assert.rejects(repair({ ...options, nodeExecutable: movedExecutable }), /recovery required:.*CLI rollback ownership is ambiguous/);
  assert.deepEqual(registered, foreign);
  assert.deepEqual(mutations, ["remove", "add"]);
  assert.deepEqual(await readFile(statePath), before);
  await assert.rejects(readFile(`${value.installRoot}.lock`), { code: "ENOENT" });
});

test("audit install: local CLI registrations keep their project binding through repair and removal elsewhere", async (t) => {
  const value = await fixture(t);
  const projects = await Promise.all(["first", "second", "elsewhere"].map(async (name) => {
    const directory = path.join(value.root, name);
    await mkdir(directory);
    return realpath(directory);
  }));
  const registered = new Map();
  const mutations = [];
  const runCommand = (_command, args, { cwd }) => {
    if (args[1] === "get") return cliQueryResult(registered.get(cwd));
    mutations.push({ action: args[1], cwd });
    if (args[1] === "remove") {
      if (!registered.delete(cwd)) return cliQueryResult(undefined);
    }
    if (args[1] === "add") registered.set(cwd, args.slice(args.indexOf("--") + 1));
    return { status: 0 };
  };
  const options = { ...value, runCommand };
  await setup({ ...options, readHost: ["claude-first", "claude-second"] });
  for (const [index, hostId] of ["claude-first", "claude-second"].entries()) {
    const result = await registerHost({ ...options, host: "claude-code", hostId, scope: "local", cwd: projects[index] });
    assert.equal(result.host.cwd, projects[index]);
  }
  assert.deepEqual([...registered.keys()], projects.slice(0, 2));
  const movedExecutable = path.join(value.root, "updated-node.exe");
  await writeFile(movedExecutable, "");
  await repair({ ...options, cwd: projects[2], nodeExecutable: movedExecutable });
  assert.equal(registered.get(projects[0])[0], movedExecutable);
  assert.equal(registered.get(projects[1])[0], movedExecutable);
  assert.equal(registered.has(projects[2]), false);
  const second = [...registered.get(projects[1])];
  mutations.length = 0;
  await removeHost({ ...options, cwd: projects[2], hostId: "claude-first" });
  assert.equal(registered.has(projects[0]), false);
  assert.deepEqual(registered.get(projects[1]), second);
  assert.deepEqual(mutations, [{ action: "remove", cwd: projects[0] }]);

  const statePath = path.join(value.installRoot, "ownership.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.hosts["claude-second"].cwd;
  await writeFile(statePath, JSON.stringify(state));
  const unboundState = await readFile(statePath);
  const unexpectedCommand = () => { throw new Error("unbound local ownership must be refused before querying a project"); };
  await assert.rejects(repair({ ...options, cwd: projects[2], runCommand: unexpectedCommand }), /local host project ownership is unproven/);
  await assert.rejects(removeHost({ ...options, cwd: projects[2], hostId: "claude-second", runCommand: unexpectedCommand }), /local host project ownership is unproven/);
  assert.deepEqual(registered.get(projects[1]), second);
  assert.deepEqual(await readFile(statePath), unboundState);
});

test("audit install: user CLI scope stays global and cannot mix with project scope", async (t) => {
  const value = await fixture(t);
  const elsewhere = path.join(value.root, "elsewhere");
  await mkdir(elsewhere);
  let registered;
  const mutations = [];
  const runCommand = (_command, args) => {
    if (args[1] === "get") return cliQueryResult(registered);
    mutations.push(args[1]);
    if (args[1] === "remove") {
      if (!registered) return cliQueryResult(undefined);
      registered = undefined;
    }
    if (args[1] === "add") registered = args.slice(args.indexOf("--") + 1);
    return { status: 0 };
  };
  const options = { ...value, runCommand };
  await setup({ ...options, readHost: ["claude-first", "claude-second"] });
  await registerHost({ ...options, host: "claude-code", hostId: "claude-first", scope: "user" });
  const before = [...registered];
  mutations.length = 0;
  await assert.rejects(registerHost({ ...options, cwd: elsewhere, host: "claude-code", hostId: "claude-second", scope: "user" }), /host CLI scope is already registered/);
  assert.deepEqual(registered, before);
  assert.deepEqual(mutations, []);
  const projectConfigPath = path.join(elsewhere, ".mcp.json");
  const projectConfig = '{\n  "mcpServers": { "other": { "command": "keep" } }\n}\n';
  await writeFile(projectConfigPath, projectConfig);
  const statePath = path.join(value.installRoot, "ownership.json");
  const beforeState = await readFile(statePath);
  await assert.rejects(registerHost({ ...options, cwd: elsewhere, host: "claude-code", hostId: "claude-second", scope: "project" }));
  assert.equal(await readFile(projectConfigPath, "utf8"), projectConfig);
  assert.deepEqual(await readFile(statePath), beforeState);
  assert.deepEqual(registered, before);
  assert.deepEqual(mutations, []);
  await removeHost({ ...options, cwd: elsewhere, hostId: "claude-first" });
  assert.equal(registered, undefined);
  assert.deepEqual(mutations, ["remove"]);
});

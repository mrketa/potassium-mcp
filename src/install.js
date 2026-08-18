import { createHash, randomBytes } from "node:crypto";
import { access, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { deploy } from "./deploy.js";
import { doctor } from "./doctor.js";
import {
  createInstallPlan,
  removeConfig,
  resolveHost,
  transformConfig,
  verifyOwnership,
} from "./hosts.js";
import packageMetadata from "../package.json" with { type: "json" };

const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (target, fallback) => await exists(target)
  ? JSON.parse(await readFile(target, "utf8"))
  : fallback;

async function writeAtomic(target, value) {
  const staged = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    staged,
    typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(staged, target);
}

async function rejectLinkedPath(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`refusing linked managed path: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      break;
    }
  }
}

async function acquireInstallLock(installRoot) {
  const lockPath = `${installRoot}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`another Potassium MCP operation holds ${lockPath}: ${error.code ?? error.message}`);
  }
  return async () => {
    await handle.close();
    await rm(lockPath, { force: true });
  };
}

export function defaults() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return {
    installRoot: path.join(local, "Potassium", "MCP"),
    workspaceRoot: path.join(local, "Potassium", "data"),
  };
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function installationPaths(options = {}) {
  const base = defaults();
  const installRoot = path.resolve(options.installRoot ?? base.installRoot);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? base.workspaceRoot);
  const mcpConfigPath = options.mcpConfigPath ? path.resolve(options.mcpConfigPath) : undefined;
  if (overlaps(installRoot, workspaceRoot) || overlaps(workspaceRoot, installRoot)) {
    throw new Error("install root and workspace must not overlap");
  }
  if (mcpConfigPath && overlaps(installRoot, mcpConfigPath)) {
    throw new Error("MCP config must be outside the install root");
  }
  return {
    installRoot,
    workspaceRoot,
    mcpConfigPath,
    appPath: path.join(installRoot, "app"),
    configPath: path.join(installRoot, "config.json"),
    statePath: path.join(installRoot, "ownership.json"),
  };
}

export async function restrictTokenAcl(tokenPath, run = spawnSync) {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!user) throw new Error("USERNAME is required to secure the token file");
  const result = run("icacls", [tokenPath, "/inheritance:r", "/grant:r", `${user}:F`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Unable to restrict token-file ACL");
}

async function applyFileAcl(target, source, options = {}) {
  if (source && options.copyAcl) {
    await options.copyAcl({ source, target });
    return;
  }
  if (process.platform !== "win32") return;
  if (!source) {
    await restrictTokenAcl(target, options.run ?? spawnSync);
    return;
  }
  const command = "$acl = Get-Acl -LiteralPath $env:POTASSIUM_ACL_SOURCE; Set-Acl -LiteralPath $env:POTASSIUM_ACL_TARGET -AclObject $acl";
  const result = (options.run ?? spawnSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, POTASSIUM_ACL_SOURCE: source, POTASSIUM_ACL_TARGET: target },
  });
  if (result.error || result.status !== 0) throw new Error("Unable to preserve MCP-config ACL");
}

async function writeProtectedAtomic(target, value, options = {}, aclSource) {
  const staged = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(staged, "", { mode: 0o600, flag: "wx" });
    await applyFileAcl(staged, aclSource, options);
    await writeFile(
      staged,
      typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

async function installRuntime(stage, source, options) {
  if (options.installPackage) return options.installPackage({ stage, source });
  const args = ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--prefix", stage, "--", source];
  let command = "npm";
  let commandArgs = args;
  if (process.platform === "win32") {
    const npmCli = process.env.npm_execpath
      ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!await exists(npmCli)) throw new Error(`npm CLI was not found: ${npmCli}`);
    command = process.execPath;
    commandArgs = [npmCli, ...args];
  }
  const result = spawnSync(command, commandArgs, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status}`;
    throw new Error(`npm could not install the Potassium MCP runtime: ${detail}`);
  }
}

function runtimePath(appPath) {
  return path.join(appPath, "node_modules", "@mrketa", "potassium-mcp");
}

export const EXECUTOR_REQUEST_TIMEOUT_MS = 30000;
export const MCP_LAUNCHER_TIMEOUT_MS = 40000;

function runtimeConfig(workspaceRoot, tokenPath, allowUnsafeExecute = false) {
  return {
    host: "127.0.0.1",
    port: 32145,
    proxyHost: "127.0.0.1",
    proxyPort: 32146,
    proxyMaxFrameBytes: 1048576,
    proxyHandshakeTimeoutMs: 5000,
    tokenFile: tokenPath,
    requestTimeoutMs: EXECUTOR_REQUEST_TIMEOUT_MS,
    maxMessageBytes: 1048576,
    maxPendingRequests: 64,
    shutdownGraceMs: 5000,
    allowUnsafeExecute,
    adminAuditPath: path.join(workspaceRoot, "potassium-mcp-admin-audit.ndjson"),
    artifactRoots: [{
      name: "artifacts",
      path: path.join(workspaceRoot, "potassium-mcp-artifacts"),
      recursive: true,
      extensions: [".json", ".ndjson", ".txt", ".log"],
    }],
    httpAllowedHosts: ["apis.roblox.com", "games.roblox.com", "thumbnails.roblox.com", "users.roblox.com"],
  };
}

export function launcher(proxyPath, configPath, nodeExecutable = process.execPath) {
  if (!path.isAbsolute(nodeExecutable)) throw new Error("Node executable must be an absolute path");
  return {
    type: "stdio",
    command: nodeExecutable,
    args: [proxyPath, "--config", configPath],
    timeout: MCP_LAUNCHER_TIMEOUT_MS,
  };
}

function selectedHosts(options) {
  const selected = options.hosts
    ?? (options.host ? (Array.isArray(options.host) ? options.host : [options.host]) : []);
  if (selected.length === 0) throw new Error("at least one host is required");
  return [...new Set(selected)];
}

function hostOptions(options, hostId, configPath, selectedCount = 1) {
  return {
    cwd: options.cwd,
    env: options.env,
    scope: options.scope,
    configPath: configPath ?? (selectedCount === 1 ? options.mcpConfigPath : undefined),
  };
}

function expectedScriptPaths(workspaceRoot) {
  return new Set([
    path.join(workspaceRoot, ".potassium-mcp-bootstrap.lua"),
    path.join(workspaceRoot, "..", "autoexec", "potassium_mcp_autoexec.lua"),
  ]);
}

function validateSchema2Shape(state, value) {
  const scripts = Array.isArray(state?.scripts) ? state.scripts : [];
  const scriptPaths = new Set(scripts.map(({ target }) => target));
  const expected = expectedScriptPaths(value.workspaceRoot);
  return state?.schema === 2
    && state.installRoot === value.installRoot
    && state.workspaceRoot === value.workspaceRoot
    && state.appPath === value.appPath
    && state.configPath === value.configPath
    && state.tokenPath === path.join(value.workspaceRoot, ".potassium-mcp-token")
    && state.hosts && typeof state.hosts === "object" && !Array.isArray(state.hosts)
    && scripts.length === 2 && scriptPaths.size === 2
    && [...expected].every((target) => scriptPaths.has(target));
}

async function runHostCommand(options, command, args) {
  if (options.runCommand) return options.runCommand(command, args);
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function commandOk(result) {
  return !result?.error && (result?.status === undefined || result.status === 0);
}

async function verifyCliRecord(record, options) {
  if (options.verifyCliRegistration) return options.verifyCliRegistration(record);
  const result = await runHostCommand(options, record.command, ["mcp", "get", "potassium"]);
  if (!commandOk(result)) return false;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes(record.launcher.command)
    && record.launcher.args.every((argument) => output.includes(argument));
}


async function proveSchema2(state, value, options) {
  if (!validateSchema2Shape(state, value)) throw new Error("ownership state is invalid");
  if (!await exists(state.tokenPath) || hash(await readFile(state.tokenPath)) !== state.tokenSha256) {
    throw new Error("token ownership is ambiguous");
  }
  if (!await exists(value.configPath) || hash(await readFile(value.configPath)) !== state.configSha256) {
    throw new Error("runtime config ownership is ambiguous");
  }
  const proxyPath = path.join(runtimePath(value.appPath), "src", "proxy.js");
  if (!await exists(proxyPath) || hash(await readFile(proxyPath)) !== state.serverSha256) {
    throw new Error("runtime ownership is ambiguous");
  }
  for (const script of state.scripts) {
    if (!await exists(script.target) || hash(await readFile(script.target)) !== script.sha256) {
      throw new Error("deployed script ownership is ambiguous");
    }
  }
  for (const [hostId, record] of Object.entries(state.hosts)) {
    if (record?.id !== hostId || record.launcher?.args?.[0] !== proxyPath) {
      throw new Error(`host ownership is invalid: ${hostId}`);
    }
    if (record.kind === "manual") continue;
    if (record.kind === "cli") {
      if (!await verifyCliRecord(record, options)) throw new Error(`host ownership is ambiguous: ${hostId}`);
      continue;
    }
    if (!record.configPath || !await exists(record.configPath)) {
      throw new Error(`host config is missing: ${hostId}`);
    }
    const source = await readFile(record.configPath, "utf8");
    if (!verifyOwnership(hostId, source, record.launcher, hostOptions(options, hostId, record.configPath)).owned) {
      throw new Error(`host ownership is ambiguous: ${hostId}`);
    }
  }
  return state;
}


function prepareFileContent(hostId, record, source, nextLauncher, options) {
  const settings = hostOptions(options, hostId, record?.configPath);
  if (!record) return transformConfig(hostId, source, nextLauncher, settings).content;
  if (!verifyOwnership(hostId, source, record.launcher, settings).owned) {
    throw new Error(`host ownership is ambiguous: ${hostId}`);
  }
  if (JSON.stringify(record.launcher) === JSON.stringify(nextLauncher)) return source;
  const removed = removeConfig(hostId, source, record.launcher, settings);
  return transformConfig(hostId, removed.content, nextLauncher, settings).content;
}

async function prepareHosts(hostIds, priorState, nextLauncher, options) {
  if (options.mcpConfigPath && hostIds.length !== 1) {
    throw new Error("--mcp-config requires exactly one selected host");
  }
  const plans = [];
  const filePaths = new Set();
  for (const hostId of hostIds) {
    const prior = priorState?.hosts?.[hostId];
    const settings = hostOptions(options, hostId, prior?.configPath, hostIds.length);
    const plan = createInstallPlan(hostId, nextLauncher, settings);
    if (plan.kind === "manual") {
      plans.push({ hostId, prior, plan, record: { id: hostId, kind: "manual", scope: plan.scope, launcher: nextLauncher, json: plan.json, toml: plan.toml } });
      continue;
    }
    if (plan.kind === "cli") {
      const existing = await runHostCommand(options, plan.command, ["mcp", "get", "potassium"]);
      if (!prior && commandOk(existing)) throw new Error(`${hostId} launcher already exists without proven ownership`);
      if (prior && !await verifyCliRecord(prior, options)) throw new Error(`host ownership is ambiguous: ${hostId}`);
      plans.push({ hostId, prior, plan, record: { id: hostId, kind: "cli", scope: plan.scope, command: plan.command, args: plan.args, launcher: nextLauncher } });
      continue;
    }
    const configPath = path.resolve(plan.path);
    if (filePaths.has(configPath)) throw new Error(`selected hosts resolve to the same config path: ${configPath}`);
    filePaths.add(configPath);
    await rejectLinkedPath(configPath);
    const before = await exists(configPath) ? await readFile(configPath, "utf8") : undefined;
    let content;
    try {
      content = prepareFileContent(hostId, prior, before ?? "", nextLauncher, options);
    } catch (error) {
      if (!prior && /unmanaged/.test(error.message)) {
        throw new Error(`${hostId} launcher already exists without proven ownership`);
      }
      throw error;
    }
    plans.push({
      hostId,
      prior,
      plan,
      configPath,
      before,
      content,
      changed: before !== content,
      record: {
        id: hostId,
        kind: plan.kind,
        scope: plan.scope,
        configPath,
        configCreated: prior?.configCreated === true || before === undefined,
        launcher: nextLauncher,
      },
    });
  }
  return plans;
}

async function restoreBackups(backups) {
  for (const [target, backup] of backups.slice().reverse()) {
    await rm(target, { recursive: true, force: true });
    if (backup && await exists(backup)) await rename(backup, target);
  }
}

export async function install(options = {}) {
  const value = installationPaths(options);
  const source = options.packageSource ?? `@mrketa/potassium-mcp@${packageMetadata.version}`;
  const hostIds = selectedHosts(options);
  const stage = `${value.appPath}.${randomBytes(8).toString("hex")}.staging`;
  const deployStatePath = path.join(value.installRoot, "deploy-state.json");
  const tokenPath = path.join(value.workspaceRoot, ".potassium-mcp-token");
  const backups = [];
  let scriptSnapshot = [];
  let deployStateSnapshot;
  let tokenSnapshot;
  let tokenChanged = false;
  let releaseLock = async () => {};
  const addedCli = [];
  let installRootExisted;
  const remember = async (target) => {
    if (await exists(target)) {
      const backup = `${target}.${randomBytes(8).toString("hex")}.backup`;
      await rename(target, backup);
      backups.push([target, backup]);
      return backup;
    }
    backups.push([target, null]);
    return undefined;
  };

  try {
    if (typeof source !== "string" || source.startsWith("-")) {
      throw new Error("package source must not begin with a dash");
    }
    releaseLock = await acquireInstallLock(value.installRoot);
    installRootExisted = await exists(value.installRoot);
    if (!await exists(value.workspaceRoot)) throw new Error(`workspace does not exist: ${value.workspaceRoot}`);
    await Promise.all([value.installRoot, value.workspaceRoot].map(rejectLinkedPath));

    let priorState = await readJson(value.statePath, null);
    if (priorState?.schema === 2) {
      priorState = await proveSchema2(priorState, value, options);
    } else if (priorState) {
      throw new Error("refusing repair: ownership state is invalid");
    }

    const managedPaths = [
      value.appPath,
      value.configPath,
      deployStatePath,
      value.statePath,
      tokenPath,
      ...expectedScriptPaths(value.workspaceRoot),
    ];
    if (!priorState && (await Promise.all(managedPaths.map(exists))).some(Boolean)) {
      throw new Error("refusing install: managed paths or launcher already exist without proven ownership");
    }

    await mkdir(stage, { recursive: true });
    await installRuntime(stage, source, options);
    const stagedRuntime = runtimePath(stage);
    for (const required of ["src/proxy.js", "src/broker.js", "assets/potassium_mcp_bootstrap.lua", "assets/potassium_mcp_autoexec.lua"]) {
      if (!await exists(path.join(stagedRuntime, required))) {
        throw new Error(`installed runtime is missing required file: ${required}`);
      }
    }

    const nextProxyPath = path.join(runtimePath(value.appPath), "src", "proxy.js");
    const nextLauncher = launcher(nextProxyPath, value.configPath, options.nodeExecutable);
    const hostPlans = await prepareHosts(hostIds, priorState, nextLauncher, options);

    tokenSnapshot = await exists(tokenPath) ? await readFile(tokenPath) : undefined;
    const currentToken = tokenSnapshot?.toString("utf8").trim() ?? "";
    if (currentToken.length < 32 || currentToken.length > 4096) {
      await writeProtectedAtomic(tokenPath, `${randomBytes(32).toString("hex")}\n`, options);
      tokenChanged = true;
    }
    await restrictTokenAcl(tokenPath, options.run ?? spawnSync);
    await mkdir(path.join(value.workspaceRoot, "potassium-mcp-artifacts"), { recursive: true });

    await mkdir(value.installRoot, { recursive: true });
    await remember(value.appPath);
    await rename(stage, value.appPath);
    const configBackup = await remember(value.configPath);
    await writeAtomic(value.configPath, runtimeConfig(value.workspaceRoot, tokenPath, options.allowUnsafeExecute === true));

    for (const hostPlan of hostPlans.filter(({ changed }) => changed)) {
      await options.beforeMcpCommit?.({ path: hostPlan.configPath, operation: "install", host: hostPlan.hostId });
      const current = await exists(hostPlan.configPath) ? await readFile(hostPlan.configPath, "utf8") : undefined;
      if (current !== hostPlan.before) throw new Error(`host config changed during installation: ${hostPlan.hostId}`);
      const backup = await remember(hostPlan.configPath);
      await writeProtectedAtomic(hostPlan.configPath, hostPlan.content, options, backup);
    }

    for (const hostPlan of hostPlans.filter((candidate) => candidate.plan.kind === "cli" && !candidate.prior)) {
      const result = await runHostCommand(options, hostPlan.plan.command, hostPlan.plan.args);
      if (!commandOk(result)) throw new Error(`${hostPlan.hostId} CLI installation failed`);
      addedCli.push(hostPlan);
    }

    const stateBackup = await remember(value.statePath);
    scriptSnapshot = await Promise.all([...expectedScriptPaths(value.workspaceRoot)].map(async (target) => ({
      target,
      content: await exists(target) ? await readFile(target) : undefined,
    })));
    deployStateSnapshot = await exists(deployStatePath) ? await readFile(deployStatePath) : undefined;
    const deployed = await deploy({
      scriptSourceRoot: path.join(runtimePath(value.appPath), "assets"),
      workspaceRoot: value.workspaceRoot,
      statePath: deployStatePath,
      compileProbe: options.compileProbe,
    });

    const nextState = priorState ?? {
      schema: 2,
      installRoot: value.installRoot,
      workspaceRoot: value.workspaceRoot,
      appPath: value.appPath,
      configPath: value.configPath,
      tokenPath,
      hosts: {},
    };
    nextState.schema = 2;
    nextState.hosts = { ...nextState.hosts };
    for (const hostPlan of hostPlans) nextState.hosts[hostPlan.hostId] = hostPlan.record;
    nextState.scripts = deployed.files.map(({ target, sha256 }) => ({ target, sha256 }));
    nextState.tokenSha256 = hash(await readFile(tokenPath));
    nextState.configSha256 = hash(await readFile(value.configPath));
    nextState.serverSha256 = hash(await readFile(nextProxyPath));
    await writeAtomic(value.statePath, nextState);

    const result = await doctor({
      installRoot: value.installRoot,
      workspaceRoot: value.workspaceRoot,
      configPath: value.configPath,
      packageRoot: runtimePath(value.appPath),
      hosts: Object.keys(nextState.hosts),
      cwd: options.cwd,
      env: options.env,
      verifyCliRegistration: options.verifyCliRegistration,
    });
    if (!result.ok) throw new Error("installation doctor failed");

    await Promise.all(backups.map(([, backup]) => backup
      && (options.remove ?? rm)(backup, { recursive: true, force: true }).catch(() => {})));
    await releaseLock().catch(() => {});
    return { ...value, hosts: Object.values(nextState.hosts), doctor: result };
  } catch (error) {
    for (const hostPlan of addedCli.reverse()) {
      await runHostCommand(options, hostPlan.plan.command, ["mcp", "remove", "potassium", "--scope", hostPlan.plan.scope]).catch?.(() => {});
    }
    await rm(stage, { recursive: true, force: true });
    await Promise.all(scriptSnapshot.map(async ({ target, content }) => {
      if (content === undefined) await rm(target, { force: true });
      else await writeAtomic(target, content);
    }));
    if (deployStateSnapshot === undefined) await rm(deployStatePath, { force: true });
    else await writeAtomic(deployStatePath, deployStateSnapshot);
    if (tokenChanged) {
      if (tokenSnapshot === undefined) await rm(tokenPath, { force: true });
      else await writeAtomic(tokenPath, tokenSnapshot);
    }
    await restoreBackups(backups);
    if (installRootExisted === false) {
      await rm(value.installRoot, { recursive: true, force: true });
    }
    await releaseLock().catch(() => {});
    throw error;
  }
}

export const repair = install;

function canDeleteCreatedConfig(hostId, source, record) {
  if (record.kind === "toml") return source.trim() === "";
  try {
    const config = JSON.parse(source);
    const key = hostId === "vscode" ? "servers" : "mcpServers";
    return Object.keys(config).every((name) => name === key)
      && config[key] && typeof config[key] === "object"
      && Object.keys(config[key]).length === 0;
  } catch {
    return false;
  }
}

export async function uninstall(options = {}) {
  const value = installationPaths(options);
  const releaseLock = await acquireInstallLock(value.installRoot);
  const backups = [];
  const removedCli = [];
  const remember = async (target) => {
    const parked = `${target}.${randomBytes(8).toString("hex")}.uninstall`;
    await rename(target, parked);
    backups.push([target, parked]);
    return parked;
  };
  try {
    let state = await readJson(value.statePath, null);
    try {
      state = await proveSchema2(state, value, options);
    } catch (error) {
      throw new Error(`refusing uninstall: installation ownership is ambiguous (${error.message})`);
    }
    const hostIds = options.all ? Object.keys(state.hosts) : selectedHosts(options);
    const filePlans = [];
    for (const hostId of hostIds) {
      const record = state.hosts[hostId];
      if (!record) throw new Error(`host is not owned: ${hostId}`);
      if (record.kind === "manual") continue;
      if (record.kind === "cli") continue;
      const before = await readFile(record.configPath, "utf8");
      const removed = removeConfig(
        hostId,
        before,
        record.launcher,
        hostOptions(options, hostId, record.configPath),
      );
      filePlans.push({
        hostId,
        record,
        before,
        content: removed.content,
        removeFile: record.configCreated === true && canDeleteCreatedConfig(hostId, removed.content, record),
      });
    }

    for (const plan of filePlans) {
      await options.beforeMcpCommit?.({ path: plan.record.configPath, operation: "uninstall", host: plan.hostId });
      if (await readFile(plan.record.configPath, "utf8") !== plan.before) {
        throw new Error(`host config changed during uninstall: ${plan.hostId}`);
      }
      const backup = await remember(plan.record.configPath);
      if (!plan.removeFile) await writeProtectedAtomic(plan.record.configPath, plan.content, options, backup);
    }

    for (const hostId of hostIds) {
      const record = state.hosts[hostId];
      if (record.kind !== "cli") continue;
      const result = await runHostCommand(options, record.command, ["mcp", "remove", "potassium", "--scope", record.scope]);
      if (!commandOk(result)) throw new Error(`${hostId} CLI removal failed`);
      removedCli.push(record);
    }

    const remainingHosts = { ...state.hosts };
    for (const hostId of hostIds) delete remainingHosts[hostId];
    if (Object.keys(remainingHosts).length > 0) {
      const stateBackup = await remember(value.statePath);
      await writeAtomic(value.statePath, { ...state, hosts: remainingHosts });
      await Promise.all(backups.map(([, backup]) => (options.remove ?? rm)(backup, { recursive: true, force: true }).catch(() => {})));
      return { uninstalled: true, hosts: hostIds, sharedRetained: true };
    }

    for (const target of [
      ...state.scripts.map(({ target }) => target),
      path.join(value.installRoot, "deploy-state.json"),
      value.configPath,
      value.appPath,
      value.statePath,
    ]) await remember(target);
    await Promise.all(backups.map(([, backup]) => (options.remove ?? rm)(backup, { recursive: true, force: true }).catch(() => {})));
    return { uninstalled: true, hosts: hostIds, sharedRetained: false };
  } catch (error) {
    await restoreBackups(backups);
    for (const record of removedCli.reverse()) {
      await runHostCommand(options, record.command, record.args).catch?.(() => {});
    }
    throw error;
  } finally {
    await releaseLock().catch(() => {});
  }
}

/** Stable, provider-neutral installer API shared by terminal and GUI callers. */
export const installer = Object.freeze({
  defaults,
  installationPaths,
  install,
  repair,
  uninstall,
});

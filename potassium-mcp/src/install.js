import { createHash, randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visit } from "jsonc-parser";
import { prepareDeployment } from "./deploy.js";
import { configSchema, parseConfig } from "./server.js";
import { createInstallPlan, launcherTimeout, removeConfig, supportsRuntime, transformConfig, verifyOwnership } from "./hosts.js";
import { cliRegistrationMatches } from "./doctor.js";
import { resolveInstallRoot, resolveConfigPath } from "./paths.js";
import { assertHostId, resolveHostPolicy } from "./host-policy.js";
import packageMetadata from "../package.json" with { type: "json" };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (target, fallback) => await exists(target) ? JSON.parse(await readFile(target, "utf8")) : fallback;
const encode = (value) => typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`;
export const EXECUTOR_REQUEST_TIMEOUT_MS = 30000;
export const MCP_LAUNCHER_TIMEOUT_MS = 40000;


function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function rejectLinkedPath(target) {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`refusing linked managed path: ${current}`);
      if (info.isFile() && info.nlink > 1) throw new Error(`refusing hard-linked managed file: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      break;
    }
  }
}

async function context(options = {}) {
  const selectedConfig = resolveConfigPath(options);
  const explicitConfig = options.configFile !== undefined || (options.env ?? process.env).POTASSIUM_MCP_CONFIG !== undefined;
  const installRoot = explicitConfig && options.installRoot === undefined
    ? path.dirname(selectedConfig) : resolveInstallRoot(options);
  const configPath = path.join(installRoot, "config.json");
  if (selectedConfig !== configPath) throw new Error("managed configuration must be install-root/config.json; conflicting config and install root");
  const statePath = path.join(installRoot, "ownership.json");
  const journalPath = `${installRoot}.transaction.json`;
  const { journal, bytes: journalBytes } = await readJournal(journalPath);
  await rejectLinkedPath(statePath);
  const stateBytes = await exists(statePath) ? await readFile(statePath) : undefined;
  let state;
  try { state = stateBytes === undefined ? null : JSON.parse(stateBytes); }
  catch { throw new Error("ownership state is invalid JSON; preserve it and recover verified backups"); }
  const configuredWorkspace = options.workspaceRoot ?? (options.env ?? process.env).POTASSIUM_WORKSPACE;
  if (configuredWorkspace === undefined && !state?.workspaceRoot && !journal?.workspaceRoot) throw new Error("workspace is required: run setup --workspace <existing Potassium workspace> --install-root <private directory>");
  if (options.workspaceRoot === undefined && configuredWorkspace !== undefined && !path.isAbsolute(configuredWorkspace)) throw new Error("POTASSIUM_WORKSPACE must be an absolute path");
  const workspaceRoot = configuredWorkspace === undefined ? state?.workspaceRoot ?? journal.workspaceRoot : path.resolve(options.cwd ?? process.cwd(), configuredWorkspace);
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("ownership workspace path is invalid");
  if (overlaps(installRoot, workspaceRoot) || overlaps(workspaceRoot, installRoot)) throw new Error("install root and workspace must not overlap");
  await Promise.all([installRoot, workspaceRoot].map(rejectLinkedPath));
  return { installRoot, workspaceRoot, configPath, statePath, state, stateBytes, journalPath, journal, journalBytes, plannedHosts: new Map(), snapshots: new Map([[statePath, stateBytes]]), appPath: path.join(installRoot, "app"), deployStatePath: path.join(installRoot, "deploy-state.json"), tokenPath: path.join(workspaceRoot, ".potassium-mcp-token") };
}

async function readJournal(target) {
  await rejectLinkedPath(target);
  if (!await exists(target)) return { journal: null, bytes: undefined };
  const handle = await open(target, "r");
  try {
    const limit = 1024 * 1024;
    const size = (await handle.stat()).size;
    if (size > limit) throw new Error("transaction journal exceeds its bounded size; preserve it for verified recovery");
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== size) throw new Error("transaction journal changed while it was being read");
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString("utf8");
    const objects = [];
    let invalid = false;
    visit(text, {
      onObjectBegin() {
        if (objects.length >= 64) throw new Error("transaction journal nesting exceeds its bounded schema");
        objects.push(new Set());
      },
      onObjectProperty(name) {
        const keys = objects.at(-1);
        if (!keys || keys.has(name)) invalid = true;
        keys?.add(name);
      },
      onObjectEnd() { objects.pop(); },
      onError() { invalid = true; },
    }, { disallowComments: true, allowTrailingComma: false });
    if (invalid) throw new Error("transaction journal is malformed or ambiguous; preserve it and all backups for verified recovery");
    let journal;
    try { journal = JSON.parse(text); } catch { throw new Error("transaction journal is malformed; preserve it and all backups for verified recovery"); }
    return { journal, bytes };
  } finally { await handle.close(); }
}

async function fileDigest(target) {
  await rejectLinkedPath(target);
  if (!await exists(target)) return null;
  if (!(await stat(target)).isFile()) throw new Error(`recovery conflict: expected an owned regular file at ${target}`);
  return hash(await readFile(target));
}

function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function recoveryPlan(value, options) {
  const journal = value.journal;
  const owner = journal?.owner;
  if (!journal || journal.schema !== 1 || journal.installRoot !== value.installRoot || journal.workspaceRoot !== value.workspaceRoot
    || !["applying", "committed", "rolled-back"].includes(journal.phase) || !owner || owner.hostname !== os.hostname()
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[a-f0-9]{32}$/.test(owner.nonce ?? "")
    || !Array.isArray(journal.entries) || journal.entries.length > 1024
    || !Array.isArray(journal.hosts) || journal.hosts.length > 1024
    || !Array.isArray(journal.cli) || journal.cli.length > 1024
    || typeof journal.brokerWasRunning !== "boolean") throw new Error("transaction journal ownership is malformed; no recovery paths are trusted");
  const baseline = journal.baseline;
  const scriptTargets = expectedScriptPaths(value.workspaceRoot);
  if (baseline !== null && (!baseline || ![2, 3].includes(baseline.schema)
    || baseline.installRoot !== value.installRoot || baseline.workspaceRoot !== value.workspaceRoot
    || baseline.configPath !== value.configPath || baseline.tokenPath !== value.tokenPath
    || !validDigest(journal.baselineSha256)
    || ![baseline.tokenSha256, baseline.configSha256, baseline.serverSha256].every(validDigest)
    || !Array.isArray(baseline.scripts) || baseline.scripts.length !== 2
    || new Set(baseline.scripts.map((entry) => entry?.target)).size !== 2
    || baseline.scripts.some((entry) => !scriptTargets.includes(entry?.target) || !validDigest(entry.sha256))
    || !baseline.hosts || typeof baseline.hosts !== "object" || Array.isArray(baseline.hosts))) throw new Error("transaction journal baseline ownership is invalid");
  if (baseline === null && journal.baselineSha256 !== null) throw new Error("fresh transaction journal claims an invalid baseline");
  const allowed = new Set([value.tokenPath, value.configPath, value.statePath, value.deployStatePath, ...scriptTargets]);
  const validateHost = async (record, legacy = false) => {
    if (!record || typeof record !== "object") throw new Error("transaction journal host ownership is invalid");
    assertHostId(record.id);
    const adapter = record.adapter ?? record.id;
    const runtime = legacy ? null : journal.runtime ?? baseline?.runtime;
    const entry = legacy
      ? path.join(value.appPath, "node_modules", "@mrketa", "potassium-mcp", "src", "proxy.js")
      : typeof runtime?.root === "string" ? path.join(runtime.root, "bin", "potassium-mcp.js") : "";
    const args = legacy ? [entry, "--config", value.configPath, "--host-id", record.id] : [entry, "serve", "--config", value.configPath, "--host-id", record.id];
    if (!path.isAbsolute(record.launcher?.command ?? "") || JSON.stringify(record.launcher?.args) !== JSON.stringify(args)
      || !Number.isSafeInteger(record.launcher.timeout) || record.launcher.timeout < MCP_LAUNCHER_TIMEOUT_MS || record.launcher.timeout > launcherTimeout(120000)) throw new Error("transaction journal launcher is not an owned public entry");
    const plan = createInstallPlan(adapter, record.launcher, hostSettings(record, options));
    if (plan.kind !== record.kind || plan.scope !== record.scope) throw new Error("transaction journal host adapter is invalid");
    if (record.kind === "cli") {
      if (record.command !== plan.command || JSON.stringify(record.args) !== JSON.stringify(plan.args)) throw new Error("transaction journal CLI command is not owned");
      if (record.scope === "local" && (!path.isAbsolute(record.cwd ?? "") || await realpath(record.cwd) !== record.cwd)) throw new Error("transaction journal local CLI project is unproven");
    } else if (record.kind !== "manual") {
      if (!path.isAbsolute(record.configPath ?? "") || overlaps(value.installRoot, record.configPath)
        || record.configPath === value.tokenPath || scriptTargets.includes(record.configPath) || plan.path !== record.configPath) throw new Error("transaction journal host target is not permitted");
      allowed.add(record.configPath);
    }
  };
  for (const record of Object.values(baseline?.hosts ?? {})) {
    const originalRuntime = journal.runtime;
    try { journal.runtime = baseline.runtime; await validateHost(record, baseline.schema === 2); }
    finally { journal.runtime = originalRuntime; }
  }
  for (const record of journal.hosts) await validateHost(record);
  for (const change of journal.cli) {
    if (!change || (!change.prior && !change.replacement)) throw new Error("transaction journal CLI undo is invalid");
    if (change.prior && JSON.stringify(change.prior) !== JSON.stringify(baseline?.hosts?.[change.prior.id])) throw new Error("transaction journal prior CLI registration is not owned");
    if (change.replacement) await validateHost(change.replacement);
    if (change.prior?.kind !== undefined && change.prior.kind !== "cli" || change.replacement?.kind !== undefined && change.replacement.kind !== "cli") throw new Error("transaction journal contains a non-CLI rollback command");
  }
  const seen = new Set();
  const operations = [];
  for (const [index, entry] of journal.entries.entries()) {
    if (!entry || typeof entry.target !== "string" || !allowed.has(entry.target) || seen.has(entry.target)
      || entry.beforeSha256 !== null && !validDigest(entry.beforeSha256)
      || entry.afterSha256 !== null && !validDigest(entry.afterSha256)
      || entry.backup !== (entry.beforeSha256 === null ? null : `${entry.target}.${owner.nonce}.${index}.backup`)) throw new Error("transaction journal target, backup, or hash is not permitted");
    seen.add(entry.target);
    const current = await fileDigest(entry.target);
    const backup = entry.backup === null ? null : await fileDigest(entry.backup);
    if (backup !== null && backup !== entry.beforeSha256) throw new Error(`recovery conflict: backup bytes changed at ${entry.backup}`);
    if (journal.phase === "committed" || journal.phase === "rolled-back") {
      const expected = journal.phase === "committed" ? entry.afterSha256 : entry.beforeSha256;
      if (current !== expected) throw new Error(`recovery conflict: completed target changed at ${entry.target}`);
      operations.push({ operation: backup === null ? "keep-original" : "cleanup-backup", path: entry.target, backup: entry.backup, current, backupHash: backup });
    } else if (entry.beforeSha256 === null) {
      if (current !== null && current !== entry.afterSha256) throw new Error(`recovery conflict: foreign bytes at ${entry.target}`);
      operations.push({ operation: current === null ? "keep-original" : "remove-interrupted-file", path: entry.target, backup: null, current, backupHash: null });
    } else if (backup === null && current === entry.beforeSha256) {
      operations.push({ operation: "keep-original", path: entry.target, backup: entry.backup, current, backupHash: null });
    } else if (backup === entry.beforeSha256 && (current === null || current === entry.afterSha256 || current === entry.beforeSha256)) {
      operations.push({ operation: "restore-backup", path: entry.target, backup: entry.backup, current, backupHash: backup });
    } else throw new Error(`recovery conflict: original or interrupted bytes cannot be proved at ${entry.target}`);
  }
  if (baseline !== null) {
    const stateEntry = journal.entries.find((entry) => entry.target === value.statePath);
    const candidates = [value.statePath, stateEntry?.backup].filter(Boolean);
    let proven = false;
    for (const candidate of candidates) {
      if (await fileDigest(candidate) === journal.baselineSha256
        && JSON.stringify(await readJson(candidate, null)) === JSON.stringify(baseline)) proven = true;
    }
    if (!proven && journal.phase !== "committed") throw new Error("recovery conflict: the original ownership record is unavailable or changed");
  }
  return operations;
}

async function recoveryOwner(value) {
  const lockPath = `${value.installRoot}.lock`;
  await rejectLinkedPath(lockPath);
  const bytes = await exists(lockPath) ? await readFile(lockPath) : null;
  let owner;
  if (bytes !== null) {
    try { owner = JSON.parse(bytes); } catch { throw new Error("recovery conflict: lock ownership is malformed"); }
    if (owner.installRoot !== value.installRoot || owner.pid !== value.journal.owner.pid
      || owner.hostname !== value.journal.owner.hostname || owner.nonce !== value.journal.owner.nonce) throw new Error("recovery conflict: transaction lock belongs to another owner");
  }
  let absent = false;
  try { process.kill(value.journal.owner.pid, 0); } catch (error) { absent = error.code === "ESRCH"; }
  if (!absent) throw new Error("transaction recovery refused: journal owner is live or its absence cannot be proved");
  return { lockPath, bytes };
}

async function recoverTransaction(value, options) {
  if (!value.journal) return null;
  const operations = await recoveryPlan(value, options);
  await recoveryOwner(value);
  if (options.dryRun) return { dryRun: true, recoveryRequired: true, operations: operations.map(({ operation, path: target, backup }) => ({ operation, path: target, backup })), conflicts: [], ...(value.journal.cli.length ? { verificationRequired: "exact CLI rollback ownership must be checked before recovery" } : {}) };
  const guardPath = `${value.installRoot}.lock.recovery`;
  await rejectLinkedPath(guardPath);
  let guard;
  try { guard = await open(guardPath, "wx", 0o600); } catch { throw new Error(`transaction recovery is already guarded; preserve ${guardPath}`); }
  const guardBytes = encode({ pid: process.pid, hostname: os.hostname(), nonce: randomBytes(16).toString("hex") });
  let recoveryLock;
  let recoveryLockBytes;
  try {
    await guard.writeFile(guardBytes);
    const currentJournal = await readJournal(value.journalPath);
    if (!currentJournal.bytes?.equals(value.journalBytes)) throw new Error("transaction journal changed before recovery");
    const owner = await recoveryOwner(value);
    if (owner.bytes === null) {
      recoveryLock = await open(owner.lockPath, "wx", 0o600);
      recoveryLockBytes = encode({ schema: 1, pid: process.pid, hostname: os.hostname(), installRoot: value.installRoot, nonce: randomBytes(16).toString("hex") });
      await recoveryLock.writeFile(recoveryLockBytes);
    }
    const checked = await recoveryPlan(value, options);
    if (value.journal.phase === "applying") {
      for (const change of [...value.journal.cli].reverse()) await restoreCliRegistration(change.replacement, change.prior, options);
    }
    for (const operation of checked.reverse()) {
      if (await fileDigest(operation.path) !== operation.current
        || operation.backup && await fileDigest(operation.backup) !== operation.backupHash) throw new Error(`recovery conflict: files changed before restoring ${operation.path}`);
      if (operation.operation === "restore-backup") {
        if (operation.current !== null) await rm(operation.path);
        await rename(operation.backup, operation.path);
      } else if (operation.operation === "remove-interrupted-file") await rm(operation.path);
      else if (operation.operation === "cleanup-backup") await rm(operation.backup);
    }
    if (!(await readJournal(value.journalPath)).bytes?.equals(value.journalBytes)) throw new Error("transaction journal changed during recovery");
    await rm(value.journalPath);
    if (owner.bytes !== null && await exists(owner.lockPath) && (await readFile(owner.lockPath)).equals(owner.bytes)) await rm(owner.lockPath);
    return { recovered: true, operations, restartRequired: value.journal.brokerWasRunning };
  } finally {
    if (recoveryLock) {
      await recoveryLock.close();
      const lockPath = `${value.installRoot}.lock`;
      if (await exists(lockPath) && await readFile(lockPath, "utf8") === recoveryLockBytes) await rm(lockPath);
    }
    await guard.close();
    if (await exists(guardPath) && await readFile(guardPath, "utf8") === guardBytes) await rm(guardPath);
  }
}

async function snapshot(value, target) {
  const bytes = await readFile(target);
  value.snapshots.set(target, bytes);
  return bytes;
}

export async function restrictTokenAcl(tokenPath, run = spawnSync) {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) throw new Error("USERNAME is required to secure the token file");
  const result = run("icacls", [tokenPath, "/inheritance:r", "/grant:r", `${user}:F`], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Unable to restrict token-file ACL");
}

async function applyFileAcl(target, source, options) {
  if (source && options.copyAcl) return options.copyAcl({ source, target });
  if (process.platform !== "win32") return;
  if (!source) return restrictTokenAcl(target, options.run ?? spawnSync);
  const command = "$acl = Get-Acl -LiteralPath $env:POTASSIUM_ACL_SOURCE; Set-Acl -LiteralPath $env:POTASSIUM_ACL_TARGET -AclObject $acl";
  const result = (options.run ?? spawnSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, POTASSIUM_ACL_SOURCE: source, POTASSIUM_ACL_TARGET: target },
  });
  if (result.error || result.status !== 0) throw new Error("Unable to preserve MCP-config ACL");
}

async function writeProtectedAtomic(target, value, options = {}, aclSource) {
  const staged = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(staged, "", { mode: 0o600, flag: "wx" });
    if (aclSource && process.platform !== "win32") await chmod(staged, (await stat(aclSource)).mode & 0o777);
    await applyFileAcl(staged, aclSource, options);
    await writeFile(staged, encode(value));
    if (options.durable) {
      const handle = await open(staged, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await rename(staged, target);
  } finally { await rm(staged, { force: true }); }
}

export async function acquireInstallLock(value, options = {}) {
  if (typeof value.installRoot !== "string" || !path.isAbsolute(value.installRoot)) throw new Error("install lock requires an absolute private root");
  const lockPath = `${value.installRoot}.lock`;
  await rejectLinkedPath(lockPath);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const owner = { schema: 1, pid: process.pid, hostname: os.hostname(), installRoot: value.installRoot, nonce: randomBytes(16).toString("hex") };
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (options.recover === false) throw new Error("installation is locked; retry after its owner completes or run verified repair");
    const guardPath = `${lockPath}.recovery`;
    await rejectLinkedPath(guardPath);
    let guard;
    try { guard = await open(guardPath, "wx", 0o600); }
    catch { throw new Error(`another Potassium MCP operation is recovering ${lockPath}; preserve its recovery guard`); }
    const guardBytes = encode(owner);
    try {
      await guard.writeFile(guardBytes);
      // Every reclaimer must reread and prove the owner under this exclusive guard.
      const before = await readFile(lockPath);
      let prior;
      try { prior = JSON.parse(before); } catch { throw new Error(`another Potassium MCP operation holds ${lockPath}; lock owner cannot be verified`); }
      if (prior.schema !== 1 || prior.hostname !== owner.hostname || prior.installRoot !== value.installRoot || !Number.isSafeInteger(prior.pid) || prior.pid < 1 || !/^[a-f0-9]{32}$/.test(prior.nonce ?? "")) throw new Error(`another Potassium MCP operation holds ${lockPath}; lock owner cannot be verified`);
      let absent = false;
      try { process.kill(prior.pid, 0); } catch (probe) { absent = probe.code === "ESRCH"; }
      if (!absent) throw new Error(`another Potassium MCP operation holds ${lockPath}; owner is live or its absence cannot be proved`);
      if (!value.state || !(await readFile(value.statePath)).equals(value.stateBytes)
        || hash(await readFile(value.configPath)) !== value.state.configSha256) throw new Error(`orphan lock requires verified intact ownership; preserve ${lockPath} and transaction backups`);
      await options.beforeLockRecovery?.({ lockPath, guardPath });
      if (!(await readFile(lockPath)).equals(before)) throw new Error("operation lock changed during recovery");
      const parked = `${lockPath}.${owner.nonce}.orphan`;
      await rename(lockPath, parked);
      try { handle = await open(lockPath, "wx", 0o600); }
      finally { await rm(parked, { force: true }); }
    } finally {
      await guard.close();
      if (await exists(guardPath) && await readFile(guardPath, "utf8") === guardBytes) await rm(guardPath);
    }
  }
  const bytes = encode(owner);
  try { await handle.writeFile(bytes); }
  catch (error) { await handle.close(); await rm(lockPath, { force: true }); throw error; }
  const release = async () => {
    await handle.close();
    if (await exists(lockPath) && (await readFile(lockPath, "utf8")) === bytes) await rm(lockPath);
  };
  release.lease = Object.freeze(owner);
  return release;
}

async function verifyHeldInstallOwner(lease) {
  if (!lease || lease.schema !== 1 || typeof lease.installRoot !== "string" || !path.isAbsolute(lease.installRoot)
    || lease.hostname !== os.hostname() || !Number.isSafeInteger(lease.pid) || lease.pid < 1
    || !/^[a-f0-9]{32}$/.test(lease.nonce ?? "")) throw new Error("internal install lease is invalid");
  const lockPath = `${lease.installRoot}.lock`;
  await rejectLinkedPath(lockPath);
  const held = await readJson(lockPath, null);
  if (held?.schema !== 1 || held.installRoot !== lease.installRoot || held.pid !== lease.pid || held.hostname !== lease.hostname || held.nonce !== lease.nonce) throw new Error("internal install lease is no longer held by its exact owner");
  try { process.kill(lease.pid, 0); } catch { throw new Error("internal install lease owner is not verifiably live"); }
}

/** Internal broker child lease; never accept it as a public CLI argument. */
export async function verifyInstallLease(lease, { requireCommittedJournal = false } = {}) {
  await verifyHeldInstallOwner(lease);
  const { journal } = await readJournal(`${lease.installRoot}.transaction.json`);
  if (journal && !["committed", "rolled-back"].includes(journal.phase)) throw new Error("broker startup is blocked by an applying installer transaction");
  if (requireCommittedJournal && (!journal || journal.schema !== 1 || journal.phase !== "committed"
    || journal.installRoot !== lease.installRoot || journal.owner?.pid !== lease.pid
    || journal.owner?.hostname !== lease.hostname || journal.owner?.nonce !== lease.nonce)) throw new Error("internal broker startup requires the exact owner's committed installer journal");
  return true;
}

/** Authenticate only an old owned broker while a validated config edit is being repaired. */
export async function readRepairDrainCredentials(configFile, lease, repairContext) {
  await verifyHeldInstallOwner(lease);
  const keys = ["configSha256", "ownedConfigSha256", "tokenSha256"];
  if (configFile !== path.join(lease.installRoot, "config.json") || !repairContext || typeof repairContext !== "object"
    || Object.keys(repairContext).length !== keys.length || !keys.every((key) => validDigest(repairContext[key]))) throw new Error("validated repair drain context is invalid");
  const { journal } = await readJournal(`${lease.installRoot}.transaction.json`);
  if (journal?.schema !== 1 || journal.phase !== "applying" || journal.installRoot !== lease.installRoot
    || journal.owner?.pid !== lease.pid || journal.owner?.hostname !== lease.hostname || journal.owner?.nonce !== lease.nonce
    || !keys.every((key) => journal.repairContext?.[key] === repairContext[key])
    || journal.baseline?.schema !== 3 || journal.baseline.status !== "active"
    || journal.baseline.configSha256 !== repairContext.ownedConfigSha256
    || journal.baseline.tokenSha256 !== repairContext.tokenSha256
    || !Array.isArray(journal.entries) || journal.entries.length !== 0 || !Array.isArray(journal.cli) || journal.cli.length !== 0) throw new Error("validated repair drain is not bound to an unchanged applying transaction");
  const statePath = path.join(lease.installRoot, "ownership.json");
  await Promise.all([configFile, statePath].map(rejectLinkedPath));
  const stateBytes = await readFile(statePath);
  if (hash(stateBytes) !== journal.baselineSha256) throw new Error("ownership changed before validated repair drain");
  const state = JSON.parse(stateBytes);
  if (state.installRoot !== lease.installRoot || state.configPath !== configFile || state.configSha256 !== repairContext.ownedConfigSha256
    || typeof state.workspaceRoot !== "string" || !path.isAbsolute(state.workspaceRoot)
    || state.tokenPath !== path.join(state.workspaceRoot, ".potassium-mcp-token") || state.tokenSha256 !== repairContext.tokenSha256) throw new Error("validated repair drain ownership differs from its baseline");
  const bytes = await readFile(configFile);
  if (hash(bytes) !== repairContext.configSha256) throw new Error("configuration changed after repair preflight; refusing broker drain");
  const config = configSchema.safeParse(JSON.parse(bytes));
  if (!config.success || config.data.token !== undefined || typeof config.data.tokenFile !== "string"
    || path.resolve(path.dirname(configFile), config.data.tokenFile) !== state.tokenPath) throw new Error("configuration is no longer the validated owned repair input");
  await rejectLinkedPath(state.tokenPath);
  const tokenBytes = await readFile(state.tokenPath);
  const token = tokenBytes.toString("utf8").trim();
  if (hash(tokenBytes) !== repairContext.tokenSha256 || token.length < 32 || token.length > 4096) throw new Error("credential changed after repair preflight; refusing broker drain");
  return { token, proxyMaxFrameBytes: config.data.proxyMaxFrameBytes };
}

/** Narrow read-only proof for legacy effective-policy preservation in loadConfig. */
export async function isOwnedLegacyConfig(configFile, rawConfigBytes) {
  if (typeof configFile !== "string" || !path.isAbsolute(configFile)) throw new Error("configuration ownership proof requires an absolute config path");
  const installRoot = path.dirname(configFile);
  const statePath = path.join(installRoot, "ownership.json");
  try { await lstat(statePath); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error("MCP ownership metadata cannot be inspected; refusing an unowned-policy fallback", { cause: error });
  }
  try {
    await Promise.all([configFile, statePath].map(rejectLinkedPath));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (![2, 3].includes(state?.schema) || configFile !== path.join(installRoot, "config.json")
      || state.installRoot !== installRoot || state.configPath !== configFile
      || typeof state.workspaceRoot !== "string" || !path.isAbsolute(state.workspaceRoot)
      || overlaps(installRoot, state.workspaceRoot) || overlaps(state.workspaceRoot, installRoot)
      || state.tokenPath !== path.join(state.workspaceRoot, ".potassium-mcp-token")
      || ![state.configSha256, state.tokenSha256, state.serverSha256].every(validDigest)
      || hash(rawConfigBytes) !== state.configSha256
      || !state.hosts || typeof state.hosts !== "object" || Array.isArray(state.hosts)
      || !Array.isArray(state.scripts) || state.scripts.length !== 2
      || new Set(state.scripts.map((entry) => entry?.target)).size !== 2
      || state.scripts.some((entry) => !expectedScriptPaths(state.workspaceRoot).includes(entry?.target) || !validDigest(entry.sha256))) throw new Error("ownership paths, schema, or hashes differ");
    if (state.schema === 2 && state.appPath !== path.join(installRoot, "app")) throw new Error("legacy runtime path differs");
    if (state.schema === 3 && (!["active", "retained"].includes(state.status) || state.runtime?.mode !== "external"
      || !path.isAbsolute(state.runtime.root ?? "") || !path.isAbsolute(state.runtime.nodeExecutable ?? "") || !validDigest(state.runtime.nodeSha256))) throw new Error("external runtime identity is invalid");
    const config = JSON.parse(rawConfigBytes);
    if (config.token !== undefined || typeof config.tokenFile !== "string"
      || path.resolve(installRoot, config.tokenFile) !== state.tokenPath) throw new Error("configuration credential is not the owned workspace token");
    await rejectLinkedPath(state.tokenPath);
    if (hash(await readFile(state.tokenPath)) !== state.tokenSha256) throw new Error("owned token bytes differ");
    return state.schema === 2;
  } catch (error) {
    throw new Error("MCP configuration conflicts with existing ownership.json; run verified repair instead of falling back to manual policy", { cause: error });
  }
}

function expectedScriptPaths(workspaceRoot) {
  return [path.join(workspaceRoot, ".potassium-mcp-bootstrap.lua"), path.join(workspaceRoot, "..", "autoexec", "potassium_mcp_autoexec.lua")];
}

export function launcher(entryPath, configPath, nodeExecutable = process.execPath, hostId, requestTimeoutMs = EXECUTOR_REQUEST_TIMEOUT_MS) {
  assertHostId(hostId);
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(entryPath) || !path.isAbsolute(configPath)) throw new Error("launcher paths must be absolute");
  return { type: "stdio", command: nodeExecutable, args: [entryPath, "serve", "--config", configPath, "--host-id", hostId], timeout: launcherTimeout(requestTimeoutMs) };
}

async function runtimeIdentity(root, nodeExecutable, value) {
  if (!path.isAbsolute(nodeExecutable)) throw new Error("Node executable must be an absolute path");
  const canonicalRoot = await realpath(root);
  const node = await realpath(nodeExecutable);
  if (!(await stat(node)).isFile()) throw new Error("Node executable must be a regular file");
  if (overlaps(canonicalRoot, value.installRoot) || overlaps(value.installRoot, canonicalRoot)
    || overlaps(canonicalRoot, value.workspaceRoot) || overlaps(value.workspaceRoot, canonicalRoot)) throw new Error("external package root must not overlap private setup or workspace paths");
  const metadata = await readJson(path.join(canonicalRoot, "package.json"), null);
  if (metadata?.name !== "@mrketa/potassium-mcp" || typeof metadata.version !== "string") throw new Error("external runtime is not the Potassium MCP package");
  if (!supportsRuntime(metadata)) throw new Error("external runtime is incompatible with public serve and schema-3 setup; install a package declaring potassiumMcpRuntime ownershipSchema 3 and launcherProtocol 1");
  for (const required of ["bin/potassium-mcp.js", "src/proxy.js", "src/broker.js", "assets/potassium_mcp_bootstrap.lua", "assets/potassium_mcp_autoexec.lua"]) {
    if (!await exists(path.join(canonicalRoot, required)) || !(await stat(path.join(canonicalRoot, required))).isFile()) throw new Error(`external runtime is missing required file: ${required}; install the npm package first`);
    if (await realpath(path.join(canonicalRoot, required)) !== path.join(canonicalRoot, required)) throw new Error(`external runtime entry is redirected: ${required}`);
  }
  return { mode: "external", root: canonicalRoot, nodeExecutable: node, nodeSha256: hash(await readFile(node)) };
}

const hostSettings = (record, options = {}) => ({ cwd: record.cwd ?? options.cwd, env: options.env, scope: record.scope, configPath: record.configPath });
const commandOk = (result) => !result?.error && (result?.status === undefined || result.status === 0);
async function runHostCommand(options, command, args, cwd = options.cwd ?? process.cwd()) {
  return options.runCommand ? options.runCommand(command, args, { cwd }) : spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
}
async function verifyCliRecord(record, options) {
  if (options.verifyCliRegistration) return await options.verifyCliRegistration(record) === true;
  const result = await runHostCommand(options, record.command, ["mcp", "get", "potassium"], record.cwd);
  return commandOk(result) && cliRegistrationMatches(result, record.launcher, record.scope);
}

function cliRegistrationAbsent(result) {
  return !result?.error && result?.status === 1
    && `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() === "No MCP server found with name: potassium";
}

async function matchesCliResult(result, record, options) {
  return commandOk(result) && (options.verifyCliRegistration
    ? await options.verifyCliRegistration(record) === true
    : cliRegistrationMatches(result, record.launcher, record.scope));
}

async function restoreCliRegistration(replacement, prior, options) {
  const record = replacement ?? prior;
  const current = await runHostCommand(options, record.command, ["mcp", "get", "potassium"], record.cwd);
  if (prior && await matchesCliResult(current, prior, options)) return;
  if (replacement && await matchesCliResult(current, replacement, options)) {
    const removed = await runHostCommand(options, replacement.command, ["mcp", "remove", "potassium", "--scope", replacement.scope], replacement.cwd);
    if (!commandOk(removed)) throw new Error(`${record.id} CLI rollback removal failed`);
  } else if (!cliRegistrationAbsent(current)) {
    throw new Error(`${record.id} CLI rollback ownership is ambiguous; preserve the current registration`);
  }
  if (prior) {
    if (!commandOk(await runHostCommand(options, prior.command, prior.args, prior.cwd))) throw new Error(`${prior.id} CLI rollback restore failed`);
    if (!await verifyCliRecord(prior, options)) throw new Error(`${prior.id} CLI rollback restore was not confirmed`);
  }
}

async function proveHosts(state, value, options, legacy, config) {
  const identities = new Set();
  for (const [id, record] of Object.entries(state.hosts)) {
    assertHostId(id);
    if (!record || record.id !== id) throw new Error(`host ownership is invalid: ${id}`);
    if (!options.allowConfigChanges) resolveHostPolicy(id, config.hostPolicies);
    const adapter = legacy ? id : record.adapter;
    const expectedEntry = legacy ? path.join(value.appPath, "node_modules", "@mrketa", "potassium-mcp", "src", "proxy.js") : path.join(state.runtime.root, "bin", "potassium-mcp.js");
    const expectedArgs = legacy ? [expectedEntry, "--config", value.configPath, "--host-id", id] : [expectedEntry, "serve", "--config", value.configPath, "--host-id", id];
    if (JSON.stringify(record.launcher?.args) !== JSON.stringify(expectedArgs)
      || !path.isAbsolute(record.launcher?.command ?? "") || record.launcher.type !== "stdio"
      || (legacy ? record.launcher.timeout !== MCP_LAUNCHER_TIMEOUT_MS
        : options.allowConfigChanges
          ? !Number.isSafeInteger(record.launcher.timeout) || record.launcher.timeout < MCP_LAUNCHER_TIMEOUT_MS || record.launcher.timeout > launcherTimeout(120000)
          : record.launcher.timeout !== launcherTimeout(config.requestTimeoutMs))
      || (!legacy && record.launcher.command !== state.runtime.nodeExecutable)) throw new Error(`user-managed or modified host launcher is a migration conflict: ${id}; preserve its wrapper and configuration`);
    const plan = createInstallPlan(adapter, record.launcher, hostSettings(record, options));
    if (plan.kind !== record.kind || plan.scope !== record.scope) throw new Error(`host adapter ownership is invalid: ${id}`);
    if (record.kind === "manual") continue;
    if (record.kind === "cli") {
      if (record.scope === "local") {
        if (!path.isAbsolute(record.cwd ?? "") || await realpath(record.cwd) !== record.cwd || !(await stat(record.cwd)).isDirectory()) throw new Error(`local host project ownership is unproven: ${id}; explicit verified migration is required`);
      } else if (record.cwd !== undefined) throw new Error(`unexpected project binding on global host: ${id}`);
      const identity = `cli:${record.command}:${record.scope}:${record.cwd ?? ""}`;
      if (identities.has(identity)) throw new Error("multiple host identities claim the same host CLI scope");
      identities.add(identity);
      if (record.command !== plan.command || JSON.stringify(record.args) !== JSON.stringify(plan.args)) throw new Error(`host CLI ownership is invalid: ${id}`);
      if (options.dryRun !== true && !await verifyCliRecord(record, options)) throw new Error(`host ownership is ambiguous: ${id}`);
      continue;
    }
    if (!path.isAbsolute(record.configPath ?? "") || overlaps(value.installRoot, record.configPath) || plan.path !== record.configPath) throw new Error(`host configuration ownership is invalid: ${id}`);
    if (identities.has(record.configPath)) throw new Error("multiple host identities claim the same host configuration");
    identities.add(record.configPath);
    await rejectLinkedPath(record.configPath);
    const source = (await snapshot(value, record.configPath)).toString("utf8");
    if (!verifyOwnership(adapter, source, record.launcher, hostSettings(record, options)).owned) throw new Error(`host ownership is ambiguous: ${id}; user-managed wrappers must be preserved, not adopted or overwritten`);
  }
}

async function proveState(value, options = {}) {
  if (value.journal) throw new Error(`interrupted transaction requires repair; preserve ${value.journalPath} and its verified backups`);
  const state = value.state;
  const targets = expectedScriptPaths(value.workspaceRoot);
  if (!state || ![2, 3].includes(state.schema) || state.installRoot !== value.installRoot || state.workspaceRoot !== value.workspaceRoot
    || state.configPath !== value.configPath || state.tokenPath !== value.tokenPath || !state.hosts || typeof state.hosts !== "object" || Array.isArray(state.hosts)
    || ![state.tokenSha256, state.configSha256, state.serverSha256].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
    || !Array.isArray(state.scripts) || state.scripts.length !== 2 || new Set(state.scripts.map((script) => script.target)).size !== 2
    || state.scripts.some((script) => !targets.includes(script.target) || !/^[a-f0-9]{64}$/.test(script.sha256))) throw new Error("ownership state is invalid; schema-1 or unknown layouts require explicit verified recovery");
  if (state.schema === 2 && state.appPath !== value.appPath) throw new Error("legacy runtime ownership is invalid");
  if (state.schema === 3 && !["active", "retained"].includes(state.status)) throw new Error("ownership setup status is invalid");
  await Promise.all([value.configPath, value.tokenPath, value.deployStatePath, ...targets].map(rejectLinkedPath));
  const token = await snapshot(value, value.tokenPath);
  if (hash(token) !== state.tokenSha256 || token.toString("utf8").trim().length < 32 || token.toString("utf8").trim().length > 4096) throw new Error("token ownership is ambiguous");
  const configBytes = await snapshot(value, value.configPath);
  if (hash(configBytes) !== state.configSha256 && (options.allowConfigChanges !== true || state.schema !== 3 || state.status !== "active")) throw new Error("runtime config ownership is ambiguous");
  let config;
  try { config = JSON.parse(configBytes); } catch { throw new Error("runtime configuration is invalid JSON; refusing to reset user settings"); }
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error(`runtime configuration is invalid; refusing to reset user settings: ${parsed.error.message}`);
  if (config.token !== undefined || typeof config.tokenFile !== "string" || path.resolve(path.dirname(value.configPath), config.tokenFile) !== value.tokenPath) throw new Error("runtime config token path is not owned");
  await parseConfig(config, path.dirname(value.configPath));
  if (state.status === "retained") {
    if (Object.keys(state.hosts).length || (await Promise.all([...targets, value.deployStatePath].map(exists))).some(Boolean)) throw new Error("retained setup conflicts with unexpected deployment or host records");
    if (state.runtime?.mode !== "external" || !path.isAbsolute(state.runtime.root ?? "") || !path.isAbsolute(state.runtime.nodeExecutable ?? "") || !/^[a-f0-9]{64}$/.test(state.runtime.nodeSha256 ?? "")) throw new Error("retained runtime ownership is invalid");
    return { state, config, configBytes, classification: "retained" };
  }
  for (const script of state.scripts) if (hash(await snapshot(value, script.target)) !== script.sha256) throw new Error("deployed script ownership is ambiguous");
  const deployState = JSON.parse(await snapshot(value, value.deployStatePath));
  if (deployState?.schema !== 3 || !Array.isArray(deployState.files) || deployState.files.length !== 2
    || new Set(deployState.files.map((file) => file.target)).size !== 2
    || deployState.files.some((file) => !state.scripts.some((script) => script.target === file.target && script.sha256 === file.sha256))) throw new Error("deployment state ownership is ambiguous");
  let classification = "external";
  if (state.schema === 2) {
    const legacyRoot = path.join(value.appPath, "node_modules", "@mrketa", "potassium-mcp");
    await rejectLinkedPath(path.dirname(legacyRoot));
    const linked = (await lstat(legacyRoot)).isSymbolicLink();
    classification = linked ? "junction" : "copy";
    if (linked && options.runtimeRoot === undefined) throw new Error("legacy junction runtime requires explicit --runtime-root migration; link and repository target remain untouched");
    const canonical = await realpath(legacyRoot);
    const proxy = path.join(legacyRoot, "src", "proxy.js");
    if (await realpath(proxy) !== path.join(canonical, "src", "proxy.js") || hash(await readFile(proxy)) !== state.serverSha256) throw new Error("legacy runtime ownership is ambiguous");
  } else {
    if (state.runtime?.mode !== "external" || !path.isAbsolute(state.runtime.root ?? "") || !path.isAbsolute(state.runtime.nodeExecutable ?? "") || !/^[a-f0-9]{64}$/.test(state.runtime.nodeSha256 ?? "")) throw new Error("external runtime ownership is invalid");
    for (const identityPath of [state.runtime.root, state.runtime.nodeExecutable]) {
      if (options.allowRuntimeChanges && !await exists(identityPath)) continue;
      if (await realpath(identityPath) !== identityPath) throw new Error("external runtime identity is redirected");
    }
    if (!options.allowRuntimeChanges && (hash(await readFile(path.join(state.runtime.root, "src", "proxy.js"))) !== state.serverSha256
      || hash(await readFile(state.runtime.nodeExecutable)) !== state.runtime.nodeSha256)) throw new Error("runtime version or Node identity changed; run setup to verify the installed package before starting it");
  }
  await proveHosts(state, value, options, state.schema === 2, config);
  return { state, config, configBytes, classification };
}

function initialConfig(value, initialFullAccessHost) {
  return { host: "127.0.0.1", port: 32145, proxyHost: "127.0.0.1", proxyPort: 32146, proxyMaxFrameBytes: 1048576, proxyHandshakeTimeoutMs: 5000,
    streamableHttpEnabled: false, streamableHttpHost: "127.0.0.1", streamableHttpPort: 32147, tokenFile: value.tokenPath,
    requestTimeoutMs: EXECUTOR_REQUEST_TIMEOUT_MS, maxMessageBytes: 1048576, maxPendingRequests: 64, shutdownGraceMs: 5000, allowUnsafeExecute: initialFullAccessHost !== undefined,
    adminAuditPath: path.join(value.workspaceRoot, "potassium-mcp-admin-audit.ndjson"), artifactRoots: [{ name: "artifacts", path: path.join(value.workspaceRoot, "potassium-mcp-artifacts"), recursive: true, extensions: [".json", ".ndjson", ".txt", ".log"] }],
    sourceRoots: [{ name: "sources", path: path.join(value.workspaceRoot, "potassium-mcp-sources"), recursive: true, extensions: [".lua", ".luau"] }],
    httpAllowedHosts: ["apis.roblox.com", "games.roblox.com", "thumbnails.roblox.com", "users.roblox.com"],
    hostPolicies: initialFullAccessHost === undefined ? {} : { [initialFullAccessHost]: { read: true, admin: true, execute: true } },
    httpPolicy: { read: true, admin: false, execute: false }, statefulHttpEnabled: false, builtinFallbackEnabled: false };
}

function overlayConfig(previous, options, value) {
  const config = structuredClone(previous);
  for (const key of ["allowUnsafeExecute", "streamableHttpEnabled", "streamableHttpPort", "statefulHttpEnabled", "builtinFallbackEnabled", "httpPolicy"]) {
    if (options[key] !== undefined) config[key] = options[key];
  }
  if (options.streamableHttpPort !== undefined && !config.streamableHttpEnabled) throw new Error("--streamable-http-port requires --streamable-http");
  if (options.builtinFallbackTokenFile !== undefined) {
    config.builtinFallbackTokenFile = path.resolve(options.cwd ?? process.cwd(), options.builtinFallbackTokenFile);
    config.builtinFallbackEnabled = options.builtinFallbackEnabled !== false;
  }
  if (options.builtinFallbackEnabled === false) delete config.builtinFallbackTokenFile;
  for (const [option, axis] of [["httpRead", "read"], ["httpAdmin", "admin"], ["httpExecute", "execute"]]) {
    if (options[option] !== undefined) config.httpPolicy = { ...(config.httpPolicy ?? { read: true, admin: false, execute: false }), [axis]: options[option] };
  }
  if (options.readHost?.some((id) => options.denyReadHost?.includes(id))) throw new Error("a host ID cannot be both --read-host and --deny-read-host");
  for (const [option, axis, enabled] of [["readHost", "read", true], ["adminHost", "admin", true], ["executeHost", "execute", true], ["denyReadHost", "read", false]]) {
    if (options[option] === undefined) continue;
    if (!Array.isArray(options[option])) throw new Error(`${option} must be an array of normalized host IDs`);
    config.hostPolicies ??= {};
    for (const id of options[option]) {
      assertHostId(id);
      config.hostPolicies[id] = { ...(config.hostPolicies[id] ?? { read: true, admin: false, execute: false }), [axis]: enabled };
    }
  }
  if ((options.executeHost?.length || options.httpExecute === true || options.httpPolicy?.execute === true) && config.allowUnsafeExecute !== true) throw new Error("execute grants require allowUnsafeExecute");
  const checked = configSchema.safeParse(config);
  if (!checked.success) throw new Error(`runtime configuration is invalid; refusing to reset user settings: ${checked.error.message}`);
  if (path.resolve(path.dirname(value.configPath), config.tokenFile) !== value.tokenPath) throw new Error("runtime config token path is not owned");
  return config;
}

async function verifyFallback(config, value) {
  if (!config.builtinFallbackEnabled) return;
  const fallback = path.resolve(path.dirname(value.configPath), config.builtinFallbackTokenFile);
  await rejectLinkedPath(fallback);
  if (!await exists(fallback)) throw new Error("built-in fallback token file does not exist");
  const content = await readFile(fallback);
  if (fallback === value.tokenPath || (await exists(value.tokenPath) && hash(content) === hash(await readFile(value.tokenPath)))) throw new Error("built-in fallback token must be distinct from the custom broker token");
  if (content.toString("utf8").trim().length < 32 || content.toString("utf8").trim().length > 4096) throw new Error("built-in fallback token must contain between 32 and 4096 characters");
}

async function brokerLifecycle(options) { return options.brokerLifecycle ?? import("./broker.js"); }
async function brokerRunning(value, options) {
  const status = await (await brokerLifecycle(options)).brokerStatus({ ...options, installRoot: value.installRoot });
  if (["absent", "stopped"].includes(status.status)) return false;
  if (status.status === "running") return true;
  throw new Error(`broker is ${status.status}; resolve broker ownership before changing setup`);
}

async function transaction(value, options, action) {
  const release = await acquireInstallLock(value, options);
  const owner = await readJson(`${value.installRoot}.lock`, null);
  const journal = {
    schema: 1, installRoot: value.installRoot, workspaceRoot: value.workspaceRoot, owner,
    baseline: value.state, baselineSha256: value.stateBytes === undefined ? null : hash(value.stateBytes),
    runtime: value.nextRuntime ?? value.state?.runtime ?? null,
    phase: "applying", brokerWasRunning: false,
    repairContext: value.repairContext ?? null,
    hosts: [...value.plannedHosts.values()], entries: [], cli: [],
  };
  const backups = [];
  const touched = new Set();
  const roots = [];
  let stopped = false;
  let running = false;
  let restartAttempted = false;
  let commitPublished = false;
  let journalCreated = false;
  const persist = async () => {
    const bytes = encode(journal);
    if (journal.entries.length > 1024 || journal.cli.length > 1024 || Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("transaction exceeds its bounded recovery journal");
    await writeProtectedAtomic(value.journalPath, bytes, { ...options, durable: true }, journalCreated ? value.journalPath : undefined);
    journalCreated = true;
  };
  const remember = async (target, afterSha256 = null) => {
    if (touched.has(target)) throw new Error(`transaction target repeated: ${target}`);
    await rejectLinkedPath(target);
    const current = await exists(target) ? await readFile(target) : undefined;
    const expected = value.snapshots.get(target);
    if ((current === undefined) !== (expected === undefined) || (current && !current.equals(expected))) throw new Error(`managed file changed during operation: ${target}`);
    const entry = {
      target, backup: current === undefined ? null : `${target}.${owner.nonce}.${journal.entries.length}.backup`,
      beforeSha256: current === undefined ? null : hash(current), afterSha256,
    };
    if (entry.backup && await exists(entry.backup)) throw new Error(`transaction backup already exists: ${entry.backup}`);
    journal.entries.push(entry);
    await persist();
    if (entry.backup) await rename(target, entry.backup);
    touched.add(target);
    backups.push(entry);
    return entry.backup;
  };
  const assertReadInputs = async () => {
    for (const [target, expected] of value.snapshots) {
      if (touched.has(target)) continue;
      const current = await exists(target) ? await readFile(target) : undefined;
      if ((current === undefined) !== (expected === undefined) || (current && !current.equals(expected))) throw new Error(`managed file changed during operation: ${target}`);
    }
    for (const entry of backups) {
      if (await fileDigest(entry.target) !== entry.afterSha256) throw new Error(`owned transaction output changed during operation: ${entry.target}`);
    }
  };
  const tx = {
    async write(target, content) {
      if (target === value.statePath) await assertReadInputs();
      const encoded = encode(content);
      const backup = await remember(target, hash(encoded));
      await writeProtectedAtomic(target, encoded, options, backup);
    },
    remove: remember,
    async directory(target) { if (!await exists(target)) { await mkdir(target, { recursive: true }); roots.push(target); } },
    async planCli(replacement, prior) {
      journal.cli.push({ replacement: replacement ?? null, prior: prior ?? null });
      await persist();
    },
    async stop() {
      await assertReadInputs();
      const active = value.state?.status !== "retained" && value.state !== null && await brokerRunning(value, options);
      running = active || options.resumeBroker === true;
      journal.brokerWasRunning = running;
      await persist();
      if (active) {
        await (await brokerLifecycle(options)).stopBroker({ ...options, installRoot: value.installRoot, installLease: release.lease, repairContext: value.repairContext });
        stopped = true;
      }
    },
    async restart() {
      await assertReadInputs();
      journal.phase = "committed";
      await persist();
      commitPublished = true;
      if (running) {
        restartAttempted = true;
        await (await brokerLifecycle(options)).restartBroker({ ...options, installRoot: value.installRoot, installLease: release.lease });
      }
    },
  };
  try {
    const current = await exists(value.statePath) ? await readFile(value.statePath) : undefined;
    if ((current === undefined) !== (value.stateBytes === undefined) || (current && !current.equals(value.stateBytes))) throw new Error("ownership state changed during operation");
    if (await exists(value.journalPath)) throw new Error("an interrupted transaction requires verified repair before another operation");
    await persist();
    const result = await action(tx);
    await assertReadInputs();
    if (!commitPublished) {
      journal.phase = "committed";
      await persist();
      commitPublished = true;
    }
    let cleaned = true;
    for (const entry of backups) if (entry.backup) {
      try { await (options.remove ?? rm)(entry.backup, { force: true }); } catch { cleaned = false; }
    }
    if (cleaned) {
      try { await (options.remove ?? rm)(value.journalPath, { force: true }); } catch { cleaned = false; }
    }
    return cleaned ? result : { ...result, cleanupPending: true, warnings: ["Committed setup is intact; verified backup/journal cleanup remains pending. Run repair after this command exits."] };
  } catch (error) {
    if (commitPublished) {
      const detail = restartAttempted
        ? "Broker startup outcome is uncertain; committed configuration and credentials were retained without rollback."
        : "Setup was committed; a subsequent operation failed and committed data was retained without rollback.";
      const failure = new Error(`${detail} Preserve ${value.journalPath}; inspect broker status and run repair before further credential changes. ${error.message}`, { cause: error });
      failure.code = restartAttempted ? "BROKER_STARTUP_UNCERTAIN" : "INSTALL_COMMITTED";
      throw failure;
    }
    const failures = [];
    if (journalCreated && journal.phase !== "applying") {
      journal.phase = "applying";
      try { await persist(); } catch (failure) { failures.push(`rollback intent could not be recorded: ${failure.message}`); }
    }
    if (failures.length === 0) {
      for (const change of [...journal.cli].reverse()) {
        try { await restoreCliRegistration(change.replacement, change.prior, options); } catch (failure) { failures.push(failure.message); }
      }
      for (const entry of [...backups].reverse()) {
        try {
          const current = await fileDigest(entry.target);
          if (current !== null && current !== entry.afterSha256) throw new Error("foreign output bytes must be preserved");
          if (entry.backup && await fileDigest(entry.backup) !== entry.beforeSha256) throw new Error("original backup bytes changed");
          if (current !== null) await rm(entry.target);
          if (entry.backup) await rename(entry.backup, entry.target);
        } catch (failure) { failures.push(`${entry.target}: ${failure.message}; backup ${entry.backup ?? "none"}`); }
      }
    }
    for (const root of roots.reverse()) await rmdir(root).catch(() => {});
    if (journalCreated && failures.length === 0 && stopped) {
      journal.phase = "committed";
      for (const entry of journal.entries) entry.afterSha256 = entry.beforeSha256;
      try {
        await persist();
        if (value.repairContext) failures.push("the original running configuration bytes are unavailable; user-edited configuration and committed recovery metadata were retained for verified repair to resume");
        else await (await brokerLifecycle(options)).restartBroker({ ...options, installRoot: value.installRoot, installLease: release.lease });
      } catch (failure) { failures.push(`rollback finalization: ${failure.message}`); }
    }
    if (failures.length) throw new Error(`${error.message}; recovery required: ${failures.join("; ")}; preserve ${value.journalPath}`, { cause: error });
    if (journalCreated) await rm(value.journalPath, { force: true });
    throw error;
  } finally { await release(); }
}

async function prepareHost(id, adapter, state, nextLauncher, value, options) {
  const prior = state?.hosts[id];
  if (prior && (prior.adapter ?? id) !== adapter) throw new Error(`host ID already belongs to another adapter: ${id}`);
  const settings = { cwd: options.cwd, env: options.env, scope: options.scope ?? prior?.scope, configPath: options.mcpConfigPath ?? prior?.configPath };
  const plan = createInstallPlan(adapter, nextLauncher, settings);
  if (adapter === "claude-code" && Object.values(state?.hosts ?? {}).some((other) => other.id !== id && (other.adapter ?? other.id) === "claude-code" && other.scope !== plan.scope)) {
    throw new Error("mixed Claude Code scopes cannot be proven through the precedence-based CLI; keep one scope and use distinct IDs/cwd for separate local projects");
  }
  if (plan.kind === "manual") throw new Error("manual registration is read-only: use config print --host-id <id>");
  if (options.mcpConfigPath && plan.kind === "cli") throw new Error("--mcp-config requires a file-backed host");
  const record = { id, adapter, kind: plan.kind, scope: plan.scope, launcher: nextLauncher };
  if (prior && (plan.scope !== prior.scope || (plan.path && path.resolve(plan.path) !== prior.configPath))) throw new Error(`host ID already identifies another scope or project: ${id}; use a unique --host-id`);
  if (plan.kind === "cli") {
    Object.assign(record, { command: plan.command, args: plan.args });
    if (plan.scope === "local") {
      const selectedCwd = await realpath(path.resolve(options.cwd ?? process.cwd()));
      record.cwd = prior?.cwd ?? selectedCwd;
      if (prior && options.host !== undefined && selectedCwd !== prior.cwd) throw new Error(`host ID already identifies another local project: ${id}; use a unique --host-id`);
    }
    for (const other of Object.values(state?.hosts ?? {})) if (other.id !== id && other.kind === "cli" && other.command === plan.command && other.scope === plan.scope && (plan.scope !== "local" || other.cwd === record.cwd)) throw new Error("host CLI scope is already registered under another host ID");
    if (!options.dryRun && !prior) {
      const current = await runHostCommand(options, plan.command, ["mcp", "get", "potassium"], record.cwd);
      if (!cliRegistrationAbsent(current)) throw new Error(`${adapter} launcher exists or its absence cannot be proved; refusing registration without proven ownership`);
    }
    value.plannedHosts.set(id, record);
    return { id, adapter, prior, plan, record, changed: JSON.stringify(prior?.launcher) !== JSON.stringify(nextLauncher) };
  }
  record.configPath = path.resolve(options.cwd ?? process.cwd(), plan.path);
  if (overlaps(value.installRoot, record.configPath) || record.configPath === value.tokenPath || expectedScriptPaths(value.workspaceRoot).includes(record.configPath)) throw new Error("host config must be outside managed private and deployment files");
  for (const other of Object.values(state?.hosts ?? {})) if (other.id !== id && other.configPath === record.configPath) throw new Error("host config already belongs to another host ID");
  await rejectLinkedPath(record.configPath);
  const before = await exists(record.configPath) ? await readFile(record.configPath, "utf8") : undefined;
  value.snapshots.set(record.configPath, before === undefined ? undefined : Buffer.from(before));
  record.configCreated = prior?.configCreated === true || before === undefined;
  const settingsFinal = hostSettings(record, options);
  let content = before ?? "";
  if (prior && JSON.stringify(prior.launcher) !== JSON.stringify(nextLauncher)) content = removeConfig(adapter, content, prior.launcher, settingsFinal).content;
  content = transformConfig(adapter, content, nextLauncher, settingsFinal).content;
  value.plannedHosts.set(id, record);
  return { id, adapter, prior, plan, record, before, content, changed: before !== content };
}

async function commitHost(plan, tx, options, operation = "register") {
  if (!plan.changed) return;
  if (plan.record.kind === "cli") {
    await tx.planCli(plan.record, plan.prior);
    await options.beforeMcpCommit?.({ operation, host: plan.id, kind: "cli" });
    if (plan.prior) {
      if (!await verifyCliRecord(plan.prior, options)) throw new Error(`${plan.id} host ownership changed before CLI replacement; preserving the foreign registration`);
      const result = await runHostCommand(options, plan.prior.command, ["mcp", "remove", "potassium", "--scope", plan.prior.scope], plan.prior.cwd);
      if (!commandOk(result)) throw new Error(`${plan.id} CLI replacement failed`);
    }
    else if (!cliRegistrationAbsent(await runHostCommand(options, plan.record.command, ["mcp", "get", "potassium"], plan.record.cwd))) {
      throw new Error(`${plan.id} host registration appeared before CLI commit; preserving it`);
    }
    if (!commandOk(await runHostCommand(options, plan.plan.command, plan.plan.args, plan.record.cwd))) throw new Error(`${plan.id} CLI registration failed`);
    if (!await verifyCliRecord(plan.record, options)) throw new Error(`${plan.id} CLI did not confirm the exact registered launcher`);
    return;
  }
  await options.beforeMcpCommit?.({ path: plan.record.configPath, operation, host: plan.id });
  const current = await exists(plan.record.configPath) ? await readFile(plan.record.configPath, "utf8") : undefined;
  if (current !== plan.before) throw new Error(`host config changed during ${operation}: ${plan.id}`);
  await tx.write(plan.record.configPath, plan.content);
}

/** Configure private credentials and deployment using an already installed npm package. */
export async function setup(options = {}) {
  if (options.host !== undefined || options.hosts !== undefined || options.mcpConfigPath !== undefined) throw new Error("setup is host-independent; use host add after setup");
  if (options.packageSource !== undefined || options.installPackage !== undefined) throw new Error("npm owns package installation; install the package before setup");
  if (options.initialFullAccessHost !== undefined) assertHostId(options.initialFullAccessHost);
  const value = await context(options);
  if (value.journal) {
    const recovered = await recoverTransaction(value, options);
    if (options.dryRun) return recovered;
    return setup({ ...options, resumeBroker: recovered.restartRequired });
  }
  if (!await exists(value.workspaceRoot) || !(await stat(value.workspaceRoot)).isDirectory()) throw new Error(`workspace does not exist: ${value.workspaceRoot}`);
  const proof = value.state ? await proveState(value, { ...options, allowConfigChanges: true, allowRuntimeChanges: true }) : null;
  if (proof?.state.schema === 3 && proof.state.status === "active" && hash(proof.configBytes) !== proof.state.configSha256) {
    value.repairContext = { configSha256: hash(proof.configBytes), ownedConfigSha256: proof.state.configSha256, tokenSha256: proof.state.tokenSha256 };
  }
  if (options.requireExisting && !proof) throw new Error("repair requires verified existing setup; run setup first");
  if (!proof && (await Promise.all([value.appPath, value.configPath, value.deployStatePath, value.tokenPath, ...expectedScriptPaths(value.workspaceRoot)].map(exists))).some(Boolean)) throw new Error("managed paths already exist without proven ownership; refusing credential adoption");
  const runtime = await runtimeIdentity(path.resolve(options.cwd ?? process.cwd(), options.runtimeRoot ?? packageRoot), options.nodeExecutable ?? process.execPath, value);
  const serverSha256 = hash(await readFile(path.join(runtime.root, "src", "proxy.js")));
  const previousConfig = structuredClone(proof?.config ?? initialConfig(value, options.initialFullAccessHost));
  if (proof?.state.schema === 2 && previousConfig.allowUnsafeExecute !== true) {
    for (const policy of Object.values(previousConfig.hostPolicies ?? {})) if (policy.admin === true) policy.admin = false;
    if (previousConfig.httpPolicy?.admin === true) previousConfig.httpPolicy.admin = false;
  }
  const config = overlayConfig(previousConfig, options, value);
  await verifyFallback(config, value);
  const endpoint = { host: config.host, port: config.port };
  const deployment = await prepareDeployment({ scriptSourceRoot: path.join(runtime.root, "assets"), workspaceRoot: value.workspaceRoot, statePath: value.deployStatePath, endpoint });
  value.nextRuntime = runtime;
  const hostPlans = [];
  for (const [id, record] of Object.entries(proof?.state.hosts ?? {})) {
    resolveHostPolicy(id, config.hostPolicies);
    const nextLauncher = launcher(path.join(runtime.root, "bin", "potassium-mcp.js"), value.configPath, runtime.nodeExecutable, id, config.requestTimeoutMs);
    if (record.kind === "manual") {
      value.plannedHosts.set(id, { id, adapter: record.adapter ?? id, kind: record.kind, scope: record.scope, launcher: nextLauncher });
      continue;
    }
    hostPlans.push(await prepareHost(id, record.adapter ?? id, proof.state, nextLauncher, value, options));
  }
  const scriptPaths = expectedScriptPaths(value.workspaceRoot);
  const operations = [
    ...(!proof ? [{ operation: "create-private-token", path: value.tokenPath }] : []),
    { operation: proof ? "preserve-config-with-explicit-overlays" : "create-private-config", path: value.configPath },
    { operation: "select-external-runtime", path: runtime.root, nodeExecutable: runtime.nodeExecutable, classification: proof?.classification ?? "new" },
    ...scriptPaths.map((target) => ({ operation: "deploy", path: target })),
    { operation: "write-deployment-evidence", path: value.deployStatePath },
    { operation: "preserve-existing-acls", paths: [value.configPath, value.statePath, ...scriptPaths] },
    ...hostPlans.filter((plan) => plan.changed).map((plan) => ({ operation: "migrate-registration", hostId: plan.id, path: plan.record.configPath, command: plan.plan.command, args: plan.plan.args })),
    { operation: "write-ownership", path: value.statePath, status: "active" },
    ...(proof?.state.status !== "retained" && proof ? [{ operation: "restart-if-running", ownership: "exact verified broker generation; stop must drain safely before mutation" }] : []),
  ];
  if (options.dryRun) return { dryRun: true, operations, conflicts: [], runtime, installRoot: value.installRoot, workspaceRoot: value.workspaceRoot };
  return transaction(value, options, async (tx) => {
    await tx.stop();
    await tx.directory(value.installRoot);
    const nextToken = proof ? undefined : `${randomBytes(32).toString("hex")}\n`;
    if (nextToken !== undefined) await tx.write(value.tokenPath, nextToken);
    const bytes = proof && JSON.stringify(config) === JSON.stringify(proof.config) ? proof.configBytes : encode(config);
    if (!proof || !Buffer.from(bytes).equals(proof.configBytes)) await tx.write(value.configPath, bytes);
    for (const plan of hostPlans) await commitHost(plan, tx, options, "setup");
    await options.compileProbe?.(deployment.scripts.map(({ source }) => source));
    for (const script of deployment.scripts) {
      await tx.write(script.target, script.content);
      await options.onDeploymentActivation?.(script.name);
    }
    await tx.write(value.deployStatePath, deployment.state);
    await options.onDeploymentActivation?.("state");
    const deployed = deployment.state;
    const nextState = { schema: 3, status: "active", installRoot: value.installRoot, workspaceRoot: value.workspaceRoot, configPath: value.configPath, tokenPath: value.tokenPath,
      tokenSha256: proof ? proof.state.tokenSha256 : hash(nextToken), configSha256: hash(bytes), serverSha256, runtime,
      scripts: deployed.files.map(({ target, sha256 }) => ({ target, sha256 })), hosts: Object.fromEntries(value.plannedHosts) };
    await tx.write(value.statePath, nextState);
    for (const root of config.artifactRoots ?? []) await tx.directory(path.resolve(path.dirname(value.configPath), root.path));
    if (!proof) for (const root of config.sourceRoots ?? []) await tx.directory(path.resolve(path.dirname(value.configPath), root.path));
    await options.beforeRestart?.();
    await tx.restart();
    return { configured: true, installRoot: value.installRoot, workspaceRoot: value.workspaceRoot, configPath: value.configPath, runtime, hosts: Object.values(nextState.hosts), classification: proof?.classification ?? "new", operations };
  });
}

export function repair(options = {}) { return setup({ ...options, requireExisting: true }); }

export async function printConfig(options = {}) {
  assertHostId(options.hostId);
  const value = await context(options);
  const proof = await proveState(value, { ...options, dryRun: true });
  if (proof.state.schema !== 3 || proof.state.status !== "active") throw new Error("active external setup is required; run setup before printing a launcher");
  resolveHostPolicy(options.hostId, proof.config.hostPolicies);
  if (options.npm) return { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["--yes", `@mrketa/potassium-mcp@${packageMetadata.version}`, "serve", "--config", value.configPath, "--host-id", options.hostId], env: {} };
  const entry = launcher(path.join(proof.state.runtime.root, "bin", "potassium-mcp.js"), value.configPath, proof.state.runtime.nodeExecutable, options.hostId, proof.config.requestTimeoutMs);
  return { command: entry.command, args: entry.args, env: {} };
}

export async function registerHost(options = {}) {
  assertHostId(options.hostId);
  if (typeof options.host !== "string") throw new Error("host add requires one --host adapter and unique --host-id");
  const value = await context(options);
  const proof = await proveState(value, options);
  if (proof.state.schema !== 3 || proof.state.status !== "active") throw new Error("run setup to migrate or reactivate the deployment before registering a host");
  resolveHostPolicy(options.hostId, proof.config.hostPolicies);
  const { runtime } = proof.state;
  const plan = await prepareHost(options.hostId, options.host, proof.state, launcher(path.join(runtime.root, "bin", "potassium-mcp.js"), value.configPath, runtime.nodeExecutable, options.hostId, proof.config.requestTimeoutMs), value, options);
  const operations = [{ operation: plan.changed ? "register-host" : "keep-host", hostId: options.hostId, path: plan.record.configPath, command: plan.plan.command, args: plan.plan.args }, { operation: "write-ownership", path: value.statePath }];
  if (options.dryRun) return { dryRun: true, operations, conflicts: [], ...(plan.record.kind === "cli" ? { verificationRequired: "host CLI ownership must be checked before commit" } : {}) };
  return transaction(value, options, async (tx) => {
    await commitHost(plan, tx, options);
    if (JSON.stringify(proof.state.hosts[options.hostId]) !== JSON.stringify(plan.record)) await tx.write(value.statePath, { ...proof.state, hosts: { ...proof.state.hosts, [options.hostId]: plan.record } });
    return { registered: true, host: plan.record, sharedRetained: true, operations };
  });
}

function canDeleteCreatedConfig(adapter, source, record) {
  if (record.kind === "toml") return source.trim() === "";
  try {
    const config = JSON.parse(source);
    const key = adapter === "vscode" ? "servers" : "mcpServers";
    return Object.keys(config).every((name) => name === key) && config[key] && typeof config[key] === "object" && Object.keys(config[key]).length === 0;
  } catch { return false; }
}

async function removeHosts(value, proof, ids, tx, options) {
  const hosts = { ...proof.state.hosts };
  for (const id of ids) {
    const record = hosts[id];
    if (!record) throw new Error(`host is not owned: ${id}`);
    if (record.kind === "cli") {
      if (!await verifyCliRecord(record, options)) throw new Error(`host ownership is ambiguous: ${id}`);
      await tx.planCli(null, record);
      if (!commandOk(await runHostCommand(options, record.command, ["mcp", "remove", "potassium", "--scope", record.scope], record.cwd))) throw new Error(`${id} CLI removal failed`);
    } else if (record.kind !== "manual") {
      const adapter = record.adapter ?? id;
      const before = await readFile(record.configPath, "utf8");
      const removed = removeConfig(adapter, before, record.launcher, hostSettings(record, options));
      await options.beforeMcpCommit?.({ path: record.configPath, operation: "remove", host: id });
      if (await readFile(record.configPath, "utf8") !== before) throw new Error(`host config changed during remove: ${id}`);
      if (record.configCreated && canDeleteCreatedConfig(adapter, removed.content, record)) await tx.remove(record.configPath);
      else await tx.write(record.configPath, removed.content);
    }
    delete hosts[id];
  }
  return hosts;
}

export async function removeHost(options = {}) {
  assertHostId(options.hostId);
  const value = await context(options);
  const proof = await proveState(value, options);
  const record = proof.state.hosts[options.hostId];
  if (!record || (options.host !== undefined && (record.adapter ?? record.id) !== options.host)) throw new Error(`host is not owned by the selected adapter: ${options.hostId}`);
  if (options.scope !== undefined && options.scope !== record.scope || options.mcpConfigPath !== undefined && path.resolve(options.cwd ?? process.cwd(), options.mcpConfigPath) !== record.configPath) throw new Error("selected host scope or configuration differs from ownership");
  const operations = [{ operation: "remove-host", hostId: options.hostId, path: record.configPath, command: record.command, args: record.kind === "cli" ? ["mcp", "remove", "potassium", "--scope", record.scope] : undefined }, { operation: "write-ownership", path: value.statePath }];
  if (options.dryRun) return { dryRun: true, operations, conflicts: [] };
  return transaction(value, options, async (tx) => {
    const hosts = await removeHosts(value, proof, [options.hostId], tx, options);
    await tx.write(value.statePath, { ...proof.state, hosts });
    return { removed: true, hosts: [options.hostId], sharedRetained: true, operations };
  });
}

export async function uninstall(options = {}) {
  if (options.all !== true) throw new Error("uninstall requires --all for deployment removal; use host remove for one registration");
  const value = await context(options);
  const proof = await proveState(value, options);
  if (proof.state.schema !== 3) throw new Error("run setup with verified migration before uninstall; legacy package/link ownership is not deletion authority");
  const ids = Object.keys(proof.state.hosts);
  const operations = [...ids.map((id) => ({ operation: "remove-host", hostId: id, path: proof.state.hosts[id].configPath })), ...proof.state.scripts.map(({ target }) => ({ operation: "remove-deployment", path: target })), { operation: "retain-config-and-credential-proof", path: value.statePath }];
  if (options.dryRun) return { dryRun: true, operations, conflicts: [] };
  if (proof.state.status === "retained") return { uninstalled: true, hosts: [], sharedRetained: true, deploymentRemoved: true, packageRetained: true };
  return transaction(value, options, async (tx) => {
    await tx.stop();
    await removeHosts(value, proof, ids, tx, options);
    for (const target of [...proof.state.scripts.map((script) => script.target), value.deployStatePath]) await tx.remove(target);
    await tx.write(value.statePath, { ...proof.state, status: "retained", hosts: {} });
    return { uninstalled: true, hosts: ids, sharedRetained: true, deploymentRemoved: true, packageRetained: true, retained: [value.tokenPath, value.configPath, value.statePath], operations };
  });
}

/** Rotate only the owned custom token; executor clients must explicitly reconnect. */
export async function rotateToken(options = {}) {
  const value = await context(options);
  const proof = await proveState(value, options);
  if (proof.state.schema !== 3 || proof.state.status !== "active") throw new Error("token rotation requires active verified external setup");
  if (options.dryRun) return { dryRun: true, operations: [{ operation: "rotate-private-token", path: value.tokenPath }, { operation: "write-ownership", path: value.statePath }], conflicts: [] };
  return transaction(value, options, async (tx) => {
    await tx.stop();
    const token = `${randomBytes(32).toString("hex")}\n`;
    await tx.write(value.tokenPath, token);
    await tx.write(value.statePath, { ...proof.state, tokenSha256: hash(token) });
    await tx.restart();
    return { rotated: true, executorReattachRequired: true };
  });
}

import { createHash } from "node:crypto";
import { access, lstat, open, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { visit } from "jsonc-parser";
import { renderBootstrap } from "./deploy.js";
import { inspectHost, launcherTimeout, resolveHost, supportsRuntime } from "./hosts.js";
import { resolveHostPolicy } from "./host-policy.js";
import { resolveConfigSelection, resolveInstallRoot } from "./paths.js";
import { loadConfig } from "./server.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_LAUNCHER_TIMEOUT_MS = 40000;
const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (value) => typeof value === "string" && path.isAbsolute(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const readJson = async (target, fallback = null) => await exists(target)
  ? JSON.parse(await readFile(target, "utf8"))
  : fallback;
const assets = [
  ["bootstrap", "potassium_mcp_bootstrap.lua", ".potassium-mcp-bootstrap.lua"],
  ["autoexec", "potassium_mcp_autoexec.lua", "potassium_mcp_autoexec.lua"],
];

function record(checks, name, ok, detail, extra = {}) {
  checks.push({ name, ok, detail, ...extra });
}

function selectedHosts(options, records) {
  const requested = options.hostId ?? options.hosts ?? options.host;
  return [...new Set(requested === undefined ? Object.keys(records) : Array.isArray(requested) ? requested : [requested])];
}

const CLI_SCOPE_LABELS = {
  user: ["user", "User config", "User config (available in all your projects)"],
  local: ["local", "Local config", "Local config (private to you in this project)"],
  project: ["project", "Project config", "Project config (shared via .mcp.json)"],
};

function structuredLauncherMatches(value, expected, scope) {
  if (!object(value)) return false;
  if (value.name !== undefined && value.name !== "potassium") return false;
  const launcher = value.transport ?? value;
  return object(launcher)
    && (launcher.type === undefined || launcher.type === "stdio")
    && (scope === undefined || (value.scope === undefined || value.scope === scope)
      && (launcher.scope === undefined || launcher.scope === scope))
    && launcher.command === expected.command
    && isDeepStrictEqual(launcher.args, expected.args)
    && (launcher.env === undefined || (object(launcher.env) && Object.keys(launcher.env).length === 0));
}

/** Prove exact launcher arguments and, when requested, registration scope from CLI output. */
export function cliRegistrationMatches(result, expected, scope = undefined) {
  if (!object(expected) || typeof expected.command !== "string" || !Array.isArray(expected.args)
    || !expected.args.every((argument) => typeof argument === "string")
    || (scope !== undefined && !Object.hasOwn(CLI_SCOPE_LABELS, scope))
    || !result || result.error || (result.status !== undefined && result.status !== 0)) return false;
  if (result.stdout === undefined) return structuredLauncherMatches(result, expected, scope);
  const output = String(result.stdout).trim();
  try {
    return structuredLauncherMatches(JSON.parse(output), expected, scope);
  } catch {
    const fields = (name) => [...output.matchAll(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "gm"))]
      .map((match) => match[1].trim());
    const commands = fields("Command");
    const args = fields("Args");
    const types = fields("Type");
    if (commands.length !== 1 || args.length !== 1 || types.length > 1
      || (types.length === 1 && types[0] !== "stdio") || commands[0] !== expected.command) return false;
    if (scope !== undefined) {
      const scopes = fields("Scope");
      if (scopes.length !== 1 || !CLI_SCOPE_LABELS[scope].includes(scopes[0])) return false;
    }
    try {
      return isDeepStrictEqual(JSON.parse(args[0]), expected.args);
    } catch { /* Unquoted human output proves only nonempty, whitespace-free argument tokens. */ }
    return expected.args.every((argument) => argument.length > 0 && !/\s/.test(argument))
      && args[0] === expected.args.join(" ");
  }
}

async function verifyCli(owned, options) {
  if (options.verifyCliRegistration) return await options.verifyCliRegistration(owned) === true;
  const run = options.runCommand ?? ((command, args, executionOptions) => spawnSync(command, args, {
    ...executionOptions, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  }));
  return cliRegistrationMatches(await run(owned.command, ["mcp", "get", "potassium"],
    owned.scope === "local" ? { cwd: owned.cwd } : undefined), owned.launcher, owned.scope);
}

function scriptTargets(workspaceRoot) {
  return assets.map(([name, source, target]) => ({
    name, source,
    target: path.join(name === "bootstrap" ? workspaceRoot : path.join(workspaceRoot, "..", "autoexec"), target),
  }));
}

function validState(state, installRoot, workspaceRoot, configPath, targets) {
  if (!object(state) || ![2, 3].includes(state.schema) || !object(state.hosts)
    || state.installRoot !== installRoot || state.workspaceRoot !== workspaceRoot
    || state.configPath !== configPath || state.tokenPath !== path.join(workspaceRoot, ".potassium-mcp-token")
    || ![state.tokenSha256, state.configSha256, state.serverSha256].every(digest)) return false;
  if (state.schema === 3 && (!["active", "retained"].includes(state.status)
    || state.runtime?.mode !== "external" || !absolute(state.runtime.root)
    || !absolute(state.runtime.nodeExecutable) || !digest(state.runtime.nodeSha256))) return false;
  if (state.schema === 2 && state.appPath !== path.join(installRoot, "app")) return false;
  if (state.schema === 3 && state.status === "retained" && Object.keys(state.hosts).length !== 0) return false;
  return Array.isArray(state.scripts) && state.scripts.length === targets.length
    && new Set(state.scripts.map((script) => script?.target)).size === targets.length
    && state.scripts.every((script) => object(script) && digest(script.sha256)
      && targets.some(({ target }) => target === script.target));
}

async function historicalMode(root) {
  for (let target = root; ; target = path.dirname(target)) {
    try {
      if ((await lstat(target)).isSymbolicLink()) return "junction";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(target) === target) return "copy";
  }
}

function validLauncher(launcher, root, configPath, runtimeConfig, state, hostId) {
  if (!runtimeConfig || !object(launcher) || launcher.type !== "stdio" || !absolute(launcher.command)) return false;
  const timeout = state.schema === 3 ? launcherTimeout(runtimeConfig.requestTimeoutMs) : MCP_LAUNCHER_TIMEOUT_MS;
  if (launcher.timeout !== timeout || launcher.timeout <= runtimeConfig.requestTimeoutMs) return false;
  const args = state.schema === 3
    ? [path.join(root, "bin", "potassium-mcp.js"), "serve", "--config", configPath, "--host-id", hostId]
    : [path.join(root, "src", "proxy.js"), "--config", configPath, "--host-id", hostId];
  const historicalOmp = state.schema === 2 && hostId === "omp"
    && isDeepStrictEqual(launcher.args, args.slice(0, 3));
  return isDeepStrictEqual(launcher, {
    type: "stdio", command: state.schema === 3 ? state.runtime.nodeExecutable : launcher.command,
    args: historicalOmp ? args.slice(0, 3) : args, timeout,
  });
}

async function inspectScripts(checks, targets, sourceRoot, state, installRoot, retained, runtimeConfig) {
  if (retained) {
    const scriptsAbsent = !(await Promise.all(targets.map(({ target }) => exists(target)))).some(Boolean);
    record(checks, "script-parity", scriptsAbsent, scriptsAbsent
      ? "retained script hashes are preserved and deployment is absent; run setup to deploy"
      : "retained setup conflicts with deployed files; preserve unexpected files before running setup", { skipped: scriptsAbsent });
    const deployStateAbsent = !await exists(path.join(installRoot, "deploy-state.json"));
    record(checks, "deploy-state", deployStateAbsent, deployStateAbsent
      ? "deployment is intentionally absent for retained configuration"
      : "retained setup conflicts with an existing deploy-state.json; inspect ownership before setup", { skipped: deployStateAbsent });
    return;
  }
  record(checks, "canonical-assets", (await Promise.all(targets.map(({ source }) => exists(path.join(sourceRoot, source))))).every(Boolean),
    "both canonical Lua assets must exist in the runtime package; restore the package if missing");
  try {
    for (const { name, source, target } of targets) {
      const content = await readFile(target);
      let expectedContent = await readFile(path.join(sourceRoot, source));
      if (state?.schema === 3 && name === "bootstrap") {
        if (!runtimeConfig) throw new Error("runtime config is unavailable; cannot verify the bootstrap endpoint");
        expectedContent = renderBootstrap(expectedContent, { host: runtimeConfig.host, port: runtimeConfig.port });
      }
      if (sha256(expectedContent) !== sha256(content)) {
        throw new Error(`${name} differs from the runtime asset; repair the deployment after reviewing local changes`);
      }
      const owned = state?.scripts?.find((script) => script?.target === target);
      if (!owned || sha256(content) !== owned.sha256) {
        throw new Error(`${name} does not match ownership evidence; restore the owned script before repair`);
      }
    }
    record(checks, "script-parity", true, "both deployed scripts match endpoint-rendered runtime assets and ownership hashes");
  } catch (error) {
    record(checks, "script-parity", false, `${error.message}; check the deployed scripts and run setup or repair`);
  }
  try {
    const deployState = await readJson(path.join(installRoot, "deploy-state.json"));
    if (deployState?.schema !== 3 || !Array.isArray(deployState.files) || deployState.files.length !== targets.length) {
      throw new Error("deploy state is missing or invalid");
    }
    const expected = new Map(targets.map((target) => [target.name, target.target]));
    for (const entry of deployState.files) {
      if (!object(entry) || expected.get(entry.name) !== entry.target || !absolute(entry.target)
        || !digest(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error("deploy state does not identify both exact canonical deployment targets");
      }
      expected.delete(entry.name);
      const content = await readFile(entry.target);
      if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) {
        throw new Error(`deploy state differs from deployed file: ${entry.name}`);
      }
    }
    record(checks, "deploy-state", true, "schema-3 deployment state matches both deployed script byte lengths and hashes");
  } catch (error) {
    record(checks, "deploy-state", false, `${error.message}; restore ownership evidence or run setup with a clean deployment`);
  }
}

async function inspectTransaction(checks, installRoot) {
  try {
    const handle = await open(`${installRoot}.transaction.json`, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("journal size is invalid");
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== info.size) throw new Error("journal changed while being read");
      const metadata = Object.create(null);
      const selected = new Set(["schema", "installRoot", "phase"]);
      const seen = new Set();
      let property = null;
      let invalid = false;
      // Visit root metadata only: do not construct or expose baseline, hash, or rollback records.
      visit(buffer.subarray(0, length).toString("utf8"), {
        onObjectBegin: (_offset, _length, _line, _character, getPath) => getPath().length === 0,
        onArrayBegin: () => false,
        onObjectProperty: (name) => {
          property = selected.has(name) ? name : null;
          if (property !== null) {
            if (seen.has(property)) invalid = true;
            seen.add(property);
          }
        },
        onLiteralValue: (value) => {
          if (property !== null) metadata[property] = value;
          property = null;
        },
        onError: () => { invalid = true; },
      }, { disallowComments: true, allowTrailingComma: false });
      if (invalid || metadata.schema !== 1 || metadata.installRoot !== installRoot
        || !["applying", "committed", "rolled-back"].includes(metadata.phase)) throw new Error("journal metadata is invalid");
      const pending = metadata.phase === "applying";
      record(checks, "installer-transaction", !pending, pending
        ? "an installer transaction is still applying; do not use this installation; preserve the journal and backups, then run repair"
        : "a completed installer transaction needs backup cleanup; run repair; runtime/config/deployment checks remain independently required",
      { phase: metadata.phase, cleanupRequired: !pending });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      record(checks, "installer-transaction", true, "no pending installer transaction journal");
    } else {
      record(checks, "installer-transaction", false,
        "installer transaction metadata is unreadable, changing, or invalid; preserve its journal and backups, then run repair");
    }
  }
}

export async function doctor(options = {}) {
  const selectedConfig = resolveConfigSelection(options);
  const configPath = selectedConfig.path;
  const env = options.env ?? process.env;
  const explicitConfig = options.configFile !== undefined || env.POTASSIUM_MCP_CONFIG !== undefined;
  const installRoot = explicitConfig && options.installRoot === undefined
    ? path.dirname(configPath) : resolveInstallRoot(options);
  const checks = [];
  record(checks, "config-selection", true, `${selectedConfig.source}: ${configPath}`);
  let state;
  try {
    state = await readJson(path.join(installRoot, "ownership.json"));
  } catch (error) {
    record(checks, "ownership", false, `cannot read ownership.json: ${error.message}; restore valid ownership metadata before repair`);
  }
  const workspaceRoot = path.resolve(options.cwd ?? process.cwd(), options.workspaceRoot
    ?? (absolute(state?.workspaceRoot) ? state.workspaceRoot : path.join(installRoot, "..", "workspace")));
  const targets = scriptTargets(workspaceRoot);
  const ownedState = validState(state, installRoot, workspaceRoot, configPath, targets);
  const retained = state?.schema === 3 && state.status === "retained";
  if (!checks.some(({ name }) => name === "ownership")) {
    record(checks, "ownership", ownedState, ownedState
      ? `schema-${state.schema} ${retained ? "retained" : "active"} ownership matches the selected paths`
      : "ownership is missing, corrupt, or belongs to different paths; select the owned --install-root/--config or run setup");
  }
  const root = state?.schema === 3 && absolute(state.runtime?.root)
    ? state.runtime.root
    : path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp");
  const runtime = {
    mode: state?.schema === 3 ? "external" : state?.schema === 2 ? await historicalMode(root) : "unknown",
    root,
    nodeExecutable: state?.schema === 3 ? state.runtime?.nodeExecutable ?? null : null,
    version: null,
    invokedVersion: null,
  };
  const legacy = state?.schema === 2;
  record(checks, "runtime-mode", ownedState, legacy
    ? `historical schema-2 ${runtime.mode} runtime; diagnosis is read-only, and custom wrappers or junctions are not modified`
    : retained ? "external runtime retained without a deployed installation" : "external package runtime; no package copy or junction is managed");
  record(checks, "workspace", await exists(workspaceRoot), `workspace must exist at ${workspaceRoot}; select the correct workspace or run setup`);
  let runtimeConfig;
  let configSha256;
  try {
    const bytes = await readFile(configPath);
    configSha256 = sha256(bytes);
    const rawConfig = JSON.parse(bytes.toString("utf8"));
    runtimeConfig = await loadConfig(configPath);
    const tokenPath = typeof rawConfig.tokenFile === "string" ? path.resolve(path.dirname(configPath), rawConfig.tokenFile) : null;
    const bounded = ["127.0.0.1", "::1"].includes(runtimeConfig.host)
      && ["127.0.0.1", "::1"].includes(runtimeConfig.proxyHost)
      && runtimeConfig.port > 0 && runtimeConfig.proxyPort > 0 && tokenPath === state?.tokenPath;
    record(checks, "runtime-config", bounded, bounded
      ? `selected config uses bounded loopback endpoints and ${runtimeConfig.artifactRoots.length} artifact roots`
      : "config must use nonzero loopback endpoints and the owned token file; correct --config or repair the owned configuration");
    record(checks, "config-ownership", configSha256 === state?.configSha256,
      "configuration bytes must match ownership; review local edits before repair");
    record(checks, "token-ownership", tokenPath !== null && sha256(await readFile(tokenPath)) === state?.tokenSha256,
      "token bytes must match ownership; restore the owned token before repair or rotation");
    record(checks, "streamable-http", !runtimeConfig.streamableHttpEnabled || runtimeConfig.streamableHttpPort > 0,
      runtimeConfig.streamableHttpEnabled ? "enabled; use a nonzero loopback Streamable HTTP port" : "disabled");
    record(checks, "stateful-http", !runtimeConfig.statefulHttpEnabled || runtimeConfig.streamableHttpPort > 0,
      runtimeConfig.statefulHttpEnabled ? "enabled; use a nonzero loopback SSE session port" : "disabled");
    record(checks, "builtin-fallback", !runtimeConfig.builtinFallbackEnabled
      || (runtimeConfig.builtinFallbackTokenFile !== undefined && await exists(runtimeConfig.builtinFallbackTokenFile)),
    runtimeConfig.builtinFallbackEnabled ? "diagnostic-only fallback requires its separate token file" : "disabled");
    record(checks, "native-editor", !runtimeConfig.nativeEditorEnabled
      || (runtimeConfig.nativeEditorTokenFile !== undefined && await exists(runtimeConfig.nativeEditorTokenFile)),
    runtimeConfig.nativeEditorEnabled ? "desktop editor requires its separate token file; native readiness is not probed" : "disabled");
  } catch (error) {
    record(checks, "runtime-config", false, `${error.message}; correct the selected config or restore its token file`);
  }
  let runtimeChanged = false;
  if (retained) {
    record(checks, "runtime-integrity", true, "retained runtime identity is recorded only; the external npm package may have been uninstalled", { skipped: true });
    record(checks, "runtime-version", true, "retained runtime is not required to exist; run setup with the intended installed package before use", { skipped: true });
  } else {
    try {
      const proxyPath = path.join(root, "src", "proxy.js");
      const proxySha256 = sha256(await readFile(proxyPath));
      runtimeChanged = digest(state?.serverSha256) && proxySha256 !== state.serverSha256;
      if (proxySha256 !== state?.serverSha256) throw new Error("proxy bytes differ from ownership; repair after reviewing the package update");
      if (!legacy) {
        if (await realpath(root) !== root) throw new Error("runtime root is not canonical; rerun setup using the real package location");
        if (!absolute(runtime.nodeExecutable) || await realpath(runtime.nodeExecutable) !== runtime.nodeExecutable) {
          throw new Error("Node executable is missing or not canonical; repair using an existing absolute Node executable");
        }
        if (sha256(await readFile(runtime.nodeExecutable)) !== state.runtime.nodeSha256) {
          runtimeChanged = true;
          throw new Error("Node executable changed; repair to refresh the owned runtime identity");
        }
        for (const entry of ["bin/potassium-mcp.js", "src/proxy.js", "src/broker.js"]) {
          const target = path.join(root, entry);
          if (!(await lstat(target)).isFile() || await realpath(target) !== target) {
            throw new Error(`runtime entry is missing or redirected: ${entry}; restore the external package`);
          }
        }
      }
      record(checks, "runtime-integrity", true, "runtime files match the recorded package and executable identity");
    } catch (error) {
      record(checks, "runtime-integrity", false, `${error.message}; runtime is not ready`);
    }
    try {
      const metadata = await readJson(path.join(root, "package.json"));
      const invoked = await readJson(path.join(options.packageRoot ?? packageRoot, "package.json"));
      if (metadata?.name !== "@mrketa/potassium-mcp" || typeof metadata.version !== "string"
        || typeof invoked?.version !== "string") throw new Error("Potassium package version metadata is missing");
      runtime.version = metadata.version;
      runtime.invokedVersion = invoked.version;
      record(checks, "runtime-compatibility", legacy || supportsRuntime(metadata), legacy
        ? "historical schema-2 runtime does not require the public-launcher compatibility marker"
        : "external runtime must support ownership schema 3 and launcher protocol 1; install a compatible npm release and run setup if this check fails");
      record(checks, "runtime-version", runtime.version === runtime.invokedVersion, runtime.version === runtime.invokedVersion
        ? `runtime and invoked CLI version ${runtime.version} agree`
        : `owned runtime ${runtime.version} differs from invoked CLI ${runtime.invokedVersion}; run repair from the intended package version`);
    } catch (error) {
      record(checks, "runtime-version", false, `${error.message}; restore the runtime package metadata`);
    }
  }
  await inspectScripts(checks, targets, options.scriptSourceRoot ?? path.join(root, "assets"), state, installRoot, retained, runtimeConfig);
  const runtimeReady = ownedState && !retained && checks.every(({ ok }) => ok);
  const records = object(state?.hosts) ? state.hosts : {};
  const hosts = selectedHosts(options, records);
  const hostStatus = [];
  for (const id of hosts) {
    const owned = records[id];
    const status = { id, adapter: legacy ? id : owned?.adapter ?? null, kind: owned?.kind ?? null, ready: false, configured: false, actuallyChecked: false };
    hostStatus.push(status);
    try {
      if (!ownedState || !object(owned) || owned.id !== id) throw new Error("host is not covered by valid ownership; reconnect the host after restoring ownership");
      const target = resolveHost(status.adapter, { cwd: options.cwd, env: options.env, scope: owned.scope, configPath: owned.configPath });
      if (target.kind !== owned.kind || target.scope !== owned.scope
        || (target.kind === "cli" && target.command !== owned.command)) {
        throw new Error("host adapter metadata differs from ownership; reconnect using the correct adapter and scope");
      }
      if (!validLauncher(owned.launcher, root, configPath, runtimeConfig, state, id)
        || !await exists(owned.launcher.command)) {
        throw new Error("launcher must use the owned absolute Node executable, exact runtime/config/host arguments, and the managed outer deadline derived from executor requests; reconnect this host");
      }
      if (owned.kind === "cli" && !isDeepStrictEqual(owned.args,
        ["mcp", "add", "potassium", "--scope", owned.scope, "--", owned.launcher.command, ...owned.launcher.args])) {
        throw new Error("CLI registration metadata differs from the exact owned install command; reconnect this host");
      }
      if (owned.kind === "cli" && owned.scope === "local"
        && (!absolute(owned.cwd) || !await exists(owned.cwd) || await realpath(owned.cwd) !== owned.cwd
          || !(await lstat(owned.cwd)).isDirectory())) {
        throw new Error("local CLI ownership requires its existing canonical project cwd; preserve the registration and reconnect from the original project");
      }
      try {
        resolveHostPolicy(id, runtimeConfig.hostPolicies);
      } catch (error) {
        throw new Error(`${error.message}; configure an explicit hostPolicies entry for this custom host ID before reconnecting`);
      }
      status.ready = runtimeReady;
      if (owned.kind === "manual") {
        record(checks, "host-launcher", true, "manual snippet only; configuration and connectivity are user-managed and have not been checked", { host: id, skipped: true });
        continue;
      }
      if (owned.kind === "cli") {
        if (options.probe !== true) {
          record(checks, "host-launcher", true, "owned launcher is ready; CLI registration is not checked in static mode; rerun doctor --probe", { host: id, skipped: true });
          continue;
        }
        status.actuallyChecked = true;
        status.configured = await verifyCli(owned, options);
        record(checks, "host-launcher", status.configured, status.configured
          ? "host CLI confirms the exact owned launcher; this does not prove an MCP or executor connection"
          : "host CLI did not confirm the exact owned launcher; reconnect this host and rerun doctor --probe", { host: id });
        continue;
      }
      if (!absolute(owned.configPath)) throw new Error("owned host configuration path is not absolute; reconnect this host");
      const source = await readFile(owned.configPath, "utf8");
      const view = inspectHost(status.adapter, source, owned.launcher, {
        cwd: options.cwd, env: options.env, scope: owned.scope, configPath: owned.configPath,
      });
      status.configured = view.configured;
      record(checks, "host-launcher", status.configured, status.configured
        ? "host configuration contains the exact owned launcher; no live connection was checked"
        : "host configuration differs from exact ownership; preserve foreign entries and reconnect this host", { host: id });
    } catch (error) {
      status.ready = false;
      record(checks, "host-launcher", false, error.message, { host: id });
    }
  }
  let broker = { status: "not-checked", actuallyChecked: false, version: null };
  let restartRequired = false;
  let brokerVersionDrift = false;
  try {
    const recorded = await readJson(path.join(installRoot, "broker-state.json"));
    if (recorded !== null) {
      const brokerPath = path.join(root, "src", "broker.js");
      if (recorded?.schema !== 1 || !Number.isSafeInteger(recorded.pid) || recorded.pid <= 0
        || recorded.configPath !== configPath || !absolute(recorded.brokerPath)
        || (recorded.brokerPath !== brokerPath && await realpath(recorded.brokerPath) !== await realpath(brokerPath))
        || !digest(recorded.configDigest) || typeof recorded.version !== "string") {
        throw new Error("broker state is invalid or belongs to another runtime/config; inspect ownership before restarting");
      }
      broker = { status: "recorded-unverified", actuallyChecked: false, version: recorded.version };
      brokerVersionDrift = runtime.version !== null && recorded.version !== runtime.version;
      restartRequired = brokerVersionDrift || recorded.configDigest !== configSha256 || runtimeChanged;
    }
    if (options.probe === true) {
      broker.actuallyChecked = true;
      const lifecycle = options.brokerLifecycle ?? await import("./broker.js");
      const probed = await lifecycle.brokerStatus({ ...options, installRoot, configFile: configPath });
      broker = { ...probed, actuallyChecked: true };
      if (probed.status === "running") {
        brokerVersionDrift = runtime.version !== null && typeof probed.version === "string" && probed.version !== runtime.version;
        restartRequired = brokerVersionDrift || (digest(probed.configDigest) && probed.configDigest !== configSha256) || runtimeChanged;
      } else {
        brokerVersionDrift = false;
        restartRequired = false;
      }
      record(checks, "broker-probe", probed.status === "running" && probed.readiness === "ready",
        probed.status === "running" && probed.readiness === "ready"
          ? "owned broker process and listener are ready; executor/game connectivity was not checked"
          : "owned broker is not ready; start or restart it explicitly, then rerun doctor --probe");
    }
    if (recorded !== null || (broker.actuallyChecked && typeof broker.version === "string")) {
      record(checks, "broker-version", !restartRequired, restartRequired
        ? `broker version/config differs from the current runtime; restart the owned broker before use${broker.actuallyChecked ? "" : " (running state is unverified)"}`
        : broker.actuallyChecked ? "checked broker has no observed version/config drift"
          : "recorded broker version/config agree; running state and connectivity are unverified");
    }
  } catch (error) {
    record(checks, options.probe === true && broker.actuallyChecked ? "broker-probe" : "broker-version", false, error.message);
  }
  await inspectTransaction(checks, installRoot);
  const versionDrift = runtimeChanged || brokerVersionDrift
    || (runtime.version !== null && runtime.invokedVersion !== null && runtime.version !== runtime.invokedVersion);
  const ready = runtimeReady && !versionDrift && !restartRequired
    && checks.every((entry) => (!entry.name.startsWith("broker-") && entry.name !== "installer-transaction") || entry.ok);
  for (const host of hostStatus) host.ready &&= ready;
  return {
    ok: checks.every(({ ok }) => ok),
    ready,
    configured: hostStatus.some((host) => host.configured),
    actuallyChecked: broker.actuallyChecked || hostStatus.some((host) => host.actuallyChecked),
    installRoot, workspaceRoot, configPath, configSource: selectedConfig.source, selectedConfig,
    schema: state?.schema ?? null,
    status: retained ? "retained" : ownedState ? "active" : "unmanaged",
    legacy, runtime, versionDrift, restartRequired, broker, checks, hosts, hostStatus,
  };
}

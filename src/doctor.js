import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHost } from "./hosts.js";
import { loadConfig } from "./server.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_LAUNCHER_TIMEOUT_MS = 40000;
const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (target, fallback) => await exists(target)
  ? JSON.parse(await readFile(target, "utf8"))
  : fallback;
const assets = [
  ["bootstrap", "potassium_mcp_bootstrap.lua", ".potassium-mcp-bootstrap.lua"],
  ["autoexec", "potassium_mcp_autoexec.lua", "potassium_mcp_autoexec.lua"],
];

function record(checks, name, ok, detail, host) {
  checks.push({ name, ok, detail, ...(host ? { host } : {}) });
}

function selectedHosts(options, records) {
  const requested = options.hosts ?? options.host;
  if (requested === undefined) return Object.keys(records);
  return Array.isArray(requested) ? requested : [requested];
}

async function verifyCli(recordValue, options) {
  if (options.verifyCliRegistration) return options.verifyCliRegistration(recordValue);
  const run = options.runCommand ?? ((command, args) => spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  }));
  const result = await run(recordValue.command, ["mcp", "get", "potassium"]);
  if (result?.error || (result?.status !== undefined && result.status !== 0)) return false;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes(recordValue.launcher.command)
    && recordValue.launcher.args.every((argument) => output.includes(argument));
}

function validLauncher(launcher, proxyPath, configPath, runtime) {
  return launcher?.type === "stdio"
    && typeof launcher.command === "string"
    && path.isAbsolute(launcher.command)
    && Array.isArray(launcher.args)
    && JSON.stringify(launcher.args) === JSON.stringify([proxyPath, "--config", configPath])
    && launcher.timeout === MCP_LAUNCHER_TIMEOUT_MS
    && launcher.timeout > runtime.requestTimeoutMs;
}

export async function doctor(options = {}) {
  const installRoot = path.resolve(options.installRoot ?? (
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Potassium", "MCP")
      : path.join(packageRoot, "..", "MCP")
  ));
  const workspaceRoot = path.resolve(options.workspaceRoot ?? (
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Potassium", "data")
      : path.join(installRoot, "data")
  ));
  const installedPackageRoot = path.join(
    installRoot,
    "app",
    "node_modules",
    "@mrketa",
    "potassium-mcp",
  );
  const sourceRoot = options.scriptSourceRoot
    ? path.resolve(options.scriptSourceRoot)
    : path.resolve(options.packageRoot ?? installedPackageRoot, "assets");
  const configPath = path.resolve(options.configPath ?? path.join(installRoot, "config.json"));
  const state = await readJson(path.join(installRoot, "ownership.json"), null);
  const checks = [];

  record(checks, "workspace", await exists(workspaceRoot), "workspace exists");
  const canonical = assets.map(([, source]) => path.join(sourceRoot, source));
  record(
    checks,
    "canonical-assets",
    (await Promise.all(canonical.map(exists))).every(Boolean),
    "both canonical Lua assets exist",
  );
  try {
    const parity = await Promise.all(assets.map(async ([name, source, target]) => {
      const deployed = path.join(
        name === "bootstrap" ? workspaceRoot : path.join(workspaceRoot, "..", "autoexec"),
        target,
      );
      return await exists(deployed)
        && sha256(await readFile(path.join(sourceRoot, source))) === sha256(await readFile(deployed));
    }));
    record(checks, "script-parity", parity.every(Boolean), "deployed scripts match canonical assets");
  } catch (error) {
    record(checks, "script-parity", false, error.message);
  }

  let runtime;
  const defaultProxyPath = path.join(installedPackageRoot, "src", "proxy.js");
  const proxyPath = path.resolve(options.serverPath ?? defaultProxyPath);
  try {
    if (!await exists(proxyPath)) throw new Error("stable proxy is missing");
    runtime = await loadConfig(configPath);
    const rawConfig = JSON.parse(await readFile(configPath, "utf8"));
    const tokenPath = path.resolve(path.dirname(configPath), rawConfig.tokenFile ?? "");
    const ok = runtime.host === "127.0.0.1"
      && runtime.proxyHost === "127.0.0.1"
      && runtime.proxyPort > 0
      && await exists(tokenPath)
      && runtime.artifactRoots.length === 1;
    record(checks, "runtime-config", ok, ok
      ? "proxy accepts the loopback runtime config"
      : "runtime must keep executor and proxy transports on bounded loopback endpoints");
  } catch (error) {
    record(checks, "runtime-config", false, error.message);
  }

  const schema2 = state?.schema === 2 && state.hosts && typeof state.hosts === "object";
  if (!schema2) {
    record(checks, "ownership-state", false, "installation ownership state is missing or invalid");
    return { ok: false, checks, hosts: [] };
  }

  for (const hostId of selectedHosts(options, state.hosts)) {
    const owned = state.hosts[hostId];
    if (!owned) {
      record(checks, "host-launcher", false, "host is not owned", hostId);
      continue;
    }
    if (owned.kind === "manual") {
      record(checks, "host-launcher", true, "manual snippets generated; host configuration remains user-managed", hostId);
      continue;
    }
    if (owned.kind === "cli") {
      const ok = runtime !== undefined
        && validLauncher(owned.launcher, defaultProxyPath, configPath, runtime)
        && await exists(owned.launcher.command)
        && await verifyCli(owned, options);
      record(checks, "host-launcher", ok, ok
        ? "host CLI reports the exact owned proxy launcher"
        : "host CLI did not confirm the exact owned proxy launcher", hostId);
      continue;
    }
    try {
      const source = await readFile(owned.configPath, "utf8");
      const view = inspectHost(hostId, source, owned.launcher, {
        cwd: options.cwd,
        env: options.env,
        scope: owned.scope,
        configPath: owned.configPath,
      });
      const ok = runtime !== undefined
        && view.configured
        && validLauncher(owned.launcher, defaultProxyPath, configPath, runtime)
        && await exists(owned.launcher.command);
      record(checks, "host-launcher", ok, ok
        ? "host contains the exact owned proxy launcher"
        : "host launcher differs from ownership or runtime configuration", hostId);
    } catch (error) {
      record(checks, "host-launcher", false, error.message, hostId);
    }
  }

  return {
    ok: checks.every(({ ok }) => ok),
    checks,
    hosts: Object.keys(state.hosts),
  };
}

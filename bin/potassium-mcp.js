#!/usr/bin/env node
import { brokerStatus, restartBroker, stopBroker } from "../src/broker.js";
import { doctor } from "../src/doctor.js";
import { HOST_IDS } from "../src/hosts.js";
import { verify } from "../src/verify.js";
import { createInterface } from "node:readline/promises";
import { install, repair, rotateToken, uninstall } from "../src/install.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const help = `Potassium MCP

Usage: potassium-mcp <setup|install|repair|rotate-token|doctor|verify|uninstall|broker|help> [options]

Setup:
  potassium-mcp setup [options]
  Prompts for one or more supported hosts. It never selects or changes a host until you choose it.

Broker usage:
  potassium-mcp broker <status|restart|stop> [--install-root <path>] [--wait <milliseconds>] [--json]
  Restart and stop wait up to 30000 milliseconds for an active request to finish; use --wait 0 to refuse immediately.

Options:
  --workspace <path>
  --autoexec <path>
  --install-root <path>
  --host <omp|codex|claude-code|claude-desktop|vscode|cursor|gemini|manual> (repeatable)
  --scope <user|project|local>
  --mcp-config <path> (one file-backed host only)
  --package-source <spec-or-path>
  --allow-unsafe-execute (trusted local admin; install/repair only)
  --no-unsafe-execute (explicitly revoke trusted admin execution)
  --admin-host <host-id> (repeatable per-host admin grant; install/repair only)
  --deny-read-host <host-id> (repeatable per-host read denial; install/repair only)
  --execute-host <host-id> (repeatable; requires --allow-unsafe-execute)
  --streamable-http (authenticated loopback HTTP MCP endpoint; install/repair only)
  --no-streamable-http (explicitly disable stateless HTTP)
  --no-stateful-http (explicitly disable stateful HTTP/SSE)
  --stateful-http (stateful authenticated HTTP/SSE sessions; install/repair only)
  --streamable-http-port <1..65535> (requires --streamable-http)
  --http-admin (grant HTTP admin tools; install/repair only)
  --http-execute (grant HTTP raw tools; requires --allow-unsafe-execute)
  --http-no-read (deny HTTP read tools; install/repair only)
  --builtin-fallback-token-file <path> (enable diagnostic-only built-in fallback)
  --no-builtin-fallback (explicitly disable built-in diagnostics)
  --all (uninstall every owned host)
  --wait <milliseconds> (broker lifecycle only)
  rotate-token stops an owned broker, rotates only the custom token, restarts it, and requires executor reattach.
  --json
`;

function parse(argv) {
  const [command = "help", ...initialRest] = argv;
  const [brokerCommand, ...rest] = command === "broker" ? initialRest : [undefined, ...initialRest];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag === "--no-unsafe-execute") {
      options.allowUnsafeExecute = false;
      continue;
    }
    if (flag === "--allow-unsafe-execute") {
      options.allowUnsafeExecute = true;
      continue;
    }
    if (flag === "--streamable-http") {
      options.streamableHttpEnabled = true;
      continue;
    }
    if (flag === "--no-streamable-http") {
      options.streamableHttpEnabled = false;
      continue;
    }
    if (flag === "--stateful-http") {
      options.statefulHttpEnabled = true;
      continue;
    }
    if (flag === "--no-stateful-http") {
      options.statefulHttpEnabled = false;
      continue;
    }
    if (flag === "--http-admin") {
      options.httpAdmin = true;
      continue;
    }
    if (flag === "--http-execute") {
      options.httpExecute = true;
      continue;
    }
    if (flag === "--http-no-read") {
      options.httpRead = false;
      continue;
    }
    if (flag === "--no-builtin-fallback") {
      options.builtinFallbackEnabled = false;
      continue;
    }
    if (flag === "--all") {
      options.all = true;
      continue;
    }
    const key = {
      "--workspace": "workspaceRoot",
      "--install-root": "installRoot",
      "--autoexec": "autoexecRoot",
      "--mcp-config": "mcpConfigPath",
      "--package-source": "packageSource",
      "--scope": "scope",
      "--host": "host",
      "--admin-host": "adminHost",
      "--execute-host": "executeHost",
      "--deny-read-host": "denyReadHost",
      "--builtin-fallback-token-file": "builtinFallbackTokenFile",
      "--wait": "waitMs",
      "--streamable-http-port": "streamableHttpPort",
    }[flag];
    if (!key || !rest[index + 1]) throw new Error(`unknown or incomplete option: ${flag}`);
    const value = rest[++index];
    if (key === "waitMs") {
      if (!/^\d+$/.test(value)) throw new Error("--wait requires milliseconds");
      options.waitMs = Number(value);
    } else if (key === "streamableHttpPort") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 65535) {
        throw new Error("--streamable-http-port requires an integer from 1 through 65535");
      }
      options.streamableHttpPort = Number(value);
    } else if (key === "host" || key === "adminHost" || key === "executeHost" || key === "denyReadHost") (options[key] ??= []).push(value);
    else options[key] = value;
  }
  if (options.streamableHttpPort !== undefined && options.streamableHttpEnabled !== true) {
    throw new Error("--streamable-http-port requires --streamable-http");
  }
  if ((options.streamableHttpEnabled === true || options.streamableHttpPort !== undefined || options.statefulHttpEnabled === true)
    && !["install", "repair"].includes(command)) {
    throw new Error("--streamable-http and --stateful-http options are valid only for install or repair");
  }
  const installOnly = options.streamableHttpEnabled !== undefined
    || options.streamableHttpPort !== undefined
    || options.statefulHttpEnabled !== undefined
    || options.httpAdmin === true
    || options.httpExecute === true
    || options.builtinFallbackTokenFile !== undefined
    || options.builtinFallbackEnabled === false
    || options.adminHost !== undefined
    || options.denyReadHost !== undefined
    || options.httpRead === false
    || options.executeHost !== undefined
    || options.allowUnsafeExecute !== undefined;
  if (installOnly && !["install", "repair"].includes(command)) {
    throw new Error("transport and policy options are valid only for install or repair");
  }
  if ((options.httpAdmin === true || options.httpExecute === true || options.adminHost?.length || options.executeHost?.length)
    && options.allowUnsafeExecute !== true) {
    throw new Error("admin and execute grants require --allow-unsafe-execute");
  }
  return { command, brokerCommand, options };
}

/** Prompt terminal users to make an explicit, provider-neutral host selection. */
export async function selectSetupHosts(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!options.allowNonInteractive && (!input.isTTY || !output.isTTY)) throw new Error("setup requires an interactive terminal; use install --host <host> for automation");
  const prompt = options.prompt ?? (async () => {
    const terminal = createInterface({ input, output });
    try { return await terminal.question(`Choose one or more hosts (${HOST_IDS.join(", ")}), comma-separated: `); } finally { terminal.close(); }
  });
  const selected = [...new Set(String(await prompt()).split(",").map((item) => item.trim()).filter(Boolean))];
  if (selected.length === 0) throw new Error("select at least one host");
  for (const host of selected) if (!HOST_IDS.includes(host)) throw new Error(`unsupported MCP host: ${host}`);
  return selected;
}

export async function setup(options = {}) {
  if (options.host?.length) throw new Error("setup always prompts for hosts; use install --host for deterministic automation");
  return install({ ...options, host: await selectSetupHosts(options) });
}

export function human(value, command) {
  if (typeof value === "string") return value;
  if (command === "broker") {
    const active = value.active ? `; active ${value.active.method} since ${value.active.startedAt}` : "";
    const http = value.streamableHttp?.endpoint ? `; HTTP ${value.streamableHttp.endpoint}` : "";
    return `Broker ${value.status}: PID ${value.pid ?? "n/a"}; version ${value.version ?? "n/a"}; config ${value.configDigest ?? "n/a"}; readiness ${value.readiness}${active}${http}`;
  }
  if (command === "doctor") {
    return value.checks
      .map((check) => `[${check.ok ? "ok" : "fail"}] ${check.host ? `${check.host} ` : ""}${check.name}: ${check.detail}`)
      .join("\n");
  }
  if (command === "verify") {
    const staticState = value.static?.ok ? "ready" : `failed: ${value.static?.reason ?? "unknown"}`;
    return `Static verification: ${staticState}\nLive MCP verification: ${value.live?.state ?? "not-started"}`;
  }
  if (command === "uninstall") {
    return `Potassium MCP uninstalled from ${value.hosts?.join(", ") ?? "selected hosts"}.${value.sharedRetained
      ? " Shared runtime was retained."
      : " Shared runtime was removed; token, artifacts, and unrelated configuration were preserved."}`;
  }
  if (command === "rotate-token") {
    return `Potassium MCP token rotated.${value.executorReattachRequired ? " Restart/re-attach Potassium to load the new credential." : ""}`;
  }
  const lines = [
    `Potassium MCP ${command === "repair" ? "repaired" : "installed"}.`,
    `Runtime: ${value.installRoot}`,
    `Workspace: ${value.workspaceRoot}`,
    `Hosts: ${value.hosts?.map((host) => host.id).join(", ")}`,
  ];
  for (const host of value.hosts?.filter(({ kind }) => kind === "manual") ?? []) {
    lines.push(
      `Manual configuration required: ${host.id}`,
      "JSON:",
      host.json,
      "TOML:",
      host.toml,
    );
  }
  return lines.join("\n");
}

const emit = (value, json, command) => process.stdout.write(
  json ? `${JSON.stringify(value)}\n` : `${human(value, command)}\n`,
);

function isCliMain() {
  try {
    return process.argv[1] !== undefined
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, brokerCommand, options } = parse(argv);
    if (command === "help") emit(help, false, command);
    else if (command === "setup") emit(await setup(options), options.json, command);
    else if (command === "install") emit(await install(options), options.json, command);
    else if (command === "repair") emit(await repair(options), options.json, command);
    else if (command === "doctor") {
      const result = await doctor(options);
      emit(result, options.json, command);
      if (!result.ok) process.exitCode = 1;
    } else if (command === "verify") {
      const result = await verify(options);
      emit(result, options.json, command);
      if (!result.ok) process.exitCode = 1;
    } else if (command === "broker") {
      if (brokerCommand === "status") emit(await brokerStatus(options), options.json, command);
      else if (brokerCommand === "restart") emit(await restartBroker(options), options.json, command);
      else if (brokerCommand === "stop") emit(await stopBroker(options), options.json, command);
      else throw new Error("broker requires status, restart, or stop");
    } else if (command === "rotate-token") emit(await rotateToken(options), options.json, command);
    else if (command === "uninstall") emit(await uninstall(options), options.json, command);
    else throw new Error(`unknown command: ${command}`);
  } catch (error) {
    const json = argv.includes("--json");
    process.stderr.write(json
      ? `${JSON.stringify({ ok: false, error: error.message })}\n`
      : `potassium-mcp: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (isCliMain()) await main();

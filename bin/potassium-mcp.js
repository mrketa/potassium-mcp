#!/usr/bin/env node
import { brokerStatus, restartBroker } from "../src/broker.js";
import { doctor } from "../src/doctor.js";
import { install, repair, uninstall } from "../src/install.js";
import { HOST_IDS } from "../src/hosts.js";
import { verify } from "../src/verify.js";
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const help = `Potassium MCP

Usage: potassium-mcp <setup|install|repair|doctor|verify|uninstall|broker|help> [options]

Setup:
  potassium-mcp setup [options]
  Prompts for one or more supported hosts. It never selects or changes a host until you choose it.

Broker usage:
  potassium-mcp broker <status|restart> [--install-root <path>] [--wait <milliseconds>] [--json]
  Restart waits up to 30000 milliseconds for an active request to finish; use --wait 0 to refuse immediately.

Options:
  --workspace <path>
  --install-root <path>
  --host <codex|claude-code|claude-desktop|vscode|cursor|gemini|manual> (repeatable; required by install, repair, and uninstall unless --all)
  --scope <user|project|local>
  --mcp-config <path> (one file-backed host only)
  --package-source <spec-or-path>
  --allow-unsafe-execute (trusted local admin; install/repair only)
  --all (uninstall every owned host)
  --wait <milliseconds> (broker restart only)
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
    if (flag === "--allow-unsafe-execute") {
      options.allowUnsafeExecute = true;
      continue;
    }
    if (flag === "--all") {
      options.all = true;
      continue;
    }
    const key = {
      "--workspace": "workspaceRoot",
      "--install-root": "installRoot",
      "--mcp-config": "mcpConfigPath",
      "--package-source": "packageSource",
      "--scope": "scope",
      "--host": "host",
      "--wait": "waitMs",
    }[flag];
    if (!key || !rest[index + 1]) throw new Error(`unknown or incomplete option: ${flag}`);
    const value = rest[++index];
    if (key === "waitMs") {
      if (!/^\d+$/.test(value)) throw new Error("--wait requires milliseconds");
      options.waitMs = Number(value);
    } else if (key === "host") (options.host ??= []).push(value);
    else options[key] = value;
  }
  return { command, brokerCommand, options };
}

/** Prompt terminal users to make an explicit, provider-neutral host selection. */
export async function selectSetupHosts(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!options.allowNonInteractive && (!input.isTTY || !output.isTTY)) {
    throw new Error("setup requires an interactive terminal; use install --host <host> for automation");
  }
  const prompt = options.prompt ?? (async () => {
    const terminal = createInterface({ input, output });
    try {
      return await terminal.question(`Choose one or more hosts (${HOST_IDS.join(", ")}), comma-separated: `);
    } finally {
      terminal.close();
    }
  });
  const answer = await prompt();
  const selected = [...new Set(String(answer).split(",").map((item) => item.trim()).filter(Boolean))];
  if (selected.length === 0) throw new Error("select at least one host");
  for (const host of selected) {
    if (!HOST_IDS.includes(host)) throw new Error(`unsupported MCP host: ${host}`);
  }
  return selected;
}

export async function setup(options = {}) {
  if (options.host?.length) throw new Error("setup always prompts for hosts; use install --host for deterministic automation");
  const hosts = await selectSetupHosts(options);
  return install({ ...options, host: hosts });
}

export function human(value, command) {
  if (typeof value === "string") return value;
  if (command === "broker") {
    const active = value.active ? `; active ${value.active.method} since ${value.active.startedAt}` : "";
    return `Broker ${value.status}: PID ${value.pid ?? "n/a"}; version ${value.version ?? "n/a"}; config ${value.configDigest ?? "n/a"}; readiness ${value.readiness}${active}`;
  }
  if (command === "doctor") {
    return value.checks
      .map((check) => `[${check.ok ? "ok" : "fail"}] ${check.host ? `${check.host} ` : ""}${check.name}: ${check.detail}`)
      .join("\n");
  }
  if (command === "verify") {
    const staticState = value.static?.ok ? "ready" : `failed: ${value.static?.reason ?? "unknown"}`;
    const liveState = value.live?.state ?? "not-started";
    return `Static verification: ${staticState}\nLive MCP verification: ${liveState}`;
  }
  if (command === "uninstall") {
    return `Potassium MCP uninstalled from ${value.hosts?.join(", ") ?? "selected hosts"}.${value.sharedRetained
      ? " Shared runtime was retained."
      : " Shared runtime was removed; token, artifacts, and unrelated configuration were preserved."}`;
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
      "Optional Streamable HTTP:",
      host.http,
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
      else throw new Error("broker requires status or restart");
    } else if (command === "uninstall") emit(await uninstall(options), options.json, command);
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

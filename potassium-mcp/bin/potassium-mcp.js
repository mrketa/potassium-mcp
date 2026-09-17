#!/usr/bin/env node
import { brokerStatus, restartBroker, stopBroker } from "../src/broker.js";
import { doctor } from "../src/doctor.js";
import { printConfig, registerHost, removeHost, repair, rotateToken, setup, uninstall } from "../src/install.js";
import { assertHostId } from "../src/host-policy.js";
import { resolveConfigPath } from "../src/paths.js";
import { runProxy } from "../src/proxy.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const help = `Potassium MCP

Usage:
  potassium-mcp serve --host-id <id> [--config <path> | --install-root <path>]
  potassium-mcp setup --workspace <path> [--install-root <path>] [--dry-run] [--json]
  potassium-mcp config print --host-id <id> [--config <path> | --install-root <path>] [--npm] [--json]
  potassium-mcp host <add|remove> --host <adapter> --host-id <id> [--scope <scope>] [--json]
  potassium-mcp repair [--install-root <path>] [--dry-run] [--json]
  potassium-mcp doctor [--install-root <path> | --config <path>] [--host-id <id>] [--probe] [--json]
  potassium-mcp uninstall --all [--install-root <path>] [--dry-run] [--json]
  potassium-mcp rotate-token [--install-root <path>] [--json]
  potassium-mcp broker <status|restart|stop> [--install-root <path>] [--wait <milliseconds>] [--json]
  potassium-mcp help

serve uses the existing shared broker and never performs setup. Its stdout is MCP only.
Install/update the package with npm separately; setup never installs or copies npm packages.
config print emits a standard command/args/env JSON entry without credentials.
--npm prints a version-pinned npx entry instead of the installed public executable.
Host IDs start with a lowercase letter, followed by lowercase letters, digits, _ or - (64 maximum).
Use a distinct configured host ID for each project or host policy.

Path precedence:
  --config > --install-root > POTASSIUM_MCP_CONFIG > POTASSIUM_MCP_INSTALL_ROOT > default.
  Default private root: LOCALAPPDATA/Potassium/MCP, or ~/.local/share/Potassium/MCP.
  Environment paths must be absolute. Explicit relative options use the invocation directory;
  paths inside config.json are relative to that config file, not the invocation directory.

Setup/repair options:
  --workspace <path>                    Executor workspace; required on first setup
  --runtime-root <path>                 Explicit migration to an external installed package
  --initial-full-access-host <id>       Initialize one host with read/admin/execute and unsafe execution
                                       on first setup only; never changes existing access
  --allow-unsafe-execute | --no-unsafe-execute
  --read-host <id>                      Repeatable explicit read-only identity/grant
  --admin-host <id>                     Repeatable independent admin grant
  --deny-read-host <id>                 Repeatable read denial
  --execute-host <id>                   Repeatable; requires --allow-unsafe-execute
  --streamable-http | --no-streamable-http
  --stateful-http | --no-stateful-http
  --streamable-http-port <1..65535>      Requires --streamable-http
  --http-admin | --http-no-read         Independent HTTP capabilities
  --http-execute                       Requires --allow-unsafe-execute
  --builtin-fallback-token-file <path>  Distinct diagnostic-only built-in credential
  --no-builtin-fallback
  --native-editor-token-file <path>     Enable desktop editor tools with a separate native credential
  --no-native-editor                   Disable editor tools without changing execution grants

Host options:
  --host <omp|codex|claude-code|claude-desktop|vscode|cursor|gemini|manual>
  --host-id <id>
  --scope <user|project|local>
  --mcp-config <path>                   One file-backed host's config
  --dry-run                            Plan only: no writes, locks, tokens or restarts

uninstall --all removes owned deployment/registrations, retaining tokens, artifacts and recovery metadata.
It never deletes the externally installed npm package. Use host remove for one registration.
Broker restart/stop wait up to 30000 ms for active work; --wait 0 refuses immediately.
doctor is static by default; --probe explicitly checks configured host CLIs and broker readiness.
rotate-token stops an owned broker, rotates only the custom token and restarts it; executor reattach is required.
--help shows this help. --json makes management output and stderr errors machine-readable.
`;

const valueOptions = {
  "--workspace": "workspaceRoot", "--install-root": "installRoot", "--config": "configFile",
  "--runtime-root": "runtimeRoot", "--mcp-config": "mcpConfigPath", "--scope": "scope",
  "--host": "host", "--host-id": "hostId", "--admin-host": "adminHost",
  "--execute-host": "executeHost", "--deny-read-host": "denyReadHost", "--read-host": "readHost",
  "--builtin-fallback-token-file": "builtinFallbackTokenFile", "--wait": "waitMs",
  "--native-editor-token-file": "nativeEditorTokenFile",
  "--streamable-http-port": "streamableHttpPort",
  "--initial-full-access-host": "initialFullAccessHost",
};
const booleanOptions = {
  "--help": ["help", true], "--json": ["json", true], "--dry-run": ["dryRun", true], "--probe": ["probe", true],
  "--npm": ["npm", true], "--all": ["all", true],
  "--no-unsafe-execute": ["allowUnsafeExecute", false], "--allow-unsafe-execute": ["allowUnsafeExecute", true],
  "--streamable-http": ["streamableHttpEnabled", true], "--no-streamable-http": ["streamableHttpEnabled", false],
  "--stateful-http": ["statefulHttpEnabled", true], "--no-stateful-http": ["statefulHttpEnabled", false],
  "--http-admin": ["httpAdmin", true], "--http-execute": ["httpExecute", true],
  "--http-no-read": ["httpRead", false], "--no-builtin-fallback": ["builtinFallbackEnabled", false],
  "--no-native-editor": ["nativeEditorEnabled", false],
};
const repeatable = new Set(["readHost", "adminHost", "executeHost", "denyReadHost"]);
const setupOptions = ["workspaceRoot", "runtimeRoot", "initialFullAccessHost", "allowUnsafeExecute", "readHost", "adminHost", "executeHost", "denyReadHost",
  "streamableHttpEnabled", "statefulHttpEnabled", "streamableHttpPort", "httpAdmin", "httpExecute", "httpRead",
  "builtinFallbackTokenFile", "builtinFallbackEnabled", "nativeEditorTokenFile", "nativeEditorEnabled"];
const commandOptions = {
  serve: ["configFile", "hostId"],
  setup: [...setupOptions, "dryRun"],
  repair: [...setupOptions, "dryRun"],
  config: ["configFile", "hostId", "npm"],
  host: ["host", "hostId", "scope", "mcpConfigPath", "dryRun"],
  doctor: ["configFile", "hostId", "probe"],
  uninstall: ["all", "dryRun"],
  "rotate-token": [],
  broker: ["waitMs"],
  help: [],
};

function parse(argv) {
  const [first = "help", ...rest] = argv;
  const command = first === "--help" ? "help" : first;
  const subcommand = ["broker", "config", "host"].includes(command) && rest[0] && !rest[0].startsWith("--")
    ? rest.shift() : undefined;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const boolean = booleanOptions[flag];
    const key = boolean?.[0] ?? valueOptions[flag];
    if (!key) throw new Error(`unknown option: ${flag}`);
    if (Object.hasOwn(options, key) && !repeatable.has(key)) throw new Error(`${flag} may be specified only once`);
    if (boolean) {
      options[key] = boolean[1];
      continue;
    }
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`unknown or incomplete option: ${flag}`);
    if (key === "waitMs") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--wait requires integer milliseconds");
      options[key] = Number(value);
    } else if (key === "streamableHttpPort") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 65535) throw new Error("--streamable-http-port requires an integer from 1 through 65535");
      options[key] = Number(value);
    } else if (repeatable.has(key)) (options[key] ??= []).push(value);
    else options[key] = value;
  }
  if (!Object.hasOwn(commandOptions, command)) throw new Error(`unknown command: ${command}`);
  if (options.help) return { command: "help", options: { json: options.json } };
  const allowed = new Set(["installRoot", "json", ...commandOptions[command]]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`option ${Object.entries(valueOptions).find(([, value]) => value === key)?.[0]
      ?? Object.entries(booleanOptions).find(([, value]) => value[0] === key)?.[0]} is not valid for ${command}`);
  }
  if (command === "config" && subcommand !== "print") throw new Error("config requires print");
  if (command === "host" && !["add", "remove"].includes(subcommand)) throw new Error("host requires add or remove");
  if (command === "broker" && !["status", "restart", "stop"].includes(subcommand)) throw new Error("broker requires status, restart, or stop");
  if (["serve", "config", "host"].includes(command)) {
    if (options.hostId === undefined) throw new Error("--host-id requires an explicit normalized host ID");
    assertHostId(options.hostId);
  }
  if (command === "doctor" && options.hostId !== undefined) assertHostId(options.hostId);
  if (options.initialFullAccessHost !== undefined) assertHostId(options.initialFullAccessHost);
  if (command === "host" && options.host === undefined) throw new Error("host add/remove requires --host <adapter>");
  if (options.scope !== undefined && !["user", "project", "local"].includes(options.scope)) throw new Error("--scope requires user, project, or local");
  if (command === "uninstall" && !options.all) throw new Error("uninstall requires --all; use host remove for one registration");
  if (options.streamableHttpPort !== undefined && options.streamableHttpEnabled !== true) throw new Error("--streamable-http-port requires --streamable-http");
  if ((options.httpExecute === true || options.executeHost?.length) && options.allowUnsafeExecute !== true) {
    throw new Error("execute grants require --allow-unsafe-execute");
  }
  for (const key of repeatable) for (const id of options[key] ?? []) assertHostId(id);
  return { command, subcommand, options };
}

export function human(value, command) {
  if (typeof value === "string") return value;
  if (value.dryRun) return JSON.stringify(value, null, 2);
  if (command === "broker") {
    const active = value.active ? `; active ${value.active.method} since ${value.active.startedAt}` : "";
    const http = value.streamableHttp?.endpoint ? `; HTTP ${value.streamableHttp.endpoint}` : "";
    return `Broker ${value.status}: PID ${value.pid ?? "n/a"}; version ${value.version ?? "n/a"}; config ${value.configDigest ?? "n/a"}; readiness ${value.readiness}${active}${http}`;
  }
  if (command === "doctor") {
    return [
      `Configured: ${value.configured === true ? "yes" : "no"}; ready: ${value.ready === true ? "yes" : "no"}; actually checked: ${value.actuallyChecked === true ? "yes" : "no"}.`,
      ...(value.versionDrift ? ["Runtime version drift detected; verify the installed package with setup."] : []),
      ...(value.restartRequired ? ["Broker restart required."] : []),
      ...value.checks.map((check) => `[${check.ok ? "ok" : "fail"}] ${check.host ? `${check.host} ` : ""}${check.name}: ${check.detail}`),
    ].join("\n");
  }
  if (command === "uninstall") return "Potassium MCP deployment removed. External package, token, artifacts and ownership recovery metadata were preserved.";
  if (command === "rotate-token") return `Potassium MCP token rotated.${value.executorReattachRequired ? " Restart/re-attach Potassium to load the new credential." : ""}`;
  if (command === "host remove") return `Potassium MCP host registration removed: ${value.hostId ?? value.hosts?.join(", ") ?? "requested host"}.`;
  const lines = [
    `Potassium MCP ${command === "repair" ? "repaired" : command === "host add" ? "host registered" : "setup complete"}.`,
    ...(value.installRoot ? [`Private data: ${value.installRoot}`] : []),
    ...(value.workspaceRoot ? [`Workspace: ${value.workspaceRoot}`] : []),
    ...(value.hosts?.length ? [`Hosts: ${value.hosts.map((host) => typeof host === "string" ? host : host.id).join(", ")}`] : []),
  ];
  for (const host of value.hosts?.filter((host) => host.kind === "manual") ?? []) {
    lines.push(`User-managed host: ${host.id}; registration unchanged.`, "Suggested stdio launcher:", JSON.stringify(host.launcher, null, 2));
  }
  return lines.join("\n");
}

const emit = (value, json, command) => {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human(value, command)}\n`);
  if (!json) {
    for (const warning of value?.warnings ?? []) process.stderr.write(`potassium-mcp: warning: ${warning}\n`);
  }
};

function diagnostic(error, json) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error?.code === "string" ? error.code : undefined;
  let acl;
  const seen = new Set();
  for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (cause.code === "MCP_ACL_PRESERVE_FAILED" && cause.acl) { acl = cause.acl; break; }
  }
  const advice = acl?.requiresElevation
    ? "\nClose Setup, run the same installer as administrator, and retry. This does not require running MCP clients as administrator."
    : "";
  const detail = acl ? `\nAffected path: ${acl.path}\nWindows ACL error (${acl.operation}): ${acl.message}${advice}` : "";
  process.stderr.write(json ? `${JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}), ...(acl ? { acl } : {}) })}\n` : `potassium-mcp: ${message}${detail}\n`);
  process.exitCode = 1;
}

function isCliMain() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, subcommand, options } = parse(argv);
    if (command === "help") emit(options.json ? { help } : help, options.json, command);
    else if (command === "serve") await runProxy({
      ...options,
      configFile: resolveConfigPath(options),
      logError: (error) => diagnostic(error, options.json),
    });
    else if (command === "setup") emit(await setup(options), options.json, command);
    else if (command === "repair") emit(await repair(options), options.json, command);
    else if (command === "config") emit(await printConfig(options), true, command);
    else if (command === "host") {
      emit(await (subcommand === "add" ? registerHost : removeHost)(options), options.json, `host ${subcommand}`);
    } else if (command === "doctor") {
      const result = await doctor(options);
      emit(result, options.json, command);
      if (!result.ok) process.exitCode = 1;
    } else if (command === "broker") {
      const operation = { status: brokerStatus, restart: restartBroker, stop: stopBroker }[subcommand];
      emit(await operation(options), options.json, command);
    } else if (command === "rotate-token") emit(await rotateToken(options), options.json, command);
    else if (command === "uninstall") emit(await uninstall(options), options.json, command);
  } catch (error) {
    diagnostic(error, argv.includes("--json"));
  }
}

if (isCliMain()) await main();

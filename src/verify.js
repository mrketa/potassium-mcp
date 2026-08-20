import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installationPaths } from "./install.js";

const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);

function requestedHosts(options, records) {
  const requested = options.hosts ?? options.host;
  if (requested === undefined) return Object.keys(records);
  return [...new Set(Array.isArray(requested) ? requested : [requested])];
}

function staticResult(options, state, value) {
  const hostIds = requestedHosts(options, state?.hosts ?? {});
  if (state?.schema !== 2 || !state.hosts || typeof state.hosts !== "object") {
    return { ok: false, reason: "installation ownership state is missing or invalid", hosts: hostIds };
  }
  if (hostIds.length === 0) return { ok: false, reason: "no owned host is available to verify", hosts: [] };
  const records = hostIds.map((id) => ({ id, record: state.hosts[id] })).filter(({ record }) => record);
  if (records.length !== hostIds.length) {
    return { ok: false, reason: "requested host is not owned", hosts: hostIds };
  }
  const owned = records[0];
  const expectedProxy = path.join(value.appPath, "node_modules", "@mrketa", "potassium-mcp", "src", "proxy.js");
  const launcher = owned.record.launcher;
  const exact = launcher?.type === "stdio"
    && typeof launcher.command === "string"
    && Array.isArray(launcher.args)
    && launcher.args.length === 5
    && launcher.args[0] === expectedProxy
    && launcher.args[1] === "--config"
    && launcher.args[2] === value.configPath
    && launcher.args[3] === "--host-id"
    && launcher.args[4] === owned.id;
  return {
    ok: exact,
    reason: exact ? undefined : "owned launcher does not reference the installed proxy and configuration",
    host: owned.id,
    hosts: hostIds,
    launcher: exact ? launcher : undefined,
    proxyPath: expectedProxy,
    configPath: value.configPath,
  };
}

function toolValue(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  try {
    return JSON.parse(result?.content?.find((item) => item.type === "text")?.text ?? "null");
  } catch {
    return null;
  }
}

/** Verify the installed, owned stdio proxy without reading or reporting credentials. */
export async function verify(options = {}) {
  const value = installationPaths(options);
  let state;
  try {
    state = JSON.parse(await readFile(value.statePath, "utf8"));
  } catch (error) {
    return { ok: false, static: { ok: false, reason: error.message }, live: { ok: false, state: "not-started" } };
  }
  const staticCheck = staticResult(options, state, value);
  if (!staticCheck.ok) return { ok: false, static: staticCheck, live: { ok: false, state: "not-started" } };
  if (!await exists(staticCheck.launcher.command) || !await exists(staticCheck.proxyPath) || !await exists(staticCheck.configPath)) {
    return { ok: false, static: { ...staticCheck, ok: false, reason: "owned proxy, Node runtime, or configuration is missing", launcher: undefined }, live: { ok: false, state: "not-started" } };
  }

  const makeClient = options.makeClient ?? (() => new Client({ name: "potassium-mcp-verify", version: "0.10.0-beta.1" }));
  const makeTransport = options.makeTransport ?? ((launcher) => new StdioClientTransport({
    command: launcher.command,
    args: launcher.args,
    stderr: "pipe",
  }));
  let client;
  try {
    client = makeClient();
    await client.connect(makeTransport(staticCheck.launcher));
    const [statusResult, capabilitiesResult] = await Promise.all([
      client.callTool({ name: "potassium_status", arguments: {} }),
      client.callTool({ name: "potassium_capabilities", arguments: {} }),
    ]);
    const status = toolValue(statusResult);
    const capabilities = toolValue(capabilitiesResult);
    if (statusResult?.isError || capabilitiesResult?.isError) {
      return { ok: false, static: { ...staticCheck, launcher: undefined }, live: { ok: false, state: "error", connected: false } };
    }
    return {
      ok: true,
      static: { ...staticCheck, launcher: undefined },
      live: {
        ok: true,
        state: status?.connected === true ? "connected" : "unattached",
        connected: status?.connected === true,
        capabilities: capabilities !== null,
      },
    };
  } catch (error) {
    return { ok: false, static: { ...staticCheck, launcher: undefined }, live: { ok: false, state: "error", error: error.message } };
  } finally {
    await client?.close?.().catch(() => {});
  }
}

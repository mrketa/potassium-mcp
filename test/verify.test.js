import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verify } from "../src/verify.js";

async function fixture(t) {
  const installRoot = await mkdtemp(path.join(tmpdir(), "potassium-verify-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "potassium-workspace-"));
  const proxyPath = path.join(installRoot, "app", "node_modules", "@mrketa", "potassium-mcp", "src", "proxy.js");
  const configPath = path.join(installRoot, "config.json");
  await mkdir(path.dirname(proxyPath), { recursive: true });
  await writeFile(proxyPath, "// owned proxy\n");
  await writeFile(configPath, "{}\n");
  await writeFile(path.join(installRoot, "ownership.json"), JSON.stringify({
    schema: 2,
    hosts: { manual: { launcher: { type: "stdio", command: process.execPath, args: [proxyPath, "--config", configPath, "--host-id", "manual"] } } },
  }));
  t.after(() => Promise.all([rm(installRoot, { recursive: true, force: true }), rm(workspaceRoot, { recursive: true, force: true })]));
  return { installRoot, workspaceRoot };
}

function clientFor(connected) {
  return {
    async connect() {},
    async close() {},
    async callTool({ name }) {
      return { structuredContent: name === "potassium_status" ? { connected } : { methods: [] } };
    },
  };
}

test("verify reports a connected live MCP without exposing the launcher", async (t) => {
  const options = await fixture(t);
  const result = await verify({ ...options, makeClient: () => clientFor(true), makeTransport: () => ({}) });
  assert.equal(result.ok, true);
  assert.equal(result.static.ok, true);
  assert.equal(result.static.launcher, undefined);
  assert.deepEqual(result.live, { ok: true, state: "connected", connected: true, capabilities: true });
});

test("verify distinguishes an initialized but unattached bridge", async (t) => {
  const options = await fixture(t);
  const result = await verify({ ...options, makeClient: () => clientFor(false), makeTransport: () => ({}) });
  assert.equal(result.ok, true);
  assert.equal(result.live.state, "unattached");
  assert.equal(result.live.connected, false);
});

test("verify reports initialization failures as live errors", async (t) => {
  const options = await fixture(t);
  const result = await verify({
    ...options,
    makeClient: () => ({ async connect() { throw new Error("proxy unavailable"); }, async close() {} }),
    makeTransport: () => ({}),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.live, { ok: false, state: "error", error: "proxy unavailable" });
});

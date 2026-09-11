import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { acquireInstallLock } from "../src/install.js";

const token = "detached-state-regression-token-at-least-thirty-two-characters";
const brokerPath = fileURLToPath(new URL("../src/broker.js", import.meta.url));
const waitFor = async (read, predicate, diagnostics = () => "") => {
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Detached broker state did not reach the expected transition; last=${JSON.stringify(last)}; ${diagnostics()}`);
};

async function detachedFixture(t, failState = false, renameFailures = 0, beforeSpawn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium detached state "));
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "broker-state.json");
  const preload = path.join(root, "test-lifecycle.mjs");
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1", port: 0, proxyPort: 0, token, requestTimeoutMs: 10000,
    maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 100,
    proxyMaxFrameBytes: 65536, proxyHandshakeTimeoutMs: 1000,
    streamableHttpEnabled: true, streamableHttpHost: "127.0.0.1", streamableHttpPort: 0,
  }));
  const previousState = '{"preserved":true}\n';
  if (renameFailures) await writeFile(statePath, previousState);
  const sharingFault = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalRename = fs.promises.rename;
let failures = ${Number.isFinite(renameFailures) ? renameFailures : "Infinity"};
let runtimeFault;
process.on('message', async message => {
  if (message?.type !== 'arm-publication-denial') return;
  runtimeFault = {
    mode: message.mode, foreignBytes: message.foreignBytes,
    previousBytes: await fs.promises.readFile(${JSON.stringify(statePath)}, 'utf8'),
    denied: 0, attemptsPerPublication: process.platform === 'win32' ? 5 : 1,
  };
  process.send({ type: 'publication-denial-armed' });
});
fs.promises.rename = async (source, target) => {
  if (target === ${JSON.stringify(statePath)} && runtimeFault) {
    const fault = runtimeFault;
    if (await fs.promises.readFile(target, 'utf8') !== fault.previousBytes) throw new Error('Previous runtime state changed before atomic publication');
    fault.denied += 1;
    if (fault.mode === 'transient' && fault.denied === fault.attemptsPerPublication) runtimeFault = undefined;
    if (fault.mode === 'takeover' && fault.denied === fault.attemptsPerPublication + 1) {
      // Transfer ownership as the first final-republication attempt fails.
      // Its next rename retry must revalidate instead of replacing these bytes.
      await fs.promises.writeFile(target, fault.foreignBytes);
      runtimeFault = undefined;
    }
    throw Object.assign(new Error('Injected runtime publication denial'), { code: 'EPERM' });
  }
  if (target === ${JSON.stringify(statePath)} && failures-- > 0) {
    if (await fs.promises.readFile(target, 'utf8') !== ${JSON.stringify(previousState)}) throw new Error('Previous state changed before atomic publication');
    throw Object.assign(new Error('Injected Windows sharing denial'), { code: 'EPERM' });
  }
  return originalRename(source, target);
};
syncBuiltinESMExports();
`;
  // The watchdog bounds a pre-fix resource leak without sending OS signals.
  // The IPC command exercises the installed JS shutdown callback, not Windows
  // process.kill semantics; the authenticated management tests cover that fence.
  await writeFile(preload, `${sharingFault}setTimeout(() => process.exit(97), 10000).unref();\nprocess.on('message', message => { if (message === 'finish') { process.emit('SIGTERM'); process.disconnect(); } });\nprocess.channel?.unref();\n`);
  if (failState) await mkdir(statePath);
  const childEnv = { ...process.env, POTASSIUM_MCP_CONFIG: configPath, POTASSIUM_MCP_BROKER_STATE: statePath };
  delete childEnv.POTASSIUM_MCP_INSTALL_LEASE;
  Object.assign(childEnv, await beforeSpawn?.(root));
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, brokerPath, "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
    env: childEnv,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-10000); });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.connected) child.send("finish");
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  return {
    child, exited, root, statePath, stderr: () => stderr,
    readState: () => readFile(statePath, "utf8").then(JSON.parse).catch(() => null),
    async armPublicationDenial(mode, foreignBytes) {
      await waitFor(() => stderr, (value) => value.includes("proxy listening"));
      const armed = once(child, "message");
      child.send({ type: "arm-publication-denial", mode, foreignBytes });
      assert.equal((await armed)[0].type, "publication-denial-armed");
    },
  };
}

async function executor(t, endpoint) {
  const socket = new WebSocket(endpoint);
  t.after(() => socket.terminate());
  await once(socket, "open");
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "hello", protocol: 2, clientId: "b".repeat(32), generation: 1, clientNonce, client: { protocol: 2 } }));
  const [raw] = await once(socket, "message");
  const challenge = JSON.parse(raw.toString());
  const transcript = `potassium-mcp/v2|client|${clientNonce}|${challenge.serverNonce}`;
  const hash = createHash("sha256").update(transcript).digest("hex");
  const proof = createHmac("sha256", token).update(hash).digest("base64");
  socket.send(JSON.stringify({ type: "ack", protocol: 2, clientNonce, serverNonce: challenge.serverNonce, proof }));
  const [ready] = await once(socket, "message");
  assert.equal(JSON.parse(ready.toString()).type, "ready");
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", nonce: message.nonce }));
  });
  return socket;
}

function toolCall(endpoint, id, name) {
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }),
  }).then(async (response) => {
    const text = await response.text();
    const json = text.trim().startsWith("{") ? text : text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5);
    return { status: response.status, payload: JSON.parse(json) };
  });
}

test("detached broker startup persistence failure closes listeners and exits instead of appearing ready", { timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t, true);
  const [code] = await fixture.exited;
  assert.equal(code, 1, "a leaked listener would keep the child alive until watchdog exit 97");
  assert.equal(fixture.stderr().includes("proxy listening"), false);
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.startsWith("broker-state.json.")), []);
});

test("detached state retains all concurrent RPCs and the correct final idle snapshot", { timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t);
  const state = await waitFor(fixture.readState, (value) => value?.readiness === "ready");
  const endpoint = /Potassium listening on (ws:\/\/[^; ]+)/;
  const banner = await waitFor(() => fixture.stderr(), (value) => endpoint.test(value));
  const socket = await executor(t, banner.match(endpoint)[1]);
  const frames = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "request") frames.push(message);
  });
  const first = toolCall(state.streamableHttp.endpoint, 1, "potassium_client_state");
  const second = toolCall(state.streamableHttp.endpoint, 2, "potassium_diagnostic_snapshot");
  await waitFor(() => frames, (value) => value.length === 2);
  const busy = await waitFor(fixture.readState, (value) => value?.activeRequests?.length === 2);
  assert.deepEqual(busy.activeRequests.map(({ method }) => method).sort(), ["client_state", "diagnostic_snapshot"]);
  const short = frames.find(({ method }) => method === "diagnostic_snapshot");
  socket.send(JSON.stringify({ type: "response", id: short.id, ok: true, result: {} }));
  const shortResult = await second;
  assert.equal(shortResult.status, 200);
  assert.equal(shortResult.payload.result.isError ?? false, false, JSON.stringify(shortResult.payload));
  const remaining = await waitFor(fixture.readState, (value) => value?.activeRequests?.length === 1, fixture.stderr);
  assert.equal(remaining.active.method, "client_state");
  const long = frames.find(({ method }) => method === "client_state");
  socket.send(JSON.stringify({ type: "response", id: long.id, ok: true, result: {} }));
  assert.equal((await first).status, 200);
  const idle = await waitFor(fixture.readState, (value) => value?.activeRequests?.length === 0 && value.active === null);
  assert.equal(idle.recovering, false);
  fixture.child.send("finish");
  assert.equal((await fixture.exited)[0], 0);
  assert.equal((await fixture.readState()).instanceId, state.instanceId);
  const receipt = JSON.parse(await readFile(path.join(fixture.root, "broker-stopped.json"), "utf8"));
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.instanceId, state.instanceId);
});

test("Windows transient sharing denial eventually publishes complete state without rerunning the broker", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t, false, 2);
  const published = await waitFor(fixture.readState, (value) => value?.readiness === "ready", fixture.stderr);
  assert.equal(published.pid, fixture.child.pid);
  fixture.child.send("finish");
  assert.equal((await fixture.exited)[0], 0);
});

test("Windows persistent publication denial preserves old bytes and removes the staged file", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t, false, Infinity);
  assert.equal((await fixture.exited)[0], 1);
  assert.deepEqual(await fixture.readState(), { preserved: true });
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.startsWith("broker-state.json.")), []);
  assert.match(fixture.stderr(), /EPERM/);
});

// These faults exercise fs.rename publication behavior, not native OS sharing
// locks. Arm only after readiness so startup persistence cannot satisfy them.
test("detached final publication recovers an exhausted transient denial before writing its stopped receipt", { timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t);
  const initial = await waitFor(fixture.readState, (value) => value?.readiness === "ready", fixture.stderr);
  assert.equal(initial.draining, false);
  await fixture.armPublicationDenial("transient");
  fixture.child.send("finish");
  assert.equal((await fixture.exited)[0], 0, fixture.stderr());
  const final = await fixture.readState();
  assert.equal(final.instanceId, initial.instanceId);
  assert.equal(final.draining, true);
  assert.equal(final.active, null);
  assert.deepEqual(final.activeRequests, []);
  assert.equal(final.recovering, false);
  const receipt = JSON.parse(await readFile(path.join(fixture.root, "broker-stopped.json"), "utf8"));
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.instanceId, initial.instanceId);
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.endsWith(".tmp")), []);
});

test("detached final publication rejects persistent denial without a stopped receipt or staged leftovers", { timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t);
  await fixture.armPublicationDenial("persistent");
  const previousBytes = await readFile(fixture.statePath, "utf8");
  fixture.child.send("finish");
  assert.equal((await fixture.exited)[0], 1, fixture.stderr());
  assert.equal(await readFile(fixture.statePath, "utf8"), previousBytes);
  await assert.rejects(readFile(path.join(fixture.root, "broker-stopped.json"), "utf8"), { code: "ENOENT" });
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.endsWith(".tmp")), []);
});

test("detached final publication retry preserves a takeover generation and withholds its stopped receipt", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t);
  const initial = await waitFor(fixture.readState, (value) => value?.readiness === "ready", fixture.stderr);
  const foreignBytes = `${JSON.stringify({ ...initial, instanceId: "replacement-generation" })}\n`;
  await fixture.armPublicationDenial("takeover", foreignBytes);
  fixture.child.send("finish");
  assert.equal((await fixture.exited)[0], 1, fixture.stderr());
  assert.equal(await readFile(fixture.statePath, "utf8"), foreignBytes);
  await assert.rejects(readFile(path.join(fixture.root, "broker-stopped.json"), "utf8"), { code: "ENOENT" });
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.endsWith(".tmp")), []);
});

test("independent startup cannot join an existing installer lock", { timeout: 15000 }, async (t) => {
  const fixture = await detachedFixture(t, false, 0, async (root) => {
    const release = await acquireInstallLock({ installRoot: root }, { recover: false });
    t.after(release);
  });
  assert.equal((await fixture.exited)[0], 1);
  assert.match(fixture.stderr(), /installation is locked/);
  assert.equal(await fixture.readState(), null);
});

test("borrowed startup requires the exact live committed installer lease and never releases it", { timeout: 15000 }, async (t) => {
  let heldBytes;
  const fixture = await detachedFixture(t, false, 0, async (root) => {
    const release = await acquireInstallLock({ installRoot: root }, { recover: false });
    t.after(async () => { await release(); await rm(`${root}.transaction.json`, { force: true }); });
    await writeFile(`${root}.transaction.json`, JSON.stringify({ schema: 1, phase: "committed", installRoot: root, owner: release.lease }));
    heldBytes = await readFile(`${root}.lock`, "utf8");
    return { POTASSIUM_MCP_INSTALL_LEASE: JSON.stringify(release.lease) };
  });
  const published = await waitFor(fixture.readState, (value) => value?.readiness === "ready", fixture.stderr);
  assert.equal(published.pid, fixture.child.pid);
  assert.equal(await readFile(`${fixture.root}.lock`, "utf8"), heldBytes);
  fixture.child.send("finish");
  assert.equal((await fixture.exited)[0], 0);
  assert.equal(await readFile(`${fixture.root}.lock`, "utf8"), heldBytes);
});

test("a mismatched borrowed startup nonce cannot read configuration into a running broker", { timeout: 15000 }, async (t) => {
  let heldBytes;
  const fixture = await detachedFixture(t, false, 0, async (root) => {
    const release = await acquireInstallLock({ installRoot: root }, { recover: false });
    t.after(release);
    heldBytes = await readFile(`${root}.lock`, "utf8");
    return { POTASSIUM_MCP_INSTALL_LEASE: JSON.stringify({ ...release.lease, nonce: "0".repeat(32) }) };
  });
  assert.equal((await fixture.exited)[0], 1);
  assert.match(fixture.stderr(), /exact owner/);
  assert.equal(await fixture.readState(), null);
  assert.equal(await readFile(`${fixture.root}.lock`, "utf8"), heldBytes);
});

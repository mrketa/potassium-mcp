import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { brokerStatus, createBroker, stopBroker } from "../src/broker.js";
import { setup, repair } from "../src/install.js";
import { loadConfig } from "../src/server.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));

async function reserve(t) {
  const listener = net.createServer((socket) => socket.destroy());
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const close = () => listener.listening ? new Promise((resolve) => listener.close(resolve)) : Promise.resolve();
  t.after(close);
  return { listener, port: listener.address().port, close };
}

// Real loopback brokers and isolated installer files; OS identity and process
// signaling are modeled so this regression never sends a signal to any process.
async function fixture(t, fault) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-active-repair-"));
  const installRoot = path.join(root, "private MCP");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const configFile = path.join(installRoot, "config.json");
  const statePath = path.join(installRoot, "broker-state.json");
  const brokers = [];
  let current;
  let alive = false;
  let record;
  let changedAfterDrain = false;
  const signals = [];
  const originalExecution = await reserve(t);
  const originalProxy = await reserve(t);
  const nextExecution = await reserve(t);
  const nextProxy = await reserve(t);
  let unexpectedNewEndpointConnections = 0;
  nextProxy.listener.on("connection", () => { unexpectedNewEndpointConnections += 1; });
  const writeRecord = async () => {
    record = {
      schema: 1, instanceId: current.instanceId, pid: process.pid,
      nodeExecutable: process.execPath, brokerPath: path.join(runtimeRoot, "src", "broker.js"), configPath: configFile,
      configDigest: hash(await readFile(configFile)), version: "test", proxyHost: "127.0.0.1",
      proxyPort: current.listener.address().port, readiness: "ready", active: null,
    };
    await writeFile(statePath, JSON.stringify(record));
  };
  const inspect = (pid) => {
    if (!alive || pid !== process.pid) return { exited: true };
    if (fault === "edit-after-drain" && current.bridge.status().draining && !changedAfterDrain) {
      changedAfterDrain = true;
      writeFileSync(configFile, `${editedBytes}\n`);
    }
    return { executable: process.execPath, argv: [process.execPath, record.brokerPath, "--config", configFile] };
  };
  const signal = (pid) => {
    assert.equal(pid, process.pid);
    signals.push(pid);
    void current.close().then(() => { alive = false; });
  };
  const lifecycle = {
    brokerStatus: (options) => brokerStatus({ ...options, processInfoForPid: inspect }),
    stopBroker: async (options) => {
      if (fault === "wrong-recorded-digest") {
        record = { ...record, configDigest: "0".repeat(64) };
        await writeFile(statePath, JSON.stringify(record));
      }
      return stopBroker({ ...options, processInfoForPid: inspect, signalProcess: signal, waitMs: 10000 });
    },
    restartBroker: async (options) => {
      assert.equal(unexpectedNewEndpointConnections, 0, "drain must not contact the edited endpoint");
      await Promise.all([nextExecution.close(), nextProxy.close()]);
      current = await createBroker(undefined, { configFile });
      brokers.push(current);
      alive = true;
      await writeRecord();
      return brokerStatus({ ...options, processInfoForPid: inspect });
    },
  };
  const options = { cwd: root, env: {}, installRoot, workspaceRoot, runtimeRoot, nodeExecutable: process.execPath, run: () => ({ status: 0 }), brokerLifecycle: lifecycle };
  t.after(async () => {
    await Promise.allSettled(brokers.map((broker) => broker.close()));
    await rm(root, { recursive: true, force: true });
    await rm(`${installRoot}.transaction.json`, { force: true });
  });
  await setup(options);
  const initial = JSON.parse(await readFile(configFile, "utf8"));
  Object.assign(initial, { port: originalExecution.port, proxyPort: originalProxy.port, requestTimeoutMs: 18000 });
  await writeFile(configFile, `${JSON.stringify(initial, null, 2)}\n`);
  await repair(options); // Adopt the isolated baseline before any broker is started.
  await Promise.all([originalExecution.close(), originalProxy.close()]);
  current = await createBroker(undefined, { configFile });
  brokers.push(current);
  alive = true;
  await writeRecord();
  const original = current;
  const tokenPath = path.join(workspaceRoot, ".potassium-mcp-token");
  const tokenBytes = await readFile(tokenPath);
  const edited = { ...initial, port: nextExecution.port, proxyPort: nextProxy.port, requestTimeoutMs: 45000 };
  const editedBytes = `${JSON.stringify(edited, null, 4)}\n\n`;
  await writeFile(configFile, editedBytes);
  return {
    options, configFile, tokenPath, tokenBytes, original, edited, editedBytes, signals,
    inspect, signal, current: () => current,
    unexpectedConnections: () => unexpectedNewEndpointConnections,
  };
}

test("active config repair drains the recorded old endpoint and starts the accepted edited configuration", { timeout: 45000 }, async (t) => {
  const value = await fixture(t);
  await assert.rejects(stopBroker({ installRoot: value.options.installRoot, env: {}, processInfoForPid: value.inspect, signalProcess: value.signal, waitMs: 10000 }), /configuration conflicts/);
  assert.equal(value.signals.length, 0, "public lifecycle must not bypass edited ownership");
  await repair(value.options);
  assert.equal(value.signals.length, 1);
  assert.equal(value.unexpectedConnections(), 0);
  assert.equal(value.original.listener.address(), null);
  assert.equal(value.current().listener.address().port, value.edited.proxyPort);
  assert.equal((await loadConfig(value.configFile)).requestTimeoutMs, value.edited.requestTimeoutMs);
  assert.equal(await readFile(value.configFile, "utf8"), value.editedBytes);
  assert.deepEqual(await readFile(value.tokenPath), value.tokenBytes);
});

test("repair cannot drain a broker whose recorded configuration digest differs from original ownership", { timeout: 45000 }, async (t) => {
  const value = await fixture(t, "wrong-recorded-digest");
  await assert.rejects(repair(value.options), /original owned broker configuration/);
  assert.equal(value.signals.length, 0);
  assert.equal(value.unexpectedConnections(), 0);
  assert.notEqual(value.original.listener.address(), null);
});

test("a second user edit after authenticated drain is detected before any process signal", { timeout: 45000 }, async (t) => {
  const value = await fixture(t, "edit-after-drain");
  await assert.rejects(repair(value.options), /configuration changed after repair preflight/);
  assert.equal(value.signals.length, 0);
  assert.equal(value.unexpectedConnections(), 0);
  assert.equal(await readFile(value.configFile, "utf8"), `${value.editedBytes}\n`);
  assert.deepEqual(await readFile(value.tokenPath), value.tokenBytes);
});

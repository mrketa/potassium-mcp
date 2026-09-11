import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctor } from "../src/doctor.js";
import { printConfig, registerHost, repair, setup } from "../src/install.js";
import { loadConfig } from "../src/server.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const installUrl = new URL("../src/install.js", import.meta.url).href;
const exitCode = 73;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (target) => JSON.parse(await readFile(target, "utf8"));
const unexpected = () => { throw new Error("unexpected external mutation or live service call"); };

async function filesBelow(root) {
  const files = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(root, entry.name);
    const metadata = await lstat(target);
    if (entry.isSymbolicLink()) files[target] = { link: await readlink(target), mode: metadata.mode };
    else if (entry.isDirectory()) {
      files[target] = { directory: true, mode: metadata.mode };
      Object.assign(files, await filesBelow(target));
    } else files[target] = { bytes: await readFile(target, "base64"), mode: metadata.mode };
  }
  return files;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "potassium-recovery-雪 ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "private MCP");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const options = {
    cwd: root, installRoot, workspaceRoot,
    runtimeRoot: await realpath(packageRoot), nodeExecutable: await realpath(process.execPath),
    env: { HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), LOCALAPPDATA: path.join(root, "local"), APPDATA: path.join(root, "roaming") },
    run: () => ({ status: 0 }), runCommand: unexpected,
    brokerLifecycle: { brokerStatus: async () => ({ status: "absent" }), stopBroker: unexpected, restartBroker: unexpected },
  };
  const paths = {
    config: path.join(installRoot, "config.json"), ownership: path.join(installRoot, "ownership.json"),
    deployment: path.join(installRoot, "deploy-state.json"), token: path.join(workspaceRoot, ".potassium-mcp-token"),
    bootstrap: path.join(workspaceRoot, ".potassium-mcp-bootstrap.lua"),
    autoexec: path.join(root, "autoexec", "potassium_mcp_autoexec.lua"),
    journal: `${installRoot}.transaction.json`, lock: `${installRoot}.lock`, guard: `${installRoot}.lock.recovery`,
  };
  await setup(options);
  const config = await readJson(paths.config);
  Object.assign(config, {
    port: 33451, proxyPort: 33452, requestTimeoutMs: 18000, maxPendingRequests: 37, proxyMaxFrameBytes: 65536,
    httpAllowedHosts: ["example.com"], adminAuditPath: "../private-audit.ndjson",
    artifactRoots: [...config.artifactRoots, { name: "saved", path: "../saved files", recursive: true, extensions: [".json", ".txt"] }],
    hostPolicies: { agent: { read: false, admin: false, execute: false }, omp: { read: true, admin: false, execute: false }, omp_secondary: { read: false, admin: true, execute: false } },
    httpPolicy: { read: false, admin: true, execute: false },
  });
  const configBytes = `${JSON.stringify(config, null, 4)}\n\n`;
  await writeFile(paths.config, configBytes);
  await repair(options);
  const hosts = [
    { id: "omp", path: path.join(root, ".omp", "mcp.json") },
    { id: "omp_secondary", path: path.join(root, "other project", ".omp", "mcp.json") },
  ];
  for (const host of hosts) {
    await mkdir(path.dirname(host.path), { recursive: true });
    await writeFile(host.path, '{\n  // unrelated settings must survive recovery\n  "preserved": true, "mcpServers": {"other": {"command": "keep"}}\n}\n');
    if (process.platform !== "win32") await chmod(host.path, 0o640);
    await registerHost({ ...options, host: "omp", hostId: host.id, mcpConfigPath: host.path });
  }
  const artifacts = [
    { path: path.join(workspaceRoot, "potassium-mcp-artifacts", "keep.txt"), bytes: Buffer.from("saved artifact\r\n\0unchanged") },
    { path: path.join(root, "saved files", "result.json"), bytes: Buffer.from('{"private":"retained"}\n') },
    { path: path.join(root, "private-audit.ndjson"), bytes: Buffer.from('{"event":"existing local audit"}\n') },
  ];
  for (const artifact of artifacts) await writeFile(artifact.path, artifact.bytes);
  for (const host of hosts) {
    host.bytes = await readFile(host.path);
    host.mode = (await lstat(host.path)).mode;
  }
  const baseline = {
    config, configBytes, token: await readFile(paths.token), ownership: await readJson(paths.ownership),
    bootstrap: await readFile(paths.bootstrap), autoexec: await readFile(paths.autoexec),
  };
  assert.equal(await readFile(paths.config, "utf8"), configBytes);
  return { root, options, paths, hosts, artifacts, baseline };
}

const childSource = `
  import { writeSync } from "node:fs";
  const { repair } = await import(${JSON.stringify(installUrl)});
  const options = JSON.parse(process.env.POTASSIUM_RECOVERY_OPTIONS);
  const stage = process.env.POTASSIUM_RECOVERY_STAGE;
  const fail = () => { throw new Error("unexpected live service or host CLI"); };
  await repair({ ...options, allowUnsafeExecute: true,
    run: () => ({ status: 0 }), runCommand: fail,
    brokerLifecycle: { brokerStatus: async () => ({ status: "absent" }), stopBroker: fail, restartBroker: fail },
    onDeploymentActivation: async (name) => {
      if (name !== stage) return;
      const marker = { stage: name, pid: process.pid };
      if (process.env.POTASSIUM_RECOVERY_HOLD === "1") {
        await new Promise(() => {
          process.once("message", () => process.exit(${exitCode}));
          process.send(marker);
        });
      } else {
        writeSync(1, JSON.stringify(marker));
        process.exit(${exitCode});
      }
    },
  });
  throw new Error("repair returned without reaching the requested crash boundary");
`;

function childEnvironment(value, stage, hold = false) {
  return {
    ...process.env, POTASSIUM_RECOVERY_OPTIONS: JSON.stringify(value.options),
    POTASSIUM_RECOVERY_STAGE: stage, POTASSIUM_RECOVERY_HOLD: hold ? "1" : "0",
  };
}

async function crashRepair(value, stage) {
  const child = spawnSync(value.options.nodeExecutable, ["--input-type=module", "--eval", childSource], {
    cwd: value.root, env: childEnvironment(value, stage), encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, exitCode, child.stderr);
  const marker = JSON.parse(child.stdout);
  assert.equal(marker.stage, stage);
  assert.notEqual(marker.pid, process.pid);
  assert.equal((await readJson(value.paths.lock)).pid, marker.pid, "the exited child owned the interrupted transaction");
  assert.equal((await readJson(value.paths.config)).allowUnsafeExecute, true, "the child actually activated its config change before dying");
  const backupName = (await readdir(value.options.workspaceRoot)).find((name) => name.startsWith(`${path.basename(value.paths.bootstrap)}.`) && name.endsWith(".backup"));
  assert.ok(backupName, "the actual interrupted deployment retained its prior bootstrap");
  assert.deepEqual(await readFile(path.join(value.options.workspaceRoot, backupName)), value.baseline.bootstrap);
  assert.deepEqual(await readFile(value.paths.bootstrap), value.baseline.bootstrap, "the callback ran after bootstrap activation");
  return readJson(value.paths.journal);
}

async function assertUsable(value, overlays = {}) {
  const state = await readJson(value.paths.ownership);
  assert.equal(state.schema, 3);
  assert.equal(state.status, "active");
  assert.equal(state.runtime.mode, "external");
  assert.equal(state.runtime.root, value.options.runtimeRoot);
  assert.deepEqual(await readJson(value.paths.config), { ...value.baseline.config, ...overlays });
  if (Object.keys(overlays).length === 0) assert.equal(await readFile(value.paths.config, "utf8"), value.baseline.configBytes);
  assert.deepEqual(await readFile(value.paths.token), value.baseline.token);
  assert.equal(state.tokenSha256, digest(value.baseline.token));
  assert.equal(state.configSha256, digest(await readFile(value.paths.config)));
  assert.deepEqual(state.hosts, value.baseline.ownership.hosts);
  assert.deepEqual(await readFile(value.paths.bootstrap), value.baseline.bootstrap);
  assert.deepEqual(await readFile(value.paths.autoexec), value.baseline.autoexec);
  for (const host of value.hosts) {
    assert.deepEqual(await readFile(host.path), host.bytes);
    assert.equal((await lstat(host.path)).mode, host.mode);
    const launcher = await printConfig({ ...value.options, hostId: host.id });
    assert.equal(launcher.command, state.hosts[host.id].launcher.command);
    assert.deepEqual(launcher.args, state.hosts[host.id].launcher.args);
  }
  for (const artifact of value.artifacts) assert.deepEqual(await readFile(artifact.path), artifact.bytes);
  const loaded = await loadConfig(value.paths.config);
  assert.equal(loaded.token, value.baseline.token.toString("utf8").trim());
  assert.equal(loaded.requestTimeoutMs, value.baseline.config.requestTimeoutMs);
  const report = await doctor({ ...value.options, probe: false });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(({ ok }) => !ok)));
  assert.equal(report.ready, true);
  assert.equal(report.configured, true);
  assert.equal(report.schema, 3);
  for (const host of report.hostStatus) {
    assert.equal(host.ready, true);
    assert.equal(host.configured, true);
  }
  for (const target of [value.paths.lock, value.paths.journal, value.paths.guard]) await assert.rejects(readFile(target), { code: "ENOENT" });
  const leftovers = Object.keys(await filesBelow(value.root)).filter((target) => /\.(backup|staging|tmp|orphan)$/.test(target));
  assert.deepEqual(leftovers, [], "completed recovery does not strand rollback or staging files");
}

for (const stage of ["bootstrap", "autoexec", "state"]) {
  test(`repair recovers a real child exit after ${stage} activation, then applies only the newly requested change`, async (t) => {
    const value = await fixture(t);
    await crashRepair(value, stage);
    const result = await repair({ ...value.options, initialFullAccessHost: "agent", streamableHttpEnabled: true });
    assert.equal(result.configured, true);
    await assertUsable(value, { streamableHttpEnabled: true });
  });
}

test("fresh access initialization cannot elevate restricted config restored from a journal while config is absent", async (t) => {
  const value = await fixture(t);
  await crashRepair(value, "autoexec");
  await rm(value.paths.config);
  await assert.rejects(readFile(value.paths.config), { code: "ENOENT" });
  await setup({ ...value.options, initialFullAccessHost: "agent" });
  await assertUsable(value);
});

test("dry-run describes concrete recovery from a real interrupted repair and preserves every file byte", async (t) => {
  const value = await fixture(t);
  const journal = await crashRepair(value, "autoexec");
  const entry = journal.entries.find(({ target }) => target === value.paths.bootstrap);
  assert.ok(entry?.backup, "the recorded transaction identifies the original bootstrap backup");
  const before = await filesBelow(value.root);
  const result = await repair({
    ...value.options, dryRun: true, run: unexpected, runCommand: unexpected, copyAcl: unexpected,
    compileProbe: unexpected, onDeploymentActivation: unexpected, beforeLockRecovery: unexpected,
    beforeRestart: unexpected, remove: unexpected, brokerLifecycle: new Proxy({}, { get: unexpected }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.recoveryRequired, true);
  const restoration = result.operations.find(({ operation, path: target }) => operation === "restore-backup" && target === value.paths.bootstrap);
  assert.ok(restoration, "the dry-run identifies the exact bootstrap restoration, not just a generic repair");
  assert.equal(restoration.backup, entry.backup);
  assert.deepEqual(await filesBelow(value.root), before);
  await repair(value.options);
  await assertUsable(value);
});

for (const { label, field, replacement } of [
  { label: "malformed target metadata", field: "target", replacement: () => null },
  { label: "redirected target metadata", field: "target", replacement: (victim) => victim },
  { label: "redirected backup metadata", field: "backup", replacement: (victim) => victim },
  { label: "a forged original-file hash", field: "beforeSha256", replacement: () => digest("not the verified baseline") },
]) {
  test(`recovery refuses ${label} in a real journal and preserves the victim, lock and journal`, async (t) => {
    const value = await fixture(t);
    const journal = await crashRepair(value, "bootstrap");
    const entry = journal.entries.find(({ target }) => target === value.paths.bootstrap);
    assert.ok(entry?.backup, "mutate one actual recorded deployment entry rather than inventing a transaction");
    const victim = path.join(value.options.workspaceRoot, "unowned matching bootstrap.lua");
    await writeFile(victim, value.baseline.bootstrap);
    entry[field] = replacement(victim);
    await writeFile(value.paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
    const before = await filesBelow(value.root);
    await assert.rejects(repair(value.options), /recover|journal|transaction|conflict|ownership/i);
    assert.deepEqual(await filesBelow(value.root), before);
    assert.deepEqual(await readFile(victim), value.baseline.bootstrap, "matching bytes do not authorize a foreign path");
  });
}

test("recovery refuses duplicate phase keys in an actual journal without changing any file", async (t) => {
  const value = await fixture(t);
  await crashRepair(value, "bootstrap");
  const raw = await readFile(value.paths.journal, "utf8");
  const phaseProperty = /"phase"\s*:\s*"(?:applying|committed)"/.exec(raw)?.[0];
  assert.ok(phaseProperty, "duplicate the real recorded phase rather than constructing a replacement journal");
  const ambiguous = raw.replace(/^(\s*\{)/, (opening) => `${opening}\n${phaseProperty},`);
  await writeFile(value.paths.journal, ambiguous);
  const before = await filesBelow(value.root);
  await assert.rejects(repair(value.options), /duplicate|recover|journal|transaction/i);
  assert.deepEqual(await filesBelow(value.root), before);
});

test("recovery refuses a foreign edit to an actually activated journal-owned target without changing any file", async (t) => {
  const value = await fixture(t);
  await crashRepair(value, "bootstrap");
  const foreign = Buffer.from("-- user replaced the interrupted bootstrap; never overwrite or remove this\n");
  await writeFile(value.paths.bootstrap, foreign);
  const before = await filesBelow(value.root);
  await assert.rejects(repair(value.options), /recover|conflict|ownership|transaction/i);
  assert.deepEqual(await filesBelow(value.root), before);
  assert.deepEqual(await readFile(value.paths.bootstrap), foreign);
});

test("recovery never takes a live child's lock or journal, and succeeds only after that owner exits", async (t) => {
  const value = await fixture(t);
  const child = spawn(value.options.nodeExecutable, ["--input-type=module", "--eval", childSource], {
    cwd: value.root, env: childEnvironment(value, "autoexec", true), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  try {
    const marker = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not reach activation: ${stderr}`)), 30000);
      const settle = (action, value) => { clearTimeout(timer); action(value); };
      child.once("message", (message) => settle(resolve, message));
      child.once("error", (error) => settle(reject, error));
      child.once("exit", (code) => settle(reject, new Error(`child exited before activation (${code}): ${stderr}`)));
    });
    assert.equal(marker.stage, "autoexec");
    assert.equal(marker.pid, child.pid);
    assert.equal((await readJson(value.paths.lock)).pid, child.pid);
    await readJson(value.paths.journal);
    const before = await filesBelow(value.root);
    await assert.rejects(repair(value.options), /owner.*live|absence.*prov/i);
    assert.deepEqual(await filesBelow(value.root), before);
    child.send("exit");
    assert.deepEqual(await exited, { code: exitCode, signal: null });
    await repair(value.options);
    await assertUsable(value);
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});

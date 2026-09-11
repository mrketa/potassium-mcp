import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { runBootstrap } from "./bootstrap-runner.mjs";
import { observeStdioClose, openSdkSmoke, prepareRuntimeAttestation } from "./sdk-smoke.mjs";
import { listAllTools } from "../potassium-mcp/test/helpers/list-tools.js";
import { validateNpmArtifact } from "../potassium-mcp/release-publish.js";
import { validateReleaseOutput } from "./release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limits = { durationMs: 30 * 60 * 1000, heapGrowthBytes: 32 * 1024 * 1024, handlesGrowth: 8, p95Ms: 2000 };
export function verifySmokeArtifact(bytes, metadata) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(sha256, metadata.sha256, "selected smoke tarball does not match release SHA-256");
  assert.equal(integrity, metadata.integrity, "selected smoke tarball does not match release integrity");
  return { sha256, integrity };
}
export function parsePackageSmokeArgs(args) {
  const options = {};
  const positional = [];
  const usage = "Usage: node [--expose-gc] tools/package-smoke.mjs [smoke|soak] [tarball] [--npm-artifact <metadata.json>] [--output <directory>]";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("-")) { positional.push(argument); continue; }
    const key = argument === "--npm-artifact" ? "npmArtifact" : argument === "--output" ? "output" : null;
    if (!key || Object.hasOwn(options, key) || !args[index + 1]?.trim() || args[index + 1].startsWith("-")) throw new Error(usage);
    options[key] = args[++index];
  }
  if (positional.length > 2 || positional.length && !["smoke", "soak"].includes(positional[0])) throw new Error(usage);
  if (positional.length) options.mode = positional[0];
  if (positional.length === 2) {
    if (!positional[1].trim()) throw new Error(usage);
    options.tarball = positional[1];
  }
  return options;
}

export async function loadSmokeArtifact(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["npmArtifact", "tarball"].includes(key))) throw new Error("Invalid smoke artifact options");
  const { npmArtifact = path.join(root, "release-out", "NPM-ARTIFACT.json"), tarball } = options;
  if (typeof npmArtifact !== "string" || !npmArtifact.trim() || tarball !== undefined && (typeof tarball !== "string" || !tarball.trim())) throw new Error("Smoke artifact paths must be nonempty strings");
  const metadataPath = path.resolve(npmArtifact);
  const selected = JSON.parse(await readFile(metadataPath, "utf8"));
  const validated = await validateNpmArtifact(metadataPath, { name: "@mrketa/potassium-mcp", version: selected?.version });
  const selectedTarball = tarball === undefined ? validated.tarball : path.resolve(tarball);
  if (!(await lstat(selectedTarball)).isFile()) throw new Error("Selected smoke tarball must be a regular file");
  const tarballBytes = await readFile(selectedTarball);
  const artifact = { ...verifySmokeArtifact(tarballBytes, validated), npmArtifact: metadataPath, tarball: selectedTarball };
  return { metadata: validated, tarballBytes, artifact };
}
function npm(args, cwd, env) {
  const cli = process.env.npm_execpath || (process.platform === "win32" ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
  const result = spawnSync(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.error?.code || result.status}): ${result.stderr}`);
  return result.stdout;
}
export function isolatedEnv(home) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG"]) if (process.env[key]) env[key] = process.env[key];
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), npm_config_userconfig: path.join(home, ".npmrc"), npm_config_cache: path.join(home, ".npm-cache"), npm_config_registry: "https://registry.npmjs.org/", CI: "true" };
}
export async function freeLoopbackPorts(count) {
  const listeners = [];
  try {
    for (let index = 0; index < count; index++) {
      const listener = net.createServer();
      listeners.push(listener);
      await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    }
    return listeners.map((listener) => listener.address().port);
  } finally {
    await Promise.all(listeners.map((listener) => listener.listening ? new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())) : undefined));
  }
}
function appendSmokeFailure(primary, secondary) {
  if (primary === undefined) return secondary;
  const error = new AggregateError([primary, secondary], `${primary.message}; ${secondary.message}`, { cause: primary });
  error.preserveDirectory = primary.preserveDirectory === true || secondary.preserveDirectory === true;
  return error;
}
export async function probeManagedSdk(packageRoot, directory, env, runtime, launcher) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
  const bin = path.resolve(packageRoot, "../../.bin", process.platform === "win32" ? "potassium-mcp.cmd" : "potassium-mcp");
  const attestation = await prepareRuntimeAttestation(directory, "managed-sdk");
  const transport = new StdioClientTransport({ ...(launcher ?? { command: bin, args: ["serve", "--install-root", runtime, "--host-id", "package-smoke"] }), cwd: directory, env: { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, attestation.env.NODE_OPTIONS].filter(Boolean).join(" ") }, stderr: "pipe" });
  const client = new Client({ name: "potassium-managed-lifecycle-smoke", version: "1.0.0" });
  const waitForClose = observeStdioClose(transport);
  let failure;
  try {
    await client.connect(transport, { timeout: 20000 });
    transport.stderr?.resume();
    assert.equal(client.getServerVersion().name, "potassium-mcp");
    const listed = await listAllTools((cursor) => client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 5000 }), { forTool: "potassium_status" });
    assert(listed.tools.some((tool) => tool.name === "potassium_status"));
    const result = await client.callTool({ name: "potassium_status", arguments: {} }, undefined, { timeout: 5000 });
    assert.notEqual(result.isError, true, "managed public serve must reach its authenticated broker");
    const nodeRuntime = await attestation.verify(path.join(packageRoot, "bin", "potassium-mcp.js"));
    return { tools: listed.tools.length, initialized: true, status: true, serverVersion: client.getServerVersion().version, nodeRuntime };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let cleanupFailure;
    try { await client.close(); } catch (error) { cleanupFailure = error; }
    try { await waitForClose(); } catch (error) { cleanupFailure = appendSmokeFailure(cleanupFailure, error); }
    if (!cleanupFailure) {
      try { await attestation.close(); } catch (error) { cleanupFailure = error; }
    }
    if (cleanupFailure) {
      const error = new Error(`Owned managed SDK cleanup failed; preserve ${directory}`, { cause: cleanupFailure });
      error.preserveDirectory = true;
      throw appendSmokeFailure(failure, error);
    }
  }
}
async function probePinnedNpx(packageRoot, directory, env, runtime, invoke) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const launcher = JSON.parse(invoke(["config", "print", "--npm", "--host-id", "package-smoke", "--install-root", runtime, "--json"]));
  assert.equal(launcher.command, process.platform === "win32" ? "npx.cmd" : "npx");
  assert.equal(launcher.args[1], `${metadata.name}@${metadata.version}`);
  const observed = await probeManagedSdk(packageRoot, directory, { ...env, npm_config_offline: "true" }, runtime, launcher);
  return { ...observed, pin: `${metadata.name}@${metadata.version}`, command: launcher.command, offline: true, candidateEntrySha256: observed.nodeRuntime.entrySha256, selectedVerifiedCandidate: true, scope: "generated pinned npx launcher against foreign locally installed candidate; no registry publication claim" };
}
async function packedInstallerRoundtrip({ directory, env, snapshot, packageRoot, invoke, runtime, workspace, setupArgs }) {
  const json = async (target) => JSON.parse(await readFile(target, "utf8"));
  let cleanupBroker = false;
  let failure;
  try {
  const configPath = path.join(runtime, "config.json");
  const statePath = path.join(runtime, "ownership.json");
  const tokenPath = path.join(workspace, ".potassium-mcp-token");
  const originalToken = await readFile(tokenPath);
  const originalPackage = await readFile(path.join(packageRoot, "package.json"));
  const rootA = await realpath(packageRoot);
  const selectedNode = { executable: await realpath(process.execPath), version: process.version, sha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") };
  const brokerRuntimes = [];
  const manualId = "package-smoke"; // Already granted by setup; fixture preparation grants nothing.
  const manualPath = path.join(directory, "manual-host-project", ".omp", "mcp.json");
  const wrapperBytes = Buffer.from('{\r\n  // user-managed wrapper: preserve whitespace and unrelated server\r\n  "mcpServers": { "potassium": { "command": "custom-wrapper", "args": ["keep", "雪"] }, "other": { "command": "keep-unrelated" } }\r\n}\r\n');
  await mkdir(path.dirname(manualPath), { recursive: true });
  await writeFile(manualPath, wrapperBytes);
  const initialState = await json(statePath);
  const initialConfig = await json(configPath);
  const { launcher } = await import(pathToFileURL(path.join(packageRoot, "src", "install.js")));
  initialState.hosts[manualId] = { id: manualId, adapter: "manual", kind: "manual", scope: "user",
    launcher: launcher(path.join(rootA, "bin", "potassium-mcp.js"), configPath, initialState.runtime.nodeExecutable, manualId, initialConfig.requestTimeoutMs) };
  await writeFile(statePath, JSON.stringify(initialState));
  const artifactRoot = path.join(directory, "custom-artifacts");
  await mkdir(artifactRoot);
  const [executorPort, proxyPort, httpPort] = await freeLoopbackPorts(3);
  const configured = {
    ...initialConfig, port: executorPort, proxyPort, streamableHttpPort: httpPort,
    requestTimeoutMs: 45000, proxyHandshakeTimeoutMs: 17000, shutdownGraceMs: 1900,
    maxPendingRequests: 17, artifactRoots: [{ name: "custom", path: artifactRoot, recursive: true, extensions: [".json", ".txt"] }],
  };
  const configuredBytes = `${JSON.stringify(configured, null, 4)}\n\n`;
  await writeFile(configPath, configuredBytes);
  invoke(["repair", "--install-root", runtime, "--json"]);
  const checkManual = async (expectedRoot) => {
    assert.deepEqual(await readFile(manualPath), wrapperBytes, "manual wrapper and unrelated entry must remain byte-for-byte user managed");
    const state = await json(statePath);
    const record = state.hosts[manualId];
    assert.deepEqual(record, { id: manualId, adapter: "manual", kind: "manual", scope: "user",
      launcher: launcher(path.join(expectedRoot, "bin", "potassium-mcp.js"), configPath, selectedNode.executable, manualId, configured.requestTimeoutMs) });
    const doctor = JSON.parse(invoke(["doctor", "--host-id", manualId, "--install-root", runtime, "--json"]));
    assert.equal(doctor.ok, true);
    assert.deepEqual(doctor.hostStatus, [{ id: manualId, adapter: "manual", kind: "manual", ready: true, configured: false, actuallyChecked: false }]);
    assert.equal(doctor.configured, false);
    assert.equal(doctor.actuallyChecked, false);
    const suggestion = JSON.parse(invoke(["config", "print", "--host-id", manualId, "--install-root", runtime, "--json"]));
    assert.equal(suggestion.command, selectedNode.executable);
    assert.deepEqual(suggestion.args, record.launcher.args);
    return suggestion;
  };
  const preserved = async (expectedRoot) => {
    assert.deepEqual(await json(configPath), configured, "repair/migration must preserve nondefault user configuration");
    assert.equal(await readFile(configPath, "utf8"), configuredBytes, "repair/migration must not reformat user configuration");
    assert.deepEqual(await readFile(manualPath), wrapperBytes);
    assert.deepEqual(await readFile(tokenPath), originalToken, "custom bridge identity must survive lifecycle changes");
    const state = await json(statePath);
    assert.equal(state.runtime.root, expectedRoot);
    assert.equal(state.runtime.nodeExecutable, selectedNode.executable, "ownership must select the requested qualification Node");
    assert.equal(state.runtime.nodeSha256, selectedNode.sha256);
    assert.equal(state.status, "active");
    assert.equal(state.tokenSha256, createHash("sha256").update(originalToken).digest("hex"));
    assert.deepEqual(await readFile(path.join(packageRoot, "package.json")), originalPackage, "setup must not mutate npm-owned package metadata");
    const entry = JSON.parse(invoke(["config", "print", "--host-id", "package-smoke", "--install-root", runtime, "--json"]));
    assert.equal(entry.args[0], path.join(expectedRoot, "bin", "potassium-mcp.js"));
    assert.equal(entry.command, selectedNode.executable);
    return state;
  };
  await preserved(rootA);
  await checkManual(rootA);
  const bootstrapPath = path.join(workspace, ".potassium-mcp-bootstrap.lua");
  assert((await readFile(bootstrapPath, "utf8")).split(/\r?\n/).includes(`local ENDPOINT = "ws://127.0.0.1:${executorPort}"`));
  const hostPath = path.join(directory, "host-project", ".omp", "mcp.json");
  const unrelated = { command: "preserved-unrelated-host", args: [] };
  await mkdir(path.dirname(hostPath), { recursive: true });
  await writeFile(hostPath, JSON.stringify({ mcpServers: { unrelated } }));
  const hostArgs = ["--host", "omp", "--host-id", "package-host", "--scope", "project", "--mcp-config", hostPath, "--install-root", runtime, "--json"];
  invoke(["host", "add", ...hostArgs]);
  const checkHost = async (expectedRoot) => {
    const host = await json(hostPath);
    assert.deepEqual(host.mcpServers.unrelated, unrelated);
    assert.equal(host.mcpServers.potassium.args[0], path.join(expectedRoot, "bin", "potassium-mcp.js"));
    assert(host.mcpServers.potassium.timeout > configured.requestTimeoutMs, "host timeout must cover configured executor request duration");
  };
  await checkHost(rootA);
  const second = path.join(directory, "second-install");
  await mkdir(second);
  await writeFile(path.join(second, "package.json"), JSON.stringify({ private: true, type: "module" }));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", snapshot], second, env);
  const rootB = await realpath(path.join(second, "node_modules/@mrketa/potassium-mcp"));
  assert.notEqual(rootB, rootA, "relocation must use a separately installed package tree");
  const invokeB = (args) => npm(["exec", "--offline", "--", "potassium-mcp", ...args], second, env);
  const checkRunning = async (expectedRoot, previousGeneration) => {
    const status = JSON.parse(invoke(["broker", "status", "--install-root", runtime, "--json"]));
    assert.equal(status.status, "running", "repair must leave a real shared broker running");
    assert.equal(status.readiness, "ready");
    const state = await json(path.join(runtime, "broker-state.json"));
    assert.equal(state.brokerPath, path.join(expectedRoot, "src", "broker.js"));
    assert.equal(await realpath(state.nodeExecutable), selectedNode.executable, "owned broker must run under the selected Node executable");
    brokerRuntimes.push({ executable: state.nodeExecutable, brokerPath: state.brokerPath, instanceId: state.instanceId });
    assert.equal(state.configPath, configPath);
    assert(typeof state.instanceId === "string" && state.instanceId.length > 0);
    if (previousGeneration) assert.notEqual(state.instanceId, previousGeneration, "runtime relocation must start a replacement broker generation");
    return state.instanceId;
  };
  cleanupBroker = true;
  await probeManagedSdk(rootA, directory, env, runtime);
  const manualLaunches = [await probeManagedSdk(rootA, directory, env, runtime, await checkManual(rootA))];
  const generationA = await checkRunning(rootA);
  const pinnedNpx = await probePinnedNpx(rootA, directory, env, runtime, invoke);
  invokeB(["repair", "--install-root", runtime, "--runtime-root", rootB, "--json"]);
  await preserved(rootB);
  await checkHost(rootB);
  const generationB = await checkRunning(rootB, generationA);
  await probeManagedSdk(rootB, directory, env, runtime);
  manualLaunches.push(await probeManagedSdk(rootB, directory, env, runtime, await checkManual(rootB)));
  invoke(["repair", "--install-root", runtime, "--runtime-root", rootA, "--json"]);
  const restored = await preserved(rootA);
  await checkHost(rootA);
  await checkRunning(rootA, generationB);
  await probeManagedSdk(rootA, directory, env, runtime);
  manualLaunches.push(await probeManagedSdk(rootA, directory, env, runtime, await checkManual(rootA)));
  const legacy = path.join(directory, "historical-install");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "package.json"), JSON.stringify({ private: true }));
  const historicalSpec = "@mrketa/potassium-mcp@0.10.0-beta.1";
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", historicalSpec], legacy, env);
  const oldRoot = path.join(legacy, "node_modules/@mrketa/potassium-mcp");
  const oldMetadata = await json(path.join(oldRoot, "package.json"));
  assert.equal(oldMetadata.version, "0.10.0-beta.1");
  assert.notDeepEqual(oldMetadata.potassiumMcpRuntime, { ownershipSchema: 3, launcherProtocol: 1 }, "historical rejection fixture must remain a genuinely incompatible published package");
  const protectedFiles = [configPath, statePath, tokenPath, path.join(runtime, "deploy-state.json"), hostPath, manualPath, ...restored.scripts.map((script) => script.target)];
  const beforeRejection = await Promise.all(protectedFiles.map((target) => readFile(target)));
  assert.throws(() => invoke(["repair", "--install-root", runtime, "--runtime-root", oldRoot, "--json"]), /external runtime is incompatible/);
  for (const [index, target] of protectedFiles.entries()) assert.deepEqual(await readFile(target), beforeRejection[index], "incompatible package rejection must leave deployment unchanged");
  invoke(["host", "remove", ...hostArgs]);
  assert.deepEqual(await json(hostPath), { mcpServers: { unrelated } });
  const stopped = JSON.parse(invoke(["broker", "stop", "--install-root", runtime, "--wait", "30000", "--json"]));
  assert.equal(stopped.status, "stopped");
  const receipt = await json(path.join(runtime, "broker-stopped.json"));
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.brokerPath, path.join(rootA, "src", "broker.js"));
  assert.equal(await realpath(receipt.nodeExecutable), selectedNode.executable);
  cleanupBroker = false;
  invoke(["uninstall", "--all", "--install-root", runtime, "--json"]);
  assert.equal((await json(statePath)).status, "retained");
  assert.deepEqual((await json(statePath)).hosts, {}, "retained uninstall intentionally clears manual and managed metadata");
  assert.deepEqual(await readFile(manualPath), wrapperBytes);
  assert.deepEqual(await readFile(tokenPath), originalToken);
  assert.equal(await readFile(configPath, "utf8"), configuredBytes);
  for (const target of [...restored.scripts.map((script) => script.target), path.join(runtime, "deploy-state.json")]) await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(packageRoot, "package.json")), originalPackage);
  invoke(setupArgs);
  await preserved(rootA);
  assert.equal(Object.keys((await json(statePath)).hosts).length, 0);
  assert.deepEqual(await json(hostPath), { mcpServers: { unrelated } });
  assert.deepEqual(await readFile(manualPath), wrapperBytes);
  const reinstalledSuggestion = JSON.parse(invoke(["config", "print", "--host-id", manualId, "--install-root", runtime, "--json"]));
  assert.equal(reinstalledSuggestion.command, selectedNode.executable);
  assert.deepEqual(reinstalledSuggestion.args, [path.join(rootA, "bin", "potassium-mcp.js"), "serve", "--config", configPath, "--host-id", manualId]);
  cleanupBroker = true;
  const reinstalledLaunch = await probeManagedSdk(rootA, directory, env, runtime, reinstalledSuggestion);
  assert.deepEqual((await json(statePath)).hosts, {}, "using a printed suggestion must not silently adopt the user wrapper");
  const reinstalledStop = JSON.parse(invoke(["broker", "stop", "--install-root", runtime, "--wait", "30000", "--json"]));
  assert.equal(reinstalledStop.status, "stopped");
  await preserved(rootA);
  cleanupBroker = false;
  return {
    realPackageInstalls: 3, pinnedNpx, selectedNode,
    relocation: "same-contract candidate A to separately npm-installed B and back with live authenticated broker drain/stop/restart",
    managedBroker: { publicServeAutostart: true, clientCloseLeavesSharedBroker: true, distinctGenerations: 3, runtimes: brokerRuntimes, ownedStoppedReceipt: true, processSignals: "only verified public broker lifecycle APIs" },
    manualHost: { id: manualId, explicitlyPreparedMetadata: true, doctor: { ready: true, configured: false, actuallyChecked: false }, wrapperSha256: createHash("sha256").update(wrapperBytes).digest("hex"), wrapperBytesPreserved: true, regeneratedSuggestionLaunches: manualLaunches, uninstallClearedMetadata: true, reinstallDidNotAdoptWrapper: true, reinstalledSuggestionLaunch: reinstalledLaunch, scope: "explicit temporary metadata and regenerated launchers; the user-managed custom wrapper is never executed or adopted" },
    preserved: ["token bytes", "configuration bytes", "free nondefault ports", "timeouts", "artifact roots", "unrelated managed host registration", "manual custom wrapper and unrelated entry bytes"],
    hostAddRemove: true, uninstallReinstall: "retained token/config identity reactivated without adopting manual wrapper",
    historicalPackage: historicalSpec, historicalDowngrade: "incompatible public contract rejected without deployment writes; not supported downgrade qualification",
    crossNodeMigration: "not exercised; ownership, public SDK launch and owned broker identities attest this runner's selected Node executable",
  };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (cleanupBroker) {
      try { invoke(["broker", "stop", "--install-root", runtime, "--wait", "30000", "--json"]); }
      catch (cause) {
        const error = new Error(`Owned staging broker cleanup could not be verified; preserve ${directory}`, { cause });
        error.preserveDirectory = true;
        throw appendSmokeFailure(failure, error);
      }
    }
  }
}
export async function soak(harness) {
  if (typeof global.gc !== "function") throw new Error("Soak requires node --expose-gc for comparable retained-heap samples");
  for (let index = 0; index < 10; index++) await harness.probe();
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  const handles = process.getActiveResourcesInfo().length;
  const started = performance.now();
  const samples = [];
  let requests = 0;
  let batches = 0;
  let nextLifecycle = 0;
  let bootstrapCases = 0;
  const lifecycleBatches = [];
  let lifecyclePending;
  let lifecycleFailure;
  let concurrentProbeBatches = 0;
  try {
  while (performance.now() - started < limits.durationMs) {
    if (lifecycleFailure) throw lifecycleFailure;
    if (!lifecyclePending && performance.now() - started >= nextLifecycle) {
      lifecyclePending = runBootstrap("lifecycle").then((lifecycle) => {
        assert.equal(lifecycle.failed, 0);
        lifecycleBatches.push({ elapsedMs: performance.now() - started, results: lifecycle.results, skipped: lifecycle.skipped });
        bootstrapCases += lifecycle.total;
      }).catch((error) => { lifecycleFailure = error; }).finally(() => { lifecyclePending = undefined; });
      nextLifecycle += 60000;
    }
    const observations = await harness.probe();
    if (lifecyclePending) concurrentProbeBatches++;
    requests += observations.length * 3;
    batches++;
    if (batches % 20 === 0) {
      global.gc();
      const sample = { elapsedMs: performance.now() - started, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, resources: process.getActiveResourcesInfo().length, lifecycleActive: Boolean(lifecyclePending), latency: observations.map((item) => item.milliseconds) };
      samples.push(sample);
      assert(sample.heapUsed - baseline <= limits.heapGrowthBytes, "retained broker/SDK heap exceeded predeclared growth bound");
      assert(sample.resources - handles <= limits.handlesGrowth, "active resource count exceeded predeclared growth bound");
      assert(harness.broker.listener.clients.size <= 1, "proxy clients accumulated");
      assert(harness.broker.httpListener.mcpClients.size <= 8, "HTTP connections accumulated");
    }
    await delay(100);
  }
  } finally {
    await lifecyclePending;
  }
  if (lifecycleFailure) throw lifecycleFailure;
  assert(concurrentProbeBatches > 0, "SDK probes must continue while the bootstrap workload is running");
  const latencies = samples.flatMap((sample) => sample.latency).sort((a, b) => a - b);
  const p95Ms = latencies[Math.floor((latencies.length - 1) * 0.95)];
  assert(p95Ms <= limits.p95Ms, "control latency exceeded predeclared p95 bound");
  assert(requests >= 3000 && bootstrapCases >= 30, "soak workload did not meet minimum actual work");
  return { elapsedMs: performance.now() - started, limits, requests, batches, concurrentProbeBatches, bootstrapCases, p95Ms, samples, lifecycleBatches, scope: "one persistent isolated SDK/broker process with concurrent asynchronous Lune subprocess every minute; each lifecycle batch keeps one generation for100cycles; not long-lived Lune heap or live engine stability" };
}
export async function runPackageSmoke(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["mode", "tarball", "npmArtifact", "output"].includes(key))) throw new Error("Invalid package smoke options");
  const { mode = "smoke", output = path.join(root, "release-out") } = options;
  if (!["smoke", "soak"].includes(mode) || typeof output !== "string" || !output.trim()) throw new Error("Invalid package smoke mode or output");
  const destination = await validateReleaseOutput(root, output, ["potassium-mcp", "tools"]);
  const { metadata, tarballBytes, artifact } = await loadSmokeArtifact({ npmArtifact: options.npmArtifact, tarball: options.tarball });
  const reportPath = path.join(destination, mode === "soak" ? "SOAK-EVIDENCE.json" : "PACKAGE-SMOKE.json");
  assert.notEqual(reportPath.toLowerCase(), artifact.npmArtifact.toLowerCase(), "smoke evidence must not replace its selected artifact metadata");
  try {
    const info = await lstat(reportPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Smoke evidence must be a regular file, not a redirected output");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "potassium package smoke-雪-"));
  const home = path.join(directory, "home");
  const env = isolatedEnv(home);
  let harness;
  let preserveDirectory = false;
  let failure;
  let evidence;
  try {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const snapshot = path.join(directory, "verified-package.tgz");
    await writeFile(snapshot, tarballBytes);
    npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", snapshot], directory, env);
    const packageRoot = path.join(directory, "node_modules/@mrketa/potassium-mcp");
    const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(installed.name, metadata.name);
    assert.equal(installed.version, metadata.version);
    assert.equal(installed.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
    assert.equal(installed.scripts, undefined, "installed package must not advertise source-only commands");
    const invoke = (args) => npm(["exec", "--offline", "--", "potassium-mcp", ...args], directory, env);
    assert.match(invoke(["--help"]), /serve/);
    const workspace = path.join(directory, "workspace");
    const runtime = path.join(directory, "runtime");
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(directory, "autoexec"), { recursive: true });
    const setupArgs = ["setup", "--workspace", workspace, "--install-root", runtime, "--read-host", "package-smoke", "--read-host", "package-host", "--json"];
    invoke([...setupArgs, "--dry-run"]);
    await assert.rejects(readdir(runtime), { code: "ENOENT" });
    invoke(setupArgs);
    const config = JSON.parse(invoke(["config", "print", "--host-id", "package-smoke", "--install-root", runtime, "--json"]));
    assert(config && typeof config === "object", "setup must produce usable host configuration");
    const installer = await packedInstallerRoundtrip({ directory, env, snapshot, packageRoot, invoke, runtime, workspace, setupArgs });
    harness = await openSdkSmoke(packageRoot, directory, env);
    const transports = (await harness.probe()).map(({ milliseconds, ...observation }) => observation);
    const nativeCode = await harness.nativeCode();
    const cancellation = await harness.cancellation();
    evidence = { mode, node: process.version, platform: process.platform, package: `${installed.name}@${installed.version}`, artifact, installer, sdkRuntime: harness.nodeRuntime, nativeCode, transports, protocol: harness.protocol, cancellation, setup: "real isolated hostless runtime", skipped: ["Roblox/Potassium engine and real external hosts require manual qualification"], ...(mode === "soak" ? { soak: await soak(harness) } : {}) };
  } catch (error) {
    failure = error;
    preserveDirectory = error.preserveDirectory === true;
  } finally {
    try { await harness?.close(); } catch (cause) {
      preserveDirectory = true;
      const error = new Error(`Owned SDK harness cleanup failed; preserve ${directory}`, { cause });
      error.preserveDirectory = true;
      failure = appendSmokeFailure(failure, error);
    }
    if (!preserveDirectory) {
      try {
        // Only our closed temporary tree: let Windows release transient filesystem locks.
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (cause) {
        preserveDirectory = true;
        const error = new Error(`Owned smoke temporary root cleanup failed; retained remnants at ${directory}`, { cause });
        error.preserveDirectory = true;
        failure = appendSmokeFailure(failure, error);
      }
    }
  }
  const failureDiagnostic = failure === undefined ? undefined : inspect(failure, { depth: 8, maxArrayLength: 32, maxStringLength: 4096 });
  const report = failure === undefined ? evidence : {
    ...(evidence ?? { mode, node: process.version, platform: process.platform, artifact }),
    status: "failed",
    cleanup: { directory, status: preserveDirectory ? "preserved" : "removed" },
    failure: failureDiagnostic.slice(0, 65536),
    failureTruncated: failureDiagnostic.length > 65536,
  };
  try {
    await mkdir(destination, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) { failure = appendSmokeFailure(failure, error); }
  if (failure !== undefined) throw failure;
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runPackageSmoke(parsePackageSmokeArgs(process.argv.slice(2))))
    .then((evidence) => console.log(JSON.stringify(evidence, null, 2)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

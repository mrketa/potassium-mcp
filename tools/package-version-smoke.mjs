import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "../potassium-mcp/release-publish.js";
import { freeLoopbackPorts, isolatedEnv, loadSmokeArtifact, probeManagedSdk } from "./package-smoke.mjs";
import { validateReleaseOutput } from "./release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (target) => JSON.parse(await readFile(target, "utf8"));
export function parsePackageVersionSmokeArgs(args) {
  const options = {};
  const usage = "Usage: node tools/package-version-smoke.mjs --npm-artifact <metadata.json> --output <directory>";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const key = argument === "--npm-artifact" ? "npmArtifact" : argument === "--output" ? "output" : null;
    if (!key || Object.hasOwn(options, key) || !args[index + 1]?.trim() || args[index + 1].startsWith("-")) throw new Error(usage);
    options[key] = args[++index];
  }
  if (!Object.hasOwn(options, "npmArtifact") || !Object.hasOwn(options, "output")) throw new Error(usage);
  return options;
}

export async function preparePackageVersionSmoke(options, projectRoot = root) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["npmArtifact", "output"].includes(key))
    || typeof options.npmArtifact !== "string" || !options.npmArtifact.trim()
    || typeof options.output !== "string" || !options.output.trim()) throw new Error("Version smoke requires explicit npmArtifact and output paths");
  const destination = await validateReleaseOutput(projectRoot, options.output, ["potassium-mcp", "tools"]);
  const selected = await loadSmokeArtifact({ npmArtifact: options.npmArtifact });
  const reportPath = path.join(destination, "PACKAGE-VERSION-SMOKE.json");
  assert.notEqual(reportPath.toLowerCase(), selected.artifact.npmArtifact.toLowerCase(), "version smoke evidence must not replace its selected artifact metadata");
  try {
    const info = await lstat(reportPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Version smoke evidence must be a regular file, not a redirected output");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { name, version, filename } = selected.metadata;
  return { ...selected, artifact: { ...selected.artifact, name, version, filename }, destination, reportPath };
}

async function inventory(directory, prefix = "") {
  const result = [];
  for (const entry of (await readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(directory, relative);
    const stat = await lstat(target);
    assert(!stat.isSymbolicLink(), "qualification inputs must not traverse links");
    if (stat.isDirectory()) result.push(...await inventory(directory, relative));
    else {
      assert(stat.isFile(), "qualification input must be a regular file");
      if (relative !== "package.json") result.push({ path: relative, sha256: digest(await readFile(target)) });
    }
  }
  return result;
}

function errorCategory(error) {
  return {
    name: ["Error", "AssertionError", "AggregateError", "TypeError", "SyntaxError"].includes(error?.name) ? error.name : "Error",
    ...(typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code) ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { exitStatus: error.status } : {}),
    ...(["SIGTERM", "SIGKILL", "SIGINT"].includes(error?.signal) ? { signal: error.signal } : {}),
    ...(error?.preserveDirectory === true ? { isolatedRootPreserved: true } : {}),
  };
}

function versionObservation() {
  const started = performance.now();
  const phases = [];
  let reportPath;
  let originalArtifact;
  let persistenceError;
  let current;
  let failurePhase;
  const snapshot = () => ({
    status: failurePhase || persistenceError ? "failed" : "running",
    elapsedMs: Math.round(performance.now() - started),
    ...(failurePhase ? { failurePhase } : {}),
    phases: phases.map(({ startedMs, finishedMs, ...phase }) => ({
      ...phase,
      elapsedMs: Math.round((finishedMs ?? performance.now()) - startedMs),
    })),
    scope: "bounded CI qualification stage evidence; no command arguments, output, configuration or credentials; not runtime latency qualification",
  });
  const publish = () => {
    const observation = snapshot();
    const phase = observation.phases.at(-1);
    // A receipt write failure must fail qualification, but must not prevent owned cleanup.
    if (reportPath) {
      try { writeFileSync(reportPath, `${JSON.stringify({ originalArtifact, observation }, null, 2)}\n`); }
      catch (error) { persistenceError ??= error; }
    }
    console.log(JSON.stringify({ versionSmoke: phase?.phase, status: phase?.status, elapsedMs: observation.elapsedMs, phaseElapsedMs: phase?.elapsedMs, ...(phase?.error ? { error: phase.error } : {}) }));
  };
  const finish = (status, error) => {
    if (!current) return;
    current.status = status;
    current.finishedMs = performance.now();
    if (error) current.error = errorCategory(error);
    if (status === "failed") failurePhase ??= current.phase;
    current = undefined;
    publish();
  };
  return {
    attach(target, { name, version, sha256, integrity }) {
      reportPath = target;
      originalArtifact = { name, version, sha256, integrity };
      publish();
    },
    start(phase) {
      finish("completed");
      current = { phase, status: "running", startedAt: new Date().toISOString(), startedMs: performance.now() };
      phases.push(current);
      publish();
    },
    finish,
    snapshot,
    persistenceError: () => persistenceError,
  };
}

async function main(options) {
  const observation = versionObservation();
  observation.start("acquisition.verify-selected-artifact");
  let selected;
  try { selected = await preparePackageVersionSmoke(options); }
  catch (error) { observation.finish("failed", error); throw error; }
  const { metadata: original, tarballBytes: originalBytes, artifact: originalIdentity, destination, reportPath } = selected;
  observation.start("acquisition.prepare-evidence-output");
  try { await mkdir(destination, { recursive: true }); }
  catch (error) { observation.finish("failed", error); throw error; }
  observation.attach(reportPath, originalIdentity);
  observation.start("acquisition.create-isolated-root");
  let directory;
  try { directory = await mkdtemp(path.join(tmpdir(), "potassium version qualification-雪-")); }
  catch (error) { observation.finish("failed", error); throw error; }
  const workspace = path.join(directory, "workspace");
  const runtime = path.join(directory, "runtime");
  let invoke;
  let brokerMayBeRunning = false;
  let report;
  let failure;
  try {
    observation.start("acquisition.extract-and-inventory");
    const home = path.join(directory, "home");
    await Promise.all(["AppData/Local", "AppData/Roaming"].map((folder) => mkdir(path.join(home, folder), { recursive: true })));
    await writeFile(path.join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    const env = isolatedEnv(home);
    const sourceTarball = path.join(directory, "verified-source.tgz");
    await writeFile(sourceTarball, originalBytes);
    const extracted = path.join(directory, "extracted");
    await mkdir(extracted);
    const npmCli = process.env.npm_execpath ?? path.join(path.dirname(createRequire(process.execPath).resolve("npm/package.json")), "bin", "npm-cli.js");
    env.npm_execpath = npmCli;
    const npmRequire = createRequire(npmCli);
    await npmRequire("tar").x({ file: sourceTarball, cwd: extracted, strict: true, preservePaths: false });
    const source = path.join(extracted, "package");
    const metadata = await json(path.join(source, "package.json"));
    assert.equal(metadata.name, original.name);
    assert.equal(metadata.version, original.version);
    const expectedFiles = await inventory(source);
    const candidates = [];
    for (const version of ["0.10.0-qualification.1", "0.10.0-qualification.2"]) {
      observation.start(`candidate.${version}.stage-and-verify`);
      const staging = path.join(directory, `stage-${version}`);
      const destination = path.join(directory, `install-${version}`);
      const packedDirectory = path.join(directory, `packed-${version}`);
      await cp(source, staging, { recursive: true });
      await mkdir(destination);
      await mkdir(packedDirectory);
      await writeFile(path.join(staging, "package.json"), `${JSON.stringify({ ...metadata, version }, null, 2)}\n`);
      assert.deepEqual(await inventory(staging), expectedFiles, "qualification versions may not alter any runtime file");
      const stagedMetadata = await json(path.join(staging, "package.json"));
      assert.deepEqual({ ...stagedMetadata, version: metadata.version }, metadata, "version must be the only manifest change");
      observation.start(`candidate.${version}.npm-pack`);
      const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packedDirectory], { cwd: staging, env, encoding: "utf8", stdio: "pipe" }));
      assert.equal(packed.length, 1);
      assert.equal(packed[0].version, version);
      const tarball = path.join(packedDirectory, packed[0].filename);
      const bytes = await readFile(tarball);
      assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, packed[0].integrity);
      await writeFile(path.join(destination, "package.json"), JSON.stringify({ private: true }));
      observation.start(`candidate.${version}.npm-install`);
      runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: destination, env, encoding: "utf8", stdio: "pipe" });
      observation.start(`candidate.${version}.verify-installed-bytes`);
      const packageRoot = await realpath(path.join(destination, "node_modules/@mrketa/potassium-mcp"));
      assert.deepEqual({ ...await json(path.join(packageRoot, "package.json")), version: metadata.version }, metadata);
      for (const file of expectedFiles) assert.equal(digest(await readFile(path.join(packageRoot, file.path))), file.sha256, `installed runtime changed: ${file.path}`);
      candidates.push({ version, packageRoot, destination, sha256: digest(bytes), integrity: packed[0].integrity });
    }
    const [a, b] = candidates;
    const command = (candidate, args) => runNpm(["exec", "--offline", "--", "potassium-mcp", ...args], { cwd: candidate.destination, env, encoding: "utf8", stdio: "pipe" });
    invoke = (args) => command(a, args);
    await mkdir(workspace);
    await mkdir(path.join(directory, "autoexec"));
    observation.start("lifecycle.setup");
    invoke(["setup", "--workspace", workspace, "--install-root", runtime, "--read-host", "version-smoke", "--read-host", "package-smoke", "--json"]);
    const configPath = path.join(runtime, "config.json");
    const statePath = path.join(runtime, "ownership.json");
    const tokenPath = path.join(workspace, ".potassium-mcp-token");
    const originalToken = await readFile(tokenPath);
    observation.start("lifecycle.prepare-private-state");
    const [port, proxyPort, streamableHttpPort] = await freeLoopbackPorts(3);
    const artifactRoot = path.join(directory, "preserved-artifacts");
    await mkdir(artifactRoot);
    const config = { ...await json(configPath), port, proxyPort, streamableHttpPort, requestTimeoutMs: 45000, proxyHandshakeTimeoutMs: 17000, maxPendingRequests: 19, artifactRoots: [{ name: "preserved", path: artifactRoot, recursive: true, extensions: [".json"] }] };
    await writeFile(configPath, JSON.stringify(config));
    observation.start("lifecycle.initial-repair");
    invoke(["repair", "--install-root", runtime, "--json"]);
    observation.start("lifecycle.prepare-host-registration");
    const hostPath = path.join(directory, "host", "mcp.json");
    await mkdir(path.dirname(hostPath));
    const unrelated = { command: "preserved-unrelated-registration", args: [] };
    await writeFile(hostPath, JSON.stringify({ mcpServers: { unrelated } }));
    observation.start("lifecycle.host-add");
    invoke(["host", "add", "--host", "omp", "--host-id", "version-smoke", "--scope", "project", "--mcp-config", hostPath, "--install-root", runtime, "--json"]);
    brokerMayBeRunning = true;
    const transitions = [];
    let previousGeneration;
    let transition = 0;
    for (const candidate of [a, b, a]) {
      const phase = `lifecycle.transition-${++transition}`;
      if (previousGeneration) {
        observation.start(`${phase}.repair`);
        command(candidate, ["repair", "--install-root", runtime, "--runtime-root", candidate.packageRoot, "--json"]);
      }
      observation.start(`${phase}.sdk-probe`);
      const sdk = await probeManagedSdk(candidate.packageRoot, candidate.destination, env, runtime);
      assert.equal(sdk.serverVersion, candidate.version, "actual SDK server version must follow upgrade/rollback");
      observation.start(`${phase}.broker-status`);
      const status = JSON.parse(invoke(["broker", "status", "--install-root", runtime, "--json"]));
      assert.equal(status.status, "running");
      assert.equal(status.readiness, "ready");
      assert.equal(status.version, candidate.version, "actual detached broker version must follow upgrade/rollback");
      observation.start(`${phase}.verify-private-state`);
      const broker = await json(path.join(runtime, "broker-state.json"));
      assert.equal(broker.brokerPath, path.join(candidate.packageRoot, "src/broker.js"));
      if (previousGeneration) assert.notEqual(broker.instanceId, previousGeneration);
      previousGeneration = broker.instanceId;
      assert.deepEqual(await readFile(tokenPath), originalToken);
      assert.deepEqual(await json(configPath), config);
      assert.equal((await json(statePath)).runtime.root, candidate.packageRoot);
      const host = await json(hostPath);
      assert.deepEqual(host.mcpServers.unrelated, unrelated);
      assert.equal(host.mcpServers.potassium.args[0], path.join(candidate.packageRoot, "bin/potassium-mcp.js"));
      assert(host.mcpServers.potassium.timeout > config.requestTimeoutMs);
      transitions.push({ version: candidate.version, sdkVersion: sdk.serverVersion, brokerVersion: status.version, tools: sdk.tools, distinctGeneration: true, tokenConfigHostPreserved: true });
    }
    // Edit raw user configuration while the owned broker still listens on the
    // recorded old endpoint. Repair must drain that generation, not the edited port.
    observation.start("lifecycle.raw-config.prepare");
    const [nextProxyPort] = await freeLoopbackPorts(1);
    assert.notEqual(nextProxyPort, proxyPort);
    const priorHostTimeout = (await json(hostPath)).mcpServers.potassium.timeout;
    const editedConfig = { ...config, proxyPort: nextProxyPort, requestTimeoutMs: 46000 };
    await writeFile(configPath, `${JSON.stringify(editedConfig, null, 2)}\n`);
    observation.start("lifecycle.raw-config.repair");
    invoke(["repair", "--install-root", runtime, "--json"]);
    // Inspect before the SDK can autostart anything: this must be repair's restart.
    observation.start("lifecycle.raw-config.broker-status");
    const repairedStatus = JSON.parse(invoke(["broker", "status", "--install-root", runtime, "--json"]));
    assert.equal(repairedStatus.status, "running");
    assert.equal(repairedStatus.readiness, "ready");
    assert.equal(repairedStatus.version, a.version);
    observation.start("lifecycle.raw-config.verify-private-state");
    const repairedBroker = await json(path.join(runtime, "broker-state.json"));
    assert.notEqual(repairedBroker.instanceId, previousGeneration);
    assert.equal(repairedBroker.proxyPort, nextProxyPort);
    assert.equal(repairedBroker.brokerPath, path.join(a.packageRoot, "src/broker.js"));
    assert.equal(repairedBroker.configDigest, digest(await readFile(configPath)));
    assert.deepEqual(await json(configPath), editedConfig);
    assert.deepEqual(await readFile(tokenPath), originalToken);
    const repairedHost = await json(hostPath);
    assert.deepEqual(repairedHost.mcpServers.unrelated, unrelated);
    assert(repairedHost.mcpServers.potassium.timeout > priorHostTimeout, "repair must refresh the launcher after a raw timeout edit");
    assert(repairedHost.mcpServers.potassium.timeout > editedConfig.requestTimeoutMs);
    observation.start("lifecycle.raw-config.verify-old-listener-closed");
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
      socket.once("connect", () => { socket.destroy(); reject(new Error("old owned proxy listener survived repair")); });
      socket.once("error", (error) => { if (error.code === "ECONNREFUSED") resolve(); else reject(error); });
      socket.setTimeout(1500, () => { socket.destroy(); reject(new Error("old proxy listener closure could not be confirmed")); });
    });
    observation.start("lifecycle.raw-config.sdk-probe");
    const editedSdk = await probeManagedSdk(a.packageRoot, a.destination, env, runtime);
    assert.equal(editedSdk.serverVersion, a.version);
    const rawConfigRepair = { actualRunningBroker: true, editedSettings: ["proxyPort", "requestTimeoutMs"], readyBeforeSdkReconnect: true, distinctGeneration: true, oldListenerClosed: true, editedConfigDigestMatched: true, tokenRootsAndUnrelatedHostPreserved: true, refreshedHostTimeout: true, sdkNewEndpoint: true };
    observation.start("lifecycle.broker-stop");
    assert.equal(JSON.parse(invoke(["broker", "stop", "--install-root", runtime, "--wait", "30000", "--json"])).status, "stopped");
    brokerMayBeRunning = false;
    report = { originalArtifact: originalIdentity, candidates: candidates.map(({ version, sha256, integrity }) => ({ version, sha256, integrity })), runtimeFilesVerifiedIdentical: expectedFiles.length, transitions, rawConfigRepair, stoppedThroughOwnedLifecycle: true, scope: "controlled compatible-contract version qualification1→2→1 using genuine npm packs and installed final runtime bytes; only manifest version changed; raw config repair with a real running owned broker; no source worktree version edit or publication; not historical public-beta downgrade support" };
  } catch (error) {
    failure = error;
    observation.finish("failed", error);
  }
  try {
    if (brokerMayBeRunning) {
      observation.start("cleanup.owned-broker-stop");
      try { invoke(["broker", "stop", "--install-root", runtime, "--wait", "30000", "--json"]); }
      catch (cause) {
        throw Object.assign(new Error(`Owned version-qualification broker cleanup uncertain; preserve ${directory}`, { cause }), { preserveDirectory: true });
      }
    }
    if (failure?.preserveDirectory === true) {
      observation.start("cleanup.preserve-isolated-root");
      observation.finish("indeterminate", failure);
    } else {
      observation.start("cleanup.remove-isolated-root");
      await rm(directory, { recursive: true, force: true });
      observation.finish("completed");
    }
  } catch (error) {
    observation.finish("failed", error);
    failure = failure ? new AggregateError([failure, error], "Version qualification and owned cleanup both failed", { cause: failure }) : error;
  }
  if (observation.persistenceError()) {
    failure = failure ? new AggregateError([failure, observation.persistenceError()], "Version qualification and evidence persistence both failed", { cause: failure }) : observation.persistenceError();
  }
  if (failure) throw failure;
  await writeFile(reportPath, `${JSON.stringify({ ...report, observation: { ...observation.snapshot(), status: "completed" } }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => main(parsePackageVersionSmokeArgs(process.argv.slice(2))))
    .catch((error) => {
      // Child-process errors can embed commands, private paths and captured output.
      // Keep the original exception/cause intact in-process, but emit only its category.
      const errors = error instanceof AggregateError ? error.errors : [error];
      console.error(JSON.stringify({ versionSmoke: "failed", errors: errors.map(errorCategory) }));
      process.exitCode = 1;
    });
}

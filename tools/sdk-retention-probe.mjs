import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runNpm } from "../potassium-mcp/release-publish.js";
import { isolatedEnv, verifySmokeArtifact } from "./package-smoke.mjs";
import { openSdkSmoke } from "./sdk-smoke.mjs";

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), "..");
const execute = promisify(execFile);
const iterations = 30;
async function worker(mode, packageRoot, directory) {
  assert(["default", "raw-discovery-control"].includes(mode));
  assert.equal(typeof global.gc, "function", "retention diagnostic requires --expose-gc");
  const options = { diagnosticRawDiscovery: mode === "raw-discovery-control" };
  const harness = await openSdkSmoke(packageRoot, directory, process.env, options);
  const samples = [];
  try {
    for (let index = 0; index < 3; index++) await harness.probe();
    global.gc();
    const baseline = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let index = 1; index <= iterations; index++) {
      const observations = await harness.probe();
      if (index % 5 === 0) {
        global.gc();
        const memory = process.memoryUsage();
        const sample = { iteration: index, heapUsed: memory.heapUsed, heapGrowth: memory.heapUsed - baseline, rss: memory.rss, elapsedMs: performance.now() - started, milliseconds: observations.map((item) => item.milliseconds) };
        samples.push(sample);
        console.log(`RETENTION_SAMPLE=${JSON.stringify({ mode, ...sample })}`);
      }
    }
    return { mode, node: process.version, warmup: 3, iterations, operationsPerIteration: 9, operations: iterations * 9, baseline, samples, outputValidation: mode === "raw-discovery-control" ? "DIAGNOSTIC ONLY: raw tools/list bypasses SDK metadata compilation; not qualification" : "official SDK AJV validation enabled", scope: "real packed broker and all three SDK transports in a fresh process; no bootstrap workload; client/server shared heap separated by raw-discovery control" };
  } finally { await harness.close(); }
}
async function main() {
  if (process.argv[2] === "worker") {
    const report = await worker(process.argv[3], process.argv[4], process.argv[5]);
    console.log(`RETENTION_RESULT=${JSON.stringify(report)}`);
    return;
  }
  if (process.argv.length !== 2) throw new Error("Usage: node tools/sdk-retention-probe.mjs");
  const metadata = JSON.parse(await readFile(path.join(root, "release-out/NPM-ARTIFACT.json"), "utf8"));
  const bytes = await readFile(path.join(root, "release-out", metadata.filename));
  const artifact = verifySmokeArtifact(bytes, metadata);
  const directory = await mkdtemp(path.join(tmpdir(), "potassium-sdk-retention-"));
  try {
    const home = path.join(directory, "home");
    await mkdir(home);
    await writeFile(path.join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true }));
    const snapshot = path.join(directory, "verified-package.tgz");
    await writeFile(snapshot, bytes);
    const env = isolatedEnv(home);
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", snapshot], { cwd: directory, env, encoding: "utf8", stdio: "pipe" });
    const packageRoot = path.join(directory, "node_modules/@mrketa/potassium-mcp");
    const reports = [];
    for (const mode of ["default", "raw-discovery-control"]) {
      const phase = path.join(directory, mode);
      await mkdir(phase);
      const result = await execute(process.execPath, ["--expose-gc", self, "worker", mode, packageRoot, phase], { cwd: directory, env, encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
      process.stdout.write(result.stdout);
      const line = result.stdout.split(/\r?\n/).findLast((row) => row.startsWith("RETENTION_RESULT="));
      assert(line, "retention worker did not produce an evidence envelope");
      reports.push(JSON.parse(line.slice("RETENTION_RESULT=".length)));
    }
    const report = { artifact, reports, acceptance: "diagnostic comparison only; does not replace unchanged32MiB/full30minute soak gate" };
    await writeFile(path.join(root, `release-out/SDK-RETENTION-${artifact.sha256.slice(0, 12)}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

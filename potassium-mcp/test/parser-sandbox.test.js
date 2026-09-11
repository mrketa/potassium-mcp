import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parseSourcePackage } from "../src/parser-process.js";

const windows = process.platform === "win32" && process.arch === "x64";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = path.join(packageRoot, "assets/parser-host/win32-x64/PotassiumMcp.ParserHost.exe");
const workspaceRoot = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PotassiumMcp.ParserSandbox");
const module = { id: "test", logicalPath: "test", source: "return 42", sha256: createHash("sha256").update("return 42").digest("hex") };

function probe(request, { onSpawn, onReady, environment = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(host, ["--probe", "fixed"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...environment } });
    const chunks = []; let total = 0, diagnostics = 0, diagnosticText = "", childReady = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Fixed parser probe exceeded host deadline")); }, 22000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (bytes) => { total += bytes.length; if (total > 8 * 1024 * 1024) { child.kill(); reject(new Error("Host output ceiling failed")); } else chunks.push(bytes); });
    child.stderr.on("data", (bytes) => {
      diagnostics += bytes.length;
      if (diagnostics > 65536) child.kill();
      else {
        diagnosticText += bytes.toString("utf8");
        if (diagnosticText.split(/\r?\n/).includes("parser-probe-running")) {
          childReady = true;
          if (onReady) { onReady(); onReady = undefined; }
        }
      }
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) { reject(new Error(`Parser probe host exited ${status}`)); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (result.error && diagnosticText) result.error.probeDiagnostics = diagnosticText;
        result.childReady = childReady;
        resolve(result);
      } catch (error) { reject(error); }
    });
    const bytes = Buffer.from(JSON.stringify(request)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    child.stdin.write(header); child.stdin.write(bytes);
    onSpawn?.(child);
  });
}

const execFileAsync = promisify(execFile);

async function ownedLease(controllerPid, workers, root = workspaceRoot) {
  assert.ok(Number.isSafeInteger(controllerPid) && controllerPid > 0, "Parser controller PID is required");
  for (const worker of workers) {
    if (worker.ParentProcessId !== controllerPid || typeof worker.ExecutablePath !== "string") continue;
    const relative = path.relative(root, worker.ExecutablePath);
    const parts = relative.split(path.sep);
    if (parts.length !== 3 || !/^[0-9a-f]{32}$/.test(parts[0]) ||
        parts[1] !== "runtime" || parts[2] !== "PotassiumMcp.LuauParser.exe") continue;
    const id = parts[0];
    try {
      const receipt = JSON.parse(await readFile(path.join(root, id, "receipt.json"), "utf8"));
      // Receipts identify the profile, not a PID. Only the spawned controller's
      // worker executable binds that identity to this probe.
      if (receipt.owner !== "PotassiumMcp.ParserHost/1" || receipt.schema !== 1 ||
          receipt.id !== id || receipt.state !== "created" || typeof receipt.userSid !== "string") continue;
      const sidHash = createHash("sha256").update(receipt.userSid).digest("hex").slice(0, 12);
      if (receipt.profile === `Potassium.Parser.${sidHash}.${id}`) return id;
    } catch (error) { if (!["ENOENT", "EBUSY", "EPERM"].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  }
}

async function newLease(child) {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, "Parser controller did not spawn");
  const deadline = performance.now() + 8000;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    assert.equal(child.exitCode, null, "Parser controller exited before lease discovery");
    assert.equal(child.signalCode, null, "Parser controller was killed before lease discovery");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object ParentProcessId, ExecutablePath) | ConvertTo-Json -Compress`,
    ], { encoding: "utf8", windowsHide: true, timeout: Math.min(5000, remaining), maxBuffer: 65536 });
    const workers = stdout.trim() ? JSON.parse(stdout) : [];
    const lease = await ownedLease(child.pid, Array.isArray(workers) ? workers : [workers]);
    if (lease) return lease;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now()))));
  }
  throw new Error("Parser host did not create an owned lease");
}

async function assertLeaseRemoved(lease, root = workspaceRoot) {
  await assert.rejects(lstat(path.join(root, lease)), { code: "ENOENT" });
}

test("lease discovery and cleanup ignore a concurrent foreign controller", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "Potassium-parser-lease-isolation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const own = "1".repeat(32), foreign = "2".repeat(32);
  const userSid = "S-1-5-21-1234";
  const sidHash = createHash("sha256").update(userSid).digest("hex").slice(0, 12);
  for (const id of [own, foreign]) {
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, "receipt.json"), JSON.stringify({
      owner: "PotassiumMcp.ParserHost/1", schema: 1, userSid, id,
      profile: `Potassium.Parser.${sidHash}.${id}`, state: "created",
    }));
  }
  const foreignWorker = { ParentProcessId: 202, ExecutablePath: path.join(root, foreign, "runtime", "PotassiumMcp.LuauParser.exe") };
  const ownWorker = { ParentProcessId: 101, ExecutablePath: path.join(root, own, "runtime", "PotassiumMcp.LuauParser.exe") };
  assert.equal(await ownedLease(101, [foreignWorker], root), undefined);
  assert.equal(await ownedLease(101, [{
    ParentProcessId: 101,
    ExecutablePath: path.join(root, "..", foreign, "runtime", "PotassiumMcp.LuauParser.exe"),
  }], root), undefined);
  const lease = await ownedLease(101, [foreignWorker, ownWorker], root);
  assert.equal(lease, own);
  await assert.rejects(assertLeaseRemoved(lease, root), assert.AssertionError);
  await rm(path.join(root, own), { recursive: true });
  await assertLeaseRemoved(lease, root);
  assert.equal(await ownedLease(101, [foreignWorker], root), undefined);
  assert.equal(JSON.parse(await readFile(path.join(root, foreign, "receipt.json"), "utf8")).id, foreign);
});

test("unsupported parser platforms fail closed without an unconfined fallback", { skip: windows }, async () => {
  await assert.rejects(parseSourcePackage([module]), { code: "PARSER_BACKEND_UNAVAILABLE" });
});

test("parser cancellation before admission returns no result", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parseSourcePackage([module], { signal: controller.signal }), { code: "PARSER_CANCELLED" });
});

test("native AppContainer parser preserves typed Luau and UTF8 source spans", { skip: !windows, timeout: 30000 }, async () => {
  const source = 'local function greet(value: string): string\n  return value\nend\nlocal label = "雪\u{10400}"\nreturn greet(label)\n';
  const sha256 = createHash("sha256").update(source).digest("hex");
  const result = await parseSourcePackage([{ id: "unicode", logicalPath: "unicode", source, sha256 }]);
  assert.equal(result.parser.runtime, "tree-sitter");
  assert.equal(result.parser.runtimeVersion, "0.25.0");
  assert.equal(result.files[0].sha256, sha256);
  assert.deepEqual(result.diagnostics, []);
  const declaration = result.facts.functions.find((fact) => fact.name === "greet");
  assert.ok(declaration);
  const call = result.facts.calls.find((fact) => fact.callee === "greet");
  assert.equal(call.targetFunctionId, declaration.id);
  assert.deepEqual(call.span.start, { line: 5, column: 8, offset: source.indexOf("greet(label)") });
});

test("AppContainer denies file/child operations and cannot reach a host-reachable loopback listener", { skip: !windows, timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "Potassium-parser-denials-"));
  const accepted = [];
  const server = net.createServer((socket) => { accepted.push(true); socket.end("listener-control"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const control = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let message = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2000, () => socket.destroy(new Error("Host listener positive control timed out")));
      socket.on("data", (chunk) => { message += chunk; if (message.length > 64) socket.destroy(new Error("Unexpected listener control payload")); });
      socket.once("error", reject);
      socket.once("end", () => { socket.setTimeout(0); resolve(message); });
    });
    assert.equal(control, "listener-control");
    assert.deepEqual(accepted, [true]);
    const paths = ["config.json", "token.txt", "provided-source.luau"].map((name) => path.join(temporary, name));
    await Promise.all(paths.map((filename) => writeFile(filename, "owned-probe-secret")));
    const result = await probe({ mode: "denials", paths, port }, { environment: { PARSER_PROBE_TOKEN: "must-not-be-inherited", NODE_OPTIONS: "", DOTNET_STARTUP_HOOKS: "" } });
    // This exact controller replies only after Dispose; a cleanup failure
    // replaces its native result with PARSER_CLEANUP_FAILED.
    assert.notEqual(result.error?.code, "PARSER_CLEANUP_FAILED", JSON.stringify(result.error));
    assert.equal(result.schema, 1); assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.equal(result.childReady, true);
    assert.equal(result.files.length, paths.length);
    for (const file of result.files) { assert.equal(file.attempted, true); assert.equal(file.allowed, false); assert.equal(file.error, 5); }
    assert.deepEqual(result.stageWrite, { attempted: true, allowed: false, error: 5 });
    assert.equal(result.process.attempted, true); assert.equal(result.process.allowed, false);
    assert.ok([5, 1816].includes(result.process.error), JSON.stringify(result.process));
    assert.equal(result.network.available, true, JSON.stringify(result.network));
    assert.equal(result.network.attempted, true); assert.equal(result.network.allowed, false);
    // Preserve the real result: explicit WSAEACCES or bounded WSAETIMEDOUT.
    // This qualifies this reachable loopback endpoint, not all possible networks.
    assert.ok([10013, 10060].includes(result.network.error), JSON.stringify(result.network));
    assert.deepEqual(accepted, [true]);
    assert.deepEqual(result.environment, { PARSER_PROBE_TOKEN: false, NODE_OPTIONS: false, DOTNET_STARTUP_HOOKS: false });
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
});

test("AppContainer worker CPU, memory, output and wall limits terminate work", { skip: !windows, timeout: 90000 }, async (context) => {
  for (const [mode, code] of [["cpu", "PARSER_CPU_LIMIT"], ["stdout", "PARSER_OUTPUT_LIMIT"], ["wall", "PARSER_WALL_LIMIT"]]) {
    await context.test(mode, async () => {
      const result = await probe({ mode });
      assert.equal(result.childReady, true);
      assert.equal(result.error?.code, code, JSON.stringify(result));
      if (mode === "cpu") {
        // Proves the fixed 1s CPU probe, not a wall timeout or the production 5s duration.
        const reports = result.error.probeDiagnostics.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        assert.equal(reports.find((report) => report.workerExit !== undefined)?.cpuLimitMilliseconds, 1000);
      }
    });
  }
  await context.test("memory", async () => {
    const result = await probe({ mode: "memory" });
    assert.equal(result.childReady, true);
    assert.equal(result.error?.code, "PARSER_WORKER_EXIT", JSON.stringify(result));
    const reports = result.error.probeDiagnostics.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const exit = reports.find((report) => report.workerExit !== undefined);
    assert.equal(exit?.workerExit, 3);
    const denied = /parser-probe-memory-allocation-denied:(\d+):(\d+)/.exec(exit.workerStderr);
    assert.ok(denied, exit.workerStderr);
    assert.ok([8, 1455, 1816].includes(Number(denied[1])));
    assert.ok(Number(denied[2]) > 128 * 1024 * 1024 && Number(denied[2]) <= 256 * 1024 * 1024);
  });
});

test("parent-channel cancellation removes the owned runtime and profile lease", { skip: !windows, timeout: 30000 }, async () => {
  let child, markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const pending = probe({ mode: "wall" }, { onSpawn: (value) => { child = value; }, onReady: markReady });
  try {
    await Promise.race([ready, pending.then((result) => { throw new Error(`Parser did not start: ${JSON.stringify(result)}`); })]);
    const lease = await newLease(child);
    child.stdin.end();
    const result = await pending;
    assert.equal(result.error?.code, "PARSER_CANCELLED");
    await assertLeaseRemoved(lease);
  } finally {
    child?.stdin.end();
    await pending.catch(() => {});
  }
});

test("a subsequent host recovers only an abandoned owned parser lease", { skip: !windows, timeout: 40000 }, async () => {
  let child, markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const pending = probe({ mode: "wall" }, { onSpawn: (value) => { child = value; }, onReady: markReady });
  try {
    await Promise.race([ready, pending.then((result) => { throw new Error(`Parser did not start: ${JSON.stringify(result)}`); })]);
    const lease = await newLease(child);
    await assert.rejects(async () => {
      child.kill();
      await pending;
    }, /Parser probe host exited/);
    const foreign = await mkdtemp(path.join(workspaceRoot, "foreign-"));
    try {
      await writeFile(path.join(foreign, "keep.txt"), "foreign");
      const result = await probe({ mode: "stdout" }); assert.equal(result.childReady, true); assert.equal(result.error?.code, "PARSER_OUTPUT_LIMIT");
      await assertLeaseRemoved(lease);
      assert.equal(await readFile(path.join(foreign, "keep.txt"), "utf8"), "foreign");
    } finally { await rm(foreign, { recursive: true }); }
  } finally {
    child?.stdin.end();
    await pending.catch(() => {});
  }
});

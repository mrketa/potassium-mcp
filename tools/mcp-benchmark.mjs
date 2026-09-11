import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import fsBuiltin from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBootstrap } from "./bootstrap-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = 20260907;
const policy = Object.freeze({ warmup: 3, repetitions: 10, maximumRepetitions: 30, p95RegressionFraction: 0.05, maximumRepeatNoiseFraction: 0.03, minimumRetainedRegressionBytes: 65536 });
const unavailable = [
  { id: "I3.engine", reason: "Lune fixture GetChildren clones a Lua table, not an engine array. Engine allocations, engine CPU, true peak/retained engine memory and engine path costs require an approved Roblox run." },
  { id: "I4.engine", reason: "Fixture signals/scheduler do not prove real engine deferred signal ordering or callback latency. Lua retained byte counts and allocation counts are unavailable; reported slots/listeners are logical counters only." },
];
const contract = {
  schemaVersion: 1, seed, policy,
  suites: {
    node: ["I1.host: isolated real setup once, then register/remove and idempotent host refresh; npm/host-CLI/deploy counters exclude setup", "I6.envelope: 1KiB/64KiB/256KiB plain and escaped values; 128KiB rejection boundary", "I6.artifact: 64KiB/1MiB/4MiB redacted text; adjacent 127-byte pages at fixed offsets; exact read/path/close counters"],
    bootstrap: ["I2: same 20 targets; property singles versus mixed batch; path/ref; ordinary/32 duplicate/absent middle/escaped/full budgets", "I3: wide/deep 1000/10000/50000 nodes, identical long names, maxVisited 1/64, limit 1", "I4: 16 watches, 400 events each, 3-event slow pages, replay/stop checks; 400-message async console burst, 3-entry pages"],
    broker: ["I5: isolated real detached broker, real SDK HTTP and authenticated synthetic executor; 256 requests at concurrency 1/8; exact state write/rename attempts, completions, bytes and busy/idle commits; live drain must await a held request"],
  },
  resultSchema: {
    case: "{id,input,surface,samples:[{wallMs,cpuMs?,bytes,counters,heapUsedDeltaBytes?,retainedHeapDeltaBytes?}],summary:{wallMs:{p50,p95,max},cpuMs?,bytes?,counters?},unavailable?}",
    report: "{schemaVersion,label,createdAt,runtime,sourceSha256|null,provenance:{status,before,after,changedFiles},seed,policy,cases,evidence,unavailable}",
    memory: "Node heap deltas are noisy process observations, not allocations; post-GC retained deltas require --expose-gc. Synchronous operations do not provide sampled transient peak memory.",
    comparability: "Duplicate/escaped batches can stop at shared value/byte budgets while 20 singles continue; compare coverage/counters, not their latency as equivalent completed work. Artifact counter instrumentation and assertions are included in timings.",
    provenance: "Hash all MCP source modules, bootstrap assets/fixture/runner/harness and package manifests before and after workloads. A mismatch writes invalid-source-changed evidence, clears sourceSha256 and exits nonzero. Comparison rejects mixed, legacy end-only and differently revised repeat reports.",
  },
  unavailable,
};
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}
function summarize(samples) {
  const result = {};
  for (const key of ["wallMs", "cpuMs", "bytes", "heapUsedDeltaBytes", "retainedHeapDeltaBytes"]) {
    if (samples.every((sample) => Number.isFinite(sample[key]))) result[key] = distribution(samples.map((sample) => sample[key]));
  }
  result.counters = {};
  for (const key of Object.keys(samples[0]?.counters ?? {})) {
    if (samples.every((sample) => Number.isFinite(sample.counters[key]))) result.counters[key] = distribution(samples.map((sample) => sample.counters[key]));
  }
  return result;
}
async function measure(id, input, operation, repetitions) {
  const samples = [];
  for (let index = 0; index < policy.warmup + repetitions; index += 1) {
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();
    const start = performance.now();
    let observation = await operation();
    const wallMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    const after = process.memoryUsage().heapUsed;
    const sample = { wallMs, cpuMs: (usage.user + usage.system) / 1000, bytes: observation.bytes, counters: observation.counters, heapUsedDeltaBytes: after - before };
    observation = null;
    if (global.gc) { global.gc(); sample.retainedHeapDeltaBytes = process.memoryUsage().heapUsed - before; }
    if (index >= policy.warmup) samples.push(sample);
  }
  return { id, input, surface: "node-real-implementation", samples, summary: summarize(samples) };
}
async function nodeCases(repetitions) {
  const { formatToolResult } = await import("../potassium-mcp/src/server.js");
  const { readArtifact } = await import("../potassium-mcp/src/safe-read.js");
  const cases = [];
  for (const size of [1024, 65536, 262144]) {
    for (const escaped of [false, true]) {
      const unit = escaped ? '\\"\n\t雪' : "a";
      const value = { value: unit.repeat(Math.ceil(size / Buffer.byteLength(unit))).slice(0, size), seed };
      for (const limit of [131072, 4194304]) {
        const originalStringify = JSON.stringify;
        let stringifyCalls = 0;
        let diagnostic;
        try {
          JSON.stringify = (...args) => { stringifyCalls += 1; return originalStringify(...args); };
          diagnostic = formatToolResult(value, limit);
        } finally { JSON.stringify = originalStringify; }
        const expectedError = diagnostic.isError === true;
        cases.push(await measure(`I6.envelope.${size}.${escaped ? "escaped" : "plain"}.${limit}`, { size, escaped, limit, inputBytes: Buffer.byteLength(JSON.stringify(value)) }, () => {
          const result = formatToolResult(value, limit);
          assert.equal(result.isError === true, expectedError);
          if (!result.isError) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
          const bytes = Buffer.byteLength(JSON.stringify(result));
          assert(bytes <= limit, "complete MCP envelope exceeds declared limit");
          return { bytes, counters: { formatterStringifyCalls: stringifyCalls, resultLimitErrors: Number(expectedError) } };
        }, repetitions));
      }
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "potassium-measurement-"));
  try {
    const token = "fixture-measurement-token-20260907";
    const secret = "fixture-cross-page-credential-20260907";
    const line = `safe-before password=${secret} safe-after token=${token}\n`;
    const config = { token, artifactRoots: [{ name: "measurement", path: directory, extensions: [".txt"], recursive: false }] };
    for (const size of [65536, 1048576, 4194304]) {
      const filename = `records-${size}.txt`;
      const raw = line.repeat(Math.floor(size / Buffer.byteLength(line))) + "x".repeat(size % Buffer.byteLength(line));
      await fs.writeFile(path.join(directory, filename), raw);
      const initial = await readArtifact({ root: "measurement", path: filename, maxBytes: 4096 }, config);
      assert(!initial.text.includes(secret) && !initial.text.includes(token));
      for (const offset of [0, 113]) {
        cases.push(await measure(`I6.artifact.${size}.${offset}`, { rawFileBytes: size, pageBytes: 127, offset, adjacentPages: 2 }, async () => {
          const counters = { opens: 0, reads: 0, rawBytesRead: 0, stats: 0, realpaths: 0, closes: 0 };
          const dependencies = {
            realpath: (...args) => { counters.realpaths += 1; return fs.realpath(...args); },
            stat: (...args) => { counters.stats += 1; return fs.stat(...args); },
            open: async (...args) => {
              counters.opens += 1;
              const handle = await fs.open(...args);
              return {
                stat: (...values) => { counters.stats += 1; return handle.stat(...values); },
                read: async (...values) => { counters.reads += 1; const read = await handle.read(...values); counters.rawBytesRead += read.bytesRead; return read; },
                close: () => { counters.closes += 1; return handle.close(); },
              };
            },
          };
          const pages = [];
          for (const pageOffset of [offset, offset + 127]) pages.push(await readArtifact({ root: "measurement", path: filename, offsetBytes: pageOffset, maxBytes: 127 }, config, dependencies));
          const joined = pages.map((page) => page.text).join("");
          assert.equal(joined, initial.text.slice(offset, offset + 254), "adjacent pages must use the redacted coordinate space");
          assert(!joined.includes(secret) && !joined.includes(token));
          assert.equal(counters.opens, counters.closes);
          return { bytes: Buffer.byteLength(JSON.stringify(pages)), counters };
        }, repetitions));
      }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  return cases;
}

async function hostCases(repetitions) {
  const { setup, registerHost, removeHost } = await import("../potassium-mcp/src/install.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "potassium-host-measurement-"));
  let counters = { subprocessAttempts: 0, npmProcessAttempts: 0, hostCliAttempts: 0, deploymentActivations: 0 };
  const options = {
    installRoot: path.join(directory, "private"),
    workspaceRoot: path.join(directory, "workspace"),
    runtimeRoot: path.join(root, "potassium-mcp"),
    cwd: directory,
    env: { ...process.env, POTASSIUM_MCP_CONFIG: undefined, POTASSIUM_MCP_INSTALL_ROOT: undefined, POTASSIUM_WORKSPACE: undefined },
    onDeploymentActivation: () => { counters.deploymentActivations += 1; },
    run: (command, args, settings) => {
      counters.subprocessAttempts += 1;
      if (/^(?:npm|npx)(?:\.cmd|\.exe)?$/i.test(path.basename(command)) || args.some((argument) => /npm-cli\.js$/i.test(argument))) {
        counters.npmProcessAttempts += 1;
        throw new Error("host measurement refuses npm execution");
      }
      assert(["icacls", "powershell.exe"].includes(path.basename(command).toLowerCase()), "unexpected subprocess in isolated host operation");
      return spawnSync(command, args, { ...settings, timeout: 10000 });
    },
    runCommand: () => { counters.hostCliAttempts += 1; throw new Error("file-backed host benchmark must not execute host CLI"); },
  };
  try {
    await fs.mkdir(options.workspaceRoot);
    await setup(options); // Real private deployment, excluded from host-only timing/counters.
    const host = { ...options, host: "omp", hostId: "omp", mcpConfigPath: path.join(directory, "host", "mcp.json") };
    const initial = await registerHost(host);
    assert.equal(initial.registered, true);
    const cases = [];
    for (const cycle of [false, true]) {
      cases.push(await measure(`I1.host.${cycle ? "remove-register-cycle" : "idempotent-refresh"}`, { adapter: "omp", cycle, setupExcluded: true, commandCounterScope: "installer run/runCommand injection seams" }, async () => {
        counters = { subprocessAttempts: 0, npmProcessAttempts: 0, hostCliAttempts: 0, deploymentActivations: 0 };
        if (cycle) await removeHost(host);
        const result = await registerHost(host);
        assert.equal(result.registered, true);
        assert.equal(counters.npmProcessAttempts, 0);
        assert.equal(counters.deploymentActivations, 0);
        assert.equal(counters.hostCliAttempts, 0);
        const content = await fs.readFile(host.mcpConfigPath, "utf8");
        assert(content.includes("potassium") && content.includes("--host-id"));
        return { bytes: Buffer.byteLength(content), counters };
      }, repetitions));
    }
    return cases;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function bootstrapSource(repetitions) {
  return String.raw`local serde = require("@lune/serde")
return function(fixture)
  local cases = {}
  local warmup, repetitions = 3, ${repetitions}
  local function instrument(f)
    local counters = { encodeCalls = 0, getChildrenCalls = 0, childrenMaterialized = 0, pathCalls = 0, lookupCalls = 0, schedulerSteps = 0 }
    local http = f.environment.game:GetService("HttpService")
    local encode = http.JSONEncode
    http.JSONEncode = function(self, value) counters.encodeCalls += 1; return encode(self, value) end
    local step = f.scheduler.step
    f.scheduler.step = function() counters.schedulerSteps += 1; return step() end
    local function node(value)
      local children, fullName, lookup = value.GetChildren, value.GetFullName, value.FindFirstChild
      value.GetChildren = function(self) counters.getChildrenCalls += 1; local result = children(self); counters.childrenMaterialized += #result; return result end
      value.GetFullName = function(self) counters.pathCalls += 1; return fullName(self) end
      value.FindFirstChild = function(self, name) counters.lookupCalls += 1; return lookup(self, name) end
      return value
    end
    node(f.workspace)
    return counters, node
  end
  local function record(id, input, setup, operation)
    local f = fixture()
    local counters, node = instrument(f)
    local socket = f.boot(); f.authenticate(socket)
    local context = setup(f, socket, node)
    local samples = {}
    for iteration = 1, warmup + repetitions do
      -- Repeated wide scans advance virtual time; emulate the broker heartbeat
      -- outside timing instead of allowing a healthy reused fixture to expire.
      f.scheduler.advance(0)
      table.clear(socket.sent) -- Fixture transport retention is not production retention.
      for key in pairs(counters) do counters[key] = 0 end
      local started = os.clock()
      local virtualStarted = f.environment.os.clock()
      local result, extra = operation(f, socket, context)
      local elapsed = (os.clock() - started) * 1000
      local measured = table.clone(counters)
      measured.virtualElapsedSeconds = f.environment.os.clock() - virtualStarted
      for key, value in pairs(extra or {}) do measured[key] = value end
      measured.responseFrames = 0
      measured.responseFrameBytes = 0
      for _, message in ipairs(socket.sent) do
        if message.type == "response" then
          measured.responseFrames += 1
          measured.responseFrameBytes += #serde.encode("json", message)
        end
      end
      local bytes = #serde.encode("json", result)
      if iteration > warmup then table.insert(samples, { wallMs = elapsed, bytes = bytes, counters = measured }) end
    end
    f.teardown()
    table.insert(cases, { id = id, input = input, surface = "lune-isolated-fixture-real-bootstrap", samples = samples,
      unavailable = { "CPU/allocation/peak/retained byte counts unavailable; logical counters only", "Fixture timing excludes tree setup and teardown; real os.clock is outside virtual scheduler" } })
  end
  for _, variant in ipairs({ "ordinary", "duplicates", "missing", "escaped", "full" }) do
    for _, references in ipairs({ false, true }) do
      for _, batching in ipairs({ false, true }) do
        local id = "I2." .. variant .. "." .. (references and "ref" or "path") .. "." .. (batching and "batch" or "single")
        record(id, { targets = 20, variant = variant, references = references, batching = batching, maxTotalValues = 200 }, function(f, socket, node)
          local targets, requests = {}, {}
          for index = 1, 20 do
            local target = node(f.instance(string.format("Target%02d", index), "StringValue", f.workspace))
            target.Value = variant == "escaped" and string.rep("\"\\\n\t", 1000) or "value-" .. tostring(index)
            for key = 1, 4 do target.attributes["A" .. tostring(key)] = key % 2 == 0 and false or key end
            node(f.instance("Child", "Folder", target))
            targets[index] = "workspace." .. target.Name
            requests[index] = { path = targets[index], properties = { "Name" } }
          end
          if references then
            local acquired = f.request(socket, "batch_read", { requests = requests, includeReferences = true })
            for index, row in ipairs(acquired.results) do targets[index] = assert(row.instance.reference) end
          end
          for index = 1, 20 do
            local properties = { "Value" }
            if variant == "duplicates" then properties = table.create(32, "Value") end
            if variant == "full" then properties = { "Name", "ClassName", "Value", "Archivable", "Parent" } end
            requests[index] = { path = variant == "missing" and index == 10 and "workspace.Absent" or targets[index], properties = properties }
            if variant == "ordinary" or variant == "full" then
              requests[index].attributes = { names = { "A1", "A2", "A3", "A4" }, limit = 4 }
              requests[index].children = { limit = 1 }
            end
          end
          return requests
        end, function(f, socket, requests)
          if batching then
            local result = f.request(socket, "batch_read", { requests = requests, includeReferences = references, maxTotalValues = 200 })
            assert(#result.results == 20 and result.valueCount <= 200 and #serde.encode("json", result) <= 65536)
            if variant == "missing" then assert(not result.results[10].ok and result.results[11].ok) end
            return result, { requests = 1, valuesAttempted = result.valueCount }
          end
          local results, calls = {}, 0
          for index, request in ipairs(requests) do
            local pending = f.begin(socket, "read_properties", { path = request.path, properties = request.properties })
            f.scheduler.untilTrue(pending); calls += 1
            local response = pending()
            assert(response.ok == not (variant == "missing" and index == 10), "single target outcome differs from fixed workload")
            table.insert(results, response)
            if request.attributes then table.insert(results, f.request(socket, "attribute_inventory", { path = request.path, attributeNames = request.attributes.names, limit = 4 })); calls += 1 end
            if request.children then table.insert(results, f.request(socket, "list_children", { path = request.path, limit = 1, includeReferences = references })); calls += 1 end
          end
          if variant == "missing" then assert(not results[10].ok and results[11].ok) end
          return results, { requests = calls }
        end)
      end
    end
  end
  for _, shape in ipairs({ "wide", "deep" }) do
    for _, size in ipairs({ 1000, 10000, 50000 }) do
      for _, maximum in ipairs({ 1, 64 }) do
        record("I3." .. shape .. "." .. tostring(size) .. "." .. tostring(maximum), { shape = shape, nodes = size, maxVisited = maximum, limit = 1, nameBytes = 64 }, function(f, _, node)
          local parent = f.workspace
          for _ = 1, size do
            local current = node(f.instance(string.rep("Same", 16), "Folder", parent))
            if shape == "deep" then parent = current end
          end
        end, function(f, socket)
          local result = f.request(socket, "find_instances", { root = "workspace", nameContains = "absent", limit = 1, maxVisited = maximum })
          assert(result.visited <= maximum and #result.results == 0 and result.truncated)
          return result, { visited = result.visited }
        end)
      end
    end
  end
  record("I4.watch-burst", { watches = 16, eventsPerWatch = 400, pageLimit = 3, payloadBytes = 1024 }, function() end, function(f, socket)
    local ids = {}
    for index = 1, 16 do ids[index] = f.request(socket, "watch_start", { path = "workspace", maxEvents = 200, includeChildren = false }).watchId end
    for index = 1, 400 do f.workspace:SetAttribute("Payload", string.rep("x", 1018) .. string.format("%06d", index)) end
    f.scheduler.advance(2)
    local dropped, retained, maximumBytes, pages = 0, 0, 0, {}
    for _, id in ipairs(ids) do
      local first = f.request(socket, "watch_poll", { watchId = id, limit = 3 })
      local replay = f.request(socket, "watch_poll", { watchId = id, limit = 3 })
      assert(serde.encode("json", first) == serde.encode("json", replay), "same cursor must replay the same suffix")
      local events, page = {}, first
      dropped += first.dropped
      for _ = 1, 68 do
        for _, event in ipairs(page.events) do table.insert(events, event) end
        if not page.hasMore then break end
        page = f.request(socket, "watch_poll", { watchId = id, afterCursor = page.nextCursor, limit = 3 })
      end
      assert(not page.hasMore and #events + first.dropped == 400)
      assert(#events <= 200 and #serde.encode("json", events) <= 65536)
      retained += #events; maximumBytes = math.max(maximumBytes, #serde.encode("json", events))
      f.request(socket, "watch_stop", { watchId = id })
      local stopped = f.request(socket, "watch_poll", { watchId = id, afterCursor = page.nextCursor })
      assert(#stopped.events == 0 and stopped.nextCursor == page.nextCursor)
      table.insert(pages, { dropped = first.dropped, retained = #events, cursor = page.nextCursor })
    end
    f.workspace:SetAttribute("AfterStop", true)
    for index, id in ipairs(ids) do
      local stopped = f.request(socket, "watch_poll", { watchId = id, afterCursor = pages[index].cursor })
      assert(#stopped.events == 0 and stopped.nextCursor == pages[index].cursor)
    end
    assert(f.workspace:ListenerCount() == 0)
    return pages, { eventsEmitted = 6400, dropped = dropped, retainedEvents = retained, maximumBufferBytes = maximumBytes, callbacksAfterStop = 0, activeListenersAfterStop = f.workspace:ListenerCount() }
  end)
  record("I4.console-burst", { messages = 400, payloadBytes = 1024, pageLimit = 3, capture = "job-print-wrapper" }, function() end, function(f, socket)
    f.global.benchmarkBurstDone = false
    local id = f.request(socket, "execute_luau_async", { code = [[
      for index = 1, 400 do print(string.rep("c", 1018) .. string.format("%06d", index)) end
      _G.benchmarkBurstDone = true
      task.wait(4)
      return true
    ]] }).jobId
    f.scheduler.untilTrue(function() return f.global.benchmarkBurstDone end)
    f.scheduler.advance(2)
    local first = f.request(socket, "async_job_console", { jobId = id, limit = 3 })
    local replay = f.request(socket, "async_job_console", { jobId = id, limit = 3 })
    assert(serde.encode("json", first) == serde.encode("json", replay))
    local cursor, entries = 0, {}
    for _ = 1, 68 do
      local page = f.request(socket, "async_job_console", { jobId = id, afterCursor = cursor, limit = 3 })
      for _, entry in ipairs(page.entries) do assert(entry.cursor > cursor); cursor = entry.cursor; table.insert(entries, entry) end
      if #page.entries == 0 then break end
    end
    assert(#entries > 0 and #entries <= 200)
    f.finished(socket, id)
    return entries, { emitted = 400, retainedEntries = #entries, inferredDroppedByKnownInput = 400 - #entries, lastCursor = cursor, activeLogListeners = f.logService.MessageOut:Count() }
  end)
  return { kind = "measurements", measurements = cases }
end`;
}
async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw new Error("bounded broker measurement wait expired");
}
function nextFrame(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("broker measurement frame timed out")), 10000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off("message", message);
      socket.off("error", failed);
      socket.off("close", closed);
      if (error) reject(error); else resolve(value);
    };
    const message = (data) => {
      try { const value = JSON.parse(data.toString()); if (predicate(value)) finish(null, value); }
      catch (error) { finish(error); }
    };
    const failed = (error) => finish(error);
    const closed = () => finish(new Error("broker measurement socket closed before frame"));
    socket.on("message", message); socket.once("error", failed); socket.once("close", closed);
  });
}
async function openSocket(WebSocket, address) {
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("broker measurement connect timed out")); }, 10000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}
function installStateObserver(statePath) {
  const originalWrite = fsBuiltin.promises.writeFile;
  const originalRename = fsBuiltin.promises.rename;
  const originalMkdir = fsBuiltin.promises.mkdir;
  const stateDirectory = path.dirname(statePath);
  const staged = new Map();
  const empty = () => ({ writeAttempts: 0, writeCompletions: 0, writeBytes: 0, renameAttempts: 0, renameCompletions: 0, directoryAttempts: 0, directoryCompletions: 0, failures: 0, busyCommits: 0, idleCommits: 0 });
  let counters = empty(), inflight = 0, sequence = 0, last = null;
  const isStaged = (value) => typeof value === "string" && value.startsWith(`${statePath}.`) && /^[a-f0-9]{16}\.tmp$/.test(value.slice(statePath.length + 1));
  // writeAtomic awaits parent mkdir before writeFile. Track that I/O phase
  // without counting directory operations as metadata writes.
  fsBuiltin.promises.mkdir = async function(target, ...rest) {
    if (target !== stateDirectory) return originalMkdir.call(this, target, ...rest);
    counters.directoryAttempts += 1; inflight += 1; sequence += 1;
    try {
      const result = await originalMkdir.call(this, target, ...rest);
      counters.directoryCompletions += 1;
      return result;
    } catch (error) { counters.failures += 1; throw error; }
    finally { inflight -= 1; sequence += 1; }
  };
  fsBuiltin.promises.writeFile = async function(target, value, ...rest) {
    if (!isStaged(target) && target !== statePath) return originalWrite.call(this, target, value, ...rest);
    counters.writeAttempts += 1; inflight += 1; sequence += 1;
    try {
      const decoded = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
      const summary = { busy: decoded.active !== null || (decoded.activeRequests?.length ?? 0) > 0, draining: decoded.draining === true };
      counters.writeBytes += Buffer.byteLength(value);
      const result = await originalWrite.call(this, target, value, ...rest);
      counters.writeCompletions += 1;
      if (target === statePath) { last = summary; counters[summary.busy ? "busyCommits" : "idleCommits"] += 1; }
      else staged.set(target, summary);
      return result;
    } catch (error) { counters.failures += 1; throw error; }
    finally { inflight -= 1; sequence += 1; }
  };
  fsBuiltin.promises.rename = async function(from, to, ...rest) {
    if (to !== statePath || !isStaged(from)) return originalRename.call(this, from, to, ...rest);
    counters.renameAttempts += 1; inflight += 1; sequence += 1;
    try {
      const result = await originalRename.call(this, from, to, ...rest);
      counters.renameCompletions += 1;
      const summary = staged.get(from);
      assert(summary, "state rename was not preceded by an observed state write");
      last = summary; counters[summary.busy ? "busyCommits" : "idleCommits"] += 1;
      staged.delete(from);
      return result;
    } catch (error) { counters.failures += 1; throw error; }
    finally { inflight -= 1; sequence += 1; }
  };
  syncBuiltinESMExports();
  return {
    snapshot: () => ({ ...counters }),
    current: () => last,
    diagnostic: () => ({ counters: { ...counters }, inflight, sequence, staged: staged.size, last }),
    reset() { assert.equal(inflight, 0); assert.equal(staged.size, 0); counters = empty(); },
    async quiet() {
      await waitFor(async () => {
        if (inflight !== 0 || staged.size !== 0) return false;
        const observedSequence = sequence;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return inflight === 0 && staged.size === 0 && observedSequence === sequence;
      });
    },
    restore() { fsBuiltin.promises.writeFile = originalWrite; fsBuiltin.promises.rename = originalRename; fsBuiltin.promises.mkdir = originalMkdir; syncBuiltinESMExports(); },
  };
}
async function runBrokerScenario(statePath, observer, repetitions) {
  const require = createRequire(path.join(root, "potassium-mcp", "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")));
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")));
  const config = JSON.parse(await fs.readFile(path.join(path.dirname(statePath), "config.json"), "utf8"));
  const state = await waitFor(async () => {
    try { const value = JSON.parse(await fs.readFile(statePath, "utf8")); return value.streamableHttp?.endpoint ? value : false; }
    catch (error) { if (["ENOENT", "EACCES", "EBUSY"].includes(error.code)) return false; throw error; }
  });
  await observer.quiet();
  assert(observer.snapshot().writeCompletions > 0 && observer.snapshot().renameCompletions > 0, "preload did not observe the real initial broker state write");
  const client = new Client({ name: "potassium-persistence-measurement", version: "1.0.0" });
  let executor, manager, releaseHeld, holdNext = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(state.streamableHttp.endpoint), { requestInit: { headers: { authorization: `Bearer ${config.token}` } } }), { timeout: 10000 });
    const status = await client.callTool({ name: "potassium_status", arguments: {} }, undefined, { timeout: 10000 });
    executor = await openSocket(WebSocket, status.structuredContent.endpoint);
    const clientNonce = "a".repeat(64);
    const proof = (role, serverNonce) => createHmac("sha256", config.token).update(createHash("sha256").update(`potassium-mcp/v2|${role}|${clientNonce}|${serverNonce}`).digest("hex")).digest("base64");
    const challengePromise = nextFrame(executor, (frame) => frame.type === "challenge");
    executor.send(JSON.stringify({ type: "hello", protocol: 2, clientId: "b".repeat(32), generation: 1, clientNonce, client: { executor: "measurement", protocol: 2 } }));
    const challenge = await challengePromise;
    assert.equal(challenge.proof, proof("server", challenge.serverNonce));
    const ready = nextFrame(executor, (frame) => frame.type === "ready");
    executor.send(JSON.stringify({ type: "ack", protocol: 2, clientNonce, serverNonce: challenge.serverNonce, proof: proof("client", challenge.serverNonce) }));
    await ready;
    executor.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "ping") { executor.send(JSON.stringify({ type: "pong", nonce: message.nonce })); return; }
      if (message.type !== "request") return;
      assert.equal(message.method, "read_properties", "unexpected executor operation in broker measurement");
      const respond = () => executor.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { instance: { name: "Workspace", className: "Workspace", path: "Workspace" }, properties: { Name: { ok: true, value: "Workspace" } } } }));
      if (holdNext) { holdNext = false; releaseHeld = respond; }
      else setImmediate(respond);
    });
    const read = async () => {
      const result = await client.callTool({ name: "potassium_read_properties", arguments: { path: "workspace", properties: ["Name"] } }, undefined, { timeout: 10000 });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.properties.Name.value, "Workspace");
      return Buffer.byteLength(JSON.stringify(result));
    };
    const cases = [];
    for (const concurrency of [1, 8]) {
      let iteration = 0;
      await observer.quiet();
      cases.push(await measure(`I5.persistence.${concurrency}`, { requests: 256, concurrency, method: "read_properties", instrumentation: "preload exact state writeFile/rename only", filesystemFlush: "OS completion, not fsync durability" }, async () => {
        await observer.quiet(); observer.reset();
        iteration += 1;
        let bytes = 0;
        for (let index = 0; index < 256; index += concurrency) {
          const results = await Promise.all(Array.from({ length: concurrency }, read));
          bytes += results.reduce((sum, value) => sum + value, 0);
        }
        await observer.quiet();
        const counters = observer.snapshot();
        assert.equal(counters.failures, 0);
        assert(counters.writeCompletions > 0 && counters.busyCommits > 0 && counters.idleCommits > 0);
        assert.equal(counters.writeAttempts, counters.writeCompletions);
        assert.equal(counters.renameAttempts, counters.renameCompletions);
        assert.equal(counters.writeCompletions, counters.renameCompletions);
        if (observer.current().busy) {
          const atAssertion = observer.diagnostic();
          const raw = JSON.parse(await fs.readFile(statePath, "utf8"));
          const afterDiskRead = observer.diagnostic();
          const liveResult = await client.callTool({ name: "potassium_status", arguments: {} }, undefined, { timeout: 10000 });
          assert.notEqual(liveResult.isError, true);
          const safeActivity = (value) => ({
            active: value.active != null,
            activeMethod: value.active?.method === "read_properties" ? "read_properties" : value.active?.method ? "other" : null,
            activeRequests: Array.isArray(value.activeRequests) ? value.activeRequests.length : null,
            pendingRequests: Number.isInteger(value.pendingRequests) ? value.pendingRequests : null,
            queuedRequests: Number.isInteger(value.queuedRequests) ? value.queuedRequests : null,
            draining: value.draining === true,
            recovering: value.recovering === true,
          });
          throw new Error(`final persisted broker state must be idle; diagnostic=${JSON.stringify({ concurrency, iteration, requestsCompleted: 256, atAssertion, rawState: safeActivity(raw), afterDiskRead, liveState: safeActivity(liveResult.structuredContent), afterLiveRead: observer.diagnostic() })}`);
        }
        assert.equal(observer.current().busy, false, "final persisted broker state must be idle");
        return { bytes, counters: { ...counters, requestsCompleted: 256, finalIdle: 1 } };
      }, repetitions));
    }
    // The manager's real authenticated drain protocol must not acknowledge stale disk idle.
    const { proxyProof } = await import("../potassium-mcp/src/broker.js");
    manager = await openSocket(WebSocket, `ws://127.0.0.1:${state.proxyPort}`);
    const managerNonce = "c".repeat(64), hostId = "omp", leaseId = "d".repeat(32);
    const proxyChallenge = nextFrame(manager, (frame) => frame.type === "proxy-challenge");
    manager.send(JSON.stringify({ type: "proxy-hello", protocol: 1, hostId, clientNonce: managerNonce }));
    const proxy = await proxyChallenge;
    assert.equal(proxy.proof, proxyProof(config.token, "server", managerNonce, proxy.serverNonce, hostId));
    const proxyReady = nextFrame(manager, (frame) => frame.type === "proxy-ready");
    manager.send(JSON.stringify({ type: "proxy-ack", proof: proxyProof(config.token, "client", managerNonce, proxy.serverNonce, hostId) }));
    await proxyReady;
    holdNext = true;
    const heldRequest = read();
    void heldRequest.catch(() => {}); // Awaited below; cleanup may fail first.
    await waitFor(() => releaseHeld);
    await waitFor(() => observer.current()?.busy === true);
    let drained = false;
    const drainReply = nextFrame(manager, (frame) => frame.type === "broker-drained").then((frame) => { drained = true; return frame; });
    void drainReply.catch(() => {}); // Keep the bounded frame wait handled during cleanup.
    manager.send(JSON.stringify({ type: "broker-drain", instanceId: state.instanceId, leaseId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drained, false, "broker drain acknowledged while the observed request was held");
    releaseHeld(); releaseHeld = undefined;
    await heldRequest;
    const acknowledgment = await drainReply;
    assert.equal(acknowledgment.instanceId, state.instanceId);
    assert.equal(acknowledgment.leaseId, leaseId);
    await observer.quiet();
    assert.equal(observer.current().busy, false);
    const evidence = { preloadObservedInitialWrite: true, heldRequestPersistedBusy: true, drainAcknowledgmentBeforeRelease: false, drainAcknowledgedAfterRelease: true, finalPersistedIdle: true, scope: "real manager drain handshake; no restart process launched; no Roblox engine execution" };
    manager.close(); manager = undefined;
    executor.close(); executor = undefined;
    await client.close();
    process.emit("SIGTERM");
    const receiptPath = path.join(path.dirname(statePath), "broker-stopped.json");
    await waitFor(async () => { try { await fs.stat(receiptPath); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } });
    await observer.quiet();
    await verifyStoppedEvidence(statePath, state);
    return { cases, evidence: { ...evidence, stateRetainedOnShutdown: true, matchingStoppedReceipt: true } };
  } finally {
    releaseHeld?.();
    manager?.terminate(); executor?.terminate();
    await client.close().catch(() => {});
    process.emit("SIGTERM");
  }
}
async function verifyStoppedEvidence(statePath, expected) {
  const [state, receipt] = await Promise.all([statePath, path.join(path.dirname(statePath), "broker-stopped.json")].map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
  assert.equal(receipt.stopped, true);
  for (const key of ["instanceId", "pid", "configDigest", "nodeExecutable", "brokerPath", "configPath"]) {
    assert.equal(receipt[key], state[key], `stopped receipt does not match retained state ${key}`);
    if (expected[key] !== undefined) assert.equal(state[key], expected[key], `retained state changed generation ${key}`);
  }
  assert.equal(state.active, null);
  assert.deepEqual(state.activeRequests, []);
}

async function brokerCases(repetitions) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "potassium-broker-measurement-"));
  try {
    const configPath = path.join(directory, "config.json"), statePath = path.join(directory, "broker-state.json");
    await fs.writeFile(configPath, JSON.stringify({ host: "127.0.0.1", port: 0, proxyPort: 0, token: "fixture-measurement-broker-token-20260907", requestTimeoutMs: 10000, maxMessageBytes: 1048576, maxPendingRequests: 32, shutdownGraceMs: 1000, streamableHttpEnabled: true, streamableHttpHost: "127.0.0.1", streamableHttpPort: 0, allowUnsafeExecute: false }), { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", import.meta.url, path.join(root, "potassium-mcp", "src", "broker.js"), "--config", configPath], {
      cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, POTASSIUM_BENCHMARK_STATE: statePath, POTASSIUM_BENCHMARK_REPETITIONS: String(repetitions), POTASSIUM_MCP_CONFIG: configPath, POTASSIUM_MCP_BROKER_STATE: statePath },
    });
    if (result.error || result.status !== 0) throw new Error(`isolated broker measurement failed: ${result.error?.message ?? result.stderr ?? result.status}`);
    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("BROKER_MEASUREMENT="));
    assert(marker, "isolated broker did not emit measurement evidence");
    const report = JSON.parse(marker.slice("BROKER_MEASUREMENT=".length));
    await verifyStoppedEvidence(statePath, { pid: result.pid });
    report.evidence.processExited = true; // spawnSync observed this exact child exit successfully.
    return report;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function sourceDigests() {
  const modules = (await fs.readdir(path.join(root, "potassium-mcp", "src"), { recursive: true })).filter((name) => name.endsWith(".js")).map((name) => `potassium-mcp/src/${name.split(path.sep).join("/")}`);
  const files = ["tools/mcp-benchmark.mjs", "tools/bootstrap-runner.mjs", "tools/bootstrap-runner.luau", "potassium-mcp/test/bootstrap-audit.smoke.luau", "potassium-mcp/assets/potassium_mcp_bootstrap.lua", "potassium-mcp/assets/potassium_mcp_autoexec.lua", "potassium-mcp/package.json", "potassium-mcp/package-lock.json", ...modules].sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex")])));
}
function relativeDifference(left, right) { return Math.abs(left - right) / Math.max(left, right, 0.000001); }
async function compare(files) {
  assert.equal(files.length, 4, "compare requires baseline1 baseline2 candidate1 candidate2");
  const reports = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
  for (const report of reports) {
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.provenance?.status, "stable", "comparison requires stable before/after source provenance; legacy end-only reports are unqualified");
    assert.deepEqual(report.provenance.before, report.provenance.after, "sources changed during measurement");
    assert.deepEqual(report.sourceSha256, report.provenance.before);
    assert.deepEqual(report.policy, reports[0].policy);
    assert.deepEqual(report.runtime, reports[0].runtime, "runtime/CPU/GC mode must match");
    assert.equal(report.seed, seed);
  }
  assert.deepEqual(reports[0].sourceSha256, reports[1].sourceSha256, "baseline repeats must measure the same source revision");
  assert.deepEqual(reports[2].sourceSha256, reports[3].sourceSha256, "candidate repeats must measure the same source revision");
  const cases = reports[0].cases.map((entry) => {
    const peers = reports.map((report) => report.cases.find((candidate) => candidate.id === entry.id));
    assert(peers.every(Boolean), `missing case ${entry.id}`);
    for (const peer of peers) assert.deepEqual(peer.input, entry.input);
    const times = peers.map((peer) => peer.summary.wallMs.p95);
    const noise = Math.max(relativeDifference(times[0], times[1]), relativeDifference(times[2], times[3]));
    const before = (times[0] + times[1]) / 2, after = (times[2] + times[3]) / 2;
    const delta = (after - before) / Math.max(before, 0.000001);
    const threshold = Math.max(policy.p95RegressionFraction, 2 * noise);
    const decision = noise > policy.maximumRepeatNoiseFraction ? "inconclusive-noisy" : delta > threshold ? "p95-regression" : delta < -threshold ? "candidate-gain-needs-safety-review" : "inconclusive-within-tolerance";
    return { id: entry.id, baselineP95Ms: before, candidateP95Ms: after, repeatNoiseFraction: noise, p95ChangeFraction: delta, decision,
      retainedHeap: peers.map((peer) => peer.summary.retainedHeapDeltaBytes ?? null), counters: peers.map((peer) => peer.summary.counters), bytes: peers.map((peer) => peer.summary.bytes) };
  });
  return { schemaVersion: 1, policy, cases, interpretation: "Never accept p95 alone: review CPU/max/retained deltas, bytes and correctness counters. Any retained increase > max(64KiB,5% baseline) blocks acceptance pending explanation. Engine safety remains unproved. Within-noise choices retain current structure." };
}
async function main() {
  const [mode = "plan", ...args] = process.argv.slice(2);
  if (mode === "plan") { assert.equal(args.length, 0); console.log(JSON.stringify(contract, null, 2)); return; }
  if (mode === "compare") { console.log(JSON.stringify(await compare(args), null, 2)); return; }
  assert.equal(mode, "run", "Usage: node [--expose-gc] tools/mcp-benchmark.mjs plan | run <node|bootstrap|broker|all> <output.json> <label> [10..30 repetitions] | compare <base1.json> <base2.json> <after1.json> <after2.json>");
  const [suite, output, label, count = "10"] = args;
  assert(args.length >= 3 && args.length <= 4 && ["node", "bootstrap", "broker", "all"].includes(suite) && output && label);
  const repetitions = Number(count);
  assert(Number.isInteger(repetitions) && repetitions >= 10 && repetitions <= policy.maximumRepetitions);
  const before = await sourceDigests();
  const cases = [], evidence = {};
  if (suite === "node" || suite === "all") cases.push(...await hostCases(repetitions), ...await nodeCases(repetitions));
  if (suite === "broker" || suite === "all") { const broker = await brokerCases(repetitions); cases.push(...broker.cases); evidence.broker = broker.evidence; }
  if (suite === "bootstrap" || suite === "all") {
    const report = await runBootstrap("scenario", { scenarioSource: bootstrapSource(repetitions) });
    const result = report.results[0];
    assert(result.kind === "measurements" && Array.isArray(result.measurements) && result.measurements.length > 0, "scenario returned no measurements");
    for (const entry of result.measurements) { entry.summary = summarize(entry.samples); cases.push(entry); }
  }
  const after = await sourceDigests();
  const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
  const provenance = { status: changedFiles.length === 0 ? "stable" : "invalid-source-changed", before, after, changedFiles };
  const report = { schemaVersion: 1, label, createdAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, gcExposed: typeof global.gc === "function", brokerGcExposed: suite === "broker" || suite === "all" ? true : null, lune: suite === "bootstrap" || suite === "all" ? "0.10.4" : null }, sourceSha256: changedFiles.length === 0 ? before : null, provenance, seed, policy: { ...policy, repetitions }, cases, evidence, unavailable };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output: path.resolve(output), cases: cases.length, provenance: provenance.status, changedFiles, unavailable: unavailable.map((entry) => entry.id) }));
  if (changedFiles.length) process.exitCode = 1;
}
if (process.env.POTASSIUM_BENCHMARK_STATE && path.resolve(process.argv[1] ?? "") === path.join(root, "potassium-mcp", "src", "broker.js")) {
  const statePath = path.resolve(process.env.POTASSIUM_BENCHMARK_STATE);
  assert.equal(path.basename(statePath), "broker-state.json");
  assert(path.basename(path.dirname(statePath)).startsWith("potassium-broker-measurement-"));
  assert.equal(path.dirname(path.dirname(statePath)), path.resolve(os.tmpdir()));
  const repetitions = Number(process.env.POTASSIUM_BENCHMARK_REPETITIONS);
  assert(Number.isInteger(repetitions) && repetitions >= 10 && repetitions <= policy.maximumRepetitions);
  const observer = installStateObserver(statePath);
  const deadline = setTimeout(() => { console.error("bounded broker measurement deadline expired"); process.exit(1); }, 170000);
  deadline.unref();
  setImmediate(() => runBrokerScenario(statePath, observer, repetitions).then((result) => {
    observer.restore(); clearTimeout(deadline); console.log(`BROKER_MEASUREMENT=${JSON.stringify(result)}`);
  }).catch((error) => {
    observer.restore(); console.error(error.stack ?? error.message); process.exitCode = 1; process.emit("SIGTERM");
    setTimeout(() => process.exit(1), 1000).unref();
  }));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });

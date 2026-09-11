import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listAllTools } from "../potassium-mcp/test/helpers/list-tools.js";

export async function prepareRuntimeAttestation(directory, label) {
  const suffix = randomBytes(8).toString("hex");
  const preload = path.join(directory, `${label}-${suffix}.cjs`);
  const proof = path.join(directory, `${label}-${suffix}.ndjson`);
  const executable = await realpath(process.execPath);
  await writeFile(preload, `const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");\nif (process.argv[1] && path.basename(process.argv[1]) === "potassium-mcp.js") { const entry = fs.realpathSync(process.argv[1]); fs.appendFileSync(${JSON.stringify(proof)}, JSON.stringify({ entry, entrySha256: crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex"), executable: fs.realpathSync(process.execPath), version: process.version }) + "\\n"); }\n`);
  await writeFile(proof, "");
  return {
    env: { NODE_OPTIONS: `--require "${preload.split(path.sep).join("/")}"` },
    async verify(entryPath) {
      const expectedEntry = await realpath(entryPath);
      const expectedHash = createHash("sha256").update(await readFile(expectedEntry)).digest("hex");
      const entries = (await readFile(proof, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      assert(entries.length > 0, "SDK launch must attest the executed installed public bin and Node runtime");
      for (const entry of entries) {
        assert.equal(entry.entry, expectedEntry, "SDK resolved another installed package");
        assert.equal(entry.entrySha256, expectedHash);
        assert.equal(entry.executable, executable, "SDK selected another Node executable");
        assert.equal(entry.version, process.version);
      }
      return entries[0];
    },
    async close() { await Promise.all([rm(preload, { force: true }), rm(proof, { force: true })]); },
  };
}

export function observeStdioClose(transport) {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const onclose = transport.onclose;
  transport.onclose = () => { resolveClosed(); onclose?.(); };
  return async () => {
    const controller = new AbortController();
    try {
      await Promise.race([
        closed,
        delay(5000, undefined, { signal: controller.signal }).then(() => { throw new Error("Owned SDK stdio process did not report close after transport shutdown"); }),
      ]);
    } finally { controller.abort(); }
  };
}

export async function openSdkSmoke(packageRoot, directory, env = process.env, { diagnosticRawDiscovery = false, mutateHttpHeaders } = {}) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")));
  const { ListToolsResultSchema } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/types.js")));
  const { createBroker } = await import(pathToFileURL(path.join(packageRoot, "src/broker.js")));
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")));
  const config = { host: "127.0.0.1", port: 0, proxyPort: 0, token: randomBytes(32).toString("hex"), requestTimeoutMs: 1000, maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 1000, streamableHttpEnabled: true, statefulHttpEnabled: true, streamableHttpHost: "127.0.0.1", streamableHttpPort: 0, allowUnsafeExecute: false, hostPolicies: { "package-smoke": { read: true, admin: false, execute: false } }, httpPolicy: { read: true, admin: false, execute: false } };
  const broker = await createBroker(config);
  const clients = [];
  const protocolHeaders = new Map(["http-stateless", "http-stateful"].map((mode) => [mode, { expected: "2025-11-25", requests: 0, postRequests: 0, matchingRequests: 0 }]));
  let attestation;
  let nodeRuntime;
  const inspectFetch = (mode) => async (url, init) => {
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
    if (mutateHttpHeaders) {
      mutateHttpHeaders(mode, headers);
      init = { ...init, headers };
    }
    const counters = protocolHeaders.get(mode);
    counters.requests++;
    if (init?.method?.toUpperCase() === "POST") counters.postRequests++;
    if (headers.get("mcp-protocol-version") === counters.expected) counters.matchingRequests++;
    return fetch(url, init);
  };
  async function close() {
    const failures = [];
    for (const { client, transport, mode, waitForClose } of clients) {
      if (mode === "http-stateful") {
        try { await transport.terminateSession(); } catch (error) { failures.push(error); }
      }
      try { await client.close(); } catch (error) { failures.push(error); }
      try { await waitForClose?.(); } catch (error) { failures.push(error); }
    }
    try { await broker.close(); } catch (error) { failures.push(error); }
    // Keep runtime attestations when any owned resource could still be live.
    if (!failures.length) {
      try { await attestation?.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const error = new AggregateError(failures, `Owned SDK harness cleanup failed; preserve ${directory}`, { cause: failures[0] });
      error.preserveDirectory = true;
      throw error;
    }
  }
  try {
    const configPath = path.join(directory, "smoke-config.json");
    await writeFile(configPath, JSON.stringify({ ...config, proxyPort: broker.listener.address().port }), { mode: 0o600 });
    const binDirectory = path.resolve(packageRoot, "../../.bin");
    const bin = path.join(binDirectory, process.platform === "win32" ? "potassium-mcp.cmd" : "potassium-mcp");
    attestation = await prepareRuntimeAttestation(directory, "sdk-stdio");
    const transports = [
      ["stdio", new StdioClientTransport({ command: bin, args: ["serve", "--config", configPath, "--host-id", "package-smoke"], cwd: directory, env: { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, attestation.env.NODE_OPTIONS].filter(Boolean).join(" ") }, stderr: "pipe" })],
      ["http-stateless", new StreamableHTTPClientTransport(new URL(broker.streamableHttp.endpoint), { fetch: inspectFetch("http-stateless"), requestInit: { headers: { authorization: `Bearer ${config.token}` } } })],
      ["http-stateful", new StreamableHTTPClientTransport(new URL(`${broker.streamableHttp.endpoint}/session`), { fetch: inspectFetch("http-stateful"), requestInit: { headers: { authorization: `Bearer ${config.token}` } } })],
    ];
    for (const [mode, transport] of transports) {
      const client = new Client({ name: "potassium-package-smoke", version: "1.0.0" });
      clients.push({ mode, client, transport, ...(mode === "stdio" ? { waitForClose: observeStdioClose(transport) } : {}) });
      await client.connect(transport, { timeout: 10000 });
      assert.equal(client.getServerVersion().name, "potassium-mcp");
      if (mode !== "stdio") assert.equal(transport.protocolVersion, protocolHeaders.get(mode).expected);
    }
    const stdioRuntime = await attestation.verify(path.join(packageRoot, "bin", "potassium-mcp.js"));
    nodeRuntime = { stdio: stdioRuntime, broker: { executable: await realpath(process.execPath), version: process.version, module: await realpath(path.join(packageRoot, "src", "broker.js")), inProcess: true } };
    const protocol = [];
    for (const suffix of ["", "/session"]) {
      const endpoint = `${broker.streamableHttp.endpoint}${suffix}`;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 900, method: "tools/list", params: {} });
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const unauthorized = await fetch(endpoint, { method: "POST", headers, body });
      assert.equal(unauthorized.status, 401);
      await unauthorized.body?.cancel();
      const unsupported = await fetch(endpoint, { method: "POST", headers: { ...headers, authorization: `Bearer ${config.token}`, "mcp-protocol-version": "2099-01-01" }, body });
      assert.equal(unsupported.status, 400);
      await unsupported.body?.cancel();
      protocol.push({ mode: suffix ? "http-stateful" : "http-stateless", unauthorized: 401, unsupportedProtocol: 400 });
    }
    async function cancellation() {
      const outcomes = [];
      for (const { mode, client } of clients) {
        const socket = new WebSocket(`ws://127.0.0.1:${broker.bridge.server.address().port}`);
        try {
          await once(socket, "open");
          const clientNonce = randomBytes(32).toString("hex");
          const clientId = randomBytes(16).toString("hex");
          const challengePromise = once(socket, "message");
          socket.send(JSON.stringify({ type: "hello", protocol: 2, clientId, generation: 1, clientNonce, client: { executor: "isolated-smoke", protocol: 2 } }));
          const [challengeFrame] = await challengePromise;
          const challenge = JSON.parse(challengeFrame.toString());
          const proof = (role) => createHmac("sha256", config.token).update(createHash("sha256").update(`potassium-mcp/v2|${role}|${clientNonce}|${challenge.serverNonce}`).digest("hex")).digest("base64");
          assert.equal(challenge.proof, proof("server"));
          const ready = once(socket, "message");
          socket.send(JSON.stringify({ type: "ack", protocol: 2, clientNonce, serverNonce: challenge.serverNonce, proof: proof("client") }));
          await ready;
          const received = [];
          socket.on("message", (frame) => { const message = JSON.parse(frame.toString()); if (message.type === "request") received.push(message); });
          const until = async (predicate) => {
            const deadline = performance.now() + 500;
            while (!predicate() && performance.now() < deadline) await delay(5);
            assert(predicate(), "SDK cancellation scenario exceeded its pre-timeout bound");
          };
          if (mode !== "http-stateless") {
            const blockers = Array.from({ length: 4 }, () => client.callTool({ name: "potassium_read_properties", arguments: { path: "game", properties: ["Name"] } }, undefined, { timeout: 5000 }).catch((error) => error));
            await until(() => received.length === 4);
            const queuedController = new AbortController();
            const queued = client.callTool({ name: "potassium_read_properties", arguments: { path: "game.Queued", properties: ["Name"] } }, undefined, { signal: queuedController.signal, timeout: 5000 }).then(() => { throw new Error("queued cancellation unexpectedly succeeded"); }, (error) => error);
            await until(() => broker.bridge.status().pendingRequests === 5);
            queuedController.abort(new Error("cancel queued read"));
            await queued;
            await until(() => broker.bridge.status().pendingRequests === 4);
            for (const request of received) socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { path: "game", properties: [] } }));
            await Promise.all(blockers);
            await delay(25);
            assert.equal(received.length, 4, "cancelled queued read must never dispatch later");
          }
          const before = received.length;
          const controller = new AbortController();
          const pending = client.callTool({ name: "potassium_read_properties", arguments: { path: "game", properties: ["Name"] } }, undefined, { signal: controller.signal, timeout: 5000 }).then(() => { throw new Error("cancelled call unexpectedly succeeded"); }, (error) => error);
          await until(() => received.length === before + 1);
          controller.abort(new Error("isolated smoke cancellation"));
          await pending;
          if (mode !== "http-stateless") {
            const deadline = performance.now() + 500;
            while (broker.bridge.status().pendingRequests !== 0 && performance.now() < deadline) await delay(10);
            assert.equal(broker.bridge.status().pendingRequests, 0, "cancellation must release bridge work before timeout");
            assert.equal(broker.bridge.status().recovering, true, "in-flight cancellation must preserve executor uncertainty");
          }
          outcomes.push({ mode, clientCancellation: true, queuedNeverDispatched: mode !== "http-stateless", inFlightUncertaintyPreserved: mode !== "http-stateless", remoteExecutionStopped: false, limitation: mode === "http-stateless" ? "per-request servers cannot route cross-request cancellation; bounded timeout/disconnect cleanup only" : null });
        } finally {
          socket.close();
          if (socket.readyState !== WebSocket.CLOSED) await once(socket, "close");
        }
      }
      return outcomes;
    }
    async function probe() {
      const observations = [];
      for (const { mode, client, transport } of clients) {
        const counters = protocolHeaders.get(mode);
        // Exclude initialization, other transports, and all earlier probe traffic.
        const baseline = counters ? { ...counters } : undefined;
        const start = performance.now();
        const tools = await listAllTools((cursor) => diagnosticRawDiscovery
          ? client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, ListToolsResultSchema, { timeout: 5000 })
          : client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 5000 }), { forTool: "potassium_status" });
        assert(tools.tools.some((tool) => tool.name === "potassium_status"));
        assert(!tools.tools.some((tool) => tool.name === "potassium_execute_luau"), "unsafe execute must remain opt-in");
        const status = await client.callTool({ name: "potassium_status", arguments: {} }, undefined, { timeout: 5000 });
        assert.notEqual(status.isError, true);
        const invalid = await client.callTool({ name: "potassium_read_properties", arguments: { path: "game", properties: [] } }, undefined, { timeout: 5000 }).catch((error) => ({ isError: true, code: error.code }));
        assert.equal(invalid.isError, true, "invalid request must fail rather than silently execute");
        assert(!tools.tools.some((tool) => tool.name === "potassium_admin_recover"), "admin policy must be independent and denied");
        const protocolHeader = counters ? {
          expected: transport.protocolVersion,
          requests: counters.requests - baseline.requests,
          postRequests: counters.postRequests - baseline.postRequests,
          matchingRequests: counters.matchingRequests - baseline.matchingRequests,
        } : undefined;
        if (protocolHeader) {
          assert(protocolHeader.postRequests >= 3, `${mode} probe must send fresh discovery, status, and invalid-request POSTs`);
          assert.equal(protocolHeader.matchingRequests, protocolHeader.requests, `${mode} SDK must send the negotiated protocol header on every probe request`);
        }
        observations.push({ mode, tools: tools.tools.length, milliseconds: performance.now() - start, session: Boolean(transport.sessionId), ...(protocolHeader ? { protocolHeader } : {}) });
      }
      return observations;
    }
    async function nativeCode() {
      const owner = clients.find(({ mode }) => mode === "http-stateful").client;
      const foreign = clients.find(({ mode }) => mode === "stdio").client;
      const source = "local Package = {}\nlocal function echo(value)\n  return value\nend\nfunction Package:run(value)\n  return echo(value)\nend\nPackage:run(7)\nlocal channel = script.Parent.Send\nlocal alias = channel\nalias:FireServer(\"package-remote-secret\", nil, echo(3))\nlocal function captured() alias:InvokeServer() end\nSend:FireServer()\n-- Send:InvokeServer(\"not-a-call\")\nreturn Package\n";
      const sha256 = createHash("sha256").update(source).digest("hex");
      const call = async (client, name, args) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
        assert.notEqual(result.isError, true, `${name} must succeed through the installed production parser: ${JSON.stringify(result._meta?.error ?? result.content)}`);
        const descriptor = result.structuredContent;
        if (descriptor.kind !== "potassium/result") return descriptor;
        assert.equal(descriptor.toolName, name);
        assert(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= 1048576, "retained smoke evidence must stay within the result-store byte bound");
        await listAllTools((cursor) => client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 5000 }), { forTool: "potassium_result_read" });
        const chunks = [];
        const digest = createHash("sha256");
        let offsetBytes = 0;
        for (let pages = 0; offsetBytes < descriptor.bytes; pages += 1) {
          assert(pages < 1024, "retained smoke evidence must finish within the page bound");
          const response = await client.callTool({ name: "potassium_result_read", arguments: { resultId: descriptor.resultId, pointer: "", view: "text", offsetBytes, maxBytes: 4096 } }, undefined, { timeout: 30000 });
          assert.notEqual(response.isError, true, `potassium_result_read must recover ${name} in its originating SDK session: ${JSON.stringify(response._meta?.error ?? response.content)}`);
          assert(Buffer.byteLength(JSON.stringify(response)) <= Math.min(8192, config.maxMessageBytes), "retained evidence pages must respect the transport budget");
          const page = response.structuredContent;
          assert.equal(page.resultId, descriptor.resultId);
          assert.equal(page.toolName, name);
          assert.equal(page.pointer, "");
          assert.equal(page.totalBytes, descriptor.bytes);
          assert.equal(page.offsetBytes, offsetBytes);
          const bytes = Buffer.byteLength(page.text);
          assert(bytes > 0 && bytes <= 4096);
          assert.equal(page.nextOffsetBytes, offsetBytes + bytes);
          assert(page.nextOffsetBytes <= descriptor.bytes);
          assert.equal(page.hasMore, page.nextOffsetBytes < descriptor.bytes);
          chunks.push(page.text);
          digest.update(page.text);
          offsetBytes = page.nextOffsetBytes;
        }
        assert.equal(digest.digest("hex"), descriptor.sha256, "recovered evidence must match the retained original result");
        return JSON.parse(chunks.join(""));
      };
      assert.equal(broker.bridge.status().connected, false, "authored-source indexing must not rely on an executor");
      assert.equal(config.allowUnsafeExecute, false);
      assert.equal(config.httpPolicy.execute, false, "source candidates must work under the existing read-only grant");
      await listAllTools((cursor) => owner.listTools(cursor === undefined ? {} : { cursor }, { timeout: 5000 }), { forTool: "potassium_code_index" });
      const index = await call(owner, "potassium_code_index", { modules: [{ id: "Package", logicalPath: "Smoke/Package.luau", source, sha256 }], provenance: "assistant-authored package acceptance fixture" });
      let released = false;
      try {
        await listAllTools((cursor) => owner.listTools(cursor === undefined ? {} : { cursor }, { timeout: 5000 }), { forTool: "potassium_code_query" });
        assert.equal(index.files[0].sha256, sha256);
        assert.equal(index.parser.nativeTreeSchema, 1, "installed indexing must use the bundled native tree route");
        assert.equal(index.completeness.syntax, true);
        assert.equal(index.completeness.execution, "not-executed");
        assert.equal(index.completeness.semantic, "conservative");
        const functions = await call(owner, "potassium_code_query", { indexId: index.indexId, view: "functions", moduleId: "Package", limit: 50 });
        assert(functions.rows.some((row) => row.name === "echo"), "authored local function must be located");
        assert(functions.rows.some((row) => row.name === "Package:run"), "authored method must be located");
        const calls = await call(owner, "potassium_code_query", { indexId: index.indexId, view: "calls", moduleId: "Package", limit: 50 });
        const callsite = calls.rows.find((row) => row.callee === "echo");
        assert(callsite, "authored echo callsite must be located");
        assert.equal(callsite.sha256, sha256);
        assert.equal(source.slice(callsite.span.start.offset, callsite.span.end.offset), "echo(value)");
        const origins = await call(owner, "potassium_code_query", { indexId: index.indexId, view: "origins", callsiteId: callsite.id });
        assert.equal(origins.rows[0].callsiteId, callsite.id);
        assert.equal(origins.rows[0].sha256, sha256);
        const remoteSelection = { indexId: index.indexId, view: "remote_callsites", moduleId: "Package", remote: { logicalPath: "Smoke/Send", name: "Send" } };
        const remoteCallsites = await call(owner, "potassium_code_query", remoteSelection);
        assert.equal(remoteCallsites.total, 1, "an explicit logical path must not include unrelated name-only candidates");
        assert.equal(remoteCallsites.correlation, "static-candidates-only");
        assert.equal(remoteCallsites.execution, "not-executed");
        assert.equal(remoteCallsites.receiverIdentity, "unverified");
        const remoteCallsite = remoteCallsites.rows[0];
        assert.equal(remoteCallsite.moduleId, "Package");
        assert.equal(remoteCallsite.sha256, sha256);
        assert.equal(source.slice(remoteCallsite.span.start.offset, remoteCallsite.span.end.offset), 'alias:FireServer("package-remote-secret", nil, echo(3))');
        assert.equal(remoteCallsite.method, "FireServer");
        assert.equal(remoteCallsite.matchKind, "static-logical-path");
        assert.equal(remoteCallsite.confidence, "inferred");
        assert.equal(remoteCallsite.argumentExpressionCount, 3);
        assert(remoteCallsite.uncertainty.includes("runtime-arity-unverified"));
        assert.equal(JSON.stringify(remoteCallsites).includes("package-remote-secret"), false);
        const namedRemotes = await call(owner, "potassium_code_query", { ...remoteSelection, remote: { name: "Send" } });
        assert.equal(namedRemotes.total, 2);
        assert(namedRemotes.rows.every((row) => row.matchKind === "receiver-name-heuristic" && row.receiverIdentity === "unverified"));
        const capturedRemotes = await call(owner, "potassium_code_query", { ...remoteSelection, remote: { name: "alias" } });
        assert.equal(capturedRemotes.total, 1);
        assert(capturedRemotes.rows[0].uncertainty.includes("captured-upvalue"));
        assert.equal(broker.bridge.status().connected, false, "retained source correlation must remain executor-independent");
        await listAllTools((cursor) => foreign.listTools(cursor === undefined ? {} : { cursor }, { timeout: 5000 }), { forTool: "potassium_code_query" });
        const denied = await foreign.callTool({ name: "potassium_code_query", arguments: remoteSelection }, undefined, { timeout: 5000 });
        assert.equal(denied.isError, true);
        assert.equal(denied._meta?.error?.code, "CODE_NOT_FOUND");
        const release = await call(owner, "potassium_code_query", { indexId: index.indexId, view: "release" });
        assert.equal(release.released, true);
        released = true;
        const invalid = await owner.callTool({ name: "potassium_code_query", arguments: remoteSelection }, undefined, { timeout: 5000 });
        assert.equal(invalid.isError, true);
        assert.equal(invalid._meta?.error?.code, "CODE_NOT_FOUND");
        return { actualPackagedSandbox: true, noExecutor: true, noUnsafeGrant: true, sourceSha256: sha256, parser: index.parser, completeness: index.completeness, functions: functions.rows, calls: calls.rows, origins: origins.rows, remoteCallsites, namedRemotes, capturedRemotes, crossSessionDenied: true, releaseInvalidates: true, scope: "static assistant-authored Luau only; conservative unresolved origins are retained, not treated as execution evidence" };
      } finally {
        if (!released) await owner.callTool({ name: "potassium_code_query", arguments: { indexId: index.indexId, view: "release" } }, undefined, { timeout: 5000 });
      }
    }
    return { probe, cancellation, nativeCode, nodeRuntime, protocol, close, broker, clients };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      const failure = new AggregateError([error, cleanupError], `${error.message}; ${cleanupError.message}`, { cause: error });
      failure.preserveDirectory = true;
      throw failure;
    }
    throw error;
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket, { WebSocketServer } from "ws";
import { createBroker, proxyProof } from "../src/broker.js";
import { authenticate, connect, connectOrStart, runProxy } from "../src/proxy.js";
import { listAllTools } from "./helpers/list-tools.js";

const token = "proxy-test-token-that-is-longer-than-thirty-two-characters";
const baseConfig = {
  host: "127.0.0.1",
  port: 32145,
  token,
  requestTimeoutMs: 100,
  maxMessageBytes: 65536,
  maxPendingRequests: 8,
  shutdownGraceMs: 1000,
  proxyHost: "127.0.0.1",
  proxyPort: 32146,
  proxyMaxFrameBytes: 65536,
  proxyHandshakeTimeoutMs: 1000,
  artifactRoots: [],
  httpAllowedHosts: [],
};

async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function proxyServer(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

function waitForResponse(stream, id, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`response ${id} timed out`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (message.id === id) {
          clearTimeout(timer);
          stream.off("data", onData);
          resolve(message);
          return;
        }
      }
    };
    stream.on("data", onData);
  });
}

function sendStdio(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

async function unusedPort() {
  const server = createServer();
  const port = await listening(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Autostart detaches/unrefs the broker. Cleanup must own its exit lifetime.
  child.ref();
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

function isolatedEnv(root) {
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    POTASSIUM_MCP_CONFIG: path.join(root, "ambient-config-must-not-be-read.json"),
    POTASSIUM_MCP_INSTALL_ROOT: path.join(root, "unused-private"),
  };
  delete env.POTASSIUM_MCP_BROKER_STATE;
  delete env.POTASSIUM_WORKSPACE;
  return env;
}

test("proxy bounds WebSocket upgrade attempts by the startup deadline", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const port = await listening(server);
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-proxy-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "config.json");
  await writeFile(configFile, JSON.stringify(baseConfig));
  const started = Date.now();
  await assert.rejects(
    connectOrStart(
      { ...baseConfig, proxyPort: port, proxyHandshakeTimeoutMs: 150 },
      { configFile, spawn: () => ({ unref() {} }) },
    ),
    /Unable to connect|timed out/,
  );
  assert.ok(Date.now() - started < 750);
});

test("authentication rejects an already-closed socket before the next event-loop turn", async (t) => {
  const server = await proxyServer(t);
  const accepted = once(server, "connection");
  const socket = await connect(`ws://127.0.0.1:${server.address().port}`, 65536, 1000);
  const [peer] = await accepted;
  const closed = once(socket, "close");
  peer.close();
  await closed;
  const result = await Promise.race([
    authenticate(socket, baseConfig, "omp").then(() => "authenticated", (error) => error),
    new Promise((resolve) => setImmediate(() => resolve("still waiting"))),
  ]);
  assert.ok(result instanceof Error, String(result));
});

for (const phase of ["upgrade", "challenge", "ready"]) {
  test(`proxy handles ${phase} followed by an invalid opcode in one wire write without crashing`, { timeout: 15000 }, async (t) => {
    const server = phase === "upgrade" ? createServer() : await proxyServer(t);
    const rawPeers = new Set();
    if (phase === "upgrade") {
      await listening(server);
      t.after(async () => {
        for (const peer of rawPeers) peer.destroy();
        await new Promise((resolve) => server.close(resolve));
      });
    }
    const received = [];
    const wireErrors = [];
    server.on("connection", (peer) => {
      peer.on("error", (error) => wireErrors.push(error.message));
      if (phase === "upgrade") {
        rawPeers.add(peer);
        peer.once("close", () => rawPeers.delete(peer));
        let request = "";
        const onData = (data) => {
          request += data.toString("utf8");
          if (!request.includes("\r\n\r\n")) return;
          peer.off("data", onData);
          const key = /^Sec-WebSocket-Key:\s*(.+)\r$/im.exec(request)?.[1];
          const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
          const upgrade = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          peer.write(Buffer.concat([upgrade, Buffer.from([0x83, 0])]));
        };
        peer.on("data", onData);
        return;
      }
      peer.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8"));
        received.push(message);
        let response;
        if (message.type === "proxy-hello") {
          const serverNonce = "c".repeat(64);
          response = {
            type: "proxy-challenge",
            protocol: 1,
            serverNonce,
            proof: proxyProof(token, "server", message.clientNonce, serverNonce, message.hostId),
          };
          if (phase === "ready") {
            peer.send(JSON.stringify(response));
            return;
          }
        } else if (message.type === "proxy-ack" && phase === "ready") {
          response = { type: "proxy-ready" };
        } else {
          return;
        }
        const body = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(body.length < 126 ? 2 : 4);
        header[0] = 0x81;
        header[1] = body.length < 126 ? body.length : 126;
        if (body.length >= 126) header.writeUInt16BE(body.length, 2);
        peer._socket.write(Buffer.concat([header, body, Buffer.from([0x83, 0])]));
      });
    });
    const url = `ws://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { PassThrough } from "node:stream";
      import { connect, runProxy } from ${JSON.stringify(new URL("../src/proxy.js", import.meta.url).href)};
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let output = "";
      stdout.on("data", (data) => { output += data.toString("utf8"); });
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\\n");
      try {
        await runProxy({
          config: ${JSON.stringify(baseConfig)}, hostId: "omp", stdin, stdout,
          connectOrStart: () => connect(${JSON.stringify(url)}, 65536, 1000),
        });
        process.stdout.write(JSON.stringify({ resolved: true, output }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, message: error.message, output }));
      }
    `], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    t.after(() => stopChild(child));
    let output = "";
    let diagnostics = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { diagnostics += chunk.toString("utf8"); });
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, diagnostics + wireErrors.join("\n"));
    assert.equal(code, 0, diagnostics + wireErrors.join("\n"));
    const result = JSON.parse(output);
    assert.equal(result.code, "WS_ERR_INVALID_OPCODE", output);
    assert.equal(result.output, "");
    assert.equal(received.some((message) => message.jsonrpc === "2.0"), false);
  });
}

test("proxy waits for authentication before consuming and forwarding queued stdio", { timeout: 3000 }, async (t) => {
  const server = await proxyServer(t);
  const accepted = once(server, "connection");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  t.after(() => { stdin.destroy(); stdout.destroy(); });
  const request = { jsonrpc: "2.0", id: 42, method: "tools/list" };
  const input = `${JSON.stringify(request)}\n`;
  stdin.write(input);
  const running = runProxy({
    config: baseConfig, hostId: "omp", stdin, stdout,
    connectOrStart: () => connect(`ws://127.0.0.1:${server.address().port}`, 65536, 1000),
  });
  const [peer] = await accepted;
  const [helloFrame] = await once(peer, "message");
  const hello = JSON.parse(helloFrame.toString("utf8"));
  assert.equal(hello.type, "proxy-hello");
  assert.equal(stdin.readableLength, Buffer.byteLength(input));
  const ackReceived = once(peer, "message");
  const serverNonce = "d".repeat(64);
  peer.send(JSON.stringify({
    type: "proxy-challenge", protocol: 1, serverNonce,
    proof: proxyProof(token, "server", hello.clientNonce, serverNonce, hello.hostId),
  }));
  const [ackFrame] = await ackReceived;
  assert.equal(JSON.parse(ackFrame.toString("utf8")).type, "proxy-ack");
  assert.equal(stdin.readableLength, Buffer.byteLength(input));
  const requestReceived = once(peer, "message");
  peer.send(JSON.stringify({ type: "proxy-ready" }));
  const [requestFrame] = await requestReceived;
  assert.deepEqual(JSON.parse(requestFrame.toString("utf8")), request);
  const response = waitForResponse(stdout, request.id);
  peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }));
  assert.deepEqual((await response).result, { tools: [] });
  stdin.end();
  await running;
});

test("an ACK send callback error remains terminal even after a ready frame", { timeout: 3000 }, async (t) => {
  const server = await proxyServer(t);
  const accepted = once(server, "connection");
  const socket = await connect(`ws://127.0.0.1:${server.address().port}`, 65536, 1000);
  const [peer] = await accepted;
  const disconnected = once(peer, "close");
  peer.once("message", (data) => {
    const hello = JSON.parse(data.toString("utf8"));
    const serverNonce = "e".repeat(64);
    peer.send(JSON.stringify({
      type: "proxy-challenge", protocol: 1, serverNonce,
      proof: proxyProof(token, "server", hello.clientNonce, serverNonce, hello.hostId),
    }));
  });
  const failure = new Error("ACK write failed");
  const send = socket.send.bind(socket);
  socket.send = (data, callback) => {
    if (JSON.parse(data).type !== "proxy-ack") return send(data, callback);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "proxy-ready" })), false);
    queueMicrotask(() => callback(failure));
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  t.after(() => { stdin.destroy(); stdout.destroy(); });
  sendStdio(stdin, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  await assert.rejects(runProxy({
    config: baseConfig, hostId: "omp", stdin, stdout, connectOrStart: async () => socket,
  }), (error) => error === failure);
  await disconnected;
  assert.equal(stdout.readableLength, 0);
  assert.deepEqual(JSON.parse(stdin.read().toString("utf8")), { jsonrpc: "2.0", id: 1, method: "tools/list" });
});

for (const phase of ["connected", "authenticated"]) {
  test(`proxy preserves errors across the ${phase} hook handoff`, { timeout: 3000 }, async (t) => {
    const server = await proxyServer(t);
    const accepted = once(server, "connection");
    const url = `ws://127.0.0.1:${server.address().port}`;
    const socket = phase === "connected" ? await connect(url, 65536, 1000) : new WebSocket(url);
    if (phase === "authenticated") await once(socket, "open");
    const [peer] = await accepted;
    const disconnected = once(peer, "close");
    const failure = new Error(`${phase} socket failure`);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    t.after(() => { stdin.destroy(); stdout.destroy(); });
    await assert.rejects(runProxy({
      config: baseConfig, hostId: "omp", stdin, stdout,
      connectOrStart: async () => {
        if (phase === "connected") socket.emit("error", failure);
        return socket;
      },
      authenticate: async () => {
        queueMicrotask(() => socket.emit("error", failure));
      },
    }), (error) => error === failure);
    await disconnected;
    assert.equal(stdout.readableLength, 0);
  });
}

test("proxy closes a socket after invalid mutual-authentication proof", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => server.close());
  const closed = new Promise((resolve) => {
    server.on("connection", (socket) => {
      socket.once("message", () => socket.send(JSON.stringify({
        type: "proxy-challenge",
        protocol: 1,
        serverNonce: "a".repeat(64),
        proof: "invalid",
      })));
      socket.once("close", resolve);
    });
  });
  const config = { ...baseConfig, proxyPort: server.address().port };
  await assert.rejects(
    runProxy({
      config,
      hostId: "omp",
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      connectOrStart: () => connect(`ws://127.0.0.1:${config.proxyPort}`, 65536, 200),
    }),
    /Invalid broker challenge/,
  );
  await closed;
});

test("proxy removes stdio listeners when the authenticated broker closes", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => server.close());
  server.on("connection", (socket) => {
    socket.once("message", (helloFrame) => {
      const hello = JSON.parse(helloFrame.toString("utf8"));
      const serverNonce = "b".repeat(64);
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "proxy-ready" }));
        setTimeout(() => socket.close(1000, "test complete"), 50);
      });
      socket.send(JSON.stringify({
        type: "proxy-challenge",
        protocol: 1,
        serverNonce,
        proof: proxyProof(token, "server", hello.clientNonce, serverNonce, hello.hostId),
      }));
    });
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const config = { ...baseConfig, proxyPort: server.address().port };
  await runProxy({
    config,
    hostId: "omp",
    stdin,
    stdout,
    connectOrStart: () => connect(`ws://127.0.0.1:${config.proxyPort}`, 65536, 200),
  });
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("close"), 0);
  assert.equal(stdout.listenerCount("drain"), 0);
  stdin.destroy();
  stdout.destroy();
});

test("standalone proxy rejects an undiscoverable ephemeral broker port", async () => {
  await assert.rejects(
    connectOrStart({ ...baseConfig, proxyPort: 0 }),
    /proxyPort 0 cannot be used/,
  );
});


test("two simultaneous stdio proxies share one broker without port collisions", async (t) => {
  const broker = await createBroker({
    ...baseConfig,
    port: 0,
    proxyPort: 0,
  });
  t.after(() => broker.close());
  const config = { ...broker.config, proxyPort: broker.listener.address().port };
  const sessions = [0, 1].map(() => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  }));
  const running = sessions.map(({ stdin, stdout }) => runProxy({ config, hostId: "omp", stdin, stdout }));

  await Promise.all(sessions.map(async ({ stdin, stdout }, index) => {
    const initialize = waitForResponse(stdout, index + 1);
    sendStdio(stdin, {
      jsonrpc: "2.0",
      id: index + 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: `proxy-${index}`, version: "1" },
      },
    });
    assert.equal((await initialize).result.serverInfo.name, "potassium-mcp");
    sendStdio(stdin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const tools = await listAllTools(async (cursor) => {
      const response = waitForResponse(stdout, index + 11);
      sendStdio(stdin, {
        jsonrpc: "2.0", id: index + 11, method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      });
      return (await response).result;
    });
    assert.equal(tools.tools.some(({ name }) => name === "potassium_status"), true);
  }));

  assert.equal(broker.listener.clients.size, 2);
  for (const { stdin } of sessions) stdin.end();
  await Promise.all(running);
});

test("public serve initializes from a foreign Unicode cwd without writing setup data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium public 空 白-"));
  const privateRoot = path.join(root, "private data ü");
  const foreignCwd = path.join(root, "foreign 工作");
  const packageLink = path.join(root, "external package Ω");
  await mkdir(privateRoot);
  await mkdir(foreignCwd);
  await symlink(fileURLToPath(new URL("..", import.meta.url)), packageLink, process.platform === "win32" ? "junction" : "dir");
  const configPath = path.join(privateRoot, "config.json");
  await writeFile(path.join(privateRoot, "token.txt"), token);
  const executorPort = await unusedPort();
  const proxyPort = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    ...baseConfig,
    token: undefined,
    tokenFile: "token.txt",
    port: executorPort,
    proxyPort,
    proxyHandshakeTimeoutMs: 5000,
  }));
  const before = new Map(await Promise.all((await readdir(privateRoot)).map(async (name) => [name, await readFile(path.join(privateRoot, name), "utf8")])));
  const brokerPath = fileURLToPath(new URL("../src/broker.js", import.meta.url));
  const cliPath = path.join(packageLink, "bin", "potassium-mcp.js");
  const env = isolatedEnv(root);
  const child = spawn(process.execPath, [brokerPath, "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env,
  });
  t.after(async () => {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`broker entrypoint timed out: ${stderr}`)), 2000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes(`Potassium listening on ws://127.0.0.1:${executorPort}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`broker entrypoint exited early: ${code}; ${stderr}`)));
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve", "--config", configPath, "--host-id", "omp"],
    cwd: foreignCwd,
    env,
    stderr: "pipe",
  });
  const malformed = spawn(process.execPath, [cliPath, "serve", "--config", configPath, "--host-id", "omp", "--json"], {
    cwd: foreignCwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  t.after(() => stopChild(malformed));
  let malformedOutput = "";
  let malformedError = "";
  malformed.stdout.on("data", (chunk) => { malformedOutput += chunk.toString("utf8"); });
  malformed.stderr.on("data", (chunk) => { malformedError += chunk.toString("utf8"); });
  malformed.stdin.end("not JSON\n");
  const [malformedCode] = await once(malformed, "close");
  assert.equal(malformedCode, 1);
  assert.equal(malformedOutput, "");
  assert.equal(JSON.parse(malformedError).ok, false);
  const client = new Client({ name: "entrypoint-test", version: "1" });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => { diagnostics += chunk.toString("utf8"); });
  await client.connect(transport);
  const tools = await listAllTools((cursor) => client.listTools(cursor === undefined ? undefined : { cursor }));
  assert.equal(tools.tools.some(({ name }) => name === "potassium_status"), true);
  await client.close();
  assert.equal(diagnostics, "");
  for (const [name, contents] of before) assert.equal(await readFile(path.join(privateRoot, name), "utf8"), contents);
  assert.deepEqual(await readdir(foreignCwd), []);
  await stopChild(child);
});

test("proxy autostart forwards the selected config rather than ambient environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium autostart 数据-"));
  const configFile = path.join(root, "config.json");
  const config = {
    ...baseConfig,
    token: undefined,
    tokenFile: "credential.txt",
    port: await unusedPort(),
    proxyPort: await unusedPort(),
    proxyHandshakeTimeoutMs: 5000,
    hostPolicies: { "project-a": { read: true, admin: false, execute: false } },
  };
  await writeFile(path.join(root, "credential.txt"), token);
  await writeFile(configFile, JSON.stringify(config));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let child;
  t.after(async () => {
    stdin.destroy();
    stdout.destroy();
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  });
  const running = runProxy({
    configFile,
    hostId: "project-a",
    env: { POTASSIUM_MCP_CONFIG: path.join(root, "wrong-config.json") },
    stdin,
    stdout,
    spawn: (command, args, options) => {
      child = spawn(command, args, { ...options, env: isolatedEnv(root) });
      return child;
    },
  });
  const response = waitForResponse(stdout, 1, 7000);
  sendStdio(stdin, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "selected-config", version: "1" },
    },
  });
  await Promise.race([response, running.then(() => assert.fail("proxy ended before initialization"))]);
  assert.equal((await response).result.serverInfo.name, "potassium-mcp");
  stdin.end();
  await running;
  assert.equal(await readFile(path.join(root, "credential.txt"), "utf8"), token);
  assert.equal(await readFile(configFile, "utf8"), JSON.stringify(config));
});

test("proxy shuts down when stdin ended before authentication completed", { timeout: 3000 }, async (t) => {
  const broker = await createBroker({ ...baseConfig, port: 0, proxyPort: 0 });
  t.after(() => broker.close());
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const ended = once(stdin, "end");
  stdin.resume();
  stdin.end();
  await ended;
  const config = { ...broker.config, proxyPort: broker.listener.address().port };
  const disconnected = new Promise((resolve) => broker.listener.once("connection", (socket) => socket.once("close", resolve)));
  await runProxy({ config, hostId: "omp", stdin, stdout });
  await disconnected;
  assert.equal(broker.listener.clients.size, 0);
  assert.equal(stdin.listenerCount("error"), 0);
  assert.equal(stdout.listenerCount("error"), 0);
  stdout.destroy();
});

test("proxy bounds an already-CLOSING broker without reading paused stdin", async (t) => {
  const forwarded = [];
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.close = () => {
    if (socket.readyState !== WebSocket.CLOSED) socket.readyState = WebSocket.CLOSING;
  };
  socket.terminate = () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close");
  };
  socket.send = (frame, callback) => {
    forwarded.push(JSON.parse(frame));
    callback?.();
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`;
  stdin.pause();
  stdin.end(input);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shutdownGraceMs = 100;
  let completed = false;
  const running = runProxy({
    config: { ...baseConfig, shutdownGraceMs }, hostId: "omp", stdin, stdout,
    connectOrStart: async () => socket,
    authenticate: async () => socket.close(),
  }).then(() => { completed = true; });
  t.after(async () => {
    socket.terminate();
    await running;
    stdin.destroy();
    stdout.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stdin.readableEnded, false);
  assert.equal(stdin.readableLength, Buffer.byteLength(input));
  t.mock.timers.tick(shutdownGraceMs - 1);
  assert.equal(socket.readyState, WebSocket.CLOSING);
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  await running;
  assert.deepEqual(forwarded, []);
  assert.equal(stdout.readableLength, 0);
  assert.equal(stdin.read().toString("utf8"), input);
});
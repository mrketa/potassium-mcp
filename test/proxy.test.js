import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { createBroker, proxyProof } from "../src/broker.js";
import { connect, connectOrStart, runProxy } from "../src/proxy.js";

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

function waitForResponse(stream, id) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`response ${id} timed out`)), 1000);
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
  const started = Date.now();
  await assert.rejects(
    connectOrStart(
      { ...baseConfig, proxyPort: port, proxyHandshakeTimeoutMs: 150 },
      { spawn: () => ({ unref() {} }) },
    ),
    /Unable to connect|timed out/,
  );
  assert.ok(Date.now() - started < 750);
});

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
    const tools = waitForResponse(stdout, index + 11);
    sendStdio(stdin, {
      jsonrpc: "2.0",
      id: index + 11,
      method: "tools/list",
      params: {},
    });
    assert.equal((await tools).result.tools.some(({ name }) => name === "potassium_status"), true);
  }));

  assert.equal(broker.listener.clients.size, 2);
  for (const { stdin } of sessions) stdin.end();
  await Promise.all(running);
});

test("packaged broker and proxy entrypoints complete MCP initialization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-entrypoints-"));
  const configPath = path.join(root, "config.json");
  const executorPort = await unusedPort();
  const proxyPort = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    ...baseConfig,
    port: executorPort,
    proxyPort,
    proxyHandshakeTimeoutMs: 5000,
  }));
  const brokerPath = fileURLToPath(new URL("../src/broker.js", import.meta.url));
  const proxyPath = fileURLToPath(new URL("../src/proxy.js", import.meta.url));
  const child = spawn(process.execPath, [brokerPath, "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
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
    args: [proxyPath, "--config", configPath, "--host-id", "omp"],
    stderr: "pipe",
  });
  const client = new Client({ name: "entrypoint-test", version: "1" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 31);
  assert.equal(tools.tools.some(({ name }) => name === "potassium_status"), true);
  await client.close();
  child.kill();
  await once(child, "exit");
});
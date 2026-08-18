import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { connect as connectTcp } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { PotassiumBridge } from "../src/bridge.js";

const TOKEN = "test-token-that-is-longer-than-thirty-two-characters";

const PROTOCOL = 2;

function handshakeProof(role, clientNonce, serverNonce) {
  const transcript = `potassium-mcp/v${PROTOCOL}|${role}|${clientNonce}|${serverNonce}`;
  const transcriptHash = createHash("sha256").update(transcript, "utf8").digest("hex");
  return createHmac("sha256", TOKEN).update(transcriptHash, "utf8").digest("base64");
}

function nonce() {
  return randomBytes(32).toString("hex");
}

async function createBridge(timeout = 500, overrides = {}) {
  const bridge = new PotassiumBridge({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    requestTimeoutMs: timeout,
    maxMessageBytes: 65536,
    maxPendingRequests: 8,
    shutdownGraceMs: 20,
    ...overrides,
  });
  await bridge.start();
  const { port } = bridge.server.address();
  return { bridge, url: `ws://127.0.0.1:${port}` };
}

async function connect(url, _token = TOKEN, client = { executor: "Potassium", protocol: PROTOCOL }, options) {
  const socket = new WebSocket(url, options);
  await once(socket, "open");
  const clientNonce = nonce();
  const hello = { type: "hello", protocol: PROTOCOL, clientNonce, client };
  assert.equal(Object.hasOwn(hello, "token"), false);
  socket.send(JSON.stringify(hello));
  const [challengePayload] = await once(socket, "message");
  const challenge = JSON.parse(challengePayload.toString());
  assert.deepEqual(Object.keys(challenge).sort(), ["clientNonce", "proof", "protocol", "serverNonce", "type"]);
  assert.equal(challenge.type, "challenge");
  assert.equal(challenge.protocol, PROTOCOL);
  assert.equal(challenge.clientNonce, clientNonce);
  assert.equal(challenge.proof, handshakeProof("server", clientNonce, challenge.serverNonce));
  socket.send(JSON.stringify({
    type: "ack",
    protocol: PROTOCOL,
    clientNonce,
    serverNonce: challenge.serverNonce,
    proof: handshakeProof("client", clientNonce, challenge.serverNonce),
  }));
  const [readyPayload] = await once(socket, "message");
  assert.deepEqual(JSON.parse(readyPayload.toString()), {
    type: "ready",
    protocol: PROTOCOL,
    clientNonce,
    serverNonce: challenge.serverNonce,
  });
  return socket;
}

async function connectUnresponsiveSocket(port) {
  const socket = connectTcp(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write([
    "GET / HTTP/1.1",
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"));
  await once(socket, "data");
  return socket;
}

test("authenticates a Potassium client and correlates responses", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  assert.equal(bridge.status().connected, true);
  assert.deepEqual(bridge.status().client, { executor: "Potassium", protocol: PROTOCOL });
  assert.ok(bridge.status().connectedSince);

  socket.once("message", (payload) => {
    const request = JSON.parse(payload.toString());
    assert.equal(request.method, "client_state");
    socket.send(JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result: { placeId: 93411036959889 },
    }));
  });

  assert.deepEqual(await bridge.request("client_state"), { placeId: 93411036959889 });
});

test("reports active method metadata and compare-and-swap transport recovery", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const sent = once(socket, "message");
  const request = bridge.request("execute_luau", { code: "return 1" });
  await sent;
  const active = bridge.status();
  assert.equal(active.activeMethod, "execute_luau");
  assert.ok(active.activeStartedAt);
  assert.equal(active.recoveryGeneration, 0);
  assert.throws(() => bridge.recover(1), /generation does not match/);
  const closed = once(socket, "close");
  assert.deepEqual(bridge.recover(0), {
    recoveryGeneration: 1,
    transportDisconnected: true,
    forcedTermination: false,
    note: "The executor transport was disconnected. This does not forcibly terminate arbitrary Luau already running in the client.",
  });
  await assert.rejects(request, /transport was reset/);
  await closed;
  assert.equal(bridge.status().activeMethod, null);
  assert.equal(bridge.status().recoveryGeneration, 1);
});

test("retries after a bind failure without retaining a server", async () => {
  const blocker = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(blocker, "listening");
  const { port } = blocker.address();
  const bridge = new PotassiumBridge({
    host: "127.0.0.1", port, token: TOKEN, requestTimeoutMs: 100,
    maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 20,
  });
  await assert.rejects(bridge.start(), /EADDRINUSE/);
  assert.equal(bridge.server, null);
  await new Promise((resolve) => blocker.close(resolve));
  await bridge.start();
  assert.equal(bridge.status().connected, false);
  await bridge.close();
});

test("accepts the Potassium endpoint as Origin", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url, TOKEN, { executor: "Potassium", protocol: PROTOCOL }, {
    headers: { Origin: url },
  });
  t.after(() => socket.close());
  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().rejectedOrigins, 0);
});

test("rejects a non-empty Origin before authentication", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = new WebSocket(url, { headers: { Origin: "https://example.test" } });
  t.after(() => socket.close());
  const [code] = await once(socket, "close");
  assert.equal(code, 1008);
  assert.equal(bridge.status().rejectedOrigins, 1);
  assert.equal(bridge.status().connected, false);
});

test("rejects a reusable bearer token in the initial hello", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = new WebSocket(url);
  await once(socket, "open");
  socket.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    token: "wrong-token",
    clientNonce: nonce(),
    client: { executor: "Potassium", protocol: PROTOCOL },
  }));
  const [code] = await once(socket, "close");
  assert.equal(code, 1008);
  assert.equal(bridge.status().connected, false);
});

test("rejects a client protocol mismatch", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = new WebSocket(url);
  await once(socket, "open");
  socket.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    clientNonce: nonce(),
    client: { executor: "Potassium", protocol: 1 },
  }));
  const [code] = await once(socket, "close");
  assert.equal(code, 1002);
  assert.equal(bridge.status().protocolErrors, 1);
});

test("rejects replayed or mismatched client proof bindings", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = new WebSocket(url);
  await once(socket, "open");
  const clientNonce = nonce();
  socket.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    clientNonce,
    client: { executor: "Potassium", protocol: PROTOCOL },
  }));
  const [challengePayload] = await once(socket, "message");
  const challenge = JSON.parse(challengePayload.toString());
  const closed = once(socket, "close");
  socket.send(JSON.stringify({
    type: "ack",
    protocol: PROTOCOL,
    clientNonce: nonce(),
    serverNonce: challenge.serverNonce,
    proof: handshakeProof("client", clientNonce, challenge.serverNonce),
  }));
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(bridge.status().connected, false);
});

test("rejects an invalid client proof", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = new WebSocket(url);
  await once(socket, "open");
  const clientNonce = nonce();
  socket.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    clientNonce,
    client: { executor: "Potassium", protocol: PROTOCOL },
  }));
  const [challengePayload] = await once(socket, "message");
  const challenge = JSON.parse(challengePayload.toString());
  const closed = once(socket, "close");
  socket.send(JSON.stringify({
    type: "ack",
    protocol: PROTOCOL,
    clientNonce,
    serverNonce: challenge.serverNonce,
    proof: "0".repeat(64),
  }));
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(bridge.status().connected, false);
});

test("limits pending requests", async (t) => {
  const { bridge, url } = await createBridge(500, { maxPendingRequests: 1 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const firstRequest = once(socket, "message");
  const first = bridge.request("first");
  await assert.rejects(bridge.request("second"), /request limit reached/);
  const [payload] = await firstRequest;
  const request = JSON.parse(payload.toString());
  socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: null }));
  await first;
});

test("sends requests one at a time in FIFO order", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const requests = [];
  socket.on("message", (payload) => requests.push(JSON.parse(payload.toString())));
  const first = bridge.request("first");
  const second = bridge.request("second");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(requests.map((request) => request.method), ["first"]);
  assert.equal(bridge.status().pendingRequests, 2);

  socket.send(JSON.stringify({ type: "response", id: requests[0].id, ok: true, result: "one" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(requests.map((request) => request.method), ["first", "second"]);
  socket.send(JSON.stringify({ type: "response", id: requests[1].id, ok: true, result: "two" }));
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);
});

test("rejects outbound requests that exceed the UTF-8 byte limit", async (t) => {
  const { bridge, url } = await createBridge(500, { maxMessageBytes: 384 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  await assert.rejects(
    bridge.request("emoji", { text: "😀".repeat(100) }),
    /maximum message size/,
  );
  assert.equal(bridge.status().pendingRequests, 0);
});

test("timeout keeps the socket open until its late response clears recovery", async (t) => {
  const { bridge, url } = await createBridge(250);
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const requests = [];
  socket.on("message", (payload) => requests.push(JSON.parse(payload.toString())));
  const first = bridge.request("first");
  const second = bridge.request("second");
  await Promise.all([
    assert.rejects(first, /timed out after 250 ms/),
    assert.rejects(second, /timed out after 250 ms/),
  ]);

  assert.deepEqual(requests.map((request) => request.method), ["first"]);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().recovering, true);
  assert.equal(bridge.status().pendingRequests, 0);
  assert.equal(bridge.status().timeouts, 1);
  await assert.rejects(bridge.request("third"), /executor is recovering/);

  socket.send(JSON.stringify({ type: "response", id: requests[0].id, ok: true, result: "late" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bridge.status().recovering, false);
  assert.equal(bridge.status().lateResponses, 1);
  const followUpPayload = once(socket, "message");
  const followUp = bridge.request("follow-up");
  let followUpSettled = false;
  followUp.then(() => { followUpSettled = true; });
  const [payload] = await followUpPayload;
  const request = JSON.parse(payload.toString());
  assert.equal(request.method, "follow-up");
  socket.send(JSON.stringify({ type: "response", id: requests[0].id, ok: true, result: "retired" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(followUpSettled, false);
  socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "done" }));
  assert.equal(await followUp, "done");
});

test("rejects an authenticated newcomer while an active request owns the session", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const sent = once(socket, "message");
  const active = bridge.request("active");
  const [payload] = await sent;
  const request = JSON.parse(payload.toString());

  const newcomer = new WebSocket(url);
  await once(newcomer, "open");
  const newcomerNonce = nonce();
  newcomer.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    clientNonce: newcomerNonce,
    client: { executor: "Potassium", protocol: PROTOCOL },
  }));
  const [challengePayload] = await once(newcomer, "message");
  const challenge = JSON.parse(challengePayload.toString());
  const newcomerClosed = once(newcomer, "close");
  newcomer.send(JSON.stringify({
    type: "ack",
    protocol: PROTOCOL,
    clientNonce: newcomerNonce,
    serverNonce: challenge.serverNonce,
    proof: handshakeProof("client", newcomerNonce, challenge.serverNonce),
  }));
  t.after(() => newcomer.close());
  const [code] = await newcomerClosed;
  assert.equal(code, 1008);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(bridge.status().connected, true);

  socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "old session" }));
  assert.equal(await active, "old session");
});

test("replaces an idle Potassium session", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const oldSocket = await connect(url);
  t.after(() => oldSocket.close());

  const oldClosed = once(oldSocket, "close");
  const replacement = await connect(url);
  t.after(() => replacement.close());
  await oldClosed;

  const sent = once(replacement, "message");
  const requestPromise = bridge.request("replacement");
  const [payload] = await sent;
  const request = JSON.parse(payload.toString());
  replacement.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "new session" }));
  assert.equal(await requestPromise, "new session");
});

test("disconnect drains active and queued requests", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const sent = once(socket, "message");
  const first = bridge.request("first");
  const second = bridge.request("second");
  const firstRejected = assert.rejects(first, /Potassium disconnected/);
  const secondRejected = assert.rejects(second, /Potassium disconnected/);
  await sent;
  socket.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(bridge.status().pendingRequests, 0);
});

test("close drains active and queued requests", async (t) => {
  const { bridge, url } = await createBridge();
  const socket = await connect(url);
  t.after(() => socket.close());

  const sent = once(socket, "message");
  const first = bridge.request("first");
  const second = bridge.request("second");
  const firstRejected = assert.rejects(first, /Potassium bridge stopped/);
  const secondRejected = assert.rejects(second, /Potassium bridge stopped/);
  await sent;
  await bridge.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(bridge.status().pendingRequests, 0);
});

test("forced shutdown waits for its WebSocket server and socket to close", async () => {
  const { bridge } = await createBridge(500, { shutdownGraceMs: 20 });
  const { port } = bridge.server.address();
  const socket = await connectUnresponsiveSocket(port);
  const socketClosed = once(socket, "close");

  await Promise.all([bridge.close(), bridge.close(), socketClosed]);
  assert.equal(bridge.server, null);
});

test("a cleared graceful-shutdown timer cannot terminate a restarted bridge", async (t) => {
  const shutdownGraceMs = 20;
  const { bridge } = await createBridge(500, { shutdownGraceMs });
  const setTimeoutOriginal = globalThis.setTimeout;
  const clearTimeoutOriginal = globalThis.clearTimeout;
  let graceTimer;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === shutdownGraceMs && !graceTimer) {
      graceTimer = {
        cancelled: false,
        fire: () => {
          if (!graceTimer.cancelled) callback(...args);
        },
        unref() {},
      };
      return graceTimer;
    }
    return setTimeoutOriginal(callback, ms, ...args);
  };
  globalThis.clearTimeout = (timer) => {
    if (timer === graceTimer) {
      timer.cancelled = true;
      return;
    }
    clearTimeoutOriginal(timer);
  };
  try {
    await bridge.close();
    assert.ok(graceTimer?.cancelled);
    await bridge.start();
    const socket = await connect(bridge.status().endpoint);
    t.after(() => socket.close());
    graceTimer.fire();
    assert.equal(bridge.status().connected, true);
  } finally {
    globalThis.setTimeout = setTimeoutOriginal;
    globalThis.clearTimeout = clearTimeoutOriginal;
    await bridge.close();
  }
});

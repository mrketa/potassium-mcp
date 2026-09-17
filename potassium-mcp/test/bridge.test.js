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

async function connect(url, _token = TOKEN, client = { executor: "Potassium", protocol: PROTOCOL }, options, identity = {}) {
  const socket = new WebSocket(url, options);
  await once(socket, "open");
  const clientNonce = nonce();
  const clientId = identity.clientId ?? randomBytes(16).toString("hex");
  const generation = identity.generation ?? 1;
  const hello = { type: "hello", protocol: PROTOCOL, clientId, generation, clientNonce, client };
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
    clientId,
    generation,
  });
  socket.clientId = clientId;
  socket.generation = generation;
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

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected promise to reject");
}

test("authenticates a Potassium client and correlates responses", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  assert.equal(bridge.status().connected, true);
  assert.deepEqual(bridge.status().client, { executor: "Potassium", protocol: PROTOCOL });
  assert.ok(bridge.status().connectedSince);
  assert.equal(bridge.status().openSockets, 1);
  assert.equal(bridge.status().pendingHandshakes, 0);
  const activity = [];
  bridge.on("activity", (value) => activity.push(value));

  socket.once("message", (payload) => {
    const request = JSON.parse(payload.toString());
    assert.equal(request.method, "client_state");
    socket.send(JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result: { placeId: 1234567890 },
    }));
  });

  assert.deepEqual(await bridge.request("client_state"), { placeId: 1234567890 });
  assert.equal(activity[0].method, "client_state");
  assert.equal(activity[0].clientId, socket.clientId);
  assert.equal(activity.at(-1), null);
});

test("marks initially disconnected requests as definitively unsubmitted", async (t) => {
  const { bridge } = await createBridge();
  t.after(() => bridge.close());

  const error = await rejection(bridge.request("client_state"));
  assert.equal(error.submissionIndeterminate, false);
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
  const recovery = bridge.recover(0);
  assert.equal(recovery.recoveryGeneration, 1);
  assert.equal(recovery.transportDisconnected, true);
  assert.equal(recovery.forcedTermination, false);
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

test("keeps aborted handshakes separate from authenticated disconnects", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const authenticated = await connect(url);
  t.after(() => authenticated.close());
  const accepted = once(bridge.server, "connection");
  const pending = new WebSocket(url);
  t.after(() => pending.close());
  await once(pending, "open");
  const [serverSocket] = await accepted;
  assert.equal(bridge.status().openSockets, 2);
  assert.equal(bridge.status().pendingHandshakes, 1);
  let disconnectedEvents = 0;
  bridge.on("disconnected", () => { disconnectedEvents += 1; });
  const pendingClosed = Promise.all([once(pending, "close"), once(serverSocket, "close")]);
  pending.close(1000);
  await pendingClosed;
  const failed = bridge.status();
  assert.equal(failed.connected, true);
  assert.equal(failed.connects, 1);
  assert.equal(failed.disconnects, 0);
  assert.equal(failed.handshakeFailures, 1);
  assert.equal(failed.lastHandshakeFailureCode, 1000);
  assert.equal(failed.lastCloseCode, null);
  assert.equal(failed.lastCloseReason, null);
  assert.equal(failed.openSockets, 1);
  assert.equal(failed.pendingHandshakes, 0);
  assert.equal(disconnectedEvents, 0);

  const disconnected = once(bridge, "disconnected");
  authenticated.close(1001);
  await disconnected;
  const closed = bridge.status();
  assert.equal(closed.connected, false);
  assert.equal(closed.connects, 1);
  assert.equal(closed.disconnects, 1);
  assert.equal(closed.lastCloseCode, 1001);
  assert.equal(closed.handshakeFailures, 1);
  assert.equal(closed.lastHandshakeFailureCode, failed.lastHandshakeFailureCode);
  assert.equal(closed.lastHandshakeFailureReason, failed.lastHandshakeFailureReason);
  assert.equal(closed.openSockets, 0);
  assert.equal(closed.pendingHandshakes, 0);
  assert.equal(disconnectedEvents, 1);
});

test("rejects a non-empty Origin before authentication", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const closedOnBridge = once(bridge.server, "connection").then(([socket]) => once(socket, "close"));
  const socket = new WebSocket(url, { headers: { Origin: "https://example.test" } });
  t.after(() => socket.close());
  const [[code, reason]] = await Promise.all([once(socket, "close"), closedOnBridge]);
  assert.equal(code, 1008);
  assert.equal(bridge.status().rejectedOrigins, 1);
  assert.equal(bridge.status().connected, false);
  assert.equal(bridge.status().connects, 0);
  assert.equal(bridge.status().disconnects, 0);
  assert.equal(bridge.status().handshakeFailures, 1);
  assert.equal(bridge.status().lastHandshakeFailureCode, code);
  assert.equal(bridge.status().lastHandshakeFailureReason, reason.toString());
  assert.equal(bridge.status().lastCloseCode, null);
  assert.equal(bridge.status().lastCloseReason, null);
  assert.equal(bridge.status().openSockets, 0);
  assert.equal(bridge.status().pendingHandshakes, 0);
});

test("rejects a reusable bearer token in the initial hello", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = new WebSocket(url);
  await once(socket, "open");
  socket.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    clientId: randomBytes(16).toString("hex"),
    generation: 1,
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
  const closedOnBridge = once(bridge.server, "connection").then(([socket]) => once(socket, "close"));
  const socket = new WebSocket(url);
  await once(socket, "open");
  socket.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    clientId: randomBytes(16).toString("hex"),
    generation: 1,
    clientNonce: nonce(),
    client: { executor: "Potassium", protocol: 1 },
  }));
  const [[code, reason]] = await Promise.all([once(socket, "close"), closedOnBridge]);
  assert.equal(code, 1002);
  assert.equal(bridge.status().protocolErrors, 1);
  assert.equal(bridge.status().connects, 0);
  assert.equal(bridge.status().disconnects, 0);
  assert.equal(bridge.status().handshakeFailures, 1);
  assert.equal(bridge.status().lastHandshakeFailureCode, code);
  assert.equal(bridge.status().lastHandshakeFailureReason, reason.toString());
  assert.equal(bridge.status().pendingHandshakes, 0);
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
    clientId: randomBytes(16).toString("hex"),
    generation: 1,
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

test("rejects an invalid client proof without admitting a late valid acknowledgement", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const closedOnBridge = once(bridge.server, "connection").then(([socket]) => once(socket, "close"));
  const socket = new WebSocket(url);
  await once(socket, "open");
  const clientNonce = nonce();
  socket.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    clientId: randomBytes(16).toString("hex"),
    generation: 1,
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
  socket.send(JSON.stringify({
    type: "ack",
    protocol: PROTOCOL,
    clientNonce,
    serverNonce: challenge.serverNonce,
    proof: handshakeProof("client", clientNonce, challenge.serverNonce),
  }));
  const [[code, reason]] = await Promise.all([closed, closedOnBridge]);
  assert.equal(code, 1008);
  assert.equal(bridge.status().connected, false);
  assert.equal(bridge.status().connects, 0);
  assert.equal(bridge.status().disconnects, 0);
  assert.equal(bridge.status().handshakeFailures, 1);
  assert.equal(bridge.status().lastHandshakeFailureCode, code);
  assert.equal(bridge.status().lastHandshakeFailureReason, reason.toString());
  assert.equal(bridge.status().openSockets, 0);
  assert.equal(bridge.status().pendingHandshakes, 0);
});

test("accounts for an expired handshake once when shutdown races its close", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const accepted = once(bridge.server, "connection");
  const socket = new WebSocket(url);
  t.after(() => socket.close());
  await once(socket, "open");
  const [serverSocket] = await accepted;
  const closed = Promise.all([once(socket, "close"), once(serverSocket, "close")]);
  assert.equal(bridge.status().pendingHandshakes, 1);
  t.mock.timers.tick(5_000);
  assert.equal(bridge.status().pendingHandshakes, 0);
  t.mock.timers.reset();
  const [[[code, reason]]] = await Promise.all([closed, bridge.close()]);
  const status = bridge.status();
  assert.equal(code, 1008);
  assert.equal(status.connects, 0);
  assert.equal(status.disconnects, 0);
  assert.equal(status.handshakeFailures, 1);
  assert.equal(status.lastHandshakeFailureCode, code);
  assert.equal(status.lastHandshakeFailureReason, reason.toString());
  assert.equal(status.lastCloseCode, null);
  assert.equal(status.lastCloseReason, null);
  assert.equal(status.openSockets, 0);
  assert.equal(status.pendingHandshakes, 0);
});

test("counts capacity rejection without dropping admitted clients or retaining sockets", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const admitted = Array.from({ length: 64 }, () => new WebSocket(url));
  t.after(() => { for (const socket of admitted) socket.terminate(); });
  await Promise.all(admitted.map((socket) => once(socket, "open")));
  assert.equal(bridge.status().openSockets, 64);
  assert.equal(bridge.status().pendingHandshakes, 64);

  const accepted = once(bridge.server, "connection");
  const rejected = new WebSocket(url);
  t.after(() => rejected.terminate());
  const rejectedClosed = once(rejected, "close");
  const [serverSocket] = await accepted;
  assert.equal(bridge.status().openSockets, 65);
  assert.equal(bridge.status().pendingHandshakes, 64);
  const [[code, reason]] = await Promise.all([rejectedClosed, once(serverSocket, "close")]);
  const status = bridge.status();
  assert.equal(code, 1013);
  assert.equal(status.connects, 0);
  assert.equal(status.disconnects, 0);
  assert.equal(status.handshakeFailures, 1);
  assert.equal(status.lastHandshakeFailureCode, code);
  assert.equal(status.lastHandshakeFailureReason, reason.toString());
  assert.equal(status.openSockets, 64);
  assert.equal(status.pendingHandshakes, 64);

  await bridge.close();
  assert.equal(bridge.status().handshakeFailures, 65);
  assert.equal(bridge.status().disconnects, 0);
  assert.equal(bridge.status().openSockets, 0);
  assert.equal(bridge.status().pendingHandshakes, 0);
});

test("admits a replacement while a capacity-rejected peer is still closing", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const original = await connect(url);
  t.after(() => original.close());
  const pending = Array.from({ length: 63 }, () => new WebSocket(url));
  t.after(() => { for (const socket of pending) socket.terminate(); });
  await Promise.all(pending.map((socket) => once(socket, "open")));

  const rejectedAccepted = once(bridge.server, "connection");
  const rejected = await connectUnresponsiveSocket(bridge.server.address().port);
  t.after(() => rejected.destroy());
  const [rejectedServerSocket] = await rejectedAccepted;
  assert.equal(rejectedServerSocket.readyState, WebSocket.CLOSING);
  assert.equal(bridge.status().openSockets, 65);
  assert.equal(bridge.status().pendingHandshakes, 63);

  const originalDisconnected = once(bridge, "disconnected");
  original.close(1000);
  await originalDisconnected;
  assert.equal(bridge.status().openSockets, 64);
  assert.equal(rejectedServerSocket.readyState, WebSocket.CLOSING);

  const replacementAccepted = once(bridge.server, "connection");
  const connecting = connect(url);
  const [replacementServerSocket] = await replacementAccepted;
  const replacement = await Promise.race([
    connecting,
    once(replacementServerSocket, "close").then(([code]) => {
      assert.fail(`Freed admission slot rejected a valid replacement with close code ${code}`);
    }),
  ]);
  t.after(() => replacement.close());
  const status = bridge.status();
  assert.equal(status.connected, true);
  assert.equal(status.connects, 2);
  assert.equal(status.disconnects, 1);
  assert.equal(status.handshakeFailures, 0);
  assert.equal(status.openSockets, 65);
  assert.equal(status.pendingHandshakes, 63);
  assert.equal(rejectedServerSocket.readyState, WebSocket.CLOSING);

  await bridge.close();
  assert.equal(bridge.status().disconnects, 2);
  assert.equal(bridge.status().handshakeFailures, 64);
  assert.equal(bridge.status().openSockets, 0);
  assert.equal(bridge.status().pendingHandshakes, 0);
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

test("serializes mutation requests in FIFO order", async (t) => {
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

test("marks send callback and synchronous send failures as indeterminate", async (t) => {
  for (const send of [
    (_serialized, callback) => callback(new Error("send callback failed")),
    () => { throw new Error("synchronous send failed"); },
  ]) {
    const { bridge, url } = await createBridge();
    t.after(() => bridge.close());
    const socket = await connect(url);
    t.after(() => socket.close());
    bridge.clients.get(socket.clientId).socket.send = send;
    const error = await rejection(bridge.request("execute_luau"));
    assert.equal(error.submissionIndeterminate, true);
    assert.equal(bridge.status().recovering, true);
    await assert.rejects(bridge.request("execute_luau"), /recovering/);
  }
});

test("marks a timed-out sent request as indeterminate", async (t) => {
  const { bridge, url } = await createBridge(20);
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const sent = once(socket, "message");
  const request = bridge.request("timeout");
  await sent;
  const error = await rejection(request);
  assert.equal(error.submissionIndeterminate, true);
});

test("timeout keeps the socket open until its late response clears recovery", async (t) => {
  const { bridge, url } = await createBridge(100);
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const requests = [];
  socket.on("message", (payload) => requests.push(JSON.parse(payload.toString())));
  const first = bridge.request("first");
  const second = bridge.request("second");
  await Promise.all([
    assert.rejects(first, /timed out after 100 ms/),
    assert.rejects(second, /timed out after 100 ms/),
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

  const closedOnBridge = once(bridge.server, "connection").then(([socket]) => once(socket, "close"));
  const newcomer = new WebSocket(url);
  await once(newcomer, "open");
  const newcomerNonce = nonce();
  newcomer.send(JSON.stringify({
    type: "hello",
    protocol: PROTOCOL,
    clientId: socket.clientId,
    generation: socket.generation + 1,
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
  const [[code]] = await Promise.all([newcomerClosed, closedOnBridge]);
  assert.equal(code, 1008);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().connects, 1);
  assert.equal(bridge.status().disconnects, 0);
  assert.equal(bridge.status().handshakeFailures, 1);
  assert.equal(bridge.status().openSockets, 1);
  assert.equal(bridge.status().pendingHandshakes, 0);

  socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "old session" }));
  assert.equal(await active, "old session");
});

test("replaces an idle Potassium session", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const accepted = once(bridge.server, "connection");
  const oldSocket = await connect(url);
  t.after(() => oldSocket.close());
  const [oldServerSocket] = await accepted;
  const oldServerClosed = once(oldServerSocket, "close");

  const oldClosed = once(oldSocket, "close");
  const replacement = await connect(url, TOKEN, { executor: "Potassium", protocol: PROTOCOL }, undefined, {
    clientId: oldSocket.clientId,
    generation: oldSocket.generation + 1,
  });
  t.after(() => replacement.close());
  const [[code, reason]] = await Promise.all([oldClosed, oldServerClosed]);
  const status = bridge.status();
  assert.equal(status.connects, 2);
  assert.equal(status.disconnects, 1);
  assert.equal(status.handshakeFailures, 0);
  assert.equal(status.lastCloseCode, code);
  assert.equal(status.lastCloseReason, reason.toString());
  assert.equal(status.lastHandshakeFailureCode, null);
  assert.equal(status.lastHandshakeFailureReason, null);
  assert.equal(status.openSockets, 1);
  assert.equal(status.pendingHandshakes, 0);

  const sent = once(replacement, "message");
  const requestPromise = bridge.request("replacement");
  const [payload] = await sent;
  const request = JSON.parse(payload.toString());
  replacement.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "new session" }));
  assert.equal(await requestPromise, "new session");
});

test("disconnect marks only the active request as indeterminate", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());

  const sent = once(socket, "message");
  const first = bridge.request("first");
  const second = bridge.request("second");
  await sent;
  socket.close();
  const [firstError, secondError] = await Promise.all([rejection(first), rejection(second)]);
  assert.equal(firstError.submissionIndeterminate, true);
  assert.equal(secondError.submissionIndeterminate, false);
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
  assert.equal(bridge.status().disconnects, 1);
  assert.equal(bridge.status().handshakeFailures, 0);
  assert.equal(bridge.status().openSockets, 0);
  assert.equal(bridge.status().pendingHandshakes, 0);
});

test("forced shutdown waits for its WebSocket server and socket to close", async () => {
  const { bridge } = await createBridge(500, { shutdownGraceMs: 20 });
  const { port } = bridge.server.address();
  const socket = await connectUnresponsiveSocket(port);
  const socketClosed = once(socket, "close");

  await Promise.all([bridge.close(), bridge.close(), socketClosed]);
  assert.equal(bridge.server, null);
  assert.equal(bridge.status().disconnects, 0);
  assert.equal(bridge.status().handshakeFailures, 1);
  assert.equal(bridge.status().lastHandshakeFailureCode, 1006);
  assert.equal(bridge.status().openSockets, 0);
  assert.equal(bridge.status().pendingHandshakes, 0);
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

test("requires explicit client selection when multiple executors are connected", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const first = await connect(url);
  const second = await connect(url);
  t.after(() => first.close());
  t.after(() => second.close());

  await assert.rejects(bridge.request("client_state"), /client selection required/);
  const received = once(second, "message");
  const request = bridge.request("client_state", {}, 500, second.clientId);
  const [payload] = await received;
  const message = JSON.parse(payload.toString());
  assert.equal(message.method, "client_state");
  second.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { selected: second.clientId } }));
  assert.deepEqual(await request, { selected: second.clientId });
});

test("runs at most four reads and does not bypass a queued mutation", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));

  const reads = Array.from({ length: 5 }, (_, index) => bridge.request("client_state", { index }));
  const mutation = bridge.request("execute_luau", { code: "return 1" });
  const trailingRead = bridge.request("client_state", { index: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages.map(({ method }) => method), ["client_state", "client_state", "client_state", "client_state"]);
  socket.send(JSON.stringify({ type: "response", id: messages[0].id, ok: true, result: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages.map(({ method }) => method), ["client_state", "client_state", "client_state", "client_state", "client_state"]);
  for (const message of messages.slice(1, 5)) socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages[5].method, "execute_luau");
  socket.send(JSON.stringify({ type: "response", id: messages[5].id, ok: true, result: "mutated" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages[6].method, "client_state");
  socket.send(JSON.stringify({ type: "response", id: messages[6].id, ok: true, result: 5 }));
  await Promise.all(reads);
  assert.equal(await mutation, "mutated");
  assert.equal(await trailingRead, 5);
});

test("map observations share the four-read lane with ordinary reads, captures, and probes", async (t) => {
  const { bridge, url } = await createBridge(6000);
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const settle = () => { const pong = once(socket, "pong"); socket.ping(); return pong; };
  const observation = { sourceSnapshotId: "a".repeat(32), objectIds: ["b".repeat(32)], durationMs: 5000, intervalMs: 100 };
  const requests = [
    bridge.request("map_observe", observation),
    bridge.request("map_observe", observation),
    bridge.request("client_state"),
    bridge.request("game_context"),
    bridge.request("map_probe", { center: { x: 0, y: 0, z: 0 }, size: { x: 8, y: 8, z: 8 } }),
  ];
  const completed = Promise.allSettled(requests);
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "map_observe", "map_observe", "client_state", "game_context",
  ], "both observations and unrelated reads must dispatch without waiting for an observation response");

  reply(messages[2]);
  await requests[2];
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "map_observe", "map_observe", "client_state", "game_context", "map_probe",
  ], "the fifth read must wait for a slot, then dispatch while both observations remain active");
  for (const index of [0, 1, 3, 4]) reply(messages[index]);
  await completed;
  await Promise.all(requests);
});

test("mutations fence map collection and wait for outstanding observations", async (t) => {
  const { bridge, url } = await createBridge();
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const settle = () => { const pong = once(socket, "pong"); socket.ping(); return pong; };
  const execution = bridge.request("execute_luau", { code: "return 1" });
  const observation = bridge.request("map_observe", { sourceSnapshotId: "a".repeat(32), objectIds: ["b".repeat(32)], durationMs: 5000 });
  const capture = bridge.request("game_context");
  const probe = bridge.request("map_probe", { center: { x: 0, y: 0, z: 0 }, size: { x: 8, y: 8, z: 8 } });
  const mutation = bridge.request("execute_luau_async", { code: "return 2" });
  const trailingRead = bridge.request("client_state");
  const requests = [execution, observation, capture, probe, mutation, trailingRead];
  const completed = Promise.allSettled(requests);
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), ["execute_luau"],
    "map collection must not bypass an active mutation as a lifecycle control");

  reply(messages[0]);
  await execution;
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "execute_luau", "map_observe", "game_context", "map_probe",
  ]);
  reply(messages[2]);
  reply(messages[3]);
  await Promise.all([capture, probe]);
  await settle();
  assert.equal(messages.length, 4, "an outstanding observation must fence the queued mutation and later reads");

  reply(messages[1]);
  await observation;
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "execute_luau", "map_observe", "game_context", "map_probe", "execute_luau_async",
  ], "later reads must not pass the newly dispatched mutation");
  reply(messages[4]);
  await mutation;
  await settle();
  assert.equal(messages[5]?.method, "client_state");
  reply(messages[5]);
  await completed;
  await Promise.all(requests);
});

test("lifecycle controls bypass mutation barriers without exceeding read capacity or starving mutations", async (t) => {
  const { bridge, url } = await createBridge(1000, { maxPendingRequests: 12 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const settle = () => {
    const pong = once(socket, "pong");
    socket.ping();
    return pong;
  };
  const execution = bridge.request("execute_luau", { code: "task.wait(10)" });
  const acceptance = bridge.request("execute_luau_async", { code: "return 1" });
  const read = bridge.request("client_state", {});
  const controls = [
    ["async_job_cancel", { jobId: "a".repeat(32) }],
    ["watch_stop", { watchId: "b".repeat(32) }],
    ["watch_start", { path: "workspace" }],
    ["watch_poll", { watchId: "b".repeat(32) }],
  ].map(([method, params]) => bridge.request(method, params));
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "execute_luau", "async_job_cancel", "watch_stop", "watch_start", "watch_poll",
  ], "cancel and stop must reach an executing client alongside other lifecycle controls");

  reply(messages[0]);
  await execution;
  await settle();
  assert.equal(messages[5]?.method, "execute_luau_async", "outstanding controls must not starve the queued mutation");
  assert.equal(messages.length, 6, "ordinary reads must stay behind the mutation barrier");
  reply(messages[1]);
  await controls[0];
  const listed = bridge.request("async_job_list", {});
  await settle();
  assert.equal(messages[6]?.method, "async_job_list", "a freed control slot must admit another lifecycle request");
  reply(messages[5]);
  await acceptance;
  await settle();
  assert.equal(messages.length, 8, "one ordinary read may use the fifth native slot after its mutation barrier clears");
  assert.equal(messages[7]?.method, "client_state");

  for (const index of [2, 3, 4, 6]) reply(messages[index]);
  await Promise.all([...controls, listed]);
  await settle();
  assert.equal(messages[7]?.method, "client_state", "ordinary read must resume after its barrier and capacity clear");
  reply(messages[7]);
  await read;
});

test("saturated ordinary admission reserves only four reusable lifecycle control slots", async (t) => {
  const { bridge, url } = await createBridge(1000, { maxPendingRequests: 2 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const settle = () => {
    const pong = once(socket, "pong");
    socket.ping();
    return pong;
  };
  const execution = bridge.request("execute_luau", { code: "task.wait(10)" });
  const acceptance = bridge.request("execute_luau_async", { code: "return 1" });
  await assert.rejects(bridge.request("client_state", {}), /request limit reached/);
  const controls = [
    ["async_job_cancel", { jobId: "a".repeat(32) }],
    ["watch_stop", { watchId: "b".repeat(32) }],
    ["async_job_list", {}],
    ["watch_poll", { watchId: "b".repeat(32) }],
  ].map(([method, params]) => bridge.request(method, params));
  await assert.rejects(bridge.request("watch_start", { path: "workspace" }), /request limit reached/);
  await assert.rejects(bridge.request("client_state", {}), /request limit reached/);
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "execute_luau", "async_job_cancel", "watch_stop", "async_job_list", "watch_poll",
  ], "ordinary saturation must not prevent cancellation or watch cleanup, or permit a fifth control");
  reply(messages[1]);
  await controls[0];
  const replacement = bridge.request("watch_stop", { watchId: "c".repeat(32) });
  await settle();
  assert.equal(messages[5]?.method, "watch_stop", "completed controls must release reserve admission immediately");
  for (const index of [2, 3, 4, 5]) reply(messages[index]);
  await Promise.all([...controls, replacement]);
  reply(messages[0]);
  await execution;
  await settle();
  assert.equal(messages[6]?.method, "execute_luau_async", "reserved controls must not discard queued ordinary work");
  reply(messages[6]);
  await acceptance;
});

test("capture polling and stop use reserved controls while capture start respects the execution barrier", async (t) => {
  const { bridge, url } = await createBridge(1000, { maxPendingRequests: 2 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const settle = () => {
    const pong = once(socket, "pong");
    socket.ping();
    return pong;
  };
  const execution = bridge.request("execute_luau", { code: "task.wait(10)" });
  const start = bridge.request("remote_capture_start", { targets: ["workspace.Remote"] });
  const captureId = "a".repeat(32);
  const poll = bridge.request("remote_capture_poll", { captureId });
  const stop = bridge.request("remote_capture_stop", { captureId });
  await assert.rejects(bridge.request("client_state"), /request limit reached/);
  await settle();
  assert.deepEqual(messages.map(({ method }) => method), [
    "execute_luau", "remote_capture_poll", "remote_capture_stop",
  ]);
  reply(messages[1]);
  reply(messages[2]);
  await Promise.all([poll, stop]);
  await settle();
  assert.equal(messages.some(({ method }) => method === "remote_capture_start"), false);
  reply(messages[0]);
  await execution;
  await settle();
  assert.equal(messages[3]?.method, "remote_capture_start");
  reply(messages[3]);
  await start;
});

test("action observation controls bypass execution while start and cancellable remote submission remain queued", async (t) => {
  const { bridge, url } = await createBridge(2000, { maxPendingRequests: 3 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const settle = () => { const pong = once(socket, "pong"); socket.ping(); return pong; };
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const execution = bridge.request("execute_luau", { code: "task.wait(10)" });
  const start = bridge.request("observe_action", { operation: "start", requests: [{ path: "workspace", properties: ["Name"] }] });
  const controller = new AbortController();
  const remote = bridge.request("remote_call", { target: "workspace.Echo", method: "FireServer", arguments: [], argumentCount: 0 }, 2000, undefined, controller.signal);
  const cancelled = assert.rejects(remote, (error) => error.code === "CANCELLED" && error.submissionIndeterminate === false);
  const observationId = "a".repeat(32);
  const poll = bridge.request("observe_action", { operation: "poll", observationId });
  const stop = bridge.request("observe_action", { operation: "stop", observationId });
  await settle();
  assert.deepEqual(messages.map(({ method, params }) => [method, params.operation]), [
    ["execute_luau", undefined], ["observe_action", "poll"], ["observe_action", "stop"],
  ]);
  controller.abort();
  await cancelled;
  reply(messages[1]);
  reply(messages[2]);
  await Promise.all([poll, stop]);
  reply(messages[0]);
  await execution;
  await settle();
  assert.equal(messages[3].params.operation, "start");
  reply(messages[3]);
  await start;
  await settle();
  assert.equal(messages.some(({ method }) => method === "remote_call"), false);
});

test("interaction inventory uses ordinary read admission while native calls remain cancellable mutations", async (t) => {
  const { bridge, url } = await createBridge(2000, { maxPendingRequests: 8 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const settle = () => { const pong = once(socket, "pong"); socket.ping(); return pong; };
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const reads = Array.from({ length: 5 }, () => bridge.request("interaction_inventory", { view: "summary" }));
  await settle();
  assert.equal(messages.length, 4, "inventory must share the four-read bound, not the control reserve");
  reply(messages[0]);
  await reads[0];
  await settle();
  assert.equal(messages.length, 5);
  const controller = new AbortController();
  const cancelled = assert.rejects(bridge.request("interaction_call", {
    kind: "touch", source: "Workspace.A", target: "Workspace.B", touch: false,
  }, 2000, undefined, controller.signal), (error) => error.code === "CANCELLED" && error.submissionIndeterminate === false);
  const control = bridge.request("async_job_cancel", { jobId: "a".repeat(32) });
  await settle();
  assert.equal(messages.at(-1).method, "async_job_cancel");
  controller.abort();
  await cancelled;
  reply(messages.at(-1));
  await control;
  for (const message of messages.slice(1, 5)) reply(message);
  await Promise.all(reads);
  const action = bridge.request("interaction_call", { kind: "prompt", target: "Workspace.Prompt" });
  const inventory = bridge.request("interaction_inventory", { view: "summary" });
  await settle();
  assert.equal(messages.at(-1).method, "interaction_call");
  reply(messages.at(-1));
  await action;
  await settle();
  assert.equal(messages.at(-1).method, "interaction_inventory");
  reply(messages.at(-1));
  await inventory;
  assert.equal(messages.filter(({ method }) => method === "interaction_call").length, 1);
});

test("pongs live heartbeats and closes a stale executor session", async (t) => {
  const setIntervalOriginal = globalThis.setInterval;
  const clearIntervalOriginal = globalThis.clearInterval;
  const dateNowOriginal = Date.now;
  let heartbeat;
  let now = 0;
  globalThis.setInterval = (callback) => {
    heartbeat = { callback, unref() {} };
    return heartbeat;
  };
  globalThis.clearInterval = () => {};
  Date.now = () => now;
  try {
    const { bridge, url } = await createBridge();
    t.after(() => bridge.close());
    const socket = await connect(url);
    t.after(() => socket.close());
    const pingReceived = once(socket, "message");
    heartbeat.callback();
    const [pingPayload] = await pingReceived;
    const ping = JSON.parse(pingPayload.toString());
    assert.equal(ping.type, "ping");
    socket.send(JSON.stringify({ type: "pong", nonce: ping.nonce }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 15_001;
    const closed = once(socket, "close");
    heartbeat.callback();
    const [code] = await closed;
    assert.equal(code, 1001);
  } finally {
    globalThis.setInterval = setIntervalOriginal;
    globalThis.clearInterval = clearIntervalOriginal;
    Date.now = dateNowOriginal;
  }
});

test("recording controls use the fifth native slot when four ordinary reads are saturated", async (t) => {
  const { bridge, url } = await createBridge(3000, { maxPendingRequests: 8 });
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const messages = [];
  socket.on("message", (payload) => messages.push(JSON.parse(payload.toString())));
  const settle = () => { const pong = once(socket, "pong"); socket.ping(); return pong; };
  const reply = (message) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: null }));
  const reads = Array.from({ length: 4 }, () => bridge.request("client_state"));
  const mutation = bridge.request("execute_luau", { code: "return 1" });
  const start = bridge.request("map_recording", { operation: "start", targets: [] });
  const controls = ["poll", "mark", "stop", "release"].map((operation) => bridge.request("map_recording", {
    operation, recordingId: "a".repeat(32), ...(operation === "mark" ? { label: "checkpoint" } : {}),
  }));
  const completed = Promise.allSettled([...reads, mutation, start, ...controls]);
  await assert.rejects(bridge.request("map_recording", { operation: "stop", recordingId: "b".repeat(32) }), /request limit reached/);
  await settle();
  assert.deepEqual(messages.map(({ method, params }) => [method, params.operation]), [
    ...Array.from({ length: 4 }, () => ["client_state", undefined]), ["map_recording", "poll"],
  ]);
  for (let index = 0; index < controls.length; index++) {
    assert.equal(messages.length, 5 + index, "exactly one reserved control may execute beside four ordinary reads");
    reply(messages[4 + index]);
    await controls[index];
    await settle();
    if (index < 3) assert.equal(messages[5 + index].params.operation, ["mark", "stop", "release"][index]);
  }
  assert.equal(messages.length, 8, "start cannot cross the queued mutation barrier");
  for (const message of messages.slice(0, 4)) reply(message);
  await Promise.all(reads);
  await settle();
  assert.equal(messages[8].method, "execute_luau");
  reply(messages[8]);
  await mutation;
  await settle();
  assert.equal(messages[9].params.operation, "start");
  reply(messages[9]);
  await start;
  assert.ok((await completed).every(({ status }) => status === "fulfilled"));
});

test("recording controls preserve recovery barriers and only allowlisted native error codes", async (t) => {
  const { bridge, url } = await createBridge(3000);
  t.after(() => bridge.close());
  const socket = await connect(url);
  t.after(() => socket.close());
  const controller = new AbortController();
  const sent = once(socket, "message");
  const pending = bridge.request("client_state", {}, 3000, undefined, controller.signal);
  const cancelled = assert.rejects(pending, (error) => error.code === "CANCELLED" && error.submissionIndeterminate);
  const [frame] = await sent;
  const active = JSON.parse(frame.toString());
  controller.abort();
  await cancelled;
  await assert.rejects(bridge.request("map_recording", { operation: "stop", recordingId: "a".repeat(32) }), /recovering/);
  socket.send(JSON.stringify({ type: "response", id: active.id, ok: true, result: null }));
  const pong = once(socket, "pong"); socket.ping(); await pong;
  for (const [code, expected] of [["MAP_RECORDING_TERMINAL", "MAP_RECORDING_TERMINAL"], ["MAP_RECORDING_UNTRUSTED", undefined]]) {
    const incoming = once(socket, "message");
    const request = bridge.request("map_recording", { operation: "mark", recordingId: "a".repeat(32), label: "late" });
    const rejected = assert.rejects(request, (error) => error.code === expected && error.message === "Recording cannot be marked");
    const [payload] = await incoming;
    const dispatch = JSON.parse(payload.toString());
    socket.send(JSON.stringify({ type: "response", id: dispatch.id, ok: false, error: { code, message: "Recording cannot be marked" } }));
    await rejected;
  }
});

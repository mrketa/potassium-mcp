import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_PENDING_MCP_REQUESTS, RequestIdTransport } from "../src/request-id-transport.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const request = (id, label = "controlled") => ({
  jsonrpc: "2.0", id, method: "tools/call", params: { name: label, arguments: {} },
});
const cancellation = (requestId) => ({
  jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId },
});
const result = (id, label = "done") => ({
  jsonrpc: "2.0", id, result: { content: [{ type: "text", text: label }] },
});
const progress = (label) => ({
  jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: label, progress: 1 },
});

class NativeTransport {
  sent = [];
  closeCalls = 0;

  async start() {}
  async send(message, options) {
    this.sent.push({ message, options });
    await this.beforeSendCompletes?.(message, options);
  }
  async close() {
    this.closeCalls += 1;
    this.onclose?.();
  }
  receive(message) { this.onmessage?.(message); }
}

async function fixture(t, options) {
  const native = new NativeTransport();
  const transport = new RequestIdTransport(native, options);
  const received = [];
  transport.onmessage = (message) => received.push(message);
  t.after(() => transport.close());
  await transport.start();
  return { native, transport, received };
}

test("request IDs preserve typed correlation, restore results and errors, and route related sends", async (t) => {
  const { native, transport, received } = await fixture(t);
  const externalIds = [0, "0", "", 23, "23"];
  for (const id of externalIds) native.receive(request(id));
  assert.equal(received.length, externalIds.length);
  const internalIds = received.map((message) => message.id);
  for (const id of internalIds) {
    assert.equal(typeof id, "string");
    assert.notEqual(id, "");
  }
  assert.equal(new Set(internalIds).size, externalIds.length);

  for (let index = externalIds.length - 1; index >= 0; index -= 1) {
    const internalId = internalIds[index];
    const externalId = externalIds[index];
    await transport.send(progress(`progress-${index}`), { relatedRequestId: internalId });
    assert.equal(native.sent.at(-1).options.relatedRequestId, externalId);
    const reply = index % 2 === 0
      ? result(internalId, `result-${index}`)
      : { jsonrpc: "2.0", id: internalId, error: { code: -32603, message: `failure-${index}` } };
    await transport.send(reply, { relatedRequestId: internalId });
    assert.deepEqual(native.sent.at(-1), {
      message: { ...reply, id: externalId }, options: { relatedRequestId: externalId },
    });
  }

  const completedSends = [...native.sent];
  for (const id of internalIds) {
    await transport.send(result(id, "duplicate late result"));
    await transport.send(progress("retired"), { relatedRequestId: id });
  }
  await transport.send(progress("unknown"), { relatedRequestId: "never-issued" });
  assert.deepEqual(native.sent, completedSends);

  for (const id of externalIds) native.receive(request(id));
  const reusedIds = received.slice(externalIds.length).map((message) => message.id);
  assert.equal(new Set([...internalIds, ...reusedIds]).size, externalIds.length * 2);
  for (let index = 0; index < reusedIds.length; index += 1) {
    await transport.send(result(reusedIds[index], "reused"));
    assert.equal(native.sent.at(-1).message.id, externalIds[index]);
  }
});

test("server-initiated requests and their inbound replies do not consume client-request correlation", async (t) => {
  const { native, transport, received } = await fixture(t, { maxPendingRequests: 1 });
  native.receive(request(0));
  const internalId = received[0].id;
  const serverRequest = { jsonrpc: "2.0", id: internalId, method: "ping" };
  await transport.send(serverRequest, { relatedRequestId: internalId });
  assert.deepEqual(native.sent, [{ message: serverRequest, options: { relatedRequestId: 0 } }]);

  const serverReply = { jsonrpc: "2.0", id: internalId, result: {} };
  const serverError = { jsonrpc: "2.0", id: 0, error: { code: -32603, message: "peer error" } };
  native.receive(serverReply);
  native.receive(serverError);
  assert.deepEqual(received.slice(1), [serverReply, serverError]);

  await transport.send(result(internalId, "original client request"));
  assert.deepEqual(native.sent.at(-1).message, result(0, "original client request"));
  native.receive(request("next"));
  assert.equal(received.at(-1).method, "tools/call");
  await transport.send(result(received.at(-1).id, "next"));
  assert.deepEqual(native.sent.at(-1).message, result("next", "next"));
});

test("an unknown external cancellation cannot target an internal request alias", async (t) => {
  const cancelled = [];
  const { native, transport, received } = await fixture(t, {
    onRequestCancelled: (id) => cancelled.push(id),
  });
  native.receive(request(0));
  const accepted = received[0];
  native.receive(cancellation(accepted.id));
  native.receive(cancellation("0"));
  await nextTurn();
  assert.deepEqual(received, [accepted]);
  assert.deepEqual(cancelled, []);
  await transport.send(result(accepted.id, "still active"));
  assert.deepEqual(native.sent.map(({ message }) => message), [result(0, "still active")]);
});

test("cancelling numeric IDs leaves corresponding string IDs independently replyable", async (t) => {
  const cancelled = [];
  const { native, transport, received } = await fixture(t, {
    onRequestCancelled: (id) => cancelled.push(id),
  });
  const externalIds = [0, "0", 23, "23", ""];
  for (const id of externalIds) native.receive(request(id));
  const accepted = [...received];
  native.receive(cancellation(0));
  native.receive(cancellation(23));
  native.receive(cancellation(0));
  await nextTurn();
  assert.deepEqual(received.slice(accepted.length), [
    cancellation(accepted[0].id), cancellation(accepted[2].id),
  ]);
  assert.deepEqual(cancelled, [0, 23]);
  for (let index = 0; index < accepted.length; index += 1) {
    await transport.send(result(accepted[index].id, `reply-${index}`));
  }
  assert.deepEqual(native.sent.map(({ message }) => message), [
    result("0", "reply-1"), result("23", "reply-3"), result("", "reply-4"),
  ]);
});

test("cancellation accounting runs once after forwarding and ignores a reply already being sent", { timeout: 5000 }, async (t) => {
  const events = [];
  const { native, transport, received } = await fixture(t, {
    onRequestCancelled: (id) => events.push(["accounting", id]),
  });
  transport.onmessage = (message) => {
    received.push(message);
    if (message.method === "notifications/cancelled") events.push(["forwarded", message.params.requestId]);
  };
  native.receive(request(0));
  const waitingId = received[0].id;
  native.receive(cancellation(0));
  assert.deepEqual(events, [["forwarded", waitingId], ["accounting", 0]]);
  native.receive(cancellation(0));
  native.receive(cancellation("unknown"));
  await nextTurn();
  assert.deepEqual(events, [["forwarded", waitingId], ["accounting", 0]]);
  assert.deepEqual(received[1], cancellation(waitingId));

  const sendEntered = deferred();
  const releaseSend = deferred();
  t.after(() => releaseSend.resolve());
  native.beforeSendCompletes = async () => {
    sendEntered.resolve();
    await releaseSend.promise;
  };
  native.receive(request(""));
  const replyingId = received.at(-1).id;
  const sending = transport.send(result(replyingId, "already sending"));
  await bounded(sendEntered.promise, "native response send");
  const acceptedMessages = [...received];
  native.receive(cancellation(""));
  await nextTurn();
  assert.deepEqual(received, acceptedMessages);
  assert.deepEqual(events, [["forwarded", waitingId], ["accounting", 0]]);
  releaseSend.resolve();
  await bounded(sending, "response send completion");
  native.receive(cancellation(""));
  await nextTurn();
  assert.deepEqual(events, [["forwarded", waitingId], ["accounting", 0]]);
  assert.deepEqual(native.sent.map(({ message }) => message), [result("", "already sending")]);
});

test("a cancelled external ID can be reused without late old replies or related sends leaking", async (t) => {
  const retiredExternalIds = [];
  const { native, transport, received } = await fixture(t, {
    maxPendingRequests: 2, onRequestCancelled: (id) => retiredExternalIds.push(id),
  });
  native.receive(request(""));
  const oldId = received[0].id;
  native.receive(cancellation(""));
  assert.deepEqual(retiredExternalIds, [""]);
  native.receive(request(""));
  const currentId = received.at(-1).id;
  assert.equal(received.at(-1).method, "tools/call");
  assert.notEqual(currentId, oldId);
  await transport.send(result(oldId, "late old success"));
  await transport.send({ jsonrpc: "2.0", id: oldId, error: { code: -32603, message: "late old failure" } });
  await transport.send(progress("old"), { relatedRequestId: oldId });
  await transport.send({ jsonrpc: "2.0", id: 0, method: "ping" }, { relatedRequestId: oldId });
  assert.deepEqual(native.sent, []);
  await transport.send(progress("current"), { relatedRequestId: currentId });
  await transport.send(result(currentId, "current result"));
  assert.deepEqual(native.sent.map(({ message }) => message), [progress("current"), result("", "current result")]);
  assert.equal(native.sent[0].options.relatedRequestId, "");
});

test("default pending admission rejects overflow with the original ID and admits again after a reply", async (t) => {
  const { native, transport, received } = await fixture(t);
  for (let id = 0; id < MAX_PENDING_MCP_REQUESTS; id += 1) native.receive(request(id));
  assert.equal(received.length, MAX_PENDING_MCP_REQUESTS);
  native.receive(request(""));
  assert.equal(received.length, MAX_PENDING_MCP_REQUESTS);
  assert.equal(native.sent.length, 1);
  assert.equal(native.sent[0].message.id, "");
  assert.equal(native.sent[0].message.error.code, -32000);
  assert.equal(native.closeCalls, 0);
  await transport.send(result(received[0].id));
  native.receive(request(""));
  assert.equal(received.length, MAX_PENDING_MCP_REQUESTS + 1);
  await transport.send(result(received.at(-1).id, "admitted after overflow"));
  assert.deepEqual(native.sent.at(-1).message, result("", "admitted after overflow"));
});

test("cancellation checkpoints bound a same-turn flood and repeated cycles recover admission", async (t) => {
  const cancelled = [];
  let pending = 0;
  let settled = 0;
  const { native, transport, received } = await fixture(t, {
    maxPendingRequests: 2,
    onRequestCancelled: (id) => cancelled.push(id),
    onRequestStart: () => {
      pending += 1;
      return () => { pending -= 1; settled += 1; };
    },
  });
  native.receive(request(0));
  const heldId = received[0].id;
  const retiredIds = [];
  const rounds = MAX_PENDING_MCP_REQUESTS * 2 + 1;
  for (let index = 0; index < rounds; index += 1) {
    native.receive(request(""));
    assert.equal(received.at(-1).method, "tools/call");
    retiredIds.push(received.at(-1).id);
    native.receive(cancellation(""));
    assert.equal(pending, 2);
    if (index === 0) {
      const accepted = [...received];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        native.receive(request(""));
        native.receive(cancellation(""));
      }
      assert.deepEqual(received, accepted);
      assert.equal(native.sent.length, 8);
      for (const { message } of native.sent) {
        assert.equal(message.id, "");
        assert.equal(message.error.code, -32000);
      }
      assert.deepEqual(cancelled, [""]);
      assert.equal(pending, 2);
      native.sent.length = 0;
    }
    await nextTurn();
    assert.equal(pending, 1);
  }
  native.receive(request(""));
  assert.equal(received.at(-1).method, "tools/call");
  const liveId = received.at(-1).id;
  assert.equal(new Set([heldId, ...retiredIds, liveId]).size, rounds + 2);
  assert.deepEqual(cancelled, Array(rounds).fill(""));
  assert.equal(settled, rounds);
  for (const id of retiredIds) await transport.send(result(id, "late retired result"));
  assert.deepEqual(native.sent, []);
  await transport.send(result(liveId, "live reused request"));
  await transport.send(result(heldId, "held request unaffected"));
  assert.deepEqual(native.sent.map(({ message }) => message), [
    result("", "live reused request"), result(0, "held request unaffected"),
  ]);
  assert.equal(pending, 0);
  assert.equal(settled, rounds + 2);
});

test("cancelled dispatches still bound admission when no lifecycle hooks are installed", async (t) => {
  const { native, transport, received } = await fixture(t, { maxPendingRequests: 1 });
  native.receive(request(0));
  const oldId = received[0].id;
  native.receive(cancellation(0));
  native.receive(request(0));
  assert.equal(received.filter((message) => message.method === "tools/call").length, 1);
  assert.equal(native.sent.length, 1);
  assert.equal(native.sent[0].message.id, 0);
  assert.equal(native.sent[0].message.error.code, -32000);
  await nextTurn();
  native.receive(request(0));
  assert.equal(received.filter((message) => message.method === "tools/call").length, 2);
  assert.notEqual(received.at(-1).id, oldId);
  await transport.send(result(received.at(-1).id, "admitted after checkpoint"));
  assert.deepEqual(native.sent.at(-1).message, result(0, "admitted after checkpoint"));
});

test("response completion hooks wait for native success while dispatch settles at send start", { timeout: 5000 }, async (t) => {
  const events = [];
  const { native, transport, received } = await fixture(t, {
    onRequestStart: () => () => events.push("settled"),
    onResponseSent: (id) => events.push(["sent", id]),
  });
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  native.beforeSendCompletes = async () => {
    entered.resolve();
    await release.promise;
  };
  native.receive(request(0));
  const sending = transport.send(result(received[0].id, "gated result"));
  assert.deepEqual(events, ["settled"]);
  await bounded(entered.promise, "native send entry");
  assert.deepEqual(events, ["settled"]);
  release.resolve();
  await bounded(sending, "native send completion");
  assert.deepEqual(events, ["settled", ["sent", 0]]);

  native.beforeSendCompletes = undefined;
  native.receive(request(""));
  await transport.send({
    jsonrpc: "2.0", id: received.at(-1).id, error: { code: -32603, message: "tool failed" },
  });
  assert.deepEqual(events, ["settled", ["sent", 0], "settled", ["sent", ""]]);
  events.length = 0;

  native.receive(request("cancelled"));
  const cancelledId = received.at(-1).id;
  native.receive(cancellation("cancelled"));
  await nextTurn();
  await transport.send(result(cancelledId, "late result"));
  await transport.send(result("unknown", "unknown result"));
  await transport.send(progress("unrelated notification"));
  await transport.send({ jsonrpc: "2.0", id: 0, method: "ping" });
  assert.deepEqual(events, ["settled"]);

  events.length = 0;
  const failure = new Error("native send failed");
  native.beforeSendCompletes = async () => { throw failure; };
  native.receive(request("failed-send"));
  await assert.rejects(transport.send(result(received.at(-1).id)), (error) => error === failure);
  assert.deepEqual(events, ["settled"]);
});

test("admission-error completion hooks report only successful native replies", { timeout: 5000 }, async (t) => {
  const sent = [];
  const errors = [];
  const { native, transport, received } = await fixture(t, {
    maxPendingRequests: 1, onResponseSent: (id) => sent.push(id),
  });
  transport.onerror = (error) => errors.push(error);
  const release = deferred();
  t.after(() => release.resolve());
  native.beforeSendCompletes = () => release.promise;
  native.receive(request("held"));
  native.receive(request(""));
  assert.deepEqual(sent, []);
  assert.equal(native.sent[0].message.error.code, -32000);
  release.resolve();
  await nextTurn();
  assert.deepEqual(sent, [""]);

  const failure = new Error("admission error send failed");
  native.beforeSendCompletes = async () => { throw failure; };
  native.receive(request(23));
  await nextTurn();
  assert.deepEqual(sent, [""]);
  assert.deepEqual(errors, [failure]);
  assert.equal(received.length, 1);
});

test("native close settles waiting, cancelled, and flushing dispatches exactly once", { timeout: 5000 }, async (t) => {
  const settlements = [];
  const { native, transport, received } = await fixture(t, {
    onRequestStart: () => {
      const index = settlements.length;
      settlements.push(0);
      return () => { settlements[index] += 1; };
    },
  });
  for (const id of [0, "", 23]) native.receive(request(id));
  const accepted = [...received];
  const release = deferred();
  t.after(() => release.resolve());
  native.beforeSendCompletes = () => release.promise;
  native.receive(cancellation(0));
  const sending = transport.send(result(accepted[1].id, "flushing"));
  assert.deepEqual(settlements, [0, 1, 0]);
  native.onclose?.();
  assert.deepEqual(settlements, [1, 1, 1]);
  native.onclose?.();
  await transport.close();
  await nextTurn();
  assert.deepEqual(settlements, [1, 1, 1]);
  await transport.send(result(accepted[0].id, "cancelled late"));
  await transport.send(result(accepted[2].id, "closed late"));
  release.resolve();
  await bounded(sending, "flushing response after close");
  assert.deepEqual(settlements, [1, 1, 1]);
  assert.deepEqual(native.sent.map(({ message }) => message), [result("", "flushing")]);
});

test("duplicate active IDs fail closed even at capacity without dispatching or replying twice", async (t) => {
  const { native, transport, received } = await fixture(t, { maxPendingRequests: 1 });
  let closes = 0;
  transport.onclose = () => { closes += 1; };
  native.receive(request(0));
  const accepted = received[0];
  native.receive(request(0));
  await nextTurn();
  assert.deepEqual(received, [accepted]);
  assert.equal(native.closeCalls, 1);
  assert.equal(closes, 1);
  await transport.send(result(accepted.id, "late duplicate result"));
  assert.deepEqual(native.sent, []);
});

test("close propagates once and prevents pending correlation from surviving shutdown", async (t) => {
  const cancelled = [];
  const { native, transport, received } = await fixture(t, {
    onRequestCancelled: (id) => cancelled.push(id),
  });
  let closes = 0;
  transport.onclose = () => { closes += 1; };
  native.receive(request(0));
  native.receive(request(""));
  const accepted = [...received];
  await Promise.all([transport.close(), transport.close()]);
  native.onclose?.();
  assert.equal(native.closeCalls, 1);
  assert.equal(closes, 1);
  for (const message of accepted) {
    await transport.send(result(message.id, "late after close"));
    await transport.send(progress("late after close"), { relatedRequestId: message.id });
  }
  native.receive(cancellation(0));
  native.receive(cancellation(""));
  native.receive(request("after close"));
  await nextTurn();
  assert.deepEqual(received, accepted);
  assert.deepEqual(native.sent, []);
  assert.deepEqual(cancelled, []);
});

for (const externalId of [0, "", 23]) {
  for (const phase of ["queued", "running"]) {
    test(`SDK ${phase} cancellation aborts ${JSON.stringify(externalId)} and suppresses its late tool result`, { timeout: 5000 }, async (t) => {
      const entered = deferred();
      const release = deferred();
      const returning = deferred();
      const accounted = deferred();
      const dispatchSettled = deferred();
      const replies = [];
      const errors = [];
      const observations = [];
      const settlements = [];
      let pending = 0;
      let handlerSignal;
      const server = new Server({ name: "request-id-cancellation-test", version: "1.0.0" }, {
        capabilities: { tools: {} },
      });
      const [peer, native] = InMemoryTransport.createLinkedPair();
      const transport = new RequestIdTransport(native, {
        onRequestCancelled: (id) => {
          observations.push({ id, aborted: handlerSignal?.aborted, pending });
          accounted.resolve();
        },
        onRequestStart: () => {
          pending += 1;
          return () => {
            pending -= 1;
            settlements.push({ aborted: handlerSignal?.aborted });
            dispatchSettled.resolve();
          };
        },
      });
      server.onerror = (error) => errors.push(error);
      peer.onmessage = (message) => replies.push(message);
      server.setRequestHandler(CallToolRequestSchema, async (_request, { signal }) => {
        handlerSignal = signal;
        entered.resolve({ signal, abortedAtEntry: signal.aborted });
        await release.promise;
        returning.resolve();
        return { content: [{ type: "text", text: "late tool result" }] };
      });
      t.after(async () => {
        release.resolve();
        await server.close();
      });
      await server.connect(transport);
      await peer.start();

      const delivered = peer.send(request(externalId));
      let invocation;
      if (phase === "queued") {
        // Both deliveries occur in the same turn, before the SDK runs the handler.
        const cancelled = peer.send(cancellation(externalId));
        assert.equal(pending, 1);
        assert.equal(observations.length, 1);
        assert.deepEqual(settlements, []);
        await Promise.all([delivered, cancelled]);
        invocation = await bounded(entered.promise, "queued handler entry");
        assert.equal(invocation.abortedAtEntry, true);
      } else {
        await delivered;
        invocation = await bounded(entered.promise, "running handler entry");
        assert.equal(invocation.abortedAtEntry, false);
        assert.equal(invocation.signal.aborted, false);
        const cancelled = peer.send(cancellation(externalId));
        assert.equal(pending, 1);
        assert.equal(observations.length, 1);
        assert.deepEqual(settlements, []);
        await cancelled;
      }
      await bounded(accounted.promise, "effective cancellation accounting");
      await bounded(dispatchSettled.promise, "dispatch cancellation checkpoint");
      assert.equal(invocation.signal.aborted, true);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].id, externalId);
      assert.equal(observations[0].pending, 1);
      assert.equal(pending, 0);
      assert.equal(settlements.length, 1);
      if (phase === "running") {
        assert.equal(observations[0].aborted, false);
        assert.equal(settlements[0].aborted, true);
      }
      await peer.send(cancellation(externalId));
      release.resolve();
      await bounded(returning.promise, "late handler return");
      // A turn boundary drains the SDK's response promise chain, not a guessed delay.
      await nextTurn();
      assert.deepEqual(replies, []);
      assert.deepEqual(errors, []);
      assert.equal(observations.length, 1);
      assert.equal(settlements.length, 1);
    });
  }
}

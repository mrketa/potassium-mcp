import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllowedHttps, getPlaceMetadata, queryTrace, readArtifact, summarizeTrace } from "../src/safe-read.js";

const token = "test-token-that-is-longer-than-thirty-two-characters";
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
const safeConfig = (root) => ({
  token,
  artifactRoots: [{ name: "audits", path: root, recursive: true, extensions: [".json", ".ndjson", ".txt", ".log"] }],
  httpAllowedHosts: ["apis.roblox.com"],
});

function response(text, { contentType = "text/plain", status = 200, contentLength } = {}) {
  const headers = new Headers({ "content-type": contentType });
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return new Response(text, { status, headers });
}

function cancelableResponse(options = {}) {
  let canceled = 0;
  const body = new ReadableStream({
    cancel() {
      canceled += 1;
    },
  });
  return {
    response: new Response(body, {
      status: options.status ?? 200,
      headers: {
        "content-type": options.contentType ?? "text/plain",
        ...(options.contentLength === undefined ? {} : { "content-length": String(options.contentLength) }),
      },
    }),
    canceled: () => canceled,
  };
}

test("reads configured artifacts without exposing absolute paths and redacts secrets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-safe-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "audit.json"), `token=${token}\nAuthorization: Bearer abc.def-123\nid=12345678901234567`);

  const result = await readArtifact({ root: "audits", path: "nested/audit.json", maxBytes: 4096 }, safeConfig(directory));
  assert.deepEqual({ root: result.root, path: result.path, offsetBytes: result.offsetBytes }, {
    root: "audits", path: "nested/audit.json", offsetBytes: 0,
  });
  assert.equal(result.text.includes(directory), false);
  assert.match(result.text, /token=\[REDACTED\]/);
  assert.match(result.text, /Authorization: \[REDACTED\] \[REDACTED\]/);
  assert.equal(result.text.includes("abc.def-123"), false);
  assert.match(result.text, /\[REDACTED_ID\]/);
});

test("redacts complete artifacts before byte pagination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-safe-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bearer = "Bearer test-bearer-value-that-must-not-be-reassembled";
  const apiKey = "test-api-key-that-must-not-be-reassembled";
  const identity = "1234567890123456789012345";
  await writeFile(join(directory, "secrets.json"), JSON.stringify({
    accessToken: token,
    authorization: bearer,
    apiKey,
    identity,
    nested: { password: "swordfish" },
  }));
  await writeFile(join(directory, "events.ndjson"), [
    JSON.stringify({ event: "login", cookie: "session-cookie-value", identity }),
    `Authorization: ${bearer}`,
    `api_key=${apiKey}`,
    "password plain-text-password-value",
    "Cookie: session=another-session-cookie-value",
  ].join("\n"));
  for (const path of ["secrets.json", "events.ndjson"]) {
    let paged = "";
    for (let offset = 0; ; offset += 1) {
      const page = await readArtifact({ root: "audits", path, offsetBytes: offset, maxBytes: 1 }, safeConfig(directory));
      if (page.bytesRead === 0) break;
      paged += page.text;
    }
    for (const secret of [token, bearer.replace("Bearer ", ""), apiKey, identity, "swordfish", "session-cookie-value", "plain-text-password-value", "another-session-cookie-value"]) {
      assert.equal(paged.includes(secret), false, `${path} leaked ${secret}`);
    }
    assert.match(paged, /\[REDACTED(?:_ID)?\]/);
  }
});

test("rejects artifact traversal, symlink escapes, source extensions, and secret names", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-safe-read-"));
  const outside = await mkdtemp(join(tmpdir(), "potassium-safe-outside-"));
  t.after(() => Promise.all([rm(directory, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(directory, "code.lua"), "return 1");
  await writeFile(join(directory, ".env"), "x=y");
  await writeFile(join(outside, "outside.json"), "outside");
  let symlinkCreated = false;
  try {
    await symlink(join(outside, "outside.json"), join(directory, "linked.json"));
    symlinkCreated = true;
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
  const config = safeConfig(directory);

  await assert.rejects(() => readArtifact({ root: "audits", path: "../outside.json" }, config), /traversal/);
  if (symlinkCreated) {
    await assert.rejects(() => readArtifact({ root: "audits", path: "linked.json" }, config), /escapes/);
  }
  await assert.rejects(() => readArtifact({ root: "audits", path: "code.lua" }, config), /extension/);
  await assert.rejects(() => readArtifact({ root: "audits", path: ".env" }, config), /file name/);
});

test("enforces artifact recursion, offsets, and byte limits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-safe-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "event.ndjson"), "abcdef");
  await writeFile(join(directory, "nested", "event.ndjson"), "abcdef");
  const config = safeConfig(directory);
  config.artifactRoots[0].recursive = false;

  const result = await readArtifact({ root: "audits", path: "event.ndjson", offsetBytes: 2, maxBytes: 3 }, config);
  assert.deepEqual(result, { root: "audits", path: "event.ndjson", offsetBytes: 2, bytesRead: 3, truncated: true, text: "cde" });
  await assert.rejects(() => readArtifact({ root: "audits", path: "nested/event.ndjson" }, config), /recursive/);
  await assert.rejects(() => readArtifact({ root: "audits", path: "event.ndjson", maxBytes: 262145 }, config), /maxBytes/);
});

test("allows only configured public HTTPS GETs and sanitizes output URLs", async () => {
  let request;
  const result = await getAllowedHttps(
    { url: "https://apis.roblox.com/v1/items?limit=2", maxBytes: 100 },
    safeConfig("unused"),
    {
      dnsLookup: publicDns,
      fetch: async (url, options) => {
        request = { url: url.toString(), options };
        return response('{"ok":true}', { contentType: "application/json; charset=utf-8" });
      },
    },
  );
  assert.equal(request.url, "https://apis.roblox.com/v1/items?limit=2");
  assert.deepEqual({ method: request.options.method, redirect: request.options.redirect }, { method: "GET", redirect: "error" });
  assert.deepEqual(result, {
    url: "https://apis.roblox.com/v1/items",
    status: 200,
    contentType: "application/json",
    bytesRead: 11,
    text: '{"ok":true}',
  });
});

test("rejects unconfigured hosts, non-HTTPS URLs, credentials, and sensitive query names", async () => {
  const config = safeConfig("unused");
  const dependencies = { dnsLookup: publicDns, fetch: async () => response("ok") };
  await assert.rejects(() => getAllowedHttps({ url: "https://example.com/" }, config, dependencies), /host/);
  await assert.rejects(() => getAllowedHttps({ url: "http://apis.roblox.com/" }, config, dependencies), /HTTPS/);
  await assert.rejects(() => getAllowedHttps({ url: "https://user:pass@apis.roblox.com/" }, config, dependencies), /credentials/);
  await assert.rejects(() => getAllowedHttps({ url: "https://apis.roblox.com/?api_key=value" }, config, dependencies), /Sensitive query/);
});

test("rejects private DNS results and rejects redirect and binary responses", async () => {
  const config = safeConfig("unused");
  for (const address of ["127.0.0.1", "::ffff:172.16.0.1", "fe90::1", "ff02::1", "2001:db8::1"]) {
    await assert.rejects(
      () => getAllowedHttps({ url: "https://apis.roblox.com/" }, config, { dnsLookup: async () => [{ address }] }),
      /disallowed address/,
    );
  }
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/" }, config, { dnsLookup: publicDns, fetch: async () => response("redirect", { status: 302 }) }),
    /status 302/,
  );
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/" }, config, { dnsLookup: publicDns, fetch: async () => response("binary", { contentType: "application/octet-stream" }) }),
    /content type/,
  );
});

test("bounds HTTP time and body size before returning response text", async () => {
  const config = safeConfig("unused");
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/", maxBytes: 5 }, config, { dnsLookup: publicDns, fetch: async () => response("ok", { contentLength: 6 }) }),
    /maxBytes/,
  );
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/", maxBytes: 5 }, config, { dnsLookup: publicDns, fetch: async () => response("123456") }),
    /maxBytes/,
  );
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/", timeoutMs: 1 }, config, {
      dnsLookup: publicDns,
      fetch: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    }),
    /timed out/,
  );
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/", timeoutMs: 1 }, config, {
      dnsLookup: publicDns,
      fetch: async () => new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    }),
    /timed out/,
  );
});

test("uses one deadline for stalled DNS and cancels every rejected HTTP response body", async () => {
  const config = safeConfig("unused");
  let resolveDns;
  let fetchCalls = 0;
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/", timeoutMs: 5 }, config, {
      dnsLookup: () => new Promise((resolve) => {
        resolveDns = resolve;
      }),
      fetch: async () => {
        fetchCalls += 1;
        return response("unexpected");
      },
    }),
    /timed out/,
  );
  resolveDns([{ address: "8.8.8.8", family: 4 }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls, 0);

  for (const options of [
    { status: 302 },
    { contentType: "application/octet-stream" },
    { contentLength: 6 },
    { contentLength: "not-a-number" },
  ]) {
    const tracked = cancelableResponse(options);
    await assert.rejects(
      () => getAllowedHttps({ url: "https://apis.roblox.com/", maxBytes: 5 }, config, {
        dnsLookup: publicDns,
        fetch: async () => tracked.response,
      }),
    );
    assert.equal(tracked.canceled(), 1);
  }

  let streamCancels = 0;
  const failingResponse = {
    status: 200,
    headers: new Headers({ "content-type": "text/plain" }),
    body: {
      getReader: () => ({
        read: async () => {
          throw new Error("stream failed");
        },
        cancel: async () => {
          streamCancels += 1;
        },
        releaseLock() {},
      }),
    },
  };
  await assert.rejects(
    () => getAllowedHttps({ url: "https://apis.roblox.com/" }, config, {
      dnsLookup: publicDns,
      fetch: async () => failingResponse,
    }),
    /stream failed/,
  );
  assert.equal(streamCancels, 1);
});

function traceConfig(root) {
  return {
    token,
    artifactRoots: [{ name: "trace_records", path: root, recursive: false, extensions: [".ndjson"] }],
    httpAllowedHosts: ["apis.roblox.com", "games.roblox.com", "thumbnails.roblox.com", "users.roblox.com"],
  };
}

test("queries complete, sanitized trace rows with deterministic filters", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "run.ndjson"), [
    JSON.stringify({ kind: "observation_captured", at: 1767225600, state: "idle" }),
    "not json",
    JSON.stringify({ kind: "observation_completed", at: 1767312000, state: "complete" }),
    "",
  ].join("\n"));

  const result = await queryTrace({ path: "run.ndjson", eventType: "observation_completed", maxRows: 2 }, traceConfig(directory));
  assert.deepEqual(result.rows, [{ at: 1767312000, kind: "observation_completed", state: "complete" }]);
  assert.deepEqual({
    root: result.root, path: result.path, linesRead: result.linesRead, linesParsed: result.linesParsed, parseErrors: result.parseErrors,
  }, { root: "trace_records", path: "run.ndjson", linesRead: 3, linesParsed: 2, parseErrors: 1 });
});

test("parses raw trace NDJSON before redaction and preserves zero-valued trace bounds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "run.ndjson"), [
    '{"kind":"__proto__","at":0,"id":12345678901234567}',
    '{"kind":"constructor","at":9}',
    '{"kind":"constructor","at":10}',
    "",
  ].join("\n"));
  const config = traceConfig(directory);

  const zero = await queryTrace({ path: "run.ndjson", since: 0, until: 0 }, config);
  assert.deepEqual(zero.rows, [{ at: 0, id: "[REDACTED_ID]", kind: "__proto__" }]);
  const bounded = await queryTrace({ path: "run.ndjson", since: 9, until: 10 }, config);
  assert.deepEqual(bounded.rows.map((row) => row.at), [9, 10]);
  const summary = await summarizeTrace({ path: "run.ndjson" }, config);
  assert.deepEqual(summary.summary.eventCounts, Object.fromEntries([["__proto__", 1], ["constructor", 2]]));
  assert.deepEqual(summary.summary.timeBounds, { earliest: 0, latest: 10 });
});

test("reports trace truncation and summarizes generic terminal and error evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "run.ndjson"), `${JSON.stringify({
    kind: "finished", at: 1767312000, terminal: true,
  })}\n${JSON.stringify({ kind: "error", code: "timeout", message: "operation timed out" })}\n`);

  const truncated = await queryTrace({ path: "run.ndjson", maxBytes: 20 }, traceConfig(directory));
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.incompleteLine, true);
  assert.deepEqual(truncated.rows, []);

  const summary = await summarizeTrace({ path: "run.ndjson" }, traceConfig(directory));
  assert.deepEqual(summary.summary.eventCounts, { error: 1, finished: 1 });
  assert.deepEqual(summary.summary.timeBounds, { earliest: 1767312000, latest: 1767312000 });
  assert.deepEqual(summary.summary.evidence.terminal, [{ row: 0, eventType: "finished", fields: ["terminal"] }]);
  assert.deepEqual(summary.summary.evidence.error, [{ row: 1, eventType: "error", fields: [] }]);
});

test("restricts traces to the fixed flat trace root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "potassium-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "run.ndjson"), "{}\n");
  await writeFile(join(directory, "code.lua"), "return 1");
  await writeFile(join(directory, ".trace-secret.ndjson"), "{}\n");
  await assert.rejects(() => queryTrace({ path: "code.lua" }, traceConfig(directory)), /extension/);
  await assert.rejects(() => queryTrace({ path: ".trace-secret.ndjson" }, traceConfig(directory)), /file name/);
  await assert.rejects(() => queryTrace({ path: "../run.ndjson" }, traceConfig(directory)), /traversal/);
  await assert.rejects(() => queryTrace({ path: "nested/run.ndjson" }, traceConfig(directory)), /recursive/);
  const unsafe = traceConfig(directory);
  unsafe.artifactRoots[0].recursive = true;
  await assert.rejects(() => queryTrace({ path: "run.ndjson" }, unsafe), /configured safely/);
});

test("constructs only fixed, inherited-safe place metadata endpoints", async () => {
  const config = traceConfig("unused");
  let requested;
  const dependencies = {
    dnsLookup: publicDns,
    fetch: async (url, options) => {
      requested = { url: url.toString(), options };
      return response('{"data":[]}', { contentType: "application/json" });
    },
  };
  const thumbnail = await getPlaceMetadata({ kind: "thumbnail", id: "123", size: "256x256" }, config, dependencies);
  assert.equal(requested.url, "https://thumbnails.roblox.com/v1/places/gameicons?placeIds=123&returnPolicy=PlaceHolder&size=256x256&format=Png&isCircular=false");
  assert.deepEqual({ kind: thumbnail.kind, id: thumbnail.id, status: thumbnail.status }, { kind: "thumbnail", id: "123", status: 200 });
  await assert.rejects(() => getPlaceMetadata({ kind: "url", id: "123" }, config, dependencies), /kind/);
  await assert.rejects(() => getPlaceMetadata({ kind: "place", id: "https://example.com" }, config, dependencies), /id/);
  await assert.rejects(() => getPlaceMetadata({ kind: "thumbnail", id: "123", size: "999x999" }, config, dependencies), /size/);
  await assert.rejects(
    () => getPlaceMetadata({ kind: "user", id: "123" }, { ...config, httpAllowedHosts: ["apis.roblox.com"] }, dependencies),
    /host/,
  );
});

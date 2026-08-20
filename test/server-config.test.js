import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { commandConfigPath, isMainModule, parseConfig } from "../src/server.js";

test("server accepts an explicit stable --config path", () => { assert.equal(commandConfigPath(["--config", "stable/config.json"]), path.resolve("stable/config.json")); });
test("server rejects a missing --config value", () => { assert.throws(() => commandConfigPath(["--config"]), /requires a path/); });
test("server recognizes a symlinked installed entrypoint", () => {
  const canonicalize = (value) => value.includes("installed") ? "C:\\source\\server.js" : value;
  assert.equal(isMainModule("C:\\installed\\server.js", "file:///C:/source/server.js", canonicalize), true);
});

test("streamable HTTP config defaults to disabled loopback, permits programmatic port zero, and rejects invalid endpoints", async () => {
  const base = {
    host: "127.0.0.1",
    port: 32145,
    token: "a".repeat(32),
    requestTimeoutMs: 30000,
    maxMessageBytes: 1048576,
    maxPendingRequests: 64,
    shutdownGraceMs: 5000,
  };
  const parsed = await parseConfig(base);
  assert.deepEqual(
    [parsed.streamableHttpEnabled, parsed.streamableHttpHost, parsed.streamableHttpPort],
    [false, "127.0.0.1", 32147],
  );
  assert.equal(
    (await parseConfig({ ...base, streamableHttpEnabled: true, streamableHttpPort: 0 })).streamableHttpPort,
    0,
  );
  await assert.rejects(
    parseConfig({ ...base, streamableHttpHost: "0.0.0.0" }),
    /Invalid configuration/,
  );
  await assert.rejects(
    parseConfig({ ...base, streamableHttpEnabled: true, streamableHttpPort: 32145 }),
    /must not share the executor endpoint/,
  );
  await assert.rejects(
    parseConfig({ ...base, streamableHttpEnabled: true, streamableHttpPort: 32146 }),
    /must not share the proxy endpoint/,
  );
  await assert.rejects(
    parseConfig({ ...base, unexpected: true }),
    /Invalid configuration/,
  );
});

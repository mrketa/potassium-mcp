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

test("HTTP transport configuration stays disabled by default and loopback-only when enabled", async () => {
  const base = {
    host: "127.0.0.1", port: 32145, token: "test-token-that-is-longer-than-thirty-two-characters",
    requestTimeoutMs: 1000, maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 1000,
  };
  const disabled = await parseConfig(base);
  assert.equal(disabled.httpEnabled, false);
  assert.equal(disabled.httpHost, "127.0.0.1");
  await assert.rejects(parseConfig({ ...base, httpEnabled: true, httpHost: "0.0.0.0" }), /Invalid configuration/);
});

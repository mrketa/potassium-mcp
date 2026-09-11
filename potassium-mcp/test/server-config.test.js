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

test("streamable HTTP config permits programmatic port zero and rejects invalid endpoints", async () => {
  const base = {
    host: "127.0.0.1",
    port: 32145,
    token: "a".repeat(32),
    requestTimeoutMs: 30000,
    maxMessageBytes: 1048576,
    maxPendingRequests: 64,
    shutdownGraceMs: 5000,
  };
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

test("source roots are separate strict grants with normalized explicit Luau extensions", async () => {
  const base = {
    host: "127.0.0.1", port: 0, token: "a".repeat(32), requestTimeoutMs: 1000,
    maxMessageBytes: 65536, maxPendingRequests: 8, shutdownGraceMs: 1000,
    artifactRoots: [{ name: "artifacts", path: "outputs", extensions: [".txt"] }],
  };
  const directory = path.resolve("source-config-fixture");
  const config = await parseConfig({
    ...base, sourceRoots: [{ name: "sources", path: "provided", recursive: true, extensions: [".luau"] }],
  }, directory);
  assert.deepEqual(config.sourceRoots, [{ name: "sources", path: path.join(directory, "provided"), recursive: true, extensions: [".luau"] }]);
  assert.deepEqual(config.artifactRoots[0].extensions, [".txt"]);
  assert.deepEqual((await parseConfig(base)).sourceRoots, []);
  for (const sourceRoots of [
    [{ name: "sources", path: "provided", extensions: [".js"] }],
    [{ name: "sources", path: "provided", extensions: [".lua", ".lua"] }],
    [{ name: "sources", path: "provided" }, { name: "sources", path: "other" }],
    [{ name: "sources", path: "provided", allowSecrets: true }],
  ]) await assert.rejects(parseConfig({ ...base, sourceRoots }), /Invalid configuration/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, open, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { respondHttps } from "./helpers/safe-read-https.js";

const source = process.env.MCP_READ_POLICY_SOURCE_DIR ?? new URL("../src/", import.meta.url);
const moduleUrl = source instanceof URL ? new URL("safe-read.js", source) : pathToFileURL(join(resolve(source), "safe-read.js"));
const { getAllowedHttps, readArtifact, queryTrace } = await import(moduleUrl);
const token = "synthetic-reader-boundary-token-0123456789";
const httpConfig = { token, httpAllowedHosts: ["apis.roblox.com"] };
const artifactConfig = (root) => ({ token, artifactRoots: [{ name: "audits", path: root, recursive: true, extensions: [".txt", ".json", ".ndjson"] }] });
const textResponse = (text) => new Response(text, { headers: { "content-type": "text/plain" } });

async function directory(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "potassium-reader-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function connectionAddresses(target, options, fallbackLookup) {
  if (!options.lookup) return fallbackLookup();
  return new Promise((resolveAddresses, reject) => {
    options.lookup(target.hostname, { all: true }, (error, addresses) => error ? reject(error) : resolveAddresses(addresses));
  });
}

test("HTTPS connection stays on approved DNS answers when the resolver rebinds", async (t) => {
  let resolutions = 0;
  const dnsLookup = async () => ++resolutions === 1
    ? [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]
    : [{ address: "127.0.0.1", family: 4 }];
  const endpoint = (addresses) => textResponse(addresses.some(({ address }) => address === "127.0.0.1")
    ? "private endpoint contents" : "approved endpoint contents");
  // This fallback makes the pre-fix global-fetch path deterministic and never uses the network.
  t.mock.method(globalThis, "fetch", async () => endpoint(await dnsLookup()));
  const result = await getAllowedHttps({ url: "https://apis.roblox.com/data" }, httpConfig, {
    dnsLookup,
    httpsRequest: respondHttps(async (target, options) => endpoint(await connectionAddresses(target, options, dnsLookup))),
  });
  assert.equal(result.text, "approved endpoint contents");
  assert.equal(resolutions, 1);
});

test("HTTPS rejects expanded mapped loopback and canonical private IPv6 before connecting", async (t) => {
  let connections = 0;
  const unexpectedConnection = async () => { connections += 1; return textResponse("private endpoint contents"); };
  t.mock.method(globalThis, "fetch", unexpectedConnection);
  for (const address of ["0:0:0:0:0:ffff:7f00:1", "::ffff:ac10:1", "0:0:0:0:0:0:0:1", "2001:0db8:0:0::1"]) {
    await assert.rejects(getAllowedHttps({ url: "https://apis.roblox.com/data" }, httpConfig, {
      dnsLookup: async () => [{ address, family: 6 }],
      httpsRequest: respondHttps(unexpectedConnection),
    }), /disallowed address/);
  }
  assert.equal(connections, 0);
});

test("HTTPS accepts public mapped IPv6 and pins its complete IPv6 connection address", async (t) => {
  const address = "::ffff:808:808";
  t.mock.method(globalThis, "fetch", async () => textResponse("public mapped endpoint"));
  const result = await getAllowedHttps({ url: "https://apis.roblox.com/data" }, httpConfig, {
    dnsLookup: async () => [{ address, family: 6 }],
    httpsRequest: respondHttps(async (target, options) => {
      const addresses = await connectionAddresses(target, options, async () => []);
      return textResponse(addresses.some((entry) => entry.address === address && entry.family === 6)
        ? "public mapped endpoint" : "wrong endpoint");
    }),
  });
  assert.equal(result.text, "public mapped endpoint");
});

test("HTTPS rejects the entire DNS answer set when one address is private", async (t) => {
  let connected = false;
  t.mock.method(globalThis, "fetch", async () => { connected = true; return textResponse("unexpected"); });
  await assert.rejects(getAllowedHttps({ url: "https://apis.roblox.com/data" }, httpConfig, {
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:c0a8:101", family: 6 }],
    httpsRequest: respondHttps(async () => { connected = true; return textResponse("unexpected"); }),
  }), /disallowed address/);
  assert.equal(connected, false);
});

test("artifact rejects a file replaced between stat and open even after the original path is restored", async (t) => {
  const root = await directory(t);
  const path = join(root, "record.txt");
  const held = join(root, "held.txt");
  const replacement = join(root, "replacement.txt");
  await writeFile(path, "safe artifact bytes");
  let swapped = false;
  let readCalls = 0;
  await assert.rejects(readArtifact({ root: "audits", path: "record.txt" }, artifactConfig(root), {
    stat: async (target, options) => {
      const observed = await stat(target, options);
      if (target === path && !swapped) {
        swapped = true;
        await rename(path, held);
        await writeFile(path, "outside private data");
      }
      return observed;
    },
    open: async (target, flags) => {
      const handle = await open(target, flags);
      await rename(path, replacement);
      await rename(held, path);
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => { readCalls += 1; return handle.read(...args); },
        close: () => handle.close(),
      };
    },
  }), /identity changed/);
  assert.equal(readCalls, 0);
});

test("artifact rejects a parent link swapped between realpath and stat before reading outside bytes", async (t) => {
  const root = await directory(t);
  const outside = await directory(t);
  const parent = join(root, "nested");
  const path = join(parent, "record.txt");
  await mkdir(parent);
  await writeFile(path, "safe artifact");
  await writeFile(join(outside, "record.txt"), "outside private artifact");
  let swapped = false;
  let readCalls = 0;
  await assert.rejects(readArtifact({ root: "audits", path: "nested/record.txt" }, artifactConfig(root), {
    realpath: async (target) => {
      const observed = await realpath(target);
      if (target === path && !swapped) {
        swapped = true;
        await rename(parent, join(root, "held"));
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      }
      return observed;
    },
    open: async (target, flags) => {
      const handle = await open(target, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => { readCalls += 1; return handle.read(...args); },
        close: () => handle.close(),
      };
    },
  }), /identity changed/);
  assert.equal(readCalls, 0);
});

test("artifact rejects same-size overwrites during a read rather than returning mixed content", async (t) => {
  const root = await directory(t);
  const path = join(root, "record.txt");
  await writeFile(path, "original artifact");
  await assert.rejects(readArtifact({ root: "audits", path: "record.txt" }, artifactConfig(root), {
    open: async (target, flags) => {
      const handle = await open(target, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: async (...args) => {
          await writeFile(path, "modified artifact");
          // A fixed distinct mtime makes the regression independent of filesystem clock resolution.
          await utimes(path, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
          return handle.read(...args);
        },
        close: () => handle.close(),
      };
    },
  }), /changed during read/);
});

test("trace rejects an append during its bounded read instead of using stale size metadata", async (t) => {
  const root = await directory(t);
  const path = join(root, "rows.ndjson");
  await writeFile(path, '{"kind":"first"}\n');
  const config = { artifactRoots: [{ name: "trace_records", path: root, recursive: false, extensions: [".ndjson"] }] };
  await assert.rejects(queryTrace({ path: "rows.ndjson" }, config, {
    open: async (target, flags) => {
      const handle = await open(target, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: async (...args) => {
          await appendFile(path, '{"kind":"second"}\n');
          return handle.read(...args);
        },
        close: () => handle.close(),
      };
    },
  }), /changed during read/);
});

test("artifact I/O errors do not disclose local paths or configured credentials", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "record.txt"), "artifact");
  await assert.rejects(readArtifact({ root: "audits", path: "record.txt" }, artifactConfig(root), {
    open: async (target, flags) => {
      const handle = await open(target, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: async () => { throw new Error(`EIO ${root} ${token}`); },
        close: () => handle.close(),
      };
    },
  }), (error) => !error.message.includes(root) && !error.message.includes(token) && /could not be read/.test(error.message));
});

test("artifact refuses alternate data stream syntax without resolving or opening that target", async (t) => {
  const root = await directory(t);
  const targetAccesses = [];
  await assert.rejects(readArtifact({ root: "audits", path: "record.txt:payload.json" }, artifactConfig(root), {
    realpath: async (target) => {
      if (target !== root) targetAccesses.push("resolve");
      return target;
    },
    stat: async (target, options) => {
      if (target === root) return stat(target, options);
      targetAccesses.push("stat");
      return { isFile: () => true, size: 2 };
    },
    open: async () => { targetAccesses.push("open"); throw new Error("alternate stream opened"); },
  }));
  assert.deepEqual(targetAccesses, []);
});

test("artifact pagination counts UTF-8 bytes even when a page splits a code point", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "record.txt"), "A€B");
  const request = { root: "audits", path: "record.txt" };
  const intact = await readArtifact({ ...request, offsetBytes: 1, maxBytes: 3 }, artifactConfig(root));
  assert.deepEqual([intact.text, intact.bytesRead, intact.truncated], ["€", 3, true]);
  const split = await readArtifact({ ...request, offsetBytes: 2, maxBytes: 1 }, artifactConfig(root));
  assert.deepEqual([split.text, split.bytesRead, split.truncated], ["�", 1, true]);
});

test("trace keeps only newline-terminated records and distinguishes byte truncation from an empty suffix", async (t) => {
  const root = await directory(t);
  const path = join(root, "rows.ndjson");
  const first = '{"kind":"first"}\n';
  await writeFile(path, `${first}{"kind":"last"}`);
  const config = { artifactRoots: [{ name: "trace_records", path: root, recursive: false, extensions: [".ndjson"] }] };
  const partial = await queryTrace({ path: "rows.ndjson" }, config);
  assert.deepEqual(partial.rows, [{ kind: "first" }]);
  assert.equal(partial.incompleteLine, true);
  assert.equal(partial.truncated, true);
  await appendFile(path, "\n");
  const complete = await queryTrace({ path: "rows.ndjson" }, config);
  assert.deepEqual(complete.rows, [{ kind: "first" }, { kind: "last" }]);
  assert.equal(complete.incompleteLine, false);
  assert.equal(complete.truncated, false);
  const boundary = await queryTrace({ path: "rows.ndjson", maxBytes: Buffer.byteLength(first) }, config);
  assert.deepEqual(boundary.rows, [{ kind: "first" }]);
  assert.equal(boundary.incompleteLine, false);
  assert.equal(boundary.truncated, true);
});

test("structured redaction never returns private child values after deeply nested JSON", async (t) => {
  const root = await directory(t);
  const privateValue = "private-structured-child-value";
  const nested = `${"[".repeat(12000)}0${"]".repeat(12000)}`;
  await writeFile(join(root, "record.json"), nested);
  const unchanged = await readArtifact({ root: "audits", path: "record.json", maxBytes: 65536 }, artifactConfig(root));
  assert.equal(unchanged.text, nested);
  await writeFile(join(root, "record.json"), `{"padding":${nested},"credentials":{"value":"${privateValue}"}}`);
  // Rejecting excessive complexity is safe; returning the raw fallback is not.
  let result;
  try {
    result = await readArtifact({ root: "audits", path: "record.json", maxBytes: 65536 }, artifactConfig(root));
  } catch (error) {
    assert.equal(error.message.includes(privateValue), false);
    return;
  }
  assert.equal(result.text.includes(privateValue), false);
});

test("structured redaction removes JSON-escaped configured credentials from keys and values", async (t) => {
  const root = await directory(t);
  const configuredToken = "abcdef0123456789abcdef0123456789abcdef";
  const encoded = [...configuredToken].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const json = `{"value":"${encoded}","${encoded}":"public field"}`;
  await writeFile(join(root, "record.json"), json);
  const config = { ...artifactConfig(root), token: configuredToken };
  const artifact = await readArtifact({ root: "audits", path: "record.json" }, config);
  assert.equal(JSON.stringify(JSON.parse(artifact.text)).includes(configuredToken), false);
  assert.equal(JSON.parse(artifact.text).value, "[REDACTED]");
  const respond = async () => new Response(json, { headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", respond);
  const http = await getAllowedHttps({ url: "https://apis.roblox.com/data" }, { ...httpConfig, token: configuredToken }, {
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    httpsRequest: respondHttps(respond),
  });
  assert.equal(JSON.stringify(JSON.parse(http.text)).includes(configuredToken), false);
  assert.equal(JSON.parse(http.text).value, "[REDACTED]");
});

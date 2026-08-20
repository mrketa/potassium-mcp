import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ASYNC_ARTIFACT_INLINE_BYTES,
  ASYNC_ARTIFACT_MAX_BYTES,
  ASYNC_ARTIFACT_MAX_COUNT,
  ASYNC_ARTIFACT_TTL_MS,
  createAsyncArtifactStore,
} from "../src/async-artifact-store.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-async-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = { value: 1_700_000_000_000, now() { return this.value; } };
  let sequence = 0;
  const randomBytes = (size) => Buffer.alloc(size, sequence++);
  return { root, clock, randomBytes, store: createAsyncArtifactStore({ root: { name: "artifacts", path: root }, clock, randomBytes }) };
}

test("keeps values at or below the inline limit out of the filesystem", async (t) => {
  const value = await fixture(t);
  const result = await value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES - 32) });
  assert.equal(result.kind, "inline");
  assert.equal(result.value.text.length, ASYNC_ARTIFACT_INLINE_BYTES - 32);
  await assert.rejects(() => readdir(path.join(value.root, "async-results")), /ENOENT/);
});

test("writes a large JSON result atomically with a bounded descriptor", async (t) => {
  const value = await fixture(t);
  const result = await value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
  assert.equal(result.kind, "artifact");
  assert.deepEqual(Object.keys(result.artifact).sort(), ["bytes", "expiresAt", "path", "root", "sha256"]);
  assert.equal(result.artifact.root, "artifacts");
  assert.match(result.artifact.path, /^async-results\/\d+-[a-f0-9]{32}\.json$/);
  assert.equal(result.artifact.expiresAt, new Date(value.clock.value + ASYNC_ARTIFACT_TTL_MS).toISOString());
  const target = path.join(value.root, ...result.artifact.path.split("/"));
  const content = await readFile(target);
  assert.equal(result.artifact.bytes, content.byteLength);
  assert.equal(result.artifact.sha256, createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(JSON.parse(content), { text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
  assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.includes(".tmp")), []);
});

test("rejects values larger than 4 MiB without writing an artifact", async (t) => {
  const value = await fixture(t);
  await assert.rejects(() => value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_MAX_BYTES) }), /exceeds 4 MiB/);
  await assert.rejects(() => readdir(path.join(value.root, "async-results")), /ENOENT/);
});

test("lazily evicts expired files and deterministically prunes the oldest artifacts over capacity", async (t) => {
  const value = await fixture(t);
  const directory = path.join(value.root, "async-results");
  await value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
  const first = (await readdir(directory)).find((name) => name.endsWith(".json"));
  value.clock.value += ASYNC_ARTIFACT_TTL_MS;
  await value.store.store({ text: "y".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
  assert.equal((await readdir(directory)).includes(first), false);

  for (let index = 0; index <= ASYNC_ARTIFACT_MAX_COUNT; index += 1) {
    value.clock.value += 1;
    await value.store.store({ text: `${index}`.padEnd(ASYNC_ARTIFACT_INLINE_BYTES, "z") });
  }
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, ASYNC_ARTIFACT_MAX_COUNT);
  const timestamps = await Promise.all(files.map(async (name) => ({ name, mtime: (await stat(path.join(directory, name))).mtimeMs })));
  assert.equal(Math.min(...timestamps.map(({ mtime }) => mtime)), value.clock.value - ASYNC_ARTIFACT_MAX_COUNT + 1);
});

test("refuses a symlinked artifact directory rather than writing through it", async (t) => {
  const value = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "potassium-async-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  try {
    await symlink(outside, path.join(value.root, "async-results"), "junction");
  } catch {
    t.skip("symlinks are unavailable in this environment");
    return;
  }
  await assert.rejects(() => value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }), /symbolic link/);
  assert.deepEqual(await readdir(outside), []);
});

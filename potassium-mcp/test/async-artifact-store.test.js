import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

async function swapFixture(t) {
  const value = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "potassium-async-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const probe = path.join(value.root, "symlink-probe");
  try {
    await symlink(outside, probe, "junction");
  } catch {
    t.skip("symlinks are unavailable in this environment");
    return null;
  }
  await rm(probe);
  const directory = path.join(value.root, "async-results");
  const held = path.join(value.root, "held");
  await mkdir(directory);
  await writeFile(path.join(outside, "unrelated.json"), "preserve outside");
  return {
    ...value, outside, directory, held,
    swap() {
      renameSync(directory, held);
      symlinkSync(outside, directory, "junction");
    },
  };
}

async function withFilesystemHook(name, hook, action) {
  const original = fs[name];
  fs[name] = (...args) => hook(original, ...args);
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
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

test("rejects an artifact parent swapped by the random source without publishing outside", async (t) => {
  const value = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "potassium-async-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const probe = path.join(value.root, "symlink-probe");
  try {
    await symlink(outside, probe, "junction");
  } catch {
    t.skip("symlinks are unavailable in this environment");
    return;
  }
  await rm(probe);
  await writeFile(path.join(outside, "unrelated.json"), "preserve outside");
  await writeFile(path.join(value.root, "unrelated.json"), "preserve root");
  let swapped = false;
  const store = createAsyncArtifactStore({
    root: { name: "artifacts", path: value.root },
    clock: value.clock,
    randomBytes(size) {
      if (!swapped) {
        renameSync(path.join(value.root, "async-results"), path.join(value.root, "held"));
        symlinkSync(outside, path.join(value.root, "async-results"), "junction");
        swapped = true;
      }
      return Buffer.alloc(size, 1);
    },
  });

  await assert.rejects(() => store.store({ text: "private-result".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }));
  assert.equal(swapped, true);
  assert.deepEqual(await readdir(outside), ["unrelated.json"]);
  assert.equal(await readFile(path.join(outside, "unrelated.json"), "utf8"), "preserve outside");
  assert.equal(await readFile(path.join(value.root, "unrelated.json"), "utf8"), "preserve root");
  assert.deepEqual(await readdir(path.join(value.root, "held")), []);
});

test("checks the directory again after staging-name randomness", async (t) => {
  const value = await swapFixture(t);
  if (!value) return;
  let calls = 0;
  const store = createAsyncArtifactStore({
    root: { name: "artifacts", path: value.root },
    clock: value.clock,
    randomBytes(size) {
      if (++calls === 2) value.swap();
      return Buffer.alloc(size, calls);
    },
  });
  await assert.rejects(() => store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }));
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(value.outside), ["unrelated.json"]);
  assert.equal(await readFile(path.join(value.outside, "unrelated.json"), "utf8"), "preserve outside");
  assert.deepEqual(await readdir(value.held), []);
});

test("rejects replacement by a different ordinary directory at the same path", async (t) => {
  const value = await fixture(t);
  const directory = path.join(value.root, "async-results");
  const held = path.join(value.root, "held");
  let swapped = false;
  const store = createAsyncArtifactStore({
    root: { name: "artifacts", path: value.root },
    clock: value.clock,
    randomBytes(size) {
      if (!swapped) {
        renameSync(directory, held);
        mkdirSync(directory);
        writeFileSync(path.join(directory, "unrelated.json"), "replacement directory");
        swapped = true;
      }
      return Buffer.alloc(size, 1);
    },
  });
  await assert.rejects(() => store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }));
  assert.equal(swapped, true);
  assert.deepEqual(await readdir(directory), ["unrelated.json"]);
  assert.equal(await readFile(path.join(directory, "unrelated.json"), "utf8"), "replacement directory");
  assert.deepEqual(await readdir(held), []);
});

test("never writes result bytes to a staged file opened through a swapped parent", async (t) => {
  const value = await swapFixture(t);
  if (!value) return;
  let staged;
  await withFilesystemHook("open", async (original, target, ...args) => {
    if (path.dirname(target) === value.directory && target.endsWith(".tmp")) {
      staged = path.basename(target);
      value.swap();
    }
    return original(target, ...args);
  }, async () => {
    await assert.rejects(() => value.store.store({ text: "private-result".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }));
  });
  assert.equal(typeof staged, "string");
  // A racing open may create an empty file; untrusted-path cleanup must not
  // remove it, and the private result must never be written or published there.
  assert.deepEqual((await readdir(value.outside)).sort(), [staged, "unrelated.json"].sort());
  assert.equal((await readFile(path.join(value.outside, staged))).byteLength, 0);
  assert.equal(await readFile(path.join(value.outside, "unrelated.json"), "utf8"), "preserve outside");
  assert.deepEqual(await readdir(value.held), []);
});

test("failed staging cleanup never unlinks an unrelated file through a replaced parent", async (t) => {
  const value = await swapFixture(t);
  if (!value) return;
  let staged;
  await withFilesystemHook("open", async (original, target, ...args) => {
    const file = await original(target, ...args);
    if (path.dirname(target) === value.directory && target.endsWith(".tmp")) {
      staged = path.basename(target);
      const originalWrite = file.writeFile.bind(file);
      const originalClose = file.close.bind(file);
      file.writeFile = async (...writeArgs) => {
        await originalWrite(...writeArgs);
        throw new Error("injected staging failure");
      };
      file.close = async () => {
        await originalClose();
        value.swap();
        await writeFile(path.join(value.outside, staged), "unrelated staging name");
      };
    }
    return file;
  }, async () => {
    await assert.rejects(() => value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }), /injected staging failure/);
  });
  assert.equal(await readFile(path.join(value.outside, staged), "utf8"), "unrelated staging name");
  assert.equal(await readFile(path.join(value.outside, "unrelated.json"), "utf8"), "preserve outside");
  assert.deepEqual((await readdir(value.outside)).sort(), [staged, "unrelated.json"].sort());
});

test("pruning rejects a parent swap during directory enumeration without deleting outside files", async (t) => {
  const value = await swapFixture(t);
  if (!value) return;
  const name = `${value.clock.value}-${"01".repeat(16)}.json`;
  for (const directory of [value.directory, value.outside]) {
    await writeFile(path.join(directory, name), directory === value.directory ? "expired artifact" : "unrelated outside artifact name");
    await utimes(path.join(directory, name), 0, 0);
  }
  let swapped = false;
  await withFilesystemHook("readdir", async (original, target, ...args) => {
    const names = await original(target, ...args);
    if (target === value.directory && !swapped) {
      value.swap();
      swapped = true;
    }
    return names;
  }, async () => {
    await assert.rejects(() => value.store.prune());
  });
  assert.equal(swapped, true);
  assert.equal(await readFile(path.join(value.outside, name), "utf8"), "unrelated outside artifact name");
  assert.equal(await readFile(path.join(value.outside, "unrelated.json"), "utf8"), "preserve outside");
  assert.equal(await readFile(path.join(value.held, name), "utf8"), "expired artifact");
});

test("pruning rechecks the parent after obtaining a deletion candidate's identity", async (t) => {
  const value = await swapFixture(t);
  if (!value) return;
  const name = `${value.clock.value}-${"01".repeat(16)}.json`;
  await writeFile(path.join(value.directory, name), "expired artifact");
  await utimes(path.join(value.directory, name), 0, 0);
  await writeFile(path.join(value.outside, name), "unrelated outside artifact name");
  let candidateReads = 0;
  await withFilesystemHook("lstat", async (original, target, ...args) => {
    const entry = await original(target, ...args);
    if (target === path.join(value.directory, name) && ++candidateReads === 2) value.swap();
    return entry;
  }, async () => {
    await assert.rejects(() => value.store.prune());
  });
  assert.equal(candidateReads, 2);
  assert.equal(await readFile(path.join(value.outside, name), "utf8"), "unrelated outside artifact name");
  assert.equal(await readFile(path.join(value.outside, "unrelated.json"), "utf8"), "preserve outside");
  assert.equal(await readFile(path.join(value.held, name), "utf8"), "expired artifact");
});

test("preserves existing artifact and staging names when retrying collisions", async (t) => {
  const value = await fixture(t);
  const directory = path.join(value.root, "async-results");
  await mkdir(directory);
  const existing = `${value.clock.value}-${"01".repeat(16)}.json`;
  const staged = `.${value.clock.value}-${"02".repeat(16)}.json.${"03".repeat(16)}.tmp`;
  await writeFile(path.join(directory, existing), "existing artifact");
  await writeFile(path.join(directory, staged), "existing staged file");
  let sequence = 0;
  const store = createAsyncArtifactStore({
    root: { name: "artifacts", path: value.root },
    clock: value.clock,
    randomBytes: (size) => Buffer.alloc(size, ++sequence),
  });
  const result = await store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
  assert.equal(result.artifact.path, `async-results/${value.clock.value}-${"04".repeat(16)}.json`);
  assert.equal(await readFile(path.join(directory, existing), "utf8"), "existing artifact");
  assert.equal(await readFile(path.join(directory, staged), "utf8"), "existing staged file");
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), [staged]);
});

test("atomic publication retries rather than overwriting a newly occupied target", async (t) => {
  const value = await fixture(t);
  let occupied;
  const result = await withFilesystemHook("link", async (original, staged, target) => {
    if (!occupied) {
      occupied = target;
      await writeFile(target, "publication collision", { flag: "wx" });
    }
    return original(staged, target);
  }, () => value.store.store({ text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) }));
  assert.notEqual(path.basename(result.artifact.path), path.basename(occupied));
  assert.equal(await readFile(occupied, "utf8"), "publication collision");
  assert.deepEqual((await readdir(path.dirname(occupied))).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(value.root, result.artifact.path), "utf8")), { text: "x".repeat(ASYNC_ARTIFACT_INLINE_BYTES) });
});

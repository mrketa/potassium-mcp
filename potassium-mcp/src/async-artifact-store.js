import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const ASYNC_ARTIFACT_INLINE_BYTES = 64 * 1024;
export const ASYNC_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
export const ASYNC_ARTIFACT_MAX_COUNT = 64;
export const ASYNC_ARTIFACT_TTL_MS = 900_000;

const ARTIFACT_DIRECTORY = "async-results";
const ARTIFACT_NAME = /^[0-9]+-[a-f0-9]{32}\.json$/;

function artifactError(message) {
  const error = new Error(message);
  error.name = "AsyncArtifactStoreError";
  return error;
}

function isWithin(root, target) {
  const value = relative(root, target);
  return value === "" || (!isAbsolute(value) && !value.startsWith(`..${sep}`) && value !== "..");
}

function asMilliseconds(clock) {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) throw artifactError("Artifact clock returned an invalid time");
  return now;
}

function safeRandomHex(randomBytes) {
  const value = randomBytes(16);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw artifactError("Artifact random source returned invalid bytes");
  if (value.byteLength !== 16) throw artifactError("Artifact random source returned invalid bytes");
  return Buffer.from(value).toString("hex");
}

function sameFileIdentity(left, right) {
  return typeof left.ino === "bigint" && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

async function directoryWithoutSymlink(target, { create = false } = {}) {
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  const entry = await lstat(target, { bigint: true }).catch(() => { throw artifactError("Artifact root is unavailable"); });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw artifactError("Artifact root must be a directory and not a symbolic link");
  const path = await realpath(target).catch(() => { throw artifactError("Artifact root is unavailable"); });
  const actual = await lstat(path, { bigint: true }).catch(() => { throw artifactError("Artifact root is unavailable"); });
  if (!actual.isDirectory() || actual.isSymbolicLink() || !sameFileIdentity(entry, actual)) {
    throw artifactError("Artifact directory identity changed");
  }
  return { path, identity: entry };
}

function normalizedRoot(root) {
  if (!root || typeof root !== "object" || typeof root.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(root.name)) {
    throw artifactError("Artifact root name is invalid");
  }
  if (typeof root.path !== "string" || root.path.length === 0 || root.path.includes("\0") || !isAbsolute(root.path)) {
    throw artifactError("Artifact root path is invalid");
  }
  return { name: root.name, path: resolve(root.path) };
}

/** Stores only terminal async results that do not fit safely in an MCP response. */
class AsyncArtifactStore {
  constructor({ root, clock, randomBytes }) {
    this.root = normalizedRoot(root);
    if (!clock || typeof clock.now !== "function") throw artifactError("Artifact clock is required");
    if (typeof randomBytes !== "function") throw artifactError("Artifact random source is required");
    this.clock = clock;
    this.randomBytes = randomBytes;
  }

  async #directory() {
    const root = await directoryWithoutSymlink(this.root.path);
    const requested = resolve(root.path, ARTIFACT_DIRECTORY);
    if (!isWithin(root.path, requested)) throw artifactError("Artifact directory escapes its root");
    const directory = await directoryWithoutSymlink(requested, { create: true });
    if (directory.path !== requested || !isWithin(root.path, directory.path)) throw artifactError("Artifact directory escapes its root");
    const state = { root, directory };
    await this.#assertDirectory(state);
    return state;
  }

  async #assertDirectory(state) {
    const root = await directoryWithoutSymlink(this.root.path);
    const canonicalRoot = await directoryWithoutSymlink(state.root.path);
    const directory = await directoryWithoutSymlink(state.directory.path);
    if (root.path !== state.root.path || canonicalRoot.path !== state.root.path
      || directory.path !== state.directory.path
      || !sameFileIdentity(state.root.identity, root.identity)
      || !sameFileIdentity(state.root.identity, canonicalRoot.identity)
      || !sameFileIdentity(state.directory.identity, directory.identity)) {
      throw artifactError("Artifact directory identity changed");
    }
  }

  async #assertFile(state, target, identity) {
    const entry = await lstat(target, { bigint: true }).catch(() => { throw artifactError("Artifact file is unavailable"); });
    if (!entry.isFile() || entry.isSymbolicLink() || !sameFileIdentity(identity, entry)) {
      throw artifactError("Artifact file identity changed");
    }
    await this.#assertDirectory(state);
  }

  async #remove(state, target, identity) {
    await this.#assertFile(state, target, identity);
    // Node has no portable unlinkat/linkat API. These checks reject persistent
    // parent swaps, not an ABA swap inside the subsequent pathname operation.
    await rm(target, { force: true }).catch(() => {});
    await this.#assertDirectory(state);
  }

  async #entries(state) {
    const directory = state.directory.path;
    const names = await readdir(directory).catch(() => { throw artifactError("Artifact directory is unavailable"); });
    await this.#assertDirectory(state);
    const entries = await Promise.all(names.filter((name) => ARTIFACT_NAME.test(name)).map(async (name) => {
      const target = resolve(directory, name);
      if (!isWithin(directory, target) || basename(target) !== name) return null;
      const entry = await lstat(target, { bigint: true }).catch(() => null);
      if (!entry || !entry.isFile() || entry.isSymbolicLink()) return null;
      return { name, target, mtimeMs: Number(entry.mtimeMs), identity: entry };
    }));
    await this.#assertDirectory(state);
    return entries.filter(Boolean);
  }

  async #prune(state, retainedTarget) {
    const now = asMilliseconds(this.clock);
    await this.#assertDirectory(state);
    const entries = await this.#entries(state);
    const expired = entries.filter((entry) => now >= entry.mtimeMs + ASYNC_ARTIFACT_TTL_MS);
    for (const { target, identity } of expired) await this.#remove(state, target, identity);
    const remaining = entries.filter((entry) => !expired.includes(entry) && entry.target !== retainedTarget).sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const retainedCount = entries.some((entry) => entry.target === retainedTarget && !expired.includes(entry)) ? 1 : 0;
    const excess = remaining.slice(0, Math.max(0, remaining.length + retainedCount - ASYNC_ARTIFACT_MAX_COUNT));
    for (const { target, identity } of excess) await this.#remove(state, target, identity);
  }

  async prune() {
    await this.#prune(await this.#directory());
  }

  async store(value) {
    const text = JSON.stringify(value);
    if (text === undefined) throw artifactError("Async artifact value must be JSON serializable");
    const content = Buffer.from(text, "utf8");
    if (content.byteLength <= ASYNC_ARTIFACT_INLINE_BYTES) return { kind: "inline", value };
    if (content.byteLength > ASYNC_ARTIFACT_MAX_BYTES) throw artifactError("Async artifact exceeds 4 MiB");

    const now = asMilliseconds(this.clock);
    const state = await this.#directory();
    const directory = state.directory.path;
    await this.#prune(state);
    let target;
    let name;
    let committed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      name = `${now}-${safeRandomHex(this.randomBytes)}.json`;
      target = resolve(directory, name);
      if (!isWithin(directory, target) || basename(target) !== name) throw artifactError("Artifact path is invalid");
      await this.#assertDirectory(state);
      const present = await lstat(target).then(() => true).catch(() => false);
      await this.#assertDirectory(state);
      if (present) continue;
      const staged = resolve(directory, `.${name}.${safeRandomHex(this.randomBytes)}.tmp`);
      let identity;
      try {
        await this.#assertDirectory(state);
        const file = await open(staged, "wx", 0o600);
        try {
          identity = await file.stat({ bigint: true });
          // Opening creates only an empty file. Never pass result bytes to a
          // pathname operation before the opened file and its parents agree.
          await this.#assertFile(state, staged, identity);
          await file.writeFile(content);
          await file.utimes(now / 1000, now / 1000);
        } finally {
          await file.close();
        }
        await this.#assertFile(state, staged, identity);
        await link(staged, target);
        await this.#assertFile(state, target, identity);
        await this.#remove(state, staged, identity);
        committed = true;
        break;
      } catch (error) {
        // A changed parent makes the pathname untrusted, even when we opened
        // a file with this name earlier. Leave it rather than unlink outside.
        if (identity) await this.#remove(state, staged, identity).catch(() => {});
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (!committed) throw artifactError("Could not allocate an artifact path");
    await this.#prune(state, target);
    return {
      kind: "artifact",
      artifact: {
        root: this.root.name,
        path: `${ARTIFACT_DIRECTORY}/${name}`,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        expiresAt: new Date(now + ASYNC_ARTIFACT_TTL_MS).toISOString(),
      },
    };
  }
}

export function createAsyncArtifactStore(options) {
  return new AsyncArtifactStore(options);
}

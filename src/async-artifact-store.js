import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
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

async function directoryWithoutSymlink(target, { create = false } = {}) {
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  const entry = await lstat(target).catch(() => { throw artifactError("Artifact root is unavailable"); });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw artifactError("Artifact root must be a directory and not a symbolic link");
  return await realpath(target).catch(() => { throw artifactError("Artifact root is unavailable"); });
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
export class AsyncArtifactStore {
  constructor({ root, clock, randomBytes }) {
    this.root = normalizedRoot(root);
    if (!clock || typeof clock.now !== "function") throw artifactError("Artifact clock is required");
    if (typeof randomBytes !== "function") throw artifactError("Artifact random source is required");
    this.clock = clock;
    this.randomBytes = randomBytes;
  }

  async #directory() {
    const root = await directoryWithoutSymlink(this.root.path);
    const directory = resolve(root, ARTIFACT_DIRECTORY);
    if (!isWithin(root, directory)) throw artifactError("Artifact directory escapes its root");
    const actual = await directoryWithoutSymlink(directory, { create: true });
    if (!isWithin(root, actual)) throw artifactError("Artifact directory escapes its root");
    return { root, directory: actual };
  }

  async #entries(directory) {
    const names = await readdir(directory).catch(() => { throw artifactError("Artifact directory is unavailable"); });
    const entries = await Promise.all(names.filter((name) => ARTIFACT_NAME.test(name)).map(async (name) => {
      const target = resolve(directory, name);
      if (!isWithin(directory, target) || basename(target) !== name) return null;
      const entry = await lstat(target).catch(() => null);
      if (!entry || !entry.isFile() || entry.isSymbolicLink()) return null;
      return { name, target, mtimeMs: Math.trunc(entry.mtimeMs) };
    }));
    return entries.filter(Boolean);
  }

  async prune() {
    const now = asMilliseconds(this.clock);
    const { directory } = await this.#directory();
    const entries = await this.#entries(directory);
    const expired = entries.filter((entry) => now >= entry.mtimeMs + ASYNC_ARTIFACT_TTL_MS);
    await Promise.all(expired.map(({ target }) => rm(target, { force: true }).catch(() => {})));
    const remaining = entries.filter((entry) => !expired.includes(entry)).sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const excess = remaining.slice(0, Math.max(0, remaining.length - ASYNC_ARTIFACT_MAX_COUNT));
    await Promise.all(excess.map(({ target }) => rm(target, { force: true }).catch(() => {})));
  }

  async store(value) {
    const text = JSON.stringify(value);
    if (text === undefined) throw artifactError("Async artifact value must be JSON serializable");
    const content = Buffer.from(text, "utf8");
    if (content.byteLength <= ASYNC_ARTIFACT_INLINE_BYTES) return { kind: "inline", value };
    if (content.byteLength > ASYNC_ARTIFACT_MAX_BYTES) throw artifactError("Async artifact exceeds 4 MiB");

    const now = asMilliseconds(this.clock);
    const { directory } = await this.#directory();
    await this.prune();
    let target;
    let name;
    let staged;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      name = `${now}-${safeRandomHex(this.randomBytes)}.json`;
      target = resolve(directory, name);
      if (!isWithin(directory, target) || basename(target) !== name) throw artifactError("Artifact path is invalid");
      const present = await lstat(target).then(() => true).catch(() => false);
      if (present) continue;
      staged = resolve(directory, `.${name}.${safeRandomHex(this.randomBytes)}.tmp`);
      try {
        await writeFile(staged, content, { encoding: undefined, mode: 0o600, flag: "wx" });
        await utimes(staged, now / 1000, now / 1000);
        await rename(staged, target);
        staged = undefined;
        break;
      } catch (error) {
        await rm(staged, { force: true }).catch(() => {});
        staged = undefined;
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (!target || await lstat(target).then(() => false).catch(() => true)) throw artifactError("Could not allocate an artifact path");
    await this.prune();
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

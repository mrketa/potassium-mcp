import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const sameIdentity = (a, b) => typeof a.ino === "bigint" && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export function createContextStore({ configFile: inputConfigFile, namespace, errorPrefix, randomBytes = nodeRandomBytes, indexMaxBytes = 16384 } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace ?? "") || !/^[A-Z][A-Z0-9_]*_$/.test(errorPrefix ?? "")) throw new TypeError("Invalid context store namespace or error prefix");
  if (!Number.isSafeInteger(indexMaxBytes) || indexMaxBytes < 16384 || indexMaxBytes > 65536) throw new TypeError("Invalid context index byte limit");
  const configFile = typeof inputConfigFile === "string" && inputConfigFile.length > 0 && !inputConfigFile.includes("\0") && isAbsolute(inputConfigFile) ? resolve(inputConfigFile) : null;
  const fail = (code, message, details = {}) => Object.assign(new Error(message), { code: `${errorPrefix}${code}`, ...details });
function randomHex(randomBytes) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw fail("STORAGE", "Context identifier source is unavailable");
  return Buffer.from(bytes).toString("hex");
}
function jsonBytes(value, max = 16384) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > max) throw fail("INVALID_DATA", "Game context data exceeds the byte limit");
  return bytes;
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw fail("STORAGE", "Stored game context is not valid UTF-8 JSON"); }
}
async function restrictTokenAcl(target) {
  if (process.platform !== "win32") return;
  // install.js imports server.js, which consumes this module's schemas. Load
  // the existing ACL policy after initialization rather than creating a cycle.
  const install = await import("./install.js");
  await install.restrictTokenAcl(target);
}
async function inspect(path, directory = true) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || info.ino === 0n || canonical(await realpath(path)) !== canonical(path)) throw fail("STORAGE", "Context path redirects through a symbolic link or reparse point");
  if (!directory && info.nlink !== 1n) throw fail("STORAGE", "Context file is not privately owned");
  if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) throw fail("STORAGE", "Context path has a different owner");
  return { path, info };
}
async function assertEntries(entries) {
  for (const entry of entries) {
    const current = await inspect(entry.path, entry.info.isDirectory());
    if (!sameIdentity(entry.info, current.info)) throw fail("STORAGE", "Context directory or file identity changed");
  }
}
async function ancestry(path) {
  let current = parsePath(path).root;
  const entries = [];
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    // System ancestors need not belong to the current user.
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n || canonical(await realpath(current)) !== canonical(current)) throw fail("STORAGE", "Configuration ancestor redirects through a symbolic link or reparse point");
    entries.push({ path: current, info });
  }
  return entries;
}
async function assertAncestry(entries) {
  for (const entry of entries) {
    const info = await lstat(entry.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(entry.info, info) || canonical(await realpath(entry.path)) !== canonical(entry.path)) throw fail("STORAGE", "Configuration ancestor identity changed");
  }
}
async function assertState(state, extra = []) {
  await assertAncestry(state.ancestors);
  await assertEntries([...state.directories, ...extra]);
}
async function privateDirectory(path, state, create) {
  let created = false;
  try { await lstat(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create) return null;
    await assertState(state);
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  }
  const entry = await inspect(path);
  await assertState(state, [entry]);
  if (created) { await restrictTokenAcl(path); await assertState(state, [entry]); }
  if (process.platform !== "win32" && (entry.info.mode & 0o077n) !== 0n) throw fail("STORAGE", "Context directory permissions are not private");
  return entry;
}
async function readBytes(state, directory, name, max, expectedHash) {
  const path = resolve(directory.path, name);
  await assertState(state, [directory]);
  const entry = await inspect(path, false);
  if (entry.info.size < 1n || entry.info.size > BigInt(max)) throw fail("STORAGE", "Stored context file exceeds its byte limit");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!sameVersion(entry.info, before)) throw fail("STORAGE", "Stored context file changed before reading");
    await assertState(state, [directory, entry]);
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw fail("STORAGE", "Stored context file changed during reading");
      offset += result.bytesRead;
    }
    await assertState(state, [directory, entry]);
    if (!sameVersion(before, await file.stat({ bigint: true })) || !sameVersion(before, (await inspect(path, false)).info)) throw fail("STORAGE", "Stored context file changed during reading");
    if (expectedHash && hash(bytes) !== expectedHash) throw fail("STORAGE", "Stored context content hash does not match");
    return { bytes, entry };
  } finally { await file.close(); }
}
async function writeBytes(state, directory, name, bytes) {
  await assertState(state, [directory]);
  const path = resolve(directory.path, name);
  const file = await open(path, "wx", 0o600);
  let entry;
  let complete = false;
  try {
    entry = { path, info: await file.stat({ bigint: true }) };
    await assertState(state, [directory, entry]);
    await restrictTokenAcl(path);
    await assertState(state, [directory, entry]);
    await file.writeFile(bytes);
    await file.sync();
    await assertState(state, [directory, entry]);
    complete = true;
    return entry;
  } finally {
    await file.close();
    if (!complete && entry) await removeFile(state, directory, entry).catch(() => {});
  }
}
async function removeFile(state, directory, entry) {
  await assertState(state, [directory, entry]);
  // Like the artifact store, Node cannot close the final pathname-operation ABA
  // race without unlinkat. Persistent ancestor swaps fail closed before deletion.
  await unlink(entry.path);
  await assertState(state, [directory]);
}
async function namesIn(state, directory, maximum) {
  await assertState(state, [directory]);
  const names = [];
  const handle = await opendir(directory.path);
  try {
    for await (const entry of handle) {
      if (names.length >= maximum) throw fail("STORAGE", "Context directory exceeds its entry bound");
      names.push(entry.name);
    }
  } finally { await handle.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error; }); }
  await assertState(state, [directory]);
  return names;
}
  async function state(create = false) {
    if (!configFile) throw fail("UNAVAILABLE", "Game context storage requires an explicit absolute configuration identity");
    const parent = dirname(configFile);
    let ancestors;
    try { ancestors = await ancestry(parent); }
    catch (error) { if (!create && error.code === "ENOENT") return null; throw error; }
    const state = { ancestors, directories: [] };
    try { await inspect(configFile, false); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    state.owner = hash(canonical(configFile));
    const root = await privateDirectory(resolve(parent, namespace), state, create);
    if (!root) return null;
    state.directories.push(root);
    const directory = await privateDirectory(resolve(root.path, state.owner), state, create);
    if (!directory) return null;
    state.directories.push(directory);
    state.directory = directory;
    await assertState(state);
    return state;
  }
  async function storage(action) {
    try { return await action(); }
    catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith(errorPrefix)) throw error;
      throw fail("STORAGE", "Game context storage is unavailable; no local paths are exposed");
    }
  }
  async function verifyLock(state, lease) {
    const current = await readBytes(state, state.directory, lease.name, 512, lease.sha256);
    if (!sameIdentity(lease.entry.info, current.entry.info)) throw fail("STORAGE", "Context lock identity changed; preserving its successor");
    return current.entry;
  }
  async function removeLock(state, lease) {
    await removeFile(state, state.directory, await verifyLock(state, lease));
  }
  async function lock(state) {
    const name = ".writer.lock";
    await assertState(state);
    try {
      await lstat(resolve(state.directory.path, ".writer.lock.recovery"));
      throw fail("BUSY", "A context recovery guard is present; preserve it before further mutations");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const bytes = jsonBytes({ schema: 1, owner: state.owner, pid: process.pid, nonce: randomHex(randomBytes) }, 512);
    const digest = hash(bytes);
    const create = async (marker) => ({ name: marker, sha256: digest, entry: await writeBytes(state, state.directory, marker, bytes) });
    const requireDeadOwner = (content) => {
      const owner = parseJson(content);
      if (!owner || owner.schema !== 1 || owner.owner !== state.owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9]{32}$/.test(owner.nonce)) throw fail("STORAGE", "Context writer lock ownership is invalid");
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return; }
      throw fail("BUSY", "Another game context mutation is in progress; no capture queue is used");
    };
    let lease;
    try { lease = await create(name); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readBytes(state, state.directory, name, 512);
      requireDeadOwner(previous.bytes);
      let guard;
      try { guard = await create(".writer.lock.recovery"); }
      catch (cause) {
        if (cause.code === "EEXIST") throw fail("BUSY", "Another game context operation owns the recovery guard");
        throw cause;
      }
      let releasedGuard = false;
      try {
        // Every reclaimer must acquire this guard before re-reading and
        // removing the exact dead lease. A second recoverer cannot unlink a
        // successor between our ownership check and pathname removal.
        const current = await readBytes(state, state.directory, name, 512);
        if (!sameIdentity(previous.entry.info, current.entry.info) || !previous.bytes.equals(current.bytes)) throw fail("BUSY", "Context writer changed during recovery; preserving its successor");
        requireDeadOwner(current.bytes);
        await verifyLock(state, guard);
        await removeLock(state, { name, entry: current.entry, sha256: hash(current.bytes) });
        try { lease = await create(name); }
        catch (cause) {
          if (cause.code === "EEXIST") throw fail("BUSY", "Another game context mutation acquired the writer lock");
          throw cause;
        }
        await removeLock(state, guard);
        releasedGuard = true;
      } catch (cause) {
        if (lease) await removeLock(state, lease).catch(() => {});
        throw cause;
      } finally {
        if (!releasedGuard) await removeLock(state, guard).catch(() => {});
      }
    }
    return async () => { await removeLock(state, lease); };
  }
  async function publishIndex(state, catalog, fence = () => {}) {
    const name = `.index-${randomHex(randomBytes)}.tmp`;
    let staged;
    try {
      staged = await writeBytes(state, state.directory, name, jsonBytes(catalog, indexMaxBytes));
      await assertState(state, [staged]);
      const target = resolve(state.directory.path, "index.json");
      try { await inspect(target, false); } catch (error) { if (error.code !== "ENOENT") throw error; }
      fence();
      await rename(staged.path, target);
      // The rename is the linearization point. No throwing work follows it:
      // publication succeeded even if best-effort old-context cleanup cannot.
    } catch (error) { if (staged) await removeFile(state, state.directory, staged).catch(() => {}); throw error; }
  }
  return Object.freeze({ configFile, state, storage, readBytes, writeBytes, removeFile, namesIn, inspect, assertState, privateDirectory, lock, publishIndex, restrictTokenAcl });
}

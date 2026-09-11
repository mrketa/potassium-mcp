import assert from "node:assert/strict";
import fs, { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGameContextService, gameContextInputSchema, gameContextOutputSchema } from "../src/game-context.js";

// Deliberately synthetic provider bytes: these tests prove storage/envelope
// behavior only. They are not evidence of a Roblox window or map capture.
const JPEG_FIXTURE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const unavailableImages = { async render() { return { screenshot: { status: "unavailable", reason: "fixture-no-window" }, map: { status: "unavailable", reason: "fixture-no-renderer" } }; } };
const fakeFacet = (kind) => ({
  status: "available", data: Buffer.from(JPEG_FIXTURE), mimeType: "image/jpeg", width: 32, height: 24, provider: `synthetic-${kind}-fixture`,
  ...(kind === "screenshot" ? { target: { pid: 123, startedAt: "2026-09-09T00:00:00.000Z", windowHandle: "0x123", association: "Synthetic test association; not an actual window" } } : {}),
});
const successfulImages = { async render({ screenshot, map }) { return { screenshot: screenshot ? fakeFacet("screenshot") : { status: "not-requested", reason: "not-requested" }, map: map ? fakeFacet("map") : { status: "not-requested", reason: "not-requested" } }; } };
function scene(overrides = {}) {
  const value = {
    schema: 2, sourceSnapshotId: "a".repeat(32), root: "Workspace", place: { placeId: 1234, placeVersion: 7, name: "Fixture place" },
    player: { present: true, position: { x: 3, y: 5, z: 9 } }, coverage: "complete", truncated: false, stopReasons: [],
    parts: [{ name: "Floor", path: "Workspace.Floor", className: "Part", cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: { x: 20, y: 1, z: 20 }, anchored: true, canCollide: true }],
    ui: { coverage: "complete", truncated: false, entries: [{ name: "Status", path: "Players.LocalPlayer.PlayerGui.Status", className: "TextLabel", text: "[REDACTED]" }] },
    remotes: { root: "game.ReplicatedStorage", coverage: "complete", truncated: false, entries: [
      { name: "Update", path: "game.ReplicatedStorage.Update", className: "RemoteEvent" },
      { name: "Query", path: "game.ReplicatedStorage.Query", className: "RemoteFunction" },
      { name: "Position", path: "game.ReplicatedStorage.Position", className: "UnreliableRemoteEvent" },
    ] },
    atomicSnapshot: false, ...overrides,
  };
  value.parts = value.parts.map((part, index) => ({ ...part, sourceObjectId: index.toString(16).padStart(32, "0") }));
  value.facetCoverage ??= {
    geometry: { visited: value.parts.length, coverage: value.coverage, truncated: value.truncated, stopReasons: value.stopReasons },
    ui: { visited: value.ui.entries.length, coverage: value.ui.coverage, truncated: value.ui.truncated, stopReasons: [] },
    remotes: { visited: value.remotes?.entries.length ?? 0, coverage: value.remotes?.coverage ?? "partial", truncated: value.remotes?.truncated ?? true, stopReasons: [] },
  };
  value.visited ??= Object.values(value.facetCoverage).reduce((sum, facet) => sum + facet.visited, 0);
  if (Object.values(value.facetCoverage).some((facet) => facet.coverage === "partial")) value.coverage = "partial";
  if (Object.values(value.facetCoverage).some((facet) => facet.truncated)) value.truncated = true;
  return value;
}

test("source verifies immutable capture identity without exporting storage state", async (t) => {
  const value = await fixture(t);
  const captured = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  value.service.close();
  const reader = createGameContextService({ configFile: value.configFile });
  t.after(() => reader.close());
  const source = await reader.source(captured.contextId);
  assert.deepEqual(Object.keys(source).sort(), ["contextId", "capturedAt", "client", "place", "root", "coverage", "truncated", "sha256", "scene"].sort());
  assert.equal(source.scene.sourceSnapshotId, "a".repeat(32));
  assert.throws(() => { source.scene.parts[0].size.x = 999; }, TypeError);
  assert.throws(() => { source.client.generation = 999; }, TypeError);
  assert.equal((await reader.source(captured.contextId)).scene.parts[0].size.x, 20);
  const target = path.join(value.namespace, captured.contextId, "context.json");
  const bytes = await readFile(target);
  assert.equal(source.sha256, createHash("sha256").update(bytes).digest("hex"));
  await writeFile(target, bytes.toString("utf8").replace('"Floor"', '"Other"'));
  await assert.rejects(() => reader.source(captured.contextId), isCode("STORAGE"));
});

test("basic part pages omit enrichment while immutable source retains every native facet", async (t) => {
  const value = await fixture(t);
  const data = scene({
    physics: { gravity: 196.2, walkSpeed: 16, jumpPower: 50, jumpHeight: 7.2, useJumpPower: true, hipHeight: 2, bodySize: { x: 2, y: 5, z: 2 } },
  });
  const basic = { ...data.parts[0] };
  delete basic.sourceObjectId;
  Object.assign(data.parts[0], {
    shape: "Block", canTouch: false, canQuery: true, material: "Concrete", collisionGroup: "Platforms", collidesWithCharacter: false,
    linearVelocity: { x: 1, y: 2, z: 3 }, angularVelocity: { x: 0, y: 0.5, z: 0 },
    tags: ["MovingPlatform"], attributes: [{ name: "Enabled", value: true }, { name: "Speed", value: 4 }, { name: "Mode", value: "Loop" }],
  });
  const captured = await value.service.capture({ screenshot: false, map: false }, captureOptions({ collect: async () => data }));
  const target = path.join(value.namespace, captured.contextId, "context.json");
  const originalBytes = await readFile(target);
  const page = await value.service.read({ contextId: captured.contextId, section: "parts" });
  assert.deepEqual(page.entries, [basic]);
  assert.equal(gameContextOutputSchema.safeParse({ ...page, entries: data.parts }).success, false);
  const source = await value.service.source(captured.contextId);
  assert.deepEqual(source.scene, data);
  assert.throws(() => { source.scene.parts[0].attributes[0].value = false; }, TypeError);
  assert.throws(() => { source.scene.facetCoverage.geometry.visited = 0; }, TypeError);
  assert.deepEqual(await readFile(target), originalBytes);
});

test("capture2 rejects missing retained identities and contradictory facet budgets", async (t) => {
  const value = await fixture(t);
  const missingSnapshot = scene();
  delete missingSnapshot.sourceSnapshotId;
  const missingObject = scene();
  delete missingObject.parts[0].sourceObjectId;
  const exceededVisits = scene();
  exceededVisits.facetCoverage.geometry.visited += 1;
  const inconsistentFacet = scene();
  inconsistentFacet.facetCoverage.ui.coverage = "partial";
  for (const data of [missingSnapshot, missingObject, exceededVisits, inconsistentFacet]) {
    await assert.rejects(() => value.service.capture({ screenshot: false, map: false }, captureOptions({ collect: async () => data })), isCode("INVALID_DATA"));
  }
  assert.deepEqual((await value.service.list()).contexts, []);
});
function captureOptions(overrides = {}) {
  return { client: { clientId: "client-fixture", generation: 3 }, clientCount: 1, imageBudget: 65536, isCurrent: () => true, collect: async () => scene(), ...overrides };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-game-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "config.json");
  await writeFile(configFile, "{}", { mode: 0o600 });
  const clock = { value: 1_780_000_000_000, now() { return this.value; } };
  let sequence = 0;
  const randomBytes = (size) => { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(++sequence, size - 4); return bytes; };
  const settings = { configFile, clock, randomBytes, images: unavailableImages, ...options };
  const service = createGameContextService(settings);
  t.after(() => service.close());
  const identity = process.platform === "win32" ? path.resolve(configFile).toLowerCase() : path.resolve(configFile);
  const namespace = path.join(root, "game-contexts", createHash("sha256").update(identity).digest("hex"));
  return { root, configFile, clock, settings, service, namespace };
}
async function retainLegacyRecord(value, contextId, { omitRemotes = false } = {}) {
  const contextPath = path.join(value.namespace, contextId, "context.json");
  const record = JSON.parse(await readFile(contextPath, "utf8"));
  const data = record.scene;
  // Original schema-1 writer order: parts preceded UI, atomicSnapshot was last.
  record.scene = {
    schema: 1, root: data.root, place: data.place, player: data.player, coverage: data.coverage,
    truncated: data.truncated, visited: data.visited, stopReasons: data.stopReasons,
    parts: data.parts.map(({ name, path, className, cframe, size, anchored, canCollide }) => ({ name, path, className, cframe, size, anchored, canCollide })),
    ui: data.ui, ...(!omitRemotes && { remotes: data.remotes }), atomicSnapshot: false,
  };
  if (omitRemotes) delete record.summary.counts.remotes;
  const bytes = Buffer.from(JSON.stringify(record));
  await writeFile(contextPath, bytes);
  const indexPath = path.join(value.namespace, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const entry = index.contexts.find((entry) => entry.contextId === contextId);
  entry.bytes = bytes.length;
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(indexPath, JSON.stringify(index));
  return { record, bytes, contextPath };
}
async function withFilesystemHook(name, hook, action) {
  const original = fs[name];
  fs[name] = (...args) => hook(original, ...args);
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs[name] = original; syncBuiltinESMExports(); }
}
async function linkOrSkip(t, target, destination, type = "junction") {
  try { await symlink(target, destination, type); return true; }
  catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    t.skip("The environment does not allow this symlink type");
    return false;
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const isCode = (code) => (error) => error.code === `GAME_CONTEXT_${code}`;
async function orphanWriter(t, value) {
  const deadPid = 0x7fffffff;
  const originalKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === deadPid) throw Object.assign(new Error("Synthetic absent owner"), { code: "ESRCH" });
    return originalKill(pid, signal);
  });
  const target = path.join(value.namespace, ".writer.lock");
  const bytes = Buffer.from(JSON.stringify({ schema: 1, owner: path.basename(value.namespace), pid: deadPid, nonce: "a".repeat(32) }));
  await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  return { target, bytes };
}

test("validates view-specific selectors instead of silently ignoring capture or image arguments", () => {
  const id = `gc-${"1".repeat(32)}`;
  for (const input of [
    { view: "read" }, { view: "image", contextId: id }, { view: "release", contextId: id, limit: 1 },
    { view: "list", root: "workspace" }, { view: "capture", contextId: id }, { view: "capture", maxParts: 513 },
    { view: "read", contextId: id, limit: 101 }, { view: "read", contextId: id, offset: -1 },
    { view: "capture", screenshot: "true" }, { view: "image", contextId: "../outside", kind: "map" },
    { view: "capture", remoteLimit: -1 }, { view: "capture", remoteLimit: 101 }, { view: "capture", remoteLimit: 0.5 },
    { view: "read", contextId: id, remoteLimit: 1 },
  ]) assert.equal(gameContextInputSchema.safeParse(input).success, false, JSON.stringify(input));
  assert.equal(gameContextInputSchema.safeParse({ view: "read", contextId: id, section: "parts", offset: 0, limit: 100 }).success, true);
  for (const remoteLimit of [0, 100]) assert.equal(gameContextInputSchema.safeParse({ remoteLimit }).success, true);
  assert.equal(gameContextInputSchema.safeParse({ view: "read", contextId: id, section: "remotes" }).success, true);
});

test("read-only absent-store list and release do not create directories or modify the config", async (t) => {
  const value = await fixture(t);
  const before = await stat(value.configFile);
  assert.deepEqual((await value.service.list()).contexts, []);
  assert.deepEqual(await value.service.release({ contextId: `gc-${"0".repeat(32)}` }), { view: "release", contextId: `gc-${"0".repeat(32)}`, released: false });
  await assert.rejects(() => stat(path.join(value.root, "game-contexts")), { code: "ENOENT" });
  assert.deepEqual(await readdir(value.root), ["config.json"]);
  assert.equal((await stat(value.configFile)).mtimeMs, before.mtimeMs);
});

test("no explicit config identity means unavailable, never a working-directory storage fallback", async () => {
  const service = createGameContextService({ images: unavailableImages });
  await assert.rejects(() => service.list(), isCode("UNAVAILABLE"));
  await assert.rejects(() => service.capture({}, captureOptions()), isCode("UNAVAILABLE"));
  service.close();
});

test("shares immutable data across services, session closure, and service restart without executor callbacks", async (t) => {
  const value = await fixture(t, { images: successfulImages });
  const collected = scene();
  const captured = await value.service.capture({}, captureOptions({ collect: async () => collected }));
  assert.equal(gameContextOutputSchema.safeParse(captured).success, true);
  collected.parts[0].name = "Changed after capture";
  collected.remotes.entries[0].name = "Changed after capture";
  captured.place.name = "Changed caller result";
  value.service.close();
  const offlineImages = { render() { throw new Error("Offline operations must not invoke the image provider"); } };
  const restarted = createGameContextService({ configFile: value.configFile, images: offlineImages });
  t.after(() => restarted.close());
  const listed = await restarted.list();
  assert.deepEqual(listed.contexts.map((item) => item.contextId), [captured.contextId]);
  assert.equal(listed.contexts[0].counts.remotes, 3);
  const firstRead = await restarted.read({ contextId: captured.contextId, section: "parts" });
  assert.equal(firstRead.entries[0].name, "Floor");
  firstRead.entries[0].name = "Changed reader result";
  assert.equal((await restarted.read({ contextId: captured.contextId, section: "parts" })).entries[0].name, "Floor");
  const metadata = await restarted.read({ contextId: captured.contextId });
  assert.equal(metadata.place.name, "Fixture place");
  assert.deepEqual(metadata.player.position, { x: 3, y: 5, z: 9 });
  assert.equal(metadata.static, true);
  const image = await restarted.image({ contextId: captured.contextId, kind: "map" });
  assert.deepEqual(image.image.data, JPEG_FIXTURE);
  assert.equal(Buffer.isBuffer(image.image.data), true);
  assert.equal(JSON.stringify(image.metadata).includes('"data"'), false);
  assert.equal(image.metadata.images.map.provider, "synthetic-map-fixture");
  const ui = await restarted.read({ contextId: captured.contextId, section: "ui" });
  assert.equal(ui.entries[0].text, "[REDACTED]");
  const remotes = await restarted.read({ contextId: captured.contextId, section: "remotes" });
  assert.deepEqual(remotes.entries, scene().remotes.entries);
  assert.equal(remotes.root, scene().remotes.root);
  assert.equal(remotes.sectionCoverage, "complete");
  assert.equal(remotes.sectionTruncated, false);
  assert.equal(gameContextOutputSchema.safeParse(remotes).success, true);
  remotes.entries[0].name = "Changed reader result";
  const otherReader = createGameContextService({ configFile: value.configFile, images: offlineImages });
  t.after(() => otherReader.close());
  assert.deepEqual((await otherReader.read({ contextId: captured.contextId, section: "remotes" })).entries, scene().remotes.entries);
  assert.equal(gameContextOutputSchema.safeParse({ ...remotes, entries: [{ ...scene().remotes.entries[0], text: "not remote identity" }] }).success, false);
  assert.equal(gameContextOutputSchema.safeParse({ ...remotes, entries: [{ ...scene().remotes.entries[0], className: "BindableEvent" }] }).success, false);
});

test("isolates both different config roots and different config identities in one root", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const captured = await first.service.capture({ screenshot: false, map: false }, captureOptions());
  const siblingConfig = path.join(first.root, "other-config.json");
  await writeFile(siblingConfig, "{}", { mode: 0o600 });
  const sibling = createGameContextService({ configFile: siblingConfig, images: unavailableImages });
  t.after(() => sibling.close());
  for (const service of [second.service, sibling]) {
    assert.deepEqual((await service.list()).contexts, []);
    await assert.rejects(() => service.read({ contextId: captured.contextId }), isCode("NOT_FOUND"));
    assert.equal((await service.release({ contextId: captured.contextId })).released, false);
  }
  assert.equal((await first.service.read({ contextId: captured.contextId })).contextId, captured.contextId);
});

test("bounds part pages by bytes without skipping rows and preserves UI coverage independently", async (t) => {
  const value = await fixture(t);
  const template = scene().parts[0];
  const parts = Array.from({ length: 20 }, (_, index) => ({ ...template, name: `Part ${index}`, path: `Workspace.${String(index).padStart(3, "0")}.${"x".repeat(900)}` }));
  const captured = await value.service.capture({ screenshot: false, map: false }, captureOptions({ collect: async () => scene({ parts, ui: { coverage: "partial", truncated: true, entries: [] } }) }));
  const found = [];
  let offset = 0;
  do {
    const page = await value.service.read({ contextId: captured.contextId, section: "parts", offset, limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 6144);
    found.push(...page.entries.map((entry) => entry.path));
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset < parts.length);
  assert.deepEqual(found, parts.map((entry) => entry.path));
  const ui = await value.service.read({ contextId: captured.contextId, section: "ui" });
  assert.equal(ui.sectionCoverage, "partial");
  assert.equal(ui.sectionTruncated, true);
  const beyond = await value.service.read({ contextId: captured.contextId, section: "parts", offset: 100 });
  assert.deepEqual(beyond.entries, []);
  assert.equal(beyond.nextOffset, undefined);
});

test("remote capture limits are enforced and excluded metadata stays explicitly partial", async (t) => {
  const value = await fixture(t);
  const remotes = scene().remotes;
  const collect = async ({ remoteLimit }) => scene({
    remotes: { ...remotes, entries: Array.from({ length: remoteLimit }, (_, index) => ({ ...remotes.entries[index % 3], name: `Remote ${index}` })) },
  });
  const defaults = await value.service.capture({ screenshot: false, map: false }, captureOptions({ collect }));
  assert.equal(defaults.counts.remotes, 50);
  const maximum = await value.service.capture({ remoteLimit: 100, screenshot: false, map: false }, captureOptions({ collect }));
  assert.equal(maximum.counts.remotes, 100);
  await assert.rejects(() => value.service.capture({ remoteLimit: 2 }, captureOptions()), isCode("INVALID_DATA"));
  await assert.rejects(() => value.service.capture({ remoteLimit: 0 }, captureOptions({ collect: async () => scene({ remotes: { ...remotes, entries: [] } }) })), isCode("INVALID_DATA"));
  const excluded = await value.service.capture({ remoteLimit: 0, screenshot: false, map: false }, captureOptions({ collect: async () => scene({
    remotes: { ...remotes, coverage: "partial", truncated: true, entries: [] }, stopReasons: ["remotes-excluded"],
  }) }));
  assert.equal(excluded.counts.remotes, 0);
  assert.equal(excluded.partial, true);
  assert.deepEqual(excluded.stopReasons, ["remotes-excluded"]);
  const page = await value.service.read({ contextId: excluded.contextId, section: "remotes" });
  assert.equal(page.sectionCoverage, "partial");
  assert.equal(page.sectionTruncated, true);
  assert.deepEqual(page.entries, []);
});

test("remote pages preserve every bounded metadata row and independent facet coverage", async (t) => {
  const value = await fixture(t);
  const entries = Array.from({ length: 25 }, (_, index) => ({ ...scene().remotes.entries[0], path: `game.ReplicatedStorage.R${index}.${"x".repeat(900)}` }));
  const captured = await value.service.capture({ screenshot: false, map: false }, captureOptions({ collect: async () => scene({
    remotes: { root: "game.ReplicatedStorage", coverage: "partial", truncated: true, entries }, stopReasons: ["remote-limit"],
  }) }));
  const found = [];
  let offset = 0;
  do {
    const page = await value.service.read({ contextId: captured.contextId, section: "remotes", offset, limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 6144);
    assert.equal(page.total, entries.length);
    assert.equal(page.sectionCoverage, "partial");
    assert.equal(page.sectionTruncated, true);
    found.push(...page.entries);
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset < entries.length);
  assert.deepEqual(found, entries);
  assert.equal(captured.coverage, "partial");
  assert.equal((await value.service.read({ contextId: captured.contextId, section: "parts" })).sectionCoverage, "complete");
  assert.equal(captured.partial, true);
});

test("retained legacy scenes expose missing remotes as unavailable, never a known empty inventory", async (t) => {
  const value = await fixture(t);
  const captured = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  value.service.close();
  const { record, bytes, contextPath } = await retainLegacyRecord(value, captured.contextId, { omitRemotes: true });
  const reader = createGameContextService({ configFile: value.configFile });
  t.after(() => reader.close());
  assert.equal(Object.hasOwn((await reader.list()).contexts[0].counts, "remotes"), false);
  assert.equal(Object.hasOwn((await reader.read({ contextId: captured.contextId })).counts, "remotes"), false);
  assert.deepEqual((await reader.read({ contextId: captured.contextId, section: "parts" })).entries, record.scene.parts);
  const source = await reader.source(captured.contextId);
  assert.equal(source.scene.schema, 1);
  assert.equal(Object.hasOwn(source.scene, "sourceSnapshotId"), false);
  assert.equal(Object.hasOwn(source.scene, "remotes"), false);
  assert.equal(source.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(await readFile(contextPath), bytes);
  await assert.rejects(() => reader.read({ contextId: captured.contextId, section: "remotes" }), (error) => isCode("SECTION_UNAVAILABLE")(error) && error.reason === "not-captured");
  assert.equal((await reader.release({ contextId: captured.contextId })).released, true);
  await assert.rejects(() => readFile(contextPath), { code: "ENOENT" });
});

test("image unavailability does not turn successfully collected scene coverage into a false traversal failure", async (t) => {
  const value = await fixture(t);
  const captured = await value.service.capture({}, captureOptions());
  assert.equal(captured.coverage, "complete");
  assert.equal(captured.partial, true);
  assert.equal(captured.images.screenshot.status, "unavailable");
  assert.deepEqual(captured.stopReasons, []);
  assert.equal((await value.service.read({ contextId: captured.contextId, section: "parts" })).entries[0].name, "Floor");
  await assert.rejects(() => value.service.image({ contextId: captured.contextId, kind: "screenshot" }), (error) => isCode("IMAGE_UNAVAILABLE")(error) && error.reason === "fixture-no-window");
});

test("multiple clients suppress screenshot but still render the map once from the immutable DTO", async (t) => {
  let calls = 0;
  const value = await fixture(t, { images: { async render(input) {
    calls += 1;
    assert.equal(input.screenshot, false);
    assert.equal(input.map, true);
    assert.throws(() => { input.scene.parts[0].name = "provider mutation"; }, TypeError);
    return { screenshot: fakeFacet("screenshot"), map: fakeFacet("map") };
  } } });
  const captured = await value.service.capture({}, captureOptions({ clientCount: 2 }));
  assert.equal(calls, 1);
  assert.equal(captured.images.screenshot.status, "unavailable");
  assert.equal(captured.images.screenshot.reason, "requires-exactly-one-authenticated-client");
  assert.equal(captured.images.map.status, "available");
  assert.deepEqual((await value.service.image({ contextId: captured.contextId, kind: "map" })).image.data, JPEG_FIXTURE);
});

test("invalid or overflowing provider bytes cannot be published as images; metadata remains useful", async (t) => {
  const value = await fixture(t, { images: { async render() {
    return { screenshot: { ...fakeFacet("screenshot"), data: Buffer.alloc(65537, 0xff) }, map: { ...fakeFacet("map"), data: Buffer.from("not jpeg") } };
  } } });
  const captured = await value.service.capture({}, captureOptions({ imageBudget: 65536 }));
  assert.equal(captured.images.screenshot.status, "unavailable");
  assert.equal(captured.images.map.status, "unavailable");
  assert.deepEqual(await readdir(path.join(value.namespace, captured.contextId)), ["context.json"]);
  assert.equal((await value.service.read({ contextId: captured.contextId })).counts.parts, 1);
});

test("rejects oversized or native-reference-bearing DTOs before publishing a context", async (t) => {
  const value = await fixture(t);
  const tooLarge = Array.from({ length: 40 }, (_, index) => ({ ...scene().parts[0], path: `Workspace.${index}.${"x".repeat(980)}` }));
  await assert.rejects(() => value.service.capture({ screenshot: false, map: false }, captureOptions({ collect: async () => scene({ parts: tooLarge }) })), isCode("INVALID_DATA"));
  await assert.rejects(() => value.service.capture({}, captureOptions({ collect: async () => ({ ...scene(), instanceRef: "ref-native" }) })), isCode("INVALID_DATA"));
  await assert.rejects(() => value.service.capture({}, captureOptions({ collect: async () => scene({ player: { present: true, position: { x: Infinity, y: 0, z: 0 } } }) })), isCode("INVALID_DATA"));
  for (const remotes of [
    undefined,
    { ...scene().remotes, coverage: "complete", truncated: true },
    { ...scene().remotes, entries: [{ ...scene().remotes.entries[0], className: "BindableEvent" }] },
    { ...scene().remotes, entries: [{ ...scene().remotes.entries[0], instanceRef: "ref-native" }] },
    { ...scene().remotes, entries: [{ ...scene().remotes.entries[0], arguments: ["secret"] }] },
  ]) await assert.rejects(() => value.service.capture({}, captureOptions({ collect: async () => scene({ remotes }) })), isCode("INVALID_DATA"));
  assert.deepEqual((await value.service.list()).contexts, []);
});

test("evicts the oldest context at eight, leaves newer snapshots intact, and releases persistently", async (t) => {
  const value = await fixture(t);
  const ids = [];
  for (let index = 0; index < 9; index += 1) {
    value.clock.value += 1;
    ids.push((await value.service.capture({ screenshot: false, map: false }, captureOptions())).contextId);
  }
  await assert.rejects(() => value.service.read({ contextId: ids[0] }), isCode("NOT_FOUND"));
  assert.deepEqual((await value.service.list()).contexts.map((entry) => entry.contextId), ids.slice(1).reverse());
  assert.deepEqual((await readdir(value.namespace)).filter((name) => name.startsWith("gc-")).sort(), ids.slice(1).sort());
  const removed = await value.service.release({ contextId: ids[1] });
  assert.equal(removed.released, true);
  assert.equal((await value.service.release({ contextId: ids[1] })).released, false);
  await assert.rejects(() => stat(path.join(value.namespace, ids[1])), { code: "ENOENT" });
  const restarted = createGameContextService({ configFile: value.configFile });
  t.after(() => restarted.close());
  assert.equal((await restarted.list()).contexts.some((entry) => entry.contextId === ids[1]), false);
});

test("ninth capture evicts original-order legacy bytes without rewriting surviving archives", async (t) => {
  const value = await fixture(t);
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    value.clock.value += 1;
    ids.push((await value.service.capture({ screenshot: false, map: false }, captureOptions())).contextId);
  }
  const oldest = await retainLegacyRecord(value, ids[0]);
  const survivor = await retainLegacyRecord(value, ids[1]);
  const source = await value.service.source(ids[0]);
  assert.deepEqual((await value.service.read({ contextId: ids[0], section: "parts" })).entries, oldest.record.scene.parts);
  assert.equal(source.sha256, createHash("sha256").update(oldest.bytes).digest("hex"));
  assert.deepEqual(await readFile(oldest.contextPath), oldest.bytes);
  value.clock.value += 1;
  const newest = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  assert.deepEqual((await value.service.list()).contexts.map((entry) => entry.contextId), [...ids.slice(1), newest.contextId].reverse());
  await assert.rejects(() => stat(path.dirname(oldest.contextPath)), { code: "ENOENT" });
  await assert.rejects(() => value.service.source(ids[0]), isCode("NOT_FOUND"));
  assert.deepEqual(await readFile(survivor.contextPath), survivor.bytes);
  assert.equal((await value.service.release({ contextId: ids[1] })).released, true);
  await assert.rejects(() => stat(path.dirname(survivor.contextPath)), { code: "ENOENT" });
});

test("publication failure rolls back the new snapshot without evicting any existing data", async (t) => {
  const value = await fixture(t);
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    value.clock.value += 1;
    ids.push((await value.service.capture({ screenshot: false, map: false }, captureOptions())).contextId);
  }
  const previous = await readFile(path.join(value.namespace, "index.json"));
  await withFilesystemHook("rename", async (original, source, destination) => {
    if (path.basename(destination) === "index.json") throw Object.assign(new Error("Synthetic disk failure"), { code: "EIO" });
    return original(source, destination);
  }, async () => {
    await assert.rejects(() => value.service.capture({ screenshot: false, map: false }, captureOptions()), isCode("STORAGE"));
  });
  assert.deepEqual(await readFile(path.join(value.namespace, "index.json")), previous);
  assert.equal((await value.service.read({ contextId: ids[0] })).contextId, ids[0]);
  assert.deepEqual((await readdir(value.namespace)).sort(), ["index.json", ...ids].sort());
});

test("opened-file write failure removes its owned stage but preserves the prior index", async (t) => {
  const value = await fixture(t);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  await withFilesystemHook("open", async (original, target, ...args) => {
    const file = await original(target, ...args);
    if (path.basename(target) === "context.json" && args[0] === "wx") file.writeFile = async () => { throw Object.assign(new Error("Synthetic write failure"), { code: "ENOSPC" }); };
    return file;
  }, async () => {
    await assert.rejects(() => value.service.capture({ screenshot: false, map: false }, captureOptions()), isCode("STORAGE"));
  });
  assert.deepEqual((await value.service.list()).contexts.map((entry) => entry.contextId), [saved.contextId]);
  assert.deepEqual((await readdir(value.namespace)).sort(), ["index.json", saved.contextId].sort());
});

test("rejects linked context roots without writing or deleting outside the config namespace", async (t) => {
  const value = await fixture(t);
  const outside = path.join(value.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "unrelated");
  if (!await linkOrSkip(t, outside, path.join(value.root, "game-contexts"))) return;
  await assert.rejects(() => value.service.list(), isCode("STORAGE"));
  await assert.rejects(() => value.service.capture({}, captureOptions()), isCode("STORAGE"));
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "unrelated");
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
});

test("rejects a substituted snapshot directory for read, image, and release", async (t) => {
  const value = await fixture(t, { images: successfulImages });
  const saved = await value.service.capture({}, captureOptions());
  const directory = path.join(value.namespace, saved.contextId);
  const held = path.join(value.root, "held-context");
  await rename(directory, held);
  if (!await linkOrSkip(t, held, directory)) { await rename(held, directory); return; }
  for (const action of [() => value.service.read({ contextId: saved.contextId }), () => value.service.image({ contextId: saved.contextId, kind: "map" }), () => value.service.release({ contextId: saved.contextId })]) await assert.rejects(action, isCode("STORAGE"));
  assert.deepEqual((await readdir(held)).sort(), ["context.json", "map.jpg", "screenshot.jpg"]);
});

test("opened-file parent substitution cannot write context bytes through a junction", async (t) => {
  const value = await fixture(t);
  const outside = path.join(value.root, "outside");
  await mkdir(outside);
  const probe = path.join(value.root, "probe");
  if (!await linkOrSkip(t, outside, probe)) return;
  await rm(probe);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  let held;
  await withFilesystemHook("open", async (original, target, ...args) => {
    if (!held && path.basename(target) === "context.json" && args[0] === "wx") {
      const stage = path.dirname(target);
      const heldPath = path.join(value.root, "held-stage");
      renameSync(stage, heldPath);
      held = heldPath;
      symlinkSync(outside, stage, "junction");
    }
    // Swap before the native open: Windows can refuse renaming a directory
    // containing an open file. The production handle now points outside, so
    // its post-open parent checks must reject it before writing any bytes.
    return original(target, ...args);
  }, async () => { await assert.rejects(() => value.service.capture({ screenshot: false, map: false }, captureOptions()), isCode("STORAGE")); });
  assert.deepEqual(await readdir(outside), ["context.json"]);
  assert.equal((await stat(path.join(outside, "context.json"))).size, 0);
  assert.deepEqual(await readdir(held), []);
  assert.equal((await value.service.read({ contextId: saved.contextId })).contextId, saved.contextId);
});

test("release refuses unknown context-directory files rather than recursively deleting them", async (t) => {
  const value = await fixture(t);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  const foreign = path.join(value.namespace, saved.contextId, "unrelated.txt");
  await writeFile(foreign, "preserve me");
  await assert.rejects(() => value.service.release({ contextId: saved.contextId }), isCode("STORAGE"));
  assert.equal(await readFile(foreign, "utf8"), "preserve me");
  assert.equal((await value.service.read({ contextId: saved.contextId })).contextId, saved.contextId);
});

test("stored metadata and image hashes are checked and oversized opened files are rejected", async (t) => {
  const value = await fixture(t, { images: successfulImages });
  const saved = await value.service.capture({}, captureOptions());
  const map = path.join(value.namespace, saved.contextId, "map.jpg");
  await writeFile(map, Buffer.from([0xff, 0xd8, 0x00, 0xd9]));
  await assert.rejects(() => value.service.image({ contextId: saved.contextId, kind: "map" }), isCode("STORAGE"));
  const metadata = path.join(value.namespace, saved.contextId, "context.json");
  const original = await readFile(metadata);
  await writeFile(metadata, Buffer.from(original.toString().replace("Floor", "Other")));
  await assert.rejects(() => value.service.read({ contextId: saved.contextId }), isCode("STORAGE"));
  await writeFile(metadata, original);
  await appendFile(metadata, "x".repeat(2 * 1024 * 1024));
  await assert.rejects(() => value.service.list(), isCode("STORAGE"));
});

test("a changed selected client after collection or image rendering never publishes a context", async (t) => {
  const value = await fixture(t);
  let current = true;
  await assert.rejects(() => value.service.capture({}, captureOptions({ isCurrent: () => current, collect: async () => { current = false; return scene(); } })), isCode("CLIENT_CHANGED"));
  assert.deepEqual((await value.service.list()).contexts, []);
  current = true;
  const images = { async render() { current = false; return { map: fakeFacet("map"), screenshot: fakeFacet("screenshot") }; } };
  const second = createGameContextService({ ...value.settings, images });
  t.after(() => second.close());
  await assert.rejects(() => second.capture({}, captureOptions({ isCurrent: () => current })), isCode("CLIENT_CHANGED"));
  assert.deepEqual((await value.service.list()).contexts, []);
});

test("generation fencing immediately before publication rolls back already staged data", async (t) => {
  const value = await fixture(t);
  let current = true;
  await withFilesystemHook("open", async (original, target, ...args) => {
    const file = await original(target, ...args);
    if (path.basename(target).startsWith(".index-") && args[0] === "wx") current = false;
    return file;
  }, async () => { await assert.rejects(() => value.service.capture({}, captureOptions({ isCurrent: () => current })), isCode("CLIENT_CHANGED")); });
  assert.deepEqual((await value.service.list()).contexts, []);
  assert.deepEqual(await readdir(value.namespace), []);
});

test("capture admission is shared across services and close cancels a hung collector without deleting saved snapshots", { timeout: 30000 }, async (t) => {
  const value = await fixture(t);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  const entered = deferred();
  const pending = deferred();
  const capture = value.service.capture({}, captureOptions({ collect: () => { entered.resolve(); return pending.promise; } }));
  const rejection = assert.rejects(capture, isCode("CANCELLED"));
  await entered.promise;
  const sibling = createGameContextService(value.settings);
  t.after(() => sibling.close());
  await assert.rejects(() => sibling.capture({}, captureOptions()), isCode("BUSY"));
  value.service.close();
  await rejection;
  assert.equal((await sibling.read({ contextId: saved.contextId })).contextId, saved.contextId);
  pending.resolve(scene());
  const next = await sibling.capture({ screenshot: false, map: false }, captureOptions());
  assert.equal((await sibling.list()).contexts.some((entry) => entry.contextId === next.contextId), true);
});

test("request cancellation reaches the owned renderer and does not publish an unavailable-image substitute", { timeout: 30000 }, async (t) => {
  const entered = deferred();
  let rendererSignal;
  const value = await fixture(t, { images: { render({ signal }) { rendererSignal = signal; entered.resolve(); return new Promise(() => {}); } } });
  const controller = new AbortController();
  const pending = value.service.capture({}, captureOptions({ signal: controller.signal }));
  const rejection = assert.rejects(pending, isCode("CANCELLED"));
  await entered.promise;
  controller.abort();
  await rejection;
  assert.equal(rendererSignal.aborted, true);
  assert.deepEqual((await value.service.list()).contexts, []);
});

test("close after publication preserves the accepted contextId and committed offline snapshot", async (t) => {
  const value = await fixture(t);
  const captured = await withFilesystemHook("rename", async (original, source, destination) => {
    const result = await original(source, destination);
    if (path.basename(destination) === "index.json") value.service.close();
    return result;
  }, () => value.service.capture({ screenshot: false, map: false }, captureOptions()));
  const restarted = createGameContextService({ configFile: value.configFile, images: unavailableImages });
  t.after(() => restarted.close());
  assert.deepEqual((await restarted.list()).contexts.map((entry) => entry.contextId), [captured.contextId]);
  assert.equal((await restarted.read({ contextId: captured.contextId, section: "parts" })).entries[0].name, "Floor");
});

test("competing orphan recoverers cannot remove the guarded writer lease", { timeout: 30000 }, async (t) => {
  const value = await fixture(t);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  const orphan = await orphanWriter(t, value);
  const sibling = createGameContextService(value.settings);
  t.after(() => sibling.close());
  const bothReadOldOwner = deferred();
  const enteredRemoval = deferred();
  const blockedRecoverer = deferred();
  const resume = deferred();
  let guardAttempts = 0;
  let paused = false;
  await withFilesystemHook("open", async (original, target, ...args) => {
    if (path.basename(target) === ".writer.lock.recovery" && args[0] === "wx") {
      if (++guardAttempts === 2) bothReadOldOwner.resolve();
      await bothReadOldOwner.promise;
    }
    return original(target, ...args);
  }, () => withFilesystemHook("unlink", async (original, target, ...args) => {
    if (target === orphan.target && !paused) {
      paused = true;
      enteredRemoval.resolve();
      await resume.promise;
    }
    return original(target, ...args);
  }, async () => {
    const observe = (pending) => pending.then((result) => ({ result }), (error) => {
      blockedRecoverer.resolve();
      return { error };
    });
    const pending = [
      observe(value.service.release({ contextId: `gc-${"0".repeat(32)}` })),
      observe(sibling.release({ contextId: `gc-${"f".repeat(32)}` })),
    ];
    let outcomes;
    try {
      await Promise.all([enteredRemoval.promise, blockedRecoverer.promise]);
      assert.deepEqual(await readFile(orphan.target), orphan.bytes);
    } finally {
      resume.resolve();
      outcomes = await Promise.all(pending);
    }
    assert.equal(outcomes.filter((outcome) => outcome.result?.released === false).length, 1);
    assert.equal(outcomes.filter((outcome) => isCode("BUSY")(outcome.error ?? {})).length, 1);
  }));
  await assert.rejects(() => stat(orphan.target), { code: "ENOENT" });
  await assert.rejects(() => stat(path.join(value.namespace, ".writer.lock.recovery")), { code: "ENOENT" });
  assert.equal((await sibling.read({ contextId: saved.contextId })).contextId, saved.contextId);
});

test("recovery rereads the original lease under its guard and preserves a same-inode successor", async (t) => {
  const value = await fixture(t);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  const orphan = await orphanWriter(t, value);
  const before = await stat(orphan.target, { bigint: true });
  const replacement = Buffer.from(JSON.stringify({ schema: 1, owner: path.basename(value.namespace), pid: process.pid, nonce: "b".repeat(32) }));
  await withFilesystemHook("open", async (original, target, ...args) => {
    if (path.basename(target) === ".writer.lock.recovery" && args[0] === "wx") await writeFile(orphan.target, replacement);
    return original(target, ...args);
  }, async () => {
    await assert.rejects(() => value.service.release({ contextId: saved.contextId }), isCode("BUSY"));
  });
  assert.equal((await stat(orphan.target, { bigint: true })).ino, before.ino);
  assert.deepEqual(await readFile(orphan.target), replacement);
  await assert.rejects(() => stat(path.join(value.namespace, ".writer.lock.recovery")), { code: "ENOENT" });
  assert.equal((await value.service.read({ contextId: saved.contextId })).contextId, saved.contextId);
});

test("unlock preserves rewritten owner bytes on the same inode and returns the committed contextId", async (t) => {
  const value = await fixture(t);
  const target = path.join(value.namespace, ".writer.lock");
  let replacement;
  let identity;
  const captured = await withFilesystemHook("rename", async (original, source, destination) => {
    const result = await original(source, destination);
    if (path.basename(destination) === "index.json") {
      identity = (await stat(target, { bigint: true })).ino;
      const owner = JSON.parse(await readFile(target, "utf8"));
      replacement = Buffer.from(JSON.stringify({ ...owner, nonce: "f".repeat(32) }));
      await writeFile(target, replacement);
    }
    return result;
  }, () => value.service.capture({ screenshot: false, map: false }, captureOptions()));
  assert.equal((await stat(target, { bigint: true })).ino, identity);
  assert.deepEqual(await readFile(target), replacement);
  assert.equal((await value.service.read({ contextId: captured.contextId })).contextId, captured.contextId);
  await assert.rejects(() => value.service.release({ contextId: captured.contextId }), isCode("BUSY"));
});

test("recovery never removes a rewritten guard or admits capture through interrupted guard data", async (t) => {
  const value = await fixture(t);
  const saved = await value.service.capture({ screenshot: false, map: false }, captureOptions());
  const orphan = await orphanWriter(t, value);
  const guard = path.join(value.namespace, ".writer.lock.recovery");
  let writerCreates = 0;
  let replacement;
  await withFilesystemHook("open", async (original, target, ...args) => {
    if (target === orphan.target && args[0] === "wx" && ++writerCreates === 2) {
      const owner = JSON.parse(await readFile(guard, "utf8"));
      replacement = Buffer.from(JSON.stringify({ ...owner, nonce: "c".repeat(32) }));
      await writeFile(guard, replacement);
    }
    return original(target, ...args);
  }, async () => {
    await assert.rejects(() => value.service.release({ contextId: saved.contextId }), isCode("STORAGE"));
  });
  assert.deepEqual(await readFile(guard), replacement);
  await assert.rejects(() => value.service.capture({ screenshot: false, map: false }, captureOptions()), isCode("BUSY"));
  await assert.rejects(() => value.service.release({ contextId: saved.contextId }), isCode("BUSY"));
  assert.deepEqual(await readFile(guard), replacement);
  assert.equal((await value.service.read({ contextId: saved.contextId })).contextId, saved.contextId);
});

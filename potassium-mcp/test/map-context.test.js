import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMapContextService } from "../src/map-context.js";
import { createMapRecordingService } from "../src/map-recording.js";
import { createGameContextService } from "../src/game-context.js";
import { linkSchema, mapMechanicsInputSchema, mapMechanicsOutputSchema, mapRecordSchema, routeSchema } from "../src/map-schemas.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const hex = (n) => n.toString(16).padStart(32, "0");
const frame = (x = 0) => [x, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
function source(n = 1, overrides = {}) {
  const scene = { schema: 2, sourceSnapshotId: hex(n), root: "Workspace", place: { placeId: 123 }, player: { present: false }, parts: [{ sourceObjectId: hex(n + 100), name: "Floor", path: "Workspace.Floor", className: "Part", cframe: frame((n - 1) * 30), size: { x: 20, y: 1, z: 20 }, anchored: true, canCollide: true, shape: "Block" }], ui: { coverage: "complete", truncated: false, entries: [] }, remotes: { root: "game.ReplicatedStorage", coverage: "complete", truncated: false, entries: [] }, coverage: "complete", truncated: false, visited: 1, stopReasons: [], atomicSnapshot: false, facetCoverage: Object.fromEntries(["geometry", "ui", "remotes"].map((key) => [key, { visited: key === "geometry" ? 1 : 0, coverage: "complete", truncated: false, stopReasons: [] }])) };
  return { contextId: `gc-${hex(n)}`, capturedAt: "2026-09-09T00:00:00.000Z", client: { clientId: "fixture", generation: 1 }, place: scene.place, root: scene.root, coverage: scene.coverage, truncated: false, sha256: digest(JSON.stringify(scene)), scene, ...overrides };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-map-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "config.json");
  await writeFile(configFile, "{}", { mode: 0o600 });
  const sources = new Map([source(1), source(2), source(3)].map((value) => [value.contextId, value]));
  let sequence = 1000;
  const settings = { configFile, gameContextService: { async source(id) { if (!sources.has(id)) throw new Error("evicted"); return structuredClone(sources.get(id)); } }, randomBytes(size) { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(++sequence, size - 4); return bytes; }, ...options };
  const service = createMapContextService(settings);
  t.after(() => service.close());
  const identity = process.platform === "win32" ? path.resolve(configFile).toLowerCase() : path.resolve(configFile);
  const namespace = path.join(root, "map-contexts", digest(identity));
  return { service, sources, settings, configFile, namespace, root };
}
const code = (name) => (error) => error.code === `MAP_CONTEXT_${name}`;
const liveOptions = (collect) => ({ client: { clientId: "fixture", generation: 1 }, isCurrent: () => true, collect });
function observation(params, offset = 0) {
  return { schema: 1, sourceSnapshotId: params.sourceSnapshotId, durationMs: params.durationMs, intervalMs: params.intervalMs, clock: "observation-relative-seconds", tracks: params.objectIds.map((id) => ({ sourceObjectId: id, path: "Workspace.Floor", className: "Part", size: { x: 20, y: 1, z: 20 }, anchored: false, canCollide: true, samples: [{ t: 0, cframe: frame(offset) }, { t: 0.1, cframe: frame(offset + 1) }, { t: 0.2, cframe: frame(offset + 2) }] })), events: [], coverage: "complete", truncated: false, stopReasons: [] };
}
function probe(params) {
  return { schema: 1, center: params.center, size: params.size, columns: params.columns, rows: params.rows, samples: Array.from({ length: params.rows }, (_, row) => Array.from({ length: params.columns }, (_, column) => ({ row, column, origin: { x: params.center.x + params.size.x * (column / (params.columns - 1) - 0.5), y: params.center.y + params.size.y / 2, z: params.center.z + params.size.z * (row / (params.rows - 1) - 0.5) }, hit: false }))).flat(), coverage: "complete", truncated: false, stopReasons: [] };
}
function recordingEvidence(part, id = 7000, count = 3) {
  const recordingId = hex(id), durationMs = Math.max(1000, (count - 1) * 50), stoppedAt = 10 + durationMs / 1000;
  const frames = Array.from({ length: count }, (_, index) => ({ sequence: index + 1, t: index * 0.05, samples: [{ sourceObjectId: part.sourceObjectId, t: index * 0.05, cframe: frame(index * 0.01), size: part.size }] }));
  const events = [{ sequence: 1, t: 0.05, kind: "marker", label: "start-check", source: "mcp-request" }];
  return {
    recordingId, client: { clientId: "fixture", generation: 1 }, receivedAt: "2026-09-09T00:00:01.000Z",
    metadata: { recordingId, state: "stopped", ready: false, clock: "client-monotonic-seconds", atomicSnapshot: false, acceptedAt: 10, startedAt: 10, firstSampleAt: 10, readyAt: 10, lastSampleAt: 10 + frames.at(-1).t, stoppedAt, now: stoppedAt, expiresAt: stoppedAt + 120, durationMs, intervalMs: 50, elapsedMs: durationMs, remainingMs: 0, frameCount: count, sampleCount: count, eventCount: events.length, markerCount: 1, missedIntervals: 0, retainedDrops: 0, sampleBytes: Buffer.byteLength(JSON.stringify(frames)), eventBytes: Buffer.byteLength(JSON.stringify(events)), coverage: "complete", stopReasons: ["duration-complete"], targets: [{ sourceSnapshotId: part.sourceSnapshotId, sourceObjectId: part.sourceObjectId, path: part.path, className: part.className, size: part.size, anchored: part.anchored, canCollide: part.canCollide }] },
    frames, events,
  };
}
async function replaceMapBytes(f, mapId, bytes) {
  await writeFile(path.join(f.namespace, `${mapId}.json`), bytes);
  const indexPath = path.join(f.namespace, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const entry = index.maps.find((row) => row.mapId === mapId);
  entry.bytes = bytes.length;
  entry.sha256 = digest(bytes);
  await writeFile(indexPath, JSON.stringify(index));
}

test("immutable branches retain source evidence after raw context eviction and inherit chunk size", async (t) => {
  const f = await fixture(t);
  const base = await f.service.build({ contextIds: [source(1).contextId], chunkSize: 32 });
  const before = await f.service.read({ mapId: base.mapId, section: "parts" });
  const left = await f.service.update({ mapId: base.mapId, contextIds: [source(2).contextId] });
  const right = await f.service.update({ mapId: base.mapId, contextIds: [source(3).contextId] });
  assert.notEqual(left.mapId, right.mapId);
  assert.equal(left.parentMapId, base.mapId); assert.equal(right.parentMapId, base.mapId);
  assert.equal(left.revision, 2); assert.equal(right.revision, 2); assert.equal(left.chunkSize, 32);
  f.sources.clear();
  assert.deepEqual(await f.service.read({ mapId: base.mapId, section: "parts" }), before);
  assert.equal((await f.service.read({ mapId: left.mapId, section: "parts" })).total, 2);
  const offline = createMapContextService({ configFile: f.configFile }); t.after(() => offline.close());
  assert.equal((await offline.list()).maps.length, 3);
  await f.service.release({ mapId: base.mapId });
  assert.equal((await offline.read({ mapId: right.mapId })).parentMapId, base.mapId);
});

test("scope mismatch and cancellation publish no revision", async (t) => {
  const f = await fixture(t);
  f.sources.set(source(2).contextId, source(2, { client: { clientId: "fixture", generation: 2 } }));
  await assert.rejects(f.service.build({ contextIds: [source(1).contextId, source(2).contextId] }), code("INVALID_INPUT"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.build({ contextIds: [source(1).contextId] }, { signal: controller.signal }), code("CANCELLED"));
  assert.deepEqual((await f.service.list()).maps, []);
});

test("catalog ownership tampering fails closed and foreign files survive release", async (t) => {
  const f = await fixture(t);
  const built = await f.service.build({ contextIds: [source(1).contextId] });
  const catalogPath = path.join(f.namespace, "index.json");
  const original = await readFile(catalogPath);
  const catalog = JSON.parse(original); catalog.owner = "f".repeat(64);
  await writeFile(catalogPath, JSON.stringify(catalog));
  await assert.rejects(f.service.read({ mapId: built.mapId }), code("STORAGE"));
  await writeFile(catalogPath, original);
  const foreign = path.join(f.namespace, "foreign.txt"); await writeFile(foreign, "preserve");
  await f.service.release({ mapId: built.mapId });
  assert.equal(await readFile(foreign, "utf8"), "preserve");
  assert.deepEqual((await f.service.list()).maps, []);
});

test("observation keeps historical health evidence while fitting only the latest continuous window", async (t) => {
  let now = Date.parse("2026-09-09T00:00:00.000Z");
  const f = await fixture(t, { clock: { now: () => now } });
  const base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const first = await f.service.observe({ mapId: base.mapId, objectIds: [part.id] }, liveOptions(async (method, params) => {
    assert.equal(method, "map_observe"); assert.equal(params.sourceSnapshotId, hex(1)); assert.deepEqual(params.objectIds, [hex(101)]);
    return { ...observation(params), events: [{ t: 0.1, kind: "health-drop", amount: 10, objectIds: params.objectIds, association: "spatial-temporal-correlation" }, { t: 0.2, kind: "death", objectIds: params.objectIds, association: "spatial-temporal-correlation" }] };
  }));
  const originalHazards = (await f.service.read({ mapId: first.mapId, section: "hazards" })).entries;
  now += 10000;
  const second = await f.service.observe({ mapId: first.mapId, objectIds: [part.id] }, liveOptions(async (_, params) => observation(params, 10)));
  const record = JSON.parse(await readFile(path.join(f.namespace, `${second.mapId}.json`), "utf8")).record;
  assert.equal(record.observations.length, 2);
  assert.deepEqual(record.observations[0].data.events.map((event) => event.objectIds), [[hex(101)], [hex(101)]]);
  const track = (await f.service.read({ mapId: second.mapId, section: "tracks" })).entries[0];
  assert.deepEqual(track.samples.map((sample) => sample.cframe[0]), [10, 11, 12]);
  assert.equal(track.observedAt, new Date(now).toISOString());
  const hazard = (await f.service.read({ mapId: second.mapId, section: "hazards" })).entries.find((row) => row.partId === part.id);
  assert.equal(hazard.level, "correlated");
  assert.deepEqual(hazard.kinds, ["health-drop", "death"]);
  assert.deepEqual(hazard.evidence, originalHazards[0].evidence);
  assert.deepEqual((await f.service.read({ mapId: first.mapId, section: "hazards" })).entries, originalHazards);
  assert.equal((await f.service.read({ mapId: first.mapId, section: "tracks" })).entries[0].samples[0].cframe[0], 0);
  await assert.rejects(f.service.observe({ mapId: base.mapId, objectIds: [part.id] }, liveOptions(async (_, params) => ({ ...observation(params), sourceSnapshotId: hex(99) }))), code("INVALID_DATA"));
  assert.equal((await f.service.list()).maps.length, 3);
});

test("mixed native snapshots and legacy rows reject before acquisition", async (t) => {
  const f = await fixture(t);
  const built = await f.service.build({ contextIds: [source(1).contextId, source(2).contextId] });
  const rows = (await f.service.read({ mapId: built.mapId, section: "parts" })).entries;
  let calls = 0; const options = liveOptions(async () => { calls++; throw new Error("must not collect"); });
  await assert.rejects(f.service.observe({ mapId: built.mapId, objectIds: rows.map((part) => part.id) }, options), code("INVALID_INPUT"));
  const legacy = source(3); legacy.scene.schema = 1; delete legacy.scene.sourceSnapshotId; delete legacy.scene.facetCoverage; delete legacy.scene.parts[0].sourceObjectId; delete legacy.scene.parts[0].shape;
  f.sources.set(legacy.contextId, legacy);
  const old = await f.service.build({ contextIds: [legacy.contextId] });
  const part = (await f.service.read({ mapId: old.mapId, section: "parts" })).entries[0];
  await assert.rejects(f.service.observe({ mapId: old.mapId, objectIds: [part.id] }, options), code("SOURCE_UNAVAILABLE"));
  assert.equal(calls, 0);
});

test("client changes or aborts during collection do not persist observations", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  let current = true;
  await assert.rejects(f.service.observe({ mapId: base.mapId, objectIds: [part.id] }, { ...liveOptions(async (_, params) => { current = false; return observation(params); }), isCurrent: () => current }), code("CLIENT_CHANGED"));
  const controller = new AbortController();
  await assert.rejects(f.service.observe({ mapId: base.mapId, objectIds: [part.id] }, { ...liveOptions(async (_, params) => { controller.abort(); return observation(params); }), signal: controller.signal }), code("CANCELLED"));
  assert.equal((await f.service.list()).maps.length, 1);
});

test("offline image keeps bytes in media lane, exposes digest, and cannot erase accepted map", async (t) => {
  let renderArgs;
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const f = await fixture(t, { images: { async render(args) { renderArgs = args; return { map: { status: "available", data, mimeType: "image/jpeg", width: 32, height: 24, provider: "synthetic-fixture", rendering: { coverage: "partial", selectedParts: 1, unrenderedParts: 0, selectedPrimitives: 1, unrenderedPrimitives: 0, omittedLabels: 0, warnings: [] } } }; } } });
  const built = await f.service.build({ contextIds: [source(1).contextId] });
  f.sources.clear();
  const result = await f.service.image({ mapId: built.mapId, minY: -1, maxY: 2 }, { imageBudget: 4096 });
  assert.equal(renderArgs.screenshot, false); assert.equal(renderArgs.mapOverlay.minY, -1);
  assert.equal(result.metadata.image.sha256, digest(data)); assert.deepEqual(result.image.data, data);
  assert.equal(JSON.stringify(result.metadata).includes(data.toString("base64")), false);
  await assert.rejects(f.service.image({ mapId: built.mapId }, { imageBudget: 0 }), code("IMAGE_UNAVAILABLE"));
  assert.equal((await f.service.read({ mapId: built.mapId })).mapId, built.mapId);
});

test("immutable row pagination terminates and route endpoints belong to selected revision", async (t) => {
  const f = await fixture(t), built = await f.service.build({ contextIds: [source(1).contextId, source(2).contextId] });
  const first = await f.service.read({ mapId: built.mapId, section: "parts", limit: 1 });
  const second = await f.service.read({ mapId: built.mapId, section: "parts", offset: first.nextOffset, limit: 1 });
  assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, undefined);
  assert.notEqual(first.entries[0].id, second.entries[0].id);
  assert.deepEqual((await f.service.read({ mapId: built.mapId, section: "parts", offset: 100 })).entries, []);
  const surface = (await f.service.read({ mapId: built.mapId, section: "surfaces" })).entries[0];
  const route = await f.service.route({ mapId: built.mapId, from: surface.id, to: surface.id });
  assert.equal(route.status, "found"); assert.equal(route.duration, 0);
  await assert.rejects(f.service.route({ mapId: built.mapId, from: surface.id, to: "foreign-surface" }), code("INVALID_INPUT"));
});

test("probe revisions retain sampled collision evidence without binding hits by path", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId], chunkSize: 32 });
  const center = { x: 50, y: 0, z: 0 }, size = { x: 10, y: 10, z: 10 };
  const options = liveOptions(async (method, params) => {
    assert.equal(method, "map_probe");
    return { schema: 1, center: params.center, size: params.size, columns: 2, rows: 2, samples: [0, 1].flatMap((row) => [0, 1].map((column) => ({ row, column, origin: { x: 45 + column * 10, y: 5, z: -5 + row * 10 }, hit: true, position: { x: 45 + column * 10, y: 0, z: -5 + row * 10 }, normal: { x: 0, y: 1, z: 0 }, path: "Workspace.Floor", className: "Terrain" }))), coverage: "complete", truncated: false, stopReasons: [] };
  });
  const probed = await f.service.probe({ mapId: base.mapId, center, size, columns: 2, rows: 2 }, options);
  assert.equal(probed.parentMapId, base.mapId); assert.equal(probed.chunkSize, 32);
  const parts = (await f.service.read({ mapId: probed.mapId, section: "parts" })).entries;
  const sampled = parts.find((part) => part.geometry === "sampled");
  assert.ok(sampled); assert.equal(sampled.sourceIdentity, "probe-sample"); assert.equal(sampled.sourceObjectId, undefined);
  assert.equal(sampled.anchored, undefined); assert.equal(sampled.canCollide, undefined);
  assert.equal((await f.service.read({ mapId: base.mapId, section: "parts" })).total, 1);
  f.sources.clear();
  assert.equal((await f.service.read({ mapId: probed.mapId })).counts.parts, 2);
});

test("retention rejects a ninth map without evicting immutable branches and release frees quota", async (t) => {
  const f = await fixture(t), maps = [];
  for (let i = 0; i < 8; i++) maps.push(await f.service.build({ contextIds: [source(1).contextId] }));
  await assert.rejects(f.service.build({ contextIds: [source(1).contextId] }), code("LIMIT"));
  assert.deepEqual((await f.service.list()).maps.map((map) => map.mapId), maps.map((map) => map.mapId));
  await f.service.release({ mapId: maps[0].mapId });
  const accepted = await f.service.build({ contextIds: [source(1).contextId] });
  assert.equal((await f.service.read({ mapId: accepted.mapId })).mapId, accepted.mapId);
  const differentConfig = path.join(f.root, "other-config.json");
  await writeFile(differentConfig, "{}");
  const other = createMapContextService({ configFile: differentConfig }); t.after(() => other.close());
  await assert.rejects(other.read({ mapId: accepted.mapId }), code("NOT_FOUND"));
});

test("a large track page preserves every sample and advances instead of looping", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const observed = await f.service.observe({ mapId: base.mapId, objectIds: [part.id], durationMs: 5000, intervalMs: 50 }, liveOptions(async (_, params) => {
    const data = observation(params);
    data.tracks[0].samples = Array.from({ length: 101 }, (_, index) => ({ t: index / 20, cframe: frame(0.123456789 + index / 3), size: { x: 20.123456789, y: 1.123456789, z: 20.123456789 } }));
    return data;
  }));
  const page = await f.service.read({ mapId: observed.mapId, section: "tracks" });
  assert.equal(page.entries[0].samples.length, 101);
  assert.equal(page.nextOffset, undefined);
  assert.deepEqual((await f.service.read({ mapId: observed.mapId, section: "tracks", offset: 1 })).entries, []);
});

test("cancellation after atomic publication preserves and returns accepted identity", async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const original = fs.rename;
  fs.rename = async (...args) => {
    await original(...args);
    if (path.basename(args[1]) === "index.json" && path.dirname(args[1]) === f.namespace) controller.abort();
  };
  syncBuiltinESMExports();
  let accepted;
  try { accepted = await f.service.build({ contextIds: [source(1).contextId] }, { signal: controller.signal }); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.equal(controller.signal.aborted, true);
  assert.equal((await f.service.read({ mapId: accepted.mapId })).revision, accepted.revision);
  assert.equal((await f.service.list()).maps[0].mapId, accepted.mapId);
});

test("observation and probe batch limits reject before native collection without discarding evidence", async (t) => {
  for (const view of ["observe", "probe"]) {
    const f = await fixture(t);
    let current = await f.service.build({ contextIds: [source(1).contextId] });
    const part = (await f.service.read({ mapId: current.mapId, section: "parts" })).entries[0];
    const args = view === "observe" ? { objectIds: [part.id] } : { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, columns: 2, rows: 2 };
    let calls = 0;
    const options = liveOptions(async (_, params) => { calls++; return view === "observe" ? observation(params) : probe(params); });
    for (let i = 0; i < 8; i++) {
      const parent = current;
      current = await f.service[view]({ ...args, mapId: parent.mapId }, options);
      await f.service.release({ mapId: parent.mapId });
    }
    const before = await readFile(path.join(f.namespace, `${current.mapId}.json`));
    await assert.rejects(f.service[view]({ ...args, mapId: current.mapId }, options), code("LIMIT"));
    assert.equal(calls, 8);
    assert.deepEqual(await readFile(path.join(f.namespace, `${current.mapId}.json`)), before);
    assert.deepEqual((await f.service.list()).maps.map((map) => map.mapId), [current.mapId]);
  }
});

test("map storage rejects malformed UTF-8 even when catalog hashes match", async (t) => {
  const f = await fixture(t), built = await f.service.build({ contextIds: [source(1).contextId] });
  const bytes = await readFile(path.join(f.namespace, `${built.mapId}.json`));
  const marker = Buffer.from("Historical, partial client-visible evidence");
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0);
  bytes[offset] = 0xff;
  await replaceMapBytes(f, built.mapId, bytes);
  await assert.rejects(f.service.read({ mapId: built.mapId }), code("STORAGE"));
  await assert.rejects(f.service.list(), code("STORAGE"));
});

test("probe admission and stored batches must belong to the map client and generation", async (t) => {
  const f = await fixture(t), built = await f.service.build({ contextIds: [source(1).contextId] });
  let calls = 0;
  for (const client of [{ clientId: "foreign", generation: 1 }, { clientId: "fixture", generation: 2 }]) {
    await assert.rejects(f.service.probe({ mapId: built.mapId, center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, columns: 2, rows: 2 }, { ...liveOptions(async (_, params) => { calls++; return probe(params); }), client }), code("CLIENT_CHANGED"));
  }
  assert.equal(calls, 0);
  const probed = await f.service.probe({ mapId: built.mapId, center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, columns: 2, rows: 2 }, liveOptions(async (_, params) => probe(params)));
  const original = JSON.parse(await readFile(path.join(f.namespace, `${probed.mapId}.json`), "utf8"));
  for (const client of [{ clientId: "foreign", generation: 1 }, { clientId: "fixture", generation: 2 }]) {
    const envelope = structuredClone(original);
    envelope.record.probes[0].client = client;
    await replaceMapBytes(f, probed.mapId, Buffer.from(JSON.stringify(envelope)));
    await assert.rejects(f.service.read({ mapId: probed.mapId }), code("STORAGE"));
  }
  assert.equal((await f.service.read({ mapId: built.mapId })).mapId, built.mapId);
});

test("real saved sources keep basic legacy reads separate from enriched map metadata", async (t) => {
  const f = await fixture(t);
  const contexts = createGameContextService({ configFile: f.configFile, images: { async render() { return {}; } } });
  t.after(() => contexts.close());
  const scene = source(1).scene;
  scene.parts[0].canTouch = false;
  scene.parts[0].material = "Concrete";
  const captured = await contexts.capture({ screenshot: false, map: false }, { ...liveOptions(async () => scene), clientCount: 1, imageBudget: 65536 });
  const basicPart = { name: "Floor", path: "Workspace.Floor", className: "Part", cframe: frame(), size: { x: 20, y: 1, z: 20 }, anchored: true, canCollide: true };
  assert.deepEqual((await contexts.read({ contextId: captured.contextId, section: "parts" })).entries, [basicPart]);
  const verified = await contexts.source(captured.contextId);
  assert.equal(verified.scene.parts[0].material, "Concrete");
  const maps = createMapContextService({ configFile: f.configFile, gameContextService: contexts });
  t.after(() => maps.close());
  const enriched = await maps.build({ contextIds: [captured.contextId] });
  const enrichedPart = (await maps.read({ mapId: enriched.mapId, section: "parts" })).entries[0];
  assert.equal(enrichedPart.sourceIdentity, "retained-instance");
  assert.equal(enrichedPart.sourceObjectId, hex(101));
  assert.equal(enrichedPart.material, "Concrete");
  assert.equal(enrichedPart.canTouch, false);

  const namespace = path.join(f.root, "game-contexts", path.basename(f.namespace));
  const contextPath = path.join(namespace, captured.contextId, "context.json");
  const envelope = JSON.parse(await readFile(contextPath, "utf8"));
  envelope.scene = { schema: 1, root: scene.root, place: scene.place, player: scene.player, coverage: scene.coverage, truncated: scene.truncated, visited: scene.visited, stopReasons: scene.stopReasons, parts: [basicPart], ui: scene.ui, remotes: scene.remotes, atomicSnapshot: false };
  const legacyBytes = Buffer.from(JSON.stringify(envelope, null, 2));
  await writeFile(contextPath, legacyBytes);
  const indexPath = path.join(namespace, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.contexts[0].bytes = legacyBytes.length;
  index.contexts[0].sha256 = digest(legacyBytes);
  await writeFile(indexPath, JSON.stringify(index));
  assert.equal((await contexts.source(captured.contextId)).scene.schema, 1);
  assert.deepEqual((await contexts.read({ contextId: captured.contextId, section: "parts" })).entries, [basicPart]);
  const legacy = await maps.build({ contextIds: [captured.contextId] });
  const legacyPart = (await maps.read({ mapId: legacy.mapId, section: "parts" })).entries[0];
  assert.equal(legacyPart.sourceIdentity, "capture-row");
  assert.equal(legacyPart.sourceObjectId, undefined);
  assert.equal(legacyPart.material, undefined);
  assert.equal(legacyPart.canTouch, undefined);
  assert.deepEqual(await readFile(contextPath), legacyBytes);
  await contexts.release({ contextId: captured.contextId });
  assert.deepEqual((await maps.read({ mapId: enriched.mapId, section: "parts" })).entries, [enrichedPart]);
  assert.deepEqual((await maps.read({ mapId: legacy.mapId, section: "parts" })).entries, [legacyPart]);
});

test("mechanics requires complete explicit reports naming exact retained parts", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const other = await f.service.build({ contextIds: [source(2).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const foreign = (await f.service.read({ mapId: other.mapId, section: "parts" })).entries[0];
  const transition = { partId: part.id, fromMode: "floor", toMode: "ceiling", note: "The first pad put me on the ceiling." };
  const valid = { view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [transition] };
  for (const input of [
    { ...valid, supportModes: undefined }, { ...valid, transitions: undefined },
    { ...valid, supportModes: ["floor"] }, { ...valid, supportModes: ["floor", "floor"] },
    { ...valid, transitions: [{ ...transition, toMode: "floor" }] },
    { ...valid, transitions: [transition, transition] },
    { ...valid, transitions: [{ ...transition, reportedAt: "2026-09-09T00:00:00.000Z" }] },
    { ...valid, transitions: [{ ...transition, evidence: { kind: "engine-observation" } }] },
    { ...valid, transitions: [{ ...transition, note: "x".repeat(257) }] },
    { ...valid, clientId: "fixture" }, { ...valid, view: "read" },
  ]) {
    assert.equal(mapMechanicsInputSchema.safeParse(input).success, false);
    await assert.rejects(f.service.mechanics(input), code("INVALID_INPUT"));
  }
  for (const partId of [foreign.id, part.path, part.sourceObjectId]) {
    await assert.rejects(f.service.mechanics({ ...valid, transitions: [{ ...transition, partId }] }), code("INVALID_INPUT"));
  }
  assert.deepEqual((await f.service.list()).maps.map((map) => map.mapId), [base.mapId, other.mapId]);
  assert.deepEqual((await f.service.mechanics({ mapId: base.mapId })).mechanics, { supportModes: ["floor"], transitions: [] });
});

test("offline mechanics branches retain evidence after source eviction and clear by replacement", async (t) => {
  let now = Date.parse("2026-09-10T01:00:00.000Z");
  const f = await fixture(t, { clock: { now: () => now } });
  const base = await f.service.build({ contextIds: [source(1).contextId], chunkSize: 32 });
  const basePath = path.join(f.namespace, `${base.mapId}.json`), baseBytes = await readFile(basePath);
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  f.sources.clear();
  const offline = createMapContextService({ configFile: f.configFile, clock: f.settings.clock, randomBytes: f.settings.randomBytes });
  t.after(() => offline.close());
  const report = { partId: part.id, fromMode: "floor", toMode: "ceiling", note: "I walked on the ceiling until the second pad." };
  const applied = await offline.mechanics({ view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [report] });
  assert.equal(applied.parentMapId, base.mapId); assert.equal(applied.revision, 2);
  assert.equal(mapMechanicsOutputSchema.safeParse(applied).success, true);
  assert.deepEqual(applied.mechanics.transitions[0].evidence, { kind: "user-report", note: report.note, reportedAt: new Date(now).toISOString() });
  const firstReport = structuredClone(applied.mechanics.transitions[0]);
  const appliedBytes = await readFile(path.join(f.namespace, `${applied.mapId}.json`));
  const appliedRecord = JSON.parse(appliedBytes).record, baseRecord = JSON.parse(baseBytes).record;
  assert.equal(appliedRecord.schema, 2); assert.equal(appliedRecord.chunkSize, 32);
  assert.deepEqual(appliedRecord.sources, baseRecord.sources);
  assert.deepEqual(appliedRecord.sourceHashes, baseRecord.sourceHashes);
  const surfaces = (await offline.read({ mapId: applied.mapId, section: "surfaces" })).entries;
  assert.deepEqual(new Set(surfaces.map((surface) => surface.supportMode)), new Set(["floor", "ceiling"]));
  now += 1000;
  const branch = await offline.mechanics({ view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [{ ...report, note: "The same behavior, reported again." }] });
  assert.notEqual(branch.mapId, applied.mapId); assert.equal(branch.revision, 2);
  assert.equal(branch.mechanics.transitions[0].id, firstReport.id);
  assert.equal(branch.mechanics.transitions[0].evidence.reportedAt, new Date(now).toISOString());
  const cleared = await offline.mechanics({ view: "apply", mapId: applied.mapId, supportModes: ["floor"], transitions: [] });
  assert.equal(cleared.parentMapId, applied.mapId); assert.equal(cleared.revision, 3);
  assert.deepEqual(cleared.mechanics, { supportModes: ["floor"], transitions: [] });
  assert.equal((await offline.read({ mapId: cleared.mapId, section: "surfaces" })).entries.every((surface) => surface.supportMode === "floor"), true);
  assert.deepEqual((await offline.mechanics({ mapId: applied.mapId })).mechanics.transitions, [firstReport]);
  assert.deepEqual(await readFile(basePath), baseBytes);
  assert.deepEqual(await readFile(path.join(f.namespace, `${applied.mapId}.json`)), appliedBytes);
});

test("updates observations and probes inherit complete mechanics without restamping reports", async (t) => {
  let now = Date.parse("2026-09-10T01:00:00.000Z");
  const f = await fixture(t, { clock: { now: () => now } }), base = await f.service.build({ contextIds: [source(1).contextId], chunkSize: 32 });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const applied = await f.service.mechanics({ view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [{ partId: part.id, fromMode: "floor", toMode: "ceiling", note: "Reported ceiling support." }] });
  const expected = structuredClone(applied.mechanics);
  now += 10000;
  f.sources.delete(source(1).contextId);
  const updated = await f.service.update({ mapId: applied.mapId, contextIds: [source(2).contextId] });
  f.sources.clear();
  now += 10000;
  const observed = await f.service.observe({ mapId: updated.mapId, objectIds: [part.id] }, liveOptions(async (_, params) => observation(params)));
  now += 10000;
  const probed = await f.service.probe({ mapId: observed.mapId, center: { x: 50, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, columns: 2, rows: 2 }, liveOptions(async (_, params) => probe(params)));
  for (const revision of [updated, observed, probed]) {
    assert.deepEqual((await f.service.mechanics({ mapId: revision.mapId })).mechanics, expected);
    assert.equal(revision.chunkSize, 32);
  }
  const reapplied = await f.service.mechanics({ view: "apply", mapId: probed.mapId, supportModes: ["floor", "ceiling"], transitions: [] });
  const before = JSON.parse(await readFile(path.join(f.namespace, `${probed.mapId}.json`), "utf8")).record;
  const after = JSON.parse(await readFile(path.join(f.namespace, `${reapplied.mapId}.json`), "utf8")).record;
  assert.deepEqual(after.observations, before.observations); assert.deepEqual(after.probes, before.probes);
  assert.deepEqual(after.model.profile, before.model.profile); assert.equal(after.model.profileSource, before.model.profileSource);
});

test("legacy map reads and release retain original bytes while apply upgrades a new branch", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const envelope = JSON.parse(await readFile(path.join(f.namespace, `${base.mapId}.json`), "utf8"));
  envelope.record.schema = 1;
  delete envelope.record.model.mechanics;
  for (const surface of envelope.record.model.surfaces) delete surface.supportMode;
  for (const link of envelope.record.model.links) { delete link.fromMode; delete link.toMode; }
  const legacyBytes = Buffer.from(JSON.stringify(envelope, null, 2));
  await replaceMapBytes(f, base.mapId, legacyBytes);
  const indexBytes = await readFile(path.join(f.namespace, "index.json"));
  f.sources.clear();
  const before = await f.service.read({ mapId: base.mapId, section: "surfaces" });
  assert.equal(before.entries[0].supportMode, undefined);
  const route = await f.service.route({ mapId: base.mapId, from: before.entries[0].id, to: before.entries[0].id });
  assert.equal(route.timing, "modeled"); assert.equal(route.duration, 0);
  assert.deepEqual((await f.service.mechanics({ mapId: base.mapId })).mechanics, { supportModes: ["floor"], transitions: [] });
  assert.deepEqual(await readFile(path.join(f.namespace, "index.json")), indexBytes);
  const upgraded = await f.service.mechanics({ view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [] });
  const record = JSON.parse(await readFile(path.join(f.namespace, `${upgraded.mapId}.json`), "utf8")).record;
  assert.equal(record.schema, 2);
  assert.deepEqual(record.sourceHashes, envelope.record.sourceHashes);
  assert.deepEqual(await readFile(path.join(f.namespace, `${base.mapId}.json`)), legacyBytes);
  f.sources.set(source(2).contextId, source(2));
  const updated = await f.service.update({ mapId: base.mapId, contextIds: [source(2).contextId] });
  assert.equal(updated.parentMapId, base.mapId);
  assert.deepEqual((await f.service.mechanics({ mapId: updated.mapId })).mechanics, { supportModes: ["floor"], transitions: [] });
  assert.equal((await f.service.read({ mapId: updated.mapId, section: "surfaces" })).entries.every((surface) => surface.supportMode === "floor"), true);
  assert.deepEqual(await f.service.read({ mapId: base.mapId, section: "surfaces" }), before);
  assert.equal((await f.service.release({ mapId: base.mapId })).released, true);
  await assert.rejects(readFile(path.join(f.namespace, `${base.mapId}.json`)), { code: "ENOENT" });
  assert.equal((await f.service.mechanics({ mapId: upgraded.mapId })).parentMapId, base.mapId);
});

test("mechanics validates retained record identity and report timestamps before publishing", async (t) => {
  const f = await fixture(t, { clock: { now: () => Date.parse("2026-09-10T01:00:00.000Z") } });
  const base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const input = { view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [{ partId: part.id, fromMode: "floor", toMode: "ceiling", note: "User report." }] };
  const invalidClock = createMapContextService({ configFile: f.configFile, clock: { now: () => NaN } });
  t.after(() => invalidClock.close());
  await assert.rejects(invalidClock.mechanics(input), code("INVALID_DATA"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.mechanics(input, { signal: controller.signal }), code("CANCELLED"));
  assert.equal((await f.service.list()).maps.length, 1);
  const applied = await f.service.mechanics(input);
  const original = JSON.parse(await readFile(path.join(f.namespace, `${applied.mapId}.json`), "utf8"));
  for (const mutate of [
    (record) => { record.model.mechanics.transitions[0].partId = "unretained-part"; },
    (record) => { record.model.mechanics.transitions[0].evidence.reportedAt = "2026-09-11T00:00:00.000Z"; },
    (record) => { record.model.mechanics.transitions[0].evidence.kind = "engine-observation"; },
    (record) => { record.sources[0].client.generation = 2; },
    (record) => { delete record.model.surfaces[0].supportMode; },
    (record) => { delete record.model.mechanics; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed.record);
    assert.equal(mapRecordSchema.safeParse(changed.record).success, false);
    await replaceMapBytes(f, applied.mapId, Buffer.from(JSON.stringify(changed)));
    await assert.rejects(f.service.mechanics({ mapId: applied.mapId }), code("STORAGE"));
    await assert.rejects(f.service.mechanics({ ...input, mapId: applied.mapId }), code("STORAGE"));
  }
  await replaceMapBytes(f, applied.mapId, Buffer.from(JSON.stringify(original)));
  assert.equal((await f.service.list()).maps.length, 2);
});

test("mode switches expose unknown route timing and reject fabricated schedules", async (t) => {
  const f = await fixture(t), captured = source(1);
  captured.scene.parts[0].collidesWithCharacter = true;
  const roof = structuredClone(captured.scene.parts[0]);
  roof.sourceObjectId = hex(102); roof.name = "Roof"; roof.path = "Workspace.Roof"; roof.cframe[1] = 20;
  captured.scene.parts.push(roof);
  captured.sha256 = digest(JSON.stringify(captured.scene));
  f.sources.set(captured.contextId, captured);
  const base = await f.service.build({ contextIds: [captured.contextId] });
  const parts = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries;
  const floorPart = parts.find((part) => part.name === "Floor"), roofPart = parts.find((part) => part.name === "Roof");
  const applied = await f.service.mechanics({ view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [{ partId: floorPart.id, fromMode: "floor", toMode: "ceiling", note: "The floor pad made me walk on the ceiling." }] });
  const surfaces = (await f.service.read({ mapId: applied.mapId, section: "surfaces" })).entries;
  const from = surfaces.find((surface) => surface.partId === floorPart.id && surface.supportMode === "floor").id;
  const to = surfaces.find((surface) => surface.partId === roofPart.id && surface.supportMode === "ceiling").id;
  assert.notEqual((await f.service.route({ mapId: applied.mapId, from, to })).status, "found");
  const itinerary = await f.service.route({ mapId: applied.mapId, from, to, allowUncertain: true });
  assert.equal(itinerary.status, "found"); assert.equal(itinerary.timing, "unknown");
  assert.equal(itinerary.duration, null); assert.equal(itinerary.arrival, null);
  const step = itinerary.steps.find((edge) => edge.action === "mode-switch");
  assert.equal(step.transitionId, applied.mechanics.transitions[0].id);
  assert.equal(step.duration, null); assert.equal(step.status, "candidate"); assert.equal(step.windows, undefined);
  assert.equal(linkSchema.safeParse({ ...step, duration: 0 }).success, false);
  assert.equal(linkSchema.safeParse({ ...step, action: "jump", transitionId: undefined, toMode: "floor" }).success, false);
  const route = { status: itinerary.status, steps: itinerary.steps, timing: itinerary.timing, duration: itinerary.duration, arrival: itinerary.arrival, reasons: itinerary.reasons };
  assert.equal(routeSchema.safeParse(route).success, true);
  assert.equal(routeSchema.safeParse({ ...route, timing: "modeled", duration: 0, arrival: 0 }).success, false);
  assert.equal(routeSchema.safeParse({ ...route, duration: 0 }).success, false);
  assert.equal(routeSchema.safeParse({ ...route, arrival: 1 }).success, false);
  const stored = JSON.parse(await readFile(path.join(f.namespace, `${applied.mapId}.json`), "utf8")).record;
  const crossed = structuredClone(stored);
  crossed.model.links.find((edge) => edge.action === "mode-switch").transitionId = "unreported-transition";
  assert.equal(mapRecordSchema.safeParse(crossed).success, false);
  const ordinary = { ...step, id: "ordinary", action: "walk", transitionId: undefined, toMode: "floor", duration: 1 };
  assert.equal(mapRecordSchema.safeParse({ ...stored, model: { ...stored.model, links: [ordinary] } }).success, false);
});

test("retained queries normalize IDs and bind continuation to map, selectors, and projection", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId, source(2).contextId, source(3).contextId] });
  const all = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries;
  const ids = all.map((row) => row.id);
  const first = await f.service.read({ mapId: base.mapId, section: "parts", query: { ids: [...ids].reverse() }, limit: 1 });
  assert.deepEqual(first.entries, all.slice(0, 1));
  assert.equal(first.totalMatched, all.length);
  assert.equal(first.totalAvailable, all.length);
  const rest = await f.service.read({ mapId: base.mapId, section: "parts", query: { ids: [...ids, ids[0]] }, cursor: first.nextCursor });
  assert.deepEqual([...first.entries, ...rest.entries], all);
  assert.equal(rest.nextCursor, undefined);
  await assert.rejects(f.service.read({ mapId: base.mapId, section: "parts", query: { ids: ids.slice(0, 1) }, cursor: first.nextCursor }), code("INVALID_INPUT"));
  await assert.rejects(f.service.read({ mapId: base.mapId, section: "parts", query: { ids }, offset: 1 }), code("INVALID_INPUT"));
  await assert.rejects(f.service.read({ mapId: base.mapId, section: "parts", query: { ids }, cursor: first.nextCursor, offset: 0 }), code("INVALID_INPUT"));
  const branch = await f.service.update({ mapId: base.mapId, contextIds: [source(1).contextId] });
  await assert.rejects(f.service.read({ mapId: branch.mapId, section: "parts", query: { ids }, cursor: first.nextCursor }), code("INVALID_INPUT"));
  const bounds = { min: { x: -10, y: -1, z: -10 }, max: { x: 10, y: 1, z: 10 } };
  const bounded = await f.service.read({ mapId: base.mapId, section: "parts", query: { bounds } });
  assert.deepEqual(bounded.entries, all.filter((row) => ["x", "y", "z"].every((axis) => row.bounds.max[axis] >= bounds.min[axis] && row.bounds.min[axis] <= bounds.max[axis])));
  await assert.rejects(f.service.read({ mapId: base.mapId, section: "tracks", query: { bounds } }), code("INVALID_INPUT"));
});

test("track summary retains typed timing while full reads retain every sample", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId, source(2).contextId] });
  const parts = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries;
  let observed = base;
  for (const part of parts) observed = await f.service.observe({ mapId: observed.mapId, objectIds: [part.id] }, liveOptions(async (_, params) => observation(params)));
  const full = await f.service.read({ mapId: observed.mapId, section: "tracks" });
  const first = await f.service.read({ mapId: observed.mapId, section: "tracks", presentation: "summary", limit: 1 });
  const second = await f.service.read({ mapId: observed.mapId, section: "tracks", presentation: "summary", cursor: first.nextCursor });
  const summaries = [...first.entries, ...second.entries];
  assert.deepEqual(summaries.map((row) => row.id), full.entries.map((row) => row.id));
  for (const [index, row] of summaries.entries()) {
    const raw = full.entries[index];
    assert.equal(row.sampleCount, raw.samples.length);
    assert.equal(row.sampleStart, raw.sampleStart);
    assert.equal(row.sampleEnd, raw.sampleEnd);
    assert.equal(row.samples, undefined);
    assert.deepEqual(row.uncertainty, raw.uncertainty);
    assert.equal(row.maxGap, Math.max(0, ...raw.samples.slice(1).map((sample, i) => sample.t - raw.samples[i].t)));
  }
  await assert.rejects(f.service.read({ mapId: observed.mapId, section: "tracks", presentation: "full", cursor: first.nextCursor }), code("INVALID_INPUT"));
  const selected = await f.service.read({ mapId: observed.mapId, section: "tracks", presentation: "summary", query: { partId: parts[0].id } });
  assert.deepEqual(selected.entries.map((row) => row.partId), [parts[0].id]);
});

test("map index refuses malformed UTF-8 without replacing durable evidence", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const indexPath = path.join(f.namespace, "index.json"), bytes = await readFile(indexPath);
  const offset = bytes.indexOf(Buffer.from('"owner":"')) + 9;
  bytes[offset] = 0xff;
  await writeFile(indexPath, bytes);
  await assert.rejects(f.service.read({ mapId: base.mapId }), code("STORAGE"));
  await assert.rejects(f.service.release({ mapId: base.mapId }), code("STORAGE"));
  assert.deepEqual(await readFile(indexPath), bytes);
});

test("recording import is once-only across concurrent services, restart, and released maps", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const recording = recordingEvidence(part);
  const other = createMapContextService(f.settings);
  t.after(() => other.close());
  const importing = f.service.importRecording({ mapId: base.mapId, recording });
  const conflicting = structuredClone(recording);
  conflicting.frames[0].samples[0].cframe[0] += 0.1;
  const conflictWhilePending = assert.rejects(other.importRecording({ mapId: base.mapId, recording: conflicting }), code("CONFLICT"));
  const [accepted, retry] = await Promise.all([importing, other.importRecording({ mapId: base.mapId, recording: structuredClone(recording) })]);
  await conflictWhilePending;
  assert.deepEqual(retry, accepted);
  assert.equal((await f.service.list()).maps.length, 2);
  const later = structuredClone(recording);
  later.receivedAt = "2026-09-09T00:00:02.000Z";
  later.metadata.now += 1;
  assert.deepEqual(await other.importRecording({ mapId: base.mapId, recording: later }), accepted);
  const conflict = structuredClone(recording);
  conflict.frames[0].samples[0].cframe[0] += 0.1;
  await assert.rejects(other.importRecording({ mapId: base.mapId, recording: conflict }), code("CONFLICT"));
  await assert.rejects(other.importRecording({ mapId: accepted.mapId, recording }), code("CONFLICT"));
  await f.service.release({ mapId: base.mapId });
  await f.service.release({ mapId: accepted.mapId });
  const restarted = createMapContextService(f.settings);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.importRecording({ mapId: base.mapId, recording }), { ...accepted, released: true });
  assert.deepEqual(await restarted.findRecordingReceipt({ mapId: base.mapId, recordingId: recording.recordingId }), { ...accepted, released: true });
  await assert.rejects(restarted.findRecordingReceipt({ mapId: base.mapId, recordingId: recording.recordingId, clientId: "another-client" }), code("CONFLICT"));
  await assert.rejects(restarted.findRecordingReceipt({ mapId: base.mapId, recordingId: recording.recordingId, client: { clientId: "fixture", generation: 2 } }), code("CONFLICT"));
  assert.deepEqual((await restarted.list()).maps, []);
});

test("long recording archives page complete raw frames and inherit offline evidence", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  assert.deepEqual((await f.service.prepareRecording({ mapId: base.mapId, objectIds: [part.id] })).targets, [{ sourceSnapshotId: part.sourceSnapshotId, sourceObjectId: part.sourceObjectId }]);
  await assert.rejects(f.service.prepareRecording({ mapId: base.mapId, objectIds: [part.id, part.id] }), code("INVALID_INPUT"));
  const mechanics = await f.service.mechanics({ view: "apply", mapId: base.mapId, supportModes: ["floor", "ceiling"], transitions: [] });
  const probed = await f.service.probe({ mapId: mechanics.mapId, center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, columns: 2, rows: 2 }, liveOptions(async (_, params) => probe(params)));
  const recording = recordingEvidence(part, 7100, 1201);
  f.sources.clear();
  const saved = await f.service.importRecording({ mapId: probed.mapId, recording });
  const rows = [];
  let cursor = 0, page;
  do {
    page = await f.service.readRecording({ mapId: saved.mapId, recordingId: recording.recordingId, view: "frames", afterCursor: cursor, limit: 20 });
    assert.ok(page.nextCursor > cursor);
    rows.push(...page.frames);
    cursor = page.nextCursor;
  } while (page.hasMore);
  assert.deepEqual(rows, recording.frames);
  assert.deepEqual((await f.service.readRecording({ mapId: saved.mapId, recordingId: recording.recordingId, view: "events" })).events, recording.events);
  assert.deepEqual((await f.service.readRecording({ mapId: saved.mapId })).recordings[0].metadata, recording.metadata);
  const empty = await f.service.readRecording({ mapId: saved.mapId, recordingId: recording.recordingId, view: "frames", afterCursor: 1201 });
  assert.deepEqual(empty.frames, []);
  assert.equal(empty.hasMore, false);
  await assert.rejects(f.service.readRecording({ mapId: saved.mapId, view: "frames" }), code("INVALID_INPUT"));
  await assert.rejects(f.service.readRecording({ mapId: saved.mapId, recordingId: recording.recordingId, view: "events", afterCursor: 2 }), code("INVALID_INPUT"));
  const stored = JSON.parse(await readFile(path.join(f.namespace, `${saved.mapId}.json`), "utf8")).record;
  assert.equal(stored.schema, 3);
  assert.deepEqual(stored.recordings, [recording]);
  assert.equal(stored.probes.length, 1);
  assert.equal(stored.sources.length, 1);
  assert.deepEqual(stored.model.mechanics.supportModes, ["floor", "ceiling"]);
  assert.ok(stored.model.tracks.every((track) => track.samples.length <= 101));
  const cleared = await f.service.mechanics({ view: "apply", mapId: saved.mapId, supportModes: ["floor"], transitions: [] });
  assert.deepEqual((await f.service.readRecording({ mapId: cleared.mapId })).recordings, (await f.service.readRecording({ mapId: saved.mapId })).recordings);
});

test("recording limits and cancellation reject before publication but late abort returns accepted identity", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0], recording = recordingEvidence(part, 7200);
  const invalid = structuredClone(recording);
  invalid.frames[1].sequence++;
  await assert.rejects(f.service.importRecording({ mapId: base.mapId, recording: invalid }), code("INVALID_INPUT"));
  const early = new AbortController();
  early.abort();
  await assert.rejects(f.service.importRecording({ mapId: base.mapId, recording }, { signal: early.signal }), code("CANCELLED"));
  assert.equal((await f.service.list()).maps.length, 1);
  const late = new AbortController(), original = fs.rename;
  fs.rename = async (...args) => {
    await original(...args);
    if (path.basename(args[1]) === "index.json" && path.dirname(args[1]) === f.namespace) late.abort();
  };
  syncBuiltinESMExports();
  let saved;
  try { saved = await f.service.importRecording({ mapId: base.mapId, recording }, { signal: late.signal }); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.equal(late.signal.aborted, true);
  assert.deepEqual(await f.service.findRecordingReceipt({ mapId: base.mapId, recordingId: recording.recordingId }), saved);
  let current = saved;
  for (let i = 1; i < 4; i++) current = await f.service.importRecording({ mapId: current.mapId, recording: recordingEvidence(part, 7200 + i) });
  const before = (await f.service.list()).maps;
  await assert.rejects(f.service.prepareRecording({ mapId: current.mapId, objectIds: [part.id] }), code("LIMIT"));
  await assert.rejects(f.service.importRecording({ mapId: current.mapId, recording: recordingEvidence(part, 7204) }), code("LIMIT"));
  assert.deepEqual((await f.service.list()).maps, before);
});

test("128 durable recording receipts exceed old index bytes without dedup loss or silent eviction", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  let first;
  for (let i = 0; i < 128; i++) {
    const accepted = await f.service.importRecording({ mapId: base.mapId, recording: recordingEvidence(part, 8000 + i) });
    first ??= accepted;
    await f.service.release({ mapId: accepted.mapId });
  }
  const indexPath = path.join(f.namespace, "index.json"), before = await readFile(indexPath);
  assert.ok(before.length > 16384 && before.length <= 65536);
  const restarted = createMapContextService(f.settings);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.importRecording({ mapId: base.mapId, recording: recordingEvidence(part, 8000) }), { ...first, released: true });
  await assert.rejects(restarted.prepareRecording({ mapId: base.mapId, objectIds: [part.id] }), code("LIMIT"));
  await assert.rejects(restarted.importRecording({ mapId: base.mapId, recording: recordingEvidence(part, 8128) }), code("LIMIT"));
  assert.deepEqual(await readFile(indexPath), before);
  assert.deepEqual((await restarted.list()).maps.map((row) => row.mapId), [base.mapId]);
});

test("oversized recording scalar pages cannot publish a map or a dedup receipt", async (t) => {
  const f = await fixture(t);
  f.sources.set(source(4).contextId, source(4));
  const base = await f.service.build({ contextIds: [1, 2, 3, 4].map((id) => source(id).contextId) });
  const parts = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries;
  const recording = recordingEvidence(parts[0], 9000, 1201), tiny = 1.2345678901234567e-100;
  recording.metadata.targets = parts.map((part) => ({ sourceSnapshotId: part.sourceSnapshotId, sourceObjectId: part.sourceObjectId, path: part.path, className: part.className, size: part.size, anchored: part.anchored, canCollide: part.canCollide }));
  for (const row of recording.frames) row.samples = parts.map((part) => ({ sourceObjectId: part.sourceObjectId, t: row.t, cframe: Array(12).fill(tiny), size: { x: tiny, y: tiny, z: tiny } }));
  recording.metadata.sampleCount = recording.frames.length * parts.length;
  recording.metadata.sampleBytes = 2097152;
  assert.ok(Buffer.byteLength(JSON.stringify(recording.frames)) > 2097152);
  const before = await readFile(path.join(f.namespace, "index.json"));
  await assert.rejects(f.service.importRecording({ mapId: base.mapId, recording }), code("LIMIT"));
  assert.deepEqual(await readFile(path.join(f.namespace, "index.json")), before);
  assert.equal(await f.service.findRecordingReceipt({ mapId: base.mapId, recordingId: recording.recordingId }), null);
});

test("joined recording cancellation cannot retract acceptance and owner failure releases the join", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const part = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const recording = recordingEvidence(part, 9200);
  const other = createMapContextService(f.settings);
  t.after(() => other.close());
  const joining = new AbortController(), beforeJoin = new AbortController();
  beforeJoin.abort();
  const owner = f.service.importRecording({ mapId: base.mapId, recording });
  const joined = other.importRecording({ mapId: base.mapId, recording }, { signal: joining.signal });
  const rejectedBeforeJoin = assert.rejects(other.importRecording({ mapId: base.mapId, recording }, { signal: beforeJoin.signal }), code("CANCELLED"));
  joining.abort();
  const [accepted, joinedAcceptance] = await Promise.all([owner, joined]);
  await rejectedBeforeJoin;
  assert.deepEqual(joinedAcceptance, accepted);
  assert.deepEqual(await f.service.findRecordingReceipt({ mapId: base.mapId, recordingId: recording.recordingId }), accepted);

  const next = recordingEvidence(part, 9201), cancelledJoin = new AbortController();
  let current = true;
  const failingOwner = f.service.importRecording({ mapId: base.mapId, recording: next }, { client: next.client, isCurrent: () => current });
  const failedJoin = other.importRecording({ mapId: base.mapId, recording: next }, { signal: cancelledJoin.signal });
  current = false;
  cancelledJoin.abort();
  await Promise.all([assert.rejects(failingOwner, code("CLIENT_CHANGED")), assert.rejects(failedJoin, code("CANCELLED"))]);
  assert.equal(await f.service.findRecordingReceipt({ mapId: base.mapId, recordingId: next.recordingId }), null);
  const retried = await other.importRecording({ mapId: base.mapId, recording: next });
  assert.equal(retried.revision, base.revision + 1);
  assert.notEqual(retried.mapId, accepted.mapId);
});

test("recapturing an exact native object updates geometry without rebinding archived recordings by path", async (t) => {
  const f = await fixture(t), base = await f.service.build({ contextIds: [source(1).contextId] });
  const original = (await f.service.read({ mapId: base.mapId, section: "parts" })).entries[0];
  const recording = recordingEvidence(original, 9300);
  recording.events.push({ sequence: 2, t: 0.1, kind: "health-drop", objectIds: [original.sourceObjectId], amount: 5, association: "spatial-temporal-correlation" });
  recording.metadata.eventCount = recording.events.length;
  recording.metadata.eventBytes = Buffer.byteLength(JSON.stringify(recording.events));
  const saved = await f.service.importRecording({ mapId: base.mapId, recording });
  const recaptured = source(2, { capturedAt: "2026-09-09T00:00:02.000Z" });
  recaptured.scene.parts[0].sourceObjectId = original.sourceObjectId;
  recaptured.sha256 = digest(JSON.stringify(recaptured.scene));
  f.sources.set(recaptured.contextId, recaptured);
  const updated = await f.service.update({ mapId: saved.mapId, contextIds: [recaptured.contextId] });
  const updatedParts = (await f.service.read({ mapId: updated.mapId, section: "parts" })).entries;
  assert.equal(updatedParts.length, 1);
  assert.equal(updatedParts[0].id, original.id);
  assert.equal(updatedParts[0].sourceSnapshotId, recaptured.scene.sourceSnapshotId);
  assert.deepEqual(updatedParts[0].cframe, recaptured.scene.parts[0].cframe);
  assert.deepEqual((await f.service.readRecording({ mapId: updated.mapId })).recordings, (await f.service.readRecording({ mapId: saved.mapId })).recordings);
  assert.deepEqual((await f.service.readRecording({ mapId: updated.mapId, recordingId: recording.recordingId, view: "frames" })).frames, recording.frames);
  assert.deepEqual((await f.service.readRecording({ mapId: updated.mapId, recordingId: recording.recordingId, view: "events" })).events, recording.events);
  const tracked = await f.service.read({ mapId: updated.mapId, section: "tracks", query: { partId: original.id } });
  assert.equal(tracked.entries.length, 1);
  assert.equal(tracked.entries[0].sampleStart, recording.frames[0].samples[0].t);
  assert.equal(tracked.entries[0].sampleEnd, recording.frames.at(-1).samples[0].t);

  const hazards = await f.service.read({ mapId: updated.mapId, section: "hazards", query: { partId: original.id } });
  assert.equal(hazards.entries.length, 1);
  assert.equal(hazards.entries[0].level, "correlated");
  assert.ok(hazards.entries[0].kinds.includes("health-drop"));
  const replacement = source(3, { capturedAt: "2026-09-09T00:00:03.000Z" });
  assert.equal(replacement.scene.parts[0].path, original.path);
  f.sources.set(replacement.contextId, replacement);
  const replaced = await f.service.update({ mapId: updated.mapId, contextIds: [replacement.contextId] });
  const replacementPart = (await f.service.read({ mapId: replaced.mapId, section: "parts" })).entries.find((part) => part.sourceObjectId === replacement.scene.parts[0].sourceObjectId);
  assert.notEqual(replacementPart.id, original.id);
  assert.deepEqual(replacementPart.cframe, replacement.scene.parts[0].cframe);
  assert.deepEqual((await f.service.read({ mapId: replaced.mapId, section: "tracks", query: { partId: replacementPart.id } })).entries, []);
  assert.deepEqual((await f.service.read({ mapId: replaced.mapId, section: "hazards", query: { partId: replacementPart.id } })).entries, []);
  assert.deepEqual((await f.service.readRecording({ mapId: replaced.mapId, recordingId: recording.recordingId, view: "frames" })).frames, recording.frames);
  assert.equal((await f.service.read({ mapId: replaced.mapId, section: "tracks", query: { partId: original.id } })).entries.length, 1);
});

test("combined track capacity rejects new recording targets before collection without losing archived evidence", async (t) => {
  const f = await fixture(t), capture = source(1);
  capture.scene.parts = Array.from({ length: 129 }, (_, index) => ({ ...capture.scene.parts[0], sourceObjectId: hex(100 + index), path: `Workspace.Platform${index}`, canCollide: false }));
  capture.scene.visited = capture.scene.parts.length;
  capture.scene.facetCoverage.geometry.visited = capture.scene.parts.length;
  capture.sha256 = digest(JSON.stringify(capture.scene));
  f.sources.set(capture.contextId, capture);
  let current = await f.service.build({ contextIds: [capture.contextId] });
  const parts = [];
  let offset = 0, page;
  do {
    page = await f.service.read({ mapId: current.mapId, section: "parts", offset, limit: 100 });
    parts.push(...page.entries);
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.equal(parts.length, 129);
  for (let start = 0; start < 128; start += 16) {
    const parent = current;
    current = await f.service.observe({ mapId: parent.mapId, objectIds: parts.slice(start, Math.min(start + 16, 128)).map((part) => part.id) }, liveOptions(async (_, params) => observation(params)));
    await f.service.release({ mapId: parent.mapId });
  }
  assert.equal((await f.service.read({ mapId: current.mapId, section: "tracks" })).total, 128);
  const archived = recordingEvidence(parts[0], 9400);
  const saved = await f.service.importRecording({ mapId: current.mapId, recording: archived });
  assert.deepEqual((await f.service.prepareRecording({ mapId: saved.mapId, objectIds: [parts[0].id] })).targets, [{ sourceSnapshotId: parts[0].sourceSnapshotId, sourceObjectId: parts[0].sourceObjectId }]);
  const recorder = createMapRecordingService({ mapContextService: f.service });
  t.after(() => recorder.close());
  let collections = 0;
  const before = await readFile(path.join(f.namespace, "index.json"));
  await assert.rejects(recorder.start({ mapId: saved.mapId, objectIds: [parts[128].id] }, liveOptions(async () => { collections++; throw new Error("Collection must not run after a known capacity failure"); })), code("LIMIT"));
  assert.equal(collections, 0);
  await assert.rejects(f.service.importRecording({ mapId: saved.mapId, recording: recordingEvidence(parts[128], 9401) }), code("LIMIT"));
  assert.deepEqual(await readFile(path.join(f.namespace, "index.json")), before);
  assert.deepEqual((await f.service.readRecording({ mapId: saved.mapId, recordingId: archived.recordingId, view: "frames" })).frames, archived.frames);
  assert.deepEqual((await f.service.readRecording({ mapId: saved.mapId, recordingId: archived.recordingId, view: "events" })).events, archived.events);
  const empty = recordingEvidence(parts[128], 9402);
  empty.frames = [];
  empty.events = [];
  Object.assign(empty.metadata, { state: "failed", coverage: "partial", stopReasons: ["target-unavailable"], frameCount: 0, sampleCount: 0, eventCount: 0, markerCount: 0, sampleBytes: 0, eventBytes: 0 });
  for (const key of ["firstSampleAt", "lastSampleAt", "readyAt"]) delete empty.metadata[key];
  const retainedFailure = await f.service.importRecording({ mapId: saved.mapId, recording: empty });
  assert.equal((await f.service.read({ mapId: retainedFailure.mapId, section: "tracks" })).total, 128);
  assert.deepEqual((await f.service.readRecording({ mapId: retainedFailure.mapId, recordingId: empty.recordingId })).recordings[0].metadata, empty.metadata);
});

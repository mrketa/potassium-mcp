import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { z } from "zod";
import { createContextStore } from "./context-store.js";
import { createGameContextImages } from "./game-context-images.js";
import { reconstructGeometry } from "./map-geometry.js";
import { analyzeMotion } from "./map-motion.js";
import { buildNavigation, planRoute } from "./map-navigation.js";
import { captureSourceSchema, clientSchema, mapMechanicsInputSchema, mapOperationInputSchema, mapImageSchema, mapRecordSchema, nativeObservationSchema, nativeProbeSchema, profileSchema } from "./map-schemas.js";
import { recordingEvidenceSchema } from "./map-recording-schemas.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const PAGE_BYTES = 6144;
const INDEX_BYTES = 65536;
const MAX_RECEIPTS = 128;
const pendingRecordingImports = new Map();
const ROWS = ["parts", "surfaces", "chunks", "links", "tracks", "hazards"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code: `MAP_CONTEXT_${code}` });
const idSchema = z.string().regex(/^map-[a-f0-9]{32}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativeIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const recordingLookupSchema = z.object({ mapId: idSchema, recordingId: nativeIdSchema, client: clientSchema.optional(), clientId: clientSchema.shape.clientId.optional() }).strict();
const recordingReadSchema = z.object({ mapId: idSchema, recordingId: nativeIdSchema.optional(), view: z.enum(["summary", "frames", "events"]).default("summary"), afterCursor: z.number().int().min(0).max(1201).optional(), limit: z.number().int().min(1).max(20).optional() }).strict().superRefine((value, ctx) => {
  if (value.view !== "summary" && !value.recordingId) ctx.addIssue({ code: "custom", message: "Raw recording reads require recordingId" });
  if (value.view === "summary" && (value.afterCursor !== undefined || value.limit !== undefined)) ctx.addIssue({ code: "custom", message: "Summary does not accept pagination" });
});
const receiptSchema = z.object({ key: digestSchema, parent: idSchema, sha256: digestSchema, mapId: idSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), id: nativeIdSchema, client: digestSchema }).strict();
const indexSchema = z.object({ schema: z.literal(1), owner: digestSchema, maps: z.array(z.object({ mapId: idSchema, createdAt: z.string().datetime(), bytes: z.number().int().positive().max(MAX_BYTES), sha256: digestSchema }).strict()).max(8), recordingReceipts: z.array(receiptSchema).max(MAX_RECEIPTS).default([]) }).strict();
const envelopeSchema = z.object({ schema: z.literal(1), owner: digestSchema, record: mapRecordSchema }).strict();
const defaults = { walkSpeed: 16, jumpVelocity: 50, gravity: 196.2, radius: 1, height: 5, maxSlopeDegrees: 45, maxDropHeight: 16, stepHeight: 1, landingMargin: 0.25 };
const unique = (values) => [...new Set(values)].slice(0, 64);
function parse(schema, value, code = "INVALID_INPUT") {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(code, "Map data does not satisfy its bounded schema");
  return result.data;
}
function bytesFor(value, maximum = MAX_BYTES) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maximum) throw fail("LIMIT", "Map record exceeds its byte allowance");
  return bytes;
}
function json(bytes) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw fail("STORAGE", "Stored map is not valid UTF-8 JSON"); } }
function scopeOf(source) { return { placeId: source.place.placeId, clientId: source.client.clientId, generation: source.client.generation }; }
function sameScope(a, b) { return a.placeId === b.placeId && a.clientId === b.clientId && a.generation === b.generation; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return Object.is(value, -0) ? 0 : value;
}
function recordingKey(client, recordingId) { return hash(JSON.stringify([client.clientId, client.generation, recordingId])); }
function recordingDigest(recording) {
  const { receivedAt, metadata, ...evidence } = recording;
  const { now, elapsedMs, remainingMs, expiresAt, ...finalized } = metadata;
  return hash(JSON.stringify(canonical({ ...evidence, metadata: finalized })));
}
function receiptResult(receipt, index) {
  return { mapId: receipt.mapId, revision: receipt.revision, ...(!index.maps.some((row) => row.mapId === receipt.mapId) ? { released: true } : {}) };
}
function matchingReceipt(index, key, mapId, evidenceSha256) {
  const receipt = index.recordingReceipts.find((row) => row.key === key);
  if (receipt && (receipt.parent !== mapId || (evidenceSha256 !== undefined && receipt.sha256 !== evidenceSha256))) throw fail("CONFLICT", "Recording identity was already accepted with a different parent or finalized evidence");
  return receipt;
}
function recordingTargets(record, { objectIds, sourceTargets }) {
  if ((objectIds === undefined) === (sourceTargets === undefined)) throw fail("INVALID_INPUT", "Select either exact map parts or native target pairs");
  const selection = objectIds ?? sourceTargets;
  if (!Array.isArray(selection) || selection.length < 1 || selection.length > 4) throw fail("INVALID_INPUT", "Recording requires one to four exact targets");
  const targets = selection.map((selected) => record.model.parts.find((part) => objectIds ? part.id === selected : part.sourceSnapshotId === selected?.sourceSnapshotId && part.sourceObjectId === selected?.sourceObjectId));
  if (targets.some((part) => !part)) throw fail("INVALID_INPUT", "Recording target is not retained in this map");
  if (targets.some((part) => part.sourceIdentity !== "retained-instance" || !part.sourceSnapshotId || !part.sourceObjectId)) throw fail("SOURCE_UNAVAILABLE", "Recording requires exact retained native bindings");
  if (new Set(targets.map((part) => part.sourceObjectId)).size !== targets.length) throw fail("INVALID_INPUT", "Recording targets must be unique");
  return targets.map(({ sourceSnapshotId, sourceObjectId }) => ({ sourceSnapshotId, sourceObjectId }));
}
function recordingTrackCapacity(record, targets) {
  const tracked = new Set(record.model.tracks.map((track) => track.partId));
  const selected = new Set(targets.map((target) => target.sourceObjectId));
  for (const part of record.model.parts) if (part.sourceIdentity === "retained-instance" && selected.has(part.sourceObjectId)) tracked.add(part.id);
  if (tracked.size > 128) throw fail("LIMIT", "Recording targets exceed the combined motion track capacity");
}
function trackSummary(track) {
  let maxGap = 0;
  for (let i = 1; i < track.samples.length; i++) maxGap = Math.max(maxGap, track.samples[i].t - track.samples[i - 1].t);
  return { id: track.id, partId: track.partId, model: track.model, sampleCount: track.samples.length, sampleStart: track.sampleStart, sampleEnd: track.sampleEnd, observedAt: track.observedAt, maxGap, uncertainty: track.uncertainty, ...(track.period !== undefined ? { period: track.period } : {}), ...(track.velocity ? { velocity: track.velocity } : {}) };
}
function matchesQuery(row, query, section) {
  if (query.ids && !query.ids.includes(row.id)) return false;
  if (query.bounds && !["x", "y", "z"].every((axis) => row.bounds.max[axis] >= query.bounds.min[axis] && row.bounds.min[axis] <= query.bounds.max[axis])) return false;
  if (query.supportMode !== undefined && (section === "links" ? row.fromMode ?? "floor" : row.supportMode ?? "floor") !== query.supportMode) return false;
  return ["from", "to", "action", "partId"].every((key) => query[key] === undefined || row[key] === query[key]);
}
function summary(record) {
  return { mapId: record.mapId, revision: record.revision, ...(record.parentMapId ? { parentMapId: record.parentMapId } : {}), createdAt: record.createdAt, chunkSize: record.chunkSize, sourceContextIds: record.sourceContextIds, counts: Object.fromEntries(ROWS.map((key) => [key, record.model[key].length])), scope: record.scope, coverage: "partial", profileSource: record.model.profileSource, stopReasons: record.model.stopReasons, warnings: record.model.warnings };
}
function mechanicsOf(record) { return record?.model.mechanics ?? { supportModes: ["floor"], transitions: [] }; }
function mechanicsResult(view, record) {
  return { view, mapId: record.mapId, revision: record.revision, ...(record.parentMapId ? { parentMapId: record.parentMapId } : {}), mechanics: mechanicsOf(record), coverage: "partial", warnings: record.model.warnings };
}
function chooseProfile(sources, supplied, parent) {
  if (supplied) return { profile: parse(profileSchema, supplied), profileSource: "supplied" };
  if (parent) return { profile: parent.model.profile, profileSource: parent.model.profileSource };
  const physics = sources.at(-1)?.scene.physics;
  const profile = { ...defaults };
  if (physics) {
    if (physics.gravity > 0) profile.gravity = physics.gravity;
    if (physics.walkSpeed > 0) profile.walkSpeed = physics.walkSpeed;
    if (physics.useJumpPower === true && physics.jumpPower >= 0) profile.jumpVelocity = physics.jumpPower;
    if (physics.useJumpPower === false && physics.jumpHeight >= 0) profile.jumpVelocity = Math.sqrt(2 * profile.gravity * physics.jumpHeight);
    if (physics.bodySize) { profile.radius = Math.max(physics.bodySize.x, physics.bodySize.z) / 2; profile.height = physics.bodySize.y; }
  }
  // Slope, clearance and drop preferences are not engine observations.
  return { profile: parse(profileSchema, profile, "INVALID_DATA"), profileSource: "assumed" };
}
async function cancellable(action, signal) {
  if (signal.aborted) throw fail("CANCELLED", "Map operation cancelled");
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(fail("CANCELLED", "Map operation cancelled")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(action), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createMapContextService({ configFile, gameContextService, images, clock = Date, randomBytes = nodeRandomBytes } = {}) {
  const store = createContextStore({ configFile, namespace: "map-contexts", errorPrefix: "MAP_CONTEXT_", clock, randomBytes, indexMaxBytes: INDEX_BYTES });
  const renderer = images ?? createGameContextImages();
  const controllers = new Set();
  let closed = false;
  function inputFor(view, args = {}) { if (args.view !== undefined && args.view !== view) throw fail("INVALID_INPUT", "Map view does not match method"); return parse(mapOperationInputSchema, { ...args, view }); }
  function timestamp() { const value = clock.now(); if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw fail("INVALID_DATA", "Map clock is invalid"); return new Date(value).toISOString(); }
  async function operation(options, action, liveScope) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    controllers.add(controller);
    let work = 0;
    const check = () => {
      if (closed || controller.signal.aborted) throw fail("CANCELLED", "Map operation cancelled");
      if (++work > 1000000) throw fail("LIMIT", "Map work allowance exceeded");
      if (liveScope && (!options.isCurrent?.() || options.client?.clientId !== liveScope.clientId || options.client?.generation !== liveScope.generation)) throw fail("CLIENT_CHANGED", "Map client or generation changed");
    };
    try { check(); return await action(check, controller.signal); }
    finally { controllers.delete(controller); options.signal?.removeEventListener("abort", abort); }
  }
  async function catalog(state) {
    let bytes;
    try { ({ bytes } = await store.readBytes(state, state.directory, "index.json", INDEX_BYTES)); }
    catch (error) { if (error.code === "ENOENT") return { schema: 1, owner: state.owner, maps: [], recordingReceipts: [] }; throw error; }
    const result = parse(indexSchema, json(bytes), "STORAGE");
    if (result.owner !== state.owner || new Set(result.maps.map((row) => row.mapId)).size !== result.maps.length || result.maps.reduce((sum, row) => sum + row.bytes, 0) > MAX_TOTAL) throw fail("STORAGE", "Map catalog owner or bounds differ");
    if (new Set(result.recordingReceipts.map((row) => row.key)).size !== result.recordingReceipts.length) throw fail("STORAGE", "Recording receipt identities are not unique");
    return result;
  }
  async function load(state, entry) {
    const value = await store.readBytes(state, state.directory, `${entry.mapId}.json`, MAX_BYTES, entry.sha256);
    const envelope = parse(envelopeSchema, json(value.bytes), "STORAGE");
    if (envelope.owner !== state.owner || envelope.record.mapId !== entry.mapId || envelope.record.createdAt !== entry.createdAt || value.bytes.length !== entry.bytes) throw fail("STORAGE", "Map record identity differs from catalog");
    return { record: envelope.record, file: value.entry };
  }
  async function selected(mapId) {
    return store.storage(async () => {
      const state = await store.state();
      if (!state) throw fail("NOT_FOUND", "Map revision was not found");
      const index = await catalog(state);
      const entry = index.maps.find((row) => row.mapId === mapId);
      if (!entry) throw fail("NOT_FOUND", "Map revision was not found");
      return { state, index, entry, ...await load(state, entry) };
    });
  }
  async function sourcesFor(ids, parent, check) {
    if (!gameContextService?.source) throw fail("SOURCE_UNAVAILABLE", "Saved game-context source service is unavailable");
    const sources = [...(parent?.sources ?? [])];
    for (const id of ids) {
      check();
      let source;
      try { source = await gameContextService.source(id); }
      catch (error) { if (error.code === "GAME_CONTEXT_CANCELLED") throw fail("CANCELLED", "Source read cancelled"); throw fail("SOURCE_UNAVAILABLE", "Verified saved context is unavailable"); }
      check();
      source = parse(captureSourceSchema, source, "INVALID_DATA");
      if (source.contextId !== id) throw fail("INVALID_DATA", "Source identity differs from requested saved context");
      if (sources.length && !sameScope(scopeOf(sources[0]), scopeOf(source))) throw fail("INVALID_INPUT", "Sources must share exact place, client and generation");
      const existing = sources.find((item) => item.contextId === id);
      if (existing && existing.sha256 !== source.sha256) throw fail("INVALID_DATA", "Immutable source hash changed");
      if (!existing) sources.push(source);
    }
    if (sources.length > 32) throw fail("LIMIT", "Map source retention limit reached");
    return sources;
  }
  function rebuild(sources, observations, probes, profileData, chunkSize, mechanics, check, recordings = []) {
    const geometry = reconstructGeometry(sources, { probeBatches: probes, profile: profileData.profile, chunkSize, supportModes: mechanics.supportModes, check });
    const partIds = new Set(geometry.parts.map((part) => part.id));
    if (mechanics.transitions.some((transition) => !partIds.has(transition.partId))) throw fail("INVALID_INPUT", "Reported transition must name an exact retained map part");
    let motion;
    try { motion = analyzeMotion(geometry.parts, observations, { check, recordings }); }
    catch (error) {
      if (error.code === "MAP_MOTION_LIMIT") throw fail("LIMIT", "Combined motion track capacity exceeded");
      throw error;
    }
    if (motion.tracks.length > 128) throw fail("LIMIT", "Combined motion track capacity exceeded");
    const base = { ...geometry, ...profileData, mechanics, tracks: motion.tracks, hazards: motion.hazards };
    const navigation = buildNavigation(base, { check });
    return { ...base, links: navigation.links, coverage: "partial", stopReasons: unique([...geometry.stopReasons, ...motion.stopReasons, ...navigation.stopReasons]), warnings: unique(["Historical, partial client-visible evidence; never a current safety guarantee.", "Sources may have mixed capture ages; unseen older objects are retained.", ...(profileData.profileSource === "assumed" ? ["Movement profile includes assumed dimensions or movement preferences."] : []), ...geometry.warnings, ...motion.warnings, ...navigation.warnings]) };
  }
  async function commit(view, parent, sources, observations, probes, model, chunkSize, check, { recordings = parent?.recordings ?? [], receipt } = {}) {
    check();
    const random = randomBytes(16);
    if (!Buffer.isBuffer(random) || random.length !== 16) throw fail("INVALID_DATA", "Map identity generator returned invalid bytes");
    const record = parse(mapRecordSchema, { schema: recordings.length ? 3 : 2, mapId: `map-${random.toString("hex")}`, revision: (parent?.revision ?? 0) + 1, ...(parent ? { parentMapId: parent.mapId } : {}), createdAt: timestamp(), chunkSize, sourceContextIds: sources.map((s) => s.contextId), sourceHashes: sources.map((s) => ({ contextId: s.contextId, sha256: s.sha256 })), scope: scopeOf(sources[0]), sources, observations, probes, ...(recordings.length ? { recordings } : {}), model }, "INVALID_DATA");
    const result = view === "apply" ? mechanicsResult(view, record) : { view, ...summary(record) };
    return store.storage(async () => {
      const state = await store.state(true);
      const unlock = await store.lock(state);
      let staged, committed = false;
      try {
        check();
        const index = await catalog(state);
        if (receipt) {
          const existing = matchingReceipt(index, receipt.key, receipt.parent, receipt.sha256);
          if (existing) return receiptResult(existing, index);
          if (index.recordingReceipts.length >= MAX_RECEIPTS) throw fail("LIMIT", "Recording receipt capacity reached; accepted identities cannot be evicted");
        }
        const expected = new Set(["index.json", ".writer.lock", ...index.maps.map((entry) => `${entry.mapId}.json`)]);
        if ((await store.namesIn(state, state.directory, 11)).some((name) => !expected.has(name))) throw fail("STORAGE", "Map namespace contains unowned or interrupted data");
        if (index.maps.length >= 8) throw fail("LIMIT", "Map retention limit reached; release an unneeded revision");
        if (index.maps.some((entry) => entry.mapId === record.mapId)) throw fail("LIMIT", "Map identity collision");
        const bytes = bytesFor({ schema: 1, owner: state.owner, record });
        if (index.maps.reduce((sum, entry) => sum + entry.bytes, bytes.length) > MAX_TOTAL) throw fail("LIMIT", "Map total retention limit reached");
        staged = await store.writeBytes(state, state.directory, `${record.mapId}.json`, bytes);
        check();
        const nextIndex = { ...index, maps: [...index.maps, { mapId: record.mapId, createdAt: record.createdAt, bytes: bytes.length, sha256: hash(bytes) }], recordingReceipts: receipt ? [...index.recordingReceipts, { ...receipt, mapId: record.mapId, revision: record.revision }] : index.recordingReceipts };
        bytesFor(nextIndex, INDEX_BYTES);
        await store.publishIndex(state, nextIndex, check);
        committed = true;
        return receipt ? { mapId: record.mapId, revision: record.revision } : result;
      } finally {
        if (staged && !committed) await store.removeFile(state, state.directory, staged).catch(() => {});
        await unlock().catch(() => {});
      }
    });
  }
  async function buildOrUpdate(view, args, options = {}) {
    const input = inputFor(view, args);
    return operation(options, async (check) => {
      const parent = view === "update" ? (await selected(input.mapId)).record : undefined;
      const sources = await sourcesFor(input.contextIds, parent, check);
      const observations = parent?.observations ?? [], probes = parent?.probes ?? [];
      const chunkSize = parent?.chunkSize ?? input.chunkSize ?? 64;
      const model = rebuild(sources, observations, probes, chooseProfile(sources, input.profile, parent), chunkSize, mechanicsOf(parent), check, parent?.recordings);
      return commit(view, parent, sources, observations, probes, model, chunkSize, check);
    });
  }
  async function live(view, args, options = {}) {
    const input = inputFor(view, args);
    const parent = (await selected(input.mapId)).record;
    if (typeof options.collect !== "function" || typeof options.isCurrent !== "function") throw fail("INVALID_INPUT", "Map observation requires a pinned collector");
    return operation(options, async (check, signal) => {
      let observations = parent.observations, probes = parent.probes;
      if (view === "observe") {
        const targets = input.objectIds.map((id) => parent.model.parts.find((part) => part.id === id));
        if (targets.some((part) => !part)) throw fail("INVALID_INPUT", "Observation target is not a map part");
        if (targets.some((part) => !part.sourceSnapshotId || !part.sourceObjectId || part.sourceIdentity !== "retained-instance")) throw fail("SOURCE_UNAVAILABLE", "Legacy or sampled map parts have no retained native binding");
        const groups = new Map();
        for (const part of targets) { const ids = groups.get(part.sourceSnapshotId) ?? []; if (!ids.includes(part.sourceObjectId)) ids.push(part.sourceObjectId); groups.set(part.sourceSnapshotId, ids); }
        if (groups.size !== 1) throw fail("INVALID_INPUT", "Observation targets must share one retained source snapshot");
        if (observations.length >= 8) throw fail("LIMIT", "Observation retention limit reached");
        const batches = [];
        for (const [sourceSnapshotId, objectIds] of groups) {
          check();
          const params = { sourceSnapshotId, objectIds, durationMs: input.durationMs ?? 2000, intervalMs: input.intervalMs ?? 100, _maxResultBytes: 65536 };
          const observedAt = timestamp();
          const data = parse(nativeObservationSchema, await cancellable(() => options.collect("map_observe", params), signal), "INVALID_DATA");
          check(); bytesFor(data, 65536);
          if (data.sourceSnapshotId !== sourceSnapshotId || data.tracks.some((track) => !objectIds.includes(track.sourceObjectId)) || data.events.some((event) => event.objectIds.some((id) => !objectIds.includes(id)))) throw fail("INVALID_DATA", "Observation contains targets outside its retained snapshot selection");
          if (data.durationMs !== params.durationMs || data.intervalMs !== params.intervalMs || (data.coverage === "complete" && data.tracks.length !== objectIds.length) || data.tracks.some((track) => track.samples.length > Math.floor(params.durationMs / params.intervalMs) + 1)) throw fail("INVALID_DATA", "Observation contradicts requested sampling bounds");
          batches.push({ observedAt, client: { clientId: parent.scope.clientId, generation: parent.scope.generation }, data });
        }
        observations = [...observations, ...batches];
      } else {
        if (probes.length >= 8) throw fail("LIMIT", "Probe retention limit reached");
        const params = { center: input.center, size: input.size, columns: input.columns ?? 4, rows: input.rows ?? 4, maxDistance: input.maxDistance ?? 256, _maxResultBytes: 32768 };
        const observedAt = timestamp();
        const data = parse(nativeProbeSchema, await cancellable(() => options.collect("map_probe", params), signal), "INVALID_DATA");
        check(); bytesFor(data, 32768);
        if (data.columns !== params.columns || data.rows !== params.rows || ["x", "y", "z"].some((axis) => Math.abs(data.center[axis] - params.center[axis]) > Math.max(0.001, Math.abs(params.center[axis]) * 1e-6) || Math.abs(data.size[axis] - params.size[axis]) > Math.max(0.001, Math.abs(params.size[axis]) * 1e-6))) throw fail("INVALID_DATA", "Probe differs from requested grid");
        for (const sample of data.samples) {
          check();
          const expected = { x: params.center.x + params.size.x * (sample.column / (params.columns - 1) - 0.5), y: params.center.y + params.size.y / 2, z: params.center.z + params.size.z * (sample.row / (params.rows - 1) - 0.5) };
          const tolerance = Math.max(0.001, ...Object.values(expected).map((value) => Math.abs(value) * 1e-6));
          if (["x", "y", "z"].some((axis) => Math.abs(sample.origin[axis] - expected[axis]) > tolerance)) throw fail("INVALID_DATA", "Probe origin is not on the requested ray grid");
          if (sample.hit && (Math.abs(sample.position.x - sample.origin.x) > tolerance || Math.abs(sample.position.z - sample.origin.z) > tolerance || sample.position.y > sample.origin.y + tolerance || sample.origin.y - sample.position.y > params.maxDistance + tolerance || Math.abs(Math.hypot(sample.normal.x, sample.normal.y, sample.normal.z) - 1) > 0.01)) throw fail("INVALID_DATA", "Probe hit contradicts its bounded downward ray");
        }
        probes = [...probes, { observedAt, client: { clientId: parent.scope.clientId, generation: parent.scope.generation }, data }];
      }
      const model = rebuild(parent.sources, observations, probes, { profile: parent.model.profile, profileSource: parent.model.profileSource }, parent.chunkSize, mechanicsOf(parent), check, parent.recordings);
      return commit(view, parent, parent.sources, observations, probes, model, parent.chunkSize, check);
    }, parent.scope);
  }
  async function findRecordingReceipt(args) {
    const input = parse(recordingLookupSchema, args);
    return store.storage(async () => {
      const state = await store.state();
      if (!state) return null;
      const index = await catalog(state);
      const receipt = index.recordingReceipts.find((row) => row.parent === input.mapId && row.id === input.recordingId);
      if (receipt && ((input.client && receipt.key !== recordingKey(input.client, input.recordingId)) || (input.clientId && receipt.client !== hash(input.clientId)))) throw fail("CONFLICT", "Recording receipt belongs to a different client or generation");
      if (!receipt && input.client) matchingReceipt(index, recordingKey(input.client, input.recordingId), input.mapId);
      if (receipt) return receiptResult(receipt, index);
      if (index.recordingReceipts.length >= MAX_RECEIPTS || index.maps.length >= 8 || index.maps.reduce((sum, row) => sum + row.bytes, 0) >= MAX_TOTAL) throw fail("LIMIT", "Map or recording retention capacity is exhausted");
      const entry = index.maps.find((row) => row.mapId === input.mapId);
      if (entry && ((await load(state, entry)).record.recordings?.length ?? 0) >= 4) throw fail("LIMIT", "Recording evidence retention limit reached");
      return null;
    });
  }
  return {
    build: (args, options) => buildOrUpdate("build", args, options),
    update: (args, options) => buildOrUpdate("update", args, options),
    observe: (args, options) => live("observe", args, options),
    probe: (args, options) => live("probe", args, options),
    findRecordingReceipt,
    async prepareRecording(args) {
      const input = parse(z.object({ mapId: idSchema, objectIds: z.array(z.string().min(1).max(128)).min(1).max(4).optional(), sourceTargets: z.array(z.object({ sourceSnapshotId: nativeIdSchema, sourceObjectId: nativeIdSchema }).strict()).min(1).max(4).optional() }).strict(), args);
      const { record, index, entry } = await selected(input.mapId);
      const targets = recordingTargets(record, input);
      recordingTrackCapacity(record, targets);
      if ((record.recordings?.length ?? 0) >= 4 || index.recordingReceipts.length >= MAX_RECEIPTS || index.maps.length >= 8 || entry.bytes >= MAX_BYTES || index.maps.reduce((sum, row) => sum + row.bytes, 0) >= MAX_TOTAL) throw fail("LIMIT", "Map or recording retention capacity is exhausted");
      return { scope: record.scope, targets };
    },
    async importRecording(args, options = {}) {
      const input = parse(z.object({ mapId: idSchema, recording: recordingEvidenceSchema }).strict(), args);
      const { recording } = input;
      bytesFor(recording);
      bytesFor(recording.frames, 2097152);
      bytesFor(recording.events, 65536);
      const receipt = { key: recordingKey(recording.client, recording.recordingId), parent: input.mapId, sha256: recordingDigest(recording), id: recording.recordingId, client: hash(recording.client.clientId) };
      const namespace = process.platform === "win32" ? store.configFile?.toLowerCase() : store.configFile;
      const pending = pendingRecordingImports.get(namespace);
      const existing = pending?.get(receipt.key);
      if (existing && (existing.parent !== receipt.parent || existing.sha256 !== receipt.sha256)) throw fail("CONFLICT", "Recording identity is already being imported with different parent or finalized evidence");
      const scope = options.client || options.isCurrent ? recording.client : undefined;
      if (existing) {
        return operation(options, async (check) => {
          // A joiner cannot cancel the owner's import. Once joined, acceptance
          // wins over cancellation; if the owner fails, this caller's own
          // cancellation/current-client fence determines its failure.
          try { return { ...await existing.promise }; }
          catch (error) { check(); throw error; }
        }, scope);
      }
      if ((pending?.size ?? 0) >= 8) throw fail("LIMIT", "Pending recording import capacity reached");
      const promise = operation(options, async (check) => {
        const accepted = await store.storage(async () => {
          const state = await store.state();
          if (!state) return null;
          const index = await catalog(state);
          const existing = matchingReceipt(index, receipt.key, input.mapId, receipt.sha256);
          if (existing) return receiptResult(existing, index);
          if (index.recordingReceipts.length >= MAX_RECEIPTS) throw fail("LIMIT", "Recording receipt capacity reached; accepted identities cannot be evicted");
          return null;
        });
        if (accepted) return accepted;
        check();
        const { record: parent } = await selected(input.mapId);
        if (parent.scope.clientId !== recording.client.clientId || parent.scope.generation !== recording.client.generation) throw fail("INVALID_DATA", "Recording belongs to a different client or generation");
        const targets = recordingTargets(parent, { sourceTargets: recording.metadata.targets.map(({ sourceSnapshotId, sourceObjectId }) => ({ sourceSnapshotId, sourceObjectId })) });
        if (recording.frames.length) recordingTrackCapacity(parent, targets);
        const recordings = [...(parent.recordings ?? []), recording];
        if (recordings.length > 4) throw fail("LIMIT", "Recording evidence retention limit reached");
        bytesFor({ sources: parent.sources, observations: parent.observations, probes: parent.probes, recordings });
        const model = rebuild(parent.sources, parent.observations, parent.probes, { profile: parent.model.profile, profileSource: parent.model.profileSource }, parent.chunkSize, mechanicsOf(parent), check, recordings);
        return commit("save", parent, parent.sources, parent.observations, parent.probes, model, parent.chunkSize, check, { recordings, receipt });
      }, scope);
      const imports = pending ?? new Map();
      imports.set(receipt.key, { parent: receipt.parent, sha256: receipt.sha256, promise });
      pendingRecordingImports.set(namespace, imports);
      // The first caller owns admission and cancellation before publication.
      // Its failure is shared by joiners; no joined request keeps it alive.
      try { return await promise; }
      finally {
        imports.delete(receipt.key);
        if (!imports.size) pendingRecordingImports.delete(namespace);
      }
    },
    async readRecording(args) {
      const input = parse(recordingReadSchema, args);
      const { record } = await selected(input.mapId);
      const recordings = record.recordings ?? [];
      const recording = input.recordingId ? recordings.find((row) => row.recordingId === input.recordingId) : undefined;
      if (input.recordingId && !recording) throw fail("NOT_FOUND", "Recording was not archived in this revision");
      const result = { mapId: record.mapId, revision: record.revision, view: input.view };
      if (input.view === "summary") return { ...result, recordings: (recording ? [recording] : recordings).map(({ recordingId, client, receivedAt, metadata }) => ({ recordingId, client, receivedAt, metadata })) };
      const rows = recording[input.view], cursor = input.afterCursor ?? 0, limit = input.limit ?? 10;
      if (cursor > (rows.at(-1)?.sequence ?? 0)) throw fail("INVALID_INPUT", "Recording cursor is beyond retained evidence");
      const page = { ...result, recordingId: recording.recordingId, metadata: recording.metadata, cursor, nextCursor: cursor, hasMore: false, [input.view]: [] };
      for (const row of rows) {
        if (row.sequence <= cursor) continue;
        page[input.view].push(row);
        page.nextCursor = row.sequence;
        page.hasMore = row.sequence < rows.at(-1).sequence;
        if (Buffer.byteLength(JSON.stringify(page)) > 65536) {
          page[input.view].pop();
          if (!page[input.view].length) throw fail("LIMIT", "A complete recording row exceeds the page byte allowance");
          page.nextCursor = page[input.view].at(-1).sequence;
          page.hasMore = true;
          break;
        }
        if (page[input.view].length >= limit) break;
      }
      return page;
    },
    async mechanics(args, options = {}) {
      const input = parse(mapMechanicsInputSchema, args);
      return operation(options, async (check) => {
        const parent = (await selected(input.mapId)).record;
        check();
        if (input.view === "read") return mechanicsResult("read", parent);
        const partIds = new Set(parent.model.parts.map((part) => part.id));
        if (input.transitions.some((transition) => !partIds.has(transition.partId))) throw fail("INVALID_INPUT", "Reported transition must name an exact part in the selected revision");
        const reportedAt = timestamp();
        const mechanics = {
          supportModes: input.supportModes,
          transitions: input.transitions.map(({ partId, fromMode, toMode, note }) => ({
            id: `transition-${hash(JSON.stringify([partId, fromMode, toMode])).slice(0, 40)}`, partId, fromMode, toMode, evidence: { kind: "user-report", note, reportedAt },
          })),
        };
        const model = rebuild(parent.sources, parent.observations, parent.probes, { profile: parent.model.profile, profileSource: parent.model.profileSource }, parent.chunkSize, mechanics, check, parent.recordings);
        return commit("apply", parent, parent.sources, parent.observations, parent.probes, model, parent.chunkSize, check);
      });
    },
    async read(args) {
      const input = inputFor("read", args);
      const { record } = await selected(input.mapId);
      const section = input.section ?? "summary";
      if (section === "summary") return { view: "read", section, ...summary(record) };
      const available = record.model[section], limit = input.limit ?? 20;
      const query = canonical(input.query ? { ...input.query, ...(input.query.ids ? { ids: [...new Set(input.query.ids)].sort() } : {}) } : {});
      const projected = input.query !== undefined || input.presentation !== undefined || input.cursor !== undefined;
      const binding = hash(JSON.stringify([record.mapId, record.revision, section, query, input.presentation ?? "full"]));
      const rows = input.query ? available.filter((row) => matchesQuery(row, query, section)) : available;
      let offset = input.offset ?? 0;
      if (input.cursor !== undefined) {
        const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(input.cursor);
        if (!match || match[1] !== binding || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > rows.length) throw fail("INVALID_INPUT", "Cursor does not match this map, revision, query, or presentation");
        offset = Number(match[2]);
      }
      const result = { view: "read", mapId: record.mapId, revision: record.revision, section, offset, total: rows.length, ...(projected ? { totalMatched: rows.length, totalAvailable: available.length, ...(input.query ? { query } : {}), ...(input.presentation ? { presentation: input.presentation } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) } : {}), entries: [], coverage: "partial", warnings: record.model.warnings.slice(0, 4) };
      const continuation = (offset) => projected ? { nextCursor: `${binding}:${offset}` } : { nextOffset: offset };
      for (let i = offset; i < rows.length && result.entries.length < limit; i++) {
        result.entries.push(input.presentation === "summary" ? trackSummary(rows[i]) : rows[i]);
        if (Buffer.byteLength(JSON.stringify({ ...result, ...continuation(i + 1) })) > PAGE_BYTES) { if (result.entries.length > 1) result.entries.pop(); break; }
      }
      if (offset + result.entries.length < rows.length) Object.assign(result, continuation(offset + result.entries.length));
      return result;
    },
    async list() {
      return store.storage(async () => {
        const state = await store.state();
        if (!state) return { view: "list", maps: [] };
        const index = await catalog(state), maps = [];
        for (const entry of index.maps) {
          const { mapId, revision, parentMapId, createdAt, counts, coverage } = summary((await load(state, entry)).record);
          maps.push({ mapId, revision, ...(parentMapId ? { parentMapId } : {}), createdAt, counts, coverage });
        }
        return { view: "list", maps };
      });
    },
    async release(args) {
      const input = inputFor("release", args);
      return store.storage(async () => {
        const state = await store.state();
        if (!state) return { view: "release", mapId: input.mapId, released: false };
        const unlock = await store.lock(state);
        try {
          const index = await catalog(state), entry = index.maps.find((row) => row.mapId === input.mapId);
          if (!entry) return { view: "release", mapId: input.mapId, released: false };
          const { file } = await load(state, entry);
          await store.assertState(state, [file]);
          await store.publishIndex(state, { ...index, maps: index.maps.filter((row) => row !== entry) });
          await store.removeFile(state, state.directory, file).catch(() => {});
          return { view: "release", mapId: input.mapId, released: true };
        } finally { await unlock().catch(() => {}); }
      });
    },
    async route(args, options = {}) {
      const input = inputFor("route", args);
      return operation(options, async (check) => {
        const { record } = await selected(input.mapId); check();
        if (![input.from, input.to].every((id) => record.model.surfaces.some((surface) => surface.id === id))) throw fail("INVALID_INPUT", "Route endpoints must be surfaces in this revision");
        return { view: "route", mapId: record.mapId, revision: record.revision, ...planRoute(record.model, { from: input.from, to: input.to, departure: input.departure ?? 0, allowUncertain: input.allowUncertain ?? false }, { check }) };
      });
    },
    async image(args, options = {}) {
      const input = inputFor("image", args);
      return operation(options, async (check, signal) => {
        const { record } = await selected(input.mapId); check();
        if (!Number.isSafeInteger(options.imageBudget) || options.imageBudget < 4096) throw fail("IMAGE_UNAVAILABLE", "Image budget is unavailable");
        const maxBytes = Math.min(options.imageBudget, 128 * 1024);
        const rendered = await cancellable(() => renderer.render({ scene: { parts: record.model.parts }, screenshot: false, map: true, maxBytes, signal, mapOverlay: { surfaces: record.model.surfaces, links: record.model.links, tracks: record.model.tracks, hazards: record.model.hazards, ...(input.minY !== undefined ? { minY: input.minY } : {}), ...(input.maxY !== undefined ? { maxY: input.maxY } : {}) } }), signal);
        check();
        const facet = rendered?.map;
        if (facet?.status !== "available" || !Buffer.isBuffer(facet.data) || facet.data.length > maxBytes || facet.mimeType !== "image/jpeg") throw fail("IMAGE_UNAVAILABLE", "Offline map image could not be rendered");
        const metadata = parse(mapImageSchema, { mimeType: facet.mimeType, bytes: facet.data.length, sha256: hash(facet.data), width: facet.width, height: facet.height, provider: facet.provider, rendering: facet.rendering }, "IMAGE_UNAVAILABLE");
        return { metadata: { view: "image", mapId: record.mapId, revision: record.revision, coverage: "partial", warnings: record.model.warnings, image: metadata }, image: { data: facet.data, mimeType: facet.mimeType, width: facet.width, height: facet.height } };
      });
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); },
  };
}

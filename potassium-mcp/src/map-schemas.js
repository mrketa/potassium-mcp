import { z } from "zod";
import { recordingEvidenceSchema, recordingIdSchema } from "./map-recording-schemas.js";

export const MAP_LIMITS = Object.freeze({ parts: 1024, surfaces: 2048, links: 4096, chunks: 256, sources: 32, observationBatches: 8, motionTargets: 16, samplesPerTarget: 101, tracks: 128, maps: 8, pageRows: 100 });

const text = (max) => z.string().max(max).refine((value) => value.isWellFormed() && !value.includes("\0"), "Must be well-formed text without NUL");
const finite = z.number().finite();
const coordinate = finite.min(-1e9).max(1e9);
const count = (max) => z.number().int().min(0).max(max);
const seconds = finite.min(0).max(60);
const timestamp = z.string().datetime();
const rowId = text(64).min(1);
const reason = text(256);
const reasons = z.array(reason).max(64);
const rowReasons = z.array(reason).max(32);
const coverage = z.enum(["complete", "partial"]);
const partial = z.literal("partial");
const geometry = z.enum(["block", "bounds-only", "sampled"]);
const profileSource = z.enum(["captured", "supplied", "assumed"]);
const issue = (ctx, path, message) => ctx.addIssue({ code: "custom", path, message });
const unique = (values) => new Set(values).size === values.length;
const sameClient = (a, b) => a.clientId === b.clientId && a.generation === b.generation;

export const mapIdSchema = z.string().regex(/^map-[a-f0-9]{32}(?![\s\S])/);
export const contextIdSchema = z.string().regex(/^gc-[a-f0-9]{32}(?![\s\S])/);
export const sourceObjectIdSchema = z.string().regex(/^[a-f0-9]{32}(?![\s\S])/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
export const vectorSchema = z.object({ x: coordinate, y: coordinate, z: coordinate }).strict();
const legacyVectorSchema = z.object({ x: finite, y: finite, z: finite }).strict();
export const supportModeSchema = z.enum(["floor", "ceiling"]);
const supportModesSchema = z.array(supportModeSchema).min(1).max(2).refine(unique, "Support modes must be unique");
const transitionFields = { partId: rowId, fromMode: supportModeSchema, toMode: supportModeSchema };
const transitionInputSchema = z.object({ ...transitionFields, note: reason }).strict().superRefine((value, ctx) => {
  if (value.fromMode === value.toMode) issue(ctx, ["toMode"], "A reported transition must change support mode");
});
export const reportedTransitionSchema = z.object({
  id: rowId, ...transitionFields, evidence: z.object({ kind: z.literal("user-report"), note: reason, reportedAt: timestamp }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.fromMode === value.toMode) issue(ctx, ["toMode"], "A reported transition must change support mode");
});
function validateMechanics(value, ctx) {
  if (value.supportModes === undefined || value.transitions === undefined) return;
  const keys = new Set();
  for (const [index, transition] of value.transitions.entries()) {
    const key = JSON.stringify([transition.partId, transition.fromMode]);
    if (keys.has(key)) issue(ctx, ["transitions", index], "Only one transition may leave a part in each mode");
    keys.add(key);
    for (const mode of ["fromMode", "toMode"]) if (!value.supportModes.includes(transition[mode])) issue(ctx, ["transitions", index, mode], "Transition modes must be enabled");
  }
}
export const mapMechanicsSchema = z.object({ supportModes: supportModesSchema, transitions: z.array(reportedTransitionSchema).max(16) }).strict().superRefine((value, ctx) => {
  validateMechanics(value, ctx);
  if (!unique(value.transitions.map((transition) => transition.id))) issue(ctx, ["transitions"], "Reported transition IDs must be unique");
});
export const sizeSchema = z.object({ x: finite.positive().max(1e6), y: finite.positive().max(1e6), z: finite.positive().max(1e6) }).strict();
const capturedSizeSchema = z.object({ x: finite.min(0).max(1e6), y: finite.min(0).max(1e6), z: finite.min(0).max(1e6) }).strict();
export const cframeSchema = z.array(coordinate).length(12);
export const boundsSchema = z.object({ min: vectorSchema, max: vectorSchema }).strict().superRefine((value, ctx) => {
  for (const axis of ["x", "y", "z"]) if (value.min[axis] > value.max[axis]) issue(ctx, ["max", axis], "Bounds must be ordered");
});
export const clientSchema = z.object({ clientId: text(128).min(1), generation: z.union([text(128).min(1), count(Number.MAX_SAFE_INTEGER)]) }).strict();
export const placeSchema = z.object({ placeId: count(Number.MAX_SAFE_INTEGER), placeVersion: count(Number.MAX_SAFE_INTEGER).optional(), name: text(128).optional() }).strict();
export const mapScopeSchema = z.object({ placeId: count(Number.MAX_SAFE_INTEGER), ...clientSchema.shape }).strict();
export const attributeSchema = z.object({ name: text(64), value: z.union([text(128), finite, z.boolean()]) }).strict();
const optionalPartFields = {
  shape: text(64).optional(), canTouch: z.boolean().optional(), canQuery: z.boolean().optional(), material: text(64).optional(), collisionGroup: text(128).optional(),
  collidesWithCharacter: z.boolean().optional(),
  linearVelocity: vectorSchema.optional(), angularVelocity: vectorSchema.optional(), tags: z.array(text(128)).max(16).optional(), attributes: z.array(attributeSchema).max(8).optional(),
};
const partFields = { name: text(128), path: text(1024), className: text(64), cframe: cframeSchema, size: capturedSizeSchema, anchored: z.boolean(), canCollide: z.boolean() };
export const capturedPartSchema = z.object({ ...partFields, sourceObjectId: sourceObjectIdSchema, ...optionalPartFields }).strict();
export const legacyCapturedPartSchema = z.object({
  name: text(128), path: text(1024), className: text(64), cframe: z.array(finite).length(12),
  size: legacyVectorSchema.refine((value) => value.x >= 0 && value.y >= 0 && value.z >= 0), anchored: z.boolean(), canCollide: z.boolean(),
}).strict();
const uiEntrySchema = z.object({ name: text(128), path: text(1024), className: text(64), text: text(256).optional() }).strict();
const remoteEntrySchema = z.object({ name: text(128), path: text(1024), className: z.enum(["RemoteEvent", "RemoteFunction", "UnreliableRemoteEvent"]) }).strict();
const uiSchema = z.object({ coverage, truncated: z.boolean(), entries: z.array(uiEntrySchema).max(40) }).strict();
const remotesSchema = z.object({ root: text(1024).min(1), coverage, truncated: z.boolean(), entries: z.array(remoteEntrySchema).max(100) }).strict();
const sceneFields = {
  root: text(1024).min(1), place: placeSchema, player: z.object({ present: z.boolean(), position: legacyVectorSchema.optional() }).strict(),
  coverage, truncated: z.boolean(), visited: count(20000), stopReasons: z.array(text(128)).max(32), ui: uiSchema, atomicSnapshot: z.literal(false),
};
export const legacyCaptureSceneSchema = z.object({ schema: z.literal(1), ...sceneFields, parts: z.array(legacyCapturedPartSchema).max(512), remotes: remotesSchema.optional() }).strict();
export const facetCoverageSchema = z.object({ visited: count(20000), coverage, truncated: z.boolean(), stopReasons: z.array(text(128)).max(32) }).strict().superRefine((value, ctx) => {
  if (value.coverage === "complete" && value.truncated) issue(ctx, ["coverage"], "Truncated facets cannot have complete coverage");
});
export const physicsSchema = z.object({
  gravity: finite.min(0).max(10000).optional(), walkSpeed: finite.min(0).max(1000).optional(), jumpPower: finite.min(0).max(1000).optional(),
  jumpHeight: finite.min(0).max(10000).optional(), useJumpPower: z.boolean().optional(), hipHeight: finite.min(0).max(1000).optional(), bodySize: sizeSchema.optional(),
}).strict();
export const captureSceneSchema = z.object({
  schema: z.literal(2), ...sceneFields, player: z.object({ present: z.boolean(), position: vectorSchema.optional() }).strict(),
  sourceSnapshotId: sourceObjectIdSchema, parts: z.array(capturedPartSchema).max(512), remotes: remotesSchema, physics: physicsSchema.optional(),
  facetCoverage: z.object({ geometry: facetCoverageSchema, ui: facetCoverageSchema, remotes: facetCoverageSchema }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.coverage === "complete" && value.truncated) issue(ctx, ["coverage"], "Truncated scenes cannot have complete coverage");
  if (!unique(value.parts.map((part) => part.sourceObjectId))) issue(ctx, ["parts"], "Source object IDs must be unique within a snapshot");
  const facets = Object.values(value.facetCoverage);
  if (facets.reduce((sum, facet) => sum + facet.visited, 0) !== value.visited) issue(ctx, ["visited"], "Aggregate visits must equal facet visits");
  for (const name of ["ui", "remotes"]) {
    if (value[name].coverage !== value.facetCoverage[name].coverage || value[name].truncated !== value.facetCoverage[name].truncated) issue(ctx, ["facetCoverage", name], "Facet coverage must match its entries");
  }
  if (value.coverage === "complete" && facets.some((facet) => facet.coverage !== "complete")) issue(ctx, ["coverage"], "Partial facets require partial aggregate coverage");
});

export const nativeSampleSchema = z.object({ t: finite.min(0).max(5), cframe: cframeSchema, size: capturedSizeSchema.optional() }).strict();
export const nativeTrackSchema = z.object({
  sourceObjectId: sourceObjectIdSchema, path: text(1024), className: text(64), size: capturedSizeSchema, canCollide: z.boolean(), anchored: z.boolean(), canTouch: z.boolean().optional(),
  samples: z.array(nativeSampleSchema).max(101), unavailable: text(128).min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.samples.length && value.unavailable === undefined) issue(ctx, ["samples"], "Empty tracks require an unavailable reason");
  for (let index = 1; index < value.samples.length; index++) if (value.samples[index].t <= value.samples[index - 1].t) issue(ctx, ["samples", index, "t"], "Sample times must increase strictly");
});
export const motionEventSchema = z.object({
  t: finite.min(0).max(5), kind: z.enum(["health-drop", "death", "respawn"]), objectIds: z.array(sourceObjectIdSchema).max(16),
  amount: finite.min(0).max(1e9).optional(), association: z.literal("spatial-temporal-correlation"),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.objectIds)) issue(ctx, ["objectIds"], "Associated object IDs must be unique");
  if (value.amount !== undefined && value.kind !== "health-drop") issue(ctx, ["amount"], "Only health-drop events carry an amount");
});
export const nativeObservationSchema = z.object({
  schema: z.literal(1), sourceSnapshotId: sourceObjectIdSchema, durationMs: z.number().int().min(100).max(5000), intervalMs: z.number().int().min(50).max(1000),
  clock: z.literal("observation-relative-seconds"), tracks: z.array(nativeTrackSchema).max(16), events: z.array(motionEventSchema).max(64), coverage, truncated: z.boolean(), stopReasons: reasons,
}).strict().superRefine((value, ctx) => {
  if (value.coverage === "complete" && (value.truncated || value.tracks.some((track) => track.unavailable !== undefined))) issue(ctx, ["coverage"], "Unavailable or truncated observations require partial coverage");
  const ids = value.tracks.map((track) => track.sourceObjectId);
  if (!unique(ids)) issue(ctx, ["tracks"], "Observed object IDs must be unique");
  const selected = new Set(ids);
  for (const [index, event] of value.events.entries()) {
    if (event.objectIds.some((id) => !selected.has(id))) issue(ctx, ["events", index, "objectIds"], "Event associations must name observed targets");
    if (event.t > value.durationMs / 1000) issue(ctx, ["events", index, "t"], "Event exceeds the observation window");
  }
  for (const [index, track] of value.tracks.entries()) if (track.samples.some((sample) => sample.t > value.durationMs / 1000)) issue(ctx, ["tracks", index, "samples"], "Sample exceeds the observation window");
});
export const nativeObservationInputSchema = z.object({
  sourceSnapshotId: sourceObjectIdSchema, objectIds: z.array(sourceObjectIdSchema).min(1).max(16).refine(unique, "Object IDs must be unique"),
  durationMs: z.number().int().min(100).max(5000).default(2000), intervalMs: z.number().int().min(50).max(1000).default(100), _maxResultBytes: z.number().int().min(1).max(65536).optional(),
}).strict();
export const probeSampleSchema = z.object({
  column: count(7), row: count(7), origin: vectorSchema, hit: z.boolean(),
  position: vectorSchema.optional(), normal: vectorSchema.optional(), path: text(1024).optional(), className: text(64).optional(), material: text(64).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.hit) {
    for (const key of ["position", "normal"]) if (value[key] === undefined) issue(ctx, [key], "Hits require position and normal");
  } else for (const key of ["position", "normal", "path", "className", "material"]) if (value[key] !== undefined) issue(ctx, [key], "Misses cannot contain hit metadata");
});
const probeCoordinate = finite.min(-1e7).max(1e7);
const probeSize = finite.positive().max(10000);
const probeFields = {
  center: z.object({ x: probeCoordinate, y: probeCoordinate, z: probeCoordinate }).strict(),
  size: z.object({ x: probeSize, y: probeSize, z: probeSize }).strict(),
  columns: z.number().int().min(2).max(8), rows: z.number().int().min(2).max(8),
};
export const nativeProbeSchema = z.object({ schema: z.literal(1), ...probeFields, samples: z.array(probeSampleSchema).max(64), coverage, truncated: z.boolean(), stopReasons: reasons }).strict().superRefine((value, ctx) => {
  const cells = new Set();
  for (const [index, sample] of value.samples.entries()) {
    if (sample.column >= value.columns || sample.row >= value.rows) issue(ctx, ["samples", index], "Probe sample is outside its grid");
    const cell = `${sample.column}:${sample.row}`;
    if (cells.has(cell)) issue(ctx, ["samples", index], "Probe grid cells must be unique");
    cells.add(cell);
  }
  if (value.coverage === "complete" && (value.truncated || value.samples.length !== value.columns * value.rows)) issue(ctx, ["coverage"], "Complete coverage requires every requested grid ray");
});
export const nativeProbeInputSchema = z.object({
  center: probeFields.center, size: probeFields.size, columns: probeFields.columns.default(4), rows: probeFields.rows.default(4),
  maxDistance: finite.positive().max(10000).default(256), _maxResultBytes: z.number().int().min(1).max(32768).optional(),
}).strict();

export const profileSchema = z.object({
  walkSpeed: finite.positive().max(1000), jumpVelocity: finite.min(0).max(1000), gravity: finite.positive().max(10000), radius: finite.positive().max(100),
  height: finite.positive().max(1000), maxSlopeDegrees: finite.min(0).max(89), maxDropHeight: finite.min(0).max(10000), stepHeight: finite.min(0).max(1000), landingMargin: finite.min(0).max(100),
}).strict();
export const probeProvenanceSchema = z.object({ batchId: sourceObjectIdSchema, column: count(7), row: count(7) }).strict();
export const mapPartSchema = z.object({
  id: rowId, sourceKey: text(512).min(1), sourceContextId: contextIdSchema.optional(), sourceSnapshotId: sourceObjectIdSchema.optional(), sourceObjectId: sourceObjectIdSchema.optional(),
  capturedAt: timestamp.optional(), observedAt: timestamp.optional(), probe: probeProvenanceSchema.optional(),
  ...partFields, name: text(128).optional(), path: text(1024).optional(), className: text(64).optional(), anchored: z.boolean().optional(), canCollide: z.boolean().optional(),
  size: sizeSchema, ...optionalPartFields, bounds: boundsSchema, geometry, sourceIdentity: z.enum(["retained-instance", "capture-row", "probe-sample"]),
}).strict().superRefine((value, ctx) => {
  if (value.sourceIdentity === "probe-sample") {
    for (const key of ["probe", "observedAt"]) if (value[key] === undefined) issue(ctx, [key], "Probe samples require observation provenance");
    for (const key of ["sourceContextId", "capturedAt", "sourceSnapshotId", "sourceObjectId", "anchored", "canCollide", "canTouch", "canQuery", "collidesWithCharacter", "collisionGroup", "linearVelocity", "angularVelocity", "shape", "tags", "attributes"]) if (value[key] !== undefined) issue(ctx, [key], "Ray samples do not establish source identity or object physics");
    if (value.geometry !== "sampled") issue(ctx, ["geometry"], "Probe samples require sampled geometry");
  } else {
    for (const key of ["sourceContextId", "capturedAt", "name", "path", "className", "anchored", "canCollide"]) if (value[key] === undefined) issue(ctx, [key], "Captured parts require capture metadata");
    for (const key of ["probe", "observedAt"]) if (value[key] !== undefined) issue(ctx, [key], "Captured parts cannot claim probe provenance");
    if (value.sourceIdentity === "retained-instance" && (value.sourceSnapshotId === undefined || value.sourceObjectId === undefined)) issue(ctx, ["sourceIdentity"], "Retained identity requires snapshot and object IDs");
    if (value.sourceIdentity === "capture-row" && (value.sourceSnapshotId !== undefined || value.sourceObjectId !== undefined)) issue(ctx, ["sourceIdentity"], "Capture-local identity cannot claim retained bindings");
  }
  let key;
  try { key = JSON.parse(value.sourceKey); } catch { issue(ctx, ["sourceKey"], "Source keys must encode bounded identity tuples"); return; }
  if (!Array.isArray(key) || !clientSchema.safeParse({ clientId: key[0], generation: key[1] }).success) { issue(ctx, ["sourceKey"], "Source keys require exact client and generation scope"); return; }
  const valid = value.sourceIdentity === "retained-instance" ? key.length === 3 && key[2] === value.sourceObjectId
    : value.sourceIdentity === "capture-row" ? key.length === 4 && key[2] === value.sourceContextId && Number.isSafeInteger(key[3]) && key[3] >= 0 && key[3] < 512
      : key.length === 5 && key[2] === value.probe?.batchId && key[3] === value.probe?.column && key[4] === value.probe?.row;
  if (!valid) issue(ctx, ["sourceKey"], "Source key must match the part's truthful identity variant");
});
export const surfaceSchema = z.object({ id: rowId, partId: rowId, supportMode: supportModeSchema.optional(), center: vectorSchema, normal: vectorSchema, vertices: z.array(vectorSchema).min(3).max(4), bounds: boundsSchema, geometry, standable: z.enum(["modeled", "candidate"]), reasons: rowReasons }).strict();
export const chunkSchema = z.object({
  id: rowId, cell: z.object({ x: z.number().int().min(-1e9).max(1e9), y: z.number().int().min(-1e9).max(1e9), z: z.number().int().min(-1e9).max(1e9) }).strict(),
  bounds: boundsSchema, partIds: z.array(rowId).max(1024), surfaceIds: z.array(rowId).max(2048), coverage: z.literal("observed-content-only"),
}).strict();
export const timeWindowSchema = z.object({ start: seconds, end: seconds }).strict().superRefine((value, ctx) => {
  if (value.end < value.start) issue(ctx, ["end"], "Time windows must be ordered");
});
export const linkSchema = z.object({
  id: rowId, from: rowId, to: rowId, action: z.enum(["walk", "jump", "drop", "ride", "wait", "mode-switch"]), takeoff: vectorSchema, landing: vectorSchema,
  fromMode: supportModeSchema.optional(), toMode: supportModeSchema.optional(), transitionId: rowId.optional(),
  duration: finite.min(0).max(3600).nullable(), status: z.enum(["modeled", "candidate"]), reasons: rowReasons, windows: z.array(timeWindowSchema).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "mode-switch") {
    if (value.duration !== null) issue(ctx, ["duration"], "Unmeasured mode switches have unknown duration");
    if (value.status !== "candidate") issue(ctx, ["status"], "User reports do not establish a modeled transfer trajectory");
    if (value.fromMode === undefined || value.toMode === undefined || value.fromMode === value.toMode) issue(ctx, ["toMode"], "Mode switches require distinct explicit support modes");
    if (value.transitionId === undefined) issue(ctx, ["transitionId"], "Mode switches require an explicit report");
    if (value.windows !== undefined) issue(ctx, ["windows"], "Unmeasured mode switches cannot claim timing windows");
  } else {
    if (value.duration === null || (value.fromMode !== undefined && value.duration <= 0)) issue(ctx, ["duration"], "Ordinary movement must have a positive modeled duration");
    if (value.fromMode !== value.toMode) issue(ctx, ["toMode"], "Ordinary movement must preserve support mode");
    if (value.transitionId !== undefined) issue(ctx, ["transitionId"], "Only mode switches may reference reports");
  }
});
export const trackSampleSchema = z.object({ t: seconds, cframe: cframeSchema, size: sizeSchema.optional() }).strict();
export const recordingProjectionSchema = z.object({
  kind: z.literal("continuous-recording"), recordingId: recordingIdSchema, clock: z.literal("client-monotonic-seconds"), startedAt: finite.min(0).max(Number.MAX_SAFE_INTEGER),
  sourceSampleCount: z.number().int().min(1).max(1201), selectedSampleCount: z.number().int().min(1).max(101),
  sourceMaxGap: seconds, selectedMaxGap: seconds, decimated: z.boolean(),
  sourceMatchesCapturedGeometry: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.selectedSampleCount > value.sourceSampleCount) issue(ctx, ["selectedSampleCount"], "A model projection cannot invent source samples");
  if (value.decimated !== (value.selectedSampleCount < value.sourceSampleCount)) issue(ctx, ["decimated"], "Projection metadata must disclose every omitted source sample");
  if (value.selectedMaxGap < value.sourceMaxGap) issue(ctx, ["selectedMaxGap"], "A projection cannot claim denser coverage than its full source");
});
export const trackSchema = z.object({
  id: rowId, partId: rowId, model: z.enum(["stationary", "linear", "periodic", "unknown"]), samples: z.array(trackSampleSchema).max(101), size: sizeSchema,
  sampleStart: seconds, sampleEnd: seconds, velocity: vectorSchema.optional(), period: finite.positive().max(60).optional(), sweptBounds: boundsSchema, uncertainty: reasons, observedAt: timestamp,
  projection: recordingProjectionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sampleEnd < value.sampleStart) issue(ctx, ["sampleEnd"], "Sample window must be ordered");
  if (value.model === "periodic" && value.period === undefined) issue(ctx, ["period"], "Periodic models require a period");
  if (value.model !== "periodic" && value.period !== undefined) issue(ctx, ["period"], "Only periodic models have a period");
  if (value.projection && value.projection.selectedSampleCount !== value.samples.length) issue(ctx, ["projection", "selectedSampleCount"], "Projection counts must describe the retained model samples");
  for (let index = 0; index < value.samples.length; index++) {
    const sample = value.samples[index];
    if (sample.t < value.sampleStart || sample.t > value.sampleEnd) issue(ctx, ["samples", index, "t"], "Sample is outside its recorded window");
    if (index > 0 && sample.t <= value.samples[index - 1].t) issue(ctx, ["samples", index, "t"], "Sample times must increase strictly");
  }
});
export const trackSummarySchema = z.object({
  id: rowId, partId: rowId, model: trackSchema.shape.model, sampleCount: count(101), sampleStart: seconds, sampleEnd: seconds,
  observedAt: timestamp, maxGap: seconds, uncertainty: reasons, period: finite.positive().max(60).optional(), velocity: vectorSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sampleEnd < value.sampleStart) issue(ctx, ["sampleEnd"], "Summary sample windows must be ordered");
  if ((value.model === "periodic") !== (value.period !== undefined)) issue(ctx, ["period"], "Only periodic summaries require a period");
  if (value.maxGap > value.sampleEnd - value.sampleStart) issue(ctx, ["maxGap"], "Sample gaps cannot exceed the recorded window");
});
export const hazardEvidenceSchema = z.object({ kind: text(64), detail: text(256), t: seconds.optional(), observedAt: timestamp.optional(), recordingId: recordingIdSchema.optional() }).strict().superRefine((value, ctx) => {
  if (value.recordingId !== undefined && (value.kind !== "spatial-temporal-correlation" || value.t === undefined || value.observedAt === undefined)) issue(ctx, ["recordingId"], "Continuous hazard correlations require native time and archived receipt provenance");
});
export const hazardSchema = z.object({ id: rowId, partId: rowId, level: z.enum(["hint", "correlated", "unknown"]), kinds: z.array(text(64)).max(16), evidence: z.array(hazardEvidenceSchema).max(128), bounds: boundsSchema }).strict();
export const mapRowSchemas = Object.freeze({ parts: mapPartSchema, surfaces: surfaceSchema, chunks: chunkSchema, links: linkSchema, tracks: trackSchema, hazards: hazardSchema });
const rowCaps = { parts: 1024, surfaces: 2048, chunks: 256, links: 4096, tracks: 128, hazards: 1024 };
export const mapModelSchema = z.object({
  ...Object.fromEntries(Object.entries(mapRowSchemas).map(([name, schema]) => [name, z.array(schema).max(rowCaps[name])])),
  coverage: partial, stopReasons: reasons, warnings: reasons, profile: profileSchema, profileSource, timeOrigin: timestamp.optional(), mechanics: mapMechanicsSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const ids = Object.fromEntries(Object.keys(mapRowSchemas).map((name) => [name, new Set(value[name].map((row) => row.id))]));
  for (const name of Object.keys(mapRowSchemas)) if (ids[name].size !== value[name].length) issue(ctx, [name], "Row IDs must be unique within their section");
  for (const name of ["surfaces", "tracks", "hazards"]) for (const [index, row] of value[name].entries()) if (!ids.parts.has(row.partId)) issue(ctx, [name, index, "partId"], "Referenced part does not exist");
  for (const [index, row] of value.links.entries()) if (!ids.surfaces.has(row.from) || !ids.surfaces.has(row.to)) issue(ctx, ["links", index], "Referenced surface does not exist");
  for (const [index, row] of value.chunks.entries()) {
    if (!unique(row.partIds) || row.partIds.some((id) => !ids.parts.has(id))) issue(ctx, ["chunks", index, "partIds"], "Chunk parts must be unique existing rows");
    if (!unique(row.surfaceIds) || row.surfaceIds.some((id) => !ids.surfaces.has(id))) issue(ctx, ["chunks", index, "surfaceIds"], "Chunk surfaces must be unique existing rows");
  }
  const surfaces = new Map(value.surfaces.map((surface) => [surface.id, surface]));
  const transitions = new Map((value.mechanics?.transitions ?? []).map((transition) => [transition.id, transition]));
  for (const [index, transition] of (value.mechanics?.transitions ?? []).entries()) if (!ids.parts.has(transition.partId)) issue(ctx, ["mechanics", "transitions", index, "partId"], "Reported transitions must name an exact retained part");
  for (const [index, row] of value.links.entries()) {
    const fromMode = surfaces.get(row.from)?.supportMode ?? "floor", toMode = surfaces.get(row.to)?.supportMode ?? "floor";
    if ((row.fromMode ?? "floor") !== fromMode || (row.toMode ?? "floor") !== toMode) issue(ctx, ["links", index], "Link modes must match their actual endpoint surfaces");
    if (row.action !== "mode-switch" && fromMode !== toMode) issue(ctx, ["links", index], "Ordinary movement cannot cross support modes");
    if (row.action === "mode-switch") {
      const transition = transitions.get(row.transitionId);
      if (!transition || transition.fromMode !== fromMode || transition.toMode !== toMode) issue(ctx, ["links", index, "transitionId"], "Cross-mode links must match an explicit report");
    }
  }
});
export const captureSourceSchema = z.object({
  contextId: contextIdSchema, capturedAt: timestamp, client: clientSchema, place: placeSchema, root: text(1024).min(1), coverage, truncated: z.boolean(), sha256: sha256Schema,
  scene: z.union([legacyCaptureSceneSchema, captureSceneSchema]),
}).strict().superRefine((value, ctx) => {
  if (value.root !== value.scene.root || value.place.placeId !== value.scene.place.placeId || value.coverage !== value.scene.coverage || value.truncated !== value.scene.truncated) issue(ctx, ["scene"], "Source metadata must match its verified scene");
});
export const observationBatchSchema = z.object({ observedAt: timestamp, client: clientSchema, data: nativeObservationSchema }).strict();
export const probeBatchSchema = z.object({ observedAt: timestamp, client: clientSchema, data: nativeProbeSchema }).strict();
export const sourceHashSchema = z.object({ contextId: contextIdSchema, sha256: sha256Schema }).strict();
export const mapRecordSchema = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]), mapId: mapIdSchema, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), parentMapId: mapIdSchema.optional(), createdAt: timestamp,
  sourceContextIds: z.array(contextIdSchema).min(1).max(32), sourceHashes: z.array(sourceHashSchema).min(1).max(32), scope: mapScopeSchema,
  chunkSize: finite.min(16).max(256),
  sources: z.array(captureSourceSchema).min(1).max(32), observations: z.array(observationBatchSchema).max(8), probes: z.array(probeBatchSchema).max(8), model: mapModelSchema,
  recordings: z.array(recordingEvidenceSchema).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.parentMapId === value.mapId || (value.parentMapId === undefined ? value.revision !== 1 : value.revision < 2)) issue(ctx, ["revision"], "Revision and immutable parent identity disagree");
  if (!unique(value.sourceContextIds) || value.sourceContextIds.length !== value.sources.length || value.sourceHashes.length !== value.sources.length) issue(ctx, ["sourceContextIds"], "Source IDs, hashes, and DTOs must align uniquely");
  for (const [index, source] of value.sources.entries()) {
    if (value.sourceContextIds[index] !== source.contextId || value.sourceHashes[index]?.contextId !== source.contextId || value.sourceHashes[index]?.sha256 !== source.sha256) issue(ctx, ["sources", index], "Source IDs and hashes must match retained DTOs in order");
    if (source.place.placeId !== value.scope.placeId || !sameClient(source.client, value.scope)) issue(ctx, ["sources", index], "Source scope differs from map scope");
  }
  const sources = new Map(value.sources.map((source) => [source.contextId, source]));
  for (const [index, part] of value.model.parts.entries()) {
    const path = ["model", "parts", index];
    let key;
    try { key = JSON.parse(part.sourceKey); } catch { issue(ctx, [...path, "sourceKey"], "Source key is invalid"); continue; }
    if (!Array.isArray(key) || key[0] !== value.scope.clientId || key[1] !== value.scope.generation) issue(ctx, [...path, "sourceKey"], "Part scope differs from map scope");
    if (part.sourceIdentity === "probe-sample") {
      if (!value.probes.some((batch) => batch.observedAt === part.observedAt && batch.data.samples.some((sample) => sample.hit && sample.column === part.probe?.column && sample.row === part.probe?.row))) issue(ctx, [...path, "probe"], "Probe provenance must name a retained hit sample");
      continue;
    }
    const source = sources.get(part.sourceContextId);
    if (!source || source.capturedAt !== part.capturedAt) issue(ctx, [...path, "sourceContextId"], "Part must belong to its retained capture");
    else if (part.sourceIdentity === "retained-instance" && (source.scene.schema !== 2 || source.scene.sourceSnapshotId !== part.sourceSnapshotId || !source.scene.parts.some((row) => row.sourceObjectId === part.sourceObjectId))) issue(ctx, [...path, "sourceObjectId"], "Retained identity must match its exact captured snapshot");
    else if (part.sourceIdentity === "capture-row" && (source.scene.schema !== 1 || !Array.isArray(key) || key[3] >= source.scene.parts.length)) issue(ctx, [...path, "sourceKey"], "Capture-local identity must name its legacy source row");
  }
  const snapshots = new Map(value.sources.filter((source) => source.scene.schema === 2).map((source) => [source.scene.sourceSnapshotId, new Set(source.scene.parts.map((part) => part.sourceObjectId))]));
  for (const [index, batch] of value.observations.entries()) {
    if (!sameClient(batch.client, value.scope)) issue(ctx, ["observations", index, "client"], "Observation scope differs from map scope");
    const objects = snapshots.get(batch.data.sourceSnapshotId);
    if (!objects || batch.data.tracks.some((track) => !objects.has(track.sourceObjectId))) issue(ctx, ["observations", index, "data"], "Observation must bind retained source objects");
  }
  for (const [index, batch] of value.probes.entries()) if (!sameClient(batch.client, value.scope)) issue(ctx, ["probes", index, "client"], "Probe scope differs from map scope");
  if (value.schema === 3 && value.recordings === undefined) issue(ctx, ["recordings"], "Schema 3 records explicitly retain their continuous evidence archives");
  if (value.schema !== 3 && value.recordings !== undefined) issue(ctx, ["recordings"], "Legacy record formats cannot claim continuous recording archives");
  const recordings = new Map((value.recordings ?? []).map((recording) => [recording.recordingId, recording]));
  if (recordings.size !== (value.recordings?.length ?? 0)) issue(ctx, ["recordings"], "Archived recording identities must be unique");
  for (const [index, recording] of (value.recordings ?? []).entries()) {
    if (!sameClient(recording.client, value.scope)) issue(ctx, ["recordings", index, "client"], "Continuous recording scope must exactly match its immutable map");
    for (const [targetIndex, target] of recording.metadata.targets.entries()) if (!snapshots.get(target.sourceSnapshotId)?.has(target.sourceObjectId)) issue(ctx, ["recordings", index, "metadata", "targets", targetIndex], "Recording targets must bind their exact retained historical capture, not paths or replacement objects");
  }
  const parts = new Map(value.model.parts.map((part) => [part.id, part]));
  for (const [index, track] of value.model.tracks.entries()) {
    if (!track.projection) continue;
    const recording = recordings.get(track.projection.recordingId), part = parts.get(track.partId);
    if (!recording || part?.sourceIdentity !== "retained-instance" || !recording.metadata.targets.some((target) => target.sourceObjectId === part.sourceObjectId)) issue(ctx, ["model", "tracks", index, "projection"], "Model projections require the full archived evidence for the same scoped native object");
    else if (track.projection.startedAt !== recording.metadata.startedAt || track.projection.sourceSampleCount !== recording.frames.length || track.observedAt !== recording.receivedAt) issue(ctx, ["model", "tracks", index, "projection"], "Projection clock, source counts, and host receipt provenance must match the unabridged archive");
    else if (track.projection.sourceMatchesCapturedGeometry !== undefined) {
      const matches = recording.frames.every((frame) => {
        const sample = frame.samples.find((entry) => entry.sourceObjectId === part.sourceObjectId);
        return sample !== undefined && sample.cframe.every((component, componentIndex) => component === part.cframe[componentIndex])
          && sample.size.x === part.size.x && sample.size.y === part.size.y && sample.size.z === part.size.z;
      });
      if (track.projection.sourceMatchesCapturedGeometry !== matches) issue(ctx, ["model", "tracks", index, "projection", "sourceMatchesCapturedGeometry"], "Captured-geometry agreement must include every full-source frame, not only selected model samples");
    }
  }
  for (const [index, hazard] of value.model.hazards.entries()) for (const [evidenceIndex, evidence] of hazard.evidence.entries()) {
    if (evidence.recordingId === undefined) continue;
    const recording = recordings.get(evidence.recordingId), part = parts.get(hazard.partId);
    if (!recording || part?.sourceIdentity !== "retained-instance" || evidence.observedAt !== recording.receivedAt || !recording.metadata.targets.some((target) => target.sourceObjectId === part.sourceObjectId)
      || !recording.events.some((event) => event.t === evidence.t && event.objectIds?.includes(part.sourceObjectId))) issue(ctx, ["model", "hazards", index, "evidence", evidenceIndex], "Continuous hazard correlations must reference the exact native event and scoped object in the retained archive");
  }
  if (value.schema >= 2) {
    if (value.model.mechanics === undefined) issue(ctx, ["model", "mechanics"], "Schema 2 and 3 records require explicit mechanics");
    for (const [index, surface] of value.model.surfaces.entries()) {
      if (surface.supportMode === undefined || !value.model.mechanics?.supportModes.includes(surface.supportMode)) issue(ctx, ["model", "surfaces", index, "supportMode"], "New surfaces require an enabled explicit support mode");
      else if (surface.normal.y * (surface.supportMode === "floor" ? 1 : -1) <= 0) issue(ctx, ["model", "surfaces", index, "normal"], "Support normals must face their declared signed up direction");
    }
    for (const [index, link] of value.model.links.entries()) {
      if (link.fromMode === undefined || link.toMode === undefined) issue(ctx, ["model", "links", index], "New links require explicit endpoint support modes");
      if (link.action !== "mode-switch" && !(link.duration > 0)) issue(ctx, ["model", "links", index, "duration"], "New ordinary links require positive modeled durations");
    }
    for (const [index, transition] of (value.model.mechanics?.transitions ?? []).entries()) if (Date.parse(transition.evidence.reportedAt) > Date.parse(value.createdAt)) issue(ctx, ["model", "mechanics", "transitions", index, "evidence", "reportedAt"], "Reports cannot postdate the retained revision");
  } else {
    if (value.model.mechanics !== undefined) issue(ctx, ["model", "mechanics"], "Legacy records cannot claim new mechanics");
    for (const [index, surface] of value.model.surfaces.entries()) if ((surface.supportMode ?? "floor") !== "floor") issue(ctx, ["model", "surfaces", index, "supportMode"], "Legacy surfaces are floor supports");
  }
});

export const mapCountsSchema = z.object(Object.fromEntries(Object.entries(rowCaps).map(([name, maximum]) => [name, count(maximum)]))).strict();
const summaryFields = {
  mapId: mapIdSchema, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), parentMapId: mapIdSchema.optional(), createdAt: timestamp,
  sourceContextIds: z.array(contextIdSchema).min(1).max(32), counts: mapCountsSchema, scope: mapScopeSchema, coverage: partial, profileSource, stopReasons: reasons, warnings: reasons,
  chunkSize: finite.min(16).max(256),
};
export const mapSummarySchema = z.object(summaryFields).strict().superRefine((value, ctx) => {
  if (!unique(value.sourceContextIds)) issue(ctx, ["sourceContextIds"], "Source IDs must be unique");
  if (value.parentMapId === value.mapId || (value.parentMapId === undefined ? value.revision !== 1 : value.revision < 2)) issue(ctx, ["revision"], "Revision and immutable parent identity disagree");
});
export const mapListEntrySchema = z.object({
  mapId: summaryFields.mapId, revision: summaryFields.revision, parentMapId: summaryFields.parentMapId,
  createdAt: summaryFields.createdAt, counts: mapCountsSchema, coverage: partial,
}).strict().superRefine((value, ctx) => {
  if (value.parentMapId === value.mapId || (value.parentMapId === undefined ? value.revision !== 1 : value.revision < 2)) issue(ctx, ["revision"], "Revision and immutable parent identity disagree");
});
export const routeSchema = z.object({
  status: z.enum(["found", "unreachable", "insufficient-evidence"]), steps: z.array(linkSchema).max(4096), timing: z.enum(["modeled", "unknown"]),
  duration: finite.min(0).max(1e9).nullable(), arrival: finite.min(0).max(1e9).nullable(), reasons,
}).strict().superRefine((value, ctx) => {
  if (value.status !== "found" && value.steps.length) issue(ctx, ["steps"], "Unsuccessful routes cannot contain a usable path");
  if (value.timing === "unknown") {
    if (value.duration !== null || value.arrival !== null) issue(ctx, ["timing"], "Unknown route timing requires null duration and arrival");
  } else {
    if (value.duration === null || value.arrival === null) issue(ctx, ["timing"], "Modeled routes require numeric timing");
    else if (value.arrival < value.duration) issue(ctx, ["arrival"], "Arrival cannot precede the route duration");
    if (value.steps.some((step) => step.duration === null)) issue(ctx, ["steps"], "Unmeasured mode switches cannot produce numeric route timing");
  }
});
const managementViews = ["build", "update", "observe", "probe", "read", "list", "release", "image"];
const geometrySections = ["parts", "surfaces", "chunks"];
const navigationSections = ["links"];
const motionSections = ["tracks", "hazards"];
const sectionSchema = z.enum(["summary", ...geometrySections, ...navigationSections, ...motionSections]);
const readQueryFields = {
  ids: z.array(rowId).min(1).max(16).optional(), bounds: boundsSchema.optional(), supportMode: supportModeSchema.optional(),
  from: rowId.optional(), to: rowId.optional(), action: linkSchema.shape.action.optional(), partId: rowId.optional(),
};
export const mapReadQuerySchema = z.object(readQueryFields).strict();
export const mapReadCursorSchema = z.string().max(81).regex(/^[a-f0-9]{64}:(?:0|[1-9][0-9]{0,15})(?![\s\S])/).refine((value) => Number.isSafeInteger(Number(value.slice(65))), "Cursor offsets must be safe integers");
const geometryQuerySchema = z.object({ ids: readQueryFields.ids, bounds: readQueryFields.bounds, supportMode: readQueryFields.supportMode }).strict();
const navigationQuerySchema = z.object({ ids: readQueryFields.ids, supportMode: readQueryFields.supportMode, from: readQueryFields.from, to: readQueryFields.to, action: readQueryFields.action }).strict();
const motionQuerySchema = z.object({ ids: readQueryFields.ids, partId: readQueryFields.partId }).strict();
function validateReadQuery(value, ctx, section) {
  if (!value.query) return;
  const allowed = section === "surfaces" ? ["ids", "bounds", "supportMode"] : geometrySections.includes(section) ? ["ids", "bounds"]
    : section === "links" ? ["ids", "from", "to", "action", "supportMode"] : ["ids", "partId"];
  for (const key of Object.keys(value.query)) if (value.query[key] !== undefined && !allowed.includes(key)) issue(ctx, ["query", key], "Selector is incompatible with the selected row section");
}
const viewKeys = {
  build: ["contextIds", "profile", "chunkSize"], update: ["mapId", "contextIds", "profile"], observe: ["mapId", "objectIds", "durationMs", "intervalMs"],
  probe: ["mapId", "center", "size", "columns", "rows", "maxDistance"], read: ["mapId", "section", "offset", "limit", "query", "cursor", "presentation"],
  summary: ["mapId", "section", "offset", "limit", "query", "cursor"], list: [], release: ["mapId"], image: ["mapId", "minY", "maxY"], route: ["mapId", "from", "to", "departure", "allowUncertain"],
};
const requiredInput = { build: ["contextIds"], update: ["mapId", "contextIds"], observe: ["mapId", "objectIds"], probe: ["mapId", "center", "size"], read: ["mapId"], summary: ["mapId"], list: [], release: ["mapId"], image: ["mapId"], route: ["mapId", "from", "to"] };
function validateOperationInput(value, ctx, defaultSection = "summary") {
  const allowed = new Set(["view", ...viewKeys[value.view]]);
  if (value.view === "observe" || value.view === "probe") allowed.add("clientId");
  for (const key of Object.keys(value)) if (!allowed.has(key) && value[key] !== undefined) issue(ctx, [key], "Field is not allowed for this view");
  for (const key of requiredInput[value.view]) if (value[key] === undefined) issue(ctx, [key], "Required for this view");
  if (value.minY !== undefined && value.maxY !== undefined && value.minY > value.maxY) issue(ctx, ["maxY"], "Y bounds must be ordered");
  const section = value.section ?? (value.view === "summary" ? "tracks" : defaultSection);
  if (value.view === "read" && section === "summary") for (const key of ["offset", "limit", "query", "cursor", "presentation"]) if (value[key] !== undefined) issue(ctx, [key], "Map summaries do not accept row selectors or projections");
  if (value.view === "read" || value.view === "summary") {
    validateReadQuery(value, ctx, section);
    if ((value.view === "summary" || value.presentation === "summary") && section !== "tracks") issue(ctx, ["section"], "Compact summaries project tracks only");
    if (value.query !== undefined && value.offset !== undefined && value.offset !== 0) issue(ctx, ["offset"], "Filtered reads start at zero or continue with their bound cursor");
    if (value.cursor !== undefined && value.offset !== undefined) issue(ctx, ["offset"], "Cursor reads cannot also provide an offset");
    if (value.cursor !== undefined && value.query === undefined && value.presentation === undefined && value.view !== "summary") issue(ctx, ["cursor"], "Cursors require the same query or projection as the original read");
    if ((value.view === "summary" || value.presentation !== undefined) && value.offset !== undefined && value.offset !== 0) issue(ctx, ["offset"], "Projected reads start at zero or continue with their bound cursor");
  }
}
const paginationInputFields = {
  offset: count(Number.MAX_SAFE_INTEGER).optional().meta({ default: 0 }), limit: z.number().int().min(1).max(100).optional().meta({ default: 20 }),
};
const routeInputFields = {
  from: rowId.optional(), to: rowId.optional(), departure: seconds.optional().meta({ default: 0 }), allowUncertain: z.boolean().optional().meta({ default: false }),
};
const managementInputFields = {
  view: z.enum(managementViews).default("build"), contextIds: z.array(contextIdSchema).min(1).max(8).refine(unique, "Context IDs must be unique").optional(), mapId: mapIdSchema.optional(),
  profile: profileSchema.optional(), chunkSize: finite.min(16).max(256).optional().meta({ default: 64 }), section: z.literal("summary").optional().meta({ default: "summary" }),
  objectIds: z.array(rowId).min(1).max(16).refine(unique, "Part IDs must be unique").optional(), durationMs: z.number().int().min(100).max(5000).optional().meta({ default: 2000 }), intervalMs: z.number().int().min(50).max(1000).optional().meta({ default: 100 }),
  center: probeFields.center.optional(), size: probeFields.size.optional(), columns: probeFields.columns.optional().meta({ default: 4 }), rows: probeFields.rows.optional().meta({ default: 4 }), maxDistance: finite.positive().max(10000).optional().meta({ default: 256 }),
  minY: coordinate.optional(), maxY: coordinate.optional(),
};
export const mapOperationInputSchema = z.object({
  ...managementInputFields, view: z.enum([...managementViews, "route"]).default("build"),
  section: sectionSchema.optional().meta({ default: "summary" }), ...paginationInputFields, ...routeInputFields,
  query: mapReadQuerySchema.optional(), cursor: mapReadCursorSchema.optional(), presentation: z.enum(["full", "summary"]).optional(),
}).strict().superRefine(validateOperationInput);
export const mapContextInputSchema = z.object(managementInputFields).strict().superRefine(validateOperationInput);
export const mapGeometryInputSchema = z.object({
  view: z.literal("read").default("read"), mapId: mapIdSchema, section: z.enum(geometrySections).default("parts"), ...paginationInputFields,
  query: geometryQuerySchema.optional(), cursor: mapReadCursorSchema.optional(),
}).strict().superRefine(validateOperationInput);
export const mapNavigationInputSchema = z.object({
  view: z.enum(["read", "route"]).default("read"), mapId: mapIdSchema,
  section: z.literal("links").optional().meta({ default: "links" }), ...paginationInputFields, ...routeInputFields,
  query: navigationQuerySchema.optional(), cursor: mapReadCursorSchema.optional(),
}).strict().superRefine((value, ctx) => validateOperationInput(value, ctx, "links"));
export const mapMotionInputSchema = z.object({
  view: z.enum(["read", "summary"]).default("read"), mapId: mapIdSchema, section: z.enum(motionSections).default("tracks"),
  ...paginationInputFields, query: motionQuerySchema.optional(), cursor: mapReadCursorSchema.optional(),
}).strict().superRefine((value, ctx) => validateOperationInput(value, ctx, "tracks"));
export const mapMechanicsInputSchema = z.object({
  view: z.enum(["read", "apply"]).default("read"), mapId: mapIdSchema,
  supportModes: supportModesSchema.optional(), transitions: z.array(transitionInputSchema).max(16).optional(),
}).strict().superRefine((value, ctx) => {
  for (const key of ["supportModes", "transitions"]) {
    if (value.view === "apply" && value[key] === undefined) issue(ctx, [key], "Apply requires complete replacement mechanics");
    if (value.view === "read" && value[key] !== undefined) issue(ctx, [key], "Read does not accept mechanics changes");
  }
  validateMechanics(value, ctx);
});
export const mapMechanicsOutputSchema = z.object({
  view: z.enum(["read", "apply"]), mapId: mapIdSchema, revision: summaryFields.revision, parentMapId: mapIdSchema.optional(),
  mechanics: mapMechanicsSchema, coverage: partial, warnings: reasons,
}).strict().superRefine((value, ctx) => {
  if (value.parentMapId === value.mapId || (value.parentMapId === undefined ? value.revision !== 1 : value.revision < 2)) issue(ctx, ["revision"], "Revision and immutable parent identity disagree");
});

export const mapRenderingSchema = z.object({
  coverage: partial, selectedParts: count(512), unrenderedParts: count(1024), selectedPrimitives: count(512), unrenderedPrimitives: count(110000), omittedLabels: count(512),
  warnings: z.array(text(128)).max(3), minY: coordinate.optional(), maxY: coordinate.optional(),
  selectedLinkPaths: count(4096).optional(), representedLinks: count(4096).optional(), representedTimeOpportunities: count(524288).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.minY !== undefined && value.maxY !== undefined && value.minY > value.maxY) issue(ctx, ["maxY"], "Y bounds must be ordered");
});
export const mapImageSchema = z.object({
  mimeType: z.literal("image/jpeg"), bytes: z.number().int().min(1).max(128 * 1024), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
  sha256: sha256Schema, provider: text(96).min(1), rendering: mapRenderingSchema,
}).strict();
const optionalSummaryFields = Object.fromEntries(Object.entries(summaryFields).map(([key, schema]) => [key, schema.optional()]));
const routeFields = routeSchema.shape;
const optionalRouteFields = Object.fromEntries(Object.entries(routeFields).map(([key, schema]) => [key, schema.optional()]));
const requiredSummary = Object.keys(summaryFields).filter((key) => key !== "parentMapId");
const pageFields = ["mapId", "revision", "section", "offset", "total", "entries", "coverage", "warnings"];
const outputKeys = {
  build: Object.keys(summaryFields), update: Object.keys(summaryFields), observe: Object.keys(summaryFields), probe: Object.keys(summaryFields),
  read: [...Object.keys(summaryFields), "section"], list: ["maps"], release: ["mapId", "released"], image: ["mapId", "revision", "coverage", "warnings", "image"],
};
function validateOutputKeys(value, ctx, allowed, required = allowed) {
  const keys = new Set(["view", ...allowed]);
  for (const key of Object.keys(value)) if (!keys.has(key) && value[key] !== undefined) issue(ctx, [key], "Field is not allowed for this view");
  for (const key of required) if (value[key] === undefined) issue(ctx, [key], "Required for this view");
}
function validatePage(value, ctx) {
  const projected = value.view === "summary" || value.presentation === "summary";
  const rowSchema = projected && value.section === "tracks" ? trackSummarySchema : mapRowSchemas[value.section];
  const cursorPage = value.query !== undefined || value.presentation !== undefined || projected;
  validateReadQuery(value, ctx, value.section);
  if (projected && value.section !== "tracks") issue(ctx, ["section"], "Summary entries are explicitly projected track rows");
  if (value.view === "summary" && value.presentation !== "summary") issue(ctx, ["presentation"], "Track summaries must be explicitly labeled projections");
  if (value.view === "read" && value.presentation === "summary") issue(ctx, ["view"], "Public compact track pages use the summary view");
  if (value.query?.ids && (!unique(value.query.ids) || value.query.ids.some((id, index) => index > 0 && id < value.query.ids[index - 1]))) issue(ctx, ["query", "ids"], "Returned query IDs must be normalized, sorted, and unique");
  if (cursorPage && value.totalMatched === undefined) issue(ctx, ["totalMatched"], "Selected pages must expose the complete matched-row count");
  if (value.totalMatched !== undefined && value.totalMatched !== value.total) issue(ctx, ["totalMatched"], "Page totals describe the matched selection, not the unfiltered section");
  if (value.totalAvailable !== undefined && (value.totalAvailable < value.total || value.totalAvailable > rowCaps[value.section])) issue(ctx, ["totalAvailable"], "Available totals must bound the matched selection within its section");
  if (!rowSchema) issue(ctx, ["section"], "Row reads require a typed section");
  else {
    if (value.total > rowCaps[value.section]) issue(ctx, ["total"], "Section total exceeds its row bound");
    for (const [index, entry] of (value.entries ?? []).entries()) if (!rowSchema.safeParse(entry).success) issue(ctx, ["entries", index], "Row does not match the selected section");
  }
  if (value.offset !== undefined && value.total !== undefined && value.entries !== undefined) {
    if (value.entries.length > Math.max(0, value.total - value.offset)) issue(ctx, ["entries"], "Page exceeds the section total");
    const end = value.offset + value.entries.length;
    if (cursorPage) {
      if (value.nextOffset !== undefined) issue(ctx, ["nextOffset"], "Selected pages continue only with a query-bound cursor");
      if (end < value.total && value.nextCursor === undefined) issue(ctx, ["nextCursor"], "Incomplete selected pages require a bound continuation");
      if (value.nextCursor !== undefined && (Number(value.nextCursor.slice(65)) !== end || end <= value.offset || end >= value.total)) issue(ctx, ["nextCursor"], "Bound continuations advance by whole rows within the matched selection");
      if (value.cursor !== undefined && Number(value.cursor.slice(65)) !== value.offset) issue(ctx, ["cursor"], "Returned cursor offsets must match the selected row offset");
    } else {
      for (const key of ["cursor", "nextCursor"]) if (value[key] !== undefined) issue(ctx, [key], "Unfiltered full reads preserve offset pagination");
      if (value.nextOffset !== undefined && (value.nextOffset !== end || value.nextOffset <= value.offset || value.nextOffset >= value.total)) issue(ctx, ["nextOffset"], "Continuation must advance by the emitted rows within the section");
      if (end < value.total && value.nextOffset === undefined) issue(ctx, ["nextOffset"], "Incomplete pages require a continuation offset");
    }
  }
}
export const mapContextOutputSchema = z.object({
  view: z.enum(managementViews), ...optionalSummaryFields, section: z.literal("summary").optional(),
  maps: z.array(mapListEntrySchema).max(8).optional(), released: z.boolean().optional(), image: mapImageSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const summary = ["build", "update", "observe", "probe", "read"].includes(value.view);
  validateOutputKeys(value, ctx, outputKeys[value.view], summary ? [...requiredSummary, ...(value.view === "read" ? ["section"] : [])] : outputKeys[value.view]);
  if (value.parentMapId !== undefined && (value.parentMapId === value.mapId || value.revision < 2)) issue(ctx, ["parentMapId"], "Parent must be a different immutable revision");
});
const pageOutputFields = {
  mapId: mapIdSchema, revision: summaryFields.revision, offset: count(Number.MAX_SAFE_INTEGER), total: count(4096),
  nextOffset: count(Number.MAX_SAFE_INTEGER).optional(), coverage: partial, warnings: reasons,
  query: mapReadQuerySchema.optional(), presentation: z.enum(["full", "summary"]).optional(), cursor: mapReadCursorSchema.optional(), nextCursor: mapReadCursorSchema.optional(),
  totalMatched: count(4096).optional(), totalAvailable: count(4096).optional(),
};
export const mapGeometryOutputSchema = z.object({
  view: z.literal("read"), ...pageOutputFields, section: z.enum(geometrySections), query: geometryQuerySchema.optional(), presentation: z.literal("full").optional(),
  entries: z.array(z.union(geometrySections.map((section) => mapRowSchemas[section]))).max(100),
}).strict().superRefine(validatePage);
export const mapNavigationOutputSchema = z.object({
  view: z.enum(["read", "route"]), ...Object.fromEntries(Object.entries(pageOutputFields).map(([key, schema]) => [key, schema.optional()])),
  mapId: mapIdSchema, revision: summaryFields.revision, section: z.literal("links").optional(), query: navigationQuerySchema.optional(), presentation: z.literal("full").optional(),
  entries: z.array(linkSchema).max(100).optional(), ...optionalRouteFields,
}).strict().superRefine((value, ctx) => {
  if (value.view === "read") {
    validateOutputKeys(value, ctx, [...pageFields, "nextOffset", "query", "presentation", "cursor", "nextCursor", "totalMatched", "totalAvailable"], pageFields);
    validatePage(value, ctx);
  } else {
    validateOutputKeys(value, ctx, ["mapId", "revision", ...Object.keys(routeFields)]);
    const result = routeSchema.safeParse(Object.fromEntries(Object.keys(routeFields).map((key) => [key, value[key]])));
    if (!result.success) issue(ctx, ["steps"], "Route does not satisfy the typed route contract");
  }
});
export const mapMotionOutputSchema = z.object({
  view: z.enum(["read", "summary"]), ...pageOutputFields, section: z.enum(motionSections), query: motionQuerySchema.optional(),
  entries: z.array(z.union([trackSchema, hazardSchema, trackSummarySchema])).max(100),
}).strict().superRefine(validatePage);

import { z } from "zod";

// This module intentionally does not import map-schemas: archived maps depend on it.
export const MAP_RECORDING_LIMITS = Object.freeze({ active: 4, retained: 8, targets: 4, durationMsMin: 1000, durationMsMax: 60000, durationMsDefault: 30000, intervalMsMin: 50, intervalMsMax: 1000, intervalMsDefault: 100, frames: 1201, samples: 4804, sampleBytes: 2097152, eventBytes: 65536, events: 256, markers: 32, retentionSeconds: 120, pageFrames: 20, pageBytes: 65536, recordings: 4 });
const text = (max) => z.string().max(max).refine((value) => value.isWellFormed() && !value.includes("\0"), "Must be well-formed text without NUL");
const finite = z.number().finite();
const count = (max = Number.MAX_SAFE_INTEGER) => z.number().int().min(0).max(max);
const positiveCount = (max) => z.number().int().min(1).max(max);
const clockTime = finite.min(0).max(Number.MAX_SAFE_INTEGER);
const relativeTime = finite.min(0).max(60);
const coordinate = finite.min(-1e9).max(1e9);
const sizeAxis = finite.min(0).max(1e6);
const size = z.object({ x: sizeAxis, y: sizeAxis, z: sizeAxis }).strict();
const mapId = z.string().regex(/^map-[a-f0-9]{32}(?![\s\S])/);
export const recordingIdSchema = z.string().regex(/^[a-f0-9]{32}(?![\s\S])/);
const client = z.object({ clientId: text(128).min(1), generation: z.union([text(128).min(1), count()]) }).strict();
const receivedAt = z.string().datetime();
const durationMs = z.number().int().min(1000).max(60000);
const intervalMs = z.number().int().min(50).max(1000);
const view = z.enum(["summary", "frames", "events"]);
const issue = (ctx, path, message) => ctx.addIssue({ code: "custom", path, message });
const unique = (values) => new Set(values).size === values.length;
const terminal = (metadata) => metadata.state === "stopped" || metadata.state === "failed";
const bindingFields = { sourceSnapshotId: recordingIdSchema, sourceObjectId: recordingIdSchema };
const target = z.object({ ...bindingFields, path: text(1024), className: text(64), size, anchored: z.boolean(), canCollide: z.boolean(), canTouch: z.boolean().optional() }).strict();

export const nativeRecordingMetadataSchema = z.object({
  recordingId: recordingIdSchema, state: z.enum(["accepted", "starting", "recording", "stopped", "failed"]), ready: z.boolean(), clock: z.literal("client-monotonic-seconds"), atomicSnapshot: z.literal(false),
  acceptedAt: clockTime, startedAt: clockTime.optional(), firstSampleAt: clockTime.optional(), readyAt: clockTime.optional(), lastSampleAt: clockTime.optional(), stoppedAt: clockTime.optional(), now: clockTime, expiresAt: clockTime.optional(),
  durationMs, intervalMs, elapsedMs: finite.min(0).max(Number.MAX_SAFE_INTEGER), remainingMs: finite.min(0).max(60000),
  frameCount: count(1201), sampleCount: count(4804), eventCount: count(256), markerCount: count(32), missedIntervals: count(), retainedDrops: z.literal(0), sampleBytes: count(2097152), eventBytes: count(65536),
  coverage: z.enum(["complete", "partial"]), stopReasons: z.array(text(256).min(1)).max(64), targets: z.array(target).min(1).max(4),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.targets.map((entry) => entry.sourceObjectId))) issue(ctx, ["targets"], "Recording targets must be unique exact native objects");
  for (const key of ["acceptedAt", "startedAt", "firstSampleAt", "readyAt", "lastSampleAt", "stoppedAt"]) if (value[key] !== undefined && value[key] > value.now) issue(ctx, [key], "Capture timestamps cannot exceed this metadata snapshot's native clock");
  const ordered = ["acceptedAt", "startedAt", "firstSampleAt", "readyAt"];
  for (let index = 1; index < ordered.length; index++) {
    const key = ordered[index], previous = ordered[index - 1];
    if (value[key] !== undefined && (value[previous] === undefined || value[key] < value[previous])) issue(ctx, [key], "Native lifecycle timestamps must be present and ordered");
  }
  if (value.lastSampleAt !== undefined && (value.firstSampleAt === undefined || value.lastSampleAt < value.firstSampleAt)) issue(ctx, ["lastSampleAt"], "Last sample cannot precede the first real sample");
  if (value.sampleCount !== value.frameCount * value.targets.length) issue(ctx, ["sampleCount"], "Every retained frame must contain all owned targets");
  if (value.markerCount > value.eventCount) issue(ctx, ["markerCount"], "Markers are retained events");
  if (value.frameCount > 0) {
    for (const key of ["startedAt", "firstSampleAt", "lastSampleAt"]) if (value[key] === undefined) issue(ctx, [key], "Retained samples require actual native sample timestamps");
  } else for (const key of ["firstSampleAt", "lastSampleAt", "readyAt"]) if (value[key] !== undefined) issue(ctx, [key], "An empty recording cannot claim a real sample or readiness");
  if (value.ready !== (value.state === "recording")) issue(ctx, ["ready"], "Only an ongoing recording can be ready");
  if (value.state === "recording" && (!value.frameCount || value.readyAt === undefined)) issue(ctx, ["ready"], "Readiness requires a first complete frame and native sampler receipt");
  if (value.state === "accepted" && (value.startedAt !== undefined || value.frameCount !== 0)) issue(ctx, ["state"], "Accepted recordings have not started sampling");
  if (terminal(value)) {
    if (value.stoppedAt === undefined || value.expiresAt === undefined) issue(ctx, ["stoppedAt"], "Terminal recordings require fixed stop and retention timestamps");
    else {
      if (value.stoppedAt < (value.lastSampleAt ?? value.startedAt ?? value.acceptedAt)) issue(ctx, ["stoppedAt"], "Stopping cannot precede retained capture activity");
      if (value.expiresAt !== value.stoppedAt + 120) issue(ctx, ["expiresAt"], "Terminal retention starts at stop and is never renewed by reads");
    }
    if (!value.stopReasons.length) issue(ctx, ["stopReasons"], "Terminal recordings require an explicit reason");
    if (value.remainingMs !== 0) issue(ctx, ["remainingMs"], "Terminal recordings have no remaining capture time");
  } else for (const key of ["stoppedAt", "expiresAt"]) if (value[key] !== undefined) issue(ctx, [key], "Active recordings cannot claim terminal retention");
  if (value.state === "failed" && value.coverage !== "partial") issue(ctx, ["coverage"], "Failed recordings retain partial evidence, not complete success");
  if (value.remainingMs > value.durationMs) issue(ctx, ["remainingMs"], "Remaining time cannot exceed the absolute capture window");
});

export const nativeRecordingFrameSchema = z.object({
  sequence: positiveCount(1201), t: relativeTime,
  samples: z.array(z.object({ sourceObjectId: recordingIdSchema, t: relativeTime, cframe: z.array(coordinate).length(12), size }).strict()).min(1).max(4),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.samples.map((sample) => sample.sourceObjectId))) issue(ctx, ["samples"], "Each exact target occurs once per frame");
});
const eventFields = {
  sequence: positiveCount(256), t: relativeTime, kind: z.enum(["health-drop", "death", "respawn", "marker"]),
  objectIds: z.array(recordingIdSchema).max(4).optional(), amount: finite.min(0).max(1e9).optional(), association: z.literal("spatial-temporal-correlation").optional(),
  label: text(64).min(1).optional(), source: z.literal("mcp-request").optional(),
};
export const nativeRecordingEventSchema = z.object(eventFields).strict().superRefine((value, ctx) => {
  if (value.kind === "marker") {
    for (const key of ["label", "source"]) if (value[key] === undefined) issue(ctx, [key], "Markers require an actual MCP receipt label and source");
    for (const key of ["objectIds", "amount", "association"]) if (value[key] !== undefined) issue(ctx, [key], "Markers do not assert physical event associations");
  } else {
    for (const key of ["objectIds", "association"]) if (value[key] === undefined) issue(ctx, [key], "Health observations require bounded spatial-temporal associations");
    for (const key of ["label", "source"]) if (value[key] !== undefined) issue(ctx, [key], "Only markers have request labels");
    if (value.amount !== undefined && value.kind !== "health-drop") issue(ctx, ["amount"], "Only health-drop observations have amounts");
    if (value.objectIds !== undefined && !unique(value.objectIds)) issue(ctx, ["objectIds"], "Event target associations must be unique");
  }
});

function validateEntries(metadata, entries, section, ctx, prefix = []) {
  const ids = new Set(metadata.targets.map((entry) => entry.sourceObjectId));
  const previousTimes = new Map();
  const end = (section === "frames" ? metadata.lastSampleAt : metadata.stoppedAt ?? metadata.now);
  const recordedUntil = metadata.startedAt === undefined || end === undefined ? -1 : end - metadata.startedAt;
  // Subtraction of native absolute clocks may differ by a floating-point ULP.
  const clockTolerance = Number.EPSILON * Math.max(1, metadata.now) * 4;
  for (const [index, entry] of entries.entries()) {
    const path = [...prefix, section, index];
    if (entry.t > metadata.durationMs / 1000) issue(ctx, [...path, "t"], "Evidence cannot extend the absolute capture deadline");
    if (entry.t > recordedUntil + clockTolerance) issue(ctx, [...path, "t"], "Relative evidence times must belong to the actual native capture lifecycle");
    if (section === "frames" && entry.sequence === 1 && Math.abs(entry.t - (metadata.firstSampleAt - metadata.startedAt)) > clockTolerance) issue(ctx, [...path, "t"], "The first retained frame must match the native first-sample receipt");
    if (index > 0 && (entry.sequence !== entries[index - 1].sequence + 1 || entry.t < entries[index - 1].t || (section === "frames" && entry.t === entries[index - 1].t))) issue(ctx, path, "Sequences must be contiguous and native sample times ordered");
    if (section === "frames") {
      if (entry.samples.length !== ids.size || entry.samples.some((sample) => !ids.has(sample.sourceObjectId))) issue(ctx, [...path, "samples"], "A complete frame contains exactly the selected native targets");
      for (const sample of entry.samples) {
        if (sample.t > metadata.durationMs / 1000 || (previousTimes.has(sample.sourceObjectId) && sample.t <= previousTimes.get(sample.sourceObjectId))) issue(ctx, [...path, "samples"], "Per-target native times must increase within the capture window");
        if (sample.t < entry.t || sample.t > recordedUntil + clockTolerance) issue(ctx, [...path, "samples"], "Target samples must occur within their real native frame and capture lifetime");
        previousTimes.set(sample.sourceObjectId, sample.t);
      }
    } else if (entry.objectIds?.some((id) => !ids.has(id))) issue(ctx, [...path, "objectIds"], "Events may only correlate owned recording targets");
  }
}
const nativePageFields = {
  metadata: nativeRecordingMetadataSchema, view, cursor: count(1201), nextCursor: count(1201), hasMore: z.boolean(),
  frames: z.array(nativeRecordingFrameSchema).max(20).optional(), events: z.array(nativeRecordingEventSchema).max(20).optional(),
};
function validateNativePage(value, ctx) {
  if (value.view === "summary") {
    for (const key of ["frames", "events"]) if (value[key] !== undefined) issue(ctx, [key], "Summary polls do not return raw evidence");
    if (value.cursor !== 0 || value.nextCursor !== 0 || value.hasMore) issue(ctx, ["cursor"], "Summary polls do not have an evidence cursor");
    return;
  }
  const section = value.view, other = section === "frames" ? "events" : "frames", entries = value[section];
  if (value[other] !== undefined) issue(ctx, [other], "Only the selected evidence view may be returned");
  if (entries === undefined) { issue(ctx, [section], "Selected evidence pages require a typed array"); return; }
  const total = section === "frames" ? value.metadata.frameCount : value.metadata.eventCount;
  if (value.cursor > total) issue(ctx, ["cursor"], "Cursors cannot name future evidence");
  if (entries.length && entries[0].sequence !== value.cursor + 1) issue(ctx, [section, 0, "sequence"], "A page starts immediately after the retained sequence cursor");
  if (value.nextCursor !== value.cursor + entries.length || value.nextCursor > total) issue(ctx, ["nextCursor"], "Evidence cursors advance only by complete retained entries");
  if (value.hasMore !== (value.nextCursor < total)) issue(ctx, ["hasMore"], "Continuation must reflect retained evidence at this snapshot");
  if (value.hasMore && entries.length === 0) issue(ctx, [section], "An incomplete page must advance rather than stall");
  validateEntries(value.metadata, entries, section, ctx);
}
export const nativeRecordingPollSchema = z.object(nativePageFields).strict().superRefine(validateNativePage);

export const recordingEvidenceSchema = z.object({
  recordingId: recordingIdSchema, client, receivedAt, metadata: nativeRecordingMetadataSchema,
  frames: z.array(nativeRecordingFrameSchema).max(1201), events: z.array(nativeRecordingEventSchema).max(256),
}).strict().superRefine((value, ctx) => {
  if (value.recordingId !== value.metadata.recordingId) issue(ctx, ["recordingId"], "Archived identity must match the finalized native recording");
  if (!terminal(value.metadata) || value.metadata.ready) issue(ctx, ["metadata", "state"], "Only terminal evidence can be archived");
  if (value.frames.length !== value.metadata.frameCount || value.frames.reduce((sum, frame) => sum + frame.samples.length, 0) !== value.metadata.sampleCount) issue(ctx, ["frames"], "Archives preserve every retained frame and target sample");
  if (value.events.length !== value.metadata.eventCount || value.events.filter((event) => event.kind === "marker").length !== value.metadata.markerCount) issue(ctx, ["events"], "Archives preserve every retained event and marker");
  for (const section of ["frames", "events"]) {
    if (value[section].length && value[section][0].sequence !== 1) issue(ctx, [section, 0, "sequence"], "A full archive starts at retained sequence one");
    validateEntries(value.metadata, value[section], section, ctx);
  }
});
export const archivedRecordingSummarySchema = z.object({ recordingId: recordingIdSchema, client, receivedAt, metadata: nativeRecordingMetadataSchema }).strict().superRefine((value, ctx) => {
  if (value.recordingId !== value.metadata.recordingId || !terminal(value.metadata)) issue(ctx, ["metadata"], "Archived summaries require the exact finalized native recording");
});

const operations = ["start", "poll", "mark", "stop", "save", "read", "release"];
const selectorFields = { view: view.optional(), afterCursor: count(1201).optional(), limit: positiveCount(20).optional() };
const publicAllowed = {
  start: ["mapId", "objectIds", "durationMs", "intervalMs", "clientId"], poll: ["recordingId", "view", "afterCursor", "limit", "clientId"],
  mark: ["recordingId", "label", "clientId"], stop: ["recordingId", "clientId"], save: ["mapId", "recordingId", "clientId"],
  read: ["mapId", "recordingId", "view", "afterCursor", "limit"], release: ["recordingId", "clientId"],
};
const publicRequired = { start: ["mapId", "objectIds"], poll: ["recordingId"], mark: ["recordingId", "label"], stop: ["recordingId"], save: ["mapId", "recordingId"], read: ["mapId"], release: ["recordingId"] };
function validateKeys(value, ctx, allowed, required) {
  for (const key of Object.keys(value)) if (key !== "operation" && value[key] !== undefined && !allowed.includes(key)) issue(ctx, [key], "Field is not allowed for this operation");
  for (const key of required) if (value[key] === undefined) issue(ctx, [key], "Required for this operation");
}
function validateEvidenceSelectors(value, ctx) {
  if (!["poll", "read"].includes(value.operation)) return;
  if ((value.view ?? "summary") === "summary") {
    for (const key of ["afterCursor", "limit"]) if (value[key] !== undefined) issue(ctx, [key], "Summary reads do not accept evidence pagination");
  } else if (value.operation === "read" && value.recordingId === undefined) issue(ctx, ["recordingId"], "Archived evidence pages require an exact recording identity");
  if (value.view === "events" && value.afterCursor > 256) issue(ctx, ["afterCursor"], "Event cursors cannot exceed retained event capacity");
}
export const mapRecordingOperationInputSchema = z.object({
  operation: z.enum(operations), mapId: mapId.optional(), recordingId: recordingIdSchema.optional(), clientId: recordingIdSchema.optional(),
  objectIds: z.array(text(64).min(1)).min(1).max(4).refine(unique, "Part IDs must be unique").optional(),
  durationMs: durationMs.optional().meta({ default: 30000 }), intervalMs: intervalMs.optional().meta({ default: 100 }), label: text(64).min(1).optional(), ...selectorFields,
}).strict().superRefine((value, ctx) => {
  validateKeys(value, ctx, publicAllowed[value.operation], publicRequired[value.operation]);
  validateEvidenceSelectors(value, ctx);
});
const controlOperations = ["start", "poll", "mark", "stop", "save", "release"];
export const mapRecordingInputSchema = z.object({
  ...Object.fromEntries(Object.entries(mapRecordingOperationInputSchema.shape).filter(([key]) => !["afterCursor", "limit"].includes(key))),
  operation: z.enum(controlOperations), view: z.literal("summary").optional(),
}).strict().superRefine((value, ctx) => {
  validateKeys(value, ctx, publicAllowed[value.operation], publicRequired[value.operation]);
  validateEvidenceSelectors(value, ctx);
});
export const mapRecordingReadInputSchema = z.object({
  operation: z.enum(["poll", "read"]), mapId: mapId.optional(), recordingId: recordingIdSchema.optional(), clientId: recordingIdSchema.optional(), ...selectorFields,
}).strict().superRefine((value, ctx) => {
  validateKeys(value, ctx, publicAllowed[value.operation], publicRequired[value.operation]);
  validateEvidenceSelectors(value, ctx);
  if (value.operation === "poll" && !["frames", "events"].includes(value.view)) issue(ctx, ["view"], "Live evidence polls require an explicit frames or events view");
});
export const nativeRecordingInputSchema = z.object({
  operation: z.enum(["start", "poll", "mark", "stop", "release"]), recordingId: recordingIdSchema.optional(),
  targets: z.array(z.object(bindingFields).strict()).min(1).max(4).refine((entries) => unique(entries.map((entry) => entry.sourceObjectId)), "Native targets must be unique").optional(),
  durationMs: durationMs.optional(), intervalMs: intervalMs.optional(), label: text(64).min(1).optional(), ...selectorFields, _maxResultBytes: positiveCount(65536).optional(),
}).strict().superRefine((value, ctx) => {
  const allowed = value.operation === "start" ? ["targets", "durationMs", "intervalMs"] : publicAllowed[value.operation].filter((key) => key !== "clientId");
  validateKeys(value, ctx, [...allowed, "_maxResultBytes"], value.operation === "start" ? ["targets"] : publicRequired[value.operation]);
  validateEvidenceSelectors(value, ctx);
});

const revision = positiveCount(Number.MAX_SAFE_INTEGER);
function validateRecordingOutput(value, ctx) {
  if (["start", "mark", "stop"].includes(value.operation)) {
    validateKeys(value, ctx, ["metadata", "receivedAt"], ["metadata", "receivedAt"]);
    if (value.operation === "stop" && value.metadata && !terminal(value.metadata)) issue(ctx, ["metadata", "state"], "Stop receipts require a terminal native state");
  } else if (value.operation === "poll") {
    validateKeys(value, ctx, [...Object.keys(nativePageFields), "receivedAt"], ["metadata", "receivedAt", "view", "cursor", "nextCursor", "hasMore"]);
    if (value.metadata && value.view !== undefined) validateNativePage(value, ctx);
  } else if (value.operation === "release") validateKeys(value, ctx, ["recordingId", "released"], ["recordingId", "released"]);
  else if (value.operation === "save") validateKeys(value, ctx, ["mapId", "revision", "recordingId", "released"], ["mapId", "revision", "recordingId"]);
  else if (value.view === "summary") {
    validateKeys(value, ctx, ["mapId", "revision", "view", "recordings"], ["mapId", "revision", "view", "recordings"]);
    if (value.recordings && !unique(value.recordings.map((entry) => entry.recordingId))) issue(ctx, ["recordings"], "Archived recording summaries must be unique");
  } else {
    validateKeys(value, ctx, ["mapId", "revision", "recordingId", ...Object.keys(nativePageFields)], ["mapId", "revision", "recordingId", "metadata", "view", "cursor", "nextCursor", "hasMore"]);
    if (value.metadata && value.view !== undefined) {
      validateNativePage(value, ctx);
      if (!terminal(value.metadata) || value.recordingId !== value.metadata.recordingId) issue(ctx, ["metadata"], "Archived pages require the exact terminal recording identity");
    }
  }
}
export const mapRecordingOutputSchema = z.object({
  operation: z.enum(controlOperations), mapId: mapId.optional(), revision: revision.optional(), recordingId: recordingIdSchema.optional(), receivedAt: receivedAt.optional(), released: z.boolean().optional(),
  metadata: nativeRecordingMetadataSchema.optional(), view: z.literal("summary").optional(), cursor: z.literal(0).optional(), nextCursor: z.literal(0).optional(), hasMore: z.literal(false).optional(),
}).strict().superRefine(validateRecordingOutput);
export const mapRecordingReadOutputSchema = z.object({
  operation: z.enum(["poll", "read"]), mapId: mapId.optional(), revision: revision.optional(), recordingId: recordingIdSchema.optional(), receivedAt: receivedAt.optional(),
  ...Object.fromEntries(Object.entries(nativePageFields).map(([key, schema]) => [key, schema.optional()])), recordings: z.array(archivedRecordingSummarySchema).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  validateRecordingOutput(value, ctx);
  if (value.operation === "poll" && !["frames", "events"].includes(value.view)) issue(ctx, ["view"], "Live evidence pages require an explicit frames or events view");
});

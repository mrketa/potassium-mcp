import { z } from "zod";
import { mapRecordingOperationInputSchema, nativeRecordingMetadataSchema, nativeRecordingPollSchema, recordingEvidenceSchema, recordingIdSchema } from "./map-recording-schemas.js";

const fail = (code, message) => Object.assign(new Error(message), { code: `MAP_RECORDING_${code}` });
const terminal = (metadata) => metadata.state === "stopped" || metadata.state === "failed";
const receiptSchema = z.object({ metadata: nativeRecordingMetadataSchema }).strict();
const releaseSchema = z.object({ recordingId: recordingIdSchema, released: z.boolean() }).strict();
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw fail("INVALID_DATA", "Recording receipt does not satisfy its bounded schema");
  return parsed.data;
}
function stableMetadata(metadata) {
  const { now, elapsedMs, remainingMs, expiresAt, ...stable } = metadata;
  return JSON.stringify(stable);
}
const binding = (target) => `${target.sourceSnapshotId}:${target.sourceObjectId}`;
function selectedTargets(metadata, targets) {
  const expected = new Set(targets.map(binding));
  if (metadata.targets.length !== expected.size || metadata.targets.some((target) => !expected.has(binding(target)))) throw fail("INVALID_DATA", "Recording source selection changed");
}
function validateMetadata(metadata) {
  if (metadata.ready && (metadata.state !== "recording" || metadata.frameCount < 1 || metadata.sampleCount < metadata.targets.length || metadata.startedAt === undefined || metadata.firstSampleAt === undefined || metadata.readyAt === undefined)) throw fail("INVALID_DATA", "Recording readiness precedes its first real sample");
  if (terminal(metadata) && (metadata.ready || metadata.stoppedAt === undefined)) throw fail("INVALID_DATA", "Terminal recording receipt is inconsistent");
  if (new Set(metadata.targets.map(binding)).size !== metadata.targets.length) throw fail("INVALID_DATA", "Recording contains duplicate source bindings");
  return metadata;
}

/** Coordinates native recording receipts; durable evidence and retry receipts belong to MapService. */
export function createMapRecordingService({ mapContextService, clock = Date } = {}) {
  if (!mapContextService) throw new TypeError("mapContextService is required");
  let closed = false;
  const controllers = new Set();
  function input(operation, args = {}) {
    if (args.operation !== undefined && args.operation !== operation) throw fail("INVALID_INPUT", "Recording operation does not match method");
    const parsed = mapRecordingOperationInputSchema.safeParse({ ...args, operation });
    if (!parsed.success) throw fail("INVALID_INPUT", "Recording selectors do not match the operation");
    return parsed.data;
  }
  function timestamp() {
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw fail("INVALID_DATA", "Host receipt clock is invalid");
    return new Date(now).toISOString();
  }
  async function live(options = {}, action) {
    const client = { clientId: options.client?.clientId, generation: options.client?.generation };
    if (typeof client.clientId !== "string" || !client.clientId || !(Number.isSafeInteger(client.generation) && client.generation >= 0 || typeof client.generation === "string" && client.generation.length > 0) || typeof options.collect !== "function") throw fail("INVALID_INPUT", "A selected native client and collector are required");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    controllers.add(controller);
    function check(scope = client) {
      if (closed || controller.signal.aborted) throw fail("CANCELLED", "Recording operation cancelled");
      if (!options.isCurrent?.() || options.client?.clientId !== client.clientId || options.client?.generation !== client.generation || scope.clientId !== client.clientId || scope.generation !== client.generation) throw fail("CLIENT_CHANGED", "Recording client or generation changed");
    }
    async function collect(params, schema) {
      check();
      const maximum = Math.min(options.maxResultBytes ?? 65536, 65536);
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw fail("INVALID_INPUT", "Recording result byte allowance is invalid");
      // The native operation owns sampling; a host poll never schedules or synthesizes samples.
      const raw = await options.collect("map_recording", { ...params, _maxResultBytes: maximum });
      check();
      if (Buffer.byteLength(JSON.stringify(raw)) > maximum) throw fail("LIMIT", "Recording receipt exceeds its byte allowance");
      const result = parse(schema, raw);
      if (result.metadata) {
        validateMetadata(result.metadata);
        if (params.recordingId && result.metadata.recordingId !== params.recordingId) throw fail("INVALID_DATA", "Recording identity changed");
      }
      return result;
    }
    try { check(); return await action({ check, collect, client, signal: controller.signal }); }
    finally { controllers.delete(controller); options.signal?.removeEventListener("abort", abort); }
  }
  async function control(operation, args, options) {
    const request = input(operation, args);
    return live(options, async ({ collect }) => {
      const params = { operation, recordingId: request.recordingId, ...(operation === "mark" ? { label: request.label } : {}) };
      const result = await collect(params, operation === "release" ? releaseSchema : receiptSchema);
      if (operation === "release") {
        if (result.recordingId !== request.recordingId) throw fail("INVALID_DATA", "Released recording identity changed");
        return { operation, ...result };
      }
      if (operation === "stop" && !terminal(result.metadata)) throw fail("INVALID_DATA", "Stop did not return a terminal receipt");
      return { operation, ...result, receivedAt: timestamp() };
    });
  }
  function pollParams(request, view = request.view ?? "summary", afterCursor = request.afterCursor ?? 0) {
    return { operation: "poll", recordingId: request.recordingId, view, ...(view === "summary" ? {} : { afterCursor, limit: request.limit ?? 10 }) };
  }
  function validatePage(page, params) {
    if (page.view !== params.view || page.cursor !== (params.afterCursor ?? 0)) throw fail("INVALID_DATA", "Recording page selector changed");
    if (params.view === "summary") {
      if (page.cursor !== 0 || page.nextCursor !== 0 || page.hasMore) throw fail("INVALID_DATA", "Recording summary contains a data cursor");
      return;
    }
    const rows = page[params.view];
    if (!Array.isArray(rows) || rows.length > params.limit || rows.some((row, index) => row.sequence !== params.afterCursor + index + 1) || page.nextCursor !== params.afterCursor + rows.length || (page.hasMore && rows.length === 0)) throw fail("INVALID_DATA", "Recording page has a sequence hole or stalled cursor");
    if (params.view === "frames" && (page.nextCursor > page.metadata.frameCount || page.hasMore !== (page.nextCursor < page.metadata.frameCount))) throw fail("INVALID_DATA", "Recording frame pagination contradicts its receipt");
  }
  return {
    async start(args, options) {
      const request = input("start", args);
      return live(options, async ({ check, collect }) => {
        const selection = await mapContextService.prepareRecording({ mapId: request.mapId, objectIds: request.objectIds });
        check(selection.scope);
        const params = { operation: "start", targets: selection.targets.map(({ sourceSnapshotId, sourceObjectId }) => ({ sourceSnapshotId, sourceObjectId })), ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}), ...(request.intervalMs !== undefined ? { intervalMs: request.intervalMs } : {}) };
        const result = await collect(params, receiptSchema);
        check(selection.scope);
        selectedTargets(result.metadata, selection.targets);
        if (result.metadata.durationMs !== (request.durationMs ?? 30000) || result.metadata.intervalMs !== (request.intervalMs ?? 100)) throw fail("INVALID_DATA", "Recording capture bounds changed");
        return { operation: "start", ...result, receivedAt: timestamp() };
      });
    },
    async poll(args, options) {
      const request = input("poll", args);
      return live(options, async ({ collect }) => {
        const params = pollParams(request);
        const page = await collect(params, nativeRecordingPollSchema);
        validatePage(page, params);
        return { operation: "poll", ...page, receivedAt: timestamp() };
      });
    },
    mark: (args, options) => control("mark", args, options),
    stop: (args, options) => control("stop", args, options),
    release: (args, options) => control("release", args, options),
    async save(args, options = {}) {
      const request = input("save", args);
      if (closed || options.signal?.aborted) throw fail("CANCELLED", "Recording operation cancelled");
      const accepted = await mapContextService.findRecordingReceipt({ mapId: request.mapId, recordingId: request.recordingId, ...(options.client ? { client: options.client } : {}), ...((request.clientId ?? options.clientId) ? { clientId: request.clientId ?? options.clientId } : {}) });
      if (accepted) return { operation: "save", recordingId: request.recordingId, mapId: accepted.mapId, revision: accepted.revision, ...(accepted.released !== undefined ? { released: accepted.released } : {}) };
      if (closed || options.signal?.aborted) throw fail("CANCELLED", "Recording operation cancelled");
      if (options.acquire) options = { ...options, ...await options.acquire() };
      return live(options, async ({ collect, check, client, signal }) => {
        const params = pollParams({ recordingId: request.recordingId });
        const initial = await collect(params, nativeRecordingPollSchema);
        validatePage(initial, params);
        const metadata = initial.metadata;
        if (!terminal(metadata)) throw fail("NOT_TERMINAL", "Stop the recording explicitly before saving; save does not stop capture");
        const selection = await mapContextService.prepareRecording({ mapId: request.mapId, sourceTargets: metadata.targets.map(({ sourceSnapshotId, sourceObjectId }) => ({ sourceSnapshotId, sourceObjectId })) });
        check(selection.scope);
        selectedTargets(metadata, selection.targets);
        const identity = stableMetadata(metadata);
        const frames = [], events = [];
        let sampleBytes = 0, eventBytes = 0, sampleCount = 0, lastTime = -1;
        const targetTimes = new Map();
        for (const view of ["frames", "events"]) {
          const rows = view === "frames" ? frames : events;
          const cap = view === "frames" ? 1201 : 256;
          let more = true;
          while (more) {
            check(selection.scope);
            const query = pollParams({ recordingId: request.recordingId, limit: 20 }, view, rows.length);
            const page = await collect(query, nativeRecordingPollSchema);
            validatePage(page, query);
            if (stableMetadata(page.metadata) !== identity) throw fail("INVALID_DATA", "Terminal recording changed during acquisition");
            if (rows.length + page[view].length > cap) throw fail("LIMIT", "Recording row allowance exceeded");
            for (const row of page[view]) {
              if (view === "frames") {
                if (row.t < lastTime || row.samples.length !== metadata.targets.length || new Set(row.samples.map((sample) => sample.sourceObjectId)).size !== metadata.targets.length) throw fail("INVALID_DATA", "Recording frame is incomplete or time regressed");
                lastTime = row.t;
                for (const sample of row.samples) {
                  if (!metadata.targets.some((target) => target.sourceObjectId === sample.sourceObjectId) || sample.t < (targetTimes.get(sample.sourceObjectId) ?? -1)) throw fail("INVALID_DATA", "Recording sample source changed or time regressed");
                  targetTimes.set(sample.sourceObjectId, sample.t);
                }
                sampleCount += row.samples.length;
                sampleBytes += Buffer.byteLength(JSON.stringify(row));
                if (sampleBytes > 2097152) throw fail("LIMIT", "Recording sample byte allowance exceeded");
              } else {
                eventBytes += Buffer.byteLength(JSON.stringify(row));
                if (eventBytes > 65536) throw fail("LIMIT", "Recording event byte allowance exceeded");
              }
              rows.push(row);
            }
            more = page.hasMore;
          }
        }
        if (frames.length !== metadata.frameCount || sampleCount !== metadata.sampleCount || metadata.retainedDrops !== 0) throw fail("INVALID_DATA", "Recording acquisition is incomplete");
        const final = await collect(params, nativeRecordingPollSchema);
        validatePage(final, params);
        if (stableMetadata(final.metadata) !== identity) throw fail("INVALID_DATA", "Terminal recording changed before persistence");
        const recording = parse(recordingEvidenceSchema, { recordingId: request.recordingId, client, receivedAt: timestamp(), metadata, frames, events });
        check(selection.scope);
        // Import owns the atomic acceptance boundary. Never check cancellation or format after it.
        const receipt = await mapContextService.importRecording({ mapId: request.mapId, recording }, { signal, client, isCurrent: options.isCurrent });
        return { operation: "save", recordingId: request.recordingId, mapId: receipt.mapId, revision: receipt.revision, ...(receipt.released !== undefined ? { released: receipt.released } : {}) };
      });
    },
    async read(args) {
      const request = input("read", args);
      if (closed) throw fail("CANCELLED", "Recording service is closed");
      const { operation, ...selectors } = request;
      return { operation, ...await mapContextService.readRecording(selectors) };
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); },
  };
}

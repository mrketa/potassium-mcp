import assert from "node:assert/strict";
import test from "node:test";
import { createMapRecordingService } from "../src/map-recording.js";

const hex = (n) => n.toString(16).padStart(32, "0");
const mapId = `map-${hex(1)}`;
const recordingId = hex(2);
const client = { clientId: "fixture", generation: 1 };
const target = { sourceSnapshotId: hex(3), sourceObjectId: hex(4), path: "Workspace.Floor", className: "Part", size: { x: 20, y: 1, z: 20 }, anchored: true, canCollide: true, canTouch: true };
const frame = (sequence = 1) => ({ sequence, t: (sequence - 1) / 10, samples: [{ sourceObjectId: target.sourceObjectId, t: (sequence - 1) / 10, cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: target.size }] });
function metadata(overrides = {}) {
  return { recordingId, state: "recording", ready: true, clock: "client-monotonic-seconds", atomicSnapshot: false, acceptedAt: 10, startedAt: 10, firstSampleAt: 10, readyAt: 10, lastSampleAt: 10.1, now: 10.1, durationMs: 30000, intervalMs: 100, elapsedMs: 100, remainingMs: 29900, frameCount: 2, sampleCount: 2, eventCount: 0, markerCount: 0, missedIntervals: 0, retainedDrops: 0, sampleBytes: Buffer.byteLength(JSON.stringify(frame(1))) + Buffer.byteLength(JSON.stringify(frame(2))) + 2, eventBytes: 0, coverage: "complete", stopReasons: [], targets: [target], ...overrides };
}
const ended = (overrides = {}) => metadata({ state: "stopped", ready: false, remainingMs: 0, stoppedAt: 10.1, expiresAt: 130.1, stopReasons: ["user-stop"], ...overrides });
function fixture(overrides = {}) {
  const calls = [], imports = [];
  const service = createMapRecordingService({ clock: { now: () => Date.parse("2026-09-10T00:00:00Z") }, mapContextService: {
    prepareRecording: async () => ({ scope: client, targets: [target] }),
    findRecordingReceipt: async () => null,
    importRecording: async ({ recording }) => { imports.push(recording); return { mapId: `map-${hex(9)}`, revision: 2 }; },
    readRecording: async (args) => ({ mapId: args.mapId, revision: 2, view: "summary", recordings: [] }),
    ...overrides,
  } });
  const options = (handler = async () => ({ metadata: metadata() })) => ({ client: { ...client }, isCurrent: () => true, collect: async (method, params) => { calls.push({ method, params }); return handler(params); } });
  return { service, calls, imports, options };
}
function nativePages(meta = ended(), transform = (page) => page) {
  return async (params) => {
    assert.equal(params.operation, "poll");
    if (params.view === "summary") return transform({ metadata: meta, view: "summary", cursor: 0, nextCursor: 0, hasMore: false });
    const rows = params.view === "frames" ? [frame(1), frame(2)].slice(params.afterCursor) : [];
    return transform({ metadata: meta, view: params.view, cursor: params.afterCursor, nextCursor: params.afterCursor + rows.length, hasMore: false, [params.view]: rows });
  };
}
const badData = (error) => error.code === "MAP_RECORDING_INVALID_DATA";

test("ready before the first real sample is rejected, never converted to a GO receipt", async () => {
  const f = fixture();
  await assert.rejects(f.service.start({ mapId, objectIds: ["part-" + "a".repeat(40)] }, f.options(async () => ({ metadata: metadata({ frameCount: 0, sampleCount: 0, firstSampleAt: undefined }) }))), badData);
});

test("start fences saved scope before collection and receipt source after collection", async () => {
  const foreign = fixture({ prepareRecording: async () => ({ scope: { ...client, generation: 2 }, targets: [target] }) });
  await assert.rejects(foreign.service.start({ mapId, objectIds: ["part-" + "a".repeat(40)] }, foreign.options()), { code: "MAP_RECORDING_CLIENT_CHANGED" });
  assert.equal(foreign.calls.length, 0);
  const f = fixture();
  await assert.rejects(f.service.start({ mapId, objectIds: ["part-" + "a".repeat(40)] }, f.options(async () => ({ metadata: metadata({ targets: [{ ...target, sourceObjectId: hex(8) }] }) }))), badData);
});

test("poll is a replayable native read, not capture and does not synthesize native time", async () => {
  const f = fixture();
  const options = f.options(nativePages());
  const first = await f.service.poll({ recordingId, view: "frames", afterCursor: 0 }, options);
  const again = await f.service.poll({ recordingId, view: "frames", afterCursor: 0 }, options);
  assert.deepEqual(first.frames, again.frames);
  assert.equal(first.metadata.startedAt, 10);
  assert.equal(first.receivedAt, "2026-09-10T00:00:00.000Z");
  assert.deepEqual(f.calls.map(({ method, params }) => [method, params.operation]), [["map_recording", "poll"], ["map_recording", "poll"]]);
});

test("terminal save preserves every raw frame and does not stop or release native evidence", async () => {
  const f = fixture();
  const result = await f.service.save({ mapId, recordingId }, f.options(nativePages(ended({ coverage: "partial", stopReasons: ["target-disappeared"] }))));
  assert.equal(result.revision, 2);
  assert.deepEqual(f.imports[0].frames, [frame(1), frame(2)]);
  assert.equal(f.imports[0].metadata.coverage, "partial");
  assert.equal(f.imports[0].receivedAt, "2026-09-10T00:00:00.000Z");
  assert.ok(f.calls.every(({ params }) => params.operation === "poll"));
});

test("save rejects an active recording without implicitly stopping it", async () => {
  const f = fixture();
  await assert.rejects(f.service.save({ mapId, recordingId }, f.options(nativePages(metadata()))), { code: "MAP_RECORDING_NOT_TERMINAL" });
  assert.equal(f.imports.length, 0);
  assert.deepEqual(f.calls.map(({ params }) => params.operation), ["poll"]);
});

test("save rejects sequence holes, missing target samples and changed terminal identity", async () => {
  for (const mutate of [
    (page) => page.view === "frames" ? { ...page, frames: [frame(2)] } : page,
    (page) => page.view === "frames" ? { ...page, frames: [{ ...frame(1), samples: [] }, frame(2)] } : page,
    (page) => page.view === "events" ? { ...page, metadata: ended({ stoppedAt: 10.2 }) } : page,
    (page) => page.view === "frames" ? { ...page, frames: [frame(1)], nextCursor: 1, hasMore: false } : page,
  ]) {
    const f = fixture();
    await assert.rejects(f.service.save({ mapId, recordingId }, f.options(nativePages(ended(), mutate))), badData);
    assert.equal(f.imports.length, 0);
  }
});

test("a generation change after an awaited receipt rejects persistence", async () => {
  const f = fixture();
  let current = true;
  const options = f.options(async (params) => { const result = await nativePages()(params); current = false; return result; });
  options.isCurrent = () => current;
  await assert.rejects(f.service.save({ mapId, recordingId }, options), { code: "MAP_RECORDING_CLIENT_CHANGED" });
  assert.equal(f.imports.length, 0);
});

test("archived read and accepted retry never acquire a live client, including released revisions", async () => {
  const f = fixture({ findRecordingReceipt: async () => ({ mapId: `map-${hex(9)}`, revision: 2, released: true }) });
  const result = await f.service.save({ mapId, recordingId }, { acquire() { assert.fail("accepted retry must stay offline"); } });
  assert.deepEqual(result, { operation: "save", recordingId, mapId: `map-${hex(9)}`, revision: 2, released: true });
  assert.deepEqual(await f.service.read({ mapId }), { operation: "read", mapId, revision: 2, view: "summary", recordings: [] });
  assert.equal(f.calls.length, 0);
  assert.equal(f.imports.length, 0);
});

test("cancellation before persistence publishes nothing, late cancellation preserves accepted identity", async () => {
  const controller = new AbortController();
  const f = fixture();
  const options = f.options(async (params) => { controller.abort(); return nativePages()(params); });
  options.signal = controller.signal;
  await assert.rejects(f.service.save({ mapId, recordingId }, options), { code: "MAP_RECORDING_CANCELLED" });
  assert.equal(f.imports.length, 0);
  const late = new AbortController();
  const committed = fixture({ importRecording: async () => { late.abort(); return { mapId: `map-${hex(9)}`, revision: 2 }; } });
  assert.equal((await committed.service.save({ mapId, recordingId }, { ...committed.options(nativePages()), signal: late.signal })).revision, 2);
});

test("markers reject ignored selectors and overlong labels without calling native", async () => {
  const f = fixture();
  for (const args of [{ recordingId, label: "x".repeat(65) }, { recordingId, label: "landing", afterCursor: 1 }]) await assert.rejects(f.service.mark(args, f.options()), { code: "MAP_RECORDING_INVALID_INPUT" });
  assert.equal(f.calls.length, 0);
});

test("terminal pagination archives all pages and rejects cross-page time regression", async () => {
  for (const regress of [false, true]) {
    const f = fixture();
    const frames = Array.from({ length: 21 }, (_, index) => frame(index + 1));
    if (regress) frames[20] = { ...frames[20], t: 0.5, samples: [{ ...frames[20].samples[0], t: 0.5 }] };
    const meta = ended({ frameCount: 21, sampleCount: 21, lastSampleAt: 12, stoppedAt: 12, now: 12, expiresAt: 132, elapsedMs: 2000 });
    const handler = async (params) => {
      if (params.view === "summary") return { metadata: meta, view: "summary", cursor: 0, nextCursor: 0, hasMore: false };
      const rows = params.view === "frames" ? frames.slice(params.afterCursor, params.afterCursor + params.limit) : [];
      const nextCursor = params.afterCursor + rows.length;
      return { metadata: meta, view: params.view, cursor: params.afterCursor, nextCursor, hasMore: params.view === "frames" && nextCursor < frames.length, [params.view]: rows };
    };
    if (regress) {
      await assert.rejects(f.service.save({ mapId, recordingId }, f.options(handler)), badData);
      assert.equal(f.imports.length, 0);
    } else {
      await f.service.save({ mapId, recordingId }, f.options(handler));
      assert.deepEqual(f.imports[0].frames, frames);
      assert.deepEqual(f.calls.filter(({ params }) => params.view === "frames").map(({ params }) => params.afterCursor), [0, 20]);
    }
  }
});

test("an incomplete event stream cannot be accepted as complete evidence", async () => {
  const f = fixture();
  await assert.rejects(f.service.save({ mapId, recordingId }, f.options(nativePages(ended({ eventCount: 1, eventBytes: 64 })))), badData);
  assert.equal(f.imports.length, 0);
});

test("close invalidates an in-flight receipt before any import", async () => {
  const f = fixture();
  const options = f.options(async (params) => { f.service.close(); return nativePages()(params); });
  await assert.rejects(f.service.save({ mapId, recordingId }, options), { code: "MAP_RECORDING_CANCELLED" });
  assert.equal(f.imports.length, 0);
});

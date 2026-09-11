import assert from "node:assert/strict";
import test from "node:test";
import { adaptRecordingForModel, analyzeMotion, evaluateTrack, prepareTrackEvaluator } from "../src/map-motion.js";

const objectId = "a".repeat(32);
const snapshotId = "b".repeat(32);
const capturedAt = "2026-09-09T12:00:00.000Z";
const observedAt = "2026-09-09T12:01:00.000Z";
const client = { clientId: "motion-fixture", generation: "generation-1" };
const size = { x: 10, y: 2, z: 2 };

function frame(x = 0, y = 0, z = 0, yaw = 0) {
  const c = Math.cos(yaw); const s = Math.sin(yaw);
  return [x, y, z, c, 0, s, 0, 1, 0, -s, 0, c];
}

function part(overrides = {}) {
  return {
    id: "part-fixture", sourceKey: JSON.stringify([client.clientId, client.generation, objectId]),
    sourceContextId: `gc-${"c".repeat(32)}`, sourceSnapshotId: snapshotId, sourceObjectId: objectId,
    capturedAt, name: "Platform", path: "Workspace.Platform", className: "Part", cframe: frame(), size: { ...size },
    anchored: true, canCollide: true, shape: "Block", geometry: "block", sourceIdentity: "retained-instance",
    bounds: { min: { x: -5, y: -1, z: -1 }, max: { x: 5, y: 1, z: 1 } }, ...overrides,
  };
}

function batch(samples, { native = {}, events = [], ...overrides } = {}) {
  return {
    observedAt, client: { ...client },
    data: {
      schema: 1, sourceSnapshotId: snapshotId, durationMs: 5000, intervalMs: 100, clock: "observation-relative-seconds",
      tracks: [{ sourceObjectId: objectId, path: "Workspace.Platform", className: "Part", size: { ...size }, anchored: true, canCollide: true, samples, ...native }],
      events, coverage: native.unavailable ? "partial" : "complete", truncated: false, stopReasons: [],
    },
    ...overrides,
  };
}

function trackFor(samples, options) {
  return analyzeMotion([part()], [batch(samples, options)]).tracks[0];
}

function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

function sampleAt(t, cframe = frame()) { return { t, cframe }; }

function periodicSamples(end = 2.4) {
  return Array.from({ length: Math.floor(end * 10) + 1 }, (_, index) => {
    const t = index === 0 ? 0 : index / 10 + Math.sin(index) * 0.013;
    return sampleAt(t, frame(4 * Math.sin(2 * Math.PI * t), 0, 0, 2 * Math.PI * t));
  });
}

test("linear translation uses actual nonuniform timestamps and bounds its prediction horizon", () => {
  const samples = [0, 0.07, 0.23, 0.58, 1.1, 1.7].map((t) => sampleAt(t, frame(7 + 3 * t, 2 - t, -4 + 2 * t)));
  const track = trackFor(samples);
  assert.equal(track.model, "linear");
  near(track.velocity.x, 3); near(track.velocity.y, -1); near(track.velocity.z, 2);
  const interpolated = evaluateTrack(track, 0.1);
  near(interpolated.cframe[0], 7.3);
  assert.equal(interpolated.uncertain, true);
  assert.equal(evaluateTrack(track, 0.23).uncertain, false);
  const predicted = evaluateTrack(track, 2.2);
  near(predicted.cframe[0], 13.6);
  assert.equal(predicted.uncertain, true);
  assert.equal(evaluateTrack(track, 2.56), null);
  assert.equal(evaluateTrack(track, -0.1), null);
});

test("missing samples and unavailable targets never become stationary from anchored metadata", () => {
  const absent = analyzeMotion([part()], []);
  assert.deepEqual(absent.tracks, []);
  const unavailable = trackFor([], { native: { unavailable: "destroyed" } });
  assert.equal(unavailable.model, "unknown");
  assert.equal(evaluateTrack(unavailable, 0), null);
  const one = trackFor([sampleAt(0.2)]);
  assert.equal(one.model, "unknown");
  assert.equal(evaluateTrack(one, 0.2).uncertain, false);
  assert.equal(evaluateTrack(one, 0.21), null);
});

test("stationarity describes sampled agreement only and cannot be extrapolated", () => {
  const track = trackFor([0, 0.1, 0.3, 0.5].map((t) => sampleAt(t)));
  assert.equal(track.model, "stationary");
  assert.equal(evaluateTrack(track, 0.1).uncertain, false);
  assert.equal(evaluateTrack(track, 0.2).uncertain, true);
  assert.equal(evaluateTrack(track, 0.5001), null);
});

test("irregular translation stays unknown instead of replaying a guessed period", () => {
  const positions = [0, 4, -2, 9, 3, 13, -8, 2, 6, -1, 17, 4, -3];
  const samples = positions.map((x, index) => sampleAt(index * 0.16, frame(x)));
  const track = trackFor(samples);
  assert.equal(track.model, "unknown");
  assert.equal(evaluateTrack(track, 2), null);
  assert.equal(evaluateTrack(track, 0.08).uncertain, true);
});

test("rotating centers are not stationary and SLERP preserves a rigid intermediate box", () => {
  const samples = [0, 0.1, 0.2].map((t) => sampleAt(t, frame(0, 0, 0, t * Math.PI * 2.5)));
  const track = trackFor(samples);
  assert.equal(track.model, "unknown");
  const middle = evaluateTrack(track, 0.15);
  const expected = frame(0, 0, 0, Math.PI * 0.375);
  for (let index = 3; index < 12; index++) near(middle.cframe[index], expected[index]);
  const longCorner = 5 * Math.SQRT1_2 + Math.SQRT1_2;
  assert.ok(track.sweptBounds.max.z >= longCorner);
  assert.ok(track.sweptBounds.min.z <= -longCorner);
  assert.equal(middle.uncertain, true);
});

test("periodic translation and rotation require an actual two-cycle nonuniform fit", () => {
  const samples = periodicSamples();
  const track = trackFor(samples);
  assert.equal(track.model, "periodic");
  near(track.period, 1, 0.002);
  assert.equal(track.sampleEnd, samples.at(-1).t);
  const future = evaluateTrack(track, track.sampleEnd + 0.2);
  assert.equal(future.uncertain, true);
  near(future.cframe[0], 4 * Math.sin(2 * Math.PI * (track.sampleEnd + 0.2)), 0.3);
  near(Math.hypot(...future.cframe.slice(3, 6)), 1);
  assert.equal(evaluateTrack(track, track.sampleEnd + 1.01), null);
});

test("one observed cycle cannot qualify a repeating model", () => {
  const track = trackFor(periodicSamples(1.1));
  assert.equal(track.model, "unknown");
  assert.equal(evaluateTrack(track, 1.5), null);
});

test("two-sample-per-cycle aliasing is rejected despite repeated endpoint poses", () => {
  const samples = Array.from({ length: 17 }, (_, index) => sampleAt(index / 4, frame(index % 2 ? 4 : -4)));
  const track = trackFor(samples);
  assert.equal(track.model, "unknown");
  assert.equal(evaluateTrack(track, 4.1), null);
});

test("phase-clustered samples do not pass periodicity just by having enough total rows", () => {
  const times = [0, 0.01, 0.02, 0.03, 1, 1.01, 1.02, 1.03, 2, 2.01, 2.02, 2.03, 3];
  const samples = times.map((t) => sampleAt(t, frame(Math.sin(2 * Math.PI * t), 0, 0, 2 * Math.PI * t)));
  assert.equal(trackFor(samples).model, "unknown");
});

test("near-constant irregular rotation does not gain a periodic claim from residual tolerance", () => {
  const rotations = [0, 0.003, -0.004, 0.002, -0.003, 0.005, 0.001, -0.002, 0.004, -0.005, 0.001];
  assert.equal(trackFor(rotations.map((angle, index) => sampleAt(index * 0.2, frame(0, 0, 0, angle)))).model, "unknown");
});

test("duplicate timestamps are deduplicated only when they agree, while conflicts are not chosen as truth", () => {
  const same = trackFor([sampleAt(0), sampleAt(0.1), sampleAt(0.1), sampleAt(0.2)]);
  assert.equal(same.model, "stationary");
  assert.deepEqual(same.samples.map((sample) => sample.t), [0, 0.1, 0.2]);
  const conflict = trackFor([sampleAt(0), sampleAt(0.1), sampleAt(0.1, frame(100)), sampleAt(0.2)]);
  assert.equal(conflict.model, "unknown");
  assert.deepEqual(conflict.samples.map((sample) => sample.t), [0, 0.2]);
  const inferred = evaluateTrack(conflict, 0.1);
  assert.equal(inferred.uncertain, true);
  assert.notEqual(inferred.cframe[0], 100);
});

test("backward time, non-rigid frames, and changing size invalidate continuous motion fitting", () => {
  const backwards = trackFor([sampleAt(0), sampleAt(0.2, frame(2)), sampleAt(0.1, frame(1)), sampleAt(0.3, frame(3))]);
  assert.equal(backwards.model, "unknown");
  const scaled = frame(); scaled[3] = 2;
  const invalid = trackFor([sampleAt(0), sampleAt(0.1, scaled), sampleAt(0.2)]);
  assert.equal(invalid.model, "unknown");
  assert.deepEqual(invalid.samples.map((sample) => sample.t), [0, 0.2]);
  const resized = trackFor([sampleAt(0), { ...sampleAt(0.1), size: { x: 30, y: 2, z: 2 } }, sampleAt(0.2)]);
  assert.equal(resized.model, "unknown");
  assert.ok(resized.sweptBounds.max.z >= Math.hypot(30, 2, 2) / 2);
});

test("long observation gaps are not silently filled even when sampled motion is linear", () => {
  const track = trackFor([sampleAt(0), sampleAt(0.1, frame(1)), sampleAt(1, frame(10))]);
  assert.equal(track.model, "linear");
  assert.equal(evaluateTrack(track, 0.5), null);
  assert.equal(evaluateTrack(track, 0.1).cframe[0], 1);
});

test("new acquisitions replace, rather than stitch, independent relative clocks", () => {
  const old = batch(periodicSamples(), { observedAt: "2026-09-09T12:00:30.000Z" });
  const latest = batch([sampleAt(0), sampleAt(0.1, frame(4))]);
  const result = analyzeMotion([part()], [latest, old]);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].model, "unknown");
  assert.equal(result.tracks[0].observedAt, observedAt);
  assert.deepEqual(result.tracks[0].samples.map((sample) => sample.t), [0, 0.1]);
  const unavailable = batch([], { observedAt: "2026-09-09T12:02:00.000Z", native: { unavailable: "destroyed" } });
  assert.equal(analyzeMotion([part()], [old, unavailable]).tracks[0].model, "unknown");
});

test("source identity is exact scoped native identity, not path or snapshot recency", () => {
  const samples = [0, 0.1, 0.2].map((t) => sampleAt(t));
  const differentClient = batch(samples, { client: { ...client, clientId: "other-client" } });
  const differentGeneration = batch(samples, { client: { ...client, generation: "generation-2" } });
  assert.deepEqual(analyzeMotion([part()], [differentClient, differentGeneration]).tracks, []);
  const renamed = batch(samples, { native: { path: "Workspace.Renamed" } });
  const newerPart = part({ path: "Workspace.OtherName", sourceSnapshotId: "d".repeat(32) });
  assert.equal(analyzeMotion([newerPart], [renamed]).tracks[0].partId, newerPart.id);
  const malformed = part({ sourceKey: JSON.stringify([client.clientId, client.generation, "e".repeat(32)]) });
  assert.deepEqual(analyzeMotion([malformed], [batch(samples)]).tracks, []);
  assert.deepEqual(analyzeMotion([part({ sourceIdentity: "capture-row" })], [batch(samples)]).tracks, []);
});

test("noncollidable hazard hints survive and only allowlisted affirmative attributes add evidence", () => {
  const dangerous = part({ name: "LavaFloor", canCollide: false, tags: ["Laser", "Decoration"], attributes: [{ name: "TouchDamage", value: 20 }, { name: "Unrelated", value: "kill" }] });
  const result = analyzeMotion([dangerous], []);
  assert.equal(result.hazards.length, 1);
  assert.equal(result.hazards[0].level, "hint");
  assert.deepEqual(new Set(result.hazards[0].kinds), new Set(["lava", "laser", "damage"]));
  assert.ok(result.hazards[0].evidence.every((item) => item.observedAt === capturedAt));
  assert.deepEqual(analyzeMotion([part({ name: "Skillington", attributes: [{ name: "Damage", value: 0 }, { name: "Kill", value: false }] })], []).hazards, []);
});

test("native health events remain ambiguous spatial-temporal associations with provenance", () => {
  const samples = [0, 0.1, 0.2].map((t) => sampleAt(t));
  const events = [
    { kind: "health-drop", t: 0.1, amount: 20, objectIds: [objectId], association: "spatial-temporal-correlation" },
    { kind: "death", t: 0.15, objectIds: [], association: "spatial-temporal-correlation" },
    { kind: "respawn", t: 0.2, objectIds: [objectId], association: "spatial-temporal-correlation" },
  ];
  const result = analyzeMotion([part({ canCollide: false })], [batch(samples, { events })]);
  assert.equal(result.hazards.length, 1);
  const hazard = result.hazards[0];
  assert.equal(hazard.level, "correlated");
  assert.deepEqual(hazard.kinds, ["health-drop"]);
  assert.equal(hazard.evidence.length, 1);
  assert.equal(hazard.evidence[0].kind, "spatial-temporal-correlation");
  assert.equal(hazard.evidence[0].observedAt, observedAt);
  assert.equal(hazard.evidence[0].t, 0.1);
  assert.deepEqual(analyzeMotion([part()], [batch(samples, { events: [events[1]] })]).hazards, []);
  assert.deepEqual(analyzeMotion([part()], [batch(samples, { events, client: { ...client, generation: "other" } })]).hazards, []);
});

test("motion sweeps retain the whole predicted rotated box for hazardous moving parts", () => {
  const samples = [0, 0.1, 0.2].map((t) => sampleAt(t, frame(10 * t)));
  const result = analyzeMotion([part({ name: "Laser" })], [batch(samples)]);
  const track = result.tracks[0];
  assert.equal(track.model, "linear");
  const radius = Math.hypot(size.x, size.y, size.z) / 2;
  assert.ok(track.sweptBounds.max.x >= 3 + radius);
  assert.ok(result.hazards[0].bounds.max.x >= track.sweptBounds.max.x);
  assert.ok(result.hazards[0].bounds.max.z >= radius);
});

test("historical health associations retain their own observed spatial envelope after a newer acquisition", () => {
  const old = batch([0, 0.1, 0.2].map((t) => sampleAt(t, frame(100))), {
    observedAt: "2026-09-09T12:00:30.000Z",
    events: [{ kind: "health-drop", t: 0.1, amount: 5, objectIds: [objectId], association: "spatial-temporal-correlation" }],
  });
  const recent = batch([0, 0.1, 0.2].map((t) => sampleAt(t)));
  const result = analyzeMotion([part()], [old, recent]);
  assert.equal(result.tracks[0].observedAt, observedAt);
  assert.equal(result.hazards[0].evidence[0].observedAt, old.observedAt);
  assert.ok(result.hazards[0].bounds.max.x >= 105);
  assert.ok(result.hazards[0].bounds.min.x <= -5);
});

test("cancellation escapes fitting instead of returning an apparently complete analysis", () => {
  const cancellation = new Error("cancelled");
  let checks = 0;
  assert.throws(() => analyzeMotion([part()], [batch(periodicSamples())], {
    check() { if (++checks === 10) throw cancellation; },
  }), (error) => error === cancellation);
});

test("prepared evaluation preserves exact samples, interpolation boundaries, invalidity and small stationary motion", () => {
  const base = trackFor([sampleAt(0, frame()), sampleAt(0.25, frame(0.004)), sampleAt(0.5, frame(0.008))]);
  assert.equal(base.model, "stationary");
  const prepared = prepareTrackEvaluator(base);
  assert.equal(prepared(0.25).cframe[0], 0.004);
  assert.equal(prepared(0.25).uncertain, false);
  near(prepared(0.125).cframe[0], 0.002);
  assert.equal(prepared(0.125).uncertain, true);
  assert.equal(prepared(0.5000000001), null);
  const gap = structuredClone(base);
  gap.samples[1].t += Number.EPSILON;
  assert.equal(prepareTrackEvaluator(gap)(0.125), null);
  assert.equal(prepareTrackEvaluator(gap)(gap.samples[1].t).uncertain, false);
  const invalid = structuredClone(base);
  invalid.samples[1].cframe[3] = 2;
  const unknown = { ...base, model: "unknown" };
  const linear = trackFor([0, 0.1, 0.2].map((t) => sampleAt(t, frame(t))));
  const periodic = trackFor(periodicSamples());
  for (const track of [base, gap, invalid, unknown, linear, periodic]) {
    const evaluate = prepareTrackEvaluator(track);
    for (const t of [NaN, -1, 0, 0.05, 0.1, 0.125, 0.25, 0.3, 0.5, 1, 2.4, 2.8, 3.5]) {
      assert.deepEqual(evaluate(t), evaluateTrack(track, t));
    }
  }
});

function recording(samples, overrides = {}) {
  const recordingId = "d".repeat(32);
  const target = { sourceObjectId: objectId, sourceSnapshotId: snapshotId, path: "Workspace.Platform", className: "Part",
    size: { ...size }, canCollide: true, anchored: true };
  const durationMs = Math.max(1000, Math.ceil(samples.at(-1).t * 1000));
  const end = samples.at(-1).t;
  return {
    recordingId, client: { ...client }, receivedAt: "2026-09-09T12:02:00.000Z",
    metadata: {
      recordingId, state: "stopped", ready: false, clock: "client-monotonic-seconds", atomicSnapshot: false,
      acceptedAt: 100, startedAt: 100, firstSampleAt: 100 + samples[0].t, readyAt: 100 + samples[0].t,
      lastSampleAt: 100 + end, stoppedAt: 100 + end, now: 100 + end, expiresAt: 220 + end,
      durationMs, intervalMs: 100, elapsedMs: end * 1000, remainingMs: 0,
      frameCount: samples.length, sampleCount: samples.length, missedIntervals: 0, retainedDrops: 0,
      sampleBytes: samples.length * 128, eventBytes: 0, eventCount: 0, markerCount: 0,
      coverage: "complete", stopReasons: ["duration-limit"], targets: [target],
    },
    frames: samples.map((sample, index) => ({ sequence: index + 1, t: sample.t,
      samples: [{ sourceObjectId: objectId, size: { ...size }, ...sample }] })),
    events: [], ...overrides,
  };
}

test("continuous archives retain the full long clock while model projections explicitly decimate", () => {
  const source = recording(Array.from({ length: 601 }, (_, index) => sampleAt(index / 10, frame(7 + index / 5))));
  const original = JSON.stringify(source);
  const adapted = adaptRecordingForModel(source);
  assert.equal(adapted.kind, "continuous-recording");
  assert.equal(adapted.durationMs, 60000);
  const result = analyzeMotion([part()], [batch([sampleAt(0), sampleAt(0.1), sampleAt(0.2)])], { recordings: [source] });
  const track = result.tracks[0];
  assert.equal(track.model, "linear");
  near(track.velocity.x, 2);
  assert.equal(track.samples.length, 101);
  assert.equal(track.sampleStart, 0);
  assert.equal(track.sampleEnd, 60);
  assert.deepEqual(track.samples.map((sample) => sample.t), Array.from({ length: 101 }, (_, index) => index * 6 / 10));
  assert.equal(track.projection.recordingId, source.recordingId);
  assert.equal(track.projection.clock, "client-monotonic-seconds");
  assert.equal(track.projection.startedAt, 100);
  assert.equal(track.projection.sourceSampleCount, 601);
  assert.equal(track.projection.selectedSampleCount, 101);
  assert.equal(track.projection.decimated, true);
  near(track.projection.sourceMaxGap, 0.1);
  near(track.projection.selectedMaxGap, 0.6);
  assert.ok(track.uncertainty.includes("projection-intervals-exceed-interpolation-limit"));
  assert.equal(evaluateTrack(track, 0.1), null, "raw archived samples omitted from the model do not fill its interpolation gaps");
  assert.equal(evaluateTrack(track, 60).cframe[0], 127);
  assert.equal(JSON.stringify(source), original);
  const forgedLegacy = batch(source.frames.slice(0, 101).map((frame) => frame.samples[0]));
  forgedLegacy.data.durationMs = 60000;
  assert.deepEqual(analyzeMotion([part()], [forgedLegacy]).tracks, []);
});

test("omitted recording motion still constrains classification and the complete hazard envelope", () => {
  const source = recording(Array.from({ length: 301 }, (_, index) => sampleAt(index / 10)));
  source.frames[1].samples[0].cframe = frame(100);
  source.events = [{ sequence: 1, kind: "health-drop", t: 20, amount: 5, objectIds: [objectId], association: "spatial-temporal-correlation" }];
  source.metadata.eventCount = 1;
  source.metadata.eventBytes = 128;
  const result = analyzeMotion([part()], [], { recordings: [source] });
  const track = result.tracks[0];
  assert.equal(track.model, "unknown", "decimation must not turn a hidden excursion into stationarity");
  assert.ok(track.samples.every((sample) => sample.cframe[0] === 0));
  assert.ok(track.sweptBounds.max.x >= 105);
  assert.ok(result.hazards[0].bounds.max.x >= 105);
  assert.equal(result.hazards[0].evidence[0].t, 20);
  assert.equal(result.hazards[0].evidence[0].observedAt, source.receivedAt);
  assert.equal(result.hazards[0].evidence[0].recordingId, source.recordingId);
  source.frames[1].samples[0].cframe = frame();
  source.frames[1].samples[0].size.x = 30;
  const resized = analyzeMotion([part()], [], { recordings: [source] }).tracks[0];
  assert.equal(resized.model, "unknown");
  assert.ok(resized.uncertainty.includes("observed-size-changes"));
});

test("long-window periodic fits need complete-source agreement, not aliased selected frames", () => {
  const source = recording(Array.from({ length: 301 }, (_, index) => sampleAt(index / 10, frame(4 * Math.cos(2 * Math.PI * index / 150)))));
  const track = analyzeMotion([part()], [], { recordings: [source] }).tracks[0];
  assert.equal(track.model, "periodic");
  near(track.period, 15, 0.01);
  source.frames[1].samples[0].cframe[0] += 2;
  assert.equal(analyzeMotion([part()], [], { recordings: [source] }).tracks[0].model, "unknown");
});

test("continuous projection rejects malformed full archives before decimation and never rebinds by path", () => {
  const source = recording(Array.from({ length: 201 }, (_, index) => sampleAt(index / 10)));
  for (const mutate of [
    (value) => { value.frames[1].sequence = 3; },
    (value) => { value.frames[1].samples[0].cframe[3] = 2; },
    (value) => { value.frames[1].samples[0].t = value.frames[0].t; },
    (value) => { value.frames[1].samples[0].sourceObjectId = "e".repeat(32); },
    (value) => { value.metadata.sampleCount--; },
    (value) => { value.metadata.state = "recording"; value.metadata.ready = true; },
  ]) {
    const invalid = structuredClone(source);
    mutate(invalid);
    assert.equal(adaptRecordingForModel(invalid), null);
    assert.deepEqual(analyzeMotion([part()], [], { recordings: [invalid] }).tracks, []);
  }
  const foreign = structuredClone(source);
  foreign.client.generation = "different";
  assert.deepEqual(analyzeMotion([part()], [], { recordings: [foreign] }).tracks, []);
  const later = batch([sampleAt(0), sampleAt(0.1, frame(4))], { observedAt: "2026-09-09T12:03:00.000Z" });
  const track = analyzeMotion([part()], [later], { recordings: [source] }).tracks[0];
  assert.deepEqual(track.samples.map((sample) => sample.t), adaptRecordingForModel(source).tracks[0].samples.map((sample) => sample.t));
  assert.equal(track.projection.recordingId, source.recordingId);
  assert.ok(track.uncertainty.includes("mixed-observation-clocks-no-cross-clock-recency"));
});

test("same-generation continuous windows are selected by native samples, not save order", () => {
  const older = recording([0, 0.1, 0.2].map((t) => sampleAt(t, frame(100))), { receivedAt: "2026-09-09T12:04:00.000Z" });
  const newer = recording([0, 0.1, 0.2].map((t) => sampleAt(t, frame(10))), { receivedAt: "2026-09-09T12:03:00.000Z" });
  newer.recordingId = newer.metadata.recordingId = "e".repeat(32);
  for (const key of ["acceptedAt", "startedAt", "firstSampleAt", "readyAt", "lastSampleAt", "stoppedAt", "now", "expiresAt"]) newer.metadata[key] += 100;
  for (const recordings of [[newer, older], [older, newer]]) {
    const track = analyzeMotion([part()], [], { recordings }).tracks[0];
    assert.equal(evaluateTrack(track, 0.1).cframe[0], 10);
    assert.equal(track.projection.recordingId, newer.recordingId);
  }
  const tied = structuredClone(newer);
  tied.recordingId = tied.metadata.recordingId = "f".repeat(32);
  tied.frames[1].samples[0].cframe[0] = 20;
  for (const recordings of [[newer, tied], [tied, newer]]) {
    const track = analyzeMotion([part()], [], { recordings }).tracks[0];
    assert.equal(track.projection.recordingId, tied.recordingId);
    assert.equal(track.model, "unknown");
    assert.ok(track.uncertainty.includes("ambiguous-observation-batch-time"));
  }
});

test("combined observation and recording targets reject track overflow without truncating evidence", () => {
  const parts = Array.from({ length: 129 }, (_, index) => {
    const sourceObjectId = (index + 1).toString(16).padStart(32, "0");
    return part({ id: `part-${index}`, sourceObjectId, sourceKey: JSON.stringify([client.clientId, client.generation, sourceObjectId]) });
  });
  const batches = Array.from({ length: 8 }, (_, index) => {
    const result = batch([]);
    result.data.tracks = parts.slice(index * 16, index * 16 + 16).map((part) => ({
      ...result.data.tracks[0], sourceObjectId: part.sourceObjectId, samples: [0, 0.1, 0.2].map((t) => sampleAt(t)),
    }));
    return result;
  });
  const source = recording([0, 0.1, 0.2].map((t) => sampleAt(t)));
  const bind = (sourceObjectId) => {
    source.metadata.targets[0].sourceObjectId = sourceObjectId;
    for (const frame of source.frames) frame.samples[0].sourceObjectId = sourceObjectId;
  };
  bind(parts[127].sourceObjectId);
  assert.equal(analyzeMotion(parts, batches, { recordings: [source] }).tracks.length, 128);
  bind(parts[128].sourceObjectId);
  assert.throws(() => analyzeMotion(parts, batches, { recordings: [source] }), { code: "MAP_MOTION_LIMIT" });
});

test("recording loss disqualifies every unidentified target's continuation but preserves real samples", () => {
  const secondId = "e".repeat(32);
  const source = recording(Array.from({ length: 21 }, (_, index) => sampleAt(index / 10, frame(index / 10))));
  source.metadata.targets.push({ ...source.metadata.targets[0], sourceObjectId: secondId });
  for (const frame of source.frames) frame.samples.push({ ...structuredClone(frame.samples[0]), sourceObjectId: secondId });
  source.metadata.sampleCount *= 2;
  source.metadata.sampleBytes *= 2;
  source.metadata.durationMs = 3000;
  source.metadata.stoppedAt = source.metadata.now = 102.1;
  source.metadata.expiresAt = 222.1;
  source.metadata.elapsedMs = 2100;
  const parts = [part(), part({ id: "second", sourceObjectId: secondId, sourceKey: JSON.stringify([client.clientId, client.generation, secondId]) })];
  for (const reason of ["object-destroyed-or-unreachable", "geometry-unavailable", "socket-disconnected", "sampler-failed"]) {
    source.metadata.stopReasons = [reason];
    source.metadata.coverage = "partial";
    const tracks = analyzeMotion(parts, [], { recordings: [source] }).tracks;
    assert.equal(tracks.length, 2);
    for (const track of tracks) {
      assert.equal(evaluateTrack(track, 2).cframe[0], 2);
      assert.equal(evaluateTrack(track, 2.5), null);
      assert.ok(track.uncertainty.includes("recording-continuation-unavailable"));
      assert.equal(track.uncertainty.includes("target-unavailable-during-observation"), ["object-destroyed-or-unreachable", "geometry-unavailable"].includes(reason));
    }
  }
  for (const reason of ["user-stop", "duration-complete", "frame-limit", "sample-byte-limit", "event-limit"]) {
    source.metadata.stopReasons = [reason];
    const track = analyzeMotion(parts, [], { recordings: [source] }).tracks[0];
    assert.equal(track.model, "linear");
    near(evaluateTrack(track, 2.5).cframe[0], 2.5);
    assert.ok(!track.uncertainty.includes("target-unavailable-during-observation"));
  }
});

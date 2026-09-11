import { createHash } from "node:crypto";

const LIMITS = { parts: 1024, batches: 8, targets: 16, tracks: 128, samples: 101, events: 64, evidence: 128, work: 1000000 };
const RECORDING_LIMITS = { recordings: 4, targets: 4, frames: 1201, events: 256 };
const TARGET_UNAVAILABLE_REASONS = new Set(["object-destroyed-or-unreachable", "geometry-unavailable"]);
const CONTINUATION_FAILURE_REASONS = new Set(["generation-changed", "socket-disconnected", "sampler-failed"]);
const ID = /^[0-9a-f]{32}$/;
const POSITION_EPSILON = 0.01;
const ANGLE_EPSILON = 0.002;
const MAX_INTERPOLATION_GAP = 0.25;
const AXES = ["x", "y", "z"];
const HINTS = new Set(["kill", "killbrick", "killpart", "killzone", "death", "deadly", "damage", "hazard", "lava", "laser", "acid", "spike", "spikes", "toxic"]);
const DAMAGE_ATTRIBUTES = new Set(["damage", "touchdamage", "contactdamage", "damageamount", "kill", "killoncontact", "killbrick", "lethal", "hazard", "ishazard", "deadly", "isdangerous"]);
const TYPE_ATTRIBUTES = new Set(["hazardtype", "damagetype", "hazardkind"]);

function identifier(prefix, value) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function validSize(size) {
  return size && AXES.every((axis) => Number.isFinite(size[axis]) && size[axis] > 0 && size[axis] <= 1e6);
}

function validFrame(frame) {
  if (!Array.isArray(frame) || frame.length !== 12 || !frame.every(Number.isFinite)) return false;
  if (frame.slice(0, 3).some((value) => Math.abs(value) > 1e7)) return false;
  for (let row = 0; row < 3; row++) {
    for (let other = row; other < 3; other++) {
      let dot = 0;
      for (let column = 0; column < 3; column++) dot += frame[3 + row * 3 + column] * frame[3 + other * 3 + column];
      if (Math.abs(dot - (row === other ? 1 : 0)) > 0.001) return false;
    }
  }
  const [, , , a, b, c, d, e, f, g, h, i] = frame;
  return Math.abs(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) - 1) <= 0.001;
}

function angleBetween(a, b) {
  let trace = 0;
  for (let index = 3; index < 12; index++) trace += a[index] * b[index];
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
}

function positionDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function sameSize(a, b) {
  return AXES.every((axis) => Math.abs(a[axis] - b[axis]) <= 0.001);
}

function copySample(sample, size, uncertain) {
  return { cframe: sample.cframe.slice(), size: { ...(sample.size ?? size) }, uncertain };
}

function rotationQuaternion(frame) {
  const [, , , a, b, c, d, e, f, g, h, i] = frame;
  const trace = a + e + i;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(h - f) / s, (c - g) / s, (d - b) / s, s / 4];
  } else if (a > e && a > i) {
    const s = Math.sqrt(1 + a - e - i) * 2;
    q = [s / 4, (b + d) / s, (c + g) / s, (h - f) / s];
  } else if (e > i) {
    const s = Math.sqrt(1 + e - a - i) * 2;
    q = [(b + d) / s, s / 4, (f + h) / s, (c - g) / s];
  } else {
    const s = Math.sqrt(1 + i - a - e) * 2;
    q = [(c + g) / s, (f + h) / s, s / 4, (d - b) / s];
  }
  const norm = Math.hypot(...q);
  return q.map((value) => value / norm);
}

function interpolate(a, b, size, fraction) {
  const q = rotationQuaternion(a.cframe);
  let r = rotationQuaternion(b.cframe);
  let dot = q.reduce((sum, value, index) => sum + value * r[index], 0);
  if (dot < 0) { r = r.map((value) => -value); dot = -dot; }
  let left = 1 - fraction;
  let right = fraction;
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(1, dot));
    const sine = Math.sin(theta);
    left = Math.sin((1 - fraction) * theta) / sine;
    right = Math.sin(fraction * theta) / sine;
  }
  const blended = q.map((value, index) => left * value + right * r[index]);
  const norm = Math.hypot(...blended);
  const [x, y, z, w] = blended.map((value) => value / norm);
  const cframe = [
    a.cframe[0] + fraction * (b.cframe[0] - a.cframe[0]),
    a.cframe[1] + fraction * (b.cframe[1] - a.cframe[1]),
    a.cframe[2] + fraction * (b.cframe[2] - a.cframe[2]),
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  const aSize = a.size ?? size;
  const bSize = b.size ?? size;
  return { cframe, size: Object.fromEntries(AXES.map((axis) => [axis, aSize[axis] + fraction * (bSize[axis] - aSize[axis])])), uncertain: true };
}

function predictionHorizon(track) {
  return Math.min(1, (track.sampleEnd - track.sampleStart) / 2, track.model === "periodic" ? track.period : Infinity);
}

// Time is observation-relative, never wall-clock/current time. Only exact samples are certain.
function validTrack(track) {
  if (!track || !validSize(track.size) || !Array.isArray(track.samples)
    || track.samples.length === 0 || track.samples.length > LIMITS.samples) return false;
  const samples = track.samples;
  let previous = -Infinity;
  for (const sample of samples) {
    if (!Number.isFinite(sample.t) || sample.t < 0 || sample.t <= previous || !validFrame(sample.cframe)
      || (sample.size !== undefined && !validSize(sample.size))) return false;
    previous = sample.t;
  }
  return track.sampleStart === samples[0].t && track.sampleEnd === samples.at(-1).t;
}

// Prepared evaluators are owned by one immutable-model invocation, never persisted
// or shared across revisions. Validation is identical to the public one-shot path.
export function prepareTrackEvaluator(track) {
  return validTrack(track) ? (t) => evaluateValidatedTrack(track, t) : () => null;
}

export function evaluateTrack(track, t) {
  return validTrack(track) ? evaluateValidatedTrack(track, t) : null;
}

function evaluateValidatedTrack(track, t) {
  if (!Number.isFinite(t) || t < 0 || t < track.sampleStart) return null;
  const samples = track.samples;
  let at = t;
  let predicted = false;
  if (at > track.sampleEnd) {
    const horizon = predictionHorizon(track);
    if (!Number.isFinite(horizon) || horizon <= 0 || at - track.sampleEnd > horizon) return null;
    if (track.model === "linear") {
      if (!track.velocity || !AXES.every((axis) => Number.isFinite(track.velocity[axis]))) return null;
      const result = copySample(samples.at(-1), track.size, true);
      for (let index = 0; index < 3; index++) result.cframe[index] += track.velocity[AXES[index]] * (at - track.sampleEnd);
      return validFrame(result.cframe) ? result : null;
    }
    if (track.model !== "periodic" || !Number.isFinite(track.period) || track.period <= 0
      || track.sampleEnd - track.sampleStart < 2 * track.period) return null;
    at = track.sampleEnd - track.period + ((at - track.sampleEnd) % track.period);
    predicted = true;
  }
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (at === sample.t) return copySample(sample, track.size, predicted);
    if (sample.t > at && index > 0) {
      const before = samples[index - 1];
      const gap = sample.t - before.t;
      if (gap > MAX_INTERPOLATION_GAP) return null;
      return interpolate(before, sample, track.size, (at - before.t) / gap);
    }
  }
  return null;
}

function normalizeSamples(native, duration, uncertainty, stopReasons) {
  const samples = new Map();
  const conflicts = new Set();
  let previous = -Infinity;
  let invalid = false;
  if (!Array.isArray(native.samples)) return { samples: [], invalid: true };
  if (native.samples.length > LIMITS.samples) { stopReasons.add("motion-sample-limit"); invalid = true; }
  for (const sample of native.samples.slice(0, LIMITS.samples)) {
    if (!sample || !Number.isFinite(sample.t) || sample.t < 0 || sample.t > duration
      || !validFrame(sample.cframe) || (sample.size !== undefined && !validSize(sample.size))) {
      uncertainty.add("invalid-observation-samples"); invalid = true; continue;
    }
    if (sample.t < previous) { uncertainty.add("nonmonotonic-observation-times"); invalid = true; }
    previous = sample.t;
    if (conflicts.has(sample.t)) continue;
    const existing = samples.get(sample.t);
    if (existing) {
      uncertainty.add("duplicate-observation-times");
      if (existing.cframe.some((value, index) => value !== sample.cframe[index])
        || !sameSize(existing.size ?? native.size, sample.size ?? native.size)) {
        samples.delete(sample.t); conflicts.add(sample.t); invalid = true;
        uncertainty.add("conflicting-observation-times");
      }
      continue;
    }
    samples.set(sample.t, { t: sample.t, cframe: sample.cframe.slice(), ...(sample.size ? { size: { ...sample.size } } : {}) });
  }
  return { samples: [...samples.values()].sort((a, b) => a.t - b.t), invalid };
}

function fitLinear(samples, tolerance) {
  const meanT = samples.reduce((sum, sample) => sum + sample.t, 0) / samples.length;
  const means = [0, 0, 0];
  for (const sample of samples) for (let index = 0; index < 3; index++) means[index] += sample.cframe[index] / samples.length;
  const slopes = [0, 0, 0];
  let denominator = 0;
  for (const sample of samples) {
    const delta = sample.t - meanT;
    denominator += delta * delta;
    for (let index = 0; index < 3; index++) slopes[index] += delta * (sample.cframe[index] - means[index]);
  }
  if (denominator <= 1e-12) return null;
  for (let index = 0; index < 3; index++) slopes[index] /= denominator;
  for (const sample of samples) {
    const residual = Math.hypot(...means.map((mean, index) => sample.cframe[index] - mean - slopes[index] * (sample.t - meanT)));
    if (residual > tolerance) return null;
  }
  return { x: slopes[0], y: slopes[1], z: slopes[2] };
}

// Fit a single harmonic to translation AND all rotation-matrix elements, not sample indices.
// Two observed cycles, per-cycle density, residuals, and a bounded frequency search are mandatory.
function fitPeriodic(samples, positionTolerance, rotationTolerance, consume, candidatePeriod) {
  const start = samples[0].t;
  const span = samples.at(-1).t - start;
  if (samples.length < 9 || span < 0.4) return null;
  let maximumGap = 0;
  for (let index = 1; index < samples.length; index++) maximumGap = Math.max(maximumGap, samples[index].t - samples[index - 1].t);
  const minimumPeriod = candidatePeriod ?? Math.max(0.2, maximumGap * 3);
  const maximumPeriod = candidatePeriod ?? span / 2;
  if (minimumPeriod < Math.max(0.2, maximumGap * 3) || maximumPeriod > span / 2) return null;
  if (minimumPeriod > maximumPeriod) return null;
  const minimumFrequency = 1 / maximumPeriod;
  const maximumFrequency = 1 / minimumPeriod;
  const cosine = new Float64Array(samples.length);
  const sine = new Float64Array(samples.length);
  const sums = new Float64Array(36);
  const coefficients = new Float64Array(36);
  const cycleCounts = new Uint16Array(Math.floor(span / minimumPeriod) + 1);
  let exhausted = false;
  const score = (frequency) => {
    const period = 1 / frequency;
    if (period > maximumPeriod || period < minimumPeriod) return Infinity;
    if (!consume(samples.length * 3)) { exhausted = true; return Infinity; }
    const cycles = Math.floor((span + 1e-9) / period);
    cycleCounts.fill(0);
    for (const sample of samples) {
      const cycle = Math.floor((sample.t - start + 1e-9) / period);
      if (cycle < cycles) cycleCounts[cycle]++;
    }
    for (let cycle = 0; cycle < cycles; cycle++) if (cycleCounts[cycle] < 4) return Infinity;
    sums.fill(0);
    let c = 0; let s = 0; let cc = 0; let ss = 0; let cs = 0;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const phase = 2 * Math.PI * frequency * (sample.t - start);
      const co = Math.cos(phase); const si = Math.sin(phase);
      cosine[index] = co; sine[index] = si;
      c += co; s += si; cc += co * co; ss += si * si; cs += co * si;
      for (let dimension = 0; dimension < 12; dimension++) {
        const value = sample.cframe[dimension] - (dimension < 3 ? samples[0].cframe[dimension] : 0);
        sums[dimension * 3] += value;
        sums[dimension * 3 + 1] += value * co;
        sums[dimension * 3 + 2] += value * si;
      }
    }
    const n = samples.length;
    const a = cc * ss - cs * cs; const b = s * cs - c * ss; const d = n * ss - s * s;
    const h = c * cs - s * cc; const e = c * s - n * cs; const f = n * cc - c * c;
    const determinant = n * a + c * b + s * h;
    if (Math.abs(determinant) < 1e-9) return Infinity;
    for (let dimension = 0; dimension < 12; dimension++) {
      const offset = dimension * 3;
      const y = sums[offset]; const yc = sums[offset + 1]; const ys = sums[offset + 2];
      coefficients[offset] = (a * y + b * yc + h * ys) / determinant;
      coefficients[offset + 1] = (b * y + d * yc + e * ys) / determinant;
      coefficients[offset + 2] = (h * y + e * yc + f * ys) / determinant;
    }
    let worst = 0;
    for (let index = 0; index < samples.length; index++) {
      let positionError = 0; let rotationError = 0;
      for (let dimension = 0; dimension < 12; dimension++) {
        const offset = dimension * 3;
        const expected = coefficients[offset] + coefficients[offset + 1] * cosine[index] + coefficients[offset + 2] * sine[index];
        const actual = samples[index].cframe[dimension] - (dimension < 3 ? samples[0].cframe[dimension] : 0);
        const squared = (actual - expected) ** 2;
        if (dimension < 3) positionError += squared; else rotationError += squared;
      }
      worst = Math.max(worst, Math.sqrt(positionError) / positionTolerance, Math.sqrt(rotationError / 2) / rotationTolerance);
    }
    return worst;
  };
  let bestFrequency = minimumFrequency;
  let bestScore = Infinity;
  let step = (maximumFrequency - minimumFrequency) / 95;
  for (let index = 0; index < 96; index++) {
    const frequency = minimumFrequency + step * index;
    const result = score(frequency);
    if (result < bestScore) { bestScore = result; bestFrequency = frequency; }
    if (exhausted) return null;
    if (step === 0) break;
  }
  for (let pass = 0; pass < 3 && step > 0; pass++) {
    const center = bestFrequency;
    step /= 4;
    for (let offset = -4; offset <= 4; offset++) {
      const frequency = center + offset * step;
      if (frequency < minimumFrequency || frequency > maximumFrequency) continue;
      const result = score(frequency);
      if (exhausted) return null;
      if (result < bestScore) { bestScore = result; bestFrequency = frequency; }
    }
  }
  return bestScore <= 1 ? 1 / bestFrequency : null;
}

function sweptBounds(part, samples, size, velocity, horizon) {
  const centers = samples.length ? samples.map((sample) => sample.cframe) : [part.cframe];
  let radius = Math.hypot(size.x, size.y, size.z) / 2;
  for (const sample of samples) {
    const sampleSize = sample.size ?? size;
    radius = Math.max(radius, Math.hypot(sampleSize.x, sampleSize.y, sampleSize.z) / 2);
  }
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const center of centers) for (let index = 0; index < 3; index++) {
    const axis = AXES[index];
    bounds.min[axis] = Math.min(bounds.min[axis], center[index] - radius);
    bounds.max[axis] = Math.max(bounds.max[axis], center[index] + radius);
  }
  if (velocity && samples.length) for (let index = 0; index < 3; index++) {
    const axis = AXES[index];
    const coordinate = samples.at(-1).cframe[index] + velocity[axis] * horizon;
    bounds.min[axis] = Math.min(bounds.min[axis], coordinate - radius);
    bounds.max[axis] = Math.max(bounds.max[axis], coordinate + radius);
  }
  return bounds;
}

function includeBounds(target, source) {
  for (const axis of AXES) {
    target.min[axis] = Math.min(target.min[axis], source.min[axis]);
    target.max[axis] = Math.max(target.max[axis], source.max[axis]);
  }
}

function analyzeTrack(part, selection, stopReasons, consume) {
  const { native, window, ambiguous } = selection;
  const uncertainty = new Set(["observed-window-only-not-current-state", "unsampled-motion-and-temporal-aliasing-remain-unknown", "swept-bounds-assume-centers-stay-inside-observed-or-predicted-envelope"]);
  const size = validSize(native.size) ? { ...native.size } : { ...part.size };
  const normalized = normalizeSamples(native, window.durationMs / 1000, uncertainty, stopReasons);
  const samples = normalized.samples;
  const projection = window.kind === "continuous-recording" ? native.projection : undefined;
  const sourceSamples = projection ? native.sourceSamples : samples;
  if (projection) {
    uncertainty.add("continuous-recording-model-projection");
    if (projection.decimated) uncertainty.add("decimated-recording-samples-omitted-from-model");
    if (projection.selectedMaxGap > MAX_INTERPOLATION_GAP) uncertainty.add("projection-intervals-exceed-interpolation-limit");
    if (projection.sourceMaxGap > MAX_INTERPOLATION_GAP) uncertainty.add("recording-intervals-exceed-interpolation-limit");
    if (native.continuationUnavailable) uncertainty.add("recording-continuation-unavailable");
  }
  const sampleStart = samples[0]?.t ?? 0;
  const sampleEnd = samples.at(-1)?.t ?? 0;
  const span = sampleEnd - sampleStart;
  let model = "unknown";
  let velocity; let period;
  if (native.unavailable) uncertainty.add("target-unavailable-during-observation");
  if (ambiguous) uncertainty.add("ambiguous-observation-batch-time");
  if (selection.mixedClocks) uncertainty.add("mixed-observation-clocks-no-cross-clock-recency");
  if (window.coverage !== "complete" || window.truncated) uncertainty.add(window.kind === "continuous-recording" ? "partial-continuous-recording" : "partial-observation-batch");
  if (!validSize(native.size)) uncertainty.add("invalid-observed-size");
  let changingSize = false;
  let sourceMatchesCapturedGeometry = true;
  let translation = 0; let rotation = 0;
  for (const sample of sourceSamples) {
    translation = Math.max(translation, positionDistance(sample.cframe, samples[0].cframe));
    rotation = Math.max(rotation, angleBetween(sample.cframe, samples[0].cframe));
    if (!sameSize(sample.size ?? size, samples[0].size ?? size)) changingSize = true;
    if (projection && (sample.cframe.some((value, index) => value !== part.cframe[index])
      || AXES.some((axis) => (sample.size ?? size)[axis] !== part.size[axis]))) sourceMatchesCapturedGeometry = false;
  }
  if (changingSize) uncertainty.add("observed-size-changes");
  if (!normalized.invalid && !native.unavailable && !native.continuationUnavailable && !ambiguous && validSize(native.size) && !changingSize && samples.length >= 3 && span >= 0.1) {
    if (translation <= POSITION_EPSILON && rotation <= ANGLE_EPSILON) {
      model = "stationary";
      uncertainty.add("stationary-at-sampled-instants-only-no-extrapolation");
    } else {
      const tolerance = Math.max(0.002, translation * 0.01);
      if (rotation <= ANGLE_EPSILON) velocity = fitLinear(sourceSamples, tolerance);
      if (velocity) {
        model = "linear";
        uncertainty.add("linear-continuation-is-a-bounded-assumption");
      } else {
        if (translation >= 0.05 || rotation >= 0.02) period = fitPeriodic(samples, tolerance, Math.max(0.0005, rotation * 0.005), consume);
        if (period && projection?.decimated && !fitPeriodic(sourceSamples, tolerance, Math.max(0.0005, rotation * 0.005), consume, period)) period = undefined;
        if (period) {
          model = "periodic";
          uncertainty.add("single-harmonic-fit-two-cycles-minimum-four-samples-per-cycle");
          uncertainty.add("periodic-continuation-is-a-bounded-assumption");
        }
      }
    }
  }
  if (model === "unknown") uncertainty.add(samples.length < 3 || span < 0.1 ? "insufficient-distinct-time-samples" : "no-qualified-motion-model");
  const track = {
    id: identifier("track", `${part.id}\0${window.observedAt}${projection ? `\0${projection.recordingId}` : ""}`), partId: part.id, model, samples, size, sampleStart, sampleEnd,
    ...(velocity ? { velocity } : {}), ...(period ? { period } : {}),
    sweptBounds: sweptBounds(part, sourceSamples, size, velocity, Math.min(1, span / 2)),
    uncertainty: [...uncertainty], observedAt: window.observedAt,
    ...(projection ? { projection: { ...projection, sourceMatchesCapturedGeometry } } : {}),
  };
  return track;
}

function metadataKinds(value, limit) {
  if (typeof value !== "string") return [];
  return [...new Set(value.slice(0, limit).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((word) => HINTS.has(word)))];
}

function retainedKey(part) {
  if (part.sourceIdentity !== "retained-instance" || !ID.test(part.sourceObjectId ?? "") || !ID.test(part.sourceSnapshotId ?? "")
    || typeof part.sourceKey !== "string" || part.sourceKey.length > 512) return null;
  try {
    const scope = JSON.parse(part.sourceKey);
    if (!Array.isArray(scope) || scope.length !== 3 || typeof scope[0] !== "string" || !scope[0] || scope[0].length > 128
      || !(typeof scope[1] === "string" && scope[1].length > 0 && scope[1].length <= 128 || Number.isSafeInteger(scope[1]) && scope[1] >= 0)
      || scope[2] !== part.sourceObjectId) return null;
    return JSON.stringify(scope);
  } catch { return null; }
}

function maximumGap(samples) {
  let result = 0;
  for (let i = 1; i < samples.length; i++) result = Math.max(result, samples[i].t - samples[i - 1].t);
  return result;
}

// This is an analysis window, never a legacy native five-second observation
// batch. Endpoints and original native-relative timestamps are retained exactly.
// Full source samples remain available here only to qualify fits and sweeps;
// persisted model tracks contain at most 101 explicitly labeled selected samples.
export function adaptRecordingForModel(recording, { check = () => {} } = {}) {
  check();
  const metadata = recording?.metadata;
  if (!metadata || !ID.test(recording.recordingId ?? "") || metadata.recordingId !== recording.recordingId
    || !["stopped", "failed"].includes(metadata.state) || metadata.ready !== false
    || metadata.clock !== "client-monotonic-seconds" || !Number.isFinite(metadata.startedAt) || metadata.startedAt < 0
    || !Number.isFinite(metadata.durationMs) || metadata.durationMs < 1000 || metadata.durationMs > 60000
    || typeof recording.receivedAt !== "string" || !Number.isFinite(Date.parse(recording.receivedAt))
    || !recording.client || typeof recording.client.clientId !== "string" || !recording.client.clientId
    || !(typeof recording.client.generation === "string" && recording.client.generation.length > 0 || Number.isSafeInteger(recording.client.generation) && recording.client.generation >= 0)
    || !Array.isArray(metadata.targets) || metadata.targets.length < 1 || metadata.targets.length > RECORDING_LIMITS.targets
    || !Array.isArray(recording.frames) || recording.frames.length < 1 || recording.frames.length > RECORDING_LIMITS.frames
    || metadata.frameCount !== recording.frames.length
    || !Array.isArray(recording.events) || recording.events.length > RECORDING_LIMITS.events) return null;
  const sources = new Map();
  for (const target of metadata.targets) {
    if (!target || !ID.test(target.sourceObjectId ?? "") || !ID.test(target.sourceSnapshotId ?? "") || !validSize(target.size) || sources.has(target.sourceObjectId)) return null;
    sources.set(target.sourceObjectId, { target, samples: [] });
  }
  let previousFrameTime = -Infinity, sampleCount = 0;
  for (let index = 0; index < recording.frames.length; index++) {
    check();
    const frame = recording.frames[index];
    if (!frame || frame.sequence !== index + 1 || !Number.isFinite(frame.t) || frame.t < 0 || frame.t <= previousFrameTime || frame.t > metadata.durationMs / 1000
      || !Array.isArray(frame.samples) || frame.samples.length !== sources.size) return null;
    previousFrameTime = frame.t;
    const seen = new Set();
    for (const sample of frame.samples) {
      const source = sample && sources.get(sample.sourceObjectId);
      if (!source || seen.has(sample.sourceObjectId) || !Number.isFinite(sample.t) || sample.t < frame.t || sample.t > metadata.durationMs / 1000
        || source.samples.length && sample.t <= source.samples.at(-1).t || !validFrame(sample.cframe) || !validSize(sample.size)) return null;
      seen.add(sample.sourceObjectId);
      source.samples.push(sample);
      sampleCount++;
    }
  }
  if (metadata.sampleCount !== sampleCount) return null;
  const reasons = Array.isArray(metadata.stopReasons) ? metadata.stopReasons : [];
  const unavailable = reasons.find((reason) => TARGET_UNAVAILABLE_REASONS.has(reason));
  // Native failure reasons currently do not identify which owned target failed.
  // Qualify all selected targets rather than guessing; ordinary quota/user/deadline
  // stops do not imply disappearance or invalidate an otherwise qualified fit.
  const continuationUnavailable = Boolean(unavailable || metadata.state === "failed" || reasons.some((reason) => CONTINUATION_FAILURE_REASONS.has(reason)));
  const tracks = [...sources.values()].map(({ target, samples: sourceSamples }) => {
    const selectedCount = Math.min(LIMITS.samples, sourceSamples.length);
    const samples = selectedCount === sourceSamples.length ? sourceSamples
      : Array.from({ length: selectedCount }, (_, i) => sourceSamples[Math.floor(i * (sourceSamples.length - 1) / (selectedCount - 1))]);
    return { ...target, samples, sourceSamples, ...(unavailable ? { unavailable } : {}), continuationUnavailable, projection: {
      kind: "continuous-recording", recordingId: recording.recordingId, clock: metadata.clock, startedAt: metadata.startedAt,
      sourceSampleCount: sourceSamples.length, selectedSampleCount: samples.length,
      sourceMaxGap: maximumGap(sourceSamples), selectedMaxGap: maximumGap(samples), decimated: samples.length < sourceSamples.length,
    } };
  });
  return { kind: "continuous-recording", recordingId: recording.recordingId, client: recording.client, observedAt: recording.receivedAt,
    durationMs: metadata.durationMs, coverage: metadata.coverage, truncated: false, tracks, events: recording.events };
}

// Pure bounded analysis. Native IDs plus exact client/generation scope are the only object association.
export function analyzeMotion(parts, observationBatches, { check = () => {}, recordings = [] } = {}) {
  const tracks = [];
  const hazards = new Map();
  const selections = new Map();
  const bySource = new Map();
  const observationBounds = new Map();
  const stopReasons = new Set();
  const warnings = new Set(["Missing hazard evidence does not establish harmlessness; hints and health correlations are not behavior proof."]);
  let work = 0;
  const consume = (count = 1) => {
    check();
    work += count;
    if (work > LIMITS.work) { stopReasons.add("motion-work-limit"); return false; }
    return true;
  };
  check();
  const boundedParts = Array.isArray(parts) ? parts.slice(0, LIMITS.parts) : [];
  const batches = Array.isArray(observationBatches) ? observationBatches.slice(0, LIMITS.batches) : [];
  if (Array.isArray(parts) && parts.length > LIMITS.parts) stopReasons.add("motion-part-limit");
  if (Array.isArray(observationBatches) && observationBatches.length > LIMITS.batches) stopReasons.add("motion-batch-limit");
  const evidence = (part, level, kind, item) => {
    let hazard = hazards.get(part.id);
    if (!hazard) {
      hazard = { id: identifier("hazard", part.id), partId: part.id, level, kinds: [], evidence: [], bounds: { min: { ...part.bounds.min }, max: { ...part.bounds.max } } };
      hazards.set(part.id, hazard);
    }
    if (level === "correlated") hazard.level = level;
    if (!hazard.kinds.includes(kind) && hazard.kinds.length < 16) hazard.kinds.push(kind);
    if (hazard.evidence.length < LIMITS.evidence) hazard.evidence.push(item);
    else stopReasons.add("hazard-evidence-limit");
  };
  for (const part of boundedParts) {
    check();
    if (!part || !validFrame(part.cframe) || !validSize(part.size) || !part.bounds) { warnings.add("Invalid parts were excluded from motion analysis."); continue; }
    const key = retainedKey(part);
    if (key) bySource.set(key, part);
    const hint = (kind, detail, kinds) => {
      const observedAt = part.capturedAt ?? part.observedAt;
      for (const value of kinds) evidence(part, "hint", value, { kind, detail: detail.slice(0, 256), ...(observedAt ? { observedAt } : {}) });
    };
    hint("name-hint", `Untrusted name hint: ${String(part.name ?? "").slice(0, 128)}`, metadataKinds(part.name, 128));
    for (const tag of (Array.isArray(part.tags) ? part.tags : []).slice(0, 16)) hint("tag-hint", `Untrusted tag hint: ${String(tag).slice(0, 128)}`, metadataKinds(tag, 128));
    for (const attribute of (Array.isArray(part.attributes) ? part.attributes : []).slice(0, 8)) {
      if (typeof attribute?.name !== "string") continue;
      const name = attribute.name.slice(0, 64).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (DAMAGE_ATTRIBUTES.has(name) && (attribute.value === true || typeof attribute.value === "number" && Number.isFinite(attribute.value) && attribute.value > 0)) {
        hint("attribute-hint", `Untrusted attribute hint: ${attribute.name.slice(0, 64)}=${String(attribute.value).slice(0, 128)}`, ["damage"]);
      } else if (TYPE_ATTRIBUTES.has(name)) {
        hint("attribute-hint", `Untrusted attribute hint: ${attribute.name.slice(0, 64)}=${String(attribute.value).slice(0, 128)}`, metadataKinds(attribute.value, 128));
      }
    }
  }
  const observeWindow = (window) => {
    check();
    const time = Date.parse(window.observedAt);
    const scopeKey = (id) => JSON.stringify([window.client.clientId, window.client.generation, id]);
    const nativeTracks = Array.isArray(window.tracks) ? window.tracks : [];
    if (nativeTracks.length > LIMITS.targets) stopReasons.add("motion-target-limit");
    const seen = new Set();
    for (const native of nativeTracks.slice(0, LIMITS.targets)) {
      check();
      const part = native && bySource.get(scopeKey(native.sourceObjectId));
      if (!part) { warnings.add("Unbound or differently scoped observation objects were not associated by path."); continue; }
      const validSamples = (Array.isArray(native.samples) ? native.samples : []).slice(0, LIMITS.samples).filter((sample) =>
        sample && Number.isFinite(sample.t) && sample.t >= 0 && sample.t <= window.durationMs / 1000
        && validFrame(sample.cframe) && (sample.size === undefined || validSize(sample.size)));
      const windowBounds = sweptBounds(part, window.kind === "continuous-recording" ? native.sourceSamples : validSamples, validSize(native.size) ? native.size : part.size, null, 0);
      if (observationBounds.has(part.id)) includeBounds(observationBounds.get(part.id), windowBounds);
      else observationBounds.set(part.id, windowBounds);
      const prior = selections.get(part.id);
      const continuous = window.kind === "continuous-recording";
      const nativeTime = continuous ? native.projection.startedAt + native.sourceSamples.at(-1).t : undefined;
      const mixedClocks = Boolean(prior?.mixedClocks || prior && (prior.window.kind === "continuous-recording") !== continuous);
      let ambiguous = seen.has(part.id), replace = !prior;
      if (prior) {
        const priorContinuous = prior.window.kind === "continuous-recording";
        if (continuous && priorContinuous) {
          ambiguous ||= nativeTime === prior.nativeTime;
          replace = nativeTime > prior.nativeTime || nativeTime === prior.nativeTime && window.recordingId >= prior.window.recordingId;
          if (nativeTime === prior.nativeTime) prior.ambiguous = true;
        } else if (!continuous && !priorContinuous) {
          ambiguous ||= time === prior.time;
          replace = prior.time <= time;
        } else {
          // Host receipt timestamps cannot order a native monotonic clock.
          // Prefer the explicit continuous window, without claiming it is newer.
          replace = continuous;
          warnings.add("Legacy observation and continuous recording clocks are not comparable; continuous models are selected without a cross-clock recency claim.");
        }
      }
      seen.add(part.id);
      if (replace) selections.set(part.id, { part, native, window, time, nativeTime, ambiguous, mixedClocks });
      else if (mixedClocks) prior.mixedClocks = true;
      if (selections.size > LIMITS.tracks) throw Object.assign(new Error("Combined motion track target capacity exceeded"), { code: "MAP_MOTION_LIMIT" });
    }
    const events = Array.isArray(window.events) ? window.events : [];
    const eventLimit = window.kind === "continuous-recording" ? RECORDING_LIMITS.events : LIMITS.events;
    if (events.length > eventLimit) stopReasons.add("motion-event-limit");
    for (const event of events.slice(0, eventLimit)) {
      check();
      if (!event || !["health-drop", "death"].includes(event.kind) || event.association !== "spatial-temporal-correlation"
        || !Number.isFinite(event.t) || event.t < 0 || event.t > window.durationMs / 1000
        || event.amount !== undefined && (!Number.isFinite(event.amount) || event.amount <= 0)) continue;
      const ids = Array.isArray(event.objectIds) ? event.objectIds.slice(0, LIMITS.targets) : [];
      if (!ids.length) warnings.add("Health events without associated source IDs provide no object-specific hazard evidence.");
      for (const id of new Set(ids)) {
        const part = bySource.get(scopeKey(id));
        if (!part || !seen.has(part.id)) continue;
        evidence(part, "correlated", event.kind, {
          kind: "spatial-temporal-correlation",
          detail: `${event.kind}${event.amount === undefined ? "" : ` (${event.amount})`} near an observed object; temporal/spatial association only, not causation.`,
          t: event.t, observedAt: window.observedAt,
          ...(window.kind === "continuous-recording" ? { recordingId: window.recordingId } : {}),
        });
      }
    }
  };
  for (const batch of batches) {
    check();
    const data = batch?.data;
    if (!data || data.schema !== 1 || !ID.test(data.sourceSnapshotId ?? "") || !Number.isFinite(data.durationMs) || data.durationMs < 100 || data.durationMs > 5000
      || data.clock !== "observation-relative-seconds" || !batch.client || typeof batch.observedAt !== "string" || !Number.isFinite(Date.parse(batch.observedAt))) {
      warnings.add("Invalid observation batches were excluded."); continue;
    }
    observeWindow({ kind: "native-observation", client: batch.client, observedAt: batch.observedAt,
      durationMs: data.durationMs, coverage: data.coverage, truncated: data.truncated, tracks: data.tracks, events: data.events });
  }
  if (Array.isArray(recordings)) {
    if (recordings.length > RECORDING_LIMITS.recordings) stopReasons.add("motion-recording-limit");
    for (const recording of recordings.slice(0, RECORDING_LIMITS.recordings)) {
      const window = adaptRecordingForModel(recording, { check });
      if (window) observeWindow(window);
      else warnings.add("Invalid or unsampled continuous recordings were excluded from model projection.");
    }
  }
  for (const selection of selections.values()) {
    check();
    const track = analyzeTrack(selection.part, selection, stopReasons, consume);
    tracks.push(track);
    const hazard = hazards.get(track.partId);
    if (hazard) {
      includeBounds(hazard.bounds, track.sweptBounds);
      includeBounds(hazard.bounds, observationBounds.get(track.partId));
    }
  }
  if (tracks.length < boundedParts.length) warnings.add("Objects without a selected valid observation batch have no motion classification; anchored metadata is not proof of stationarity.");
  if (new Set(tracks.map((track) => track.projection ? `recording:${track.projection.recordingId}:${track.projection.startedAt}` : track.observedAt)).size > 1)
    warnings.add("Tracks have different observation origins; their relative times must not be treated as simultaneous.");
  check();
  return { tracks, hazards: [...hazards.values()], stopReasons: [...stopReasons], warnings: [...warnings] };
}

import { createHash } from "node:crypto";
import { boundsForPart, containsPoint, transformPoint } from "./map-geometry.js";
import { prepareTrackEvaluator } from "./map-motion.js";

const MAX_WORK = 1_000_000;
const MAX_LINKS = 4096;
const MAX_NEIGHBORS = 32;
const MAX_GROUP_WINDOWS = 128;
const MAX_CACHE_ENTRIES = 8192;
const HORIZON = 60;
const EPS = 1e-6;
const axes = ["x", "y", "z"];
const id = (...values) => `link-${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32)}`;
const lerp = (a, b, t) => Object.fromEntries(axes.map((axis) => [axis, a[axis] + (b[axis] - a[axis]) * t]));
const overlap = (a, b) => axes.every((axis) => a.min[axis] < b.max[axis] - EPS && a.max[axis] > b.min[axis] + EPS);
const union = (a, b) => ({ min: Object.fromEntries(axes.map((k) => [k, Math.min(a.min[k], b.min[k])])), max: Object.fromEntries(axes.map((k) => [k, Math.max(a.max[k], b.max[k])])) });
const supportMode = (surface) => surface.supportMode ?? "floor";
const observationOrigin = (track) => track?.projection ? `recording:${track.projection.recordingId}:${track.projection.startedAt}` : track?.observedAt;
const signedUp = (surface) => supportMode(surface) === "ceiling" ? -1 : 1;
const enabledModes = (model) => model.mechanics?.supportModes ?? ["floor"];
const eligibleSupport = (model, surface) => enabledModes(model).includes(supportMode(surface))
  && surface.normal.y * signedUp(surface) > EPS
  && surface.normal.y * signedUp(surface) + EPS >= Math.cos(model.profile.maxSlopeDegrees * Math.PI / 180);

function budget(check) {
  let work = 0;
  return () => {
    if ((work++ & 127) === 0) check();
    if (work > MAX_WORK) throw LIMIT;
  };
}
const LIMIT = Symbol("navigation-work-limit");

function context(model, tick) {
  const byPart = new Map(model.parts.map((part) => [part.id, part]));
  const activations = (model.mechanics?.transitions ?? []).slice(0, 16).filter((report) => report.evidence?.kind === "user-report"
    && report.fromMode !== report.toMode && enabledModes(model).includes(report.fromMode) && enabledModes(model).includes(report.toMode) && byPart.has(report.partId));
  return { ...model, tick, byPart, activations, byTrack: new Map(model.tracks.map((t) => [t.partId, t])), hazardParts: new Set(model.hazards.map((h) => h.partId)),
    evaluators: new Map(), evaluations: new Map(), poses: new Map(), activationIntervals: new Map(), cacheEntries: 0 };
}

// A fixed invocation-local cap bounds retained results independently of work.
// Exact time keys retain nulls and uncertainty; "stationary" is not a pose key.
function memo(ctx, cache, owner, key, compute) {
  const values = cache.get(owner);
  if (values?.has(key)) return values.get(key);
  const value = compute();
  if (ctx.cacheEntries < MAX_CACHE_ENTRIES) {
    if (values) values.set(key, value);
    else cache.set(owner, new Map([[key, value]]));
    ctx.cacheEntries++;
  }
  return value;
}

function evaluate(ctx, track, time) {
  let evaluator = ctx.evaluators.get(track);
  if (!evaluator) {
    evaluator = prepareTrackEvaluator(track);
    ctx.evaluators.set(track, evaluator);
  }
  return memo(ctx, ctx.evaluations, track, time, () => evaluator(time));
}

function localPoint(cframe, point) {
  const x = point.x - cframe[0], y = point.y - cframe[1], z = point.z - cframe[2];
  return { x: x * cframe[3] + y * cframe[6] + z * cframe[9], y: x * cframe[4] + y * cframe[7] + z * cframe[10], z: x * cframe[5] + y * cframe[8] + z * cframe[11] };
}

function pose(ctx, surface, time) {
  const track = ctx.byTrack.get(surface.partId);
  if (!track) return memo(ctx, ctx.poses, surface, null, () => ({ surface, uncertain: false, stable: true }));
  return memo(ctx, ctx.poses, surface, time, () => trackedPose(ctx, surface, track, time));
}

function trackedPose(ctx, surface, track, time) {
  const evaluated = evaluate(ctx, track, time);
  const part = ctx.byPart.get(surface.partId);
  if (!evaluated || !part) return null;
  // Changing size or rotation invalidates the captured standable face model.
  const changed = axes.some((k) => Math.abs(evaluated.size[k] - part.size[k]) > EPS) || evaluated.cframe.slice(3).some((v, i) => Math.abs(v - part.cframe[i + 3]) > EPS);
  const convert = (p) => transformPoint(evaluated.cframe, localPoint(part.cframe, p));
  return { surface: { ...surface, center: convert(surface.center), vertices: surface.vertices.map(convert) }, uncertain: evaluated.uncertain || changed || track.model === "unknown", stable: !changed };
}

function onFace(surface, point) {
  const anchor = surface.vertices[0], n = surface.normal;
  return { x: point.x, y: anchor.y - (n.x * (point.x - anchor.x) + n.z * (point.z - anchor.z)) / n.y, z: point.z };
}

// Clip an affine foot trajectory against a translating convex face's inset.
// Projecting onto its plane keeps ordinary steps distinct from unsupported ramps.
function supportInterval(first, last, a, b, radius) {
  if (supportMode(first) !== supportMode(last) || first.normal.y * signedUp(first) <= EPS || last.normal.y * signedUp(last) <= EPS) return null;
  const start = onFace(first, a), end = onFace(last, b), n = first.normal;
  let lo = 0, hi = 1;
  for (let i = 0; i < first.vertices.length; i++) {
    const vertex = first.vertices[i], next = first.vertices[(i + 1) % first.vertices.length];
    const edge = { x: next.x - vertex.x, y: next.y - vertex.y, z: next.z - vertex.z };
    const length = Math.hypot(edge.x, edge.y, edge.z);
    if (length <= EPS) return null;
    const distance = (point, origin) => {
      const x = point.x - origin.x, y = point.y - origin.y, z = point.z - origin.z;
      return ((edge.y * z - edge.z * y) * n.x + (edge.z * x - edge.x * z) * n.y + (edge.x * y - edge.y * x) * n.z) / length;
    };
    const sign = Math.sign(distance(first.center, vertex));
    if (!sign) return null;
    const left = sign * distance(start, vertex) - radius, right = sign * distance(end, last.vertices[i]) - radius;
    if (left < -EPS && right < -EPS) return null;
    if (left < 0 && right > left) lo = Math.max(lo, Math.min(1, -left / (right - left)));
    if (right < 0 && left > right) hi = Math.min(hi, Math.max(0, left / (left - right)));
    if (lo > hi) return null;
  }
  return { lo, hi, start, end };
}

function walkingPath(ctx, from, to, departure, duration, origin, landing) {
  const knots = new Set([0, duration]), supports = [from, to];
  for (const surface of supports) {
    const track = ctx.byTrack.get(surface.partId);
    if (!track) continue;
    // Periodic extrapolation wraps sample time; do not bridge an unrecorded wrap.
    if (departure + duration > track.sampleEnd && track.model !== "linear") return null;
    for (const sample of track.samples) if (sample.t > departure && sample.t < departure + duration) knots.add(sample.t - departure);
  }
  const ordered = [...knots].sort((a, b) => a - b), points = [origin], times = [departure];
  let selected = 0, uncertain = false;
  const append = (point, time) => {
    const previous = points.at(-1);
    if (Math.abs(time - times.at(-1)) <= EPS && Math.abs(point.y - previous.y) > ctx.profile.stepHeight + EPS) return false;
    points.push(point); times.push(time);
    return true;
  };
  for (let i = 1; i < ordered.length; i++) {
    ctx.tick();
    const left = ordered[i - 1], right = ordered[i];
    const a = lerp(origin, landing, left / duration), b = lerp(origin, landing, right / duration);
    const intervals = supports.map((surface) => {
      const first = pose(ctx, surface, departure + left), last = pose(ctx, surface, departure + right), middle = pose(ctx, surface, departure + (left + right) / 2);
      if (!first?.stable || !last?.stable || !middle?.stable) return null;
      const interval = supportInterval(first.surface, last.surface, a, b, ctx.profile.radius);
      return interval && { ...interval, uncertain: first.uncertain || last.uncertain || middle.uncertain };
    });
    const breaks = [...new Set([0, 1, ...intervals.filter(Boolean).flatMap(({ lo, hi }) => [lo, hi])])].sort((a, b) => a - b);
    for (let j = 1; j < breaks.length; j++) {
      const lo = breaks[j - 1], hi = breaks[j];
      if (hi <= lo) continue;
      const midpoint = (lo + hi) / 2;
      const supportsAt = (index) => intervals[index] && intervals[index].lo <= midpoint && intervals[index].hi >= midpoint;
      if (!supportsAt(selected)) selected = 1 - selected;
      if (!supportsAt(selected)) return null;
      const other = 1 - selected;
      if (supportsAt(other) && signedUp(from) * (lerp(intervals[other].start, intervals[other].end, midpoint).y - lerp(intervals[selected].start, intervals[selected].end, midpoint).y) > EPS) selected = other;
      const interval = intervals[selected];
      uncertain ||= interval.uncertain;
      if (!append(lerp(interval.start, interval.end, lo), departure + left + (right - left) * lo)
        || !append(lerp(interval.start, interval.end, hi), departure + left + (right - left) * hi)) return null;
    }
  }
  if (!append(landing, departure + duration)) return null;
  return { points, times, uncertain };
}

const horizontalGap = (a, b) => Math.hypot(Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x), Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z));

function spatialTree(entries, tick) {
  tick();
  const bounds = entries.reduce((box, entry) => union(box, entry.bounds), entries[0].bounds);
  if (entries.length === 1) return { bounds, entry: entries[0] };
  const axis = bounds.max.x - bounds.min.x >= bounds.max.z - bounds.min.z ? "x" : "z";
  entries.sort((a, b) => (a.bounds.min[axis] + a.bounds.max[axis]) - (b.bounds.min[axis] + b.bounds.max[axis]) || a.surface.id.localeCompare(b.surface.id));
  const middle = Math.floor(entries.length / 2);
  return { bounds, left: spatialTree(entries.slice(0, middle), tick), right: spatialTree(entries.slice(middle), tick) };
}

function departureDomain(ctx, from, to, bounds) {
  const endpointTracks = [...new Set([ctx.byTrack.get(from.partId), ctx.byTrack.get(to.partId)])].filter(Boolean);
  if (endpointTracks.some((track) => !track.samples.length)) return null;
  const p = ctx.profile, apexTime = Math.min(HORIZON, p.jumpVelocity / p.gravity);
  const region = bodyBounds(bounds.min, bounds.max, p, p.jumpVelocity * apexTime - p.gravity * apexTime ** 2 / 2, signedUp(from));
  const relevant = ctx.tracks.filter((track) => {
    ctx.tick();
    return track.samples.length && (endpointTracks.includes(track) || overlap(region, track.sweptBounds));
  });
  if (!relevant.length) return { start: 0, end: 0, timed: false, departures: [0] };
  const start = Math.max(0, ...(endpointTracks.length ? endpointTracks.map((t) => t.sampleStart) : [Math.min(...relevant.map((t) => t.sampleStart))]));
  const end = Math.min(HORIZON, ...(endpointTracks.length ? endpointTracks.map((t) => t.sampleEnd) : [Math.max(...relevant.map((t) => t.sampleEnd))]));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end, timed: true, departures: Array.from({ length: 21 }, (_, i) => start + (end - start) * i / 20).filter((t, i, a) => i === 0 || t > a[i - 1]) };
}

function bodyBounds(a, b, profile, extraHeight = 0, up = 1) {
  const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y), height = profile.height + extraHeight;
  return { min: { x: Math.min(a.x, b.x) - profile.radius, y: up > 0 ? low + EPS : low - height, z: Math.min(a.z, b.z) - profile.radius }, max: { x: Math.max(a.x, b.x) + profile.radius, y: up > 0 ? high + height : high - EPS, z: Math.max(a.z, b.z) + profile.radius } };
}

function clearance(ctx, points, times, supportIds, extraHeight = 0, ridingPartId, walking = false, up = 1) {
  const reasons = new Set(), origins = new Set([...supportIds].map((partId) => observationOrigin(ctx.byTrack.get(partId))).filter(Boolean));
  for (let i = 1; i < points.length; i++) {
    const swept = bodyBounds(points[i - 1], points[i], ctx.profile, extraHeight, up);
    for (const part of ctx.parts) {
      ctx.tick();
      const hazard = ctx.hazardParts.has(part.id);
      if ((part.canCollide === false || part.collidesWithCharacter === false) && !hazard) continue;
      const track = ctx.byTrack.get(part.id);
      let bounds = part.bounds, uncertainMotion = false;
      if (track) {
        const a = evaluate(ctx, track, times[i - 1]), b = evaluate(ctx, track, times[i]);
        if (!a || !b) {
          if (overlap(swept, track.sweptBounds)) reasons.add("motion-outside-observed-window");
          continue;
        }
        // The retained full-box sweep includes between-sample rotation and hazard crossings.
        bounds = track.sweptBounds;
        if (supportIds.has(part.id) && !hazard) {
          bounds = union(boundsForPart({ ...part, cframe: a.cframe, size: a.size }), boundsForPart({ ...part, cframe: b.cframe, size: b.size }));
        }
        uncertainMotion = a.uncertain || b.uncertain || track.model === "unknown";
        if (part.id === ridingPartId && !hazard) {
          const rotationsStable = [a, b].every((value) => value.cframe.slice(3).every((v, j) => Math.abs(v - part.cframe[j + 3]) <= EPS) && axes.every((k) => Math.abs(value.size[k] - part.size[k]) <= EPS));
          if (!rotationsStable) reasons.add("changing-support-geometry");
          if (uncertainMotion) reasons.add("uncertain-motion");
          continue;
        }
      }
      if (!overlap(swept, bounds)) continue;
      if (track) origins.add(observationOrigin(track));
      if (uncertainMotion) reasons.add("uncertain-motion");
      if (hazard) { reasons.add("hazard-sweep-intersection"); continue; }
      if (part.geometry !== "block") { reasons.add("proxy-clearance"); continue; }
      if (part.collidesWithCharacter !== true) { reasons.add("unknown-character-collision"); continue; }
      // A supported step may intersect its own low riser, not arbitrary obstacles.
      if (walking && supportIds.has(part.id) && (up > 0 ? bounds.max.y <= swept.min.y + ctx.profile.stepHeight + EPS : bounds.min.y >= swept.max.y - ctx.profile.stepHeight - EPS)) continue;
      return null;
    }
  }
  if (origins.size > 1) reasons.add("mixed-observation-time-origins");
  return [...reasons];
}

function transferPath(ctx, from, departure, duration, action, origin, takeoff, landing, approach, reasons) {
  const points = [], times = [], p = ctx.profile, up = signedUp(from);
  const sampleTimes = Array.from({ length: 17 }, (_, i) => duration * i / 16);
  if (action === "drop") sampleTimes.push(approach);
  sampleTimes.sort((a, b) => a - b);
  for (const t of sampleTimes) {
    ctx.tick();
    let point = lerp(takeoff, landing, t / duration);
    if (action === "wait" || action === "ride") {
      const at = pose(ctx, from, departure + t);
      if (!at) return null;
      point = at.surface.center;
      if (at.uncertain) reasons.add("uncertain-support-motion");
    } else if (action === "drop") {
      const fallTime = Math.max(0, t - approach);
      point = t < approach ? lerp(origin, takeoff, t / approach) : lerp(takeoff, landing, fallTime / (duration - approach));
      point.y = takeoff.y - up * p.gravity * fallTime * fallTime / 2;
    } else if (action === "jump") {
      point.y = takeoff.y + up * (p.jumpVelocity * t - p.gravity * t * t / 2);
    }
    points.push(point); times.push(departure + t);
  }
  return { points, times };
}

function transition(ctx, from, to, departure, waitingDuration, transfer = "jump") {
  ctx.tick();
  const p = ctx.profile, up = signedUp(from), mode = supportMode(from);
  if (mode !== supportMode(to) || !eligibleSupport(ctx, from) || !eligibleSupport(ctx, to)) return null;
  if (!Number.isFinite(departure) || departure < 0 || departure > HORIZON) return null;
  const start = pose(ctx, from, departure);
  if (!start) return null;
  let end = pose(ctx, to, departure);
  if (!end) return null;
  const reasons = new Set();
  if (ctx.profileSource === "assumed") reasons.add("assumed-profile");
  for (const s of [from, to]) {
    if (s.geometry !== "block" || s.standable !== "modeled") reasons.add("candidate-surface");
    const part = ctx.byPart.get(s.partId);
    if (part?.collidesWithCharacter === false || part?.canCollide === false) return null;
    if (part?.collidesWithCharacter !== true) reasons.add("unknown-character-collision");
    if (part && !part.anchored && !ctx.byTrack.has(part.id)) reasons.add("unobserved-moving-support");
    if (part && ((part.linearVelocity && axes.some((k) => Math.abs(part.linearVelocity[k]) > EPS)) || (part.angularVelocity && axes.some((k) => Math.abs(part.angularVelocity[k]) > EPS))) && !ctx.byTrack.has(part.id)) reasons.add("unobserved-motion");
  }
  let duration = waitingDuration, action;
  const origin = start.surface.center;
  let takeoff = origin, approach = 0;
  if (transfer === "drop" && waitingDuration === undefined) {
    if (Math.abs(start.surface.normal.y - up) > EPS) return null;
    const target = { ...end.surface.center, y: origin.y };
    const distance = Math.hypot(target.x - origin.x, target.z - origin.z);
    if (distance <= EPS || containsPoint(start.surface, target, 0)) return null;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      ctx.tick();
      const mid = (lo + hi) / 2;
      if (containsPoint(start.surface, lerp(origin, target, mid), 0)) lo = mid;
      else hi = mid;
    }
    // Roll the body off the ledge before beginning a zero-impulse fall.
    // Continuous foot support over the last body radius is not established by a box model.
    takeoff = lerp(origin, target, lo + (p.radius + EPS * 4) / distance);
    approach = Math.hypot(takeoff.x - origin.x, takeoff.z - origin.z) / p.walkSpeed;
    reasons.add("candidate-edge-step-off");
  }
  const solve = (landing) => {
    const dy = (landing.y - takeoff.y) * up;
    const distance = Math.hypot(landing.x - takeoff.x, landing.z - takeoff.z);
    if (waitingDuration !== undefined) return { duration: waitingDuration, action: ctx.byTrack.has(from.partId) && ctx.byTrack.get(from.partId).model !== "stationary" ? "ride" : "wait" };
    if (transfer === "drop") {
      if (dy >= -p.stepHeight || -dy > p.maxDropHeight) return null;
      const fall = Math.sqrt(-2 * dy / p.gravity);
      return distance <= p.walkSpeed * fall ? { duration: approach + fall, action: "drop" } : null;
    }
    if (transfer !== "air" && Math.abs(dy) <= p.stepHeight) {
      const left = supportInterval(start.surface, start.surface, takeoff, landing, p.radius);
      const right = supportInterval(end.surface, end.surface, takeoff, landing, p.radius);
      if (left && right && left.lo <= EPS && right.hi >= 1 - EPS && left.hi + EPS >= right.lo)
        return { duration: Math.max(distance / p.walkSpeed, Math.abs(dy) / p.walkSpeed, 0.001), action: "walk" };
    }
    const discriminant = p.jumpVelocity ** 2 - 2 * p.gravity * dy;
    if (discriminant < 0 || p.jumpVelocity <= 0 || -dy > p.maxDropHeight) return null;
    const flight = (p.jumpVelocity + Math.sqrt(discriminant)) / p.gravity;
    return flight > 0 && distance <= p.walkSpeed * flight ? { duration: flight, action: "jump" } : null;
  };
  // Fixed bounded interception solve; reject residual rather than invent a reachable landing.
  for (let iteration = 0; iteration < 6; iteration++) {
    const solved = solve(end.surface.center);
    if (!solved || !Number.isFinite(solved.duration) || solved.duration <= 0 || departure + solved.duration > HORIZON) return null;
    ({ duration, action } = solved);
    end = pose(ctx, to, departure + duration);
    if (!end) return null;
  }
  const solved = solve(end.surface.center);
  if (!solved || !Number.isFinite(solved.duration) || departure + solved.duration > HORIZON || Math.abs(solved.duration - duration) > 0.001) return null;
  const landing = end.surface.center;
  if (!containsPoint(start.surface, origin, p.radius + p.landingMargin) || !containsPoint(end.surface, landing, p.radius + p.landingMargin)) return null;
  if (start.uncertain || end.uncertain) reasons.add("uncertain-support-motion");
  const walk = action === "walk" ? walkingPath(ctx, from, to, departure, duration, origin, landing) : null;
  if (action === "walk" && !walk) return transition(ctx, from, to, departure, undefined, "air");
  if (walk?.uncertain) reasons.add("uncertain-support-motion");
  const path = walk || transferPath(ctx, from, departure, duration, action, origin, takeoff, landing, approach, reasons);
  if (!path || !respectsActivations(ctx, from, to, path.points, path.times)) return null;
  const { points, times } = path;
  // Parabolic arc bows toward signed up from its chord by at most g*dt²/8.
  const arc = action === "jump" || action === "drop" ? p.gravity * (duration / 16) ** 2 / 8 : 0;
  const clear = clearance(ctx, points, times, new Set([from.partId, to.partId]), arc, waitingDuration !== undefined ? from.partId : undefined, action === "walk", up);
  if (!clear) return null;
  for (const reason of clear) reasons.add(reason);
  return { id: id(from.id, to.id, action, departure, duration), from: from.id, to: to.id, fromMode: mode, toMode: mode, action, takeoff, landing, duration, status: reasons.size ? "candidate" : "modeled", reasons: [...reasons] };
}

// Intersect actual support insets and the selected pad's oriented activation box.
// A shared horizontal footprint nominates a landing, not an observed transfer path.
function clipPolygon(polygon, distance, tick) {
  const clipped = [];
  for (let i = 0; i < polygon.length; i++) {
    tick();
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], left = distance(a), right = distance(b);
    if (left >= -EPS) clipped.push(a);
    if ((left < -EPS) !== (right < -EPS)) clipped.push(lerp(a, b, left / (left - right)));
  }
  return clipped;
}

function clipSupport(polygon, surface, margin, tick) {
  const n = surface.normal, nLength = Math.hypot(n.x, n.y, n.z);
  for (let i = 0; i < surface.vertices.length && polygon.length >= 3; i++) {
    const a = surface.vertices[i], b = surface.vertices[(i + 1) % surface.vertices.length];
    const edge = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, length = Math.hypot(edge.x, edge.y, edge.z);
    if (length <= EPS || nLength <= EPS) return [];
    const distance = (point) => {
      const projected = onFace(surface, point), x = projected.x - a.x, y = projected.y - a.y, z = projected.z - a.z;
      return ((edge.y * z - edge.z * y) * n.x + (edge.z * x - edge.x * z) * n.y + (edge.x * y - edge.y * x) * n.z) / (length * nLength);
    };
    const sign = Math.sign(distance(surface.center));
    if (!sign) return [];
    polygon = clipPolygon(polygon, (point) => sign * distance(point) - margin, tick);
  }
  return polygon;
}

function incidentRegion(ctx, surface, pad) {
  let polygon = clipSupport(surface.vertices, surface, ctx.profile.radius + ctx.profile.landingMargin, ctx.tick);
  for (const axis of axes) for (const sign of [-1, 1]) {
    if (polygon.length < 3) return [];
    polygon = clipPolygon(polygon, (point) => pad.size[axis] / 2 - sign * localPoint(pad.cframe, point)[axis], ctx.tick);
  }
  return polygon;
}

// Contact is clipped against the same inset and oriented pad box used to nominate
// switches, plus the actual support plane. Flying over a pad is not stepping on it.
function activationInterval(ctx, surface, pad, a, b, start, end) {
  ctx.tick();
  // Captured pads/supports are time-independent only in the absence of tracks.
  // Moving geometry keys include both exact times, not rounded model labels.
  const moving = ctx.byTrack.has(surface.partId) || ctx.byTrack.has(pad.id);
  const key = JSON.stringify([pad.id, a.x, a.y, a.z, b.x, b.y, b.z, ...(moving ? [start, end] : [])]);
  return memo(ctx, ctx.activationIntervals, surface, key, () => calculateActivationInterval(ctx, surface, pad, a, b, start, end));
}

function calculateActivationInterval(ctx, surface, pad, a, b, start, end) {
  const first = pose(ctx, surface, start)?.surface ?? surface, last = pose(ctx, surface, end)?.surface ?? surface;
  const interval = supportInterval(first, last, a, b, ctx.profile.radius + ctx.profile.landingMargin);
  if (!interval) return null;
  let { lo, hi } = interval;
  const clip = (left, right, min, max) => {
    const delta = right - left;
    if (Math.abs(delta) <= EPS) return left >= min - EPS && left <= max + EPS;
    const entry = (min - left) / delta, exit = (max - left) / delta;
    lo = Math.max(lo, Math.min(entry, exit));
    hi = Math.min(hi, Math.max(entry, exit));
    return lo <= hi + EPS;
  };
  const planeDistance = (point, face) => axes.reduce((sum, axis) => sum + (point[axis] - face.vertices[0][axis]) * face.normal[axis], 0);
  if (!clip(planeDistance(a, first), planeDistance(b, last), -EPS, EPS)) return null;
  const track = ctx.byTrack.get(pad.id);
  const padStart = track && evaluate(ctx, track, start), padEnd = track && evaluate(ctx, track, end);
  const left = localPoint(padStart?.cframe ?? pad.cframe, a), right = localPoint(padEnd?.cframe ?? pad.cframe, b);
  for (const axis of axes) {
    const half = Math.min((padStart?.size ?? pad.size)[axis], (padEnd?.size ?? pad.size)[axis]) / 2;
    if (!clip(left[axis], right[axis], -half, half)) return null;
  }
  return { lo, hi };
}

function respectsActivations(ctx, from, to, points, times) {
  for (const report of ctx.activations) {
    if (report.fromMode !== supportMode(from)) continue;
    const pad = ctx.byPart.get(report.partId);
    const reject = () => { ctx.activationBlocked = true; return false; };
    if (from.partId === pad.id || activationInterval(ctx, from, pad, points[0], points[0], times[0], times[0])) return reject();
    let entered = false;
    for (let i = 1; i < points.length; i++) {
      const intervals = [from, to].map((surface) => activationInterval(ctx, surface, pad, points[i - 1], points[i], times[i - 1], times[i])).filter(Boolean).sort((a, b) => a.lo - b.lo);
      if (!intervals.length) { if (entered) return reject(); continue; }
      if (entered && intervals[0].lo > EPS) return reject();
      let end = intervals[0].hi;
      for (const interval of intervals.slice(1)) {
        if (interval.lo > end + EPS) return reject();
        end = Math.max(end, interval.hi);
      }
      // Terminal incident arrival is an activation boundary node. Continuing
      // beyond that region needs a switch, not an unsplit ordinary edge.
      if (end < 1 - EPS) return reject();
      entered = true;
    }
  }
  return true;
}

function storedActivationPath(ctx, from, to, edge) {
  if (!ctx.activations.some((report) => report.fromMode === supportMode(from))) return true;
  if (edge.duration <= 0) { ctx.activationBlocked = true; return false; }
  for (const window of edge.windows ?? [{ start: 0 }]) {
    const departure = window.start, start = pose(ctx, from, departure), end = pose(ctx, to, departure + edge.duration);
    if (!start || !end) { ctx.activationBlocked = true; return false; }
    const origin = start.surface.center, landing = end.surface.center;
    const takeoff = edge.action === "drop" ? edge.takeoff : origin;
    if (!takeoff) { ctx.activationBlocked = true; return false; }
    const approach = edge.action === "drop" ? Math.hypot(takeoff.x - origin.x, takeoff.z - origin.z) / ctx.profile.walkSpeed : 0;
    if (approach >= edge.duration) { ctx.activationBlocked = true; return false; }
    const path = edge.action === "walk" ? walkingPath(ctx, from, to, departure, edge.duration, origin, landing)
      : transferPath(ctx, from, departure, edge.duration, edge.action, origin, takeoff, landing, approach, new Set());
    if (!path || !respectsActivations(ctx, from, to, path.points, path.times)) { ctx.activationBlocked = true; return false; }
  }
  return true;
}

function switchCandidate(ctx, report, pad, from, to, region) {
  ctx.tick();
  if (from.partId === to.partId || pad.id === to.partId) return null;
  const margin = ctx.profile.radius + ctx.profile.landingMargin, polygon = clipSupport(region, to, margin, ctx.tick);
  if (polygon.length < 3) return null;
  const anchor = polygon[0];
  const area = Math.abs(polygon.reduce((sum, point, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return sum + (point.x - anchor.x) * (next.z - anchor.z) - (next.x - anchor.x) * (point.z - anchor.z);
  }, 0));
  if (area <= EPS) return null;
  const takeoff = { x: 0, y: 0, z: 0 };
  for (const point of polygon) for (const axis of axes) takeoff[axis] += point[axis] / polygon.length;
  const landing = onFace(to, takeoff);
  if ((landing.y - takeoff.y) * -signedUp(to) <= EPS
    || !containsPoint(from, takeoff, margin) || !containsPoint(to, landing, margin)
    || !containsPoint(from, from.center, margin) || !containsPoint(to, to.center, margin)) return null;
  const reasons = new Set(["user-reported-mode-switch", "unobserved-transfer-trajectory", "unobserved-transfer-timing", "unobserved-orientation-sweep", "candidate-opposite-support"]);
  if (ctx.profileSource === "assumed") reasons.add("assumed-profile");
  for (const surface of [from, to]) {
    const part = ctx.byPart.get(surface.partId);
    if (!part || part.canCollide === false || part.collidesWithCharacter === false) return null;
    if (surface.geometry !== "block" || surface.standable !== "modeled") reasons.add("candidate-surface");
    if (part.collidesWithCharacter !== true) reasons.add("unknown-character-collision");
  }
  if (pad.geometry !== "block") reasons.add("proxy-activation-region");
  // The corridor is only a conservative obstruction screen. Neither a straight
  // trajectory nor the character's intermediate orientation has been measured.
  const corridor = {
    min: { x: takeoff.x - ctx.profile.radius, y: Math.min(takeoff.y, landing.y) + EPS, z: takeoff.z - ctx.profile.radius },
    max: { x: takeoff.x + ctx.profile.radius, y: Math.max(takeoff.y, landing.y) - EPS, z: takeoff.z + ctx.profile.radius },
  };
  // Surface nodes otherwise mean their centers. Convex insets provide continuous
  // support to/from the activation footprint, but their body sweeps still need clearance.
  const occupied = [corridor, bodyBounds(from.center, takeoff, ctx.profile, 0, signedUp(from)), bodyBounds(landing, to.center, ctx.profile, 0, signedUp(to))];
  for (const part of ctx.parts) {
    ctx.tick();
    const track = ctx.byTrack.get(part.id), hazard = ctx.hazardParts.has(part.id);
    const moving = !part.anchored || [part.linearVelocity, part.angularVelocity].some((velocity) => velocity && axes.some((axis) => Math.abs(velocity[axis]) > EPS));
    if ((track || moving) && [pad.id, from.partId, to.partId].includes(part.id)) reasons.add("unobserved-transfer-scene-motion");
    if ((part.canCollide === false || part.collidesWithCharacter === false) && !hazard) continue;
    const actualIntersection = occupied.some((bounds) => overlap(bounds, part.bounds));
    if (!actualIntersection && !(track && occupied.some((bounds) => overlap(bounds, track.sweptBounds)))) continue;
    if (hazard) reasons.add("hazard-transfer-corridor");
    // Recorded stationarity does not establish a future schedule, but merely
    // attaching unchanged samples cannot erase an occupied anchored solid.
    if (track) reasons.add("unobserved-transfer-scene-motion");
    // A decimated track cannot establish invariance from its selected subset.
    // Only explicit full-source agreement with captured geometry qualifies it;
    // older projections without that evidence remain uncertain, not solid proof.
    const projectionUncertain = track?.projection && (track.projection.sourceMatchesCapturedGeometry !== true
      || track.uncertainty.includes("recording-continuation-unavailable"));
    const changedSamples = track && (projectionUncertain || !track.samples.length || track.samples.some((sample) => {
      ctx.tick();
      return sample.cframe.some((value, index) => Math.abs(value - part.cframe[index]) > EPS)
        || axes.some((axis) => Math.abs((sample.size ?? track.size)[axis] - part.size[axis]) > EPS);
    }));
    if (moving || changedSamples || !actualIntersection) { reasons.add("unobserved-transfer-scene-motion"); continue; }
    if (part.geometry !== "block") { reasons.add("proxy-clearance"); continue; }
    if (part.collidesWithCharacter !== true) { reasons.add("unknown-character-collision"); continue; }
    return null;
  }
  return { id: id(from.id, to.id, "mode-switch", report.id), from: from.id, to: to.id, action: "mode-switch", fromMode: report.fromMode, toMode: report.toMode, transitionId: report.id, takeoff, landing, duration: null, status: "candidate", reasons: [...reasons] };
}

function reportedSwitches(ctx, surfaces, append) {
  for (const report of (ctx.mechanics?.transitions ?? []).slice(0, 16)) {
    ctx.tick();
    const pad = ctx.byPart.get(report.partId);
    if (!pad || report.evidence?.kind !== "user-report" || report.fromMode === report.toMode
      || !enabledModes(ctx).includes(report.fromMode) || !enabledModes(ctx).includes(report.toMode)) continue;
    for (const from of surfaces) {
      ctx.tick();
      if (supportMode(from) !== report.fromMode) continue;
      const region = incidentRegion(ctx, from, pad);
      if (region.length < 3) continue;
      for (const to of surfaces) {
        ctx.tick();
        if (supportMode(to) === report.toMode) append(switchCandidate(ctx, report, pad, from, to, region));
      }
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// The payload includes every semantic field, including ordered reasons and any
// provenance. Grouping changes representation only: no temporal interval filling.
function semanticKey(link) {
  const { id: ignoredId, windows: ignoredWindows, ...semantics } = link;
  return JSON.stringify(canonical(semantics));
}

export function buildNavigation(model, { check = () => {} } = {}) {
  const links = [], stopReasons = [], warnings = ["Routes describe recorded partial geometry, not current or live safety.", "Timed windows are discrete candidate departure opportunities, not robust safe intervals.", "Drop links include the approach to the ledge and a candidate step-off transition before a zero-impulse fall."];
  const tick = budget(check), ctx = context(model, tick);
  const selected = model.surfaces.slice(0, 2048), surfaces = selected.filter((surface) => eligibleSupport(model, surface));
  if (model.surfaces.length > selected.length) stopReasons.push("navigation-surface-limit");
  const groups = new Map();
  let rawOpportunities = 0;
  const p = model.profile;
  const range = Math.max(1, Math.min(p.walkSpeed * HORIZON, p.walkSpeed * (p.jumpVelocity + Math.sqrt(p.jumpVelocity ** 2 + 2 * p.gravity * p.maxDropHeight)) / p.gravity));
  const entries = surfaces.map((surface) => {
    const bounds = { min: Object.fromEntries(axes.map((axis) => [axis, Math.min(...surface.vertices.map((point) => point[axis]))])), max: Object.fromEntries(axes.map((axis) => [axis, Math.max(...surface.vertices.map((point) => point[axis]))])) };
    const track = ctx.byTrack.get(surface.partId);
    return { surface, bounds: track ? union(bounds, track.sweptBounds) : bounds };
  });
  const append = (link, departure, timed) => {
    if (!link) return;
    if (rawOpportunities >= MAX_LINKS) { stopReasons.push("navigation-link-limit"); throw LIMIT; }
    rawOpportunities++;
    if (timed) {
      link.windows = [{ start: departure, end: departure }];
      link.status = "candidate";
      link.reasons.push("discrete-departure-opportunity");
    }
    if (link.action !== "mode-switch" && link.status === "candidate" && link.windows) {
      const key = semanticKey(link), prior = groups.get(key);
      if (prior && prior.windows.length + link.windows.length <= MAX_GROUP_WINDOWS) {
        prior.windows.push(...link.windows);
        return;
      }
      groups.set(key, link);
    }
    links.push(link);
  };
  try {
    reportedSwitches(ctx, surfaces, append);
    const tree = entries.length ? spatialTree([...entries], tick) : null;
    for (const entry of entries) {
      tick();
      const from = entry.surface, nearby = [], pending = tree ? [tree] : [];
      while (pending.length) {
        tick();
        const node = pending.pop();
        if (horizontalGap(entry.bounds, node.bounds) > range) continue;
        if (node.entry) {
          if (node.entry.surface.id !== from.id && supportMode(node.entry.surface) === supportMode(from)) nearby.push(node.entry);
        } else pending.push(node.left, node.right);
      }
      const neighbors = nearby.sort((a, b) => horizontalGap(entry.bounds, a.bounds) - horizontalGap(entry.bounds, b.bounds)
        || Math.hypot(a.surface.center.x - from.center.x, a.surface.center.z - from.center.z) - Math.hypot(b.surface.center.x - from.center.x, b.surface.center.z - from.center.z)
        || a.surface.id.localeCompare(b.surface.id));
      if (neighbors.length > MAX_NEIGHBORS && !stopReasons.includes("navigation-neighbor-limit")) stopReasons.push("navigation-neighbor-limit");
      for (const neighbor of neighbors.slice(0, MAX_NEIGHBORS)) {
        const to = neighbor.surface, domain = departureDomain(ctx, from, to, union(entry.bounds, neighbor.bounds));
        if (!domain) continue;
        for (const departure of domain.departures) {
          append(transition(ctx, from, to, departure, undefined, "drop"), departure, domain.timed);
          append(transition(ctx, from, to, departure), departure, domain.timed);
        }
      }
      const domain = departureDomain(ctx, from, from, entry.bounds);
      if (domain?.timed) for (const departure of domain.departures) {
        if (departure < domain.end) append(transition(ctx, from, from, departure, Math.min((domain.end - domain.start) / 20, domain.end - departure)), departure, true);
      }
    }
  } catch (error) {
    if (error !== LIMIT) throw error;
    if (!stopReasons.includes("navigation-link-limit")) stopReasons.push("navigation-work-limit");
  }
  if (ctx.activationBlocked) warnings.push("Ordinary same-mode departures and unsplit crossings of reported pad activation regions are omitted; incident arrivals require a mode switch before continuing.");
  // Final IDs bind the complete ordered opportunity list, not just its first row.
  for (const link of links) if (link.action !== "mode-switch" && link.status === "candidate" && link.windows)
    link.id = id("semantic-group", semanticKey(link), link.windows);
  return { links, stopReasons, warnings, metrics: { rawOpportunities, retainedGroups: links.length } };
}

function validRouteLink(ctx, surfaces, edge) {
  const from = surfaces.get(edge.from), to = surfaces.get(edge.to);
  if (!from || !to || !eligibleSupport(ctx, from) || !eligibleSupport(ctx, to)) return false;
  const fromMode = supportMode(from), toMode = supportMode(to);
  if ((edge.fromMode ?? "floor") !== fromMode || (edge.toMode ?? "floor") !== toMode) return false;
  if ([from, to].some((surface) => {
    const part = ctx.byPart.get(surface.partId);
    return !part || part.canCollide === false || part.collidesWithCharacter === false;
  })) return false;
  if (edge.action !== "mode-switch") return fromMode === toMode && edge.transitionId === undefined
    && ["walk", "jump", "drop", "ride", "wait"].includes(edge.action) && Number.isFinite(edge.duration) && edge.duration >= 0 && storedActivationPath(ctx, from, to, edge);
  if (fromMode === toMode || edge.duration !== null || edge.windows !== undefined || edge.status !== "candidate" || from.partId === to.partId) return false;
  const report = ctx.mechanics?.transitions.find((entry) => entry.id === edge.transitionId && entry.fromMode === fromMode && entry.toMode === toMode && entry.evidence?.kind === "user-report");
  const pad = report && ctx.byPart.get(report.partId);
  if (!pad || pad.id === to.partId || !edge.takeoff || !edge.landing) return false;
  const local = localPoint(pad.cframe, edge.takeoff), margin = ctx.profile.radius + ctx.profile.landingMargin;
  return axes.every((axis) => Math.abs(local[axis]) <= pad.size[axis] / 2 + EPS)
    && containsPoint(from, edge.takeoff, margin) && containsPoint(to, edge.landing, margin)
    && Math.abs(edge.takeoff.x - edge.landing.x) <= EPS && Math.abs(edge.takeoff.z - edge.landing.z) <= EPS
    && (edge.landing.y - edge.takeoff.y) * -signedUp(to) > EPS;
}

export function planRoute(model, { from, to, departure = 0, allowUncertain = false }, { check = () => {} } = {}) {
  const reasons = ["Times are relative to stored observations; no live safety is implied."];
  const empty = (status, reason) => ({ status, steps: [], timing: "modeled", duration: 0, arrival: departure, reasons: [...reasons, reason] });
  if (!Number.isFinite(departure) || departure < 0 || departure > HORIZON) return empty("insufficient-evidence", "invalid-departure");
  const surfaces = new Map(model.surfaces.map((surface) => [surface.id, surface]));
  if (!surfaces.has(from) || !surfaces.has(to)) return empty("insufficient-evidence", "unknown-surface");
  if (!eligibleSupport(model, surfaces.get(from)) || !eligibleSupport(model, surfaces.get(to))) return empty("insufficient-evidence", "invalid-support-mode");
  const tick = budget(check), ctx = context(model, tick), adjacency = new Map();
  // Only time-invariant graphs permit earlier arrivals to dominate without waiting.
  // Unknown-time labels instead dominate by step count; a switch cannot reset time.
  const timeInvariant = !model.tracks.length && model.links.every((edge) => !edge.windows);
  const queue = [{ at: from, time: departure, steps: [] }], visited = new Map();
  let uncertain = false, stepLimited = false;
  const enqueue = (current, edge, time, wait) => {
    if (current.steps.length + (wait ? 2 : 1) > 128) { stepLimited = true; return; }
    if (queue.length >= 8192) throw LIMIT;
    queue.push({ at: edge.to, time, steps: [...current.steps, ...(wait ? [wait] : []), edge] });
  };
  try {
    for (const link of model.links.slice(0, MAX_LINKS)) {
      tick();
      if (!validRouteLink(ctx, surfaces, link)) continue;
      if (!adjacency.has(link.from)) adjacency.set(link.from, []);
      adjacency.get(link.from).push(link);
    }
    while (queue.length) {
      tick();
      queue.sort((a, b) => a.time === null ? b.time === null ? b.steps.length - a.steps.length : -1 : b.time === null ? 1 : b.time - a.time);
      const current = queue.pop(), labels = visited.get(current.at) || [];
      const dominates = (a, b) => (a.time === null || b.time === null ? a.time === b.time : timeInvariant ? a.time <= b.time : a.time === b.time) && a.steps.length <= b.steps.length;
      if (labels.some((label) => { tick(); return dominates(label, current); })) continue;
      visited.set(current.at, [...labels.filter((label) => { tick(); return !dominates(current, label); }), current]);
      if (current.at === to) {
        const unknown = current.time === null;
        return { status: "found", steps: current.steps, timing: unknown ? "unknown" : "modeled", duration: unknown ? null : current.time - departure, arrival: current.time,
          reasons: [...reasons, ...(unknown ? ["Unobserved mode-switch timing: this is an unscheduled candidate itinerary, not a timed route."] : []),
            ...(current.steps.some((step) => step.reasons.includes("unresolved-departure-window")) ? ["Post-switch departure windows remain unresolved; no waits or arrival schedule are established."] : [])] };
      }
      if (current.steps.length >= 128) { stepLimited = true; continue; }
      for (const edge of adjacency.get(current.at) || []) {
        tick();
        if (edge.status !== "modeled" && !allowUncertain) { uncertain = true; continue; }
        if (edge.duration === null || current.time === null) {
          if (!allowUncertain) { uncertain = true; continue; }
          if (edge.to === current.at) continue;
          if (current.time === null) {
            const { windows, ...unscheduled } = edge;
            enqueue(current, { ...unscheduled, status: "candidate", reasons: [...new Set([...edge.reasons, "unknown-arrival-time", ...(windows ? ["unresolved-departure-window"] : [])])] }, null);
          } else enqueue(current, edge, null);
          continue;
        }
        const windows = edge.windows || [{ start: current.time, end: current.time }];
        for (const window of windows) {
          tick();
          const leave = Math.max(current.time, window.start);
          if (!Number.isFinite(leave) || leave > window.end + EPS || leave + edge.duration > HORIZON) continue;
          let wait;
          if (leave > current.time + EPS) {
            wait = transition(ctx, surfaces.get(current.at), surfaces.get(current.at), current.time, leave - current.time);
            if (!wait) continue;
            if (wait.status !== "modeled" && !allowUncertain) { uncertain = true; continue; }
            wait.windows = [{ start: current.time, end: current.time }];
          }
          const nextTime = leave + edge.duration;
          if (nextTime <= current.time + EPS && edge.to === current.at) continue;
          enqueue(current, edge, nextTime, wait);
        }
      }
    }
  } catch (error) {
    if (error !== LIMIT) throw error;
    return empty("insufficient-evidence", "route-work-limit");
  }
  return empty(stepLimited || uncertain || model.coverage === "partial" ? "insufficient-evidence" : "unreachable", stepLimited ? "route-step-limit" : ctx.activationBlocked ? "reported-activation-crossings-excluded" : uncertain ? "uncertain-links-excluded" : "no-observed-route");
}

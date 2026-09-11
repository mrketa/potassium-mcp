import { createHash } from "node:crypto";

const AXES = ["x", "y", "z"];
const EPS = 1e-6;
const LIMITS = { parts: 1024, surfaces: 2048, chunks: 256, sources: 32, probes: 8, work: 1000000 };
const vec = (x, y, z) => ({ x, y, z });
const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => vec(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const length = (a) => Math.hypot(a.x, a.y, a.z);
const finiteVec = (a) => a && AXES.every((axis) => Number.isFinite(a[axis]));
const id = (kind, value) => `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function validTransform(cframe) {
  if (!Array.isArray(cframe) || cframe.length !== 12 || !cframe.every(Number.isFinite)) return false;
  const axes = [vec(cframe[3], cframe[6], cframe[9]), vec(cframe[4], cframe[7], cframe[10]), vec(cframe[5], cframe[8], cframe[11])];
  return axes.every((axis) => Math.abs(dot(axis, axis) - 1) <= 1e-4)
    && Math.abs(dot(axes[0], axes[1])) <= 1e-4 && Math.abs(dot(axes[0], axes[2])) <= 1e-4
    && Math.abs(dot(axes[1], axes[2])) <= 1e-4 && Math.abs(dot(cross(axes[0], axes[1]), axes[2]) - 1) <= 1e-4;
}

export function transformPoint(cframe, point) {
  if (!validTransform(cframe) || !finiteVec(point)) throw new TypeError("Invalid rigid transform or point");
  return transform(cframe, point);
}

function transform(c, p) {
  return vec(c[0] + c[3] * p.x + c[4] * p.y + c[5] * p.z,
    c[1] + c[6] * p.x + c[7] * p.y + c[8] * p.z,
    c[2] + c[9] * p.x + c[10] * p.y + c[11] * p.z);
}

function pointBounds(points) {
  const bounds = { min: vec(Infinity, Infinity, Infinity), max: vec(-Infinity, -Infinity, -Infinity) };
  for (const p of points) for (const axis of AXES) {
    bounds.min[axis] = Math.min(bounds.min[axis], p[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], p[axis]);
  }
  if (!finiteVec(bounds.min) || !finiteVec(bounds.max) || AXES.some((axis) => Math.abs(bounds.min[axis]) > 1e9 || Math.abs(bounds.max[axis]) > 1e9)) throw new TypeError("Nonfinite or out-of-range geometry bounds");
  return bounds;
}

export function boundsForPart(part) {
  if (!validTransform(part?.cframe) || !finiteVec(part.size) || AXES.some((axis) => part.size[axis] <= 0 || part.size[axis] > 1e6)) throw new TypeError("Invalid part geometry");
  const corners = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) corners.push(transform(part.cframe, vec(x * part.size.x, y * part.size.y, z * part.size.z)));
  return pointBounds(corners);
}

// Margin is a world-space inset from every polygon edge, not an AABB inset.
// The supplied point must lie on the actual 3D face, including on slopes.
export function containsPoint(surface, point, margin = 0) {
  if (!finiteVec(point) || !Number.isFinite(margin) || margin < 0 || !finiteVec(surface?.normal)
    || !Array.isArray(surface.vertices) || surface.vertices.length < 3 || surface.vertices.length > 4
    || !surface.vertices.every(finiteVec)) return false;
  const nLength = length(surface.normal);
  if (nLength < EPS) return false;
  const n = scale(surface.normal, 1 / nLength);
  if (Math.abs(dot(sub(point, surface.vertices[0]), n)) > 1e-4) return false;
  let sign = 0;
  for (let i = 0; i < surface.vertices.length; i++) {
    const a = surface.vertices[i];
    const edge = sub(surface.vertices[(i + 1) % surface.vertices.length], a);
    const edgeLength = length(edge);
    if (edgeLength <= EPS) return false;
    const distance = dot(cross(edge, sub(point, a)), n) / edgeLength;
    if (Math.abs(distance) + EPS < margin) return false;
    if (Math.abs(distance) > EPS) {
      const side = Math.sign(distance);
      if (sign && sign !== side) return false;
      sign = side;
    }
  }
  return true;
}

function faces(part, supportModes) {
  const result = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const local = vec(0, 0, 0);
    local[AXES[axis]] = sign * part.size[AXES[axis]] / 2;
    const normal = vec(sign * part.cframe[3 + axis], sign * part.cframe[6 + axis], sign * part.cframe[9 + axis]);
    const supportMode = normal.y > EPS ? "floor" : normal.y < -EPS ? "ceiling" : null;
    if (!supportModes.has(supportMode)) continue;
    const vertices = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const p = { ...local };
      p[AXES[u]] = a * part.size[AXES[u]] / 2;
      p[AXES[v]] = b * part.size[AXES[v]] / 2;
      return transform(part.cframe, p);
    });
    if (sign < 0) vertices.reverse();
    result.push({ id: id("surface", `${part.id}:${axis}:${sign}`), partId: part.id, supportMode, center: transform(part.cframe, local), normal,
      vertices, bounds: pointBounds(vertices), geometry: part.geometry, standable: part.geometry === "block" && part.collidesWithCharacter === true ? "modeled" : "candidate",
      reasons: [...(part.geometry === "block" ? [] : ["shape-unknown-bounds-only"]), ...(part.collidesWithCharacter === true ? [] : ["character-collision-eligibility-unknown"])] });
  }
  return result;
}

export function reconstructGeometry(sources, { previousParts = [], probeBatches = [], supportModes = ["floor"], profile, chunkSize = 64, check = () => {} } = {}) {
  if (!Number.isFinite(chunkSize) || chunkSize < 16 || chunkSize > 256) throw new TypeError("Invalid chunk size");
  if (!Array.isArray(supportModes) || supportModes.length < 1 || supportModes.length > 2
    || supportModes.some((mode) => mode !== "floor" && mode !== "ceiling") || new Set(supportModes).size !== supportModes.length) throw new TypeError("Invalid support modes");
  const enabledModes = new Set(supportModes);
  const maxSlope = profile?.maxSlopeDegrees ?? 45;
  const margin = (profile?.radius ?? 0) + (profile?.landingMargin ?? 0);
  if (!Number.isFinite(maxSlope) || maxSlope < 0 || maxSlope > 89 || !Number.isFinite(margin) || margin < 0) throw new TypeError("Invalid geometry profile");
  const slope = Math.cos(maxSlope * Math.PI / 180);
  const stopReasons = new Set();
  const warnings = new Set(["client-visible-partial-geometry", "chunks-contain-observed-content-only"]);
  let work = 0;
  const tick = () => {
    check();
    if (++work > LIMITS.work) throw Object.assign(new Error("Geometry work limit exceeded"), { code: "MAP_CONTEXT_LIMIT" });
  };
  tick();
  const selected = new Map();
  function accept(part) {
    const prior = selected.get(part.sourceKey);
    if (!prior || order(part.capturedAt, prior.capturedAt) > 0
      || (part.capturedAt === prior.capturedAt && order(part.sourceContextId, prior.sourceContextId) > 0)) selected.set(part.sourceKey, part);
  }
  for (const previous of previousParts.slice(0, LIMITS.parts)) {
    tick();
    // Probe geometry is regenerated from retained batches, never converted into box faces.
    if (previous.geometry === "sampled") continue;
    try { accept({ ...previous, bounds: boundsForPart(previous) }); }
    catch { warnings.add("invalid-previous-geometry-skipped"); }
  }
  if (previousParts.length > LIMITS.parts) stopReasons.add("part-limit");
  if (sources.length > LIMITS.sources) stopReasons.add("source-limit");
  const sortedSources = sources.slice(0, LIMITS.sources).slice().sort((a, b) => order(a.capturedAt, b.capturedAt) || order(a.contextId, b.contextId));
  for (const source of sortedSources) {
    tick();
    const scene = source.scene;
    if (scene.coverage === "partial" || source.truncated) warnings.add("partial-source-capture");
    for (const reason of scene.stopReasons ?? []) if (stopReasons.size < 32) stopReasons.add(String(reason).slice(0, 128));
    if (scene.parts.length > LIMITS.parts) stopReasons.add("source-part-limit");
    for (let index = 0; index < Math.min(scene.parts.length, LIMITS.parts); index++) {
      tick();
      const row = scene.parts[index];
      let bounds;
      try { bounds = boundsForPart(row); }
      catch { warnings.add("invalid-part-transform-or-size-skipped"); continue; }
      const retained = scene.schema === 2 && /^[a-f0-9]{32}$/.test(scene.sourceSnapshotId ?? "") && /^[a-f0-9]{32}$/.test(row.sourceObjectId ?? "");
      const sourceKey = JSON.stringify(retained ? [source.client.clientId, source.client.generation, row.sourceObjectId] : [source.client.clientId, source.client.generation, source.contextId, index]);
      if (sourceKey.length > 512) { warnings.add("source-identity-too-long-skipped"); continue; }
      const part = { id: id("part", sourceKey), sourceKey, sourceContextId: source.contextId,
        ...(retained ? { sourceSnapshotId: scene.sourceSnapshotId, sourceObjectId: row.sourceObjectId } : {}),
        capturedAt: source.capturedAt, name: row.name, path: row.path, className: row.className,
        cframe: [...row.cframe], size: { ...row.size }, anchored: row.anchored, canCollide: row.canCollide,
        bounds, geometry: row.className === "Part" && row.shape === "Block" ? "block" : "bounds-only",
        sourceIdentity: retained ? "retained-instance" : "capture-row" };
      for (const key of ["shape", "canTouch", "canQuery", "material", "collisionGroup", "collidesWithCharacter", "linearVelocity", "angularVelocity", "tags", "attributes"]) {
        if (row[key] !== undefined) part[key] = structuredClone(row[key]);
      }
      accept(part);
    }
  }
  // Latest rows win only their exact identity; partial updates never remove unseen identities.
  const parts = [...selected.values()].sort((a, b) => order(b.capturedAt, a.capturedAt) || order(a.id, b.id)).slice(0, LIMITS.parts);
  if (selected.size > LIMITS.parts) stopReasons.add("part-limit");
  if (new Set(parts.map((part) => part.capturedAt)).size > 1) warnings.add("mixed-age-source-geometry");
  const surfaces = [];
  function appendSurface(surface) {
    if (!enabledModes.has(surface.supportMode)) return;
    const up = surface.supportMode === "ceiling" ? -1 : 1;
    if (surface.normal.y * up + EPS < slope) { warnings.add("slope-exceeds-profile"); return; }
    if (!containsPoint(surface, surface.center, margin)) { warnings.add("landing-area-too-small"); return; }
    if (surfaces.length >= LIMITS.surfaces) { stopReasons.add("surface-limit"); return; }
    surfaces.push(surface);
  }
  for (const part of parts) {
    tick();
    if (part.geometry === "bounds-only") warnings.add("unknown-shapes-are-bounds-only");
    if (!part.canCollide || part.collidesWithCharacter === false) continue;
    for (const surface of faces(part, enabledModes)) appendSurface(surface);
  }
  const partIds = new Set(parts.map((part) => part.id));
  if (probeBatches.length > LIMITS.probes) stopReasons.add("probe-batch-limit");
  for (const batch of probeBatches.slice(0, LIMITS.probes)) {
    tick();
    const data = batch.data;
    if (!data || !Number.isInteger(data.columns) || !Number.isInteger(data.rows) || data.columns < 2 || data.columns > 8 || data.rows < 2 || data.rows > 8) {
      warnings.add("invalid-probe-grid-skipped"); continue;
    }
    warnings.add("sampled-patches-interpolate-between-rays-not-solid-proof");
    if (data.coverage === "partial" || data.truncated) warnings.add("partial-probe-grid");
    const batchKey = createHash("sha256").update(JSON.stringify(batch)).digest("hex").slice(0, 32);
    const grid = new Map();
    for (const sample of (data.samples ?? []).slice(0, 64)) {
      tick();
      if (!Number.isInteger(sample.column) || !Number.isInteger(sample.row) || sample.column < 0 || sample.column >= data.columns || sample.row < 0 || sample.row >= data.rows) continue;
      const key = `${sample.column}:${sample.row}`;
      if (grid.has(key)) { grid.set(key, null); continue; }
      grid.set(key, sample.hit && finiteVec(sample.position) && AXES.every((axis) => Math.abs(sample.position[axis]) <= 1e9) && finiteVec(sample.normal) && Math.abs(length(sample.normal) - 1) <= 1e-3 ? sample : null);
    }
    for (let column = 0; column < data.columns - 1; column++) for (let row = 0; row < data.rows - 1; row++) {
      tick();
      const hits = [[column, row], [column, row + 1], [column + 1, row + 1], [column + 1, row]].map(([x, y]) => grid.get(`${x}:${y}`));
      if (hits.some((hit) => !hit)) { warnings.add("sampled-gaps-not-interpolated"); continue; }
      if (hits.some((hit) => hit.path !== hits[0].path || hit.className !== hits[0].className)) { warnings.add("sampled-discontinuity-not-interpolated"); continue; }
      const vertices = hits.map((hit) => ({ ...hit.position }));
      let normal = cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0]));
      const magnitude = length(normal);
      if (magnitude < EPS) { warnings.add("degenerate-probe-cell-skipped"); continue; }
      normal = scale(normal, 1 / magnitude);
      // Grid winding is not evidence of support direction; preserve the measured hit normals.
      if (dot(normal, hits[0].normal) < 0) { normal = scale(normal, -1); vertices.reverse(); }
      if (hits.some((hit) => dot(hit.normal, normal) < 0.98 || Math.abs(dot(sub(hit.position, vertices[0]), normal)) > 0.05)) {
        warnings.add("sampled-discontinuity-not-interpolated"); continue;
      }
      const supportMode = normal.y > EPS ? "floor" : normal.y < -EPS ? "ceiling" : null;
      if (!enabledModes.has(supportMode)) continue;
      if (parts.length >= LIMITS.parts) { stopReasons.add("part-limit"); continue; }
      const center = scale(vertices.reduce(add, vec(0, 0, 0)), 0.25);
      const sourceKey = JSON.stringify([batch.client?.clientId ?? "probe", batch.client?.generation ?? 0, batchKey, column, row]);
      if (sourceKey.length > 512) { warnings.add("source-identity-too-long-skipped"); continue; }
      const partId = id("part", sourceKey);
      if (partIds.has(partId)) continue;
      const bounds = pointBounds(vertices);
      const size = vec(Math.max(EPS, bounds.max.x - bounds.min.x), Math.max(EPS, bounds.max.y - bounds.min.y), Math.max(EPS, bounds.max.z - bounds.min.z));
      if (AXES.some((axis) => size[axis] > 1e6)) { warnings.add("sampled-cell-size-out-of-range"); continue; }
      const surface = { id: id("surface", partId), partId, supportMode, center, normal, vertices, bounds, geometry: "sampled", standable: "candidate", reasons: ["isolated-ray-hits", "interpolation-uncertainty", "unknown-object-physics", "no-retained-instance-binding"] };
      if (!containsPoint(surface, center, 0)) { warnings.add("degenerate-probe-cell-skipped"); continue; }
      parts.push({ id: partId, sourceKey, observedAt: batch.observedAt, probe: { batchId: batchKey, column, row },
        ...(hits[0].path === undefined ? {} : { path: hits[0].path }), ...(hits[0].className === undefined ? {} : { className: hits[0].className }),
        cframe: [center.x, center.y, center.z, 1, 0, 0, 0, 1, 0, 0, 0, 1], size,
        bounds, geometry: "sampled", sourceIdentity: "probe-sample" });
      partIds.add(partId);
      appendSurface(surface);
    }
  }
  parts.sort((a, b) => order(a.id, b.id));
  surfaces.sort((a, b) => order(a.id, b.id));
  const chunksByCell = new Map();
  const chunkByPart = new Map();
  for (const part of parts) {
    tick();
    // One owner cell per observed object; bounds may cross cells. No voxel expansion.
    const cell = vec(Math.floor(part.cframe[0] / chunkSize), Math.floor(part.cframe[1] / chunkSize), Math.floor(part.cframe[2] / chunkSize));
    if (!AXES.every((axis) => Number.isSafeInteger(cell[axis]))) { warnings.add("chunk-coordinate-out-of-range"); continue; }
    const key = `${cell.x}:${cell.y}:${cell.z}`;
    let chunk = chunksByCell.get(key);
    if (!chunk) {
      if (chunksByCell.size >= LIMITS.chunks) { stopReasons.add("chunk-limit"); continue; }
      chunk = { id: id("chunk", `${chunkSize}:${key}`), cell, bounds: structuredClone(part.bounds), partIds: [], surfaceIds: [], coverage: "observed-content-only" };
      chunksByCell.set(key, chunk);
    }
    chunk.partIds.push(part.id);
    for (const axis of AXES) { chunk.bounds.min[axis] = Math.min(chunk.bounds.min[axis], part.bounds.min[axis]); chunk.bounds.max[axis] = Math.max(chunk.bounds.max[axis], part.bounds.max[axis]); }
    chunkByPart.set(part.id, chunk);
  }
  for (const surface of surfaces) { tick(); chunkByPart.get(surface.partId)?.surfaceIds.push(surface.id); }
  tick();
  return { parts, surfaces, chunks: [...chunksByCell.values()].sort((a, b) => order(a.id, b.id)), coverage: "partial", stopReasons: [...stopReasons].sort(), warnings: [...warnings].sort() };
}

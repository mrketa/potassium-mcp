import assert from "node:assert/strict";
import test from "node:test";
import { reconstructGeometry, transformPoint, boundsForPart, containsPoint } from "../src/map-geometry.js";

const v = (x, y, z) => ({ x, y, z });
const cf = (x = 0, y = 0, z = 0) => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const profile = { walkSpeed: 16, jumpVelocity: 50, gravity: 196.2, radius: 1, height: 5, maxSlopeDegrees: 45, maxDropHeight: 12, stepHeight: 1, landingMargin: 0.25 };
const part = (object = "a", overrides = {}) => ({ sourceObjectId: object.repeat(32), name: "Platform", path: "Workspace.Platform", className: "Part", shape: "Block", cframe: cf(), size: v(12, 2, 12), anchored: true, canCollide: true, collidesWithCharacter: true, ...overrides });
const source = (rows, overrides = {}) => ({ contextId: `gc-${"1".repeat(32)}`, capturedAt: "2026-09-09T00:00:00.000Z", client: { clientId: "client-test", generation: 1 }, scene: { schema: 2, sourceSnapshotId: "f".repeat(32), parts: rows, coverage: "partial", truncated: false, stopReasons: [] }, ...overrides });

test("extracts rotated 3D faces instead of flattening multilevel geometry", () => {
  const angle = Math.PI / 6;
  const c = Math.cos(angle), s = Math.sin(angle);
  const rotated = part("a", { cframe: [5, 10, 4, c, -s, 0, s, c, 0, 0, 0, 1] });
  const result = reconstructGeometry([source([rotated, part("b", { cframe: cf(5, 30, 4) })])], { profile });
  assert.equal(result.surfaces.length, 2);
  const face = result.surfaces.find((row) => row.center.y < 20);
  assert.ok(Math.abs(face.normal.y - c) < 1e-9);
  assert.ok(face.bounds.max.y - face.bounds.min.y > 5);
  assert.equal(containsPoint(face, face.center, 1.25), true);
  assert.equal(containsPoint(face, { ...face.center, y: face.center.y + 1 }), false);
  assert.deepEqual(transformPoint(cf(5, 10, 4), v(1, 2, 3)), v(6, 12, 7));
  const bounds = boundsForPart(rotated);
  assert.ok(bounds.min.y < face.bounds.min.y);
});

test("skips invalid transforms and zero sizes without discarding unrelated rows or noncollidable evidence", () => {
  const mirrored = cf(); mirrored[3] = -1;
  const scaled = cf(); scaled[7] = 2;
  const result = reconstructGeometry([source([part("a"), part("b", { size: v(0, 1, 1) }), part("c", { cframe: mirrored }), part("d", { cframe: scaled }), part("e", { canCollide: false, canTouch: true })])], { profile });
  assert.deepEqual(result.parts.map((row) => row.sourceObjectId).sort(), ["a".repeat(32), "e".repeat(32)]);
  assert.equal(result.surfaces.length, 1);
  assert.equal(result.parts.find((row) => !row.canCollide).canTouch, true);
  assert.ok(result.warnings.includes("invalid-part-transform-or-size-skipped"));
  assert.throws(() => boundsForPart(part("f", { cframe: mirrored })), TypeError);
});

test("same path never merges distinct instances; latest same-instance row preserves unseen partial data", () => {
  const first = source([part("a"), part("b", { cframe: cf(0, 20, 0) })]);
  const initial = reconstructGeometry([first], { profile });
  const later = source([part("a", { cframe: cf(10, 0, 0) }), part("c")], { contextId: `gc-${"2".repeat(32)}`, capturedAt: "2026-09-09T00:01:00.000Z" });
  const update = reconstructGeometry([later], { previousParts: initial.parts, profile });
  assert.equal(update.parts.length, 3);
  assert.equal(update.parts.find((row) => row.sourceObjectId === "a".repeat(32)).cframe[0], 10);
  assert.equal(update.parts.find((row) => row.sourceObjectId === "a".repeat(32)).id, initial.parts.find((row) => row.sourceObjectId === "a".repeat(32)).id);
  assert.equal(update.parts.find((row) => row.sourceObjectId === "b".repeat(32)).cframe[1], 20);
  assert.deepEqual(reconstructGeometry([later, first], { profile }), reconstructGeometry([first, later], { profile }));
  const anotherGeneration = source([part("a")], { client: { clientId: "client-test", generation: 2 } });
  assert.equal(reconstructGeometry([first, anotherGeneration], { profile }).parts.length, 3);
  const brokenUpdate = source([part("a", { size: v(0, 2, 12) })], { capturedAt: "2026-09-09T00:02:00.000Z" });
  const retained = reconstructGeometry([brokenUpdate], { previousParts: update.parts, profile });
  assert.equal(retained.parts.find((row) => row.sourceObjectId === "a".repeat(32)).cframe[0], 10);
});

test("legacy rows remain capture-local bounds-only candidates and narrow landing faces are rejected", () => {
  const row = part("a"); delete row.shape; delete row.sourceObjectId; delete row.collidesWithCharacter;
  const a = source([row]); a.scene.schema = 1; delete a.scene.sourceSnapshotId;
  const b = { ...a, contextId: `gc-${"2".repeat(32)}` };
  const result = reconstructGeometry([a, b], { profile });
  assert.equal(result.parts.length, 2);
  assert.ok(result.parts.every((entry) => entry.geometry === "bounds-only" && entry.sourceIdentity === "capture-row"));
  assert.ok(result.surfaces.every((entry) => entry.standable === "candidate"));
  assert.equal(reconstructGeometry([source([part("a", { size: v(2, 2, 12) })])], { profile }).surfaces.length, 0);
});

test("only established character collision produces modeled support", () => {
  const unknown = part("b"); delete unknown.collidesWithCharacter;
  const result = reconstructGeometry([source([part("a"), unknown, part("c", { collidesWithCharacter: false })])], { profile });
  const surfaces = new Map(result.surfaces.map((surface) => [result.parts.find((row) => row.id === surface.partId).sourceObjectId, surface]));
  assert.equal(surfaces.get("a".repeat(32)).standable, "modeled");
  assert.equal(surfaces.get("b".repeat(32)).standable, "candidate");
  assert.ok(surfaces.get("b".repeat(32)).reasons.includes("character-collision-eligibility-unknown"));
  assert.equal(surfaces.has("c".repeat(32)), false);
});

function probe() {
  const samples = [];
  for (let column = 0; column < 3; column++) for (let row = 0; row < 2; row++) samples.push({ column, row, origin: v(column * 10, 20, row * 10), hit: true, position: v(column * 10, 0, row * 10), normal: v(0, 1, 0), path: "Workspace.Terrain", className: "Terrain" });
  return { observedAt: "2026-09-09T00:00:00.000Z", client: { clientId: "client-test", generation: 1 }, data: { schema: 1, center: v(10, 0, 5), size: v(20, 40, 10), columns: 3, rows: 2, samples, coverage: "complete", truncated: false, stopReasons: [] } };
}

test("sampled patches stay uncertain and do not bridge missing rays or height discontinuities", () => {
  const batch = probe();
  const full = reconstructGeometry([], { probeBatches: [batch], profile });
  assert.equal(full.surfaces.length, 2);
  assert.ok(full.surfaces.every((row) => row.geometry === "sampled" && row.standable === "candidate" && row.reasons.includes("interpolation-uncertainty")));
  assert.ok(full.parts.every((row) => row.sourceIdentity === "probe-sample" && row.sourceObjectId === undefined && row.sourceContextId === undefined && row.anchored === undefined && row.canCollide === undefined));
  assert.ok(full.parts.every((row) => row.observedAt === batch.observedAt && /^[a-f0-9]{32}$/.test(row.probe.batchId)));
  const gap = structuredClone(batch); gap.data.samples[0].hit = false;
  assert.equal(reconstructGeometry([], { probeBatches: [gap], profile }).surfaces.length, 1);
  const step = structuredClone(batch); step.data.samples[0].position.y = 10;
  assert.equal(reconstructGeometry([], { probeBatches: [step], profile }).surfaces.length, 1);
  assert.equal(reconstructGeometry([], { probeBatches: [batch, batch], profile }).surfaces.length, 2);
});

test("large observed boxes use sparse owner chunks and cancellation propagates", () => {
  const result = reconstructGeometry([source([part("a", { size: v(1000000, 2, 1000000) })])], { profile });
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].bounds.max.x, 500000);
  assert.equal(result.chunks[0].coverage, "observed-content-only");
  const cancelled = new Error("cancelled");
  assert.throws(() => reconstructGeometry([source([part()])], { check() { throw cancelled; } }), (error) => error === cancelled);
});

test("ceiling undersides preserve floor identities and use outward winding with world-space margins", () => {
  const sources = [source([part()])];
  const floorOnly = reconstructGeometry(sources, { profile });
  const both = reconstructGeometry(sources, { profile, supportModes: ["floor", "ceiling"] });
  const floor = both.surfaces.find((face) => face.supportMode === "floor");
  const ceiling = both.surfaces.find((face) => face.supportMode === "ceiling");
  assert.deepEqual(floor, floorOnly.surfaces[0]);
  assert.notEqual(floor.id, ceiling.id);
  assert.deepEqual(floor.center, v(0, 1, 0));
  assert.deepEqual(ceiling.center, v(0, -1, 0));
  assert.equal(ceiling.normal.y, -1);
  assert.deepEqual(reconstructGeometry(sources, { profile, supportModes: ["ceiling"] }).surfaces, [ceiling]);
  for (const face of [floor, ceiling]) {
    const [a, b, c] = face.vertices;
    const windingY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    assert.ok(windingY * face.normal.y > 0);
    assert.equal(containsPoint(face, v(4.75, face.center.y, 0), 1.25), true);
    assert.equal(containsPoint(face, v(4.76, face.center.y, 0), 1.25), false);
    assert.equal(containsPoint(face, v(6.1, face.center.y, 0)), false);
    assert.equal(containsPoint(face, v(0, face.center.y + 0.1, 0)), false);
  }
});

test("signed slope and landing eligibility mirror on rotated floor and ceiling faces", () => {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const sources = [source([part("a", { cframe: [0, 0, 0, c, -s, 0, s, c, 0, 0, 0, 1] })])];
  const both = reconstructGeometry(sources, { profile, supportModes: ["floor", "ceiling"] });
  assert.equal(both.surfaces.length, 2);
  for (const face of both.surfaces) {
    const up = face.supportMode === "floor" ? 1 : -1;
    assert.ok(Math.abs(face.normal.y * up - c) < 1e-9);
    assert.equal(containsPoint(face, face.center, 1.25), true);
    const nearEdge = transformPoint(sources[0].scene.parts[0].cframe, v(4.8, up, 0));
    assert.equal(containsPoint(face, nearEdge, 1.25), false);
  }
  assert.equal(reconstructGeometry(sources, { profile: { ...profile, maxSlopeDegrees: 20 }, supportModes: ["floor", "ceiling"] }).surfaces.length, 0);
  assert.equal(reconstructGeometry([source([part("a", { size: v(2, 2, 12) })])], { profile, supportModes: ["floor", "ceiling"] }).surfaces.length, 0);
});

test("ceiling support preserves collision and shape uncertainty rather than promoting proxies", () => {
  const unknown = part("b"); delete unknown.collidesWithCharacter;
  const result = reconstructGeometry([source([part("a"), unknown, part("c", { collidesWithCharacter: false }),
    part("d", { canCollide: false }), part("e", { className: "MeshPart", shape: undefined })])],
  { profile, supportModes: ["floor", "ceiling"] });
  const byObject = (object) => result.surfaces.filter((face) => face.partId === result.parts.find((row) => row.sourceObjectId === object.repeat(32)).id);
  assert.equal(byObject("a").length, 2);
  assert.ok(byObject("a").every((face) => face.standable === "modeled"));
  assert.equal(byObject("b").length, 2);
  assert.ok(byObject("b").every((face) => face.standable === "candidate" && face.reasons.includes("character-collision-eligibility-unknown")));
  assert.deepEqual(byObject("c"), []);
  assert.deepEqual(byObject("d"), []);
  assert.equal(byObject("e").length, 2);
  assert.ok(byObject("e").every((face) => face.standable === "candidate" && face.reasons.includes("shape-unknown-bounds-only")));
});

test("probe patches follow measured normals without synthesizing opposite support", () => {
  const upward = probe();
  const downward = probe();
  for (const sample of downward.data.samples) {
    sample.origin.y = -20;
    sample.normal.y = -1;
  }
  const options = { profile, supportModes: ["floor", "ceiling"] };
  const floors = reconstructGeometry([], { ...options, probeBatches: [upward] }).surfaces;
  const ceilings = reconstructGeometry([], { ...options, probeBatches: [downward] }).surfaces;
  assert.equal(floors.length, 2);
  assert.ok(floors.every((face) => face.supportMode === "floor" && face.normal.y === 1));
  assert.equal(ceilings.length, 2);
  assert.ok(ceilings.every((face) => face.supportMode === "ceiling" && face.normal.y === -1 && face.standable === "candidate" && containsPoint(face, face.center, 1.25)));
  assert.equal(reconstructGeometry([], { profile, probeBatches: [downward] }).surfaces.length, 0);
  assert.equal(reconstructGeometry([], { profile, supportModes: ["ceiling"], probeBatches: [upward] }).surfaces.length, 0);
  downward.data.samples[0].normal.y = 1;
  const discontinuous = reconstructGeometry([], { ...options, probeBatches: [downward] });
  assert.equal(discontinuous.surfaces.length, 1);
  assert.equal(discontinuous.surfaces[0].supportMode, "ceiling");
  assert.ok(discontinuous.warnings.includes("sampled-discontinuity-not-interpolated"));
});

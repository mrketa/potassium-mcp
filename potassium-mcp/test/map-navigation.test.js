import assert from "node:assert/strict";
import test from "node:test";
import { buildNavigation, planRoute } from "../src/map-navigation.js";
import { boundsForPart } from "../src/map-geometry.js";
import { analyzeMotion } from "../src/map-motion.js";

const profile = { walkSpeed: 10, jumpVelocity: 10, gravity: 20, radius: 0.4, height: 2, maxSlopeDegrees: 45, maxDropHeight: 5, stepHeight: 0.3, landingMargin: 0.1 };
const frame = (x, y, z = 0) => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1];
function platform(id, x, y = 0, width = 3) {
  const part = { id, cframe: frame(x, y - 0.5), size: { x: width, y: 1, z: 3 }, anchored: true, canCollide: true, collidesWithCharacter: true, geometry: "block" };
  part.bounds = boundsForPart(part);
  const surface = { id: `s-${id}`, partId: id, center: { x, y, z: 0 }, normal: { x: 0, y: 1, z: 0 }, vertices: [{ x: x - width / 2, y, z: -1.5 }, { x: x + width / 2, y, z: -1.5 }, { x: x + width / 2, y, z: 1.5 }, { x: x - width / 2, y, z: 1.5 }], bounds: part.bounds, geometry: "block", standable: "modeled", reasons: [] };
  return { part, surface };
}
function model(...platforms) {
  return { parts: platforms.map((p) => p.part), surfaces: platforms.map((p) => p.surface), chunks: [], tracks: [], hazards: [], profile, profileSource: "supplied", coverage: "partial", links: [] };
}
const edge = (m, from = "s-a", to = "s-b") => buildNavigation(m).links.find((l) => l.from === from && l.to === to);
function track(part, x = 2) {
  return { id: `t-${part.id}`, partId: part.id, model: "linear", size: part.size, samples: Array.from({ length: 21 }, (_, i) => ({ t: i / 10, cframe: frame(part.cframe[0] + x * i / 20, part.cframe[1]) })), sampleStart: 0, sampleEnd: 2, velocity: { x: x / 2, y: 0, z: 0 }, sweptBounds: { min: { ...part.bounds.min }, max: { ...part.bounds.max, x: part.bounds.max.x + x } }, uncertainty: [], observedAt: "2026-09-09T00:00:00.000Z" };
}

function ceilingModel(source) {
  const result = structuredClone(source);
  const point = (value) => ({ ...value, y: -value.y });
  const bounds = (value) => ({ min: { ...value.min, y: -value.max.y }, max: { ...value.max, y: -value.min.y } });
  for (const part of result.parts) {
    part.cframe[1] *= -1;
    part.bounds = bounds(part.bounds);
    if (part.linearVelocity) part.linearVelocity.y *= -1;
    if (part.angularVelocity) part.angularVelocity.y *= -1;
  }
  for (const surface of result.surfaces) {
    surface.center = point(surface.center);
    surface.normal = point(surface.normal);
    surface.vertices = surface.vertices.map(point);
    surface.bounds = bounds(surface.bounds);
    surface.supportMode = "ceiling";
  }
  for (const motion of result.tracks) {
    for (const sample of motion.samples) sample.cframe[1] *= -1;
    motion.velocity.y *= -1;
    motion.sweptBounds = bounds(motion.sweptBounds);
  }
  for (const hazard of result.hazards) hazard.bounds = bounds(hazard.bounds);
  result.mechanics = { supportModes: ["ceiling"], transitions: [] };
  return result;
}

function ceilingPlatform(id, x, y = 10, width = 3) {
  const mirrored = ceilingModel(model(platform(id, x, -y, width)));
  return { part: mirrored.parts[0], surface: mirrored.surfaces[0] };
}

function reported(partId, fromMode, toMode) {
  return { id: `report-${partId}-${fromMode}`, partId, fromMode, toMode, evidence: { kind: "user-report", note: "First pad enables ceiling walking; second returns to floor.", reportedAt: "2026-09-09T00:00:00.000Z" } };
}

function switchModel() {
  const result = model(platform("a", 0), ceilingPlatform("roof", 0, 10, 6), ceilingPlatform("upper", 4, 10, 6), platform("finish", 4));
  result.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
  result.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", "floor", "ceiling"), reported("upper", "ceiling", "floor")] };
  return result;
}
test("unknown character collision is candidate and false cannot support a route", () => {
  const m = model(platform("a", 0), platform("b", 5));
  delete m.parts[1].collidesWithCharacter;
  assert.equal(edge(m)?.status, "candidate");
  m.parts[1].collidesWithCharacter = false;
  assert.equal(edge(m), undefined);
});


test("unknown probe collision state qualifies crossing clearance instead of disappearing", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const probe = platform("probe", 2.5, 3, 2).part;
  delete probe.canCollide;
  delete probe.anchored;
  delete probe.collidesWithCharacter;
  probe.geometry = "sampled";
  probe.sourceIdentity = "probe-sample";
  m.parts.push(probe);
  const crossing = edge(m);
  assert.equal(crossing?.status, "candidate");
  assert.ok(crossing.reasons.includes("proxy-clearance"));
});

test("continuous support permits walking but a sub-sampling gap needs a jump", () => {
  assert.equal(edge(model(platform("a", 0, 0, 6), platform("b", 4, 0, 6)))?.action, "walk");
  const gap = model(platform("a", 0), platform("b", 3.01));
  assert.equal(edge(gap)?.action, "jump");
  gap.profile = { ...profile, jumpVelocity: 0 };
  assert.equal(edge(gap), undefined);
});

test("extent-aware neighbors preserve overlapping zero-jump walking routes", () => {
  const close = model(platform("a", 0, 0, 6), platform("b", 4, 0, 6));
  close.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
  close.links = buildNavigation(close).links;
  const route = planRoute(close, { from: "s-a", to: "s-b" });
  assert.equal(route.status, "found");
  assert.equal(route.steps[0].action, "walk");
  assert.equal(route.duration, 0.4);
  const long = model(platform("a", 0, 0, 600), platform("b", 500, 0, 600));
  long.profile = close.profile;
  assert.equal(edge(long)?.duration, 50);
});

test("bounded steps use their support planes and still reject gaps and overhead obstacles", () => {
  const steps = model(platform("a", 0, 0, 6), platform("b", 4, 0.2, 6));
  steps.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
  assert.equal(edge(steps)?.action, "walk");
  assert.equal(edge(steps, "s-b", "s-a")?.action, "walk");
  const tooHigh = model(platform("a", 0, 0, 6), platform("b", 4, 0.31, 6));
  tooHigh.profile = steps.profile;
  assert.equal(edge(tooHigh), undefined);
  const gap = model(platform("a", 0, 0, 6), platform("b", 6.01, 0.2, 6));
  gap.profile = steps.profile;
  assert.equal(edge(gap), undefined);
  steps.parts.push(platform("ceiling", 2, 2.5, 6).part);
  assert.equal(edge(steps), undefined);
});

test("height and horizontal reach constrain full 3D jumps", () => {
  assert.equal(edge(model(platform("a", 0), platform("b", 5)))?.action, "jump");
  assert.equal(edge(model(platform("a", 0), platform("b", 5, 3))), undefined);
  assert.equal(edge(model(platform("a", 0), platform("b", 12))), undefined);
});

test("out-of-horizon ballistic transfers do not invalidate useful local walks", () => {
  const m = model(platform("a", 0), platform("b", 5), platform("c", -1));
  m.profile = { ...profile, gravity: 0.001 };
  m.links = buildNavigation(m).links;
  assert.equal(m.links.find((link) => link.from === "s-a" && link.to === "s-b"), undefined);
  assert.equal(planRoute(m, { from: "s-a", to: "s-c" }).status, "found");
  assert.ok(m.links.every((link) => Number.isFinite(link.duration) && link.duration > 0 && link.duration <= 60));
  const distant = model(platform("a", 0, 0, 1000), platform("b", 700, 0, 1000));
  distant.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
  assert.equal(edge(distant), undefined);
});

test("body headroom rejects an otherwise reachable arc", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const ceiling = platform("ceiling", 2.5, 3, 12).part;
  m.parts.push(ceiling);
  assert.equal(edge(m), undefined);
});

test("landing inset rejects narrow targets and maximum drop is directed", () => {
  assert.equal(edge(model(platform("a", 0), platform("b", 5, 0, 0.8))), undefined);
  const down = model(platform("a", 0), platform("b", 5, -4));
  assert.equal(edge(down)?.action, "drop");
  assert.ok(buildNavigation(down).links.some((link) => link.from === "s-a" && link.to === "s-b" && link.action === "jump"));
  down.profile = { ...profile, jumpVelocity: 0 };
  const drop = edge(down);
  assert.equal(drop?.action, "drop");
  assert.ok(drop.takeoff.x > down.parts[0].bounds.max.x);
  assert.ok(Math.abs(drop.duration - (drop.takeoff.x / profile.walkSpeed + Math.sqrt(8 / profile.gravity))) < 1e-5);
  assert.equal(drop.status, "candidate");
  assert.equal(edge(down, "s-b", "s-a"), undefined);
  assert.equal(edge(model(platform("a", 0), platform("b", 5, -6))), undefined);
});

test("assumed profiles and proxy support never become modeled routes", () => {
  const m = model(platform("a", 0), platform("b", 5));
  m.profileSource = "assumed";
  m.links = buildNavigation(m).links;
  assert.equal(m.links.find((l) => l.from === "s-a")?.status, "candidate");
  assert.equal(planRoute(m, { from: "s-a", to: "s-b" }).status, "insufficient-evidence");
  assert.equal(planRoute(m, { from: "s-a", to: "s-b", allowUncertain: true }).status, "found");
  m.profileSource = "supplied";
  m.surfaces[1].geometry = "bounds-only";
  assert.equal(edge(m)?.status, "candidate");
});

test("recorded moving platforms expose bounded ride and transfer windows", () => {
  const m = model(platform("a", 0), platform("b", 5));
  m.tracks = [track(m.parts[1])];
  const { links } = buildNavigation(m);
  const ride = links.find((l) => l.action === "ride");
  assert.ok(ride && ride.from === "s-b" && ride.to === "s-b");
  assert.ok(ride.landing.x > ride.takeoff.x);
  assert.equal(ride.status, "candidate");
  assert.ok(links.some((l) => l.from === "s-a" && l.to === "s-b" && l.windows?.length));
  assert.ok(links.every((l) => l.windows?.every((w) => w.start === w.end && w.start >= 0 && w.end <= 2)));
});

test("walking cannot use a moving platform's departed footprint as transit support", () => {
  const m = model(platform("a", 0, 0, 6), platform("b", 5, 0, 6));
  m.profile = { ...profile, jumpVelocity: 0 };
  const fleeing = track(m.parts[0], -200);
  fleeing.sweptBounds = { min: { ...m.parts[0].bounds.min, x: -203 }, max: { ...m.parts[0].bounds.max } };
  m.tracks = [fleeing];
  m.links = buildNavigation(m).links;
  assert.equal(m.links.find((link) => link.from === "s-a" && link.to === "s-b" && link.windows?.some((window) => window.start === 0)), undefined);
  assert.notEqual(planRoute(m, { from: "s-a", to: "s-b", allowUncertain: true }).status, "found");

  const sharedMotion = model(platform("a", 0, 0, 6), platform("b", 4, 0, 6));
  sharedMotion.profile = m.profile;
  sharedMotion.tracks = sharedMotion.parts.map((part) => track(part));
  const supported = edge(sharedMotion);
  assert.equal(supported?.action, "walk");
  assert.equal(supported.status, "candidate");
  assert.ok(supported.landing.x > 4);
});

test("an unavailable track does not erase unrelated static links or usable ride windows", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const staticLink = edge(m);
  const available = platform("available", 1000), unavailable = platform("unavailable", 2000);
  m.parts.push(available.part, unavailable.part);
  m.surfaces.push(available.surface, unavailable.surface);
  const moving = track(available.part);
  moving.samples = moving.samples.map((sample) => ({ ...sample, t: sample.t + 0.001 }));
  moving.sampleStart = moving.samples[0].t;
  moving.sampleEnd = moving.samples.at(-1).t;
  const missing = { ...track(unavailable.part), model: "unknown", samples: [], sampleStart: 0, sampleEnd: 0, uncertainty: ["object-destroyed-or-unreachable"], observedAt: "2026-09-09T01:00:00.000Z" };
  m.tracks = [moving, missing];
  m.links = buildNavigation(m).links;
  assert.deepEqual(m.links.find((link) => link.from === "s-a" && link.to === "s-b"), staticLink);
  assert.equal(planRoute(m, { from: "s-a", to: "s-b" }).status, "found");
  assert.ok(m.links.some((link) => link.from === available.surface.id && link.action === "ride"));
  assert.ok(m.links.every((link) => link.from !== unavailable.surface.id && link.to !== unavailable.surface.id));
});

test("unavailable motion near a transfer retains local uncertainty", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const hazard = platform("missing-hazard", 2.5, 2).part;
  hazard.canCollide = false;
  m.parts.push(hazard);
  m.hazards.push({ partId: hazard.id, level: "hint", bounds: hazard.bounds });
  m.tracks.push({ ...track(hazard, 0), model: "unknown", samples: [], sampleStart: 0, sampleEnd: 0, uncertainty: ["unavailable"] });
  const link = edge(m);
  assert.equal(link?.status, "candidate");
  assert.ok(link.reasons.includes("motion-outside-observed-window"));
});

test("a crossing moving hazard qualifies the entire transit even away at departure", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const hazard = platform("hazard", -10, 2).part;
  hazard.canCollide = false;
  m.parts.push(hazard);
  const motion = track(hazard, 20);
  motion.sweptBounds = { min: { x: -12, y: 0, z: -2 }, max: { x: 12, y: 5, z: 2 } };
  m.tracks.push(motion);
  m.hazards.push({ partId: hazard.id, bounds: hazard.bounds, level: "hint" });
  const link = edge(m);
  assert.ok(link?.reasons.includes("hazard-sweep-intersection"));
  assert.equal(link.status, "candidate");
});

test("route waits explicitly for directed windows and rejects expired windows", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const link = edge(m);
  link.windows = [{ start: 2, end: 2 }];
  m.links = [link];
  const route = planRoute(m, { from: "s-a", to: "s-b" });
  assert.equal(route.status, "found");
  assert.equal(route.steps[0].action, "wait");
  assert.equal(route.steps[0].duration, 2);
  assert.equal(route.arrival, 2 + link.duration);
  assert.notEqual(planRoute(m, { from: "s-b", to: "s-a" }).status, "found");
  assert.notEqual(planRoute(m, { from: "s-a", to: "s-b", departure: 3 }).status, "found");
});

test("cheap coincident cycles cannot hide a direct valid route", () => {
  const m = model(platform("a", 0), platform("b", 0), platform("c", 5));
  m.links = buildNavigation(m).links;
  const direct = m.links.find((link) => link.from === "s-a" && link.to === "s-c");
  assert.equal(direct?.action, "jump");
  const route = planRoute(m, { from: "s-a", to: "s-c" });
  assert.equal(route.status, "found");
  assert.deepEqual(route.steps, [direct]);
});

test("a capped timed label is pruned without abandoning a queued destination", () => {
  const m = model(platform("a", 0), platform("b", 0), platform("c", 5));
  const links = buildNavigation(m).links;
  const direct = links.find((link) => link.from === "s-a" && link.to === "s-c");
  const cycle = links.filter((link) => (link.from === "s-a" && link.to === "s-b") || (link.from === "s-b" && link.to === "s-a"));
  m.links = [direct, ...cycle.map((link) => ({ ...link, windows: [{ start: 0, end: 60 }] }))];
  const route = planRoute(m, { from: "s-a", to: "s-c" });
  assert.equal(route.status, "found");
  assert.deepEqual(route.steps, [direct]);
});

test("waiting beneath a hazard is not silently accepted by default", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const link = edge(m);
  link.windows = [{ start: 2, end: 2 }];
  m.links = [link];
  const hazard = platform("hazard", 0, 2).part;
  hazard.canCollide = false;
  m.parts.push(hazard);
  m.hazards.push({ partId: hazard.id, bounds: hazard.bounds, level: "correlated" });
  assert.equal(planRoute(m, { from: "s-a", to: "s-b" }).status, "insufficient-evidence");
});

test("cancellation propagates rather than returning a partial success", () => {
  const cancelled = new Error("cancelled");
  assert.throws(() => buildNavigation(model(platform("a", 0)), { check: () => { throw cancelled; } }), (error) => error === cancelled);
});

test("ceiling walking, steps, jumps and passive drops mirror signed floor mechanics", () => {
  const cases = [
    ["walk", model(platform("a", 0, 0, 6), platform("b", 4, 0, 6)), "walk"],
    ["step", model(platform("a", 0, 0, 6), platform("b", 4, 0.2, 6)), "walk"],
    ["gap", model(platform("a", 0), platform("b", 5)), "jump"],
    ["too high", model(platform("a", 0), platform("b", 5, 3)), undefined],
    ["too far", model(platform("a", 0), platform("b", 12)), undefined],
    ["narrow landing", model(platform("a", 0), platform("b", 5, 0, 0.8)), undefined],
    ["drop", model(platform("a", 0), platform("b", 5, -4)), "drop"],
    ["excessive drop", model(platform("a", 0), platform("b", 5, -6)), undefined],
  ];
  for (const [name, floor, action] of cases) {
    const lower = edge(floor), upper = edge(ceilingModel(floor));
    assert.equal(lower?.action, action, `floor ${name}`);
    assert.equal(upper?.action, action, `ceiling ${name}`);
    if (!lower) continue;
    assert.equal(upper.duration, lower.duration, name);
    assert.equal(upper.status, lower.status, name);
    assert.equal(upper.fromMode, "ceiling");
    assert.equal(upper.toMode, "ceiling");
    assert.ok(Math.abs(upper.takeoff.y + lower.takeoff.y) < 1e-8, name);
    assert.ok(Math.abs(upper.landing.y + lower.landing.y) < 1e-8, name);
  }
  const dropping = ceilingModel(model(platform("a", 0), platform("b", 5, -4)));
  dropping.profile.jumpVelocity = 0;
  assert.equal(edge(dropping)?.action, "drop");
  assert.equal(edge(dropping, "s-b", "s-a"), undefined);
});

test("ceiling clearance extends below supports through steps and ballistic arcs", () => {
  for (const step of [false, true]) {
    const floor = step ? model(platform("a", 0, 0, 6), platform("b", 4, 0.2, 6)) : model(platform("a", 0), platform("b", 5));
    if (step) floor.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
    const open = ceilingModel(floor);
    assert.equal(edge(open)?.action, step ? "walk" : "jump");
    floor.parts.push(platform("body-blocker", 2, step ? 2.5 : 3, 12).part);
    assert.equal(edge(ceilingModel(floor)), undefined);
  }
  const step = ceilingModel(model(platform("a", 0, 0, 6), platform("b", 4, 0.2, 6)));
  step.profile.jumpVelocity = 0;
  step.profile.maxDropHeight = 0;
  assert.equal(edge(step, "s-b", "s-a")?.action, "walk");
  const high = ceilingModel(model(platform("a", 0, 0, 6), platform("b", 4, 0.31, 6)));
  high.profile = step.profile;
  assert.equal(edge(high), undefined);
});

test("ceiling moving supports retain ride windows and cannot lend departed footprints", () => {
  const floor = model(platform("a", 0), platform("b", 5));
  floor.tracks = [track(floor.parts[1])];
  const ceiling = ceilingModel(floor), links = buildNavigation(ceiling).links;
  const ride = links.find((link) => link.from === "s-b" && link.action === "ride");
  assert.ok(ride.landing.x > ride.takeoff.x);
  assert.equal(ride.fromMode, "ceiling");
  assert.equal(ride.status, "candidate");
  assert.ok(links.some((link) => link.from === "s-a" && link.to === "s-b" && link.windows?.length));
  const fleeing = model(platform("a", 0, 0, 6), platform("b", 5, 0, 6));
  fleeing.profile = { ...profile, jumpVelocity: 0 };
  const motion = track(fleeing.parts[0], -200);
  motion.sweptBounds = { min: { ...fleeing.parts[0].bounds.min, x: -203 }, max: { ...fleeing.parts[0].bounds.max } };
  fleeing.tracks = [motion];
  const departed = ceilingModel(fleeing);
  departed.links = buildNavigation(departed).links;
  assert.notEqual(planRoute(departed, { from: "s-a", to: "s-b", allowUncertain: true }).status, "found");
});

test("ceiling hazard sweeps and waits use the underside body and departure domain", () => {
  const floor = model(platform("a", 0), platform("b", 5));
  const hazard = platform("hazard", -10, 2).part;
  hazard.canCollide = false;
  floor.parts.push(hazard);
  const motion = track(hazard, 20);
  motion.sweptBounds = { min: { x: -12, y: 0, z: -2 }, max: { x: 12, y: 5, z: 2 } };
  floor.tracks.push(motion);
  floor.hazards.push({ partId: hazard.id, bounds: hazard.bounds, level: "hint" });
  const crossing = edge(ceilingModel(floor));
  assert.equal(crossing.status, "candidate");
  assert.ok(crossing.reasons.includes("hazard-sweep-intersection"));
  assert.ok(crossing.windows?.length);
  const waiting = ceilingModel(model(platform("a", 0), platform("b", 5)));
  const link = edge(waiting);
  waiting.links = [{ ...link, windows: [{ start: 2, end: 2 }] }];
  const route = planRoute(waiting, { from: "s-a", to: "s-b" });
  assert.equal(route.timing, "modeled");
  assert.equal(route.steps[0].action, "wait");
  assert.equal(route.steps[0].fromMode, "ceiling");
  assert.equal(route.arrival, 2 + link.duration);
  const below = ceilingPlatform("below", 0, -2).part;
  below.canCollide = false;
  waiting.parts.push(below);
  waiting.hazards.push({ partId: below.id, bounds: below.bounds, level: "hint" });
  assert.notEqual(planRoute(waiting, { from: "s-a", to: "s-b" }).status, "found");
});

test("ordinary neighbors filter modes before their shared cap and never infer switches", () => {
  const ceiling = ceilingModel(model(platform("a", 0, 0, 6), platform("b", 4, 0, 6)));
  for (let i = 0; i < 40; i++) {
    const decoy = platform(`floor-${i}`, 0, -100);
    ceiling.parts.push(decoy.part); ceiling.surfaces.push(decoy.surface);
  }
  ceiling.mechanics.supportModes.push("floor");
  const navigation = buildNavigation(ceiling);
  assert.equal(navigation.links.find((link) => link.from === "s-a" && link.to === "s-b")?.action, "walk");
  assert.ok(navigation.links.every((link) => link.fromMode === link.toMode));
  const unreported = switchModel();
  unreported.mechanics.transitions = [];
  unreported.links = buildNavigation(unreported).links;
  assert.ok(unreported.links.every((link) => link.action !== "mode-switch"));
  assert.notEqual(planRoute(unreported, { from: "s-a", to: "s-roof", allowUncertain: true }).status, "found");
});

test("first and second reported pads give an unscheduled opposite-support itinerary", () => {
  const m = switchModel();
  m.links = buildNavigation(m).links;
  const switches = m.links.filter((link) => link.action === "mode-switch");
  assert.deepEqual(switches.map(({ from, to }) => [from, to]), [["s-a", "s-roof"], ["s-upper", "s-finish"]]);
  for (const link of switches) {
    assert.equal(link.duration, null);
    assert.equal(link.status, "candidate");
    assert.equal(link.windows, undefined);
    assert.ok(link.reasons.includes("unobserved-transfer-trajectory"));
    assert.ok(link.reasons.includes("unobserved-orientation-sweep"));
  }
  assert.notEqual(planRoute(m, { from: "s-a", to: "s-finish" }).status, "found");
  const route = planRoute(m, { from: "s-a", to: "s-finish", allowUncertain: true });
  assert.equal(route.status, "found");
  assert.equal(route.timing, "unknown");
  assert.equal(route.duration, null);
  assert.equal(route.arrival, null);
  assert.deepEqual(route.steps.map((link) => link.action), ["mode-switch", "walk", "mode-switch"]);
});

test("reported switches use incident support for noncollidable pads, not arbitrary centers", () => {
  const m = model(platform("a", 0, 0, 20), ceilingPlatform("b", 7, 10, 3), ceilingPlatform("distant", 30));
  const pad = platform("pad", 7, 1, 2).part;
  pad.canCollide = false;
  m.parts.push(pad);
  m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported(pad.id, "floor", "ceiling")] };
  const switches = buildNavigation(m).links.filter((link) => link.action === "mode-switch");
  assert.deepEqual(switches.map(({ from, to }) => [from, to]), [["s-a", "s-b"]]);
  assert.equal(switches[0].takeoff.x, 7);
  assert.equal(switches[0].landing.x, 7);
  const floating = structuredClone(m);
  floating.parts.at(-1).cframe[1] += 4;
  floating.parts.at(-1).bounds = boundsForPart(floating.parts.at(-1));
  assert.ok(buildNavigation(floating).links.every((link) => link.action !== "mode-switch"));
});

test("off-center activation and landing cannot bypass blocked access on a large face", () => {
  for (const targetLeg of [false, true]) {
    const m = model(platform("a", 0, 0, 20), ceilingPlatform("b", targetLeg ? 0 : 7, 10, targetLeg ? 20 : 3));
    const pad = platform("pad", 7, 1, 2).part;
    pad.canCollide = false;
    m.parts.push(pad);
    m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported(pad.id, "floor", "ceiling")] };
    assert.equal(edge(m)?.action, "mode-switch");
    m.parts.push(platform("access-blocker", 3.5, targetLeg ? 9 : 2, 2).part);
    assert.equal(edge(m), undefined, targetLeg ? "ceiling exit access" : "floor pad access");
    m.tracks.push({ ...track(m.parts.at(-1), 0), model: "stationary" });
    assert.equal(edge(m), undefined, "unchanged samples cannot erase the occupied access leg");
  }
});

test("switch corridors reject known solids and narrow insets but qualify uncertain scenes", () => {
  const clear = model(platform("a", 0), ceilingPlatform("b", 0));
  clear.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", "floor", "ceiling")] };
  assert.equal(edge(clear)?.action, "mode-switch");
  const blocked = structuredClone(clear);
  blocked.parts.push(platform("blocker", 0, 5, 6).part);
  assert.equal(edge(blocked), undefined);
  blocked.tracks.push({ ...track(blocked.parts.at(-1), 0), model: "stationary" });
  assert.equal(edge(blocked), undefined, "unchanged samples cannot erase the occupied transfer corridor");
  blocked.parts.at(-1).collidesWithCharacter = undefined;
  assert.ok(edge(blocked)?.reasons.includes("unknown-character-collision"));
  blocked.parts.at(-1).collidesWithCharacter = true;
  blocked.parts.at(-1).geometry = "bounds-only";
  assert.ok(edge(blocked)?.reasons.includes("proxy-clearance"));
  blocked.parts.at(-1).geometry = "block";
  blocked.parts.at(-1).anchored = false;
  assert.ok(edge(blocked)?.reasons.includes("unobserved-transfer-scene-motion"));
  const narrow = model(platform("a", 0), ceilingPlatform("b", 0, 10, 0.8));
  narrow.mechanics = clear.mechanics;
  assert.equal(edge(narrow), undefined);
  const sameSolid = structuredClone(clear);
  sameSolid.surfaces[1].partId = "a";
  assert.equal(edge(sameSolid), undefined);
});

test("a conservative track envelope alone does not become a known-solid switch obstruction", () => {
  const m = model(platform("a", 0), ceilingPlatform("b", 0));
  m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", "floor", "ceiling")] };
  const outside = platform("outside", 20, 5).part;
  m.parts.push(outside);
  const motion = { ...track(outside, 0), model: "stationary", sweptBounds: { min: { x: -2, y: 3, z: -2 }, max: { x: 22, y: 6, z: 2 } } };
  m.tracks.push(motion);
  const link = edge(m);
  assert.equal(link?.action, "mode-switch");
  assert.equal(link.status, "candidate");
  assert.equal(link.duration, null);
  assert.ok(link.reasons.includes("unobserved-transfer-scene-motion"));
});

test("switch obstruction proof uses full recording geometry rather than its decimated sample subset", () => {
  const m = model(platform("a", 0), ceilingPlatform("b", 0));
  m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", "floor", "ceiling")] };
  const client = { clientId: "recorded-blocker", generation: "generation-1" };
  const sourceObjectId = "a".repeat(32), sourceSnapshotId = "b".repeat(32), recordingId = "c".repeat(32);
  const blocker = { ...platform("blocker", 0, 5, 6).part, sourceObjectId, sourceSnapshotId,
    sourceIdentity: "retained-instance", sourceKey: JSON.stringify([client.clientId, client.generation, sourceObjectId]) };
  m.parts.push(blocker);
  const source = {
    recordingId, client, receivedAt: "2026-09-09T12:02:00.000Z",
    metadata: {
      recordingId, state: "stopped", ready: false, clock: "client-monotonic-seconds", atomicSnapshot: false,
      acceptedAt: 100, startedAt: 100, firstSampleAt: 100, readyAt: 100, lastSampleAt: 130, stoppedAt: 130, now: 130, expiresAt: 250,
      durationMs: 30000, intervalMs: 100, elapsedMs: 30000, remainingMs: 0,
      frameCount: 301, sampleCount: 301, missedIntervals: 0, retainedDrops: 0, sampleBytes: 38528, eventBytes: 0, eventCount: 0, markerCount: 0,
      coverage: "complete", stopReasons: ["duration-limit"], targets: [{ sourceObjectId, sourceSnapshotId,
        path: "Workspace.Blocker", className: "Part", size: { ...blocker.size }, anchored: true, canCollide: true }],
    },
    frames: Array.from({ length: 301 }, (_, index) => ({ sequence: index + 1, t: index / 10,
      samples: [{ sourceObjectId, t: index / 10, cframe: [...blocker.cframe], size: { ...blocker.size } }] })),
    events: [],
  };
  const qualify = (recording) => {
    m.tracks = analyzeMotion(m.parts, [], { recordings: [recording] }).tracks;
    return edge(m);
  };
  assert.equal(qualify(source), undefined, "complete unchanged source geometry still proves the occupied anchored solid");
  for (const change of [
    (sample) => { sample.cframe[0] += 100; },
    (sample) => { sample.size.x += 10; },
    (sample) => { sample.cframe[3] = sample.cframe[11] = Math.cos(0.1); sample.cframe[5] = Math.sin(0.1); sample.cframe[9] = -Math.sin(0.1); },
    (sample) => { sample.cframe[0] += Number.EPSILON; },
  ]) {
    const recording = structuredClone(source);
    change(recording.frames[1].samples[0]);
    const link = qualify(recording);
    assert.ok(m.tracks[0].samples.every((sample) => sample.cframe.every((value, index) => value === blocker.cframe[index])
      && Object.keys(blocker.size).every((axis) => sample.size[axis] === blocker.size[axis])), "the excursion is outside the selected projection");
    assert.equal(link?.action, "mode-switch");
    assert.equal(link.status, "candidate");
    assert.equal(link.duration, null);
    assert.ok(link.reasons.includes("unobserved-transfer-scene-motion"));
  }
  qualify(source);
  delete m.tracks[0].projection.sourceMatchesCapturedGeometry;
  assert.equal(edge(m)?.action, "mode-switch", "older projections without full-source agreement cannot claim an invariant blocker");
  source.metadata.coverage = "partial";
  source.metadata.stopReasons = ["object-destroyed-or-unreachable"];
  assert.equal(qualify(source)?.action, "mode-switch", "unchanged captured samples cannot prove continued occupancy after target loss");
});

test("transfer windows follow native recording chronology and stop at target loss", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const client = { clientId: "recorded-transfer", generation: "generation-1" };
  const sourceObjectId = "a".repeat(32), sourceSnapshotId = "b".repeat(32);
  const target = m.parts[1];
  Object.assign(target, { sourceObjectId, sourceSnapshotId, sourceIdentity: "retained-instance",
    sourceKey: JSON.stringify([client.clientId, client.generation, sourceObjectId]) });
  const record = (recordingId, startedAt, receivedAt, x) => ({
    recordingId, client, receivedAt,
    metadata: {
      recordingId, state: "stopped", ready: false, clock: "client-monotonic-seconds", atomicSnapshot: false,
      acceptedAt: startedAt, startedAt, firstSampleAt: startedAt, readyAt: startedAt, lastSampleAt: startedAt + 2,
      stoppedAt: startedAt + 2.1, now: startedAt + 2.1, expiresAt: startedAt + 122.1,
      durationMs: 3000, intervalMs: 100, elapsedMs: 2100, remainingMs: 0, frameCount: 21, sampleCount: 21,
      missedIntervals: 0, retainedDrops: 0, sampleBytes: 2688, eventBytes: 0, eventCount: 0, markerCount: 0,
      coverage: "complete", stopReasons: ["user-stop"], targets: [{ sourceObjectId, sourceSnapshotId,
        path: "Workspace.Target", className: "Part", size: { ...target.size }, anchored: true, canCollide: true }],
    },
    frames: Array.from({ length: 21 }, (_, index) => ({ sequence: index + 1, t: index / 10,
      samples: [{ sourceObjectId, t: index / 10, cframe: frame(x(index / 10), target.cframe[1]), size: { ...target.size } }] })),
    events: [],
  });
  const older = record("c".repeat(32), 100, "2026-09-09T12:04:00.000Z", () => 50);
  const newer = record("d".repeat(32), 200, "2026-09-09T12:03:00.000Z", (t) => 5 + t / 10);
  const linksFor = (recordings) => {
    m.tracks = analyzeMotion(m.parts, [], { recordings }).tracks;
    return buildNavigation(m).links.filter((link) => link.from === "s-a" && link.to === "s-b");
  };
  assert.deepEqual(linksFor([older]), [], "the old native window leaves the platform outside jump reach");
  for (const recordings of [[newer, older], [older, newer]]) {
    const links = linksFor(recordings);
    assert.ok(links.some((link) => link.windows.some((window) => window.start === 1.5)));
    assert.ok(links.every((link) => link.landing.x < 6), "saving the older native recording later cannot restore its departed geometry");
  }
  newer.metadata.coverage = "partial";
  newer.metadata.stopReasons = ["object-destroyed-or-unreachable"];
  const afterLoss = linksFor([newer]);
  assert.ok(afterLoss.some((link) => link.windows.some((window) => window.start === 0)), "retained pre-loss samples remain useful");
  assert.ok(afterLoss.every((link) => link.windows.every((window) => window.start + link.duration <= 2)), "no candidate transfer can land after observed target loss");
});

test("switch support intersection is invariant under large in-range world translations", () => {
  const original = model(platform("a", 0), ceilingPlatform("b", 0));
  original.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", "floor", "ceiling")] };
  const offset = 2 ** 29, translated = structuredClone(original);
  const shift = (point) => ({ ...point, x: point.x + offset, z: point.z + offset });
  for (const part of translated.parts) {
    part.cframe[0] += offset;
    part.cframe[2] += offset;
    part.bounds = boundsForPart(part);
  }
  for (const surface of translated.surfaces) {
    surface.center = shift(surface.center);
    surface.vertices = surface.vertices.map(shift);
    surface.bounds = { min: shift(surface.bounds.min), max: shift(surface.bounds.max) };
  }
  const local = edge(original), distant = edge(translated);
  assert.equal(local?.action, "mode-switch");
  assert.equal(distant?.action, "mode-switch");
  assert.equal(distant.duration, null);
  for (const point of ["takeoff", "landing"]) {
    assert.ok(Math.abs(distant[point].x - offset - local[point].x) < 1e-6);
    assert.ok(Math.abs(distant[point].z - offset - local[point].z) < 1e-6);
    assert.equal(distant[point].y, local[point].y);
  }
  translated.links = buildNavigation(translated).links;
  const route = planRoute(translated, { from: "s-a", to: "s-b", allowUncertain: true });
  assert.equal(route.status, "found");
  assert.equal(route.timing, "unknown");
  assert.equal(route.arrival, null);
});

test("unknown switch timing leaves later windows unresolved without guessed waits or cycles", () => {
  const m = switchModel();
  m.links = buildNavigation(m).links;
  const walk = m.links.find((link) => link.from === "s-roof" && link.to === "s-upper");
  walk.windows = [{ start: 20, end: 20 }];
  const route = planRoute(m, { from: "s-a", to: "s-finish", allowUncertain: true });
  assert.equal(route.status, "found");
  assert.equal(route.timing, "unknown");
  assert.equal(route.arrival, null);
  assert.equal(route.duration, null);
  assert.ok(route.steps.every((link) => link.action !== "wait" && link.windows === undefined));
  assert.ok(route.steps[1].reasons.includes("unresolved-departure-window"));
  assert.equal(route.steps[1].status, "candidate");
  const unreachable = platform("unreachable", 1000);
  m.parts.push(unreachable.part); m.surfaces.push(unreachable.surface);
  assert.notEqual(planRoute(m, { from: "s-a", to: unreachable.surface.id, allowUncertain: true }).status, "found");
});

test("route validation rejects stale reports, forged mode edges and invalid endpoint orientation", () => {
  const m = switchModel();
  m.links = buildNavigation(m).links;
  const link = m.links.find((row) => row.action === "mode-switch");
  for (const patch of [{ transitionId: "missing" }, { fromMode: "ceiling" }, { duration: 0 }, { action: "jump", duration: 1 }, { from: "s-finish" }]) {
    const invalid = { ...m, links: [{ ...link, ...patch }] };
    assert.notEqual(planRoute(invalid, { from: invalid.links[0].from, to: link.to, allowUncertain: true }).status, "found");
  }
  m.mechanics.transitions = [];
  assert.notEqual(planRoute(m, { from: "s-a", to: "s-roof", allowUncertain: true }).status, "found");
  const legacy = model(platform("a", 0), platform("b", 5));
  const { fromMode, toMode, ...oldLink } = edge(legacy);
  legacy.links = [oldLink];
  const route = planRoute(legacy, { from: "s-a", to: "s-b" });
  assert.equal(route.timing, "modeled");
  assert.equal(route.duration, oldLink.duration);
  legacy.surfaces[0].normal.y = -1;
  assert.notEqual(planRoute(legacy, { from: "s-a", to: "s-b" }).status, "found");
});

test("reported floor and ceiling pad activation forbids ordinary departures but permits boundary arrivals", () => {
  for (const mode of ["floor", "ceiling"]) {
    const fixtures = [
      ["walk", model(platform("a", 0, 0, 6), platform("b", 4, 0, 6))],
      ["jump", model(platform("a", 0), platform("b", 5))],
      ["drop", model(platform("a", 0), platform("b", 5, -4))],
    ];
    for (const [action, fixture] of fixtures) {
      const m = mode === "ceiling" ? ceilingModel(fixture) : fixture;
      const bypass = edge(m);
      assert.equal(bypass?.action, action);
      m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", mode, mode === "floor" ? "ceiling" : "floor")] };
      const navigation = buildNavigation(m);
      assert.ok(navigation.links.every((link) => link.from !== "s-a" || link.action === "mode-switch"), `${mode} ${action} departure`);
      m.links = [bypass];
      const route = planRoute(m, { from: "s-a", to: "s-b", allowUncertain: true });
      assert.notEqual(route.status, "found", `${mode} stored ${action} bypass`);
      assert.ok(route.reasons.includes("reported-activation-crossings-excluded"));
      if (action === "walk") assert.ok(navigation.links.some((link) => link.from === "s-b" && link.to === "s-a"), "arrival may target the activation boundary");
    }
    for (const displacement of [0, 2]) {
      const fixture = model(platform("a", 0));
      fixture.tracks = [{ ...track(fixture.parts[0], displacement), model: displacement ? "linear" : "stationary" }];
      const m = mode === "ceiling" ? ceilingModel(fixture) : fixture;
      assert.ok(buildNavigation(m).links.some((link) => link.action === (displacement ? "ride" : "wait")));
      m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("a", mode, mode === "floor" ? "ceiling" : "floor")] };
      assert.ok(buildNavigation(m).links.every((link) => link.action !== "ride" && link.action !== "wait"), `${mode} cannot remain in activated mode`);
    }
  }
});

test("reported activation rejects unsplit mid-walk crossings without blocking routes that avoid the pad", () => {
  for (const mode of ["floor", "ceiling"]) {
    const fixture = model(platform("a", 0, 0, 20), platform("b", 8, 0, 20));
    fixture.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
    const pad = platform("pad", 4, 1, 1).part;
    pad.canCollide = false;
    fixture.parts.push(pad);
    const m = mode === "ceiling" ? ceilingModel(fixture) : fixture;
    const bypass = edge(m);
    assert.equal(bypass?.action, "walk");
    m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("pad", mode, mode === "floor" ? "ceiling" : "floor")] };
    assert.equal(edge(m), undefined, `${mode} crossing must be split at activation`);
    m.links = [bypass];
    assert.notEqual(planRoute(m, { from: "s-a", to: "s-b", allowUncertain: true }).status, "found", "stored crossing cannot bypass mechanics");
    const avoiding = structuredClone(m), offPathPad = avoiding.parts.at(-1);
    offPathPad.cframe[2] = 1;
    offPathPad.size.z = 0.5;
    offPathPad.bounds = boundsForPart(offPathPad);
    avoiding.links = buildNavigation(avoiding).links;
    const route = planRoute(avoiding, { from: "s-a", to: "s-b" });
    assert.equal(route.status, "found", `${mode} route avoids activation footprint`);
    assert.equal(route.timing, "modeled");
    assert.equal(route.steps[0].action, "walk");
  }
});

function discreteClock(m) {
  const minX = Math.min(...m.parts.map((part) => part.bounds.min.x));
  const maxX = Math.max(...m.parts.map((part) => part.bounds.max.x));
  // Cover each endpoint's local departure domain, not just their shared corridor.
  const clock = platform("clock", (minX + maxX) / 2, 1, maxX - minX).part;
  clock.canCollide = false;
  m.parts.push(clock);
  m.tracks.push({ ...track(clock, 0), model: "stationary" });
  return m;
}

function expandedSemantics(links) {
  return links.flatMap(({ id, windows, ...link }) => (windows ?? [null]).map((window) => ({ ...link, ...(window ? { windows: [window] } : {}) })))
    .map((link) => JSON.stringify(link)).sort();
}

test("exact grouping expands to every original discrete opportunity in first-seen order", () => {
  const m = model(platform("a", 0), platform("b", 5));
  const original = buildNavigation(m).links;
  discreteClock(m);
  const generated = buildNavigation(m);
  const ordinary = generated.links.filter((link) => link.from !== link.to);
  const expected = original.flatMap((link) => Array.from({ length: 21 }, (_, index) => ({
    ...link, status: "candidate", reasons: [...link.reasons, "discrete-departure-opportunity"],
    windows: [{ start: 2 * index / 20, end: 2 * index / 20 }],
  })));
  assert.deepEqual(expandedSemantics(ordinary), expandedSemantics(expected));
  assert.deepEqual(ordinary.map((link) => [link.from, link.to]), original.map((link) => [link.from, link.to]));
  assert.equal(generated.metrics.rawOpportunities, 82);
  assert.equal(generated.metrics.retainedGroups, 4);
  assert.deepEqual(buildNavigation(m).links, generated.links);
  assert.ok(generated.links.every((link) => link.windows.every((window) => window.start === window.end)));

  m.links = generated.links;
  const expanded = { ...m, links: expected };
  for (const departure of [0, 0.05, 0.1, 1.95, 2, 2.00001]) {
    const actual = planRoute(m, { from: "s-a", to: "s-b", departure, allowUncertain: true });
    const prior = planRoute(expanded, { from: "s-a", to: "s-b", departure, allowUncertain: true });
    assert.equal(actual.status, prior.status);
    assert.equal(actual.arrival, prior.arrival);
    assert.equal(actual.duration, prior.duration);
    assert.deepEqual(actual.steps.map((step) => step.action), prior.steps.map((step) => step.action));
  }
});

test("grouping retains the raw opportunity cap rather than hiding unbounded successful work", () => {
  const m = discreteClock(model(...Array.from({ length: 16 }, (_, index) => platform(`p${index}`, index / 20))));
  const result = buildNavigation(m);
  assert.ok(result.stopReasons.includes("navigation-link-limit"));
  assert.equal(result.metrics.rawOpportunities, 4096);
  assert.equal(result.links.reduce((sum, link) => sum + (link.windows?.length ?? 1), 0), 4096);
  assert.ok(result.metrics.retainedGroups < result.metrics.rawOpportunities);
  assert.ok(result.links.every((link) => !link.windows || link.windows.length <= 128));
});

test("stationary classification never rounds distinct sampled poses into one timed edge", () => {
  const m = model(platform("a", 0), platform("b", 5));
  m.tracks = [{ ...track(m.parts[1], 0.008), model: "stationary" }];
  const links = buildNavigation(m).links.filter((link) => link.from === "s-a" && link.to === "s-b");
  assert.ok(links.length >= 10);
  assert.ok(links.every((link) => link.windows.length === 1));
  assert.equal(new Set(links.map((link) => link.landing.x)).size, links.length);
  assert.ok(links.every((link) => link.windows[0].start + link.duration <= 2));
});

test("invocation-local activation caches cannot leak across revised pad geometry or native clocks", () => {
  const m = model(platform("a", 0, 0, 20), platform("b", 8, 0, 20));
  m.profile = { ...profile, jumpVelocity: 0, maxDropHeight: 0 };
  const pad = platform("pad", 4, 1, 1).part;
  pad.canCollide = false;
  m.parts.push(pad);
  m.mechanics = { supportModes: ["floor", "ceiling"], transitions: [reported("pad", "floor", "ceiling")] };
  assert.equal(edge(m), undefined);
  pad.cframe[2] = 1; pad.size.z = 0.5; pad.bounds = boundsForPart(pad);
  assert.equal(edge(m)?.action, "walk");
  pad.cframe[2] = 0; pad.bounds = boundsForPart(pad);
  assert.equal(edge(m), undefined);

  const moving = model(platform("a", 0), platform("b", 5));
  moving.tracks = moving.parts.map((part, index) => ({ ...track(part, 0), model: "stationary",
    projection: { recordingId: String(index).repeat(32), startedAt: 100 } }));
  assert.ok(edge(moving).reasons.includes("mixed-observation-time-origins"));
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createGameContextImages } from "../src/game-context-images.js";
import { reconstructGeometry } from "../src/map-geometry.js";

// These tests exercise adapter/protocol boundaries only, never native window capture or map rendering.
// A valid 1x1 gray baseline JPEG with one-bit DC-zero/EOB Huffman codes is a transport fixture.
const jpeg = Buffer.concat([
  Buffer.from("ffd8ffdb004300", "hex"), Buffer.alloc(64, 1),
  Buffer.from("ffc0000b080001000101011100ffc40026", "hex"),
  Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0]),
  Buffer.from([0x10, 1]), Buffer.alloc(15), Buffer.from([0]),
  Buffer.from("ffda0008010100003f003fffd9", "hex"),
]);
const scene = {
  parts: [{ name: "Observed platform", cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: { x: 20, y: 2, z: 12 } }],
  player: { present: true, position: { x: 2, y: 3, z: 4 } },
};
const notRequested = { status: "not-requested", reason: "not-requested" };
const unavailable = (reason) => ({ status: "unavailable", reason });
const target = { pid: 1234, startedAt: "2026-09-09T10:00:00.0000000Z", windowHandle: "0xabcd" };
const available = (kind, extras = {}) => ({
  status: "available", data: jpeg.toString("base64"), mimeType: "image/jpeg", width: 1, height: 1,
  provider: kind === "map" ? "client-visible-box-schematic" : "windows-printwindow-client-area",
  ...(kind === "screenshot" ? { target: { ...target } } : {}), ...extras,
});
const request = (extras = {}) => ({ scene, screenshot: true, map: true, maxBytes: 8192, ...extras });

// Emulating win32 on other hosts must not require an installed Windows runtime.
let previousSystemRoot;
test.before(() => {
  previousSystemRoot = process.env.SystemRoot;
  if (!previousSystemRoot) process.env.SystemRoot = "C:\\Windows";
});
test.after(() => {
  if (previousSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = previousSystemRoot;
});

function helper(onRequest = () => {}, { closeOnKill = true } = {}) {
  const children = [];
  const invocations = [];
  const run = (executable, args, options) => {
    invocations.push({ executable, args, options });
    const child = new EventEmitter();
    child.pid = 4000 + children.length;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => {
      child.kills++;
      if (closeOnKill) queueMicrotask(() => child.emit("close", null));
      return true;
    };
    child.respond = (value, code = 0) => {
      child.stdout.end(typeof value === "string" ? value : JSON.stringify(value));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", code));
    };
    const input = [];
    child.stdin.on("data", (chunk) => input.push(chunk));
    child.stdin.on("finish", () => onRequest(JSON.parse(Buffer.concat(input).toString("utf8")), child));
    children.push(child);
    return child;
  };
  return { run, children, invocations, images: createGameContextImages({ run, platform: "win32" }) };
}

function replied(value) {
  return helper((_input, child) => child.respond(value));
}

test("ambiguous Roblox target remains unavailable while the independent schematic survives", async () => {
  const transport = replied({ schema: 1, screenshot: unavailable("target-ambiguous"), map: available("map") });
  const result = await transport.images.render(request());
  assert.deepEqual(result.screenshot, unavailable("target-ambiguous"));
  assert.equal(result.map.status, "available");
  assert.deepEqual(result.map.data, jpeg);
  assert.equal(result.map.provider, "client-visible-box-schematic");
});

test("screenshot metadata is allowlisted and never claims an authenticated window binding", async () => {
  const transport = replied({
    schema: 1, map: notRequested,
    screenshot: available("screenshot", { target: { ...target, executablePath: "C:\\Users\\private-user\\Roblox.exe", username: "private-user", association: "cryptographically authenticated" } }),
  });
  const result = await transport.images.render(request({ map: false }));
  assert.deepEqual(result.screenshot.data, jpeg);
  assert.deepEqual(Object.keys(result.screenshot.target).sort(), ["association", "pid", "startedAt", "windowHandle"]);
  assert.match(result.screenshot.target.association, /not cryptographically verified/);
  assert.doesNotMatch(JSON.stringify(result), /private-user|authenticated\"/);
});

test("invalid window identity cannot turn helper bytes into an available screenshot", async () => {
  const transport = replied({ schema: 1, screenshot: available("screenshot", { target: { ...target, windowHandle: "0x0" } }), map: available("map") });
  const result = await transport.images.render(request());
  assert.deepEqual(result.screenshot, unavailable("invalid-image-result"));
  assert.equal(result.map.status, "available");
});

test("malformed JSON and untrusted helper diagnostics never leak into facets", async () => {
  const malformed = replied("C:\\Users\\private-user\\not-json");
  assert.deepEqual(await malformed.images.render(request()), { screenshot: unavailable("invalid-image-result"), map: unavailable("invalid-image-result") });
  const diagnostic = replied({ schema: 1, screenshot: unavailable("private-user failed at C:\\secret"), map: notRequested });
  assert.deepEqual(await diagnostic.images.render(request({ map: false })), { screenshot: unavailable("invalid-image-result"), map: notRequested });
});

test("JPEG marker corruption and declared dimensions are rejected independently of base64 framing", async () => {
  const corrupt = Buffer.from(jpeg);
  corrupt[corrupt.length - 1] = 0;
  const transport = replied({
    schema: 1, screenshot: available("screenshot", { data: corrupt.toString("base64") }),
    map: available("map", { width: 2 }),
  });
  assert.deepEqual(await transport.images.render(request()), { screenshot: unavailable("invalid-image-result"), map: unavailable("invalid-image-result") });
});

test("noncanonical base64 is rejected instead of accepting Buffer's permissive decoding", async () => {
  const transport = replied({ schema: 1, screenshot: available("screenshot", { data: ` ${jpeg.toString("base64")}` }), map: notRequested });
  const result = await transport.images.render(request({ map: false }));
  assert.deepEqual(result.screenshot, unavailable("invalid-image-result"));
});

test("raw image budget rejects oversized bytes without truncating them", async () => {
  const oversized = Buffer.alloc(8193, 0);
  jpeg.copy(oversized);
  const transport = replied({ schema: 1, screenshot: available("screenshot", { data: oversized.toString("base64") }), map: available("map") });
  const result = await transport.images.render(request());
  assert.deepEqual(result.screenshot, unavailable("image-budget"));
  assert.deepEqual(result.map.data, jpeg);
  const tooSmall = helper(() => assert.fail("insufficient budgets must not start the helper"));
  assert.deepEqual(await tooSmall.images.render(request({ maxBytes: 4095 })), { screenshot: unavailable("image-budget"), map: unavailable("image-budget") });
});

test("unsupported platforms and unrequested images do not invoke a capture helper", async () => {
  const images = createGameContextImages({ platform: "linux", run: () => assert.fail("must not spawn") });
  assert.deepEqual(await images.render(request({ map: false })), { screenshot: unavailable("unsupported-platform"), map: notRequested });
  assert.deepEqual(await images.render(request({ screenshot: false, map: false })), { screenshot: notRequested, map: notRequested });
});

test("invalid geometry does not suppress a separately valid screenshot", async () => {
  const transport = replied({ schema: 1, screenshot: available("screenshot"), map: notRequested });
  const result = await transport.images.render(request({ scene: { ...scene, parts: [{ ...scene.parts[0], cframe: [Infinity] }] } }));
  assert.equal(result.screenshot.status, "available");
  assert.deepEqual(result.map, unavailable("invalid-scene"));
});

test("plain captured scenes still require observed names", async () => {
  const unnamed = { ...scene.parts[0] };
  delete unnamed.name;
  const images = createGameContextImages({ platform: "win32", run: () => assert.fail("must not spawn") });
  const result = await images.render(request({ screenshot: false, scene: { parts: [unnamed] } }));
  assert.deepEqual(result.map, unavailable("invalid-scene"));
});

test("observed labels are data only and never part of executable arguments", async () => {
  const injection = "$(throw 'INJECTED'); <script>";
  const transport = helper((input, child) => {
    assert.equal(input.scene.parts[0].name, injection);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { ...scene, parts: [{ ...scene.parts[0], name: injection }] } }));
  assert.equal(result.map.status, "available");
  assert.equal(transport.invocations[0].options.shell, false);
  assert.doesNotMatch(JSON.stringify(transport.invocations[0].args), /INJECTED|<script>/);
});

const surfaceAt = (y, id = "surface") => ({ id, standable: "modeled",
  vertices: [{ x: 0, y, z: 0 }, { x: 10, y, z: 0 }, { x: 10, y, z: 10 }, { x: 0, y, z: 10 }] });
const overlays = (extra = {}) => ({ surfaces: [], links: [], tracks: [], hazards: [], ...extra });
const linkAt = (extra = {}) => ({
  id: "link", from: "floor-a", to: "floor-b", fromMode: "floor", toMode: "floor",
  action: "jump", status: "modeled", duration: 0.5, reasons: [],
  takeoff: { x: 0, y: 0, z: 0 }, landing: { x: 8, y: 0, z: 0 },
  windows: [{ start: 0, end: 0 }], ...extra,
});

test("reconstructed unnamed probe patches normalize without fabricating captured metadata", async () => {
  const samples = [];
  for (let column = 0; column < 2; column++) for (let row = 0; row < 2; row++) {
    samples.push({ column, row, origin: { x: column * 10, y: 20, z: row * 10 }, hit: true,
      position: { x: column * 10, y: 0, z: row * 10 }, normal: { x: 0, y: 1, z: 0 },
      path: "Workspace.Terrain", className: "Terrain" });
  }
  const geometry = reconstructGeometry([], {
    profile: { walkSpeed: 16, jumpVelocity: 50, gravity: 196.2, radius: 1, height: 5,
      maxSlopeDegrees: 45, maxDropHeight: 12, stepHeight: 1, landingMargin: 0.25 },
    probeBatches: [{ observedAt: "2026-09-09T00:00:00.000Z", client: { clientId: "client-test", generation: 1 },
      data: { schema: 1, center: { x: 5, y: 0, z: 5 }, size: { x: 10, y: 40, z: 10 },
        columns: 2, rows: 2, samples, coverage: "complete", truncated: false, stopReasons: [] } }],
  });
  assert.equal(geometry.parts.length, 1);
  assert.equal(geometry.parts[0].sourceIdentity, "probe-sample");
  assert.equal(Object.hasOwn(geometry.parts[0], "name"), false);
  const original = structuredClone(geometry);
  const transport = helper((input, child) => {
    assert.equal(input.screenshot, false);
    assert.equal(input.mapOverlay.parts.length, 1);
    assert.equal(input.mapOverlay.primitives.length, 1);
    assert.equal(input.mapOverlay.primitives[0].kind, "candidate");
    assert.deepEqual(input.mapOverlay.primitives[0].points,
      geometry.surfaces[0].vertices.map((p) => ({ x: p.x - p.z * 0.5, z: p.z * 0.5 - p.y })));
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: geometry.parts },
    mapOverlay: overlays({ surfaces: geometry.surfaces }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedParts, 1);
  assert.equal(result.map.rendering.selectedPrimitives, 1);
  assert.equal(result.map.rendering.unrenderedParts, 0);
  assert.equal(result.map.rendering.unrenderedPrimitives, 0);
  assert.deepEqual(geometry, original);
});

test("overlay layers keep stacked floors distinct and explicitly account for excluded geometry", async () => {
  let drawing;
  const transport = helper((input, child) => {
    drawing = input.mapOverlay;
    assert.equal(input.screenshot, false);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const input = request({ screenshot: false, scene: { parts: [] }, mapOverlay: overlays({ surfaces: [surfaceAt(0), surfaceAt(20)] }) });
  const both = await transport.images.render(input);
  assert.notDeepEqual(drawing.primitives[0].points, drawing.primitives[1].points);
  assert.match(drawing.primitives[1].label, /Y=20/);
  assert.equal(both.map.rendering.selectedPrimitives, 2);
  const filtered = await transport.images.render({ ...input, mapOverlay: { ...input.mapOverlay, minY: 10, maxY: 30 } });
  assert.equal(drawing.primitives.length, 1);
  assert.equal(filtered.map.rendering.unrenderedPrimitives, 1);
  assert.equal(filtered.map.rendering.coverage, "partial");
  assert.match(filtered.map.rendering.warnings.join(" "), /exclude recorded data/);
});

test("ceiling overlays retain downward support geometry and label legacy surfaces as floor without inference", async () => {
  const floor = { ...surfaceAt(0, "floor"), normal: { x: 0, y: 1, z: 0 }, supportMode: "floor" };
  const ceiling = { ...surfaceAt(20, "ceiling"), normal: { x: 0, y: -1, z: 0 }, supportMode: "ceiling" };
  ceiling.vertices.reverse();
  const legacy = { ...surfaceAt(30, "legacy"), normal: { x: 0, y: -1, z: 0 } };
  const surfaces = [floor, ceiling, legacy];
  const original = structuredClone(surfaces);
  const transport = helper((input, child) => {
    const primitives = input.mapOverlay.primitives;
    assert.match(primitives[0].label, /^FLOOR /);
    assert.match(primitives[1].label, /^CEILING /);
    assert.match(primitives[2].label, /^FLOOR /);
    for (let index = 0; index < surfaces.length; index++) {
      assert.equal(primitives[index].kind, "surface");
      assert.deepEqual(primitives[index].points,
        surfaces[index].vertices.map((p) => ({ x: p.x - p.z * 0.5, z: p.z * 0.5 - p.y })));
    }
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ surfaces }) }));
  assert.equal(result.map.status, "available");
  assert.deepEqual(surfaces, original);
});

test("reported switches share exact paths while retaining unknown time, direction, and layer exclusions", async () => {
  const injection = "$(throw 'INJECTED')\n\u202e";
  const switching = { from: injection, to: "ceiling", fromMode: "floor", toMode: "ceiling",
    action: "mode-switch", status: "candidate", duration: null, transitionId: injection,
    reasons: [injection], takeoff: { x: 4, y: 0, z: 2 }, landing: { x: 4, y: 20, z: 2 } };
  const links = [{ ...switching, takeoff: { x: 4, y: 40, z: 2 }, landing: { x: 4, y: 60, z: 2 } },
    switching, { ...switching },
    { ...switching, from: "ceiling", to: "floor", fromMode: "ceiling", toMode: "floor",
      takeoff: switching.landing, landing: switching.takeoff }];
  const original = structuredClone(links);
  const transport = helper((input, child) => {
    const primitives = input.mapOverlay.primitives;
    assert.equal(primitives.length, 2);
    assert.deepEqual(input.mapOverlay.linkSummary.match(/\d+/g).map(Number), [2, 3, 0, 1, 1, 0]);
    assert.ok(primitives.every((primitive) => primitive.kind === "uncertain-link"));
    assert.match(primitives[0].label, /^FLOOR>CEILING .*user-report.*unknown time/);
    assert.match(primitives[1].label, /^CEILING>FLOOR .*user-report.*unknown time/);
    assert.deepEqual(primitives[0].points, [{ x: 3, z: 1 }, { x: 3, z: -19 }]);
    assert.deepEqual(primitives[1].points, [{ x: 3, z: -19 }, { x: 3, z: 1 }]);
    assert.doesNotMatch(JSON.stringify(primitives), /INJECTED|[\n\u202e]|\b0s\b|teleport|speed/i);
    assert.ok(primitives.every((primitive) => primitive.label.length <= 64));
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ minY: -1, maxY: 21, links }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedPrimitives, 2);
  assert.equal(result.map.rendering.unrenderedPrimitives, 1);
  assert.equal(result.map.rendering.omittedLabels, 0);
  assert.equal(result.map.rendering.selectedLinkPaths, 2);
  assert.equal(result.map.rendering.representedLinks, 3);
  assert.equal(result.map.rendering.representedTimeOpportunities, 0);
  assert.deepEqual(links, original);
  assert.equal(transport.invocations[0].options.shell, false);
  assert.doesNotMatch(JSON.stringify(transport.invocations[0].args), /INJECTED/);
});

test("visible reported switches retain labels after twenty surfaces without increasing the label budget", async () => {
  const surfaces = Array.from({ length: 20 }, (_, index) => surfaceAt(index, `floor-${index}`));
  const switches = Array.from({ length: 4 }, (_, index) => ({
    from: `floor-${index}`, to: `ceiling-${index}`, fromMode: "floor", toMode: "ceiling",
    action: "mode-switch", status: "candidate", duration: null,
    takeoff: { x: index, y: 0, z: 0 }, landing: { x: index, y: 20, z: 0 },
  }));
  const excluded = { ...switches[0], takeoff: { x: 0, y: 40, z: 0 }, landing: { x: 0, y: 60, z: 0 } };
  const transport = helper((input, child) => {
    const primitives = input.mapOverlay.primitives;
    assert.equal(primitives.length, 24);
    assert.equal(primitives.filter((primitive) => primitive.label).length, 20);
    for (let index = 0; index < surfaces.length; index++) {
      assert.equal(primitives[index].kind, "surface");
      assert.deepEqual(primitives[index].points,
        surfaces[index].vertices.map((p) => ({ x: p.x - p.z * 0.5, z: p.z * 0.5 - p.y })));
    }
    assert.equal(primitives.slice(0, 20).filter((primitive) => primitive.label).length, 16);
    for (const primitive of primitives.slice(20, 24)) {
      assert.equal(primitive.kind, "uncertain-link");
      assert.match(primitive.label, /FLOOR>CEILING .*user-report.*unknown time/);
    }
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ minY: -1, maxY: 21, surfaces, links: [excluded, ...switches, switches[0]] }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedPrimitives, 24);
  assert.equal(result.map.rendering.unrenderedPrimitives, 1);
  assert.equal(result.map.rendering.omittedLabels, 4);
  assert.equal(result.map.rendering.selectedLinkPaths, 4);
  assert.equal(result.map.rendering.representedLinks, 5);
});

test("switches excluded by the primitive cap cannot displace visible surface labels", async () => {
  const transport = helper((input, child) => {
    assert.equal(input.mapOverlay.primitives.length, 512);
    assert.equal(input.mapOverlay.primitives.filter((primitive) => primitive.label).length, 20);
    assert.ok(input.mapOverlay.primitives.every((primitive) => primitive.kind === "surface"));
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({
      surfaces: Array.from({ length: 512 }, (_, index) => surfaceAt(0, `floor-${index}`)),
      links: [{ from: "floor", to: "ceiling", fromMode: "floor", toMode: "ceiling",
        action: "mode-switch", status: "candidate", duration: null,
        takeoff: { x: 0, y: 0, z: 0 }, landing: { x: 0, y: 20, z: 0 } }],
    }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.unrenderedPrimitives, 1);
  assert.equal(result.map.rendering.omittedLabels, 492);
});

test("exact structural paths share one primitive without combining or discarding timing opportunities", async () => {
  const base = linkAt({ windows: [{ start: 0, end: 0 }, { start: 4, end: 4 }] });
  const reordered = Object.fromEntries(Object.entries({
    ...base, id: "second", takeoff: { z: 0, y: 0, x: 0 }, landing: { z: 0, y: 0, x: 8 },
    windows: [{ start: 0.5, end: 0.5 }],
  }).reverse());
  const links = [base, reordered, { ...base, id: "third", windows: [{ start: 2, end: 2 }] }];
  const original = structuredClone(links);
  const transport = helper((input, child) => {
    assert.equal(input.mapOverlay.primitives.length, 1);
    assert.deepEqual(input.mapOverlay.primitives[0].points, [{ x: 0, z: 0 }, { x: 8, z: 0 }]);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] }, mapOverlay: overlays({ links }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedPrimitives, 1);
  assert.equal(result.map.rendering.selectedLinkPaths, 1);
  assert.equal(result.map.rendering.representedLinks, 3);
  assert.equal(result.map.rendering.representedTimeOpportunities, 4);
  assert.equal(result.map.rendering.unrenderedPrimitives, 0);
  assert.equal(result.map.rendering.omittedLabels, 0);
  assert.deepEqual(links, original);
});

test("path sharing preserves exact 3D poses, duration, status, modes, and evidence even when projections coincide", async () => {
  const base = linkAt();
  const links = [
    base,
    linkAt({ landing: { ...base.landing, x: 8 + Number.EPSILON * 8 } }),
    linkAt({ takeoff: { x: 1, y: 1, z: 2 }, landing: { x: 9, y: 1, z: 2 } }),
    linkAt({ duration: 0.5000000000000001 }),
    linkAt({ status: "candidate" }),
    linkAt({ fromMode: "ceiling", toMode: "ceiling" }),
    linkAt({ reasons: ["unverified moving support"] }),
    linkAt({ from: "another-floor" }),
    linkAt({ to: "another-target" }),
    linkAt({ action: "ride" }),
  ];
  const original = structuredClone(links);
  const transport = helper((input, child) => {
    const primitives = input.mapOverlay.primitives;
    assert.equal(primitives.length, links.length);
    assert.notDeepEqual(primitives[0].points, primitives[1].points);
    assert.deepEqual(primitives[0].points, primitives[2].points);
    assert.equal(primitives[4].kind, "uncertain-link");
    assert.match(primitives[4].label, /\?/);
    assert.equal(primitives[5].kind, "link");
    assert.ok(primitives[5].label);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] }, mapOverlay: overlays({ links }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedLinkPaths, links.length);
  assert.equal(result.map.rendering.representedLinks, links.length);
  assert.equal(result.map.rendering.representedTimeOpportunities, links.length);
  assert.deepEqual(links, original);
});

test("the raw link and per-row window caps remain bounded even when every path is identical", async () => {
  const windows = Array.from({ length: 128 }, (_, index) => ({ start: index / 4, end: index / 4 }));
  const links = Array.from({ length: 4096 }, (_, index) => linkAt({ id: `link-${index}`, windows }));
  const transport = helper((input, child) => {
    assert.equal(input.mapOverlay.primitives.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 256 * 1024);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] }, mapOverlay: overlays({ links }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedLinkPaths, 1);
  assert.equal(result.map.rendering.representedLinks, 4096);
  assert.equal(result.map.rendering.representedTimeOpportunities, 4096 * 128);
  assert.equal(result.map.rendering.unrenderedPrimitives, 0);
  assert.equal(result.map.rendering.omittedLabels, 0);
  const tooManyLinks = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ links: [...links, links[0]] }) }));
  const tooManyWindows = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ links: [linkAt({ windows: [...windows, windows[0]] })] }) }));
  assert.deepEqual(tooManyLinks.map, unavailable("invalid-scene"));
  assert.deepEqual(tooManyWindows.map, unavailable("invalid-scene"));
  assert.equal(transport.invocations.length, 1);
});

test("Y and primitive exclusions count omitted exact paths separately from their represented rows and windows", async () => {
  const hidden = linkAt({ takeoff: { x: 0, y: 40, z: 0 }, landing: { x: 8, y: 40, z: 0 } });
  const visible = linkAt({ windows: [{ start: 1, end: 1 }, { start: 3, end: 3 }] });
  const links = [hidden, { ...hidden, id: "hidden-again" }, visible, { ...visible, id: "visible-again" },
    linkAt({ duration: 1, windows: [{ start: 2, end: 2 }] })];
  const transport = helper((input, child) => {
    assert.equal(input.mapOverlay.primitives.length, 512);
    assert.equal(input.mapOverlay.primitives.filter((item) => item.kind === "link").length, 1);
    assert.equal(input.mapOverlay.primitives.filter((item) => item.label).length, 20);
    assert.deepEqual(input.mapOverlay.linkSummary.match(/\d+/g).map(Number), [1, 2, 4, 2, 3, 3]);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ minY: -1, maxY: 21, surfaces: Array.from({ length: 511 }, () => surfaceAt(0)), links }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedLinkPaths, 1);
  assert.equal(result.map.rendering.representedLinks, 2);
  assert.equal(result.map.rendering.representedTimeOpportunities, 4);
  assert.equal(result.map.rendering.unrenderedPrimitives, 2);
});

test("IPC trimming removes a shared path's entire row and opportunity counts without claiming omitted geometry was drawn", async () => {
  const coordinate = 0.0000010000000000000002;
  const corner = { x: coordinate, y: -coordinate, z: 0 };
  const hazards = Array.from({ length: 510 }, () => ({ level: "unknown", bounds: { min: corner, max: corner } }));
  const first = linkAt({ windows: [{ start: 0, end: 0 }, { start: 1, end: 1 }] });
  const second = linkAt({ duration: 1, windows: [{ start: 2, end: 2 }, { start: 3, end: 3 }] });
  const links = [first, { ...first, id: "first-again" }, second, { ...second, id: "second-again" }];
  let primitiveCount;
  const transport = helper((input, child) => {
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 256 * 1024);
    primitiveCount = input.mapOverlay.primitives.length;
    assert.ok(primitiveCount < 510);
    assert.ok(input.mapOverlay.primitives.every((item) => item.kind === "hazard"));
    assert.ok(input.mapOverlay.primitives.filter((item) => item.label).length <= 20);
    assert.deepEqual(input.mapOverlay.linkSummary.match(/\d+/g).map(Number), [0, 0, 0, 2, 4, 8]);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ hazards, links }) }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedPrimitives, primitiveCount);
  assert.equal(result.map.rendering.selectedPrimitives + result.map.rendering.unrenderedPrimitives, 512);
  assert.equal(result.map.rendering.selectedLinkPaths, 0);
  assert.equal(result.map.rendering.representedLinks, 0);
  assert.equal(result.map.rendering.representedTimeOpportunities, 0);
});

test("fabricated numeric switch timing and unsupported support modes never reach the drawing helper", async () => {
  const images = createGameContextImages({ platform: "win32", run: () => assert.fail("must not spawn") });
  const timed = await images.render(request({ screenshot: false, scene: { parts: [] }, mapOverlay: overlays({
    links: [{ from: "floor", to: "ceiling", fromMode: "floor", toMode: "ceiling", action: "mode-switch",
      duration: 0, status: "candidate", takeoff: { x: 0, y: 0, z: 0 }, landing: { x: 0, y: 20, z: 0 } }],
  }) }));
  assert.deepEqual(timed.map, unavailable("invalid-scene"));
  const windowed = await images.render(request({ screenshot: false, scene: { parts: [] }, mapOverlay: overlays({
    links: [{ from: "floor", to: "ceiling", fromMode: "floor", toMode: "ceiling", action: "mode-switch",
      duration: null, status: "candidate", windows: [{ start: 0, end: 0 }],
      takeoff: { x: 0, y: 0, z: 0 }, landing: { x: 0, y: 20, z: 0 } }],
  }) }));
  assert.deepEqual(windowed.map, unavailable("invalid-scene"));
  const unsupported = await images.render(request({ screenshot: false, scene: { parts: [] },
    mapOverlay: overlays({ surfaces: [{ ...surfaceAt(0), supportMode: "wall" }] }) }));
  assert.deepEqual(unsupported.map, unavailable("invalid-scene"));
});

test("overlay selection bounds parts, primitives, labels and UTF-8 IPC without losing omission accounting", async () => {
  const transport = helper((input, child) => {
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 256 * 1024);
    assert.ok(input.mapOverlay.parts.length <= 512);
    assert.ok(input.mapOverlay.primitives.length <= 512);
    assert.ok(input.mapOverlay.primitives.filter((item) => item.label).length <= 20);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false,
    scene: { parts: Array.from({ length: 1024 }, () => scene.parts[0]) },
    mapOverlay: overlays({ surfaces: Array.from({ length: 600 }, (_, i) => surfaceAt(i, "観測".repeat(64))) }),
  }));
  assert.equal(result.map.status, "available");
  assert.equal(result.map.rendering.selectedParts + result.map.rendering.unrenderedParts, 1024);
  assert.equal(result.map.rendering.selectedPrimitives + result.map.rendering.unrenderedPrimitives, 600);
  assert.ok(result.map.rendering.unrenderedParts >= 512);
  assert.ok(result.map.rendering.unrenderedPrimitives >= 88);
});

test("malformed overlay cannot suppress screenshot or reach the drawing helper", async () => {
  const transport = helper((input, child) => {
    assert.equal(input.map, false);
    assert.equal(input.mapOverlay, undefined);
    child.respond({ schema: 1, screenshot: available("screenshot"), map: notRequested });
  });
  const result = await transport.images.render(request({ mapOverlay: overlays({ surfaces: [{ vertices: [{ x: Infinity, y: 0, z: 0 }] }] }) }));
  assert.equal(result.screenshot.status, "available");
  assert.deepEqual(result.map, unavailable("invalid-scene"));
});

test("overlay labels remain data and observed motion trails never invent intermediate samples", async () => {
  const injection = "$(throw 'INJECTED')\n\u202e";
  const transport = helper((input, child) => {
    assert.match(input.mapOverlay.primitives[0].label, /\$\(throw 'INJECTED'\)/);
    assert.doesNotMatch(input.mapOverlay.primitives[0].label, /[\n\u202e]/);
    const trails = input.mapOverlay.primitives.filter((item) => item.kind === "trail");
    assert.equal(trails.length, 1);
    assert.deepEqual(trails[0].points, [{ x: 0, z: 0 }, { x: 4, z: -2 }]);
    child.respond({ schema: 1, screenshot: notRequested, map: available("map") });
  });
  const result = await transport.images.render(request({ screenshot: false, scene: { parts: [{ ...scene.parts[0], id: "platform", name: injection }] }, mapOverlay: overlays({
    surfaces: [{ ...surfaceAt(0), partId: "platform", supportMode: "ceiling" }],
    tracks: [{ samples: [{ cframe: scene.parts[0].cframe }, { cframe: [4, 2, 0, ...scene.parts[0].cframe.slice(3)] }] }],
  }) }));
  assert.equal(result.map.status, "available");
  assert.doesNotMatch(JSON.stringify(transport.invocations[0].args), /INJECTED/);
});

test("cancellation terminates only the owned helper and holds its slot until exit", async () => {
  const transport = helper(() => {}, { closeOnKill: false });
  const controller = new AbortController();
  const pending = transport.images.render(request({ signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await pending, { screenshot: unavailable("cancelled"), map: unavailable("cancelled") });
  assert.equal(transport.children[0].kills, 1);
  assert.deepEqual(await transport.images.render(request()), { screenshot: unavailable("busy"), map: unavailable("busy") });
  assert.equal(transport.children.length, 1);
  transport.children[0].emit("close", null);
  const next = transport.images.render(request({ map: false }));
  transport.children[1].respond({ schema: 1, screenshot: unavailable("target-not-found"), map: notRequested });
  assert.deepEqual((await next).screenshot, unavailable("target-not-found"));
  assert.equal(transport.children[1].kills, 0);
});

test("already cancelled work never creates a helper", async () => {
  const transport = helper(() => assert.fail("must not spawn"));
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await transport.images.render(request({ signal: controller.signal })), { screenshot: unavailable("cancelled"), map: unavailable("cancelled") });
  assert.equal(transport.children.length, 0);
});

test("the combined IPC output limit kills the helper rather than retaining excessive data", async () => {
  const transport = helper((_input, child) => {
    child.stderr.write(Buffer.alloc(8192));
    child.stdout.write(Buffer.alloc(1024 * 1024 - 8191));
  });
  assert.deepEqual(await transport.images.render(request()), { screenshot: unavailable("helper-output-limit"), map: unavailable("helper-output-limit") });
  assert.equal(transport.children[0].kills, 1);
});

test("a stalled native request times out at ten seconds and kills its owned helper", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = helper();
  const pending = transport.images.render(request());
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, { screenshot: unavailable("helper-timeout"), map: unavailable("helper-timeout") });
  assert.equal(transport.children[0].kills, 1);
});

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../assets/game-context-images.ps1", import.meta.url));
const outputLimit = 1024 * 1024;
const inputLimit = 256 * 1024;
const minimumImageBytes = 4096;
const maximumImageBytes = 128 * 1024;
const association = "Single Roblox process/window observed; association with the selected authenticated client is not cryptographically verified.";
const providers = { screenshot: "windows-printwindow-client-area", map: "client-visible-box-schematic" };
const reasons = new Set([
  "not-requested", "unsupported-platform", "image-budget", "invalid-scene", "helper-unavailable",
  "helper-failed", "helper-timeout", "helper-output-limit", "invalid-image-result", "cancelled", "busy",
  "target-not-found", "target-ambiguous", "target-not-visible", "target-changed", "target-unavailable",
  "window-size-limit", "capture-failed", "capture-uniform", "map-empty", "map-render-failed",
]);

function unavailable(reason) {
  return { status: "unavailable", reason };
}

function requestedFacets(screenshot, map, reason) {
  return Object.fromEntries(Object.entries({ screenshot, map }).map(([kind, requested]) => [kind,
    requested ? unavailable(reason) : { status: "not-requested", reason: "not-requested" },
  ]));
}

function environment() {
  const result = {};
  // Do not inherit credentials, profiles, PATH, or PowerShell module overrides.
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "SystemDrive"]) {
    const actual = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (actual && process.env[actual]) result[name] = process.env[actual];
  }
  return result;
}

function point(value, maximum, positive = false) {
  if (!value || typeof value !== "object") throw new Error("invalid-scene");
  const result = {};
  for (const axis of ["x", "y", "z"]) {
    const number = value[axis];
    if (!Number.isFinite(number) || Math.abs(number) > maximum || (positive && number <= 0)) throw new Error("invalid-scene");
    result[axis] = number;
  }
  return result;
}

function partGeometry(part) {
  if (!part || !Array.isArray(part.cframe) || part.cframe.length !== 12) throw new Error("invalid-scene");
  const cframe = part.cframe.map((number, index) => {
    if (!Number.isFinite(number) || Math.abs(number) > (index < 3 ? 1e9 : 1.001)) throw new Error("invalid-scene");
    return number;
  });
  return { cframe, size: point(part.size, 1e6, true) };
}

function sceneData(scene) {
  if (!scene || !Array.isArray(scene.parts) || scene.parts.length > 512) throw new Error("invalid-scene");
  const parts = scene.parts.map((part) => {
    if (!part || typeof part.name !== "string") throw new Error("invalid-scene");
    return {
      name: part.name.slice(0, 80).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " "),
      ...partGeometry(part),
    };
  });
  const player = scene.player?.present && scene.player.position ? point(scene.player.position, 1e9) : null;
  return { parts, player };
}

// Exact JSON structure, not screen coordinates: nearby poses, durations, modes,
// status, and evidence must never become one path merely because they overlap.
function linkPathKey(link) {
  const { id, windows, ...semantics } = link;
  return JSON.stringify(semantics, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid-scene");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value;
  });
}

function updateLinkSummary({ drawing, metadata, linkTotals }) {
  drawing.linkSummary = `Links: ${metadata.selectedLinkPaths} paths / ${metadata.representedLinks} rows / ${metadata.representedTimeOpportunities} windows`
    + ` | omitted: ${linkTotals.paths - metadata.selectedLinkPaths} paths / ${linkTotals.links - metadata.representedLinks} rows / ${linkTotals.timeOpportunities - metadata.representedTimeOpportunities} windows`;
}

// Only this boundary converts analysis rows into drawing DTOs. The helper never
// infers walkability, danger, trajectories, or connectivity from box projections.
function overlayData(scene, overlay) {
  if (!overlay || typeof overlay !== "object" || !Array.isArray(scene?.parts) || scene.parts.length > 1024) throw new Error("invalid-scene");
  for (const [key, cap] of Object.entries({ surfaces: 2048, links: 4096, tracks: 1024, hazards: 1024 })) {
    if (!Array.isArray(overlay[key]) || overlay[key].length > cap) throw new Error("invalid-scene");
  }
  for (const key of ["minY", "maxY"]) {
    if (overlay[key] !== undefined && (!Number.isFinite(overlay[key]) || Math.abs(overlay[key]) > 1e9)) throw new Error("invalid-scene");
  }
  if (overlay.minY !== undefined && overlay.maxY !== undefined && overlay.minY > overlay.maxY) throw new Error("invalid-scene");
  const metadata = { coverage: "partial", selectedParts: 0, unrenderedParts: 0, selectedPrimitives: 0, unrenderedPrimitives: 0, omittedLabels: 0,
    selectedLinkPaths: 0, representedLinks: 0, representedTimeOpportunities: 0,
    warnings: ["Partial recorded map; uncertainty is not safety.", "Oblique X/Z/Y projection; overlapping geometry may occlude."] };
  for (const key of ["minY", "maxY"]) if (overlay[key] !== undefined) metadata[key] = overlay[key];
  const drawing = { parts: [], primitives: [], layer: `Y ${overlay.minY ?? "-infinity"} to ${overlay.maxY ?? "+infinity"}` };
  const label = (text) => String(text ?? "").slice(0, 64).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
  const project = (p) => ({ x: p.x - p.z * 0.5, z: p.z * 0.5 - p.y });
  const inLayer = (points) => points.some((p) => p.y >= (overlay.minY ?? -Infinity)) && points.some((p) => p.y <= (overlay.maxY ?? Infinity));
  let labels = 0;
  const ordinaryLabels = [];
  const add = (kind, points, text, part = false, priorityLabel = false) => {
    const selected = part ? drawing.parts : drawing.primitives;
    const skipped = part ? "unrenderedParts" : "unrenderedPrimitives";
    if (!inLayer(points) || selected.length >= 512) { metadata[skipped]++; return; }
    const cleanLabel = label(text);
    if (cleanLabel && priorityLabel && labels >= 20 && ordinaryLabels.length) {
      ordinaryLabels.pop().label = "";
      labels--;
      metadata.omittedLabels++;
    }
    const shownLabel = cleanLabel && labels < 20 ? cleanLabel : "";
    if (shownLabel) labels++; else if (cleanLabel) metadata.omittedLabels++;
    const item = { kind, points: points.map(project), label: shownLabel };
    selected.push(item);
    if (shownLabel && !priorityLabel) ordinaryLabels.push(item);
    return item;
  };
  const vector = (p) => point(p, 1.01e9);
  const corners = (bounds) => {
    const min = vector(bounds?.min); const max = vector(bounds?.max);
    if (["x", "y", "z"].some((axis) => min[axis] > max[axis])) throw new Error("invalid-scene");
    return [min, { ...min, x: max.x }, { ...max, z: min.z }, { ...min, y: max.y },
      { ...min, z: max.z }, { ...max, y: min.y }, max, { ...max, x: min.x }];
  };
  const partNames = new Map();
  for (const part of scene.parts) {
    const clean = partGeometry(part);
    if (typeof part.name === "string") partNames.set(part.id, label(part.name).slice(0, 24));
    const cf = clean.cframe; const size = clean.size;
    const points = [];
    for (const [x, y, z] of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]) {
      points.push(vector({ x: cf[0] + (cf[3]*size.x*x + cf[4]*size.y*y + cf[5]*size.z*z)/2,
        y: cf[1] + (cf[6]*size.x*x + cf[7]*size.y*y + cf[8]*size.z*z)/2,
        z: cf[2] + (cf[9]*size.x*x + cf[10]*size.y*y + cf[11]*size.z*z)/2 }));
    }
    add("box", points, "", true);
  }
  for (const surface of overlay.surfaces) {
    if (!Array.isArray(surface.vertices) || surface.vertices.length < 3 || surface.vertices.length > 4) throw new Error("invalid-scene");
    const mode = surface.supportMode === undefined ? "floor" : surface.supportMode;
    if (!["floor", "ceiling"].includes(mode)) throw new Error("invalid-scene");
    const points = surface.vertices.map(vector);
    const title = partNames.get(surface.partId) || (surface.geometry === "sampled" ? "Sampled patch" : String(surface.id).slice(0, 12));
    add(surface.standable === "modeled" ? "surface" : "candidate", points, `${mode.toUpperCase()} ${title} Y=${points[0].y.toFixed(1)}${surface.standable === "modeled" ? "" : " ?"}`);
  }
  for (const hazard of overlay.hazards) add("hazard", corners(hazard.bounds), `${hazard.level} hazard (not proven)`);
  const labeledLinks = new Set();
  const linkPaths = new Map();
  const linkCounts = new WeakMap();
  const linkTotals = { paths: 0, links: overlay.links.length, timeOpportunities: 0 };
  for (const link of overlay.links) {
    if (!["walk", "jump", "drop", "ride", "wait", "mode-switch"].includes(link.action)) throw new Error("invalid-scene");
    const switching = link.action === "mode-switch";
    if (switching && (!["floor", "ceiling"].includes(link.fromMode) || !["floor", "ceiling"].includes(link.toMode)
      || link.fromMode === link.toMode || link.duration !== null || link.windows !== undefined)) throw new Error("invalid-scene");
    if (link.windows !== undefined && (!Array.isArray(link.windows) || link.windows.length > 128
      || link.windows.some((window) => !Number.isFinite(window?.start) || !Number.isFinite(window?.end)
        || window.start < 0 || window.end < window.start || window.end > 60))) throw new Error("invalid-scene");
    const pathKey = linkPathKey(link);
    const existing = linkPaths.get(pathKey);
    const opportunities = link.windows?.length ?? 0;
    linkTotals.timeOpportunities += opportunities;
    if (existing) {
      existing.links++;
      existing.timeOpportunities += opportunities;
      if (existing.drawn) {
        metadata.representedLinks++;
        metadata.representedTimeOpportunities += opportunities;
      }
      continue;
    }
    const points = [vector(link.takeoff), vector(link.landing)];
    const labelKey = JSON.stringify([link.from, link.to, link.action, link.fromMode, link.toMode, link.status]);
    const repeated = labeledLinks.has(labelKey);
    const uncertain = switching || link.status !== "modeled";
    const text = switching ? `${link.fromMode.toUpperCase()}>${link.toMode.toUpperCase()} mode-switch user-report / unknown time ?`
      : `${link.action}${uncertain ? " ?" : ""}`;
    const drawn = add(uncertain ? "uncertain-link" : "link", points, repeated ? "" : text, false, switching);
    const counts = { drawn: Boolean(drawn), links: 1, timeOpportunities: opportunities };
    linkPaths.set(pathKey, counts);
    linkTotals.paths++;
    if (drawn) {
      metadata.selectedLinkPaths++;
      metadata.representedLinks++;
      metadata.representedTimeOpportunities += opportunities;
      linkCounts.set(drawn, counts);
      if (repeated) metadata.omittedLabels++;
      else labeledLinks.add(labelKey);
    }
  }
  for (const track of overlay.tracks) {
    if (!Array.isArray(track.samples) || track.samples.length > 101) throw new Error("invalid-scene");
    let previous;
    for (const sample of track.samples) {
      if (!Array.isArray(sample.cframe) || sample.cframe.length !== 12 || !sample.cframe.every(Number.isFinite)) throw new Error("invalid-scene");
      const p = vector({ x: sample.cframe[0], y: sample.cframe[1], z: sample.cframe[2] });
      if (previous) add("trail", [previous, p], "");
      previous = p;
    }
  }
  metadata.selectedParts = drawing.parts.length;
  metadata.selectedPrimitives = drawing.primitives.length;
  const result = { drawing, metadata, linkCounts, linkTotals };
  updateLinkSummary(result);
  return result;
}

export function imageDimensions(bytes) {
  if (bytes.length < 32 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return null;
  let dimensions;
  let offset = 2;
  while (offset + 4 <= bytes.length - 2) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (dimensions || length < 11 || bytes[offset + 2] !== 8) return null;
      const components = bytes[offset + 7];
      if (![1, 3].includes(components) || length !== 8 + components * 3) return null;
      dimensions = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    if (marker === 0xda) return dimensions && offset + length < bytes.length - 2 ? dimensions : null;
    offset += length;
  }
  return null;
}

function validateFacet(value, kind, requested, maxBytes) {
  if (!requested) return { status: "not-requested", reason: "not-requested" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable("invalid-image-result");
  if (value.status === "unavailable") return unavailable(reasons.has(value.reason) && value.reason !== "not-requested" ? value.reason : "invalid-image-result");
  if (value.status !== "available" || value.mimeType !== "image/jpeg" || value.provider !== providers[kind]
      || !Number.isInteger(value.width) || !Number.isInteger(value.height)
      || value.width < 1 || value.height < 1 || value.width > 1600 || value.height > 1600
      || typeof value.data !== "string") return unavailable("invalid-image-result");
  if (value.data.length > Math.ceil(maxBytes / 3) * 4) return unavailable("image-budget");
  if (value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return unavailable("invalid-image-result");
  const data = Buffer.from(value.data, "base64");
  if (data.length > maxBytes) return unavailable("image-budget");
  const dimensions = imageDimensions(data);
  if (!dimensions || dimensions.width !== value.width || dimensions.height !== value.height || data.toString("base64") !== value.data) return unavailable("invalid-image-result");
  const result = { status: "available", data, mimeType: "image/jpeg", ...dimensions, provider: providers[kind] };
  if (kind === "screenshot") {
    const target = value.target;
    if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid > 0xffffffff
        || typeof target.startedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(target.startedAt)
        || !Number.isFinite(Date.parse(target.startedAt))
        || typeof target.windowHandle !== "string" || !/^0x[0-9a-f]{1,16}$/.test(target.windowHandle) || /^0x0+$/.test(target.windowHandle)) return unavailable("invalid-image-result");
    result.target = { pid: target.pid, startedAt: target.startedAt, windowHandle: target.windowHandle, association };
  }
  return result;
}

function invoke(run, bytes, signal, state) {
  return new Promise((resolve, reject) => {
    const env = environment();
    const windows = env.SystemRoot || env.WINDIR;
    if (!windows || !path.win32.isAbsolute(windows)) { reject(new Error("helper-unavailable")); return; }
    let child;
    try {
      child = run(path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      ], { cwd: path.dirname(script), env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch { reject(new Error("helper-unavailable")); return; }
    state.active = true;
    let chunks = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      chunks = [];
      if (error) reject(error); else resolve(value);
    };
    const stop = (reason) => {
      if (settled) return;
      // Only this invocation's owned helper is terminated. Never enumerate/kill Roblox or use taskkill.
      try { child.kill(); } catch { /* Keep the slot occupied until close confirms termination. */ }
      child.stdin.destroy();
      finish(new Error(reason));
    };
    const abort = () => stop("cancelled");
    const timeout = setTimeout(() => stop("helper-timeout"), 10000);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      if (!child.pid) state.active = false;
      stop("helper-unavailable");
    });
    child.once("close", (code) => {
      state.active = false;
      if (settled) return;
      if (code !== 0) { finish(new Error("helper-failed")); return; }
      try { finish(null, JSON.parse(Buffer.concat(chunks, outputBytes).toString("utf8"))); }
      catch { finish(new Error("invalid-image-result")); }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop("helper-failed"));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes + diagnosticBytes > outputLimit) stop("helper-output-limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 16384 || outputBytes + diagnosticBytes > outputLimit) stop("helper-output-limit");
    });
    if (signal?.aborted) abort();
    else child.stdin.end(bytes);
  });
}

/** run is a spawn-compatible adapter for tests; input is JSON data sent only to the fixed bundled script. */
export function createGameContextImages({ run = spawn, platform = process.platform } = {}) {
  const state = { active: false };
  return {
    async render({ scene, screenshot = true, map = true, maxBytes, signal, mapOverlay } = {}) {
      screenshot = screenshot === true;
      map = map === true;
      const initial = requestedFacets(screenshot, map, "helper-failed");
      if (!screenshot && !map) return initial;
      if (signal?.aborted) return requestedFacets(screenshot, map, "cancelled");
      if (platform !== "win32") return requestedFacets(screenshot, map, "unsupported-platform");
      if (!Number.isInteger(maxBytes) || maxBytes < minimumImageBytes) return requestedFacets(screenshot, map, "image-budget");
      if (state.active) return requestedFacets(screenshot, map, "busy");
      const budget = Math.min(maxBytes, maximumImageBytes);
      let cleanScene = null;
      let sceneInvalid = false;
      let overlay;
      if (map) {
        try {
          if (mapOverlay !== undefined) { overlay = overlayData(scene, mapOverlay); cleanScene = { parts: [], player: null }; }
          else cleanScene = sceneData(scene);
        }
        catch { sceneInvalid = true; initial.map = unavailable("invalid-scene"); }
      }
      const request = { schema: 1, screenshot, map: map && !sceneInvalid, maxBytes: budget, scene: cleanScene };
      if (overlay) request.mapOverlay = overlay.drawing;
      let bytes = Buffer.from(JSON.stringify(request), "utf8");
      while (bytes.length > inputLimit && overlay && (overlay.drawing.parts.length || overlay.drawing.primitives.length)) {
        if (overlay.drawing.parts.length) { overlay.drawing.parts.pop(); overlay.metadata.selectedParts--; overlay.metadata.unrenderedParts++; }
        else {
          const removed = overlay.drawing.primitives.pop();
          overlay.metadata.selectedPrimitives--; overlay.metadata.unrenderedPrimitives++;
          const counts = overlay.linkCounts.get(removed);
          if (counts) {
            overlay.metadata.selectedLinkPaths--;
            overlay.metadata.representedLinks -= counts.links;
            overlay.metadata.representedTimeOpportunities -= counts.timeOpportunities;
          }
        }
        updateLinkSummary(overlay);
        bytes = Buffer.from(JSON.stringify(request), "utf8");
      }
      if (bytes.length > inputLimit) {
        initial.map = unavailable("invalid-scene"); sceneInvalid = true;
        request.map = false; request.scene = null;
        delete request.mapOverlay;
        bytes = Buffer.from(JSON.stringify(request), "utf8");
      }
      if (!request.screenshot && !request.map) return initial;
      try {
        const value = await invoke(run, bytes, signal, state);
        if (signal?.aborted) return requestedFacets(screenshot, map, "cancelled");
        if (!value || value.schema !== 1) return requestedFacets(screenshot, map, "invalid-image-result");
        const result = {
          screenshot: validateFacet(value.screenshot, "screenshot", screenshot, budget),
          map: sceneInvalid ? initial.map : validateFacet(value.map, "map", map, budget),
        };
        if (overlay) {
          if (overlay.metadata.unrenderedParts || overlay.metadata.unrenderedPrimitives) overlay.metadata.warnings.push("Selection, Y layer, or IPC limits exclude recorded data.");
          result.map.rendering = overlay.metadata;
        }
        return result;
      } catch (error) {
        const result = requestedFacets(screenshot, map, reasons.has(error?.message) ? error.message : "helper-failed");
        if (sceneInvalid) result.map = initial.map;
        return result;
      }
    },
  };
}

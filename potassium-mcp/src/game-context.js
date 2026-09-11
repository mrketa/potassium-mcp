import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { lstat, mkdir, rename, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createGameContextImages } from "./game-context-images.js";
import { createContextStore } from "./context-store.js";
import { legacyCapturedPartSchema, captureSceneSchema, legacyCaptureSceneSchema } from "./map-schemas.js";

const MAX_CONTEXTS = 8;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024;
const MAX_SCENE_BYTES = 32768;
const PAGE_BYTES = 6144;
const ID = /^gc-[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATIC_WARNING = "Immutable static snapshot captured at capturedAt; it does not describe later live state.";
const GEOMETRY_WARNING = "Bounded client-visible BasePart boxes only; not an entire server, full map, mesh, Terrain, navmesh, or pathfinding model.";
const activeCaptures = new Set();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code: `GAME_CONTEXT_${code}`, ...details });
const boundedText = (max) => z.string().max(max).refine((value) => value.isWellFormed() && !value.includes("\0"), "Must be well-formed text without NUL");
const contextIdSchema = z.string().regex(ID);
const coverageSchema = z.enum(["complete", "partial"]);
const vectorSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const playerSchema = z.object({ present: z.boolean(), position: vectorSchema.optional() }).strict();
function basicPart({ name, path, className, cframe, size, anchored, canCollide }) {
  return { name, path, className, cframe, size, anchored, canCollide };
}
const uiEntrySchema = z.object({ name: boundedText(128), path: boundedText(1024), className: boundedText(64), text: boundedText(256).optional() }).strict();
const remoteEntrySchema = z.object({ name: boundedText(128), path: boundedText(1024), className: z.enum(["RemoteEvent", "RemoteFunction", "UnreliableRemoteEvent"]) }).strict();
const placeSchema = z.object({ placeId: z.number().int().nonnegative(), placeVersion: z.number().int().nonnegative().optional(), name: boundedText(128).optional() }).strict();
const clientSchema = z.object({ clientId: boundedText(128).min(1), generation: z.union([boundedText(128).min(1), z.number().int().nonnegative()]) }).strict();
const statusSchema = z.enum(["available", "unavailable", "not-requested"]);
const targetSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().datetime(), windowHandle: z.string().regex(/^0x[0-9a-f]+$/i), association: boundedText(200) }).strict();
const facetSchema = z.object({
  status: statusSchema, reason: boundedText(256).optional(), mimeType: z.literal("image/jpeg").optional(),
  width: z.number().int().min(1).max(8192).optional(), height: z.number().int().min(1).max(8192).optional(),
  bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES).optional(), sha256: z.string().regex(HASH).optional(),
  provider: boundedText(96).optional(), target: targetSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "available") {
    for (const key of ["mimeType", "width", "height", "bytes", "sha256", "provider"]) if (value[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: "Available image requires this field" });
  } else if (!value.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Unavailable or unrequested image requires a reason" });
});
const imagesSchema = z.object({ screenshot: facetSchema, map: facetSchema }).strict();
const countsSchema = z.object({ parts: z.number().int().min(0).max(512), ui: z.number().int().min(0).max(40), remotes: z.number().int().min(0).max(100).optional() }).strict();
const summaryFields = {
  contextId: contextIdSchema, capturedAt: z.string().datetime(), client: clientSchema, place: placeSchema,
  root: boundedText(1024), coverage: coverageSchema, truncated: z.boolean(), visited: z.number().int().min(0).max(20000),
  player: playerSchema,
  stopReasons: z.array(boundedText(128)).max(32), counts: countsSchema, images: imagesSchema,
  partial: z.boolean(), static: z.literal(true), atomicSnapshot: z.literal(false), warnings: z.array(boundedText(256)).max(4),
};
const summarySchema = z.object(summaryFields).strict();
const listEntrySchema = z.object({
  contextId: contextIdSchema, capturedAt: z.string().datetime(), client: clientSchema,
  place: z.object({ placeId: z.number().int().nonnegative() }).strict(), coverage: coverageSchema,
  counts: countsSchema, images: z.object({ screenshot: statusSchema, map: statusSchema }).strict(), partial: z.boolean(), static: z.literal(true),
}).strict();

export const gameContextInputSchema = z.object({
  view: z.enum(["capture", "read", "list", "image", "release"]).default("capture").describe("read: section/offset/limit; image: kind required. contextId required only for read/image/release; others capture-only."),
  contextId: contextIdSchema.optional(),
  section: z.enum(["summary", "parts", "ui", "remotes"]).optional().meta({ default: "summary" }),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().meta({ default: 0 }),
  limit: z.number().int().min(1).max(100).optional().meta({ default: 20 }).describe("Rows per page: 1..100, default20; also byte-bounded."),
  kind: z.enum(["screenshot", "map"]).optional(),
  root: boundedText(1024).min(1).optional().meta({ default: "workspace" }),
  maxVisited: z.number().int().min(1).max(20000).optional().meta({ default: 2500 }),
  maxParts: z.number().int().min(1).max(512).optional().meta({ default: 200 }),
  uiLimit: z.number().int().min(0).max(40).optional().meta({ default: 20 }),
  remoteLimit: z.number().int().min(0).max(100).optional().meta({ default: 50 }).describe("ReplicatedStorage metadata; 0 disables."),
  screenshot: z.boolean().optional().meta({ default: true }),
  map: z.boolean().optional().meta({ default: true }),
}).strict().superRefine((value, ctx) => {
  const requiredId = ["read", "image", "release"].includes(value.view);
  if (requiredId && value.contextId === undefined) ctx.addIssue({ code: "custom", path: ["contextId"], message: "contextId is required for this view" });
  if (!requiredId && value.contextId !== undefined) ctx.addIssue({ code: "custom", path: ["contextId"], message: "contextId is only allowed for read, image, and release" });
  const groups = { read: ["section", "offset", "limit"], image: ["kind"], capture: ["root", "maxVisited", "maxParts", "uiLimit", "remoteLimit", "screenshot", "map"] };
  for (const [view, keys] of Object.entries(groups)) for (const key of keys) if (value[key] !== undefined && value.view !== view) ctx.addIssue({ code: "custom", path: [key], message: `${key} is only allowed for ${view}` });
  if (value.view === "image" && value.kind === undefined) ctx.addIssue({ code: "custom", path: ["kind"], message: "kind is required for image" });
});

export const gameContextOutputSchema = z.object({
  view: z.enum(["capture", "read", "list", "image", "release"]),
  ...Object.fromEntries(Object.entries(summaryFields).map(([key, schema]) => [key, schema.optional()])),
  section: z.enum(["summary", "parts", "ui", "remotes"]).optional(), offset: z.number().int().nonnegative().optional(),
  total: z.number().int().min(0).max(512).optional(), nextOffset: z.number().int().nonnegative().optional(),
  entries: z.array(z.union([legacyCapturedPartSchema, uiEntrySchema])).max(100).optional(),
  sectionCoverage: coverageSchema.optional(), sectionTruncated: z.boolean().optional(),
  kind: z.enum(["screenshot", "map"]).optional(), contexts: z.array(listEntrySchema).max(MAX_CONTEXTS).optional(), released: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  const require = (keys) => { for (const key of keys) if (value[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: "Required for this view" }); };
  if (["capture", "image"].includes(value.view) || (value.view === "read" && value.section === "summary")) require(Object.keys(summaryFields));
  if (value.view === "read") { require(["contextId", "capturedAt", "section", "static", "warnings"]); if (value.section !== "summary") require(["offset", "total", "entries", "sectionCoverage", "sectionTruncated"]); }
  if (value.view === "capture" && value.counts?.remotes === undefined) ctx.addIssue({ code: "custom", path: ["counts", "remotes"], message: "Required for capture" });
  if (value.section === "remotes" && value.entries) for (const [index, entry] of value.entries.entries()) {
    if (!remoteEntrySchema.safeParse(entry).success) ctx.addIssue({ code: "custom", path: ["entries", index], message: "Remote identity metadata required" });
  }
  if (value.view === "image") require(["kind"]);
  if (value.view === "list") require(["contexts", "static", "warnings"]);
  if (value.view === "release") require(["contextId", "released"]);
});

const indexEntrySchema = z.object({ contextId: contextIdSchema, capturedAt: z.string().datetime(), bytes: z.number().int().positive().max(MAX_CONTEXT_BYTES), sha256: z.string().regex(HASH) }).strict();
const indexSchema = z.object({ schema: z.literal(1), owner: z.string().regex(HASH), contexts: z.array(indexEntrySchema).max(MAX_CONTEXTS) }).strict();
const recordSchema = z.object({ schema: z.literal(1), owner: z.string().regex(HASH), summary: summarySchema, scene: z.union([legacyCaptureSceneSchema, captureSceneSchema]) }).strict();

function parse(schema, value, code = "INVALID_INPUT") {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(code, code === "INVALID_INPUT" ? "Game context arguments do not match the selected view or bounds" : "Game context data is invalid or exceeds its bounds");
  return result.data;
}
function argsFor(view, args = {}) {
  if (args.view !== undefined && args.view !== view) throw fail("INVALID_INPUT", "Game context view does not match the service method");
  return parse(gameContextInputSchema, { ...args, view });
}
function randomHex(randomBytes) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw fail("STORAGE", "Context identifier source is unavailable");
  return Buffer.from(bytes).toString("hex");
}
function jsonBytes(value, max = MAX_CONTEXT_BYTES) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > max) throw fail("INVALID_DATA", "Game context data exceeds the byte limit");
  return bytes;
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw fail("STORAGE", "Stored game context is not valid UTF-8 JSON"); }
}
function freezeDto(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeDto(item);
    Object.freeze(value);
  }
  return value;
}
function cancellable(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(fail("CANCELLED", "Game context capture was cancelled"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw fail("CANCELLED", "Game context capture was cancelled");
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
function normalizeFacet(facet, requested, budget, kind) {
  if (!requested) return { metadata: { status: "not-requested", reason: "not-requested" } };
  if (!facet || facet.status !== "available") {
    const reason = typeof facet?.reason === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(facet.reason) ? facet.reason : "image-provider-unavailable";
    return { metadata: { status: "unavailable", reason } };
  }
  const { data } = facet;
  if (!Buffer.isBuffer(data) || data.length < 4 || data.length > budget || data.length > MAX_IMAGE_BYTES || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) return { metadata: { status: "unavailable", reason: "invalid-or-over-budget-image" } };
  const value = { status: "available", mimeType: facet.mimeType, width: facet.width, height: facet.height, bytes: data.length, sha256: hash(data), provider: facet.provider, ...(facet.target === undefined ? {} : { target: facet.target }) };
  const valid = facetSchema.safeParse(value);
  if (!valid.success || (kind === "screenshot" && !valid.data.target)) return { metadata: { status: "unavailable", reason: "invalid-image-metadata" } };
  return { metadata: valid.data, data: Buffer.from(data) };
}
function compactSummary(summary) {
  return { contextId: summary.contextId, capturedAt: summary.capturedAt, client: summary.client, place: { placeId: summary.place.placeId }, coverage: summary.coverage, counts: summary.counts, images: { screenshot: summary.images.screenshot.status, map: summary.images.map.status }, partial: summary.partial, static: true };
}

class GameContextService {
  constructor({ configFile, images, clock = Date, randomBytes = nodeRandomBytes } = {}) {
    this.store = createContextStore({ configFile, namespace: "game-contexts", errorPrefix: "GAME_CONTEXT_", clock, randomBytes });
    this.configFile = this.store.configFile;
    this.images = images ?? createGameContextImages();
    this.clock = clock;
    this.randomBytes = randomBytes;
    this.active = null;
    this.closed = false;
  }
  async catalog(state) {
    let bytes;
    try { ({ bytes } = await this.store.readBytes(state, state.directory, "index.json", 16384)); }
    catch (error) { if (error.code === "ENOENT") return { schema: 1, owner: state.owner, contexts: [] }; throw error; }
    const value = parse(indexSchema, parseJson(bytes), "STORAGE");
    if (value.owner !== state.owner || new Set(value.contexts.map((entry) => entry.contextId)).size !== value.contexts.length || value.contexts.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_TOTAL_BYTES) throw fail("STORAGE", "Stored context catalog ownership or bounds do not match");
    return value;
  }
  async admit(state, catalog) {
    const expected = new Set(["index.json", ".writer.lock", ...catalog.contexts.map((entry) => entry.contextId)]);
    const names = await this.store.namesIn(state, state.directory, MAX_CONTEXTS + 3);
    if (names.some((name) => !expected.has(name))) {
      throw fail("STORAGE", "Context namespace contains unowned or interrupted data; refusing additional writes");
    }
  }
  async record(state, entry) {
    const directory = await this.store.inspect(resolve(state.directory.path, entry.contextId));
    const { bytes } = await this.store.readBytes(state, directory, "context.json", MAX_CONTEXT_BYTES, entry.sha256);
    const record = parse(recordSchema, parseJson(bytes), "STORAGE");
    const imageBytes = Object.values(record.summary.images).reduce((sum, facet) => sum + (facet.status === "available" ? facet.bytes : 0), 0);
    if (record.owner !== state.owner || record.summary.contextId !== entry.contextId || record.summary.capturedAt !== entry.capturedAt || bytes.length + imageBytes !== entry.bytes || record.summary.counts.parts !== record.scene.parts.length || record.summary.counts.ui !== record.scene.ui.entries.length || record.summary.counts.remotes !== record.scene.remotes?.entries.length) throw fail("STORAGE", "Stored context ownership, counts, or byte bounds do not match");
    return { directory, record, sha256: entry.sha256 };
  }
  async selected(contextId) {
    const state = await this.store.state();
    if (!state) throw fail("NOT_FOUND", "Shared game context was not found");
    const catalog = await this.catalog(state);
    const entry = catalog.contexts.find((value) => value.contextId === contextId);
    if (!entry) throw fail("NOT_FOUND", "Shared game context was not found");
    return { state, catalog, entry, ...await this.record(state, entry) };
  }
  async source(contextId) {
    const id = parse(contextIdSchema, contextId);
    return this.store.storage(async () => {
      const { entry, record } = await this.selected(id);
      const { capturedAt, client, place, root, coverage, truncated } = record.summary;
      return freezeDto({ contextId: id, capturedAt, client, place, root, coverage, truncated, sha256: entry.sha256, scene: record.scene });
    });
  }
  async ownedFiles(state, directory, record, sha256) {
    if (typeof sha256 !== "string" || !HASH.test(sha256)) throw fail("STORAGE", "Context ownership requires the original stored content digest");
    const expected = ["context.json", ...["screenshot", "map"].filter((kind) => record.summary.images[kind].status === "available").map((kind) => `${kind}.jpg`)];
    const names = await this.store.namesIn(state, directory, 4);
    if (names.length !== expected.length || names.some((name) => !expected.includes(name))) throw fail("STORAGE", "Context directory contains unowned files; refusing deletion");
    const files = [];
    for (const name of expected) {
      const digest = name === "context.json" ? sha256 : record.summary.images[name.slice(0, -4)].sha256;
      files.push((await this.store.readBytes(state, directory, name, MAX_CONTEXT_BYTES, digest)).entry);
    }
    // Verify every file before deleting any; never recursively remove a tree.
    await this.store.assertState(state, [directory, ...files]);
    return files;
  }
  async removeContext(state, directory, record, sha256) {
    const files = await this.ownedFiles(state, directory, record, sha256);
    for (const file of files.reverse()) await this.store.removeFile(state, directory, file);
    await this.store.assertState(state, [directory]);
    await rmdir(directory.path);
  }
  async capture(args = {}, options = {}) {
    const input = argsFor("capture", args);
    if (this.closed) throw fail("CANCELLED", "Game context service is closed");
    const captureKey = this.configFile && canonical(this.configFile);
    if (this.active || (captureKey && activeCaptures.has(captureKey))) throw fail("BUSY", "A game context capture is already in progress; no queue is used");
    const client = parse(clientSchema, options.client);
    if (typeof options.isCurrent !== "function" || typeof options.collect !== "function" || !Number.isSafeInteger(options.clientCount) || options.clientCount < 1 || !Number.isSafeInteger(options.imageBudget) || options.imageBudget < 0) throw fail("INVALID_INPUT", "Capture requires an explicit current client, collector, client count, and byte budget");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.active = controller;
    if (captureKey) activeCaptures.add(captureKey);
    const fence = () => {
      if (controller.signal.aborted || this.closed) throw fail("CANCELLED", "Game context capture was cancelled");
      if (!options.isCurrent()) { controller.abort(); throw fail("CLIENT_CHANGED", "Selected client or bootstrap generation changed during capture"); }
    };
    let unlock, state, staged, stagedFiles = [], publishedDirectory, publishedRecord, publishedHash, committed = false;
    try {
      fence();
      state = await this.store.storage(() => this.store.state(true));
      unlock = await this.store.storage(() => this.store.lock(state));
      fence();
      const catalog = await this.store.storage(() => this.catalog(state));
      await this.store.storage(() => this.admit(state, catalog));
      const params = { root: input.root ?? "workspace", maxVisited: input.maxVisited ?? 2500, maxParts: input.maxParts ?? 200, uiLimit: input.uiLimit ?? 20, remoteLimit: input.remoteLimit ?? 50, _maxResultBytes: MAX_SCENE_BYTES };
      const collected = await cancellable(() => options.collect(params), controller.signal);
      fence();
      const scene = freezeDto(parse(captureSceneSchema, collected, "INVALID_DATA"));
      if (scene.visited > params.maxVisited || scene.parts.length > params.maxParts || scene.ui.entries.length > params.uiLimit || scene.remotes.entries.length > params.remoteLimit || (scene.coverage === "complete" && scene.truncated) || (scene.ui.coverage === "complete" && scene.ui.truncated) || (scene.remotes.coverage === "complete" && scene.remotes.truncated)) throw fail("INVALID_DATA", "Collected game context contradicts its requested bounds or coverage");
      if (params.remoteLimit === 0 && (scene.remotes.coverage !== "partial" || !scene.remotes.truncated || !scene.stopReasons.includes("remotes-excluded"))) throw fail("INVALID_DATA", "Excluded remote metadata requires explicit partial coverage and stop reason");
      const coverage = scene.facetCoverage;
      if (Object.values(coverage).reduce((sum, facet) => sum + facet.visited, 0) !== scene.visited
        || coverage.geometry.visited < scene.parts.length || coverage.ui.visited < scene.ui.entries.length || coverage.remotes.visited < scene.remotes.entries.length
        || coverage.ui.coverage !== scene.ui.coverage || coverage.ui.truncated !== scene.ui.truncated
        || coverage.remotes.coverage !== scene.remotes.coverage || coverage.remotes.truncated !== scene.remotes.truncated
        || Object.values(coverage).some((facet) => facet.coverage === "complete" && facet.truncated)
        || (scene.coverage === "complete" && Object.values(coverage).some((facet) => facet.coverage !== "complete"))) throw fail("INVALID_DATA", "Collected facet coverage contradicts its aggregate bounds or metadata");
      jsonBytes(scene, MAX_SCENE_BYTES);
      const time = this.clock.now();
      if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) throw fail("INVALID_DATA", "Capture clock returned an invalid timestamp");
      const capturedAt = new Date(time).toISOString();
      const requested = { screenshot: input.screenshot ?? true, map: input.map ?? true };
      const budget = Math.min(options.imageBudget, MAX_IMAGE_BYTES);
      let rendered;
      try { rendered = await cancellable(() => this.images.render({ scene, screenshot: requested.screenshot && options.clientCount === 1, map: requested.map, maxBytes: budget, signal: controller.signal }), controller.signal); }
      catch { rendered = { screenshot: { status: "unavailable", reason: "image-provider-failed" }, map: { status: "unavailable", reason: "image-provider-failed" } }; }
      fence();
      const facets = Object.fromEntries(["screenshot", "map"].map((kind) => [kind, normalizeFacet(rendered?.[kind], requested[kind], budget, kind)]));
      if (requested.screenshot && options.clientCount !== 1) facets.screenshot = { metadata: { status: "unavailable", reason: "requires-exactly-one-authenticated-client" } };
      const contextId = `gc-${randomHex(this.randomBytes)}`;
      const summary = parse(summarySchema, {
        contextId, capturedAt, client, place: scene.place, player: scene.player, root: scene.root, coverage: scene.coverage, truncated: scene.truncated,
        visited: scene.visited, stopReasons: scene.stopReasons, counts: { parts: scene.parts.length, ui: scene.ui.entries.length, remotes: scene.remotes.entries.length },
        images: { screenshot: facets.screenshot.metadata, map: facets.map.metadata },
        partial: scene.coverage === "partial" || scene.ui.coverage === "partial" || scene.remotes.coverage === "partial" || Object.values(facets).some((facet) => facet.metadata.status === "unavailable"),
        static: true, atomicSnapshot: false, warnings: [STATIC_WARNING, GEOMETRY_WARNING],
      }, "INVALID_DATA");
      publishedRecord = { schema: 1, owner: state.owner, summary, scene };
      const content = jsonBytes(publishedRecord);
      publishedHash = hash(content);
      const bytes = content.length + Object.values(facets).reduce((sum, facet) => sum + (facet.data?.length ?? 0), 0);
      if (bytes > MAX_CONTEXT_BYTES) throw fail("INVALID_DATA", "Captured game context exceeds 2 MiB");
      await this.store.storage(async () => {
        fence();
        const finalPath = resolve(state.directory.path, contextId);
        try { await lstat(finalPath); throw fail("STORAGE", "Context identifier collision; existing data was preserved"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const stagePath = resolve(state.directory.path, `.stage-${randomHex(this.randomBytes)}`);
        await this.store.assertState(state);
        await mkdir(stagePath, { mode: 0o700 });
        staged = await this.store.inspect(stagePath);
        await this.store.assertState(state, [staged]);
        await this.store.restrictTokenAcl(stagePath);
        await this.store.assertState(state, [staged]);
        for (const kind of ["screenshot", "map"]) if (facets[kind].data) stagedFiles.push(await this.store.writeBytes(state, staged, `${kind}.jpg`, facets[kind].data));
        stagedFiles.push(await this.store.writeBytes(state, staged, "context.json", content));
        await this.store.assertState(state, [staged, ...stagedFiles]);
        fence();
        await rename(stagePath, finalPath);
        publishedDirectory = { path: finalPath, info: staged.info };
        staged = null;
        await this.store.assertState(state, [publishedDirectory]);
        const next = [...catalog.contexts, { contextId, capturedAt, bytes, sha256: publishedHash }].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.contextId.localeCompare(b.contextId));
        const evicted = [];
        while (next.length > MAX_CONTEXTS || next.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_TOTAL_BYTES) {
          const at = next.findIndex((entry) => entry.contextId !== contextId);
          evicted.push(...next.splice(at, 1));
        }
        // Read and validate eviction ownership before committing anything.
        const removed = [];
        for (const entry of evicted) {
          const old = await this.record(state, entry);
          await this.ownedFiles(state, old.directory, old.record, old.sha256);
          removed.push(old);
        }
        await this.store.publishIndex(state, { schema: 1, owner: state.owner, contexts: next }, fence);
        committed = true;
        for (const old of removed) await this.removeContext(state, old.directory, old.record, old.sha256).catch(() => {});
      });
      return parse(gameContextOutputSchema, { view: "capture", ...summary }, "INVALID_DATA");
    } finally {
      if (state && !committed) {
        if (publishedDirectory && publishedRecord) await this.removeContext(state, publishedDirectory, publishedRecord, publishedHash).catch(() => {});
        if (staged) {
          for (const entry of stagedFiles.reverse()) await this.store.removeFile(state, staged, entry).catch(() => {});
          await this.store.assertState(state, [staged]).then(() => rmdir(staged.path)).catch(() => {});
        }
      }
      if (unlock) await unlock().catch(() => {});
      options.signal?.removeEventListener("abort", onAbort);
      if (this.active === controller) this.active = null;
      if (captureKey) activeCaptures.delete(captureKey);
    }
  }
  async list() {
    return this.store.storage(async () => {
      const state = await this.store.state();
      const contexts = [];
      if (state) {
        const catalog = await this.catalog(state);
        for (const entry of [...catalog.contexts].reverse()) contexts.push(compactSummary((await this.record(state, entry)).record.summary));
      }
      return parse(gameContextOutputSchema, { view: "list", contexts, static: true, warnings: [STATIC_WARNING] }, "STORAGE");
    });
  }
  async read(args) {
    const input = argsFor("read", args);
    return this.store.storage(async () => {
      const { record } = await this.selected(input.contextId);
      const section = input.section ?? "summary";
      if (section === "summary") return parse(gameContextOutputSchema, { view: "read", ...record.summary, section }, "STORAGE");
      if (section === "remotes" && !record.scene.remotes) throw fail("SECTION_UNAVAILABLE", "Remote metadata was not captured in this saved context", { contextId: input.contextId, section, reason: "not-captured" });
      const facet = section === "parts" ? (record.scene.facetCoverage?.geometry ?? record.scene) : record.scene[section];
      const values = section === "parts" ? record.scene.parts : facet.entries;
      const offset = input.offset ?? 0;
      const result = { view: "read", contextId: input.contextId, capturedAt: record.summary.capturedAt, section, offset, total: values.length, entries: [], sectionCoverage: facet.coverage, sectionTruncated: facet.truncated, static: true, warnings: [STATIC_WARNING] };
      if (section === "remotes") result.root = facet.root;
      let used = Buffer.byteLength(JSON.stringify(result)) + 64;
      for (let at = offset; at < Math.min(values.length, offset + (input.limit ?? 20)); at += 1) {
        const entry = section === "parts" ? basicPart(values[at]) : values[at];
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
        // One escaped-text-heavy row can exceed the usual page budget. Return it
        // alone (still bounded by the 32 KiB scene) so host result retention can
        // expose it, rather than issuing a non-advancing pagination cursor.
        if (used + bytes > PAGE_BYTES && result.entries.length > 0) break;
        result.entries.push(entry); used += bytes;
      }
      if (offset + result.entries.length < values.length) result.nextOffset = offset + result.entries.length;
      return parse(gameContextOutputSchema, result, "STORAGE");
    });
  }
  async image(args) {
    const input = argsFor("image", args);
    return this.store.storage(async () => {
      const { state, directory, record } = await this.selected(input.contextId);
      const facet = record.summary.images[input.kind];
      if (facet.status !== "available") throw fail("IMAGE_UNAVAILABLE", "The saved context has no available image of this kind; structured data remains readable", { contextId: input.contextId, kind: input.kind, reason: facet.reason });
      const { bytes } = await this.store.readBytes(state, directory, `${input.kind}.jpg`, facet.bytes, facet.sha256);
      if (bytes.length !== facet.bytes) throw fail("STORAGE", "Stored image byte count does not match");
      return { metadata: parse(gameContextOutputSchema, { view: "image", ...record.summary, kind: input.kind }, "STORAGE"), image: { data: bytes, mimeType: "image/jpeg", width: facet.width, height: facet.height } };
    });
  }
  async release(args) {
    const input = argsFor("release", args);
    return this.store.storage(async () => {
      const state = await this.store.state();
      const result = { view: "release", contextId: input.contextId, released: false };
      if (!state) return result;
      const unlock = await this.store.lock(state);
      try {
        const catalog = await this.catalog(state);
        const entry = catalog.contexts.find((value) => value.contextId === input.contextId);
        if (!entry) return result;
        const value = await this.record(state, entry);
        await this.ownedFiles(state, value.directory, value.record, value.sha256);
        await this.store.publishIndex(state, { ...catalog, contexts: catalog.contexts.filter((item) => item.contextId !== input.contextId) });
        await this.removeContext(state, value.directory, value.record, value.sha256).catch(() => {});
        return { ...result, released: true };
      } finally { await unlock().catch(() => {}); }
    });
  }
  close() {
    this.closed = true;
    this.active?.abort();
  }
}

export function createGameContextService(options) {
  return new GameContextService(options);
}
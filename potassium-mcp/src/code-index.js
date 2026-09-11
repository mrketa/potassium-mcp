import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";
import { parseSourcePackage } from "./parser-process.js";

export const CODE_INDEX_LIMITS = Object.freeze({ maxModules: 32, maxFileBytes: 256 * 1024, maxPackageBytes: 4 * 1024 * 1024, maxIndexes: 4, maxSourceBytes: 8 * 1024 * 1024, maxMetadataBytes: 8 * 1024 * 1024, ttlMs: 600000, maxPending: 4 });
const factKinds = ["functions", "calls", "dependencies", "bindings"];
const remoteMethods = new Set(["FireServer", "InvokeServer", "FireClient", "FireAllClients", "InvokeClient"]);
const remoteQueryLimits = Object.freeze({ maxRows: 50, maxReceiverDepth: 8, maxReceiverNodes: 32, retainedNameTruncationAt: 128 });
const receiverReasons = new Set(["captured-upvalue", "global-or-unbound", "environment-effect", "dynamic-member", "logical-hierarchy-boundary", "member-identity-unverified", "return-derived", "varargs", "table-members-not-resolved", "branch-merge", "loop-merge", "multiple-return", "possible-captured-write", "computed-expression", "unsupported-expression", "interpolated-string", "parameter", "update-assignment", "member-write", "origin-depth", "missing-binding"]);
const remoteQueryLimitations = Object.freeze(["supplied-index-only", "no-live-instance-correlation", "name-collisions-possible", "dynamic-and-captured-receivers-may-not-match", "collapsed-or-truncated-alias-names-may-not-match", "member-mutation-not-tracked", "static-expression-counts-not-runtime-arity"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function error(code, message) { return Object.assign(new Error(message), { code }); }
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw error("CODE_INVALID_INPUT", `${label} is outside its allowed range`);
  return value;
}
function text(value, maximum, label, empty = false) {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > maximum || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) throw error("CODE_INVALID_INPUT", `${label} is invalid`);
  return value;
}
function logicalPath(value) {
  text(value, 512, "logicalPath");
  if (/[\\:]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw error("CODE_INVALID_INPUT", "Logical hierarchy path is invalid");
  return value;
}
function abort(signal, lease) {
  if (signal?.aborted || lease?.cancelled) throw error("CODE_CANCELLED", "Code indexing was cancelled");
}
const canonical = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const sameIdentity = (left, right) => typeof left.ino === "bigint" && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
const sameVersion = (left, right) => sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

async function readSourceFile(module, config, io, signal) {
  const roots = config.sourceRoots ?? [];
  const root = roots.find((entry) => entry.name === module.root);
  if (!root) throw error("CODE_SOURCE_DENIED", "Source root is not configured");
  const requested = text(module.path, 1024, "path");
  const components = requested.split(/[\\/]/);
  if (isAbsolute(requested) || requested.includes(":") || components.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw error("CODE_SOURCE_DENIED", "Source path is not an explicit relative file");
  const extension = extname(requested).toLowerCase();
  if (![".lua", ".luau"].includes(extension) || !(root.extensions ?? [".lua", ".luau"]).includes(extension) || (!root.recursive && components.length !== 1)) throw error("CODE_SOURCE_DENIED", "Source file selection is not allowed by its root");
  if (typeof root.path !== "string" || !isAbsolute(root.path)) throw error("CODE_SOURCE_DENIED", "Source root path is invalid");
  const rootPath = resolve(root.path);
  const target = resolve(rootPath, requested);
  const relation = relative(rootPath, target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw error("CODE_SOURCE_DENIED", "Source path escapes its root");
  const inspect = async (value) => {
    abort(signal);
    const info = await (io.lstat ?? lstat)(value, { bigint: true });
    if (info.isSymbolicLink() || info.ino === 0n || canonical(await (io.realpath ?? realpath)(value)) !== canonical(value)) throw error("CODE_SOURCE_IDENTITY", "Source path redirects through a link or reparse point");
    return info;
  };
  let file;
  try {
    // Snapshot every component, including configured-root ancestors, to reject junction
    // redirection and detect substitutions around the opened handle's identity checks.
    const ancestry = [];
    const volume = parsePath(target).root;
    let current = volume;
    for (const component of relative(volume, target).split(sep)) {
      current = resolve(current, component);
      const info = await inspect(current);
      if (canonical(current) !== canonical(target) && !info.isDirectory()) throw error("CODE_SOURCE_IDENTITY", "Source ancestor is not a directory");
      ancestry.push({ path: current, info });
    }
    const expected = ancestry.at(-1).info;
    if (!expected.isFile()) throw error("CODE_SOURCE_DENIED", "Source path is not a regular file");
    if (expected.size > BigInt(CODE_INDEX_LIMITS.maxFileBytes)) throw error("CODE_SOURCE_TOO_LARGE", "Source file exceeds the byte limit");
    file = await (io.open ?? open)(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || !sameVersion(expected, opened)) throw error("CODE_SOURCE_IDENTITY", "Source identity changed before reading");
    const verify = async () => {
      for (const entry of ancestry) {
        const observed = await inspect(entry.path);
        if (!(canonical(entry.path) === canonical(target) ? sameVersion(entry.info, observed) : sameIdentity(entry.info, observed))) throw error("CODE_SOURCE_IDENTITY", "Source identity changed during reading");
      }
      if (!sameVersion(opened, await file.stat({ bigint: true }))) throw error("CODE_SOURCE_IDENTITY", "Opened source changed during reading");
    };
    await verify();
    const buffer = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      abort(signal);
      const result = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) throw error("CODE_SOURCE_IDENTITY", "Source size changed during reading");
      offset += result.bytesRead;
    }
    await verify();
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { throw error("CODE_INVALID_INPUT", "Source file is not UTF-8 text"); }
  } catch (cause) {
    if (cause?.code?.startsWith("CODE_")) throw cause;
    throw error("CODE_SOURCE_UNAVAILABLE", "Source file or identity is unavailable");
  } finally {
    if (file) await file.close();
  }
}

function displaySource(source, spans, token) {
  if (!Array.isArray(spans)) return null;
  let output = "";
  let offset = 0;
  for (const span of spans) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < offset || span.end <= span.start || span.end > source.length || !["string", "number", "comment"].includes(span.kind)) throw error("CODE_PARSE_RESULT_INVALID", "Parser redaction span is invalid");
    output += source.slice(offset, span.start) + `[${span.kind}]`;
    for (let at = source.indexOf("\n", span.start); at >= 0 && at < span.end; at = source.indexOf("\n", at + 1)) output += "\n";
    offset = span.end;
  }
  output += source.slice(offset);
  return token ? output.replaceAll(token, "[REDACTED]") : output;
}

function normalizeAnalysis(parsed, modules, token) {
  let json;
  try { json = JSON.stringify(parsed); }
  catch { throw error("CODE_PARSE_RESULT_INVALID", "Parser result is not JSON"); }
  if (!json || Buffer.byteLength(json) > CODE_INDEX_LIMITS.maxMetadataBytes) throw error("CODE_PARSE_RESULT_INVALID", "Parser result exceeds the metadata limit");
  const result = JSON.parse(json);
  if (!result.parser || typeof result.parser !== "object" || !Array.isArray(result.files) || result.files.length !== modules.length || !result.facts || !Array.isArray(result.diagnostics) || result.diagnostics.length > 256 || typeof result.truncated !== "boolean" || !result.budgets) throw error("CODE_PARSE_RESULT_INVALID", "Parser result shape is invalid");
  const moduleMap = new Map(modules.map((module) => [module.id, module]));
  const factIds = new Set();
  let factCount = 0;
  for (const kind of factKinds) {
    if (!Array.isArray(result.facts[kind])) throw error("CODE_PARSE_RESULT_INVALID", "Parser fact collection is invalid");
    factCount += result.facts[kind].length;
    for (const fact of result.facts[kind]) {
      const module = moduleMap.get(fact.moduleId);
      if (!module || typeof fact.id !== "string" || fact.id.length > 128 || factIds.has(fact.id) || fact.sha256 !== module.sha256 || !fact.span
        || !Number.isSafeInteger(fact.span.start?.offset) || !Number.isSafeInteger(fact.span.end?.offset) || fact.span.start.offset < 0 || fact.span.end.offset > module.source.length || fact.span.start.offset > fact.span.end.offset) throw error("CODE_PARSE_RESULT_INVALID", "Parser fact identity or span is invalid");
      factIds.add(fact.id);
    }
  }
  if (factCount > 12000) throw error("CODE_PARSE_RESULT_INVALID", "Parser fact limit exceeded");
  const sources = new Map();
  for (let index = 0; index < result.files.length; index += 1) {
    const file = result.files[index];
    const module = modules[index];
    if (file.id !== module.id || file.sha256 !== module.sha256 || file.logicalPath !== module.logicalPath) throw error("CODE_PARSE_RESULT_INVALID", "Parser file identity does not match its supplied source");
    sources.set(module.id, displaySource(module.source, file.redactions, token));
    delete file.redactions;
  }
  // All displayed parser strings are redacted before retention; credentials never go
  // to the parser process and are not needed by subsequent retained queries.
  if (token) {
    const stack = [result];
    const displayFields = new Set(["snippet", "name", "callee", "method", "member", "parameter", "message"]);
    while (stack.length) {
      const value = stack.pop();
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string" && displayFields.has(key)) value[key] = child.replaceAll(token, "[REDACTED]");
        else if (key === "parameters" && Array.isArray(child)) value[key] = child.map((parameter) => typeof parameter === "string" ? parameter.replaceAll(token, "[REDACTED]") : parameter);
        else if (child && typeof child === "object") stack.push(child);
      }
    }
  }
  return { result, sources };
}

function remoteCallsite(call, remote, bindings, includeRow) {
  const method = call.method ?? call.callee;
  if (!remoteMethods.has(method)) return null;
  const callee = call.calleeOrigin;
  let receiver;
  if (callee?.kind === "logical-instance" && typeof callee.logicalPath === "string" && callee.logicalPath.endsWith(`/${method}`)) {
    receiver = { kind: "logical-instance", logicalPath: callee.logicalPath.slice(0, -method.length - 1) };
  } else if (callee?.kind === "member" && callee.member === method) receiver = callee.receiver;
  else return null;

  const names = new Set();
  const uncertainty = new Set(["receiver-identity-unverified", "runtime-arity-unverified"]);
  const seen = new Set();
  let path;
  let visited = 0;
  let truncated = false;
  function name(value) {
    if (typeof value !== "string") return;
    if (value.includes("[REDACTED]")) { uncertainty.add("receiver-name-redacted"); return; }
    // Retained identifiers are silently shortened by the parser. A shortened
    // prefix is not evidence of an exact receiver-name match.
    if (value.length >= remoteQueryLimits.retainedNameTruncationAt) {
      uncertainty.add("receiver-name-truncated");
      truncated = true;
    } else names.add(value);
  }
  function resolveReceiver(origin, depth, collectNames) {
    if (++visited > remoteQueryLimits.maxReceiverNodes || depth >= remoteQueryLimits.maxReceiverDepth) {
      uncertainty.add("receiver-resolution-limit");
      truncated = true;
      return;
    }
    if (!origin || typeof origin !== "object") { uncertainty.add("missing-origin"); return; }
    if (origin.kind === "logical-instance") {
      if (collectNames && typeof origin.logicalPath === "string") {
        path = origin.logicalPath;
        names.add(path.slice(path.lastIndexOf("/") + 1));
      }
    } else if (origin.kind === "binding") {
      if (collectNames) name(origin.name);
      if (seen.has(origin.bindingId)) { uncertainty.add("binding-cycle"); return; }
      seen.add(origin.bindingId);
      const binding = bindings.get(origin.bindingId);
      if (!binding || binding.moduleId !== call.moduleId || binding.sha256 !== call.sha256) { uncertainty.add("missing-binding"); return; }
      resolveReceiver(binding.origin, depth + 1, collectNames);
    } else if (origin.kind === "member") {
      if (collectNames) name(origin.member);
      uncertainty.add("member-identity-unverified");
      // Enclosing member names are not names of the selected receiver.
      resolveReceiver(origin.receiver, depth + 1, false);
    } else {
      if (collectNames) name(origin.name);
      uncertainty.add(receiverReasons.has(origin.reason) ? origin.reason : "unresolved-origin");
      // In particular, never chase a captured bindingId, previous assignment,
      // or return-derived callsiteId into a more certain receiver identity.
    }
  }
  resolveReceiver(receiver, 0, true);
  const pathMatch = remote.logicalPath !== undefined && path === remote.logicalPath;
  const nameMatch = remote.name !== undefined && names.has(remote.name);
  if ((remote.logicalPath !== undefined && !pathMatch) || (remote.name !== undefined && !nameMatch)) return { truncated };
  if (!includeRow) return { matched: true, truncated };
  if (!pathMatch) uncertainty.add("receiver-name-collision");
  if (call.argumentsTruncated) uncertainty.add("argument-list-truncated");
  return {
    matched: true, truncated,
    row: {
      callsiteId: call.id, moduleId: call.moduleId, sha256: call.sha256, span: call.span, method,
      matchKind: pathMatch ? "static-logical-path" : "receiver-name-heuristic",
      confidence: pathMatch ? "inferred" : "heuristic", receiverIdentity: "unverified",
      argumentExpressionCount: call.argumentCount, argumentsTruncated: call.argumentsTruncated,
      uncertainty: [...uncertainty], snippet: call.snippet.slice(0, 160),
    },
  };
}

/** Memory-only source analysis, scoped like retained results and independent of any executor. */
export function createCodeIndexService({ parse = parseSourcePackage, clock = Date, randomBytes = nodeRandomBytes, io = {}, maxIndexes = CODE_INDEX_LIMITS.maxIndexes, maxSourceBytes = CODE_INDEX_LIMITS.maxSourceBytes, maxMetadataBytes = CODE_INDEX_LIMITS.maxMetadataBytes, ttlMs = CODE_INDEX_LIMITS.ttlMs } = {}) {
  integer(maxIndexes, 1, CODE_INDEX_LIMITS.maxIndexes, "maxIndexes");
  integer(maxSourceBytes, 1, CODE_INDEX_LIMITS.maxSourceBytes, "maxSourceBytes");
  integer(maxMetadataBytes, 1, CODE_INDEX_LIMITS.maxMetadataBytes, "maxMetadataBytes");
  integer(ttlMs, 1, CODE_INDEX_LIMITS.ttlMs, "ttlMs");
  if (typeof parse !== "function" || typeof clock?.now !== "function" || typeof randomBytes !== "function") throw error("CODE_INVALID_INPUT", "Index dependencies are invalid");
  const records = new Map();
  const pending = new Set();
  const cursorSecret = randomBytes(32);
  if (!(cursorSecret instanceof Uint8Array) || cursorSecret.byteLength !== 32) throw error("CODE_STORE_UNAVAILABLE", "Index random source returned invalid bytes");
  let sourceBytes = 0;
  let metadataBytes = 0;
  const now = () => {
    const time = clock.now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000 - ttlMs) throw error("CODE_STORE_UNAVAILABLE", "Index clock returned an invalid time");
    return time;
  };
  const remove = (id, record) => { records.delete(id); sourceBytes -= record.sourceBytes; metadataBytes -= record.metadataBytes; };
  const sweep = (time) => { for (const [id, record] of records) if (record.expiresAt <= time) remove(id, record); };
  const mac = (value) => createHmac("sha256", cursorSecret).update(value).digest("base64url");
  function cursor(indexId, selection, offset) { const body = Buffer.from(JSON.stringify([indexId, selection, offset])).toString("base64url"); return `${body}.${mac(body)}`; }
  function cursorOffset(value, indexId, selection) {
    if (value === undefined) return 0;
    text(value, 512, "cursor");
    const [body, signature, extra] = value.split(".");
    const expected = mac(body);
    if (extra !== undefined || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw error("CODE_INVALID_CURSOR", "Index cursor is invalid");
    let decoded;
    try { decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw error("CODE_INVALID_CURSOR", "Index cursor is invalid"); }
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== indexId || decoded[1] !== selection || !Number.isSafeInteger(decoded[2]) || decoded[2] < 0) throw error("CODE_INVALID_CURSOR", "Index cursor belongs to another selection");
    return decoded[2];
  }
  function summary(record) {
    return { indexId: record.indexId, digest: record.digest, parser: record.result.parser, provenance: record.provenance, files: record.result.files, counts: Object.fromEntries(factKinds.map((kind) => [kind, record.result.facts[kind].length])), diagnostics: record.result.diagnostics.slice(0, 20), diagnosticsTotal: record.result.diagnostics.length, diagnosticsTruncated: record.result.diagnostics.length > 20, completeness: { syntax: record.result.files.every((file) => !file.parseErrors), bounded: !record.result.truncated, semantic: "conservative", execution: "not-executed" }, expiresAt: new Date(record.expiresAt).toISOString() };
  }
  return {
    async index({ scopeId, modules, provenance }, config = {}, { signal } = {}) {
      text(scopeId, 256, "scopeId");
      if (provenance !== undefined) text(provenance, 128, "provenance", true);
      if (!Array.isArray(modules) || modules.length < 1 || modules.length > CODE_INDEX_LIMITS.maxModules) throw error("CODE_INVALID_INPUT", "Index requires between 1 and 32 explicit modules");
      if (pending.size >= CODE_INDEX_LIMITS.maxPending) throw error("CODE_STORE_CAPACITY", "Code index intake capacity is occupied");
      const lease = { scopeId, cancelled: false };
      pending.add(lease);
      try {
        const normalized = [];
        const ids = new Set();
        const paths = new Set();
        let bytes = 0;
        for (const module of modules) {
          abort(signal, lease);
          if (!module || typeof module !== "object" || Array.isArray(module)) throw error("CODE_INVALID_INPUT", "Module selection is invalid");
          const id = text(module.id, 128, "module id");
          const hierarchy = logicalPath(module.logicalPath ?? id);
          if (ids.has(id) || paths.has(hierarchy)) throw error("CODE_INVALID_INPUT", "Module identities and logical paths must be unique");
          ids.add(id); paths.add(hierarchy);
          const inline = Object.hasOwn(module, "source");
          if (inline ? typeof module.source !== "string" || module.root !== undefined || module.path !== undefined : typeof module.root !== "string" || typeof module.path !== "string") throw error("CODE_INVALID_INPUT", "Module must select inline source or one configured source file");
          const source = inline ? module.source : await readSourceFile(module, config, io, signal);
          if (!source.isWellFormed()) throw error("CODE_INVALID_INPUT", "Module source is not well-formed Unicode");
          const length = Buffer.byteLength(source);
          bytes += length;
          if (length > CODE_INDEX_LIMITS.maxFileBytes || bytes > CODE_INDEX_LIMITS.maxPackageBytes) throw error("CODE_SOURCE_TOO_LARGE", "Source package exceeds its byte limit");
          const hash = sha256(source);
          if (module.sha256 !== undefined && (typeof module.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(module.sha256))) throw error("CODE_INVALID_INPUT", "Source hash must contain 64 hexadecimal characters");
          if (module.sha256 !== undefined && module.sha256.toLowerCase() !== hash) throw error("CODE_HASH_MISMATCH", "Source hash does not match the supplied identity");
          normalized.push({ id, logicalPath: hierarchy, source, sha256: hash });
        }
        abort(signal, lease);
        const parsed = await parse(normalized, { signal });
        abort(signal, lease);
        const { result, sources } = normalizeAnalysis(parsed, normalized, typeof config.token === "string" && config.token.length ? config.token : null);
        const recordMetadataBytes = Buffer.byteLength(JSON.stringify(result));
        const recordSourceBytes = Math.max(bytes, [...sources.values()].reduce((sum, source) => sum + (source === null ? 0 : Buffer.byteLength(source)), 0));
        if (recordMetadataBytes > maxMetadataBytes || recordSourceBytes > maxSourceBytes) throw error("CODE_STORE_CAPACITY", "Index exceeds the retention byte limit");
        const time = now();
        sweep(time);
        let indexId;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const value = randomBytes(16);
          if (!(value instanceof Uint8Array) || value.byteLength !== 16) throw error("CODE_STORE_UNAVAILABLE", "Index random source returned invalid bytes");
          const candidate = Buffer.from(value).toString("hex");
          if (!records.has(candidate)) { indexId = candidate; break; }
        }
        if (!indexId) throw error("CODE_STORE_CAPACITY", "A unique index identifier could not be allocated");
        while (records.size >= maxIndexes || sourceBytes + recordSourceBytes > maxSourceBytes || metadataBytes + recordMetadataBytes > maxMetadataBytes) { const [id, oldest] = records.entries().next().value; remove(id, oldest); }
        const digest = sha256(JSON.stringify({ parser: result.parser, modules: normalized.map(({ id, logicalPath: hierarchy, sha256: hash }) => ({ id, logicalPath: hierarchy, sha256: hash })) }));
        const record = { indexId, scopeId, digest, provenance, result, sources, expiresAt: time + ttlMs, sourceBytes: recordSourceBytes, metadataBytes: recordMetadataBytes };
        records.set(indexId, record); sourceBytes += recordSourceBytes; metadataBytes += recordMetadataBytes;
        return structuredClone(summary(record));
      } finally { pending.delete(lease); }
    },
    query({ scopeId, indexId, view = "summary", moduleId, query, callsiteId, remote, cursor: continuation, limit = 10, depth = 4 }, permissionCallback) {
      text(scopeId, 256, "scopeId");
      if (typeof indexId !== "string" || !/^[a-f0-9]{32}$/.test(indexId)) throw error("CODE_INVALID_INPUT", "Index identifier must contain 32 lowercase hexadecimal characters");
      sweep(now());
      const record = records.get(indexId);
      if (!record || record.scopeId !== scopeId) throw error("CODE_NOT_FOUND", "Index is unavailable, expired, or outside this scope");
      let allowed = false;
      try { allowed = typeof permissionCallback === "function" && permissionCallback("potassium_code_index") === true; } catch {}
      if (!allowed) throw error("CODE_ORIGIN_DENIED", "The originating index tool is no longer permitted");
      if (!["summary", "calls", "functions", "dependencies", "origins", "remote_callsites", "source", "release"].includes(view)) throw error("CODE_INVALID_INPUT", "Code query view is invalid");
      integer(limit, 1, 50, "limit"); integer(depth, 1, 8, "depth");
      if (moduleId !== undefined) { text(moduleId, 128, "moduleId"); if (!record.sources.has(moduleId)) throw error("CODE_INVALID_INPUT", "Module is not in this index"); }
      if (query !== undefined) text(query, 256, "query", true);
      if (callsiteId !== undefined) text(callsiteId, 128, "callsiteId");
      if (view === "remote_callsites") {
        if (!remote || typeof remote !== "object" || Array.isArray(remote) || Object.keys(remote).some((key) => key !== "name" && key !== "logicalPath") || (remote.name === undefined && remote.logicalPath === undefined)) throw error("CODE_INVALID_INPUT", "Remote callsites require an explicit remote selector");
        if (remote.name !== undefined) text(remote.name, 256, "remote name");
        if (remote.logicalPath !== undefined) logicalPath(remote.logicalPath);
        if (query !== undefined || callsiteId !== undefined) throw error("CODE_INVALID_INPUT", "Remote callsites use only explicit remote selectors");
      } else if (remote !== undefined) throw error("CODE_INVALID_INPUT", "Remote selectors require the remote_callsites view");
      if (view === "release") { remove(indexId, record); return { indexId, released: true }; }
      if (view === "summary") return structuredClone(summary(record));
      const selection = sha256(JSON.stringify([view, moduleId ?? null, query ?? null, callsiteId ?? null, depth, remote?.name ?? null, remote?.logicalPath ?? null]));
      const offset = cursorOffset(continuation, indexId, selection);
      let rows;
      let total;
      let pageReady = false;
      let receiverResolutionTruncated = false;
      if (view === "source") {
        if (!moduleId) throw error("CODE_INVALID_INPUT", "Source view requires moduleId");
        const source = record.sources.get(moduleId);
        if (source === null) throw error("CODE_SOURCE_DISPLAY_UNAVAILABLE", "Source display is unavailable for incomplete syntax or redaction analysis");
        rows = [];
        total = 0;
        pageReady = true;
        let line = 1;
        let start = 0;
        do {
          const newline = source.indexOf("\n", start);
          const end = newline < 0 ? source.length : newline;
          const lineText = source.slice(start, end);
          if (query === undefined || lineText.includes(query)) {
            for (let column = 0; column < lineText.length || column === 0; column += 256) {
              if (total >= offset && rows.length < limit) rows.push({ moduleId, line, displayColumn: column + 1, text: lineText.slice(column, column + 256), redacted: true, positionEncoding: "redacted-display", lineContinues: column + 256 < lineText.length });
              total += 1;
            }
          }
          if (newline < 0) break;
          start = end + 1; line += 1;
        } while (start <= source.length);
      } else if (view === "origins") {
        const calls = record.result.facts.calls.filter((call) => (!moduleId || call.moduleId === moduleId) && (!callsiteId || call.id === callsiteId) && (!query || call.callee.includes(query)));
        if (callsiteId && calls.length === 0) throw error("CODE_INVALID_INPUT", "Callsite is not in this selection");
        const bindings = new Map(record.result.facts.bindings.map((binding) => [binding.id, binding]));
        total = calls.length;
        pageReady = true;
        rows = calls.slice(offset, offset + limit).map((call) => {
          let remaining = 128;
          function chain(origin, level, seen = new Set()) {
            if (--remaining < 0 || level >= depth) return { kind: "unresolved", confidence: "unresolved", reason: "query-depth-limit" };
            if (!origin || typeof origin !== "object") return { kind: "unresolved", confidence: "unresolved", reason: "missing-origin" };
            if (origin.bindingId && !seen.has(origin.bindingId)) {
              const binding = bindings.get(origin.bindingId);
              if (binding) { const nextSeen = new Set(seen); nextSeen.add(origin.bindingId); return { ...origin, bindingSpan: binding.span, ...(origin.kind === "binding" ? { from: chain(binding.origin, level + 1, nextSeen) } : {}) }; }
            }
            return { ...origin, ...(origin.receiver ? { receiver: chain(origin.receiver, level + 1, seen) } : {}), ...(origin.previous ? { previous: chain(origin.previous, level + 1, seen) } : {}) };
          }
          return { callsiteId: call.id, moduleId: call.moduleId, sha256: call.sha256, span: call.span, callee: call.callee, arguments: call.arguments.map((argument, index) => ({ index: index + 1, span: argument.span, origin: chain(argument.origin, 0) })), argumentsTruncated: call.argumentsTruncated };
        });
      } else if (view === "remote_callsites") {
        const bindings = new Map(record.result.facts.bindings.map((binding) => [binding.id, binding]));
        rows = [];
        total = 0;
        pageReady = true;
        for (const call of record.result.facts.calls) {
          if (moduleId !== undefined && call.moduleId !== moduleId) continue;
          const candidate = remoteCallsite(call, remote, bindings, total >= offset && rows.length < limit);
          if (!candidate) continue;
          receiverResolutionTruncated ||= candidate.truncated;
          if (!candidate.matched) continue;
          if (candidate.row) rows.push(candidate.row);
          total += 1;
        }
      } else rows = record.result.facts[view].filter((fact) => (!moduleId || fact.moduleId === moduleId) && (!callsiteId || fact.id === callsiteId || fact.callsiteId === callsiteId) && (!query || [fact.name, fact.callee, fact.logicalPath, fact.targetModuleId, fact.snippet].some((value) => typeof value === "string" && value.includes(query))));
      total ??= rows.length;
      if (offset > total) throw error("CODE_INVALID_CURSOR", "Index cursor is outside this selection");
      const next = Math.min(total, offset + limit);
      return structuredClone({ indexId, view, rows: pageReady ? rows : rows.slice(offset, next), total, hasMore: next < total, ...(next < total ? { cursor: cursor(indexId, selection, next) } : {}), truncated: record.result.truncated || receiverResolutionTruncated, ...(view === "remote_callsites" ? {
        correlation: "static-candidates-only", execution: "not-executed", receiverIdentity: "unverified",
        completeness: { syntax: record.result.files.every((file) => !file.parseErrors), bounded: !record.result.truncated && !receiverResolutionTruncated, semantic: "conservative", execution: "not-executed" },
        limits: remoteQueryLimits, limitations: remoteQueryLimitations,
      } : {}) });
    },
    releaseScope(scopeId) { text(scopeId, 256, "scopeId"); for (const lease of pending) if (lease.scopeId === scopeId) lease.cancelled = true; for (const [id, record] of records) if (record.scopeId === scopeId) remove(id, record); },
    clear() { for (const lease of pending) lease.cancelled = true; records.clear(); sourceBytes = 0; metadataBytes = 0; },
  };
}

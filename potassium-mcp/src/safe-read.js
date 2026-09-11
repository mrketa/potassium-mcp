import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export const MAX_SAFE_READ_BYTES = 262144;
export const DEFAULT_SAFE_READ_BYTES = 65536;
export const DEFAULT_ARTIFACT_READ_BYTES = 4096;
export const DEFAULT_TRACE_READ_BYTES = 8192;
export const MAX_SAFE_ARTIFACT_BYTES = MAX_SAFE_READ_BYTES * 16;
export const MAX_SAFE_TIMEOUT_MS = 10000;
export const DEFAULT_SAFE_TIMEOUT_MS = 5000;

const blockedSourceExtensions = new Set([
  ".lua", ".luau", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".php", ".java", ".cs", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".sh", ".ps1", ".bat", ".cmd",
]);
const secretFileName = /(?:^|[._-])(?:env|token|secret|password|passwd|credential|api[_-]?key|auth|cookie|private[_-]?key)(?:[._-]|$)/i;
const sensitiveQueryName = /(?:token|secret|password|passwd|credential|api[_-]?key|auth|cookie|signature|sig|key)/i;
const commonSecretKey = /(?:access[_-]?token|api[_-]?key|authorization|auth|bearer|client[_-]?secret|cookie|credential|pass(?:word|wd)?|private[_-]?key|refresh[_-]?token|secret|session(?:id)?|signature|sig|token)/i;
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const longNumericId = /\b\d{16,}\b/g;
const keyedSecretValue = /((?:["']?(?:access[_-]?token|api[_-]?key|authorization|auth|bearer|client[_-]?secret|cookie|credential|pass(?:word|wd)?|private[_-]?key|refresh[_-]?token|secret|session(?:id)?|signature|sig|token)["']?)\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s,;}\]\r\n]+)/gi;
const namedSecretValue = /\b(?:access[_-]?token|api[ _-]?key|client[_-]?secret|pass(?:word|wd)?|refresh[_-]?token|secret|token)\b\s+(?:(?:is|was)\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9._~+\/=-]{8,})/gi;
const cookieHeaderValue = /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi;

const TRACE_ROOT_NAME = "trace_records";
const MAX_TRACE_ROWS = 500;
const DEFAULT_TRACE_ROWS = 20;
const MAX_TRACE_STRING_LENGTH = 4096;
const MAX_TRACE_DEPTH = 8;
const MAX_TRACE_COLLECTION_LENGTH = 64;
const placeMetadataKinds = new Map([
  ["universe", (id) => `https://games.roblox.com/v1/games?universeIds=${id}`],
  ["place", (id) => `https://apis.roblox.com/universes/v1/places/${id}/universe`],
  ["thumbnail", (id, size) => `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${id}&returnPolicy=PlaceHolder&size=${size}&format=Png&isCircular=false`],
  ["user", (id) => `https://users.roblox.com/v1/users/${id}`],
]);

function safeError(message) {
  return new Error(message);
}

function assertBoundedInteger(value, fallback, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw safeError(`${label} must be an integer between 0 and ${maximum}`);
  }
  return resolved;
}

function isWithin(root, target) {
  const relativePath = relative(root, target);
  return relativePath === "" || (!isAbsolute(relativePath) && !relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function redactJsonText(text, token) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // Non-JSON artifacts retain the existing bounded plain-text redaction path.
    return text;
  }
  try {
    let changed = false;
    if (typeof value === "string" && token) {
      const redacted = value.replaceAll(token, "[REDACTED]");
      changed = redacted !== value;
      value = redacted;
    }
    const pending = value !== null && typeof value === "object" ? [value] : [];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const key of Object.keys(current)) {
        const child = current[key];
        const redacted = commonSecretKey.test(key) ? "[REDACTED]"
          : typeof child === "string" && token ? child.replaceAll(token, "[REDACTED]") : child;
        const redactedKey = token ? key.replaceAll(token, "[REDACTED]") : key;
        if (redactedKey !== key) {
          delete current[key];
          Object.defineProperty(current, redactedKey, {
            value: redacted, enumerable: true, writable: true, configurable: true,
          });
          changed = true;
        } else if (redacted !== child) {
          current[key] = redacted;
          changed = true;
        }
        if (redacted !== null && typeof redacted === "object") pending.push(redacted);
      }
    }
    return changed ? JSON.stringify(value) : text;
  } catch {
    // In particular, never return raw JSON when serialization exhausts its stack.
    throw safeError("Structured text exceeds safe redaction complexity");
  }
}

function redactStructuredText(text, extension, token) {
  if (extension === ".json") return redactJsonText(text, token);
  if (extension !== ".ndjson") return text;
  return text.split(/(\r?\n)/).map((line) => {
    if (line === "\n" || line === "\r\n" || line.trim() === "") return line;
    return redactJsonText(line, token);
  }).join("");
}

function redactText(text, token, extension = "") {
  let output = redactStructuredText(text, extension, token)
    .replace(bearerValue, "Bearer [REDACTED]")
    .replace(keyedSecretValue, "$1[REDACTED]")
    .replace(namedSecretValue, "[REDACTED]")
    .replace(cookieHeaderValue, "Cookie: [REDACTED]")
    .replace(longNumericId, "[REDACTED_ID]");
  if (token) output = output.replaceAll(token, "[REDACTED]");
  return output;
}

function validateArtifactPath(path, root) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0") || path.includes(":") || isAbsolute(path)) {
    throw safeError("Artifact path is invalid");
  }
  if (path.split(/[\\/]+/).some((part) => part === "..")) {
    throw safeError("Artifact path traversal is not allowed");
  }
  if (secretFileName.test(path)) {
    throw safeError("Artifact file name is not allowed");
  }
  const target = resolve(root, path);
  if (!isWithin(root, target)) throw safeError("Artifact path traversal is not allowed");
  return target;
}

function sameFileIdentity(left, right) {
  return typeof left.ino === "bigint" && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left, right) {
  return sameFileIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readArtifactText({ root, path, offsetBytes = 0, maxBytes = DEFAULT_ARTIFACT_READ_BYTES }, config, dependencies, redact) {
  const offset = assertBoundedInteger(offsetBytes, 0, Number.MAX_SAFE_INTEGER, "offsetBytes");
  const limit = assertBoundedInteger(maxBytes, DEFAULT_ARTIFACT_READ_BYTES, MAX_SAFE_READ_BYTES, "maxBytes");
  if (limit === 0) throw safeError("maxBytes must be greater than 0");
  const roots = config.artifactRoots ?? [];
  const configuredRoot = roots.find((entry) => entry.name === root);
  if (!configuredRoot) throw safeError("Artifact root is not allowed");

  const resolvePath = async (value) => (dependencies.realpath ?? realpath)(value).catch(() => {
    throw safeError("Artifact path is unavailable");
  });
  const statPath = async (value) => (dependencies.stat ?? stat)(value, { bigint: true }).catch(() => {
    throw safeError("Artifact path is unavailable");
  });
  const rootRealpath = await resolvePath(configuredRoot.path);
  const rootStat = await statPath(rootRealpath);
  if (!rootStat.isDirectory() || rootStat.ino === 0n) throw safeError("Artifact root identity is unavailable");
  const requestedPath = validateArtifactPath(path, rootRealpath);
  const targetRealpath = await resolvePath(requestedPath);
  if (!isWithin(rootRealpath, targetRealpath)) throw safeError("Artifact path escapes its configured root");
  if (!configuredRoot.recursive && dirname(targetRealpath) !== rootRealpath) {
    throw safeError("Artifact root does not allow recursive reads");
  }

  const extension = extname(targetRealpath).toLowerCase();
  if (blockedSourceExtensions.has(extension) || !configuredRoot.extensions.includes(extension)) {
    throw safeError("Artifact file extension is not allowed");
  }
  if (secretFileName.test(targetRealpath)) throw safeError("Artifact file name is not allowed");

  const expectedStat = await statPath(targetRealpath);
  if (!expectedStat.isFile()) throw safeError("Artifact path is not a file");
  const assertPathIdentity = async (fileStat) => {
    if (await resolvePath(configuredRoot.path) !== rootRealpath
      || await resolvePath(requestedPath) !== targetRealpath
      || await resolvePath(targetRealpath) !== targetRealpath
      || !sameFileIdentity(rootStat, await statPath(rootRealpath))
      || !sameFileVersion(fileStat, await statPath(targetRealpath))) {
      throw safeError("Artifact identity changed during read");
    }
  };

  // O_NOFOLLOW protects the final component where supported; O_NONBLOCK avoids
  // hanging on a FIFO substituted after stat. Parent/reparse identity is checked below.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await (dependencies.open ?? open)(targetRealpath, flags).catch(() => {
    throw safeError("Artifact file is unavailable");
  });
  try {
    const statOpened = async () => file.stat({ bigint: true }).catch(() => {
      throw safeError("Artifact file metadata is unavailable");
    });
    const fileStat = await statOpened();
    if (!fileStat.isFile() || !sameFileVersion(expectedStat, fileStat)) {
      throw safeError("Artifact identity changed during read");
    }
    await assertPathIdentity(fileStat);
    if (fileStat.size > BigInt(redact ? MAX_SAFE_ARTIFACT_BYTES : Number.MAX_SAFE_INTEGER)) {
      throw safeError("Artifact file exceeds safe read size");
    }
    const size = Number(fileStat.size);
    if (!redact && offset > size) throw safeError("offsetBytes exceeds artifact size");
    const readOffset = redact ? 0 : offset;
    const raw = Buffer.allocUnsafe(redact ? size : Math.min(limit, size - offset));
    let bytesRead = 0;
    while (bytesRead < raw.length) {
      const result = await file.read(raw, bytesRead, raw.length - bytesRead, readOffset + bytesRead).catch(() => {
        throw safeError("Artifact file could not be read");
      });
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== raw.length || !sameFileVersion(fileStat, await statOpened())) {
      throw safeError("Artifact changed during read");
    }
    await assertPathIdentity(fileStat);
    // Byte offsets address the fully redacted UTF-8 representation, not raw secrets.
    // A page may split a UTF-8 code point; decoding that page uses replacement characters.
    const content = redact ? Buffer.from(redactText(raw.toString("utf8"), config.token, extension), "utf8") : raw;
    if (redact && offset > content.length) throw safeError("offsetBytes exceeds artifact size");
    const totalBytes = redact ? content.length : size;
    const visible = redact ? content.subarray(offset, offset + limit) : content;
    const relativePath = relative(rootRealpath, targetRealpath).split(sep).join("/");
    return {
      root: configuredRoot.name,
      path: relativePath,
      offsetBytes: offset,
      bytesRead: visible.length,
      truncated: offset + visible.length < totalBytes,
      text: visible.toString("utf8"),
    };
  } finally {
    await file.close().catch(() => {
      throw safeError("Artifact file could not be closed");
    });
  }
}

export async function readArtifact(request, config, dependencies = {}) {
  return readArtifactText(request, config, dependencies, true);
}

async function readRawArtifact(request, config, dependencies = {}) {
  return readArtifactText(request, config, dependencies, false);
}

function sanitizeTraceValue(value, config, depth = 0) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? "[REDACTED_ID]" : value;
  }
  if (typeof value === "string") return redactText(value, config.token).slice(0, MAX_TRACE_STRING_LENGTH);
  if (depth >= MAX_TRACE_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_TRACE_COLLECTION_LENGTH).map((item) => sanitizeTraceValue(item, config, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort().slice(0, MAX_TRACE_COLLECTION_LENGTH)) {
      const safeKey = redactText(key, config.token).slice(0, 256);
      Object.defineProperty(result, safeKey, {
        value: commonSecretKey.test(key) ? "[REDACTED]" : sanitizeTraceValue(value[key], config, depth + 1),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  return null;
}

function validateTraceRequest({ path, eventType, since, until, maxRows = DEFAULT_TRACE_ROWS, maxBytes = DEFAULT_TRACE_READ_BYTES }, config) {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) throw safeError("Trace path is invalid");
  if (eventType !== undefined && (typeof eventType !== "string" || eventType.length === 0 || eventType.length > 128)) {
    throw safeError("eventType is invalid");
  }
  const parseBound = (value, label) => {
    if (value === undefined) return undefined;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) throw safeError(`${label} must be a non-negative Unix timestamp`);
      return value;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      || Number.isNaN(Date.parse(value))) {
      throw safeError(`${label} must be a Unix timestamp or ISO date-time`);
    }
    return Date.parse(value) / 1000;
  };
  const start = parseBound(since, "since");
  const end = parseBound(until, "until");
  if (start !== undefined && end !== undefined && start > end) throw safeError("since must not be after until");
  const rows = assertBoundedInteger(maxRows, DEFAULT_TRACE_ROWS, MAX_TRACE_ROWS, "maxRows");
  if (rows === 0) throw safeError("maxRows must be greater than 0");
  const bytes = assertBoundedInteger(maxBytes, DEFAULT_TRACE_READ_BYTES, MAX_SAFE_READ_BYTES, "maxBytes");
  if (bytes === 0) throw safeError("maxBytes must be greater than 0");
  const root = (config.artifactRoots ?? []).find((entry) => entry.name === TRACE_ROOT_NAME);
  if (!root || root.recursive || !Array.isArray(root.extensions) || root.extensions.length !== 1 || root.extensions[0] !== ".ndjson") {
    throw safeError("Trace root is not configured safely");
  }
  return { path, eventType, since: start, until: end, maxRows: rows, maxBytes: bytes };
}

function traceTimestamp(row) {
  for (const key of ["at", "timestamp", "time"]) {
    if (typeof row[key] === "number" && Number.isFinite(row[key])) return row[key];
    if (typeof row[key] === "string" && !Number.isNaN(Date.parse(row[key]))) return Date.parse(row[key]) / 1000;
  }
  return undefined;
}

function traceEventType(row) {
  if (typeof row.kind === "string") return row.kind;
  if (typeof row.eventType === "string") return row.eventType;
  return typeof row.event === "string" ? row.event : undefined;
}

export async function queryTrace(request, config, dependencies = {}) {
  const validated = validateTraceRequest(request, config);
  const artifact = await readRawArtifact({
    root: TRACE_ROOT_NAME,
    path: validated.path,
    maxBytes: validated.maxBytes,
  }, config, dependencies);
  const completeLines = artifact.text.split("\n");
  const hasIncompleteLine = completeLines.at(-1) !== "";
  completeLines.pop();
  const rows = [];
  let parseErrors = 0;
  let linesRead = 0;
  let rowLimitReached = false;
  for (const line of completeLines) {
    if (line.trim().length === 0) continue;
    linesRead += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      parseErrors += 1;
      continue;
    }
    const timestamp = traceTimestamp(parsed);
    const eventType = traceEventType(parsed);
    if ((validated.eventType !== undefined && eventType !== validated.eventType)
      || (validated.since !== undefined && (timestamp === undefined || timestamp < validated.since))
      || (validated.until !== undefined && (timestamp === undefined || timestamp > validated.until))) continue;
    if (rows.length >= validated.maxRows) {
      rowLimitReached = true;
      continue;
    }
    const row = sanitizeTraceValue(parsed, config);
    rows.push(row);
  }
  return {
    root: artifact.root,
    path: artifact.path,
    bytesRead: artifact.bytesRead,
    truncated: artifact.truncated || hasIncompleteLine,
    incompleteLine: hasIncompleteLine,
    linesRead,
    linesParsed: linesRead - parseErrors,
    parseErrors,
    rowLimitReached,
    rows,
  };
}

function evidenceFields(row, matcher) {
  return Object.keys(row).filter((key) => matcher.test(key)).sort();
}

export async function summarizeTrace(request, config, dependencies = {}) {
  const { includeRows = false } = request;
  if (typeof includeRows !== "boolean") throw safeError("includeRows must be a boolean");
  const trace = await queryTrace(request, config, dependencies);
  const eventCounts = Object.create(null);
  let earliest;
  let latest;
  const evidence = { terminal: [], error: [] };
  trace.rows.forEach((row, index) => {
    const eventType = traceEventType(row);
    if (eventType) eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
    const timestamp = traceTimestamp(row);
    if (timestamp !== undefined) {
      earliest = earliest === undefined || timestamp < earliest ? timestamp : earliest;
      latest = latest === undefined || timestamp > latest ? timestamp : latest;
    }
    const classificationText = [eventType, typeof row.code === "string" ? row.code : ""].filter(Boolean).join(" ");
    for (const [kind, matcher] of Object.entries({
      terminal: /(?:terminal|complete|completed|stopped|finished)/i,
      error: /(?:error|failed|failure|exception|timeout)/i,
    })) {
      const fields = evidenceFields(row, matcher);
      if (fields.length > 0 || matcher.test(classificationText)) {
        evidence[kind].push({ row: index, eventType: eventType ?? null, fields });
      }
    }
  });
  const { rows, ...metadata } = trace;
  return {
    ...metadata,
    ...(includeRows ? { rows } : {}),
    summary: {
      eventCounts: Object.fromEntries(Object.entries(eventCounts).sort(([a], [b]) => a.localeCompare(b))),
      timeBounds: earliest === undefined ? null : { earliest, latest },
      evidence,
    },
  };
}

function isPrivateAddress(address) {
  const family = typeof address === "string" ? isIP(address) : 0;
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 88 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0) || a >= 224;
  }
  if (family === 6) {
    if (address.includes("%")) return true;
    // URL parsing canonicalizes expanded IPv6, including dotted mapped addresses.
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
    return normalized === "::" || normalized === "::1" || normalized.startsWith("100:")
      || normalized.startsWith("2001:db8:") || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0
      || (first & 0xff00) === 0xff00;
  }
  return true;
}

function isAllowedContentType(contentType) {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml"
    || mediaType.endsWith("+json") || mediaType.endsWith("+xml");
}

async function readResponseBody(body, maxBytes, signal) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  const readChunk = () => new Promise((resolveRead, rejectRead) => {
    if (signal.aborted) {
      rejectRead(safeError("HTTP request timed out"));
      return;
    }
    const onAbort = () => rejectRead(safeError("HTTP request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolveRead, rejectRead).finally(() => signal.removeEventListener("abort", onAbort));
  });
  try {
    while (true) {
      const { done, value } = await readChunk();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw safeError("HTTP response exceeds maxBytes");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requestPinnedHttps(target, addresses, signal, request) {
  const approved = addresses.map(({ address }) => ({ address, family: isIP(address) }));
  return new Promise((resolveResponse, rejectResponse) => {
    const pending = request(target, {
      method: "GET",
      agent: false,
      signal,
      headers: { "accept-encoding": "identity" },
      // Keep the URL hostname for Host, SNI and Node's default certificate checks.
      // A fresh socket can resolve only to this preflight-approved address set.
      lookup(hostname, options, callback) {
        if (hostname !== target.hostname) {
          callback(safeError("HTTP host changed during connection"));
          return;
        }
        const family = typeof options === "number" ? options : options.family;
        const candidates = family ? approved.filter((entry) => entry.family === family) : approved;
        if (candidates.length === 0) {
          callback(safeError("HTTP host has no approved address for this family"));
        } else if (options.all) {
          callback(null, candidates);
        } else {
          callback(null, candidates[0].address, candidates[0].family);
        }
      },
    }, (incoming) => {
      if (signal.aborted) {
        incoming.destroy();
        rejectResponse(safeError("HTTP request timed out"));
        return;
      }
      resolveResponse({
        status: incoming.statusCode,
        headers: new Headers(Object.entries(incoming.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]])),
        body: Readable.toWeb(incoming, {
          strategy: { highWaterMark: DEFAULT_SAFE_READ_BYTES, size: (chunk) => chunk.byteLength },
        }),
      });
    });
    pending.once("error", rejectResponse);
    pending.end();
  });
}

export async function getAllowedHttps({ url, timeoutMs = DEFAULT_SAFE_TIMEOUT_MS, maxBytes = DEFAULT_SAFE_READ_BYTES }, config, dependencies = {}) {
  const timeout = assertBoundedInteger(timeoutMs, DEFAULT_SAFE_TIMEOUT_MS, MAX_SAFE_TIMEOUT_MS, "timeoutMs");
  if (timeout === 0) throw safeError("timeoutMs must be greater than 0");
  const limit = assertBoundedInteger(maxBytes, DEFAULT_SAFE_READ_BYTES, MAX_SAFE_READ_BYTES, "maxBytes");
  if (limit === 0) throw safeError("maxBytes must be greater than 0");
  let target;
  try {
    target = new URL(url);
  } catch {
    throw safeError("HTTP URL is invalid");
  }
  if (target.protocol !== "https:" || (target.port && target.port !== "443")) throw safeError("Only HTTPS port 443 is allowed");
  if (target.username || target.password) throw safeError("HTTP URL credentials are not allowed");
  if (!(config.httpAllowedHosts ?? []).includes(target.hostname.toLowerCase())) throw safeError("HTTP host is not allowed");
  for (const name of target.searchParams.keys()) {
    if (sensitiveQueryName.test(name)) throw safeError("Sensitive query parameters are not allowed");
  }

  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(safeError("HTTP request timed out"));
  }, timeout);
  let response;
  let bodyHandled = false;
  try {
    const lookup = dependencies.dnsLookup ?? nodeLookup;
    let addresses;
    try {
      addresses = await Promise.race([lookup(target.hostname, { all: true, verbatim: true }), deadline]);
    } catch (error) {
      if (timedOut) throw safeError("HTTP request timed out");
      throw safeError("HTTP host could not be resolved");
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !entry || isPrivateAddress(entry.address))) {
      throw safeError("HTTP host resolves to a disallowed address");
    }

    try {
      response = await Promise.race([
        requestPinnedHttps(target, addresses, controller.signal, dependencies.httpsRequest ?? httpsRequest),
        deadline,
      ]);
    } catch {
      if (timedOut) throw safeError("HTTP request timed out");
      throw safeError("HTTP request failed");
    }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
      throw safeError(`HTTP response returned status ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isAllowedContentType(contentType)) throw safeError("HTTP response content type is not allowed");
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity") {
      throw safeError("HTTP response encoding is not allowed");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
      throw safeError("HTTP response exceeds maxBytes");
    }
    bodyHandled = true;
    const body = await readResponseBody(response.body, limit, controller.signal).catch((error) => {
      if (timedOut) throw safeError("HTTP request timed out");
      if (error.message === "HTTP response exceeds maxBytes") throw safeError("HTTP response exceeds maxBytes");
      throw safeError("HTTP response body could not be read");
    });
    return {
      url: `${target.origin}${target.pathname}`,
      status: response.status,
      contentType: contentType.split(";", 1)[0].trim().toLowerCase(),
      bytesRead: body.byteLength,
      text: redactText(new TextDecoder("utf-8", { fatal: false }).decode(body), config.token,
        /^(?:application\/json|[^;]+\+json)(?:\s*;|$)/i.test(contentType) ? ".json" : ""),
    };
  } finally {
    clearTimeout(timer);
    if (response?.body && !bodyHandled) void response.body.cancel().catch(() => {});
  }
}

export async function getPlaceMetadata({ kind, id, size = "512x512", timeoutMs = DEFAULT_SAFE_TIMEOUT_MS, maxBytes = DEFAULT_SAFE_READ_BYTES }, config, dependencies = {}) {
  if (!placeMetadataKinds.has(kind)) throw safeError("Place metadata kind is invalid");
  if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) throw safeError("Place metadata id is invalid");
  if (typeof size !== "string" || !new Set(["150x150", "256x256", "512x512"]).has(size)) {
    throw safeError("Place metadata size is invalid");
  }
  if (kind !== "thumbnail" && size !== "512x512") throw safeError("Place metadata size is only supported for thumbnails");
  const url = placeMetadataKinds.get(kind)(id, size);
  const result = await getAllowedHttps({ url, timeoutMs, maxBytes }, config, dependencies);
  return { kind, id, ...result };
}

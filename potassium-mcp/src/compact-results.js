import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export const COMPACT_RESULT_INLINE_BYTES = 8192;
export const COMPACT_RESULT_PAGE_DEFAULT_BYTES = 2048;
export const COMPACT_RESULT_PAGE_MAX_BYTES = 4096;
export const COMPACT_RESULT_MAX_ENTRIES = 64;
export const COMPACT_RESULT_MAX_BYTES = 8 * 1024 * 1024;
export const COMPACT_RESULT_MAX_ENTRY_BYTES = 1024 * 1024;
export const COMPACT_RESULT_TTL_MS = 120000;

const MAX_POINTER_LENGTH = 512;
const MAX_POINTER_DEPTH = 64;
const MAX_POINTERS = 8;
const MAX_POINTERS_LENGTH = 1024;
const MAX_SUMMARY_FIELDS = 12;
const MAX_SUMMARY_BYTES = 512;
const RESULT_ID = /^[a-f0-9]{32}$/;

function resultError(code, message) {
  const error = new Error(message);
  error.name = "CompactResultError";
  error.code = code;
  return error;
}

function boundedInteger(value, minimum, maximum, label, code = "RESULT_INVALID_INPUT") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw resultError(code, `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateScope(scopeId) {
  if (typeof scopeId !== "string" || scopeId.length === 0 || scopeId.length > 256) {
    throw resultError("RESULT_INVALID_INPUT", "Result scope is invalid");
  }
}

function typeMetadata(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (typeof value === "object") return { type: "object", count: Object.keys(value).length };
  return { type: typeof value };
}

function summarize(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return typeMetadata(value);
  const keys = Object.keys(value).sort();
  const summary = { type: "object", count: keys.length, fields: [], omittedFields: keys.length };
  for (let index = 0; index < Math.min(keys.length, MAX_SUMMARY_FIELDS); index += 1) {
    const key = keys[index];
    // Metadata never contains scalar values or recursively expanded children.
    let visibleKey = key.slice(0, 64);
    if (visibleKey.length < key.length && /[\uD800-\uDBFF]$/.test(visibleKey)) visibleKey = visibleKey.slice(0, -1);
    summary.fields.push({ key: visibleKey, ...typeMetadata(value[key]) });
    summary.omittedFields -= 1;
    if (Buffer.byteLength(JSON.stringify(summary)) > MAX_SUMMARY_BYTES) {
      summary.fields.pop();
      summary.omittedFields += 1;
      break;
    }
  }
  return summary;
}

function pointerTokens(pointer) {
  if (typeof pointer !== "string" || pointer.length > MAX_POINTER_LENGTH
    || (pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) {
    throw resultError("RESULT_INVALID_POINTER", "Result pointer must be a bounded RFC 6901 JSON pointer");
  }
  if (pointer === "") return [];
  const tokens = pointer.slice(1).split("/");
  if (tokens.length > MAX_POINTER_DEPTH) throw resultError("RESULT_INVALID_POINTER", "Result pointer exceeds its depth limit");
  return tokens.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function selectValue(value, tokens) {
  for (const token of tokens) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)
      || (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(token))) {
      throw resultError("RESULT_INVALID_POINTER", "Result pointer does not select an own JSON value");
    }
    value = value[token];
  }
  return value;
}

function selectionRequests({ pointer, offsetBytes, pointers, offsets, view }) {
  if (view !== undefined && view !== "auto" && view !== "text") {
    throw resultError("RESULT_INVALID_INPUT", "Result view must be auto or text");
  }
  if (pointers === undefined) {
    if (offsets !== undefined) throw resultError("RESULT_INVALID_INPUT", "offsets requires pointers");
    return [{ pointer: pointer === undefined ? "" : pointer, offsetBytes: offsetBytes === undefined ? 0 : offsetBytes }];
  }
  if (pointer !== undefined || offsetBytes !== undefined) {
    throw resultError("RESULT_INVALID_INPUT", "pointers and offsets cannot be combined with pointer or offsetBytes");
  }
  if (!Array.isArray(pointers) || pointers.length < 1 || pointers.length > MAX_POINTERS
    || Array.from(pointers).some((entry) => typeof entry !== "string")
    || pointers.reduce((length, entry) => length + entry.length, 0) > MAX_POINTERS_LENGTH
    || new Set(pointers).size !== pointers.length) {
    throw resultError("RESULT_INVALID_POINTER", "pointers must contain 1 to 8 unique JSON pointers totaling at most 1024 characters");
  }
  if (offsets !== undefined && (!Array.isArray(offsets) || offsets.length !== pointers.length)) {
    throw resultError("RESULT_INVALID_OFFSET", "offsets must match the pointers array");
  }
  return pointers.map((selectedPointer, index) => ({
    pointer: selectedPointer,
    offsetBytes: offsets === undefined ? 0 : offsets[index],
  }));
}

function fitTextPage(content, offsetBytes, pageBytes, setPage, fits) {
  let high = Math.min(content.length, offsetBytes + pageBytes);
  while (high > offsetBytes && high < content.length && isContinuation(content[high])) high -= 1;
  if (high === offsetBytes && offsetBytes < content.length) return undefined;
  setPage(high);
  if (fits()) return high;
  let low = offsetBytes;
  high -= 1;
  let end;
  while (low <= high) {
    const midpoint = low + Math.floor((high - low) / 2);
    let boundary = midpoint;
    while (boundary > offsetBytes && boundary < content.length && isContinuation(content[boundary])) boundary -= 1;
    setPage(boundary);
    if (fits()) {
      end = boundary;
      low = midpoint + 1;
    } else {
      high = boundary - 1;
    }
  }
  if (end === undefined || (end === offsetBytes && offsetBytes < content.length)) return undefined;
  setPage(end);
  return end;
}

function isContinuation(byte) {
  return (byte & 0xc0) === 0x80;
}

function pageEnvelopeBytes(page) {
  const text = JSON.stringify(page);
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }], structuredContent: page }));
}

/** Memory-only JSON retention. Scope IDs and the originating permission callback are host-owned. */
export function createCompactResultStore({
  clock = Date,
  randomBytes = nodeRandomBytes,
  maxEntries = COMPACT_RESULT_MAX_ENTRIES,
  maxBytes = COMPACT_RESULT_MAX_BYTES,
  maxEntryBytes = COMPACT_RESULT_MAX_ENTRY_BYTES,
  ttlMs = COMPACT_RESULT_TTL_MS,
} = {}) {
  boundedInteger(maxEntries, 1, COMPACT_RESULT_MAX_ENTRIES, "maxEntries");
  boundedInteger(maxBytes, 1, COMPACT_RESULT_MAX_BYTES, "maxBytes");
  boundedInteger(maxEntryBytes, 1, COMPACT_RESULT_MAX_ENTRY_BYTES, "maxEntryBytes");
  boundedInteger(ttlMs, 1, COMPACT_RESULT_TTL_MS, "ttlMs");
  if (typeof clock?.now !== "function" || typeof randomBytes !== "function") {
    throw resultError("RESULT_INVALID_INPUT", "Result clock and random source must be callable");
  }
  const records = new Map();
  let retainedBytes = 0;

  function now() {
    const value = clock.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000 - ttlMs) {
      throw resultError("RESULT_STORE_UNAVAILABLE", "Result clock returned an invalid time");
    }
    return value;
  }

  function remove(resultId, record) {
    records.delete(resultId);
    retainedBytes -= record.bytes;
  }

  function sweep(time) {
    for (const [resultId, record] of records) {
      if (record.expiresAt <= time) remove(resultId, record);
    }
  }

  function nextId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let bytes;
      try {
        bytes = randomBytes(16);
      } catch {
        throw resultError("RESULT_STORE_UNAVAILABLE", "Result random source is unavailable");
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
        throw resultError("RESULT_STORE_UNAVAILABLE", "Result random source returned invalid bytes");
      }
      const resultId = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
      if (!records.has(resultId)) return resultId;
    }
    throw resultError("RESULT_STORE_CAPACITY", "A unique result identifier could not be allocated");
  }

  return {
    put({ scopeId, toolName, json }) {
      validateScope(scopeId);
      if (typeof toolName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(toolName)) {
        throw resultError("RESULT_INVALID_INPUT", "Originating tool name is invalid");
      }
      if (typeof json !== "string") throw resultError("RESULT_INVALID_JSON", "Result must be normalized JSON text");
      const bytes = Buffer.byteLength(json);
      if (bytes > maxEntryBytes || bytes > maxBytes) {
        throw resultError("RESULT_TOO_LARGE", "Result exceeds the configured retention byte limit");
      }
      let value;
      try {
        if (!json.isWellFormed()) throw new Error("Invalid Unicode");
        value = JSON.parse(json);
      } catch {
        throw resultError("RESULT_INVALID_JSON", "Result must be valid UTF-8 JSON text");
      }
      const summary = summarize(value);
      const sha256 = createHash("sha256").update(json, "utf8").digest("hex");
      const time = now();
      sweep(time);
      const resultId = nextId();
      const expiresAt = time + ttlMs;
      while (records.size >= maxEntries || retainedBytes + bytes > maxBytes) {
        const [oldestId, oldest] = records.entries().next().value;
        remove(oldestId, oldest);
      }
      // Retain one representation only; parsed trees and selected subtrees are never cached.
      records.set(resultId, { scopeId, toolName, json, bytes, expiresAt });
      retainedBytes += bytes;
      return {
        kind: "potassium/result", resultId, toolName, bytes, sha256,
        expiresAt: new Date(expiresAt).toISOString(), summary,
      };
    },

    read(request, allowsToolCallback, { maxResponseBytes = COMPACT_RESULT_INLINE_BYTES } = {}) {
      const { scopeId, resultId, maxBytes: pageBytes = COMPACT_RESULT_PAGE_DEFAULT_BYTES } = request;
      validateScope(scopeId);
      if (typeof resultId !== "string" || !RESULT_ID.test(resultId)) {
        throw resultError("RESULT_INVALID_INPUT", "Result identifier must contain 32 lowercase hexadecimal characters");
      }
      const record = records.get(resultId);
      const time = now();
      sweep(time);
      if (!record || record.scopeId !== scopeId || record.expiresAt <= time) {
        throw resultError("RESULT_NOT_FOUND", "Result is unavailable, expired, or outside this scope");
      }
      let allowed = false;
      try {
        allowed = typeof allowsToolCallback === "function" && allowsToolCallback(record.toolName) === true;
      } catch {
        // Do not expose policy implementation errors or weaken permission checks.
      }
      if (!allowed) throw resultError("RESULT_ORIGIN_DENIED", "The originating tool is no longer permitted");
      boundedInteger(pageBytes, 1, COMPACT_RESULT_PAGE_MAX_BYTES, "maxBytes");
      boundedInteger(maxResponseBytes, 1, COMPACT_RESULT_INLINE_BYTES, "maxResponseBytes");
      const requests = selectionRequests(request).map((selection) => ({
        ...selection,
        tokens: pointerTokens(selection.pointer),
        offsetBytes: boundedInteger(selection.offsetBytes, 0, Number.MAX_SAFE_INTEGER, "offsetBytes", "RESULT_INVALID_OFFSET"),
      }));
      const auto = request.view !== "text";
      const multiple = request.pointers !== undefined || auto;
      // A request owns this parsed tree only until its response is constructed.
      const parsed = multiple || requests[0].tokens.length > 0 ? JSON.parse(record.json) : undefined;
      const selected = requests.map(({ pointer, offsetBytes, tokens }) => {
        const value = selectValue(parsed, tokens);
        let json;
        try {
          json = tokens.length === 0 ? record.json : JSON.stringify(value);
        } catch {
          throw resultError("RESULT_INVALID_POINTER", "Selected JSON value exceeds serialization limits");
        }
        const content = Buffer.from(json, "utf8");
        if (offsetBytes > content.length || (offsetBytes < content.length && isContinuation(content[offsetBytes]))) {
          throw resultError("RESULT_INVALID_OFFSET", "Result offset must be a UTF-8 boundary within the selected JSON");
        }
        return { pointer, offsetBytes, content, value };
      });
      if (!multiple) {
        const { pointer, offsetBytes, content } = selected[0];
        const page = {
          resultId, toolName: record.toolName, pointer, offsetBytes, nextOffsetBytes: offsetBytes,
          hasMore: offsetBytes < content.length, totalBytes: content.length, text: "",
        };
        const end = fitTextPage(content, offsetBytes, pageBytes, (boundary) => {
          page.nextOffsetBytes = boundary;
          page.hasMore = boundary < content.length;
          page.text = content.toString("utf8", offsetBytes, boundary);
        }, () => pageEnvelopeBytes(page) <= maxResponseBytes);
        if (end === undefined) {
          throw resultError("RESULT_PAGE_TOO_SMALL", "maxBytes or the response budget cannot fit the next UTF-8 page");
        }
        return page;
      }

      const page = {
        resultId, toolName: record.toolName,
        selections: selected.map(({ pointer, offsetBytes }) => ({
          pointer, kind: "pending", nextOffsetBytes: offsetBytes, hasMore: true,
        })),
        hasMore: true,
      };
      let remainingBytes = pageBytes;
      let progress = false;
      const fits = () => {
        page.hasMore = page.selections.some((selection) => selection.hasMore === true);
        return pageEnvelopeBytes(page) <= maxResponseBytes;
      };
      const values = selected.map(({ pointer, offsetBytes, content, value }) => {
        if (!auto || offsetBytes !== 0 || content.length > pageBytes) return undefined;
        const bytes = pointer === "" ? Buffer.byteLength(JSON.stringify(value), "utf8") : content.length;
        return { selection: { pointer, kind: "value", value }, bytes };
      });
      // Small direct values can cost less metadata than pending selections. Seed
      // those first, including when pending metadata alone exceeds the envelope.
      for (let index = 0; index < values.length; index += 1) {
        const direct = values[index];
        if (direct && direct.bytes <= remainingBytes
          && pageEnvelopeBytes(direct.selection) <= pageEnvelopeBytes(page.selections[index])) {
          page.selections[index] = direct.selection;
          remainingBytes -= direct.bytes;
          progress = true;
        }
      }
      for (let index = 0; index < selected.length; index += 1) {
        if (page.selections[index].kind === "value") continue;
        const pending = page.selections[index];
        const direct = values[index];
        if (direct && direct.bytes <= remainingBytes) {
          page.selections[index] = direct.selection;
          if (fits()) {
            remainingBytes -= direct.bytes;
            progress = true;
            continue;
          }
          page.selections[index] = pending;
        }
        const { pointer, offsetBytes, content } = selected[index];
        const text = {
          pointer, kind: "text", text: "", offsetBytes, nextOffsetBytes: offsetBytes,
          totalBytes: content.length, hasMore: offsetBytes < content.length,
        };
        page.selections[index] = text;
        const end = fitTextPage(content, offsetBytes, remainingBytes, (boundary) => {
          text.text = content.toString("utf8", offsetBytes, boundary);
          text.nextOffsetBytes = boundary;
          text.hasMore = boundary < content.length;
        }, fits);
        if (end === undefined) {
          page.selections[index] = pending;
        } else {
          remainingBytes -= end - offsetBytes;
          progress = true;
        }
      }
      if (!progress || !fits()) {
        throw resultError("RESULT_PAGE_TOO_SMALL", "maxBytes or the response budget cannot fit a selected value or UTF-8 page");
      }
      return page;
    },

    releaseScope(scopeId) {
      validateScope(scopeId);
      for (const [resultId, record] of records) {
        if (record.scopeId === scopeId) remove(resultId, record);
      }
    },

    clear() {
      records.clear();
      retainedBytes = 0;
    },
  };
}

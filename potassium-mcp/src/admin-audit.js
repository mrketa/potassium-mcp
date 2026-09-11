import { mkdir, writeFile } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { assertHostId } from "./host-policy.js";

const MAX_HISTORY = 100;
const MAX_ENTRY_BYTES = 4096;

function metadataText(value, maximum = 128) {
  return typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9 ._+()-]*(?![\s\S])/.test(value)
    ? value : undefined;
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/.test(value)
    && Number.isFinite(Date.parse(value));
}

function auditEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !timestamp(value.startedAt) || !timestamp(value.finishedAt)
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0
    || !["success", "error", "timeout"].includes(value.outcome)
    || !["sync", "async"].includes(value.mode ?? "sync")
    || typeof value.codeSha256 !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(value.codeSha256)
    || !Number.isSafeInteger(value.utf8Bytes) || value.utf8Bytes < 0 || value.utf8Bytes > 65536) return undefined;
  const entry = {
    startedAt: value.startedAt, finishedAt: value.finishedAt, durationMs: value.durationMs,
    outcome: value.outcome, mode: value.mode ?? "sync",
    codeSha256: value.codeSha256, utf8Bytes: value.utf8Bytes,
    client: clientMetadata(value.client),
  };
  if (value.outcome !== "success") entry.errorClass = ["timeout", "transport", "error"].includes(value.errorClass) ? value.errorClass : "error";
  if (typeof value.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value.sessionId)) entry.sessionId = value.sessionId;
  if (typeof value.executorJobId === "string" && /^[a-f0-9]{32}(?![\s\S])/.test(value.executorJobId)) entry.executorJobId = value.executorJobId;
  try { entry.hostId = assertHostId(value.hostId); } catch { /* Legacy rows may omit the host. */ }
  return Object.freeze(entry);
}

function replayHistory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return [];
    const length = Math.min(stat.size, MAX_ENTRY_BYTES * (MAX_HISTORY + 1));
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, offset);
    const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/);
    if (offset > 0) lines.shift(); // Never parse a row whose beginning was not read.
    const entries = [];
    for (const line of lines) {
      if (!line || Buffer.byteLength(line, "utf8") > MAX_ENTRY_BYTES) continue;
      try {
        const entry = auditEntry(JSON.parse(line));
        if (entry) entries.push(entry);
      } catch { /* One damaged row must not hide later valid metadata. */ }
    }
    return entries.slice(-MAX_HISTORY);
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function errorClass(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out after")) return "timeout";
  if (message.includes("not connected") || message.includes("disconnected")) return "transport";
  return "error";
}

function clientMetadata(client) {
  if (!client || typeof client !== "object" || Array.isArray(client)) return null;
  const metadata = {};
  for (const key of ["executor", "version"]) {
    const value = metadataText(client[key]);
    if (value !== undefined) metadata[key] = value;
  }
  for (const key of ["placeId", "protocol"]) {
    if (Number.isSafeInteger(client[key]) && client[key] >= 0) metadata[key] = client[key];
  }
  return Object.freeze(metadata);
}

export class AdminAuditRecorder {
  constructor({ path } = {}) {
    this.path = path;
    this.entries = path ? replayHistory(path) : [];
    this.pendingWrite = Promise.resolve();
    this.durableDirectory = path ? mkdir(dirname(path), { recursive: true }).catch(() => {}) : null;
  }
  begin({ code, bridge, sessionId, mode = "sync", executorJobId, hostId, client } = {}) {
    const startedAt = new Date().toISOString();
    return {
      startedAt,
      mode,
      ...(executorJobId === undefined ? {} : { executorJobId }),
      ...(typeof hostId === "string" ? { hostId: assertHostId(hostId) } : {}),
      codeSha256: createHash("sha256").update(code, "utf8").digest("hex"),
      utf8Bytes: Buffer.byteLength(code, "utf8"),
      sessionId,
      client: clientMetadata(client ?? bridge.status().client),
    };
  }

  async finish(operation, outcome, error) {
    const finishedAt = new Date().toISOString();
    const entry = auditEntry({
      startedAt: operation.startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(operation.startedAt)),
      outcome,
      ...(outcome === "success" ? {} : { errorClass: errorClass(error) }),
      mode: operation.mode ?? "sync",
      ...(operation.executorJobId === undefined ? {} : { executorJobId: operation.executorJobId }),
      ...(operation.hostId === undefined ? {} : { hostId: operation.hostId }),
      codeSha256: operation.codeSha256,
      utf8Bytes: operation.utf8Bytes,
      sessionId: operation.sessionId,
      client: operation.client,
    });
    if (!entry) throw new Error("Invalid audit metadata");
    this.entries.push(entry);
    if (this.entries.length > MAX_HISTORY) this.entries.splice(0, this.entries.length - MAX_HISTORY);
    if (this.path) {
      const write = this.pendingWrite.then(async () => {
        await this.durableDirectory;
        const contents = `${this.entries.map((item) => JSON.stringify(item)).join("\n")}\n`;
        await writeFile(this.path, contents, { encoding: "utf8", mode: 0o600 });
      });
      // Preserve ordering after a failed write without hiding this caller's failure.
      this.pendingWrite = write.catch(() => {});
      await write;
    }
    return entry;
  }

  history(limit = 20) {
    return this.entries.slice(-limit).reverse();
  }
}

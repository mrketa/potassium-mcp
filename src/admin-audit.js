import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const MAX_HISTORY = 100;

function errorClass(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out after")) return "timeout";
  if (message.includes("not connected") || message.includes("disconnected")) return "transport";
  return "error";
}

function clientMetadata(client) {
  if (!client || typeof client !== "object") return null;
  const metadata = {};
  for (const key of ["executor", "version", "placeId", "protocol"]) {
    const value = client[key];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) metadata[key] = value;
  }
  return metadata;
}

export class AdminAuditRecorder {
  constructor({ path } = {}) {
    this.path = path;
    this.entries = [];
    if (path) {
      try {
        const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_HISTORY);
        for (const line of lines) {
          const entry = JSON.parse(line);
          if (entry && typeof entry === "object") this.entries.push(entry);
        }
      } catch {
        // A missing or malformed prior audit must not disable trusted execution.
      }
    }
    this.durableDirectory = path ? mkdir(dirname(path), { recursive: true }).catch(() => {}) : null;
  }
  begin({ code, bridge, sessionId }) {
    const startedAt = new Date().toISOString();
    return {
      startedAt,
      codeSha256: createHash("sha256").update(code, "utf8").digest("hex"),
      utf8Bytes: Buffer.byteLength(code, "utf8"),
      sessionId,
      client: clientMetadata(bridge.status().client),
    };
  }

  async finish(operation, outcome, error) {
    const finishedAt = new Date().toISOString();
    const entry = {
      startedAt: operation.startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(operation.startedAt)),
      outcome,
      ...(outcome === "success" ? {} : { errorClass: errorClass(error) }),
      codeSha256: operation.codeSha256,
      utf8Bytes: operation.utf8Bytes,
      sessionId: operation.sessionId,
      client: operation.client,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_HISTORY) this.entries.splice(0, this.entries.length - MAX_HISTORY);
    if (this.path) {
      try {
        await this.durableDirectory;
        const contents = `${this.entries.map((item) => JSON.stringify(item)).join("\n")}\n`;
        await writeFile(this.path, contents, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Auditing must not change unrestricted execution semantics if storage fails.
      }
    }
    return entry;
  }

  history(limit = 20) {
    return this.entries.slice(-limit).reverse();
  }
}

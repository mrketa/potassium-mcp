import {
  createNativeMcpTransport,
  NATIVE_MCP_TIMEOUT_MS,
  NATIVE_MCP_URL,
  redactNativeToken,
  validateNativeMcpUrl,
} from "./native-mcp.js";

export const BUILTIN_FALLBACK_URL = NATIVE_MCP_URL;
const BUILTIN_FALLBACK_TIMEOUT_MS = NATIVE_MCP_TIMEOUT_MS;
export const BUILTIN_FALLBACK_MAX_RESPONSE_BYTES = 64 * 1024;

const allowedTools = new Set([
  "list_clients",
  "read_console",
]);


function failure(message) {
  return new Error(`Built-in fallback unavailable: ${message}`);
}


export function validateBuiltinFallbackUrl(url = BUILTIN_FALLBACK_URL) {
  return validateNativeMcpUrl(url, failure);
}

function boundedToolMetadata(result) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.tools)) {
    throw failure("tools/list response is invalid");
  }
  return result.tools
    .filter((tool) => tool !== null && typeof tool === "object" && allowedTools.has(tool.name))
    .map((tool) => ({ name: tool.name }));
}



function validateToolResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.content)
    || !result.content.every((entry) => entry !== null && typeof entry === "object"
      && entry.type === "text" && typeof entry.text === "string")) {
    throw failure("tool response is invalid");
  }
}

function validateConsoleArguments(pid, options) {
  if (typeof pid !== "string" || !/^[1-9]\d{0,10}$/.test(pid)) {
    throw new TypeError("pid must be a positive decimal process identifier");
  }
  if (options === undefined) return { pid };
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("console options must be an object");
  const { afterCursor, limit, waitMs, ...unknown } = options;
  if (Object.keys(unknown).length > 0) throw new TypeError("console options contain an unknown field");
  if (afterCursor !== undefined && (!Number.isSafeInteger(afterCursor) || afterCursor < 0)) throw new TypeError("afterCursor must be a non-negative integer");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw new TypeError("limit must be an integer from 1 through 200");
  if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > BUILTIN_FALLBACK_TIMEOUT_MS)) throw new TypeError("waitMs must be an integer from 0 through 3000");
  return {
    pid,
    ...(afterCursor === undefined ? {} : { after_cursor: afterCursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(waitMs === undefined ? {} : { wait_ms: waitMs }),
  };
}

class BuiltinFallbackClient {
  #transport;

  constructor(options = {}) {
    this.#transport = createNativeMcpTransport({
      ...options,
      maxBytes: BUILTIN_FALLBACK_MAX_RESPONSE_BYTES,
      errorPrefix: "Built-in fallback unavailable",
    });
  }

  async #discover() {
    const { token, tools } = await this.#transport.discover("potassium-builtin-fallback");
    return { token, tools: boundedToolMetadata({ tools }) };
  }

  async #call(toolName, arguments_) {
    if (!allowedTools.has(toolName)) throw failure("tool is not an allowed diagnostic method");
    const { token, tools } = await this.#discover();
    if (!tools.some((tool) => tool.name === toolName)) {
      throw failure(`required diagnostic tool ${toolName} is unavailable`);
    }
    const result = await this.#transport.request(token, "tools/call", { name: toolName, arguments: arguments_ });
    validateToolResult(result);
    return redactNativeToken(result, token);
  }

  status() {
    return this.#discover().then(({ tools }) => ({ reachable: true, tools }));
  }

  listClients() {
    return this.#call("list_clients", {});
  }

  readConsole(pid, options) {
    return this.#call("read_console", validateConsoleArguments(pid, options));
  }
}
export function createBuiltinFallbackClient(options) {
  return new BuiltinFallbackClient(options);
}

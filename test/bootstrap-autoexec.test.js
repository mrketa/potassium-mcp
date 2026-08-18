import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const autoexecPath = fileURLToPath(new URL("../assets/potassium_mcp_autoexec.lua", import.meta.url));
const bootstrapPath = fileURLToPath(new URL("../assets/potassium_mcp_bootstrap.lua", import.meta.url));

test("autoexec loads the standalone bootstrap and retries only bounded failures", async () => {
  const source = await readFile(autoexecPath, "utf8");

  assert.match(source, /local BOOTSTRAP_PATH = "\.potassium-mcp-bootstrap\.lua"/);
  assert.match(source, /local RETRYABLE_REASONS = \{/);
  assert.match(source, /\["bootstrap file is unavailable"\] = true/);
  assert.match(source, /\["connection unavailable"\] = true/);
  assert.match(source, /\["connection failed"\] = true/);
  assert.match(source, /pcall\(readfile, BOOTSTRAP_PATH\)/);
  assert.match(source, /loadstring\(source, "@" \.\. BOOTSTRAP_PATH\)/);
  assert.match(source, /pcall\(chunk\)/);
  assert.match(source, /local sharedEnvironment = _G/);
  assert.match(source, /pcall\(getgenv\)/);
  assert.match(source, /local current = sharedEnvironment\.PotassiumMcp/);
  assert.match(source, /sharedEnvironment\.PotassiumMcp = _G\.PotassiumMcp/);
  assert.match(source, /if not retryable or attempt == MAX_LOAD_ATTEMPTS then\s+break\s+end/);
  assert.match(source, /warnUnavailable\(reason\)/);
});
test("startup converges overlapping executor environments on one global owner", async () => {
  const [bootstrap, autoexec] = await Promise.all([
    readFile(bootstrapPath, "utf8"),
    readFile(autoexecPath, "utf8"),
  ]);

  assert.match(autoexec, /sharedEnvironment\.PotassiumMcp ~= _G\.PotassiumMcp/);
  assert.match(bootstrap, /sharedEnvironment\.PotassiumMcp ~= _G\.PotassiumMcp/);
  assert.match(bootstrap, /_G\.PotassiumMcpGeneration = generation/);
  assert.match(bootstrap, /_G\.PotassiumMcp = state/);
  assert.match(bootstrap, /and _G\.PotassiumMcpGeneration == generation\s+and _G\.PotassiumMcp == state/);
});


test("bootstrap preserves Protocol 2 diagnostics, bounded inspection, and gated admin execution", async () => {
  const source = await readFile(bootstrapPath, "utf8");

  assert.match(source, /local PROTOCOL = 2/);
  assert.match(source, /function handshakeProof\(role, clientNonce, serverNonce\)/);
  assert.match(source, /pcall\(crypt\.hmac, key, message, "sha256"\)/);
  assert.match(source, /startupStatus\s*=/);
  assert.match(source, /startupReason\s*=/);
  assert.match(source, /function handlers\.capabilities\(\)/);
  assert.match(source, /"diagnostic_snapshot"/);
  assert.match(source, /"observe_changes"/);
  assert.match(source, /function handlers\.client_state\(\)/);
  assert.doesNotMatch(source, /\bWins\b/);
  assert.match(source, /function handlers\.execute_luau\(params\)/);
  assert.match(source, /code exceeds 32768 bytes/);
  assert.match(source, /loadstring\(code, "@potassium-mcp"\)/);
  assert.doesNotMatch(
    source,
    /runtime_(?:status|stop|eject|command)|approved_teleport|registered_(?:input|remote)_action/i,
  );
  assert.doesNotMatch(source, /HMAC_BLOCK_BYTES|base64ToBytes|writeHmacDiagnostic|protocol2-diagnostic/);
});

test("bootstrap cooperatively slices bounded traversal work without relaxing single-flight ownership", async () => {
  const source = await readFile(bootstrapPath, "utf8");

  assert.match(source, /local WORK_SLICE_SECONDS = 0\.002/);
  assert.match(source, /local WORK_SLICE_ITEMS = 128/);
  assert.match(source, /sharedEnvironment\.PotassiumMcpGeneration/);
  assert.match(source, /sharedEnvironment\.PotassiumMcp == state/);
  assert.match(source, /sharedEnvironment\.PotassiumMcp = _G\.PotassiumMcp/);
  assert.match(source, /local function checkpointWork\(budget, items\)[\s\S]*task\.wait\(\)/);
  assert.match(source, /local function boundedTraversal[\s\S]*checkpointWork\(budget\)/);
  assert.match(source, /function handlers\.subtree_summary[\s\S]*checkpointWork\(budget\)/);
  assert.match(source, /function handlers\.snapshot_diff[\s\S]*checkpointWork\(budget\)/);
  assert.match(source, /function handlers\.class_summary[\s\S]*checkpointWork\(budget\)/);
  assert.match(source, /local MAX_IN_FLIGHT_REQUESTS = 1/);
});

test("bootstrap selects child paths with caller-bounded storage and deterministic truncation", async () => {
  const source = await readFile(bootstrapPath, "utf8");
  const sortedChildren = source.match(
    /local function sortedChildren\(instance, capacity, budget\)([\s\S]*?)\nend\n\nlocal function boundedTraversal/,
  )?.[0];

  assert.ok(sortedChildren, "sortedChildren accepts an explicit caller capacity");
  assert.match(sortedChildren, /table\.create\(math\.min\(#children, capacity \+ 1\)\)/);
  assert.match(sortedChildren, /local sentinelCapacity = capacity \+ 1/);
  assert.match(sortedChildren, /local truncated = #retained > capacity/);
  assert.match(
    sortedChildren,
    /local function siftDown\(index\)[\s\S]*?retained\[index\], retained\[largest\] = retained\[largest\], retained\[index\][\s\S]*?checkpointWork\(budget\)/,
  );
  assert.match(sortedChildren, /while index > 1 do[\s\S]*?local parent = math\.floor\(index \/ 2\)[\s\S]*?checkpointWork\(budget\)/);
  assert.match(sortedChildren, /for index = #retained, 1, -1 do[\s\S]*?selected\[index\] = entry\.instance/);
  assert.match(sortedChildren, /\n\t\tend\n\t\tcheckpointWork\(budget\)\n\tend\n\tlocal truncated/);
  assert.doesNotMatch(sortedChildren, /table\.create\(#children\)/);
  assert.doesNotMatch(sortedChildren, /table\.sort/);

  const traversalSelections = source.match(/sortedChildren\((?:node|entry\.node), maxVisited - #queue, budget\)/g) ?? [];
  assert.equal(traversalSelections.length, 4, "every bounded traversal passes its remaining visit capacity");
  assert.match(source, /local children, childrenTruncated = sortedChildren\(node, remaining, budget\)/);
  assert.match(source, /local sorted, childrenTruncated = sortedChildren\(instance, MAX_SNAPSHOT_CHILDREN, budget\)/);
});

test("bootstrap bounds every unauthenticated connection cycle", async () => {
  const source = await readFile(bootstrapPath, "utf8");

  assert.match(source, /local CONNECTION_TIMEOUT_SECONDS = 10/);
  assert.match(source, /local function startConnectionTimeout\(\)/);
  assert.match(source, /task\.delay\(CONNECTION_TIMEOUT_SECONDS, function\(\)/);
  assert.match(
    source,
    /state\.active = false\s+state\.socket = nil[\s\S]*state\.startupReason = "connection timed out"/,
  );
  assert.match(
    source,
    /state\.acknowledged = true\s+state\.connected = true\s+state\.reconnectAttempt = 0\s+cancelConnectionTimeout\(\)/,
  );
  assert.match(source, /local wasAcknowledged = state\.acknowledged/);
  assert.match(source, /if wasAcknowledged then\s+startConnectionTimeout\(\)\s+end/);
  assert.match(
    source,
    /if not isCurrent\(\) then\s+if ok and socketOrError then\s+pcall\(function\(\)\s+socketOrError:Close\(\)\s+end\)\s+end\s+return\s+end/,
  );
  assert.match(source, /else\s+startConnectionTimeout\(\)\s+task\.defer\(connect\)\s+end\s*$/);
});

test("standalone Lua sources have no legacy gameplay markers", async () => {
  const [bootstrap, autoexec] = await Promise.all([
    readFile(bootstrapPath, "utf8"),
    readFile(autoexecPath, "utf8"),
  ]);

  for (const source of [bootstrap, autoexec]) {
    assert.doesNotMatch(source, /private-game-marker/i);
  }
});

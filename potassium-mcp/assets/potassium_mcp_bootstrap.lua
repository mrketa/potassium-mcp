local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local LogService = game:GetService("LogService")

local ENDPOINT = "ws://127.0.0.1:32145"
local PROTOCOL = 2
local BOOTSTRAP_BUILD = "lifecycle-5"
local MAX_SERIALIZE_DEPTH = 6
local MAX_TABLE_ITEMS = 200
local MAX_MESSAGE_BYTES = 1048576
local MAX_ERROR_MESSAGE_BYTES = 1024
local MAX_TOKEN_BYTES = 4096
local MAX_IN_FLIGHT_REQUESTS = 5
local MAX_REQUEST_ID_BYTES = 256
local RECONNECT_BASE_DELAY_SECONDS = 1
local RECONNECT_MAX_DELAY_SECONDS = 30
local HANDSHAKE_TIMEOUT_SECONDS = 5
local CONNECTION_TIMEOUT_SECONDS = 10
local HEARTBEAT_STALE_SECONDS = 15
local WORK_SLICE_SECONDS = 0.002
local WORK_SLICE_ITEMS = 128
local MAX_ASYNC_RESULT_BYTES = 262144
local MAX_ACTIVE_ASYNC_JOBS = 8
local MAX_RETAINED_ASYNC_JOBS = 32
local ASYNC_JOB_RETENTION_SECONDS = 300
local MAX_ASYNC_SERIALIZED_ITEMS = 4096
local MAX_ASYNC_SERIALIZED_BYTES = 245760
local MAX_ASYNC_CONSOLE_ENTRIES = 200
local MAX_ASYNC_CONSOLE_BYTES = 65536
local MAX_ASYNC_TRACKED_CONNECTIONS = 128
local MAX_SAFE_INTEGER = 9007199254740991
local MAX_ACTIVE_WATCHES = 16
local MAX_RETAINED_WATCHES = 16
local MAX_WATCH_EVENTS = 200
local MAX_WATCH_BUFFER_BYTES = 65536
local MAX_WATCH_EVENT_BYTES = 8192
local MAX_WATCH_SERIALIZED_ITEMS = 128
local MAX_WATCH_PROPERTIES = 16
local MAX_WATCH_CONNECTIONS = MAX_WATCH_PROPERTIES + 4
local WATCH_RETENTION_SECONDS = 60
local LIFECYCLE_SWEEP_SECONDS = 1

local MAX_SNAPSHOT_PROPERTIES = 16
local MAX_SNAPSHOT_ATTRIBUTES = 32
local MAX_SNAPSHOT_TAGS = 32
local MAX_SNAPSHOT_CHILDREN = 100
local MAX_SNAPSHOT_CHANGES = 500
local MAX_MULTI_READ_REQUESTS = 20
local MAX_MULTI_READ_PROPERTIES = 32
local MAX_MULTI_READ_VALUES = 200
local MAX_ANCESTRY_DEPTH = 32
local MAX_CLASS_SUMMARY_RESULTS = 200
local MAX_CLASS_SUMMARY_VISITS = 20000
local MAX_INSTANCE_REFERENCES = 1024
local MAX_REFERENCE_RELEASE = 128
local MAX_BATCH_RESULT_BYTES = 65536
local MAX_BATCH_VALUE_BYTES = 8192
local MAX_BATCH_SERIALIZED_ITEMS = 8192
local MAX_BATCH_SERIALIZED_BYTES = 262144
local MAX_BATCH_WORK_ITEMS = 100000
local function loadToken()
	if type(readfile) ~= "function" then
		return nil
	end

	local ok, token = pcall(readfile, ".potassium-mcp-token")
	if not ok or type(token) ~= "string" then
		return nil
	end
	token = string.gsub(token, "^%s+", "")
	token = string.gsub(token, "%s+$", "")
	if #token < 32 or #token > MAX_TOKEN_BYTES then
		return nil
	end
	return token
end
local token = loadToken()

local NONCE_BYTES = 32
local NONCE_HEX_LENGTH = NONCE_BYTES * 2

local function isHex(value, expectedLength)
	return type(value) == "string" and #value == expectedLength and string.match(value, "^[%x]+$") ~= nil
end
local function isProof(value)
	return type(value) == "string" and #value == 44 and string.match(value, "^[%w%+%/]+=$") ~= nil
end

local function bytesToHex(value)
	return (string.gsub(value, ".", function(character)
		return string.format("%02x", string.byte(character))
	end))
end

local function sha256(value)
	if type(crypt) ~= "table" or type(crypt.hash) ~= "function" then
		return nil
	end
	local ok, digest = pcall(crypt.hash, value, "sha256")
	if not ok or not isHex(digest, 64) then
		return nil
	end
	return string.lower(digest)
end

local function hmacSha256(key, message)
	if
		type(key) ~= "string"
		or type(message) ~= "string"
		or type(crypt) ~= "table"
		or type(crypt.hmac) ~= "function"
	then
		return nil
	end
	local ok, digest = pcall(crypt.hmac, key, message, "sha256")
	return ok and isProof(digest) and digest or nil
end

local function secureRandomNonce()
	if type(crypt) == "table" and type(crypt.random) == "function" then
		local ok, random = pcall(crypt.random, NONCE_BYTES)
		if ok and type(random) == "string" then
			if #random == NONCE_BYTES then
				return bytesToHex(random)
			end
			if isHex(random, NONCE_HEX_LENGTH) then
				return string.lower(random)
			end
		end
	end

	local ok, first, second = pcall(function()
		return HttpService:GenerateGUID(false), HttpService:GenerateGUID(false)
	end)
	if not ok then
		return nil
	end
	local combined = string.lower(string.gsub(tostring(first) .. tostring(second), "%-", ""))
	return isHex(combined, NONCE_HEX_LENGTH) and combined or nil
end

local function handshakeProof(role, clientNonce, serverNonce)
	if role ~= "client" and role ~= "server" then
		return nil
	end
	local transcript = "potassium-mcp/v" .. PROTOCOL .. "|" .. role .. "|" .. clientNonce .. "|" .. serverNonce
	local transcriptHash = sha256(transcript)
	return transcriptHash and hmacSha256(token, transcriptHash) or nil
end

local function proofsMatch(expected, actual)
	if not isProof(expected) or not isProof(actual) then
		return false
	end
	local difference = 0
	for index = 1, 44 do
		difference = bit32.bor(difference, bit32.bxor(string.byte(expected, index), string.byte(actual, index)))
	end
	return difference == 0
end

local sharedEnvironment = _G
if type(getgenv) == "function" then
	local ok, environment = pcall(getgenv)
	if ok and type(environment) == "table" then
		sharedEnvironment = environment
	end
end
if
	sharedEnvironment ~= _G
	and type(_G.PotassiumMcp) == "table"
	and sharedEnvironment.PotassiumMcp ~= _G.PotassiumMcp
then
	sharedEnvironment.PotassiumMcp = _G.PotassiumMcp
	sharedEnvironment.PotassiumMcpGeneration = _G.PotassiumMcpGeneration
end

local previous = sharedEnvironment.PotassiumMcp
if
	type(previous) == "table"
	and (
		previous.socket ~= nil
		or (tonumber(previous.inFlightRequests) or 0) > 0
		or previous.rawExecutionActive
		or (tonumber(previous.asyncActiveJobs) or 0) > 0
		or previous.asyncWorkerScheduled
	)
then
	warn("[Potassium MCP] Bootstrap reload refused while the prior session owns active work")
	return
end

local cryptoAvailable = secureRandomNonce() ~= nil and hmacSha256("capability-check", "potassium-mcp-v2") ~= nil
local webSocketConnect = type(WebSocket) == "table" and type(WebSocket.connect) == "function" and WebSocket.connect
	or nil

local startupStatus, startupReason = "connecting", nil
if not token then
	startupStatus, startupReason = "disabled", "authentication token unavailable"
elseif not cryptoAvailable then
	startupStatus, startupReason = "disabled", "secure cryptography unavailable"
elseif not webSocketConnect then
	startupStatus, startupReason = "disabled", "WebSocket.connect unavailable"
end

local generation = math.max(
	tonumber(sharedEnvironment.PotassiumMcpGeneration) or 0,
	tonumber(_G.PotassiumMcpGeneration) or 0
) + 1
sharedEnvironment.PotassiumMcpGeneration = generation
_G.PotassiumMcpGeneration = generation
local clientId = string.sub(secureRandomNonce() or "", 1, 32)
local state = {
	active = token ~= nil and cryptoAvailable and webSocketConnect ~= nil,
	clientId = clientId,
	generation = generation,
	acknowledged = false,
	connected = false,
	socket = nil,
	socketConnections = {},
	handshake = nil,
	handshakeGeneration = 0,
	lastPongAt = 0,
	startupStatus = startupStatus,
	startupReason = startupReason,
	reconnectScheduled = false,
	reconnectAttempt = 0,
	connectionTimeoutGeneration = 0,
	inFlightRequests = 0,
	requestCounts = { read = 0, control = 0, mutation = 0 },
	peakInFlightRequests = 0,
	rejectedRequests = 0,
	duplicateRequestIds = 0,
	activeRequestIds = {},
	rawExecutionActive = false,
	rawExecutionOwner = nil,
	asyncJobs = {},
	asyncQueue = {},
	asyncQueueHead = 1,
	asyncActiveJobs = 0,
	asyncTerminalOrder = {},
	asyncTerminalHead = 1,
	asyncTerminalCount = 0,
	asyncWorkerScheduled = false,
	watches = {},
	activeWatches = 0,
	watchTerminalOrder = {},
	lifecycleTimer = nil,
	observers = {},
	instanceReferences = {},
	instanceReferenceReverse = {},
	instanceReferenceCount = 0,
	instanceReferenceCounter = 0,
	remoteWorkflow = {
		snapshots = {}, snapshotOrder = {}, snapshotBytes = 0,
		captures = {}, captureOrder = {}, activeCaptures = 0,
	},
	actionObservations = { records = {}, order = {}, active = 0 },
	mapSnapshots = { records = {}, order = {}, reverse = {}, count = 0, bytes = 0, counter = 0 },
	mapRecordings = { records = {}, order = {}, active = 0 },
	tornDown = false,
}

if type(previous) == "table" then
	previous.active = false
	if type(previous.teardown) == "function" then
		pcall(previous.teardown)
	end
	pcall(function()
		if previous.socket then
			previous.socket:Close()
		end
	end)
end
sharedEnvironment.PotassiumMcp = state
_G.PotassiumMcp = state

local function isCurrent()
	return state.active
		and sharedEnvironment.PotassiumMcpGeneration == generation
		and sharedEnvironment.PotassiumMcp == state
		and _G.PotassiumMcpGeneration == generation
		and _G.PotassiumMcp == state
end

local function disconnectConnections(connections)
	for _, connection in pairs(connections) do
		pcall(function()
			connection:Disconnect()
		end)
	end
	table.clear(connections)
end

local function strictInteger(value, default, minimum, maximum, field)
	if value == nil then
		return default
	end
	if type(value) ~= "number" or value ~= value or value < minimum or value > maximum or value % 1 ~= 0 then
		error(field .. " must be an integer from " .. minimum .. " to " .. maximum, 0)
	end
	return value
end

local scheduleLifecycleSweep

local function startConnectionTimeout()
	state.connectionTimeoutGeneration = state.connectionTimeoutGeneration + 1
	local timeoutGeneration = state.connectionTimeoutGeneration
	task.delay(CONNECTION_TIMEOUT_SECONDS, function()
		if not isCurrent() or state.acknowledged or state.connectionTimeoutGeneration ~= timeoutGeneration then
			return
		end

		local socket = state.socket
		state.connected = false
		state.acknowledged = false
		state.handshake = nil
		state.handshakeGeneration = state.handshakeGeneration + 1
		state.startupStatus = "connection_unavailable"
		state.startupReason = "connection timed out"
		if socket then
			pcall(function()
				socket:Close()
			end)
		end
	end)
end

local function cancelConnectionTimeout()
	state.connectionTimeoutGeneration = state.connectionTimeoutGeneration + 1
end

local function safeProperty(instance, property)
	local ok, value = pcall(function()
		return instance[property]
	end)
	if ok then
		return value
	end
	return nil
end

local redaction = { secretKeys = { "apikey", "auth", "bearer", "clientsecret", "cookie", "credential",
	"pass", "privatekey", "secret", "session", "sig", "token" } }
function redaction.patterns()
	local patterns = {}
	local player = Players.LocalPlayer
	local secrets = { token, game.JobId }
	if player then
		table.insert(secrets, safeProperty(player, "Name"))
		table.insert(secrets, safeProperty(player, "DisplayName"))
		table.insert(secrets, tostring(safeProperty(player, "UserId") or ""))
	end
	for _, secret in ipairs(secrets) do
		if type(secret) == "string" and secret ~= "" then
			local pattern = string.gsub(secret, "([^%w])", "%%%1")
			table.insert(patterns, pattern)
		end
	end
	return patterns
end
function redaction.sensitiveKey(key)
	if type(key) ~= "string" then return false end
	local normalized = string.gsub(string.lower(key), "[_%-]", "")
	-- Mirrors safe-read.js commonSecretKey (unanchored, intentionally broad).
	for _, word in ipairs(redaction.secretKeys) do
		if string.find(normalized, word, 1, true) then return true end
	end
	return false
end
function redaction.text(value, patterns, maximum)
	local output = value
	for _, pattern in ipairs(patterns) do
		output = string.gsub(output, pattern, "[redacted]")
		if maximum and #output > maximum then return nil end
	end
	output = string.gsub(output, "[Bb]earer%s+[%w%-%._~%+/%=]+", "[redacted]")
	if maximum and #output > maximum then return nil end
	output = string.gsub(output, "https?://[^%s]+", "[redacted]")
	if maximum and #output > maximum then return nil end
	output = string.gsub(output, "%f[%d]%d%d%d%d%d%d%d%d+%f[^%d]", "[redacted]")
	if maximum and #output > maximum then return nil end
	return output
end
local function redactString(value)
	if type(value) ~= "string" then return value end
	local output = redaction.text(value, redaction.patterns())
	if #output > 4096 then
		output = string.sub(output, 1, 4093) .. "..."
	end
	return output
end

local function safePath(instance)
	local ok, path = pcall(function()
		return instance:GetFullName()
	end)
	return ok and redactString(path) or "[unavailable]"
end
local function newWorkBudget()
	return {
		items = 0,
		startedAt = os.clock(),
	}
end

local function checkpointWork(budget, items)
	if budget.cancelled and budget.cancelled() then error("Read interrupted", 0) end
	budget.items = budget.items + (items or 1)
	if budget.maxItems then
		budget.totalItems = (budget.totalItems or 0) + (items or 1)
		if budget.totalItems > budget.maxItems then
			error("Read work limit exceeded", 0)
		end
	end
	if budget.items < WORK_SLICE_ITEMS and os.clock() - budget.startedAt < WORK_SLICE_SECONDS then
		return
	end
	task.wait()
	if budget.cancelled and budget.cancelled() then error("Read interrupted", 0) end
	budget.items = 0
	budget.startedAt = os.clock()
end

local function consumeSerializeBudget(budget, items, bytes)
	if budget and budget.shared and not consumeSerializeBudget(budget.shared, items, bytes) then
		return false
	end
	if not budget then
		return true
	end
	budget.items = budget.items + (items or 0)
	budget.bytes = budget.bytes + (bytes or 0)
	return budget.items <= budget.maxItems and budget.bytes <= budget.maxBytes
end

local function serialize(value, seen, depth, budget)
	if not consumeSerializeBudget(budget, 1, 16) then
		return nil, "Async result serialization budget exceeded"
	end

	local valueType = typeof(value)
	if value == nil then
		if not consumeSerializeBudget(budget, 0, 14) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "nil" }
	end
	if valueType == "boolean" then
		return value
	end
	if valueType == "string" then
		local redacted = redactString(value)
		if not consumeSerializeBudget(budget, 0, #redacted + 2) then
			return nil, "Async result serialization budget exceeded"
		end
		return redacted
	end
	if valueType == "number" then
		if value ~= value then
			return { type = "number", value = "nan" }
		elseif value == math.huge then
			return { type = "number", value = "inf" }
		elseif value == -math.huge then
			return { type = "number", value = "-inf" }
		end
		return value
	end
	if valueType == "Vector3" then
		if not consumeSerializeBudget(budget, 3, 64) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "Vector3", x = value.X, y = value.Y, z = value.Z }
	end
	if valueType == "Vector2" then
		if not consumeSerializeBudget(budget, 2, 48) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "Vector2", x = value.X, y = value.Y }
	end
	if valueType == "Color3" then
		if not consumeSerializeBudget(budget, 3, 64) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "Color3", r = value.R, g = value.G, b = value.B }
	end
	if valueType == "CFrame" then
		if not consumeSerializeBudget(budget, 13, 256) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "CFrame", components = { value:GetComponents() } }
	end
	if valueType == "UDim" then
		if not consumeSerializeBudget(budget, 2, 48) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "UDim", scale = value.Scale, offset = value.Offset }
	end
	if valueType == "UDim2" then
		if not consumeSerializeBudget(budget, 6, 112) then
			return nil, "Async result serialization budget exceeded"
		end
		return {
			type = "UDim2",
			x = { scale = value.X.Scale, offset = value.X.Offset },
			y = { scale = value.Y.Scale, offset = value.Y.Offset },
		}
	end
	if valueType == "Rect" then
		if not consumeSerializeBudget(budget, 6, 112) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "Rect", min = { x = value.Min.X, y = value.Min.Y }, max = { x = value.Max.X, y = value.Max.Y } }
	end
	if valueType == "BrickColor" then
		local name = redactString(value.Name)
		if not consumeSerializeBudget(budget, 2, #name + 48) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "BrickColor", number = value.Number, name = name }
	end
	if valueType == "NumberRange" then
		if not consumeSerializeBudget(budget, 2, 48) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "NumberRange", min = value.Min, max = value.Max }
	end
	if valueType == "Instance" then
		local name = redactString(value.Name)
		local path = safePath(value)
		if not consumeSerializeBudget(budget, 3, #name + #path + 80) then
			return nil, "Async result serialization budget exceeded"
		end
		return {
			type = "Instance",
			className = value.ClassName,
			name = name,
			path = path,
		}
	end
	if valueType == "EnumItem" then
		local itemValue = redactString(tostring(value))
		if not consumeSerializeBudget(budget, 1, #itemValue + 32) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = "EnumItem", value = itemValue }
	end
	if valueType ~= "table" then
		local text = redactString(tostring(value))
		if not consumeSerializeBudget(budget, 1, #valueType + #text + 32) then
			return nil, "Async result serialization budget exceeded"
		end
		return { type = valueType, value = text }
	end

	seen = seen or {}
	depth = depth or 0
	if seen[value] then
		return { type = "cycle" }
	end
	if depth >= MAX_SERIALIZE_DEPTH then
		return { type = "truncated", reason = "depth" }
	end
	if not consumeSerializeBudget(budget, 0, 2) then
		return nil, "Async result serialization budget exceeded"
	end

	seen[value] = true
	local output = {}
	local count = 0
	local truncated = false
	for key, child in pairs(value) do
		count = count + 1
		if count > MAX_TABLE_ITEMS then
			truncated = true
			break
		end
		local serializedKey = redactString(tostring(key))
		if not consumeSerializeBudget(budget, 0, #serializedKey + 4) then
			seen[value] = nil
			return nil, "Async result serialization budget exceeded"
		end
		local serializedChild, serializationError = serialize(child, seen, depth + 1, budget)
		if serializedChild == nil then
			seen[value] = nil
			return nil, serializationError
		end
		output[serializedKey] = serializedChild
	end
	seen[value] = nil
	if truncated then
		if not consumeSerializeBudget(budget, 0, #"__truncated" + 6) then
			return nil, "Async result serialization budget exceeded"
		end
		output.__truncated = true
	end
	return output
end

local function isInstanceReference(reference)
	return type(reference) == "string"
		and #reference == 43
		and string.sub(reference, 1, 11) == "instance://"
		and string.match(string.sub(reference, 12), "^[0-9a-f]+$") ~= nil
end

local function referenceBindings(params)
	if params and params.includeReferences ~= nil and type(params.includeReferences) ~= "boolean" then
		error("includeReferences must be a boolean", 0)
	end
	return params and params.includeReferences and {} or nil
end

local function releaseInstanceReference(reference)
	local entry = state.instanceReferences[reference]
	if not entry then
		return false
	end
	if entry.connection then
		entry.connection:Disconnect()
		entry.connection = nil
	end
	if entry.instance then
		state.instanceReferenceReverse[entry.instance] = nil
		entry.instance = nil
	end
	state.instanceReferences[reference] = nil
	state.instanceReferenceCount = state.instanceReferenceCount - 1
	return true
end

local function rollbackInstanceReferences(requestContext)
	for _, entry in ipairs(requestContext.createdReferenceEntries) do
		if state.instanceReferences[entry.reference] == entry then
			releaseInstanceReference(entry.reference)
		end
	end
	if state.remoteWorkflow.rollback then state.remoteWorkflow.rollback(requestContext) end
	if state.actionObservations.rollback then state.actionObservations.rollback(requestContext) end
	if state.mapSnapshots.rollback then state.mapSnapshots.rollback(requestContext) end
	if state.mapRecordings.rollback then state.mapRecordings.rollback(requestContext) end
	table.clear(requestContext.createdReferenceEntries)
end

-- Traversals may yield. Reference ownership is committed only after every emitted
-- summary is known, without yielding and with all new listeners staged together.
local function commitInstanceReferences(bindings, requestContext)
	if not bindings or #bindings == 0 then
		return
	end
	if not isCurrent() or state.tornDown or not requestContext
		or not requestContext.socket or state.socket ~= requestContext.socket or not state.acknowledged then
		error("Instance reference unavailable", 0)
	end
	local entries, pending, staged = {}, {}, {}
	for _, binding in ipairs(bindings) do
		local instance = binding.instance
		local entry = state.instanceReferenceReverse[instance] or pending[instance]
		if not entry then
			local ok, reachable = pcall(function()
				return instance == game or instance:IsDescendantOf(game)
			end)
			if not ok or not reachable then
				error("Instance reference unavailable", 0)
			end
			entry = { instance = instance }
			pending[instance] = entry
			table.insert(staged, entry)
		end
		entries[binding] = entry
	end
	if state.instanceReferenceCount + #staged > MAX_INSTANCE_REFERENCES then
		error("Instance reference capacity exceeded", 0)
	end
	if #staged > 0 and not state.instanceReferencePrefix then
		local nonce = secureRandomNonce()
		if not nonce then
			error("Instance reference identity unavailable", 0)
		end
		state.instanceReferencePrefix = string.sub(nonce, 1, 24)
	end
	local ok = pcall(function()
		for _, entry in ipairs(staged) do
			if state.instanceReferenceCounter >= 4294967295 then
				error("Instance reference identity exhausted", 0)
			end
			state.instanceReferenceCounter = state.instanceReferenceCounter + 1
			entry.reference = "instance://" .. state.instanceReferencePrefix
				.. string.format("%08x", state.instanceReferenceCounter)
			entry.connection = entry.instance.Destroying:Connect(function()
				local instance = entry.instance
				if instance and state.instanceReferenceReverse[instance] == entry then
					state.instanceReferenceReverse[instance] = nil
				end
				entry.instance = nil
				if entry.connection then
					entry.connection:Disconnect()
					entry.connection = nil
				end
				entry.destroyed = true
			end)
			if not entry.instance then
				error("Instance reference unavailable", 0)
			end
		end
	end)
	if not ok then
		for _, entry in ipairs(staged) do
			if entry.connection then
				pcall(function()
					entry.connection:Disconnect()
				end)
			end
		end
		error("Instance reference acquisition failed", 0)
	end
	for _, entry in ipairs(staged) do
		state.instanceReferences[entry.reference] = entry
		state.instanceReferenceReverse[entry.instance] = entry
		state.instanceReferenceCount = state.instanceReferenceCount + 1
		table.insert(requestContext.createdReferenceEntries, entry)
	end
	for _, binding in ipairs(bindings) do
		binding.summary.reference = entries[binding].reference
	end
end

local function finishReferenceResult(result, bindings, maximumBytes, requestContext)
	if bindings then
		for _, binding in ipairs(bindings) do
			binding.summary.reference = "instance://" .. string.rep("0", 32)
		end
		-- A maximally escaped request ID and the response envelope still fit.
		local ok, encoded = pcall(HttpService.JSONEncode, HttpService, result)
		if not ok or type(encoded) ~= "string" or #encoded > maximumBytes then
			error("Reference result limit exceeded", 0)
		end
		commitInstanceReferences(bindings, requestContext)
	end
	return result
end

local function referenceResultLimit(params)
	return strictInteger(params and params._maxResultBytes, MAX_MESSAGE_BYTES - 2048,
		1, MAX_MESSAGE_BYTES - 2048, "_maxResultBytes")
end

local function resolvePath(path)
	if type(path) ~= "string" or path == "" then
		return nil, "Path must be a non-empty string"
	end
	-- Reserve the URI namespace before dotted traversal, including malformed
	-- spellings: a reference must never fall back to a similarly named child.
	if string.find(string.lower(path), "instance://", 1, true) then
		local entry = isInstanceReference(path) and state.instanceReferences[path] or nil
		if not isCurrent() or not entry or not entry.instance then
			return nil, "Instance reference unavailable"
		end
		return entry.instance
	end

	local current = game
	local first = true
	for segment in string.gmatch(path, "[^%.]+") do
		if first and string.lower(segment) == "game" then
			first = false
			continue
		end
		if first and string.lower(segment) == "workspace" then
			current = workspace
		else
			current = current:FindFirstChild(segment)
		end
		first = false
		if not current then
			return nil, "Instance not found at segment: " .. segment
		end
	end
	return current
end

local function instanceSummary(instance, bindings, serializationBudget)
	local summary = {
		name = redactString(instance.Name),
		className = instance.ClassName,
		path = safePath(instance),
	}
	if instance:IsA("BasePart") then
		summary.position = serialize(instance.Position, nil, nil, serializationBudget)
		summary.size = serialize(instance.Size, nil, nil, serializationBudget)
		if summary.position == nil or summary.size == nil then
			error("Summary serialization limit exceeded", 0)
		end
		summary.transparency = instance.Transparency
		summary.canCollide = instance.CanCollide
	elseif instance:IsA("ValueBase") then
		local value, serializationError = serialize(safeProperty(instance, "Value"), nil, nil, serializationBudget)
		if serializationError then
			error("Summary serialization limit exceeded", 0)
		end
		summary.value = value
	end
	if bindings then
		table.insert(bindings, { summary = summary, instance = instance })
	end
	return summary
end

local function sortedChildren(instance, capacity, budget, requireTotal)
	budget = budget or newWorkBudget()
	capacity = math.max(0, capacity or 0)
	-- Traversals need only the overflow bit once their queue is full. The two
	-- public direct-child count consumers opt in to exact GetChildren totals.
	if capacity == 0 and not requireTotal then
		return {}, instance:FindFirstChildWhichIsA("Instance") ~= nil
	end
	local children = instance:GetChildren()
	if capacity == 0 then
		return {}, #children > 0, #children
	end
	local retained = table.create(math.min(#children, capacity + 1))
	local sentinelCapacity = capacity + 1
	local function siftDown(index)
		while true do
			local left = index * 2
			if left > #retained then
				break
			end
			local right = left + 1
			local largest = right <= #retained and retained[right].path > retained[left].path and right or left
			if retained[index].path >= retained[largest].path then
				break
			end
			retained[index], retained[largest] = retained[largest], retained[index]
			index = largest
			checkpointWork(budget)
		end
	end
	for _, child in ipairs(children) do
		local path = safePath(child)
		if #retained < sentinelCapacity then
			local index = #retained + 1
			while index > 1 do
				local parent = math.floor(index / 2)
				if retained[parent].path >= path then
					break
				end
				retained[index] = retained[parent]
				index = parent
				checkpointWork(budget)
			end
			retained[index] = { instance = child, path = path }
		elseif path < retained[1].path then
			retained[1] = { instance = child, path = path }
			siftDown(1)
		end
		checkpointWork(budget)
	end
	local truncated = #retained > capacity
	if truncated then
		retained[1] = retained[#retained]
		retained[#retained] = nil
		siftDown(1)
		checkpointWork(budget)
	end
	local selected = table.create(#retained)
	for index = #retained, 1, -1 do
		local entry = retained[1]
		local last = retained[#retained]
		retained[#retained] = nil
		if #retained > 0 then
			retained[1] = last
			siftDown(1)
		end
		selected[index] = entry.instance
		checkpointWork(budget)
	end
	return selected, truncated, #children
end

local function boundedTraversal(root, maxVisited, visit)
	local queue = { root }
	local head = 1
	local visited = 0
	local truncated = false
	local budget = newWorkBudget()
	while head <= #queue and visited < maxVisited do
		local node = queue[head]
		head = head + 1
		visited = visited + 1
		visit(node)
		checkpointWork(budget)
		local children, childrenTruncated = sortedChildren(node, maxVisited - #queue, budget)
		if childrenTruncated then
			truncated = true
		end
		for _, child in ipairs(children) do
			table.insert(queue, child)
			checkpointWork(budget)
		end
	end
	if head <= #queue then
		truncated = true
	end
	return visited, truncated
end

local SAFE_PROPERTIES = {
	Archivable = true,
	Name = true,
	Parent = true,
	ClassName = true,
	Position = true,
	Size = true,
	CFrame = true,
	Color = true,
	Material = true,
	Transparency = true,
	CanCollide = true,
	CanQuery = true,
	CanTouch = true,
	Anchored = true,
	AssemblyLinearVelocity = true,
	Health = true,
	MaxHealth = true,
	WalkSpeed = true,
	JumpPower = true,
	RigType = true,
	MoveDirection = true,
	Visible = true,
	Text = true,
	TextColor3 = true,
	BackgroundColor3 = true,
	BackgroundTransparency = true,
	AbsolutePosition = true,
	AbsoluteSize = true,
	Position = true,
	CanvasPosition = true,
	CanvasSize = true,
	Enabled = true,
	ResetOnSpawn = true,
	ZIndexBehavior = true,
	Value = true,
}

local function readablePropertyName(property)
	return type(property) == "string"
		and #property <= 64
		and string.match(property, "^[A-Za-z_][A-Za-z0-9_]*$")
		and SAFE_PROPERTIES[property]
		and not string.find(string.lower(property), "source", 1, true)
		and not string.find(string.lower(property), "script", 1, true)
end

local function propertyResult(instance, property, serializationBudget)
	if not readablePropertyName(property) then
		return { ok = false, error = "Property is not readable" }
	end
	local ok, value = pcall(function()
		return instance[property]
	end)
	if not ok then
		return { ok = false, error = "Property unavailable" }
	end
	local serialized, serializationError = serialize(value, nil, nil, serializationBudget)
	if serializationError then
		return { ok = false, error = "Property serialization limit exceeded" }
	end
	return { ok = true, value = serialized }
end

local function inspectInstance(instance, depth, childLimit, bindings)
	local remaining = childLimit
	local budget = newWorkBudget()
	local function visit(node, level)
		local result = instanceSummary(node, bindings)
		local ok, attributes = pcall(function()
			return node:GetAttributes()
		end)
		if ok then
			result.attributes = serialize(attributes)
		end
		if level <= 0 then
			return result
		end

		result.children = {}
		local children, childrenTruncated = sortedChildren(node, remaining, budget)
		if childrenTruncated then
			result.childrenTruncated = true
		end
		for _, child in ipairs(children) do
			if remaining <= 0 then
				result.childrenTruncated = true
				break
			end
			remaining = remaining - 1
			table.insert(result.children, visit(child, level - 1))
			checkpointWork(budget)
		end
		return result
	end
	return visit(instance, depth)
end

local handlers = {}
local function asyncErrorMessage(errorMessage)
	local message = redactString(tostring(errorMessage or "Async execution failed"))
	message = string.match(message, "^[^\r\n]*") or "Async execution failed"
	message = string.gsub(message, "[%c]", " ")
	message = string.gsub(message, "%s+", " ")
	message = string.gsub(message, "^%s+", "")
	message = string.gsub(message, "%s+$", "")
	if message == "" then
		message = "Async execution failed"
	end
	if #message > MAX_ERROR_MESSAGE_BYTES then
		message = string.sub(message, 1, MAX_ERROR_MESSAGE_BYTES - 3) .. "..."
	end
	return message
end

local function isResourceId(id)
	return type(id) == "string" and #id == 32 and string.match(id, "^[a-f0-9]+$") ~= nil
end

local function appendAsyncConsole(job, message, messageType)
	if job.state ~= "running" or job.cancellationRequested then
		return
	end
	local text = redactString(tostring(message or ""))
	if #text > MAX_ASYNC_CONSOLE_BYTES then
		text = string.sub(text, 1, MAX_ASYNC_CONSOLE_BYTES)
	end
	local bytes = #text
	while
		#job.console > 0
		and (#job.console >= MAX_ASYNC_CONSOLE_ENTRIES or job.consoleBytes + bytes > MAX_ASYNC_CONSOLE_BYTES)
	do
		local removed = table.remove(job.console, 1)
		job.consoleBytes = math.max(0, job.consoleBytes - #(removed.text or ""))
	end
	if bytes > MAX_ASYNC_CONSOLE_BYTES then
		return
	end
	job.consoleCursor = job.consoleCursor + 1
	table.insert(job.console, {
		cursor = job.consoleCursor,
		text = text,
		messageType = tostring(messageType),
		timestamp = os.time(),
	})
	job.consoleBytes = job.consoleBytes + bytes
end

local function asyncOutputWrapper(job, original, messageType)
	return function(...)
		local count = select("#", ...)
		local parts = {}
		for index = 1, math.min(count, 64) do
			parts[index] = tostring(select(index, ...))
		end
		if count > 64 then
			parts[65] = "..."
		end
		pcall(appendAsyncConsole, job, table.concat(parts, "\t"), messageType)
		return original(...)
	end
end

local function installAsyncOutputCapture(job)
	if type(getfenv) ~= "function" or type(setfenv) ~= "function" then
		return false
	end
	local ok, base = pcall(getfenv, job.chunk)
	if not ok or type(base) ~= "table" then
		return false
	end
	local environment = setmetatable({}, { __index = base })
	if type(base.print) == "function" then
		environment.print = asyncOutputWrapper(job, base.print, "MessageOutput")
	end
	if type(base.warn) == "function" then
		environment.warn = asyncOutputWrapper(job, base.warn, "MessageWarning")
	end
	local installed = pcall(setfenv, job.chunk, environment)
	return installed
end

local function pruneAsyncJobs()
	local now = os.time()
	while state.asyncTerminalHead <= #state.asyncTerminalOrder do
		local jobId = state.asyncTerminalOrder[state.asyncTerminalHead]
		local job = state.asyncJobs[jobId]
		if
			job
			and now - job.finishedAt < ASYNC_JOB_RETENTION_SECONDS
			and state.asyncTerminalCount <= MAX_RETAINED_ASYNC_JOBS
		then
			break
		end
		state.asyncJobs[jobId] = nil
		state.asyncTerminalHead = state.asyncTerminalHead + 1
		state.asyncTerminalCount = math.max(0, state.asyncTerminalCount - 1)
	end
	if state.asyncTerminalHead > 64 then
		local retained = {}
		for index = state.asyncTerminalHead, #state.asyncTerminalOrder do
			table.insert(retained, state.asyncTerminalOrder[index])
		end
		state.asyncTerminalOrder = retained
		state.asyncTerminalHead = 1
	end
end

local function disconnectAsyncConnections(job)
	disconnectConnections(job.connections)
	if job.consoleConnection then
		pcall(function()
			job.consoleConnection:Disconnect()
		end)
		job.consoleConnection = nil
	end
end

local function completeAsyncJob(job, terminalState, result, errorMessage)
	if job.state ~= "queued" and job.state ~= "running" then
		return
	end
	job.state = terminalState
	disconnectAsyncConnections(job)
	job.finishedAt = os.time()
	job.result = result
	job.error = errorMessage
	job.chunk = nil
	job.code = nil
	job.packed = nil
	job.callable = nil
	job.arguments = nil
	state.asyncActiveJobs = math.max(0, state.asyncActiveJobs - 1)
	table.insert(state.asyncTerminalOrder, job.jobId)
	state.asyncTerminalCount = state.asyncTerminalCount + 1
	pruneAsyncJobs()
end

local function requestAsyncCancellation(job)
	if job.state ~= "queued" and job.state ~= "running" then
		return
	end
	job.cancellationRequested = true
	disconnectAsyncConnections(job)
	if job.state == "queued" then
		completeAsyncJob(job, "cancelled")
		-- Remove cancelled IDs even if a non-cooperative job holds the worker indefinitely.
		local pending = {}
		for index = state.asyncQueueHead, #state.asyncQueue do
			local pendingId = state.asyncQueue[index]
			local pendingJob = state.asyncJobs[pendingId]
			if pendingJob and pendingJob.state == "queued" then
				table.insert(pending, pendingId)
			end
		end
		state.asyncQueue = pending
		state.asyncQueueHead = 1
	end
end

local function asyncJobStatus(job)
	return {
		jobId = job.jobId,
		state = job.state,
		submittedAt = job.submittedAt,
		startedAt = job.startedAt,
		finishedAt = job.finishedAt,
		cancellationRequested = job.cancellationRequested,
		kind = job.kind,
		dispatchStarted = job.dispatchStarted,
		dispatchedAt = job.dispatchedAt,
	}
end

local function asyncJobContext(job)
	return {
		isCancellationRequested = function()
			return job.cancellationRequested or not isCurrent()
		end,
		checkpoint = function()
			if job.cancellationRequested or not isCurrent() then
				error("Async job cancellation requested", 0)
			end
		end,
		trackConnection = function(connection)
			if typeof(connection) ~= "RBXScriptConnection" then
				error("trackConnection requires an RBXScriptConnection", 0)
			end
			if job.cancellationRequested or job.state ~= "running" or not isCurrent() then
				connection:Disconnect()
				return connection
			end
			if job.connections[connection] then
				return connection
			end
			if job.trackedConnectionCount >= MAX_ASYNC_TRACKED_CONNECTIONS then
				connection:Disconnect()
				error("Async job tracked connection capacity exceeded", 0)
			end
			job.connections[connection] = connection
			job.trackedConnectionCount = job.trackedConnectionCount + 1
			return connection
		end,
	}
end

local function newResourceId(registry)
	for _ = 1, 4 do
		local ok, guid = pcall(HttpService.GenerateGUID, HttpService, false)
		local id = ok and string.lower(string.gsub(tostring(guid), "%-", "")) or nil
		if isResourceId(id) and not registry[id] then
			return id
		end
	end
	local nonce = secureRandomNonce()
	local id = nonce and string.sub(nonce, 1, 32) or nil
	if isResourceId(id) and not registry[id] then
		return id
	end
	return nil
end

local function asyncResultFromPacked(packed)
	local budget = {
		items = 0,
		bytes = 0,
		maxItems = MAX_ASYNC_SERIALIZED_ITEMS,
		maxBytes = MAX_ASYNC_SERIALIZED_BYTES,
	}
	if not consumeSerializeBudget(budget, 1, 32) then
		return nil, "Async result serialization budget exceeded"
	end
	local values = {}
	for index = 1, packed.n do
		local serialized, serializationError = serialize(packed[index], nil, nil, budget)
		if serialized == nil then
			return nil, serializationError
		end
		values[index] = serialized
	end
	local result = { count = packed.n, values = values }
	local encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, result)
	if not encodedOk or type(encoded) ~= "string" or #encoded > MAX_ASYNC_RESULT_BYTES then
		return nil, "Async result exceeds " .. MAX_ASYNC_RESULT_BYTES .. " bytes"
	end
	return result
end

local function runAsyncWorker()
	while state.asyncQueueHead <= #state.asyncQueue do
		local jobId = state.asyncQueue[state.asyncQueueHead]
		state.asyncQueueHead = state.asyncQueueHead + 1
		if state.asyncQueueHead > 64 then
			local pending = {}
			for index = state.asyncQueueHead, #state.asyncQueue do
				table.insert(pending, state.asyncQueue[index])
			end
			state.asyncQueue = pending
			state.asyncQueueHead = 1
		end
		local job = state.asyncJobs[jobId]
		if job and job.state == "queued" then
			while state.rawExecutionActive and job.state == "queued" and isCurrent() do
				task.wait()
			end
			if not isCurrent() then
				requestAsyncCancellation(job)
			end
			if job.state ~= "queued" then
				continue
			end
			state.rawExecutionActive = true
			state.rawExecutionOwner = "async"
			job.state = "running"
			job.startedAt = os.time()
			local packed
			local ran, runtimeError = xpcall(function()
				if job.callable then
					packed = table.pack(job.callable(job))
					return
				end
				if not installAsyncOutputCapture(job) then
					pcall(function()
						job.consoleConnection = LogService.MessageOut:Connect(function(message, messageType)
							pcall(appendAsyncConsole, job, message, messageType)
						end)
					end)
				end
				packed = table.pack(job.chunk(asyncJobContext(job)))
			end, function(err)
				return debug.traceback(tostring(err), 2)
			end)
			disconnectAsyncConnections(job)
			state.rawExecutionActive = false
			state.rawExecutionOwner = nil
			if (job.cancellationRequested or not isCurrent()) and not (job.kind == "remote_call" and job.dispatchStarted) then
				job.cancellationRequested = true
				completeAsyncJob(job, "cancelled")
			elseif not ran then
				completeAsyncJob(job, "failed", nil, asyncErrorMessage((job.kind == "remote_call" and "Remote call failed: " or "Luau execution failed: ") .. runtimeError))
			else
				local converted, result, resultError = pcall(asyncResultFromPacked, packed)
				if (job.cancellationRequested or not isCurrent()) and not (job.kind == "remote_call" and job.dispatchStarted) then
					job.cancellationRequested = true
					completeAsyncJob(job, "cancelled")
				elseif not converted then
					completeAsyncJob(job, "failed", nil, asyncErrorMessage(result))
				elseif not result then
					completeAsyncJob(job, "failed", nil, asyncErrorMessage(resultError))
				else
					if job.kind == "remote_call" then
						result.dispatchStarted = true
						if job.method == "FireServer" then result.dispatched, result.serverAcknowledged = true, false end
					end
					completeAsyncJob(job, "succeeded", result)
				end
			end
		end
	end
	state.asyncWorkerScheduled = false
end

local function scheduleAsyncWorker()
	if state.asyncWorkerScheduled then
		return
	end
	state.asyncWorkerScheduled = true
	task.defer(runAsyncWorker)
end

local function resourceSnapshot()
	local function connected(connection)
		local ok, value = pcall(function() return connection.Connected end)
		return ok and value == true and 1 or 0
	end
	local function connectionCount(connections)
		local count = 0
		for _, connection in pairs(connections) do count = count + connected(connection) end
		return count
	end
	local now = os.time()
	local jobs = {
		active = state.asyncActiveJobs, queued = 0, running = 0, retained = 0, expiredRetained = 0,
		maxActive = MAX_ACTIVE_ASYNC_JOBS, maxRetained = MAX_RETAINED_ASYNC_JOBS,
	}
	local watches = {
		active = state.activeWatches, retained = 0, maxActive = MAX_ACTIVE_WATCHES,
		maxRetained = MAX_RETAINED_WATCHES, bufferedEvents = 0, bufferedBytes = 0, dropped = 0,
	}
	local references = { live = 0, tombstones = 0, total = state.instanceReferenceCount, max = MAX_INSTANCE_REFERENCES }
	local connections = { socket = connectionCount(state.socketConnections), reference = 0, watch = 0, observer = 0, job = 0 }
	for _, entry in pairs(state.instanceReferences) do
		if entry.instance then references.live = references.live + 1 else references.tombstones = references.tombstones + 1 end
		if entry.connection then connections.reference = connections.reference + connected(entry.connection) end
	end
	for _, job in pairs(state.asyncJobs) do
		if job.state == "queued" or job.state == "running" then
			jobs[job.state] = jobs[job.state] + 1
		else
			jobs.retained = jobs.retained + 1
			if now - job.finishedAt >= ASYNC_JOB_RETENTION_SECONDS then jobs.expiredRetained = jobs.expiredRetained + 1 end
		end
		connections.job = connections.job + connectionCount(job.connections)
		if job.consoleConnection then connections.job = connections.job + connected(job.consoleConnection) end
	end
	for _, watch in pairs(state.watches) do
		if watch.state ~= "active" then watches.retained = watches.retained + 1 end
		watches.bufferedEvents = watches.bufferedEvents + watch.count
		watches.bufferedBytes = watches.bufferedBytes + watch.bytes
		-- Cumulative eviction only for currently retained watches, not a lifetime peak.
		watches.dropped = watches.dropped + watch.cursor - watch.count
		if watch.observer then connections.watch = connections.watch + connectionCount(watch.observer.connections) end
	end
	for _, observer in pairs(state.observers) do
		connections.observer = connections.observer + connectionCount(observer.connections)
	end
	connections.observer = connections.observer - connections.watch
	return {
		version = 1,
		handlers = {
			active = state.inFlightRequests, max = MAX_IN_FLIGHT_REQUESTS, peak = state.peakInFlightRequests,
			rejected = state.rejectedRequests, duplicateIds = state.duplicateRequestIds,
			reads = state.requestCounts.read, controls = state.requestCounts.control, mutations = state.requestCounts.mutation,
		},
		queue = { pending = math.max(0, #state.asyncQueue - state.asyncQueueHead + 1), retainedSlots = #state.asyncQueue },
		jobs = jobs, watches = watches, references = references, connections = connections,
		remoteWorkflow = state.remoteWorkflow.resources and state.remoteWorkflow.resources() or nil,
		actionObservations = state.actionObservations.resources and state.actionObservations.resources() or nil,
		mapSnapshots = state.mapSnapshots.resources and state.mapSnapshots.resources() or nil,
		mapRecordings = state.mapRecordings.resources and state.mapRecordings.resources() or nil,
	}
end

function handlers.capabilities()
	local executorName, executorVersion = "Potassium", nil
	if type(identifyexecutor) == "function" then
		local ok, name, version = pcall(identifyexecutor)
		if ok then
			executorName = tostring(name or executorName)
			executorVersion = version and tostring(version) or nil
		end
	end
	return {
		protocol = PROTOCOL,
		bootstrap = { build = BOOTSTRAP_BUILD, generation = generation },
		resources = resourceSnapshot(),
		executor = executorName,
		version = executorVersion,
		methods = {
			"capabilities",
			"execute_luau_async",
			"async_job_status",
			"async_job_result",
			"async_job_console",
			"async_job_list",
			"async_job_cancel",
			"execute_luau",
			"remote_call",
			"observe_action",
			"client_state",
			"list_children",
			"inspect_instance",
			"find_instances",
			"read_properties",
			"list_tags",
			"diagnostic_snapshot",
			"game_context",
			"map_observe",
			"map_recording",
			"map_probe",
			"script_fingerprint",
			"script_inventory",
			"remote_inventory",
			"remote_capture_start",
			"remote_capture_poll",
			"remote_capture_stop",
			"performance_snapshot",
			"spatial_query",
			"ui_inventory",
			"signal_inventory",
			"observe_changes",
			"watch_start",
			"watch_poll",
			"watch_stop",
			"attribute_inventory",
			"observe_logs",
			"snapshot_diff",
			"multi_read_properties",
			"batch_read",
			"instance_references_release",
			"instance_ancestry",
			"class_summary",
			"overlap_query",
			"subtree_summary",
		},
		remoteInventory = {
			version = 4, maxSnapshots = 8, maxRows = 512, snapshotBytes = 262144,
			totalBytes = 1048576, retentionSeconds = 120, maxWorkItems = MAX_BATCH_WORK_ITEMS,
			atomicSnapshot = false, survivesReconnect = true,
			queryScope = "retained-rows",
			detail = { maxAttributes = 32, maxValueAssociations = 50, defaultValueAssociations = 20,
				metadataTiming = "live-non-atomic", associationMeaning = "metadata-not-call-arguments",
				siblingsDefault = false, retainedIdentity = "snapshot-owned-instance-no-path-rebinding" },
		},
		remoteCapture = state.remoteWorkflow.capabilities(),
		remoteActions = { version = 1, maxArguments = 16, maxNodes = 256, maxDepth = 6, argumentBytes = 65536 },
		actionObservation = { version = 1, maxActive = 4, maxRetained = 8, retentionSeconds = 120,
			maxRequests = 16, maxChanges = 100, observationBytes = 131072, totalBytes = 1048576,
			correlation = "temporal", atomicSnapshot = false },
		diagnosticSnapshot = { version = 2, views = { "overview", "character", "ui", "nearby" } },
		mapObservation = { version = 1, maxTargets = 16, maxDurationMs = 5000, minimumIntervalMs = 50, maxSamplesPerTarget = 101, maxProbeAxis = 8 },
		mapRecording = { version = 1, maxActive = 4, maxRetained = 8, maxTargets = 4,
			maxDurationMs = 60000, minimumIntervalMs = 50, maxFrames = 1201, maxEvents = 256,
			maxMarkers = 32, sampleBytes = 2097152, eventBytes = 65536, retentionSeconds = 120,
			pageFrames = 20, pageBytes = 65536, clock = "client-monotonic-seconds", atomicSnapshot = false },
		gameContext = { version = 2, maxVisited = 20000, maxParts = 512, uiLimit = 40, remoteLimit = 100,
			resultBytes = 32768, atomicSnapshot = false, geometry = "client-visible-basepart-boxes",
			rootScope = "workspace-subtree", uiScope = "player-gui", remoteScope = "replicated-storage",
			remoteMetadata = "name-path-class-only", excludes = { "CoreGui", "LuaSourceContainer" } },
		asyncJobs = {
			version = 2,
			cooperativeCancellation = true,
			maxTrackedConnections = MAX_ASYNC_TRACKED_CONNECTIONS,
			maxActive = MAX_ACTIVE_ASYNC_JOBS,
			maxRetained = MAX_RETAINED_ASYNC_JOBS,
			resultBytes = MAX_ASYNC_RESULT_BYTES,
			retentionSeconds = ASYNC_JOB_RETENTION_SECONDS,
			retentionCleanup = "on-operation",
		},
		watches = {
			version = 1,
			maxActive = MAX_ACTIVE_WATCHES,
			maxRetained = MAX_RETAINED_WATCHES,
			maxEvents = MAX_WATCH_EVENTS,
			bufferBytes = MAX_WATCH_BUFFER_BYTES,
			eventBytes = MAX_WATCH_EVENT_BYTES,
			maxSerializedItems = MAX_WATCH_SERIALIZED_ITEMS,
			maxProperties = MAX_WATCH_PROPERTIES,
			maxConnections = MAX_WATCH_CONNECTIONS,
			minTtlSeconds = 10,
			maxTtlSeconds = 300,
			retentionSeconds = WATCH_RETENTION_SECONDS,
			sweepIntervalSeconds = LIFECYCLE_SWEEP_SECONDS,
		},
		instanceReferences = {
			version = 1,
			scheme = "instance://",
			maxEntries = MAX_INSTANCE_REFERENCES,
			maxRelease = MAX_REFERENCE_RELEASE,
			referenceBytes = 43,
			destroyedEntriesCountTowardCapacity = true,
			survivesReconnect = true,
			sharedAcrossSessions = true,
		},
		batchRead = {
			version = 1,
			maxRequests = MAX_MULTI_READ_REQUESTS,
			maxProperties = MAX_MULTI_READ_PROPERTIES,
			maxAttributes = 32,
			maxChildren = 100,
			maxTotalValues = MAX_MULTI_READ_VALUES,
			resultBytes = MAX_BATCH_RESULT_BYTES,
			valueBytes = MAX_BATCH_VALUE_BYTES,
			maxSerializedItems = MAX_BATCH_SERIALIZED_ITEMS,
			maxSerializedBytes = MAX_BATCH_SERIALIZED_BYTES,
			maxWorkItems = MAX_BATCH_WORK_ITEMS,
			atomicSnapshot = false,
		},
	}
end

function handlers.execute_luau(params)
	local code = params and params.code
	if type(code) ~= "string" or code == "" then
		error("code must be a non-empty string", 0)
	end
	if #code > 32768 then
		error("code exceeds 32768 bytes", 0)
	end
	if type(loadstring) ~= "function" then
		error("loadstring is unavailable", 0)
	end
	local chunk, compileError = loadstring(code, "@potassium-mcp")
	if not chunk then
		error("Luau compilation failed: " .. tostring(compileError), 0)
	end
	if state.rawExecutionActive then
		error("Raw execution is busy", 0)
	end

	state.rawExecutionActive = true
	state.rawExecutionOwner = "sync"
	local packed
	local ok, runtimeError = xpcall(function()
		packed = table.pack(chunk())
	end, function(err)
		return debug.traceback(tostring(err), 2)
	end)
	state.rawExecutionActive = false
	state.rawExecutionOwner = nil
	if not ok then
		error("Luau execution failed: " .. tostring(runtimeError), 0)
	end

	local values = {}
	for index = 1, packed.n do
		values[index] = serialize(packed[index])
	end
	return { count = packed.n, values = values }
end

function handlers.execute_luau_async(params)
	if not isCurrent() then
		error("Bootstrap is not active", 0)
	end
	local code = params and params.code
	if type(code) ~= "string" or code == "" then
		error("code must be a non-empty string", 0)
	end
	if #code > 32768 then
		error("code exceeds 32768 bytes", 0)
	end
	if type(loadstring) ~= "function" then
		error("loadstring is unavailable", 0)
	end
	local chunk, compileError = loadstring(code, "@potassium-mcp-async")
	if not chunk then
		error("Luau compilation failed: " .. tostring(compileError), 0)
	end
	return state.enqueueAsyncJob({ chunk = chunk })
end

function state.enqueueAsyncJob(job)
	if not isCurrent() then error("Bootstrap is not active", 0) end
	pruneAsyncJobs()
	if state.asyncActiveJobs >= MAX_ACTIVE_ASYNC_JOBS then
		error("Async job capacity exceeded", 0)
	end
	local jobId = newResourceId(state.asyncJobs)
	if not jobId then
		error("Unable to allocate async job id", 0)
	end
	job.jobId, job.state, job.submittedAt = jobId, "queued", os.time()
	job.console, job.consoleBytes, job.consoleCursor = {}, 0, 0
	job.cancellationRequested, job.connections, job.trackedConnectionCount = false, {}, 0
	state.asyncJobs[jobId] = job
	state.asyncActiveJobs = state.asyncActiveJobs + 1
	table.insert(state.asyncQueue, jobId)
	scheduleAsyncWorker()
	scheduleLifecycleSweep()
	return { jobId = jobId, state = "queued" }
end

function handlers.async_job_status(params)
	local jobId = params and params.jobId
	if not isResourceId(jobId) then
		error("Invalid async job id", 0)
	end
	pruneAsyncJobs()
	local job = state.asyncJobs[jobId]
	if not job then
		error("Unknown or expired async job", 0)
	end
	return asyncJobStatus(job)
end

function handlers.async_job_list(params)
	if params ~= nil and type(params) ~= "table" then
		error("params must be an object", 0)
	end
	params = params or {}
	local limit = strictInteger(params.limit, 40, 1, 40, "limit")
	pruneAsyncJobs()
	local jobs = {}
	for _, job in pairs(state.asyncJobs) do
		table.insert(jobs, asyncJobStatus(job))
	end
	table.sort(jobs, function(a, b)
		return a.submittedAt < b.submittedAt or (a.submittedAt == b.submittedAt and a.jobId < b.jobId)
	end)
	local truncated = #jobs > limit
	while #jobs > limit do
		table.remove(jobs)
	end
	return { jobs = jobs, truncated = truncated }
end

function handlers.async_job_cancel(params)
	local jobId = params and params.jobId
	if not isResourceId(jobId) then
		error("Invalid async job id", 0)
	end
	pruneAsyncJobs()
	local job = state.asyncJobs[jobId]
	if not job then
		error("Unknown or expired async job", 0)
	end
	requestAsyncCancellation(job)
	return asyncJobStatus(job)
end

function handlers.async_job_console(params)
	local jobId = params and params.jobId
	if not isResourceId(jobId) then
		error("Invalid async job id", 0)
	end
	pruneAsyncJobs()
	local job = state.asyncJobs[jobId]
	if not job then
		error("Unknown or expired async job", 0)
	end
	local afterCursor = tonumber(params.afterCursor) or 0
	if afterCursor < 0 or afterCursor % 1 ~= 0 then
		error("afterCursor must be a non-negative integer", 0)
	end
	local limit = tonumber(params.limit) or MAX_ASYNC_CONSOLE_ENTRIES
	if limit < 1 or limit > MAX_ASYNC_CONSOLE_ENTRIES or limit % 1 ~= 0 then
		error("limit must be an integer from 1 to " .. MAX_ASYNC_CONSOLE_ENTRIES, 0)
	end
	local entries = {}
	local nextCursor = afterCursor
	for _, entry in ipairs(job.console) do
		if entry.cursor > afterCursor then
			table.insert(entries, entry)
			nextCursor = entry.cursor
			if #entries >= limit then
				break
			end
		end
	end
	return { jobId = job.jobId, entries = entries, nextCursor = nextCursor }
end

function handlers.async_job_result(params)
	local jobId = params and params.jobId
	if not isResourceId(jobId) then
		error("Invalid async job id", 0)
	end
	pruneAsyncJobs()
	local job = state.asyncJobs[jobId]
	if not job then
		error("Unknown or expired async job", 0)
	end
	if job.kind ~= "remote_call" then
		if job.state == "queued" or job.state == "running" then
			return { jobId = job.jobId, state = job.state, ready = false }
		end
		if job.state == "succeeded" then return { jobId = job.jobId, state = "succeeded", ready = true, result = job.result } end
		if job.state == "cancelled" then return { jobId = job.jobId, state = "cancelled", ready = true } end
		return { jobId = job.jobId, state = "failed", ready = true, error = job.error }
	end
	local result = asyncJobStatus(job)
	result.ready = job.state ~= "queued" and job.state ~= "running"
	if job.state == "succeeded" then result.result = job.result end
	if job.state == "failed" then result.error = job.error end
	return result
end

function handlers.client_state()
	local player = Players.LocalPlayer
	local character = player and player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	return {
		placeId = game.PlaceId,
		jobIdPresent = type(game.JobId) == "string" and game.JobId ~= "",
		loaded = game:IsLoaded(),
		playerPresent = player ~= nil,
		characterPresent = character ~= nil,
		characterPath = character and safePath(character) or nil,
		position = root and serialize(root.Position) or nil,
		health = humanoid and humanoid.Health or nil,
		maxHealth = humanoid and humanoid.MaxHealth or nil,
	}
end
local function boundedNumber(value, default, minimum, maximum)
	return math.clamp(tonumber(value) or default, minimum, maximum)
end

local function sortSummaries(results)
	table.sort(results, function(a, b)
		if a.path == b.path then
			return (a.className or "") .. (a.name or "") < (b.className or "") .. (b.name or "")
		end
		return a.path < b.path
	end)
end

function handlers.find_instances(params, requestContext)
	local bindings = referenceBindings(params)
	local maximumBytes = referenceResultLimit(params)
	local root, pathError = resolvePath(params and params.root)
	if not root then
		error(pathError, 0)
	end
	local limit = boundedNumber(params.limit, 100, 1, 200)
	local maxVisited = boundedNumber(params.maxVisited, 5000, 1, 20000)
	local nameContains = params.nameContains
	local pathContains = params.pathContains
	if
		(nameContains and (type(nameContains) ~= "string" or #nameContains > 128))
		or (pathContains and (type(pathContains) ~= "string" or #pathContains > 128))
	then
		error("Search filters must be strings up to 128 bytes", 0)
	end
	local classes = {}
	if params.classNames then
		if type(params.classNames) ~= "table" or #params.classNames > 16 then
			error("classNames must contain at most 16 names", 0)
		end
		for _, className in ipairs(params.classNames) do
			if type(className) ~= "string" or #className > 64 then
				error("Class names must be strings up to 64 bytes", 0)
			end
			classes[className] = true
		end
	end
	local results, totalMatches, resultTruncated = {}, 0, false
	local visited, traversalTruncated = boundedTraversal(root, maxVisited, function(node)
		local rawPath = safePath(node)
		local matches = (next(classes) == nil or classes[node.ClassName])
			and (not nameContains or string.find(node.Name, nameContains, 1, true))
			and (not pathContains or string.find(rawPath, pathContains, 1, true))
		if matches then
			totalMatches = totalMatches + 1
			if #results < limit then
				table.insert(results, instanceSummary(node, bindings))
			else
				resultTruncated = true
			end
		end
	end)
	sortSummaries(results)
	local rootSummary = instanceSummary(root, bindings)
	return finishReferenceResult({
		root = rootSummary,
		visited = visited,
		totalMatches = totalMatches,
		truncated = traversalTruncated or resultTruncated,
		results = results,
	}, bindings, maximumBytes, requestContext)
end

function handlers.read_properties(params)
	local instance, pathError = resolvePath(params and params.path)
	if not instance then
		error(pathError, 0)
	end
	if type(params.properties) ~= "table" or #params.properties < 1 or #params.properties > 32 then
		error("properties must contain 1 to 32 names", 0)
	end
	local properties = {}
	for _, property in ipairs(params.properties) do
		if type(property) ~= "string" or #property > 64 or not string.match(property, "^[A-Za-z_][A-Za-z0-9_]*$") then
			error("Invalid property name", 0)
		end
		table.insert(properties, property)
	end
	table.sort(properties)
	local output = {}
	for _, property in ipairs(properties) do
		output[property] = propertyResult(instance, property)
	end
	return { instance = instanceSummary(instance), properties = output }
end

function handlers.list_tags(params)
	local hasPath, hasTag = params and params.path ~= nil, params and params.tag ~= nil
	if hasPath == hasTag then
		error("Specify exactly one of path or tag", 0)
	end
	local limit = boundedNumber(params.limit, 100, 1, 200)
	local collection = game:GetService("CollectionService")
	if hasPath then
		local instance, pathError = resolvePath(params.path)
		if not instance then
			error(pathError, 0)
		end
		local tags = collection:GetTags(instance)
		table.sort(tags)
		local output = {}
		for index = 1, math.min(#tags, limit) do
			output[index] = redactString(tags[index])
		end
		return { instance = instanceSummary(instance), total = #tags, truncated = #tags > limit, tags = output }
	end
	if type(params.tag) ~= "string" or #params.tag > 128 then
		error("tag must be a string up to 128 bytes", 0)
	end
	local tagged = collection:GetTagged(params.tag)
	local results = {}
	for index = 1, math.min(#tagged, limit) do
		table.insert(results, instanceSummary(tagged[index]))
	end
	sortSummaries(results)
	return { tag = redactString(params.tag), total = #tagged, truncated = #tagged > limit, results = results }
end

function handlers.diagnostic_snapshot()
	local player = Players.LocalPlayer
	local character = player and player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	local humanoidState
	if humanoid then
		local ok, value = pcall(function()
			return humanoid:GetState()
		end)
		if ok then
			humanoidState = serialize(value)
		end
	end
	local networkOwner
	if root and type(isnetworkowner) == "function" then
		local ok, value = pcall(isnetworkowner, root)
		if ok and type(value) == "boolean" then
			networkOwner = value
		end
	end
	return {
		place = {
			id = game.PlaceId,
			loaded = game:IsLoaded(),
		},
		workspace = {
			distributedGameTime = safeProperty(workspace, "DistributedGameTime"),
			gravity = workspace.Gravity,
			streamingEnabled = safeProperty(workspace, "StreamingEnabled"),
		},
		character = {
			present = character ~= nil,
			path = character and safePath(character) or nil,
		},
		root = root and {
			anchored = root.Anchored,
			assemblyAngularVelocity = serialize(root.AssemblyAngularVelocity),
			assemblyLinearVelocity = serialize(root.AssemblyLinearVelocity),
			networkOwner = networkOwner,
			position = serialize(root.Position),
			receiveAge = safeProperty(root, "ReceiveAge"),
		} or nil,
		humanoid = humanoid and {
			autoRotate = humanoid.AutoRotate,
			floorMaterial = serialize(humanoid.FloorMaterial),
			health = humanoid.Health,
			hipHeight = humanoid.HipHeight,
			maxHealth = humanoid.MaxHealth,
			platformStand = humanoid.PlatformStand,
			sit = humanoid.Sit,
			state = humanoidState,
			walkSpeed = humanoid.WalkSpeed,
		} or nil,
	}
end

local function inventory(params, predicate)
	local root, pathError = resolvePath(params.root)
	if not root then
		error(pathError, 0)
	end
	local limit = boundedNumber(params.limit, 100, 1, 200)
	local maxVisited = boundedNumber(params.maxVisited, 5000, 1, 20000)
	local results, resultTruncated = {}, false
	local visited, traversalTruncated = boundedTraversal(root, maxVisited, function(node)
		if predicate(node) then
			if #results < limit then
				local item = instanceSummary(node)
				for _, property in ipairs({ "Disabled", "Enabled", "RunContext" }) do
					local value = safeProperty(node, property)
					if value ~= nil then
						item[property] = serialize(value)
					end
				end
				table.insert(results, item)
			else
				resultTruncated = true
			end
		end
	end)
	sortSummaries(results)
	return {
		root = instanceSummary(root),
		visited = visited,
		truncated = traversalTruncated or resultTruncated,
		results = results,
	}
end

local function scriptMetadata(instance)
	local item = instanceSummary(instance)
	for _, property in ipairs({ "Disabled", "Enabled", "RunContext" }) do
		local value = safeProperty(instance, property)
		if value ~= nil then
			item[property] = serialize(value)
		end
	end
	return item
end

local function inventoryScriptsFromList(params, scope, source)
	local limit = boundedNumber(params.limit, 100, 1, 200)
	local maxVisited = boundedNumber(params.maxVisited, 5000, 1, 20000)
	local visited = math.min(#source, maxVisited)
	local totalMatches = 0
	local results = {}
	for index = 1, visited do
		local instance = source[index]
		if
			typeof(instance) == "Instance"
			and (instance:IsA("Script") or instance:IsA("LocalScript") or instance:IsA("ModuleScript"))
		then
			totalMatches = totalMatches + 1
			if #results < limit then
				table.insert(results, scriptMetadata(instance))
			end
		end
	end
	sortSummaries(results)
	return {
		scope = scope,
		visited = visited,
		totalMatches = totalMatches,
		truncated = #source > maxVisited or totalMatches > limit,
		results = results,
	}
end

local function djb2Digest(value)
	local hash = 5381
	for index = 1, #value do
		hash = (hash * 33 + string.byte(value, index)) % 4294967296
	end
	return string.format("%08x", hash)
end

function handlers.script_fingerprint(params)
	local instance, pathError = resolvePath(params and params.path)
	if not instance then
		error(pathError, 0)
	end
	if not (instance:IsA("Script") or instance:IsA("LocalScript") or instance:IsA("ModuleScript")) then
		error("Path must resolve to a Script, LocalScript, or ModuleScript", 0)
	end
	if type(getscriptbytecode) ~= "function" then
		error("Script fingerprinting is unavailable", 0)
	end

	local ok, bytecode = pcall(getscriptbytecode, instance)
	if not ok or type(bytecode) ~= "string" then
		error("Script fingerprinting failed", 0)
	end
	local byteLength = #bytecode
	if byteLength > 4 * 1024 * 1024 then
		error("Script bytecode exceeds 4194304 bytes", 0)
	end

	local algorithm, digest = "djb2-32", nil
	if type(crypt) == "table" and type(crypt.hash) == "function" then
		local hashed, value = pcall(crypt.hash, bytecode, "sha256")
		if hashed and type(value) == "string" and string.match(value, "^[%x]+$") and #value == 64 then
			algorithm, digest = "sha256", string.lower(value)
		end
	end
	digest = digest or djb2Digest(bytecode)
	bytecode = nil

	return {
		metadata = scriptMetadata(instance),
		algorithm = algorithm,
		digest = digest,
		byteLength = byteLength,
	}
end

function handlers.script_inventory(params)
	params = params or {}
	local scope = params.scope
	if scope == "descendants" then
		params.root = params.root or "game"
		return inventory(params, function(node)
			return node:IsA("Script") or node:IsA("LocalScript") or node:IsA("ModuleScript")
		end)
	end
	local getter = scope == "loaded" and getloadedmodules or scope == "running" and getrunningscripts or nil
	if type(getter) ~= "function" then
		if scope ~= "loaded" and scope ~= "running" then
			error("scope must be descendants, loaded, or running", 0)
		end
		error(scope .. " script inventory is unavailable", 0)
	end
	local ok, scripts = pcall(getter)
	if not ok or type(scripts) ~= "table" then
		error(scope .. " script inventory failed", 0)
	end
	return inventoryScriptsFromList(params, scope, scripts)
end


function handlers.list_children(params, requestContext)
	local bindings = referenceBindings(params)
	local maximumBytes = referenceResultLimit(params)
	local instance, pathError = resolvePath(params and params.path)
	if not instance then
		error(pathError, 0)
	end
	local limit = math.clamp(tonumber(params.limit) or 200, 1, 1000)
	local budget = newWorkBudget()
	local children, truncated, total = sortedChildren(instance, limit, budget, true)
	local output = {}
	for index, child in ipairs(children) do
		output[index] = instanceSummary(child, bindings)
		checkpointWork(budget)
	end
	local rootSummary = instanceSummary(instance, bindings)
	return finishReferenceResult({
		instance = rootSummary,
		total = total,
		truncated = truncated,
		children = output,
	}, bindings, maximumBytes, requestContext)
end

function handlers.inspect_instance(params, requestContext)
	local bindings = referenceBindings(params)
	local maximumBytes = referenceResultLimit(params)
	local instance, pathError = resolvePath(params and params.path)
	if not instance then
		error(pathError, 0)
	end
	local depth = math.clamp(tonumber(params.depth) or 0, 0, 3)
	local childLimit = math.clamp(tonumber(params.childLimit) or 100, 1, 500)
	local result = inspectInstance(instance, depth, childLimit, bindings)
	return finishReferenceResult(result, bindings, maximumBytes, requestContext)
end

local function finiteNumber(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function strictVector(value, field)
	if
		type(value) ~= "table"
		or not finiteNumber(value.x)
		or not finiteNumber(value.y)
		or not finiteNumber(value.z)
	then
		error(field .. " must be a finite {x, y, z} vector", 0)
	end
	return Vector3.new(value.x, value.y, value.z)
end


local function readStatNumber(parent, name)
	if not parent then
		return nil
	end
	local found, item = pcall(function()
		return parent:FindFirstChild(name)
	end)
	if not found or not item then
		return nil
	end
	local ok, value = pcall(function()
		return item:GetValue()
	end)
	return ok and finiteNumber(value) and value or nil
end

function handlers.performance_snapshot(params)
	params = params or {}
	local maxVisited = boundedNumber(params.maxVisited, 5000, 1, 20000)
	local maxClassCounts = boundedNumber(params.maxClassCounts, 200, 1, 500)
	local counts = {}
	local visited, traversalTruncated = boundedTraversal(game, maxVisited, function(node)
		counts[node.ClassName] = (counts[node.ClassName] or 0) + 1
	end)
	local classCounts = {}
	for className, count in pairs(counts) do
		table.insert(classCounts, { className = redactString(className), count = count })
	end
	table.sort(classCounts, function(a, b)
		return a.className < b.className
	end)
	local classCountsTruncated = #classCounts > maxClassCounts
	while #classCounts > maxClassCounts do
		table.remove(classCounts)
	end

	local statsOk, stats = pcall(game.GetService, game, "Stats")
	if not statsOk or not stats then
		error("Stats service is unavailable", 0)
	end
	local memory = {}
	local totalMemoryOk, totalMemoryValue = pcall(function()
		return stats:GetTotalMemoryUsageMb()
	end)
	if totalMemoryOk and finiteNumber(totalMemoryValue) then
		memory.totalMb = totalMemoryValue
	end
	for _, tagName in ipairs({
		"Internal",
		"LuaHeap",
		"GraphicsTexture",
		"GraphicsMeshParts",
		"Script",
		"PhysicsCollision",
		"Instances",
		"Gui",
		"Signals",
	}) do
		local tag = Enum.DeveloperMemoryTag[tagName]
		if tag then
			local ok, value = pcall(function()
				return stats:GetMemoryUsageMbForTag(tag)
			end)
			if ok and finiteNumber(value) then
				memory[tagName] = value
			end
		end
	end
	local network = {}
	local serverStats = safeProperty(safeProperty(stats, "Network"), "ServerStatsItem")
	for _, entry in ipairs({
		{ name = "Receive kBps", key = "receiveKbps" },
		{ name = "Send kBps", key = "sendKbps" },
		{ name = "Received Physics Packets", key = "receivedPhysicsPackets" },
		{ name = "Sent Physics Packets", key = "sentPhysicsPackets" },
		{ name = "Data Ping", key = "dataPing" },
		{ name = "Network Ping", key = "networkPing" },
	}) do
		local value = readStatNumber(serverStats, entry.name)
		if value ~= nil then
			network[entry.key] = value
		end
	end
	local physicsFps
	local fpsOk, fpsValue = pcall(function()
		return workspace:GetRealPhysicsFPS()
	end)
	if fpsOk and finiteNumber(fpsValue) then
		physicsFps = fpsValue
	end
	return {
		visited = visited,
		truncated = traversalTruncated or classCountsTruncated,
		classCounts = classCounts,
		classCountsTruncated = classCountsTruncated,
		stats = { memoryAvailable = next(memory) ~= nil },
		workspace = {
			distributedGameTime = safeProperty(workspace, "DistributedGameTime"),
			gravity = safeProperty(workspace, "Gravity"),
			streamingEnabled = safeProperty(workspace, "StreamingEnabled"),
			physicsSteppingMethod = safeProperty(workspace, "PhysicsSteppingMethod") and redactString(
				tostring(safeProperty(workspace, "PhysicsSteppingMethod"))
			) or nil,
			physicsFps = physicsFps,
		},
		memory = memory,
		network = network,
	}
end

local function resolveExcludedPaths(paths)
	local excluded = {}
	if paths == nil then
		return excluded
	end
	if type(paths) ~= "table" or #paths > 16 then
		error("excludePaths must contain at most 16 paths", 0)
	end
	for _, path in ipairs(paths) do
		if type(path) ~= "string" or #path > 1024 then
			error("excludePaths entries must be paths up to 1024 bytes", 0)
		end
		local instance, pathError = resolvePath(path)
		if not instance then
			error(pathError, 0)
		end
		table.insert(excluded, instance)
	end
	return excluded
end

function handlers.overlap_query(params)
	params = params or {}
	local target, pathError = resolvePath(params.path)
	if not target then
		error(pathError, 0)
	end
	if not target:IsA("BasePart") then
		error("path must resolve to a BasePart", 0)
	end
	local maxResults = boundedNumber(params.maxResults, 100, 1, 200)
	local filter = OverlapParams.new()
	filter.FilterType = Enum.RaycastFilterType.Exclude
	filter.FilterDescendantsInstances = resolveExcludedPaths(params.excludePaths)
	filter.MaxParts = maxResults
	local ok, parts = pcall(function()
		return workspace:GetPartsInPart(target, filter)
	end)
	if not ok or type(parts) ~= "table" then
		error("GetPartsInPart is unavailable", 0)
	end
	local results = {}
	for _, part in ipairs(parts) do
		table.insert(results, instanceSummary(part))
	end
	sortSummaries(results)
	return {
		target = instanceSummary(target),
		truncated = #parts >= maxResults,
		results = results,
	}
end

local function scalarAttribute(value)
	local valueType = typeof(value)
	return valueType ~= "table" and valueType ~= "Instance" and valueType ~= "function" and valueType ~= "thread"
end

function handlers.attribute_inventory(params)
	params = params or {}
	local root, pathError = resolvePath(params.path)
	if not root then
		error(pathError, 0)
	end
	local recursive = params.recursive == true
	local limit = boundedNumber(params.limit, 100, 1, 500)
	local maxVisited = boundedNumber(params.maxVisited, 3000, 1, 10000)
	if type(params.attributeNames or {}) ~= "table" or #(params.attributeNames or {}) > 32 then
		error("attributeNames must contain at most 32 names", 0)
	end
	local requested, seenNames = {}, {}
	for _, name in ipairs(params.attributeNames or {}) do
		if type(name) ~= "string" or #name > 128 then
			error("attributeNames entries must be strings up to 128 bytes", 0)
		end
		if not seenNames[name] then
			seenNames[name] = true
			table.insert(requested, name)
		end
	end
	table.sort(requested)
	local results, resultTruncated = {}, false
	local function visit(node)
		local ok, attributes = pcall(function()
			return node:GetAttributes()
		end)
		if not ok then
			return
		end
		local names = #requested > 0 and requested or {}
		if #requested == 0 then
			for name in pairs(attributes) do
				table.insert(names, name)
			end
			table.sort(names)
		end
		local output = {}
		for _, name in ipairs(names) do
			local value = attributes[name]
			if value ~= nil and scalarAttribute(value) then
				table.insert(output, { name = redactString(name), value = serialize(value) })
			end
		end
		if #output == 0 then
			return
		end
		if #results >= limit then
			resultTruncated = true
			return
		end
		table.insert(results, { instance = instanceSummary(node), attributes = output })
	end
	local visited, traversalTruncated
	if recursive then
		visited, traversalTruncated = boundedTraversal(root, maxVisited, visit)
	else
		visited, traversalTruncated = 1, false
		visit(root)
	end
	table.sort(results, function(a, b)
		return a.instance.path < b.instance.path
	end)
	return {
		root = instanceSummary(root),
		visited = visited,
		truncated = traversalTruncated or resultTruncated,
		results = results,
	}
end

local function structuralDigestAdd(hash, text)
	for index = 1, #text do
		hash = bit32.band(hash * 33 + string.byte(text, index), 0xffffffff)
	end
	return hash
end

local function sortedCountEntries(counts)
	local entries = {}
	for name, count in pairs(counts) do
		table.insert(entries, { name = redactString(name), count = count })
	end
	table.sort(entries, function(a, b)
		return a.name < b.name
	end)
	return entries
end

function handlers.subtree_summary(params)
	params = params or {}
	local root, pathError = resolvePath(params.path)
	if not root then
		error(pathError, 0)
	end
	local maxDepth = boundedNumber(params.maxDepth, 4, 0, 8)
	local maxVisited = boundedNumber(params.maxVisited, 5000, 1, 20000)
	local maxSummaryEntries = boundedNumber(params.maxSummaryEntries, 200, 1, 500)
	local collection = game:GetService("CollectionService")
	local classes, tags, attributeNames = {}, {}, {}
	local queue, head, visited, truncated, hash = { { node = root, depth = 0 } }, 1, 0, false, 5381
	local budget = newWorkBudget()
	while head <= #queue and visited < maxVisited do
		local entry = queue[head]
		head, visited = head + 1, visited + 1
		local node = entry.node
		checkpointWork(budget)
		classes[node.ClassName] = (classes[node.ClassName] or 0) + 1
		hash =
			structuralDigestAdd(hash, tostring(entry.depth) .. "\0" .. safePath(node) .. "\0" .. node.ClassName .. "\0")
		local attributesOk, attributes = pcall(function()
			return node:GetAttributes()
		end)
		if attributesOk then
			local names = {}
			for name in pairs(attributes) do
				attributeNames[name] = (attributeNames[name] or 0) + 1
				table.insert(names, name)
			end
			table.sort(names)
			for _, name in ipairs(names) do
				hash = structuralDigestAdd(hash, "@" .. name .. "\0")
			end
		end
		local tagsOk, nodeTags = pcall(function()
			return collection:GetTags(node)
		end)
		if tagsOk and type(nodeTags) == "table" then
			table.sort(nodeTags)
			for _, tag in ipairs(nodeTags) do
				tags[tag] = (tags[tag] or 0) + 1
				hash = structuralDigestAdd(hash, "#" .. tag .. "\0")
			end
		end
		if entry.depth < maxDepth then
			local children, childrenTruncated = sortedChildren(node, maxVisited - #queue, budget)
			if childrenTruncated then
				truncated = true
			end
			for _, child in ipairs(children) do
				table.insert(queue, { node = child, depth = entry.depth + 1 })
				checkpointWork(budget)
			end
		end
	end
	if head <= #queue then
		truncated = true
	end
	local classCounts, tagCounts, attributeNameCounts =
		sortedCountEntries(classes), sortedCountEntries(tags), sortedCountEntries(attributeNames)
	local remaining = maxSummaryEntries
	local function take(entries)
		local output = {}
		for _, entry in ipairs(entries) do
			if remaining <= 0 then
				truncated = true
				break
			end
			table.insert(output, entry)
			remaining = remaining - 1
		end
		return output
	end
	local selectedClasses, selectedTags, selectedAttributes = take(classCounts), take(tagCounts), take(attributeNameCounts)
	return {
		root = instanceSummary(root),
		visited = visited,
		truncated = truncated,
		structuralDigest = string.format("%08x", hash),
		classCounts = selectedClasses,
		tagCounts = selectedTags,
		attributeNameCounts = selectedAttributes,
	}
end

function handlers.spatial_query(params, requestContext, diagnosticBindings)
	params = params or {}
	local mode = params.mode
	if mode ~= "raycast" and mode ~= "radius" and mode ~= "box" then
		error("mode must be raycast, radius, or box", 0)
	end
	local maxResults = boundedNumber(params.maxResults, 100, 1, 200)
	local maxDistance = boundedNumber(params.maxDistance, 1000, 0.1, 10000)
	local excluded = {}
	if params.excludePaths ~= nil then
		if type(params.excludePaths) ~= "table" or #params.excludePaths > 16 then
			error("excludePaths must contain at most 16 paths", 0)
		end
		for _, path in ipairs(params.excludePaths) do
			if type(path) ~= "string" or #path > 1024 then
				error("excludePaths entries must be paths up to 1024 bytes", 0)
			end
			local instance, pathError = resolvePath(path)
			if not instance then
				error(pathError, 0)
			end
			table.insert(excluded, instance)
		end
	end
	local filter = mode == "raycast" and RaycastParams.new() or OverlapParams.new()
	filter.FilterType = Enum.RaycastFilterType.Exclude
	filter.FilterDescendantsInstances = excluded
	if mode ~= "raycast" then
		filter.MaxParts = maxResults
	end
	local results = {}
	if mode == "raycast" then
		local origin, direction = strictVector(params.origin, "origin"), strictVector(params.direction, "direction")
		if direction.Magnitude == 0 then
			error("direction must not be zero", 0)
		end
		local hit = workspace:Raycast(origin, direction.Unit * maxDistance, filter)
		if hit then
			local item = instanceSummary(hit.Instance, diagnosticBindings)
			item.distance = (hit.Position - origin).Magnitude
			item.position, item.normal, item.material =
				serialize(hit.Position), serialize(hit.Normal), serialize(hit.Material)
			table.insert(results, item)
		end
	elseif mode == "radius" then
		local center = strictVector(params.center, "center")
		if not finiteNumber(params.radius) then
			error("radius must be a finite number", 0)
		end
		local radius = math.clamp(params.radius, 0.1, 5000)
		for _, part in ipairs(workspace:GetPartBoundsInRadius(center, radius, filter)) do
			local item = instanceSummary(part, diagnosticBindings)
			item.distance = (part.Position - center).Magnitude
			table.insert(results, item)
		end
	else
		local center, size = strictVector(params.center, "center"), strictVector(params.size, "size")
		if size.X < 0.1 or size.Y < 0.1 or size.Z < 0.1 or size.X > 10000 or size.Y > 10000 or size.Z > 10000 then
			error("size components must be between 0.1 and 10000", 0)
		end
		for _, part in ipairs(workspace:GetPartBoundsInBox(CFrame.new(center), size, filter)) do
			local item = instanceSummary(part, diagnosticBindings)
			item.distance = (part.Position - center).Magnitude
			table.insert(results, item)
		end
	end
	table.sort(results, function(a, b)
		return a.distance == b.distance and a.path < b.path or a.distance < b.distance
	end)
	local truncated = mode ~= "raycast" and #results >= maxResults or nil
	return { mode = mode, maxDistance = maxDistance, results = results, truncated = truncated }
end

local function uiMetadata(node, includeText, diagnosticBindings)
	local item = instanceSummary(node, diagnosticBindings)
	for _, property in ipairs({
		"Enabled",
		"Visible",
		"Active",
		"Interactable",
		"AbsolutePosition",
		"AbsoluteSize",
		"ZIndex",
		"LayoutOrder",
	}) do
		local value = safeProperty(node, property)
		if value ~= nil then
			item[property] = serialize(value)
		end
	end
	if includeText then
		local text = safeProperty(node, "Text")
		if type(text) == "string" then
			item.text = string.sub(redactString(text), 1, 256)
		end
	end
	return item
end

function handlers.ui_inventory(params, requestContext, diagnosticBindings)
	params = params or {}
	local roots = params.roots or "player_gui"
	if roots ~= "player_gui" and roots ~= "core_gui" and roots ~= "both" then
		error("roots must be player_gui, core_gui, or both", 0)
	end
	local includeText = params.includeText == true
	local limit, maxVisited = boundedNumber(params.limit, 100, 1, 500), boundedNumber(params.maxVisited, 3000, 1, 10000)
	local remaining = limit
	local requested = {}
	if roots == "player_gui" or roots == "both" then
		table.insert(requested, {
			name = "player_gui",
			root = Players.LocalPlayer and Players.LocalPlayer:FindFirstChildOfClass("PlayerGui"),
		})
	end
	if roots == "core_gui" or roots == "both" then
		local ok, coreGui = pcall(game.GetService, game, "CoreGui")
		table.insert(requested, { name = "core_gui", root = ok and coreGui or nil, unavailable = not ok })
	end
	local output = {}
	for _, entry in ipairs(requested) do
		if not entry.root then
			table.insert(output, { root = entry.name, unavailable = true })
		else
			local results, resultTruncated = {}, false
			local rowBindings = diagnosticBindings and {} or nil
			local initialRemaining = remaining
			local ok, visited, traversalTruncated = pcall(function()
				return boundedTraversal(entry.root, maxVisited, function(node)
					local isGuiOk, isGui = pcall(function()
						return node:IsA("GuiBase2d") or node:IsA("LayerCollector") or node:IsA("UIComponent")
					end)
					if isGuiOk and isGui then
						if #results < limit and (not diagnosticBindings or remaining > 0) then
							table.insert(results, uiMetadata(node, includeText, rowBindings))
							remaining = remaining - 1
						else
							resultTruncated = true
						end
					end
				end)
			end)
			if not ok then
				remaining = initialRemaining
				table.insert(output, { root = entry.name, unavailable = true })
			else
				if diagnosticBindings then
					for _, binding in ipairs(rowBindings) do table.insert(diagnosticBindings, binding) end
				end
				sortSummaries(results)
				table.insert(output, {
					root = entry.name,
					available = true,
					visited = visited,
					truncated = traversalTruncated or resultTruncated,
					results = results,
				})
			end
		end
	end
	return { roots = output }
end

function handlers.signal_inventory(params)
	params = params or {}
	if type(getconnections) ~= "function" then
		error("getconnections is unavailable", 0)
	end
	local instance, pathError = resolvePath(params.path)
	if not instance then
		error(pathError, 0)
	end
	if type(params.signals) ~= "table" or #params.signals < 1 or #params.signals > 16 then
		error("signals must contain 1 to 16 names", 0)
	end
	local limit = boundedNumber(params.limitPerSignal, 100, 1, 200)
	local names, output = {}, {}
	for _, name in ipairs(params.signals) do
		if type(name) ~= "string" or #name > 64 or not string.match(name, "^[A-Za-z_][A-Za-z0-9_]*$") then
			error("Invalid signal name", 0)
		end
		names[name] = true
	end
	for name in pairs(names) do
		table.insert(output, name)
	end
	table.sort(output)
	local signals = {}
	for _, name in ipairs(output) do
		local signal = safeProperty(instance, name)
		if typeof(signal) ~= "RBXScriptSignal" then
			table.insert(signals, {
				name = redactString(name),
				available = false,
				total = 0,
				inspected = 0,
				enabled = 0,
				disabled = 0,
				truncated = false,
			})
		else
			local ok, connections = pcall(getconnections, signal)
			if not ok or type(connections) ~= "table" then
				table.insert(signals, {
					name = redactString(name),
					available = false,
					total = 0,
					inspected = 0,
					enabled = 0,
					disabled = 0,
					truncated = false,
				})
			else
				local enabled, disabled = 0, 0
				for index = 1, math.min(#connections, limit) do
					if safeProperty(connections[index], "Enabled") == false then
						disabled = disabled + 1
					else
						enabled = enabled + 1
					end
				end
				table.insert(signals, {
					name = redactString(name),
					available = true,
					total = #connections,
					inspected = math.min(#connections, limit),
					enabled = enabled,
					disabled = disabled,
					truncated = #connections > limit,
				})
			end
		end
	end
	return { instance = instanceSummary(instance), signals = signals }
end

local function observationOptions(params)
	local requested = params.properties
	if requested == nil then
		requested = {}
	end
	if type(requested) ~= "table" or #requested > MAX_WATCH_PROPERTIES then
		error("properties must contain at most " .. MAX_WATCH_PROPERTIES .. " names", 0)
	end
	local propertyCount = 0
	for key in pairs(requested) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > #requested then
			error("properties must be an array", 0)
		end
		propertyCount = propertyCount + 1
	end
	if propertyCount ~= #requested then
		error("properties must be an array", 0)
	end
	for _, field in ipairs({ "includeAttributes", "includeChildren" }) do
		if params[field] ~= nil and type(params[field]) ~= "boolean" then
			error(field .. " must be a boolean", 0)
		end
	end
	local properties, seen = {}, {}
	for _, property in ipairs(requested) do
		if not readablePropertyName(property) then
			error("Property is not observable", 0)
		end
		if not seen[property] then
			seen[property] = true
			table.insert(properties, property)
		end
	end
	table.sort(properties)
	return properties, params.includeAttributes ~= false, params.includeChildren ~= false
end

local function disconnectObserver(observer)
	if not observer then
		return
	end
	observer.active = false
	state.observers[observer] = nil
	disconnectConnections(observer.connections)
end

local function subscribeChanges(instance, properties, includeAttributes, includeChildren, record, onClosed)
	local observer = { active = true, connections = {} }
	state.observers[observer] = observer
	local function close(reason)
		disconnectObserver(observer)
		if onClosed then
			onClosed(reason)
		end
	end
	local function connect(signal, callback)
		if #observer.connections >= MAX_WATCH_CONNECTIONS then
			error("Observer connection capacity exceeded", 0)
		end
		local connection = signal:Connect(function(...)
			if not observer.active then
				return
			end
			if not isCurrent() then
				state.teardown()
				return
			end
			local ok = pcall(callback, ...)
			if not ok then
				observer.error = "Observation callback failed"
				close("stopped")
			end
		end)
		table.insert(observer.connections, connection)
	end
	local ok = pcall(function()
		connect(instance.Destroying, function()
			close("destroyed")
		end)
		for _, property in ipairs(properties) do
			connect(instance:GetPropertyChangedSignal(property), function()
				record("property", property, safeProperty(instance, property))
			end)
		end
		if includeAttributes then
			connect(instance.AttributeChanged, function(name)
				local attrOk, value = pcall(instance.GetAttribute, instance, name)
				if attrOk then
					record("attribute", tostring(name), value)
				else
					record("attribute", tostring(name), nil)
				end
			end)
		end
		if includeChildren then
			connect(instance.ChildAdded, function(child)
				record("child_added", child.Name, instanceSummary(child))
			end)
			connect(instance.ChildRemoved, function(child)
				record("child_removed", child.Name, instanceSummary(child))
			end)
		end
	end)
	if not ok then
		disconnectObserver(observer)
		error("Unable to subscribe to instance changes", 0)
	end
	return observer
end

local function observationEvent(started, kind, field, value, cursor)
	local budget = {
		items = 0,
		bytes = 0,
		maxItems = MAX_WATCH_SERIALIZED_ITEMS,
		maxBytes = MAX_WATCH_EVENT_BYTES,
	}
	local ok, serialized = pcall(serialize, value, nil, nil, budget)
	local event = {
		cursor = cursor,
		elapsedMs = math.floor((os.clock() - started) * 1000),
		kind = kind,
		field = string.sub(redactString(tostring(field)), 1, 128),
		value = ok and serialized,
	}
	if not ok or serialized == nil then
		event.value = { type = "truncated", reason = "event budget" }
	end
	local encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, event)
	if not encodedOk or type(encoded) ~= "string" or #encoded > MAX_WATCH_EVENT_BYTES then
		event.value = { type = "truncated", reason = "event budget" }
		event.field = "[unavailable]"
		encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, event)
	end
	if not encodedOk or type(encoded) ~= "string" or #encoded > MAX_WATCH_EVENT_BYTES then
		error("Observation event serialization failed", 0)
	end
	return event, #encoded
end

local function pruneTerminalWatches(now)
	while #state.watchTerminalOrder > 0 do
		local watchId = state.watchTerminalOrder[1]
		local watch = state.watches[watchId]
		if
			watch
			and now - watch.finishedAt < WATCH_RETENTION_SECONDS
			and #state.watchTerminalOrder <= MAX_RETAINED_WATCHES
		then
			break
		end
		state.watches[watchId] = nil
		table.remove(state.watchTerminalOrder, 1)
	end
end

local function finishWatch(watch, terminalState)
	if watch.state ~= "active" then
		return
	end
	watch.state = terminalState
	watch.finishedAt = os.clock()
	disconnectObserver(watch.observer)
	watch.observer = nil
	state.activeWatches = math.max(0, state.activeWatches - 1)
	table.insert(state.watchTerminalOrder, watch.watchId)
	pruneTerminalWatches(watch.finishedAt)
end

local function pruneWatches()
	local now = os.clock()
	-- Terminal pruning can remove map entries, so do not finish watches during map iteration.
	local expired = {}
	for _, watch in pairs(state.watches) do
		if watch.state == "active" and now >= watch.expiresAt then
			table.insert(expired, watch)
		end
	end
	for _, watch in ipairs(expired) do
		finishWatch(watch, "expired")
	end
	pruneTerminalWatches(now)
end

function state.teardown()
	if state.tornDown then
		return
	end
	state.tornDown = true
	state.active = false
	if state.actionObservations.teardown then state.actionObservations.teardown() end
	if state.remoteWorkflow.teardown then state.remoteWorkflow.teardown() end
	if state.mapRecordings.teardown then state.mapRecordings.teardown() end
	if state.mapSnapshots.clear then state.mapSnapshots.clear() end
	if state.socket then
		pcall(function() state.socket:Close() end)
		state.socket = nil
	end
	disconnectConnections(state.socketConnections)
	state.connected = false
	state.acknowledged = false
	for reference in pairs(state.instanceReferences) do
		releaseInstanceReference(reference)
	end
	if state.lifecycleTimer then
		pcall(task.cancel, state.lifecycleTimer)
		state.lifecycleTimer = nil
	end
	local activeWatches, activeJobs = {}, {}
	for _, watch in pairs(state.watches) do
		if watch.state == "active" then
			table.insert(activeWatches, watch)
		end
	end
	for _, watch in ipairs(activeWatches) do
		finishWatch(watch, "stopped")
	end
	for _, observer in pairs(state.observers) do
		disconnectConnections(observer.connections)
		observer.active = false
	end
	table.clear(state.observers)
	for _, job in pairs(state.asyncJobs) do
		if job.state == "queued" or job.state == "running" then
			table.insert(activeJobs, job)
		end
	end
	for _, job in ipairs(activeJobs) do
		requestAsyncCancellation(job)
	end
end

scheduleLifecycleSweep = function()
	if state.lifecycleTimer or state.tornDown then
		return
	end
	if not isCurrent() then
		state.teardown()
		return
	end
	if state.activeWatches == 0 and #state.watchTerminalOrder == 0 and state.asyncActiveJobs == 0
		and #state.remoteWorkflow.snapshotOrder == 0 and #state.remoteWorkflow.captureOrder == 0
		and #state.actionObservations.order == 0 and #state.mapSnapshots.order == 0 and #state.mapRecordings.order == 0 then
		return
	end
	state.lifecycleTimer = task.delay(LIFECYCLE_SWEEP_SECONDS, function()
		state.lifecycleTimer = nil
		if not isCurrent() then
			state.teardown()
			return
		end
		pruneWatches()
		if state.remoteWorkflow.sweep then state.remoteWorkflow.sweep() end
		if state.actionObservations.sweep then state.actionObservations.sweep() end
		if state.mapRecordings.sweep then state.mapRecordings.sweep() end
		if state.mapSnapshots.sweep then state.mapSnapshots.sweep() end
		scheduleLifecycleSweep()
	end)
end

local function appendWatchEvent(watch, kind, field, value)
	if watch.state ~= "active" then
		return
	end
	if os.clock() >= watch.expiresAt then
		finishWatch(watch, "expired")
		return
	end
	if watch.cursor >= MAX_SAFE_INTEGER then
		finishWatch(watch, "stopped")
		return
	end
	local event, bytes = observationEvent(watch.startedAt, kind, field, value, watch.cursor + 1)
	-- Include array delimiters and a conservative comma byte for each retained event.
	bytes = bytes + 1
	while watch.count > 0 and (watch.count >= watch.maxEvents or watch.bytes + bytes > MAX_WATCH_BUFFER_BYTES) do
		local removed = watch.events[watch.head]
		watch.bytes = watch.bytes - removed.bytes
		watch.events[watch.head] = nil
		watch.head = watch.head % watch.maxEvents + 1
		watch.count = watch.count - 1
	end
	local index = (watch.head + watch.count - 1) % watch.maxEvents + 1
	watch.events[index] = { event = event, bytes = bytes }
	watch.count = watch.count + 1
	watch.bytes = watch.bytes + bytes
	watch.cursor = event.cursor
end

local function getWatch(params)
	local watchId = params and params.watchId
	if not isResourceId(watchId) then
		error("Invalid watch id", 0)
	end
	if not isCurrent() then
		state.teardown()
	end
	pruneWatches()
	local watch = state.watches[watchId]
	if not watch then
		error("Unknown or expired watch", 0)
	end
	return watch
end

function handlers.watch_start(params)
	params = params or {}
	if not isCurrent() then
		error("Bootstrap is not active", 0)
	end
	if type(params.path) ~= "string" or #params.path < 1 or #params.path > 1024 then
		error("path must contain 1 to 1024 bytes", 0)
	end
	local properties, includeAttributes, includeChildren = observationOptions(params)
	local maxEvents = strictInteger(params.maxEvents, 100, 1, MAX_WATCH_EVENTS, "maxEvents")
	local ttlSeconds = strictInteger(params.ttlSeconds, 60, 10, 300, "ttlSeconds")
	local instance, pathError = resolvePath(params.path)
	if not instance then
		error(pathError, 0)
	end
	pruneWatches()
	if state.activeWatches >= MAX_ACTIVE_WATCHES then
		error("Watch capacity exceeded", 0)
	end
	local watchId = newResourceId(state.watches)
	if not watchId then
		error("Unable to allocate watch id", 0)
	end
	local summary = instanceSummary(instance)
	local startedAt = os.clock()
	local watch = {
		watchId = watchId,
		state = "active",
		startedAt = startedAt,
		expiresAt = startedAt + ttlSeconds,
		ttlSeconds = ttlSeconds,
		maxEvents = maxEvents,
		events = {},
		head = 1,
		count = 0,
		bytes = 2,
		cursor = 0,
	}
	watch.observer = subscribeChanges(instance, properties, includeAttributes, includeChildren, function(kind, field, value)
		appendWatchEvent(watch, kind, field, value)
	end, function(reason)
		finishWatch(watch, reason)
	end)
	state.watches[watchId] = watch
	state.activeWatches = state.activeWatches + 1
	scheduleLifecycleSweep()
	return {
		watchId = watchId,
		instance = summary,
		state = "active",
		nextCursor = 0,
		maxEvents = maxEvents,
		ttlSeconds = ttlSeconds,
	}
end

function handlers.watch_poll(params)
	params = params or {}
	local afterCursor = strictInteger(params.afterCursor, 0, 0, MAX_SAFE_INTEGER, "afterCursor")
	local limit = strictInteger(params.limit, 100, 1, MAX_WATCH_EVENTS, "limit")
	local watch = getWatch(params)
	if afterCursor > watch.cursor then
		error("afterCursor exceeds the latest watch cursor", 0)
	end
	if watch.state == "active" then
		watch.expiresAt = os.clock() + watch.ttlSeconds
	end
	local events = {}
	local oldestCursor = watch.cursor - watch.count + 1
	local dropped = math.max(0, oldestCursor - afterCursor - 1)
	local nextCursor = afterCursor + dropped
	for offset = math.max(0, afterCursor - oldestCursor + 1), watch.count - 1 do
		local index = (watch.head + offset - 1) % watch.maxEvents + 1
		local event = watch.events[index].event
		table.insert(events, event)
		nextCursor = event.cursor
		if #events >= limit then
			break
		end
	end
	return {
		watchId = watch.watchId,
		state = watch.state,
		events = events,
		nextCursor = nextCursor,
		dropped = dropped,
		hasMore = nextCursor < watch.cursor,
	}
end

function handlers.watch_stop(params)
	local watch = getWatch(params)
	finishWatch(watch, "stopped")
	return { watchId = watch.watchId, state = watch.state }
end

function handlers.observe_changes(params)
	params = params or {}
	if not isCurrent() then
		error("Bootstrap is not active", 0)
	end
	local instance, pathError = resolvePath(params.path)
	if not instance then
		error(pathError, 0)
	end
	local durationMs, maxEvents =
		boundedNumber(params.durationMs, 1000, 100, 5000), boundedNumber(params.maxEvents, 100, 1, MAX_WATCH_EVENTS)
	local properties, includeAttributes, includeChildren = observationOptions(params)
	local events, truncated, started = {}, false, os.clock()
	local observer = subscribeChanges(instance, properties, includeAttributes, includeChildren, function(kind, field, value)
		if #events >= maxEvents then
			truncated = true
			return
		end
		table.insert(events, {
			elapsedMs = math.floor((os.clock() - started) * 1000),
			kind = kind,
			field = redactString(field),
			value = serialize(value),
		})
	end)
	local ok = pcall(task.wait, durationMs / 1000)
	disconnectObserver(observer)
	if not ok or observer.error then
		error(observer.error or "Observation interrupted", 0)
	end
	return { instance = instanceSummary(instance), durationMs = durationMs, events = events, truncated = truncated }
end

function handlers.observe_logs(params)
	params = params or {}
	local durationMs = boundedNumber(params.durationMs, 1000, 100, 5000)
	local maxEvents = boundedNumber(params.maxEvents, 100, 1, 200)
	local minimum = params.minLevel or "output"
	local ranks = { output = 1, info = 2, warning = 3, error = 4 }
	if ranks[minimum] == nil then
		error("minLevel must be output, info, warning, or error", 0)
	end
	local serviceOk, logService = pcall(game.GetService, game, "LogService")
	if not serviceOk or not logService then
		error("LogService is unavailable", 0)
	end
	local events, truncated = {}, false
	local observer = { active = true, connections = {} }
	local started = os.clock()
	local levelByType = {
		[Enum.MessageType.MessageOutput] = "output",
		[Enum.MessageType.MessageInfo] = "info",
		[Enum.MessageType.MessageWarning] = "warning",
		[Enum.MessageType.MessageError] = "error",
	}
	local ok, err = xpcall(function()
		local connection = logService.MessageOut:Connect(function(message, messageType)
			if not observer.active then return end
			local level = levelByType[messageType] or "output"
			if ranks[level] < ranks[minimum] then
				return
			end
			if #events >= maxEvents then
				truncated = true
				return
			end
			local output = redactString(tostring(message))
			if #output > 1024 then
				output = string.sub(output, 1, 1021) .. "..."
			end
			table.insert(events, {
				elapsedMs = math.floor((os.clock() - started) * 1000),
				level = level,
				message = output,
			})
		end)
		table.insert(observer.connections, connection)
		state.observers[observer] = observer
		task.wait(durationMs / 1000)
	end, function(message)
		return tostring(message)
	end)
	disconnectObserver(observer)
	if not ok then
		error(err, 0)
	end
	return { durationMs = durationMs, minLevel = minimum, events = events, truncated = truncated }
end

local function strictBoundedInteger(value, default, minimum, maximum, field)
	if value == nil then
		return default
	end
	if type(value) ~= "number" or value ~= math.floor(value) or value < minimum or value > maximum then
		error(field .. " must be an integer from " .. minimum .. " to " .. maximum, 0)
	end
	return value
end
local function tableParams(params)
	if params == nil then
		return {}
	end
	if type(params) ~= "table" then
		error("params must be an object", 0)
	end
	return params
end

local function readableProperties(values, maximum, field)
	if type(values) ~= "table" or #values < 1 or #values > maximum then
		error(field .. " must contain 1 to " .. maximum .. " names", 0)
	end
	local output, seen = {}, {}
	for _, property in ipairs(values) do
		if not readablePropertyName(property) then
			error("Property is not readable", 0)
		end
		if not seen[property] then
			seen[property] = true
			table.insert(output, property)
		end
	end
	table.sort(output)
	return output
end

local function boundedInstanceSnapshot(instance, properties, includeAttributes, includeTags)
	local attributes, tags, children = {}, {}, {}
	local attributeOk, rawAttributes = false, nil
	local attributeTotal = 0
	if includeAttributes then
		attributeOk, rawAttributes = pcall(function()
			return instance:GetAttributes()
		end)
		if attributeOk and type(rawAttributes) == "table" then
			local names = {}
			for name in pairs(rawAttributes) do
				if type(name) == "string" then
					table.insert(names, name)
				end
			end
			attributeTotal = #names
			table.sort(names)
			for index = 1, math.min(#names, MAX_SNAPSHOT_ATTRIBUTES) do
				attributes[redactString(names[index])] = serialize(rawAttributes[names[index]])
			end
		end
	end
	local tagOk, rawTags = false, {}
	if includeTags then
		tagOk, rawTags = pcall(function()
			return game:GetService("CollectionService"):GetTags(instance)
		end)
		if tagOk then
			table.sort(rawTags)
			for index = 1, math.min(#rawTags, MAX_SNAPSHOT_TAGS) do
				table.insert(tags, redactString(rawTags[index]))
			end
		end
	end
	local budget = newWorkBudget()
	local sorted, childrenTruncated = sortedChildren(instance, MAX_SNAPSHOT_CHILDREN, budget)
	for _, child in ipairs(sorted) do
		table.insert(children, { className = child.ClassName, name = redactString(child.Name) })
		checkpointWork(budget)
	end
	local propertyValues = {}
	for _, property in ipairs(properties) do
		local ok, value = pcall(function()
			return instance[property]
		end)
		propertyValues[property] = ok and { ok = true, value = serialize(value) }
			or { ok = false, error = "Property unavailable" }
	end
	return {
		properties = propertyValues,
		attributes = includeAttributes and attributes or nil,
		tags = includeTags and tags or nil,
		children = children,
		attributesTruncated = includeAttributes and attributeTotal > MAX_SNAPSHOT_ATTRIBUTES or nil,
		tagsTruncated = includeTags and tagOk and #rawTags > MAX_SNAPSHOT_TAGS or nil,
		childrenTruncated = childrenTruncated,
	}
end

local function stableEqual(left, right)
	if type(left) ~= type(right) then
		return false
	end
	if type(left) ~= "table" then
		return left == right
	end
	for key, leftValue in pairs(left) do
		if not stableEqual(leftValue, right[key]) then
			return false
		end
	end
	for key in pairs(right) do
		if left[key] == nil then
			return false
		end
	end
	return true
end

function handlers.snapshot_diff(params)
	params = tableParams(params)
	local instance, pathError = resolvePath(params.path)
	if not instance then
		error(pathError, 0)
	end
	local durationMs = strictBoundedInteger(params.durationMs, 500, 50, 2000, "durationMs")
	local maxDepth = strictBoundedInteger(params.maxDepth, 1, 0, 3, "maxDepth")
	local maxVisited = strictBoundedInteger(params.maxVisited, 100, 1, 500, "maxVisited")
	local maxChanges = strictBoundedInteger(params.maxChanges, 100, 1, MAX_SNAPSHOT_CHANGES, "maxChanges")
	local requestedProperties = params.properties
	local properties = readableProperties(
		(requestedProperties == nil or #requestedProperties == 0)
				and { "Name", "Parent", "Position", "Size", "Transparency", "Visible", "Value" }
			or requestedProperties,
		MAX_SNAPSHOT_PROPERTIES,
		"properties"
	)
	local includeAttributes, includeTags = params.includeAttributes ~= false, params.includeTags ~= false
	local function capture()
		local output, queue, head, truncated = {}, { { node = instance, depth = 0 } }, 1, false
		local budget = newWorkBudget()
		while head <= #queue and #output < maxVisited do
			local entry = queue[head]
			head = head + 1
			table.insert(output, {
				instance = entry.node,
				sortKey = entry.node:GetFullName(),
				path = safePath(entry.node),
				snapshot = boundedInstanceSnapshot(entry.node, properties, includeAttributes, includeTags),
			})
			checkpointWork(budget)
			if entry.depth < maxDepth then
				local children, childrenTruncated = sortedChildren(entry.node, maxVisited - #queue, budget)
				if childrenTruncated then
					truncated = true
				end
				for _, child in ipairs(children) do
					table.insert(queue, { node = child, depth = entry.depth + 1 })
					checkpointWork(budget)
				end
			end
		end
		if head <= #queue then
			truncated = true
		end
		return output, truncated
	end
	local before, beforeTruncated = capture()
	task.wait(durationMs / 1000)
	local after, afterTruncated = capture()
	local beforeByInstance, afterByInstance, records = {}, {}, {}
	for _, item in ipairs(before) do
		beforeByInstance[item.instance] = item
		records[item.instance] = { instance = item.instance, sortKey = item.sortKey, path = item.path }
	end
	for _, item in ipairs(after) do
		afterByInstance[item.instance] = item
		local record = records[item.instance] or { instance = item.instance }
		record.sortKey = item.sortKey
		record.path = item.path
		records[item.instance] = record
	end
	local ordered, changes, truncated = {}, {}, beforeTruncated or afterTruncated
	for _, record in pairs(records) do
		table.insert(ordered, record)
	end
	table.sort(ordered, function(a, b)
		return a.sortKey < b.sortKey
	end)
	for _, record in ipairs(ordered) do
		local beforeItem, afterItem = beforeByInstance[record.instance], afterByInstance[record.instance]
		local beforeSnapshot = beforeItem and beforeItem.snapshot or nil
		local afterSnapshot = afterItem and afterItem.snapshot or nil
		if not stableEqual(beforeSnapshot, afterSnapshot) then
			if #changes >= maxChanges then
				truncated = true
				break
			end
			table.insert(changes, { path = record.path, before = beforeSnapshot, after = afterSnapshot })
		end
	end
	return { instance = instanceSummary(instance), durationMs = durationMs, changes = changes, truncated = truncated }
end

local function strictObject(value, allowed, field)
	if type(value) ~= "table" then
		error(field .. " must be an object", 0)
	end
	for key in pairs(value) do
		if type(key) ~= "string" or not allowed[key] then
			error(field .. " contains an unknown field", 0)
		end
	end
	return value
end

local function strictArray(value, minimum, maximum, field)
	if type(value) ~= "table" then
		error(field .. " must be an array", 0)
	end
	if #value < minimum or #value > maximum then
		error(field .. " has an invalid number of entries", 0)
	end
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > #value then
			error(field .. " must be a dense array", 0)
		end
		count = count + 1
	end
	if count ~= #value or count < minimum or count > maximum then
		error(field .. " has an invalid number of entries", 0)
	end
	return value
end

do
	local forms = {
		["nil"] = { type = true }, Vector3 = { type = true, x = true, y = true, z = true },
		CFrame = { type = true, components = true }, Instance = { type = true, reference = true },
		Array = { type = true, values = true }, Table = { type = true, entries = true },
	}
	local function reachable(instance)
		local ok, value = pcall(function() return instance == game or instance:IsDescendantOf(game) end)
		return ok and value == true
	end
	local function decode(value, depth, budget, references)
		budget.nodes = budget.nodes + 1
		if depth > 6 or budget.nodes > 256 then error("Remote argument complexity limit exceeded", 0) end
		if type(value) == "table" and (value.type == "Vector3" or value.type == "CFrame") then
			budget.nodes = budget.nodes + (value.type == "Vector3" and 3 or 12)
			if budget.nodes > 256 then error("Remote argument complexity limit exceeded", 0) end
		end
		local kind = type(value)
		if kind == "string" then
			if #value > 4096 then error("Remote argument string exceeds 4096 bytes", 0) end
			return value
		elseif kind == "boolean" then return value
		elseif kind == "number" then
			if not finiteNumber(value) then error("Remote argument number must be finite", 0) end
			return value
		elseif kind ~= "table" or not forms[value.type] then
			error("Invalid typed remote argument", 0)
		end
		strictObject(value, forms[value.type], "remote argument")
		if value.type == "nil" then return nil end
		if value.type == "Vector3" then return strictVector(value, "Vector3") end
		if value.type == "CFrame" then
			strictArray(value.components, 12, 12, "CFrame.components")
			for _, component in ipairs(value.components) do
				if not finiteNumber(component) then error("CFrame components must be finite", 0) end
			end
			return CFrame.new(table.unpack(value.components, 1, 12))
		end
		if value.type == "Instance" then
			if not isInstanceReference(value.reference) then error("Invalid instance reference", 0) end
			local instance, err = resolvePath(value.reference)
			if not instance or not reachable(instance) then error(err or "Instance reference unavailable", 0) end
			table.insert(references, { reference = value.reference, instance = instance })
			return instance
		end
		local output = {}
		if value.type == "Array" then
			strictArray(value.values, 0, 256, "Array.values")
			for index, child in ipairs(value.values) do output[index] = decode(child, depth + 1, budget, references) end
		else
			strictArray(value.entries, 0, 256, "Table.entries")
			local seen = {}
			for _, entry in ipairs(value.entries) do
				strictObject(entry, { key = true, value = true }, "Table entry")
				local key = entry.key
				if type(key) ~= "string" and type(key) ~= "boolean" and not finiteNumber(key) then
					error("Table keys must be strings, finite numbers, or booleans", 0)
				end
				if type(key) == "string" and #key > 4096 then error("Table key exceeds 4096 bytes", 0) end
				if seen[key] then error("Duplicate Table key", 0) end
				seen[key] = true
				budget.nodes = budget.nodes + 1
				output[key] = decode(entry.value, depth + 1, budget, references)
			end
		end
		return output
	end
	function handlers.remote_call(params)
		strictObject(params, { target = true, method = true, arguments = true, argumentCount = true }, "params")
		if type(params.target) ~= "string" or #params.target < 1 or #params.target > 1024 then error("Invalid remote target", 0) end
		if params.method ~= "FireServer" and params.method ~= "InvokeServer" then error("Invalid remote method", 0) end
		strictArray(params.arguments, 0, 16, "arguments")
		local count = strictInteger(params.argumentCount, nil, 0, 16, "argumentCount")
		if count == nil or count ~= #params.arguments then error("argumentCount must match arguments", 0) end
		local encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, params)
		if not encodedOk or type(encoded) ~= "string" or #encoded > 65536 then error("Remote arguments exceed 65536 bytes", 0) end
		local target, targetError = resolvePath(params.target)
		if not target or not reachable(target) then error(targetError or "Remote target unavailable", 0) end
		local method, targetPath = params.method, params.target
		local class = target.ClassName
		if (method == "InvokeServer" and class ~= "RemoteFunction")
			or (method == "FireServer" and class ~= "RemoteEvent" and class ~= "UnreliableRemoteEvent") then
			error("Remote method does not match target class", 0)
		end
		local references, arguments, budget = {}, { n = count }, { nodes = 0 }
		for index, value in ipairs(params.arguments) do arguments[index] = decode(value, 1, budget, references) end
		local job = { kind = "remote_call", method = method, dispatchStarted = false, arguments = arguments }
		job.callable = function(running)
			if not reachable(target) or target.ClassName ~= class or (isInstanceReference(targetPath) and resolvePath(targetPath) ~= target) then
				error("Remote target unavailable before dispatch", 0)
			end
			for _, entry in ipairs(references) do
				if resolvePath(entry.reference) ~= entry.instance or not reachable(entry.instance) then
					error("Instance reference unavailable before dispatch", 0)
				end
			end
			if running.cancellationRequested or not isCurrent() then error("Remote call cancelled before dispatch", 0) end
			running.dispatchStarted, running.dispatchedAt = true, os.time()
			if method == "FireServer" then
				target:FireServer(table.unpack(arguments, 1, arguments.n))
				return
			end
			return target:InvokeServer(table.unpack(arguments, 1, arguments.n))
		end
		return state.enqueueAsyncJob(job)
	end
end

do
	local overview = handlers.diagnostic_snapshot
	function handlers.diagnostic_snapshot(params, requestContext)
		strictObject(params, { view = true, root = true, radius = true, limit = true, _maxResultBytes = true }, "params")
		local view = params.view or "overview"
		if view ~= "overview" and view ~= "character" and view ~= "ui" and view ~= "nearby" then error("Invalid diagnostic view", 0) end
		if params.root ~= nil and view ~= "ui" then error("root requires ui view", 0) end
		if params.radius ~= nil and view ~= "nearby" then error("radius requires nearby view", 0) end
		if params.limit ~= nil and view ~= "ui" and view ~= "nearby" then error("limit requires ui or nearby view", 0) end
		if view == "overview" then return overview() end
		local bindings, result = {}, { view = view, coverage = "complete", truncated = false }
		local limit = strictInteger(params.limit, 10, 1, 20, "limit")
		if view == "ui" then
			local ui = handlers.ui_inventory({ roots = params.root or "player_gui", limit = limit, maxVisited = 256 }, nil, bindings)
			result.roots = ui.roots
			for _, root in ipairs(ui.roots) do
				if root.unavailable or root.truncated then result.coverage = "partial" end
				result.truncated = result.truncated or root.truncated == true
			end
			result.scope = "selected-ui-roots"
		else
			local character = Players.LocalPlayer and Players.LocalPlayer.Character
			local root = character and character:FindFirstChild("HumanoidRootPart")
			if view == "character" then
				local snapshot = overview()
				result.character, result.root, result.humanoid = snapshot.character, snapshot.root, snapshot.humanoid
				if character then result.character.instance = instanceSummary(character, bindings) end
				if root then result.root.instance = instanceSummary(root, bindings) end
				local humanoid = character and character:FindFirstChildOfClass("Humanoid")
				if humanoid then result.humanoid.instance = instanceSummary(humanoid, bindings) end
				if not character or not root or not humanoid then result.coverage = "partial" end
				result.scope = "local-character"
			else
				local radius = params.radius == nil and 32 or params.radius
				if not finiteNumber(radius) or radius < 1 or radius > 128 then error("radius must be from 1 to 128", 0) end
				result.radius, result.scope = radius, "local-character-radius"
				if not root then
					result.coverage, result.reason, result.results = "unavailable", "character-root-unavailable", {}
				else
					local position = root.Position
					local nearby = handlers.spatial_query({
						mode = "radius", center = { x = position.X, y = position.Y, z = position.Z },
						radius = radius, maxResults = limit,
					}, nil, bindings)
					result.center, result.results = serialize(position), nearby.results
					result.truncated = nearby.truncated == true
					if result.truncated then result.coverage = "partial" end
				end
			end
		end
		return finishReferenceResult(result, bindings, math.min(MAX_BATCH_RESULT_BYTES, referenceResultLimit(params)), requestContext)
	end
end

-- Bounded client-visible DTOs and snapshot-owned wrappers; paths are metadata,
-- never a way to rebind an observation after replacement or streaming loss.
do
	local function vectorDto(value)
		if typeof(value) ~= "Vector3" or not finiteNumber(value.X)
			or not finiteNumber(value.Y) or not finiteNumber(value.Z)
			or math.abs(value.X) > 1e9 or math.abs(value.Y) > 1e9 or math.abs(value.Z) > 1e9 then return nil end
		return { x = value.X, y = value.Y, z = value.Z }
	end
	local flow = state.mapSnapshots
	flow.holds, flow.requests = 0, {}
	local function bytes(value)
		local ok, encoded = pcall(HttpService.JSONEncode, HttpService, value)
		return ok and type(encoded) == "string" and #encoded or math.huge
	end
	local function freshId()
		if flow.counter >= 4294967295 then error("MAP_CONTEXT_LIMIT: identity exhausted", 0) end
		flow.counter = flow.counter + 1
		return string.sub(clientId, 1, 24) .. string.format("%08x", flow.counter)
	end
	local function remove(id)
		local record = flow.records[id]
		if not record then return end
		for _, entry in pairs(record.objects) do
			entry.owners = entry.owners - 1
			if entry.owners == 0 and entry.holds == 0 then
				if flow.reverse[entry.instance] == entry then flow.reverse[entry.instance] = nil end
				entry.instance = nil
			end
		end
		flow.count, flow.bytes = flow.count - record.count, flow.bytes - record.bytes
		flow.records[id] = nil
		local index = table.find(flow.order, id)
		if index then table.remove(flow.order, index) end
	end
	function flow.releaseRequest(context)
		local targets = flow.requests[context]
		if not targets then return end
		flow.holds = flow.holds - #targets
		for _, entry in ipairs(targets) do
			entry.holds = entry.holds - 1
			if entry.owners == 0 and entry.holds == 0 then
				if flow.reverse[entry.instance] == entry then flow.reverse[entry.instance] = nil end
				entry.instance = nil
			end
		end
		table.clear(targets)
		flow.requests[context] = nil
	end
	function flow.clear()
		while #flow.order > 0 do remove(flow.order[1]) end
		for context in pairs(flow.requests) do flow.releaseRequest(context) end
	end
	function flow.sweep()
		while #flow.order > 0 and flow.records[flow.order[1]].expiresAt <= os.clock() do remove(flow.order[1]) end
	end
	function flow.rollback(context)
		if context.createdMapSnapshot then remove(context.createdMapSnapshot) end
	end
	function flow.resources()
		return { snapshots = #flow.order, parts = flow.count, activeHolds = flow.holds, totalParts = flow.count + flow.holds, bytes = flow.bytes,
			maxSnapshots = 8, maxParts = 1024, maxBytes = 262144, lifetimeSeconds = 180 }
	end
	local function requestFence(context)
		if not isCurrent() or state.tornDown or not context or not context.socket
			or state.socket ~= context.socket or not state.acknowledged then
			error("MAP_CONTEXT_CLIENT_CHANGED: observation interrupted", 0)
		end
	end
	local function reachable(instance)
		local ok, value = pcall(function() return instance:IsDescendantOf(workspace) end)
		return ok and value == true
	end
	local function frame(instance)
		local size, cf = vectorDto(safeProperty(instance, "Size")), safeProperty(instance, "CFrame")
		if not size or size.x <= 0 or size.y <= 0 or size.z <= 0
			or size.x > 1e6 or size.y > 1e6 or size.z > 1e6 or typeof(cf) ~= "CFrame" then return nil end
		local ok, components = pcall(function() return { cf:GetComponents() } end)
		if not ok or #components ~= 12 then return nil end
		for _, value in ipairs(components) do if not finiteNumber(value) or math.abs(value) > 1e9 then return nil end end
		return components, size
	end
	local function optionalText(value, limit)
		if type(value) ~= "string" or #value > limit or utf8.len(value) == nil or string.find(value, "\0", 1, true) then return nil end
		local sanitized = redactString(value)
		if #sanitized > limit or utf8.len(sanitized) == nil then return nil end
		return sanitized
	end
	local function partMetadata(node, row)
		for property, field in pairs({ CanTouch = "canTouch", CanQuery = "canQuery" }) do
			local value = safeProperty(node, property)
			if type(value) == "boolean" then row[field] = value end
		end
		for property, field in pairs({ Shape = "shape", Material = "material" }) do
			local value = safeProperty(node, property)
			if value ~= nil then row[field] = optionalText(string.match(tostring(value), "[^.]+$"), 64) end
		end
		row.collisionGroup = optionalText(safeProperty(node, "CollisionGroup"), 128)
		row.linearVelocity = vectorDto(safeProperty(node, "AssemblyLinearVelocity"))
		row.angularVelocity = vectorDto(safeProperty(node, "AssemblyAngularVelocity"))
		local ok, tags = pcall(function() return game:GetService("CollectionService"):GetTags(node) end)
		if ok and type(tags) == "table" then
			row.tags = {}
			for index = 1, math.min(#tags, 16) do
				local tag = optionalText(tags[index], 128)
				if tag then table.insert(row.tags, tag) end
			end
		end
		-- Fixed scalar allowlist: never enumerate arbitrary attribute values.
		row.attributes = {}
		for _, name in ipairs({ "Hazard", "Damage", "Kill", "Deadly", "Danger", "Checkpoint", "Moving", "Speed" }) do
			local readOk, value = pcall(node.GetAttribute, node, name)
			local sanitized = type(value) == "string" and optionalText(value, 128) or nil
			if readOk and (type(value) == "boolean" or finiteNumber(value) or sanitized) then
				table.insert(row.attributes, { name = name, value = sanitized or value })
			end
		end
	end
	local function characterCollisionGroups(character, context)
		if not character then return nil end
		local queue, groups, seen, head = { character }, {}, {}, 1
		while head <= #queue do
			requestFence(context)
			local node = queue[head]
			head = head + 1
			local ok, isPart = pcall(node.IsA, node, "BasePart")
			if not ok then return nil end
			if isPart then
				local collidable = safeProperty(node, "CanCollide")
				if type(collidable) ~= "boolean" then return nil end
				if collidable then
					local group = safeProperty(node, "CollisionGroup")
					if type(group) ~= "string" or #group > 128 or utf8.len(group) == nil then return nil end
					if not seen[group] then
						if #groups == 8 then return nil end
						seen[group] = true; table.insert(groups, group)
					end
				end
			end
			local childrenOk, children = pcall(node.GetChildren, node)
			if not childrenOk or type(children) ~= "table" or #children > 64 - #queue then return nil end
			for _, child in ipairs(children) do table.insert(queue, child) end
		end
		return #groups > 0 and groups or nil
	end
	local function collisionRelation(node, groups, service)
		if not groups or not service then return nil end
		local group = safeProperty(node, "CollisionGroup")
		if type(group) ~= "string" or #group > 128 or utf8.len(group) == nil then return nil end
		local relation
		for _, characterGroup in ipairs(groups) do
			local ok, value = pcall(service.CollisionGroupsAreCollidable, service, group, characterGroup)
			if not ok or type(value) ~= "boolean" then return nil end
			if relation ~= nil and relation ~= value then return nil end
			relation = value
		end
		return relation
	end
	function handlers.game_context(params, requestContext)
		params = params or {}
		strictObject(params, { root = true, maxVisited = true, maxParts = true, uiLimit = true, remoteLimit = true, _maxResultBytes = true }, "params")
		local maximum = strictInteger(params.maxVisited, 2500, 1, 20000, "maxVisited")
		local maxParts = strictInteger(params.maxParts, 200, 1, 512, "maxParts")
		local uiLimit = strictInteger(params.uiLimit, 20, 0, 40, "uiLimit")
		local remoteLimit = strictInteger(params.remoteLimit, 50, 0, 100, "remoteLimit")
		local maximumBytes = strictInteger(params._maxResultBytes, 32768, 1, 32768, "_maxResultBytes")
		local rootPath = params.root or "workspace"
		if type(rootPath) ~= "string" or #rootPath < 1 or #rootPath > 1024 then error("Invalid game context root", 0) end
		local root, pathError = resolvePath(rootPath)
		if not root then error(pathError, 0) end
		if root ~= workspace and not root:IsDescendantOf(workspace) then
			error("Game context root must be workspace or a workspace descendant", 0)
		end
		local function fence() requestFence(requestContext) end
		fence()
		local canonicalRoot = safePath(root)
		if #canonicalRoot > 1024 or utf8.len(canonicalRoot) == nil or string.find(canonicalRoot, "\0", 1, true) or canonicalRoot == "[unavailable]" then
			error("Game context root metadata limit exceeded", 0)
		end
		local player = Players.LocalPlayer
		local result = {
			schema = 2, sourceSnapshotId = freshId(), root = canonicalRoot, place = { placeId = game.PlaceId },
			player = { present = player ~= nil }, parts = {},
			ui = { coverage = "complete", truncated = false, entries = {} },
			remotes = { root = "game.ReplicatedStorage", coverage = "complete", truncated = false, entries = {} },
			coverage = "complete", truncated = false, visited = 0, stopReasons = {}, atomicSnapshot = false,
		}
		local facets, allocations, bindings, selectedInstances = {}, {}, {}, {}
		local requested = { "geometry" }
		if uiLimit > 0 then table.insert(requested, "ui") end
		if remoteLimit > 0 then table.insert(requested, "remotes") end
		for _, facet in ipairs({ "geometry", "ui", "remotes" }) do
			facets[facet] = { visited = 0, coverage = "complete", truncated = false, stopReasons = {} }
		end
		result.facetCoverage = facets
		for index, facet in ipairs(requested) do
			allocations[facet] = { visits = math.floor(maximum / #requested) + (index <= maximum % #requested and 1 or 0),
				work = math.floor(MAX_BATCH_WORK_ITEMS / #requested), bytes = 0, charged = 0 }
		end
		if not finiteNumber(result.place.placeId) or result.place.placeId < 0 or result.place.placeId > 9007199254740991
			or result.place.placeId % 1 ~= 0 then error("Game context place unavailable", 0) end
		local reasons = {}
		local function partial(reason, facet)
			result.coverage, result.truncated = "partial", true
			local selected = facets[facet or "geometry"]
			selected.coverage, selected.truncated = "partial", true
			if not table.find(selected.stopReasons, reason) then table.insert(selected.stopReasons, reason) end
			if facet and facet ~= "geometry" then result[facet].coverage, result[facet].truncated = "partial", true end
			if not reasons[reason] then reasons[reason] = true; table.insert(result.stopReasons, reason) end
		end
		local function boundedText(value, maximumLength, facet)
			if #value > maximumLength or utf8.len(value) == nil or string.find(value, "\0", 1, true) then partial("metadata-limit", facet); return nil end
			return value
		end
		local function metadata(node, facet)
			local name = boundedText(redactString(node.Name), 128, facet)
			local path = boundedText(safePath(node), 1024, facet)
			local className = boundedText(node.ClassName, 64, facet)
			if not name or not path or not className or path == "[unavailable]" then
				partial("metadata-limit", facet)
				return nil
			end
			return { name = name, path = path, className = className }
		end
		local version, name = safeProperty(game, "PlaceVersion"), safeProperty(game, "Name")
		if finiteNumber(version) and version >= 0 and version <= 9007199254740991 and version % 1 == 0 then result.place.placeVersion = version end
		if type(name) == "string" then result.place.name = boundedText(redactString(name), 128) end
		-- PlayerGui is the game-owned UI scope. CoreGui is deliberately excluded.
		local streaming = safeProperty(workspace, "StreamingEnabled")
		if streaming == true then partial("streaming-enabled-client-visible-only")
		elseif streaming ~= false then partial("streaming-status-unavailable") end
		local collisionCharacter = player and safeProperty(player, "Character")
		local collisionGroups = characterCollisionGroups(collisionCharacter, requestContext)
		local physicsOk, physicsService = pcall(game.GetService, game, "PhysicsService")
		if not physicsOk then physicsService = nil end
		-- Reserve the bounded character metadata scan and per-part matrix reads
		-- inside the aggregate work allowance, not an extra traversal allowance.
		allocations.geometry.work = math.max(0, allocations.geometry.work - 128 - maxParts * 8)
		if player then
			local character = safeProperty(player, "Character")
			local characterRoot = character and character:FindFirstChild("HumanoidRootPart")
			result.player.position = characterRoot and vectorDto(safeProperty(characterRoot, "Position")) or nil
			if not result.player.position then partial("player-position-unavailable") end
			local humanoid = character and character:FindFirstChildOfClass("Humanoid")
			if humanoid then
				result.physics = {}
				for property, field in pairs({ WalkSpeed = "walkSpeed", JumpPower = "jumpPower", JumpHeight = "jumpHeight", HipHeight = "hipHeight" }) do
					local value = safeProperty(humanoid, property)
					local maximum = property == "JumpHeight" and 10000 or 1000
					if finiteNumber(value) and value >= 0 and value <= maximum then result.physics[field] = value end
				end
				local mode = safeProperty(humanoid, "UseJumpPower")
				if type(mode) == "boolean" then result.physics.useJumpPower = mode end
			end
		end
		local gravity = safeProperty(workspace, "Gravity")
		if finiteNumber(gravity) and gravity > 0 and gravity <= 10000 then
			result.physics = result.physics or {}; result.physics.gravity = gravity
		end
		-- Reserve reasons, counters, and coverage changes once; rows are charged
		-- by their actual encoded bytes, not by an estimated string character cap.
		local charged = bytes(result) + 2048
		if charged > maximumBytes then error("Game context result limit exceeded", 0) end
		for _, facet in ipairs(requested) do allocations[facet].bytes = math.floor((maximumBytes - charged) / #requested) end
		local function append(rows, row, facet)
			local size = bytes(row) + 1
			local allocation = allocations[facet or "geometry"]
			if allocation.charged + size > allocation.bytes then partial("byte-limit", facet); return false end
			allocation.charged = allocation.charged + size
			table.insert(rows, row)
			return true
		end
		local function walk(start, facet)
			local allocation = allocations[facet or "geometry"]
			local queue, head, capacity = { start }, 1, allocation.visits
			local work = newWorkBudget()
			work.maxItems = allocation.work
			work.cancelled = function()
				return not isCurrent() or state.tornDown or state.socket ~= requestContext.socket or not state.acknowledged
			end
			local prefix = facet and facet .. "-" or ""
			if capacity <= 0 then partial(prefix .. "visit-limit", facet); return end
			local ok, readError = pcall(function()
				while head <= #queue do
					fence()
					local node = queue[head]
					head = head + 1
					result.visited = result.visited + 1
					facets[facet or "geometry"].visited = facets[facet or "geometry"].visited + 1
					local skipChildren, stop = false, false
					local nodeOk = pcall(function()
						if facet == "remotes" then
							local className = node.ClassName
							if className == "RemoteEvent" or className == "RemoteFunction" or className == "UnreliableRemoteEvent" then
								if #result.remotes.entries >= remoteLimit then partial("remote-limit", facet); stop = true; return end
								local row = metadata(node, facet)
								if row and not append(result.remotes.entries, row, facet) then stop = true end
							end
						elseif node:IsA("LuaSourceContainer") then
							skipChildren = true
						elseif node:IsA("Terrain") then
							skipChildren = true
							partial("terrain-omitted")
						elseif facet == "ui" then
							if node:IsA("GuiBase2d") or node:IsA("LayerCollector") or node:IsA("UIComponent") then
								if #result.ui.entries >= uiLimit then partial("ui-limit", facet); stop = true; return end
								local row = metadata(node, facet)
								if not row then return end
								local text = safeProperty(node, "Text")
								if type(text) == "string" then
									row.text = redaction.sensitiveKey(node.Name) and "[redacted]" or boundedText(redactString(text), 256, facet)
								end
								if not append(result.ui.entries, row, facet) then stop = true end
							end
						elseif node:IsA("BasePart") then
							if selectedInstances[node] then return end
							if not reachable(node) then partial("geometry-unavailable"); return end
							if #result.parts >= maxParts then partial("part-limit"); stop = true; return end
							local row = metadata(node)
							if not row then return end
							local components, size = frame(node)
							if not components then partial("geometry-unavailable"); return end
							if type(node.Anchored) ~= "boolean" or type(node.CanCollide) ~= "boolean" then
								partial("geometry-unavailable"); return
							end
							row.cframe, row.size, row.anchored, row.canCollide = components, size, node.Anchored, node.CanCollide
							row.sourceObjectId = freshId()
							partMetadata(node, row)
							if player and safeProperty(player, "Character") == collisionCharacter then
								row.collidesWithCharacter = collisionRelation(node, collisionGroups, physicsService)
								if safeProperty(player, "Character") ~= collisionCharacter then row.collidesWithCharacter = nil end
							end
							if not append(result.parts, row) then stop = true
							else
								selectedInstances[node] = true
								table.insert(bindings, { instance = node, row = row })
							end
						end
					end)
					if not nodeOk then partial(facet and prefix .. "node-unavailable" or "geometry-unavailable", facet) end
					checkpointWork(work)
					if stop then break end
					if not skipChildren then
						local childrenOk, children, clipped = pcall(sortedChildren, node, capacity - #queue, work)
						if not childrenOk then
							if children == "Read work limit exceeded" or children == "Read interrupted" then error(children, 0) end
							partial(prefix .. "children-unavailable", facet)
						else
							if clipped then partial(prefix .. "visit-limit", facet) end
							for _, child in ipairs(children) do table.insert(queue, child); checkpointWork(work) end
						end
					end
				end
			end)
			if not ok then
				if readError ~= "Read work limit exceeded" then error(readError, 0) end
				partial("work-limit", facet)
			end
		end
		walk(root)
		if uiLimit == 0 then
			partial("ui-excluded", "ui")
		else
			local ok, playerGui = pcall(function() return player and player:FindFirstChildOfClass("PlayerGui") end)
			if not ok or not playerGui then partial("player-gui-unavailable", "ui")
			else walk(playerGui, "ui") end
		end
		if remoteLimit == 0 then
			partial("remotes-excluded", "remotes")
		else
			local ok, storage = pcall(function() return game:GetService("ReplicatedStorage") end)
			local path = ok and storage and boundedText(safePath(storage), 1024, "remotes") or nil
			if not path or path == "[unavailable]" then
				partial("remotes-unavailable", "remotes")
			else
				result.remotes.root = path
				walk(storage, "remotes")
			end
		end
		fence()
		if bytes(result) > maximumBytes then error("Game context result limit exceeded", 0) end
		flow.sweep()
		-- Commit without yielding: reconcile concurrent captures against live owned identities.
		local retainedBytes = bytes(result.parts)
		while #flow.order >= 8 or flow.count + flow.holds + #bindings > 1024 or flow.bytes + retainedBytes > 262144 do
			if #flow.order == 0 then error("MAP_CONTEXT_LIMIT: snapshot retention", 0) end
			remove(flow.order[1])
		end
		local record = { objects = {}, rows = {}, count = #bindings, bytes = retainedBytes, expiresAt = os.clock() + 180 }
		for _, binding in ipairs(bindings) do
			local entry = flow.reverse[binding.instance]
			if not entry then
				entry = { instance = binding.instance, id = binding.row.sourceObjectId, owners = 0, holds = 0 }
				flow.reverse[binding.instance] = entry
			end
			binding.row.sourceObjectId = entry.id
			entry.owners = entry.owners + 1
			record.objects[entry.id], record.rows[entry.id] = entry, binding.row
		end
		flow.records[result.sourceSnapshotId] = record
		table.insert(flow.order, result.sourceSnapshotId)
		flow.count, flow.bytes = flow.count + record.count, flow.bytes + record.bytes
		requestContext.createdMapSnapshot = result.sourceSnapshotId
		scheduleLifecycleSweep()
		return result
	end
		local function health(current)
			local ok, humanoid = pcall(function() return current and current:FindFirstChildOfClass("Humanoid") end)
			local value = ok and humanoid and safeProperty(humanoid, "Health")
			return finiteNumber(value) and value >= 0 and value <= 1e9 and value or nil
		end
		local function associated(current, player, targets)
			-- A bounded overlap at the health sample is correlation, never damage causation.
			-- Only the current root and owned targets are queried; missing geometry is unknown.
			local ok, ids = pcall(function()
				if not current or not reachable(current) then return {} end
				local root = current:FindFirstChild("HumanoidRootPart")
				if not root or not reachable(root) or not frame(root) then return {} end
				local selected, owned = {}, {}
				for _, entry in ipairs(targets) do
					local instance = entry.instance
					if instance and reachable(instance) and not instance:IsDescendantOf(current) and frame(instance) then
						table.insert(selected, instance)
						owned[instance] = entry.id
					end
				end
				if #selected == 0 then return {} end
				local overlap = OverlapParams.new()
				overlap.FilterType = Enum.RaycastFilterType.Include
				overlap.FilterDescendantsInstances = selected
				overlap.MaxParts = 16
				overlap.RespectCanCollide = false
				local hits = workspace:GetPartsInPart(root, overlap)
				if type(hits) ~= "table" or #hits > 16 or safeProperty(player, "Character") ~= current then return {} end
				local output, seenHits = {}, {}
				for _, hit in ipairs(hits) do
					local id = owned[hit]
					if id and not seenHits[id] and reachable(hit) then
						seenHits[id] = true
						table.insert(output, id)
					end
				end
				table.sort(output)
				return output
			end)
			return ok and ids or {}
		end
	-- Record-owned timers and holds outlive the admission request, not the generation.
	do
		local recordings = state.mapRecordings
		local finish, schedule
		local function validMarkerLabel(value)
			if type(value) ~= "string" or #value == 0 or #value > 256 or utf8.len(value) == nil then return false end
			-- Match the public JavaScript string-length contract, not UTF-8 byte length.
			local units = 0
			for _, codepoint in utf8.codes(value) do
				units = units + (codepoint > 65535 and 2 or 1)
				if units > 64 then return false end
			end
			return true
		end
		local function accountGap(record, now, sampled)
			if not record.lastSampleAt then return end
			local intervals = math.floor((math.min(now, record.deadline) - record.lastSampleAt) / (record.intervalMs / 1000) + 1e-7)
			local missed = math.max(0, intervals - (sampled and 1 or 0))
			record.missedIntervals = record.missedIntervals + missed
			if missed > 0 then record.coverage = "partial" end
		end
		local function removeRecording(id)
			local record = recordings.records[id]
			if not record then return false end
			finish(record, "released")
			recordings.records[id] = nil
			local index = table.find(recordings.order, id)
			if index then table.remove(recordings.order, index) end
			return true
		end
		finish = function(record, reason, failed)
			if record.state == "stopped" or record.state == "failed" then return end
			record.state = failed and "failed" or "stopped"
			record.stoppedAt = os.clock()
			accountGap(record, record.stoppedAt, false)
			record.expiresAt = record.stoppedAt + 120
			table.insert(record.stopReasons, reason)
			if reason ~= "duration-complete" and reason ~= "user-stop" then record.coverage = "partial" end
			if record.timer then pcall(task.cancel, record.timer); record.timer = nil end
			flow.releaseRequest(record)
			record.socket, record.character, record.player = nil, nil, nil
			recordings.active = recordings.active - 1
		end
		function recordings.sweep()
			local now = os.clock()
			for index = #recordings.order, 1, -1 do
				local record = recordings.records[recordings.order[index]]
				if record.expiresAt and now >= record.expiresAt then removeRecording(record.id) end
			end
		end
		function recordings.disconnect(socket)
			for _, record in pairs(recordings.records) do
				if record.socket == socket then finish(record, "socket-disconnected") end
			end
		end
		function recordings.teardown()
			while #recordings.order > 0 do removeRecording(recordings.order[1]) end
		end
		function recordings.rollback(context)
			if context.createdMapRecording then removeRecording(context.createdMapRecording) end
		end
		function recordings.resources()
			local timers, holds, samples, events, misses = 0, 0, 0, 0, 0
			for _, record in pairs(recordings.records) do
				timers = timers + (record.timer and 1 or 0)
				holds = holds + #(flow.requests[record] or {})
				samples, events = samples + record.sampleBytes, events + record.eventBytes
				misses = misses + record.missedIntervals
			end
			return { active = recordings.active, retained = #recordings.order, timers = timers, holds = holds,
				sampleBytes = samples, eventBytes = events, usedBytes = samples + events,
				allocatedBytes = #recordings.order * (2097152 + 65536), retainedDrops = 0,
				missedIntervals = misses, maxActive = 4, maxRetained = 8 }
		end
		local function metadata(record)
			local now = os.clock()
			if record.state == "recording" and now > record.deadline then finish(record, "duration-complete"); now = os.clock() end
			local elapsed = math.max(0, ((record.stoppedAt or now) - record.startedAt) * 1000)
			return { recordingId = record.id, state = record.state,
				ready = record.state == "recording" and #record.frames > 0 and record.timer ~= nil,
				clock = "client-monotonic-seconds", atomicSnapshot = false,
				acceptedAt = record.acceptedAt, startedAt = record.startedAt, firstSampleAt = record.firstSampleAt,
				readyAt = record.readyAt, lastSampleAt = record.lastSampleAt, stoppedAt = record.stoppedAt,
				expiresAt = record.expiresAt, now = now, durationMs = record.durationMs, intervalMs = record.intervalMs,
				elapsedMs = elapsed, remainingMs = record.state == "recording" and math.max(0, record.durationMs - elapsed) or 0,
				frameCount = #record.frames, sampleCount = #record.frames * #record.targets,
				eventCount = #record.events, markerCount = record.markerCount, missedIntervals = record.missedIntervals,
				retainedDrops = 0, sampleBytes = record.sampleBytes, eventBytes = record.eventBytes,
				coverage = record.coverage, stopReasons = table.clone(record.stopReasons), targets = record.targets }
		end
		local function event(record, row)
			row.sequence = #record.events + 1
			local size = bytes(row) + 1
			if #record.events >= 256 then finish(record, "event-limit"); return false end
			if record.eventBytes + size > 65536 then finish(record, "event-byte-limit"); return false end
			table.insert(record.events, row)
			record.eventBytes = record.eventBytes + size
			return true
		end
		local function sample(record)
			if not isCurrent() or state.tornDown then finish(record, "generation-changed"); return false end
			if state.socket ~= record.socket or not state.acknowledged then finish(record, "socket-disconnected"); return false end
			local now = os.clock()
			if now > record.deadline then finish(record, "duration-complete"); return false end
			if #record.frames >= 1201 then finish(record, "frame-limit"); return false end
			local row = { sequence = #record.frames + 1, t = now - record.startedAt, samples = {} }
			for _, entry in ipairs(flow.requests[record] or {}) do
				local target = entry.instance
				if not target or not reachable(target) then finish(record, "object-destroyed-or-unreachable", #record.frames == 0); return false end
				local cf, size = frame(target)
				if not cf then finish(record, "geometry-unavailable", #record.frames == 0); return false end
				local sampledAt = os.clock()
				if sampledAt > record.deadline then finish(record, "duration-complete"); return false end
				table.insert(row.samples, { sourceObjectId = entry.id, t = sampledAt - record.startedAt, cframe = cf, size = size })
			end
			local size = bytes(row) + 1
			if record.sampleBytes + size > 2097152 then finish(record, "sample-byte-limit"); return false end
			accountGap(record, now, true)
			table.insert(record.frames, row)
			record.sampleBytes = record.sampleBytes + size
			record.firstSampleAt = record.firstSampleAt or now
			record.lastSampleAt = os.clock()
			local current = record.player and safeProperty(record.player, "Character")
			local currentHealth = health(current)
			local function healthEvent(kind, amount, ids)
				return event(record, { t = row.t, kind = kind, amount = amount, objectIds = ids or {},
					association = "spatial-temporal-correlation" })
			end
			if current ~= record.character then
				if current and not healthEvent("respawn") then return false end
			elseif currentHealth and record.previousHealth and currentHealth < record.previousHealth then
				local ids = associated(current, record.player, flow.requests[record])
				if not healthEvent("health-drop", record.previousHealth - currentHealth, ids) then return false end
				if currentHealth == 0 and record.previousHealth > 0 and not healthEvent("death", nil, ids) then return false end
			end
			record.character, record.previousHealth = current, currentHealth
			return true
		end
		schedule = function(record)
			local now = os.clock()
			if now >= record.deadline then finish(record, "duration-complete"); return end
			local due = math.min(record.lastSampleAt + record.intervalMs / 1000, record.deadline)
			record.timer = task.delay(math.max(0, due - now), function()
				record.timer = nil
				if record.state ~= "recording" then return end
				local ok = pcall(function() if sample(record) then schedule(record) end end)
				if not ok then finish(record, "sampler-failed", true) end
			end)
		end
		function handlers.map_recording(params, context)
			strictObject(params, { operation = true, targets = true, durationMs = true, intervalMs = true,
				recordingId = true, label = true, view = true, afterCursor = true, limit = true, _maxResultBytes = true }, "params")
			local op = params.operation
			if op ~= "start" and op ~= "poll" and op ~= "mark" and op ~= "stop" and op ~= "release" then error("Invalid map recording operation", 0) end
			local allowed = op == "start" and { targets = true, durationMs = true, intervalMs = true }
				or op == "poll" and { recordingId = true, view = true, afterCursor = true, limit = true }
				or op == "mark" and { recordingId = true, label = true } or { recordingId = true }
			for key in pairs(params) do
				if key ~= "operation" and key ~= "_maxResultBytes" and not allowed[key] then error("Invalid selector for map recording operation: " .. key, 0) end
			end
			local maximum = strictInteger(params._maxResultBytes, 65536, 1, 65536, "_maxResultBytes")
			requestFence(context)
			recordings.sweep()
			local record
			if op == "start" then
				strictArray(params.targets, 1, 4, "targets")
				local duration = strictInteger(params.durationMs, 30000, 1000, 60000, "durationMs")
				local interval = strictInteger(params.intervalMs, 100, 50, 1000, "intervalMs")
				flow.sweep()
				if recordings.active >= 4 or #recordings.order >= 8 then error("MAP_RECORDING_LIMIT: recording capacity", 0) end
				local entries, targets, seen = {}, {}, {}
				for _, selection in ipairs(params.targets) do
					strictObject(selection, { sourceSnapshotId = true, sourceObjectId = true }, "target")
					if not isResourceId(selection.sourceSnapshotId) or not isResourceId(selection.sourceObjectId) then error("Invalid recording target identity", 0) end
					local snapshot = flow.records[selection.sourceSnapshotId]
					local entry = snapshot and snapshot.objects[selection.sourceObjectId]
					if not entry then error("MAP_CONTEXT_SOURCE_UNAVAILABLE: recording target not owned", 0) end
					if seen[entry] then error("Duplicate recording target", 0) end
					seen[entry] = true
					local source = snapshot.rows[selection.sourceObjectId]
					table.insert(entries, entry)
					table.insert(targets, { sourceSnapshotId = selection.sourceSnapshotId, sourceObjectId = entry.id,
						path = source.path, className = source.className, size = source.size, anchored = source.anchored,
						canCollide = source.canCollide, canTouch = source.canTouch })
				end
				if flow.count + flow.holds + #entries > 1024 then error("MAP_RECORDING_LIMIT: target retention", 0) end
				local now = os.clock()
				record = { id = freshId(), state = "starting", acceptedAt = now, startedAt = now, deadline = now + duration / 1000,
					durationMs = duration, intervalMs = interval, frames = {}, events = {}, targets = targets,
					sampleBytes = 0, eventBytes = 0, markerCount = 0, missedIntervals = 0, coverage = "complete",
					stopReasons = {}, socket = context.socket, player = Players.LocalPlayer }
				record.character = record.player and safeProperty(record.player, "Character")
				record.previousHealth = health(record.character)
				recordings.records[record.id] = record
				table.insert(recordings.order, record.id)
				recordings.active = recordings.active + 1
				context.createdMapRecording = record.id
				flow.requests[record], flow.holds = entries, flow.holds + #entries
				for _, entry in ipairs(entries) do entry.holds = entry.holds + 1 end
				if sample(record) then
					record.state = "recording"
					schedule(record)
					if record.timer then record.readyAt = os.clock() end
				end
				scheduleLifecycleSweep()
			else
				if not isResourceId(params.recordingId) then error("Invalid recordingId", 0) end
				record = recordings.records[params.recordingId]
				if op == "release" then return { recordingId = params.recordingId, released = removeRecording(params.recordingId) } end
				if not record then error("MAP_RECORDING_UNAVAILABLE: recording expired or released", 0) end
				if op == "stop" then finish(record, "user-stop")
				elseif op == "mark" then
					if not validMarkerLabel(params.label) then error("Invalid recording marker label", 0) end
					local label = optionalText(params.label, 256)
					if not validMarkerLabel(label) then error("Invalid recording marker label", 0) end
					if record.state ~= "recording" then error("MAP_RECORDING_TERMINAL: marker requires active recording", 0) end
					local receiptAt = os.clock()
					if receiptAt >= record.deadline then finish(record, "duration-complete"); error("MAP_RECORDING_TERMINAL: deadline reached", 0) end
					if record.markerCount >= 32 then finish(record, "marker-limit"); error("MAP_RECORDING_LIMIT: markers", 0) end
					if event(record, { t = receiptAt - record.startedAt, kind = "marker", label = label, source = "mcp-request" }) then
						record.markerCount = record.markerCount + 1
					end
				end
			end
			local result = { metadata = metadata(record) }
			if op == "poll" then
				local view = params.view or "summary"
				if view ~= "summary" and view ~= "frames" and view ~= "events" then error("Invalid recording view", 0) end
				if view == "summary" and (params.afterCursor ~= nil or params.limit ~= nil) then error("Page selectors require frames or events", 0) end
				result.view, result.cursor, result.nextCursor, result.hasMore = view, 0, 0, false
				if view ~= "summary" then
					local rows = record[view]
					local cursor = strictInteger(params.afterCursor, 0, 0, #rows, "afterCursor")
					local limit = strictInteger(params.limit, 10, 1, 20, "limit")
					result.cursor, result.nextCursor, result[view] = cursor, cursor, {}
					for index = cursor + 1, math.min(#rows, cursor + limit) do
						table.insert(result[view], rows[index])
						result.nextCursor, result.hasMore = index, index < #rows
						if bytes(result) > maximum then
							table.remove(result[view]); result.nextCursor = index - 1; result.hasMore = true
							if index == cursor + 1 then error("MAP_RECORDING_LIMIT: complete entry exceeds page budget", 0) end
							break
						end
					end
				end
			end
			if bytes(result) > maximum then error("MAP_RECORDING_LIMIT: result bytes", 0) end
			return result
		end
	end
	function handlers.map_observe(params, context)
		strictObject(params, { sourceSnapshotId = true, objectIds = true, durationMs = true, intervalMs = true, _maxResultBytes = true }, "params")
		if not isResourceId(params.sourceSnapshotId) then error("Invalid sourceSnapshotId", 0) end
		strictArray(params.objectIds, 1, 16, "objectIds")
		local duration = strictInteger(params.durationMs, 2000, 100, 5000, "durationMs")
		local interval = strictInteger(params.intervalMs, 100, 50, 1000, "intervalMs")
		local limit = strictInteger(params._maxResultBytes, 65536, 1, 65536, "_maxResultBytes")
		requestFence(context)
		flow.sweep()
		local record = flow.records[params.sourceSnapshotId]
		if not record then error("MAP_CONTEXT_SOURCE_UNAVAILABLE: snapshot expired or disconnected", 0) end
		local result = { schema = 1, sourceSnapshotId = params.sourceSnapshotId, durationMs = duration, intervalMs = interval,
			clock = "observation-relative-seconds", tracks = {}, events = {}, coverage = "complete", truncated = false, stopReasons = {} }
		local targets, seen = {}, {}
		for _, id in ipairs(params.objectIds) do
			if not isResourceId(id) or seen[id] then error("Invalid or duplicate objectId", 0) end
			seen[id] = true
			local entry, row = record.objects[id], record.rows[id]
			if not entry then error("MAP_CONTEXT_SOURCE_UNAVAILABLE: object not owned by snapshot", 0) end
			table.insert(targets, entry)
			table.insert(result.tracks, { sourceObjectId = id, path = row.path, className = row.className, size = row.size,
				canCollide = row.canCollide, anchored = row.anchored, canTouch = row.canTouch, samples = {} })
		end
		local function partial(reason)
			result.coverage, result.truncated = "partial", true
			if not table.find(result.stopReasons, reason) then table.insert(result.stopReasons, reason) end
		end
		-- Reserve all per-target terminal reasons and event/coverage overhead first.
		local charged = bytes(result) + 1024 + #targets * 160
		if charged > limit then error("MAP_CONTEXT_LIMIT: observation metadata exceeds result limit", 0) end
		if flow.count + flow.holds + #targets > 1024 then error("MAP_CONTEXT_LIMIT: observation target retention", 0) end
		flow.requests[context], flow.holds = targets, flow.holds + #targets
		for _, entry in ipairs(targets) do entry.holds = entry.holds + 1 end
		local allowance = math.floor((limit - charged) / #targets)
		local used = table.create(#targets, 0)
		local started = os.clock()
		local player = Players.LocalPlayer
		local character = player and safeProperty(player, "Character")
		local previousHealth = health(character)
		local function event(t, kind, amount, ids)
			if #result.events >= 64 then partial("event-limit"); return end
			local row = { t = t, kind = kind, objectIds = ids or {}, amount = amount, association = "spatial-temporal-correlation" }
			if bytes(result.events) + bytes(row) > 768 then partial("event-byte-limit"); return end
			table.insert(result.events, row)
		end
		for sampleIndex = 1, 101 do
			requestFence(context)
			local elapsed = os.clock() - started
			if elapsed > duration / 1000 then
				if elapsed - duration / 1000 > interval / 1000 then partial("scheduler-delay") end
				break
			end
			for index, track in ipairs(result.tracks) do
				if not track.unavailable then
					local target = targets[index].instance
					if not target or not reachable(target) then
						track.unavailable = "object-destroyed-or-unreachable"; partial("target-unavailable")
					else
						local cf, size = frame(target)
						if not cf then track.unavailable = "geometry-unavailable"; partial("target-unavailable")
						else
							local sample = { t = elapsed, cframe = cf, size = size }
							local sampleBytes = bytes(sample) + 1
							if used[index] + sampleBytes > allowance then
								track.unavailable = "sample-byte-limit"; partial("byte-limit")
							else
								table.insert(track.samples, sample); used[index] = used[index] + sampleBytes
							end
						end
					end
				end
			end
			local current = player and safeProperty(player, "Character")
			local currentHealth = health(current)
			if current ~= character then
				if current then event(elapsed, "respawn") end
			elseif currentHealth and previousHealth and currentHealth < previousHealth then
				local ids = associated(current, player, targets)
				event(elapsed, "health-drop", previousHealth - currentHealth, ids)
				if currentHealth == 0 and previousHealth > 0 then event(elapsed, "death", nil, ids) end
			end
			character, previousHealth = current, currentHealth
			if elapsed >= duration / 1000 then break end
			if sampleIndex == 101 then partial("sample-limit"); break end
			task.wait(math.min(interval / 1000, duration / 1000 - elapsed))
			requestFence(context)
		end
		requestFence(context)
		if bytes(result) > limit then error("MAP_CONTEXT_LIMIT: observation result", 0) end
		return result
	end
	function handlers.map_probe(params, context)
		strictObject(params, { center = true, size = true, columns = true, rows = true, maxDistance = true, _maxResultBytes = true }, "params")
		strictObject(params.center, { x = true, y = true, z = true }, "center")
		strictObject(params.size, { x = true, y = true, z = true }, "size")
		local center, size = strictVector(params.center, "center"), strictVector(params.size, "size")
		for _, value in pairs(params.center) do if math.abs(value) > 10000000 then error("center exceeds world bounds", 0) end end
		for _, value in pairs(params.size) do if value <= 0 or value > 10000 then error("size must be positive and bounded", 0) end end
		local columns = strictInteger(params.columns, 4, 2, 8, "columns")
		local rows = strictInteger(params.rows, 4, 2, 8, "rows")
		local distance = params.maxDistance or 256
		if not finiteNumber(distance) or distance <= 0 or distance > 10000 then error("Invalid maxDistance", 0) end
		local limit = strictInteger(params._maxResultBytes, 32768, 1, 32768, "_maxResultBytes")
		requestFence(context)
		local result = { schema = 1, center = vectorDto(center), size = vectorDto(size), columns = columns, rows = rows,
			samples = {}, coverage = "complete", truncated = false, stopReasons = {} }
		local charged = bytes(result) + 256
		if charged > limit then error("MAP_CONTEXT_LIMIT: probe metadata", 0) end
		local rayParams = RaycastParams.new()
		rayParams.FilterType = Enum.RaycastFilterType.Exclude
		local character = Players.LocalPlayer and safeProperty(Players.LocalPlayer, "Character")
		rayParams.FilterDescendantsInstances = character and { character } or {}
		local work = newWorkBudget()
		work.maxItems = 64
		work.cancelled = function()
			return not isCurrent() or state.tornDown or state.socket ~= context.socket or not state.acknowledged
		end
		for row = 1, rows do
			for column = 1, columns do
				requestFence(context)
				-- Work checkpoints may yield across a respawn; never raycast with a stale exclusion.
				character = Players.LocalPlayer and safeProperty(Players.LocalPlayer, "Character")
				rayParams.FilterDescendantsInstances = character and { character } or {}
				local origin = Vector3.new(center.X + size.X * ((column - 1) / (columns - 1) - 0.5),
					center.Y + size.Y / 2, center.Z + size.Z * ((row - 1) / (rows - 1) - 0.5))
				local ok, hit = pcall(workspace.Raycast, workspace, origin, Vector3.new(0, -distance, 0), rayParams)
				if not ok then
					result.coverage, result.truncated = "partial", true
					if not table.find(result.stopReasons, "raycast-unavailable") then table.insert(result.stopReasons, "raycast-unavailable") end
				else
					local sample = { column = column - 1, row = row - 1, origin = vectorDto(origin), hit = hit ~= nil }
					if hit then
						sample.position, sample.normal = vectorDto(hit.Position), vectorDto(hit.Normal)
						sample.path = optionalText(safePath(hit.Instance), 1024)
						sample.className = optionalText(safeProperty(hit.Instance, "ClassName"), 64)
						sample.material = optionalText(string.match(tostring(hit.Material), "[^.]+$"), 64)
						if not sample.position or not sample.normal then
							result.coverage, result.truncated = "partial", true
							if not table.find(result.stopReasons, "hit-metadata-unavailable") then table.insert(result.stopReasons, "hit-metadata-unavailable") end
							sample = nil
						end
					end
					if sample then
						local count = bytes(sample) + 1
						if charged + count > limit then
							result.coverage, result.truncated = "partial", true
							table.insert(result.stopReasons, "byte-limit")
							return result
						end
						charged = charged + count
						table.insert(result.samples, sample)
					end
				end
				checkpointWork(work)
			end
		end
		requestFence(context)
		if bytes(result) > limit then error("MAP_CONTEXT_LIMIT: probe result", 0) end
		return result
	end
end

-- Bounded snapshots own row/root Instance wrappers until cleanup; this does not
-- prevent engine destruction or detachment. Textual paths are never identity.
do
	local flow = state.remoteWorkflow
	local remoteClasses = { RemoteEvent = true, RemoteFunction = true, UnreliableRemoteEvent = true }
	local rowFields = { name = true, className = true, path = true, parent = true }
	local function removeSnapshot(id)
		local snapshot = flow.snapshots[id]
		if not snapshot then return false end
		flow.snapshotBytes = flow.snapshotBytes - snapshot.bytes
		flow.snapshots[id] = nil
		for index, candidate in ipairs(flow.snapshotOrder) do
			if candidate == id then table.remove(flow.snapshotOrder, index); break end
		end
		return true
	end
	function flow.pruneSnapshots()
		local now = os.clock()
		for index = #flow.snapshotOrder, 1, -1 do
			local id = flow.snapshotOrder[index]
			if now >= flow.snapshots[id].deadline then removeSnapshot(id) end
		end
	end
	function flow.releaseSnapshot(id) return removeSnapshot(id) end
	local function getSnapshot(id)
		if not isResourceId(id) then error("Invalid remote snapshot id", 0) end
		local snapshot = flow.snapshots[id]
		if not snapshot then error("Remote snapshot unavailable: expired, released, evicted, or another generation", 0) end
		return snapshot
	end
	local function text(value, maximum, field)
		if value == nil then return nil end
		if type(value) ~= "string" or #value > maximum then
			error(field .. " must be a bounded string", 0)
		end
		return value
	end
	local function filters(params)
		local selected, names = {}, {}
		if params.classNames ~= nil then
			strictArray(params.classNames, 1, 3, "classNames")
			for _, className in ipairs(params.classNames) do
				if not remoteClasses[className] then error("Unsupported remote class", 0) end
				if not selected[className] then
					selected[className] = true
					table.insert(names, className)
				end
			end
		else
			for className in pairs(remoteClasses) do selected[className] = true; table.insert(names, className) end
		end
		table.sort(names)
		return {
			nameContains = string.lower(text(params.nameContains, 256, "nameContains") or ""),
			pathContains = string.lower(text(params.pathContains, 512, "pathContains") or ""),
			classNames = names,
		}, selected
	end
	local function sameFilters(left, right)
		return left.nameContains == right.nameContains and left.pathContains == right.pathContains
			and table.concat(left.classNames, ",") == table.concat(right.classNames, ",")
	end
	local function identity(instance, rootIdentity, fallback)
		for _, id in ipairs(flow.snapshotOrder) do
			local snapshot = flow.snapshots[id]
			if rootIdentity and snapshot.rootInstance[1] == instance then return snapshot.rootIdentity end
			if not rootIdentity and snapshot.reverse[instance] then return snapshot.reverse[instance] end
		end
		if fallback then return fallback end
		local id = newResourceId({})
		if not id then error("Remote snapshot identity unavailable", 0) end
		return id
	end
	local function buildGroups(rows)
		local groups, byKey = {}, {}
		for _, row in ipairs(rows) do
			local key = row.parent .. "\0" .. row.className
			local group = byKey[key]
			if not group then
				group = { parent = row.parent, className = row.className, count = 0 }
				byKey[key] = group
				table.insert(groups, group)
			end
			group.count = group.count + 1
		end
		table.sort(groups, function(a, b)
			return a.parent == b.parent and a.className < b.className or a.parent < b.parent
		end)
		return groups
	end
	local function scan(params, normalized, selected, requestContext)
		local rootPath = text(params.root or "game", 1024, "root")
		local root, pathError = resolvePath(rootPath)
		if not root then error(pathError, 0) end
		local id = newResourceId(flow.snapshots)
		if not id then error("Remote snapshot identity unavailable", 0) end
		local rootIdentity = identity(root, true)
		local rows, classes, reasons = {}, {}, {}
		local instances = {}
		local reverse = setmetatable({}, { __mode = "k" })
		local maximum = strictInteger(params.maxVisited, 5000, 1, 20000, "maxVisited")
		local work = newWorkBudget()
		work.maxItems = MAX_BATCH_WORK_ITEMS
		local visited, matched, charged = 0, 0, 16384
		local queue, head, visitLimited = { root }, 1, false
		local ok, scanError = pcall(function()
			while head <= #queue and visited < maximum do
				if not isCurrent() or not requestContext or state.socket ~= requestContext.socket
					or not state.acknowledged then error("Remote snapshot interrupted", 0) end
				local node = queue[head]
				head = head + 1
				visited = visited + 1
				local className = node.ClassName
				if selected[className] then
					local name, path = redactString(node.Name), safePath(node)
					if string.find(string.lower(name), normalized.nameContains, 1, true)
						and string.find(string.lower(path), normalized.pathContains, 1, true) then
						matched = matched + 1
						classes[className] = (classes[className] or 0) + 1
						if #rows == 512 then table.insert(reasons, "row-limit"); break end
						local row = {
							rowId = identity(node, false), name = name, path = path,
							className = className, parent = node.Parent and safePath(node.Parent) or "",
						}
						-- Reserve both the row and its worst-case separate parent group.
						local bytes = #HttpService:JSONEncode(row) * 2 + 128
						if charged + bytes > 262144 then table.insert(reasons, "byte-limit"); break end
						charged = charged + bytes
						table.insert(rows, row)
						instances[row.rowId], reverse[node] = node, row.rowId
					end
				end
				checkpointWork(work)
				local children, clipped = sortedChildren(node, maximum - #queue, work)
				visitLimited = visitLimited or clipped
				for _, child in ipairs(children) do table.insert(queue, child); checkpointWork(work) end
			end
		end)
		if not ok then
			if scanError == "Read work limit exceeded" then table.insert(reasons, "work-limit")
			else error(scanError, 0) end
		end
		if visitLimited or (head <= #queue and visited >= maximum) then table.insert(reasons, "visit-limit") end
		-- Final commit below is non-yielding, and cannot publish after teardown.
		if not isCurrent() or state.socket ~= requestContext.socket or not state.acknowledged then
			error("Remote snapshot interrupted", 0)
		end
		-- Concurrent scans may have committed while traversal yielded. Reconcile
		-- live identities at this non-yielding boundary before publishing.
		rootIdentity = identity(root, true, rootIdentity)
		for _, row in ipairs(rows) do
			local instance = instances[row.rowId]
			local rowId = instance and identity(instance, false, row.rowId) or row.rowId
			if rowId ~= row.rowId then
				instances[row.rowId], instances[rowId], reverse[instance] = nil, instance, rowId
				row.rowId = rowId
			end
		end
		local metadata = {
			snapshotId = id, generation = generation, root = safePath(root), rootIdentity = rootIdentity,
			filters = normalized, visited = visited, matchedVisited = matched, retained = #rows,
			coverage = #reasons == 0 and "complete" or "partial", truncated = #reasons > 0,
			stopReasons = reasons, classes = classes, groups = buildGroups(rows), results = rows,
			groupCoverage = "retained-rows", atomicSnapshot = false,
		}
		local bytes = #HttpService:JSONEncode(metadata)
		if bytes > 262144 then error("Remote snapshot metadata byte limit exceeded", 0) end
		flow.pruneSnapshots()
		while #flow.snapshotOrder >= 8 or flow.snapshotBytes + bytes > 1048576 do
			removeSnapshot(flow.snapshotOrder[1])
		end
		local snapshot = {
			metadata = metadata, bytes = bytes, deadline = os.clock() + 120,
			rootIdentity = rootIdentity, rootInstance = { root },
			instances = instances, reverse = reverse,
		}
		flow.snapshots[id] = snapshot
		table.insert(flow.snapshotOrder, id)
		flow.snapshotBytes = flow.snapshotBytes + bytes
		requestContext.createdRemoteSnapshot = id
		scheduleLifecycleSweep()
		return snapshot
	end
	local function projection(row, fields, bindings, snapshot)
		local result = { rowId = row.rowId }
		for _, field in ipairs(fields) do result[field] = row[field] end
		if bindings then
			local instance = snapshot.instances[row.rowId]
			local ok, reachable = pcall(function() return instance and instance:IsDescendantOf(game) end)
			if ok and reachable then
				table.insert(bindings, { summary = result, instance = instance })
			else
				result.referenceUnavailable = true
			end
		end
		return result
	end
	local function changes(snapshot, before)
		local output, old, present = {}, {}, {}
		for _, row in ipairs(before.metadata.results) do old[row.rowId] = row end
		for _, row in ipairs(snapshot.metadata.results) do
			present[row.rowId] = true
			local previousRow = old[row.rowId]
			if not previousRow then
				table.insert(output, { kind = "added", rowId = row.rowId, after = row })
			elseif previousRow.name ~= row.name or previousRow.path ~= row.path
				or previousRow.parent ~= row.parent or previousRow.className ~= row.className then
				table.insert(output, { kind = "changed", rowId = row.rowId, before = previousRow, after = row })
			end
		end
		for _, row in ipairs(before.metadata.results) do
			if not present[row.rowId] then table.insert(output, { kind = "removed", rowId = row.rowId, before = row }) end
		end
		table.sort(output, function(a, b) return a.rowId < b.rowId end)
		return output
	end
	local function detail(params, requestContext)
		for _, field in ipairs({ "compareTo", "cursor", "nameContains", "pathContains", "classNames", "fields" }) do
			if params[field] ~= nil then error(field .. " is not supported in detail view", 0) end
		end
		if params.includeSiblingValues ~= nil and type(params.includeSiblingValues) ~= "boolean" then
			error("includeSiblingValues must be a boolean", 0)
		end
		local limit = strictInteger(params.limit, 20, 1, 50, "limit")
		local maximum = strictInteger(params.maxVisited, 5000, 1, 20000, "maxVisited")
		local maximumBytes = math.min(MAX_BATCH_RESULT_BYTES, referenceResultLimit(params))
		local bindings = referenceBindings(params)
		local names, seenNames = {}, {}
		if params.attributeNames ~= nil then
			strictArray(params.attributeNames, 0, 32, "attributeNames")
			for _, name in ipairs(params.attributeNames) do
				if type(name) ~= "string" or #name < 1 or #name > 128 then error("Invalid attribute name", 0) end
				if not seenNames[name] then seenNames[name] = true; table.insert(names, name) end
			end
			table.sort(names)
		end
		local instance, snapshot, retainedRow
		if params.root ~= nil then
			if params.snapshotId ~= nil or params.rowId ~= nil then error("detail requires root or snapshotId with rowId", 0) end
			if type(params.root) ~= "string" or #params.root < 1 or #params.root > 1024 then error("Invalid detail root", 0) end
			local pathError
			instance, pathError = resolvePath(params.root)
			if not instance then error(pathError, 0) end
			if not remoteClasses[instance.ClassName] then error("detail root must be a remote", 0) end
		else
			if not isResourceId(params.rowId) then error("detail requires root or snapshotId with rowId", 0) end
			snapshot = getSnapshot(params.snapshotId)
			for _, row in ipairs(snapshot.metadata.results) do
				if row.rowId == params.rowId then retainedRow = row; break end
			end
			if not retainedRow then error("Remote snapshot row unavailable", 0) end
			instance = snapshot.instances[params.rowId]
		end
		local result = {
			view = "detail", generation = generation, snapshotId = params.snapshotId, rowId = params.rowId,
			metadataTiming = "live-non-atomic", associationMeaning = "metadata-not-call-arguments",
			attributes = { ok = true, values = {}, truncated = false },
			valueAssociations = { children = {}, siblings = {}, siblingsRequested = params.includeSiblingValues == true,
				siblingMeaning = "shared-parent-only" },
			visited = 0, truncated = false, coverage = "complete", stopReasons = {},
		}
		local reasons = {}
		local function partial(reason)
			result.truncated, result.coverage = true, "partial"
			if not reasons[reason] then reasons[reason] = true; table.insert(result.stopReasons, reason) end
		end
		local function reachable()
			local ok, live = pcall(function() return instance and instance:IsDescendantOf(game) end)
			return ok and live
		end
		local function fence()
			if not isCurrent() or state.tornDown or not requestContext or state.socket ~= requestContext.socket
				or not state.acknowledged then error("Remote detail interrupted", 0) end
			if snapshot and (flow.snapshots[params.snapshotId] ~= snapshot or os.clock() >= snapshot.deadline) then
				error("Remote snapshot unavailable: expired, released, evicted, or another generation", 0)
			end
		end
		local function size(value)
			local ok, encoded = pcall(HttpService.JSONEncode, HttpService, value)
			return ok and type(encoded) == "string" and #encoded or math.huge
		end
		if not reachable() then error("Remote detail target unavailable", 0) end
		result.instance = instanceSummary(instance, bindings)
		if bindings then result.instance.reference = "instance://" .. string.rep("0", 32) end
		local work = newWorkBudget()
		work.maxItems = MAX_BATCH_WORK_ITEMS
		work.cancelled = function()
			return not isCurrent() or state.tornDown or state.socket ~= requestContext.socket or not state.acknowledged
		end
		local shared = { items = 0, bytes = 0, maxItems = MAX_BATCH_SERIALIZED_ITEMS, maxBytes = MAX_BATCH_SERIALIZED_BYTES }
		local function valueResult(name, raw)
			if redaction.sensitiveKey(name) then return { ok = true, value = "[redacted]", redacted = true } end
			local label = typeof(raw)
			if label == "table" or label == "function" or label == "thread" then
				return { ok = false, error = "Value type unsupported" }
			end
			if type(raw) == "number" then
				local representation = tostring(raw)
				if (raw == raw and raw ~= math.huge and raw ~= -math.huge and math.abs(raw) >= 10000000)
					or redactString(representation) ~= representation then
					return { ok = true, value = "[redacted]", redacted = true }
				end
			end
			local budget = { items = 0, bytes = 0, maxItems = 256, maxBytes = MAX_BATCH_VALUE_BYTES, shared = shared }
			local ok, value, serializationError = pcall(serialize, raw, nil, nil, budget)
			if not ok or serializationError or size(value) > MAX_BATCH_VALUE_BYTES then
				return { ok = false, error = "Value serialization limit exceeded" }
			end
			return { ok = true, value = value }
		end
		local reservedBytes = size(result) + 512
		if reservedBytes > maximumBytes then error("Remote detail result limit exceeded", 0) end
		local function append(list, entry, binding)
			local bytes = size(entry) + 2
			if reservedBytes + bytes > maximumBytes then partial("byte-limit"); return false end
			reservedBytes = reservedBytes + bytes
			table.insert(list, entry)
			if bindings and binding then table.insert(bindings, { summary = entry, instance = binding }) end
			return true
		end
		local attributesOk, attributes = pcall(function() return instance:GetAttributes() end)
		if not attributesOk or type(attributes) ~= "table" then
			result.attributes = { ok = false, values = {}, truncated = false, error = "Attributes unavailable" }
			partial("attributes-unavailable")
		else
			local total = 0
			local ok, readError = pcall(function()
				for name in pairs(attributes) do
					total = total + 1
					if params.attributeNames == nil and type(name) == "string" then
						-- Keep only the first 32 lexical names, not an unbounded second attribute array.
						table.insert(names, name)
						table.sort(names)
						if #names > 32 then table.remove(names) end
					end
					checkpointWork(work)
				end
				result.attributes.total = total
				if params.attributeNames == nil and total > 32 then
					result.attributes.truncated = true; partial("attribute-limit")
				end
				for _, name in ipairs(names) do
					local raw = rawget(attributes, name)
					local entry
					if raw == nil then entry = { ok = false, error = "Attribute unavailable" }
					elseif redaction.sensitiveKey(name) then entry = { ok = true, value = "[redacted]", redacted = true }
					elseif not scalarAttribute(raw) then entry = { ok = false, error = "Attribute type unsupported" }
					else entry = valueResult(name, raw) end
					entry.name = redactString(name)
					if not entry.ok then partial("attribute-value-unavailable") end
					if not append(result.attributes.values, entry) then result.attributes.truncated = true; break end
					checkpointWork(work)
				end
			end)
			if not ok then
				if readError ~= "Read work limit exceeded" then error(readError, 0) end
				result.attributes.truncated = true; partial("work-limit")
			end
		end
		local associated = 0
		local function associations(parent, list, siblings)
			local ok, children = pcall(function() return parent:GetChildren() end)
			if not ok or type(children) ~= "table" then partial(siblings and "siblings-unavailable" or "children-unavailable"); return end
			for _, child in ipairs(children) do
				if result.visited >= maximum then partial("visit-limit"); break end
				if associated >= limit then partial("association-limit"); break end
				result.visited = result.visited + 1
				local childOk, isValue = pcall(function() return child ~= instance and child.Parent == parent and child:IsA("ValueBase") end)
				if childOk and isValue then
					local name = child.Name
					local entry = { name = redactString(name), className = child.ClassName, path = safePath(child) }
					if redaction.sensitiveKey(name) then entry.value = { ok = true, value = "[redacted]", redacted = true }
					else
						local valueOk, raw = pcall(function() return child.Value end)
						entry.value = valueOk and valueResult(name, raw) or { ok = false, error = "Property unavailable" }
					end
					if not entry.value.ok then partial("association-value-unavailable") end
					if bindings then entry.reference = "instance://" .. string.rep("0", 32) end
					if not append(list, entry, child) then break end
					associated = associated + 1
				elseif not childOk then partial("association-unavailable") end
				checkpointWork(work)
			end
		end
		local ok, readError = pcall(function()
			if not reasons["work-limit"] then
				associations(instance, result.valueAssociations.children, false)
				if params.includeSiblingValues then
					local parent = safeProperty(instance, "Parent")
					if parent then associations(parent, result.valueAssociations.siblings, true) end
				end
			end
		end)
		if not ok then
			if readError ~= "Read work limit exceeded" then error(readError, 0) end
			partial("work-limit")
		end
		fence()
		if not reachable() then error("Remote detail target unavailable", 0) end
		if size(result) > maximumBytes then error("Remote detail result limit exceeded", 0) end
		return finishReferenceResult(result, bindings, maximumBytes, requestContext)
	end
	function handlers.remote_inventory(params, requestContext)
		strictObject(params, {
			root = true, view = true, snapshotId = true, compareTo = true, cursor = true, nameContains = true,
			pathContains = true, classNames = true, limit = true, maxVisited = true, fields = true,
			includeReferences = true, _maxResultBytes = true, rowId = true, attributeNames = true, includeSiblingValues = true, query = true,
		}, "params")
		flow.pruneSnapshots()
		local view = params.view or "summary"
		local query, queryClasses, queryHash
		if params.query ~= nil then
			if not params.snapshotId or (view ~= "rows" and view ~= "summary") then
				error("query requires snapshotId and rows or summary view", 0)
			end
			strictObject(params.query, { nameContains = true, pathContains = true, classNames = true }, "query")
			query, queryClasses = filters(params.query)
			-- Length-prefix variable selectors: separators inside names/paths must
			-- never alias another canonical query. No query creates a snapshot.
			queryHash = sha256(#query.nameContains .. ":" .. query.nameContains
				.. #query.pathContains .. ":" .. query.pathContains .. table.concat(query.classNames, ","))
			if not queryHash then error("Remote query cursor hash unavailable", 0) end
		end
		if view == "detail" then return detail(params, requestContext) end
		if params.rowId ~= nil or params.attributeNames ~= nil or params.includeSiblingValues ~= nil then
			error("rowId, attributeNames and includeSiblingValues require detail view", 0)
		end
		if view ~= "summary" and view ~= "rows" and view ~= "diff" and view ~= "release" then error("Invalid remote inventory view", 0) end
		local normalized, selected = filters(params)
		local bindings = referenceBindings(params)
		local fields = params.fields or { "name", "className", "path", "parent" }
		strictArray(fields, 0, 4, "fields")
		local seen = {}
		for _, field in ipairs(fields) do
			if not rowFields[field] or seen[field] then error("Invalid or duplicate remote row field", 0) end
			seen[field] = true
		end
		local limit = strictInteger(params.limit, 20, 1, 200, "limit")
		strictInteger(params.maxVisited, 5000, 1, 20000, "maxVisited")
		text(params.root, 1024, "root")
		text(params.cursor, 256, "cursor")
		if params.compareTo ~= nil and not isResourceId(params.compareTo) then error("Invalid comparison snapshot id", 0) end
		if view ~= "diff" and params.compareTo ~= nil then error("compareTo requires diff view", 0) end
		if view == "release" then
			if not isResourceId(params.snapshotId) or params.cursor then error("release requires snapshotId without cursor", 0) end
			return { snapshotId = params.snapshotId, generation = generation, released = removeSnapshot(params.snapshotId) }
		end
		if params.cursor and not params.snapshotId then error("cursor requires snapshotId", 0) end
		if view == "diff" and (not params.snapshotId or not params.compareTo) then error("diff requires two snapshots", 0) end
		local snapshot = params.snapshotId and getSnapshot(params.snapshotId) or scan(params, normalized, selected, requestContext)
		if params.snapshotId then
			if params.root ~= nil then
				local root = resolvePath(params.root)
				if not root or root ~= snapshot.rootInstance[1] then error("Snapshot root identity mismatch", 0) end
			end
			if params.nameContains ~= nil or params.pathContains ~= nil or params.classNames ~= nil then
				local supplied = table.clone(snapshot.metadata.filters)
				if params.nameContains ~= nil then supplied.nameContains = normalized.nameContains end
				if params.pathContains ~= nil then supplied.pathContains = normalized.pathContains end
				if params.classNames ~= nil then supplied.classNames = normalized.classNames end
				if not sameFilters(supplied, snapshot.metadata.filters) then error("Snapshot filter mismatch", 0) end
			end
		end
		local data, before = snapshot.metadata, nil
		local result = {
			snapshotId = data.snapshotId, generation = generation, view = view, root = data.root,
			visited = data.visited, matchedVisited = data.matchedVisited, retained = data.retained,
			coverage = data.coverage, truncated = data.truncated, stopReasons = table.clone(data.stopReasons),
			expiresInMs = math.max(0, math.floor((snapshot.deadline - os.clock()) * 1000)), atomicSnapshot = false,
		}
		local source = view == "summary" and data.groups or data.results
		local classes = data.classes
		if query then
			local rows = {}
			classes = {}
			for _, row in ipairs(data.results) do
				if queryClasses[row.className]
					and string.find(string.lower(row.name), query.nameContains, 1, true)
					and string.find(string.lower(row.path), query.pathContains, 1, true) then
					table.insert(rows, row)
					classes[row.className] = (classes[row.className] or 0) + 1
				end
			end
			result.queryScope, result.queryMatched = "retained-rows", #rows
			source = view == "summary" and buildGroups(rows) or rows
		end
		if view == "diff" then
			before = getSnapshot(params.compareTo)
			if before.rootIdentity ~= snapshot.rootIdentity or not sameFilters(before.metadata.filters, data.filters) then
				error("Remote snapshots have incompatible root/filter identities", 0)
			end
			source = changes(snapshot, before)
			result.compareTo, result.comparisonScope = params.compareTo, "retained-rows"
			result.absenceAuthoritative = data.coverage == "complete" and before.metadata.coverage == "complete"
			if not result.absenceAuthoritative then
				result.coverage, result.truncated = "partial", true
				for _, reason in ipairs(before.metadata.stopReasons) do table.insert(result.stopReasons, "compare-" .. reason) end
			end
		end
		local prefix = data.snapshotId .. ":" .. generation .. ":" .. view .. ":" .. (params.compareTo or "-") .. ":"
		if queryHash then prefix = prefix .. queryHash .. ":" end
		local offset = 0
		if params.cursor then
			if string.sub(params.cursor, 1, #prefix) ~= prefix then error("Remote snapshot cursor mismatch", 0) end
			local suffix = string.sub(params.cursor, #prefix + 1)
			if not string.match(suffix, "^%d+$") then error("Invalid remote snapshot cursor", 0) end
			offset = strictInteger(tonumber(suffix), nil, 0, #source, "cursor offset")
			if offset == nil then error("Invalid remote snapshot cursor", 0) end
		end
		local page = {}
		for index = offset + 1, math.min(#source, offset + limit) do
			local row = source[index]
			if view == "summary" then table.insert(page, table.clone(row))
			elseif view == "rows" then table.insert(page, projection(row, fields, bindings, snapshot))
			else
				local change = { kind = row.kind, rowId = row.rowId }
				if row.before then change.before = projection(row.before, fields, nil, before) end
				if row.after then change.after = projection(row.after, fields, bindings, snapshot) end
				table.insert(page, change)
			end
		end
		result.hasMore = offset + #page < #source
		result.nextCursor = result.hasMore and prefix .. (offset + #page) or nil
		if view == "summary" then
			result.classes, result.groups, result.groupCoverage = table.clone(classes), page, "retained-rows"
		else result.results = page end
		return finishReferenceResult(result, bindings, referenceResultLimit(params), requestContext)
	end
end

-- The observer retains type labels and, only when requested, bounded sanitized
-- copies made with raw primitive operations. Native objects remain type-only.
-- The original call remains outside pcall and is returned directly.
do
	local flow = state.remoteWorkflow
	local activeOutbound = 0
	local native = {
		getrawmetatable = getrawmetatable, isreadonly = isreadonly, setreadonly = setreadonly,
		newcclosure = newcclosure, getnamecallmethod = getnamecallmethod,
	}
	local function prerequisites()
		local result, available = {}, true
		for _, name in ipairs({ "getrawmetatable", "isreadonly", "setreadonly", "newcclosure", "getnamecallmethod" }) do
			result[name] = type(native[name]) == "function"
			available = available and result[name]
		end
		return result, available and not sharedEnvironment.PotassiumMcpCaptureBlocked
	end
	function flow.capabilities()
		local required, available = prerequisites()
		return {
			version = 2, mode = "selected-outbound-namecall-and-inbound-events", available = true, prerequisites = required,
			outboundAvailable = available == true, inboundAvailable = true, supportedDirections = { "outbound", "inbound" },
			nativeSemanticsVerified = false, recordsValues = false, recordsReturns = false,
			valueExamples = { supported = true, default = false, maxExamplesPerVariant = 3, defaultExamplesPerVariant = 2,
				maxArguments = 8, maxNodes = 32, maxDepth = 2, maxTableEntries = 8, maxStringBytes = 128,
				maxExampleBytes = 1024, maxSampleAttempts = 200, nativeValues = "type-only", sharedCaptureBudget = true },
			maxActive = 4, maxRetained = 8, maxTargets = 16, maxEvents = 200, bufferBytes = 65536,
			maxShapes = 32, maxArgumentTypes = 8, maxDurationMs = 30000, retentionSeconds = 60,
			survivesReconnect = true, directMethodCalls = false, incomingCalls = true, incomingRemoteFunctions = false,
			ownershipBlocked = sharedEnvironment.PotassiumMcpCaptureBlocked == true,
		}
	end
	local function removeCapture(id)
		if not flow.captures[id] then return end
		flow.captures[id] = nil
		for index, candidate in ipairs(flow.captureOrder) do
			if candidate == id then table.remove(flow.captureOrder, index); break end
		end
	end
	local function cleanupListeners(capture)
		if #capture.connections == 0 then return end
		disconnectConnections(capture.connections)
		capture.bytes = capture.bytes - capture.listenerBytes
		capture.listenerBytes = 0
	end
	local function finish(capture, terminalState, reason, hot)
		if capture.state == "active" then
			capture.state, capture.reason, capture.finishedAt = terminalState, reason, os.clock()
			capture.targetByInstance, capture.secretPatterns = nil, nil
			flow.activeCaptures = flow.activeCaptures - 1
			if capture.outbound then activeOutbound = activeOutbound - 1 end
		end
		-- Outbound observation never calls engine APIs, including Disconnect.
		-- A terminal state fences queued callbacks; the existing sweep owns cleanup.
		if not hot then cleanupListeners(capture) end
	end
	local function blockHook(hook, reason)
		hook.token.observe, hook.token.failed = nil, nil
		sharedEnvironment.PotassiumMcpCaptureBlocked = true
		for _, capture in pairs(flow.captures) do
			if capture.outbound then
				if capture.state == "active" then finish(capture, "interrupted", reason) end
				capture.hookCleanup = rawget(hook.metatable, "__namecall") == hook.original
					and "readonly-restoration-limited" or "inert-wrapper-retained"
			end
		end
		flow.hook = nil
	end
	local function releaseHook()
		local hook = flow.hook
		if not hook then return end
		hook.token.observe, hook.token.failed = nil, nil
		if rawget(hook.metatable, "__namecall") ~= hook.wrapper then
			blockHook(hook, "hook-ownership-lost")
			return
		end
		local ok = pcall(function()
			local readonly = native.isreadonly(hook.metatable)
			if type(readonly) ~= "boolean" then error("Readonly ownership unavailable", 0) end
			local changed, mutationError = pcall(function()
				if readonly then native.setreadonly(hook.metatable, false) end
				if rawget(hook.metatable, "__namecall") ~= hook.wrapper then error("Hook ownership lost", 0) end
				rawset(hook.metatable, "__namecall", hook.original)
			end)
			if readonly then
				local restored = pcall(native.setreadonly, hook.metatable, true)
				if not restored then
					-- Keep the saved flag through a transient native failure.
					-- Never retry against a slot now owned by another wrapper.
					local current = rawget(hook.metatable, "__namecall")
					if current ~= hook.original and current ~= hook.wrapper then error("Hook ownership lost", 0) end
					native.setreadonly(hook.metatable, true)
				end
			end
			if not changed then error(mutationError, 0) end
			if rawget(hook.metatable, "__namecall") ~= hook.original then error("Hook restoration unavailable", 0) end
		end)
		if not ok then blockHook(hook, "hook-cleanup-limited"); return end
		for _, capture in pairs(flow.captures) do
			if capture.outbound and capture.state ~= "active" and not capture.hookCleanup then capture.hookCleanup = "restored" end
		end
		flow.hook = nil
	end
	local function sweepCaptures()
		local now = os.clock()
		local hook = flow.hook
		if hook and rawget(hook.metatable, "__namecall") ~= hook.wrapper then blockHook(hook, "hook-ownership-lost") end
		for _, capture in pairs(flow.captures) do
			if capture.state == "active" and now >= capture.deadline then finish(capture, "expired", "deadline") end
			if capture.state ~= "active" then cleanupListeners(capture) end
		end
		if activeOutbound == 0 then releaseHook() end
		for index = #flow.captureOrder, 1, -1 do
			local id = flow.captureOrder[index]
			local capture = flow.captures[id]
			if capture.state ~= "active" and now - capture.finishedAt >= 60 then removeCapture(id) end
		end
	end
	local function evictEvent(capture)
		local entry = capture.events[capture.head]
		capture.events[capture.head] = nil
		capture.head = capture.head % capture.maxEvents + 1
		capture.count = capture.count - 1
		capture.bytes = capture.bytes - entry.bytes
		capture.dropped.events = capture.dropped.events + 1
	end
	local function typeLabel(value)
		local label = typeof(value)
		if type(label) ~= "string" or #label > 64 or not string.match(label, "^[%w_]+$") then
			error("Unsupported native type label", 0)
		end
		return label
	end
	local function equalNodes(left, right)
		if type(left) ~= type(right) then return false end
		if type(left) ~= "table" then return left == right end
		-- Both sides are owned sanitized copies, never caller tables.
		for key, value in next, left do
			if not equalNodes(value, rawget(right, key)) then return false end
		end
		for key in next, right do
			if rawget(left, key) == nil then return false end
		end
		return true
	end
	local function example(capture, argc, argumentTypes, elapsed, ...)
		local topCount = math.min(argc, 8)
		local budget = { nodes = topCount, bytes = 160, truncated = argc > 8 }
		for _, label in ipairs(argumentTypes) do budget.bytes = budget.bytes + #label + 48 end
		if budget.bytes > 1024 then return nil end
		local seen = {}
		local function reserve(bytes)
			if budget.bytes + bytes > 1024 then budget.truncated = true; return false end
			budget.bytes = budget.bytes + bytes
			return true
		end
		local function node(raw, depth, root, masked)
			local label = typeLabel(raw)
			if not root then
				if budget.nodes >= 32 or not reserve(#label + 48) then budget.truncated = true; return nil end
				budget.nodes = budget.nodes + 1
			end
			local value = { type = label }
			if masked then value.redacted = true; return value end
			local rawType = type(raw)
			if rawType == "nil" then return value end
			if rawType == "boolean" then value.value = raw; return value end
			if rawType == "number" then
				if raw ~= raw or raw == math.huge or raw == -math.huge then
					value.omitted = "non-finite"; budget.truncated = true
				else
					local representation = tostring(raw)
					if math.abs(raw) >= 10000000 or redaction.text(representation, capture.secretPatterns, 128) ~= representation then value.redacted = true
					elseif reserve(32) then value.value = raw
					else value.omitted = "byte-limit" end
				end
				return value
			end
			if rawType == "string" then
				if #raw > 128 then value.omitted = "string-limit"; budget.truncated = true
				elseif utf8.len(raw) == nil then value.omitted = "invalid-utf8"; budget.truncated = true
				else
					local sanitized = redaction.text(raw, capture.secretPatterns, 128)
					if not sanitized then value.omitted = "string-limit"; budget.truncated = true
					elseif utf8.len(sanitized) == nil then value.omitted = "invalid-utf8"; budget.truncated = true
					elseif sanitized ~= raw and sanitized == "[redacted]" then value.redacted = true
					elseif reserve(#sanitized * 6 + 10) then value.value = sanitized
					else value.omitted = "byte-limit" end
				end
				return value
			end
			-- typeof distinguishes executor/native objects even in table-backed adapters.
			if rawType ~= "table" or label ~= "table" then return value end
			if depth >= 2 then value.omitted = "depth-limit"; budget.truncated = true; return value end
			if seen[raw] then value.omitted = "cycle"; budget.truncated = true; return value end
			if not reserve(32) then value.omitted = "byte-limit"; return value end
			seen[raw] = true
			value.entries, value.truncated = {}, false
			local key, scanned = nil, 0
			while true do
				local nextKey = next(raw, key)
				if nextKey == nil then break end
				if scanned >= 8 then value.truncated = true; budget.truncated = true; break end
				key, scanned = nextKey, scanned + 1
				local keyType = type(key)
				-- Unsupported/overlong keys are skipped here; invalid UTF-8 keys are
				-- omitted by node below, before their associated value is read.
				if (keyType ~= "string" and keyType ~= "number" and keyType ~= "boolean")
					or (keyType == "string" and #key > 128) then
					value.truncated, budget.truncated = true, true
					continue
				end
				if budget.nodes > 30 or not reserve(20) then value.truncated = true; budget.truncated = true; break end
				local copiedKey = node(key, depth + 1, false, false)
				if not copiedKey or copiedKey.omitted then
					value.truncated, budget.truncated = true, true
					continue
				end
				local copiedValue = node(rawget(raw, key), depth + 1, false, redaction.sensitiveKey(key))
				if not copiedValue then value.truncated = true; budget.truncated = true; break end
				table.insert(value.entries, { key = copiedKey, value = copiedValue })
			end
			seen[raw] = nil
			-- Canonical primitive-key ordering makes sanitized table examples deduplicate.
			table.sort(value.entries, function(a, b)
				local left, right = a.key, b.key
				if left.type ~= right.type then return left.type < right.type end
				if left.redacted ~= right.redacted then return left.redacted ~= true end
				if left.value == right.value then return false end
				if left.type == "boolean" then return left.value == false end
				return left.value < right.value
			end)
			return value
		end
		local result = { argc = argc, arguments = {}, firstSeenMs = elapsed, lastSeenMs = elapsed, count = 1 }
		for index = 1, topCount do
			result.arguments[index] = node(select(index, ...), 0, true, false)
		end
		result.truncated = budget.truncated
		return result, budget.bytes
	end
	local function collect(capture, target, direction, method, argc, argumentTypes, typeBytes, now, ...)
		if capture.observed >= 9007199254740991 then finish(capture, "limited", "sequence-limit", true); return end
		capture.observed = capture.observed + 1
		local elapsed = math.max(0, math.floor((now - capture.startedAt) * 1000))
		local key = target.targetId .. "\0" .. direction .. "\0" .. method .. "\0" .. argc .. "\0" .. table.concat(argumentTypes, ",")
		local group = capture.shapeByKey[key]
		if not group and #capture.groups < 32 then
			-- Includes key, cumulative timing/count fields and the empty examples array.
			local groupBytes = 384 + typeBytes + #key
			while capture.count > 0 and capture.bytes + groupBytes > 65536 do evictEvent(capture) end
			if capture.bytes + groupBytes <= 65536 then
				group = { targetId = target.targetId, direction = direction, method = method, argc = argc, argumentTypes = argumentTypes,
					typesTruncated = argc > 8, count = 0, firstSeenMs = elapsed, lastSeenMs = elapsed, exampleCount = 0, examples = {} }
				capture.shapeByKey[key] = group
				table.insert(capture.groups, group)
				capture.bytes = capture.bytes + groupBytes
			end
		end
		if group then
			group.count, group.lastSeenMs = group.count + 1, elapsed
			if capture.includeValueExamples then
				local sample, sampleBytes
				if capture.exampleAttempts < 200 then
					capture.exampleAttempts = capture.exampleAttempts + 1
					sample, sampleBytes = example(capture, argc, argumentTypes, elapsed, ...)
					if sample and sample.truncated then capture.examplesTruncated = true end
				end
				local duplicate = false
				if sample then
					for _, retained in ipairs(group.examples) do
						if retained.truncated == sample.truncated and equalNodes(retained.arguments, sample.arguments) then
							retained.count, retained.lastSeenMs = retained.count + 1, elapsed
							duplicate = true
							break
						end
					end
				end
				if not duplicate then
					if sample and group.exampleCount < capture.maxExamplesPerVariant then
						-- Keep room for any later event, not just this call's smaller shape:
						-- 320 fixed bytes plus eight maximum 64-byte labels and delimiters.
						while capture.count > 0 and capture.bytes + sampleBytes + 856 > 65536 do evictEvent(capture) end
						if capture.bytes + sampleBytes + 856 <= 65536 then
							table.insert(group.examples, sample)
							group.exampleCount = group.exampleCount + 1
							capture.bytes = capture.bytes + sampleBytes
						else capture.dropped.examples = capture.dropped.examples + 1 end
					else capture.dropped.examples = capture.dropped.examples + 1 end
				end
			end
		else
			capture.dropped.shapes = capture.dropped.shapes + 1
			if capture.includeValueExamples then capture.dropped.examples = capture.dropped.examples + 1 end
		end
		local event = { sequence = capture.observed, elapsedMs = elapsed, targetId = target.targetId,
			direction = direction, method = method, argc = argc, argumentTypes = argumentTypes, typesTruncated = argc > 8 }
		local bytes = 320 + typeBytes
		while capture.count > 0 and (capture.count >= capture.maxEvents or capture.bytes + bytes > 65536) do evictEvent(capture) end
		if capture.bytes + bytes > 65536 then
			capture.dropped.events = capture.dropped.events + 1
			finish(capture, "limited", "metadata-byte-limit", true)
		else
			local index = (capture.head + capture.count - 1) % capture.maxEvents + 1
			capture.events[index] = { value = event, bytes = bytes }
			capture.count, capture.bytes = capture.count + 1, capture.bytes + bytes
		end
	end
	local function argumentShape(...)
		local argc, argumentTypes, typeBytes = select("#", ...), {}, 0
		for index = 1, math.min(argc, 8) do
			local label = typeLabel(select(index, ...))
			argumentTypes[index], typeBytes = label, typeBytes + #label + 3
		end
		return argc, argumentTypes, typeBytes
	end
	local function observe(self, ...)
		if not isCurrent() then
			if flow.hook then flow.hook.token.observe, flow.hook.token.failed = nil, nil end
			return
		end
		if activeOutbound == 0 then return end
		local hook = flow.hook
		if hook and rawget(hook.metatable, "__namecall") ~= hook.wrapper then
			-- Defer ownership cleanup to the lifecycle sweep, never engine work here.
			hook.token.observe, hook.token.failed = nil, nil
			for _, capture in pairs(flow.captures) do
				if capture.outbound and capture.state == "active" then finish(capture, "interrupted", "hook-ownership-lost", true) end
			end
			return
		end
		local method = native.getnamecallmethod()
		if method ~= "FireServer" and method ~= "InvokeServer" then return end
		local now, argc, argumentTypes, typeBytes = os.clock()
		for _, capture in pairs(flow.captures) do
			if not capture.outbound or capture.state ~= "active" then continue end
			if now >= capture.deadline then finish(capture, "expired", "deadline", true); continue end
			local target = capture.targetByInstance[self]
			if not target or target.method ~= method then continue end
			if not argc then argc, argumentTypes, typeBytes = argumentShape(...) end
			collect(capture, target, "outbound", method, argc, argumentTypes, typeBytes, now, ...)
		end
	end
	local function observationFailure()
		for _, capture in pairs(flow.captures) do
			if capture.outbound and capture.state == "active" then
				capture.dropped.observationErrors = capture.dropped.observationErrors + 1
				finish(capture, "limited", "metadata-observation-failed", true)
			end
		end
		if flow.hook then flow.hook.token.observe, flow.hook.token.failed = nil, nil end
	end
	local function forwardingWrapper(original, token)
		-- This closure deliberately captures neither state nor selected targets.
		return function(self, ...)
			local callback = token.observe
			if callback then
				local ok = pcall(callback, self, ...)
				if not ok and token.failed then pcall(token.failed) end
			end
			callback = nil
			return original(self, ...)
		end
	end
	local function installHook()
		if flow.hook then return end
		local _, available = prerequisites()
		if not available then error("UNSUPPORTED: remote capture requires ownership-checkable native namecall facilities", 0) end
		local ok, metatable = pcall(native.getrawmetatable, game)
		if not ok or type(metatable) ~= "table" then error("UNSUPPORTED: raw namecall metatable unavailable", 0) end
		local original = rawget(metatable, "__namecall")
		if type(original) ~= "function" then error("UNSUPPORTED: original namecall callable unavailable", 0) end
		local readonlyOk, readonly = pcall(native.isreadonly, metatable)
		if not readonlyOk or type(readonly) ~= "boolean" then error("UNSUPPORTED: readonly state unavailable", 0) end
		local token = {}
		local wrappedOk, wrapper = pcall(native.newcclosure, forwardingWrapper(original, token))
		if not wrappedOk or type(wrapper) ~= "function" then error("UNSUPPORTED: native namecall wrapper unavailable", 0) end
		local hook = { metatable = metatable, original = original, wrapper = wrapper, token = token }
		local installed = pcall(function()
			if readonly then native.setreadonly(metatable, false) end
			if rawget(metatable, "__namecall") ~= original then error("Namecall ownership changed during installation", 0) end
			rawset(metatable, "__namecall", wrapper)
		end)
		local restored = not readonly or pcall(native.setreadonly, metatable, true)
		flow.hook = hook
		if not installed or not restored or rawget(metatable, "__namecall") ~= wrapper then
			if rawget(metatable, "__namecall") == original then flow.hook = nil
			else releaseHook() end
			if not restored and rawget(metatable, "__namecall") == original then
				-- A transient readonly failure must not strand the original slot
				-- writable after rolling the wrapper back.
				if not pcall(native.setreadonly, metatable, readonly) then
					error("UNSUPPORTED: namecall readonly restoration unavailable", 0)
				end
			end
			error("UNSUPPORTED: ownership-safe namecall installation failed", 0)
		end
		token.observe, token.failed = observe, observationFailure
	end
	local function captureResult(capture, details, profiles)
		local groups
		if details then
			groups = {}
			for _, group in ipairs(capture.groups) do
				local row = {
					targetId = group.targetId, direction = group.direction, method = group.method,
					argc = group.argc, argumentTypes = group.argumentTypes, typesTruncated = group.typesTruncated,
					count = group.count, firstSeenMs = group.firstSeenMs, lastSeenMs = group.lastSeenMs, exampleCount = group.exampleCount,
				}
				if profiles then row.examples = group.examples end
				table.insert(groups, row)
			end
		end
		return {
			captureId = capture.captureId, generation = generation, state = capture.state, reason = capture.reason,
			coverage = capture.outbound and (capture.inbound and "selected-outbound-namecall-and-inbound-events"
				or "selected-outbound-namecall-only") or "selected-inbound-events-only",
			directions = capture.directions, unsupportedInboundTargets = capture.unsupportedInboundTargets,
			recordsValues = capture.includeValueExamples, recordsReturns = false, observed = capture.observed,
			exampleSampling = { attempts = capture.exampleAttempts, maxAttempts = 200,
				truncated = capture.examplesTruncated or capture.dropped.examples > 0 },
			dropped = table.clone(capture.dropped), retained = capture.count, bufferedBytes = capture.bytes,
			byteAccounting = "conservative-metadata-bound",
			groups = not profiles and groups or nil, profiles = profiles and groups or nil,
			targets = details and capture.targets or nil, hookCleanup = capture.hookCleanup,
			expiresInMs = math.max(0, math.floor(((capture.state == "active" and capture.deadline or capture.finishedAt + 60) - os.clock()) * 1000)),
			nativeSemanticsVerified = false, directMethodCalls = false, incomingCalls = capture.inbound, incomingRemoteFunctions = false,
		}
	end
	local function getCapture(id)
		if not isResourceId(id) then error("Invalid remote capture id", 0) end
		sweepCaptures()
		local capture = flow.captures[id]
		if not capture then error("Remote capture unavailable: expired, evicted, or another generation", 0) end
		return capture
	end
	local function receiveInbound(capture, target, now, ...)
		local argc, argumentTypes, typeBytes = argumentShape(...)
		collect(capture, target, "inbound", "OnClientEvent", argc, argumentTypes, typeBytes, now, ...)
	end
	local function inboundCallback(capture, target)
		-- Own only this subscription's capture/metadata; never retain the event arguments.
		return function(...)
			if not isCurrent() or capture.state ~= "active" or flow.captures[capture.captureId] ~= capture then return end
			local now = os.clock()
			if now >= capture.deadline then
				finish(capture, "expired", "deadline")
				if activeOutbound == 0 then releaseHook() end
				return
			end
			local ok = pcall(receiveInbound, capture, target, now, ...)
			if not ok then
				capture.dropped.observationErrors = capture.dropped.observationErrors + 1
				finish(capture, "limited", "metadata-observation-failed")
			elseif capture.state ~= "active" then cleanupListeners(capture) end
			if activeOutbound == 0 then releaseHook() end
		end
	end
	function handlers.remote_capture_start(params, requestContext)
		strictObject(params, { targets = true, durationMs = true, maxEvents = true, directions = true,
			includeValueExamples = true, maxExamplesPerVariant = true }, "params")
		strictArray(params.targets, 1, 16, "targets")
		local duration = strictInteger(params.durationMs, 5000, 1000, 30000, "durationMs")
		local maxEvents = strictInteger(params.maxEvents, 100, 1, 200, "maxEvents")
		if params.includeValueExamples ~= nil and type(params.includeValueExamples) ~= "boolean" then
			error("includeValueExamples must be a boolean", 0)
		end
		local maxExamples = strictInteger(params.maxExamplesPerVariant, 2, 1, 3, "maxExamplesPerVariant")
		if params.maxExamplesPerVariant ~= nil and params.includeValueExamples ~= true then
			error("maxExamplesPerVariant requires includeValueExamples=true", 0)
		end
		local directions = params.directions or { "outbound" }
		strictArray(directions, 1, 2, "directions")
		local requested = {}
		for _, direction in ipairs(directions) do
			if (direction ~= "outbound" and direction ~= "inbound") or requested[direction] then error("Invalid or duplicate capture direction", 0) end
			requested[direction] = true
		end
		local targets, selected = {}, setmetatable({}, { __mode = "k" })
		local signals, unsupported = {}, {}
		for _, path in ipairs(params.targets) do
			if type(path) ~= "string" or #path < 1 or #path > 1024 then error("Invalid capture target", 0) end
			local instance, pathError = resolvePath(path)
			if not instance then error(pathError, 0) end
			local className = instance.ClassName
			if className ~= "RemoteEvent" and className ~= "RemoteFunction" and className ~= "UnreliableRemoteEvent" then
				error("Capture target must be a remote", 0)
			end
			if not selected[instance] then
				local target = {
					targetId = string.format("%02d", #targets + 1), className = className,
					name = string.sub(redactString(instance.Name), 1, 256), path = string.sub(safePath(instance), 1, 256),
					method = className == "RemoteFunction" and "InvokeServer" or "FireServer",
				}
				selected[instance] = target
				table.insert(targets, target)
				if requested.inbound then
					if className == "RemoteFunction" then
						table.insert(unsupported, { targetId = target.targetId, reason = "remote-function-callback-not-observed" })
					else
						local signalOk, signal = pcall(function() return instance.OnClientEvent end)
						local connectOk, connect = pcall(function() return signal.Connect end)
						if not signalOk or not connectOk or type(connect) ~= "function" then
							error("UNSUPPORTED: selected inbound event signal unavailable", 0)
						end
						table.insert(signals, { signal = signal, target = target })
					end
				end
			end
		end
		if not requested.outbound and #signals == 0 then error("UNSUPPORTED: no supported target/direction pair", 0) end
		if requested.outbound then
			local _, available = prerequisites()
			if not available then error("UNSUPPORTED: remote capture requires ownership-checkable native namecall facilities", 0) end
		end
		local secretPatterns, secretBytes = nil, 0
		if params.includeValueExamples then
			secretPatterns = {}
			for _, pattern in ipairs(redaction.patterns()) do
				-- A longer literal secret cannot occur in a permitted 128-byte source string.
				if #pattern <= 256 then
					table.insert(secretPatterns, pattern)
					secretBytes = secretBytes + #pattern + 16
				end
			end
		end
		sweepCaptures()
		if flow.activeCaptures >= 4 then error("Remote capture active capacity exceeded", 0) end
		local id = newResourceId(flow.captures)
		if not id then error("Remote capture identity unavailable", 0) end
		local now = os.clock()
		local capture = {
			captureId = id, state = "starting", targets = targets, targetByInstance = selected,
			startedAt = now, deadline = now + duration / 1000, maxEvents = maxEvents,
			outbound = requested.outbound == true, inbound = requested.inbound == true, directions = table.clone(directions),
			unsupportedInboundTargets = unsupported, includeValueExamples = params.includeValueExamples == true,
			maxExamplesPerVariant = maxExamples, secretPatterns = secretPatterns, connections = {}, listenerBytes = #signals * 256,
			exampleAttempts = 0, examplesTruncated = false,
			events = {}, head = 1, count = 0,
			bytes = #HttpService:JSONEncode(targets) + #HttpService:JSONEncode(unsupported) + 2048 + #signals * 256 + secretBytes,
			observed = 0, dropped = { events = 0, shapes = 0, examples = 0, observationErrors = 0 }, groups = {}, shapeByKey = {},
		}
		if capture.bytes + 320 > 65536 then error("Remote capture metadata byte limit exceeded", 0) end
		local function fence()
			if not isCurrent() or state.tornDown or not requestContext or state.socket ~= requestContext.socket
				or not state.acknowledged then error("Remote capture interrupted", 0) end
		end
		fence()
		local installed, installationError = pcall(function()
			for _, selection in ipairs(signals) do
				local connection = selection.signal:Connect(inboundCallback(capture, selection.target))
				table.insert(capture.connections, connection)
				if connection == nil or type(connection.Disconnect) ~= "function" then
					error("UNSUPPORTED: inbound event connection unavailable", 0)
				end
				fence()
			end
			if capture.outbound then installHook() end
			fence()
		end)
		if not installed then
			capture.state, capture.targetByInstance, capture.secretPatterns = "interrupted", nil, nil
			cleanupListeners(capture)
			if activeOutbound == 0 then releaseHook() end
			error(installationError, 0)
		end
		while #flow.captureOrder >= 8 do
			for _, retainedId in ipairs(flow.captureOrder) do
				if flow.captures[retainedId].state ~= "active" then removeCapture(retainedId); break end
			end
		end
		capture.state = "active"
		flow.captures[id] = capture
		table.insert(flow.captureOrder, id)
		flow.activeCaptures = flow.activeCaptures + 1
		if capture.outbound then activeOutbound = activeOutbound + 1 end
		if requestContext then requestContext.createdRemoteCapture = id end
		scheduleLifecycleSweep()
		return captureResult(capture)
	end
	function handlers.remote_capture_poll(params)
		strictObject(params, { captureId = true, after = true, limit = true, view = true }, "params")
		local after = strictInteger(params.after, 0, 0, 9007199254740991, "after")
		local limit = strictInteger(params.limit, 20, 1, 20, "limit")
		local view = params.view or "summary"
		if view ~= "summary" and view ~= "events" and view ~= "profiles" then error("Invalid remote capture view", 0) end
		local capture = getCapture(params.captureId)
		if after > capture.observed then error("Remote capture cursor is ahead of observations", 0) end
		local result = captureResult(capture, true, view == "profiles")
		local oldest = capture.count > 0 and capture.events[capture.head].value.sequence or capture.observed + 1
		result.oldestSequence, result.droppedAfter = oldest, math.max(0, oldest - after - 1)
		result.nextAfter, result.hasMore = after, false
		if view == "events" then
			local events = {}
			for index = 0, capture.count - 1 do
				local entry = capture.events[(capture.head + index - 1) % capture.maxEvents + 1].value
				if entry.sequence > after then
					if #events >= limit then result.hasMore = true; break end
					table.insert(events, entry)
					result.nextAfter = entry.sequence
				end
			end
			result.events = events
		else
			result.hasMore = capture.observed > after and capture.count > 0
		end
		return result
	end
	function handlers.remote_capture_stop(params)
		strictObject(params, { captureId = true }, "params")
		local capture = getCapture(params.captureId)
		finish(capture, "stopped", "requested")
		if activeOutbound == 0 then releaseHook() end
		return captureResult(capture)
	end
	function flow.releaseOwnedCapture(id, reason)
		local capture = flow.captures[id]
		if not capture then return { available = false, reason = "capture-unavailable" } end
		finish(capture, reason == "deadline" and "expired" or "stopped", reason)
		if activeOutbound == 0 then releaseHook() end
		local result = captureResult(capture, true)
		removeCapture(id)
		return result
	end
	function flow.sweep()
		flow.pruneSnapshots()
		sweepCaptures()
	end
	function flow.rollback(requestContext)
		if requestContext.createdRemoteSnapshot then flow.releaseSnapshot(requestContext.createdRemoteSnapshot) end
		local capture = requestContext.createdRemoteCapture and flow.captures[requestContext.createdRemoteCapture]
		if capture then
			finish(capture, "interrupted", "response-unavailable")
			if activeOutbound == 0 then releaseHook() end
		end
	end
	function flow.teardown()
		for _, capture in pairs(flow.captures) do finish(capture, "interrupted", "bootstrap-teardown") end
		releaseHook()
		table.clear(flow.captures)
		table.clear(flow.captureOrder)
		table.clear(flow.snapshots)
		table.clear(flow.snapshotOrder)
		flow.snapshotBytes = 0
	end
	function flow.resources()
		local events, bytes, groups = 0, 0, 0
		for _, capture in pairs(flow.captures) do
			events, bytes, groups = events + capture.count, bytes + capture.bytes, groups + #capture.groups
		end
		return {
			snapshots = #flow.snapshotOrder, snapshotBytes = flow.snapshotBytes, maxSnapshots = 8, maxSnapshotBytes = 1048576,
			captures = #flow.captureOrder, activeCaptures = flow.activeCaptures, maxCaptures = 8, maxActiveCaptures = 4,
			captureEvents = events, captureBytes = bytes, captureGroups = groups, hookInstalled = flow.hook ~= nil,
			activeOutboundCaptures = activeOutbound,
		}
	end
end

function handlers.instance_references_release(params)
	strictObject(params, { references = true }, "params")
	local references = strictArray(params.references, 1, MAX_REFERENCE_RELEASE, "references")
	for _, reference in ipairs(references) do
		if not isInstanceReference(reference) then
			error("Invalid instance reference", 0)
		end
	end
	local results = {}
	for _, reference in ipairs(references) do
		table.insert(results, { reference = reference, released = releaseInstanceReference(reference) })
	end
	return { results = results }
end

local function batchRequests(params)
	strictObject(params, { requests = true, maxTotalValues = true, includeReferences = true, _maxResultBytes = true }, "params")
	local bindings = referenceBindings(params)
	local maximumBytes = math.min(MAX_BATCH_RESULT_BYTES, referenceResultLimit(params))
	local maximum = strictInteger(params.maxTotalValues, MAX_MULTI_READ_VALUES, 1, MAX_MULTI_READ_VALUES, "maxTotalValues")
	local requests = strictArray(params.requests, 1, MAX_MULTI_READ_REQUESTS, "requests")
	local normalized = {}
	-- Validate the entire request, including later rows, before touching instances.
	for _, request in ipairs(requests) do
		strictObject(request, { path = true, properties = true, attributes = true, children = true }, "request")
		if type(request.path) ~= "string" or #request.path < 1 or #request.path > 1024 then
			error("path must contain 1 to 1024 bytes", 0)
		end
		if request.properties == nil and request.attributes == nil and request.children == nil then
			error("Each request must include at least one read facet", 0)
		end
		local item = { path = request.path }
		if request.properties ~= nil then
			item.properties = strictArray(request.properties, 1, MAX_MULTI_READ_PROPERTIES, "properties")
			for _, property in ipairs(item.properties) do
				if type(property) ~= "string" or #property > 64
					or not string.match(property, "^[A-Za-z_][A-Za-z0-9_]*$") then
					error("Invalid property name", 0)
				end
			end
		end
		if request.attributes ~= nil then
			strictObject(request.attributes, { names = true, limit = true }, "attributes")
			local names, seen = {}, {}
			if request.attributes.names ~= nil then
				strictArray(request.attributes.names, 0, 32, "attributes.names")
				for _, name in ipairs(request.attributes.names) do
					if type(name) ~= "string" or #name < 1 or #name > 128 then
						error("Attribute names must contain 1 to 128 bytes", 0)
					end
					if not seen[name] then
						seen[name] = true
						table.insert(names, name)
					end
				end
			end
			table.sort(names)
			item.attributes = {
				names = names,
				limit = strictInteger(request.attributes.limit, 32, 1, 32, "attributes.limit"),
			}
		end
		if request.children ~= nil then
			strictObject(request.children, { limit = true }, "children")
			item.children = { limit = strictInteger(request.children.limit, 100, 1, 100, "children.limit") }
		end
		table.insert(normalized, item)
	end
	return normalized, maximum, bindings, maximumBytes
end

local function batchError(index, code)
	local messages = {
		TARGET_UNAVAILABLE = "Target unavailable",
		BUDGET_EXHAUSTED = "Value budget exhausted",
		RESULT_LIMIT = "Result limit exceeded",
	}
	return { index = index, ok = false, error = { code = code, message = messages[code] } }
end

local function jsonBytes(value)
	local ok, encoded = pcall(HttpService.JSONEncode, HttpService, value)
	return ok and type(encoded) == "string" and #encoded or math.huge
end

function handlers.batch_read(params, requestContext, selection)
	local requests, maximum, bindings, maximumBytes = batchRequests(params)
	local response = { requestCount = #requests, valueCount = 0, truncated = false, results = {} }
	for index in ipairs(requests) do
		response.results[index] = batchError(index, "BUDGET_EXHAUSTED")
	end
	-- Keep space for every remaining error row and valueCount's final digits.
	local responseBytes = jsonBytes(response) + 4
	if responseBytes > maximumBytes then
		error("Batch result limit too small", 0)
	end
	local work = newWorkBudget()
	work.maxItems = MAX_BATCH_WORK_ITEMS
	work.cancelled = selection and selection.cancelled
	local sharedSerialization = {
		items = 0, bytes = 0,
		maxItems = MAX_BATCH_SERIALIZED_ITEMS, maxBytes = MAX_BATCH_SERIALIZED_BYTES,
	}
	local function valueBudget()
		return { items = 0, bytes = 0, maxItems = 256, maxBytes = MAX_BATCH_VALUE_BYTES, shared = sharedSerialization }
	end
	local function summary(instance, rowBindings)
		local budget = valueBudget()
		local value = instanceSummary(instance, rowBindings, budget)
		if rowBindings then
			-- Exact-width placeholder accounts for references before allocating any.
			value.reference = "instance://" .. string.rep("0", 32)
		end
		local size = jsonBytes(value)
		local items = 1
		for _ in pairs(value) do items = items + 2 end
		-- Nested values already consumed their budgets. Charge the complete
		-- summary, including identity fields and keys, even if its row is discarded.
		local withinBudget = consumeSerializeBudget(budget, items, math.max(0, size - budget.bytes))
		if not withinBudget or size > MAX_BATCH_VALUE_BYTES then
			error("Summary serialization limit exceeded", 0)
		end
		return value, size, budget.bytes
	end
	for index, request in ipairs(requests) do
		local previousBytes = jsonBytes(response.results[index])
		local rowBindings = bindings and {} or nil
		local attemptedProperties = 0
		local startValues = response.valueCount
		local row
		if startValues >= maximum then
			row = batchError(index, "BUDGET_EXHAUSTED")
		elseif (work.totalItems or 0) > work.maxItems
			or sharedSerialization.items > sharedSerialization.maxItems
			or sharedSerialization.bytes > sharedSerialization.maxBytes then
			row = batchError(index, "RESULT_LIMIT")
		else
			local resolved, instance
			if selection then
				instance = selection.targets[index]
				resolved = instance and pcall(function()
					if instance ~= game and not instance:IsDescendantOf(game) then error("Target unavailable", 0) end
				end)
			else
				resolved, instance = pcall(resolvePath, request.path)
			end
			if not resolved or not instance then
				row = batchError(index, "TARGET_UNAVAILABLE")
			else
				local ok, result = pcall(function()
					local item = { index = index, ok = true, instance = summary(instance, rowBindings), truncated = false }
					if request.properties then item.properties = {} end
					if request.attributes then item.attributes = { ok = true, values = {}, truncated = false } end
					if request.children then item.children = { ok = true, total = 0, children = {}, truncated = false } end
					local estimatedBytes = jsonBytes(item)
					local availableBytes = maximumBytes - responseBytes + previousBytes
					local propertyReservations = {}
					local function reserve(value, key, size, chargedBytes, items)
						size = size or jsonBytes(value)
						local keyBytes = key and jsonBytes(key) or 0
						-- Charge attempted serialization independently of retained output.
						if not consumeSerializeBudget(sharedSerialization, items or 0,
							math.max(0, size - (chargedBytes or 0)) + keyBytes + 8) then
							error("Value serialization limit exceeded", 0)
						end
						if size > MAX_BATCH_VALUE_BYTES then
							error("Value serialization limit exceeded", 0)
						end
						-- A duplicate property replaces its map slot, but still consumes
						-- the attempted-value and aggregate serialization budgets.
						local reservation = size + keyBytes + 8
						estimatedBytes = estimatedBytes + reservation - (key and propertyReservations[key] or 0)
						if key then propertyReservations[key] = reservation end
						if estimatedBytes > availableBytes then
							error("Result limit exceeded", 0)
						end
					end
					if estimatedBytes > availableBytes then
						error("Result limit exceeded", 0)
					end
					if request.properties then
						for _, property in ipairs(request.properties) do
							if response.valueCount >= maximum then
								item.truncated = true
								break
							end
							attemptedProperties = attemptedProperties + 1
							response.valueCount = response.valueCount + 1
							local budget = valueBudget()
							local value = propertyResult(instance, property, budget)
							local size = jsonBytes(value)
							if size > MAX_BATCH_VALUE_BYTES then
								value = { ok = false, error = "Property serialization limit exceeded" }
								size = jsonBytes(value)
							end
							reserve(value, property, size, budget.bytes, 4)
							item.properties[property] = value
							checkpointWork(work)
						end
					end
					if request.attributes then
						local facet = item.attributes
						if response.valueCount >= maximum then
							facet.truncated, item.truncated = true, true
						else
							local attributesOk, attributes = pcall(function() return instance:GetAttributes() end)
							if not attributesOk or type(attributes) ~= "table" then
								item.attributes = { ok = false, error = "Attributes unavailable" }
							else
								local names = request.attributes.names
								if #names == 0 then
									names = {}
									for name in pairs(attributes) do
										if type(name) == "string" then table.insert(names, name) end
										checkpointWork(work)
									end
									table.sort(names)
								end
								for _, name in ipairs(names) do
									local raw = attributes[name]
									if raw ~= nil and scalarAttribute(raw) then
										if #facet.values >= request.attributes.limit or response.valueCount >= maximum then
											facet.truncated, item.truncated = true, true
											break
										end
										local budget = valueBudget()
										local value, serializationError = serialize(raw, nil, nil, budget)
										if serializationError then error("Attribute serialization limit exceeded", 0) end
										local entry = { name = redactString(name), value = value }
										reserve(entry, nil, nil, budget.bytes, 4)
										table.insert(facet.values, entry)
										response.valueCount = response.valueCount + 1
									end
									checkpointWork(work)
								end
							end
						end
					end
					if request.children then
						local facet = item.children
						local childrenOk, children, truncated, total = pcall(sortedChildren, instance,
							math.min(request.children.limit, maximum - response.valueCount), work, true)
						if not childrenOk then
							if (work.totalItems or 0) > work.maxItems then error("Read work limit exceeded", 0) end
							item.children = { ok = false, error = "Children unavailable" }
						else
							facet.total, facet.truncated = total, truncated
							item.truncated = item.truncated or truncated
							for _, child in ipairs(children) do
								local entry, size, chargedBytes = summary(child, rowBindings)
								reserve(entry, nil, size, chargedBytes)
								table.insert(facet.children, entry)
								response.valueCount = response.valueCount + 1
								checkpointWork(work)
							end
						end
					end
					return item
				end)
				row = ok and result or batchError(index, "RESULT_LIMIT")
			end
		end
		local rowBytes = jsonBytes(row)
		if responseBytes - previousBytes + rowBytes > maximumBytes then
			row = batchError(index, "RESULT_LIMIT")
			rowBytes = jsonBytes(row)
		end
		if not row.ok then
			-- Only attempted property slots survive a discarded row. Attribute and
			-- child values count exclusively when actually returned.
			response.valueCount = startValues + attemptedProperties
		elseif bindings then
			for _, binding in ipairs(rowBindings) do table.insert(bindings, binding) end
		end
		response.results[index] = row
		responseBytes = responseBytes - previousBytes + rowBytes
		response.truncated = response.truncated or row.truncated == true
			or (not row.ok and row.error.code ~= "TARGET_UNAVAILABLE")
	end
	-- Validate the complete result before acquiring reference ownership.
	if jsonBytes(response) > maximumBytes then
		error("Batch serialization limit exceeded", 0)
	end
	commitInstanceReferences(bindings, requestContext)
	return response
end

do
	local flow = state.actionObservations
	local function remove(id)
		flow.records[id] = nil
		for index, candidate in ipairs(flow.order) do
			if candidate == id then table.remove(flow.order, index); break end
		end
	end
	local function coverage(snapshot)
		if not snapshot then return { coverage = "unavailable", complete = false, reason = "not-observed" } end
		local result = { coverage = "complete", complete = not snapshot.truncated, truncated = snapshot.truncated, reads = {} }
		for _, row in ipairs(snapshot.results) do
			local item = { selectionId = row.index, available = row.ok, truncated = row.truncated, error = row.error, failures = {} }
			if not row.ok or row.truncated then result.complete = false end
			for property, value in pairs(row.properties or {}) do
				if not value.ok then
					table.insert(item.failures, { field = "properties." .. property, error = value.error })
					result.complete = false
				end
			end
			table.sort(item.failures, function(a, b) return a.field < b.field end)
			for _, field in ipairs({ "attributes", "children" }) do
				local facet = row[field]
				if facet and (not facet.ok or facet.truncated) then
					table.insert(item.failures, { field = field, error = facet.error, truncated = facet.truncated })
					result.complete = false
				end
			end
			table.insert(result.reads, item)
		end
		if not result.complete then result.coverage = "partial" end
		return result
	end
	local function receipt(record, details)
		local result = {
			observationId = record.id, generation = generation, state = record.state, reason = record.reason,
			correlation = "temporal", atomicSnapshot = false, startedAt = record.startedAt,
			deadline = record.deadline, remainingMs = math.max(0, math.floor((record.deadline - os.clock()) * 1000)),
			finishedAt = record.finishedAt,
		}
		if details then
			result.before = record.result and record.result.before or coverage(record.before)
			result.after = record.result and record.result.after or coverage(nil)
			result.changes = record.result and record.result.changes or {}
			result.truncated = record.result and record.result.truncated or false
			result.remotes = record.result and record.result.remotes or { selected = record.captureId ~= nil, pending = record.captureId ~= nil }
		end
		return result
	end
	local function releaseInputs(record)
		record.requests, record.targets, record.before, record.socket, record.remoteSummary = nil, nil, nil, nil, nil
		if record.timer then pcall(task.cancel, record.timer); record.timer = nil end
	end
	local function stopCapture(record, reason)
		if not record.captureId then return record.remoteSummary or { selected = false } end
		local result = state.remoteWorkflow.releaseOwnedCapture(record.captureId, reason)
		record.captureId = nil
		result.selected = true
		return result
	end
	local function interrupt(record, reason)
		if record.state == "completed" or record.state == "interrupted" then return end
		record.state, record.reason, record.finishedAt = "interrupted", reason, os.clock()
		record.result = { before = coverage(record.before), after = { coverage = "unavailable", complete = false, reason = reason },
			changes = {}, truncated = false, remotes = stopCapture(record, reason) }
		releaseInputs(record)
		flow.active = math.max(0, flow.active - 1)
	end
	local function compare(before, after)
		local changes, truncated = {}, false
		local function add(index, field, left, right)
			if stableEqual(left, right) then return end
			if #changes >= 100 then truncated = true; return end
			local unavailable = (type(left) == "table" and left.ok == false) or (type(right) == "table" and right.ok == false)
			table.insert(changes, { selectionId = index, field = field,
				kind = unavailable and "availability" or "changed", before = left, after = right })
		end
		for index, left in ipairs(before.results) do
			local right = after.results[index]
			if not left.ok or not right.ok then
				add(index, "target", left, right)
			else
				add(index, "instance", left.instance, right.instance)
				local names, seen = {}, {}
				for property in pairs(left.properties or {}) do seen[property] = true; table.insert(names, property) end
				for property in pairs(right.properties or {}) do if not seen[property] then table.insert(names, property) end end
				table.sort(names)
				for _, property in ipairs(names) do
					add(index, "properties." .. property, left.properties and left.properties[property], right.properties and right.properties[property])
				end
				add(index, "attributes", left.attributes, right.attributes)
				add(index, "children", left.children, right.children)
			end
		end
		return changes, truncated
	end
	local function complete(record, reason)
		if record.state ~= "active" then return end
		record.state, record.reason = "completing", reason
		if record.timer then pcall(task.cancel, record.timer); record.timer = nil end
		local remotes = stopCapture(record, reason)
		record.remoteSummary = remotes
		-- Only the bounded after read runs in a background task; no request owns
		-- the observation window or waits for this completion.
		task.defer(function()
			if record.state ~= "completing" then return end
			local ok, after = pcall(handlers.batch_read, { requests = record.requests, _maxResultBytes = record.snapshotBytes }, nil, {
				targets = record.targets,
				cancelled = function() return record.state ~= "completing" or not isCurrent() end,
			})
			if record.state ~= "completing" then return end
			if not isCurrent() then interrupt(record, "bootstrap-teardown"); return end
			local changes, truncated = {}, false
			if ok then changes, truncated = compare(record.before, after) end
			record.result = {
				before = coverage(record.before), after = ok and coverage(after) or {
					coverage = "unavailable", complete = false, reason = asyncErrorMessage(after),
				}, changes = changes, truncated = truncated, remotes = remotes,
			}
			record.state, record.finishedAt = "completed", os.clock()
			releaseInputs(record)
			flow.active = math.max(0, flow.active - 1)
			-- Each retained result has an independent full-JSON ceiling. All eight
			-- reservations together therefore remain within one MiB.
			while jsonBytes(receipt(record, true)) > 131072 and #changes > 0 do
				table.remove(changes)
				record.result.truncated = true
			end
		end)
	end
	function flow.sweep()
		local now = os.clock()
		for index = #flow.order, 1, -1 do
			local record = flow.records[flow.order[index]]
			if record.state == "active" and now >= record.deadline then complete(record, "deadline") end
			if record.finishedAt and now - record.finishedAt >= 120 then remove(record.id) end
		end
	end
	function flow.rollback(context)
		local record = context.createdActionObservation and flow.records[context.createdActionObservation]
		if record then interrupt(record, "response-unavailable"); remove(record.id) end
	end
	function flow.disconnect(socket)
		for _, record in pairs(flow.records) do
			if record.socket == socket then interrupt(record, "transport-disconnected") end
		end
	end
	function flow.teardown()
		for _, record in pairs(flow.records) do interrupt(record, "bootstrap-teardown") end
		table.clear(flow.records)
		table.clear(flow.order)
	end
	function flow.resources()
		return { active = flow.active, retained = #flow.order, maxActive = 4, maxRetained = 8,
			reservedBytes = #flow.order * 131072, maxBytes = 1048576 }
	end
	function handlers.observe_action(params, requestContext)
		strictObject(params, { operation = true, requests = true, remotes = true, durationMs = true, observationId = true }, "params")
		local operation = params.operation
		if operation ~= "start" and operation ~= "poll" and operation ~= "stop" then error("Invalid observation operation", 0) end
		if operation ~= "start" then
			if params.requests ~= nil or params.remotes ~= nil or params.durationMs ~= nil then error("Only start accepts observation selections", 0) end
			if not isResourceId(params.observationId) then error("Invalid action observation id", 0) end
			flow.sweep()
			local record = flow.records[params.observationId]
			if not record then error("Action observation unavailable: expired, evicted, or another generation", 0) end
			if operation == "stop" then complete(record, "requested") end
			return receipt(record, true)
		end
		if params.observationId ~= nil then error("start does not accept observationId", 0) end
		strictArray(params.requests, 1, 16, "requests")
		local requests = batchRequests({ requests = params.requests })
		local duration = strictInteger(params.durationMs, 5000, 1000, 30000, "durationMs")
		if jsonBytes(requests) > 49152 then error("Observation selections exceed 49152 bytes", 0) end
		local targets, remoteTargets = {}, {}
		for index, request in ipairs(requests) do targets[index] = resolvePath(request.path) or false end
		if params.remotes ~= nil then
			strictArray(params.remotes, 0, 16, "remotes")
			for _, path in ipairs(params.remotes) do
				if type(path) ~= "string" or #path < 1 or #path > 1024 then error("Invalid capture target", 0) end
				local remote, err = resolvePath(path)
				if not remote then error(err, 0) end
				if remote.ClassName ~= "RemoteEvent" and remote.ClassName ~= "RemoteFunction" and remote.ClassName ~= "UnreliableRemoteEvent" then
					error("Capture target must be an outbound remote", 0)
				end
				remoteTargets[path] = remote
			end
		end
		flow.sweep()
		if flow.active >= 4 then error("Action observation active capacity exceeded", 0) end
		while #flow.order >= 8 do
			for _, id in ipairs(flow.order) do
				if flow.records[id].finishedAt then remove(id); break end
			end
		end
		local id = newResourceId(flow.records)
		if not id then error("Action observation identity unavailable", 0) end
		local record = { id = id, state = "starting", requests = requests, targets = targets,
			socket = requestContext.socket, startedAt = os.clock(), deadline = os.clock() + duration / 1000 }
		record.snapshotBytes = math.min(32768, 131072 - 65536 - jsonBytes(requests) - 4096)
		flow.records[id], flow.active = record, flow.active + 1
		table.insert(flow.order, id)
		requestContext.createdActionObservation = id
		record.before = handlers.batch_read({ requests = requests, _maxResultBytes = record.snapshotBytes }, nil, {
			targets = targets, cancelled = function() return record.state ~= "starting" or not isCurrent() end,
		})
		if record.state ~= "starting" or not isCurrent() or state.socket ~= requestContext.socket or not state.acknowledged then
			error("Action observation interrupted", 0)
		end
		if params.remotes and #params.remotes > 0 then
			for path, remote in pairs(remoteTargets) do
				if resolvePath(path) ~= remote then error("Capture target changed during before observation", 0) end
			end
			record.captureId = handlers.remote_capture_start({ targets = params.remotes, durationMs = duration, maxEvents = 100 }, requestContext).captureId
		end
		record.state, record.startedAt = "active", os.clock()
		record.deadline = record.startedAt + duration / 1000
		record.timer = task.delay(duration / 1000, function()
			record.timer = nil
			if not isCurrent() then interrupt(record, "bootstrap-teardown") else complete(record, "deadline") end
		end)
		scheduleLifecycleSweep()
		return receipt(record, false)
	end
end

function handlers.multi_read_properties(params)
	params = tableParams(params)
	if type(params.requests) ~= "table" or #params.requests < 1 or #params.requests > MAX_MULTI_READ_REQUESTS then
		error("requests must contain 1 to " .. MAX_MULTI_READ_REQUESTS .. " entries", 0)
	end
	local totalValues, results = 0, {}
	local maxTotalValues =
		strictBoundedInteger(params.maxTotalValues, MAX_MULTI_READ_VALUES, 1, MAX_MULTI_READ_VALUES, "maxTotalValues")
	for _, request in ipairs(params.requests) do
		if type(request) ~= "table" then
			error("Each request must be an object", 0)
		end
		local instance, pathError = resolvePath(request.path)
		if not instance then
			error(pathError, 0)
		end
		local properties = readableProperties(request.properties, MAX_MULTI_READ_PROPERTIES, "properties")
		totalValues = totalValues + #properties
		if totalValues > maxTotalValues then
			error("Requested property values exceed maxTotalValues", 0)
		end
		local values = {}
		for _, property in ipairs(properties) do
			values[property] = propertyResult(instance, property)
		end
		table.insert(results, { instance = instanceSummary(instance), properties = values })
	end
	return { requestCount = #results, valueCount = totalValues, results = results }
end
function handlers.instance_ancestry(params)
	params = tableParams(params)
	local instance, pathError = resolvePath(params.path)
	if not instance then
		error(pathError, 0)
	end
	local maxDepth = strictBoundedInteger(params.maxDepth, 16, 1, MAX_ANCESTRY_DEPTH, "maxDepth")
	local function chain(node)
		local raw, summaries, truncated = {}, {}, false
		for depth = 0, maxDepth do
			table.insert(raw, node)
			table.insert(summaries, instanceSummary(node))
			node = node.Parent
			if not node then
				break
			end
			if depth == maxDepth then
				truncated = true
			end
		end
		return raw, summaries, truncated
	end
	local rawChainA, chainA, truncatedA = chain(instance)
	if params.otherPath == nil then
		return { path = safePath(instance), chain = chainA, truncated = truncatedA }
	end
	local other, otherError = resolvePath(params.otherPath)
	if not other then
		error(otherError, 0)
	end
	local rawChainB, chainB, truncatedB = chain(other)
	local seen, common = {}, nil
	for index, ancestor in ipairs(rawChainA) do
		seen[ancestor] = chainA[index]
	end
	for _, ancestor in ipairs(rawChainB) do
		if seen[ancestor] then
			common = seen[ancestor]
			break
		end
	end
	return {
		path = safePath(instance),
		otherPath = safePath(other),
		chain = chainA,
		otherChain = chainB,
		commonAncestor = common,
		pathIsDescendantOfOther = instance:IsDescendantOf(other),
		otherIsDescendantOfPath = other:IsDescendantOf(instance),
		truncated = truncatedA or truncatedB,
	}
end

function handlers.class_summary(params)
	params = tableParams(params)
	local root, pathError = resolvePath(params.path)
	if not root then
		error(pathError, 0)
	end
	local maxDepth = strictBoundedInteger(params.maxDepth, 3, 0, 8, "maxDepth")
	local maxVisited = strictBoundedInteger(params.maxVisited, 5000, 1, MAX_CLASS_SUMMARY_VISITS, "maxVisited")
	local maxClasses = strictBoundedInteger(params.maxClasses, 100, 1, MAX_CLASS_SUMMARY_RESULTS, "maxClasses")
	local counts, queue, head, visited, truncated = {}, { { node = root, depth = 0 } }, 1, 0, false
	local budget = newWorkBudget()
	while head <= #queue and visited < maxVisited do
		local entry = queue[head]
		head = head + 1
		visited = visited + 1
		counts[entry.node.ClassName] = (counts[entry.node.ClassName] or 0) + 1
		checkpointWork(budget)
		if entry.depth < maxDepth then
			local children, childrenTruncated = sortedChildren(entry.node, maxVisited - #queue, budget)
			if childrenTruncated then
				truncated = true
			end
			for _, child in ipairs(children) do
				table.insert(queue, { node = child, depth = entry.depth + 1 })
				checkpointWork(budget)
			end
		end
	end
	if head <= #queue then
		truncated = true
	end
	local classes = {}
	for className, count in pairs(counts) do
		table.insert(classes, { className = className, count = count })
	end
	table.sort(classes, function(a, b)
		return a.className < b.className
	end)
	while #classes > maxClasses do
		table.remove(classes)
		truncated = true
	end
	return { root = instanceSummary(root), visited = visited, classes = classes, truncated = truncated }
end

local function safeErrorMessage(errorMessage)
	local message = tostring(errorMessage or "Request failed")
	message = string.match(message, "^[^\r\n]*") or "Request failed"
	message = redactString(message)
	message = string.gsub(message, "[%c]", " ")
	message = string.gsub(message, "%s+", " ")
	message = string.gsub(message, "^%s+", "")
	message = string.gsub(message, "%s+$", "")
	if message == "" then
		message = "Request failed"
	end
	if #message > MAX_ERROR_MESSAGE_BYTES then
		message = string.sub(message, 1, MAX_ERROR_MESSAGE_BYTES - 3) .. "..."
	end
	return message
end

local function send(socket, message)
	local encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, message)
	if not encodedOk or type(encoded) ~= "string" or #encoded > MAX_MESSAGE_BYTES then
		return false
	end
	return pcall(function()
		socket:Send(encoded)
	end)
end

local function sendResponseError(socket, id, errorMessage)
	local sent = send(socket, {
		type = "response",
		id = id,
		ok = false,
		error = { message = safeErrorMessage(errorMessage) },
	})
	if not sent then pcall(function() socket:Close() end) end
	return sent
end

do
	local controls = {
		capabilities = true, watch_start = true, watch_poll = true, watch_stop = true, async_job_list = true,
		async_job_cancel = true, instance_references_release = true, remote_capture_poll = true, remote_capture_stop = true,
	}
	local mutations = { execute_luau = true, execute_luau_async = true, remote_call = true, remote_capture_start = true }
	function state.requestClass(method, params)
		if method == "map_recording" then
			return type(params) == "table" and params.operation == "start" and "read" or "control"
		end
		if method == "observe_action" then
			return type(params) == "table" and (params.operation == "poll" or params.operation == "stop") and "control" or "mutation"
		end
		if controls[method] then return "control" end
		return mutations[method] and "mutation" or "read"
	end
end

local function handleMessage(socket, rawMessage)
	if type(rawMessage) ~= "string" or #rawMessage > MAX_MESSAGE_BYTES then
		return
	end

	local decodedOk, message = pcall(HttpService.JSONDecode, HttpService, rawMessage)
	if not decodedOk or type(message) ~= "table" then
		return
	end

	if not state.acknowledged then
		local handshake = state.handshake
		if not handshake or message.protocol ~= PROTOCOL or message.clientNonce ~= handshake.clientNonce then
			return
		end

		if message.type == "challenge" and handshake.serverNonce == nil then
			local expectedServerProof = handshakeProof("server", handshake.clientNonce, message.serverNonce)
			if
				not isHex(message.serverNonce, NONCE_HEX_LENGTH)
				or not proofsMatch(expectedServerProof, message.proof)
			then
				state.teardown()
				state.connected = false
				state.handshake = nil
				state.startupStatus = "disabled"
				state.startupReason = "authentication failed"
				warn("[Potassium MCP] Disabled: authentication failed")
				pcall(function()
					socket:Close()
				end)
				return
			end

			local proof = handshakeProof("client", handshake.clientNonce, message.serverNonce)
			if
				not proof
				or not send(socket, {
					type = "ack",
					protocol = PROTOCOL,
					clientNonce = handshake.clientNonce,
					serverNonce = message.serverNonce,
					proof = proof,
				})
			then
				state.connected = false
				state.handshake = nil
				state.startupStatus = "connection_unavailable"
				state.startupReason = "connection failed"
				pcall(function()
					socket:Close()
				end)
				return
			end
			handshake.serverNonce = message.serverNonce
			return
		end

		if
			message.type == "ready"
			and handshake.serverNonce ~= nil
			and message.serverNonce == handshake.serverNonce
			and message.clientId == state.clientId
			and message.generation == state.generation
		then
			state.handshake = nil
			state.acknowledged = true
			state.connected = true
			state.lastPongAt = os.clock()
			state.reconnectAttempt = 0
			cancelConnectionTimeout()
			state.startupStatus = "active"
			state.startupReason = nil
			local heartbeatSocket = socket
			task.spawn(function()
				while isCurrent() and state.socket == heartbeatSocket and state.acknowledged do
					task.wait(HEARTBEAT_STALE_SECONDS / 3)
					if
						isCurrent()
						and state.socket == heartbeatSocket
						and state.acknowledged
						and os.clock() - state.lastPongAt > HEARTBEAT_STALE_SECONDS
					then
						state.startupStatus = "connection_unavailable"
						state.startupReason = "heartbeat timed out"
						pcall(function()
							heartbeatSocket:Close()
						end)
						break
					end
				end
			end)
		end
		return
	end

	if not state.acknowledged then
		return
	end
	if message.type == "ping" and type(message.nonce) == "string" and #message.nonce <= 64 then
		send(socket, { type = "pong", nonce = message.nonce })
		state.lastPongAt = os.clock()
		return
	end
	if message.type ~= "request" or type(message.id) ~= "string" then
		return
	end
	if #message.id > MAX_REQUEST_ID_BYTES then
		return
	end
	if state.activeRequestIds[message.id] then
		state.duplicateRequestIds = state.duplicateRequestIds + 1
		-- The original may already be executing. A second response with its ID is
		-- ambiguous; close without replaying or releasing its execution ownership.
		pcall(function() socket:Close() end)
		return
	end
	local requestClass = state.requestClass(message.method, message.params)
	if state.inFlightRequests >= MAX_IN_FLIGHT_REQUESTS
		or (requestClass == "read" and state.requestCounts.read >= 4)
		or (requestClass == "control" and state.requestCounts.control >= 4) then
		state.rejectedRequests = state.rejectedRequests + 1
		sendResponseError(socket, message.id, "Request capacity exceeded")
		return
	end
	if message.method == "observe_action" and requestClass == "mutation" and state.rawExecutionActive then
		sendResponseError(socket, message.id, "Raw execution is busy")
		return
	end

	state.activeRequestIds[message.id] = true
	state.inFlightRequests = state.inFlightRequests + 1
	state.requestCounts[requestClass] = state.requestCounts[requestClass] + 1
	state.peakInFlightRequests = math.max(state.peakInFlightRequests, state.inFlightRequests)

	task.spawn(function()
		local requestContext = { socket = socket, createdReferenceEntries = {} }
		local released = false
		local function release()
			if released then
				return
			end
			released = true
			if state.mapSnapshots.releaseRequest then state.mapSnapshots.releaseRequest(requestContext) end
			state.activeRequestIds[message.id] = nil
			state.inFlightRequests = math.max(0, state.inFlightRequests - 1)
			state.requestCounts[requestClass] = math.max(0, state.requestCounts[requestClass] - 1)
		end

		local handler = handlers[message.method]
		if not handler then
			sendResponseError(socket, message.id, "Unknown method")
			release()
			return
		end

		local ok, result = xpcall(function()
			return handler(message.params or {}, requestContext)
		end, function(err)
			return safeErrorMessage(err)
		end)
		if not isCurrent() or state.socket ~= socket or not state.acknowledged then
			rollbackInstanceReferences(requestContext)
		elseif ok then
			if not send(socket, { type = "response", id = message.id, ok = true, result = result }) then
				rollbackInstanceReferences(requestContext)
				-- Send can fail after delivery. Never emit a competing response.
				pcall(function() socket:Close() end)
			end
		else
			rollbackInstanceReferences(requestContext)
			sendResponseError(socket, message.id, result)
		end
		release()
	end)
end

local connect
local function scheduleReconnect()
	if not isCurrent() or state.reconnectScheduled then
		return
	end
	local delaySeconds =
		math.min(RECONNECT_MAX_DELAY_SECONDS, RECONNECT_BASE_DELAY_SECONDS * (2 ^ state.reconnectAttempt))
	state.reconnectAttempt = math.min(state.reconnectAttempt + 1, 6)
	state.reconnectScheduled = true
	task.delay(delaySeconds, function()
		state.reconnectScheduled = false
		if isCurrent() then
			connect()
		end
	end)
end
connect = function()
	if not isCurrent() or state.socket then
		return
	end
	if type(webSocketConnect) ~= "function" then
		state.teardown()
		state.connected = false
		state.acknowledged = false
		state.startupStatus = "disabled"
		state.startupReason = "WebSocket.connect unavailable"
		warn("[Potassium MCP] Disabled: WebSocket.connect is unavailable")
		return
	end

	local ok, socketOrError = pcall(webSocketConnect, ENDPOINT)
	if not isCurrent() then
		if ok and socketOrError then
			pcall(function()
				socketOrError:Close()
			end)
		end
		return
	end
	if not ok then
		state.connected = false
		state.acknowledged = false
		state.startupStatus = "connection_unavailable"
		state.startupReason = "connection failed"
		warn("[Potassium MCP] Connect failed")
		scheduleReconnect()
		return
	end

	local socket = socketOrError
	state.socket = socket
	state.connected = false
	state.acknowledged = false
	state.handshake = nil
	state.startupStatus = "connecting"
	state.startupReason = nil
	table.insert(state.socketConnections, socket.OnMessage:Connect(function(message)
		if isCurrent() and state.socket == socket then
			handleMessage(socket, message)
		end
	end))
	table.insert(state.socketConnections, socket.OnClose:Connect(function()
		if state.socket == socket then
			if state.actionObservations.disconnect then state.actionObservations.disconnect(socket) end
			if state.mapRecordings.disconnect then state.mapRecordings.disconnect(socket) end
			if state.mapSnapshots.clear then state.mapSnapshots.clear() end
			disconnectConnections(state.socketConnections)
			state.socket = nil
			state.connected = false
			state.acknowledged = false
			state.handshake = nil
			state.handshakeGeneration = state.handshakeGeneration + 1
			cancelConnectionTimeout()
			-- Native transports may reconnect after a peer close. Retire the old
			-- transport before our reconnect loop creates its replacement.
			pcall(function()
				socket:Close()
			end)
			if state.active then
				state.startupStatus = "connection_unavailable"
				state.startupReason = "connection closed"
				scheduleReconnect()
			end
		end
	end))

	local executorName, executorVersion = "Potassium", nil
	if type(identifyexecutor) == "function" then
		local identified, name, version = pcall(identifyexecutor)
		if identified then
			executorName = tostring(name or executorName)
			executorVersion = version and tostring(version) or nil
		end
	end
	local clientNonce = secureRandomNonce()
	if not clientNonce then
		state.teardown()
		state.connected = false
		state.acknowledged = false
		state.startupStatus = "disabled"
		state.startupReason = "secure cryptography unavailable"
		pcall(function()
			socket:Close()
		end)
		return
	end

	state.handshakeGeneration = state.handshakeGeneration + 1
	local handshakeGeneration = state.handshakeGeneration
	state.handshake = { clientNonce = clientNonce }
	if
		not send(socket, {
			type = "hello",
			protocol = PROTOCOL,
			clientId = state.clientId,
			generation = state.generation,
			clientNonce = clientNonce,
			client = {
				protocol = PROTOCOL,
				executor = executorName,
				version = executorVersion,
				placeId = game.PlaceId,
			},
		})
	then
		if state.socket == socket then
			disconnectConnections(state.socketConnections)
			state.socket = nil
			state.connected = false
			state.acknowledged = false
			state.handshake = nil
			state.startupStatus = "connection_unavailable"
			state.startupReason = "connection failed"
		end
		pcall(function()
			socket:Close()
		end)
		scheduleReconnect()
		return
	end

	task.delay(HANDSHAKE_TIMEOUT_SECONDS, function()
		if
			isCurrent()
			and state.socket == socket
			and state.handshakeGeneration == handshakeGeneration
			and not state.acknowledged
		then
			state.connected = false
			state.handshake = nil
			state.startupStatus = "connection_unavailable"
			state.startupReason = "handshake timed out"
			pcall(function()
				socket:Close()
			end)
		end
	end)
end

if not token then
	warn("[Potassium MCP] Disabled: authentication token unavailable")
elseif not cryptoAvailable then
	warn("[Potassium MCP] Disabled: secure cryptography unavailable")
elseif type(webSocketConnect) ~= "function" then
	warn("[Potassium MCP] Disabled: WebSocket.connect is unavailable")
else
	startConnectionTimeout()
	task.defer(connect)
end

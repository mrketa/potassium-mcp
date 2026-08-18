local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local ENDPOINT = "ws://127.0.0.1:32145"
local PROTOCOL = 2
local MAX_SERIALIZE_DEPTH = 6
local MAX_TABLE_ITEMS = 200
local MAX_MESSAGE_BYTES = 1048576
local MAX_ERROR_MESSAGE_BYTES = 1024
local MAX_TOKEN_BYTES = 4096
local MAX_IN_FLIGHT_REQUESTS = 1
local MAX_REQUEST_ID_BYTES = 256
local RECONNECT_BASE_DELAY_SECONDS = 1
local RECONNECT_MAX_DELAY_SECONDS = 30
local HANDSHAKE_TIMEOUT_SECONDS = 5
local CONNECTION_TIMEOUT_SECONDS = 10
local WORK_SLICE_SECONDS = 0.002
local WORK_SLICE_ITEMS = 128

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
if type(previous) == "table" and (previous.socket ~= nil or (tonumber(previous.inFlightRequests) or 0) > 0) then
	warn("[Potassium MCP] Bootstrap reload refused while the prior session owns a socket or request")
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
local state = {
	active = token ~= nil and cryptoAvailable and webSocketConnect ~= nil,
	acknowledged = false,
	connected = false,
	socket = nil,
	handshake = nil,
	handshakeGeneration = 0,
	startupStatus = startupStatus,
	startupReason = startupReason,
	reconnectScheduled = false,
	reconnectAttempt = 0,
	connectionTimeoutGeneration = 0,
	inFlightRequests = 0,
	activeRequestIds = {},
}

if type(previous) == "table" then
	previous.active = false
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

local function startConnectionTimeout()
	state.connectionTimeoutGeneration = state.connectionTimeoutGeneration + 1
	local timeoutGeneration = state.connectionTimeoutGeneration
	task.delay(CONNECTION_TIMEOUT_SECONDS, function()
		if not isCurrent() or state.acknowledged or state.connectionTimeoutGeneration ~= timeoutGeneration then
			return
		end

		local socket = state.socket
		state.active = false
		state.socket = nil
		state.connected = false
		state.acknowledged = false
		state.handshake = nil
		state.handshakeGeneration = state.handshakeGeneration + 1
		state.startupStatus = "disabled"
		state.startupReason = "connection timed out"
		warn("[Potassium MCP] Disabled: connection timed out")
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

local function redactString(value)
	if type(value) ~= "string" then
		return value
	end
	local player = Players.LocalPlayer
	local secrets = { token, game.JobId }
	if player then
		table.insert(secrets, safeProperty(player, "Name"))
		table.insert(secrets, safeProperty(player, "DisplayName"))
		table.insert(secrets, tostring(safeProperty(player, "UserId") or ""))
	end
	local output = value
	for _, secret in ipairs(secrets) do
		if type(secret) == "string" and secret ~= "" then
			output = string.gsub(output, string.gsub(secret, "([^%w])", "%%%1"), "[redacted]")
		end
	end
	output = string.gsub(output, "[Bb]earer%s+[%w%-%._~%+/%=]+", "[redacted]")
	output = string.gsub(output, "https?://[^%s]+", "[redacted]")
	output = string.gsub(output, "%f[%d]%d%d%d%d%d%d%d%d+%f[^%d]", "[redacted]")
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
	budget.items = budget.items + (items or 1)
	if budget.items < WORK_SLICE_ITEMS and os.clock() - budget.startedAt < WORK_SLICE_SECONDS then
		return
	end
	task.wait()
	budget.items = 0
	budget.startedAt = os.clock()
end

local function serialize(value, seen, depth)
	local valueType = typeof(value)
	if value == nil then
		return { type = "nil" }
	end
	if valueType == "boolean" then
		return value
	end
	if valueType == "string" then
		return redactString(value)
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
		return { type = "Vector3", x = value.X, y = value.Y, z = value.Z }
	end
	if valueType == "Vector2" then
		return { type = "Vector2", x = value.X, y = value.Y }
	end
	if valueType == "Color3" then
		return { type = "Color3", r = value.R, g = value.G, b = value.B }
	end
	if valueType == "CFrame" then
		return { type = "CFrame", components = { value:GetComponents() } }
	end
	if valueType == "UDim" then
		return { type = "UDim", scale = value.Scale, offset = value.Offset }
	end
	if valueType == "UDim2" then
		return {
			type = "UDim2",
			x = { scale = value.X.Scale, offset = value.X.Offset },
			y = { scale = value.Y.Scale, offset = value.Y.Offset },
		}
	end
	if valueType == "Rect" then
		return { type = "Rect", min = { x = value.Min.X, y = value.Min.Y }, max = { x = value.Max.X, y = value.Max.Y } }
	end
	if valueType == "BrickColor" then
		return { type = "BrickColor", number = value.Number, name = redactString(value.Name) }
	end
	if valueType == "NumberRange" then
		return { type = "NumberRange", min = value.Min, max = value.Max }
	end
	if valueType == "Instance" then
		return {
			type = "Instance",
			className = value.ClassName,
			name = redactString(value.Name),
			path = safePath(value),
		}
	end
	if valueType == "EnumItem" then
		return { type = "EnumItem", value = redactString(tostring(value)) }
	end
	if valueType ~= "table" then
		return { type = valueType, value = redactString(tostring(value)) }
	end

	seen = seen or {}
	depth = depth or 0
	if seen[value] then
		return { type = "cycle" }
	end
	if depth >= MAX_SERIALIZE_DEPTH then
		return { type = "truncated", reason = "depth" }
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
		output[redactString(tostring(key))] = serialize(child, seen, depth + 1)
	end
	seen[value] = nil
	if truncated then
		output.__truncated = true
	end
	return output
end

local function resolvePath(path)
	if type(path) ~= "string" or path == "" then
		return nil, "Path must be a non-empty string"
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

local function instanceSummary(instance)
	local summary = {
		name = redactString(instance.Name),
		className = instance.ClassName,
		path = safePath(instance),
	}
	if instance:IsA("BasePart") then
		summary.position = serialize(instance.Position)
		summary.size = serialize(instance.Size)
		summary.transparency = instance.Transparency
		summary.canCollide = instance.CanCollide
	elseif instance:IsA("ValueBase") then
		summary.value = serialize(safeProperty(instance, "Value"))
	end
	return summary
end

local function sortedChildren(instance, capacity, budget)
	budget = budget or newWorkBudget()
	capacity = math.max(0, capacity or 0)
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

local function inspectInstance(instance, depth, childLimit)
	local remaining = childLimit
	local budget = newWorkBudget()
	local function visit(node, level)
		local result = instanceSummary(node)
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
		executor = executorName,
		version = executorVersion,
		methods = {
			"capabilities",
			"execute_luau",
			"client_state",
			"list_children",
			"inspect_instance",
			"find_instances",
			"read_properties",
			"list_tags",
			"diagnostic_snapshot",
			"script_fingerprint",
			"script_inventory",
			"remote_inventory",
			"performance_snapshot",
			"spatial_query",
			"ui_inventory",
			"signal_inventory",
			"observe_changes",
			"attribute_inventory",
			"observe_logs",
			"snapshot_diff",
			"multi_read_properties",
			"instance_ancestry",
			"class_summary",
			"overlap_query",
			"subtree_summary",
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

	local packed
	local ok, runtimeError = xpcall(function()
		packed = table.pack(chunk())
	end, function(err)
		return debug.traceback(tostring(err), 2)
	end)
	if not ok then
		error("Luau execution failed: " .. tostring(runtimeError), 0)
	end

	local values = {}
	for index = 1, packed.n do
		values[index] = serialize(packed[index])
	end
	return { count = packed.n, values = values }
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

function handlers.find_instances(params)
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
				table.insert(results, instanceSummary(node))
			else
				resultTruncated = true
			end
		end
	end)
	sortSummaries(results)
	return {
		root = instanceSummary(root),
		visited = visited,
		totalMatches = totalMatches,
		truncated = traversalTruncated or resultTruncated,
		results = results,
	}
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
		if
			not SAFE_PROPERTIES[property]
			or string.find(string.lower(property), "source", 1, true)
			or string.find(string.lower(property), "script", 1, true)
		then
			output[property] = { ok = false, error = "Property is not readable" }
		else
			local ok, value = pcall(function()
				return instance[property]
			end)
			output[property] = ok and { ok = true, value = serialize(value) }
				or { ok = false, error = "Property unavailable" }
		end
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

function handlers.remote_inventory(params)
	params = params or {}
	return inventory(params, function(node)
		return node:IsA("RemoteEvent")
			or node:IsA("RemoteFunction")
			or node.ClassName == "UnreliableRemoteEvent"
			or node.ClassName == "UnreliableRemoteFunction"
	end)
end

function handlers.list_children(params)
	local instance, pathError = resolvePath(params and params.path)
	if not instance then
		error(pathError, 0)
	end
	local limit = math.clamp(tonumber(params.limit) or 200, 1, 1000)
	local budget = newWorkBudget()
	local children, truncated, total = sortedChildren(instance, limit, budget)
	local output = {}
	for index, child in ipairs(children) do
		output[index] = instanceSummary(child)
		checkpointWork(budget)
	end
	return {
		instance = instanceSummary(instance),
		total = total,
		truncated = truncated,
		children = output,
	}
end

function handlers.inspect_instance(params)
	local instance, pathError = resolvePath(params and params.path)
	if not instance then
		error(pathError, 0)
	end
	local depth = math.clamp(tonumber(params.depth) or 0, 0, 3)
	local childLimit = math.clamp(tonumber(params.childLimit) or 100, 1, 500)
	return inspectInstance(instance, depth, childLimit)
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

local function readablePropertyName(property)
	return type(property) == "string"
		and #property <= 64
		and string.match(property, "^[A-Za-z_][A-Za-z0-9_]*$")
		and SAFE_PROPERTIES[property]
		and not string.find(string.lower(property), "source", 1, true)
		and not string.find(string.lower(property), "script", 1, true)
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
	return {
		root = instanceSummary(root),
		visited = visited,
		truncated = truncated,
		structuralDigest = string.format("%08x", hash),
		classCounts = take(classCounts),
		tagCounts = take(tagCounts),
		attributeNameCounts = take(attributeNameCounts),
	}
end

function handlers.spatial_query(params)
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
			local item = instanceSummary(hit.Instance)
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
			local item = instanceSummary(part)
			item.distance = (part.Position - center).Magnitude
			table.insert(results, item)
		end
	else
		local center, size = strictVector(params.center, "center"), strictVector(params.size, "size")
		if size.X < 0.1 or size.Y < 0.1 or size.Z < 0.1 or size.X > 10000 or size.Y > 10000 or size.Z > 10000 then
			error("size components must be between 0.1 and 10000", 0)
		end
		for _, part in ipairs(workspace:GetPartBoundsInBox(CFrame.new(center), size, filter)) do
			local item = instanceSummary(part)
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

local function uiMetadata(node, includeText)
	local item = instanceSummary(node)
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

function handlers.ui_inventory(params)
	params = params or {}
	local roots = params.roots or "player_gui"
	if roots ~= "player_gui" and roots ~= "core_gui" and roots ~= "both" then
		error("roots must be player_gui, core_gui, or both", 0)
	end
	local includeText = params.includeText == true
	local limit, maxVisited = boundedNumber(params.limit, 100, 1, 500), boundedNumber(params.maxVisited, 3000, 1, 10000)
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
			local ok, visited, traversalTruncated = pcall(function()
				return boundedTraversal(entry.root, maxVisited, function(node)
					local isGuiOk, isGui = pcall(function()
						return node:IsA("GuiBase2d") or node:IsA("LayerCollector") or node:IsA("UIComponent")
					end)
					if isGuiOk and isGui then
						if #results < limit then
							table.insert(results, uiMetadata(node, includeText))
						else
							resultTruncated = true
						end
					end
				end)
			end)
			if not ok then
				table.insert(output, { root = entry.name, unavailable = true })
			else
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

function handlers.observe_changes(params)
	params = params or {}
	local instance, pathError = resolvePath(params.path)
	if not instance then
		error(pathError, 0)
	end
	local durationMs, maxEvents =
		boundedNumber(params.durationMs, 1000, 100, 5000), boundedNumber(params.maxEvents, 100, 1, 200)
	if type(params.properties or {}) ~= "table" or #(params.properties or {}) > 16 then
		error("properties must contain at most 16 names", 0)
	end
	local properties, seen = {}, {}
	for _, property in ipairs(params.properties or {}) do
		if not readablePropertyName(property) then
			error("Property is not observable", 0)
		end
		if not seen[property] then
			seen[property] = true
			table.insert(properties, property)
		end
	end
	table.sort(properties)
	local connections, events, truncated, started = {}, {}, false, os.clock()
	local function record(kind, field, value)
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
	end
	local function connect(signal, callback)
		local connection = signal:Connect(callback)
		table.insert(connections, connection)
	end
	local ok, err = xpcall(function()
		for _, property in ipairs(properties) do
			connect(instance:GetPropertyChangedSignal(property), function()
				record("property", property, safeProperty(instance, property))
			end)
		end
		if params.includeAttributes ~= false then
			connect(instance.AttributeChanged, function(name)
				local attrOk, value = pcall(function()
					return instance:GetAttribute(name)
				end)
				record("attribute", tostring(name), attrOk and value or nil)
			end)
		end
		if params.includeChildren ~= false then
			connect(instance.ChildAdded, function(child)
				record("child_added", child.Name, instanceSummary(child))
			end)
			connect(instance.ChildRemoved, function(child)
				record("child_removed", child.Name, instanceSummary(child))
			end)
		end
		task.wait(durationMs / 1000)
	end, function(message)
		return tostring(message)
	end)
	for _, connection in ipairs(connections) do
		pcall(function()
			connection:Disconnect()
		end)
	end
	if not ok then
		error(err, 0)
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
	local events, truncated, connection = {}, false, nil
	local started = os.clock()
	local levelByType = {
		[Enum.MessageType.MessageOutput] = "output",
		[Enum.MessageType.MessageInfo] = "info",
		[Enum.MessageType.MessageWarning] = "warning",
		[Enum.MessageType.MessageError] = "error",
	}
	local ok, err = xpcall(function()
		connection = logService.MessageOut:Connect(function(message, messageType)
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
		task.wait(durationMs / 1000)
	end, function(message)
		return tostring(message)
	end)
	if connection then
		pcall(function()
			connection:Disconnect()
		end)
	end
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
			local ok, value = pcall(function()
				return instance[property]
			end)
			values[property] = ok and { ok = true, value = serialize(value) }
				or { ok = false, error = "Property unavailable" }
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
	return send(socket, {
		type = "response",
		id = id,
		ok = false,
		error = { message = safeErrorMessage(errorMessage) },
	})
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
				state.active = false
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
		then
			state.handshake = nil
			state.acknowledged = true
			state.connected = true
			state.reconnectAttempt = 0
			cancelConnectionTimeout()
			state.startupStatus = "active"
			state.startupReason = nil
		end
		return
	end

	if not state.acknowledged or message.type ~= "request" or type(message.id) ~= "string" then
		return
	end
	if #message.id > MAX_REQUEST_ID_BYTES then
		return
	end
	if state.activeRequestIds[message.id] then
		sendResponseError(socket, message.id, "Duplicate request id")
		return
	end
	if state.inFlightRequests >= MAX_IN_FLIGHT_REQUESTS then
		sendResponseError(socket, message.id, "Request capacity exceeded")
		return
	end

	state.activeRequestIds[message.id] = true
	state.inFlightRequests = state.inFlightRequests + 1

	task.spawn(function()
		local released = false
		local function release()
			if released then
				return
			end
			released = true
			state.activeRequestIds[message.id] = nil
			state.inFlightRequests = math.max(0, state.inFlightRequests - 1)
		end

		local handler = handlers[message.method]
		if not handler then
			sendResponseError(socket, message.id, "Unknown method")
			release()
			return
		end

		local ok, result = xpcall(function()
			return handler(message.params or {})
		end, function(err)
			return safeErrorMessage(err)
		end)
		if ok then
			if not send(socket, { type = "response", id = message.id, ok = true, result = result }) then
				sendResponseError(socket, message.id, "Response unavailable")
			end
		else
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
		state.active = false
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
	socket.OnMessage:Connect(function(message)
		if isCurrent() and state.socket == socket then
			handleMessage(socket, message)
		end
	end)
	socket.OnClose:Connect(function()
		local wasAcknowledged = state.acknowledged
		if isCurrent() and state.socket == socket then
			state.socket = nil
			state.connected = false
			state.acknowledged = false
			state.handshake = nil
			state.handshakeGeneration = state.handshakeGeneration + 1
			state.startupStatus = "connection_unavailable"
			state.startupReason = "connection closed"
			if wasAcknowledged then
				startConnectionTimeout()
			end
			scheduleReconnect()
		end
	end)

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
		state.active = false
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

local BOOTSTRAP_PATH = ".potassium-mcp-bootstrap.lua"
local MAX_LOAD_ATTEMPTS = 10
local RETRY_DELAY_SECONDS = 1

local RETRYABLE_REASONS = {
	["bootstrap file is unavailable"] = true,
	["connection unavailable"] = true,
	["connection failed"] = true,
}
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

local function warnUnavailable(reason)
	warn("[Potassium MCP] Autoexec unavailable: " .. reason)
end

local function startupState()
	local current = sharedEnvironment.PotassiumMcp
	if type(current) ~= "table" then
		return nil, nil
	end
	local reason = type(current.startupReason) == "string" and current.startupReason or nil
	local status = type(current.startupStatus) == "string" and current.startupStatus or nil
	return status, reason
end

local function failure(reason, retryable)
	reason = type(reason) == "string" and reason or "bootstrap startup failed"
	return false, reason, retryable == true or RETRYABLE_REASONS[reason] == true
end

if type(readfile) ~= "function" then
	warnUnavailable("readfile is unavailable")
	return
end
if type(loadstring) ~= "function" then
	warnUnavailable("loadstring is unavailable")
	return
end

local current = sharedEnvironment.PotassiumMcp
if type(current) == "table" and current.active == true then
	return
end

local function loadBootstrap()
	local readOk, source = pcall(readfile, BOOTSTRAP_PATH)
	if not readOk or type(source) ~= "string" or source == "" then
		return failure("bootstrap file is unavailable", true)
	end

	local chunk = loadstring(source, "@" .. BOOTSTRAP_PATH)
	if type(chunk) ~= "function" then
		return failure("bootstrap compilation failed")
	end

	local runOk = pcall(chunk)
	local status, reason = startupState()
	if not runOk then
		return failure(reason or "bootstrap execution failed", status == "connection_unavailable")
	end
	local started = sharedEnvironment.PotassiumMcp
	if type(started) == "table" and started.active == true then
		return true
	end
	return failure(reason or "bootstrap startup failed", status == "connection_unavailable")
end

local reason = "bootstrap file is unavailable"
for attempt = 1, MAX_LOAD_ATTEMPTS do
	local loaded, failureReason, retryable = loadBootstrap()
	if loaded then
		return
	end
	reason = failureReason
	if not retryable or attempt == MAX_LOAD_ATTEMPTS then
		break
	end
	task.wait(RETRY_DELAY_SECONDS)
end

warnUnavailable(reason)

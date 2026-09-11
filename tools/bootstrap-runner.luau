local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local mode = process.args[1] or "full"
local bootstrap = fs.readFile("potassium-mcp/assets/potassium_mcp_bootstrap.lua")
local autoexec = fs.readFile("potassium-mcp/assets/potassium_mcp_autoexec.lua")
local fixture = luau.load(fs.readFile("potassium-mcp/test/bootstrap-audit.smoke.luau"))()
local function compile(source, name, environment)
	return luau.load(source, { debugName = name, environment = environment, injectGlobals = false })
end
local function run(selected)
	return fixture(bootstrap, autoexec, compile, {
		mode = selected,
		cycles = tonumber(process.args[2]) or 100,
		jobs = tonumber(process.args[3]) or 256,
		jsonEncode = function(value) return serde.encode("json", value) end,
		jsonDecode = function(value) return serde.decode("json", value) end,
		scenario = mode == "scenario" and luau.load(fs.readFile(process.args[5]))() or nil,
	})
end
local report = { mode = mode, toolchain = "lune 0.10.4", codec = "@lune/serde JSON", total = 0, measured = 0, failed = 0, skipped = 0, results = {} }
local function collect(selected)
	local result = run(selected)
	table.insert(report.results, result)
	if selected == "scenario" and result.kind == "measurements" then
		assert(result.cases == nil and type(result.measurements) == "table" and #result.measurements > 0, "measurement scenario requires nonempty measurements and no assertion cases")
		for _, measurement in ipairs(result.measurements) do
			assert(type(measurement.id) == "string" and measurement.id ~= "" and type(measurement.samples) == "table" and #measurement.samples > 0 and measurement.ok == nil, "invalid measurement row")
			report.measured += 1
		end
	elseif result.cases then
		assert(selected ~= "scenario" or result.kind == "assertions", "assertion scenario requires kind=assertions")
		assert(#result.cases > 0, "fixture must report actual cases")
		for _, case in ipairs(result.cases) do
			assert(type(case.ok) == "boolean", "assertion case requires explicit boolean ok")
			report.total += 1
			if not case.ok then report.failed += 1 end
		end
	elseif selected == "queue" then
		assert(result.completed == result.jobs and result.jobs >= 3, "queue workload incomplete")
		report.total += 1
	else
		error("fixture mode lacks case results: " .. selected)
	end
	if result.skips then report.skipped += #result.skips end
end
if mode == "full" then
	collect("regression")
	collect("lifecycle")
elseif mode == "benchmark" then
	local repeats = tonumber(process.args[4]) or 5
	assert(repeats >= 3 and repeats <= 20 and repeats % 1 == 0, "benchmark repeats must be 3..20")
	run("queue") -- Explicit warmup; not counted as an acceptance case.
	for _ = 1, repeats do collect("queue") end
elseif mode == "queue" or mode == "lifecycle" or mode == "scenario" then
	collect(mode)
else
	error("unknown runner mode: " .. mode)
end
report.ok = report.failed == 0 and (report.total > 0 or report.measured > 0)
print("BOOTSTRAP_RESULT=" .. serde.encode("json", report))
if not report.ok then process.exit(1) end

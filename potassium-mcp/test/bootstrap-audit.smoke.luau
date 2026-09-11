-- compile(source, chunkName, environment) must return an isolated Luau chunk.
-- No executor APIs, sockets, engine services, or timers escape this fixture.
return function(bootstrapSource, autoexecSource, compile, options)
	options = options or {}
	local function fixture()
		local now, sequence, guid = 0, 0, 0
		local randomSequence, activeConnections, peakConnections, createdConnections, disconnectedConnections = 0, 0, 0, 0, 0
		local scheduled, wire, sockets, warnings = {}, {}, {}, {}
		local global, shared = {}, {}
		local hashInputs, hashSequence = {}, 0
		local environment, heartbeat
		local connectionMarker, instanceMarker = {}, {}
		local function signal()
			local listeners = {}
			local event = {}
			function event:Connect(callback)
				assert(not event.failConnect, "fixture subscription failure")
				local connection = { Connected = true, marker = connectionMarker }
				activeConnections += 1
				createdConnections += 1
				peakConnections = math.max(peakConnections, activeConnections)
				function connection:Disconnect()
					if not self.Connected then return end
					activeConnections -= 1
					disconnectedConnections += 1
					self.Connected = false
				end
				table.insert(listeners, { connection = connection, callback = callback })
				return connection
			end
			function event:Fire(...)
				for _, listener in ipairs(listeners) do
					if listener.connection.Connected then
						listener.callback(...)
					end
				end
			end
			function event:Queued(...)
				local callbacks, arguments = {}, table.pack(...)
				for _, listener in ipairs(listeners) do
					if listener.connection.Connected then table.insert(callbacks, listener.callback) end
				end
				return function()
					for _, callback in ipairs(callbacks) do callback(table.unpack(arguments, 1, arguments.n)) end
				end
			end
			function event:Count()
				local count = 0
				for _, listener in ipairs(listeners) do
					if listener.connection.Connected then count += 1 end
				end
				return count
			end
			return event
		end
		local function enqueue(thread, delay, arguments)
			sequence += 1
			table.insert(scheduled, { thread = thread, due = now + delay, order = sequence, arguments = arguments })
		end
		local function resume(thread, arguments)
			local result = table.pack(coroutine.resume(thread, table.unpack(arguments, 1, arguments.n)))
			assert(result[1], tostring(result[2]))
			if coroutine.status(thread) ~= "dead" then
				local delay = result[2] or 1 / 60
				enqueue(thread, delay, table.pack(delay))
			end
		end
		local scheduler = {}
		function scheduler.step()
			assert(#scheduled > 0, "isolated scheduler ran out of work")
			table.sort(scheduled, function(a, b)
				return a.due == b.due and a.order < b.order or a.due < b.due
			end)
			local entry = table.remove(scheduled, 1)
			now = entry.due
			resume(entry.thread, entry.arguments)
		end
		function scheduler.untilTrue(predicate, maximum)
			for _ = 1, maximum or 1000 do
				if predicate() then return end
				scheduler.step()
			end
			assert(predicate(), "isolated scheduler step bound exceeded")
		end
		function scheduler.pending() return #scheduled end
		function scheduler.advance(seconds)
			local done = false
			enqueue(coroutine.create(function()
				local remaining = seconds
				while remaining > 0 do
					heartbeat()
					local interval = math.min(remaining, 5)
					coroutine.yield(interval)
					remaining -= interval
				end
				heartbeat()
				done = true
			end), 0, table.pack())
			scheduler.untilTrue(function() return done end, 100000)
		end
		local fakeTask = {}
		function fakeTask.spawn(callback, ...)
			local thread = coroutine.create(callback)
			resume(thread, table.pack(...))
			return thread
		end
		function fakeTask.defer(callback, ...)
			local thread = coroutine.create(callback)
			enqueue(thread, 0, table.pack(...))
			return thread
		end
		function fakeTask.delay(delay, callback, ...)
			local thread = coroutine.create(callback)
			enqueue(thread, delay, table.pack(...))
			return thread
		end
		function fakeTask.cancel(thread)
			for index = #scheduled, 1, -1 do
				if scheduled[index].thread == thread then table.remove(scheduled, index) end
			end
		end
		function fakeTask.wait(delay)
			return coroutine.yield(delay or 1 / 60)
		end
		local function instance(name, className, parent)
			local node = {
				Name = name, ClassName = className, marker = instanceMarker,
				children = {}, attributes = {}, tags = {}, propertySignals = {},
				AttributeChanged = signal(), ChildAdded = signal(), ChildRemoved = signal(), Destroying = signal(),
			}
			if className == "RemoteEvent" or className == "UnreliableRemoteEvent" then node.OnClientEvent = signal() end
			function node:GetFullName()
				return self.Parent and self.Parent:GetFullName() .. "." .. self.Name or self.Name
			end
			function node:GetChildren() return table.clone(self.children) end
			function node:GetAttributes() return table.clone(self.attributes) end
			function node:GetAttribute(key) return self.attributes[key] end
			function node:GetPropertyChangedSignal(property)
				if not self.propertySignals[property] then self.propertySignals[property] = signal() end
				return self.propertySignals[property]
			end
			function node:SetProperty(property, value)
				self[property] = value
				self:GetPropertyChangedSignal(property):Fire()
			end
			function node:SetAttribute(key, value)
				self.attributes[key] = value
				self.AttributeChanged:Fire(key)
			end
			function node:Destroy()
				if self.destroyed then return end
				self.destroyed = true
				self.Destroying:Fire()
				for _, child in ipairs(self:GetChildren()) do child:Destroy() end
				self.Parent = nil
			end
			function node:ListenerCount()
				local count = self.AttributeChanged:Count() + self.ChildAdded:Count() + self.ChildRemoved:Count() + self.Destroying:Count()
				if self.OnClientEvent then count += self.OnClientEvent:Count() end
				for _, propertySignal in pairs(self.propertySignals) do count += propertySignal:Count() end
				return count
			end
			function node:FindFirstChild(childName)
				for _, child in ipairs(self.children) do
					if child.Name == childName then return child end
				end
				return nil
			end
			function node:FindFirstChildWhichIsA(expected)
				for _, child in ipairs(self.children) do if child:IsA(expected) then return child end end
				return nil
			end
			function node:FindFirstChildOfClass(expected)
				for _, child in ipairs(self.children) do if child:IsA(expected) then return child end end
				return nil
			end
			function node:IsA(expected)
				if expected == self.ClassName or expected == "Instance" then return true end
				if expected == "BasePart" then
					return self.ClassName == "Part" or self.ClassName == "MeshPart" or self.ClassName == "Terrain"
				elseif expected == "LuaSourceContainer" then
					return self.ClassName == "Script" or self.ClassName == "LocalScript" or self.ClassName == "ModuleScript"
				elseif expected == "GuiBase2d" then
					return self.ClassName == "Frame" or self.ClassName == "TextLabel" or self.ClassName == "TextBox"
				elseif expected == "LayerCollector" then return self.ClassName == "ScreenGui" end
				return expected == "ValueBase" and (
					self.ClassName == "BoolValue" or self.ClassName == "IntValue" or self.ClassName == "NumberValue"
					or self.ClassName == "StringValue" or self.ClassName == "ObjectValue"
					or self.ClassName == "Vector3Value" or self.ClassName == "CFrameValue"
				)
			end
			function node:IsDescendantOf(ancestor)
				local current = self.Parent
				while current do
					if current == ancestor then return true end
					current = current.Parent
				end
				return false
			end
			local currentParent
			setmetatable(node, {
				__index = function(_, key)
					if key == "Parent" then return currentParent end
				end,
				__newindex = function(self, key, value)
					if key ~= "Parent" then rawset(self, key, value); return end
					if currentParent == value then return end
					local previous = currentParent
					if previous then
						for index, child in ipairs(previous.children) do
							if child == self then table.remove(previous.children, index); break end
						end
					end
					currentParent = value
					if previous then previous.ChildRemoved:Fire(self) end
					if value then
						table.insert(value.children, self)
						value.ChildAdded:Fire(self)
					end
				end,
			})
			node.Parent = parent
			return node
		end
		local game = instance("game", "DataModel")
		game.PlaceId, game.JobId = 1, ""
		function game:IsLoaded() return true end
		local workspace = instance("Workspace", "Workspace", game)
		workspace.StreamingEnabled = false
		local http = {}
		function http:JSONEncode(value)
			if options.jsonEncode then return options.jsonEncode(value) end
			local key = "wire:" .. tostring(#wire + 1)
			table.insert(wire, value)
			return key
		end
		function http:JSONDecode(key)
			if options.jsonDecode then return options.jsonDecode(key) end
			local index = tonumber(string.match(key, "^wire:(%d+)$"))
			assert(index and wire[index], "invalid fixture frame")
			return wire[index]
		end
		function http:GenerateGUID()
			guid += 1
			return string.format("%032x", guid)
		end
		local logService = { MessageOut = signal() }
		local services = {
			HttpService = http,
			Players = {},
			LogService = logService,
			CollectionService = { GetTags = function(_, node) return table.clone(node.tags) end },
		}
		function game:GetService(name) return assert(services[name], "unexpected fixture service " .. name) end
		local function connect()
			local socket = { OnMessage = signal(), OnClose = signal(), sent = {}, closed = false }
			function socket:Send(frame)
				assert(not self.closed, "socket closed")
				local message = http:JSONDecode(frame)
				if self.beforeSend then self.beforeSend(message) end
				table.insert(self.sent, message)
			end
			function socket:Close()
				if self.closed then return end
				self.closed = true
				self.OnClose:Fire()
			end
			table.insert(sockets, socket)
			return socket
		end
		environment = {
			_G = global, game = game, workspace = workspace, task = fakeTask,
			assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs,
			pcall = pcall, xpcall = xpcall, select = select, tonumber = tonumber,
			rawget = rawget, rawset = rawset,
			tostring = tostring, type = type, typeof = function(value)
				if type(value) == "table" and rawget(value, "marker") == connectionMarker then return "RBXScriptConnection" end
				if type(value) == "table" and rawget(value, "marker") == instanceMarker then return "Instance" end
				return typeof(value)
			end, setmetatable = setmetatable,
			getmetatable = getmetatable, getfenv = getfenv, setfenv = setfenv,
			math = math, string = string, table = table, bit32 = bit32, debug = debug, utf8 = utf8,
			os = { clock = function() return now end, time = function() return 1000000 + math.floor(now) end },
			Enum = { MessageType = { MessageOutput = "output", MessageInfo = "info", MessageWarning = "warning", MessageError = "error" } },
			getgenv = function() return shared end,
			readfile = function(path)
				assert(path == ".potassium-mcp-token", "unexpected fixture file")
				return string.rep("t", 32)
			end,
			WebSocket = { connect = connect },
			crypt = {
				random = function(count)
					randomSequence += 1
					return string.sub(string.rep(string.format("%08x", randomSequence), math.ceil(count / 8)), 1, count)
				end,
				-- Deterministic input identity, not a cryptographic implementation:
				-- equivalent selectors share a digest; distinct selectors do not.
				hash = function(value)
					assert(type(value) == "string")
					if not hashInputs[value] then
						hashSequence += 1
						hashInputs[value] = string.format("%064x", hashSequence)
					end
					return hashInputs[value]
				end,
				hmac = function() return string.rep("h", 43) .. "=" end,
			},
			print = function() end,
			warn = function(message) table.insert(warnings, message) end,
		}
		environment.loadstring = function(source, name)
			return compile(source, name, environment)
		end
		local api = { environment = environment, global = global, shared = shared, sockets = sockets, scheduler = scheduler, warnings = warnings, workspace = workspace, instance = instance, logService = logService }
		api.services = services
		function api.modelWeakWrapperCollection()
			-- Table-backed parents retain fixture nodes, unlike engine-owned Instances.
			-- Model only the weak-value lookup boundary, not native wrapper GC:
			-- after collection, weak Instance lookups disappear; strong tables and
			-- the fixture's engine tree remain untouched. No snapshot internals are read.
			local collected = false
			environment.setmetatable = function(values, metatable)
				if not metatable or metatable.__mode ~= "v" then return setmetatable(values, metatable) end
				local backing = setmetatable(values, metatable)
				return setmetatable({}, {
					__index = function(_, key)
						local value = backing[key]
						if collected and type(value) == "table" and rawget(value, "marker") == instanceMarker then return nil end
						return value
					end,
					__newindex = function(_, key, value) backing[key] = value end,
				})
			end
			return function() collected = true end
		end
		function api.typedFacilities()
			local function vector(x, y, z)
				return setmetatable({ fixtureType = "Vector3", X = x, Y = y, Z = z, Magnitude = math.sqrt(x * x + y * y + z * z) }, {
					__sub = function(a, b) return vector(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end,
				})
			end
			environment.Vector3 = { new = vector }
			environment.CFrame = { new = function(...)
				local components = table.pack(...)
				return { fixtureType = "CFrame", GetComponents = function() return table.unpack(components, 1, components.n) end }
			end }
			local originalTypeof = environment.typeof
			environment.typeof = function(value)
				if type(value) == "table" and rawget(value, "fixtureType") then return value.fixtureType end
				return originalTypeof(value)
			end
			environment.OverlapParams = { new = function() return {} end }
			environment.RaycastParams = { new = function() return {} end }
			environment.Enum.RaycastFilterType = { Exclude = "Exclude", Include = "Include" }
			return vector
		end
		function api.geometryPart(name, parent, components, size, className)
			components = components or { 10, 20, 30, 0, 0, 1, 0, 1, 0, -1, 0, 0 }
			size = size or { 4, 6, 8 }
			local part = instance(name, className or "Part", parent or workspace)
			part.Position = environment.Vector3.new(components[1], components[2], components[3])
			part.CFrame = environment.CFrame.new(table.unpack(components))
			part.Size = environment.Vector3.new(table.unpack(size))
			part.Anchored, part.CanCollide, part.Transparency = true, false, 0
			return part
		end
		function api.connectionCounters()
			return { active = activeConnections, peak = peakConnections, created = createdConnections, disconnected = disconnectedConnections }
		end
		-- A Lua slot/closure simulation, not Roblox __namecall dispatch or a native
		-- closure ABI. Tests below cannot establish native yield/namecall semantics.
		function api.namecallFacilities(original)
			local methods = setmetatable({}, { __mode = "k" })
			local adapter = { metatable = { __namecall = original }, readonly = true, installs = 0 }
			environment.getrawmetatable = function() return adapter.metatable end
			environment.isreadonly = function() return adapter.readonly end
			environment.setreadonly = function(_, value)
				if adapter.failReadonly then error("fixture readonly failure", 0) end
				if value and adapter.failRestoreOnce then
					adapter.failRestoreOnce = false
					error("fixture one-shot readonly restore failure", 0)
				end
				adapter.readonly = value
			end
			environment.newcclosure = function(callback)
				if adapter.failClosure then error("fixture native closure failure", 0) end
				adapter.installs += 1
				return callback
			end
			environment.getnamecallmethod = function() return methods[coroutine.running()] end
			function adapter.call(method, target, ...)
				methods[coroutine.running()] = method
				return adapter.metatable.__namecall(target, ...)
			end
			return adapter
		end
		function api.run(source, name)
			fakeTask.spawn(compile(source, name, environment))
		end
		function api.boot()
			local previousSocketCount = #sockets
			api.run(bootstrapSource, "bootstrap-audit-source")
			scheduler.untilTrue(function() return #sockets > previousSocketCount and #sockets[#sockets].sent > 0 end)
			return sockets[#sockets]
		end
		function api.receive(socket, message)
			socket.OnMessage:Fire(http:JSONEncode(message))
		end
		function api.authenticate(socket)
			local hello = socket.sent[1]
			local nonce = string.rep("b", 64)
			api.receive(socket, { type = "challenge", protocol = 2, clientNonce = hello.clientNonce, serverNonce = nonce, proof = string.rep("h", 43) .. "=" })
			api.receive(socket, { type = "ready", protocol = 2, clientNonce = hello.clientNonce, serverNonce = nonce, clientId = hello.clientId, generation = hello.generation })
			assert(global.PotassiumMcp.acknowledged, "fixture handshake did not complete")
		end
		heartbeat = function()
			local socket = sockets[#sockets]
			if socket and not socket.closed and global.PotassiumMcp.acknowledged then
				api.receive(socket, { type = "ping", nonce = "fixture-heartbeat" })
			end
		end
		local requestId = 0
		function api.begin(socket, method, params)
			requestId += 1
			local id = "request-" .. requestId
			api.receive(socket, { type = "request", id = id, method = method, params = params })
			return function()
				for _, response in ipairs(socket.sent) do
					if response.type == "response" and response.id == id then return response end
				end
				return nil
			end, id
		end
		function api.request(socket, method, params)
			local response = api.begin(socket, method, params)
			scheduler.untilTrue(response)
			local received = response()
			assert(received.ok, received.error and received.error.message or "fixture request failed")
			return received.result
		end
		function api.reject(socket, method, params)
			local response = api.begin(socket, method, params)
			scheduler.untilTrue(response)
			assert(not response().ok, method .. " unexpectedly succeeded")
		end
		function api.responseCount(socket, id)
			local count = 0
			for _, message in ipairs(socket.sent) do
				if message.type == "response" and message.id == id then count += 1 end
			end
			return count
		end
		function api.reconnect(socket)
			local count = #sockets
			socket:Close()
			scheduler.untilTrue(function() return #sockets == count + 1 and #sockets[#sockets].sent > 0 end)
			local replacement = sockets[#sockets]
			api.authenticate(replacement)
			assert(socket.OnMessage:Count() == 0 and socket.OnClose:Count() == 0, "closed transport must disconnect its owned listeners")
			return replacement
		end
		function api.teardown()
			local current = global.PotassiumMcp
			if current then current.teardown() end
			scheduler.advance(11)
			assert(activeConnections == 0, "fixture teardown must return every listener to baseline")
			assert(createdConnections == disconnectedConnections, "every fixture connection must disconnect exactly once")
			assert(scheduler.pending() == 0, "fixture teardown must drain bounded waits and timers")
		end
		function api.finished(socket, jobId)
			local result
			scheduler.untilTrue(function()
				result = api.request(socket, "async_job_result", { jobId = jobId })
				return result.ready
			end)
			return result
		end
		return api
	end
	if options.scenario then return options.scenario(fixture) end

	local cases = {}
	local function check(name, callback)
		local ok, detail = pcall(callback)
		table.insert(cases, { name = name, ok = ok, detail = not ok and tostring(detail) or nil })
	end
	local engineSkips = {
		"Engine Destroying/deferred signal ordering and Connected semantics require an approved live client",
		"Roblox class inheritance and HttpService serialization are not proved by fixture objects/JSON codecs",
		"Snapshot wrapper collection is a modeled weak-value lookup boundary, not native Roblox userdata GC",
		"Executor WebSocket close callbacks and secure crypto availability require an approved live client",
		"Fixture hash input identities distinguish cursor selectors but do not prove native SHA-256 security",
		"Simulated raw namecall slots/newcclosure do not prove native ABI, engine namecall context, native yield boundaries, or physical ownership restoration",
	}
	local function report(mode, metrics)
		local passed = 0
		for _, case in ipairs(cases) do if case.ok then passed += 1 end end
		return { mode = mode, passed = passed, total = #cases, cases = cases, skips = engineSkips, metrics = metrics }
	end
	local function byName(rows)
		local result = {}
		for _, row in ipairs(rows) do result[row.name] = row end
		return result
	end
	local function entryValue(node, key)
		for _, entry in ipairs(node.entries or {}) do
			if entry.key.value == key then return entry.value end
		end
		return nil
	end
	local function assertPrivateTree(root, forbiddenValues, forbiddenStrings)
		local seen = {}
		local function visit(value)
			for _, forbidden in ipairs(forbiddenValues or {}) do
				assert(not rawequal(value, forbidden), "retention must not keep caller-owned values")
			end
			if type(value) == "string" then
				for _, forbidden in ipairs(forbiddenStrings or {}) do
					assert(not string.find(value, forbidden, 1, true), "private source bytes survived sanitization")
				end
			elseif type(value) == "table" and not seen[value] then
				seen[value] = true
				for key, child in next, value do visit(key); visit(child) end
			end
		end
		visit(root)
	end
	if options.mode == "queue" then
		local count = options.jobs or 256
		assert(count >= 3 and count <= 512 and count % 1 == 0, "jobs must be an integer from 3 to 512")
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local submitted, peakQueueSlots = {}, 0
		local function submit()
			local id = f.request(socket, "execute_luau_async", { code = "task.wait(); return 7" }).jobId
			table.insert(submitted, id)
		end
		local started = os.clock()
		submit()
		submit()
		for index = 1, count do
			f.scheduler.untilTrue(function()
				local job = f.global.PotassiumMcp.asyncJobs[submitted[index]]
				return job and job.state == "succeeded"
			end, 20)
			local result = f.request(socket, "async_job_result", { jobId = submitted[index] })
			assert(result.ready and result.result.values[1] == 7, "FIFO result was lost")
			if #submitted < count then submit() end
			peakQueueSlots = math.max(peakQueueSlots, #f.global.PotassiumMcp.asyncQueue)
		end
		f.teardown()
		return { mode = "queue", jobs = count, completed = #submitted, peakQueueSlots = peakQueueSlots, cpuSeconds = os.clock() - started, skips = engineSkips, cleanup = f.connectionCounters() }
	end

	if options.mode == "lifecycle" then
		assert(options.jsonEncode and options.jsonDecode, "lifecycle mode requires real JSON codecs")
		local cycles = options.cycles or 100
		assert(cycles >= 100 and cycles <= 200 and cycles % 1 == 0, "cycles must be an integer from 100 to 200")
		local metrics = { cycles = 0, peakReferences = 0, peakTombstones = 0, peakWatches = 0, peakJobs = 0, peakRetainedJobs = 0, peakRetainedWatches = 0, peakQueueSlots = 0, reconnects = 0, droppedEvents = 0 }
		check("persistent combined lifecycle remains bounded through deterministic capacity churn", function()
			local f = fixture()
			local socket = f.boot()
			f.authenticate(socket)
			local generation = f.global.PotassiumMcp.generation
			local nodes, references = {}, {}
			for index = 1, 1024 do nodes[index] = f.instance(string.format("Entry%04d", index), "Folder", f.workspace) end
			local function resources()
				return f.request(socket, "capabilities", {}).resources
			end
			local function sample()
				local r = resources()
				assert(r.references.total == r.references.live + r.references.tombstones and r.references.total <= 1024, "live references and tombstones must share one bounded registry")
				assert(r.jobs.active == r.jobs.queued + r.jobs.running and r.jobs.active <= 8 and r.jobs.retained <= 32, "active and terminal job budgets must remain independent")
				assert(r.watches.active <= 16 and r.watches.retained <= 16, "active and retained watches must each stay bounded")
				assert(r.queue.pending <= 8 and r.queue.retainedSlots <= 71, "FIFO consumed slots must compact under sustained churn")
				assert(r.connections.socket == 2 and r.connections.reference == r.references.live, "diagnostics must count current listeners rather than historical registrations")
				metrics.peakReferences = math.max(metrics.peakReferences, r.references.total)
				metrics.peakTombstones = math.max(metrics.peakTombstones, r.references.tombstones)
				metrics.peakWatches = math.max(metrics.peakWatches, r.watches.active)
				metrics.peakJobs = math.max(metrics.peakJobs, r.jobs.active)
				metrics.peakRetainedJobs = math.max(metrics.peakRetainedJobs, r.jobs.retained)
				metrics.peakRetainedWatches = math.max(metrics.peakRetainedWatches, r.watches.retained)
				metrics.peakQueueSlots = math.max(metrics.peakQueueSlots, r.queue.retainedSlots)
				return r
			end
			for cycle = 1, cycles do
				-- A single generation is deliberately retained across every cycle.
				for first = 1, 1024, 20 do
					local requests = {}
					for index = first, math.min(first + 19, 1024) do
						table.insert(requests, { path = "workspace." .. nodes[index].Name, properties = { "Name" } })
					end
					local batch = f.request(socket, "batch_read", { requests = requests, includeReferences = true })
					for offset, row in ipairs(batch.results) do
						assert(row.ok and row.instance.reference, "capacity acquisition must return every requested handle")
						references[first + offset - 1] = row.instance.reference
					end
				end
				local watches, jobs = {}, {}
				for index = 1, 16 do
					watches[index] = f.request(socket, "watch_start", { path = references[index], includeChildren = false, maxEvents = 3, ttlSeconds = 10 }).watchId
				end
				f.global.lifecycleEvents = 0
				jobs[1] = f.request(socket, "execute_luau_async", { code = [[
					local job = ...
					job.trackConnection(workspace:FindFirstChild("Entry0001").AttributeChanged:Connect(function() _G.lifecycleEvents += 1 end))
					_G.lifecycleEntered = true
					task.wait(2)
					job.checkpoint()
					return 1
				]] }).jobId
				f.scheduler.untilTrue(function() return f.global.lifecycleEntered end)
				for index = 2, 8 do
					jobs[index] = f.request(socket, "execute_luau_async", { code = index == 2 and "_G.cancelledQueueRan = true" or "return 7" }).jobId
				end
				local full = sample()
				assert(full.references.total == 1024 and full.watches.active == 16 and full.jobs.active == 8, "combined stress must reach all three capacities simultaneously")
				f.reject(socket, "watch_start", { path = references[1] })
				f.reject(socket, "execute_luau_async", { code = "_G.rejectedJobRan = true" })
				local overflow = f.instance("Overflow", "Folder", f.workspace)
				f.reject(socket, "inspect_instance", { path = "workspace.Overflow", includeReferences = true })
				overflow:Destroy()
				for index = 17, 32 do nodes[index]:Destroy() end
				assert(sample().references.tombstones == 16, "destroyed handles must consume the full registry's capacity")
				for event = 1, 5 do
					for index = 1, 16 do nodes[index]:SetAttribute("Cycle", event) end
				end
				f.request(socket, "instance_references_release", { references = { references[1] } })
				nodes[1]:SetAttribute("Owned", false)
				assert(f.global.lifecycleEvents == 6, "reference release must preserve independently owned job and watch listeners")
				assert(f.request(socket, "watch_poll", { watchId = watches[1] }).events[3].value == false, "reference release must not detach an existing watch")
				local ordinary = f.begin(socket, "batch_read", { requests = { { path = "workspace", children = { limit = 1 } } } })
				assert(ordinary() == nil, "wide normal batch must yield while reference and control requests overlap")
				local byReference = f.begin(socket, "batch_read", { includeReferences = true, requests = { { path = references[2], properties = { "Name" } } } })
				f.scheduler.untilTrue(function() return ordinary() and byReference() end)
				assert(ordinary().ok and ordinary().result.results[1].instance.reference == nil and byReference().result.results[1].instance.reference == references[2], "normal and reference batches must keep opt-in request-local under load")
				local cancelQueued = f.request(socket, "async_job_cancel", { jobId = jobs[2] })
				local cancelRunning = f.request(socket, "async_job_cancel", { jobId = jobs[1] })
				assert(cancelQueued.state == "cancelled" and cancelRunning.state == "running", "queued and running cancellation must retain distinct outcomes")
				assert(not f.request(socket, "async_job_result", { jobId = jobs[1] }).ready, "running cancellation must not release ownership early")
				socket = f.reconnect(socket)
				metrics.reconnects += 1
				assert(f.global.PotassiumMcp.generation == generation, "transport recovery must not replace the lifecycle generation")
				assert(f.request(socket, "inspect_instance", { path = references[2] }).name == nodes[2].Name, "existing live handles must survive every reconnect")
				for index = 1, 8 do
					local result = f.finished(socket, jobs[index])
					assert(result.state == (index <= 2 and "cancelled" or "succeeded"), "queue cancellation must preserve following FIFO outcomes")
				end
				assert(not f.global.cancelledQueueRan and not f.global.rejectedJobRan, "cancelled or rejected code must never run")
				for index = 1, 16 do
					local page = f.request(socket, "watch_poll", { watchId = watches[index] })
					metrics.droppedEvents += page.dropped
					assert(page.dropped == (index == 1 and 3 or 2) and #page.events == 3, "overflow drops must exactly account for evicted events")
					if index <= 4 then f.request(socket, "watch_stop", { watchId = watches[index] })
					elseif index <= 8 then nodes[index]:Destroy() end
				end
				f.scheduler.advance(11)
				local settled = sample()
				assert(settled.jobs.active == 0 and settled.watches.active == 0 and settled.connections.job == 0 and settled.connections.watch == 0, "natural completion, cancellation, stop, destroy and expiry must release owned connections")
				for first = 1, 1024, 128 do
					local release = {}
					for index = first, first + 127 do table.insert(release, references[index]) end
					f.request(socket, "instance_references_release", { references = release })
				end
				local clean = sample()
				assert(clean.references.total == 0 and f.connectionCounters().active == 2, "each cycle must return all non-transport listeners to baseline")
				for index, node in ipairs(nodes) do
					if node.destroyed then nodes[index] = f.instance(node.Name, "Folder", f.workspace) end
				end
				f.global.lifecycleEntered = nil
				metrics.cycles += 1
			end
			-- Job TTL is logically expired until a job operation prunes storage.
			f.scheduler.advance(301)
			local lazy = resources()
			assert(lazy.jobs.retained > 0 and lazy.jobs.expiredRetained == lazy.jobs.retained and lazy.connections.job == 0, "lazy expiry may retain bounded values, never terminal listeners")
			f.request(socket, "async_job_list", {})
			local pruned = resources()
			assert(pruned.jobs.retained == 0 and pruned.watches.retained == 0, "operation/sweep retention must release all expired metadata")
			metrics.cleanup = pruned
			f.teardown()
			metrics.connections = f.connectionCounters()
			metrics.pendingTimers = f.scheduler.pending()
		end)
		return report("lifecycle", metrics)
	end

	check("retained queries narrow immutable rows and rebuild groups without rescans or identity changes", function()
		local f = fixture()
		local alpha = f.instance("Alpha", "Folder", f.workspace)
		local beta = f.instance("Beta", "Folder", f.workspace)
		local first = f.instance("SendOne", "RemoteEvent", alpha)
		f.instance("SendTwo", "RemoteEvent", alpha)
		f.instance("SendThree", "RemoteFunction", alpha)
		f.instance("SendFour", "RemoteEvent", beta)
		f.instance("NotCaptured", "RemoteEvent", beta)
		local socket = f.boot()
		f.authenticate(socket)
		local snapshot = f.request(socket, "remote_inventory", { root = "workspace", view = "rows", nameContains = "Send" })
		local identities = {}
		for _, row in ipairs(snapshot.results) do identities[row.name] = row.rowId end
		local counts = f.request(socket, "capabilities", {}).resources.remoteWorkflow
		first.Name = "AfterCapture"
		for _, node in ipairs({ f.workspace, alpha, beta, first }) do
			node.GetChildren = function() error("retained query must not enumerate live children") end
			node.GetFullName = function() error("retained query must not resolve live paths") end
		end
		local query = { pathContains = "ALPHA", classNames = { "RemoteEvent" } }
		local rows = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", query = query })
		assert(rows.queryScope == "retained-rows" and rows.queryMatched == 2 and rows.retained == 4)
		assert(rows.root == snapshot.root and rows.snapshotId == snapshot.snapshotId and rows.visited == snapshot.visited)
		assert(rows.matchedVisited == snapshot.matchedVisited and rows.expiresInMs <= snapshot.expiresInMs)
		assert(rows.results[1].name == "SendOne" and rows.results[1].rowId == identities.SendOne)
		assert(rows.results[2].name == "SendTwo" and rows.results[2].rowId == identities.SendTwo)
		local summary = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = query })
		assert(summary.queryMatched == 2 and #summary.groups == 1 and summary.groups[1].count == 2)
		assert(summary.classes.RemoteEvent == 2 and summary.classes.RemoteFunction == nil)
		local empty = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = { nameContains = "missing" } })
		assert(empty.queryMatched == 0 and #empty.groups == 0 and next(empty.classes) == nil and empty.coverage == "complete")
		local untouched = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows" })
		assert(#untouched.results == 4 and untouched.queryScope == nil and untouched.results[1].rowId == identities.SendOne)
		local after = f.request(socket, "capabilities", {}).resources
		assert(after.remoteWorkflow.snapshots == counts.snapshots and after.remoteWorkflow.snapshotBytes == counts.snapshotBytes)
		assert(after.references.total == 0 and after.connections.reference == 0)
		f.teardown()
	end)
	check("query cursors bind canonical selectors and reject cross-query replay", function()
		local f = fixture()
		for index = 1, 3 do f.instance("Send" .. index, "RemoteEvent", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local snapshot = f.request(socket, "remote_inventory", { root = "workspace", view = "rows", limit = 1 })
		local query = { nameContains = "SEND", classNames = { "RemoteFunction", "RemoteEvent", "RemoteEvent" } }
		local first = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", query = query, limit = 1 })
		assert(first.nextCursor and #first.nextCursor <= 256)
		local second = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", limit = 1,
			query = { nameContains = "send", pathContains = "", classNames = { "RemoteEvent", "RemoteFunction" } }, cursor = first.nextCursor })
		assert(second.results[1].name == "Send2" and second.results[1].rowId ~= first.results[1].rowId)
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", query = {}, cursor = first.nextCursor })
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", query = query, cursor = snapshot.nextCursor })
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", cursor = first.nextCursor })
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = query, cursor = first.nextCursor })
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows",
			query = { nameContains = "send", pathContains = "Workspace", classNames = { "RemoteEvent", "RemoteFunction" } }, cursor = first.nextCursor })
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows",
			query = { nameContains = "send", classNames = { "RemoteEvent" } }, cursor = first.nextCursor })
		local all = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", query = {}, limit = 1 })
		local explicitAll = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", limit = 1,
			query = { nameContains = "", pathContains = "", classNames = { "UnreliableRemoteEvent", "RemoteFunction", "RemoteEvent" } }, cursor = all.nextCursor })
		assert(explicitAll.results[1].name == "Send2")
		f.teardown()
	end)
	check("invalid query views and filters cannot allocate or rescan snapshots", function()
		local f = fixture()
		f.instance("Send", "RemoteEvent", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local snapshot = f.request(socket, "remote_inventory", { root = "workspace", nameContains = "Send" })
		f.workspace.GetChildren = function() error("invalid query must not rescan") end
		f.reject(socket, "remote_inventory", { root = "workspace", query = {} })
		for _, view in ipairs({ "detail", "diff", "release" }) do
			f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = view, query = {} })
		end
		for _, query in ipairs({ { classNames = {} }, { classNames = { "Folder" } }, { nameContains = false },
			{ nameContains = string.rep("a", 257) }, { pathContains = string.rep("a", 513) }, { unknown = true } }) do
			f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = query })
		end
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = {}, nameContains = "different" })
		local retained = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = { nameContains = "missing" } })
		assert(retained.queryMatched == 0 and retained.retained == 1)
		assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.snapshots == 1)
		f.teardown()
	end)
	check("retained queries preserve partial scan coverage and never extend snapshot expiry", function()
		local f = fixture()
		for index = 1, 4 do f.instance("Remote" .. index, "RemoteEvent", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local snapshot = f.request(socket, "remote_inventory", { root = "workspace", maxVisited = 3 })
		assert(snapshot.retained == 2 and snapshot.coverage == "partial" and snapshot.stopReasons[1] == "visit-limit")
		local query = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = { nameContains = "Remote1" } })
		assert(query.queryMatched == 1 and query.retained == snapshot.retained and query.visited == snapshot.visited)
		assert(query.coverage == "partial" and query.truncated and query.stopReasons[1] == snapshot.stopReasons[1])
		f.scheduler.advance(119)
		local late = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = {} })
		assert(late.expiresInMs <= 1000)
		f.scheduler.advance(2)
		f.reject(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, query = {} })
		f.teardown()
	end)
	check("exhausted traversal skips child arrays while count consumers retain exact totals", function()
		local f = fixture()
		local branch = f.instance("Branch", "Folder", f.workspace)
		f.instance("Leaf", "Folder", branch)
		local rootReads, branchReads = 0, 0
		local rootChildren, branchChildren = f.workspace.GetChildren, branch.GetChildren
		f.workspace.GetChildren = function(self) rootReads += 1; return rootChildren(self) end
		branch.GetChildren = function(self) branchReads += 1; return branchChildren(self) end
		local socket = f.boot()
		f.authenticate(socket)
		local summary = f.request(socket, "class_summary", { path = "workspace", maxVisited = 2 })
		assert(summary.visited == 2 and summary.truncated and rootReads == 1 and branchReads == 0)
		local empty = f.request(socket, "class_summary", { path = "workspace.Branch.Leaf", maxVisited = 1 })
		assert(empty.visited == 1 and not empty.truncated)
		local scanned = f.request(socket, "remote_inventory", { root = "workspace.Branch", maxVisited = 1 })
		assert(scanned.coverage == "partial" and scanned.stopReasons[1] == "visit-limit" and branchReads == 0)
		local inspected = f.request(socket, "inspect_instance", { path = "workspace", depth = 2, childLimit = 1 })
		assert(#inspected.children == 1 and inspected.children[1].childrenTruncated and branchReads == 0)
		local listed = f.request(socket, "list_children", { path = "workspace.Branch", limit = 1 })
		assert(listed.total == 1 and #listed.children == 1 and not listed.truncated and branchReads == 1)
		local batch = f.request(socket, "batch_read", { maxTotalValues = 1, requests = {
			{ path = "workspace.Branch", properties = { "Name" }, children = { limit = 1 } },
		} })
		assert(batch.results[1].children.total == 1 and batch.results[1].children.truncated)
		assert(#batch.results[1].children.children == 0 and branchReads == 2)
		f.teardown()
	end)

	check("game context captures rotated boxes and redacted metadata with isolated snapshot ownership", function()
		local f = fixture()
		f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		local vector = f.typedFacilities()
		local player = f.instance("FixtureUser", "Player", f.environment.game)
		player.DisplayName, player.UserId = "Fixture Display", 24681357
		f.services.Players.LocalPlayer = player
		local character = f.instance("Character", "Model", f.workspace)
		player.Character = character
		f.geometryPart("HumanoidRootPart", character).Position = vector(9, 8, 7)
		local gui = f.instance("PlayerGui", "PlayerGui", player)
		f.instance("AReadout", "TextLabel", gui).Text = "FixtureUser Fixture Display 24681357 https://private.example Bearer private-token"
		f.instance("Password", "TextBox", gui).Text = "private-ui-value"
		local model = f.instance("Scene", "Model", f.workspace)
		model.GetBoundingBox = function() error("model bounding boxes must not recurse") end
		local part = f.geometryPart("FixtureUserMesh", model, nil, nil, "MeshPart")
		local script = f.instance("HiddenScript", "LocalScript", model)
		script.GetChildren = function() error("excluded scripts must not be traversed") end
		local metatable = getmetatable(script)
		local index = metatable.__index
		metatable.__index = function(self, key)
			if key == "Source" then error("script source must not be read") end
			return index(self, key)
		end
		f.services.CoreGui = { GetChildren = function() error("CoreGui is outside the selected UI scope") end }
		local socket = f.boot()
		f.authenticate(socket)
		local baseline = f.connectionCounters().active
		local result = f.request(socket, "game_context", { root = "workspace.Scene", maxVisited = 100, maxParts = 1, uiLimit = 2 })
		assert(result.schema == 2 and #result.sourceSnapshotId == 32 and #result.parts[1].sourceObjectId == 32 and result.root == "game.Workspace.Scene" and result.place.placeId == 1)
		assert(result.player.present and result.player.position.x == 9 and result.player.position.y == 8 and result.player.position.z == 7)
		assert(result.coverage == "complete" and not result.truncated and result.visited == 7 and not result.atomicSnapshot)
		assert(#result.parts == 1 and result.parts[1].className == "MeshPart" and result.parts[1].name == "[redacted]Mesh")
		local box = result.parts[1]
		assert(#box.cframe == 12 and box.cframe[1] == 10 and box.cframe[6] == 1 and box.cframe[10] == -1)
		assert(box.size.x == 4 and box.size.y == 6 and box.size.z == 8 and box.anchored and not box.canCollide)
		assert(result.ui.coverage == "complete" and not result.ui.truncated and #result.ui.entries == 2)
		assert(byName(result.ui.entries).Password.text == "[redacted]")
		assert(result.remotes.root == "game.ReplicatedStorage" and result.remotes.coverage == "complete" and not result.remotes.truncated and #result.remotes.entries == 0)
		assertPrivateTree(result, { part, part.CFrame, part.Size, player, script }, {
			"FixtureUser", "Fixture Display", "24681357", "private.example", "private-token", "private-ui-value",
		})
		local resources = f.request(socket, "capabilities", {}).resources
		assert(resources.references.total == 0 and resources.remoteWorkflow.snapshots == 0 and resources.connections.reference == 0)
		assert(f.connectionCounters().active == baseline and part.Parent == model)
		f.teardown()
	end)
	check("game context reports terrain streaming and independent part and UI truncation", function()
		local f = fixture()
		f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.typedFacilities()
		f.workspace.StreamingEnabled = true
		local player = f.instance("Viewer", "Player", f.environment.game)
		f.services.Players.LocalPlayer = player
		local gui = f.instance("PlayerGui", "PlayerGui", player)
		f.instance("A", "TextLabel", gui).Text = "One"
		f.instance("B", "TextLabel", gui).Text = "Two"
		local terrain = f.instance("ATerrain", "Terrain", f.workspace)
		terrain.GetChildren = function() error("Terrain voxels/descendants must not be enumerated") end
		for index = 1, 3 do f.geometryPart("Part" .. index) end
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "game_context", { maxVisited = 20, maxParts = 2, uiLimit = 1 })
		local reasons = {}
		for _, reason in ipairs(result.stopReasons) do reasons[reason] = true end
		assert(result.coverage == "partial" and result.truncated and result.visited <= 20)
		assert(#result.parts == 2 and reasons["terrain-omitted"] and reasons["streaming-enabled-client-visible-only"] and reasons["part-limit"])
		assert(result.ui.coverage == "partial" and result.ui.truncated and #result.ui.entries == 1 and reasons["ui-limit"])
		for _, box in ipairs(result.parts) do assert(box.className ~= "Terrain") end
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.teardown()
	end)
	check("game context rejects invalid bounds and omits nonfinite geometry", function()
		local f = fixture()
		f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		local vector = f.typedFacilities()
		f.geometryPart("Valid")
		f.geometryPart("InvalidSize").Size = vector(math.huge, 1, 1)
		f.geometryPart("NegativeSize").Size = vector(-1, 1, 1)
		f.geometryPart("InvalidRotation").CFrame = f.environment.CFrame.new(0, 0, 0, 1, 0, 0, 0, 0 / 0, 0, 0, 0, 1)
		local reads, original = 0, f.workspace.GetChildren
		f.workspace.GetChildren = function(self) reads += 1; return original(self) end
		local socket = f.boot()
		f.authenticate(socket)
		for _, params in ipairs({ { maxVisited = 0 }, { maxVisited = 20001 }, { maxVisited = 1.5 }, { maxParts = 0 },
			{ maxParts = 513 }, { uiLimit = -1 }, { uiLimit = 41 }, { _maxResultBytes = 32769 }, { _maxResultBytes = 1 },
			{ remoteLimit = -1 }, { remoteLimit = 101 }, { remoteLimit = 1.5 }, { remoteLimit = "1" },
			{ root = "game" }, { root = "" }, { includeReferences = true } }) do
			f.reject(socket, "game_context", params)
		end
		assert(reads == 0)
		local result = f.request(socket, "game_context", { uiLimit = 0 })
		assert(result.coverage == "partial" and #result.parts == 1 and result.parts[1].name == "Valid")
		assert(table.find(result.stopReasons, "geometry-unavailable") and table.find(result.stopReasons, "ui-excluded"))
		for _, component in ipairs(result.parts[1].cframe) do assert(component == component and math.abs(component) < math.huge) end
		assert(result.player.present == false and f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.teardown()
	end)
	check("game context partitions aggregate visits before traversal and excludes zero-budget facets", function()
		local f = fixture()
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		f.instance("Send", "RemoteEvent", storage)
		storage.GetChildren = function() error("Remotes without visit capacity must not enumerate") end
		f.typedFacilities()
		f.geometryPart("Box")
		local player = f.instance("Viewer", "Player", f.environment.game)
		f.services.Players.LocalPlayer = player
		local gui = f.instance("PlayerGui", "PlayerGui", player)
		f.instance("Label", "TextLabel", gui).Text = "Visible"
		gui.GetChildren = function() error("UI without visit capacity must not enumerate") end
		f.workspace.GetChildren = function() error("zero remaining geometry capacity must not enumerate") end
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "game_context", { maxVisited = 1 })
		assert(result.visited == 1 and #result.parts == 0 and #result.ui.entries == 0)
		assert(result.coverage == "partial" and result.ui.coverage == "partial")
		assert(table.find(result.stopReasons, "visit-limit") and table.find(result.stopReasons, "ui-visit-limit"))
		assert(result.remotes.coverage == "partial" and #result.remotes.entries == 0 and table.find(result.stopReasons, "remotes-visit-limit"))
		local excluded = f.request(socket, "game_context", { maxVisited = 1, uiLimit = 0 })
		assert(excluded.visited == 1 and table.find(excluded.stopReasons, "ui-excluded"))
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.teardown()
	end)
	check("game context cancels cooperative reads at socket and generation boundaries without publication", function()
		for _, boundary in ipairs({ "socket", "generation" }) do
			local f = fixture()
			f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
			local paths = 0
			for index = 1, 300 do
				local node = f.instance("Wide" .. index, "Folder", f.workspace)
				local original = node.GetFullName
				node.GetFullName = function(self) paths += 1; return original(self) end
			end
			local socket = f.boot()
			f.authenticate(socket)
			local oldState = f.global.PotassiumMcp
			local wait, paused = f.environment.task.wait, false
			f.environment.task.wait = function(delay)
				if delay == nil and not paused then paused = true; return wait(2) end
				return wait(delay)
			end
			local pending, id = f.begin(socket, "game_context", { uiLimit = 0 })
			assert(paused and pending() == nil and oldState.requestCounts.read == 1 and oldState.requestCounts.mutation == 0)
			local before = paths
			if boundary == "socket" then socket = f.reconnect(socket)
			else
				f.shared.PotassiumMcpGeneration += 1
				f.global.PotassiumMcpGeneration = f.shared.PotassiumMcpGeneration
			end
			f.scheduler.advance(3)
			assert(pending() == nil and paths == before and oldState.requestCounts.read == 0)
			if boundary == "generation" then
				oldState.teardown()
				socket = f.boot()
				f.authenticate(socket)
			end
			assert(f.responseCount(socket, id) == 0)
			local resources = f.request(socket, "capabilities", {}).resources
			assert(resources.references.total == 0 and resources.remoteWorkflow.snapshots == 0 and resources.connections.reference == 0)
			f.teardown()
		end
	end)
	check("game context returns bounded partial geometry when traversal work is exhausted", function()
		local f = fixture()
		f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		local child = f.instance("Only", "Folder", f.workspace)
		f.workspace.GetChildren = function() return table.create(100010, child) end
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "game_context", { maxVisited = 20000 })
		assert(result.coverage == "partial" and result.truncated and result.facetCoverage.geometry.visited == 1)
		assert(table.find(result.facetCoverage.geometry.stopReasons, "work-limit"))
		assert(result.remotes.coverage == "complete" and result.facetCoverage.remotes.visited == 1)
		assert(#result.parts == 0 and result.ui.coverage == "partial" and f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.teardown()
	end)
	check("game context omits unrepresentable metadata rather than clipping canonical identities", function()
		local f = fixture()
		f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.typedFacilities()
		f.environment.game.Name = string.rep("p", 129)
		f.geometryPart("Valid")
		f.geometryPart(string.rep("n", 129))
		local longRoot = f.instance(string.rep("r", 970), "Folder", f.workspace)
		f.geometryPart("HiddenByPath", longRoot)
		local player = f.instance("Viewer", "Player", f.environment.game)
		f.services.Players.LocalPlayer = player
		local gui = f.instance("PlayerGui", "PlayerGui", player)
		f.instance(string.rep("u", 129), "TextLabel", gui).Text = "Omitted identity"
		f.instance("Message", "TextLabel", gui).Text = string.rep("m", 257)
		local unicodeName = string.rep("\195\169", 64)
		f.instance(unicodeName, "TextLabel", gui).Text = "Preserved UTF8"
		local socket = f.boot()
		f.authenticate(socket)
		f.reject(socket, "game_context", { root = "workspace." .. longRoot.Name })
		local result = f.request(socket, "game_context", {})
		assert(result.coverage == "partial" and table.find(result.stopReasons, "metadata-limit"))
		assert(result.place.name == nil and #result.parts == 1 and result.parts[1].name == "Valid")
		assert(result.ui.coverage == "partial" and #result.ui.entries == 2)
		assert(byName(result.ui.entries).Message.text == nil and byName(result.ui.entries)[unicodeName].text == "Preserved UTF8")
		assert(result.root == string.rep("p", 129) .. ".Workspace")
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.teardown()
	end)
	check("game context captures only ReplicatedStorage remote identities without calls source reads hooks or snapshot eviction", function()
		local f = fixture()
		local vector = f.typedFacilities()
		local player = f.instance("FixtureUser", "Player", f.environment.game)
		player.DisplayName, player.UserId = "Fixture Display", 24681357
		f.services.Players.LocalPlayer = player
		player.Character = f.instance("Character", "Model", f.environment.game)
		f.geometryPart("HumanoidRootPart", player.Character).Position = vector(1, 2, 3)
		f.instance("PlayerGui", "PlayerGui", player)
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		local folder = f.instance("Network", "Folder", storage)
		local script = f.instance("MetadataModule", "ModuleScript", folder)
		local event = f.instance("FixtureUserSend", "RemoteEvent", folder)
		local query = f.instance("Query", "RemoteFunction", folder)
		local stream = f.instance("Stream", "UnreliableRemoteEvent", script)
		local localEvent = f.instance("LocalOnly", "BindableEvent", folder)
		local value = f.instance("Value", "StringValue", folder)
		local outside = f.instance("Outside", "RemoteEvent", f.workspace)
		local forbiddenReads, invocations = 0, 0
		for _, node in ipairs({ script, event, query, stream, value }) do
			local metatable, index = getmetatable(node), getmetatable(node).__index
			metatable.__index = function(self, key)
				if key == "Source" or key == "Value" then forbiddenReads += 1; error("remote context is identity-only") end
				return index(self, key)
			end
			node.FireServer = function() invocations += 1; error("remote context must not fire") end
			node.InvokeServer = function() invocations += 1; error("remote context must not invoke") end
		end
		local adapter = f.namecallFacilities(function() invocations += 1 end)
		local socket = f.boot()
		f.authenticate(socket)
		local baseline, installed = f.connectionCounters().active, adapter.installs
		local result = f.request(socket, "game_context", {})
		assert(result.coverage == "complete" and not result.truncated and #result.stopReasons == 0)
		assert(result.remotes.root == "game.ReplicatedStorage" and result.remotes.coverage == "complete" and not result.remotes.truncated)
		assert(#result.remotes.entries == 3)
		local entries = byName(result.remotes.entries)
		assert(entries["[redacted]Send"].className == "RemoteEvent" and entries["[redacted]Send"].path == "game.ReplicatedStorage.Network.[redacted]Send")
		assert(entries.Query.className == "RemoteFunction" and entries.Query.path == "game.ReplicatedStorage.Network.Query")
		assert(entries.Stream.className == "UnreliableRemoteEvent" and entries.Stream.path == "game.ReplicatedStorage.Network.MetadataModule.Stream")
		for _, row in ipairs(result.remotes.entries) do
			for key in pairs(row) do assert(key == "name" or key == "path" or key == "className") end
		end
		assertPrivateTree(result, { storage, script, event, query, stream, localEvent, value, outside, player }, { "FixtureUser" })
		local capabilities = f.request(socket, "capabilities", {})
		assert(capabilities.gameContext.remoteScope == "replicated-storage" and capabilities.gameContext.remoteMetadata == "name-path-class-only")
		assert(capabilities.resources.remoteWorkflow.snapshots == 0 and capabilities.resources.references.total == 0)
		-- Fill the native inventory pool so even a transient inventory scan would
		-- evict the oldest other consumer's snapshot and invalidate its next page.
		local oldest
		for _ = 1, 8 do
			local snapshot = f.request(socket, "remote_inventory", { root = "game.ReplicatedStorage" })
			oldest = oldest or snapshot.snapshotId
		end
		f.request(socket, "game_context", {})
		local retained = f.request(socket, "remote_inventory", { snapshotId = oldest, view = "rows" })
		assert(#retained.results == 3)
		local resources = f.request(socket, "capabilities", {}).resources
		assert(resources.remoteWorkflow.snapshots == 8 and resources.references.total == 0)
		assert(forbiddenReads == 0 and invocations == 0 and adapter.installs == installed and f.connectionCounters().active == baseline)
		f.teardown()
	end)
	check("game context distinguishes disabled remote collection from unavailable or unreadable storage", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local serviceReads, original = 0, f.environment.game.GetService
		f.environment.game.GetService = function(self, name)
			if name == "ReplicatedStorage" then serviceReads += 1 end
			return original(self, name)
		end
		local disabled = f.request(socket, "game_context", { remoteLimit = 0 })
		assert(serviceReads == 0 and disabled.remotes.root == "game.ReplicatedStorage")
		assert(disabled.coverage == "partial" and disabled.remotes.coverage == "partial" and disabled.remotes.truncated)
		assert(#disabled.remotes.entries == 0 and table.find(disabled.stopReasons, "remotes-excluded"))
		local unavailable = f.request(socket, "game_context", {})
		assert(serviceReads == 1 and unavailable.remotes.coverage == "partial" and unavailable.remotes.truncated)
		assert(#unavailable.remotes.entries == 0 and table.find(unavailable.stopReasons, "remotes-unavailable"))
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		storage.GetChildren = function() error("fixture storage read unavailable") end
		local unreadable = f.request(socket, "game_context", {})
		assert(unreadable.remotes.coverage == "partial" and unreadable.remotes.truncated and #unreadable.remotes.entries == 0)
		assert(table.find(unreadable.stopReasons, "remotes-children-unavailable"))
		f.teardown()
	end)
	check("game context enforces remote row limits and only reports complete after exhausting the selected scope", function()
		local f = fixture()
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		for index = 1, 51 do f.instance(string.format("Remote%02d", index), "RemoteEvent", storage) end
		local socket = f.boot()
		f.authenticate(socket)
		local limited = f.request(socket, "game_context", {})
		assert(#limited.remotes.entries == 50 and limited.remotes.coverage == "partial" and limited.remotes.truncated)
		assert(limited.remotes.entries[50].name == "Remote50" and table.find(limited.stopReasons, "remote-limit"))
		local complete = f.request(socket, "game_context", { remoteLimit = 51 })
		assert(#complete.remotes.entries == 51 and complete.remotes.coverage == "complete" and not complete.remotes.truncated)
		assert(not table.find(complete.stopReasons, "remote-limit"))
		for index = 52, 101 do f.instance(string.format("Remote%03d", index), "RemoteFunction", storage) end
		local ceiling = f.request(socket, "game_context", { remoteLimit = 100, uiLimit = 0 })
		assert(#ceiling.remotes.entries == 100 and ceiling.remotes.coverage == "partial" and table.find(ceiling.stopReasons, "remote-limit"))
		f.teardown()
	end)
	check("game context reserves independent geometry UI and remote visits", function()
		local f = fixture()
		f.typedFacilities()
		f.geometryPart("Box")
		local player = f.instance("Viewer", "Player", f.environment.game)
		f.services.Players.LocalPlayer = player
		local gui = f.instance("PlayerGui", "PlayerGui", player)
		f.instance("Label", "TextLabel", gui).Text = "Visible"
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		f.instance("A", "RemoteEvent", storage)
		f.instance("B", "RemoteFunction", storage)
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "game_context", { maxVisited = 6 })
		assert(result.visited == 6 and #result.parts == 1 and #result.ui.entries == 1 and result.ui.coverage == "complete")
		assert(#result.remotes.entries == 1 and result.remotes.entries[1].name == "A")
		assert(result.remotes.coverage == "partial" and result.remotes.truncated and table.find(result.stopReasons, "remotes-visit-limit"))
		f.teardown()
	end)
	check("game context reserves work for remotes after geometry exhaustion", function()
		local f = fixture()
		f.typedFacilities()
		local branch = f.geometryPart("Box")
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		local remote = f.instance("Send", "RemoteEvent", storage)
		-- Geometry exhausts its allocation; the small remote scope must still run.
		f.workspace.GetChildren = function() return table.create(100010, branch) end
		local socket = f.boot()
		f.authenticate(socket)
		local shared = f.request(socket, "game_context", { maxVisited = 20000, maxParts = 1, uiLimit = 0 })
		assert(#shared.parts == 0 and #shared.remotes.entries == 1)
		assert(shared.remotes.coverage == "complete" and table.find(shared.facetCoverage.geometry.stopReasons, "work-limit"))
		-- These two near-ceiling reads advance more than one heartbeat interval.
		-- Model the host's intervening ping rather than testing transport expiry.
		f.receive(socket, { type = "ping", nonce = "between-work-budget-reads" })
		local remoteOnly = f.request(socket, "game_context", { root = "workspace.Box", maxVisited = 20000, uiLimit = 0 })
		assert(#remoteOnly.remotes.entries == 1 and remoteOnly.remotes.coverage == "complete")
		assert(not table.find(remoteOnly.stopReasons, "work-limit"))
		f.teardown()
	end)
	check("game context omits oversized or unavailable remote identities without clipping redacted paths", function()
		local f = fixture()
		local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
		f.services.ReplicatedStorage = storage
		f.instance("Valid", "RemoteEvent", storage)
		f.instance(string.rep("n", 129), "RemoteEvent", storage)
		local folder = f.instance(string.rep("p", 990), "Folder", storage)
		f.instance("HiddenByPath", "RemoteFunction", folder)
		local unicodeName = string.rep("\195\169", 64)
		f.instance(unicodeName, "UnreliableRemoteEvent", storage)
		local unavailable = f.instance("Unavailable", "RemoteEvent", storage)
		unavailable.GetFullName = function() error("fixture path unavailable") end
		local invalidUtf8 = f.instance("Invalid\255", "RemoteEvent", storage)
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "game_context", {})
		assert(result.remotes.coverage == "partial" and result.remotes.truncated and table.find(result.stopReasons, "metadata-limit"))
		assert(#result.remotes.entries == 2)
		local entries = byName(result.remotes.entries)
		assert(entries.Valid.path == "game.ReplicatedStorage.Valid" and entries[unicodeName].path == "game.ReplicatedStorage." .. unicodeName)
		assertPrivateTree(result, { storage, folder, unavailable, invalidUtf8 }, { "HiddenByPath", string.rep("n", 129), string.rep("p", 990), "Invalid\255" })
		f.teardown()
	end)
	if options.jsonEncode then
		check("game context accounts escaped row bytes without leaking omitted instances", function()
			local f = fixture()
			f.services.ReplicatedStorage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
			f.typedFacilities()
			f.geometryPart("A")
			local omitted = f.geometryPart("Z" .. string.rep("\1", 127))
			local socket = f.boot()
			f.authenticate(socket)
			local result = f.request(socket, "game_context", { _maxResultBytes = 4096 })
			assert(#options.jsonEncode(result) <= 4096 and result.coverage == "partial")
			assert(#result.parts == 1 and result.parts[1].name == "A" and table.find(result.stopReasons, "byte-limit"))
			assert(result.ui.coverage == "partial" and table.find(result.stopReasons, "player-gui-unavailable"))
			assert(result.remotes.coverage == "complete" and result.facetCoverage.remotes.visited == 1)
			assertPrivateTree(result, { omitted, omitted.CFrame, omitted.Size })
			assert(f.global.PotassiumMcp.instanceReferenceCount == 0 and omitted:ListenerCount() == 0)
			f.teardown()
		end)
		check("game context partitions escaped byte allowances independently across facets", function()
			local f = fixture()
			f.typedFacilities()
			f.geometryPart("Box")
			local player = f.instance("Viewer", "Player", f.environment.game)
			f.services.Players.LocalPlayer = player
			local gui = f.instance("PlayerGui", "PlayerGui", player)
			f.instance("Label", "TextLabel", gui).Text = string.rep("\1", 100)
			local storage = f.instance("ReplicatedStorage", "ReplicatedStorage", f.environment.game)
			f.services.ReplicatedStorage = storage
			f.instance("A", "RemoteEvent", storage)
			local omitted = f.instance("Z" .. string.rep("\1", 100), "RemoteFunction", storage)
			local socket = f.boot()
			f.authenticate(socket)
			local result = f.request(socket, "game_context", { _maxResultBytes = 4096 })
			assert(#options.jsonEncode(result) <= 4096 and #result.parts <= 1 and #result.ui.entries == 0 and result.ui.coverage == "partial")
			assert(#result.remotes.entries == 1 and result.remotes.entries[1].name == "A")
			assert(result.remotes.coverage == "partial" and result.remotes.truncated and table.find(result.stopReasons, "byte-limit"))
			assertPrivateTree(result, { omitted }, { omitted.Name })
			-- Disabling UI increases the reserved share, never borrows spent bytes.
			local empty = f.instance("Empty", "Folder", f.workspace)
			f.services.Players.LocalPlayer = nil
			local remoteOnly = f.request(socket, "game_context", { root = "workspace.Empty", uiLimit = 0, _maxResultBytes = 4096 })
			assert(remoteOnly.remotes.coverage == "partial" and table.find(remoteOnly.facetCoverage.remotes.stopReasons, "byte-limit") and #options.jsonEncode(remoteOnly) <= 4096)
			assert(empty.Parent == f.workspace and f.global.PotassiumMcp.instanceReferenceCount == 0)
			f.teardown()
		end)
	end
	local function recordingFixture()
		local f = fixture()
		f.typedFacilities()
		local part = f.geometryPart("Recorded")
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		local selection = { sourceSnapshotId = capture.sourceSnapshotId, sourceObjectId = capture.parts[1].sourceObjectId }
		return f, socket, part, selection
	end
	check("marker labels share the public Unicode length boundary without byte truncation", function()
		local f, socket, _, target = recordingFixture()
		local meta = f.request(socket, "map_recording", { operation = "start", targets = { target } }).metadata
		local label = string.rep(utf8.char(252), 64)
		f.request(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = label })
		f.reject(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = label .. "x" })
		local astral = string.rep(utf8.char(0x10400), 32)
		f.request(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = astral })
		f.reject(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = astral .. "x" })
		local page = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "events" })
		assert(#page.events == 2 and page.events[1].label == label and page.events[2].label == astral)
		f.teardown()
	end)
	check("marker receipt crossing deadline retains only its admitted native timestamp", function()
		local f, socket, _, target = recordingFixture()
		local meta = f.request(socket, "map_recording", { operation = "start", targets = { target }, durationMs = 1000 }).metadata
		f.scheduler.advance(0.99)
		local clock, tick = f.environment.os.clock, 0
		local before = clock()
		-- Model real clock progress within one non-yielding request at the deadline.
		f.environment.os.clock = function() tick += 0.004; return before + tick end
		f.request(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = "edge" })
		f.environment.os.clock = clock
		f.scheduler.advance(0.1)
		local page = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "events" })
		assert(#page.events == 1 and page.events[1].t < 1 and page.events[1].t >= 0.99)
		assert(page.metadata.state == "stopped" and page.metadata.eventCount == 1 and not page.metadata.ready)
		f.teardown()
	end)
	check("continuous recorder owns thirty seconds of samples without polling and expires from terminal time", function()
		local f, socket, part, target = recordingFixture()
		local initial = f.request(socket, "map_recording", { operation = "start", targets = { target }, durationMs = 30000 }).metadata
		assert(initial.ready and initial.state == "recording" and initial.frameCount == 1 and initial.firstSampleAt == initial.startedAt)
		assert(initial.readyAt >= initial.firstSampleAt and initial.clock == "client-monotonic-seconds")
		local owned = f.global.PotassiumMcp.mapRecordings.records[initial.recordingId]
		assert(owned.timer and f.global.PotassiumMcp.mapSnapshots.resources().activeHolds == 1)
		f.environment.task.delay(12.05, function()
			part.CFrame = f.environment.CFrame.new(99, 20, 30, 1, 0, 0, 0, 1, 0, 0, 0, 1)
		end)
		f.scheduler.advance(31)
		local terminal = f.request(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId }).metadata
		assert(terminal.state == "stopped" and not terminal.ready and terminal.frameCount >= 300 and terminal.frameCount <= 302)
		assert(terminal.stopReasons[1] == "duration-complete" and math.abs(terminal.stoppedAt - initial.startedAt - 30) < 0.00001)
		assert(terminal.missedIntervals == 0 and terminal.retainedDrops == 0)
		assert(not owned.timer and f.global.PotassiumMcp.mapSnapshots.resources().activeHolds == 0)
		local cursor, previous, changed = 0, nil, false
		repeat
			local page = f.request(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId, view = "frames", afterCursor = cursor, limit = 20 })
			for _, row in ipairs(page.frames) do
				assert(row.sequence == cursor + 1 and #row.samples == 1 and row.samples[1].sourceObjectId == target.sourceObjectId)
				if previous then assert(row.t > previous and row.t - previous <= 0.100001) end
				previous, cursor = row.t, row.sequence
				changed = changed or row.samples[1].cframe[1] == 99
			end
			assert(page.nextCursor == cursor)
		until not page.hasMore
		assert(changed and cursor == terminal.frameCount and previous >= 29.9)
		local replay = f.request(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId, view = "frames", afterCursor = 0, limit = 1 })
		assert(replay.frames[1].sequence == 1 and replay.frames[1].t == 0)
		f.reject(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId, view = "frames", afterCursor = cursor + 1 })
		f.reject(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId, view = "frames", _maxResultBytes = 1 })
		f.scheduler.advance(118)
		assert(f.request(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId }).metadata.expiresAt == terminal.expiresAt)
		f.scheduler.advance(2)
		f.reject(socket, "map_recording", { operation = "poll", recordingId = initial.recordingId })
		f.teardown()
	end)
	check("recording holds survive source expiry and markers preserve actual request time without reanchoring", function()
		local f, socket, _, target = recordingFixture()
		f.scheduler.advance(179)
		local meta = f.request(socket, "map_recording", { operation = "start", targets = { target }, durationMs = 30000 }).metadata
		f.scheduler.advance(2.35)
		assert(f.global.PotassiumMcp.mapSnapshots.resources().snapshots == 0)
		assert(f.global.PotassiumMcp.mapSnapshots.resources().activeHolds == 1)
		local marked = f.request(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = "receipt" }).metadata
		local events = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "events" })
		assert(marked.markerCount == 1 and events.events[1].source == "mcp-request")
		assert(math.abs(events.events[1].t - 2.35) < 0.00001 and marked.startedAt == meta.startedAt)
		assert(marked.remainingMs < 28000)
		local stopped = f.request(socket, "map_recording", { operation = "stop", recordingId = meta.recordingId }).metadata
		f.scheduler.advance(2)
		local again = f.request(socket, "map_recording", { operation = "stop", recordingId = meta.recordingId }).metadata
		assert(stopped.stoppedAt == again.stoppedAt and stopped.frameCount == again.frameCount and again.stopReasons[1] == "user-stop")
		assert(f.global.PotassiumMcp.mapSnapshots.resources().activeHolds == 0)
		f.reject(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = "late" })
		assert(f.request(socket, "map_recording", { operation = "release", recordingId = meta.recordingId }).released)
		assert(not f.request(socket, "map_recording", { operation = "release", recordingId = meta.recordingId }).released)
		f.teardown()
	end)
	check("recording rejects duplicate acquisition and rolls back unacknowledged starts exactly", function()
		local f, socket, _, target = recordingFixture()
		local flow = f.global.PotassiumMcp.mapRecordings
		f.reject(socket, "map_recording", { operation = "start", targets = { target, target } })
		f.reject(socket, "map_recording", { operation = "start", targets = { target }, durationMs = 60001 })
		f.reject(socket, "map_recording", { operation = "start", targets = { target }, _maxResultBytes = 1 })
		assert(#flow.order == 0 and flow.active == 0 and f.global.PotassiumMcp.mapSnapshots.resources().activeHolds == 0)
		socket.beforeSend = function(message)
			if message.type == "response" and message.result and message.result.metadata then error("fixture response loss") end
		end
		f.begin(socket, "map_recording", { operation = "start", targets = { target } })
		assert(#flow.order == 0 and flow.active == 0 and flow.resources().timers == 0 and flow.resources().holds == 0)
		f.teardown()
	end)
	check("recording target destruction and socket loss preserve terminal scalar evidence", function()
		for _, boundary in ipairs({ "destroy", "socket", "generation", "first-sample" }) do
			local f, socket, part, target = recordingFixture()
			if boundary == "first-sample" then part:Destroy() end
			local meta = f.request(socket, "map_recording", { operation = "start", targets = { target } }).metadata
			local state = f.global.PotassiumMcp
			if boundary == "first-sample" then
				assert(meta.state == "failed" and not meta.ready and meta.frameCount == 0 and not meta.firstSampleAt)
			else
				f.scheduler.advance(0.25)
				if boundary == "destroy" then
					part:Destroy(); f.geometryPart("Recorded"); f.scheduler.advance(0.1)
				elseif boundary == "socket" then socket = f.reconnect(socket)
				else
					f.shared.PotassiumMcpGeneration += 1
					f.global.PotassiumMcpGeneration = f.shared.PotassiumMcpGeneration
					f.scheduler.advance(2)
				end
				if boundary ~= "generation" then
					local result = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "frames" })
					assert(not result.metadata.ready and result.metadata.coverage == "partial" and #result.frames >= 3)
					assert(result.metadata.stopReasons[1] == (boundary == "socket" and "socket-disconnected" or "object-destroyed-or-unreachable"))
					assertPrivateTree(result, { part, part.CFrame, part.Size })
				else assert(#state.mapRecordings.order == 0) end
			end
			assert(state.mapRecordings.resources().timers == 0 and state.mapRecordings.resources().holds == 0)
			f.teardown()
		end
	end)
	check("recording capacity and marker limits terminate explicitly without evicting data", function()
		local f, socket, _, target = recordingFixture()
		local ids = {}
		for index = 1, 4 do ids[index] = f.request(socket, "map_recording", { operation = "start", targets = { target } }).metadata.recordingId end
		f.reject(socket, "map_recording", { operation = "start", targets = { target } })
		for index = 1, 32 do f.request(socket, "map_recording", { operation = "mark", recordingId = ids[1], label = tostring(index) }) end
		f.reject(socket, "map_recording", { operation = "mark", recordingId = ids[1], label = "overflow" })
		local stopped = f.request(socket, "map_recording", { operation = "poll", recordingId = ids[1] }).metadata
		assert(stopped.markerCount == 32 and stopped.eventCount == 32 and stopped.stopReasons[1] == "marker-limit" and stopped.coverage == "partial")
		for _, id in ipairs(ids) do f.request(socket, "map_recording", { operation = "stop", recordingId = id }) end
		for _ = 1, 4 do
			local id = f.request(socket, "map_recording", { operation = "start", targets = { target } }).metadata.recordingId
			f.request(socket, "map_recording", { operation = "stop", recordingId = id })
		end
		f.reject(socket, "map_recording", { operation = "start", targets = { target } })
		assert(f.global.PotassiumMcp.mapRecordings.resources().retained == 8)
		assert(f.request(socket, "map_recording", { operation = "poll", recordingId = ids[1] }).metadata.eventCount == 32)
		f.teardown()
	end)
	check("one recording acquires four different snapshots under one clock and releases active ownership", function()
		local f = fixture()
		f.typedFacilities()
		for index = 1, 4 do f.geometryPart("Part" .. index) end
		local socket = f.boot()
		f.authenticate(socket)
		local targets = {}
		for index = 1, 4 do
			local capture = f.request(socket, "game_context", { root = "workspace.Part" .. index, uiLimit = 0, remoteLimit = 0 })
			targets[index] = { sourceSnapshotId = capture.sourceSnapshotId, sourceObjectId = capture.parts[1].sourceObjectId }
		end
		local meta = f.request(socket, "map_recording", { operation = "start", targets = targets }).metadata
		assert(meta.ready and meta.sampleCount == 4)
		f.scheduler.advance(0.3)
		local page = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "frames" })
		for _, row in ipairs(page.frames) do
			assert(#row.samples == 4)
			for index, sample in ipairs(row.samples) do
				assert(sample.sourceObjectId == targets[index].sourceObjectId and sample.t >= row.t)
			end
		end
		assert(f.request(socket, "map_recording", { operation = "release", recordingId = meta.recordingId }).released)
		local resources = f.global.PotassiumMcp.mapRecordings.resources()
		assert(resources.active == 0 and resources.retained == 0 and resources.holds == 0 and resources.timers == 0)
		f.teardown()
	end)
	check("delayed recording callbacks report actual gaps instead of synthesizing catch-up frames", function()
		local f, socket, _, target = recordingFixture()
		local delay = f.environment.task.delay
		f.environment.task.delay = function(seconds, callback, ...)
			return delay(seconds <= 0.1 and seconds + 0.25 or seconds, callback, ...)
		end
		local meta = f.request(socket, "map_recording", { operation = "start", targets = { target }, durationMs = 1000 }).metadata
		f.scheduler.advance(1.5)
		local page = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "frames" })
		assert(not page.metadata.ready and page.metadata.missedIntervals >= 4 and page.metadata.coverage == "partial")
		assert(#page.frames >= 3 and #page.frames <= 4)
		assert(math.abs(page.frames[2].t - 0.35) < 0.00001 and math.abs(page.frames[3].t - 0.7) < 0.00001)
		f.teardown()
	end)
	check("overdue terminal gap accounting is independent of poll versus delayed sampler order", function()
		for _, pollFirst in ipairs({ true, false }) do
			local f, socket, _, target = recordingFixture()
			local delay = f.environment.task.delay
			f.environment.task.delay = function(seconds, callback, ...)
				return delay(seconds <= 0.1 and seconds + 1.1 or seconds, callback, ...)
			end
			local meta = f.request(socket, "map_recording", { operation = "start", targets = { target }, durationMs = 1000 }).metadata
			f.scheduler.advance(pollFirst and 1.05 or 1.3)
			local result = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId }).metadata
			assert(result.state == "stopped" and result.frameCount == 1 and result.coverage == "partial")
			assert(result.missedIntervals == 10 and result.stopReasons[1] == "duration-complete")
			f.scheduler.advance(1)
			local replay = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId }).metadata
			assert(replay.missedIntervals == 10 and replay.frameCount == 1)
			f.teardown()
		end
	end)
	check("recording byte ceilings stop before appending or evicting a whole frame or event", function()
		for _, facet in ipairs({ "sample", "event" }) do
			local f, socket, _, target = recordingFixture()
			local meta = f.request(socket, "map_recording", { operation = "start", targets = { target } }).metadata
			local record = f.global.PotassiumMcp.mapRecordings.records[meta.recordingId]
			-- Deterministically place accounting at its bounded ceiling; the next real append must be rejected.
			if facet == "sample" then record.sampleBytes = 2097152; f.scheduler.advance(0.11)
			else
				record.eventBytes = 65536
				f.request(socket, "map_recording", { operation = "mark", recordingId = meta.recordingId, label = "no room" })
			end
			local result = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId }).metadata
			assert(result.state == "stopped" and result.coverage == "partial" and result.frameCount == 1 and result.eventCount == 0)
			assert(result.stopReasons[1] == facet .. "-byte-limit")
			assert(f.global.PotassiumMcp.mapRecordings.resources().holds == 0)
			f.teardown()
		end
	end)
	check("recording health events remain bounded temporal correlations and stop at event capacity", function()
		local f, socket, part, target = recordingFixture()
		local player = f.instance("Viewer", "Player", f.environment.game)
		local character = f.instance("Character", "Model", f.workspace)
		player.Character = character
		f.services.Players.LocalPlayer = player
		local root = f.geometryPart("HumanoidRootPart", character)
		local humanoid = f.instance("Humanoid", "Humanoid", character)
		humanoid.Health = 1000
		f.workspace.GetPartsInPart = function(_, queryRoot, params)
			assert(queryRoot == root and #params.FilterDescendantsInstances == 1 and params.FilterDescendantsInstances[1] == part)
			return { part }
		end
		local meta = f.request(socket, "map_recording", { operation = "start", targets = { target } }).metadata
		for index = 1, 257 do
			f.environment.task.delay(index * 0.1 - 0.05, function() humanoid.Health -= 1 end)
		end
		f.scheduler.advance(26)
		local summary = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId }).metadata
		assert(summary.state == "stopped" and summary.eventCount == 256 and summary.stopReasons[1] == "event-limit")
		local page = f.request(socket, "map_recording", { operation = "poll", recordingId = meta.recordingId, view = "events", afterCursor = 250 })
		assert(#page.events == 6 and page.nextCursor == 256 and not page.hasMore)
		for index, event in ipairs(page.events) do
			assert(event.sequence == 250 + index and event.kind == "health-drop" and event.amount == 1)
			assert(event.association == "spatial-temporal-correlation" and event.objectIds[1] == target.sourceObjectId)
		end
		f.teardown()
	end)
	check("map snapshots preserve retained identity but never rebind replaced paths", function()
		local f = fixture()
		f.typedFacilities()
		local original = f.geometryPart("Platform")
		local socket = f.boot()
		f.authenticate(socket)
		local first = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		local second = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		assert(first.sourceSnapshotId ~= second.sourceSnapshotId)
		assert(first.parts[1].sourceObjectId == second.parts[1].sourceObjectId)
		original:Destroy()
		f.geometryPart("Platform")
		local replacement = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		assert(replacement.parts[1].sourceObjectId ~= first.parts[1].sourceObjectId)
		local observed = f.request(socket, "map_observe", { sourceSnapshotId = first.sourceSnapshotId,
			objectIds = { first.parts[1].sourceObjectId }, durationMs = 100, intervalMs = 50 })
		assert(observed.coverage == "partial" and #observed.tracks[1].samples == 0)
		assert(observed.tracks[1].unavailable == "object-destroyed-or-unreachable")
		f.scheduler.advance(181)
		f.reject(socket, "map_observe", { sourceSnapshotId = first.sourceSnapshotId, objectIds = { first.parts[1].sourceObjectId } })
		assert(f.request(socket, "capabilities", {}).resources.mapSnapshots.snapshots == 0)
		f.teardown()
	end)
	check("map observation uses actual delayed timestamps and stops on target destruction", function()
		local f = fixture()
		f.typedFacilities()
		local part = f.geometryPart("Moving")
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		local wait = f.environment.task.wait
		f.environment.task.wait = function(delay) return wait(delay and delay + 0.025 or delay) end
		f.environment.task.delay(0.16, function() part:Destroy() end)
		local observed = f.request(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId,
			objectIds = { capture.parts[1].sourceObjectId }, durationMs = 300, intervalMs = 50 })
		local track = observed.tracks[1]
		assert(#track.samples == 3 and math.abs(track.samples[2].t - 0.075) < 0.00001)
		assert(track.unavailable == "object-destroyed-or-unreachable" and observed.coverage == "partial")
		f.teardown()
	end)
	check("map observation fences exact socket and generation after each wait", function()
		for _, boundary in ipairs({ "socket", "generation" }) do
			local f = fixture()
			f.typedFacilities()
			f.geometryPart("Platform")
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
			local pending = f.begin(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId,
				objectIds = { capture.parts[1].sourceObjectId }, durationMs = 1000 })
			assert(pending() == nil)
			local state = f.global.PotassiumMcp
			assert(state.mapSnapshots.resources().activeHolds == 1 and state.mapSnapshots.resources().totalParts == 2)
			if boundary == "socket" then socket = f.reconnect(socket)
			else f.shared.PotassiumMcpGeneration += 1; f.global.PotassiumMcpGeneration = f.shared.PotassiumMcpGeneration end
			f.scheduler.advance(2)
			assert(pending() == nil and state.requestCounts.read == 0 and #state.mapSnapshots.order == 0)
			assert(state.mapSnapshots.resources().activeHolds == 0 and state.mapSnapshots.resources().totalParts == 0)
			f.teardown()
		end
	end)
	check("map snapshot response loss rolls back retained ownership", function()
		local f = fixture()
		f.typedFacilities()
		f.geometryPart("Platform")
		local socket = f.boot()
		f.authenticate(socket)
		socket.beforeSend = function(message)
			if message.type == "response" and message.result and message.result.sourceSnapshotId then error("fixture response loss") end
		end
		f.begin(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		local flow = f.global.PotassiumMcp.mapSnapshots
		assert(#flow.order == 0 and flow.count == 0 and flow.bytes == 0 and next(flow.reverse) == nil)
		f.teardown()
	end)
	check("map probe bounds downward grid and excludes only the local character", function()
		local f = fixture()
		local vector = f.typedFacilities()
		local player = f.instance("Viewer", "Player", f.environment.game)
		local character = f.instance("Character", "Model", f.workspace)
		player.Character = character
		f.services.Players.LocalPlayer = player
		local rays = {}
		f.workspace.Raycast = function(_, origin, direction, params)
			assert(direction.X == 0 and direction.Y == -12 and direction.Z == 0)
			assert(params.FilterType == "Exclude" and params.FilterDescendantsInstances[1] == character)
			table.insert(rays, origin)
			return nil
		end
		local socket = f.boot()
		f.authenticate(socket)
		local args = { center = { x = 2, y = 3, z = 4 }, size = { x = 8, y = 6, z = 10 },
			columns = 2, rows = 2, maxDistance = 12 }
		local result = f.request(socket, "map_probe", args)
		assert(#rays == 4 and rays[1].X == -2 and rays[1].Y == 6 and rays[1].Z == -1)
		assert(rays[4].X == 6 and rays[4].Z == 9 and result.samples[4].column == 1 and result.samples[4].row == 1)
		assert(result.samples[1].column == 0 and result.samples[1].row == 0)
		assert(result.coverage == "complete" and not result.samples[1].hit)
		args.columns = 9; f.reject(socket, "map_probe", args)
		args.columns = 2; args.size.x = 0; f.reject(socket, "map_probe", args)
		assert(#rays == 4)
		f.teardown()
	end)
	if options.jsonEncode then
		check("map sampling and probing stop within actual encoded byte ceilings", function()
			local f = fixture()
			f.typedFacilities()
			f.geometryPart("Platform")
			f.workspace.Raycast = function() return nil end
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
			local observed = f.request(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId,
				objectIds = { capture.parts[1].sourceObjectId }, durationMs = 1000, intervalMs = 50, _maxResultBytes = 2048 })
			assert(#options.jsonEncode(observed) <= 2048 and observed.tracks[1].unavailable == "sample-byte-limit")
			local probe = f.request(socket, "map_probe", { center = { x = 0, y = 0, z = 0 },
				size = { x = 8, y = 8, z = 8 }, columns = 8, rows = 8, _maxResultBytes = 1024 })
			assert(#options.jsonEncode(probe) <= 1024 and probe.truncated and #probe.samples < 64)
			f.teardown()
		end)
	end
	check("map capture bounds retention and captures guarded physics without HRP body-size fiction", function()
		local f = fixture()
		local vector = f.typedFacilities()
		local player = f.instance("Viewer", "Player", f.environment.game)
		local character = f.instance("Character", "Model", f.workspace)
		player.Character = character
		f.services.Players.LocalPlayer = player
		f.geometryPart("HumanoidRootPart", character)
		local humanoid = f.instance("Humanoid", "Humanoid", character)
		humanoid.WalkSpeed, humanoid.JumpPower, humanoid.JumpHeight, humanoid.HipHeight = 16, 50, 7.2, 2
		humanoid.UseJumpPower = true
		f.workspace.Gravity = 196.2
		local part = f.geometryPart("Platform")
		part.CanTouch, part.CanQuery, part.Shape, part.Material, part.CollisionGroup = true, false, "Block", "Metal", "Platforms"
		part.AssemblyLinearVelocity, part.AssemblyAngularVelocity = vector(1, 2, 3), vector(0, 1, 0)
		part:SetAttribute("Damage", 10)
		part:SetAttribute("Secret", "never-read")
		local socket = f.boot()
		f.authenticate(socket)
		local first, latest
		for index = 1, 9 do
			latest = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
			first = first or latest
			assert(latest.physics.gravity == 196.2 and latest.physics.jumpPower == 50 and latest.physics.bodySize == nil)
		end
		local row = byName(latest.parts).Platform
		assert(row.canTouch and row.canQuery == false and row.collisionGroup == "Platforms" and row.linearVelocity.x == 1)
		assert(#row.attributes == 1 and row.attributes[1].name == "Damage" and row.attributes[1].value == 10)
		local resources = f.request(socket, "capabilities", {}).resources.mapSnapshots
		assert(resources.snapshots == 8 and resources.parts == 16 and resources.bytes <= 262144)
		f.reject(socket, "map_observe", { sourceSnapshotId = first.sourceSnapshotId, objectIds = { first.parts[1].sourceObjectId } })
		socket = f.reconnect(socket)
		resources = f.request(socket, "capabilities", {}).resources.mapSnapshots
		assert(resources.snapshots == 0 and resources.parts == 0 and resources.bytes == 0)
		f.reject(socket, "map_observe", { sourceSnapshotId = latest.sourceSnapshotId, objectIds = { row.sourceObjectId } })
		f.teardown()
	end)
	check("map snapshot expiry keeps already admitted observation holds accounted until completion", function()
		local f = fixture()
		f.typedFacilities()
		f.geometryPart("Platform")
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		f.scheduler.advance(179)
		local pending = f.begin(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId,
			objectIds = { capture.parts[1].sourceObjectId }, durationMs = 3000 })
		f.scheduler.advance(1.1)
		local resources = f.request(socket, "capabilities", {}).resources.mapSnapshots
		assert(resources.snapshots == 0 and resources.parts == 0 and resources.activeHolds == 1 and resources.totalParts == 1)
		f.reject(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId, objectIds = { capture.parts[1].sourceObjectId } })
		local recaptured = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		assert(recaptured.parts[1].sourceObjectId == capture.parts[1].sourceObjectId)
		f.scheduler.untilTrue(pending)
		assert(pending().ok and #pending().result.tracks[1].samples > 1)
		assert(f.request(socket, "capabilities", {}).resources.mapSnapshots.totalParts == 1)
		f.scheduler.advance(181)
		assert(f.request(socket, "capabilities", {}).resources.mapSnapshots.totalParts == 0)
		f.teardown()
	end)
	check("map optional facts omit redaction expansion and out-of-schema physics", function()
		local f = fixture()
		f.typedFacilities()
		local player = f.instance("abc", "Player", f.environment.game)
		player.Character = f.instance("Character", "Model", f.workspace)
		f.services.Players.LocalPlayer = player
		local humanoid = f.instance("Humanoid", "Humanoid", player.Character)
		humanoid.WalkSpeed, humanoid.JumpPower, humanoid.HipHeight, humanoid.JumpHeight = 1001, 1001, 1001, 10000
		local part = f.geometryPart("Platform")
		local expanding = string.rep("abc", 40)
		part.CollisionGroup, part.tags = expanding, { expanding, "known" }
		part:SetAttribute("Damage", expanding)
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		local row = byName(result.parts).Platform
		assert(row.collisionGroup == nil and #row.tags == 1 and row.tags[1] == "known" and #row.attributes == 0)
		assert(result.physics.walkSpeed == nil and result.physics.jumpPower == nil and result.physics.hipHeight == nil)
		assert(result.physics.jumpHeight == 10000)
		humanoid.WalkSpeed, humanoid.JumpPower, humanoid.HipHeight = 1000, 1000, 1000
		result = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		assert(result.physics.walkSpeed == 1000 and result.physics.jumpPower == 1000 and result.physics.hipHeight == 1000)
		f.teardown()
	end)
	check("map invalid numeric geometry cannot discard valid siblings or leak into tracks", function()
		local f = fixture()
		local vector = f.typedFacilities()
		local valid = f.geometryPart("Valid")
		valid.AssemblyLinearVelocity = vector(1e9 + 1, 0, 0)
		valid.AssemblyAngularVelocity = vector(0, -1e9 - 1, 0)
		f.geometryPart("TooLarge", nil, nil, { 1e6 + 1, 1, 1 })
		f.geometryPart("TooFar", nil, { 1e9 + 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 })
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
		assert(#capture.parts == 1 and capture.parts[1].name == "Valid")
		assert(capture.parts[1].linearVelocity == nil and capture.parts[1].angularVelocity == nil)
		assert(capture.facetCoverage.geometry.coverage == "partial" and table.find(capture.stopReasons, "geometry-unavailable"))
		f.environment.task.delay(0.025, function() valid.Size = vector(1, 1e6 + 1, 1) end)
		local observed = f.request(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId,
			objectIds = { capture.parts[1].sourceObjectId }, durationMs = 100, intervalMs = 50 })
		assert(#observed.tracks[1].samples == 1 and observed.tracks[1].unavailable == "geometry-unavailable")
		assert(observed.coverage == "partial")
		local rays = 0
		f.workspace.Raycast = function()
			rays += 1
			if rays == 1 then
				return { Instance = valid, Position = vector(1e9 + 1, 0, 0), Normal = vector(0, 1, 0), Material = "Metal" }
			end
			return nil
		end
		local probe = f.request(socket, "map_probe", { center = { x = 0, y = 0, z = 0 },
			size = { x = 8, y = 8, z = 8 }, columns = 2, rows = 2 })
		assert(#probe.samples == 3 and probe.samples[1].column == 1 and probe.coverage == "partial")
		assert(table.find(probe.stopReasons, "hit-metadata-unavailable"))
		f.teardown()
	end)
	check("map probes refresh character exclusion after a yielding respawn", function()
		local f = fixture()
		f.typedFacilities()
		local player = f.instance("Viewer", "Player", f.environment.game)
		player.Character = f.instance("Before", "Model", f.workspace)
		f.services.Players.LocalPlayer = player
		local rays, replaced = 0, false
		local originalClock = f.environment.os.clock
		f.environment.os.clock = function() return originalClock() + rays * 0.003 end
		local originalWait = f.environment.task.wait
		f.environment.task.wait = function(delay)
			if rays > 0 and not replaced then
				replaced = true
				player.Character = f.instance("After", "Model", f.workspace)
			end
			return originalWait(delay)
		end
		f.workspace.Raycast = function(_, _, _, params)
			assert(params.FilterDescendantsInstances[1] == player.Character)
			rays += 1
			return nil
		end
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "map_probe", { center = { x = 0, y = 0, z = 0 },
			size = { x = 8, y = 8, z = 8 }, columns = 8, rows = 8 })
		assert(replaced and rays == 64 and result.coverage == "complete")
		f.teardown()
	end)
	check("map health correlations use current selected overlap not names or remote geometry", function()
		for _, mode in ipairs({ "near", "far", "ambiguous", "multiple", "replaced" }) do
			local f = fixture()
			f.typedFacilities()
			local player = f.instance("Viewer", "Player", f.environment.game)
			local character = f.instance("Character", "Model", f.workspace)
			player.Character = character
			f.services.Players.LocalPlayer = player
			local root = f.geometryPart("HumanoidRootPart", character)
			local humanoid = f.instance("Humanoid", "Humanoid", character)
			humanoid.Health = 100
			local near = f.geometryPart("HarmlessName")
			local far = f.geometryPart("KillLava", nil, { 1000, 20, 30, 1, 0, 0, 0, 1, 0, 0, 0, 1 })
			local extra = f.geometryPart("Unselected")
			f.workspace.GetPartsInPart = function(_, queryRoot, params)
				assert(queryRoot == root and params.MaxParts == 16 and params.FilterType == "Include")
				if mode == "ambiguous" then error("geometry unavailable") end
				local hits = {}
				for _, target in ipairs(params.FilterDescendantsInstances) do
					if math.abs(target.Position.X - queryRoot.Position.X) < (target.Size.X + queryRoot.Size.X) / 2 then
						table.insert(hits, target)
					end
				end
				return hits
			end
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "game_context", { uiLimit = 0, remoteLimit = 0 })
			local rows = byName(capture.parts)
			local ids = { rows.HarmlessName.sourceObjectId, rows.KillLava.sourceObjectId }
			if mode == "multiple" then table.insert(ids, rows.Unselected.sourceObjectId) end
			f.environment.task.delay(0.025, function()
				if mode == "far" then near.CFrame = far.CFrame; near.Position = far.Position end
				if mode == "replaced" then
					player.Character = f.instance("Replacement", "Model", f.workspace)
					f.instance("Humanoid", "Humanoid", player.Character).Health = 1
				else humanoid.Health = 75 end
			end)
			local result = f.request(socket, "map_observe", { sourceSnapshotId = capture.sourceSnapshotId,
				objectIds = ids, durationMs = 100, intervalMs = 50 })
			assert(#result.events == 1)
			local event = result.events[1]
			assert(event.association == "spatial-temporal-correlation")
			if mode == "replaced" then assert(event.kind == "respawn" and #event.objectIds == 0)
			else
				assert(event.kind == "health-drop" and event.amount == 25 and event.t >= 0.025)
				if mode == "near" or mode == "multiple" then
					assert(table.find(event.objectIds, rows.HarmlessName.sourceObjectId))
					assert(#event.objectIds == (mode == "multiple" and 2 or 1))
				else assert(#event.objectIds == 0) end
				assert(not table.find(event.objectIds, rows.KillLava.sourceObjectId))
			end
			f.teardown()
		end
	end)

	check("map collision eligibility requires complete actual character-group evidence", function()
		for _, mode in ipairs({ "true", "false", "mixed", "unknown", "truncated", "changed", "error" }) do
			local f = fixture()
			f.typedFacilities()
			local player = f.instance("Viewer", "Player", f.environment.game)
			local character = f.instance("Character", "Model", f.workspace)
			player.Character = character
			f.services.Players.LocalPlayer = player
			local first = f.geometryPart("BodyA", character)
			first.CanCollide, first.CollisionGroup = true, "BodyA"
			local second = f.geometryPart("BodyB", character)
			second.CanCollide, second.CollisionGroup = true, "BodyB"
			local root = f.geometryPart("HumanoidRootPart", character)
			root.CanCollide, root.CollisionGroup = false, "IgnoredRoot"
			local platform = f.geometryPart("Platform")
			platform.CanCollide, platform.CollisionGroup = true, "Platforms"
			if mode == "truncated" then
				for index = 1, 65 do f.instance("Extra" .. index, "Folder", character) end
			elseif mode == "unknown" then second.CollisionGroup = nil end
			local calls = 0
			f.services.PhysicsService = { CollisionGroupsAreCollidable = function(_, target, body)
				calls += 1
				assert(target == "Platforms" and body ~= "IgnoredRoot")
				if mode == "changed" then player.Character = nil end
				if mode == "false" then return false end
				if mode == "mixed" then return body == "BodyA" end
				if mode == "error" then error("fixture matrix unavailable") end
				return true
			end }
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "game_context", { root = "workspace.Platform", uiLimit = 0, remoteLimit = 0 })
			local relation = capture.parts[1].collidesWithCharacter
			if mode == "true" then assert(relation == true and calls == 2)
			elseif mode == "false" then assert(relation == false and calls == 2)
			else assert(relation == nil) end
			if mode == "unknown" or mode == "truncated" then assert(calls == 0) end
			f.teardown()
		end
	end)
	check("remote snapshots page immutable rows and grouped summaries without default references", function()
		local f = fixture()
		local remotes = {}
		for index = 1, 24 do
			local folder = f.instance(string.format("Group%02d", index), "Folder", f.workspace)
			remotes[index] = f.instance("Send", "RemoteEvent", folder)
		end
		local reads, children = 0, f.workspace.GetChildren
		f.workspace.GetChildren = function(self) reads += 1; return children(self) end
		local socket = f.boot()
		f.authenticate(socket)
		local summary = f.request(socket, "remote_inventory", { root = "workspace" })
		assert(summary.coverage == "complete" and summary.retained == 24 and summary.classes.RemoteEvent == 24)
		assert(#summary.groups == 20 and summary.hasMore and summary.nextCursor)
		local second = f.request(socket, "remote_inventory", { snapshotId = summary.snapshotId, cursor = summary.nextCursor })
		assert(#second.groups == 4 and not second.hasMore)
		local first = f.request(socket, "remote_inventory", { snapshotId = summary.snapshotId, view = "rows", limit = 1, fields = { "name" } })
		remotes[1].Name = "RenamedAfterScan"
		local replay = f.request(socket, "remote_inventory", { snapshotId = summary.snapshotId, view = "rows", limit = 1, fields = { "name" } })
		assert(first.results[1].name == "Send" and replay.results[1].name == "Send")
		assert(first.results[1].rowId == replay.results[1].rowId and first.results[1].path == nil)
		assert(reads == 1 and f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.reject(socket, "remote_inventory", { snapshotId = summary.snapshotId, view = "rows", cursor = summary.nextCursor })
		f.reject(socket, "remote_inventory", { snapshotId = summary.snapshotId, nameContains = "different" })
		local nextRows = f.request(socket, "remote_inventory", { snapshotId = summary.snapshotId, view = "rows", cursor = first.nextCursor, limit = 1 })
		assert(nextRows.results[1].rowId ~= first.results[1].rowId and reads == 1)
		f.teardown()
	end)
	check("remote diff follows actual identities and never makes partial absence authoritative", function()
		local f = fixture()
		local left = f.instance("Duplicate", "RemoteEvent", f.workspace)
		local right = f.instance("Duplicate", "RemoteEvent", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local old = f.request(socket, "remote_inventory", { root = "workspace", view = "rows" })
		assert(old.results[1].rowId ~= old.results[2].rowId)
		left.Name = "Moved"
		right:Destroy()
		f.instance("Duplicate", "RemoteEvent", f.workspace)
		local current = f.request(socket, "remote_inventory", { root = "workspace", view = "rows" })
		local diff = f.request(socket, "remote_inventory", { view = "diff", snapshotId = current.snapshotId, compareTo = old.snapshotId, limit = 1 })
		local kinds, count = {}, 0
		while true do
			for _, change in ipairs(diff.results) do kinds[change.kind] = true; count += 1 end
			assert(diff.absenceAuthoritative and diff.comparisonScope == "retained-rows")
			if not diff.hasMore then break end
			diff = f.request(socket, "remote_inventory", { view = "diff", snapshotId = current.snapshotId, compareTo = old.snapshotId, limit = 1, cursor = diff.nextCursor })
		end
		assert(count == 3 and kinds.added and kinds.removed and kinds.changed)
		local partial = f.request(socket, "remote_inventory", { root = "workspace", maxVisited = 1 })
		local uncertain = f.request(socket, "remote_inventory", { view = "diff", snapshotId = current.snapshotId, compareTo = partial.snapshotId })
		assert(uncertain.coverage == "partial" and not uncertain.absenceAuthoritative and uncertain.stopReasons[1] == "compare-visit-limit")
		local incompatible = f.request(socket, "remote_inventory", { root = "workspace", nameContains = "Moved" })
		f.reject(socket, "remote_inventory", { view = "diff", snapshotId = current.snapshotId, compareTo = incompatible.snapshotId })
		f.teardown()
	end)
	check("snapshot references never resolve destroyed rows by a replacement textual path", function()
		local f = fixture()
		local target = f.instance("SamePath", "RemoteEvent", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local snapshot = f.request(socket, "remote_inventory", { root = "workspace", view = "rows" })
		target:Destroy()
		f.instance("SamePath", "RemoteEvent", f.workspace)
		local rows = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, view = "rows", includeReferences = true })
		assert(rows.results[1].referenceUnavailable and rows.results[1].reference == nil)
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0)
		local live = f.request(socket, "remote_inventory", { root = "workspace", view = "rows", includeReferences = true })
		assert(live.results[1].reference)
		assert(f.request(socket, "remote_inventory", { view = "release", snapshotId = live.snapshotId }).released)
		assert(not f.request(socket, "remote_inventory", { view = "release", snapshotId = live.snapshotId }).released)
		local property = f.request(socket, "read_properties", { path = live.results[1].reference, properties = { "Name" } }).properties.Name
		assert(property.ok and property.value == "SamePath")
		f.teardown()
	end)
	check("snapshot row capacity churn TTL and generation cleanup remain bounded", function()
		local f = fixture()
		for index = 1, 530 do f.instance(string.format("Remote%03d", index), "RemoteEvent", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local first = f.request(socket, "remote_inventory", { root = "workspace" })
		assert(first.retained == 512 and first.coverage == "partial" and first.stopReasons[1] == "row-limit")
		local narrowed = f.request(socket, "remote_inventory", { snapshotId = first.snapshotId, query = {} })
		assert(narrowed.queryMatched == 512 and narrowed.classes.RemoteEvent == 512)
		assert(narrowed.matchedVisited == first.matchedVisited and narrowed.coverage == "partial" and narrowed.stopReasons[1] == "row-limit")
		for _ = 1, 20 do
			f.scheduler.advance(0) -- Keep the fixture's authenticated transport alive during cooperative scans.
			f.request(socket, "remote_inventory", { root = "workspace" })
			local resources = f.request(socket, "capabilities", {}).resources.remoteWorkflow
			assert(resources.snapshots <= 8 and resources.snapshotBytes <= 1048576)
		end
		f.reject(socket, "remote_inventory", { snapshotId = first.snapshotId })
		local retained = f.request(socket, "remote_inventory", { root = "workspace", maxVisited = 2 })
		socket = f.reconnect(socket)
		assert(f.request(socket, "remote_inventory", { snapshotId = retained.snapshotId }).snapshotId == retained.snapshotId)
		f.scheduler.advance(121)
		f.reject(socket, "remote_inventory", { snapshotId = retained.snapshotId })
		assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.snapshots == 0)
		f.teardown()
	end)
	if options.jsonEncode then
		check("snapshot byte and traversal work bounds report their distinct partial reasons", function()
			local f = fixture()
			for index = 1, 40 do f.instance(string.rep("n", 4000) .. index, "RemoteEvent", f.workspace) end
			local socket = f.boot()
			f.authenticate(socket)
			local bytes = f.request(socket, "remote_inventory", { root = "workspace" })
			assert(bytes.coverage == "partial" and bytes.stopReasons[1] == "byte-limit" and bytes.retained < 40)
			assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.snapshotBytes <= 262144)
			local node = f.instance("WorkRoot", "Folder", f.workspace)
			-- A repeated child list models a pathological traversal work source
			-- without allocating a hundred thousand fixture instances.
			local child = f.instance("Only", "Folder", node)
			node.GetChildren = function() return table.create(100010, child) end
			local work = f.request(socket, "remote_inventory", { root = "workspace.WorkRoot", maxVisited = 20000 })
			assert(work.coverage == "partial" and work.stopReasons[1] == "work-limit")
			f.teardown()
		end)
	end
	check("detail survives modeled weak-wrapper collection without rescanning rebinding or renewing snapshots", function()
		local f = fixture()
		local collectWrappers = f.modelWeakWrapperCollection()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		target.attributes.Revision = 1
		local socket = f.boot()
		f.authenticate(socket)
		local snapshot = f.request(socket, "remote_inventory", { root = "workspace", view = "rows" })
		local rowId = snapshot.results[1].rowId
		local beforeCollection = f.request(socket, "remote_inventory", { view = "detail", snapshotId = snapshot.snapshotId, rowId = rowId })
		assert(beforeCollection.instance.name == "Send" and byName(beforeCollection.attributes.values).Revision.value == 1)
		collectWrappers()
		target.Name, target.attributes.Revision = "Moved", 2
		local replacement = f.instance("Send", "RemoteEvent", f.workspace)
		replacement.attributes.Revision = 99
		local detail = f.request(socket, "remote_inventory", { view = "detail", snapshotId = snapshot.snapshotId, rowId = rowId })
		assert(detail.snapshotId == snapshot.snapshotId and detail.rowId == rowId and detail.instance.name == "Moved")
		assert(byName(detail.attributes.values).Revision.value == 2 and detail.metadataTiming == "live-non-atomic")
		assert(detail.associationMeaning == "metadata-not-call-arguments" and f.global.PotassiumMcp.instanceReferenceCount == 0)
		local replay = f.request(socket, "remote_inventory", { snapshotId = snapshot.snapshotId, root = "workspace", view = "rows" })
		assert(replay.results[1].name == "Send" and replay.results[1].rowId == rowId)
		assert(target:ListenerCount() == 0 and f.workspace:ListenerCount() == 0, "snapshot identity ownership must not allocate listeners")
		target.Parent = nil
		f.reject(socket, "remote_inventory", { view = "detail", snapshotId = snapshot.snapshotId, rowId = rowId })
		target.Parent = f.workspace
		f.scheduler.advance(119)
		assert(f.request(socket, "remote_inventory", { view = "detail", snapshotId = snapshot.snapshotId, rowId = rowId }).instance.name == "Moved")
		target:Destroy()
		f.instance("Moved", "RemoteEvent", f.workspace)
		f.reject(socket, "remote_inventory", { view = "detail", snapshotId = snapshot.snapshotId, rowId = rowId })
		local fresh = f.request(socket, "remote_inventory", { view = "detail", root = "workspace.Send" })
		assert(byName(fresh.attributes.values).Revision.value == 99 and fresh.snapshotId == nil)
		assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.snapshots == 1)
		f.scheduler.advance(2)
		f.reject(socket, "remote_inventory", { view = "detail", snapshotId = snapshot.snapshotId, rowId = rowId })
		local resources = f.request(socket, "capabilities", {}).resources
		assert(resources.remoteWorkflow.snapshots == 0 and resources.remoteWorkflow.snapshotBytes == 0)
		assert(resources.references.total == 0 and resources.connections.reference == 0, "expired snapshots must leave no reference resources")
		f.teardown()
	end)
	check("detail masks sensitive named values and describes ObjectValues without target references or traversal", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local object = f.instance("Destination", "Folder", f.workspace)
		object.GetChildren = function() error("ObjectValue targets must not be traversed") end
		target.attributes.Enabled, target.attributes.Count = false, 7
		target.attributes.Password, target.attributes.ApiKey = "opaque-private-value", 314159
		target.attributes.Link = "https://private.example/payload"
		target.attributes["Bearer fixture-private-attribute-name"] = "private-associated-value"
		local enabled = f.instance("Enabled", "BoolValue", target)
		enabled.Value = false
		local linked = f.instance("Destination", "ObjectValue", target)
		linked.Value = object
		local hidden = f.instance("SessionToken", "ObjectValue", target)
		hidden.Value = object
		local password = f.instance("Password", "IntValue", target)
		password.Value = 271828
		local sibling = f.instance("Balance", "NumberValue", f.workspace)
		sibling.Value = 15
		local nested = f.instance("NotAnAssociation", "Folder", target)
		nested.GetChildren = function() error("detail must not recursively inspect children") end
		local socket = f.boot()
		f.authenticate(socket)
		local baseline = f.connectionCounters().active
		local detail = f.request(socket, "remote_inventory", { view = "detail", root = "workspace.Send" })
		local attributes, children = byName(detail.attributes.values), byName(detail.valueAssociations.children)
		assert(attributes.Enabled.ok and attributes.Enabled.value == false and attributes.Count.value == 7)
		assert(attributes.Password.redacted and attributes.ApiKey.redacted)
		assert(children.Enabled.value.ok and children.Enabled.value.value == false)
		assert(children.Destination.value.ok and children.Destination.value.value.type == "Instance")
		assert(children.Destination.value.value.name == "Destination" and children.Destination.value.value.reference == nil)
		assert(children.SessionToken.value.redacted and children.Password.value.redacted and children.NotAnAssociation == nil)
		assert(not detail.valueAssociations.siblingsRequested and #detail.valueAssociations.siblings == 0)
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0 and f.connectionCounters().active == baseline)
		assertPrivateTree(detail, { object, 314159, 271828 }, {
			"opaque-private-value", "private.example", "fixture-private-attribute-name", "private-associated-value",
		})
		local selected = f.request(socket, "remote_inventory", {
			view = "detail", root = "workspace.Send", attributeNames = { "Enabled", "Missing" }, includeSiblingValues = true,
		})
		assert(byName(selected.attributes.values).Enabled.value == false and byName(selected.attributes.values).Count == nil)
		assert(selected.valueAssociations.siblingsRequested and selected.valueAssociations.siblingMeaning == "shared-parent-only")
		assert(byName(selected.valueAssociations.siblings).Balance.value.value == 15)
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0 and object.Destroying:Count() == 0)
		f.teardown()
	end)
	check("detail shares association and traversal limits and bounds discovered attributes", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		for index = 1, 40 do target.attributes[string.format("Field%02d", index)] = index end
		f.instance("Child", "IntValue", target).Value = 1
		for index = 1, 3 do f.instance("Sibling" .. index, "IntValue", f.workspace).Value = index end
		local socket = f.boot()
		f.authenticate(socket)
		local detail = f.request(socket, "remote_inventory", { view = "detail", root = "workspace.Send", includeSiblingValues = true, limit = 2 })
		assert(#detail.attributes.values == 32 and detail.attributes.truncated)
		assert(#detail.valueAssociations.children + #detail.valueAssociations.siblings == 2)
		assert(detail.truncated and detail.coverage == "partial" and #detail.stopReasons > 0)
		local visited = f.request(socket, "remote_inventory", { view = "detail", root = "workspace.Send", includeSiblingValues = true, maxVisited = 1 })
		assert(visited.visited <= 1 and visited.truncated and visited.coverage == "partial")
		assert(f.global.PotassiumMcp.instanceReferenceCount == 0)
		f.teardown()
	end)
	if options.jsonEncode then
		check("detail serialized bytes share one budget and omitted associations acquire no references", function()
			local f = fixture()
			local target = f.instance("Send", "RemoteEvent", f.workspace)
			for index = 1, 32 do target.attributes["Field" .. index] = string.rep("\1", 4096) end
			for index = 1, 50 do f.instance("Value" .. index, "StringValue", target).Value = string.rep("\2", 4096) end
			local socket = f.boot()
			f.authenticate(socket)
			local detail = f.request(socket, "remote_inventory", { view = "detail", root = "workspace.Send", limit = 50, _maxResultBytes = 8192 })
			assert(#options.jsonEncode(detail) <= 8192 and detail.truncated and detail.coverage == "partial")
			assert(f.global.PotassiumMcp.instanceReferenceCount == 0 and target:ListenerCount() == 0)
			f.teardown()
		end)
	end
	check("detail validates its complete selection before reading metadata or allocating resources", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local reads, attributes = 0, target.GetAttributes
		target.GetAttributes = function(self) reads += 1; return attributes(self) end
		local socket = f.boot()
		f.authenticate(socket)
		f.reject(socket, "remote_inventory", { view = "detail" })
		f.reject(socket, "remote_inventory", { view = "detail", root = "workspace" })
		f.reject(socket, "remote_inventory", { view = "detail", root = "workspace.Send", fields = { "name" } })
		f.reject(socket, "remote_inventory", { view = "detail", root = "workspace.Send", nameContains = "Send" })
		f.reject(socket, "remote_inventory", { view = "detail", root = "workspace.Send", attributeNames = table.create(33, "Enabled") })
		f.reject(socket, "remote_inventory", { root = "workspace", rowId = "unscoped" })
		assert(reads == 0 and f.global.PotassiumMcp.instanceReferenceCount == 0)
		assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.snapshots == 0)
		f.teardown()
	end)
	check("capture missing prerequisites and invalid target batches never install a wrapper", function()
		local f = fixture()
		f.instance("Send", "RemoteEvent", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local availability = f.request(socket, "capabilities", {}).remoteCapture
		assert(availability.available and availability.inboundAvailable and not availability.outboundAvailable)
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		f.teardown()
		local configured = fixture()
		configured.instance("Send", "RemoteEvent", configured.workspace)
		local original = function() return "original" end
		local native = configured.namecallFacilities(original)
		socket = configured.boot()
		configured.authenticate(socket)
		configured.reject(socket, "remote_capture_start", { targets = { "workspace.Send", "workspace" } })
		assert(native.installs == 0 and native.metatable.__namecall == original)
		native.failClosure = true
		configured.reject(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		assert(native.metatable.__namecall == original and native.readonly)
		native.failClosure = false
		native.failReadonly = true
		configured.reject(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		assert(native.metatable.__namecall == original and native.readonly)
		native.failReadonly = false
		native.failRestoreOnce = true
		configured.reject(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		assert(native.metatable.__namecall == original and native.readonly)
		local capture = configured.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		native.failRestoreOnce = true
		assert(configured.request(socket, "remote_capture_stop", { captureId = capture.captureId }).hookCleanup == "restored")
		assert(native.metatable.__namecall == original and native.readonly)
		configured.teardown()
	end)
	check("simulated capture forwards identity nil arity returns errors and yielding unchanged", function()
		for _, includeValueExamples in ipairs({ false, true }) do
		local f = fixture()
		local target = f.instance("Invoke", "RemoteFunction", f.workspace)
		local calls, operation = 0, "return"
		local secret = setmetatable({}, { __index = function() error("must not inspect argument") end, __tostring = function() error("must not stringify argument") end })
		local failure = {}
		local original = function(self, ...)
			calls += 1
			assert(self == target and select("#", ...) == 3 and select(1, ...) == secret and select(2, ...) == nil)
			if operation == "error" then error(failure, 0) end
			if operation == "yield" then coroutine.yield("fixture-yield") end
			return secret, nil, false, nil
		end
		local native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Invoke" }, includeValueExamples = includeValueExamples })
		local returned = table.pack(native.call("InvokeServer", target, secret, nil, nil))
		assert(returned.n == 4 and returned[1] == secret and returned[2] == nil and returned[3] == false and returned[4] == nil)
		operation = "error"
		local ok, value = pcall(native.call, "InvokeServer", target, secret, nil, nil)
		assert(not ok and value == failure)
		operation = "yield"
		local thread = coroutine.create(function() return native.call("InvokeServer", target, secret, nil, nil) end)
		local resumed = table.pack(coroutine.resume(thread))
		assert(resumed[1] and resumed[2] == "fixture-yield" and coroutine.status(thread) == "suspended")
		assert(f.request(socket, "remote_capture_stop", { captureId = capture.captureId }).state == "stopped")
		resumed = table.pack(coroutine.resume(thread))
		assert(resumed.n == 5 and resumed[1] and resumed[2] == secret and resumed[4] == false and coroutine.status(thread) == "dead")
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "events" })
		assert(calls == 3 and poll.observed == 3 and #poll.groups == 1 and poll.groups[1].count == 3)
		assert(poll.events[1].argc == 3 and poll.events[1].argumentTypes[1] == "table" and poll.events[1].argumentTypes[3] == "nil")
		assert(poll.recordsValues == includeValueExamples and not poll.recordsReturns and not poll.nativeSemanticsVerified)
		assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { secret, failure })
		local profiles = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		if includeValueExamples then
			local example = profiles.profiles[1].examples[1]
			assert(example.argc == 3 and #example.arguments == 3 and example.arguments[2].type == "nil" and example.arguments[3].type == "nil")
			assert(example.count == 3)
		else
			assert(profiles.profiles[1].exampleCount == 0 and #profiles.profiles[1].examples == 0)
		end
		f.teardown()
		assert(native.metatable.__namecall == original)
		end
	end)
	check("capture filters targets and methods while sharing a single bounded replayable hook", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local other = f.instance("Other", "RemoteEvent", f.workspace)
		local calls = 0
		local original = function() calls += 1; return calls end
		local native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send", "workspace.Send" }, maxEvents = 3 })
		local second = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		assert(native.installs == 1 and capture.targets == nil and capture.groups == nil)
		assert(#f.request(socket, "remote_capture_poll", { captureId = capture.captureId }).targets == 1)
		native.call("FireServer", other, "not selected")
		native.call("InvokeServer", target, "wrong class method")
		for index = 1, 8 do native.call("FireServer", target, index, nil) end
		local page = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "events", limit = 1 })
		assert(page.observed == 8 and page.retained == 3 and page.dropped.events == 5 and page.droppedAfter == 5)
		assert(page.events[1].sequence == 6 and page.nextAfter == 6 and page.hasMore)
		local replay = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "events", limit = 1 })
		assert(replay.events[1].sequence == 6 and replay.nextAfter == page.nextAfter)
		local nextPage = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "events", after = page.nextAfter })
		assert(#nextPage.events == 2 and nextPage.nextAfter == 8 and not nextPage.hasMore and calls == 10)
		f.reject(socket, "remote_capture_poll", { captureId = capture.captureId, after = 9 })
		f.request(socket, "remote_capture_stop", { captureId = capture.captureId })
		assert(native.metatable.__namecall ~= original)
		native.call("FireServer", target)
		assert(f.request(socket, "remote_capture_poll", { captureId = second.captureId }).observed == 9)
		assert(f.request(socket, "remote_capture_stop", { captureId = capture.captureId }).state == "stopped")
		f.request(socket, "remote_capture_stop", { captureId = second.captureId })
		assert(native.metatable.__namecall == original)
		f.teardown()
	end)
	check("capture default remains value-free without retaining raw arguments anywhere in capture state", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local payload = { Hidden = "default-private-argument" }
		local callback = function() return "default-private-function" end
		local native = f.namecallFacilities(function() return "private-return-never-captured" end)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, maxEvents = 1 })
		native.call("FireServer", target, payload, callback, nil)
		payload.Hidden = "mutated-default-private-argument"
		native.call("FireServer", target, payload, callback, nil)
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		assert(not poll.recordsValues and not poll.recordsReturns and not poll.incomingCalls and poll.incomingRemoteFunctions == false)
		assert(poll.coverage == "selected-outbound-namecall-only" and poll.observed == 2 and poll.retained == 1)
		assert(poll.profiles[1].count == 2 and poll.profiles[1].exampleCount == 0 and #poll.profiles[1].examples == 0)
		assert(poll.profiles[1].argc == 3 and poll.profiles[1].argumentTypes[3] == "nil")
		assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { payload, callback }, {
			"default-private-argument", "default-private-function", "private-return-never-captured",
		})
		f.teardown()
	end)
	check("profiles sanitize before retention and deduplicate sanitized examples rather than private source values", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		f.environment.game.JobId = "fixture-job-identifier"
		f.services.Players.LocalPlayer = { Name = "FixtureUser", DisplayName = "Fixture Display", UserId = 24681357 }
		local native = f.namecallFacilities(function() return "never-retain-server-return" end)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", {
			targets = { "workspace.Send" }, includeValueExamples = true, maxExamplesPerVariant = 2, maxEvents = 1,
		})
		local first = { Amount = 7, Password = "private-one", ApiKey = 31415 }
		local second = table.clone(first)
		second.Password, second.ApiKey = "private-two", 27182
		native.call("FireServer", target, first, nil)
		f.scheduler.advance(0.125)
		native.call("FireServer", target, second, nil)
		native.call("FireServer", target, "FixtureUser Fixture Display fixture-job-identifier " .. string.rep("t", 32))
		native.call("FireServer", target, "https://private.example/route", nil)
		native.call("FireServer", target, 24681357, nil, nil)
		native.call("FireServer", target, { ["Bearer private-key"] = "private-named-value" })
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		local profile, example = poll.profiles[1], poll.profiles[1].examples[1]
		assert(poll.recordsValues and not poll.recordsReturns and poll.dropped.examples == 0)
		assert(profile.direction == "outbound" and profile.method == "FireServer" and profile.argc == 2 and profile.count == 2)
		assert(profile.firstSeenMs == 0 and profile.lastSeenMs == 125 and profile.exampleCount == 1)
		assert(example.count == 2 and example.firstSeenMs == 0 and example.lastSeenMs == 125 and example.arguments[2].type == "nil")
		assert(entryValue(example.arguments[1], "Amount").value == 7)
		assert(entryValue(example.arguments[1], "Password").redacted and entryValue(example.arguments[1], "ApiKey").redacted)
		assert(poll.profiles[4].examples[1].arguments[1].redacted)
		assertPrivateTree(poll, { first, second, 31415, 27182, 24681357 }, {
			"private-one", "private-two", "FixtureUser", "Fixture Display", "fixture-job-identifier", string.rep("t", 32),
			"private.example", "private-key", "private-named-value", "never-retain-server-return",
		})
		assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { first, second })
		local summary = f.request(socket, "remote_capture_poll", { captureId = capture.captureId })
		assert(summary.groups[1].exampleCount == 1 and summary.groups[1].examples == nil and summary.profiles == nil)
		f.teardown()
	end)
	check("value profiles copy raw tables before original mutation without invoking engine or metamethod code", function()
		local f = fixture()
		local vector = f.typedFacilities()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local observing, trapped, engineCalls, originals = false, 0, 0, 0
		local function trap() trapped += 1; error("untrusted metamethod entered", 0) end
		local payload = setmetatable({ n = 7, t = { f = false } }, {
			__index = trap, __newindex = trap, __len = trap, __iter = trap, __tostring = trap,
		})
		local opaque = vector(1, 2, 3)
		setmetatable(opaque, { __index = trap, __tostring = trap, __iter = trap })
		local callback, thread = function() return "private-callback" end, coroutine.create(function() end)
		local native = f.namecallFacilities(function(self, value, ...)
			observing = false
			originals += 1
			assert(self == target and value == payload and select("#", ...) == 4)
			rawset(value, "n", 99)
			value.t.f = true
			return nil, false, nil
		end)
		local http, game = f.services.HttpService, f.environment.game
		local encode, service, readfile = http.JSONEncode, game.GetService, f.environment.readfile
		http.JSONEncode = function(self, value)
			if observing then engineCalls += 1; error("hook entered JSON", 0) end
			return encode(self, value)
		end
		game.GetService = function(self, name)
			if observing then engineCalls += 1; error("hook entered engine service", 0) end
			return service(self, name)
		end
		f.environment.readfile = function(path)
			if observing then engineCalls += 1; error("hook entered filesystem", 0) end
			return readfile(path)
		end
		setmetatable(f.services.Players, { __index = function(_, key)
			if observing then engineCalls += 1; error("hook read player identity", 0) end
			return nil
		end })
		local gameMetatable, jobId = getmetatable(game), game.JobId
		local gameIndex = gameMetatable.__index
		rawset(game, "JobId", nil)
		gameMetatable.__index = function(self, key)
			if key == "JobId" then
				if observing then engineCalls += 1; error("hook read JobId", 0) end
				return jobId
			end
			return gameIndex(self, key)
		end
		for name, facility in pairs(f.environment.crypt) do
			f.environment.crypt[name] = function(...)
				if observing then engineCalls += 1; error("hook entered crypto", 0) end
				return facility(...)
			end
		end
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, includeValueExamples = true })
		target.GetFullName = trap
		target.IsA = trap
		observing = true
		local returned = table.pack(native.call("FireServer", target, payload, opaque, callback, thread, nil))
		assert(returned.n == 3 and returned[1] == nil and returned[2] == false and returned[3] == nil)
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		local arguments = poll.profiles[1].examples[1].arguments
		assert(originals == 1 and trapped == 0 and engineCalls == 0 and poll.dropped.observationErrors == 0)
		assert(entryValue(arguments[1], "n").value == 7 and entryValue(entryValue(arguments[1], "t"), "f").value == false)
		assert(arguments[2].type == "Vector3" and next(arguments[2], "type") == nil)
		assert(arguments[3].type == "function" and arguments[4].type == "thread" and arguments[5].type == "nil")
		assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { payload, payload.t, opaque, callback, thread })
		f.teardown()
	end)
	check("profile examples bound cycles depth strings entry counts and full argument arity", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, includeValueExamples = true, maxExamplesPerVariant = 3 })
		local cycle, deep, wide = {}, { Child = { Child = { Value = "unreachable-private-depth" } } }, {}
		cycle.Self = cycle
		for index = 1, 100 do wide[index] = index end
		local long = string.rep("overlong-private-source", 1000)
		native.call("FireServer", target, cycle, deep)
		native.call("FireServer", target, long, math.huge, 0 / 0)
		native.call("FireServer", target, wide)
		native.call("FireServer", target, false, false, false, false, false, false, false, nil, "ninth-private-argument", nil)
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		local recursive = poll.profiles[1].examples[1]
		assert(recursive.truncated and entryValue(recursive.arguments[1], "Self").omitted == "cycle")
		assert(entryValue(entryValue(recursive.arguments[2], "Child"), "Child").omitted == "depth-limit")
		local scalars = poll.profiles[2].examples[1].arguments
		assert(scalars[1].omitted == "string-limit" and scalars[2].omitted == "non-finite" and scalars[3].omitted == "non-finite")
		local wideExample = poll.profiles[3].examples[1]
		assert(wideExample.truncated and wideExample.arguments[1].truncated and #wideExample.arguments[1].entries <= 8)
		local profile, example = poll.profiles[4], poll.profiles[4].examples[1]
		assert(profile.argc == 10 and profile.typesTruncated and #profile.argumentTypes == 8 and example.argc == 10 and #example.arguments == 8)
		assert(example.truncated and example.arguments[8].type == "nil")
		assertPrivateTree(poll, { cycle, deep, wide }, { "overlong-private-source", "unreachable-private-depth", "ninth-private-argument" })
		assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { cycle, deep, wide })
		if options.jsonEncode then
			for _, profile in ipairs(poll.profiles) do assert(#options.jsonEncode(profile.examples[1]) <= 1024) end
		end
		f.teardown()
	end)
	check("sensitive overlong and unsupported table keys never inspect or retain their associated values", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local hidden, longHidden, unsupportedHidden = { private = "private-sensitive-child" }, { private = "private-long-key-child" }, { private = "private-opaque-key-child" }
		local visits, traps = 0, 0
		local opaqueKey = setmetatable({}, { __tostring = function() traps += 1; error("opaque key stringification") end })
		local longKey = string.rep("private-overlong-key", 1000)
		local payload = { Safe = false, Password = hidden, [longKey] = longHidden, [opaqueKey] = unsupportedHidden }
		f.environment.next = function(value, key)
			if rawequal(value, hidden) or rawequal(value, longHidden) or rawequal(value, unsupportedHidden) then
				visits += 1
				error("masked or unsupported association traversed", 0)
			end
			return next(value, key)
		end
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, includeValueExamples = true })
		native.call("FireServer", target, payload)
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		local example = poll.profiles[1].examples[1]
		assert(poll.state == "active" and poll.observed == 1 and poll.dropped.observationErrors == 0 and visits == 0 and traps == 0)
		assert(example.truncated and example.arguments[1].truncated)
		assert(entryValue(example.arguments[1], "Password").redacted and entryValue(example.arguments[1], "Safe").value == false)
		assertPrivateTree(poll, { payload, hidden, longHidden, opaqueKey, unsupportedHidden }, {
			"private-sensitive-child", "private-long-key-child", "private-opaque-key-child", "private-overlong-key",
		})
		assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { payload, hidden, longHidden, opaqueKey, unsupportedHidden })
		f.teardown()
	end)
	if options.jsonEncode and options.jsonDecode then
		check("malformed UTF8 sample strings and keys are omitted while valid Unicode survives real JSON", function()
			local f = fixture()
			local target = f.instance("Send", "RemoteEvent", f.workspace)
			local invalid = {
				string.char(128), -- Continuation byte without a leading byte.
				string.char(226, 130), -- Truncated three-byte code point.
				string.char(192, 175), -- Overlong encoding.
				string.char(237, 160, 128), -- UTF-16 surrogate, not a Unicode scalar.
				string.char(244, 144, 128, 128), -- Beyond the Unicode scalar range.
			}
			local valid = utf8.char(0xE9, 0x6F22)
			local hidden, visits = { private = "invalid-key-private-value" }, 0
			local payload = { [invalid[1]] = hidden, [valid] = valid }
			f.environment.next = function(value, key)
				if rawequal(value, hidden) then visits += 1; error("invalid-key associated value traversed", 0) end
				return next(value, key)
			end
			local native = f.namecallFacilities(function() return true end)
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, includeValueExamples = true })
			for _, value in ipairs(invalid) do native.call("FireServer", target, value, nil) end
			native.call("FireServer", target, valid, nil)
			native.call("FireServer", target, payload)
			local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
			local strings, keyed = poll.profiles[1], poll.profiles[2].examples[1]
			assert(poll.state == "active" and poll.observed == 7 and poll.dropped.observationErrors == 0 and visits == 0)
			assert(strings.exampleCount == 2 and strings.examples[1].count == 5 and strings.examples[1].truncated)
			assert(strings.examples[1].arguments[1].omitted == "invalid-utf8" and strings.examples[1].arguments[1].value == nil)
			assert(strings.examples[2].arguments[1].value == valid and strings.examples[2].arguments[2].type == "nil")
			assert(keyed.truncated and keyed.arguments[1].truncated and entryValue(keyed.arguments[1], valid).value == valid)
			local forbidden = table.clone(invalid)
			table.insert(forbidden, "invalid-key-private-value")
			assertPrivateTree(poll, { payload, hidden }, forbidden)
			assertPrivateTree(f.global.PotassiumMcp.remoteWorkflow.captures, { payload, hidden }, forbidden)
			local decoded = options.jsonDecode(options.jsonEncode(poll))
			assert(decoded.profiles[1].examples[1].arguments[1].omitted == "invalid-utf8")
			assert(decoded.profiles[1].examples[2].arguments[1].value == valid and decoded.observed == 7)
			f.teardown()
		end)
	end
	check("profile sample caps preserve cumulative groups and count dropped distinct examples", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", {
			targets = { "workspace.Send" }, includeValueExamples = true, maxExamplesPerVariant = 2, maxEvents = 1,
		})
		native.call("FireServer", target, 1)
		native.call("FireServer", target, 2)
		native.call("FireServer", target, 1)
		native.call("FireServer", target, 3)
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		local profile = poll.profiles[1]
		assert(poll.observed == 4 and poll.retained == 1 and profile.count == 4 and profile.exampleCount == 2 and poll.dropped.examples == 1)
		assert(profile.examples[1].arguments[1].value == 1 and profile.examples[1].count == 2)
		assert(profile.examples[2].arguments[1].value == 2 and profile.examples[2].count == 1)
		local replay = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		assert(replay.profiles[1].examples[1].count == 2 and replay.dropped.examples == 1)
		f.teardown()
	end)
	check("exhausted sample attempts stop raw value traversal without stopping metadata observations", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local payload, traversals = { Amount = 7 }, 0
		f.environment.next = function(value, key)
			if rawequal(value, payload) then traversals += 1 end
			return next(value, key)
		end
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", {
			targets = { "workspace.Send" }, includeValueExamples = true, maxEvents = 1,
		})
		for _ = 1, 200 do native.call("FireServer", target, payload) end
		local before = traversals
		payload.Amount = 99
		for _ = 1, 3 do native.call("FireServer", target, payload) end
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		assert(before > 0 and traversals == before and poll.observed == 203 and poll.profiles[1].count == 203)
		assert(poll.profiles[1].examples[1].count == 200 and poll.profiles[1].exampleCount == 1 and poll.dropped.examples == 3)
		assert(poll.exampleSampling.attempts == 200 and poll.exampleSampling.maxAttempts == 200 and poll.exampleSampling.truncated)
		assert(entryValue(poll.profiles[1].examples[1].arguments[1], "Amount").value == 7)
		f.teardown()
	end)
	check("inbound-only capture needs no native hook and never replaces RemoteFunction callbacks", function()
		local f = fixture()
		local event = f.instance("Event", "RemoteEvent", f.workspace)
		local unreliable = f.instance("Unreliable", "UnreliableRemoteEvent", f.workspace)
		local remoteFunction = f.instance("Function", "RemoteFunction", f.workspace)
		local invocations, foreignEvents = 0, 0
		local callback = function() invocations += 1; return "existing-callback" end
		remoteFunction.OnClientInvoke = callback
		local foreign = event.OnClientEvent:Connect(function() foreignEvents += 1 end)
		local socket = f.boot()
		f.authenticate(socket)
		local baseline = f.connectionCounters().active
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Function" }, directions = { "inbound" } })
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Event", "workspace" }, directions = { "inbound" } })
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Event" }, directions = { "inbound", "inbound" } })
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Event" }, directions = {} })
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Event" }, directions = { "inbound" }, maxExamplesPerVariant = 2 })
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Event" }, directions = { "inbound" }, includeValueExamples = true, maxExamplesPerVariant = 4 })
		assert(f.connectionCounters().active == baseline and remoteFunction.OnClientInvoke == callback)
		local capture = f.request(socket, "remote_capture_start", {
			targets = { "workspace.Event", "workspace.Unreliable", "workspace.Function" },
			directions = { "inbound" }, includeValueExamples = true,
		})
		assert(event.OnClientEvent:Count() == 2 and unreliable.OnClientEvent:Count() == 1)
		event.OnClientEvent:Fire("received", nil, false)
		unreliable.OnClientEvent:Fire(7)
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		assert(poll.coverage == "selected-inbound-events-only" and poll.incomingCalls and not poll.incomingRemoteFunctions)
		assert(poll.recordsValues and not poll.recordsReturns and not poll.directMethodCalls and poll.observed == 2)
		assert(#poll.unsupportedInboundTargets == 1 and remoteFunction.OnClientInvoke == callback and invocations == 0)
		for _, profile in ipairs(poll.profiles) do
			assert(profile.direction == "inbound" and profile.method == "OnClientEvent" and profile.count == 1)
			if profile.argc == 3 then
				assert(profile.examples[1].arguments[1].value == "received" and profile.examples[1].arguments[2].type == "nil")
				assert(profile.examples[1].arguments[3].value == false)
			end
		end
		f.request(socket, "remote_capture_stop", { captureId = capture.captureId })
		assert(event.OnClientEvent:Count() == 1 and unreliable.OnClientEvent:Count() == 0)
		event.OnClientEvent:Fire()
		assert(foreignEvents == 2 and remoteFunction.OnClientInvoke == callback and invocations == 0)
		foreign:Disconnect()
		f.teardown()
	end)
	check("capture startup rolls back only acquired inbound listeners on late subscription or hook failure", function()
		local f = fixture()
		local first = f.instance("First", "RemoteEvent", f.workspace)
		local second = f.instance("Second", "UnreliableRemoteEvent", f.workspace)
		local original = function() return true end
		local native = f.namecallFacilities(original)
		local foreign = first.OnClientEvent:Connect(function() end)
		local socket = f.boot()
		f.authenticate(socket)
		local baseline = f.connectionCounters().active
		second.OnClientEvent.failConnect = true
		f.reject(socket, "remote_capture_start", { targets = { "workspace.First", "workspace.Second" }, directions = { "inbound" } })
		assert(first.OnClientEvent:Count() == 1 and second.OnClientEvent:Count() == 0 and f.connectionCounters().active == baseline)
		assert(native.installs == 0 and native.metatable.__namecall == original)
		second.OnClientEvent.failConnect = false
		native.failClosure = true
		f.reject(socket, "remote_capture_start", { targets = { "workspace.First", "workspace.Second" }, directions = { "outbound", "inbound" } })
		assert(first.OnClientEvent:Count() == 1 and second.OnClientEvent:Count() == 0 and f.connectionCounters().active == baseline)
		assert(native.metatable.__namecall == original and f.global.PotassiumMcp.remoteWorkflow.activeCaptures == 0)
		foreign:Disconnect()
		f.teardown()
	end)
	check("direction profiles remain independent and inbound-only survivors never retain the last outbound hook", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local calls = 0
		local original = function() calls += 1; return calls end
		local native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		local mixed = f.request(socket, "remote_capture_start", {
			targets = { "workspace.Send" }, directions = { "outbound", "inbound" }, includeValueExamples = true,
		})
		local outbound = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		local inbound = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, directions = { "inbound" } })
		native.call("FireServer", target, 7)
		target.OnClientEvent:Fire(7)
		f.scheduler.advance(0.25)
		native.call("FireServer", target, 7)
		target.OnClientEvent:Fire(7)
		local poll = f.request(socket, "remote_capture_poll", { captureId = mixed.captureId, view = "profiles" })
		assert(poll.coverage == "selected-outbound-namecall-and-inbound-events" and poll.observed == 4 and #poll.profiles == 2)
		local directions = {}
		for _, profile in ipairs(poll.profiles) do
			directions[profile.direction] = true
			assert(profile.count == 2 and profile.firstSeenMs == 0 and profile.lastSeenMs == 250)
			assert(profile.examples[1].count == 2 and profile.examples[1].arguments[1].value == 7)
		end
		assert(directions.outbound and directions.inbound and calls == 2)
		socket = f.reconnect(socket)
		target.OnClientEvent:Fire(7)
		assert(f.request(socket, "remote_capture_poll", { captureId = inbound.captureId }).observed == 3)
		f.request(socket, "remote_capture_stop", { captureId = mixed.captureId })
		assert(native.metatable.__namecall ~= original and target.OnClientEvent:Count() == 1)
		f.request(socket, "remote_capture_stop", { captureId = outbound.captureId })
		assert(native.metatable.__namecall == original and target.OnClientEvent:Count() == 1)
		target.OnClientEvent:Fire(8)
		local queued = target.OnClientEvent:Queued(9)
		f.request(socket, "remote_capture_stop", { captureId = inbound.captureId })
		queued()
		assert(target.OnClientEvent:Count() == 0 and f.request(socket, "remote_capture_poll", { captureId = inbound.captureId }).observed == 4)
		f.teardown()
	end)
	check("mixed capture response failure generation teardown and queued callbacks release owned listeners", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local original = function() return "original" end
		local native = f.namecallFacilities(original)
		local foreignCalls = 0
		local foreign = target.OnClientEvent:Connect(function() foreignCalls += 1 end)
		local socket = f.boot()
		f.authenticate(socket)
		socket.beforeSend = function(message)
			if message.type == "response" and message.result and message.result.captureId then error("fixture response loss") end
		end
		f.begin(socket, "remote_capture_start", { targets = { "workspace.Send" }, directions = { "inbound", "outbound" }, includeValueExamples = true })
		assert(target.OnClientEvent:Count() == 1 and native.metatable.__namecall == original)
		assert(f.global.PotassiumMcp.remoteWorkflow.activeCaptures == 0)
		f.scheduler.untilTrue(function() return #f.sockets > 1 and #f.sockets[#f.sockets].sent > 0 end)
		socket = f.sockets[#f.sockets]
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, directions = { "outbound", "inbound" } })
		local queued, oldState = target.OnClientEvent:Queued("old-generation"), f.global.PotassiumMcp
		local owned = native.metatable.__namecall
		oldState.active = false
		socket:Close()
		socket = f.boot()
		f.authenticate(socket)
		local current = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, directions = { "inbound" } })
		queued()
		assert(native.metatable.__namecall == original and owned(target) == "original" and target.OnClientEvent:Count() == 2)
		assert(oldState.remoteWorkflow.activeCaptures == 0 and next(oldState.remoteWorkflow.captures) == nil)
		f.reject(socket, "remote_capture_poll", { captureId = capture.captureId })
		assert(f.request(socket, "remote_capture_poll", { captureId = current.captureId }).observed == 0)
		target.OnClientEvent:Fire("new-generation")
		assert(f.request(socket, "remote_capture_poll", { captureId = current.captureId }).observed == 1 and foreignCalls == 2)
		foreign:Disconnect()
		f.teardown()
	end)
	check("inbound deadline and retained TTL fence queued deliveries and release listener reservations", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local baseline = f.connectionCounters().active
		local capture = f.request(socket, "remote_capture_start", {
			targets = { "workspace.Send" }, directions = { "inbound" }, includeValueExamples = true, durationMs = 1000,
		})
		target.OnClientEvent:Fire("before-deadline")
		local queued = target.OnClientEvent:Queued("after-deadline")
		f.scheduler.advance(2)
		queued()
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
		assert(poll.state == "expired" and poll.observed == 1 and poll.profiles[1].examples[1].arguments[1].value == "before-deadline")
		assert(target.OnClientEvent:Count() == 0 and f.connectionCounters().active == baseline)
		f.scheduler.advance(58)
		f.request(socket, "remote_capture_poll", { captureId = capture.captureId })
		f.scheduler.advance(2)
		f.reject(socket, "remote_capture_poll", { captureId = capture.captureId })
		assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.captures == 0)
		f.teardown()
	end)
	if options.jsonEncode then
		check("profiles keep examples events and shapes inside one capture byte budget under pressure", function()
			local f = fixture()
			local target = f.instance("Send", "RemoteEvent", f.workspace)
			local native = f.namecallFacilities(function() return true end)
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "remote_capture_start", {
				targets = { "workspace.Send" }, directions = { "outbound", "inbound" },
				includeValueExamples = true, maxExamplesPerVariant = 3, maxEvents = 200,
			})
			for argc = 1, 32 do native.call("FireServer", target, table.unpack(table.create(argc, "a"))) end
			for variant = 1, 2 do
				for argc = 1, 32 do
					local arguments = table.create(argc, string.rep("\1", 60))
					-- A short discriminator survives the per-example byte cap even at full arity.
					arguments[1] = "variant" .. variant
					native.call("FireServer", target, table.unpack(arguments))
				end
			end
			local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "profiles" })
			assert(poll.observed == 96 and poll.bufferedBytes <= 65536 and poll.dropped.examples > 0,
				string.format("capture pressure observed=%d bytes=%d droppedExamples=%d droppedEvents=%d observationErrors=%d state=%s reason=%s",
					poll.observed, poll.bufferedBytes, poll.dropped.examples, poll.dropped.events,
					poll.dropped.observationErrors, poll.state, tostring(poll.reason)))
			local counted = 0
			for _, profile in ipairs(poll.profiles) do
				counted += profile.count
				assert(profile.exampleCount <= 3)
				for _, example in ipairs(profile.examples) do assert(#options.jsonEncode(example) <= 1024) end
			end
			assert(counted + poll.dropped.shapes == poll.observed and #options.jsonEncode(poll) <= 65536)
			local events = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "events" })
			assert(events.retained < 96 and events.dropped.events > 0 and events.bufferedBytes <= 65536)
			f.teardown()
		end)
	end
	check("capture shape and event byte bounds survive repeated starts and stop at fixed deadlines", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local original = function() return "unchanged" end
		local native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		local ids = {}
		for index = 1, 4 do ids[index] = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" }, durationMs = 1000, maxEvents = 200 }).captureId end
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		for index = 1, 100 do native.call("FireServer", target, table.unpack(table.create(index, false))) end
		for _, id in ipairs(ids) do
			local poll = f.request(socket, "remote_capture_poll", { captureId = id, view = "events" })
			assert(#poll.groups == 32 and poll.dropped.shapes == 68 and poll.bufferedBytes <= 65536)
			assert(#poll.events <= 20 and #poll.events[1].argumentTypes <= 8)
		end
		socket = f.reconnect(socket)
		f.scheduler.advance(2)
		for _, id in ipairs(ids) do assert(f.request(socket, "remote_capture_poll", { captureId = id }).state == "expired") end
		assert(native.metatable.__namecall == original)
		for _ = 1, 20 do
			local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
			f.request(socket, "remote_capture_stop", { captureId = capture.captureId })
			assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.captures <= 8)
		end
		f.scheduler.advance(61)
		assert(f.request(socket, "capabilities", {}).resources.remoteWorkflow.captures == 0)
		f.reject(socket, "remote_capture_poll", { captureId = ids[1] })
		f.teardown()
	end)
	check("capture observation failure is transparent and later foreign hook ownership is never overwritten", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local original = function() return "original" end
		local native = f.namecallFacilities(original)
		local savedTypeof, failObservation = f.environment.typeof, false
		f.environment.typeof = function(value)
			if failObservation then error("fixture observation failure") end
			return savedTypeof(value)
		end
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		failObservation = true
		assert(native.call("FireServer", target, "secret") == "original")
		failObservation = false
		local failed = f.request(socket, "remote_capture_poll", { captureId = capture.captureId })
		assert(failed.state == "limited" and failed.dropped.observationErrors == 1)
		assert(native.metatable.__namecall == original)
		local active = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		local owned = native.metatable.__namecall
		local foreign = function(self, ...) return owned(self, ...) end
		native.metatable.__namecall = foreign
		assert(native.call("FireServer", target) == "original")
		local lost = f.request(socket, "remote_capture_poll", { captureId = active.captureId })
		assert(lost.state == "interrupted" and lost.reason == "hook-ownership-lost" and lost.hookCleanup == "inert-wrapper-retained")
		assert(native.metatable.__namecall == foreign)
		f.reject(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		local oldGeneration = f.global.PotassiumMcp.generation
		f.global.PotassiumMcp.active = false
		socket:Close()
		socket = f.boot()
		f.authenticate(socket)
		assert(f.global.PotassiumMcp.generation == oldGeneration + 1)
		assert(not f.request(socket, "capabilities", {}).remoteCapture.outboundAvailable)
		assert(native.metatable.__namecall == foreign and native.call("FireServer", target) == "original")
		f.teardown()
		assert(native.metatable.__namecall == foreign)
	end)
	check("capture response loss rolls back installation and bootstrap replacement fences old wrappers", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local original = function() return "original" end
		local native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		socket.beforeSend = function(message)
			if message.type == "response" and message.result and message.result.captureId then error("fixture send failure") end
		end
		f.begin(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		assert(native.metatable.__namecall == original and f.global.PotassiumMcp.remoteWorkflow.activeCaptures == 0)
		f.scheduler.untilTrue(function() return #f.sockets > 1 and #f.sockets[#f.sockets].sent > 0 end)
		socket = f.sockets[#f.sockets]
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		local owned = native.metatable.__namecall
		local oldGeneration = f.global.PotassiumMcp.generation
		f.global.PotassiumMcp.active = false
		socket:Close()
		socket = f.boot()
		f.authenticate(socket)
		assert(f.global.PotassiumMcp.generation == oldGeneration + 1)
		assert(native.metatable.__namecall == original and owned(target) == "original")
		f.reject(socket, "remote_capture_poll", { captureId = capture.captureId })
		local nextCapture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		native.call("FireServer", target)
		assert(f.request(socket, "remote_capture_poll", { captureId = nextCapture.captureId }).observed == 1)
		f.teardown()
		assert(native.metatable.__namecall == original)
	end)
	check("overlapping snapshot scans reconcile identities after cooperative traversal yields", function()
		local f = fixture()
		for index = 1, 200 do f.instance(string.format("Remote%03d", index), "RemoteEvent", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local first = f.begin(socket, "remote_inventory", { root = "workspace", view = "rows" })
		local second = f.begin(socket, "remote_inventory", { root = "workspace", view = "rows" })
		f.scheduler.untilTrue(function() return first() and second() end)
		assert(first().ok and second().ok)
		local diff = f.request(socket, "remote_inventory", { view = "diff", snapshotId = second().result.snapshotId, compareTo = first().result.snapshotId })
		assert(#diff.results == 0 and diff.absenceAuthoritative)
		f.teardown()
	end)
	check("simulated nested original calls remain exactly once per observed namecall", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local native, calls
		calls = 0
		local original = function(self, recurse)
			calls += 1
			if recurse then return native.call("FireServer", self, false) end
			return "nested-result"
		end
		native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		assert(native.call("FireServer", target, true) == "nested-result")
		assert(calls == 2 and f.request(socket, "remote_capture_poll", { captureId = capture.captureId }).observed == 2)
		f.teardown()
	end)
	if options.jsonEncode then
		check("capture escaped metadata byte ring evicts before count capacity and keeps receipts small", function()
			local f = fixture()
			local paths, targets = {}, {}
			for index = 1, 16 do
				local name = string.rep("\1", 250) .. index
				targets[index] = f.instance(name, "RemoteEvent", f.workspace)
				paths[index] = "workspace." .. name
			end
			local original = function() return true end
			local native = f.namecallFacilities(original)
			local socket = f.boot()
			f.authenticate(socket)
			local capture = f.request(socket, "remote_capture_start", { targets = paths, maxEvents = 200 })
			assert(#options.jsonEncode(capture) < 1024 and capture.targets == nil and capture.groups == nil)
			for _ = 1, 220 do native.call("FireServer", targets[1], original, original, original, original, original, original, original, original) end
			local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId, view = "events" })
			assert(poll.bufferedBytes <= 65536 and poll.retained < 200 and poll.dropped.events > 20)
			local stopped = f.request(socket, "remote_capture_stop", { captureId = capture.captureId })
			assert(#options.jsonEncode(stopped) < 1024 and stopped.targets == nil and stopped.groups == nil)
			f.teardown()
		end)
	end
	check("capture observation never calls engine serializers or target methods before forwarding", function()
		local f = fixture()
		local target = f.instance("Send", "RemoteEvent", f.workspace)
		local observing = false
		local original = function()
			assert(f.environment.getnamecallmethod() == "FireServer", "namecall method changed before original")
			return "original"
		end
		local native = f.namecallFacilities(original)
		local http = f.environment.game:GetService("HttpService")
		local encode = http.JSONEncode
		http.JSONEncode = function(self, value)
			assert(not observing, "engine serialization entered the hook")
			return encode(self, value)
		end
		local socket = f.boot()
		f.authenticate(socket)
		local capture = f.request(socket, "remote_capture_start", { targets = { "workspace.Send" } })
		target.GetFullName = function() error("target path was not cached") end
		target.IsA = function() error("target class was not cached") end
		observing = true
		assert(native.call("FireServer", target, "private") == "original")
		observing = false
		local poll = f.request(socket, "remote_capture_poll", { captureId = capture.captureId })
		assert(poll.state == "active" and poll.observed == 1 and poll.dropped.observationErrors == 0)
		f.teardown()
	end)
	check("disconnected snapshot scans cannot publish state or acquire references after yielding", function()
		local f = fixture()
		for index = 1, 200 do f.instance(string.format("Remote%03d", index), "RemoteEvent", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		f.begin(socket, "remote_inventory", { root = "workspace", includeReferences = true, view = "rows" })
		socket = f.reconnect(socket)
		f.scheduler.untilTrue(function() return f.global.PotassiumMcp.inFlightRequests == 0 end)
		local resources = f.request(socket, "capabilities", {}).resources
		assert(resources.remoteWorkflow.snapshots == 0 and resources.references.total == 0)
		f.teardown()
	end)
	check("typed remote calls preserve nil arity and exact values without compiling code", function()
		local f = fixture()
		f.typedFacilities()
		local remote = f.instance("Echo", "RemoteFunction", f.workspace)
		local target = f.instance("Argument", "Folder", f.workspace)
		local calls = 0
		function remote:InvokeServer(...)
			calls += 1
			local args = table.pack(...)
			assert(args.n == 8 and args[1] == nil and args[2] == false and args[8] == nil)
			assert(args[3].X == 1 and args[3].Y == -2 and args[3].Z == 3)
			assert(args[4]:GetComponents() == 1 and args[5] == target)
			assert(args[6][1] == "left" and args[6][2] == nil and args[6][3] == false)
			assert(args[7][false] == "boolean-key" and args[7][2] == 19 and args[7].missing == nil)
			return nil, false, args[3], nil
		end
		local socket = f.boot()
		f.authenticate(socket)
		local reference = f.request(socket, "inspect_instance", { path = "workspace.Argument", includeReferences = true }).reference
		f.environment.loadstring = function() error("typed calls must never compile", 0) end
		local accepted = f.request(socket, "remote_call", {
			target = "workspace.Echo", method = "InvokeServer", argumentCount = 8, arguments = {
				{ type = "nil" }, false, { type = "Vector3", x = 1, y = -2, z = 3 },
				{ type = "CFrame", components = { 1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1 } },
				{ type = "Instance", reference = reference }, { type = "Array", values = { "left", { type = "nil" }, false } },
				{ type = "Table", entries = { { key = false, value = "boolean-key" }, { key = 2, value = 19 }, { key = "missing", value = { type = "nil" } } } },
				{ type = "nil" },
			},
		})
		local result = f.finished(socket, accepted.jobId)
		assert(calls == 1 and result.state == "succeeded" and result.dispatchStarted and result.result.count == 4)
		assert(result.result.values[1].type == "nil" and result.result.values[2] == false and result.result.values[4].type == "nil")
		assert(result.result.values[3].type == "Vector3" and result.result.values[3].y == -2)
		local job = f.global.PotassiumMcp.asyncJobs[accepted.jobId]
		assert(job.callable == nil and job.arguments == nil, "terminal jobs must release captured values")
		f.teardown()
	end)
	check("invalid typed batches and late references cannot dispatch a valid prefix", function()
		local f = fixture()
		local remote = f.instance("Send", "RemoteEvent", f.workspace)
		local argument = f.instance("Argument", "Folder", f.workspace)
		local calls = 0
		function remote:FireServer() calls += 1 end
		local socket = f.boot()
		f.authenticate(socket)
		local reference = f.request(socket, "inspect_instance", { path = "workspace.Argument", includeReferences = true }).reference
		for _, invalid in ipairs({
			{ type = "Instance", reference = "instance://" .. string.rep("0", 32) },
			{ type = "Vector3", x = 1, y = 2, z = 3, extra = true },
			{ type = "Table", entries = { { key = false, value = 1 }, { key = false, value = 2 } } },
			{ type = "Array", values = { { unexpected = true } } },
			{ type = "CFrame", components = { 1, 2 } }, string.rep("x", 4097),
		}) do
			f.reject(socket, "remote_call", { target = "workspace.Send", method = "FireServer", arguments = { "valid-prefix", invalid }, argumentCount = 2 })
		end
		local deep = false
		for _ = 1, 6 do deep = { type = "Array", values = { deep } } end
		f.reject(socket, "remote_call", { target = "workspace.Send", method = "FireServer", arguments = { deep }, argumentCount = 1 })
		f.reject(socket, "remote_call", { target = "workspace.Send", method = "FireServer", arguments = { { type = "Array", values = table.create(256, false) } }, argumentCount = 1 })
		f.reject(socket, "remote_call", { target = "workspace.Send", method = "FireServer", arguments = {}, argumentCount = 1 })
		f.reject(socket, "remote_call", { target = "workspace.Send", method = "InvokeServer", arguments = {}, argumentCount = 0 })
		assert(calls == 0 and #f.request(socket, "async_job_list", {}).jobs == 0)
		local blocker = f.request(socket, "execute_luau_async", { code = "_G.blocking = true; task.wait(1)" }).jobId
		f.scheduler.untilTrue(function() return f.global.blocking end)
		local accepted = f.request(socket, "remote_call", { target = "workspace.Send", method = "FireServer",
			arguments = { { type = "Instance", reference = reference } }, argumentCount = 1 })
		f.request(socket, "instance_references_release", { references = { reference } })
		local result = f.finished(socket, accepted.jobId)
		assert(result.state == "failed" and not result.dispatchStarted and string.find(result.error, "reference unavailable", 1, true))
		assert(calls == 0 and f.finished(socket, blocker).state == "succeeded")
		assert(argument.Parent == f.workspace)
		f.teardown()
	end)
	check("queued remote cancellation sends nothing and FireServer only reports local dispatch", function()
		local f = fixture()
		local remote = f.instance("Send", "RemoteEvent", f.workspace)
		local calls = 0
		function remote:FireServer(...) calls += 1; assert(select("#", ...) == 1 and (...) == nil) end
		local socket = f.boot()
		f.authenticate(socket)
		local sync = f.begin(socket, "execute_luau", { code = "task.wait(1)" })
		local cancelled = f.request(socket, "remote_call", { target = "workspace.Send", method = "FireServer", arguments = {}, argumentCount = 0 }).jobId
		assert(f.request(socket, "async_job_cancel", { jobId = cancelled }).state == "cancelled")
		local result = f.request(socket, "async_job_result", { jobId = cancelled })
		assert(result.ready and result.dispatchStarted == false and calls == 0)
		local accepted = f.request(socket, "remote_call", { target = "workspace.Send", method = "FireServer", arguments = { { type = "nil" } }, argumentCount = 1 })
		result = f.finished(socket, accepted.jobId)
		assert(sync().ok and calls == 1 and result.result.dispatched and result.result.serverAcknowledged == false)
		assert(result.result.count == 0 and f.global.PotassiumMcp.asyncJobs[cancelled].callable == nil)
		f.teardown()
	end)
	check("post-dispatch cancellation preserves both eventual InvokeServer returns and errors", function()
		local f = fixture()
		local remote = f.instance("Echo", "RemoteFunction", f.workspace)
		local calls, entered, fail = 0, false, false
		function remote:InvokeServer()
			calls += 1; entered = true
			f.environment.task.wait(1)
			if fail then error("fixture remote rejection", 0) end
			return "authoritative", nil, false, nil
		end
		local socket = f.boot()
		f.authenticate(socket)
		for _, rejects in ipairs({ false, true }) do
			entered, fail = false, rejects
			local id = f.request(socket, "remote_call", { target = "workspace.Echo", method = "InvokeServer", arguments = {}, argumentCount = 0 }).jobId
			f.scheduler.untilTrue(function() return entered end)
			local cancelled = f.request(socket, "async_job_cancel", { jobId = id })
			assert(cancelled.state == "running" and cancelled.cancellationRequested and cancelled.dispatchStarted)
			assert(not f.request(socket, "async_job_result", { jobId = id }).ready and f.global.PotassiumMcp.rawExecutionActive)
			f.reject(socket, "execute_luau", { code = "_G.overlappingRemote = true" })
			local result = f.finished(socket, id)
			assert(result.ready and result.cancellationRequested and result.dispatchStarted)
			if rejects then
				assert(result.state == "failed" and string.find(result.error, "fixture remote rejection", 1, true))
			else
				assert(result.state == "succeeded" and result.result.count == 4 and result.result.values[1] == "authoritative")
				assert(result.result.values[2].type == "nil" and result.result.values[3] == false and result.result.values[4].type == "nil")
			end
		end
		assert(calls == 2 and not f.global.overlappingRemote)
		f.teardown()
	end)
	check("remote response loss and teardown retain actual dispatched outcomes without replay", function()
		local f = fixture()
		local remote = f.instance("Echo", "RemoteFunction", f.workspace)
		local calls, accepted, entered = 0, nil, false
		function remote:InvokeServer()
			calls += 1; entered = true; f.environment.task.wait(1); return 73
		end
		local socket = f.boot()
		f.authenticate(socket)
		socket.beforeSend = function(message)
			if message.result and message.result.jobId then accepted = message.result.jobId; error("fixture lost receipt") end
		end
		f.begin(socket, "remote_call", { target = "workspace.Echo", method = "InvokeServer", arguments = {}, argumentCount = 0 })
		f.scheduler.untilTrue(function() return entered end)
		local state = f.global.PotassiumMcp
		state.teardown()
		assert(state.rawExecutionActive and state.asyncJobs[accepted].state == "running")
		f.scheduler.advance(2)
		local job = state.asyncJobs[accepted]
		assert(calls == 1 and job.state == "succeeded" and job.cancellationRequested and job.result.values[1] == 73)
		assert(not state.rawExecutionActive and job.arguments == nil and job.callable == nil)
		f.teardown()
	end)
	check("action observation correlates bounded before-after reads and only its owned capture", function()
		local f = fixture()
		local value = f.instance("Coins", "IntValue", f.workspace)
		value.Value = 2
		local remote = f.instance("Action", "RemoteEvent", f.workspace)
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local existing = f.request(socket, "remote_capture_start", { targets = { "workspace.Action" } })
		local observation = f.request(socket, "observe_action", { operation = "start",
			requests = { { path = "workspace.Coins", properties = { "Value" } } }, remotes = { "workspace.Action" } })
		assert(observation.state == "active" and f.global.PotassiumMcp.inFlightRequests == 0)
		value.Value = 9
		native.call("FireServer", remote, "action")
		local stopped = f.request(socket, "observe_action", { operation = "stop", observationId = observation.observationId })
		assert(stopped.state == "completing" and f.global.PotassiumMcp.inFlightRequests == 0)
		local completed
		f.scheduler.untilTrue(function()
			completed = f.request(socket, "observe_action", { operation = "poll", observationId = observation.observationId })
			return completed.state == "completed"
		end)
		assert(completed.correlation == "temporal" and completed.before.complete and completed.after.complete)
		local changes = {}
		for _, change in ipairs(completed.changes) do
			assert(changes[change.field] == nil, "a selected field must not produce duplicate changes")
			changes[change.field] = change
		end
		assert(changes["properties.Value"].before.value == 2 and changes["properties.Value"].after.value == 9)
		assert(changes.instance.before.value == 2 and changes.instance.after.value == 9)
		assert(completed.remotes.observed == 1 and completed.remotes.groups[1].count == 1 and not completed.remotes.recordsValues)
		assert(completed.remotes.coverage == "selected-outbound-namecall-only" and not completed.remotes.incomingCalls)
		assert(completed.remotes.groups[1].direction == "outbound" and completed.remotes.groups[1].exampleCount == 0)
		assert(remote.OnClientEvent:Count() == 0)
		assert(f.request(socket, "remote_capture_poll", { captureId = existing.captureId }).state == "active")
		assert(f.request(socket, "observe_action", { operation = "stop", observationId = observation.observationId }).finishedAt == completed.finishedAt)
		f.teardown()
	end)
	check("action observations preserve unavailable facets and never rebind replacement paths", function()
		local f = fixture()
		local value = f.instance("Value", "IntValue", f.workspace)
		value.Value = 3
		local socket = f.boot()
		f.authenticate(socket)
		local observed = f.request(socket, "observe_action", { operation = "start", requests = {
			{ path = "workspace.Value", properties = { "Value", "Source" } },
			{ path = "workspace.Missing", properties = { "Name" } },
		} })
		value:Destroy()
		local replacement = f.instance("Value", "IntValue", f.workspace)
		replacement.Value = 999
		f.instance("Missing", "Folder", f.workspace)
		f.request(socket, "observe_action", { operation = "stop", observationId = observed.observationId })
		local result
		f.scheduler.untilTrue(function()
			result = f.request(socket, "observe_action", { operation = "poll", observationId = observed.observationId })
			return result.state == "completed"
		end)
		assert(not result.before.complete and result.before.reads[1].failures[1].field == "properties.Source")
		assert(not result.after.complete and not result.after.reads[1].available and not result.after.reads[2].available)
		assert(#result.changes == 1 and result.changes[1].kind == "availability" and result.changes[1].after.error.code == "TARGET_UNAVAILABLE")
		f.teardown()
	end)
	check("action deadlines capacity TTL and operation-specific control admission remain bounded", function()
		local f = fixture()
		local value = f.instance("Value", "IntValue", f.workspace)
		value.Value = 1
		local socket = f.boot()
		f.authenticate(socket)
		local ids = {}
		for index = 1, 4 do
			ids[index] = f.request(socket, "observe_action", { operation = "start", durationMs = 1000,
				requests = { { path = "workspace.Value", properties = { "Value" } } } }).observationId
		end
		f.reject(socket, "observe_action", { operation = "start", requests = { { path = "workspace.Value", properties = { "Value" } } } })
		local raw = f.begin(socket, "execute_luau", { code = "task.wait(2)" })
		f.reject(socket, "observe_action", { operation = "start", requests = { { path = "workspace.Value", properties = { "Value" } } } })
		assert(f.request(socket, "observe_action", { operation = "poll", observationId = ids[1] }).state == "active")
		assert(f.request(socket, "observe_action", { operation = "stop", observationId = ids[1] }).state == "completing")
		f.scheduler.advance(3)
		assert(raw().ok)
		for index = 2, 4 do
			local result = f.request(socket, "observe_action", { operation = "poll", observationId = ids[index] })
			assert(result.state == "completed" and result.reason == "deadline")
		end
		for _ = 1, 10 do
			local result = f.request(socket, "observe_action", { operation = "start", durationMs = 1000,
				requests = { { path = "workspace.Value", properties = { "Value" } } } })
			f.request(socket, "observe_action", { operation = "stop", observationId = result.observationId })
			f.scheduler.advance(0.1)
		end
		local resources = f.request(socket, "capabilities", {}).resources.actionObservations
		assert(resources.active == 0 and resources.retained == 8 and resources.reservedBytes <= 1048576)
		f.scheduler.advance(121)
		f.reject(socket, "observe_action", { operation = "poll", observationId = ids[1] })
		assert(f.request(socket, "capabilities", {}).resources.actionObservations.retained == 0)
		f.teardown()
	end)
	check("action response loss disconnect and teardown release only owned capture callbacks", function()
		local f = fixture()
		f.instance("Send", "RemoteEvent", f.workspace)
		local original = function() return true end
		local native = f.namecallFacilities(original)
		local socket = f.boot()
		f.authenticate(socket)
		socket.beforeSend = function(message)
			if message.result and message.result.observationId then error("fixture action receipt lost") end
		end
		f.begin(socket, "observe_action", { operation = "start", requests = { { path = "workspace", children = { limit = 1 } } }, remotes = { "workspace.Send" } })
		f.scheduler.untilTrue(function() return #f.sockets > 1 and #f.sockets[#f.sockets].sent > 0 end)
		socket = f.sockets[#f.sockets]
		f.authenticate(socket)
		assert(f.global.PotassiumMcp.actionObservations.active == 0 and native.metatable.__namecall == original)
		local observed = f.request(socket, "observe_action", { operation = "start", requests = { { path = "workspace", properties = { "Name" } } }, remotes = { "workspace.Send" } })
		socket = f.reconnect(socket)
		local interrupted = f.request(socket, "observe_action", { operation = "poll", observationId = observed.observationId })
		assert(interrupted.state == "interrupted" and interrupted.reason == "transport-disconnected" and not interrupted.after.complete)
		assert(native.metatable.__namecall == original and f.global.PotassiumMcp.remoteWorkflow.activeCaptures == 0)
		f.request(socket, "observe_action", { operation = "start", requests = { { path = "workspace", properties = { "Name" } } }, remotes = { "workspace.Send" } })
		local state = f.global.PotassiumMcp
		f.teardown()
		assert(state.actionObservations.active == 0 and next(state.actionObservations.records) == nil and native.metatable.__namecall == original)
	end)
	check("interrupted yielding action reads cannot publish completed state after teardown", function()
		local f = fixture()
		for index = 1, 200 do f.instance("Child" .. index, "Folder", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local started = f.begin(socket, "observe_action", { operation = "start", requests = { { path = "workspace", children = { limit = 100 } } } })
		assert(started() == nil)
		local state = f.global.PotassiumMcp
		state.teardown()
		f.scheduler.advance(2)
		assert(started() == nil and state.actionObservations.active == 0 and next(state.actionObservations.records) == nil)
		f.teardown()
	end)
	check("focused diagnostics reuse selected UI and radius reads with stable identities", function()
		local f = fixture()
		local vector = f.typedFacilities()
		local player = f.instance("LocalViewer", "Player", f.environment.game)
		f.services.Players.LocalPlayer = player
		local character = f.instance("Character", "Model", f.workspace)
		player.Character = character
		local root = f.instance("HumanoidRootPart", "Folder", character)
		root.Position = vector(0, 0, 0)
		root.AssemblyAngularVelocity, root.AssemblyLinearVelocity = vector(0, 0, 0), vector(1, 0, 0)
		local humanoid = f.instance("Humanoid", "Humanoid", character)
		humanoid.Health, humanoid.MaxHealth = 50, 100
		function humanoid:GetState() return "Running" end
		local gui = f.instance("PlayerGui", "PlayerGui", player)
		for index = 1, 3 do f.instance("Panel" .. index, "GuiBase2d", gui).Visible = true end
		local nearby = f.instance("Nearby", "Folder", f.workspace)
		nearby.Position = vector(3, 0, 0)
		local queries = 0
		function f.workspace:GetPartBoundsInRadius(center, radius, filter)
			queries += 1
			assert(center.X == 0 and radius == 8 and filter.MaxParts == 1)
			return { nearby }
		end
		local socket = f.boot()
		f.authenticate(socket)
		local capabilities = f.request(socket, "capabilities", {})
		assert(capabilities.diagnosticSnapshot.version == 2 and capabilities.remoteActions.version == 1 and capabilities.actionObservation.version == 1)
		local overview = f.request(socket, "diagnostic_snapshot", {})
		assert(overview.place and overview.workspace and overview.view == nil and queries == 0)
		local selected = f.request(socket, "diagnostic_snapshot", { view = "character" })
		assert(selected.character.instance.reference and selected.root.instance.reference and selected.humanoid.health == 50)
		assert(selected.place == nil and selected.workspace == nil and selected.coverage == "complete" and queries == 0)
		local ui = f.request(socket, "diagnostic_snapshot", { view = "ui", limit = 2 })
		assert(ui.truncated and ui.coverage == "partial" and #ui.roots[1].results == 2 and ui.roots[1].results[1].reference)
		assert(ui.character == nil and queries == 0)
		local core = f.instance("CoreGui", "CoreGui", f.environment.game)
		f.services.CoreGui = core
		f.instance("CorePanel", "GuiBase2d", core)
		local both = f.request(socket, "diagnostic_snapshot", { view = "ui", root = "both", limit = 2 })
		assert(#both.roots[1].results + #both.roots[2].results == 2 and both.roots[2].truncated)
		local spatial = f.request(socket, "diagnostic_snapshot", { view = "nearby", radius = 8, limit = 1 })
		assert(queries == 1 and spatial.truncated and spatial.results[1].distance == 3 and spatial.results[1].reference)
		nearby.Name = "Moved"
		assert(f.request(socket, "inspect_instance", { path = spatial.results[1].reference }).name == "Moved")
		f.reject(socket, "diagnostic_snapshot", { view = "character", radius = 8 })
		f.reject(socket, "diagnostic_snapshot", { view = "nearby", radius = 129 })
		f.reject(socket, "diagnostic_snapshot", { view = "ui", root = "workspace" })
		player.Character = nil
		local unavailable = f.request(socket, "diagnostic_snapshot", { view = "nearby" })
		assert(unavailable.coverage == "unavailable" and unavailable.reason == "character-root-unavailable" and queries == 1)
		f.teardown()
	end)
	check("action validation is atomic and changed selections obey the shared diff ceiling", function()
		local f = fixture()
		local remote = f.instance("Send", "RemoteEvent", f.workspace)
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local reads, originalChildren = 0, f.workspace.GetChildren
		f.workspace.GetChildren = function(self) reads += 1; return originalChildren(self) end
		f.reject(socket, "observe_action", { operation = "start", requests = {
			{ path = "workspace", children = {} }, { path = "workspace", properties = { 1 } },
		}, remotes = { "workspace.Send" } })
		f.reject(socket, "observe_action", { operation = "start", requests = {
			{ path = "workspace", children = {} },
		}, remotes = { "workspace.Send", "workspace" } })
		assert(reads == 0 and native.installs == 0 and f.global.PotassiumMcp.actionObservations.active == 0)
		local nodes, requests = {}, {}
		local properties = { "Value", "Health", "MaxHealth", "WalkSpeed", "JumpPower", "Transparency", "BackgroundTransparency", "Archivable" }
		for index = 1, 16 do
			local node = f.instance("Values" .. index, "Folder", f.workspace)
			for _, property in ipairs(properties) do node[property] = 1 end
			nodes[index] = node
			requests[index] = { path = "workspace." .. node.Name, properties = properties }
		end
		local observation = f.request(socket, "observe_action", { operation = "start", requests = requests })
		for _, node in ipairs(nodes) do for _, property in ipairs(properties) do node[property] = 2 end end
		f.request(socket, "observe_action", { operation = "stop", observationId = observation.observationId })
		local result
		f.scheduler.untilTrue(function()
			result = f.request(socket, "observe_action", { operation = "poll", observationId = observation.observationId })
			return result.state == "completed"
		end)
		assert(result.before.complete and result.after.complete and result.truncated and #result.changes == 100)
		for _, change in ipairs(result.changes) do assert(change.before.value == 1 and change.after.value == 2) end
		if options.jsonEncode then assert(#options.jsonEncode(result) <= 131072) end
		assert(remote.Parent == f.workspace)
		f.teardown()
	end)
	check("interrupted after reads keep capture outcomes and fence completion callbacks", function()
		local f = fixture()
		local remote = f.instance("Send", "RemoteEvent", f.workspace)
		local native = f.namecallFacilities(function() return true end)
		local socket = f.boot()
		f.authenticate(socket)
		local observed = f.request(socket, "observe_action", { operation = "start",
			requests = { { path = "workspace", children = { limit = 100 } } }, remotes = { "workspace.Send" } })
		native.call("FireServer", remote, nil)
		for index = 1, 200 do f.instance("Child" .. index, "Folder", f.workspace) end
		f.request(socket, "observe_action", { operation = "stop", observationId = observed.observationId })
		local wait, paused = f.environment.task.wait, false
		f.environment.task.wait = function(delay)
			if delay == nil and not paused then paused = true; return wait(2) end
			return wait(delay)
		end
		f.scheduler.untilTrue(function() return paused end)
		socket = f.reconnect(socket)
		local interrupted = f.request(socket, "observe_action", { operation = "poll", observationId = observed.observationId })
		assert(interrupted.state == "interrupted" and interrupted.remotes.observed == 1)
		assert(interrupted.after.coverage == "unavailable" and interrupted.reason == "transport-disconnected")
		f.scheduler.advance(3)
		assert(f.request(socket, "observe_action", { operation = "poll", observationId = observed.observationId }).state == "interrupted")
		assert(f.global.PotassiumMcp.remoteWorkflow.activeCaptures == 0)
		f.teardown()
	end)
	check("remote targets removed while queued are never replaced by same-name instances", function()
		local f = fixture()
		local target = f.instance("Echo", "RemoteFunction", f.workspace)
		local calls = 0
		function target:InvokeServer() calls += 1 end
		local socket = f.boot()
		f.authenticate(socket)
		local sync = f.begin(socket, "execute_luau", { code = "task.wait(1)" })
		local id = f.request(socket, "remote_call", { target = "workspace.Echo", method = "InvokeServer", arguments = {}, argumentCount = 0 }).jobId
		target:Destroy()
		local replacement = f.instance("Echo", "RemoteFunction", f.workspace)
		function replacement:InvokeServer() calls += 1 end
		local result = f.finished(socket, id)
		assert(sync().ok and result.state == "failed" and not result.dispatchStarted and calls == 0)
		f.teardown()
	end)
	if options.mode == "remote" then return report("remote") end

	check("four slow observations preserve the fifth control slot and heartbeat admission", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local observations = {}
		for index = 1, 4 do observations[index] = f.begin(socket, "observe_logs", { durationMs = 5000 }) end
		local diagnostic = f.request(socket, "capabilities", {})
		assert(diagnostic.resources.handlers.active == 5 and diagnostic.resources.connections.observer == 4, "fifth diagnostic must run while four reads are waiting")
		local running, id = f.begin(socket, "execute_luau", { code = "_G.mutations = (_G.mutations or 0) + 1; task.wait(2); return 19" })
		assert(f.global.PotassiumMcp.inFlightRequests == 5 and running() == nil, "fifth yielding handler must own its admission slot")
		f.reject(socket, "execute_luau", { code = "_G.rejectedMutation = true" })
		local sent = #socket.sent
		f.receive(socket, { type = "ping", nonce = "capacity-heartbeat" })
		assert(#socket.sent == sent + 1 and socket.sent[#socket.sent].type == "pong", "heartbeat must bypass handler capacity")
		f.scheduler.untilTrue(running)
		assert(running().ok and running().result.values[1] == 19 and f.responseCount(socket, id) == 1, "normal execution must publish exactly one result")
		local control = f.request(socket, "capabilities", {}).resources
		assert(control.handlers.active == 5 and control.handlers.peak == 5 and control.handlers.rejected == 1, "completed mutation must free only its own slot for controls")
		assert(not f.global.rejectedMutation and f.global.mutations == 1 and not observations[1](), "capacity rejection must not execute and controls must finish ahead of slow reads")
		for _, response in ipairs(observations) do f.scheduler.untilTrue(response); assert(response().ok, "admitted observation must finish") end
		f.teardown()
	end)
	check("duplicate active request closes transport without replay or early lock release", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local original, id = f.begin(socket, "execute_luau", { code = "_G.executions = (_G.executions or 0) + 1; task.wait(3); _G.originalReturned = true; return 1" })
		f.receive(socket, { type = "request", id = id, method = "execute_luau", params = { code = "_G.duplicateRan = true" } })
		assert(socket.closed and f.responseCount(socket, id) == 0, "duplicate active ID must fail the transport rather than emit competing outcomes")
		assert(f.global.PotassiumMcp.rawExecutionActive and f.global.PotassiumMcp.inFlightRequests == 1, "disconnect must not release still-running request ownership")
		local generation = f.global.PotassiumMcp.generation
		f.run(bootstrapSource, "blocked-running-bootstrap-reload")
		assert(f.global.PotassiumMcp.generation == generation, "reload guard must retain a disconnected running execution")
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		local replacement = f.sockets[2]
		f.authenticate(replacement)
		f.reject(replacement, "execute_luau", { code = "_G.overlapRan = true" })
		assert(not f.global.originalReturned and not f.global.duplicateRan and not f.global.overlapRan, "neither duplicate nor recovery may overlap uncertain execution")
		f.scheduler.advance(3)
		assert(f.global.originalReturned and f.global.executions == 1 and original() == nil, "original must finish once without responding on a stale transport")
		local resources = f.request(replacement, "capabilities", {}).resources
		assert(resources.handlers.duplicateIds == 1 and not f.global.PotassiumMcp.rawExecutionActive, "duplicate accounting must preserve natural lock release")
		f.teardown()
	end)
	check("async acceptance survives response loss without replaying accepted code", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local accepted
		socket.beforeSend = function(message)
			if message.type == "response" and message.ok and message.result.jobId then
				accepted = message.result.jobId
				socket:Close()
				error("fixture disconnect after async acceptance")
			end
		end
		local response, id = f.begin(socket, "execute_luau_async", { code = "_G.acceptedRuns = (_G.acceptedRuns or 0) + 1; task.wait(); return 41" })
		assert(accepted and response() == nil and f.responseCount(socket, id) == 0, "lost acceptance must remain explicitly uncertain")
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		socket = f.sockets[2]
		f.authenticate(socket)
		local listed = f.request(socket, "async_job_list", {})
		assert(#listed.jobs == 1 and listed.jobs[1].jobId == accepted, "reconnect must recover the accepted job by metadata rather than resubmit")
		assert(f.finished(socket, accepted).result.values[1] == 41 and f.global.acceptedRuns == 1, "accepted code must execute once despite response loss")
		f.teardown()
	end)
	check("Send throwing after delivery never emits a competing error response", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		socket.beforeSend = function(message)
			if message.type == "response" then
				table.insert(socket.sent, message)
				error("fixture send acknowledgement lost after delivery")
			end
		end
		local response, id = f.begin(socket, "execute_luau", { code = "_G.deliveredRuns = (_G.deliveredRuns or 0) + 1; return 5" })
		assert(response().ok and f.responseCount(socket, id) == 1 and socket.closed, "uncertain Send must close without a second response")
		assert(f.global.deliveredRuns == 1, "transport uncertainty must never replay code")
		local failAfterDelivery = socket.beforeSend
		socket = f.reconnect(socket)
		socket.beforeSend = failAfterDelivery
		local failure, failureId = f.begin(socket, "unknown_fixture_method", {})
		assert(not failure().ok and f.responseCount(socket, failureId) == 1 and socket.closed, "uncertain error delivery must also close without competing outcomes")
		f.teardown()
	end)
	check("teardown disconnects log observers immediately but waits for running code to finish", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local logs = f.begin(socket, "observe_logs", { durationMs = 5000 })
		local id = f.request(socket, "execute_luau_async", { code = [[
			local job = ...
			job.trackConnection(workspace.AttributeChanged:Connect(function() end))
			_G.noncooperativeEntered = true
			task.wait(2)
			_G.noncooperativeReturned = true
			return 9
		]] }).jobId
		f.scheduler.untilTrue(function() return f.global.noncooperativeEntered end)
		local state = f.global.PotassiumMcp
		state.teardown()
		assert(f.connectionCounters().active == 0 and f.logService.MessageOut:Count() == 0, "teardown must release transport, log and job listeners immediately")
		assert(state.asyncJobs[id].state == "running" and state.rawExecutionActive and state.inFlightRequests == 1, "listener cleanup is not completion of sleeping handlers or noncooperative code")
		f.scheduler.advance(6)
		assert(f.global.noncooperativeReturned and state.asyncJobs[id].state == "cancelled" and state.asyncJobs[id].result == nil, "noncooperative natural return after teardown must be terminal cancellation, never success")
		assert(not state.rawExecutionActive and state.inFlightRequests == 0 and logs() == nil, "bounded waits must release ownership without publishing stale responses")
		f.teardown()
	end)
	check("autoexec preserves active generations and exhausts only transient missing-file retries", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local state = f.global.PotassiumMcp
		local generation = state.generation
		local build = f.request(socket, "capabilities", {}).bootstrap.build
		local reads = 0
		f.environment.readfile = function() reads += 1; error("new deployed asset unavailable") end
		f.run(autoexecSource, "active-autoexec")
		socket:Close()
		f.run(autoexecSource, "reconnecting-autoexec")
		assert(reads == 0 and f.global.PotassiumMcp == state, "deployed assets must not replace an active or reconnecting generation")
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		f.authenticate(f.sockets[2])
		local capability = f.request(f.sockets[2], "capabilities", {})
		assert(capability.bootstrap.build == build and capability.bootstrap.generation == generation, "running build and generation must survive transport reconnect")
		f.teardown()
		local replacement = fixture()
		local oldSocket = replacement.boot()
		replacement.authenticate(oldSocket)
		local oldReference = replacement.request(oldSocket, "inspect_instance", { path = "workspace", includeReferences = true }).reference
		local oldGeneration = replacement.global.PotassiumMcp.generation
		replacement.global.PotassiumMcp.teardown()
		replacement.run(bootstrapSource, "generation-cutover")
		replacement.scheduler.untilTrue(function() return #replacement.sockets == 2 and #replacement.sockets[2].sent > 0 end)
		local newSocket = replacement.sockets[2]
		replacement.authenticate(newSocket)
		local newCapability = replacement.request(newSocket, "capabilities", {})
		assert(newCapability.bootstrap.generation > oldGeneration, "explicit inactive cutover must report the new running generation")
		replacement.reject(newSocket, "inspect_instance", { path = oldReference })
		assert(replacement.request(newSocket, "inspect_instance", { path = "workspace", includeReferences = true }).reference ~= oldReference, "generation cutover must never reissue a previous-generation handle")
		replacement.teardown()
		local missing = fixture()
		local attempts = 0
		missing.environment.readfile = function() attempts += 1; error("absent") end
		missing.run(autoexecSource, "missing-autoexec")
		missing.scheduler.untilTrue(function() return #missing.warnings == 1 end)
		assert(attempts == 10 and not missing.global.PotassiumMcp and #missing.sockets == 0, "missing bootstrap must exhaust a bounded retry without claiming startup")
		local broken = fixture()
		local compilations = 0
		broken.environment.readfile = function() return "broken" end
		broken.environment.loadstring = function() compilations += 1; return nil, "syntax" end
		broken.run(autoexecSource, "broken-autoexec")
		assert(compilations == 1 and #broken.warnings == 1 and #broken.sockets == 0, "invalid deployed code must fail once without claiming compatibility")
	end)

	check("failed hello sends release transport listeners before bounded reconnect", function()
		local f = fixture()
		local connect = f.environment.WebSocket.connect
		local attempts = 0
		f.environment.WebSocket.connect = function(...)
			local socket = connect(...)
			attempts += 1
			if attempts <= 3 then
				socket.beforeSend = function(message)
					if message.type == "hello" then error("fixture hello send failure") end
				end
			end
			return socket
		end
		local socket = f.boot()
		assert(attempts == 4 and #f.sockets == 4, "three failed hellos must recover through exactly three bounded reconnects")
		for index = 1, 3 do
			local failed = f.sockets[index]
			assert(failed.closed and failed.OnMessage:Count() == 0 and failed.OnClose:Count() == 0, "each failed hello must disconnect both transport listeners before replacement")
		end
		assert(f.connectionCounters().active == 2, "recovered transport must own only its two current listeners")
		f.authenticate(socket)
		assert(f.request(socket, "client_state", {}).placeId == 1, "recovered hello must still require and complete normal authentication")
		f.teardown()
	end)
	check("peer close retires native reconnect attempts before authenticating one replacement", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local nativeRetryAttempts, nativeRetryEnabled = 0, true
		local function nativeRetry()
			if nativeRetryEnabled and not socket.closed then
				nativeRetryAttempts += 1
				f.environment.task.delay(0.1, nativeRetry)
			end
		end
		-- Model the native transport staying retry-capable after peer closure;
		-- only explicit Close retires it. No additional Lua connect is invoked.
		f.environment.task.delay(0.1, nativeRetry)
		socket.OnClose:Fire()
		f.scheduler.advance(0.5)
		local retiredBeforeReplacement = nativeRetryAttempts == 0
		nativeRetryEnabled = false
		socket:Close()
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		local replacement = f.sockets[2]
		f.authenticate(replacement)
		assert(f.request(replacement, "client_state", {}).placeId == 1)
		f.scheduler.advance(2)
		assert(#f.sockets == 2, "only one Lua replacement may be created")
		f.teardown()
		assert(retiredBeforeReplacement, "retired transport attempted native reconnects")
	end)

	check("disabled socket releases ownership without weakening authentication", function()
		local f = fixture()
		local socket = f.boot()
		local hello = socket.sent[1]
		f.receive(socket, { type = "challenge", protocol = 2, clientNonce = hello.clientNonce, serverNonce = string.rep("b", 64), proof = string.rep("x", 43) .. "=" })
		assert(socket.closed and not f.global.PotassiumMcp.active, "invalid proof must disable and close")
		assert(f.global.PotassiumMcp.startupStatus == "disabled", "close must preserve fail-closed startup state")
		local oldGeneration = f.global.PotassiumMcp.generation
		f.run(bootstrapSource, "bootstrap-audit-reload")
		assert(f.global.PotassiumMcp.generation > oldGeneration, "closed disabled session must permit explicit bootstrap reload")
		f.scheduler.untilTrue(function() return #f.sockets == 2 end)
		f.authenticate(f.sockets[2])
		assert(not f.global.PotassiumMcp.startupReason, "reloaded session must authenticate normally")
	end)
	check("async console pages do not skip unread entries", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "execute_luau_async", { code = 'print("first"); print("second"); print("third"); return true' }).jobId
		f.scheduler.untilTrue(function() return f.global.PotassiumMcp.asyncJobs[id].state == "succeeded" end)
		local cursor = 0
		for _, text in ipairs({ "first", "second", "third" }) do
			local page = f.request(socket, "async_job_console", { jobId = id, afterCursor = cursor, limit = 1 })
			assert(#page.entries == 1 and page.entries[1].text == text, "cursor skipped an unread console entry")
			cursor = page.nextCursor
		end
		local empty = f.request(socket, "async_job_console", { jobId = id, afterCursor = cursor, limit = 1 })
		assert(#empty.entries == 0 and empty.nextCursor == cursor, "empty page must preserve cursor")
	end)
	check("false attribute changes preserve their boolean value and disconnect", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local response = f.begin(socket, "observe_changes", { path = "workspace", durationMs = 100, includeChildren = false })
		f.workspace.attributes.Flag = false
		f.workspace.AttributeChanged:Fire("Flag")
		f.scheduler.untilTrue(response)
		local received = response()
		assert(received.ok and #received.result.events == 1 and received.result.events[1].value == false, "boolean false must not serialize as nil")
		assert(f.workspace.AttributeChanged:Count() == 0, "temporary attribute observer must disconnect")
	end)
	check("summary cap reports truncation without inventing omitted counts", function()
		local f = fixture()
		f.instance("Child", "Folder", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "subtree_summary", { path = "workspace", maxSummaryEntries = 1 })
		assert(result.visited == 2 and #result.classCounts == 1 and result.classCounts[1].name == "Folder", "summary cap must preserve deterministic first count")
		assert(result.truncated == true, "omitted class counts must mark the summary truncated")
	end)
	check("autoexec retries transient file failure but stops at disabled startup", function()
		local f = fixture()
		local attempts = 0
		local tokenReader = f.environment.readfile
		f.environment.readfile = function(path)
			if path ~= ".potassium-mcp-bootstrap.lua" then return tokenReader(path) end
			attempts += 1
			if attempts < 3 then error("temporarily absent") end
			return bootstrapSource
		end
		f.run(autoexecSource, "bootstrap-audit-autoexec")
		f.scheduler.untilTrue(function() return f.global.PotassiumMcp ~= nil end)
		assert(attempts == 3 and f.global.PotassiumMcp.active, "transient bootstrap file failure must retry then start")
		local disabled = fixture()
		local disabledAttempts = 0
		disabled.environment.readfile = function(path)
			if path == ".potassium-mcp-bootstrap.lua" then disabledAttempts += 1; return bootstrapSource end
			error("no authentication token")
		end
		disabled.run(autoexecSource, "bootstrap-audit-disabled-autoexec")
		assert(disabledAttempts == 1 and not disabled.global.PotassiumMcp.active, "disabled bootstrap must not retry")
	end)
	check("watch overflow pages preserve false nil and unread cursors", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "watch_start", { path = "workspace", properties = { "Name" }, maxEvents = 3, includeChildren = false }).watchId
		f.workspace:SetProperty("Name", "Renamed")
		f.workspace:SetAttribute("Flag", true)
		f.workspace:SetAttribute("Flag", false)
		f.workspace:SetAttribute("Flag", nil)
		local first = f.request(socket, "watch_poll", { watchId = id, limit = 1 })
		assert(first.dropped == 1 and first.hasMore and first.nextCursor == 2, "overflow must report loss without skipping buffered events")
		assert(#first.events == 1 and first.events[1].value == true, "oldest retained event must be returned first")
		local second = f.request(socket, "watch_poll", { watchId = id, afterCursor = first.nextCursor, limit = 1 })
		assert(second.dropped == 0 and second.hasMore and second.nextCursor == 3 and second.events[1].value == false, "false and pagination cursor must survive")
		local third = f.request(socket, "watch_poll", { watchId = id, afterCursor = second.nextCursor, limit = 1 })
		assert(not third.hasMore and third.nextCursor == 4 and third.events[1].value.type == "nil", "removed attribute must be an explicit nil event")
		local empty = f.request(socket, "watch_poll", { watchId = id, afterCursor = third.nextCursor })
		assert(#empty.events == 0 and empty.nextCursor == third.nextCursor, "empty poll must preserve cursor")
		f.reject(socket, "watch_poll", { watchId = id, afterCursor = third.nextCursor + 1 })
	end)
	if options.jsonEncode then
		check("watch byte ring evicts oldest events before count capacity", function()
			local f = fixture()
			local socket = f.boot()
			f.authenticate(socket)
			local id = f.request(socket, "watch_start", { path = "workspace", maxEvents = 200, includeChildren = false }).watchId
			for index = 1, 100 do f.workspace:SetAttribute("Payload", string.rep("q", 1000) .. tostring(index)) end
			local page = f.request(socket, "watch_poll", { watchId = id, limit = 200 })
			assert(page.dropped > 0 and page.dropped + #page.events == 100, "byte eviction must report every lost event")
			assert(#options.jsonEncode(page.events) <= 65536 and page.nextCursor == 100, "retained events must fit the byte budget and end at the latest cursor")
			for index, event in ipairs(page.events) do
				assert(event.cursor == page.dropped + index and event.value == string.rep("q", 1000) .. tostring(event.cursor), "byte eviction must preserve an intact contiguous suffix")
			end
		end)
	end
	check("watch stop destroys subscriptions while preserving terminal buffers", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "watch_start", { path = "workspace", properties = { "Name" } }).watchId
		f.workspace:SetProperty("Name", "Observed")
		local child = f.instance("Child", "Folder", f.workspace)
		child:Destroy()
		f.request(socket, "watch_stop", { watchId = id })
		f.request(socket, "watch_stop", { watchId = id })
		assert(f.workspace:ListenerCount() == 0, "stop must immediately disconnect every subscription")
		f.workspace:SetAttribute("Ignored", true)
		local page = f.request(socket, "watch_poll", { watchId = id })
		assert(page.state == "stopped" and #page.events == 3, "stopped watch must retain only pre-stop events")
		assert(page.events[1].kind == "property" and page.events[1].value == "Observed", "property change must preserve its observed value")
		assert(page.events[2].kind == "child_added" and page.events[3].kind == "child_removed", "child lifecycle must remain ordered")
		f.scheduler.advance(50)
		f.request(socket, "watch_poll", { watchId = id })
		f.scheduler.advance(11)
		f.reject(socket, "watch_poll", { watchId = id })
	end)
	check("watch idle renewal and destruction release listeners without polling", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "watch_start", { path = "workspace", ttlSeconds = 10 }).watchId
		f.scheduler.advance(9)
		f.request(socket, "watch_poll", { watchId = id })
		f.scheduler.advance(9)
		f.workspace:SetAttribute("Renewed", true)
		assert(f.request(socket, "watch_poll", { watchId = id }).events[1].value == true, "poll must renew idle TTL")
		f.scheduler.advance(11)
		assert(f.workspace:ListenerCount() == 0, "idle timeout must release listeners even without another poll")
		assert(f.request(socket, "watch_poll", { watchId = id }).state == "expired", "idle watch must become expired")
		local target = f.instance("Target", "Folder", f.workspace)
		local destroyed = f.request(socket, "watch_start", { path = "workspace.Target" }).watchId
		target:Destroy()
		assert(target:ListenerCount() == 0, "target destruction must disconnect every subscription immediately")
		assert(f.request(socket, "watch_poll", { watchId = destroyed }).state == "destroyed", "target destruction must be observable")
	end)
	check("failed watch subscriptions roll back and capacity is reusable", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		f.workspace.ChildRemoved.failConnect = true
		f.reject(socket, "watch_start", { path = "workspace", properties = { "Name" } })
		assert(f.workspace:ListenerCount() == 0, "partial subscribe failure must disconnect earlier listeners")
		f.workspace.ChildRemoved.failConnect = false
		local ids = {}
		for index = 1, 16 do ids[index] = f.request(socket, "watch_start", { path = "workspace" }).watchId end
		local listeners = f.workspace:ListenerCount()
		f.reject(socket, "watch_start", { path = "workspace" })
		assert(f.workspace:ListenerCount() == listeners, "capacity rejection must not attach listeners")
		f.request(socket, "watch_stop", { watchId = ids[1] })
		local replacement = f.request(socket, "watch_start", { path = "workspace" }).watchId
		f.workspace:SetAttribute("Capacity", true)
		assert(f.request(socket, "watch_poll", { watchId = replacement }).events[1].value == true, "stopping a watch must free active capacity")
	end)
	check("watches survive reconnect but generation replacement disconnects", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "watch_start", { path = "workspace" }).watchId
		socket:Close()
		f.workspace:SetAttribute("Offline", false)
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		socket = f.sockets[2]
		f.authenticate(socket)
		assert(f.request(socket, "watch_poll", { watchId = id }).events[1].value == false, "same-generation reconnect must retain watch and offline events")
		f.global.PotassiumMcp.active = false
		socket:Close()
		f.run(bootstrapSource, "bootstrap-watch-replacement")
		assert(f.workspace:ListenerCount() == 0, "generation replacement must disconnect old watch listeners")
		f.scheduler.untilTrue(function() return #f.sockets == 3 and #f.sockets[3].sent > 0 end)
		f.authenticate(f.sockets[3])
		f.reject(f.sockets[3], "watch_poll", { watchId = id })
	end)
	check("queued cancellation cannot execute after waiting for the raw lock", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local sync = f.begin(socket, "execute_luau", { code = "task.wait(2); return true" })
		local cancelled = f.request(socket, "execute_luau_async", { code = "_G.cancelledChunkRan = true" }).jobId
		f.scheduler.advance(0.1)
		assert(f.request(socket, "async_job_cancel", { jobId = cancelled }).state == "cancelled", "queued cancellation must be terminal immediately")
		local following = f.request(socket, "execute_luau_async", { code = "return 23" }).jobId
		local result = f.finished(socket, following)
		assert(sync().ok and result.state == "succeeded" and result.result.values[1] == 23, "uncancelled queued work must resume normally")
		assert(f.global.cancelledChunkRan == nil, "cancelled queued chunk must never execute")
		assert(f.request(socket, "async_job_result", { jobId = cancelled }).state == "cancelled", "cancelled result must remain cancelled after queue drains")
	end)
	check("running cancellation disconnects now but preserves the execution lock until checkpoint", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "execute_luau_async", { code = [[
			local job = ...
			_G.job = job
			_G.connection = job.trackConnection(workspace.AttributeChanged:Connect(function() _G.listenerRan = true end))
			task.wait(1)
			_G.cancelObserved = job.isCancellationRequested()
			_G.late = job.trackConnection(workspace.AttributeChanged:Connect(function() end))
			job.checkpoint()
			_G.afterCheckpoint = true
		]] }).jobId
		f.scheduler.untilTrue(function() return f.global.connection ~= nil end)
		local status = f.request(socket, "async_job_cancel", { jobId = id })
		assert(status.state == "running" and status.cancellationRequested, "running cancellation is only a request until user code exits")
		assert(not f.global.connection.Connected and f.workspace.AttributeChanged:Count() == 0, "cancellation must disconnect tracked listeners immediately")
		f.workspace:SetAttribute("AfterCancel", true)
		assert(not f.global.listenerRan, "cancelled listeners must not run")
		assert(not f.request(socket, "async_job_result", { jobId = id }).ready, "yielding code must not be declared terminal early")
		f.reject(socket, "execute_luau", { code = "_G.overlap = true" })
		local following = f.request(socket, "execute_luau_async", { code = "_G.following = true; return 31" }).jobId
		f.scheduler.advance(0.1)
		assert(not f.global.following and not f.global.overlap, "cancel must not free raw execution ownership early")
		local result = f.finished(socket, id)
		assert(result.state == "cancelled" and f.global.cancelObserved and not f.global.afterCheckpoint, "checkpoint must terminate cancelled code")
		assert(not f.global.late.Connected, "registration after cancellation must disconnect the real supplied connection")
		assert(f.finished(socket, following).result.values[1] == 31, "raw lock must become available when cancelled chunk exits")
	end)
	check("noncooperative cancellation remains running until the chunk returns", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local id = f.request(socket, "execute_luau_async", { code = "_G.entered = true; task.wait(1); _G.returned = true; return 99" }).jobId
		f.scheduler.untilTrue(function() return f.global.entered end)
		f.request(socket, "async_job_cancel", { jobId = id })
		f.reject(socket, "execute_luau", { code = "return 1" })
		assert(f.request(socket, "async_job_status", { jobId = id }).state == "running", "noncooperative code retains running state")
		local result = f.finished(socket, id)
		assert(f.global.returned and result.state == "cancelled" and result.result == nil, "normal return after cancellation must not publish a success result")
	end)
	check("job terminal outcomes clean tracked connections and reject over-capacity registration", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local success = f.request(socket, "execute_luau_async", { code = [[
			local job = ...
			_G.completedJob = job
			_G.successConnection = workspace.AttributeChanged:Connect(function() end)
			assert(job.trackConnection(_G.successConnection) == _G.successConnection)
			return true
		]] }).jobId
		assert(f.finished(socket, success).state == "succeeded" and not f.global.successConnection.Connected, "successful completion must disconnect tracked connections")
		local late = f.workspace.AttributeChanged:Connect(function() end)
		assert(f.global.completedJob.trackConnection(late) == late and not late.Connected, "late terminal registration must disconnect the supplied connection")
		local failure = f.request(socket, "execute_luau_async", { code = [[
			local job = ...
			_G.failureConnection = job.trackConnection(workspace.AttributeChanged:Connect(function() end))
			error("intentional job failure")
		]] }).jobId
		assert(f.finished(socket, failure).state == "failed" and not f.global.failureConnection.Connected, "failure must disconnect tracked connections")
		local capacity = f.request(socket, "execute_luau_async", { code = [[
			local job = ...
			for _ = 1, 128 do job.trackConnection(workspace.AttributeChanged:Connect(function() end)) end
			_G.atCapacity = true
			_G.overflowConnection = workspace.AttributeChanged:Connect(function() end)
			job.trackConnection(_G.overflowConnection)
			_G.overCapacity = true
		]] }).jobId
		assert(f.finished(socket, capacity).state == "failed" and f.global.atCapacity and not f.global.overCapacity, "tracking must accept 128 listeners and reject the next")
		assert(f.workspace.AttributeChanged:Count() == 0, "tracking overflow must not leak accepted or rejected connections")
		local listed = f.request(socket, "async_job_list", { limit = 2 })
		assert(listed.truncated and #listed.jobs == 2 and listed.jobs[1].jobId == success and listed.jobs[2].jobId == failure, "list must break equal submission-time ties by job id before limiting")
		assert(listed.jobs[1].result == nil and listed.jobs[1].code == nil and listed.jobs[1].console == nil, "list must not expose user code, result, or console")
	end)
	check("mixed batch isolates target and property failures while preserving safe values", function()
		local f = fixture()
		local target = f.instance("Target", "Folder", f.workspace)
		target.Archivable = false
		target.attributes.Flag = false
		target.attributes["Bearer fixture-private-attribute"] = "https://private.example/secret"
		target.attributes.Unsupported = {}
		f.instance("Bearer fixture-private-child", "Folder", target)
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "batch_read", { requests = {
			{ path = "workspace.Target", properties = { "Archivable", "Source", "Name" }, attributes = { names = {} }, children = {} },
			{ path = "workspace.MissingBearerSecret", properties = { "Name" } },
			{ path = "game", properties = { "Parent", "Name" } },
		} })
		assert(result.requestCount == 3 and #result.results == 3 and result.valueCount == 8, "mixed facets must count attempted property slots and emitted scalar attributes/children")
		local first, missing, last = result.results[1], result.results[2], result.results[3]
		assert(first.index == 1 and first.ok and last.index == 3 and last.ok, "one missing middle target must not abort safe siblings")
		assert(first.properties.Archivable.ok and first.properties.Archivable.value == false and first.properties.Name.value == "Target", "safe properties and false must survive a denied sibling")
		assert(not first.properties.Source.ok, "batch must enforce the normal property deny policy")
		assert(not missing.ok and missing.index == 2 and missing.error.code == "TARGET_UNAVAILABLE", "missing target must occupy its original row")
		assert(not string.find(missing.error.message, "MissingBearerSecret", 1, true), "missing target errors must not disclose path segments")
		assert(last.properties.Parent.ok and last.properties.Parent.value.type == "nil", "nil property values must remain explicit")
		local attributes = {}
		for _, entry in ipairs(first.attributes.values) do attributes[entry.name] = entry.value end
		assert(attributes.Flag == false and attributes["[redacted]"] == "[redacted]" and attributes.Unsupported == nil, "attribute filtering must preserve false and redact both names and values")
		assert(first.children.children[1].name == "[redacted]" and not string.find(first.children.children[1].path, "private-child", 1, true), "child summary names and paths must be redacted")
		assert(first.instance.reference == nil and target.Destroying:Count() == 0, "ordinary batch summaries must not allocate references")
	end)
	check("batch validates every nested shape before reading any target", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local reads = 0
		local original = f.workspace.GetAttributes
		f.workspace.GetAttributes = function(self) reads += 1; return original(self) end
		local invalid = {
			{ requests = { { path = "workspace", attributes = {} }, { path = "workspace" } } },
			{ requests = { { path = "workspace", attributes = {} }, { path = "workspace", properties = { "Name.Source" } } } },
			{ requests = { { path = "workspace", attributes = { unknown = true } } } },
			{ requests = { { path = "workspace", children = { limit = 1.5 } } } },
			{ requests = { { path = "workspace", properties = { "Name" }, extra = true } } },
			{ requests = { { path = "workspace", attributes = {} } }, includeReferences = "true" },
			{ requests = { { path = "workspace", attributes = {} } }, maxTotalValues = 201 },
			{ requests = { { path = "workspace", attributes = {} } }, extra = true },
		}
		for _, params in ipairs(invalid) do f.reject(socket, "batch_read", params) end
		assert(reads == 0, "invalid later rows or nested keys must be rejected before earlier getters run")
	end)
	check("batch getter errors remain facet errors rather than empty success", function()
		local f = fixture()
		local target = f.instance("Broken", "Folder", f.workspace)
		target.GetAttributes = function() error("Bearer fixture-private-getter") end
		target.GetChildren = function() error("https://private.example/getter") end
		local metatable = getmetatable(target)
		local originalIndex = metatable.__index
		metatable.__index = function(self, key)
			if key == "Transparency" then error("Bearer fixture-private-property") end
			return originalIndex(self, key)
		end
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "batch_read", { requests = {
			{ path = "workspace.Broken", properties = { "Name", "Transparency" }, attributes = {}, children = {} },
			{ path = "workspace", properties = { "Name" } },
		} })
		local row = result.results[1]
		assert(row.ok and row.properties.Name.value == "Broken" and not row.properties.Transparency.ok, "getter failure must not lose a readable property")
		assert(not row.attributes.ok and not row.children.ok and result.results[2].ok, "failed facet getters must not become empty success or abort siblings")
		for _, message in ipairs({ row.attributes.error, row.children.error, row.properties.Transparency.error }) do
			assert(not string.find(message, "private", 1, true), "getter errors must be safely redacted")
		end
	end)
	check("batch spends global quota dynamically and retains partially completed facets", function()
		local f = fixture()
		f.workspace.attributes.Flag = false
		f.instance("A", "Folder", f.workspace)
		f.instance("B", "Folder", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local result = f.request(socket, "batch_read", { maxTotalValues = 3, requests = {
			{ path = "workspace", properties = { "Source" }, attributes = { limit = 32 }, children = { limit = 100 } },
			{ path = "workspace", properties = { "Name" } },
		} })
		local row = result.results[1]
		assert(result.valueCount == 3 and result.truncated and row.ok and row.truncated, "maxima must not pre-reject a dynamically bounded batch")
		assert(not row.properties.Source.ok and row.attributes.values[1].value == false and not row.attributes.truncated, "denied property must consume a slot without losing completed attributes")
		assert(row.children.truncated and row.children.total == 2 and #row.children.children == 1 and row.children.children[1].name == "A", "child quota must preserve deterministic accepted prefix")
		assert(#result.results == 2 and result.results[2].index == 2 and result.results[2].error.code == "BUDGET_EXHAUSTED", "exhausted later rows must remain represented")
		local partial = f.request(socket, "batch_read", { maxTotalValues = 1, requests = {
			{ path = "workspace", properties = { "Name", "Archivable" }, attributes = {}, children = {} },
		} })
		assert(partial.valueCount == 1 and partial.results[1].ok and partial.results[1].truncated, "quota exhausted inside properties must preserve the row and completed property")
		assert(partial.results[1].properties.Name.value == "Workspace" and partial.results[1].properties.Archivable == nil, "property quota must follow request order")
	end)
	if options.jsonEncode then
		check("batch escaped byte quota preserves every row and allocates only returned references", function()
			local f = fixture()
			local requests, roots = {}, {}
			for index = 1, 20 do
				local root = f.instance(string.format("Row%02d", index), "Folder", f.workspace)
				roots[index] = root
				for child = 1, 10 do
					f.instance(string.rep("\1", 4000) .. tostring(child), "Folder", root)
				end
				requests[index] = { path = "workspace." .. root.Name, children = { limit = 10 } }
			end
			local socket = f.boot()
			f.authenticate(socket)
			local result = f.request(socket, "batch_read", { requests = requests, includeReferences = true })
			assert(#options.jsonEncode(result) <= 65536 and result.truncated and #result.results == 20, "hard raw JSON cap must include escaping, references, envelope, and all remaining rows")
			local emitted, returned = 0, {}
			for index, row in ipairs(result.results) do
				assert(row.index == index, "byte truncation must preserve original row positions")
				if row.ok then
					assert(type(row.instance.reference) == "string", "accepted batch roots must receive references")
					returned[row.instance.reference] = true
					for _, child in ipairs(row.children.children) do
						emitted += 1
						assert(type(child.reference) == "string", "accepted batch children must receive references")
						returned[child.reference] = true
					end
				else
					assert(row.error.code == "RESULT_LIMIT" or row.error.code == "BUDGET_EXHAUSTED", "byte fallback must remain a bounded row error")
				end
			end
			assert(result.valueCount == emitted, "discarded child summaries must not consume emitted-value quota")
			local listeners, references = 0, 0
			for _ in pairs(returned) do references += 1 end
			for _, root in ipairs(roots) do
				listeners += root.Destroying:Count()
				for _, child in ipairs(root.children) do listeners += child.Destroying:Count() end
			end
			assert(listeners == references, "discarded rows and summaries must never leak inaccessible reference allocations")
		end)
		check("discarded Folder rows retain shared summary serialization charges", function()
			local f = fixture()
			local root = f.instance(string.rep("a", 900), "Folder", f.workspace)
			local path = "workspace." .. root.Name
			assert(#path <= 1024, "fixture ancestry must remain a valid bounded request path")
			local summaryReads = 0
			for index = 1, 100 do
				local child = f.instance(string.format("Child%03d", index), "Folder", root)
				function child:IsA(expected)
					if expected == "BasePart" then summaryReads += 1 end
					return expected == "Folder"
				end
			end
			local requests = {}
			for index = 1, 20 do requests[index] = { path = path, children = { limit = 100 } } end
			local socket = f.boot()
			f.authenticate(socket)
			local result = f.request(socket, "batch_read", { requests = requests, includeReferences = true })
			assert(result.truncated and #result.results == 20 and #options.jsonEncode(result) <= 65536, "discarded rows must retain bounded ordered response coverage")
			for _, row in ipairs(result.results) do
				assert(not row.ok and row.error.code == "RESULT_LIMIT", "each oversized Folder row must remain a result-limit error")
			end
			assert(summaryReads > 50 and summaryReads <= 400, "discarded summaries must spend aggregate bytes rather than repeating near-64KiB work for every row")
			assert(result.valueCount == 0 and root.Destroying:Count() == 0, "discarded Folder rows must not allocate root references or emitted-value quota")
			for _, child in ipairs(root.children) do assert(child.Destroying:Count() == 0, "discarded child summaries must not allocate references") end
		end)
		check("duplicate Value properties reserve replacement bytes but count every read", function()
			local f = fixture()
			local target = f.instance("Payload", "StringValue", f.workspace)
			local payload, reads = string.rep("v", 4096), 0
			local metatable = getmetatable(target)
			local originalIndex = metatable.__index
			metatable.__index = function(self, key)
				if key == "Value" then reads += 1; return payload end
				return originalIndex(self, key)
			end
			local properties = {}
			for index = 1, 32 do properties[index] = "Value" end
			local socket = f.boot()
			f.authenticate(socket)
			f.request(socket, "batch_read", { requests = { { path = "workspace.Payload", properties = { "Name" } } } })
			local summaryReads = reads
			reads = 0
			local result = f.request(socket, "batch_read", { requests = { { path = "workspace.Payload", properties = properties } } })
			assert(reads - summaryReads == 32 and result.valueCount == 32, "duplicate property attempts must each consume read quota beyond metadata sampling")
			assert(not result.truncated and result.results[1].ok and result.results[1].properties.Value.value == payload, "replacement map entries must fit without accumulating discarded duplicate output bytes")
			assert(#options.jsonEncode(result) <= 65536, "accepted duplicate property row must satisfy the real encoded byte cap")
		end)
	end
	check("opt-in references distinguish duplicate names and survive rename reparent and detach", function()
		local f = fixture()
		local left = f.instance("Left", "Folder", f.workspace)
		local right = f.instance("Right", "Folder", f.workspace)
		local first = f.instance("Duplicate", "Folder", left)
		local second = f.instance("Duplicate", "Folder", left)
		first.attributes.Identity, second.attributes.Identity = 1, 2
		local socket = f.boot()
		f.authenticate(socket)
		local plain = f.request(socket, "list_children", { path = "workspace.Left" })
		assert(plain.instance.reference == nil and plain.children[1].reference == nil and first.Destroying:Count() == 0, "default discovery must not allocate reference bookkeeping")
		local listed = f.request(socket, "list_children", { path = "workspace.Left", includeReferences = true })
		local a, b = listed.children[1].reference, listed.children[2].reference
		assert(type(a) == "string" and #a == 43 and string.match(a, "^instance://[0-9a-f]+$") and a ~= b, "duplicate-name objects need distinct exact reference URIs")
		local identities = {}
		for _, reference in ipairs({ a, b }) do
			local item = f.request(socket, "inspect_instance", { path = reference, includeReferences = true })
			identities[item.attributes.Identity] = reference
			assert(item.reference == reference, "reacquiring a live object must preserve its reference")
		end
		local reference = identities[1]
		first.Name = "Moved"
		first.Parent = right
		assert(#left.children == 1 and right.children[1] == first, "fixture reparent must update both parents")
		assert(f.request(socket, "inspect_instance", { path = reference }).path == "game.Workspace.Right.Moved", "reference identity must not depend on old display paths")
		first.Parent = nil
		assert(f.request(socket, "inspect_instance", { path = reference, includeReferences = true }).reference == reference, "temporary detach is not destruction")
		first.Parent = right
		assert(f.request(socket, "inspect_instance", { path = "workspace.Right.Moved", includeReferences = true }).reference == reference, "reparented path acquisition must reuse the original identity")
		assert(first.Destroying:Count() == 1 and second.Destroying:Count() == 1, "reacquisition must not duplicate destruction listeners")
	end)
	check("reference release destruction and generation replacement invalidate without disrupting watches", function()
		local f = fixture()
		local target = f.instance("Target", "Folder", f.workspace)
		local child = f.instance("Child", "Folder", target)
		local socket = f.boot()
		f.authenticate(socket)
		local root = f.request(socket, "inspect_instance", { path = "workspace.Target", depth = 1, includeReferences = true })
		local reference, childReference = root.reference, root.children[1].reference
		local watch = f.request(socket, "watch_start", { path = reference, includeChildren = false }).watchId
		local released = f.request(socket, "instance_references_release", { references = { reference, reference } })
		assert(#released.results == 2 and released.results[1].reference == reference and released.results[1].released and not released.results[2].released, "release must preserve order and be idempotent")
		f.reject(socket, "inspect_instance", { path = reference })
		target:SetAttribute("StillWatched", false)
		assert(f.request(socket, "watch_poll", { watchId = watch }).events[1].value == false, "reference release must not invalidate an existing watch's independently owned Instance")
		f.request(socket, "watch_stop", { watchId = watch })
		assert(target:ListenerCount() == 0, "reference release and watch stop must disconnect their own listeners immediately")
		local renewed = f.request(socket, "inspect_instance", { path = "workspace.Target", includeReferences = true }).reference
		assert(renewed ~= reference, "released tokens must never be deliberately reused")
		target:Destroy()
		assert(target:ListenerCount() == 0 and child:ListenerCount() == 0, "deep destruction must immediately disconnect all descendant reference listeners")
		f.reject(socket, "inspect_instance", { path = renewed })
		f.reject(socket, "inspect_instance", { path = childReference })
		local live = f.request(socket, "inspect_instance", { path = "workspace", includeReferences = true }).reference
		socket:Close()
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		socket = f.sockets[2]
		f.authenticate(socket)
		assert(f.request(socket, "inspect_instance", { path = live, includeReferences = true }).reference == live, "socket reconnect must retain the registry")
		f.global.PotassiumMcp.active = false
		socket:Close()
		f.run(bootstrapSource, "bootstrap-reference-replacement")
		assert(f.workspace.Destroying:Count() == 0, "generation teardown must disconnect reference listeners")
		f.scheduler.untilTrue(function() return #f.sockets == 3 and #f.sockets[3].sent > 0 end)
		socket = f.sockets[3]
		f.authenticate(socket)
		f.reject(socket, "inspect_instance", { path = live })
		assert(f.request(socket, "inspect_instance", { path = "workspace", includeReferences = true }).reference ~= live, "new generation must not reissue an old token")
	end)
	check("central reference consumers preserve ancestry and existing property restrictions", function()
		local f = fixture()
		local target = f.instance("Target", "Script", f.workspace)
		target.Source, target.Archivable = "private source", false
		local socket = f.boot()
		f.authenticate(socket)
		local parent = f.request(socket, "inspect_instance", { path = "workspace", includeReferences = true }).reference
		local reference = f.request(socket, "inspect_instance", { path = "workspace.Target", includeReferences = true }).reference
		local ancestry = f.request(socket, "instance_ancestry", { path = reference, otherPath = parent })
		assert(ancestry.pathIsDescendantOfOther and not ancestry.otherIsDescendantOfPath and ancestry.commonAncestor.name == "Workspace", "otherPath and primary path must use the same identity resolver")
		local read = f.request(socket, "multi_read_properties", { requests = { { path = reference, properties = { "Archivable" } } } })
		assert(read.results[1].properties.Archivable.value == false, "existing property-only multi-read must consume stable references")
		f.reject(socket, "multi_read_properties", { requests = { { path = reference, properties = { "Source" } } } })
		assert(not f.request(socket, "read_properties", { path = reference, properties = { "Source" } }).properties.Source.ok, "reference lookup must never widen source access")
		local found = f.request(socket, "find_instances", { root = parent, nameContains = "Target", includeReferences = true })
		assert(found.root.reference == parent and found.results[1].reference == reference, "discovery roots and matched summaries must reuse registry identity")
		local batch = f.request(socket, "batch_read", { includeReferences = true, requests = {
			{ path = parent, children = {} },
			{ path = reference, properties = { "Source", "Archivable" } },
		} })
		assert(batch.results[1].instance.reference == parent and batch.results[1].children.children[1].reference == reference, "reference-bearing batches must return root and child identity")
		assert(not batch.results[2].properties.Source.ok and batch.results[2].properties.Archivable.value == false, "reference-bearing batches must retain per-property policy")
		local decoy = f.instance(reference, "Folder", f.environment.game)
		f.instance("Name", "Folder", decoy)
		for _, malformed in ipairs({ reference .. ".Name", string.upper(reference), " " .. reference, reference .. " ", "instance://short", "instance://" .. string.rep("A", 32), "instance://" .. string.rep("f", 32) }) do
			f.instance(malformed, "Folder", f.environment.game)
			f.reject(socket, "inspect_instance", { path = malformed })
			local result = f.request(socket, "batch_read", { requests = { { path = malformed, properties = { "Name" } }, { path = parent, properties = { "Name" } } } })
			assert(result.results[1].error.code == "TARGET_UNAVAILABLE" and result.results[2].ok, "malformed or unknown references must not fall back to dotted lookup")
			f.reject(socket, "spatial_query", { mode = "radius", center = { x = 0, y = 0, z = 0 }, radius = 1, excludePaths = { malformed } })
		end
		f.reject(socket, "instance_references_release", { references = { reference, reference .. ".Name" } })
		f.reject(socket, "instance_references_release", { references = { reference }, extra = true })
		assert(f.request(socket, "inspect_instance", { path = reference }).name == "Target", "invalid release shapes must not release valid entries")
	end)
	check("reference capacity includes tombstones and failed multi-acquisition is transactional", function()
		local f = fixture()
		local socket = f.boot()
		f.authenticate(socket)
		local refs, nodes = {}, {}
		for index = 1, 1023 do
			local node = f.instance("Entry" .. index, "Folder", f.workspace)
			nodes[index] = node
			refs[index] = f.request(socket, "inspect_instance", { path = "workspace." .. node.Name, includeReferences = true }).reference
		end
		nodes[1]:Destroy()
		local pair = f.instance("Pair", "Folder", f.workspace)
		local child = f.instance("Child", "Folder", pair)
		f.reject(socket, "inspect_instance", { path = "workspace.Pair", depth = 1, includeReferences = true })
		assert(pair.Destroying:Count() == 0 and child.Destroying:Count() == 0, "capacity rejection must allocate neither a root nor an inaccessible child")
		local last = f.request(socket, "inspect_instance", { path = "workspace.Pair", includeReferences = true }).reference
		f.reject(socket, "inspect_instance", { path = "workspace.Pair.Child", includeReferences = true })
		assert(child.Destroying:Count() == 0, "destroyed tombstones must still occupy capacity")
		assert(f.request(socket, "inspect_instance", { path = last, includeReferences = true }).reference == last, "full registry must permit existing-reference reuse")
		f.request(socket, "instance_references_release", { references = { refs[1] } })
		local acquired = f.request(socket, "inspect_instance", { path = "workspace.Pair.Child", includeReferences = true }).reference
		assert(acquired ~= refs[1] and child.Destroying:Count() == 1, "explicit tombstone release must free capacity without token reuse")
		f.request(socket, "instance_references_release", { references = { acquired, last } })
		local broken = f.instance("Broken", "Folder", pair)
		broken.Destroying.failConnect = true
		child.Parent = nil
		f.reject(socket, "inspect_instance", { path = "workspace.Pair", depth = 1, includeReferences = true })
		assert(pair.Destroying:Count() == 0 and broken.Destroying:Count() == 0, "subscription failure must roll back all newly connected references")
		broken.Destroying.failConnect = false
		local recovered = f.request(socket, "inspect_instance", { path = "workspace.Pair", depth = 1, includeReferences = true })
		assert(recovered.reference ~= last and recovered.children[1].reference ~= nil, "subscription rollback must return capacity for a subsequent real acquisition")
	end)
	check("yielding discovery keeps reference opt-in local and refuses newly detached candidates", function()
		local f = fixture()
		for index = 1, 200 do f.instance(string.format("Child%03d", index), "Folder", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local issuing = f.begin(socket, "find_instances", { root = "workspace", limit = 200, maxVisited = 1000, includeReferences = true })
		assert(issuing() == nil, "wide traversal must yield so concurrent request isolation is exercised")
		local plain = f.request(socket, "inspect_instance", { path = "workspace.Child001" })
		assert(plain.reference == nil, "concurrent plain inspection must not inherit another traversal's opt-in")
		f.scheduler.untilTrue(issuing)
		local issued = issuing()
		assert(issued.ok and issued.result.root.reference ~= nil, "yielding opt-in traversal must commit references after collection")
		for _, item in ipairs(issued.result.results) do assert(item.reference ~= nil, "every emitted discovery summary must carry its requested reference") end
		local detached = f.instance("Detached", "Folder", f.workspace)
		local child = f.instance("Child", "Folder", detached)
		for index = 1, 200 do f.instance(string.format("Wide%03d", index), "Folder", child) end
		local pending = f.begin(socket, "inspect_instance", { path = "workspace.Detached", depth = 2, childLimit = 500, includeReferences = true })
		assert(pending() == nil, "deep inspection must yield before transactional acquisition")
		detached.Parent = nil
		f.scheduler.untilTrue(pending)
		assert(not pending().ok and detached.Destroying:Count() == 0 and child.Destroying:Count() == 0, "newly detached traversal candidates must fail without partial reference issuance")
	end)
	check("yielding reference discovery cannot commit across socket reconnect", function()
		local f = fixture()
		for index = 1, 200 do f.instance(string.format("Child%03d", index), "Folder", f.workspace) end
		local socket = f.boot()
		f.authenticate(socket)
		local prior = f.request(socket, "inspect_instance", { path = "workspace", includeReferences = true }).reference
		local wait, paused, resumed = f.environment.task.wait, false, false
		f.environment.task.wait = function(delay)
			if delay == nil and not paused then
				paused = true
				wait(10)
				resumed = true
				return
			end
			return wait(delay)
		end
		local issuing = f.begin(socket, "find_instances", { root = "workspace", limit = 200, maxVisited = 1000, includeReferences = true })
		assert(paused and issuing() == nil, "reference traversal must pause before ownership commit")
		socket:Close()
		f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
		local replacement = f.sockets[2]
		f.authenticate(replacement)
		assert(not resumed, "replacement socket must authenticate before the old traversal resumes")
		f.scheduler.advance(11)
		assert(resumed and issuing() == nil, "old request must resume without publishing a response on its closed socket")
		assert(f.workspace.Destroying:Count() == 1, "reconnect must retain exactly the prior reference listener")
		for _, child in ipairs(f.workspace.children) do assert(child.Destroying:Count() == 0, "old socket traversal must not allocate any new reference listener") end
		assert(f.request(replacement, "inspect_instance", { path = prior, includeReferences = true }).reference == prior, "prior references must survive rejected stale traversal commit")
	end)
	check("response Send failure rolls back only new references without reusing IDs", function()
		local f = fixture()
		local root = f.instance("Root", "Folder", f.workspace)
		local socket = f.boot()
		f.authenticate(socket)
		local prior = f.request(socket, "inspect_instance", { path = "workspace.Root", includeReferences = true }).reference
		local child = f.instance("Child", "Folder", root)
		local failedReference
		socket.beforeSend = function(message)
			if message.type == "response" and message.ok and message.result.children then
				failedReference = message.result.children[1].reference
				assert(message.result.reference == prior and type(failedReference) == "string", "Send failure must occur after reusing prior and allocating new references")
				error("fixture response send failure")
			end
		end
		f.begin(socket, "inspect_instance", { path = "workspace.Root", depth = 1, includeReferences = true })
		f.scheduler.untilTrue(function() return failedReference ~= nil end)
		socket.beforeSend = nil
		assert(root.Destroying:Count() == 1 and child.Destroying:Count() == 0, "Send rollback must disconnect only request-new reference listeners")
		if socket.closed or not f.global.PotassiumMcp.acknowledged then
			f.scheduler.untilTrue(function() return #f.sockets == 2 and #f.sockets[2].sent > 0 end)
			socket = f.sockets[2]
			f.authenticate(socket)
		end
		assert(f.request(socket, "inspect_instance", { path = prior, includeReferences = true }).reference == prior, "Send rollback must preserve a reused reference")
		f.reject(socket, "inspect_instance", { path = failedReference })
		local acquired = f.request(socket, "inspect_instance", { path = "workspace.Root.Child", includeReferences = true }).reference
		assert(acquired ~= failedReference and tonumber(string.sub(acquired, -8), 16) > tonumber(string.sub(failedReference, -8), 16), "failed-send token IDs must remain retired and monotonically advance")
		assert(child.Destroying:Count() == 1, "failed-send rollback must leave capacity available for a fresh acquisition")
	end)
	check("spatial exclusions resolve stable references to the actual renamed subtree", function()
		local f = fixture()
		local function vector(x, y, z)
			return setmetatable({ X = x, Y = y, Z = z, Magnitude = math.sqrt(x * x + y * y + z * z) }, {
				__sub = function(a, b) return vector(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end,
			})
		end
		f.environment.Vector3 = { new = vector }
		f.environment.OverlapParams = { new = function() return {} end }
		f.environment.Enum = { RaycastFilterType = { Exclude = "Exclude" } }
		local excluded = f.instance("Excluded", "Folder", f.workspace)
		local hidden = f.instance("Hidden", "Folder", excluded)
		local retained = f.instance("Retained", "Folder", f.workspace)
		hidden.Position, retained.Position = vector(0, 0, 0), vector(1, 0, 0)
		function f.workspace:GetPartBoundsInRadius(center, radius, filter)
			local matches = {}
			for _, candidate in ipairs({ hidden, retained }) do
				local blocked = false
				for _, ancestor in ipairs(filter.FilterDescendantsInstances) do
					if candidate == ancestor or candidate:IsDescendantOf(ancestor) then blocked = true; break end
				end
				if not blocked and (candidate.Position - center).Magnitude <= radius then table.insert(matches, candidate) end
			end
			return matches
		end
		local socket = f.boot()
		f.authenticate(socket)
		local reference = f.request(socket, "inspect_instance", { path = "workspace.Excluded", includeReferences = true }).reference
		excluded.Name = "Renamed"
		local result = f.request(socket, "spatial_query", { mode = "radius", center = { x = 0, y = 0, z = 0 }, radius = 5, excludePaths = { reference } })
		assert(#result.results == 1 and result.results[1].name == "Retained" and result.results[1].distance == 1, "reference exclusion must remove the identified subtree rather than use a stale path or ignore the filter")
		f.request(socket, "instance_references_release", { references = { reference } })
		f.reject(socket, "spatial_query", { mode = "radius", center = { x = 0, y = 0, z = 0 }, radius = 5, excludePaths = { reference } })
	end)
	if options.jsonEncode then
		check("oversized opt-in discovery fails before committing inaccessible references", function()
			local f = fixture()
			local root = f.instance("Large", "Folder", f.workspace)
			for index = 1, 200 do f.instance(string.rep("q", 4000) .. tostring(index), "Folder", root) end
			local socket = f.boot()
			f.authenticate(socket)
			f.reject(socket, "inspect_instance", { path = "workspace.Large", depth = 1, childLimit = 200, includeReferences = true })
			assert(root.Destroying:Count() == 0, "oversized root summary must not leak an inaccessible reference")
			for _, child in ipairs(root.children) do
				assert(child.Destroying:Count() == 0, "oversized discovery must roll back every unreturned child reference")
			end
			assert(f.request(socket, "inspect_instance", { path = "workspace.Large", includeReferences = true }).reference ~= nil, "size rejection must leave capacity usable for bounded acquisition")
		end)
	end
	if not options.jsonEncode then
		table.insert(engineSkips, "Five byte-budget cases skipped: real JSON codecs were not supplied")
	end
	return report("core")
end

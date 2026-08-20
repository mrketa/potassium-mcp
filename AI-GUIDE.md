# Potassium MCP Bridge — complete AI agent guide

This guide describes the complete Potassium MCP Bridge surface for AI agents: connection discovery, client routing, bounded inspection, diagnostics, configured local and network reads, administrative recovery, synchronous and asynchronous Luau execution, transports, policy gates, and operational recovery.

Potassium MCP Bridge is an independent local bridge. It is not Potassium's built-in MCP endpoint. It connects an MCP host to one or more attached Potassium clients through an authenticated local broker.

## Agent operating sequence

At the beginning of a session:

1. Call `potassium_status`.
2. Call `potassium_capabilities`.
3. Call `potassium_list_clients`.
4. If more than one client is connected, select the intended lowercase 32-hex `clientId` and pass it to executor-backed tools.
5. Inspect the tool list exposed to this MCP session. Policy-gated tools that are not authorized are omitted entirely.
6. Use bounded inspection tools before raw execution when inspection answers the request.
7. For a requested mutation, use `potassium_execute_luau` or `potassium_execute_luau_async` only when those tools are exposed and the user has authorized the change.

A healthy static Doctor result does not prove a live MCP connection. Live readiness requires successful `potassium_status` and `potassium_capabilities` calls through the installed proxy.

## Architecture

```text
AI/MCP host
  -> authenticated stdio proxy, or authenticated loopback HTTP
  -> one per-user Potassium MCP broker
  -> authenticated Protocol 2 connection
  -> one or more attached Potassium clients
```

- Supported host adapters: OMP, Codex, Claude Code, Claude Desktop, VS Code, Cursor, Gemini, and manual/generic MCP hosts.
- Stdio is the default transport. Host launchers do not contain the broker token.
- The broker owns client connections, heartbeat, bounded reconnect, request routing, concurrency, and recovery state.
- Executor-backed requests are routed to an explicit `clientId` when more than one client is attached.
- Each executor permits up to four concurrent reads.
- A mutation waits for earlier reads, forms a FIFO barrier, and completes before later work begins. Mutations do not overlap reads.
- Tool responses contain JSON text and structured MCP content. Success is capped at the smaller of `maxMessageBytes` and `proxyMaxFrameBytes - 8192`; oversized results fail with instructions to narrow filters or limits.
- The bridge uses no AI-provider API key.

## Runtime defaults

Fresh installations use these defaults:

| Setting | Default |
| --- | --- |
| Executor endpoint | `127.0.0.1:32145` |
| Authenticated proxy endpoint | `127.0.0.1:32146` |
| Optional Streamable HTTP endpoint | `127.0.0.1:32147` |
| Executor request timeout | 30 seconds |
| MCP launcher timeout | 40 seconds |
| Proxy handshake timeout | 5 seconds |
| Proxy frame/result budget | 1 MiB |
| Pending requests per client | 64 |
| Concurrent reads per executor | 4 |
| Shutdown grace period | 5 seconds |

Configuration schemas restrict network binds to `127.0.0.1` or `::1`. Ports may be set to `0` where the schema permits automatic allocation.

## Host and scope matrix

| Host ID | Supported scope/configuration route |
| --- | --- |
| `omp` | Project scope; `.omp/mcp.json` |
| `codex` | User scope; Codex CLI/TOML registration |
| `claude-code` | Project `.mcp.json`; user or local scope through `claude mcp add` |
| `claude-desktop` | User scope; managed Claude Desktop configuration |
| `vscode` | User or project scope |
| `cursor` | User or project scope |
| `gemini` | User or project scope |
| `manual` | Installs the runtime and returns launcher snippets; does not modify a host |

Host adapters preserve unrelated settings, refuse to replace unmanaged existing Potassium entries, and require ownership proof for later repair or removal.

## Authentication and secrets

- Executor connections use loopback WebSocket, Protocol 2 identity/generation/nonces, and mutual transcript-bound HMAC-SHA256 authentication.
- Proxy connections use a loopback HMAC challenge bound to protocol, role, `hostId`, and both nonces. The authenticated `hostId` selects an immutable policy.
- HTTP requires a timing-safe exact Bearer token, a loopback peer, and a loopback Origin when an Origin is present.
- Runtime configuration requires exactly one inline token or `tokenFile`, containing 32–4096 characters.
- Normal installation uses a private token file protected for the current Windows user.
- The custom broker token, built-in fallback token, and AI-provider credentials are separate concerns. The bridge does not need an AI-provider credential.

## Access modes and policy gates

Every stdio host has an independent immutable policy with three capabilities:

- `read`: inspection, diagnostics, bounded configured reads, status, and client listing.
- `admin`: transport status, redacted execution history, and compare-and-swap recovery.
- `execute`: synchronous and asynchronous arbitrary Luau execution.

HTTP has its own independent `read`, `admin`, and `execute` policy. A grant to one stdio host does not grant another host or HTTP.

Default policy:

```json
{
  "read": true,
  "admin": false,
  "execute": false
}
```

Execution requires both:

1. the global `allowUnsafeExecute` gate; and
2. the selected transport's `execute` policy.

Administrative tools are also created only while the global unsafe gate is enabled and the selected transport has `admin` policy.

To grant OMP the complete read, admin, and execute surface:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp --allow-unsafe-execute --execute-host omp --admin-host omp
```

`--execute-host` and `--admin-host` are repeatable. Replace `omp` with the exact trusted host ID. Restart the affected MCP host after repair.

To grant the authenticated loopback HTTP transport admin and execution independently:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp --streamable-http --allow-unsafe-execute --http-admin --http-execute
```

To remove execution access:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp --no-unsafe-execute
```

`--deny-read-host <host-id>` and `--http-no-read` can remove read capability. A disabled capability means its tools are absent, not merely rejected after invocation.

## Common input and routing rules

Every registered tool accepts an optional:

- `clientId`: lowercase 32-character hexadecimal client identifier.

Use `clientId` for any tool whose work runs in a Potassium client. If exactly one client is connected, routing can be implicit. If several clients are connected, first call `potassium_list_clients` and route explicitly. Do not guess based on list position.

Common validation limits:

- Instance paths: 1–1024 characters.
- Property names: identifier form `[A-Za-z_][A-Za-z0-9_]*`, maximum 64 characters.
- Luau source: non-empty and at most 32,768 UTF-8 bytes.
- `clientId` and asynchronous `jobId`: lowercase 32-hex strings.
- Unknown input keys are rejected by strict schemas where specified.

## Complete tool reference

The server implements 42 MCP tools. Full read/admin/execute policy with the built-in fallback exposes all 42; full access without fallback exposes 39; default read policy exposes 31 without fallback or 34 with fallback. The current session exposes only the subset allowed by its policy and configuration.

### Connection and routing

#### `potassium_status`

Reports whether the custom Potassium bootstrap is connected, its endpoint and transport state, attached-client state, request activity, and recovery generation. No required input.

Use this first and after reconnects, timeouts, broker restarts, or recovery.

#### `potassium_list_clients`

Lists authenticated attached Potassium bootstrap clients and their identifiers. No required input.

Use the returned `clientId` whenever several clients are attached.

#### `potassium_capabilities`

Calls the selected executor's Protocol 2 `capabilities` method. Reports executor identity/version when available and the supported bridge methods. No required input beyond optional `clientId`.

Use this before assuming that a client build supports a particular operation.

### Optional Potassium built-in diagnostic fallback

These tools exist only when the separately authenticated built-in fallback is configured. The fallback is fixed to `http://127.0.0.1:8225/mcp`, uses a token distinct from the custom broker token, and never forwards native execution.

#### `potassium_builtin_status`

Reports built-in fallback availability. No required input.

#### `potassium_builtin_list_clients`

Lists clients visible through the built-in diagnostic fallback. No required input.

#### `potassium_builtin_read_console`

Reads bounded console diagnostics through the fallback.

Inputs:

- `pid`: required decimal process ID string, 1–11 digits, first digit nonzero.
- `afterCursor`: optional non-negative integer cursor.
- `limit`: optional integer 1–200.
- `waitMs`: optional integer 0–3000.

This is diagnostic console reading only. It is not an execution route.

### Full Luau execution

These tools are exposed only with the global unsafe gate and execute policy. Submitted Luau runs in the selected attached client with the capabilities provided by that executor. It can mutate client state and is intentionally marked destructive, non-idempotent, and open-world.

#### `potassium_execute_luau`

Executes trusted Luau synchronously.

Inputs:

- `code`: required non-empty Luau source, maximum 32,768 UTF-8 bytes.
- `clientId`: optional explicit target.

The call waits for the executor result up to the configured request timeout. Do not automatically retry after a timeout: the client may still have executed the code.

#### `potassium_execute_luau_async`

Submits trusted Luau to the executor's serialized asynchronous queue.

Inputs:

- `code`: required non-empty Luau source, maximum 32,768 UTF-8 bytes.
- `clientId`: optional explicit target.

A successful submission returns a `jobId`. If transport failure or timeout makes acceptance indeterminate, do not resubmit automatically. Query status only when a `jobId` was returned.

#### `potassium_async_job_status`

Reads state and timestamps for an accepted asynchronous job.

Inputs:

- `jobId`: required lowercase 32-hex ID.
- `clientId`: optional explicit target.

Jobs survive reconnects only within the same bootstrap generation.

#### `potassium_async_job_result`

Reads an asynchronous job result.

Inputs:

- `jobId`: required lowercase 32-hex ID.
- `clientId`: optional explicit target.

Pending jobs return `ready: false`. Terminal results are retained for a bounded period. Successful result envelopes larger than 64 KiB may be replaced by an artifact descriptor; read that descriptor with `potassium_artifact_read`.

#### `potassium_async_job_console`

Pages bounded, redacted console output captured during an asynchronous job's execution window.

Inputs:

- `jobId`: required lowercase 32-hex ID.
- `afterCursor`: optional non-negative integer cursor.
- `limit`: optional integer 1–200.
- `clientId`: optional explicit target.

Captured messages may contain unrelated engine output produced during the same window. This is not an arbitrary live console stream.

### Administrative transport control

These tools require the global unsafe gate and the selected transport's admin policy.

#### `potassium_admin_status`

Reports bridge activity and recovery state without code, result values, or secrets. No required input.

#### `potassium_admin_history`

Reads bounded redacted audit metadata for recent synchronous and asynchronous execution operations. Audit entries do not contain submitted code or returned values.

Input:

- `limit`: integer 1–100, default 20.

#### `potassium_admin_recover`

Performs a compare-and-swap reset of the executor transport.

Input:

- `expectedRecoveryGeneration`: required integer from 0 through JavaScript's maximum safe integer. Obtain the current generation from status immediately before recovery.

Recovery disconnects/reset transport state. It does not forcibly terminate arbitrary Luau already running in the client. A stale generation is rejected rather than resetting a newer transport state.

### Client and instance inspection

#### `potassium_client_state`

Reads place ID, job-ID presence, local player state, character state, and position. No required input beyond optional `clientId`.

#### `potassium_list_children`

Lists direct children of a Roblox instance resolved from a dotted path.

Inputs:

- `path`: required dotted instance path, maximum 1024 characters; example `workspace.AdminAbuse`.
- `limit`: integer 1–1000, default 200.

#### `potassium_inspect_instance`

Reads identity, attributes, selected safe properties, and optionally bounded descendants.

Inputs:

- `path`: required instance path.
- `depth`: integer 0–3, default 0.
- `childLimit`: integer 1–500, default 100.

#### `potassium_find_instances`

Traverses from a root and returns bounded matches.

Inputs:

- `root`: required instance path.
- `nameContains`: optional string, maximum 128 characters.
- `pathContains`: optional string, maximum 128 characters.
- `classNames`: optional array of at most 16 class names, each at most 64 characters.
- `limit`: integer 1–200, default 100.
- `maxVisited`: integer 1–20,000, default 5,000.

#### `potassium_read_properties`

Reads an allowlisted set of properties from one instance.

Inputs:

- `path`: required instance path.
- `properties`: required array of 1–32 valid property identifiers.

Unavailable, denied, or unserializable properties are reported by the executor rather than bypassing the allowlist.

#### `potassium_list_tags`

Performs exactly one of two CollectionService queries:

- list tags on one instance by supplying `path`; or
- list bounded instance summaries carrying one tag by supplying `tag`.

Inputs:

- `path`: optional instance path.
- `tag`: optional non-empty tag, maximum 128 characters.
- `limit`: integer 1–200, default 100.

Supply exactly one of `path` or `tag`.

#### `potassium_diagnostic_snapshot`

Returns a passive snapshot of place, workspace, local character, and physics state. No required input beyond optional `clientId`.

### Script and remote metadata

#### `potassium_script_fingerprint`

Fingerprints one `Script`, `LocalScript`, or `ModuleScript` without returning source, bytecode, constants, or upvalues.

Input:

- `path`: required script instance path.

#### `potassium_script_inventory`

Inventories bounded script metadata without returning script contents.

Inputs:

- `scope`: required enum: `descendants`, `loaded`, or `running`.
- `root`: optional instance path; used where the selected scope requires a traversal root.
- `limit`: integer 1–200, default 100.
- `maxVisited`: integer 1–20,000, default 5,000.

#### `potassium_remote_inventory`

Inventories `RemoteEvent` and `RemoteFunction` metadata without firing or invoking remotes.

Inputs:

- `root`: required traversal root.
- `limit`: integer 1–200, default 100.
- `maxVisited`: integer 1–20,000, default 5,000.

### Performance and spatial inspection

#### `potassium_performance_snapshot`

Returns bounded passive Roblox performance, memory, workspace, network, and class-count statistics.

Inputs:

- `maxVisited`: integer 1–20,000, default 5,000.
- `maxClassCounts`: integer 1–500, default 200.

#### `potassium_overlap_query`

Runs a bounded overlap query using a target `BasePart`.

Inputs:

- `path`: required path to the target part.
- `maxResults`: integer 1–200, default 100.
- `excludePaths`: array of at most 16 non-empty paths, default empty.

#### `potassium_spatial_query`

Runs one bounded Workspace spatial query.

Common inputs:

- `mode`: required enum `raycast`, `radius`, or `box`.
- `maxDistance`: finite number 0.1–10,000, default 1,000.
- `maxResults`: integer 1–200, default 100.
- `excludePaths`: optional array of at most 16 paths.

Mode-specific required inputs:

- `raycast`: `origin` and `direction` vectors.
- `radius`: `center` vector and `radius` from 0.1–5,000.
- `box`: `center` and `size` vectors.

Each vector is a strict object with finite numeric `x`, `y`, and `z` fields.

### Attributes, structure, UI, signals, and observation

#### `potassium_attribute_inventory`

Inventories bounded scalar-safe attributes on one instance or subtree.

Inputs:

- `path`: required root path.
- `recursive`: boolean, default `false`.
- `attributeNames`: array of at most 32 names, each 1–128 characters; default empty means no explicit name filter.
- `limit`: integer 1–500, default 100.
- `maxVisited`: integer 1–10,000, default 3,000.

#### `potassium_subtree_summary`

Summarizes a bounded subtree with deterministic class, tag, attribute, and structural digest data.

Inputs:

- `path`: required root path.
- `maxDepth`: integer 0–8, default 4.
- `maxVisited`: integer 1–20,000, default 5,000.
- `maxSummaryEntries`: integer 1–500, default 200.

#### `potassium_observe_logs`

Temporarily captures bounded redacted `LogService` output, then disconnects its listener before returning.

Inputs:

- `durationMs`: integer 100–5,000, default 1,000.
- `maxEvents`: integer 1–200, default 100.
- `minLevel`: enum `output`, `info`, `warning`, or `error`; default `output`.

#### `potassium_ui_inventory`

Inventories bounded `PlayerGui` and/or `CoreGui` metadata without interacting with UI.

Inputs:

- `roots`: enum `player_gui`, `core_gui`, or `both`; default `player_gui`.
- `includeText`: boolean, default `false`.
- `limit`: integer 1–500, default 100.
- `maxVisited`: integer 1–10,000, default 3,000.

#### `potassium_signal_inventory`

Reads bounded connection metadata for named `RBXScriptSignal` properties without invoking connections.

Inputs:

- `path`: required instance path.
- `signals`: required array of 1–16 valid signal identifiers.
- `limitPerSignal`: integer 1–200, default 100.

The attached executor must provide `getconnections`; otherwise the tool reports that capability as unavailable.

#### `potassium_observe_changes`

Temporarily observes bounded safe changes on one instance and disconnects all listeners before returning.

Inputs:

- `path`: required instance path.
- `durationMs`: integer 100–5,000, default 1,000.
- `maxEvents`: integer 1–200, default 100.
- `properties`: array of at most 16 valid property identifiers, default empty.
- `includeAttributes`: boolean, default `true`.
- `includeChildren`: boolean, default `true`.

### Configured files, HTTPS, traces, and public Roblox metadata

#### `potassium_artifact_read`

Reads bounded UTF-8 text from a configured artifact root. It cannot read arbitrary filesystem paths.

Inputs:

- `root`: required configured root name matching `[a-z][a-z0-9_]{0,63}`.
- `path`: required path relative to that root, maximum 4096 characters.
- `offsetBytes`: integer 0 through JavaScript's maximum safe integer, default 0.
- `maxBytes`: integer 1–262,144, default 65,536.

Configuration controls root directories, recursive access, and allowed file extensions. Path escape, unsupported extensions, and out-of-root access are rejected.

#### `potassium_http_get`

Performs a bounded HTTPS GET only to an explicitly configured hostname.

Inputs:

- `url`: required URL, maximum 4096 characters.
- `timeoutMs`: integer 1–10,000, default 5,000.
- `maxBytes`: integer 1–262,144, default 65,536.

Only bounded text, JSON, or XML is accepted. The host must be in `httpAllowedHosts`; local/private-address bypasses and arbitrary hosts are not allowed.

#### `potassium_trace_query`

Reads a bounded, redacted query from a configured trace file without arbitrary filesystem access.

Inputs:

- `path`: required bounded path.
- `eventType`: optional string, 1–128 characters.
- `since`: optional non-negative finite number or ISO datetime string, maximum 64 characters.
- `until`: optional non-negative finite number or ISO datetime string, maximum 64 characters.
- `maxRows`: integer 1–500, default 100.
- `maxBytes`: integer 1–262,144, default 65,536.

#### `potassium_trace_summary`

Uses the same schema as `potassium_trace_query`, but returns a bounded redacted summary rather than the matching row set.

#### `potassium_place_metadata`

Fetches bounded public Roblox metadata.

Inputs:

- `kind`: required enum `universe`, `place`, `thumbnail`, or `user`.
- `id`: required positive decimal ID string of 1–20 digits.
- `size`: optional enum `150x150`, `256x256`, or `512x512`; valid only for `thumbnail`.
- `timeoutMs`: integer 1–10,000, default 5,000.
- `maxBytes`: integer 1–262,144, default 65,536.

### Diff, batch reads, ancestry, and class summaries

#### `potassium_snapshot_diff`

Takes two bounded safe snapshots around a short observation window and returns a deterministic limited diff without mutation.

Inputs:

- `path`: required instance path.
- `properties`: array of at most 16 property identifiers, default `["Name"]`.
- `includeAttributes`: boolean, default `true`.
- `includeTags`: boolean, default `true`.
- `maxDepth`: integer 0–3, default 1.
- `maxVisited`: integer 1–500, default 100.
- `durationMs`: integer 50–2,000, default 250.
- `maxChanges`: integer 1–500, default 100.

#### `potassium_multi_read_properties`

Reads allowlisted properties from several instance paths in one bounded request.

Inputs:

- `requests`: required array of 1–20 objects. Each object contains a required `path` and 1–32 valid `properties`.
- `maxTotalValues`: integer 1–200, default 200.

The sum of all requested property counts must not exceed `maxTotalValues`.

#### `potassium_instance_ancestry`

Reads one or two bounded ancestry chains and can support relationship comparison.

Inputs:

- `path`: required instance path.
- `otherPath`: optional second instance path.
- `maxDepth`: integer 1–32, default 16.

#### `potassium_class_summary`

Summarizes Roblox classes under a bounded traversal root.

Inputs:

- `path`: required root path.
- `maxDepth`: integer 0–8, default 4.
- `maxVisited`: integer 1–20,000, default 5,000.
- `maxClasses`: integer 1–200, default 100.

## Recommended workflows

### Discover a place or feature

1. `potassium_status`
2. `potassium_capabilities`
3. `potassium_client_state`
4. `potassium_list_children` on a known root
5. `potassium_find_instances` with narrow filters
6. `potassium_inspect_instance` on relevant matches
7. `potassium_read_properties`, `potassium_list_tags`, or `potassium_attribute_inventory` for focused detail

### Investigate behavior without mutation

1. Identify the exact target with `potassium_find_instances`.
2. Read structure with `potassium_subtree_summary` or `potassium_class_summary`.
3. Inspect scripts/remotes with `potassium_script_inventory`, `potassium_script_fingerprint`, and `potassium_remote_inventory`.
4. Observe bounded activity with `potassium_observe_logs`, `potassium_observe_changes`, or `potassium_snapshot_diff`.
5. Use `potassium_performance_snapshot`, `potassium_spatial_query`, or `potassium_overlap_query` when the issue is physical or performance-related.

### Execute a synchronous administrative change

1. Confirm `potassium_execute_luau` is exposed.
2. Call `potassium_status` and select `clientId` if needed.
3. Make the code self-contained and bounded.
4. Call `potassium_execute_luau` once.
5. Verify the observable result with the appropriate inspection tool.
6. If the call times out, do not blindly retry. Check status and verify state first.

### Execute long-running work asynchronously

1. Submit once with `potassium_execute_luau_async`.
2. Save the returned `jobId` and selected `clientId`.
3. Poll `potassium_async_job_status` at a reasonable interval.
4. Read `potassium_async_job_console` with `afterCursor` when progress output matters.
5. Read `potassium_async_job_result` after terminal status.
6. If the result contains an artifact descriptor, page it with `potassium_artifact_read`.
7. Never automatically resubmit an indeterminate submission.

### Recover a stuck transport

1. Call `potassium_status` or `potassium_admin_status`.
2. Wait for a timed-out request that may still return late.
3. If recovery remains stuck and admin tools are available, read the current recovery generation.
4. Call `potassium_admin_recover` with that exact generation.
5. Reattach Potassium if necessary.
6. Call `potassium_status` and `potassium_capabilities` again.
7. Retry only after confirming the earlier operation did not already take effect.

## Error and retry semantics

- `Potassium is not connected`: start or reattach Potassium, then call `potassium_status`.
- Timeout: the operation may still complete. Wait for a late response, inspect status, and verify state before retrying.
- `recovering from a timed-out request`: wait; recover only when state remains stuck.
- Request capacity reached: wait for active work to complete, then retry once.
- Maximum message/result size: narrow the root, filters, depth, `limit`, `maxVisited`, `maxResults`, or `maxClasses`.
- Async submission acceptance indeterminate: do not automatically retry; query only when a `jobId` exists.
- Multiple attached clients: pass explicit `clientId`.
- Unknown or unavailable executor method: call `potassium_capabilities` and choose a supported operation.

## HTTP transports

Stateless Streamable HTTP:

- default endpoint: `http://127.0.0.1:32147/mcp`;
- loopback only;
- Bearer authentication required;
- POST only;
- each authenticated POST receives a fresh MCP server;
- GET and DELETE return MCP-shaped `405` responses.

Optional stateful HTTP:

- endpoint: `/mcp/session`;
- supports authenticated POST, GET, and DELETE sessions;
- uses `mcp-session-id`;
- maximum 32 sessions;
- idle sessions expire after 15 minutes.

Do not expose these endpoints through LAN binding, tunneling, reverse proxies, or port forwarding. HTTP policy remains separate from every stdio host policy.

## Installation and operational commands

Static installation check:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 doctor --json
```

Live MCP initialization and capability verification:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 verify --json
```

Broker state and recovery:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 broker status --json
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 broker restart --json
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 broker stop --json
```

Repair one host while preserving unrelated configuration:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp
```

Rotate a possibly exposed custom broker token:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 rotate-token
```

Token rotation is ownership-gated, restarts the broker, and requires Potassium to reattach. Repair is not token rotation.

Remove every owned host entry and remove the shared runtime when no owned entries remain:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 uninstall --all
```

## Configuration-dependent capabilities

The following tools can exist in the server but require explicit configuration to return useful data:

- `potassium_artifact_read`: named `artifactRoots`, allowed extensions, and recursion policy.
- `potassium_http_get`: `httpAllowedHosts` allowlist.
- `potassium_place_metadata`: the fixed public Roblox hostname must also be present in `httpAllowedHosts`.
- `potassium_trace_query` and `potassium_trace_summary`: an allowed configured trace path.
- `potassium_builtin_*`: built-in fallback enablement and its separate private token file.
- `potassium_admin_*`: global unsafe gate plus transport admin policy.
- `potassium_execute_luau*` and `potassium_async_job_*`: global unsafe gate plus transport execute policy.
- HTTP endpoints: streamable and/or stateful HTTP enablement plus separate HTTP policy.

## Boundaries agents must understand

- Bounded inspection does not expose script source, bytecode, constants, or upvalues.
- Remote inventory does not fire or invoke remotes.
- UI inventory does not click or type.
- Signal inventory does not invoke connections.
- Observation tools disconnect their temporary listeners before returning.
- Artifact access is constrained to configured roots and extensions.
- HTTP GET is constrained to configured HTTPS hosts and bounded response types/sizes.
- The optional built-in fallback is diagnostics-only.
- Raw Luau execution is the intentional full-power path. It is available only under explicit execution policy and can change the selected connected client.
- Authentication identifies a local component; it does not make arbitrary submitted code safe.
- Never expose broker tokens, fallback tokens, private paths, or unrelated host configuration in chat output.

## Minimal prompt for another AI agent

```text
Use the installed Potassium MCP Bridge. Start with potassium_status, potassium_capabilities, and potassium_list_clients. If several clients are attached, select and consistently pass the intended clientId. Use the complete exposed tool surface, including inspection, configured artifacts/HTTPS, admin recovery, and synchronous or asynchronous Luau execution when those tools are available and the requested operation requires them. Treat missing tools as policy-disabled. Never automatically retry timed-out or indeterminate mutations; verify state first. Report the tools used, target clientId when applicable, results, and any remaining connection or policy limitation.
```

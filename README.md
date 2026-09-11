# Potassium MCP Bridge

`@mrketa/potassium-mcp` is a local, loopback-only MCP bridge for bounded Potassium inspection and trusted admin/Luau execution. Genuinely fresh Windows Setup installations grant the generic `agent` full read/admin/execute access, including synchronous `potassium_execute_luau` and asynchronous `potassium_execute_luau_async`. The advanced npm CLI's defaults remain unchanged; read tools observe game state and watches/references manage bounded bookkeeping.

> **Full access means arbitrary execution.** Luau can change the connected client and act with the permissions and capabilities of its executor. Connect only trusted agents: untrusted content or prompt injection may induce unwanted actions. Execution is not sandboxed. Windows Setup adds no extra warning, consent, or permission prompt; read [Security](SECURITY.md) before connecting an agent.

## Relationship to Potassium's built-in MCP

Potassium now ships its own MCP endpoint. This independent project does not replace, wrap, or rebrand that native server. Use Potassium's built-in MCP when its direct integration is sufficient. Use this bridge when several MCP hosts must share one executor connection or when you need per-host policy, explicit multi-client routing, authenticated stdio proxies, optional Streamable HTTP sessions, bounded artifacts, audit history, or FIFO mutation barriers.

The optional built-in fallback is narrower than Potassium's native surface: fixed-local-endpoint status, client listing, and bounded console reads only, never script execution. Its historical check used Potassium `2.4.3` (`version-ce0bcd0fbd484804`); this does not qualify every later build.

## Support and candidate status

The [support matrix](potassium-mcp/README.md#support-freeze-and-release-status) separates supported qualification targets from historical observations. First Stable targets Windows 11 x64, Node 22/24, the pinned MCP SDK, and the explicitly recorded Potassium/native feature scope. Full source suites, installed npm/Windows checks, parser isolation, retained data, rollback and the unshortened staging soak are separate gates. The final release's `QUALIFICATION.json` and externally pinned `RELEASE-SET.json` identify the exact qualified bytes; older source reports do not qualify a newer archive.

MCP SDK is pinned to `1.30.0`, with newest negotiable legacy revision `2025-11-25` and missing HTTP version-header fallback `2025-03-26`. No `2026-07-28` handshake-free support is claimed. Executor Protocol 2 and capability versions are unrelated to MCP dates.

This source targets **1.0.0**. Windows Setup is intentionally **unsigned**: checksums bind file consistency, not an Authenticode publisher identity, and Windows may show SmartScreen warnings. A GitHub draft is preparation, not a published release. The explicit release workflow verifies an already complete hash-bound draft without rebuilding or signing; actual publication requires separate version confirmation and the protected owner-approved `stable-publish` environment. Never silently promote a prerelease or substitute a same-version rebuild.

## Agent documentation

Start with [Agent quick start](docs/AGENT-INSTALL.md#agent-quick-start), which routes to the canonical [Agent workflow](docs/API.md#agent-workflow). Existing docs are the single maintained workflow source; tool schemas and structured errors remain authoritative. No skill is installed by default or required for Stable. A future thin router that only links these docs is conditional on demonstrated need, not a second workflow manual. This guidance changes neither host policy nor the separately scoped qualification evidence above.

## Windows setup

1. Start Potassium once to create `%LOCALAPPDATA%\Potassium\workspace`.
2. Use `Setup.exe` from a matching verified release/candidate, directly or from its Windows Setup ZIP; verify the supplied checksums. Select the existing workspace with **Change folder** if needed, then click **Install**.
3. Use **Copy configuration**, the command, or the configuration-file path to connect your MCP host. Manually merge the generated `mcpServers.potassium` entry into any host that supports MCP stdio; preserve its other servers and settings.
4. Restart/reload that host. **Check** distinguishes **MCP connected** from **Executor attached**: the former can succeed before Roblox is running. Start Roblox and attach Potassium after the host/broker is running.

There is no Desktop/CLI selector, extra Setup warning/consent/permission prompt, Safeproxy component, or automatic new-host registration. Only a genuinely fresh installation grants `agent` full read/admin/execute and enables the global execution gate. Updates, repairs, and reinstalls with retained configuration preserve explicit existing permissions, including restrictions. A missing `agent` policy in existing configuration may receive a read-only entry, never the fresh full-access grant or elevation of admin, execute, or the global gate. Setup does not bypass harness/application approval. Authentication, token protections, loopback restrictions, truthful annotations, and resource limits remain active; optional HTTP/fallback transports, external hosts, and trace/artifact roots are not automatically enabled or widened.

The durable launcher is `%LOCALAPPDATA%\Programs\Potassium MCP\PotassiumMcp.Launcher.exe`, with no arguments. Its generated `connection.json` contains an absolute command and `args: []`, not a token. Versioned bundled Node `22.23.2`, MCP, and dependencies remain under that application root; global Node/npm and a shared .NET installation are not required. Private config, token, and artifacts remain separate under `%LOCALAPPDATA%\Potassium\MCP`.

Use Setup for **Check**, **Repair**, and removal; repair and retained uninstall/reinstall preserve private state. Existing custom wrappers or incompatible ownership fail closed. The Windows archive is `potassium-mcp-v1.0.0-windows-setup.zip`; unlike historical filtered source ZIPs, it contains the actual installer. This release does not automatically adopt every public beta's legacy schema-1/custom-autoexec installation: preserve that installer and its private data, and use a separately verified migration rather than deleting state or forcing ownership. See [Getting Started](docs/GETTING-STARTED.md#windows-local-installer) and [Deployment](docs/DEPLOYMENT.md#windows-local-installer).

## Advanced alternative: CLI setup and adapters

The existing npm/CLI route remains available independently of Setup, with unchanged defaults: the example grants ordinary read-only access, not Windows Setup's fresh full-access policy. Start Potassium once so its workspace exists, then install a verified candidate tarball:

```powershell
npm install --global <verified-candidate.tgz>
potassium-mcp setup --workspace "$env:LOCALAPPDATA\Potassium\workspace" --read-host omp-project-a --dry-run --json
potassium-mcp setup --workspace "$env:LOCALAPPDATA\Potassium\workspace" --read-host omp-project-a --json
potassium-mcp config print --host-id omp-project-a --json
```

npm owns package acquisition/update/removal. Hostless `setup` owns private state and canonical bootstrap deployment outside npm/cache directories; it never defaults to OMP. `--read-host omp-project-a` explicitly defines that ordinary read-only policy ID without registering a host. Read-only `config print` emits the standard token-free absolute Node/public-bin entry without writes or grants; unknown IDs must first be configured. Its server command is:

```text
potassium-mcp serve --config <absolute-config-path> --host-id <unique-id>
```

After confirming a matching approved published artifact, `config print --host-id <unique-id> --npm --json` emits an exact-version npm entry. Do not use a moving npm tag. See [configuration precedence](docs/CONFIGURATION.md) for explicit config/env/root resolution; ordinary `serve` does not install, deploy, or adopt credentials.

Optional adapters register only the requested application:

```powershell
potassium-mcp host add --host omp --host-id omp-project-a --scope project --dry-run --json
potassium-mcp host add --host omp --host-id omp-project-a --scope project
```

Adapters: `omp`, `codex`, `claude-code`, `claude-desktop`, `vscode`, `cursor`, `gemini`, `manual`. Choose distinct policy IDs per project/launcher; adapter and ID are separate. `host add/remove` do not install packages, redeploy scripts, or grant policy. Use only scopes supported by that adapter and preserve unrelated host content.

## Runtime

The public `serve` command starts a stdio proxy. Proxies mutually authenticate to one per-user loopback broker. The broker owns Potassium Protocol 2 connections and schedules four concurrent reads/controls per executor client. Ordinary mutations wait behind earlier ordinary reads and form FIFO barriers; bounded watch/job/reference control requests can pass a busy mutation. Multiple MCP applications and explicitly selected clients coexist without racing for the executor WebSocket port.

After installation or repair, restart or reload each changed MCP host, then attach Potassium. The bootstrap uses authenticated heartbeats and reconnects within its bounded lifetime. Verify `potassium_status`, `potassium_capabilities`, and `potassium_list_clients`; when more than one executor is connected, pass the intended `clientId` to executor-backed tools.

## Summary-first remote workflow

Remote metadata inventory is read-policy tooling. Ordinary requests require inventory3; inventory4 adds retained-row query filters without rescanning. Summary, rows, detail, diff and release preserve explicit partial/non-atomic coverage and stable snapshot identity. The separate execute-gated `potassium_remote_call` queues one selected FireServer/InvokeServer with typed arguments and an async job ID; no blind bulk-discovery invocation/replay occurs. Queued cancellation prevents dispatch; after dispatch, eventual return values/errors remain visible. FireServer completion is local dispatch, not server acknowledgement.

Large successful tool results become short `potassium/result` descriptors. `potassium_result_read` retrieves one or up to eight pointers with auto typed values by default; use explicit view:text for legacy byte paging. Its shared2048-byte default/4096-byte maximum budget and scope/expiry checks remain. Capabilities defaults to a concise summary, and structured-content-aware clients can explicitly negotiate concise text presentation without losing canonical data. Retained inventory queries reuse stored rows rather than rescanning. `potassium_game_context` shares bounded persistent scene data, window images and schematic maps across agents, including offline reads after Roblox closes; see [API](docs/API.md#shared-game-and-map-context).

Parkour reconstruction uses read-policy tools: `potassium_map_context` manages immutable maps/images, `potassium_map_geometry` reads3D support/chunks, `potassium_map_navigation` reads movement/hazard models or computes routes, and `potassium_map_mechanics` applies explicit user-reported floor/ceiling transitions offline. Maps retain source evidence; unknown switch timing stays null and no route is executed. Partial geometry, collision/profile assumptions and temporal uncertainty remain explicit. See [parkour reconstruction](docs/API.md#parkour-map-reconstruction).

Explicit execute-gated remote capture observes selected outbound namecalls and optional inbound events. Metadata is the default; version2 permits bounded redacted value examples only on explicit opt-in, and never captures returns or manufactures calls. Native game interception remains unverified and `nativeSemanticsVerified` stays false. Raw slot ownership checks do not detect in-place closure mutation; a foreign hook can block safe cleanup/restart. This is not a universal hook-safety guarantee.

`potassium_observe_action` starts/polls/stops a bounded before/after state observation with optional selected remote capture. It performs no automatic UI/game action and labels correlation temporal, not causal. `potassium_diagnostic_snapshot` adds character, UI, and nearby views with explicit coverage and stable references. `potassium_session_stats` reports bounded metadata-only calls, logical result bytes, timing, errors, detail reads, and repeated scan selections; it retains no raw arguments/results or credentials.

Read-policy `potassium_code_index`/`potassium_code_query` analyze explicitly supplied Luau without an executor: functions/calls/dependencies, conservative argument origins, and redacted excerpts. Production uses a small GUI-independent native C worker with Tree-sitter `0.25.0`/Luau grammar `1.2.0`; a validated native-tree adapter and bounded semantic JavaScript analysis run in the trusted parent. Source is never executed or reconstructed from server code. Inline intake needs no roots; file intake uses separate trusted `sourceRoots`, fresh-config `sources` at `workspace/potassium-mcp-sources`, without widening retained configs or artifacts. Build `node tools/native-parser.mjs build` (pinned Zig `0.14.1` provisioning at build time), then `node tools/parser-host.mjs build`, before packaging/Windows build. The fixed Windows x64 backend uses ordinary no-capability AppContainer and atomic Job limits, no private desktop/station or existing UI ACL edits. It is not LPAC or an absolute filesystem whitelist; unsupported/missing backends fail explicitly, never unconfined fallback. [API](docs/API.md#offline-luau-source-index), [configuration](docs/CONFIGURATION.md#offline-source-roots-and-parser-runtime), and [qualification](docs/TESTING.md#workflow-expansion-source-qualification) separate architecture from OS proof.

Ordinary clients retain the full allowed catalog. Retained sessions can opt into vendor lazy discovery and activate named typed tools through `potassium_tool_catalog`; presentation does not grant permission. Standard tools/list nextCursor pages still apply on discovery/refresh. On the same 100-row no-executor SDK fixture, the current catalog grew from 51 tools/81026 JSON bytes to 56/88676 despite shortening description bytes from 6321 to 4832. Three detail calls/3206 bytes became one multi-read/2384 bytes; lazy initialization was 3 tools/6525 bytes. The new tarball, independently installed with `--omit=dev`, reproduced these measurements and lazy activation on Node `24.15.0` and `22.23.2`. These are JSON bytes/calls, not model tokens or universal savings. [Measurement scope](docs/TESTING.md#workflow-expansion-source-qualification) separates installed-package proof from native game and Windows GUI qualification.

The running bootstrap must advertise remoteInventory v2, remoteCapture v1, actionObservation v1, remoteActions v1/asyncJobs v2, and diagnosticSnapshot v2/reference v1 for the respective features; default diagnostic overview keeps older compatibility. Use [manual deployment/restart](docs/DEPLOYMENT.md#remote-workflow-bootstrap-cutover). No live bootstrap deployment, native call, or user configuration change is implied by the source expansion.

## Optional Streamable HTTP MCP

The shared broker can expose optional loopback-only authenticated HTTP. Enable it through setup/repair:

```powershell
potassium-mcp repair --streamable-http --streamable-http-port 32147
```

`http://127.0.0.1:32147/mcp` is stateless POST-only; GET/DELETE return `405`. `--stateful-http` enables `/mcp/session` with POST/GET/DELETE, `mcp-session-id`, at most 32 sessions, and lazy 15-minute idle expiry. HTTP requires private Bearer authentication; POST also requires `Accept: application/json, text/event-stream`. Complete the legacy initialize/initialized lifecycle and send negotiated version/session headers as described in [API](docs/API.md#optional-streamable-http-transport). No SSE replay/resumability/progress is promised.

Stateless cross-request `notifications/cancelled` cannot address a previous request's server. Local client cancellation does not prove nonexecution or that work stopped. Stateful/stdio cancellation also cannot forcibly terminate arbitrary Luau. Loopback/authentication do not sandbox unsafe execution.

## Operate

For a Windows-managed installation, use Setup's maintenance actions as described above; the following commands are the advanced core CLI lifecycle.

```powershell
potassium-mcp doctor --json
potassium-mcp repair --dry-run --json
potassium-mcp repair --json
potassium-mcp rotate-token
potassium-mcp host remove --host vscode --host-id vscode-project-a --scope project
potassium-mcp uninstall --all --dry-run --json
potassium-mcp uninstall --all --json
```

Repair preserves private configuration, credentials, ports, timeouts, roots/allowlists, HTTP settings, grants, and artifacts unless explicitly changed. Unknown/modified state conflicts rather than resetting. `host remove` removes one proven-owned registration. `uninstall --all` removes owned registrations/deployment while retaining config, token, artifacts, and verified reinstall evidence; npm packages are removed separately. Token rotation requires reconnect/reattach.

The former `install`/`--package-source` path is removed. See [migration conflicts](potassium-mcp/README.md#existing-installation-conflicts) before changing existing installs. The actual custom OMP wrapper/internal-proxy consumer and junction remain user-managed conflicts until a deliberate proven migration; do not overwrite the wrapper, delete its target, or discard ownership evidence to bypass checks.

See [`potassium-mcp/README.md`](potassium-mcp/README.md) for the support/adapter matrix, paths, lifecycle limits, K1–K4 deferrals, and release gates.

## Trusted admin execution

Fresh Windows Setup enables admin and both raw Luau execution entrypoints for generic `agent`; existing configurations retain their access. Under unchanged advanced npm CLI defaults, raw synchronous/asynchronous Luau and admin tools remain absent without explicit grants. Read/admin/execute policy axes are independent: admin diagnostics do not require global unsafe execution, but execution does. To explicitly change an advanced CLI-managed host's grants:

```powershell
potassium-mcp repair --allow-unsafe-execute --execute-host omp-project-a --admin-host omp-project-a
```

The global unsafe gate and the calling host's execute grant are both required (HTTP has its own `--http-execute` policy). Fresh Windows Setup supplies these host execution gates for `agent`; it does not remove runtime checks. Submitted code can mutate the client, invoke remotes, access executor APIs, or load local scripts; loopback transport and authentication do not sandbox it. Async jobs expose bounded terminal return values plus a separately paged, redacted `print`/`warn` console cursor through `potassium_async_job_console`; they do not stream arbitrary editor output. Successful async envelopes larger than 64 KiB become artifact descriptors readable through `potassium_artifact_read`.

Shared-token host policies constrain trusted launchers, not malicious token holders claiming other known IDs. Async submission loss after send is indeterminate: never automatically resubmit. Queued cancellation prevents execution; running cancellation is cooperative and keeps the raw lock until code exits. Job/artifact retention is lazy where documented; terminal watches have a one-second lifecycle sweep. None of these imply forced code termination or exact real-time cleanup in a stalled engine.

An optional built-in fallback can be enabled with `--builtin-fallback-token-file <private-path>`. It is fixed to `http://127.0.0.1:8225/mcp`, requires a token distinct from the custom broker token, and exposes only bounded status, client listing, and console diagnostics—never raw execution.

## Security and license

The bridge remains authenticated and loopback-only, with bounded transport resources; full-access execution itself is not an observation-only mode or a sandbox. Keep credentials private, do not add untrusted artifact roots or HTTP hosts, and treat every shared-token holder and execution caller as trusted. See [Security](SECURITY.md). Released under [Apache-2.0](LICENSE).

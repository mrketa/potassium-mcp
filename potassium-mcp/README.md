# Advanced Potassium MCP — package reference

Technical reference for **Advanced Potassium MCP**, an independent, extended MCP integration for Potassium. For the short overview, Windows download and first-time setup, start with the [main README](https://github.com/mrketa/potassium-mcp#readme). The npm package remains `@mrketa/potassium-mcp` and the command remains `potassium-mcp`.

For agent use, start with [Agent documentation](#agent-documentation); installation and ordinary tool use are separate workflows.

## Relationship to Potassium's built-in MCP

Potassium includes its own built-in MCP. Advanced Potassium MCP is an independent project for deeper inspection, reusable snapshots/maps/recordings, supplied-Luau analysis and multi-assistant workflows. It is not the official native server, a wrapper around it, or a rename of it. The sections below describe this project's features and limits, not an audited feature-by-feature comparison with Potassium's built-in MCP.

With `--builtin-fallback-token-file`, the broker can use Potassium's fixed local endpoint for bounded status, client listing, and console diagnostics only; native script execution is never forwarded. The historical fallback check used Potassium `2.4.3` (`version-ce0bcd0fbd484804`). That is not a blanket compatibility claim for later builds.

## Support freeze and release status

Stable **1.0.0 is published**. Use the [release page](https://github.com/mrketa/potassium-mcp/releases/tag/v1.0.0) for Setup, the Windows ZIP and their checksums. Original qualification manifests are preserved in the [separate technical archive](https://github.com/mrketa/potassium-mcp/tree/5677385f169c24c87f8879e72bb8f5beee86f0d6/release-evidence/v1.0.0). Windows Setup is unsigned; no verified Authenticode publisher identity is claimed. The detailed notes below include historical qualification snapshots: source edits, archived prereleases and independently rebuilt binaries are not automatically the released bytes.

Schema-3 runtime compatibility is declared by package metadata `potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 }`. An archived same-version package without this marker is not a compatible explicit runtime migration target. The marker is necessary compatibility metadata, not proof of artifact integrity, qualification, or permission to publish.

| Surface | First-Stable qualification target | Evidence boundary |
|---|---|---|
| Windows | Windows 11 x64 | Windows 10 is a declared but unqualified target; Windows CI is not Windows 10 desktop evidence. |
| Node.js | Node 22 and 24; package declares `>=22` | Historical exact runs used `22.23.2` and `24.15.0`, with source suites and independently installed artifact smoke. New source/candidate bytes require new qualification; `>=22` is not a future-version guarantee. |
| Potassium | 2.4.7, with matching package/deployed/running assets | Historical detached/loopback and lifecycle-2 restart evidence is separate from lifecycle-4 bounded map read acceptance. New `lifecycle-5` / `mapRecording.version:1` is source implementation, not new native readiness acceptance or deployment. No universal engine/server/remote semantics claim. |
| Primary transport | Public `serve`, newline JSON-RPC stdio through the broker | Historical public-bin, pinned-npx, stock SDK and installed-launcher proof is artifact-bound. Existing user-managed OMP wrapper proof is separate, not certification of every host. |
| Optional HTTP | Authenticated stateless `/mcp` and retained `/mcp/session` | Historical stock-SDK checks/soak have per-transport protocol-header evidence. No SSE replay/resumability or cross-request stateless cancellation guarantee. |
| MCP revision | SDK exactly `1.30.0`, through `2025-11-25` | Also negotiates `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`; constants are not a completed host matrix. Omitted HTTP version defaults to `2025-03-26`. No `2026-07-28` or legacy HTTP+SSE endpoint. |
| MCP applications | Stock SDK and existing user-managed OMP wrapper evidence | Other adapters remain implementation/fixture-tested unless an exact independent host run is recorded. An installed Codex version or documentation availability is not host qualification. |
| Portable host core | Outside this first-Stable qualification | Linux host core and its lifecycle cases remain unqualified. No Linux/macOS executor integration, other Node lines or universal adapter support is claimed. |

The legacy MCP contract uses `initialize`, `notifications/initialized`, and negotiated HTTP version/session headers. Executor Protocol `2` and feature versions returned by `potassium_capabilities` are separate from MCP revisions. A modern-only client needs legacy compatibility; requesting a newer revision does not add its capabilities.

Stable requires all mandatory package, migration/rollback, platform/host/protocol, lifecycle, and approved engine gates; no open critical/high findings or reproduced data loss, secret leak, privilege expansion, unsafe retry, or resource leak. Lower-severity exceptions need documented impact and explicit acceptance. A green local suite alone does not authorize a version bump or publication.

The npm package and Windows Setup EXE/ZIP are the user distributions; GitHub's automatic source archives are not installed runtimes. Release tooling qualifies an exact set before protected publication. The published 1.0.0 download list was subsequently simplified by explicit request; its original metadata is in the linked archive, and its binaries are unchanged. The old full-set workflow fails closed if replayed against that reduced list and must not be used to restore removed attachments automatically. See [Deployment](../docs/DEPLOYMENT.md) for the general release and installation contracts.

The historical ownership candidate's actual npm/Windows packages, clean installation, upgrade/repair/removal/reinstall, native parser and clipboard transfers have scoped local evidence. For that source/artifact set, Node 22 and 24 each passed 564 of 567 source tests with zero failures and three explicit platform skips; modeled bootstrap70/70, managed Setup28/28 and corrected release tooling33/33 passed. Its `0c153057…` tarball completed the corrected thirty-minute stock-SDK staging soak. These remain archival results, not the current source freeze or qualification of the recorder/selective-read delta.

Native detached tests observed hierarchy changes, Destroying/Connected cleanup, local typed arguments and JSON envelopes at up to50000 direct children; owned loopback WebSockets observed graceful/abrupt close and reconnect, plus canned crypto checks. These do not prove the active bootstrap's reference/watch/socket failure integration or real Roblox server serialization. A current-place metadata capture restored its hook but observed no selected calls; actual remote arguments/returns/errors remain unqualified. Workspace.SignalBehavior was not readable, so other signal modes are not claimed. [Testing](../docs/TESTING.md#qualification-ledger-and-release-acceptance) records exact evidence and limits. No Stable version or publication is authorized by these partial native checks.

## Summary-first workflow and discovery

`potassium_remote_inventory` supports summary, selected rows/fields, compatible diffs, live detail and release. Ordinary requests require inventory3; inventory4 adds `query` on retained rows/summary so repeated searches reuse the same snapshot without rescanning. Original coverage, IDs, capture filters and lifetime remain intact; query-bound cursors reject changed selectors. Detail reads bounded remote attributes/ValueBase metadata, never rebinding a stale row through its path or treating values as call arguments.

The primary discovery requirement is to show existing client-visible remotes quickly: name, class and full path, with search/filtering, bounded pages and explicit coverage. It requires no decompilation, capture hook or remote invocation. Inventory does not infer a handler's arguments, return values or side effects. Qualify inventory separately from the optional active call/capture APIs; missing server-execution evidence is not a missing inventory feature.

Explicit capture v2 adds grouped argument profiles: direction, method, `argc`, up to8 type labels, cumulative count and first/last observation. `directions` defaults to outbound namecalls; optional inbound listens only to RemoteEvent/UnreliableRemoteEvent `OnClientEvent`, never replaces `OnClientInvoke`. `includeValueExamples` defaults false. If enabled, `view:"profiles"` can show bounded redacted scalar/raw-table examples with explicit nil slots; summary/events remain value-free. Native userdata stays type-only, malformed UTF-8/overlong/deep/cyclic values are omitted or truncated, and no untrusted metamethods or engine serializers run in the outbound observer.

At most200 observations per capture attempt sampling, with at most3 examples per shape and fixed8-argument/32-node/depth2/8-entry/128-byte-string/1024-byte-example limits inside the existing shared64KiB capture buffer. Drops and partial coverage are explicit. This is best-effort observed data, not inferred server signatures or automatic replay instructions; unknown secrets are not guaranteed recognizable. Capture still requires execute permission plus the global gate.

Capture's native API availability and local/disposable method/yield/readonly probes do not prove actual game interception: `nativeSemanticsVerified` remains false. Cleanup checks raw slot ownership, not executor in-place closure mutation. Foreign slot replacement can leave an inert wrapper, report cleanup limits, and block restart rather than overwrite another hook. Read the [capture limitations](../docs/API.md#native-and-ownership-limitations) before use.

Large successes use `{ kind: "potassium/result", resultId, toolName, bytes, sha256, expiresAt, summary }`; ordinary metadata remains within8KiB or the smaller transport budget. `potassium_result_read` now defaults to auto typed selections for single and multiple pointers; explicitly request view:text for legacy paging. The shared data budget remains2048/default and4096/max bytes, with1–8 unique pointers. Explicit `potassium/structured-results` version1 clients receive concise text plus full validated structuredContent, avoiding JSON duplication; text-oriented clients remain lossless. Canonical retention is independent of presentation.

`potassium_capabilities` defaults to summary, with explicit full and named-section views. Status now separates authenticated disconnects from handshakeFailures and exposes current openSockets/pendingHandshakes.

`potassium_game_context` captures a shared immutable snapshot: bounded Workspace boxes, player/place information, PlayerGui metadata, ReplicatedStorage remote identities, an optional Roblox-window screenshot and schematic map. Agents reuse contextId with offline list/read/image views even after Roblox or the creator closes. Records are config-owned and bounded (8 records,2MiB each/16MiB total); release is explicit and old records can be evicted. Windows image capture is unambiguous/window-only, with no desktop fallback, camera/player movement or remote invocation. Standard MCP ImageContent stays within existing transport bounds. See [shared game context](../docs/API.md#shared-game-and-map-context).

`potassium_map_context` reconstructs shared immutable parkour maps from verified saved captures; `potassium_map_geometry` reads3D stand-surface candidates and spatial chunks, while `potassium_map_navigation` reads walk/jump/drop/ride/wait links or computes a route without executing it. `potassium_map_motion` separately reads motion tracks, compact track summaries and evidence-qualified hazards. Offline maps survive source eviction and have explicit parent-linked updates. Attached mapObservation1 adds bounded identity-bound timed sampling and downward collision probes, without gameplay mutations. Assumed profiles, proxy shapes, incomplete coverage and uncertain hazard causality remain explicit. Layered map images use the existing offline image helper. See [parkour reconstruction](../docs/API.md#parkour-map-reconstruction).

`potassium_map_mechanics` applies explicit user-reported floor/ceiling transitions to an immutable map without recapture. New surfaces/clearance/navigation follow their support orientation; legacy floor-only maps stay readable. Mode-switch links remain candidate with unknown duration, and routes through them report null timing rather than invent a gravity law, teleport, or measured transfer. Names such as ReversePad do not automatically create mechanics.

New source adds offline geometry/navigation/motion queries with exact IDs/bounds/mode/link/part selectors, query-bound cursors and explicit compact track summaries through `potassium_map_motion`. Full samples and original schema1/2 records remain readable; navigation no longer accepts track/hazard/summary calls. New graph rows group only exact-equivalent ordinary links, preserving every discrete timing opportunity and existing mode/activation/null-time constraints; no measured performance improvement is implied by implementation alone.

`potassium_map_recording` adds source-side continuous native start/poll(summary only)/mark/stop/save/release, not model-scheduled short windows. `potassium_map_recording_read` separately exposes live poll(frames/events) and offline read(summary/frames/events); these are not lifecycle-tool aliases. Start selects1–4 exact map-bound targets; READY requires a first real frame and an owned running sampler at the native receipt time. A marker is timed at MCP request receipt, not a physical keypress. Recording has a fixed1–60second deadline, explicit misses/partial reasons and120second terminal retention; polling does not sample or renew either deadline. This new lifecycle-5/mapRecording1 source has no new native acceptance or deployment claim.

Terminal-only save publishes an immutable schema3 map with full frame/event evidence and a once-only durable receipt. Exact accepted retries work offline after native expiry/disconnect/restart and parent release; a released saved map returns its old identity with released:true rather than being recreated. Archive reads need no client. Motion tracks use an explicitly labeled at-most101-sample projection with source-count/clock/gap/decimation provenance; full raw recordings remain available. See [API](../docs/API.md#continuous-map-recording) for limits, clocks, selection and receipt conflict rules.

The combined motion-model quota is128 tracks; known exhaustion rejects recording start before sampling rather than overwriting archives. Same-generation continuous windows are ordered by actual native sample time, not save receipt time; mixed legacy/native clocks remain explicitly uncertain, and preferring continuous evidence is not a recency claim. Failed or target-lost recordings retain their valid raw samples but do not justify extrapolation. Recapturing the same exact object can update geometry under a new snapshot binding without rewriting its historical recording or rebinding by path. Exact same-process imports coalesce within eight in-flight imports/configuration; an owner's accepted commit survives joined cancellation, while cross-process contention can return BUSY and retain safe durable retry.

Normal/stateless HTTP clients keep the full policy-allowed catalog. Retained clients can opt into `capabilities.experimental["potassium/tool-discovery"] = { version: 1, listChanged: true }`, then search/activate named tools. Standard tools/list pagination follows actual frame size; do not assume a fixed tool count or one page. SDK1.30.0 listTools/auto-refresh cache only the latest fetched page, so follow nextCursor and fetch the target page before a typed call. No universal host-refresh support is assumed.

The identical 100-row no-executor/no-LLM stock-SDK source measurement changed full catalog bytes from 81026 (51 tools) to 88676 (56), while authored description bytes fell from 6321 to 4832 with no advisory-description matches. Three selected-detail calls/3206 JSON bytes became one multi-read/2384; lazy initialization exposed 3 tools/6525 bytes and activation passed. The full catalog grew. These are JSON bytes/calls, not exact tokens, universal or total-full-fetch savings, or installed-artifact qualification. [Testing](../docs/TESTING.md#workflow-expansion-source-qualification) separates this delta from older measurements.

`potassium_observe_action` provides execute-gated start/poll/stop before/after observations with optional selected capture, bounded coverage/diffs, and `correlation: "temporal"`—not automatic actions or proven causality. `potassium_diagnostic_snapshot` adds character/UI/nearby views with explicit coverage and stable references. `potassium_session_stats` reports only bounded call/byte/timing/error/repeated-selection metadata (retained-session or explicitly broker-shared stateless HTTP scope); it neither retains nor exports raw arguments, values, credentials, or source.

`potassium_code_index`/`potassium_code_query` require read permission and no executor. Index up to 32 inline or explicitly selected source-root modules (256 KiB/file, 4 MiB total), then page calls/functions/dependencies/origins/redacted source and release. Four memory-only indexes share 8 MiB source/8 MiB metadata ceilings and ten-minute retention. Real Tree-sitter Luau AST analysis is conservative about dynamic requires, branch/loop merges, captured values, and return-derived origins; an InvokeServer spelling does not prove remote identity or server behavior. Strings/comments/numeric AST literals and the configured token are redacted from snippets/display, with raw source hashes separate.

For an explicitly supplied index, `code_query` view `remote_callsites` finds bounded candidate source locations by exact receiver name or explicit slash-based logical path. Combined selectors are AND filters. Returned source hashes/spans, match kind and uncertainty remain `static-candidates-only`/`receiverIdentity:unverified`; name collisions and dynamic/captured values prevent automatic live-identity claims. No decompilation, source fetching or automatic reindexing is performed.

Separate trusted `sourceRoots` allow `.lua`/`.luau` only; fresh setup initializes `sources` at `workspace/potassium-mcp-sources`, while retained configurations and artifact-reader source blocking stay unchanged. Production uses a GUI-independent native C Tree-sitter `0.25.0`/Luau grammar `1.2.0` worker in `assets/native-parser/win32-x64`, plus the self-contained ParserHost controller. The native child parses source; the controller handles bounded framing; a validated native-tree adapter and bounded semantic JavaScript analysis run in the trusted parent. `web-tree-sitter@0.25.10`/WASM are development-test-only, not a production runtime dependency or fallback.

Build from the repository root in order: `node tools/native-parser.mjs build`, `node tools/parser-host.mjs build`, then npm packaging/Windows stage/build. Native build provisions hash-pinned Zig `0.14.1` only at build time and seals parser/runtime/compiler notices; target runtime downloads nothing. Production has one fixed ordinary no-capability AppContainer/atomic single-process Job backend, without CHILD_PROCESS_POLICY, private desktop/station, existing UI ACL edits, or experimental debug paths. It is not LPAC or an absolute filesystem whitelist: AppContainer-public Windows resources remain accessible. Other platforms/missing backends fail explicitly, never unconfined fallback/source execution. [API](../docs/API.md#offline-luau-source-index) documents contracts; the local OS cases above are distinct from AST proof and later artifact qualification.

Typed remote queued cancellation sends nothing. Once dispatch starts, cancellation cannot stop a native InvokeServer or release the lock early; eventual returned values/errors remain visible with cancellationRequested. FireServer success means local dispatch with `serverAcknowledged: false`, not server-side success. Actual native server/capture semantics remain unqualified (`nativeSemanticsVerified: false`). Old clients report incompatibility for missing feature versions; [manual cutover](../docs/DEPLOYMENT.md#remote-workflow-bootstrap-cutover) is separate from source work. No live deployment, automatic host registration, extra Setup prompt, or retained-rights change was performed.

## Agent documentation

Start with the [agent quick start](https://github.com/mrketa/potassium-mcp/blob/HEAD/docs/AGENT-INSTALL.md#agent-quick-start). Ordinary use follows the [canonical API agent workflow](https://github.com/mrketa/potassium-mcp/blob/HEAD/docs/API.md#agent-workflow); installation and requested host changes use [agent-assisted setup](https://github.com/mrketa/potassium-mcp/blob/HEAD/docs/AGENT-INSTALL.md#agent-assisted-setup).

These are the maintained repository docs, not an automatically loaded skill or a required installation step. The current connection's typed schemas and structured errors remain authoritative; reading docs does not register MCP, change permissions or establish host qualification.

The npm package does not ship the repository `docs/` directory. Use the online links above or `docs/AGENT-INSTALL.md` and `docs/API.md` in a source checkout; this README's other `../docs/` links are source-checkout links, not installed npm paths. Choose the source revision matching the artifact when available: the default-branch docs may describe unreleased contracts and do not prove an older installed package has those features.


## Setup, then standard launch

The separate Windows `Setup.exe` enables full read/admin/execute access for its generic `agent` identity on a genuinely fresh installation, including synchronous and asynchronous `execute_luau`. There is no Advanced setup or extra permission prompt. Only connect trusted agents: arbitrary Luau can change the connected client and use executor APIs, and untrusted content or prompt injection can induce unwanted actions. Authentication and loopback binding are not a sandbox. Existing configured permissions survive update, repair and retained reinstall; the installer does not automatically grant other hosts or HTTP execution.

Windows Setup passes `--initial-full-access-host agent`. This initialization-only option is applied only when creating new private configuration after recovery; it does not elevate existing configuration. The npm CLI instructions below retain their explicit-grant defaults.

Start Potassium once so `%LOCALAPPDATA%\Potassium\workspace` exists. Keep private configuration, credentials, and artifacts outside npm package/cache directories. npm owns package acquisition, upgrade, downgrade, and removal; setup does not install or copy another runtime.

For the unreleased candidate, install the verified tarball through npm, then run the public bin:

```powershell
npm install --global <verified-candidate.tgz>
potassium-mcp setup --workspace "$env:LOCALAPPDATA\Potassium\workspace" --read-host omp-project-a --dry-run --json
potassium-mcp setup --workspace "$env:LOCALAPPDATA\Potassium\workspace" --read-host omp-project-a --json
potassium-mcp config print --host-id omp-project-a --json
```

`setup` is hostless: it creates or safely reuses private state and deploys the bootstrap/autoexec assets, without choosing OMP or editing applications. `--read-host omp-project-a` explicitly configures that read-only policy ID without registering an application. `config print` is read-only; it prints a standard token-free JSON entry and neither registers a host nor grants policy. Unknown IDs are rejected until configured. Paste the entry into the intended MCP host, or use optional `host add` below.

The recommended server command is:

```text
potassium-mcp serve --config <absolute-config-path> --host-id <unique-id>
```

Use `config print` to obtain the exact absolute Node executable, public package bin, configuration path, and ID for a local npm installation. It never recommends an internal `src/proxy.js` path. After an approved npm publication, `config print --host-id <unique-id> --npm --json` emits the exact-version npm launch variant. Do not use a moving npm tag or assume the current registry artifact contains the candidate CLI.

Give distinct projects/launchers distinct IDs, such as `omp-project-a` and `omp-project-b`. IDs match `^[a-z][a-z0-9_-]{0,63}$`: 1–64 characters, beginning with a lowercase letter. The adapter name (`omp`) and policy identity (`omp-project-a`) are different fields; configure intended policy explicitly. `serve` does not perform setup, deployment, registration, or credential adoption; stdout is MCP protocol only and diagnostics go to stderr.

Configuration precedence is explicit `--config`, then `config.json` beneath explicit `--install-root`, then absolute `POTASSIUM_MCP_CONFIG`, then `config.json` beneath absolute `POTASSIUM_MCP_INSTALL_ROOT`, then the default root. Explicit installation selection therefore cannot be redirected by an ambient config environment variable. The Windows default is `%LOCALAPPDATA%\Potassium\MCP`; the portable fallback is `~/.local/share/Potassium/MCP`, not executor support there. Explicit relative CLI paths resolve from invocation CWD; environment paths must be absolute.

Fresh setup requires an explicit `--workspace` or absolute `POTASSIUM_WORKSPACE`; later operations may use the previously verified workspace. The example passes the conventional Potassium workspace explicitly rather than discovering/adopting it silently.

`doctor [--config <path>|--install-root <path>] [--host-id <configured-id>] [--json]` is static by default. Opt in to host-CLI/broker probes with `--probe`; a static report is not proof that a real host launched or a live client accepted the candidate.

### Trusted admin execution

Unrestricted Luau execution is disabled by default in ordinary npm CLI setup; the fresh Windows installer enables it as described above. On an existing private installation, explicitly enable the global gate and grant only the intended trusted host:

```powershell
potassium-mcp repair --allow-unsafe-execute --execute-host omp-project-a --admin-host omp-project-a
```

Only execution requires the global unsafe gate. Configure ordinary read-only IDs with repeatable `--read-host <id>` and deny reads with `--deny-read-host <id>`. Grant raw tools with `--execute-host <id>` or `--http-execute`; independently grant admin diagnostics with `--admin-host <id>` or `--http-admin`. Read, admin, and execute are separate axes. Execution can mutate the live client, invoke remotes, access executor APIs, or load local scripts. Revoke execution globally with `--no-unsafe-execute`; this does not revoke independent admin permission.

These policies constrain trusted configured launchers, not malicious holders of the shared token. A token holder can claim another known `hostId`; authenticated transcript binding prevents tampering, not impersonation by a token holder. Keep every token reader and unsafe executor trusted. Loopback, authentication, and policy do not sandbox submitted code or provide adversarial per-host isolation.

`potassium_execute_luau_async` accepts a trusted source string and returns an opaque lowercase 32-hex `jobId` with `state: "queued"` after executor acceptance. It runs one raw job at a time in FIFO order, with at most 8 queued-or-running jobs. Poll `potassium_async_job_status` for `queued`, `running`, or terminal state and `potassium_async_job_result` until it returns `ready: true`; poll `potassium_async_job_console` with `afterCursor` for separately bounded and redacted job-local `print`/`warn` entries. Results are bounded to 262,144 bytes, retain at most 32 terminal jobs, and expire after 300 seconds. Accepted jobs survive a socket reconnect within the same bootstrap generation but are lost if the bootstrap is replaced. A submit timeout or transport failure after a send attempt makes acceptance indeterminate: do not retry automatically, because the executor may have accepted and later run the code.

Terminal retention is lazy: access or subsequent job activity prunes expired records; 300 seconds is the retrieval window, not a hard wall-clock promise that an idle process has reclaimed every byte. Count/byte bounds still apply. The project job tools are not the standard MCP Tasks extension.

`potassium_async_job_list` lists at most 40 metadata-only records (`limit`, default 40), ordered by submission time then job ID. Cancellation immediately prevents queued execution; running raw code reports cancellationRequested and remains running until actual exit/checkpoint, retaining the lock. Raw jobs ending cancelled have ready results without success data. Typed remote jobs already dispatched instead preserve eventual succeeded/failed data/errors despite cancellationRequested. Cancellation is idempotent for retained jobs and never changes an already terminal job.

If acceptance succeeds but host audit/result formatting fails afterward, the tool preserves a successful `{ jobId, accepted: true, warning, nextAction }` envelope (and only a valid known `state`). `warning` is `AUDIT_FAILED` or `RESULT_FORMAT_FAILED`. Poll that returned job ID; the warning must never cause resubmission.

For synchronous execution that completed before audit persistence fails, preserve `{ executionCompleted: true, warning: "AUDIT_FAILED", result }`, or a bounded completed/next-action fallback. Completion warnings are not failed execution and must not trigger another execution.

New async scripts can receive their job context as the first argument:

```lua
local potassiumJob = ...
potassiumJob.trackConnection(workspace.AttributeChanged:Connect(function(name)
    print("Attribute changed:", name)
end))
while not potassiumJob.isCancellationRequested() do
    task.wait(0.1)
    potassiumJob.checkpoint()
end
```

`trackConnection` accepts up to 128 distinct `RBXScriptConnection` objects. Registered connections are disconnected on cancellation requests and every terminal outcome; late registrations are immediately disconnected, and an over-capacity registration disconnects the rejected connection before raising an error. Unregistered connections, spawned tasks, and arbitrary non-yielding Luau cannot be forcibly stopped. The context does not sandbox the script.

Admin history retains at most 100 metadata-only records in a bounded durable NDJSON history under the workspace. The history is rewritten as a capped file rather than maintained as an append-only log. It records execution mode (`sync` or accepted `async`), execution hashes, byte counts, timing, outcome/error class, optional async executor job ID, client/runtime metadata, and an anonymous proxy-session ID—never submitted source, returned values, or secrets. An async entry records accepted submission, not later executor completion; completion is known only when `potassium_async_job_result` observes it. `potassium_admin_status` reports active-operation metadata and the current `recoveryGeneration`; `potassium_admin_history` accepts `limit` from 1 through 100 (default 20); and `potassium_admin_recover` requires the expected recovery generation.

### Persistent watches

The read-policy tools `potassium_watch_start`, `potassium_watch_poll`, and `potassium_watch_stop` observe the same allowlisted properties, attributes, and child changes as `potassium_observe_changes`, without blocking a request for the observation lifetime.

- Start with `path`, optional `properties` (up to 16), `includeAttributes`/`includeChildren` (default true), `maxEvents` (1–200, default 100), and `ttlSeconds` (10–300, default 60). It returns an opaque lowercase 32-hex `watchId`, instance summary, active state, cursor, and chosen limits. There are at most 16 active watches per bootstrap generation.
- Poll with `watchId`, optional `afterCursor` (default 0), and `limit` (1–200, default 100). The result contains `events`, `nextCursor`, `dropped`, `hasMore`, and `state`. Reuse `nextCursor` to consume subsequent pages; polling does not consume retained events. `dropped` counts evicted events after the requested cursor. A future cursor is rejected.
- Each ring holds at most 65,536 encoded event bytes; each event is bounded to 8,192 bytes and 128 serialized items. Overflow evicts oldest events. Successful active polling renews the idle TTL; stopped, expired, and destroyed watches do not renew.
- Stop disconnects immediately and is idempotent while retained. Final buffered events remain pollable for up to 60 seconds, with at most 16 terminal watches retained. Target destruction, idle expiry, partial subscription failure, and bootstrap teardown clean listeners. Watches survive socket reconnects only within the same bootstrap generation.
- The one-second lifecycle sweep checks active expiry and physically prunes terminal watches, alongside relevant registry operations. This is scheduler-driven cleanup, not a real-time guarantee during a stalled engine.

Start/stop advertise non-read-only MCP annotations because they allocate or release observers, not because they modify game state. Update the installed package and deployed bootstrap together, then restart the MCP host and Potassium/Roblox; never reload the bootstrap through its own active MCP connection.

### Mixed batch reads and stable references

`potassium_batch_read` combines allowlisted properties, scalar-safe attributes, and direct-child summaries for 1–20 targets in one request. For example:

```json
{
  "requests": [{
    "path": "workspace",
    "properties": ["Name", "ClassName"],
    "attributes": { "limit": 4 },
    "children": { "limit": 5 }
  }],
  "maxTotalValues": 20,
  "includeReferences": true
}
```

Each target requires at least one facet. Property lists contain 1–32 names; attributes accept optional `names` (up to 32, empty means all scalar-safe names) and `limit` 1–32 (default 32); children accept `limit` 1–100 (default 100). One dynamic `maxTotalValues` quota (1–200, default 200) counts attempted properties and returned attributes/children. The ordered `results` array keeps one row per target: missing targets produce `TARGET_UNAVAILABLE`, exhausted later rows `BUDGET_EXHAUSTED`, and byte/work-limited rows `RESULT_LIMIT`. Denied properties and failed facet getters remain local errors. Partial data is marked `truncated`. Results have a 65,536-byte raw JSON ceiling, smaller when necessary to fit the server's MCP envelope; reads are not atomic snapshots. The property-only `potassium_multi_read_properties` remains available.

Set `includeReferences: true` on `find_instances`, `list_children`, `inspect_instance`, or `batch_read` to receive a `reference` URI in each returned instance summary, including roots. Pass that exact `instance://` plus 32-lowercase-hex string in any existing Roblox target path/root/otherPath/excludePaths field. These handles distinguish duplicate names and survive rename, reparenting, temporary detachment, and socket reconnect within the same bootstrap generation. They do not bypass property/class restrictions or apply to host filesystem paths.

The registry is bounded to 1,024 entries and has no silent eviction or idle TTL. Destroyed entries drop their Instance/listener but retain a small tombstone until released; they still count toward capacity. Use `potassium_instance_references_release` with `references` (1–128 URIs) to reclaim entries. It returns ordered `{ reference, released }` records; repeated release returns false. References are shared across trusted sessions using that client, so release invalidates them for those sessions too. Existing watches are independent. Capacity/response-size failures do not partially allocate inaccessible references. Old-generation and malformed references fail explicitly; normal discovery does not allocate handles.

Batch and reference tools require read permission, not unsafe execution. Reference-capable discovery and release advertise non-read-only annotations only because they manage bounded bookkeeping. Probe capabilities for `batchRead.version: 1` and `instanceReferences.version: 1` after deploying and restarting the bootstrap.

### Errors and selected-client compatibility

Versioned feature calls check capabilities for the selected client and fence the subsequent request to that generation; discovery alone does not prove running-bootstrap support. Unknown/unconfigured host IDs reject; omitted axes in an explicit partial policy are false.

Tool errors return `isError: true` without `structuredContent`. The typed envelope `{ error: { code, message, submissionIndeterminate?, nextAction? }, jobId?, state?, ready? }` is carried identically in `_meta` and JSON text; success schemas remain strict. Codes distinguish input/policy, unavailable targets, missing/ambiguous/incompatible/changed clients, capacity/draining, queued versus sent timeout, cancellation/recovery, indeterminate submission, and output/other failures. `TARGET_UNAVAILABLE` may recommend bounded discovery; it is not a policy denial and needs no permission change. There is no blanket retryable flag: follow the reported action and never automatically replay indeterminate work. Accepted async warnings remain successful structured results.

Critical output schemas describe status, ordered batch rows, reference-release records, job IDs/states/readiness, and list/console pagination. They do not claim exhaustive typing of arbitrary engine values. Capability resource diagnostics distinguish current retained state from generation-history peaks/rejections; expired terminal jobs can remain physically retained until later job activity and are reported rather than pruned by a capability read.

### Optional registration adapters

| Adapter | Default scope | Configuration mechanism |
|---|---:|---|
| `omp` | project | `.omp/mcp.json` → `mcpServers` |
| `codex` | user | managed block in `%USERPROFILE%\.codex\config.toml` |
| `claude-code` | user | official `claude mcp add` command |
| `claude-code` | project | `.mcp.json` → `mcpServers` |
| `claude-code` | local | official Claude CLI with persisted canonical project CWD |
| `claude-desktop` | user | `%APPDATA%\Claude\claude_desktop_config.json` |
| `vscode` | user | `%APPDATA%\Code\User\mcp.json` → `servers` |
| `vscode` | project | `.vscode/mcp.json` → `servers` |
| `cursor` | user | `%USERPROFILE%\.cursor\mcp.json` → `mcpServers` |
| `cursor` | project | `.cursor/mcp.json` → `mcpServers` |
| `gemini` | user | `%USERPROFILE%\.gemini\settings.json` → `mcpServers` |
| `gemini` | project | `.gemini/settings.json` → `mcpServers` |
| `manual` | user | generic registration output; use read-only `config print` when only an entry is needed |

These are implemented adapters, not a list of fully qualified application versions. See the support matrix above. Use `--scope user`, `--scope project`, or `--scope local` only where the adapter supports it. `--mcp-config <path>` overrides the file path for one file-backed host.

Claude Code deliberately refuses mixed user/local/project registration ownership when `claude mcp get` precedence can hide the exact entry that must be inspected. Returned scope is checked where available; missing/ambiguous human-readable scope is not ownership proof. The adapter does not guess scope-specific storage to bypass this conflict. Multiple local projects can use distinct configured host IDs and persisted canonical CWDs. This is a safety limitation, not a claim of real-Claude qualification.

OMP's managed outer request timeout is `max(40_000, requestTimeoutMs + 10_000)` milliseconds, so an explicitly preserved executor deadline has a 10-second host margin. This timeout is not a cancellation or forced-stop guarantee.

```powershell
# Register only this project; bootstrap and npm package are unchanged
potassium-mcp host add --host omp --host-id omp-project-a --scope project --dry-run --json
potassium-mcp host add --host omp --host-id omp-project-a --scope project

# Separate VS Code project and policy identity
potassium-mcp repair --read-host vscode-project-a
potassium-mcp host add --host vscode --host-id vscode-project-a --scope project

# Remove only the proven-owned registration
potassium-mcp host remove --host vscode --host-id vscode-project-a --scope project
```

Host add/remove operate on registration and ownership only; they do not install npm packages, redeploy scripts, or create policy grants. Configure policy separately with `setup` or `repair`. Registration changes preserve unrelated file content and refuse foreign, modified, or ambiguous entries rather than overwriting them.

Setup/repair lock shared state, check managed-path ownership, protect token permissions, and transactionally deploy canonical assets. `--dry-run` reports planned changes without locks, tokens, staging, ACL changes, package installation, or process restart. An ownership conflict is not permission to bypass those checks; see migration below.

## Runtime architecture

Every MCP host starts a small stdio proxy. All proxies authenticate to one per-user broker on `127.0.0.1:32146`. The broker owns `127.0.0.1:32145` and one or more authenticated Potassium clients. Per client it dispatches up to four concurrent reads/controls plus one mutation. Ordinary mutations wait behind prior ordinary reads and act as FIFO barriers before later ordinary work. Watch/job lifecycle tools and reference release use a bounded control lane that can pass a busy mutation; at most four controls may be pending, with up to four reserved admission slots beyond the ordinary request limit. Mixed batch reads remain ordinary reads. Timeout recovery still blocks all executor requests until outstanding replies settle or the existing recovery path resets the transport.

Broker CLI identity checks resolve actual filesystem paths, allowing a developer checkout and its installed junction to match without accepting substring lookalikes, wrapper/eval commands, or a different config. Static doctor also recognizes the same broker file through a junction; this is not a process or connectivity check. Retained installations may still reference a removed external package after uninstall. Restart rechecks ownership before signaling and can adopt a freshly verified broker already started by a reconnecting proxy. This does not weaken installer ownership rules: package repair can still reject linked managed paths or locally customized launchers.

```text
OMP ───────────┐
Codex ─────────┤
Claude ────────┤ stdio proxies ── mutual HMAC ── singleton broker ── Protocol 2 ── Potassium
VS Code/Cursor ┤
Gemini/manual ─┘
```

This prevents multiple open MCP applications from racing for the Potassium WebSocket port or replacing one another's executor session. All transports remain loopback-only; host configuration contains no token.

### Optional Streamable HTTP MCP

The broker can listen on a separately authenticated loopback Streamable HTTP endpoint, disabled by default. Enable stateless `/mcp` with `--streamable-http`; enable bounded stateful `/mcp/session` with `--stateful-http`. `--streamable-http-port <1..65535>` optionally replaces port `32147`. Repair preserves the existing choice unless `--no-streamable-http` or `--no-stateful-http` explicitly revokes it.

```powershell
potassium-mcp repair --streamable-http --streamable-http-port 32147
```

The stateless path is always `/mcp`, so the default endpoint is `http://127.0.0.1:32147/mcp`. Each authenticated `POST` gets a fresh MCP server; authenticated `GET` and `DELETE` return MCP-shaped `405` responses. When enabled, `/mcp/session` supports POST/GET/DELETE using `mcp-session-id`, at most 32 sessions, and a 15-minute idle timeout. Both routes require the existing private token:

```powershell
$credential = (Get-Content 'replace-me-token-file' -Raw).Trim()
curl.exe --fail-with-body -X POST http://127.0.0.1:32147/mcp `
  -H "Authorization: Bearer $credential" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"local-client","version":"1"}}}'
```

That command shows initialization only. A legacy client must accept the returned revision, send `notifications/initialized`, and put `MCP-Protocol-Version: <negotiated-revision>` on subsequent HTTP requests. POST must accept both `application/json` and `text/event-stream`; do not assume a JSON response body. For `/mcp/session`, retain the initialization response's `mcp-session-id` and send it on later POST/GET/DELETE calls. GET needs `Accept: text/event-stream`. Stateless `/mcp` has no retained session; GET/DELETE return `405`. The stateful 15-minute idle timeout is enforced lazily on later registry operations, not by a background deadline or continuing SSE traffic. There is no configured event-store replay.

Stateless HTTP creates a server per request; cross-request `notifications/cancelled` cannot address the previous request's server. A local client abort does not prove stopped work or nonexecution. stdio/stateful cancellation needs its own qualification and never promises forced termination of arbitrary Luau.

An HTTP-capable client configuration typically has this shape (use its documented equivalent if its configuration format differs):

```json
{
  "mcpServers": {
    "potassium-http": {
      "url": "http://127.0.0.1:32147/mcp",
      "headers": {
        "Authorization": "replace-me-authorization-header"
      }
    }
  }
}
```

For an HTTP-capable MCP client, configure the same URL plus `Authorization: Bearer <token-from-private-token-file>`. Do not add that header or token to generated host configuration: all installer-managed hosts remain exact token-free stdio launchers. Loopback and Bearer checks protect the transport, not the trusted-admin execution surface. HTTP execution still requires its own grant, even when the fresh Windows installer has enabled `allowUnsafeExecute` for its local agent.
Each stdio launcher supplies its policy ID to the broker. Configure policy with repeatable `--deny-read-host`, `--admin-host`, and `--execute-host`; configure HTTP independently with `--http-no-read`, `--http-admin`, and `--http-execute`. Raw grants require `--allow-unsafe-execute`; admin does not. Verify policy with `doctor --json` and `tools/list` from each intended transport. Shared-token trust limits also apply to HTTP.

Use `potassium_list_clients` to enumerate attached executors. Executor-backed tools accept optional `clientId`; it may be omitted only when selection is unambiguous. Heartbeats detect dead connections and the bootstrap reconnects without retrying a possibly indeterminate mutation. Successful async result envelopes larger than 64 KiB are stored as bounded artifacts and returned as descriptors for `potassium_artifact_read`; artifacts inherit the configured root, size, extension, traversal, and redaction controls.

## Start and verify

After installation:

1. Fully restart or reload each changed MCP host.
2. Ensure at least one installed host or the broker is running before attaching Potassium.
3. Start Roblox and attach/inject Potassium.
4. Call `potassium_status`, then `potassium_capabilities`.

Expected status includes `connected: true`, executor protocol `2`, and `recovering: false`. `potassium_list_clients` should show the intended client; select its `clientId` explicitly when several are present. Compare counters before and after one bounded read rather than assuming a fresh zero baseline. Check selected-client capability versions and package/deployed/running asset compatibility; discovery of a tool alone does not prove that the selected bootstrap implements it.

The bootstrap sends heartbeats and reconnects after transient broker loss within its bounded lifetime. Reattach Potassium after bootstrap replacement, token rotation, or a connection window that fully expires.

## Operate and migrate

```powershell
# Inspect owned configuration, deployment, and registrations
potassium-mcp doctor --json

# Repair setup/deployment while preserving user settings and policies
potassium-mcp repair --dry-run --json
potassium-mcp repair --json

# Inspect/restart the exactly identified broker; restart is not Luau cancellation
potassium-mcp broker status --json
potassium-mcp broker restart --install-root <path> --json

# Rotate only the custom broker token; reconnect hosts and reattach Potassium
potassium-mcp rotate-token

# Enable diagnostic fallback using a distinct private token file
potassium-mcp repair --builtin-fallback-token-file <private-path>

# Remove owned host entries/deployment, retaining private recovery state
potassium-mcp uninstall --all --dry-run --json
potassium-mcp uninstall --all --json

# Remove the npm package separately, only when no launchers need it
npm uninstall --global @mrketa/potassium-mcp
```

`broker status` is read-only. `broker restart` checks exact process/config/executable identity and waits for active requests to drain by default; it cannot terminate arbitrary Luau already running in the client. Lifecycle remains CLI-only. Use `--workspace` and `--install-root` consistently for nondefault state. Host removal is `host remove`, not partial `uninstall`.

Windows ACL-preservation failures identify the original affected path and concrete native error, including transaction-journal failures. Management JSON carries structured `acl` details under the originating `MCP_ACL_PRESERVE_FAILED` error, even when a surrounding recovery failure adds context. Setup shows **Run as administrator** guidance only for positively identified read/write permission or privilege failures, not for arbitrary PowerShell/process errors. This does not elevate automatically, change ACL policy, or require administrator rights for MCP clients. See [Windows ACL preservation failures](../docs/DEPLOYMENT.md#windows-acl-preservation-failures) for recovery and diagnostic-sharing boundaries.

Detached status publications are serialized and use bounded retries of the same staged bytes for Windows sharing denials; no executor operation is replayed. If the final publication failed, shutdown makes one fresh bounded final-state publication before writing its stopped receipt. Persistent failure rejects shutdown rather than reporting successful persistence. Final-state and receipt publication recheck generation ownership before every rename attempt; an observed replacement is preserved. Disk status can remain stale after an earlier activity-write failure, so authenticated live drain—not the file alone—governs lifecycle decisions.

The bootstrap explicitly closes a peer-closed native WebSocket after retiring its Lua listeners and before scheduling a replacement. Potassium's native transport may otherwise reconnect independently, leaving unauthenticated orphan connections. A close callback alone is not proof that the native transport stopped. Already-orphaned sockets from an affected session can require a complete Roblox process restart; reattaching the executor does not establish their cleanup.

### Existing installation conflicts

1. Preserve the current working installation, private credentials, artifacts, and user-controlled settings. Run `doctor --json` and the intended operation with `--dry-run --json`; record the exact conflict without printing tokens.
2. Distinguish an owned copied runtime, an explicitly selected external/junction runtime, a custom launcher/wrapper, and foreign files. `setup --runtime-root <absolute-package-root>` selects the new/current already-installed package; it is not authority to delete the old runtime junction or its target. Even a proven legacy link remains preserved while metadata selects the external runtime.
3. Automatic migration requires exact ownership proofs. A custom OMP wrapper or a launcher whose bytes differ from recorded ownership must remain untouched on conflict. Do not overwrite it with a generated entry, delete the junction target, remove ownership records, or broaden symlink checks to make migration pass.
4. Back up and review the actual wrapper and host entry before a separate, explicit user-managed migration. There is no force/recovery bypass for an unproven wrapper. Restoring a separately proven standard owned entry requires an explicit user decision before managed migration. `config print` may preview an entry without writes, but does not prove replacement is safe. If standard ownership cannot be proven, leave the conflict intact.
   An explicitly migrated custom wrapper remains user-managed, not an owned standard launcher. Its direct internal-proxy consumer and runtime junction can remain in place; this exception is not the recommended entrypoint for new installations. A manual ownership record contains a suggested public launcher, not proof that the actual wrapper uses it or is connected.
5. For a proven installation, npm selects the approved new package (or prior package for downgrade), then setup/repair updates deployment against that package. Check diagnostics, restart affected hosts, and reattach Potassium. Update package, deployed assets, and running bootstrap together; never reload the bootstrap through its own active connection.

The former public `install` command and `--package-source` are removed; use npm for packages, `setup` for private state/deployment, `config print` for manual entries, and `host add/remove` for optional adapters. Repair no longer re-registers hosts. Repair preserves ports, timeouts, roots/allowlists, HTTP settings, grants, workspace, token identity, and artifacts unless an explicit supported change is requested. Unknown/invalid configuration fails with a conflict instead of silently resetting.

Existing valid manual host records survive setup/repair. Their suggested launchers follow the selected runtime, Node executable, and request deadline, without changing the user's registration files or granting permissions. Doctor reports these hosts as user-managed with `configured: false` and `actuallyChecked: false`; verify the actual wrapper separately. CLI output prints the suggested stdio launcher. `host add --host manual` is not an adoption command.

Schema-2 migration preserves effective old privileges, not dormant permission bits: an old `admin: true` hidden behind `allowUnsafeExecute: false` becomes false unless `--admin-host <id>` or `--http-admin` explicitly grants it during migration. Otherwise decoupling admin from the unsafe gate would silently broaden access.

Process-death recovery uses a bounded transaction journal. Repair may roll back/resume only after proving the old owner is dead and the journal/managed-state ownership is valid; age alone is not authority to delete a lock or foreign data. Dry-run reports recovery work without performing it. This is not a force bypass for edited wrappers, unknown credentials, or unproven paths.

Runtime config loading verifies adjacent ownership against raw hashes and private paths. A genuinely absent record denotes manual configuration; an existing invalid/mismatched record is a conflict, not permission to downgrade to manual mode. Verified schema-2 installations retain old effective host/HTTP admin denial while the unsafe gate is false until explicit migration; schema-3/manual configurations use independent axes.

`uninstall --all` removes only proven-owned registrations and deployed assets. Configuration, token, artifacts, and retained ownership evidence remain for safe reinstall; npm-owned package files are never removed by setup/repair/uninstall. Reinstall requires that retained evidence to match. Do not adopt an arbitrary existing token or delete credentials to bypass a conflict. Purging private data is a separate destructive operation, not the default uninstall.

## Deferred enhancements

- **K1 — Registry:** defer `server.json`, `mcpName`, and registry publication until there is a concrete discovery/distribution need and a verified package identity/start contract. Registry listing is optional, not a prerequisite for MCP compliance or Stable.
- **K2 — MCPB:** defer one-click packaging until a named desktop host needs it. Any later bundle must expose Windows/Potassium/bootstrap prerequisites and a coherent npm/update path; do not add a second runtime stack just for packaging.
- **K3 — Resources, progress, Tasks:** defer until a client benefit is demonstrated. Bounded artifact tools and project async jobs remain the current surface; async jobs are not MCP Tasks. No extra cosmetic tools/prompts, resource interface, progress delivery, or replay capability is promised.
- **K4 — Offline module analysis:** bounded explicit source intake, real native Luau parsing, retained indexes, calls/functions/dependencies/origins, and redacted excerpts are now implemented as documented above. The separate planning backlog is not itself completion evidence. Untrusted execution, automatic dependency loading, runner/replay/compare, and server-source reconstruction are not implemented by this static feature; the parser's demonstrated OS boundary is not approval to execute Luau.

Source, security policy, and issue tracker: https://github.com/mrketa/potassium-mcp

Licensed under Apache-2.0.

# Configuration

This describes the 1.1.0 source contract; configuration documentation is not proof that a candidate is published or installed. The qualification target remains Windows 11 x64 with Node22/24 and Potassium2.4.7. Platform/host/protocol boundaries and artifact evidence are separated in the [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status). Release preparation does not authorize changes to an existing installation or grants.

## Windows Setup defaults

Only a genuinely fresh Windows Setup installation initializes generic `agent` with read/admin/execute access and `allowUnsafeExecute: true`, making synchronous `potassium_execute_luau` and asynchronous `potassium_execute_luau_async` available without an extra Setup warning, consent, or permission prompt. Updates, repairs, and reinstalls with retained configuration preserve explicit existing permissions, including restrictions. A missing `agent` policy in existing configuration may receive a read-only entry, never elevation of admin, execute, or the global gate; absence of that policy alone is not a fresh installation. Missing configuration or a recovery journal defers the helper grant until recovery is resolved. Windows supplies `--initial-full-access-host agent` to the core; it applies only when creating genuinely initial configuration after recovery, not as a prerequisite the user must configure.

> **Execution risk:** arbitrary Luau can change the connected client and act with its executor's permissions. Connect only trusted agents; untrusted content or prompt injection may induce unwanted actions. Execution is not sandboxed. See [Security](../SECURITY.md).

Setup has no Safeproxy and does not bypass harness/application approvals. Authentication, loopback restrictions, truthful tool annotations, and bounded resource limits remain active. The fresh grant does not enable optional HTTP/fallback transports or widen external-host allowlists or trace/artifact roots. The workspace **Change folder** picker is directly visible; custom `--app-root` and `--install-root` remain [explicit Setup CLI options](DEPLOYMENT.md#windows-maintenance-and-custom-roots).

## Advanced npm CLI configuration

The advanced npm CLI defaults are unchanged and do not inherit Windows Setup's fresh full-access policy. Admin and execute grants remain explicit as described below.

`potassium-mcp setup` writes private runtime configuration beneath `%LOCALAPPDATA%\Potassium\MCP`, outside npm/cache/package files, and deploys the canonical bootstrap/autoexec assets. It does not install npm packages or register a host. Do not copy `config.example.json` over generated configuration or manually change token identity to bypass an ownership conflict.

`potassium-mcp serve --config <absolute-config-path> --host-id <unique-id>` is the public stdio entrypoint. All public commands share this resolution order: explicit `--config`; `config.json` under explicit `--install-root`; absolute `POTASSIUM_MCP_CONFIG`; `config.json` under absolute `POTASSIUM_MCP_INSTALL_ROOT`; default root. Explicit installation selection must not be redirected by ambient config environment variables, including broker lifecycle operations. The default is `%LOCALAPPDATA%\Potassium\MCP`, with `~/.local/share/Potassium/MCP` as a portable host-core fallback, not a Potassium/Linux support claim. Explicit relative CLI paths resolve from invocation CWD; environment paths must be absolute. There is no CWD search for credentials.

Fresh CLI setup requires explicit `--workspace` or absolute `POTASSIUM_WORKSPACE`; later operations can reuse the previously verified workspace. Pass the conventional `%LOCALAPPDATA%\Potassium\workspace` explicitly rather than relying on silent discovery. The private root's generated file is `config.json`.

Use `config print --host-id <id> --json` for the standard entry without writes or grants. First define a custom ordinary read-only identity through `setup --read-host <id>` or `repair --read-host <id>`; unknown IDs reject. The default entry uses absolute Node and public-bin paths. `--npm` pins the package metadata version and is appropriate only after confirming the matching approved artifact. IDs match `^[a-z][a-z0-9_-]{0,63}$`; choose a distinct ID per project/launcher.

The executor and proxy listeners remain loopback-only. stdio entries contain no token; the broker and bootstrap access the private credential through managed state. Setup/repair preserve restricted token permissions. `artifactRoots` and `httpAllowedHosts` are explicit bounded allowlists. Configuration-relative paths are resolved by the runtime config loader, not by the MCP host's working directory.

Runtime configuration loading verifies any adjacent ownership record against raw configuration hashes and private-path identities. No adjacent record means manually managed configuration; an existing invalid or mismatched record is an ownership conflict, not a fallback to manual mode. Do not delete records to bypass a managed conflict. Raw-byte verification is distinct from parsed configuration normalization.

Every host proxy authenticates to the singleton broker on `127.0.0.1:32146`; the broker accepts Potassium clients on `127.0.0.1:32145`. Each client has up to four concurrent read slots, while mutations are FIFO barriers. Heartbeats and bounded reconnect keep live clients discoverable without replaying uncertain mutations.

Generated configuration sets `adminAuditPath` to `potassium-mcp-admin-audit.ndjson` beneath the selected workspace. This bounded durable NDJSON history contains at most 100 metadata-only execution records: hashes, byte counts, timing, outcome/error class, runtime client metadata, and anonymous proxy-session ID. It never stores Luau source, returned values, or secrets. Async records prove acceptance, not completion. Admin diagnostics can be granted without enabling execution.

Use `host add/remove --host <adapter> --host-id <id>` only for optional registrations. Policy changes belong to setup/repair: `--read-host <id>`, `--deny-read-host <id>`, `--admin-host <id>`, and `--execute-host <id>`; HTTP policy is independent through `--http-no-read`, `--http-admin`, and `--http-execute`. Read/admin/execute are independent; only execute grants require `--allow-unsafe-execute`. Registration and printed entries do not grant permissions. Verify effective policy with `doctor --json` and each transport's `tools/list`.

Policies constrain trusted launchers sharing a token. A malicious token holder can claim a different known `hostId`; HMAC transcript binding prevents tampering, not this impersonation. No adversarial per-host isolation or sandbox is provided. Keep credential readers and unsafe execution trusted.

Repair preserves ports, timeouts, roots/allowlists, HTTP settings, grants, workspace, token identity, and artifacts unless an explicit supported change is requested. Revocations include `--no-unsafe-execute`, `--no-streamable-http`, `--no-stateful-http`, `--no-builtin-fallback`, and `--no-native-editor`; disabling execution does not remove independent admin permission, and disabling editor tools does not revoke execution. Unknown or invalid configuration conflicts instead of resetting. `rotate-token` rotates only the custom token, restarts the broker, and requires Potassium reattach.

Legacy schema-2 compatibility and migration preserve effective denial: `admin: true` remained dormant while `allowUnsafeExecute: false`, for both host and HTTP grants. Loading a verified schema-2 installation retains that effective admin denial until explicit schema-3 migration; migration sets dormant admin false unless explicitly granted with `--admin-host <id>` or `--http-admin`. Schema-3 and manual configurations use the new independent axes. Runtime compatibility requires `potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 }` metadata, not just a matching package version string.

`doctor` is static by default. It accepts `--config`/`--install-root`, optional configured `--host-id`, and `--json`; explicitly add `--probe` for host-CLI/broker checks. Static output does not qualify live host use or compare fabricated running executor details.

## Offline source roots and parser runtime

`sourceRoots` is separate from `artifactRoots`; code indexing does not relax artifact/trace source or secret blocking. Runtime loading defaults omitted sourceRoots to `[]`. A genuinely fresh core/Windows configuration initializes one `sources` root at `<selected-workspace>/potassium-mcp-sources`, recursive with `.lua`/`.luau`, and creates that directory. Retained configurations are not widened or backfilled with this root. No extra permission UI, Setup prompt, automatic imports, or runtime downloads accompany indexing.

Configuration shape:

```json
{
  "sourceRoots": [{
    "name": "sources",
    "path": "<selected-workspace>/potassium-mcp-sources",
    "recursive": true,
    "extensions": [".lua", ".luau"]
  }]
}
```

This is a schema example, not a replacement for managed configuration. There are at most 16 roots; unique names match `^[a-z][a-z0-9_]{0,63}$`; paths are 1–4096 characters and resolve relative to the configuration directory. Recursive defaults false. Extensions default to `.lua`/`.luau` and may select only those one or two unique values. Recursive permits explicitly named nested files, not directory enumeration. Index requests use `{ id, root: "sources", path: "Client.luau", logicalPath? }`; inline `{ id, source, logicalPath? }` needs no root. Paths are explicit relative files with an effective intake limit of 1024 characters. Traversal, absolute paths, ADS, redirected links/reparse paths, unknown roots, and changed opened-file identity/version reject. Root/ancestor ownership remains a trusted boundary; path checks are best-effort, not atomic containment against an adversarial root owner. Managed configuration ownership/repair rules still apply.

The native parser never receives original source-root paths/config/token; the trusted broker supplies bounded source. Production uses a GUI-independent C Tree-sitter `0.25.0`/Luau grammar `1.2.0` worker under `assets/native-parser/win32-x64`. The self-contained C# ParserHost handles bounded framing, and the trusted parent validates native-tree data before bounded JavaScript semantic analysis. Web-tree-sitter/WASM are development-test-only, not runtime dependencies/fallback.

From the repository root build in order: `node tools/native-parser.mjs build`, `node tools/parser-host.mjs build`, then npm packaging/Windows stage/build. Native build provisions hash-pinned Zig `0.14.1` only at build time; ParserHost requires exact .NET SDK `8.0.424`/runtime `8.0.30`. Seals include native parser/runtime/compiler and .NET license notices. Target installations need no compiler/shared .NET and download no parser/runtime on invocation.

The fixed backend uses ordinary no-capability Windows AppContainer and atomic single-process Job limits, without CHILD_PROCESS_POLICY, experimental debug paths, private desktop/station, or existing UI ACL edits. It is not LPAC, a worker-thread sandbox, or an absolute filesystem whitelist; AppContainer-public Windows resources remain accessible. The semantic parent is trusted, not OS-confined. Unsupported platforms/missing assets report unavailability with no runtime downgrade/fallback. Local native parsing, file/runtime-write and child/network denial, resource limits, cancellation, and crash-recovery cases passed as [scoped in Testing](TESTING.md#parser-and-source-analysis-proof-boundaries); they do not establish universal compatibility, a final green suite, or new artifact acceptance.

## Optional Streamable HTTP endpoint

`streamableHttpEnabled` defaults to `false`; enable stateless `/mcp` with `--streamable-http`. Enable stateful `/mcp/session` with `--stateful-http`. `--streamable-http-port <1..65535>` defaults to `32147`.

```json
{
  "streamableHttpEnabled": true,
  "streamableHttpHost": "127.0.0.1",
  "streamableHttpPort": 32147
}
```

The stateless endpoint is `http://127.0.0.1:32147/mcp`; it supports authenticated POST only. Stateful `/mcp/session` supports POST/GET/DELETE with `mcp-session-id`, at most 32 sessions, and a 15-minute idle timeout checked lazily on subsequent registry operations. A long SSE connection does not keep refreshing that request-admission clock. Programmatic configurations may use port `0`, while managed configurations require a positive port.

Each stateful session also caps combined active and retained-cancellation request correlations at 256. Native SSE stream closure is not immediate correlation reclamation. If retained cancellation state leaves too little room for the next batch—including batch sizes that do not divide 256 evenly—the affected session rejects undispatched work and retires only after its own active response members/handlers/dispatches are idle. Reinitialize that session after retirement; no other session is evicted. GET/SSE closure neither forces arbitrary Luau to end nor authorizes replay of uncertain work. See [API](API.md#optional-streamable-http-transport) for pressure/status behavior.

HTTP clients use `Authorization: Bearer <token-from-private-token-file>`. POST requires `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Use the legacy initialization/initialized lifecycle, negotiated `MCP-Protocol-Version`, and session IDs as described in [API](API.md#optional-streamable-http-transport). SDK `1.30.0` negotiates up to `2025-11-25`; omitted HTTP version headers default to `2025-03-26`. No `2026-07-28` or event replay support is claimed. Never copy tokens into generated launchers, committed configuration, logs, or diagnostics.

## Remote workflow and compact defaults

These workflow defaults do not change authorization: fresh Windows Setup keeps full generic-agent access; retained installations and ordinary npm CLI defaults keep existing rights. No Advanced UI, extra prompt, Safeproxy, automatic host registration, live bootstrap deployment, or user configuration migration is introduced.

| Surface | Default and bound |
|---|---|
| Successful tool response | Ordinary metadata stays within `min(8192, maxMessageBytes, proxyMaxFrameBytes - 8192)`; explicit structured-result clients avoid full JSON text duplication. Context images use the existing transport ceiling, not a larger metadata cap. |
| Compact result retention | Memory-only 64 entries/8 MiB total/1 MiB each, 120-second lifetime; oldest eviction under capacity pressure |
| `potassium_result_read` | Default auto for root/single/multiple pointers; explicit text for legacy paging. 1–8 unique pointers/1024 combined characters, matching offsets; shared2048-byte default/4096 maximum data budget. |
| Traces | Summary excludes rows unless includeRows is true; queries default to 20 admitted rows and 8192 input bytes |
| Artifact reads | maxBytes defaults to 4096; existing configured-root and explicit upper-bound controls remain |
| Remote inventory v4 | Summary,20 rows/groups,maxVisited5000,references off; snapshots8/512 rows/256KiB each/1MiB total/120s. Retained query narrows existing rows without rescanning or renewing lifetime. |
| Remote capture v2 | Explicit start only,5000ms,100 retained events; at most4 active/8 retained,64KiB shared metadata/profile budget,60-second terminal retention. Value examples remain opt-in. |
| Action observation v1 | Explicit start/poll/stop, 1–16 state selections/optional 1–16 remotes, 5000 ms default/1000–30000 range; 4 active/8 retained, 128 KiB each/1 MiB total/120-second terminal TTL |
| Typed remote call v1 | One queued FireServer/InvokeServer, 0–16 typed arguments, depth 6/256 nodes/64 KiB normalized envelope; standard async job limits |
| Interaction inventory v1 | Workspace,summary,maxVisited5000,references off; rows1–200/default20; snapshots8/512 rows/256KiB each/1MiB total/120s,100000 scan work items. Retained query preserves original coverage/expiry. |
| Typed interaction call v1 | One queued click/prompt/boolean-touch native helper call in the existing async lifecycle; explicit targets, no property/movement controls, automatic pair or replay |
| Offline code index | 32 modules/256 KiB each/4 MiB input; 4 retained indexes/8 MiB accounted source/8 MiB metadata/10 minutes; queries 10 rows default, 50 maximum |
| Session statistics | Metadata-only admitted call/byte/timing/error counters, at most 128 tool rows/64 salted scan keys, no reset tool |
| Focused diagnostics v2 | Overview unchanged; character, UI (player_gui/10 default), nearby (radius 32/10 default); UI/nearby limit 1–20, nearby radius 1–128; normal stable references |
| Capabilities | Summary by default; explicit full or one named section. Internal feature preflight remains full. |
| Shared game context v2 | Capture: Workspace,maxVisited2500,maxParts200,uiLimit20,remoteLimit50,screenshot/map true. Requested facets partition aggregate work/visit/byte bounds. Eight config-owned records,2MiB each/16MiB total; persistent release/oldest eviction; offline list/read/image/release. Native geometry bindings separately bounded8snapshots/1024parts/256KiB/180s. |
| Context images | Windows window-only PrintWindow and box schematic; one bounded helper,10s,1MiB IPC. JPEG at most128KiB and reduced further to existing transport budget; no desktop fallback. |
| Parkour maps | Eight immutable config-owned maps,4MiB each/32MiB total;1024parts/2048surfaces/4096links/256chunks/32sources/eight observation batches. Offline build/update/read/list/image/route/release; explicit parent-linked revisions. |
| Map observation/probes | Read-only mapObservation1;1–16 bound source objects,100–5000ms/default2000,50–1000ms interval/default100,<=101samples per object. Probe grid2–8 per axis,<=64downward rays. Native sources must remain valid; old paths are not rebound. |
| Continuous map recording | lifecycle-6/mapRecording1;1–4 exact bound targets,1000–60000ms/default30000,50–1000ms interval/default100;4active/8retained,1201frames,2MiB samples,256events/64KiB,32markers;120s terminal retention, never poll-renewed. |
| Archived recordings and receipts | Up to4 full recordings per immutable schema3 map within unchanged4MiB/map/32MiB total.128 once-only receipts in the existing map index, no silent eviction; map index64KiB is storage-only, not a discovery/result cap change. |
| Selective map reads | Offline exact section-compatible query,1–16 IDs, query/presentation-bound cursors and explicit track-summary projection; existing limit1–100/default20 and6KiB soft row-page budget, whole oversized rows retained. |
| Catalog | Full policy-allowed catalog for ordinary/stateless HTTP clients; standard nextCursor pages only when proxy frame budget requires them |

Compact pages and index queries recheck scope and originating permission. stdio/stateful scopes close with their session; stateless HTTP shares broker-owned HTTP-policy results/indexes/statistics across POSTs. Inventory/capture/action-observation registries belong to the selected bootstrap generation. Shared game contexts instead use a private namespace derived from the explicit configuration path; they survive broker/Roblox/session closure and are shared by read-authorized agents on that config. Broker close clears transient results/indexes/stats, not these saved contexts. Temporal observation interruption and typed post-dispatch cancellation remain explicit, not proof that game actions stopped.

Lazy catalog discovery is a client initialization opt-in, not a setup flag: `capabilities.experimental["potassium/tool-discovery"] = { version: 1, listChanged: true }`. Only retained sessions negotiate it; ordinary/stateless clients remain full. The catalog budget is independent of the8KiB ordinary-result ceiling; follow nextCursor according to actual current schema size. SDK1.30.0 listTools/auto-refresh cache one page, so fetch all pages on refresh and the target page before its typed call. Permissions and user host configuration remain unchanged.

Ordinary inventory requires remoteInventory v3 and retained query requires v4; new game-context capture requires gameContext v2, while saved-context views and map analysis require no executor. Map observe/probe require mapObservation v1 and matching source client/generation. Capture profiles use remoteCapture v2; temporal action observation uses actionObservation v1; typed remote calls use remoteActions v1/asyncJobs v2; nondefault diagnostic views use diagnosticSnapshot v2/instanceReferences v1. Remote capture/action-observation/calls require execute/global gates; game-context and map tooling, source analysis and focused diagnostics require read policy. Discovery and available APIs do not prove every server semantic. [API](API.md) contains exact contracts.

Interaction inventory requires `interactionInventory.version >= 1` and read permission; it uses the ordinary read lane, not reserved controls. Interaction calls require `interactionActions.version >= 1`, `asyncJobs.version >= 2`, execute permission and `allowUnsafeExecute`. Source as well as target instance references require `instanceReferences.version >= 1`. Unsupported/missing methods or a changed client generation reject before dispatch. No new grant axis or configuration knob is introduced: preserve every configured local launcher (including generic agent) and independent HTTP execute grant, raw sync/async tools and all configured editor tools.

Touch calls accept only the documented boolean parameter and forward it unchanged. Owned-fixture observations do not establish begin/end phases, exactly one event, arbitrary target eligibility, or universal side effects. Successful jobs report native dispatch with `serverAcknowledged: false`, not gameplay success. See [interaction API and qualification limits](API.md#one-typed-interaction-job). Source support, modeled tests, native fixtures, and final installed-artifact qualification are distinct.

Recording requires read policy, not admin, execute, or `allowUnsafeExecute`. Its native feature is `mapRecording.version:1`, included in the 1.1.0 `lifecycle-6` bootstrap; tool discovery is not proof of a running compatible sampler. Start takes the ordinary read lane; lifecycle controls remain within bounded control/global handler/recovery limits. It adds no configuration grant, raw-execution fallback, or automatic bootstrap deployment.

Live recorder state belongs to the exact bootstrap client/generation; a disconnect ends active recording with retained partial evidence. Native terminal evidence expires120seconds after stop; reading does not renew it. Saved schema3 archives and accepted import receipts instead belong to the map service's durable configuration namespace and survive broker/session closure. Exact accepted save retries work offline even if the original parent or saved map has been released; released saved maps return their prior identity with released:true rather than being recreated. New saves require terminal native evidence and matching current generation. Receipt capacity is a hard bound, not an eviction queue; do not delete index entries or private ownership files to bypass it.

The combined model-track quota is128 across short observations and continuous recordings; known start-time exhaustion returns a typed limit error before sampling, without archive overwrite. Same-process exact duplicate imports share an owner, bounded to eight in-flight imports per configuration; joined cancellation still returns acceptance if that owner commits. Cross-process contention may report BUSY, with durable exact-retry receipts remaining authoritative. Native sample time, not host save time, orders same-generation continuous windows; mixed legacy/native clock ordering stays uncertain. Failed/target-lost recordings retain valid raw data but cannot justify extrapolation.

Geometry/navigation/motion selectors and recording archive reads require no client or capability lookup. `potassium_map_navigation` handles links/routes; `potassium_map_motion` handles tracks/hazards and track summaries. `potassium_map_recording` handles lifecycle and summary polling; `potassium_map_recording_read` handles live frame/event polling or offline archive reads. No cross-tool compatibility aliases are retained. Track summaries and at-most101-sample motion-model projections do not delete raw archived frames/events. Native monotonic sample/marker times, host ISO receivedAt, historical metadata, reported mechanics and modeled routes remain distinct. See [API](API.md#continuous-map-recording) for exact selectors, readiness and persistence rules.

Agent guidance is Docs-first: start at [Agent quick start](AGENT-INSTALL.md#agent-quick-start), then follow the canonical [Agent workflow](API.md#agent-workflow). Tool schemas and structured errors remain authoritative. No skill is installed by default or required for Stable; documentation does not register MCP, grant access, enable unsafe execution, install a package or certify OMP/Codex integration. Preserve existing host skills, registrations, wrappers and policy; do not overwrite them to follow this guidance.

Structured-result presentation is a separate client initialization opt-in: `capabilities.experimental["potassium/structured-results"] = { version: 1 }`. Only clients that consume structuredContent should enable it; their text block is concise presentation, not the full JSON payload. Ordinary clients keep complete recoverable text. No host policy or configuration file is rewritten to enable either client extension.

## Native desktop editor

`nativeEditorEnabled` is false by default. `nativeEditorTokenFile` is optional while disabled and required when enabled; relative config paths resolve against the configuration file. The native editor credential is separate from the custom broker token and configured independently from `builtinFallbackTokenFile`. The two native features may point to the same native credential file, but neither may use the custom broker credential. Keep it private; setup rejects linked/hard-linked paths, non-files and malformed tokens. The editor token must contain 32–4096 non-whitespace/control characters after trimming. Secret paths and token contents are not editor tool diagnostics.

The commands below assume an npm-managed installation with `potassium-mcp` on PATH. Windows Setup users do **not** need to install global Node/npm: follow [the bundled maintenance procedure](DEPLOYMENT.md#windows-setup-installation-without-global-node-or-npm), using the existing ownership record's Node executable and installed package CLI with the explicit private `--install-root`. Close Setup and affected MCP sessions first; do not run the two management paths concurrently.

```powershell
potassium-mcp repair --native-editor-token-file <private-native-token-path> --dry-run --json
potassium-mcp repair --native-editor-token-file <private-native-token-path> --json
potassium-mcp repair --no-native-editor --json
```

The token-file option enables editor tools; relative CLI paths use the invocation directory. `--no-native-editor` disables only editor tools and removes their configured token path, not the file or diagnostic fallback settings. `--no-builtin-fallback` leaves editor configuration intact. Neither feature changes `hostPolicies`, `httpPolicy` or `allowUnsafeExecute`. Setup validates the local credential without contacting the native service; a native endpoint outage does not block unrelated setup permissions. Static `doctor` reports the configured editor token file's availability without reading editor content or probing native readiness.

List/read require read permission. Open/write/activate/close require each caller's execute permission and global `allowUnsafeExecute`; no admin-only or agent-exclusive gate is introduced. Existing authorized synchronous/asynchronous Luau execution remains available to all trusted agents. To explicitly opt selected local identities into read and execution, repeat the flags for **every intended identity**, retaining existing admin bits:

```powershell
potassium-mcp repair --allow-unsafe-execute --read-host omp --execute-host omp --read-host agent --execute-host agent --read-host project-a --execute-host project-a
```

Replace these example IDs with the actual known/configured identities; there is no implicit grant to all future hosts. HTTP is separate: explicitly add `--http-execute` with `--allow-unsafe-execute` if authorized, and preserve its read/admin policy. Packaged defaults remain unchanged; editor opt-in alone is not an execution grant.

The [six desktop editor tools](API.md#native-desktop-editor-tabs) use fixed `127.0.0.1:8225/mcp`, not the Roblox bridge. Content is bounded to 256 KiB of UTF-8; writes require a lowercase SHA-256 precondition that is not atomic against native UI changes. Prefer new drafts, and do not force-close dirty tabs.

## Built-in diagnostic fallback and artifacts

Enable the diagnostic-only fallback with `--builtin-fallback-token-file <private-path>`. The file must exist, remain private, and contain a token different from the custom broker token. The endpoint is fixed to `http://127.0.0.1:8225/mcp`; disable it with `--no-builtin-fallback`. It exposes only bounded status, client listing, and console capture.

Async terminal envelopes over 64 KiB are stored under the managed artifact directory and returned as descriptors. Read them through `potassium_artifact_read`; configured root, extension, canonical-path, byte, and redaction limits still apply.

Terminal jobs prune expired records lazily on job operations/completion; their retention window is not an idle-memory reclamation deadline. Terminal watches are physically pruned by the one-second lifecycle sweep as well as relevant operations. References have no TTL or silent eviction and require explicit release. These generation-local registries are shared by trusted sessions, unlike durable artifacts; artifact cleanup is itself activity-driven, not a timed disk-deletion guarantee.

Configured filesystem roots remain trust boundaries: canonical identity checks and snapshots are best-effort, not atomic directory-handle containment or last-instant pathname ABA protection. Keep root/parent ownership trusted. A covered exclusive-create parent swap may leave an empty temporary file outside the intended root without result bytes; unsafe-path cleanup deliberately refuses to risk unrelated unlink. Redaction is not exhaustive DLP; review material before deliberately sharing artifacts.

Executor deployment renders only the canonical bootstrap endpoint from the preserved configured loopback host/port: `127.0.0.1` or `::1`, and port `1..65535`; IPv6 is bracketed in the WebSocket URL. The normal executor endpoint is `ws://127.0.0.1:32145`. This is not non-loopback support, and npm-owned asset bytes are not edited. Deployment parity must compare the correctly rendered bytes.

OMP's managed outer request timeout is `max(40_000, requestTimeoutMs + 10_000)` milliseconds. A longer explicit executor timeout therefore does not retain a shorter fixed launcher timeout; expiry still does not prove nonexecution or forcibly stop code.

For accepted edits to an active config, repair authenticates drain against the recorded old endpoint under the exact held installation lease with the unchanged owned token. Normal load/stop operations remain strict. If recovery cannot reconstruct the original in-memory config after stop, preserve user edits and the resume journal rather than claiming an old restart.

A postcommit restart rejection is startup-uncertain, not proof of rollback: keep current committed config/credentials/backups/journal, inspect broker status, then repair. Never assume old credentials were restored or automatically repeat token rotation. Postcommit backup/journal cleanup failure is reported as `cleanupPending` without rolling back committed state.

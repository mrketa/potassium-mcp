# Testing

## Current source qualification boundary

The active first-Stable target is Windows 11 x64, Node 22/24 and Potassium 2.4.7 through public stdio and authenticated stateless/retained HTTP. Previous exact Node runs used 22.23.2/24.15.0; they do not qualify newly edited source automatically. Windows 10, Linux host core, Linux/macOS executor use, other Node lines/host applications and MCP 2026-07-28 remain unqualified. Stock SDK and the existing user-managed OMP wrapper have distinct evidence, not universal host certification.

The recorder, selective reads and exact grouping have source qualification, with a separately scoped real lifecycle-5 idle-recording acceptance described below. First-Stable version `1.0.0`, isolated package/Windows builds and unsigned distribution are explicitly approved; publication remains a separate protected decision. The selected release's `QUALIFICATION.json` and hash-bound `RELEASE-SET.json` identify its exact approved bytes and scoped evidence. Earlier package, EXE, ZIP and soak results below remain historical artifact-bound evidence, even when filenames are unchanged. No separate testworld or retired A5/F6/I3 gate is reinstated.

Qualification success includes cleanup: the packed smoke observes the owned stdio transport's close notification before deleting its temporary tree, retries only bounded transient Windows filesystem cleanup, and retains uncertain roots plus the original failure when cleanup also fails. Failure diagnostics are bounded and are not public release assets. Version-roundtrip evidence records safe phase names, elapsed times and failure categories before operations; its CI observation window is not a runtime latency guarantee and does not relax the full-soak limits.

Hosted Windows jobs use the explicit `windows-2022` image and SDK 8.0.424 rather than the moving `windows-latest` image. This is a reproducible CI host choice, not a Windows Server product-support claim or a substitute for the separately observed Windows 11 GUI/installed-runtime checks. Isolated Windows profiles include real `AppData/Local` and `AppData/Roaming` directories before subprocesses start. Prior `windows-latest` stalls and failures remain retained evidence, not passing qualification.

The user-approved CI boundary explicitly readies Windows PowerShell/CIM and the built-in security commands before functional qualification. This dependency-readiness step is separately bounded and timed; it changes no runtime/RPC deadline, skips no test, and does not certify cold OS-start latency. Hosted cold shell startup was observed to exceed the runtime's five-second process-inspection cap even when the query itself was fast. Without timely identity evidence, the runtime continues to fail closed rather than trust a PID.

### Proxy startup source fix — September 11, 2026

[Source acceptance](../release-out/proxy-startup-fix-L08a5O/ACCEPTANCE.json) records a real pre-fix crash: a valid HMAC challenge followed by an invalid WebSocket opcode in the same network write emitted an unhandled socket error. Continuous startup ownership now preserves and rejects that error instead. Real-wire regressions also cover the upgrade and ready handoffs; already-closed authentication rejects promptly rather than waiting for another phase timeout. A stalled `CLOSING` peer terminates through the existing shutdown grace without reading queued MCP input. Invalid proof/protocol data remains terminal; no retry, replay or larger timeout was added.

Final Node22.23.2 and Node24.15.0 suites each report **851 tests,848 passed,0 failed,3 platform skips**. Targeted proxy/transport checks passed34/34; actual public-CLI source smoke passed on both Nodes with two independent authenticated sessions and49 tools each. Closing one client left the other usable. Independent review found no remaining blocker after the closing-handoff correction.

This is a source fix, not new artifact or live-executor qualification. The previous npm/Setup/ZIP bytes below remain unchanged and do not contain it. No user broker restart, installer repair, ownership repinning, bootstrap reload or publication was performed. Source-linked direct proxy launches pick up changed source on their next launch; existing processes retain loaded code, and management/Windows integrity checks may report source drift until separately verified. The old unrecorded Node24 incident still cannot be retrospectively attributed to a particular frame.

### Historical isolated test candidate — September 10, 2026

The separately approved [current candidate acceptance](../release-out/test-candidate-eMUgvF/source/release-out/candidate/ACCEPTANCE.json) binds npm SHA-256 `3d6c86f65cad9667e52ea340e6bfa58af8443bd683e51988d9ba6afbb61eca1a` to one unsigned/unpublished `0.10.0-beta.1` npm/Windows candidate. Independent Node22.23.2/24.15.0 installs exercised public CLI/npm/npx, stock-SDK stdio/stateless/retained HTTP, native parser, policy and cancellation paths. Installed offline map/archive reads on both Nodes survived real owned-broker restarts; all601 modeled source frames and the event were recovered exactly.

The unshortened Node24 soak completed1,800,127.9393ms,65,682 counted operations,7,298 batches and30 modeled lifecycle batches. Sampled three-operation p95 was125.5128ms; the unchanged32MiB growth/+8-resource/2s p95 assertions passed. Recorded post-GC heap samples span87,881,960–90,895,248bytes, resource maximum21; that sample range is not a separately retained baseline-growth value. No game/FPS/individual-RPC latency guarantee follows.

Actual Windows GUI install, restricted upgrade, repair, old/current rollback, cancelled/confirmed removal, retained reinstall and cold connection checks passed. Actual no-argument Launcher/native-parser sessions exposed64 full-access or49 restricted tools, with the live Node child bound to the installed bundle.11 protected fixture/context/map files—including schema2 mechanics and schema3 archives—survived maintenance/removal/reinstall; cancellation preserved17 files. Windows PowerShell5.1 remains an OS prerequisite; the Launcher apphost trace establishes its self-contained modern .NET binding, and the runtime uses bundled Node.

**This historical candidate was No-Go.** The first Node24 preflight closed stdio unexpectedly after179.72s; its stage/cause was not retained. The unmodified full soak and later observed parallel Node22/24 retries passed, but do not resolve that failure. The [targeted follow-up](../release-out/candidate-gaps-n2a2vQ/STDIO-CAUSE-REPORT.json) also passed a fully observed original preflight and distinguished a deliberately forced authentication timeout from natural failure; neither establishes historical attribution. New candidate acceptance must retain this uncertainty rather than assign that incident to the subsequently reproduced proxy startup defect.

The separately requested [clipboard follow-up](../release-out/candidate-gaps-n2a2vQ/CLIPBOARD-ACCEPTANCE.json) passed all three actual Setup copy handlers, exactly three dispatches and three Unicode/confirmation readbacks. Six synthetic formats were restored. The exact Setup ran through normal RunAs/UAC in a newly created, protected, noninteractive private window station; process-bound native class/caption selectors were used where UIA returned no controls. This proves elevated private-station transfer, not unelevated interactive-desktop/UIA coverage. Original user clipboard was never opened; owned processes exited and the protected root was deleted. Earlier permission failures and corrected throwaway-harness defects remain retained. Candidate bytes, real installation and publication state are unchanged; signing/distribution/publication still require separate decisions.

The preceding integrated source run reported **841 tests on each of Node22 and Node24:838 passed, zero failures and three explicit platform skips**. Its modeled bootstrap audit reported **134/134**, including the100-cycle lifecycle scenario. These earlier source/model counts remain distinct from the subsequent842-test host fix and real idle-recording evidence below.

The subsequent real-client integration found a host input-schema portability defect: valid `potassium_result_read` inputs failed before dispatch on generated `#d0` anchors. The corrected input schemas use local JSON Pointers without weakening validation or increasing budgets. Final Node22/24 runs each report842tests/839passed/0failed/3skips; targeted broker/SDK runs each213/212/0/1. The exact previously blocked eight-pointer read, archived first frame and accepted save retry passed in the mounted host after a broker-only restart. [Schema-fix evidence](../release-out/recorder-live/SCHEMA-FIX-ACCEPTANCE.json).

[Real recorder evidence](../release-out/recorder-live/LIVE-ACCEPTANCE.json): lifecycle-5/mapRecording1 on Potassium2.4.7 recorded three selected character parts,571frames/1713samples and one MCP-receipt marker. Frame span29.9859923s; actual spacing50.0795–67.087ms, mean52.607ms for requested50ms. Native reports0missed whole intervals/0retained drops and natural duration-complete. Root position was unchanged; Head/UpperTorso poses changed through animation; Health100. No player movement/input/camera/remote/raw-execution actions. Parent/context and references were released; full raw archive remained readable, including after host restart and exact save retry. Recorder timers/holds/active/retained data, instance references and native snapshots returned to0. Capture coverage was partial; recording coverage concerns only selected targets. A controller paging-shape assertion was corrected by resuming the already saved archive, never restarting the recording.

Current reproducible evidence is under [first-stable-source/QUALIFICATION.json](../release-out/first-stable-source/QUALIFICATION.json). The isolated actual-bootstrap producer emitted601frames/1803samples over30modeled seconds; exact wire DTOs survived real storage and two recreated stock-SDK readers, including offline accepted retry and full frame/event equality. Its codec is explicitly Lune serde plus the documented [HttpService empty-table JSON behavior](https://create.roblox.com/docs/reference/engine/classes/HttpService#JSONEncode), not an engine-serializer qualification.

[Graph comparison](../release-out/first-stable-source/GRAPH-COMPARISON.json) retained all1002/1157 discrete opportunities while storing110/128 grouped links; link JSON fell from699653→124519 and793347→143572 bytes. Parts, surfaces, tracks and hazards are equal. Three measured repeats follow one warmup; timings and heap/RSS deltas are source-process observations, not game/RPC guarantees. The actual saved Galaxy map was rendered and visually inspected; both original map files remain byte-identical.

[Selected-read measurement](../release-out/first-stable-source/SELECTIVE-READS.json) on the unchanged Galaxy map reduced retrieval of both reported pads from11unfiltered reads/59839DTO bytes to1selected read/2587bytes, with identical rows. Five track summaries required5full reads/30378bytes versus1summary read/3092bytes, preserving all requested summary facts and raw-sample access. These are service DTO bytes/calls; SDK correctness is separately qualified, and no executor was consulted.

[Skill evaluation](../release-out/first-stable-source/SKILL-EVALUATION.json) contains90 fresh-agent inert decisions across15cases and three repeats/arm. Fixed-rubric full criteria: A41/45, B45/45; crediting one legitimate capability clarification excluded by an overstrict criterion gives A42/45. Remaining difference is recording-archive routing in one repeated case. Both arms had zero unnecessary refusals and zero unsafe compliance: no demonstrated refusal reduction. Two invalid-cursor pilot decisions were retained and symmetrically replaced after fixture repair.44 structured proposals passed SDK input-schema validation; no proposed MCP action executed. Per-trial tokens/provider/model-only latency were unavailable; packet/reference/response bytes are reported without token estimates.

That historical comparison is unchanged; it is not Docs-vs-Skill evidence and does not establish a benefit over the current docs. The exact former skill, adjacent references and controlled case inputs are preserved in [SKILL-SNAPSHOT.json](../release-out/first-stable-source/SKILL-SNAPSHOT.json). They are archival inputs, not installed guidance or an active evaluation command.

### Recorder, immutable evidence and selective-read checks

Qualification must exercise a continuous native sampler for at least 30 seconds, first-real-sample readiness, scheduler gaps without fake catch-up samples, the absolute deadline, source holds across source expiry, selected-target disappearance, disconnect/generation change, response rollback and once-only cleanup. Polling must not sample or extend recording/terminal retention. READY is a fresh native receipt, not a model timer or promised user run. Existing short observation windows and user-reported mechanics do not substitute for this proof.

Host/store coverage must reject active saves, missing/duplicated pages, changed terminal identity, wrong client/parent and altered finalized evidence; preserve all raw frames/events; and exercise concurrent import, broker restart, offline accepted-receipt retry and parent/saved-map release without duplicate revisions. Partial coverage remains partial. Archive metadata is historical and must not be restamped as a current native receipt. Original schema1/2 bytes remain readable/releasable.

The final recording contract also requires the combined128-model-track preflight, no archive overwrite on quota exhaustion, same-generation selection by actual native sample time rather than host save time, and explicit uncertainty across legacy/native clock domains. Target loss/failure must forbid extrapolation without discarding valid raw samples. Same-exact-object recapture may advance geometry from snapshot S1 to S2 while retaining S1 archive provenance. Same-process exact imports coalesce within eight in-flight imports/configuration; joined cancellation returns acceptance if the owner commits. Cross-process BUSY remains a fail-closed outcome with durable exact retry, not a promise that every concurrent caller completes immediately.

Selective-read coverage must compare filtered rows with offline full data, normalize IDs, reject incompatible selectors and changed map/query/presentation cursors, retain whole oversized rows, and distinguish compact track summaries from full samples. Graph comparisons must preserve every discrete time opportunity, floor/ceiling and activation guards, null timing and provenance; exact grouping is not interval filling or fuzzy stationary collapse. Record baseline/post time, memory and bytes before making performance claims; a changed-chunk count alone is not an incremental-cache benefit.

Typed discovery checks must cover the clean split: map_navigation links/routes versus map_motion tracks/hazards/summary, and map_recording lifecycle/summary polling versus map_recording_read live frame/event polling and offline archives. Exercise the new names through stock SDK pages and reject obsolete operation/section combinations rather than preserving aliases or weakening schemas. Final definition sizes and acceptance counts belong to the measured source evidence, not this checklist.

Current guidance is Docs-first: [Agent quick start](AGENT-INSTALL.md#agent-quick-start) routes to the canonical [Agent workflow](API.md#agent-workflow), with tool schemas and structured errors authoritative. No default skill installation or skill evaluation is required for Stable. Consider a future thin linked router only if demonstrated routing failures justify it; any comparison must use the current docs baseline and the same host/model and controlled scenarios, preserving warranted refusals, permissions, prompt-injection boundaries and uncertainty. Historical A/B results cannot substitute for that measurement or support unmeasured improvement claims.

The source-only selector fixture `node --test tools/package-version-smoke.test.mjs` exercises controlled manifest-only archives and read-only preflight without npm pack/install or a distributable runtime. It is distinct from the actual version roundtrip below. No validation commands run during a concurrent writing batch; Main validates after freeze.

For Node tests, run `npm test` from `potassium-mcp`. For deployment changes, cover exact two-script inventory, byte parity, transactional rollback, retained credentials, and unsafe-path refusal. Run the verified package's `potassium-mcp doctor --json` against the intended configured workspace for local diagnostics; that is not a substitute for a foreign-directory packed-package smoke. Run formatting separately after concurrent edits settle.

Read-tool tests must preserve bounded game-state observation and must not require a live gameplay session. Watch start/stop and reference-capable discovery/batch/release change only bookkeeping and carry non-read-only MCP annotations. Reference release remains read-policy controlled. Read/admin/execute are independent axes: admin diagnostics must work without global unsafe execution; raw Luau and job list/cancel appear only when the global gate and calling host/HTTP execute policy both grant them. They remain absent under unchanged advanced npm CLI defaults; genuinely fresh Windows Setup grants both gates for generic `agent`. Shared-token policy tests do not establish adversarial host isolation.

Windows installer coverage must distinguish fresh state from updates, repairs, and retained reinstalls: only fresh state receives read/admin/execute and the global unsafe gate, including both execution entrypoints; explicit existing permissions and restrictions must survive maintenance. An existing configuration without `agent` may receive a read-only entry, never elevation of admin, execute, or the global gate. Missing-config and journal-present recovery must defer helper grants until recovery resolves; initial full access must apply only to genuinely initial configuration after recovery. Coverage must retain authentication, loopback, annotations, limits, host-approval boundaries, and independent HTTP/allowlist/root configuration. Discovery proves availability, not native execution safety or completion.

Coverage must exercise four concurrent reads/controls per executor client, ordinary FIFO mutation barriers, a bounded four-control admission reserve under a saturated ordinary queue, heartbeat loss/reconnect, explicit `clientId` selection with multiple clients, and no automatic replay of indeterminate mutations. Timeout recovery deliberately remains a barrier for all executor requests. HTTP coverage distinguishes stateless POST-only `/mcp` from bounded `/mcp/session` lifecycle and verifies independent host/HTTP policies plus every `--no-*` revocation.

Async coverage verifies queued/running/terminal schemas, bounded/redacted cursor-based `print`/`warn` capture, 8 active/32 retained/262,144-byte/300-second bounds, and >64 KiB artifact descriptors. Cancellation must not execute queued code or release the raw lock before running code exits; tracked connections must disconnect on success, failure, cancellation, and late registration. Watch coverage exercises count/byte eviction, replayable pages, false/nil values, idle renewal, terminal retention, partial subscription rollback, reconnect, and generation cleanup. Fallback coverage must prove fixed `127.0.0.1:8225/mcp`, a distinct token, status/list/read-console bounds, and absence of execution. Install tests must prove repair preservation and token-rotation reattach reporting.

Broker identity regressions use real temporary junctions and actual OS process arguments, plus refusal cases for decoy paths, malformed quoting, wrapper/eval launches, and changed ownership during lifecycle transitions. Mixed-batch/reference regressions cover ordered partial errors, per-property authorization, dynamic value and escaped-byte limits, private host budget rejection before allocation, duplicate names, rename/reparent/detach, destruction/release, central target-path consumers, full registry/tombstones, yielding traversal isolation, and oversized-result rollback.

Reference transport regressions pause an issuing traversal across reconnect and inject a failed response send after allocation; they require new-only rollback, preservation of reused references, and non-recycled IDs. Batch regressions retain aggregate byte charges for discarded Folder summaries and permit repeated property names without treating overwritten map entries as cumulative output bytes. The Linux zombie lifecycle case is platform-guarded and requires `python3`; Windows runs skip it explicitly.

Lifecycle coverage includes five active bootstrap handlers, active-duplicate-ID transport close without a second response or replay, send failure after possible delivery, preservation of the original raw lock until actual return, immediate observer disconnect on teardown, and metadata-only capability diagnostics. Terminal watches have a one-second physical-pruning sweep; terminal jobs prune on operations/completion, not capability reads. Assert current resource counts separately from generation-history peaks/rejections and retained-watch drop totals.

Deployment parity tests must include preserved nondefault loopback ports and IPv6 endpoint rendering without changing npm-owned source bytes. OMP launcher checks use `max(40_000, requestTimeoutMs + 10_000)` for the outer timeout; assert preserved long executor deadlines retain the host margin, not a hardcoded default.

## Floor and ceiling mechanics qualification

This is historical source/native evidence for the earlier floor/ceiling extension, not final qualification of the continuous-recorder delta.

`release-out/parkour-map/FLOOR-CEILING-ACCEPTANCE.json` binds the final source, exact scopes and installed map. Full Node22/24 suites passed783of786 with three platform skips; the subsequent reported-activation guard passed57/57 navigation/service cases on both Nodes. Coverage includes mirrored signed-up support/clearance/steps/jumps/drops, moving support, explicit report scope and inheritance, unknown/null timing, old raw-map preservation, known corridor/access obstruction, large-coordinate translation invariance and activation bypass rejection.

A verified copy of the actual saved Stage1 map yielded10floor/10ceiling faces and four candidate geometric switches for two explicit user reports; the original bytes stayed unchanged. Installed mechanics apply/read and route paths were exercised offline. The retained final map is map-8bd362ff605f19606e28aca4baa9a869/revision9. The returned itinerary is mode-switch→ceiling jump candidate→mode-switch, timingunknown with null arrival/duration; it is not a measured trajectory or a proven required jump. The real map reaches its navigation work allowance and remains partial.

The Windows-rendered map was inspected with explicit floor/ceiling and prioritized user-report/unknown-time switch labels, within existing primitive/label/image caps. Read-only SDK discovery at16384-byte frames passed: mechanics4145,geometry6646,navigation6678,management7938,game-context7986bytes. No bootstrap/native changes or live user-run validation were part of this extension. The prior failed run-recording windows remain failed evidence; the user's report is stored separately in REVERSEPAD-USER-REPORT.json.

## Parkour reconstruction qualification

The following reconstruction acceptance reports predate the current continuous recording work. In particular, lifecycle-4 evidence does not qualify lifecycle-5 readiness.

`release-out/parkour-map/SOURCE-ACCEPTANCE.json` binds the reconstruction code and exact proof scopes. Full Node22.23.2/24.15.0 suites each report750tests/747passed/zero failures/three platform skips. The final drawing-label presentation change has separate20/20 renderer verification on both versions and repeated actual Windows image inspection. The bootstrap audit passes122 cases including100 lifecycle cycles; no native Roblox engine semantics are implied by isolated fixture objects.

The throwaway end-to-end scenario executes the actual bootstrap capture/observe/probe handlers in the existing modeled engine. Their DTOs pass through real verified context storage, immutable map build/observe/probe/update, source release, service recreation, two independent stock SDK readers, typed row paging and the Windows renderer. It produces4→6parts,2tracks,1qualified health correlation and a modeled jump. Both SDK modes read a37786-byte JPEG in a53369-byte response under the57344-byte test allowance; offline executor calls remain zero. All synthetic map revisions are released afterward.

Lune serde serializes an empty table as `{}`, unlike [documented HttpService JSONEncode behavior](https://create.roblox.com/docs/reference/engine/classes/HttpService), which emits `[]`. The smoke-only codec models that documented empty-table rule using real serde scalar encoding and transports complete JSON strings so the outer Lune report cannot erase array shape. Production validators are not relaxed or fed blanket object-to-array coercions. The different codec behavior was measured and is explicitly not native-engine qualification.

A separate real saved schema1 capture was verified and reconstructed without recapture:20parts,8candidate surfaces,18chunks,zero fabricated links/tracks/hazards. Its private map remains available to the user. After source-only deployment and verified broker restart, the installed management summary/list/image, geometry reader and navigation reader successfully read it without a live client; the actual image was visually inspected.

Regression coverage defends original-byte legacy release/eviction, same-instance retention across active holds, redaction expansion, numeric DTO bounds, current-character probe exclusion, read-lane concurrency, native error identity, unnamed probe rendering, preserved historical correlations, moving walking support, broad-face/step connectivity, passive drops, horizon bounds and competing routes in cyclic graphs. All public tool definitions fit unchanged16384-byte frames: game_context7986,map_context7938,map_geometry6603,map_navigation6415 bytes in the measured read-only catalog. Further schema/input changes must repeat SDK discovery rather than raise limits or drop constraints.

Scoped native read-path acceptance is recorded in `release-out/parkour-map/LIVE-ACCEPTANCE.json`: fresh lifecycle-4/gameContext2/mapObservation1, real schema2 capture including empty arrays, two static tracks and three naturally animated character parts with actual sample timestamps and observed position/rotation changes. A3x3 downward grid produced four explicitly candidate probe patches. The native overlap primitive returned existing body overlaps and none when excluding the local character. Expired bindings rejected without path rebinding; all native map snapshots/bytes/holds and diagnostic references/observer resources returned to zero. Two independent agents read the retained map after expiry and parent release. No health loss/death occurred: the positive map_observe damage-correlation branch and specific kill-zone behavior were not exercised, and no universal engine ordering or safe traversal is claimed. No gameplay input, remote invocation, reload, restart, build or installer action was performed during this live acceptance.

## Tool optimization and shared context qualification

This historical source delta added retained inventory queries, summary/section capability views, explicit structured-result presentation, auto pointer defaults, split handshake counters and shared persistent game context. Keep ordinary regression checks; no separate testworld workflow is required.

`release-out/tool-optimization/SOURCE-ACCEPTANCE.json` records the exact source and proof scopes. The full Node22/24 implementation base each passed654 of657 tests with three platform skips; later locking/remote-facet/schema changes have separately recorded final targeted SDK/store checks. The completed bootstrap run passes109 cases including100 lifecycle cycles. Schema size is checked through stock SDK discovery at unchanged16384-byte frames, including valid/invalid, scoped-reference and recursive-schema behavior.

The throwaway pipeline executes the actual Lua producer in the existing modeled engine harness, stores its geometry/UI/remotes, recreates services and lets two independent stock SDK clients read the same context without an executor. The Windows schematic is genuinely rendered and visually inspected; it is not a screenshot of a real game. Returned map ImageContent is54795 bytes within the57344-byte tested transport allowance. Text-oriented versus structured rows in that three-box example use2008 versus1015 bytes; these are example envelope bytes, not universal savings or exact model tokens.

Real live acceptance is now recorded separately in `release-out/tool-optimization/LIVE-ACCEPTANCE.json`: lifecycle-3/Inventory4/GameContext1, actual1600x855 Roblox window image and960x720 box map visually inspected; two independent agents read saved geometry/UI/remote identities without capture or executor operations. Two superseded contexts were released and subsequent read rejected. A combined20-part/10-UI/20-remote snapshot and image bytes survived a verified broker restart; the same client automatically reconnected. Roblox itself was not closed during this live test. Broader geometry consumed shared budgets before UI/remotes, so the combined sample used a smaller maxParts and remains explicitly partial/static. Single-window association is not cryptographically bound to the authenticated client. The discovered ambiguous limit description now states1..100rows/default20, also byte-bounded; four focused schema/discovery/store cases pass. No camera/player movement, remote invocation, desktop fallback, package or installer build was used.

## Workflow expansion source qualification

All package identities, counts and parser results in this section belong to the historical workflow-expansion source/artifact set, not the current source freeze.

The final Node `24.15.0` suite reported **562 tests: 559 passed, zero failed, zero cancelled, three skipped**. The skips were the Windows file-symlink privilege case, Linux zombie-process case, and unsupported-parser-platform negative case skipped on Windows. The obsolete CLI wording assertion was removed; the final suite is green. Lune passed **70/70** (69 core including 15 new expansion cases and the existing 31 remote cases, plus a 100-cycle lifecycle run), C# Setup **28/28**, and root release/GitHub/package/Windows tooling **22/22**; Windows tooling repeated **9/9** after the cached-feed fix. [WORKFLOW-EXPANSION-ACCEPTANCE.json](../release-out/WORKFLOW-EXPANSION-ACCEPTANCE.json) binds this historical proof and its artifact identities.

The stock-SDK measurement used the same generated 100-row fixture with no executor or LLM. The historical `2817ca07…` tarball was independently installed with `--omit=dev` on Node `24.15.0` and `22.23.2`; both reproduced the source comparison below against the prior 51-tool workflow baseline. The catalog/detail fixture itself does not invoke the parser; separate installed-package production index/query proof is described below:

| Surface | Before expansion | Expanded source and installed package |
|---|---:|---:|
| Full catalog tools | 51 | 56 |
| Full catalog JSON bytes | 81026 | 88676 |
| Authored tool-description bytes | 6321 | 4832 |
| Selected detail calls | 3 | 1 multi-read |
| Selected detail CallToolResult JSON bytes | 3206 | 2384 |
| Opt-in lazy initial tools / JSON bytes | Not remeasured for this delta | 3 / 6525 |

No advisory-description matches were found; neutral descriptions did not remove technical states/errors/uncertainty. **The full catalog increased despite shorter descriptions.** Multi-read direct values and lazy activation passed on both installed stock-SDK paths. The sampled stats response reported calls 4, detailReads 1, repeatedScanRequests 1, and no raw arguments/data; the current stats request is counted in-flight before its own completed bytes. Repetition means repeated normalized selection, not proven unnecessary scanning. These are actual JSON bytes/calls, not model tokens, universal savings, total full-fetch savings, or production workload guarantees.

### Parser and source-analysis proof boundaries

The earlier code-analysis/index cases used development-test `web-tree-sitter@0.25.10`/WASM and conservative facts/origins; they do not by themselves prove the production backend. Production uses a GUI-independent native C Tree-sitter `0.25.0`/Luau grammar `1.2.0` worker, bounded-framing C# controller, and validated native-tree adaptation plus bounded semantic JavaScript analysis in the trusted parent. Actual production MCP SDK index/query passed through that AppContainer worker with no executor, both from source and from the new tarball independently installed with `--omit=dev` on Node `24.15.0` and `22.23.2`. Functions, an InvokeServer callsite, raw source hash, cross-session denial, and release were verified. This qualifies those exercised installed-package paths, not every semantic edge or a full Node 22 suite.

Before npm packaging or Windows stage/build, build the native worker and self-contained controller in this order from the repository root:

```powershell
node tools/native-parser.mjs build
node tools/parser-host.mjs build
```

Native build provisions hash-pinned Zig `0.14.1` at build time only; controller build requires Windows x64 and exact .NET SDK `8.0.424`/runtime `8.0.30`. Native/parser/compiler and .NET license inventories are sealed. Production uses ordinary no-capability AppContainer and atomic Job single-process/256 MiB/5-second CPU/10-second wall limits, with no private desktop/station or existing UI ACL edits. It is not LPAC; Windows AppContainer-public resources remain accessible. The trusted parent semantic analyzer is not OS-confined. No runtime download or unconfined fallback exists.

The final backend has one fixed ordinary AppContainer plus atomically assigned single-process Job, no redundant CHILD_PROCESS_POLICY, experimental debug paths, private UI objects, or existing UI ACL edits. The integrated native run passed typed UTF-8 parsing, external fixture-file denial and staged-runtime write denial with Windows error 5, and child CreateProcess denial with Windows error 1816 (quota). The network case passed a positive control: the host reached the loopback listener, the confined worker did not connect, and its actual error was 10060 rather than a fabricated/remapped 10013. Memory, output, wall-clock limits, cancellation, and crash recovery also passed. The CPU probe used an actual **one-second Job CPU limit** to avoid a wall-deadline race; production remains **five-second CPU/ten-second wall**, and the final full-suite CPU_LIMIT case passed. Compiler download/hash/cache verification passed separately; explicit-compiler and cached-default builds reproduced the same GUI-free 211456-byte worker, SHA-256 `ebec7ff49e845cee5809b22c80ad90920176c6457e61f5e1f9f20266e5e61409`.

This is actual scoped native Windows evidence, not a universal filesystem/network/platform guarantee or approval for untrusted Luau execution. Standard AppContainer-public resources remain accessible; the trusted parent's bounded semantic analysis is outside the child's OS boundary. That historical green suite, installed-package index/query and sealed Windows/package checks remain separate from other GUI/soak proof. .NET restore used an isolated feed seeded from SHA512-pinned cache archives because the NuGet .NET feed was unreachable; no fresh NuGet advisory audit is claimed.

### Native verification limits

The separate native testworld workflow has been retired; there is no requirement to provide a separate test place or server. This does not establish native server semantics or change the production MCP tools.

Existing offline Node and Lune regression fixtures remain in use. Lune cases model lifecycle contracts, including queued cancellation sending nothing and post-dispatch cancellation preserving eventual result/error while holding the execution lock; they do not prove real RemoteFunction/metatable behavior. `nativeSemanticsVerified` remains false. Actual typed/nil/error/yielding server replies and replicated effects remain unverified.

Historical workflow-expansion npm/Setup/ZIP/manifest identities are recorded in [Deployment](DEPLOYMENT.md#building-the-local-windows-artifact) and [WORKFLOW-EXPANSION-ACCEPTANCE.json](../release-out/WORKFLOW-EXPANSION-ACCEPTANCE.json). [PACKAGE-SMOKE.json](../release-out/PACKAGE-SMOKE.json) binds the historical `2817ca07…` npm tarball to three real npm installs, offline pinned-npx selection, status/public serve, three A→B→A generations, token/settings/other-host preservation, and retained uninstall/reinstall. All three transports discovered 41 read-only tools; HTTP 401/400 and cancellation checks used a controlled fake executor for transport testing only. The `3268e3f4…` npm, `2e291d4e…` Setup and earlier records retain their own historical scope. No live game hooks/calls, user configuration/startup/bootstrap changes, version bump or publication were performed by that expansion.

## Remote workflow host measurements

**Historical pre-expansion workflow evidence:** Main accepted Node `24.15.0` **478 tests, 476 passed, zero failed/cancelled, two skips**; Lune **55/55** (**54 core**, including **16 workflow cases**, plus lifecycle100); C# **28/28** and packaging **9/9**. [REMOTE-WORKFLOW-ACCEPTANCE.json](../release-out/REMOTE-WORKFLOW-ACCEPTANCE.json) binds those results to the older `3268e3f4…` npm/`2e291d4e…` Setup artifacts, not the later expansion. [PACKAGE-SMOKE.json](../release-out/PACKAGE-SMOKE.json) instead binds historical `2817ca07…` and must not be read as the earlier smoke. Full Node 22 was not rerun for the earlier workflow either; installed SDK measurements are narrower.

That historical pinned-SDK `1.30.0` smoke compared the b26 npm baseline with the then-final `3268e3f4…` tarball, installed independently on Node `24.15.0`/`22.23.2`, using an identical generated 100-row trace file with no executor/LLM. Both reproduced the historical byte table below. It predates multi-detail/index/action/typed-call/stats/diagnostic expansion.

| Surface | Historical baseline | Historical workflow eager/default | Historical workflow lazy |
|---|---:|---:|---:|
| Initial tools/list tool count | 46 | 51 | 3 |
| Initial catalog JSON bytes | 57956 | 81026 | 5047 |
| Trace summary first response bytes | 81952 | 752 | Not separately measured |
| Trace query first response bytes | 81652 | 1534 (descriptor) | Not separately measured |
| Artifact read first response bytes | 98396 | 1162 (descriptor) | Not separately measured |
| Selected-row retrieval | Not measured | 1 page, 1300 bytes | Not separately measured |

**The eager catalog grew**, because the public surface and honest schemas grew; compact tool responses are not a catalog-size reduction. Lazy discovery reduces this fixture's initial catalog only for explicitly compatible clients; enabled schemas still have to be discovered. No exact model-token count, model-independent savings, total full-fetch savings, or production trace-distribution claim follows. Selected-row retrieval passed and another session was denied. Vendor lazy negotiation, activation, and a public typed SDK call passed; these were real SDK paths, not an LLM agent invocation.

Tool-result compaction is bounded by the 8 KiB/executor/proxy response ceiling. Catalog paging instead uses the actual proxy frame budget: default 1 MiB frames keep the measured eager 51-tool catalog in one page, while a smaller frame can require standard tools/list nextCursor pages. SDK 1.30.0 listTools and automatic list-change refresh only retrieve/cache one page. A client must consume pages on initial/changed discovery and fetch the intended target's page before a typed call to retain that SDK validator. No private metadata-cache method was used or is recommended. This is not proof that every host consumes pagination or supports lazy list-change refresh.

### Native capture evidence boundary

The selected Potassium `2.4.7` exposed the relevant native APIs. Local native newcclosure yield/error/identity probes and disposable newproxy __namecall method/yield/readonly-restoration probes passed without touching the game metatable or calling a real RemoteFunction. **Actual game interception remains unverified; nativeSemanticsVerified is false.** Isolated capture cases model selection, metadata bounds, forwarding, expiry, teardown, and foreign raw-slot replacement; they do not qualify every engine/executor behavior.

Capture only observes explicitly selected outbound FireServer/InvokeServer namecalls, not direct method calls or incoming traffic, and never records values/returns or fires/replays a remote. Ownership compare-and-swap covers raw __namecall slot replacement, not hookfunction-style in-place closure mutation with unchanged identity. Foreign slot replacement can leave an inert wrapper and block restart rather than overwrite it; no adversarial/universal foreign-hook guarantee or unconditional cleanup promise follows.

Workflow verification must preserve original-result validation and applicable redaction before compaction; complete-or-reference object schemas; accepted async identity; UTF-8 pointer paging; TTL/eviction/scope/origin denial; immutable inventory paging, partial/non-atomic coverage and compatible diff identities; reference opt-in/no destroyed-instance path fallback; capture count/byte/shape/argument-type bounds and explicit start; ordinary/stateless full-catalog fallback and retained-session lazy activation. No live bootstrap deployment, user configuration/wrapper changes, automatic host registration, remote invocation, or publication was part of the measurement.

## Windows installer native evidence

The **historical workflow-expansion** Setup SHA-256 is `b703fb169d959c95bb5b96fd1361506d15627805d9f4e5886ae3a18086b372f6`, manifest `c660c8d4abdf1e1978cc218a992df6f7c698f3b0274503555dccc6295955501f`; ZIP/npm identities are in [Deployment](DEPLOYMENT.md#building-the-local-windows-artifact). Its embedded/sealed payload and distribution checks passed, **with no GUI rerun on this binary** in that expansion. [WORKFLOW-EXPANSION-ACCEPTANCE.json](../release-out/WORKFLOW-EXPANSION-ACCEPTANCE.json) records that proof. Earlier `2e291d4e…` Setup/`12e20a0b…` manifest and REMOTE-WORKFLOW-ACCEPTANCE.json remain separately historical; none relabels older GUI or soak proof.

The historical pre-remote-workflow Windows 11 x64 installer was `release-out/windows-setup/Setup.exe`, packaged as `potassium-mcp-v0.10.0-beta.1-windows-setup.zip`. It is an actual C# WinForms application with durable bundled Node `22.23.2`/MCP/dependencies, not the earlier filtered source ZIP or an already published EXE. Version remained `0.10.0-beta.1`; it was unsigned and unpublished. `release-out/WINDOWS-INSTALLER-ACCEPTANCE.json` binds the following proof to those older artifacts, not this workflow delta.

| Artifact | Historical pre-remote-workflow identity |
|---|---|
| Setup SHA-256 | `a3a83c3a4aad4a68d919099699331fe4939babed2e3bbacb1e2d67167079c253` |
| Installer manifest version ID | `fb84db9033f603590f944bdc6d3a963b62808f00867877949e8898fcf70095eb` |
| Windows installer ZIP SHA-256 | `ea6fcffc45fe73e69103ceb0b7d34494072fadb275f7ce1bda6ae6ab0c56e37e` |
| Candidate npm tarball SHA-256 | `b26f8f4a75b4d6bfc0af9dde6e01c75d2385b4a302cc027da08e41de9b963310` |

From the repository root, the focused commands are:

```powershell
dotnet test app/PotassiumMcp.Setup.Tests/PotassiumMcp.Setup.Tests.csproj -c Release
node --test tools/windows-release.test.mjs
node tools/native-parser.mjs build
node tools/parser-host.mjs build
node tools/windows-release.mjs stage
node tools/windows-release.mjs build
node tools/windows-release.mjs check
```

The C# command restores by default. Builder `check` verifies the sealed artifact, not the current checkout; `Setup.exe --verify-bundle` is exact read-only integrity mode, not an install test. No command here publishes a release.

### Historical full-access acceptance

For that historical sealed full-access build, Main accepted **28/28 C# tests**, **9/9 packaging tests**, and the Node `24.15.0` suite: **444 tests, 442 passed, zero failed/cancelled, two skipped**. Core recovery and retained-policy regressions passed. Its actual native Windows scenarios covered:

- Fresh GUI **Install** initialized generic `agent` read/admin/execute and the global unsafe gate. The workspace picker was directly visible; no Advanced/permission controls were present.
- The acceptance environment used an OS-only `PATH` retaining required Windows PowerShell but no Node/npm, poisoned `NODE_OPTIONS`, and a missing `DOTNET_ROOT`. Test ports were isolated from the real installation by a port-only test-config edit followed by GUI **Repair**.
- Final cold **Check** reported MCP responding and executor unattached. After GUI close, the actual installed no-argument launcher used bundled Node `22.23.2` through the stock SDK and discovered **46 tools**, including synchronous/asynchronous execution and admin tools, with truthful destructive/read-only/open-world metadata.
- The prior sealed Setup `07d4371a…` was actually installed to create restricted configuration. That full-access build's GUI **Update** and **Repair** preserved its permissions and token; the stock SDK discovered **36 tools**, excluding execution/admin tools. Fresh and restricted broker-stop checks passed.
- Existing real configuration, wrapper, and deployed bootstrap were not mutated. No arbitrary Luau was executed and no live executor was attached or changed.

This qualifies only that historical build's fresh-full-access and preserved-restriction GUI/SDK paths, not the remote-workflow delta, clipboard transfer, an independent real harness, Windows 10, native Roblox engine gates A5/F6/I3, or game execution. Detailed retained uninstall/reinstall and the 30-minute staging soak below are still earlier baselines. No publication or version bump is authorized.

### Historical pre-full-access baseline

The pre-full-access Setup SHA-256 was `07d4371a6cedbb3850791d8b9504159e862fc85613ac87fe10339f4c4c798a47`, with manifest version ID `5f7091185926e2f90b968466538bb6e3a338ead4124e6f7c60bf93703ec9a11e`. The following results belong to that build, neither the historical full-access artifact nor the remote-workflow delta:

Main's **historical pre-full-access** native acceptance passed **27/27 C# tests** and **9/9 packaging tests**, plus these actual Windows scenarios:

- Fresh GUI installation with Node/npm absent from `PATH`, a missing `DOTNET_ROOT`, and poisoned `NODE_OPTIONS`; busy `WM_CLOSE` was refused. The stable installed launcher remained usable after Setup closed.
- Repair of a partial installation, token-retaining uninstall/reinstall, and cancelled removal with unchanged state. Private config/token/artifact data was preserved.
- Final cold **Check** reported **MCP connected**, **Executor not attached**, and no `CleanupPending`. This distinguishes the working MCP path from a live executor connection rather than treating an unattached executor as installation failure.
- After GUI close, the prior installed no-argument launcher connected through the stock SDK and discovered 36 tools with truthful annotations. This historical count is not the new full-access tool count. Node preload injection was rejected; stdin EOF exited naturally, and broker closure exited the launcher even with stdin still open.
- The native `CoreCleanupLease` blocked an actual JavaScript setup attempt, and an OS process crash released the lock. This proves that scoped cross-process cleanup exclusion, not protection from every concurrent trusted manual core reconfiguration.
- The existing real configuration, ownership, custom wrapper, and two deployed Lua files retained their hashes. Acceptance used isolated installation state; it did not migrate the user's wrapper or redeploy the live bootstrap.

In that historical run, the copy buttons were visible and enabled, and the generated connection file was actually consumed by the SDK. Clipboard contents were neither changed nor tested; do not describe this as verified clipboard transfer or automatic host registration. The current installer has no Desktop/CLI selector, extra Setup warning/consent/permission prompt, Safeproxy, or harness-approval bypass; artifact-bound native UI/SDK proof is scoped separately above.

This historical baseline covers the prior local installer and generic MCP stdio connection; it is not a rerun on the current build and does not qualify each independent harness, Windows 10, native Roblox engine gates A5/F6/I3, arbitrary execution, or publication. Old wrapper/core ownership conflicts still fail closed. The core/npm qualification history below remains separate; a matching version string does not make registry artifacts identical to this installer.

## Committed isolated bootstrap runner

Run these commands from the repository root, not from `potassium-mcp`:

```powershell
# Explicitly install the pinned, SHA-256-verified Lune 0.10.4 toolchain
node tools/bootstrap-runner.mjs toolchain

# Core plus the 100-cycle lifecycle workload, with real JSON codecs
node tools/bootstrap-runner.mjs full

# Separate lifecycle, 256-job FIFO, and measured queue modes
node tools/bootstrap-runner.mjs lifecycle
node tools/bootstrap-runner.mjs queue
node tools/bootstrap-runner.mjs benchmark
```

`LUNE_BIN` may explicitly select an existing Lune binary, but its version must be exactly `0.10.4`. The verified installer covers Windows/Linux x64. A missing/wrong toolchain fails nonzero; it is not a skipped-green run. Full mode executes the actual bootstrap and autoexec with isolated services/signals/transport and a deterministic scheduler through the committed adapter. It supplies real JSON codecs so escaped-byte and serialization limits are exercised. No temporary `fixture-runner.luau` is required.

Reports contain cases, failures, explicit skips, and resource/queue metrics. Benchmark mode uses warmup and five measured queue samples; a queue run is not a combined long-duration soak. Fake-peer heartbeats must continue through simulated TTL checks, and generation replacement must release the prior socket rather than bypass the reload guard.

### Evidence boundary

The historical expansion full fixture passed **69 core plus lifecycle100 (70/70)**, including 15 new core cases. The earlier remote-workflow run passed 54 core plus lifecycle100 (55/55). Historical 39/39 included the hello-send listener-leak red→green regression; 38/38 recorded 105902 disconnected connections/zero timers. Those older metrics are not a recount of the current source. Separate historical FIFO256 had peak queue 64. Native/engine limitation categories remain explicit skips, not engine checks.

Engine services/signals/scheduling are modeled. The fixture cannot prove real Roblox destruction/signal timing, physics/streaming/overlap behavior, executor reconnect scheduling, or forced termination of non-cooperative code. Live qualification must use an explicitly approved environment and exact versions. The current live acceptance used the previously deployed bootstrap; newly edited assets were not redeployed by these fixture runs.

## Packed package and soak gates

The following commands are procedures for a separately approved artifact qualification, not authorization to build/install during current source work. Choose a fresh isolated output directory rather than overwrite archival ownership-candidate evidence. From the repository root:

```powershell
# Build/seal the required Windows x64 production parser backend first
node tools/native-parser.mjs build
node tools/parser-host.mjs build

# Build a separate candidate without overwriting historical artifacts
node tools/release.mjs npm-pack --output release-out/approved-candidate

# Install the selected artifact into a foreign temporary directory/isolated home
node tools/package-smoke.mjs smoke --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/node24

# Separate minimum 30-minute STAGING soak, not a short live read-only observation
node --expose-gc tools/package-smoke.mjs soak --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/soak
```

`npm-pack --output <directory>` writes the tarball, checksum sidecar and `NPM-ARTIFACT.json` beneath that directory; omitting the option retains the historical `release-out` default. Smoke retains `[smoke|soak] [tarball]` and adds `--npm-artifact <metadata JSON>` plus `--output <directory>`. Reports are `PACKAGE-SMOKE.json` or `SOAK-EVIDENCE.json` within the selected output. Metadata remains the identity authority: its adjacent tarball/checksum and any explicitly supplied alternative tarball must match before npm runs. Unknown, missing, duplicate or meaningless options fail before work.

The smoke launches actually installed public bins, not repository runtime sources. It exercises npm/npx, setup, repair, SDK stdio/stateless/stateful HTTP, policy errors and retained uninstall/reinstall. Manual fixture metadata is explicit test preparation, not a public wrapper-adoption API. Repair A→B→A preserves the separate user-owned wrapper and regenerates usable public suggestions; uninstall intentionally clears ownership registrations, while preserving wrapper/config/token and avoiding silent re-adoption on reinstall. Installed production `code_index`/`code_query` checks include source hashes, functions/calls, conservative origins, cross-session denial and release invalidation, with no Luau execution.

For Node 22/24 qualification, run the same tarball with each selected Node, prepend that Node's directory to `PATH`, and set `npm_execpath` to an installed npm CLI if the selected Node directory contains no npm. Use distinct output directories. The report attests executable/version for public SDK and pinned-npx launches, ownership and broker runtime identity; the harness version alone is not child-runtime proof. These independent runs are not a cross-Node migration.

Package contents must not depend on repository siblings, junctions, local credentials or source-only installed scripts. A generated pinned `--npm` entry does not prove the registry's same-version artifact contains this candidate. Release retries must preserve the original workflow's immutable artifacts/evidence, validate source/ref/name/version/digests, and reject cross-run or expired evidence; never rebuild or overwrite uploaded mismatches to make retry pass.

The packed smoke's migration scenario uses free nondefault loopback ports and a real broker autostarted by SDK/public `serve` from independently installed candidate A. Closing that SDK client leaves the shared broker running. It installs candidate B independently, exercises repair A→B→A, and checks distinct authenticated ready generations plus runtime/launcher migration before owned lifecycle stop and uninstall/reinstall. Preservation covers token, config, custom roots, timeout, and unrelated OMP content. If cleanup identity becomes uncertain, retain the temporary runtime instead of sending generic PID signals.

A third install of published `0.10.0-beta.1` without the runtime marker is an incompatible-runtime rejection, not a supported downgrade. A→B→A checks package-location migration, not cross-Node migration. The historical `3268e3f4cb0873a3b888a52cc8617fce68e114955f7676a4708a181cdbc2ebeb` tarball passed the actual packed smoke: three installs, public serve autostart, three authenticated generations, host add/remove, preservation, and retained uninstall/reinstall. PACKAGE-SMOKE.json is bound to that older artifact, not the expanded source or a new package.

That historical stock-SDK packed smoke discovered 38 read-policy tools on stdio/stateless/stateful HTTP, rejected unauthenticated HTTP with 401 and unsupported protocol with 400, and exercised queued/in-flight cancellation. Its fake-executor handshake proves controlled transport/scheduling, not game execution or current expanded discovery. Stateless cross-request cancellation cannot stop another request's server; SDK abort does not prove termination.

A separate controlled version-transition scenario is available after explicit package/install qualification approval:

```powershell
node tools/package-version-smoke.mjs --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/version-roundtrip
```

Both selectors are required; there is no implicit historical metadata/output default or positional tarball. Before npm runs, the shared `package-smoke.loadSmokeArtifact` verifier checks the receipt's adjacent tarball, checksum sidecar, archive manifest identity, SHA-256 and integrity. Output must be an isolated repository-contained directory outside source paths; redirected output and overwriting selected metadata reject. `PACKAGE-VERSION-SMOKE.json` records the selected receipt/tarball paths, name/version/filename and hashes. Exported `parsePackageVersionSmokeArgs` and read-only `preparePackageVersionSmoke(options, projectRoot)` permit controlled fixture preflight without invoking the real roundtrip.

This separate historical scenario copied/extracted its verified tarball twice, changed only temporary `package.json.version` to `0.10.0-qualification.1` and `.2`, and performed real npm pack/install. Main accepted it on the earlier sealed candidate `4408140f…`: stock SDK and a live broker observed actual versions across 1→2→rollback 1 and three distinct generations; 22 nonmanifest runtime files stayed byte-identical, and token/config/host state was preserved. Historical evidence is `PACKAGE-VERSION-SMOKE.json`. It was not rerun on the current workflow artifact and does not modify the source-worktree version, publish anything, prove historical public-beta downgrade, or qualify different implementation versions. It is separate from—not repeated inside—the historical 30-minute soak.

The pinned-npm scenario runs the actual config-print --npm entry through npx.cmd/SDK from a temporary spaces/Unicode prefix, offline against an independently installed candidate, with selected-bin attestation and no token/argument capture. The historical `3268e3f4…` run passed selected-bin verification and 38-tool read-policy discovery/status as bound in PACKAGE-SMOKE.json. It prevents cached substitution in that scenario, not registry publication, online distribution, or acceptance of this expansion.

The soak uses the staging broker/SDK for 30 minutes, three requests per transport every 100 ms, plus a fresh lifecycle100 Lune subprocess every 60 seconds. Bootstrap subprocess execution is asynchronous: the same broker/SDK event loop must keep serving probes while at most one lifecycle child runs. Record `concurrentProbeBatches` and `lifecycleActive` snapshots, and await pending child cleanup on exit/failure. A prior synchronous driver that blocked service during fixture execution is not continuous-service evidence and cannot qualify this soak.

The soak uses fresh Lune processes, each executing 100 lifecycle cycles; it is not a 30-minute live Roblox session or one continuously retained native Lua heap. Predeclared limits are 32 MiB retained-heap growth, active resources no more than baseline plus 8, and p95 duration of a three-operation mode probe at most 2,000 ms—not an individual-RPC latency promise. Record actual duration, counts, failures, drops, probe latency, and resource plateau; do not shorten a required soak and still mark it complete.

Keep the soak on the stock SDK client. A raw transport/control baseline can help diagnose retention, but replacing the SDK path with that control would change the qualified workload and cannot count as fixing production retention. Re-run after any production schema/ID fix and record the sealed candidate identity.

Schema-retention regression coverage must use content-addressed output-schema `$id` values based on the full canonical wire schema. Reconnect to a same-named tool with changed constraints and require fresh validation; a tool-name/version-only identity must fail that case. Preserve stock SDK/AJV validation, workload, and the predeclared 32 MiB bound.

The pre-fix retention investigation reported 11,838,800 bytes of retained growth for the stock SDK workload over 30×9 operations versus 1,145,048 bytes for an earlier raw control. ToolContracts relayed Main's sealed post-fix diagnostic: stock SDK growth of 1,128,344 bytes, with a contemporaneous raw control of 1,135,432 bytes, and focused semantic coverage `62/62` passed. Default SDK/AJV validation, workload, and the 32 MiB bound stayed unchanged. This diagnostic was short-run evidence; the subsequent `b667` stock-SDK soak passed separately as recorded below. Neither result qualifies later review revisions automatically.

## Qualification ledger and release acceptance

The [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status) is the support freeze, not an assertion that every target has passed. Record OS, exact Node/host/Potassium versions, package integrity, launch command, protocol revision, transport, bootstrap generation/build, cases, and explicit skips for each accepted run.

**Historical ownership freeze:** the immutable `0c153057…` npm / `321c589e…` Setup / `e69e9259…` ZIP candidate has artifact-bound package, native Windows GUI and clipboard evidence. Its qualification additions are under `release-out/ownership-candidate/stable-qualification/`; its corrected full soak is `soak-final/SOAK-EVIDENCE.json`. These results do not qualify the current source or a future candidate. Historical 4408/b26/a3a/3268/2817 reports retain their original scope. The table below is an archival ledger, not a current pass matrix.

| Area | Scoped evidence / remaining gate |
|---|---|
| Local native probes | Potassium `2.4.7` on Windows 11: detached hierarchy/signals/Connected cleanup and exact traversal helpers with mocked request/path glue;12 cases at1000/10000/50000 children,244402 owned instances destroyed, zero remaining own listeners/instances. Owned loopback WebSocket close/error/reconnect and canned crypto passed. No active-bootstrap recovery or real Roblox server semantics proof. SignalBehavior property unavailable. |
| Historical candidate bootstrap fixture | Modeled full70/70 and FIFO256/256 passed with Lune0.10.4 for that artifact set. Engine, namecall ABI and server boundaries remain explicit rather than counted as fixture passes. |
| Node/platform matrix | Exact Node22.23.2 and24.15.0 source runs: each567 tests,564 passed,0 failed,3 platform skips. Corrected release tooling33/33 and isolated managed Setup28/28 passed. Windows10/Linux and other Node versions remain unqualified. |
| Windows installer/parser/clipboard | Exact candidate EXE clean installation, update, repair, cancelled/confirmed removal, retained reinstall, cold Check and installed native-parser SDK passed. Three actual clipboard buttons passed transfer/readback; six original formats, including documented privacy flags, were restored. Original contents were not persisted. Clipboard history and concurrent writers cannot be fully controlled. Unsigned/unpublished. |
| Real hosts | Actual manual OMP wrapper has live SDK/read-only proof; stock SDK and installed Windows launcher have candidate-specific acceptance. Historical OMP18.1.13 public `mcptest` is initialize/tools-list-only and not new-host certification. Other adapters are registration/fixture-only until an exact independent host run is recorded. |
| Historical CLI/migration | The archived ownership candidate passed actual npm/npx, A→B→A, manual-host preservation and retained uninstall/reinstall on Node22/24. Actual user's schema3/manual migration has separate preservation proof. None of this proves historical public-beta downgrade or cross-Node migration. |
| Protocol/transports | Actual stdio/stateless/stateful SDK,401/400 and controlled cancellation checks passed. The verifier now demands fresh correctly versioned requests separately for each HTTP mode/probe; one transport or prior probe cannot lend header evidence to another. No game execution or2026-07-28 protocol claim. |
| Soak/release | Historical revised core baseline `4408140f…` asynchronous stock-SDK soak passed 1,800,076.9637 ms, 99,918 RPC operations, 11,102 batches, 3,695 probe batches concurrent with Lune, and 30 lifecycle cases. p95 was 46.7152 ms per three-operation mode probe, not per RPC. Observed post-GC heap samples ranged 63,078,600–66,275,128 bytes; maximum active resources was 24. Unchanged 32 MiB-growth/+8-resource/2-second-p95 gates passed. It was not rerun for the historical full-access or current workflow delta; historical b667 soak is not substituted for it. This evidence does not prove real game capture or authorize RC/Stable publication. |
| Historical ownership-candidate soak | Corrected verifier, exact0c153057 tarball:1800114.8888ms,92790 RPC operations,10310 batches,3404 batches concurrent with Lune and30 lifecycle cases. p95≈62.915ms per three-operation mode probe. Observed heap66460608–70888440 bytes, maximum resources21; unchanged32MiB/+8/2000ms gates passed. Not a real Roblox server soak or current-source qualification. |

Stateless HTTP creates a server per request; a later `notifications/cancelled` cannot address the earlier server. Tests must report this unsupported remote-cancellation boundary, not infer that a local SDK abort stopped work. Exercise stdio/stateful cancellation separately. Across transports, queued cancellation, sent/accepted uncertainty, running cooperative cancellation, recovery, and shutdown must never falsely promise nonexecution or forced Luau termination.

Custom IDs need explicit policy: for a read-only launcher use `setup --read-host <id>` before `config print`/`host add`; unknown IDs reject and omitted axes in a partial policy are false. Policy tests must prove registration/printing does not create grants and admin permission remains independent of global execution.

Claude adapter coverage must preserve the conservative mixed-scope ownership conflict: CLI precedence cannot prove a shadowed user/local/project entry. Check returned scope where available, reject ambiguous/missing proof, and exercise distinct local-project IDs with persisted canonical CWDs without inspecting guessed host storage. These fixtures do not replace a real-Claude launch/version gate.

Freeze error behavior as documented in [API](API.md): exercise the real pinned SDK client and assert `isError` failures omit `structuredContent` while carrying the identical typed envelope in `_meta` and JSON text. Preserve accepted async job IDs in successful structured warning results; never loosen success schemas merely to pass errors through. Assert consumer-visible codes and outcomes, not wording or mock echoes. Keep selected-client generation/capability and policy failures distinguishable.

No Stable release with open critical/high findings, reproduced data loss, secret leak, privilege expansion, unsafe automatic replay, or unbounded lifecycle leak. Smaller exceptions need explicit accepted impact. Test output is evidence only for the path actually exercised; no test or documentation edit authorizes publishing or overwriting an existing npm version.

### Remaining Stable-v1 decision

Local proof is not full server qualification. The current-place capture installed and restored its hook but observed zero selected outbound calls; it explicitly excluded argument values/returns. Unknown purchase/admin/reward/getter remotes were not invoked merely because of their names. Actual typed/nil/error/yielding Roblox server replies, active-bootstrap reference/watch/socket failure integration and other engine signal modes remain unverified. Detached instances, Bindables and owned loopback WebSockets do not establish those semantics.

The source manifest targets `1.0.0`; its version and unsigned distribution are explicitly approved. Preserve historical artifact identities without treating them as current candidates. Exact final package/build checks, documented migration/limits, immutable release-set verification and separate publication approval remain required; no existing npm version may be overwritten. Source implementation and historical migration proof are not an already published v1.

No authorized Authenticode signer/pipeline is configured for this task. Unsigned distribution is explicitly identified; checksums establish consistency, not publisher identity. If signing is required, obtain an authorized certificate/service, sign and verify, then rebuild checksum/ZIP/evidence identities. No private keys or certificate secrets were searched.

Additional narrow integration evidence reported by Main: reader `36/36`, artifact-writer `14/14`, and release-integrity/resume `19/19` passed. Reader evidence includes prior packed failures (`11/14` with three failures preserved) and a prior fallback failure, with corresponding current cases passing; artifact parent-swap was also red→green. Native uninjected `getAllowedHttps` returned ID `1` from `https://users.roblox.com/v1/users/1` in 601 bytes with default TLS hostname verification. These are scoped proofs, not exhaustive security certification. Filesystem snapshots remain best-effort against last-instant pathname ABA; the covered exclusive-create swap may leave an empty temporary file outside the intended root without result bytes and deliberately avoids unsafe cleanup. Node `22.23.2` was checksum-verified and its final suite passed as recorded above. Actual bootstrap deployment remains unchanged.

Migration acceptance must reject same-version runtime archives missing `potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 }`, preserve effective schema-2 dormant admin denial unless explicitly granted, and exercise verified dead-owner journal recovery without dry-run writes or age-only lock deletion. Target-lookup errors must remain `TARGET_UNAVAILABLE` with bounded discovery guidance, not permission denial; test full duplicated/escaped error-envelope budgets without corrupting redacted JSON.

The focused MCP/policy/audit run passed `85/85`, including three review regressions demonstrated red→green: trailing-backslash token/root redaction corrupted JSON; a quote-heavy uncertainty-bearing error exceeded 1,024 bytes; and a missing instance was mislabeled policy denial. The contract preserves identical `_meta`/JSON-text payloads and `TARGET_UNAVAILABLE`. Final Node 22/24 suites subsequently passed; final candidate soak/package/host qualification still follows its own evidence boundaries rather than this focused count.

Path-resolution regression coverage uses one public order: `--config` > explicit `--install-root` > `POTASSIUM_MCP_CONFIG` > `POTASSIUM_MCP_INSTALL_ROOT` > defaults. In particular, an ambient config variable must not redirect a broker lifecycle operation away from its explicitly selected installation root.

Final request-ID coverage preserves exact typed external response IDs and HTTP related-request routing for numeric zero, empty-string, and other IDs while using SDK-native cancellation signals. Unknown cancels, retired aliases, reused external IDs, late replies, duplicates, and bounded admission must not cross-associate work. Cancellation is an MCP notification, not a response; HTTP `202` only acknowledges transport receipt. Retiring an SDK response expectation after cancellation does not mean actual handler/audit work has ended: broker drain waits through final tool cleanup.

Configuration coverage distinguishes absent adjacent ownership (manual) from existing invalid/mismatched ownership (conflict), verifies raw hashes/private paths before normalization, and preserves verified legacy schema-2 host/HTTP effective admin denial until explicit migration. Schema-3/manual independent axes remain unchanged. Historical Node 24 counts progressed through 423/425 and `b667`'s 424/426; final revised `4408140f…` suites on both Node 22 and 24 each passed 440/442 with zero failures/cancellations and two skips. Final OMP remains init/list-only evidence. Final `4408140f…` soak passed on the stock SDK with 30 fresh Lune processes, each running 100 lifecycle cycles; it does not prove a native Lua heap remained stable for 30 minutes.

Main's historical rendered-endpoint smoke passed 3/3 canonical/custom IPv4/custom IPv6 with passive reads and zero listeners/timers while canonical assets stayed unchanged. That is modeled connector proof, not native IPv6 or live deployment. Source/package/host/soak staging is not production deployment. Editing this README or other source documentation does not alter any archived package bytes.

Final installer review cases distinguish precommit stop/recovery from postcommit startup uncertainty. Accepted config edits drain the recorded old endpoint only under the exact held repair lease with unchanged owned token; public load/stop remain strict. Unavailable original in-memory config preserves user edits/resume evidence without asserting an old restart. Committed restart rejection retains current config/credentials/backups/journal and never invites automatic token rotation; postcommit unlink failures report `cleanupPending` without rollback. Main accepted the final focused/full regressions, and `PACKAGE-VERSION-SMOKE.json` records `rawConfigRepair` checks all true against the actual live packaged runtime.

Stateful HTTP qualification includes the combined per-session 256 active-plus-retained cancellation-correlation cap, including pressure from batch sizes that do not divide the cap. SDK-native SSE close does not immediately reclaim retained correlations. Undispatched requests receive capacity/reinitialization guidance; only the pressured session is retired after its own response members, handlers, and dispatches become idle. Other sessions continue, and GET/SSE lifetime is never proof that arbitrary Luau stopped.

## Qualified measurement baselines

The six retained baseline files under `release-out` are `mcp-qualified-node-a.json`, `mcp-qualified-node-b.json`, `mcp-qualified-bootstrap-a.json`, `mcp-qualified-bootstrap-b.json`, `mcp-qualified-broker-a.json`, and `mcp-qualified-broker-b.json`. Main accepted stable-provenance pairs covering 20 Node, 34 bootstrap, and two broker cases. These are reproducible baselines, not automatic optimization claims or native-platform/engine qualification.

The measured broker persistence workload completed 256 requests with 512 write completions, 512 rename completions, 512 directory-operation completions, zero failures, and final idle state. No write coalescing was introduced. The artifact describes OS-completion timing rather than fsync durability; preserve lifecycle correctness rather than treating the count alone as authorization to drop state transitions.

## Native evidence limits and release decision

Despite the final Windows Node 22/24, packed/runtime, limited OMP, and stock-SDK soak proofs, Main has not approved an RC/Stable decision or publication. Historical A5/F6/I3 testworld gates are retired, not passed. Detached hierarchy/signals/traversal and loopback socket/crypto evidence is scoped as recorded above; it does not prove active-bootstrap failure integration, every engine signal mode, or real Roblox server behavior. A small `maxVisited` does not make `GetChildren()` materialization constant-cost. Passing Node tests, isolated Lune cycles, and the completed stock-SDK soak do not establish unexercised native semantics.

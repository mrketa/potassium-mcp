# Testing

## Current source qualification boundary

The selected release is **1.1.0**, targeting Windows 11 x64, Node 22/24, and Potassium 2.4.7 through public stdio and authenticated stateless/retained HTTP. Use exact Node `22.23.2` and `24.15.0` for the release matrix. Windows 10, Linux host core, Linux/macOS executor integration, other Node lines/host applications, and MCP `2026-07-28` remain outside this qualification. The [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status) separates targets from evidence.

Release preparation is authorized independently of publication. This document specifies checks; it does not assert that the 1.1.0 candidate has passed them or is published. Source tests, modeled bootstrap cases, owned native fixtures, installed npm smoke, real Windows acceptance, and soak are separate proof layers. Historical counts and hashes must not be reused as new-artifact results. Original 1.0.0 records remain in the [public technical archive](https://github.com/mrketa/potassium-mcp/tree/5677385f169c24c87f8879e72bb8f5beee86f0d6/release-evidence/v1.0.0); private working evidence and game observations are not required public runtime documentation.

## Source and protocol checks

Run validation after concurrent edits settle. From the repository root, prepare the Windows parser assets before dependent checks:

```powershell
npm ci --prefix potassium-mcp --ignore-scripts --no-audit --no-fund
node tools/native-parser.mjs build
node tools/parser-host.mjs build
node tools/native-parser.mjs check
node tools/parser-host.mjs check
node tools/release.mjs check
```

Run the source and tooling matrix under each selected Node, using that Node's actual npm installation:

```powershell
npm --prefix potassium-mcp test
node --test tools/release.test.mjs tools/github-release.test.mjs tools/package-smoke.test.mjs
node tools/bootstrap-runner.mjs full
node tools/bootstrap-runner.mjs queue
```

Windows-specific coverage also includes:

```powershell
node --test --test-concurrency=1 potassium-mcp/test/parser-sandbox.test.js
node --test tools/windows-release.test.mjs
dotnet test app/PotassiumMcp.Setup.Tests/PotassiumMcp.Setup.Tests.csproj --configuration Release --verbosity normal
```

Keep SDK `1.30.0`, legacy initialize/initialized negotiation, negotiated HTTP version/session headers, and executor Protocol 2 distinct. Exercise actual stock-SDK stdio, stateless POST-only `/mcp`, and retained `/mcp/session`; one mode cannot lend header or cancellation evidence to another. Stateless cross-request cancellation cannot address an earlier request's server. Local SDK abort and HTTP 202 do not prove nonexecution or stopped work.

Regression checks must defend observable contracts: typed external request IDs (including zero and empty strings), cancellation correlation under reuse/pressure, accepted async IDs on warning paths, identical typed errors in JSON text and `_meta`, and no `structuredContent` on `isError` replies. Preserve success-schema validation, bounded escaped UTF-8 results, scope/origin permission checks, and target-unavailable errors distinct from policy denial. Catalog tests must follow standard pagination at the unchanged frame budget; SDK listTools caches only the fetched page.

Read/admin/execute are independent. Admin diagnostics do not require the global execution gate; raw execution, interaction mutations, and job controls require the relevant execute/global gates. Fresh Windows Setup alone supplies full generic-agent defaults. Retained installations, missing-agent repair, and ordinary CLI configuration must not silently expand privileges. Registration/config printing does not grant policy. Shared-token policies are not adversarial isolation between token holders.

Lifecycle checks preserve four concurrent reads per client, FIFO mutation barriers, bounded control admission, explicit client selection, timeout recovery barriers, and no automatic replay. Queued cancellation sends nothing; running work holds its lock until actual completion. Duplicate bootstrap request IDs, possible response-send loss, teardown, expired retention, and generation changes must not fabricate completion or leak task-owned resources. Broker ownership checks use actual process identity and canonical paths, not lock age or a guessed PID.

## Native editor and interaction checks

The editor suite must cover all six tools with default-off configuration and separate native credential handling: list metadata, exact text/hash read, draft open, hash-checked whole-text write, activate, and clean-only close. Exercise 256 KiB UTF-8 boundaries, protected configured-credential echoes, permission-bound retained results, cancellation, stale hashes, dirty-close refusal, per-tab serialization across broker transports, and indeterminate mutation outcomes. No raw source or credential values may enter logs. A fixture cannot make native preconditions atomic; external/native UI races remain explicit.

Configuration/install coverage must preserve existing host/HTTP rights, raw sync/async execution, diagnostic fallback, and the credential file when editor integration is disabled. Enabling editor access alone grants no rights and requires no Roblox connection. Doctor validates local token presence/hygiene, not native endpoint readiness. Native desktop acceptance uses disposable owned tabs and records its exact application/build and scope separately from mocked transport tests.

Interaction inventory coverage must exercise summary/rows/detail/release, bounded traversal and snapshot quotas, immutable retained queries, changed-query cursor rejection, original coverage/expiry, property errors, references, and generation cleanup. TouchTransmitter discovery is non-exhaustive; transmitter identity and explicit host BasePart identity must remain distinct.

Interaction jobs must preserve one strict click/prompt/boolean-touch branch, documented boolean passthrough, exact enqueue-time identities, no same-path replacement, pre-dispatch helper availability, queued cancellation without dispatch, and eventual post-dispatch success/error. A successful job reports `serverAcknowledged: false`; it does not prove phases, exactly one event, property side effects, target eligibility, or gameplay success. Owned native fixtures are not universal server/native semantics qualification. Do not use gameplay targets to fill an evidence gap or replay an uncertain call.

## Recorder, immutable evidence and selective-read checks

The 1.1.0 bootstrap marker is `lifecycle-6`; recording still advertises `mapRecording` v1. Readiness requires a first real frame and an owned running sampler at the native receipt time, not a model timer or submitted request. Exercise at least 30 seconds of continuous sampling, actual timestamp gaps without fabricated catch-up samples, deadline, selected-target loss, disconnect/generation change, rollback, and cleanup. Polling neither samples nor renews retention.

Store/archive coverage rejects active saves, missing/duplicate pages, changed terminal identity, wrong client/parent, and altered finalized evidence. Preserve every raw frame/event across two independent SDK readers, broker restart, offline accepted retry, parent release, and saved-map release. Enforce the combined 128-track quota before sampling, without archive overwrite; preserve legacy schema1/2 bytes. Order same-generation windows by native sample time and keep mixed clocks uncertain. Failure/target loss forbids extrapolation without discarding valid evidence.

Compare selected rows/track summaries against full offline data; reject incompatible sections and changed query/presentation cursors. Retain whole oversized rows. Exact graph grouping preserves every discrete timing opportunity, floor/ceiling/activation guard, unknown/null timing, and provenance. Keep map_navigation separate from map_motion, and map_recording separate from map_recording_read. Measure bytes, time, and memory before claiming an optimization; fixture JSON bytes are not exact tokens or universal savings.

## Workflow expansion source qualification

### Parser and source-analysis proof boundaries

The production Windows x64 parser uses a native C Tree-sitter `0.25.0`/Luau grammar `1.2.0` worker and self-contained C# controller. Build the native worker before ParserHost. Native build provisions hash-pinned Zig `0.14.1`; ParserHost requires exact .NET SDK `8.0.424` and runtime `8.0.30`. Web-tree-sitter/WASM are development-test inputs, never a deployed fallback.

The child runs in an ordinary no-capability AppContainer and atomically assigned single-process Job with memory/CPU/wall limits. It is not LPAC or an absolute filesystem whitelist: AppContainer-public resources remain accessible. The trusted parent's validated tree adaptation and bounded semantic analysis are outside the child's OS confinement. No private desktop/station or existing UI ACL changes belong to this parser boundary.

Historical scoped native tests covered UTF-8 parsing, external-file/runtime-write denial, child-process quota, a host-reachable loopback positive control with no confined connection, CPU/memory/output/wall limits, cancellation, and crash recovery. Those facts do not qualify a changed binary automatically. Repeat the applicable OS checks and installed stock-SDK index/query on the selected artifact; record source hashes, semantic uncertainty, cross-session denial, release, and offline operation without executing Luau.

## Windows installer native evidence

Sealed bundle verification and `Setup.exe --verify-bundle` prove integrity only, not GUI installation, clipboard transfer, or lifecycle. Qualify the exact newly selected Setup on real Windows with isolated fixture application/state/workspace roots, leaving the user's installation and clipboard outside the fixture untouched.

Required acceptance covers fresh Install, restricted upgrade, Repair, cancelled removal, confirmed removal, retained reinstall, cold Check, actual installed no-argument launcher, and installed native parser through stock SDK. Only genuinely fresh state gets generic-agent read/admin/execute/global defaults; token, explicit restrictions, wrappers, saved contexts/maps, and ACLs survive maintenance. Recovery must resolve before initial grants. Check must distinguish a healthy MCP connection from an unattached executor.

Exercise the actual Copy configuration/command/path handlers and record the truthful clipboard scope; visible buttons or a generated connection file are not clipboard transfer evidence. Record any private-station or isolated-desktop restriction rather than claiming ordinary interactive desktop coverage. Installed runtime verification must bind the child Node and package to the sealed bundle, including operation without system Node/npm/.NET and rejection of environment preload injection. Do not weaken OS ownership, ACL, cancellation, or rollback checks to make qualification pass.

## Committed isolated bootstrap runner

From the repository root:

```powershell
node tools/bootstrap-runner.mjs toolchain
node tools/bootstrap-runner.mjs full
node tools/bootstrap-runner.mjs lifecycle
node tools/bootstrap-runner.mjs queue
node tools/bootstrap-runner.mjs benchmark
```

The runner pins Lune `0.10.4`; `LUNE_BIN` may select that exact version. Missing/wrong toolchains fail, not skipped-green. Full mode executes the actual bootstrap/autoexec with modeled services, signals, transport, deterministic scheduling, and real JSON codecs. The fixture explicitly models documented HttpService empty-table encoding where necessary; production validation must not be weakened to accommodate fixture codec differences.

Report cases, failures, skips, resource counters, and queue metrics. Fake-peer heartbeats continue through simulated TTL checks; replacement generations release owned sockets. Current retained counts are not historical peaks. Fixtures cannot prove real physics, streaming, engine signal timing, server replies, executor reconnect scheduling, or forced termination of arbitrary code. A separate testworld workflow is not required; retired testworld gates are not passed native evidence.

## Packed package and soak gates

Build once into a fresh isolated directory; never overwrite historical evidence. Follow [Deployment](DEPLOYMENT.md#building-the-local-windows-artifact) for prerequisites and exact npm-to-Windows binding:

```powershell
node tools/release.mjs npm-pack --output release-out/approved-candidate
node tools/windows-release.mjs build --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/windows-setup
node tools/windows-release.mjs check --output release-out/approved-candidate/windows-setup
node tools/package-smoke.mjs smoke --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/node22
node tools/package-smoke.mjs smoke --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/node24
node tools/package-version-smoke.mjs --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/version-roundtrip
node --expose-gc tools/package-smoke.mjs soak --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/soak
```

Select Node22 and Node24 separately for their respective smoke invocations; output names do not select the runtime. Prepend the chosen executable's directory to PATH and set `npm_execpath` to its installed npm CLI where needed. The receipt's adjacent tarball/checksum, manifest identity, SHA-256, and integrity must match before installation. Public-bin and child-runtime attestation matter, not only the harness version.

Smoke uses independently installed public bins in isolated state: npm/npx, setup/repair, three stock-SDK transports, auth/protocol/policy errors, native source analysis, A→B→A package-location migration, and retained uninstall/reinstall. This is not a cross-Node migration or support for downgrading to historical archives lacking `potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 }`. The controlled version smoke changes only temporary package versions; it does not publish, change release source, or establish historical downgrade support.

Preserve token/config, private roots, manual wrappers, unrelated host entries, maps, and archives. Dry-run must not lock, stage, rotate credentials, register hosts, change ACLs, or restart processes. Test explicit-config/install-root/environment precedence, dead-owner journal recovery, precommit failure, postcommit startup uncertainty, and cleanupPending without false rollback. A cleanup failure retains uncertain roots and the original failure; success evidence follows owned transport closure and completed cleanup.

The stock-SDK staging soak must run at least **1,800,000 ms**, with at least **3,000 requests** and **30 bootstrap lifecycle cases**. Preserve the limits: **32 MiB retained-heap growth**, active resources no more than **baseline + 8**, and three-operation mode-probe **p95 at most 2,000 ms**. Run asynchronous fresh lifecycle100 Lune children while the broker/SDK keeps serving probes; a blocking driver or shortened run does not qualify. Record duration, counts, failures, concurrency, latency, and resources.

This is a persistent broker/stock-SDK soak with fresh modeled bootstrap subprocesses, not one continuously retained native Luau heap or a 30-minute Roblox gameplay session. Do not replace stock SDK/AJV validation with raw control traffic to satisfy retention limits. Content-addressed schema identities must distinguish same-named tools with changed wire constraints. Performance claims apply only to measured paths and workload.

## Qualification ledger and release acceptance

Bind every acceptance record to exact source commit, package integrity, Setup/ZIP hashes, runtime version, OS, launch path, transport/protocol, and relevant native application/bootstrap build. Keep failures and explicit limitations; do not promote an old test count into a new release result. Source, package, Windows, preservation, rollback, recovery, maps, and soak all require truthful evidence before a passed receipt is written.

`QUALIFICATION.json` summarizes retained proof; `RELEASE-EVIDENCE.json` inventories the frozen public source. The protected publisher verifies their schema, bindings, hashes, required booleans/thresholds, and actual unsigned/embedded Windows artifact checks. It does not run source suites, real GUI/clipboard scenarios, or the soak, and digest syntax alone does not prove the referenced evidence exists. Retain detailed private evidence outside the public set and publish only sanitized bounded qualification data.

The complete immutable release set has 13 files including `RELEASE-SET.json`. Record its hash independently and select the exact draft ID and source SHA for verify-only and publish dispatches. Both use the protected `stable-publish` environment. No source/archive rebuild or uploaded-byte replacement is a publication retry. See [Publishing a release](DEPLOYMENT.md#publishing-a-release).

No release with open critical/high findings, reproduced data loss, secret disclosure, privilege expansion, unsafe replay, or unbounded resource leaks is accepted. Lower-severity exceptions need explicit scope and acceptance. Unsigned distribution is an explicit policy, not a verified publisher identity; checksums establish consistency, not Authenticode identity. Local proof and release approval never authorize deployment into an existing user installation or unrequested native/gameplay actions.

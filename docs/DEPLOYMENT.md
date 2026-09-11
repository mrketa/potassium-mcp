# Deployment

## Source work and distribution scope

The first-Stable qualification target is Windows 11 x64, Node 22/24, Potassium 2.4.7, public stdio and authenticated stateless/retained HTTP. Windows 10 remains a declared but unqualified target; Linux host core, Linux/macOS executor use, other Node lines, other host applications and MCP 2026-07-28 are not qualified by this work. See the [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status).

Current work is source implementation only. Candidate npm packaging, Windows installer builds, reinstall, version selection, signing and publication require separate approval; none is authorized by the commands in this document. Existing ownership/workflow-expansion artifacts and measurements below are historical, not the current source freeze or a package containing the new recorder.

The distribution target is a sanitized npm package plus Windows Setup EXE/ZIP, with a supplemental source ZIP. The checked-in `.github/workflows/release.yml` builds the npm artifact and a filtered source-tree ZIP named `potassium-mcp-v<version>-windows.zip`; that filename does not make it an installed Windows runtime. The workflow does not invoke `tools/windows-release.mjs build` to produce Setup. The separate Windows build path below still needs its own approval, exact-byte installation qualification and advertised-download/signing decision. Source checks and source ZIP integrity do not qualify an EXE.

Agent guidance is distributed through the existing documentation, starting at [Agent quick start](AGENT-INSTALL.md#agent-quick-start) and the canonical [Agent workflow](API.md#agent-workflow), not a separately maintained skill. No default skill installation or skill-evaluation prerequisite is part of Stable qualification. A future thin router that only links these docs is conditional on demonstrated routing need; it must not duplicate workflow guidance or change permissions, host policy or release gates.

## Windows local installer

The historical ownership candidate is `release-out/ownership-candidate/windows-setup/Setup.exe`, distributed as `potassium-mcp-v0.10.0-beta.1-windows-setup.zip`. Its ownership fixes have exact-artifact npm, sealed Windows and native GUI lifecycle evidence below. Those archived bytes do not contain or qualify the current source changes. It was local, unsigned and unpublished; a same-version registry artifact is not that candidate.

Start Potassium once to create its workspace, run Setup, select the existing `%LOCALAPPDATA%\Potassium\workspace` with the directly visible **Change folder** picker, and click **Install**. Setup does not install Potassium or Roblox. There is no Desktop/CLI selector, extra warning/consent/permission prompt, or Safeproxy. Only a genuinely fresh installation grants generic `agent` full read/admin/execute access and enables the global execution gate, including synchronous `potassium_execute_luau` and asynchronous `potassium_execute_luau_async`. Updates, repairs, and reinstalls with retained configuration preserve explicit existing permissions, including restrictions. A missing `agent` policy in existing configuration may receive a read-only entry, never elevation of admin, execute, or the global gate.

> **Trust the connected agent.** Arbitrary Luau can change the connected client and act with its executor's permissions; untrusted content or prompt injection may induce unwanted actions. Execution is not sandboxed. Setup does not bypass harness approval. Authentication, loopback restrictions, truthful annotations, and resource limits remain active; optional HTTP/fallback transports, external hosts, and trace/artifact roots are not automatically enabled or widened. See [Security](../SECURITY.md).

The installed layout separates durable application files from protected private state:

| Location | Purpose |
|---|---|
| `%LOCALAPPDATA%\Programs\Potassium MCP\PotassiumMcp.Launcher.exe` | Stable MCP stdio command; no arguments |
| Application root `connection.json` | Token-free `mcpServers.potassium` entry with the absolute launcher path and `args: []` |
| Application root `versions\<manifestVersionId>` | Owned, integrity-checked Node `22.23.2`, MCP package, and dependency bundle |
| `%LOCALAPPDATA%\Potassium\MCP` | Private config, token, artifacts, and ownership/recovery state; not part of the distributable |

The self-contained application and bundled runtime do not require global Node/npm or a shared .NET installation on the target machine. They remain installed after Setup closes; a host must not launch a temporary extraction path. Use **Copy configuration**, **Copy command**, or **Copy path**, then manually merge the entry into an MCP stdio-capable harness while preserving unrelated configuration. See [the connection example](GETTING-STARTED.md#windows-local-installer). Setup does not automatically register a new host.

Restart/reload the harness. **Check** reports MCP connectivity separately from executor attachment: **MCP connected** with **Executor not attached** can be healthy before Roblox/Potassium attaches. Discovery or a successful installer check does not qualify native engine behavior.

### Windows maintenance and custom roots

Reopen Setup and use its maintenance actions for **Check**, **Repair**, or removal. Close active MCP sessions before removal, confirm the removal dialog, and manually remove the connection entry from your harness. Repair handles owned partial installations; uninstall/reinstall retains private configuration, token, artifacts, and recovery evidence. Unknown, modified, or in-use application files are not forcibly deleted. `CleanupPending` requires resolving the reported owned recovery state, not deleting private files or assuming rollback. Do not close Setup during an active operation; its window-close action is refused while busy.

The workspace picker is directly visible; there is no **Advanced folders** section. Custom application and private-state roots remain explicit Setup CLI options:

```powershell
.\release-out\approved-candidate\windows-setup\Setup.exe --app-root "$env:LOCALAPPDATA\PotassiumMcpApp" --install-root "$env:LOCALAPPDATA\PotassiumMcpState" --workspace "$env:LOCALAPPDATA\Potassium\workspace"
```

`--app-root` is the durable application root; `--install-root` is the separate private state root. Use the same roots for later maintenance. Existing custom wrappers, junctions, or core ownership conflicts remain fail-closed migration conflicts; the installer does not adopt or overwrite them. Its application lock fences Windows-managed operations, not concurrent trusted manual core reconfiguration. Do not run both management paths concurrently.

### Building the local Windows artifact

After separate build approval, choose a new isolated output directory (the example uses `approved-candidate`, not an archived evidence directory). From the repository root on Windows x64 with Node/npm and exact .NET SDK `8.0.424` (self-contained runtime pin `8.0.30`); native build provisions the hash-pinned Zig `0.14.1` compiler at build time:

```powershell
node tools/native-parser.mjs build
node tools/parser-host.mjs build
node tools/release.mjs npm-pack --output release-out/approved-candidate
node tools/windows-release.mjs build --npm-artifact release-out/approved-candidate/NPM-ARTIFACT.json --output release-out/approved-candidate/windows-setup
node tools/windows-release.mjs check --output release-out/approved-candidate/windows-setup
```

Build/seal the native worker before ParserHost, then npm packaging or Windows stage/build. `potassium-mcp/assets/native-parser/win32-x64/` contains the GUI-independent C worker with Tree-sitter `0.25.0`/Luau grammar `1.2.0`, sealed manifest, and parser/compiler notices. `assets/parser-host/win32-x64/` contains the self-contained controller/manifest/.NET notices. Web-tree-sitter/WASM are development-test-only, not deployed runtime dependencies/fallback. Runtime invokes no compiler or downloader; stale/missing seals fail packaging.

Explicit output keeps previous artifacts and evidence intact. Windows `stage`/`build` accept `--npm-artifact`; its adjacent tarball and checksum must match the selected receipt, without fallback to historical metadata. `check` accepts only the sealed output and rejects `--npm-artifact`. Defaults remain unchanged. Keep Windows output in its own leaf directory: its ownership receipt rejects foreign or modified files. Build uses verified cached .NET packages when available; npm dependency restore and Node license retrieval can still require network access.

The native child parses source; C# handles bounded framing; validated native-tree adaptation and bounded semantic JavaScript analysis run in the trusted parent. Ordinary no-capability AppContainer plus atomic Job limits confine the native child without private desktop/station creation or existing UI ACL edits. This is not LPAC or an absolute filesystem whitelist; AppContainer-public Windows resources remain accessible. Build/seal proof does not establish OS denials, parser/adapter correctness, or GUI installation. Other platforms have no production parser backend.

The fixed production backend has no CHILD_PROCESS_POLICY or experimental debug paths. Actual local native cases passed typed UTF-8 parsing, external-file/runtime-write denial with Windows error 5, child CreateProcess denial with quota error 1816, and a loopback positive control: the host reached the listener, the confined worker did not connect, and its actual error was 10060. Memory/output/wall limits, cancellation, and crash recovery passed. The CPU probe used an actual one-second Job CPU limit to avoid racing the wall deadline; production retains five-second CPU/ten-second wall limits, and the final full-suite CPU_LIMIT case passed. These are scoped native boundary results, not universal compatibility or native game qualification. See [Testing](TESTING.md#parser-and-source-analysis-proof-boundaries).

`check` verifies the sealed artifact, not equivalence with the current checkout, and does not publish it. The EXE's exact `--verify-bundle` mode performs read-only bundle-integrity verification, not installation:

```powershell
.\release-out\approved-candidate\windows-setup\Setup.exe --verify-bundle
```

#### Current isolated test candidate

The [current scoped acceptance](../release-out/test-candidate-eMUgvF/source/release-out/candidate/ACCEPTANCE.json) retains one approved unsigned/unpublished `0.10.0-beta.1` candidate under `release-out/test-candidate-eMUgvF/source/release-out/candidate/`. It is not a Stable download or an instruction to replace an existing installation.

| Artifact | SHA-256 |
|---|---|
| npm tarball | `3d6c86f65cad9667e52ea340e6bfa58af8443bd683e51988d9ba6afbb61eca1a` |
| `windows-setup/Setup.exe` | `700c124f37fee962a1e3eefcd0ab1b899fffb5cb1df4a364ac11329f59e17d55` |
| Windows distribution ZIP | `bcbb8793fa6e43f894ae9291297005932c8820c92d7671f71e3d8e81bdb12ee0` |

Windows bundle ID: `b5128a9a4f24aab77c934cb074965929784ccd9d651501634ec5fa3533fabd04`. Node22/24 package and full30-minute soak checks passed. Actual isolated Windows maintenance, old/current rollback and retained reinstall preserved credentials, restrictions, wrappers, contexts and maps. The separately authorized private-station clipboard follow-up also passed all three real copy handlers under normal RunAs/UAC, without opening the user's clipboard. Original stdio-close attribution remains unresolved; signing/distribution/Stable/publication are not approved. See [Testing](TESTING.md#current-isolated-test-candidate--september-10-2026) for exact scope.

#### Historical ownership candidate

The following archived version `0.10.0-beta.1` artifacts were local, unsigned and unpublished. Their measured facts are preserved, not relabeled as current qualification:

| Artifact under `release-out/ownership-candidate` | SHA-256 / identity |
|---|---|
| `mrketa-potassium-mcp-0.10.0-beta.1.tgz` | `0c153057bb6afef16125c79957739767efc57d854d4d3c23fdd5a5b9ca80ec10` |
| `windows-setup/Setup.exe` | `321c589e31e33f012340e7ca3a9e721f1366368c0e1114e3d16d5b80a552a2bd` |
| `windows-setup/potassium-mcp-v0.10.0-beta.1-windows-setup.zip` | `e69e92590040e911f273e396691ef003daea07a07348097234c0f6a777573cca` |
| Installer manifest version ID | `07d23b3abc53c937bc093c714107e84be953754ef88aeb9a991f409fd3da669b` |

[Node 24](../release-out/ownership-candidate/node24/PACKAGE-SMOKE.json) and [Node 22](../release-out/ownership-candidate/node22/PACKAGE-SMOKE.json) bind the same tarball to real npm/npx, public CLI, three-transport SDK, manual-host preservation and installed production-parser checks. [Native Windows GUI acceptance](../release-out/ownership-candidate/WINDOWS-GUI-ACCEPTANCE.json) binds the exact Setup to older-artifact install → candidate update → repair → cancelled/confirmed removal → retained reinstall, cold Check and independent installed-launcher/native-parser SDK proof. Existing restrictive settings, token, manual wrapper and test data were preserved; the test broker had no executor. All application/private/workspace roots were disposable and explicit; no real user installation was replaced. See the acceptance notes for corrected test-fixture/controller issues. Native game/server qualification and stable publication remain separate.

A [separate clean candidate installation](../release-out/ownership-candidate/WINDOWS-FRESH-ACCEPTANCE.json) verified fresh full-access defaults, cold Check and the installed Windows launcher/native parser with 56 tools; the restricted upgrade/reinstall case exposed 41. The [aggregate acceptance](../release-out/ownership-candidate/ACCEPTANCE.json) also links a completed five-minute read-only live observation. That low-rate window is not native-server, leak, render-FPS or thirty-minute staging-soak qualification.

#### Historical workflow-expansion artifacts

The following identities describe the earlier historical workflow-expansion qualification, distinct from the later historical ownership candidate and the current source work:

| Artifact | Historical identity |
|---|---|
| `release-out/windows-setup/Setup.exe` SHA-256 | `b703fb169d959c95bb5b96fd1361506d15627805d9f4e5886ae3a18086b372f6` |
| Installer manifest version ID | `c660c8d4abdf1e1978cc218a992df6f7c698f3b0274503555dccc6295955501f` |
| `potassium-mcp-v0.10.0-beta.1-windows-setup.zip` SHA-256 | `94d69b50dd701831bdbe9e91e81d3dbd2bf4bd4d2f056a154fa60bf9bee42b93` |
| npm tarball directly under `release-out` SHA-256 | `2817ca070f077c43de98138103dd3d76ded312c65e6df49348959f3b037dbde2` |

[WORKFLOW-EXPANSION-ACCEPTANCE.json](../release-out/WORKFLOW-EXPANSION-ACCEPTANCE.json) records the earlier Node `24.15.0` suite (562 tests, 559 passed, zero failed/cancelled, three skipped), Lune 70/70, C# Setup 28/28 and tooling 22/22; Windows tooling later repeated 9/9. That tarball passed installed SDK and native index/query checks on Node 22/24. Its original Windows qualification was sealed-payload-only; the later ownership-candidate GUI run used this older EXE as its upgrade baseline. The SHA512-pinned cached .NET restore was not a fresh advisory audit. These historical suite counts are not reruns on the ownership candidate.

[PACKAGE-SMOKE.json](../release-out/PACKAGE-SMOKE.json) remains bound to the older `2817ca07…` tarball: three npm installs, offline pinned npx, public serve, three A→B→A generations, host add/remove and retained uninstall/reinstall, with 41 read-only tools and controlled transport/auth/cancellation checks. Its fake executor was not native game execution. [Earlier remote-workflow acceptance](../release-out/REMOTE-WORKFLOW-ACCEPTANCE.json) belongs to `3268e3f4…` npm/`2e291d4e…` Setup artifacts; neither report substitutes for the candidate-specific evidence above.

#### Historical pre-remote-workflow artifacts

The following historical pre-remote-workflow artifacts retain version `0.10.0-beta.1`; the Windows installer is unsigned and nothing has been published. These identities do not include or qualify the new remote-workflow source delta:

| Artifact | Historical accepted identity |
|---|---|
| `release-out/windows-setup/Setup.exe` SHA-256 | `a3a83c3a4aad4a68d919099699331fe4939babed2e3bbacb1e2d67167079c253` |
| Installer manifest version ID | `fb84db9033f603590f944bdc6d3a963b62808f00867877949e8898fcf70095eb` |
| `potassium-mcp-v0.10.0-beta.1-windows-setup.zip` SHA-256 | `ea6fcffc45fe73e69103ceb0b7d34494072fadb275f7ce1bda6ae6ab0c56e37e` |
| Candidate npm tarball SHA-256 | `b26f8f4a75b4d6bfc0af9dde6e01c75d2385b4a302cc027da08e41de9b963310` |

Historical Windows 11 native acceptance on a3a/b26 exercised fresh GUI installation/full grants, visible workspace picker, and cold Check with MCP responding/executor unattached. The installed bundled-Node SDK exposed 46 full-access tools; Update/Repair of a restriction created by older 07d4371a Setup preserved token/rights and 36 tools. Fresh/restricted broker-stop checks passed. Later historical 3268 full-access installed discovery had 51 tools; the historical independently installed expansion npm measurement had 56. None of those counts qualifies the current source or a newly built EXE.

The [historical Windows evidence](../release-out/WINDOWS-INSTALLER-ACCEPTANCE.json) remains bound to a3a/b26; [Testing](TESTING.md#windows-installer-native-evidence) separates it from later historical packed workflow measurements and earlier retained uninstall/reinstall/soak results. No arbitrary Luau, live executor mutation, clipboard transfer, Windows 10, independent-harness, or native engine qualification was claimed. Later sealed verification does not extend historical GUI results to another EXE.

## Advanced alternative: npm CLI and host adapters

The npm CLI's defaults are unchanged; the example below explicitly grants ordinary read-only access rather than the Windows installer's fresh full-access policy. Admin and execute grants remain explicit CLI choices.

Use the exact verified `1.0.0` candidate tarball until its matching release is explicitly published. Version text alone is not proof that a registry artifact or local rebuild contains the qualified bytes. npm owns package acquisition, upgrade, downgrade, and removal:

```powershell
npm install --global <verified-candidate.tgz>
potassium-mcp setup --workspace "$env:LOCALAPPDATA\Potassium\workspace" --read-host omp-project-a --dry-run --json
potassium-mcp setup --workspace "$env:LOCALAPPDATA\Potassium\workspace" --read-host omp-project-a --json
potassium-mcp config print --host-id omp-project-a --json
```

The private root defaults to `%LOCALAPPDATA%\Potassium\MCP` (`config.json`). Fresh setup requires `--workspace` or absolute `POTASSIUM_WORKSPACE`; later operations can reuse the verified workspace. Pass the conventional `%LOCALAPPDATA%\Potassium\workspace` explicitly as above. `--install-root` selects a different state root. Setup uses the executing external npm package or explicit `--runtime-root <absolute-package-root>`; it does not copy/install/delete package files. Private configuration and credentials stay outside npm/cache directories.

Hostless setup transactionally deploys only:

- `.potassium-mcp-bootstrap.lua` in the workspace
- `potassium_mcp_autoexec.lua` in Potassium's autoexec directory

The deployed bootstrap's canonical endpoint is rendered from preserved executor config (`127.0.0.1` or `::1`, port `1..65535`); IPv6 uses a bracketed WebSocket host. Compare deployed parity against rendered expected bytes, not an unmodified default-endpoint source hash. npm-owned source assets remain unchanged and non-loopback endpoints remain forbidden.

`--read-host` explicitly defines the unique policy identity without registering an application. `config print` requires a known configured ID and prints a standard token-free absolute Node/public-bin `serve --config <absolute-path> --host-id <id>` entry without writes or grants. After an approved matching publication, `--npm` emits the exact-version npm variant.

Optional registration is separate:

```powershell
potassium-mcp host add --host omp --host-id omp-project-a --scope project --dry-run --json
potassium-mcp host add --host omp --host-id omp-project-a --scope project
```

Adapters implement host configuration, not independent real-version qualification; see the [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status). `host add/remove` never install packages, redeploy assets, or grant policy. Use distinct IDs per project/launcher and only supported scopes.

Claude Code mixed user/local/project ownership is conservatively rejected when CLI precedence can hide the exact registered entry. Scope text is checked when available, but missing/ambiguous output is not proof; do not guess hidden storage paths. Multiple local projects use distinct configured IDs and persisted canonical CWDs. These adapter rules do not establish real-Claude runtime qualification.

Run `potassium-mcp doctor --json`, restart/reload affected hosts, then attach Potassium. Read status, capabilities, and clients; explicitly select `clientId` when ambiguous. Check package/deployed/running bootstrap compatibility. Existing live evidence uses the prior deployed bootstrap and does not prove newly edited candidate assets were deployed.

## Remote workflow bootstrap cutover

Required running feature versions are remoteInventory v3 (v4 for retained query), remoteCapture v2, actionObservation v1, remoteActions v1/asyncJobs v2, and diagnosticSnapshot v2/instanceReferences v1 for their respective tools; overview preserves old diagnostic compatibility. New context capture requires gameContext v2, bounded map observe/probe mapObservation v1, and continuous recording mapRecording v1. Missing versions report INCOMPATIBLE_CLIENT. Updating package assets or discovering tools does not replace an executing bootstrap. Availability is a prerequisite, not native interception qualification; nativeSemanticsVerified remains false. Offline saved evidence needs no executor; source indexing additionally requires its local Windows parser backend.

For an explicitly approved deployment, use the installation's own verified maintenance path:

1. Stop any owned captures and finish/drain active work. A stop, timeout, disconnect, or broker restart does not forcibly terminate arbitrary Luau or an already sent InvokeServer. Do not replay uncertain submissions.
2. Close/reload affected MCP hosts under manual control. For Windows-managed state use Setup Update/Repair; for npm-managed state acquire the verified candidate with npm, preview `potassium-mcp repair --dry-run --json`, then run repair against the intended installation. Preserve existing config/token/rights and user-managed wrapper/junction ownership; conflicts are not permission to overwrite.
3. Check package and rendered deployed-asset identity with the installation-owned doctor. Restart the broker through its verified CLI when needed, then manually restart/reattach Potassium in a safe environment so the matching bootstrap begins a new generation. Never load/reload the bootstrap through its own active MCP execute tool; this can strand the connection that must report completion. A blocked foreign-hook cleanup needs manual environment recovery, not clearing a flag or layering another wrapper.
4. Reconnect the host, select the intended client, and inspect status/capabilities for the new generation and required feature versions. Take a bounded inventory summary first. Local native probes do not prove real RemoteFunction/game-metatable behavior; `nativeSemanticsVerified` remains false.

Snapshot/capture/action-observation IDs from the old generation are invalid. Compact results, source indexes, and stats are host-retained scopes, not durable artifacts. The source work did not deploy live, alter the user's config/wrapper, register a host, invoke a game remote, or publish. Fresh Windows full-access and retained-rights behavior remain unchanged; only fresh configuration initializes the separate `sources` directory. No Advanced UI, Safeproxy, or extra prompt is added.

### Continuous recording cutover boundary

The native continuous sampler is source implementation `mapRecording.version: 1`, bootstrap `lifecycle-5`; editing those assets is not deployment or native acceptance. Existing lifecycle-4 observation/probe evidence does not qualify continuous recording. Do not promise a user-run recording or synthesize a GO from a submitted request: readiness requires the fresh first-sample native receipt described in [API](API.md#continuous-map-recording).

The source catalog separates `potassium_map_navigation` links/routes from `potassium_map_motion` tracks/hazards/summary, and `potassium_map_recording` lifecycle/summary polling from `potassium_map_recording_read` live frames/events and offline archives. After an approved host update, refresh typed discovery and activate the exact new tool names as needed. Old cross-tool operation combinations are not aliases; the split does not change native feature versions, permissions or storage scope.

Any future approved cutover must keep package, correctly rendered deployed bootstrap and actual running generation aligned. Preserve config/token/rights and the user-managed wrapper; no automatic host registration, grant, bootstrap self-reload or raw-execution fallback is added. Saved maps, archived recordings and already accepted save receipts are offline and remain distinct from generation-local live recorder IDs. A disconnect ends active recording; it does not turn historical metadata into a new ready receipt.

## Update, repair, removal, and conflicts

Use npm to select the approved new package or prior verified package for rollback, then `setup`/`repair` to update its private state/deployment. Preview with `--dry-run --json`; dry-run must not lock, stage, create tokens, change ACLs, register hosts, or restart processes. Repair preserves valid user configuration, policy, token identity, artifacts, and unrelated host content; it is not host registration or credential rotation.

Require runtime metadata `potassiumMcpRuntime: { ownershipSchema: 3, launcherProtocol: 1 }`; old same-version archives without it cannot serve as explicit schema-3 runtime migration targets. This marker does not replace integrity/package qualification. During schema-2 migration, old `admin: true` with global unsafe execution disabled was dormant and is migrated to false unless explicitly granted via `--admin-host`/`--http-admin`, preserving effective privileges rather than accidentally enabling admin.

A bounded transaction journal supports verified dead-owner rollback/resume through repair after process death. Prove owner death and journal/managed-state ownership; do not infer ownership from lock age or remove foreign locks. Dry-run describes recovery without executing it; wrapper/credential/path conflicts still fail closed.

Accepted edits to an active configuration need controlled repair: while holding the exact installation lease, the internal repair context authenticates drain against the recorded old endpoint with the unchanged owned token. Public broker-stop/config-loading checks remain strict; this is not a general override for mismatched ownership.

Distinguish failure phases. If a precommit failure follows broker stop and the original in-memory configuration bytes are unavailable, preserve the user's edited files and committed resume journal rather than claiming the old broker was restarted. Any restart rejection after committed publication is **startup-uncertain**: retain current committed config/credentials, backups, and journal; inspect `broker status`, then use verified repair. Do not assume prior credentials were restored or automatically retry `rotate-token`.

After commit, failure to remove backups/journal reports `cleanupPending`; it does not roll back the successfully committed installation. Retain the indicated recovery evidence and resolve only proven-owned cleanup. Publication here means committing local installation state, not permission to publish npm/GitHub artifacts.

```powershell
potassium-mcp repair --dry-run --json
potassium-mcp repair --json
potassium-mcp host remove --host omp --host-id omp-project-a --scope project
potassium-mcp uninstall --all --dry-run --json
potassium-mcp uninstall --all --json
npm uninstall --global @mrketa/potassium-mcp
```

`uninstall --all` removes only proven-owned registrations/deployment, preserving config/token/artifacts and retained reinstall evidence. npm package removal is separate and should wait until no launchers need it. An arbitrary existing token is not adoptable evidence; no implicit purge is provided.

The old `install` and `--package-source` commands are removed. Legacy copied runtime migration needs exact ownership proof. `--runtime-root` chooses the new package and does not grant deletion authority over an old junction or target. The actual custom OMP wrapper/internal-proxy consumer and junction remain untouched user-managed conflicts. There is no force/recovery bypass: a separately proven standard entry may be restored only by explicit user decision before migration. Follow the [full conflict procedure](../potassium-mcp/README.md#existing-installation-conflicts); never overwrite the actual wrapper, delete its repository target, or discard credentials/evidence to force success.

### Windows ACL preservation failures

An ACL-preservation failure reports the original affected file, the failed operation, and the concrete Windows exception or process-start error. The target can be the transaction journal, not only `config.json`; temporary staging and backup filenames are not substituted for the original target. CLI `--json` includes an `acl` object with `path`, `operation`, `message`, `exceptionType`, `hresult`, `nativeErrorCode`, `processCode`, `exitCode`, and `requiresElevation`. The originating error code is `MCP_ACL_PRESERVE_FAILED`; enclosing rollback/recovery context remains available.

Setup recommends closing it and reopening the same installer with **Run as administrator** only when reading or writing an ACL produced structured access-denied or privilege-required evidence. Use the same Windows account and intended installation/workspace paths. PowerShell launch errors such as `EPERM`, missing executables, module initialization failures, malformed output, and other unclassified failures do not justify that recommendation. Elevation is not guaranteed to resolve every restriction, and MCP clients do not need administrator rights because Setup needed them.

The hint never launches UAC, retries an operation, resets permissions, or bypasses ownership checks. Keep any reported recovery journal/backups; do not delete ownership or credential files to force an upgrade. The native details view retains secret redaction but intentionally shows the explicitly identified local target path, so review that path before sharing diagnostics.

## Optional Streamable HTTP deployment

Keep stdio as the default. Enable stateless HTTP and, optionally, stateful sessions explicitly:

```powershell
potassium-mcp repair --streamable-http --stateful-http --streamable-http-port 32147
```

`/mcp` is stateless POST-only. `/mcp/session` supports POST/GET/DELETE with `mcp-session-id`, at most 32 active/pending sessions, and lazy 15-minute idle expiry. Both require private Bearer auth; POST requires `Accept: application/json, text/event-stream`. Follow [legacy initialization/version/session headers](API.md#optional-streamable-http-transport). SDK `1.30.0` remains in the legacy epoch through `2025-11-25`; no `2026-07-28`, SSE replay/resumability, or progress claim.

A stateless cross-request cancellation notification cannot address a previous request's server. Local cancellation does not prove nonexecution or stopped work; no transport forcibly terminates arbitrary Luau.

Configure trusted identities through setup/repair with `--read-host`, `--deny-read-host`, `--admin-host`, and `--execute-host`; HTTP has independent `--http-no-read`, `--http-admin`, and `--http-execute`. Only execution requires `--allow-unsafe-execute`. Shared-token holder impersonation is outside policy isolation guarantees. Explicit `--no-*` options revoke optional features; token rotation restarts the broker and requires reattach. Fallback uses a distinct private token at fixed `127.0.0.1:8225/mcp` for diagnostics only.

## Publishing a release

Source qualification, draft preparation and publishing are separate operations. First Stable is `1.0.0`, explicitly unsigned. Build once in an isolated source/output root, select the exact npm receipt for the Windows build, and qualify those same bytes on Node22/24, the actual Windows launcher/maintenance paths, retained data/rollback and the full30-minute soak. Do not sign, rebuild or repackage candidate payloads after qualification.

The public release set is a deliberately small flat directory: the selected npm tarball/sidecar and `NPM-ARTIFACT.json`, exact `Setup.exe`, Windows Setup ZIP, `WINDOWS-SETUP.json`, original Windows checksums copied as `WINDOWS-SHA256SUMS.txt`, source inventory `RELEASE-EVIDENCE.json`, and sanitized `QUALIFICATION.json`. Preparation generates the standalone Setup/ZIP sidecars and aggregate `SHA256SUMS.txt`. Raw local smoke logs, private paths, credentials, installer ownership receipts and temporary build directories are not public assets. Windows licenses and sealed bundle metadata remain inside the original Setup ZIP.

`tools/github-release.mjs prepare --directory <set> --source-sha <40-hex-commit> --ref v1.0.0` validates the committed source/version/lock identity, selected npm and Windows binding, explicit unsigned decision and every required qualification gate, then writes schema2 `RELEASE-SET.json`. Its canonical file records are `{name,bytes,sha256}`. Retain the SHA-256 of that manifest externally. Verification is `node tools/github-release.mjs verify --directory <set> --source-sha <commit> --ref v1.0.0 --set-sha256 <approved-manifest-sha256>`. There is no CLI bypass for source, qualification or Windows execution checks.

Stage only those exact files plus `RELEASE-SET.json` on the explicitly selected draft in `mrketa/potassium-mcp`, with immutable source commit as `target_commitish`. Run `release.yml` on that source ref with explicit `release_id`, `set_sha256`, `publish=false`, and empty `confirm_version`. Preparation independently downloads the complete manifest-driven set, verifies every digest and source/qualification binding, checks the actual Setup bundle, and checks the configured npm identity/package permission without publishing. It produces a sanitized receipt. Missing or changed draft assets fail; no rebuilding fallback exists.

Private draft assets require a token with repository write capability. The preparation job therefore also waits behind the `stable-publish` owner-approval boundary before receiving its short-lived GitHub token; it does not expose that capability in an unprotected verification job. In preparation mode the API wrapper still permits only GET, npm checks remain read-only, and `publish=false` prevents promotion. Approval of this preparation run is not approval of a later publishing run. When editing draft metadata, send the canonical `tag_name` and immutable `target_commitish` together; a generated `untagged` browser URL is not the release identity.

Actual publication is a separate `workflow_dispatch` with `publish=true` and exact `confirm_version=1.0.0`, followed by the protected `stable-publish` owner's approval. The publishing job independently verifies the same selected draft/set again, establishes the exact source tag if absent, publishes only the verified npm tarball or recognizes an identical prior publication, then rechecks every GitHub asset before releasing the draft. No tag push implicitly publishes, and no job signs or rebuilds payloads during promotion.

For partial publication, reuse the same draft ID, external set digest, source commit and original local archived bytes. Exact npm identity/integrity permits resume without republishing or stealing a genuinely newer `latest`; a successful publish has a bounded12×5-second registry propagation observation, not repeated publication. Conflicting integrity, authorization/network errors or mismatched source fail closed. Missing/failed draft assets must first be restored from the original local set under explicit ownership; uploaded mismatched bytes are never clobbered. Only a positively identified empty failed `starter` on an unpublished draft is disposable after a fresh reread. Keep recovery receipts separate from immutable inputs.

Unsigned is an explicit release policy, not a certificate claim. Changing that policy later changes the actual executable/ZIP hashes and requires a new seal and qualification. Read-only credential checks establish current identity/package access, not a guarantee that future registry policy, token expiry or external availability cannot change. A publish Go never authorizes gameplay, bootstrap self-reload or replacement of a user's existing installation.

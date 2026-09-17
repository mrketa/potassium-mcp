# Deployment

## Release and distribution scope

The 1.1.0 qualification target is Windows 11 x64, Node 22/24, Potassium 2.4.7, public stdio and authenticated stateless/retained HTTP. Windows 10 remains a declared but unqualified target; Linux host core, Linux/macOS executor use, other Node lines, other host applications and MCP 2026-07-28 are not qualified by this work. See the [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status).

Version 1.1.0 is selected for release preparation, not yet asserted published by these docs. Build and qualify exact artifacts before protected promotion. Historical evidence does not substitute for a new source freeze, npm tarball, Windows bundle, installed lifecycle checks, or soak.

The distributions are a sanitized npm package and Windows Setup EXE/ZIP. Build the npm tarball once from the frozen allowlisted source; `tools/windows-release.mjs build` consumes that exact npm receipt and seals the installed Windows payload. The manual `.github/workflows/release.yml` verifies and promotes an explicitly selected complete draft set under protected approval. It does not build npm, Setup, or a supplemental filtered source ZIP. GitHub's automatic source archives are separate from installed runtimes.

Agent guidance is distributed through the existing documentation, starting at [Agent quick start](AGENT-INSTALL.md#agent-quick-start) and the canonical [Agent workflow](API.md#agent-workflow), not a separately maintained skill. No default skill installation or skill-evaluation prerequisite is part of Stable qualification. A future thin router that only links these docs is conditional on demonstrated routing need; it must not duplicate workflow guidance or change permissions, host policy or release gates.

## Windows local installer

Obtain Setup and its matching checksums from the selected [published release](https://github.com/mrketa/potassium-mcp/releases). An unpublished candidate is for explicitly authorized qualification only; a matching version string alone does not prove artifact identity.

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

Updates are manual. Download the newer verified Setup and choose **Update** for the same owned installation, account, and roots. Setup installs the bundle embedded in that executable; it does not fetch npm `latest` or automatically update itself. Restart affected MCP hosts and manually restart/reattach Potassium to run the newly deployed bootstrap. Reopening an old Setup is not acquisition of a new release.

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

#### Historical artifact evidence

Stable 1.0.0 and its separately tracked Windows ACL maintenance rebuild precede this release. The original npm package and release tag were not changed by that Windows-only maintenance. Original public qualification records remain in the [1.0.0 technical archive](https://github.com/mrketa/potassium-mcp/tree/5677385f169c24c87f8879e72bb8f5beee86f0d6/release-evidence/v1.0.0). Archived prerelease source, package, GUI, clipboard, and soak measurements are not current download instructions or 1.1.0 acceptance.

## Advanced alternative: npm CLI and host adapters

The npm CLI's defaults are unchanged; the example below explicitly grants ordinary read-only access rather than the Windows installer's fresh full-access policy. Admin and execute grants remain explicit CLI choices.

For candidate qualification, install the exact verified 1.1.0 tarball. After its matching release is published, `npm install --global @mrketa/potassium-mcp@1.1.0` selects the registry version. Version text alone is not proof that a registry artifact or local rebuild contains the qualified bytes. npm owns package acquisition, upgrade, downgrade, and removal:

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

Run `potassium-mcp doctor --json`, restart/reload affected hosts, then attach Potassium. Read status, capabilities, and clients; explicitly select `clientId` when ambiguous. Check package/deployed/running bootstrap compatibility; a package install alone does not replace an executing bootstrap.

## Remote workflow bootstrap cutover

Required running feature versions are remoteInventory v3 (v4 for retained query), remoteCapture v2, actionObservation v1, remoteActions v1/asyncJobs v2, and diagnosticSnapshot v2/instanceReferences v1 for their respective tools; overview preserves old diagnostic compatibility. New context capture requires gameContext v2, bounded map observe/probe mapObservation v1, and continuous recording mapRecording v1. Interaction reads require interactionInventory v1; calls require interactionActions v1/asyncJobs v2. The 1.1.0 bootstrap build marker is `lifecycle-6`. Missing versions report INCOMPATIBLE_CLIENT. Updating assets or discovering tools does not replace an executing bootstrap. Availability is not native interception qualification; nativeSemanticsVerified remains false. Offline saved evidence needs no executor; source indexing additionally requires its local Windows parser backend.

For an explicitly approved deployment, use the installation's own verified maintenance path:

1. Stop any owned captures and finish/drain active work. A stop, timeout, disconnect, or broker restart does not forcibly terminate arbitrary Luau or an already sent InvokeServer. Do not replay uncertain submissions.
2. Close/reload affected MCP hosts under manual control. For Windows-managed state use Setup Update/Repair; for npm-managed state acquire the verified candidate with npm, preview `potassium-mcp repair --dry-run --json`, then run repair against the intended installation. Preserve existing config/token/rights and user-managed wrapper/junction ownership; conflicts are not permission to overwrite.
3. Check package and rendered deployed-asset identity with the installation-owned doctor. Restart the broker through its verified CLI when needed, then manually restart/reattach Potassium in a safe environment so the matching bootstrap begins a new generation. Never load/reload the bootstrap through its own active MCP execute tool; this can strand the connection that must report completion. A blocked foreign-hook cleanup needs manual environment recovery, not clearing a flag or layering another wrapper.
4. Reconnect the host, select the intended client, and inspect status/capabilities for the new generation and required feature versions. Take a bounded inventory summary first. Local native probes do not prove real RemoteFunction/game-metatable behavior; `nativeSemanticsVerified` remains false.

Snapshot/capture/action-observation/interaction inventory IDs from the old generation are invalid. Compact results, source indexes, and stats are host-retained scopes, not durable artifacts. Release publication is not deployment into an existing installation and grants no additional host or gameplay authority. Fresh Windows full-access and retained-rights behavior remain unchanged; only fresh configuration initializes the separate `sources` directory.

### Continuous recording cutover boundary

The native continuous sampler uses `mapRecording.version: 1` and is included in bootstrap `lifecycle-6`. Historical lifecycle-5 recording evidence does not qualify a changed artifact automatically. Do not promise a user-run recording or synthesize a GO from a submitted request: readiness requires the fresh first-sample native receipt described in [API](API.md#continuous-map-recording).

The source catalog separates `potassium_map_navigation` links/routes from `potassium_map_motion` tracks/hazards/summary, and `potassium_map_recording` lifecycle/summary polling from `potassium_map_recording_read` live frames/events and offline archives. After an approved host update, refresh typed discovery and activate the exact new tool names as needed. Old cross-tool operation combinations are not aliases; the split does not change native feature versions, permissions or storage scope.

Each cutover must keep package, correctly rendered deployed bootstrap, and actual running generation aligned. Preserve config/token/rights and user-managed wrappers; no automatic host registration, grant, bootstrap self-reload, or raw-execution fallback is added. Saved maps, archived recordings, and already accepted save receipts remain offline and distinct from generation-local live recorder IDs. A disconnect ends active recording; it does not turn historical metadata into a new ready receipt.

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

The old `install` and `--package-source` commands are removed. Legacy copied runtime migration needs exact ownership proof. `--runtime-root` chooses the new package and does not grant deletion authority over an old junction or target. Custom wrappers/internal-proxy consumers and junctions remain user-managed conflicts. There is no force/recovery bypass: restore a separately proven standard entry only by explicit owner decision before migration. Follow the [full conflict procedure](../potassium-mcp/README.md#existing-installation-conflicts); never discard wrappers, targets, credentials, or evidence to force success.

### Windows ACL preservation failures

An ACL-preservation failure reports the original affected file, the failed operation, and the concrete Windows exception or process-start error. The target can be the transaction journal, not only `config.json`; temporary staging and backup filenames are not substituted for the original target. CLI `--json` includes an `acl` object with `path`, `operation`, `message`, `exceptionType`, `hresult`, `nativeErrorCode`, `processCode`, `exitCode`, and `requiresElevation`. The originating error code is `MCP_ACL_PRESERVE_FAILED`; enclosing rollback/recovery context remains available.

Setup recommends closing it and reopening the same installer with **Run as administrator** only when reading or writing an ACL produced structured access-denied or privilege-required evidence. Use the same Windows account and intended installation/workspace paths. PowerShell launch errors such as `EPERM`, missing executables, module initialization failures, malformed output, and other unclassified failures do not justify that recommendation. Elevation is not guaranteed to resolve every restriction, and MCP clients do not need administrator rights because Setup needed them.

The hint never launches UAC, retries an operation, resets permissions, or bypasses ownership checks. Keep any reported recovery journal/backups; do not delete ownership or credential files to force an upgrade. The native details view retains secret redaction but intentionally shows the explicitly identified local target path, so review that path before sharing diagnostics.

## Optional native desktop editor deployment

Enable the host-only editor integration using the public setup/repair entrypoint selected by existing installation ownership, not a newly invented launcher. The following `potassium-mcp` commands are for an npm-managed installation with that command available:

```powershell
potassium-mcp repair --install-root <owned-private-root> --native-editor-token-file <private-native-token-path> --dry-run --json
potassium-mcp repair --install-root <owned-private-root> --native-editor-token-file <private-native-token-path> --json
potassium-mcp doctor --install-root <owned-private-root> --json
```

The token is the native endpoint's credential, never the custom broker token. It remains independently configured from diagnostic fallback, and setup checks only its local hygiene/identity, not native availability. This change must preserve every existing host/HTTP grant and the global execution switch; it must not convert other authorized AI agents to read-only. Any newly authorized local grants require explicit [per-identity opt-in](CONFIGURATION.md#native-desktop-editor), not weakened packaged defaults.

### Windows Setup installation without global Node or npm

First install the approved release through Setup's normal **Update** path if the installed package does not yet contain the editor tools. Use Setup **Check** to verify the owned installed runtime, then close Setup and all affected MCP host sessions before configuration maintenance. Finish or drain active work first. Do not run Setup and manual core repair concurrently. Use the same Windows account and private-state root as the installation; the stable no-argument launcher is an MCP connection entrypoint, not the maintenance CLI.

In PowerShell, select the existing private root (replace the default below if you installed with a custom `--install-root`) and read only its owned runtime paths:

```powershell
$installRoot = Join-Path $env:LOCALAPPDATA 'Potassium\MCP'
$ownership = Get-Content -LiteralPath (Join-Path $installRoot 'ownership.json') -Raw | ConvertFrom-Json
$nodeExe = $ownership.runtime.nodeExecutable
$cli = Join-Path $ownership.runtime.root 'bin\potassium-mcp.js'
$nativeTokenFile = Read-Host 'Absolute private native token-file path (not the token)'
& $nodeExe $cli repair --install-root $installRoot --native-editor-token-file $nativeTokenFile --dry-run --json
```

This requires the existing active schema-3 ownership record from a verified Windows Setup installation. Do not supply a downloaded or edited ownership file, guess a version directory, substitute system Node, or redirect the runtime to a repository checkout. The CLI runs under the recorded bundled Node and defaults to its own installed package root, so no global Node/npm or `potassium-mcp` command is required. Review the dry-run for the same existing runtime, workspace, and preserved grants. On an ownership, credential, runtime, or recovery error, stop and use verified maintenance; do not delete records or add a force option.

After a successful preview, apply the same operation and check it with the same bundled entrypoint:

```powershell
& $nodeExe $cli repair --install-root $installRoot --native-editor-token-file $nativeTokenFile --json
& $nodeExe $cli doctor --install-root $installRoot --json
```

Keep the native token file private, outside the immutable installed bundle. Enter only its path, never its contents, and do not paste tokens, ownership/configuration files, or unreviewed local-path diagnostics into shared transcripts. This opt-in uses the native endpoint credential, not the custom broker token; it leaves all existing host/HTTP permissions and raw execution grants unchanged. It adds no Setup GUI control or Setup command-line flag.

Reconnect affected MCP hosts to refresh discovery. Doctor's local check is not native editor readiness; editor operations still require the running native desktop endpoint. The editor itself needs no Roblox attach or bootstrap reload. To disable it later, close Setup/affected sessions again, re-read the current ownership paths, and use the same bundled CLI with `repair --install-root $installRoot --no-native-editor --json`. Disabling retains the token file and unrelated grants/fallback configuration.

For source-linked runtime updates, use the supported ownership-verified broker restart when needed and reconnect/reload affected MCP hosts so their tool lists refresh. Installed bundles receive updated runtime bytes only through normal Setup maintenance. The bundled CLI procedure above changes owned configuration using the already selected runtime; it is not an alternative package-update path. Never run it concurrently with Setup. This desktop feature requires neither Roblox nor bootstrap replacement; never reload a bootstrap through its active execution connection.

Prefer opening a new draft during validation. Existing-tab writes require a best-effort SHA-256 comparison, not native atomic compare-and-swap; close refuses dirty tabs. Do not blindly replay a mutation with an indeterminate outcome. `--no-native-editor` removes only editor configuration, retaining the credential file, diagnostics and all execution grants. See the [full editor contract](API.md#native-desktop-editor-tabs).

## Optional Streamable HTTP deployment

Keep stdio as the default. Enable stateless HTTP and, optionally, stateful sessions explicitly:

```powershell
potassium-mcp repair --streamable-http --stateful-http --streamable-http-port 32147
```

`/mcp` is stateless POST-only. `/mcp/session` supports POST/GET/DELETE with `mcp-session-id`, at most 32 active/pending sessions, and lazy 15-minute idle expiry. Both require private Bearer auth; POST requires `Accept: application/json, text/event-stream`. Follow [legacy initialization/version/session headers](API.md#optional-streamable-http-transport). SDK `1.30.0` remains in the legacy epoch through `2025-11-25`; no `2026-07-28`, SSE replay/resumability, or progress claim.

A stateless cross-request cancellation notification cannot address a previous request's server. Local cancellation does not prove nonexecution or stopped work; no transport forcibly terminates arbitrary Luau.

Configure trusted identities through setup/repair with `--read-host`, `--deny-read-host`, `--admin-host`, and `--execute-host`; HTTP has independent `--http-no-read`, `--http-admin`, and `--http-execute`. Only execution requires `--allow-unsafe-execute`. Shared-token holder impersonation is outside policy isolation guarantees. Explicit `--no-*` options revoke optional features; token rotation restarts the broker and requires reattach. Fallback uses a distinct private token at fixed `127.0.0.1:8225/mcp` for diagnostics only.

## Publishing a release

Source qualification, draft preparation, and publishing are separate operations. The selected release is `1.1.0`, with explicitly unsigned Windows distribution. Build once in an isolated source/output root, select the exact npm receipt for the Windows build, and qualify those same bytes on Node22/24, the actual Windows launcher/maintenance paths, retained data/rollback, and the full 30-minute soak. Do not sign, rebuild, or repackage payloads after qualification.

The public release set is a deliberately small flat directory: the selected npm tarball/sidecar and `NPM-ARTIFACT.json`, exact `Setup.exe`, Windows Setup ZIP, `WINDOWS-SETUP.json`, original Windows checksums copied as `WINDOWS-SHA256SUMS.txt`, source inventory `RELEASE-EVIDENCE.json`, and sanitized `QUALIFICATION.json`. Preparation generates the standalone Setup/ZIP sidecars and aggregate `SHA256SUMS.txt`. Raw local smoke logs, private paths, credentials, installer ownership receipts and temporary build directories are not public assets. Windows licenses and sealed bundle metadata remain inside the original Setup ZIP.

`node tools/github-release.mjs prepare --directory <set> --source-sha <40-hex-commit> --ref v1.1.0` validates source/version/lock identity, selected npm and Windows binding, explicit unsigned decision, and required qualification receipts, then writes schema2 `RELEASE-SET.json`. Its canonical file records are `{name,bytes,sha256}`. Retain the manifest's SHA-256 externally. Verify with `node tools/github-release.mjs verify --directory <set> --source-sha <commit> --ref v1.1.0 --set-sha256 <approved-manifest-sha256>`. The final set contains exactly 13 files: 12 hashed records plus the manifest itself. Receipt validation does not run the source suites, real GUI lifecycle, or soak; retain truthful proof for every accepted field.

Stage only those exact files plus `RELEASE-SET.json` on the explicitly selected draft in `mrketa/potassium-mcp`, with immutable source commit as `target_commitish`. Run `release.yml` on that source ref with explicit `release_id`, `set_sha256`, `publish=false`, and empty `confirm_version`. Preparation independently downloads the complete manifest-driven set, verifies every digest and source/qualification binding, checks the actual Setup bundle, and checks the configured npm identity/package permission without publishing. It produces a sanitized receipt. Missing or changed draft assets fail; no rebuilding fallback exists.

Private draft assets require a token with repository write capability. The preparation job therefore also waits behind the `stable-publish` owner-approval boundary before receiving its short-lived GitHub token; it does not expose that capability in an unprotected verification job. In preparation mode the API wrapper still permits only GET, npm checks remain read-only, and `publish=false` prevents promotion. Approval of this preparation run is not approval of a later publishing run. When editing draft metadata, send the canonical `tag_name` and immutable `target_commitish` together; a generated `untagged` browser URL is not the release identity.

Actual publication is a separate `workflow_dispatch` with `publish=true` and exact `confirm_version=1.1.0`, followed by the protected `stable-publish` owner's approval. The publishing job independently verifies the same selected draft/set again, establishes the exact source tag if absent, publishes only the verified npm tarball or recognizes an identical prior publication, then rechecks every GitHub asset before releasing the draft. New npm publication uses `latest`; GitHub promotion deliberately uses `make_latest: false`. No tag push implicitly publishes, and no job signs or rebuilds payloads during promotion.

For partial publication, reuse the same draft ID, external set digest, source commit and original local archived bytes. Exact npm identity/integrity permits resume without republishing or stealing a genuinely newer `latest`; a successful publish has a bounded12×5-second registry propagation observation, not repeated publication. Conflicting integrity, authorization/network errors or mismatched source fail closed. Missing/failed draft assets must first be restored from the original local set under explicit ownership; uploaded mismatched bytes are never clobbered. Only a positively identified empty failed `starter` on an unpublished draft is disposable after a fresh reread. Keep recovery receipts separate from immutable inputs.

Unsigned is an explicit release policy, not a certificate claim. Changing that policy later changes the actual executable/ZIP hashes and requires a new seal and qualification. Read-only credential checks establish current identity/package access, not a guarantee that future registry policy, token expiry or external availability cannot change. A publish Go never authorizes gameplay, bootstrap self-reload or replacement of a user's existing installation.

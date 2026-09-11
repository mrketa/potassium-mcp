# Agent-assisted installation

## Agent quick start

Use the current connection's typed schemas and structured errors first; these docs supply workflow guidance, not permissions.
Documentation is read explicitly, not automatically loaded, and requires no separate skill installation.

- **Already connected:** follow the [canonical agent workflow](API.md#agent-workflow); do not rerun setup for ordinary use.
- **Installing or changing a host:** use [agent-assisted setup](#agent-assisted-setup) below, only for the requested configuration work.
- **Saved evidence or supplied source:** start with [contexts/maps](API.md#shared-game-and-map-context), [archived recordings](API.md#continuous-map-recording) or [offline source indexing](API.md#offline-luau-source-index).
- **Fresh live work:** resolve [client/generation and capabilities](API.md#results-errors-and-selected-clients), then [discover narrowly](API.md#catalog-discovery-and-activation).
- **Reading outcomes:** use [accepted/error handling](API.md#results-errors-and-selected-clients) and [selected result paging](API.md#compact-results-and-selected-detail), not repeated submissions.
- **Interpreting evidence:** retain [identity](API.md#stable-instance-references), [coverage/model timing](API.md#parkour-map-reconstruction) and [privacy boundaries](API.md#untrusted-evidence-and-privacy).

Reading documentation neither installs/registers MCP nor changes policy, execution gates, host compatibility or release qualification.

## Agent-assisted setup

Use these instructions with a trusted local coding agent authorized to configure the requested application. First read the [support matrix](../potassium-mcp/README.md#support-freeze-and-release-status) and [migration conflicts](../potassium-mcp/README.md#existing-installation-conflicts). Current evidence is Windows 11/Node `24.15.0`/Potassium `2.4.7`; declared requirements and implemented adapters are not independent runtime qualification.

1. Identify the requested package artifact, workspace, config root, adapter, scope, and unique policy ID. Until publication is approved, use a verified local candidate tarball, not an existing same-version npm artifact assumed to contain checkout changes. npm owns package installation/update; never place private state in npm/cache directories.
2. Preview `potassium-mcp setup --workspace <absolute-workspace> --read-host <unique-id> --dry-run --json`, then run the same intended setup without `--dry-run`. Fresh setup needs explicit workspace or absolute `POTASSIUM_WORKSPACE`; later operations may use prior verified state. `--read-host` defines read-only identity without registration; unknown IDs reject. Preserve actual wrappers, foreign entries, and junction targets on ownership conflict; never adopt arbitrary tokens.
3. Use read-only `config print --host-id <unique-id> --json` to print a standard token-free public `serve` entry. For an approved matching published package, `--npm` may print its exact-version launch. Do not recommend internal proxy paths for new configurations.
4. If host registration is requested, preview and run `host add --host <adapter> --host-id <unique-id> --scope <supported-scope>`. Registration is optional, never defaults to OMP, and does not deploy assets, install packages, or grant policy. Only the requested proven-owned entry may change.
5. Run `doctor --json` without disclosing secrets. Have the user restart/reload affected hosts and attach Potassium. Read status, capabilities, and clients, select `clientId`, compare counters around one bounded read, and report exact evidence rather than assuming counters start at zero. Discovery alone does not prove feature support in the selected running bootstrap.
6. Keep default game-state observation bounded. Admin/read/execute grants are independent; only execution requires `--allow-unsafe-execute`. Shared-token holders are trusted, not isolated from each other. Do not automatically retry indeterminate submissions or claim cancellation kills arbitrary Luau.

Setup/repair accept documented policy and optional transport flags only: `--read-host`, `--deny-read-host`, `--admin-host`, `--execute-host`, `--streamable-http`, `--stateful-http`, `--http-no-read`, `--http-admin`, `--http-execute`, and `--builtin-fallback-token-file`. Repair preserves settings unless explicitly changed. Use `host remove` for one registration and `uninstall --all` for owned registrations/deployment; config, token, artifacts, and verified reinstall evidence remain. Remove the npm package separately. Token rotation/bootstrap replacement requires reattach, never an in-connection bootstrap reload.

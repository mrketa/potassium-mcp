# Development

Install dependencies with `npm ci` in `potassium-mcp`. Keep changes focused on the standalone local bridge and preserve the protocol, loopback, ownership, bounds, and redaction guarantees.

For deployment work, use the canonical package assets in `potassium-mcp/assets/`; do not create additional payloads. Preserve bounded default game-state observation. Keep read concurrency at four per executor client and mutation ordering as FIFO barriers; preserve heartbeat/reconnect and explicit multi-client routing. Raw synchronous/asynchronous Luau remains behind the global unsafe gate and per-host/HTTP execute policy; admin grants are independent of that execution gate.

Maintain both HTTP contracts: fresh POST-only `/mcp` and optional bounded `/mcp/session`. Do not weaken artifact, async retention, console, built-in fallback, or token separation bounds. Installer changes must preserve policy on repair unless an explicit `--no-*` revocation is present; token rotation must continue to require reattach.

The public entrypoint is `serve`, backed by the shared proxy/broker. Keep npm package ownership, hostless setup/deployment, read-only `config print`, and optional host registration separate. Never turn shared-token host policies into an unsupported adversarial-isolation claim or overwrite user-managed wrappers/junctions during migration.

Use [Testing](TESTING.md) for qualification commands and their limits. SDK `1.30.0` remains pinned to the legacy handshake contract through `2025-11-25`; executor Protocol 2 is unrelated. Candidate package/host/engine evidence must be recorded separately from fixtures. No Stable bump or publication follows automatically from green tests.

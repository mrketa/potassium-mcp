# Development

Install dependencies with `npm ci` in `potassium-mcp`. Keep changes focused on the standalone local bridge and preserve the protocol, loopback, ownership, bounds, and redaction guarantees.

For deployment work, use the canonical package assets in `potassium-mcp/assets/`; do not create additional payloads. Preserve bounded default game-state observation. Keep read concurrency at four per executor client and mutation ordering as FIFO barriers; preserve heartbeat/reconnect and explicit multi-client routing. Raw synchronous/asynchronous Luau remains behind the global unsafe gate and per-host/HTTP execute policy; admin grants are independent of that execution gate.

Maintain both HTTP contracts: fresh POST-only `/mcp` and optional bounded `/mcp/session`. Do not weaken artifact, async retention, console, built-in fallback, or token separation bounds. Installer changes must preserve policy on repair unless an explicit `--no-*` revocation is present; token rotation must continue to require reattach.

The public entrypoint is `serve`, backed by the shared proxy/broker. Keep npm package ownership, hostless setup/deployment, read-only `config print`, and optional host registration separate. Never turn shared-token host policies into an unsupported adversarial-isolation claim or overwrite user-managed wrappers/junctions during migration.

Use [Testing](TESTING.md) for qualification commands and their limits. SDK `1.30.0` remains pinned to the legacy handshake contract through `2025-11-25`; executor Protocol 2 is unrelated. Candidate package/host/engine evidence must be recorded separately from fixtures. No Stable bump or publication follows automatically from green tests.

The 1.1.0 native editor integration is an independent, default-off broker service using a separately configured native credential. Preserve its 256 KiB UTF-8 bound, exact reads, metadata-only logging, per-tab serialization, cancellation, clean-only close, and explicitly non-atomic hash preconditions. Do not grant new rights when enabling it or couple it to Roblox attachment or diagnostic fallback.

Interaction inventory and one-call jobs use the existing bounded bridge/bootstrap and async lifecycle. Preserve exact queued identities, boolean touch passthrough, queued cancellation, eventual post-dispatch outcomes, and `serverAcknowledged: false`; do not infer native phases or add automatic pairing/replay.

Public source, npm, and Windows distribution inventories are distinct. New runtime files must enter the explicit release manifest even when `package.json.files` includes their directory. Keep Node tests in the public Git source without assuming they belong in the installed npm payload. Release promotion verifies an already built, qualified 13-file draft set under protected approval; it never rebuilds payloads. Windows updates are manual and use the selected Setup's embedded bundle.

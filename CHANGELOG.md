# Changelog

All notable public changes are documented here.

## 0.10.0-beta.3 — 2026-08-20

- Fixed Windows Setup runtime verification for `tar` archives whose entries use a leading `./`.
- Bundled the complete Potassium MCP package, production dependencies, and npm CLI required by the local installer.
- Added release-time launch checks for the bundled Potassium command and npm CLI.
- Replaced the setup-only AI prompt with a complete agent guide covering all 42 MCP tools, full-access policy, routing, transports, execution, and recovery.

## 0.10.0-beta.2 — 2026-08-20

- Fixed Windows Setup discovery for the standard `workspace`/`autoexec` layout, legacy `data` installations, explicit custom roots, and Windows path casing.
- Added visible host selection and OMP project-folder support to Setup.
- Made Setup full uninstall resolve proven ownership metadata instead of fresh-install defaults.
- Revalidated ownership after acquiring the lifecycle lock so repair and uninstall cannot act on stale state.

## 0.10.0-beta.1 — 2026-08-20

- Added one authenticated broker with host-bound stdio proxies, explicit executor `clientId` routing, heartbeat/reconnect, and up to four concurrent reads per executor client while mutations remain FIFO barriers.
- Added immutable per-host and independent HTTP read/admin/execute policy. The default remains read-only; unrestricted execution is an explicit trusted-admin opt-in.
- Added authenticated loopback Streamable HTTP with stateless `/mcp` and optional bounded stateful `/mcp/session`.
- Added asynchronous execution job status/result and paged redacted console cursors, audit metadata, and artifact descriptors for successful result envelopes larger than 64 KiB.
- Added a diagnostic-only optional built-in fallback fixed to `127.0.0.1:8225`; it never forwards native execution.
- Made install and repair transactional and policy-preserving, with explicit revocations; added ownership-gated `rotate-token` recovery that requires Potassium reattach.
- Preserved the Windows Setup app, Doctor, live verification, supported host adapters, and ownership-aware installer behavior.
- Documented the bridge's independent relationship to Potassium's built-in MCP and live compatibility with Potassium 2.4.3 build `version-ce0bcd0fbd484804`.

## 0.9.0-beta.2 — 2026-08-18

- Enabled token-backed npm publication with provenance after explicit repository activation.
- Preserved the verified Windows installer, portable package, and bounded MCP behavior from beta 1.

## 0.9.0-beta.1 — 2026-08-18

First public beta of Potassium MCP Bridge.

- Added a Windows-first `Setup.exe` experience with install, repair, uninstall, Doctor, and live verification actions.
- Added explicit setup for Codex, Claude Code, Claude Desktop, VS Code, Cursor, Gemini, and manual/generic MCP hosts.
- Added local stdio MCP by default, with authenticated loopback-only Streamable HTTP available only when explicitly enabled.
- Kept administrative execution disabled by default and required an informed opt-in to enable it.
- Added `verify --json`, which performs live MCP initialization through the installed proxy and calls `potassium_status` and `potassium_capabilities`.

## License

Potassium MCP Bridge is licensed under Apache-2.0. See [LICENSE](LICENSE).

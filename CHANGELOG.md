# Changelog

All notable public changes are documented here.

## 0.9.0-beta.1 — 2026-08-18

First public beta of Potassium MCP.

- Adds a Windows-first `Setup.exe` experience with install, repair, uninstall, Doctor, and live verification actions.
- Supports explicit setup for Codex, Claude Code, Claude Desktop, VS Code, Cursor, Gemini, and manual/generic MCP hosts.
- Uses local stdio MCP by default, with authenticated loopback-only Streamable HTTP available only when explicitly enabled.
- Keeps administrative execution disabled by default and requires an informed opt-in to enable it.
- Adds `verify --json`, which performs live MCP initialization through the installed proxy and calls `potassium_status` and `potassium_capabilities`.
- Publishes the nontechnical README, canonical AI setup prompt, advanced operation guide, security policy, and contribution policy.

## License

Potassium MCP is licensed under Apache-2.0. See [LICENSE](LICENSE).

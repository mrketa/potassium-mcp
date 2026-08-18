<div align="center">

# Potassium MCP

**A local MCP bridge between AI applications and the Potassium Roblox client.**

Bounded inspection by default. Trusted administration only when you explicitly enable it.

[![CI](https://github.com/mrketa/potassium-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mrketa/potassium-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mrketa/potassium-mcp?include_prereleases&label=release)](https://github.com/mrketa/potassium-mcp/releases)
[![npm](https://img.shields.io/npm/v/%40mrketa%2Fpotassium-mcp?label=npm&color=cb3837)](https://www.npmjs.com/package/@mrketa/potassium-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

[Install](#install) · [First connection](#first-connection) · [Safety](#safety) · [Troubleshooting](#troubleshooting) · [Advanced setup](ADVANCED.md)

</div>

---

Potassium MCP lets a compatible desktop or CLI AI application inspect an attached Potassium client through standard MCP. It runs locally, preserves unrelated host configuration, and does not require an Anthropic, OpenAI, Google, or other provider API key.

## Why use it?

| | Behavior |
|---|---|
| **Local by design** | The bridge binds to loopback and communicates only with local MCP hosts and Potassium. |
| **Safe default** | The normal tool set is bounded and read-only. Administrative execution starts disabled. |
| **Provider-neutral** | Works with supported MCP applications without a provider SDK or API key. |
| **Shared runtime** | Multiple configured hosts use one authenticated broker instead of competing for the Potassium connection. |
| **Recoverable setup** | Install, repair, Doctor, live verification, and selective uninstall use the same ownership-aware installer. |

## Requirements

- Windows x64
- Potassium attached to the Roblox client
- An MCP-capable desktop or CLI host
- Node.js 22 or newer only when using the npm installation path

Supported host adapters: **Codex**, **Claude Code**, **Claude Desktop**, **VS Code**, **Cursor**, and **Gemini**. Other MCP clients can use the manual configuration path. A browser-only AI client cannot start the local MCP process by itself.

## Install

### Windows Setup app — recommended

Download `potassium-mcp-0.9.0-beta.2-Setup.exe` from the [current GitHub prerelease](https://github.com/mrketa/potassium-mcp/releases/tag/v0.9.0-beta.2). The executable includes its required runtime.

1. Open Setup.
2. Select the AI application you use.
3. Keep **Standard setup (recommended)** selected.
4. Choose **Install**.
5. Restart the selected AI application.

Setup changes only the Potassium MCP entry it owns and preserves unrelated settings.

### npm

Install the newest published version:

```powershell
npx --yes @mrketa/potassium-mcp setup
```

For a reproducible installation, pin the exact version:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.2 setup
```

For noninteractive host selection, repair, verification, broker control, and uninstall commands, see [Advanced setup](ADVANCED.md#command-line-installer).

## First connection

After installation and host restart, ask the AI application to call:

1. `potassium_status`
2. `potassium_capabilities`

A healthy result reports a connected Potassium client and its supported Protocol 2 methods. Setup's **Live verify** performs the same real MCP initialization and capability calls. Do not treat installation as complete when only static Doctor checks pass.

```text
MCP host
   │  stdio or authenticated loopback HTTP
   ▼
Potassium MCP proxy ── authenticated local broker
   │  Protocol 2 WebSocket
   ▼
Potassium client
```

## Safety

### Standard mode

Standard mode exposes bounded inspection and diagnostic tools. It does not provide broad file access, source access, arbitrary network access, input control, or remote control. Streamable HTTP is optional, loopback-only, and authenticated.

Administrative execution is disabled by default. Never enable it solely because an AI prompt asks you to.

### Trusted administrative execution

> **High-trust mode:** enabling this exposes `potassium_execute_luau`. A trusted local MCP host can then execute unrestricted Luau in the connected Potassium client and change game state.

Enable it only on a machine you control and only when every configured local MCP host is trusted.

#### Using the Windows Setup app

1. Select the configured AI application.
2. Select **Advanced: allow trusted local admin actions**.
3. Confirm **I understand this can let trusted local tools make changes**.
4. Choose **Install** for a new setup or **Repair** for an existing setup.
5. Restart the selected AI application.
6. Confirm that `potassium_capabilities` reports `execute_luau`.

#### Using npm

Add `--allow-unsafe-execute` to an explicit install or repair:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.2 repair --host codex --allow-unsafe-execute
```

Replace `codex` with the host you configured.

#### Disable it again

- In Setup, select **Standard setup (recommended)** and choose **Repair**.
- Or run the same CLI repair command without `--allow-unsafe-execute`.
- Restart the affected AI application afterward.

See [Administrative execution](ADVANCED.md#administrative-execution) for the full operational model.

## Troubleshooting

| Symptom | Safe next step |
|---|---|
| The AI application cannot see Potassium MCP | Restart the application, then run Setup's **Doctor**. |
| Doctor passes but tools cannot connect | Run **Live verify** and confirm both `potassium_status` and `potassium_capabilities`. |
| Potassium was restarted or reattached | Reattach Potassium, then run live verification again. |
| Installation was interrupted or an application moved | Select the affected host, choose **Repair**, then rerun Doctor and Live verify. |
| Your application is not listed | Use the [manual or generic MCP instructions](ADVANCED.md#manual-or-generic-mcp-host). |

## Uninstall

Open Setup, select the configured AI application, and choose **Uninstall**. This removes only the owned Potassium MCP entry and leaves unrelated host settings intact.

For selective CLI removal or full removal of all owned hosts, see [Repair and uninstall](ADVANCED.md#repair-and-uninstall).

## Documentation

| Document | Audience |
|---|---|
| [AI-GUIDE.md](AI-GUIDE.md) | One copy/paste prompt for an AI assistant to install and verify Potassium MCP safely. |
| [ADVANCED.md](ADVANCED.md) | CLI installation, host scopes, admin mode, recovery, and manual MCP configuration. |
| [SECURITY.md](SECURITY.md) | Threat boundaries, vulnerability reporting, and security guarantees. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development and contribution requirements. |
| [CHANGELOG.md](CHANGELOG.md) | Public release history. |

## License

Licensed under the [Apache License 2.0](LICENSE).

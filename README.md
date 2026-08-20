<div align="center">

# Potassium MCP Bridge

**An independent local MCP bridge between AI applications and the Potassium client.**

Bounded inspection by default. Trusted administration only when you explicitly enable it.

[![CI](https://github.com/mrketa/potassium-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mrketa/potassium-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mrketa/potassium-mcp?include_prereleases&label=release)](https://github.com/mrketa/potassium-mcp/releases)
[![npm](https://img.shields.io/npm/v/%40mrketa%2Fpotassium-mcp?label=npm&color=cb3837)](https://www.npmjs.com/package/@mrketa/potassium-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

[Install](#install) · [First connection](#first-connection) · [Safety](#safety) · [Troubleshooting](#troubleshooting) · [Advanced setup](ADVANCED.md)

</div>

---

Potassium MCP Bridge runs locally, preserves unrelated host configuration, and does not require an Anthropic, OpenAI, Google, or other provider API key.

## Relationship to Potassium's built-in MCP

Potassium ships its own MCP endpoint. Potassium MCP Bridge is an independent bridge, not an official Potassium service, replacement, wrapper, or alternate name for that native MCP. Prefer Potassium's built-in MCP when its direct integration is sufficient. Use this bridge when you need one authenticated broker for several MCP hosts, immutable per-host or HTTP policy, explicit executor `clientId` routing, optional authenticated HTTP, artifact envelopes, audit history, or FIFO mutation barriers.

The optional built-in fallback is diagnostic-only. It connects only to `127.0.0.1:8225` for bounded status, client-listing, and console diagnostics; it never forwards native execution. Live compatibility is verified with Potassium 2.4.3 build `version-ce0bcd0fbd484804`.

## Why use it?

| | Behavior |
|---|---|
| **Local by design** | Authenticated components bind to loopback and communicate only with local MCP hosts and Potassium. |
| **Safe default** | The normal tool set is bounded and read-only. Trusted administrative execution starts disabled. |
| **Multi-host runtime** | Configured hosts use authenticated stdio proxies and one broker instead of competing for a Potassium connection. |
| **Policy and routing** | Per-host and HTTP read/admin/execute policies are independent; executor-backed calls select a `clientId` when needed. |
| **Recoverable setup** | Install, repair, Doctor, live verification, token rotation, and selective uninstall are ownership-aware. |

## Requirements

- Windows x64
- Potassium attached to the Roblox client
- An MCP-capable desktop or CLI host
- Node.js 22 or newer only when using the npm installation path

Supported host adapters: **OMP**, **Codex**, **Claude Code**, **Claude Desktop**, **VS Code**, **Cursor**, and **Gemini**. Other MCP clients can use the manual configuration path. A browser-only AI client cannot start the local MCP process by itself.

## Install

### Windows Setup app — recommended

Download `potassium-mcp-0.10.0-beta.3-Setup.exe` from the [current GitHub prerelease](https://github.com/mrketa/potassium-mcp/releases/tag/v0.10.0-beta.3). The executable includes its required runtime.

1. Open Setup.
2. Confirm the detected Potassium workspace and autoexec folders, or select them if detection is ambiguous. If you select OMP, also select the project containing its `.omp` folder.
3. Select the AI application you use.
4. Keep **Standard setup (recommended)** selected.
5. Choose **Install**.
6. Restart the selected AI application.

Setup detects the standard per-user `%LOCALAPPDATA%\Potassium\workspace` and sibling `autoexec` folders, supports an existing legacy `data` workspace, and reuses recorded ownership paths for repair and removal. It changes only the Potassium MCP Bridge entries it owns and preserves unrelated settings.

### npm

For a reproducible installation, pin the exact version:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 install --host omp
```

Repeat `--host` for explicitly selected hosts. For noninteractive host selection, repair, verification, broker control, token rotation, and uninstall commands, see [Advanced setup](ADVANCED.md#command-line-installer).

## First connection

After installation and host restart, ask the AI application to call:

1. `potassium_status`
2. `potassium_capabilities`
3. `potassium_list_clients`

A healthy result reports a connected Potassium client and its supported Protocol 2 methods. If more than one executor is attached, pass the intended `clientId` to executor-backed tools. Setup's **Live verify** performs real MCP initialization and capability calls. Do not treat installation as complete when only static Doctor checks pass.

```text
MCP host
   │  authenticated stdio proxy or loopback HTTP
   ▼
Potassium MCP Bridge ── authenticated local broker
   │  Protocol 2 with heartbeat/reconnect
   ▼
Potassium client(s)
```

## Safety

### Standard mode

Standard mode exposes bounded inspection and diagnostic tools. It does not provide broad file access, source access, arbitrary network access, input control, or remote control. The default is read-only; each stdio host and the optional HTTP transport have independent immutable read/admin/execute policy. Streamable HTTP is optional, loopback-only, and authenticated.

Administrative execution is disabled by default. Never enable it solely because an AI prompt asks you to.

### Trusted administrative execution

> **High-trust mode:** enabling the unsafe gate and granting a host execution policy exposes `potassium_execute_luau` and asynchronous execution. Submitted code can change the connected client.

Enable it only on a machine you control and only for every host you explicitly trust.

#### Using the Windows Setup app

1. Select the configured AI application.
2. Select **Advanced: allow trusted local admin actions**.
3. Confirm **I understand this can let trusted local tools make changes**.
4. Choose **Install** for a new setup or **Repair** for an existing setup.
5. Restart the selected AI application.
6. Confirm that `potassium_capabilities` reports the granted administrative capability.

#### Using npm

Add the unsafe gate and an explicit trusted host grant during repair:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp --allow-unsafe-execute --execute-host omp --admin-host omp
```

#### Disable it again

- In Setup, select **Standard setup (recommended)** and choose **Repair**.
- Or run repair with `--no-unsafe-execute`.
- Restart affected hosts afterward.

See [Administrative execution](ADVANCED.md#administrative-execution) for the operational model.

## Troubleshooting

| Symptom | Safe next step |
|---|---|
| The AI application cannot see Potassium MCP Bridge | Restart the application, then run Setup's **Doctor**. |
| Doctor passes but tools cannot connect | Run **Live verify** and confirm `potassium_status` and `potassium_capabilities`. |
| Several executors are attached | Call `potassium_list_clients`, then pass the intended `clientId`. |
| Potassium was restarted, reattached, or the token rotated | Reattach Potassium, then run live verification again. |
| Installation was interrupted or an application moved | Select the affected host, choose **Repair**, then rerun Doctor and Live verify. |
| Your application is not listed | Use the [manual or generic MCP instructions](ADVANCED.md#manual-or-generic-mcp-host). |

## Uninstall

Open Setup and choose **Uninstall**. Setup resolves the installed folders from proven ownership metadata, removes all owned Potassium MCP Bridge entries and the shared runtime, and leaves unrelated host settings, the private token, and bounded artifacts intact.

For selective CLI removal or full removal of all owned hosts, see [Repair and uninstall](ADVANCED.md#repair-and-uninstall).

## Documentation

| Document | Audience |
|---|---|
| [AI-GUIDE.md](AI-GUIDE.md) | Complete AI-agent reference for all 42 tools, full-access policy, routing, transports, workflows, and recovery. |
| [ADVANCED.md](ADVANCED.md) | CLI installation, policies, HTTP, recovery, and manual MCP configuration. |
| [SECURITY.md](SECURITY.md) | Threat boundaries, token recovery, and vulnerability reporting. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development and contribution requirements. |
| [CHANGELOG.md](CHANGELOG.md) | Public release history. |

## License

Licensed under the [Apache License 2.0](LICENSE).

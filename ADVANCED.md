# Advanced setup and operation

This page is for people who manage their own MCP configuration. For the normal Windows experience, use the release `Setup.exe` described in [README.md](README.md).

## Architecture

Each configured host starts the installed MCP proxy using **stdio**, the standard local MCP transport. The proxy authenticates to a per-user local broker. The broker owns the authenticated Potassium connection and serializes requests. Configuration, token material, and installation ownership data stay under the current Windows user's local application-data area.

The package does not call Anthropic, OpenAI, Google, or other AI-provider APIs. Provider credentials are neither required nor part of installation.

## Transports

Stdio is the default and recommended transport. It works when the MCP host can start a local process.

Streamable HTTP is optional. When enabled, it binds only to loopback and requires authentication. It is intended for a local, MCP-capable client that supports this transport—not for a browser-only client. Do not expose it through port forwarding, a reverse proxy, a LAN address, or a tunnel. Administrative tools must not be exposed to unauthenticated local processes.

## Supported hosts

| Host | Configuration route | Real-host test status |
| --- | --- | --- |
| Codex | Host CLI registration | Verify on the target machine with `verify --json` |
| Claude Code | Host CLI registration | Verify on the target machine with `verify --json` |
| Claude Desktop | Managed local configuration | Verify on the target machine with `verify --json` |
| VS Code | Managed local configuration | Verify on the target machine with `verify --json` |
| Cursor | Managed local configuration | Verify on the target machine with `verify --json` |
| Gemini | Managed local configuration | Verify on the target machine with `verify --json` |
| Manual/generic | Your stdio JSON or TOML configuration | Verify through your host, then use the installed CLI verification |

The table describes supported installation adapters, not a claim that every version of every host has been live-tested. A successful `verify --json` is the real test for the installed host and machine.

## Command-line installer

Use an explicitly selected host. The installer does not guess a host or rewrite every AI application.

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 install --host codex
```

Replace `codex` with one or more explicit values: `codex`, `claude-code`, `claude-desktop`, `vscode`, `cursor`, `gemini`, or `manual`. For example:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 install --host claude-desktop --host vscode
```

Use `--scope user`, `--scope project`, or `--scope local` only when the chosen host supports that scope. Use `--mcp-config <path>` for one file-backed host configuration that you specify.

### Checks

`doctor --json` checks the installed files, owned host registration, and safe local configuration without opening a live MCP session.

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 doctor --json
```

`verify --json` is the live check. It initializes MCP through the installed proxy and calls `potassium_status` and `potassium_capabilities`. Treat setup as incomplete until both calls succeed.

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 verify --json
```

The broker can be inspected or restarted with:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 broker status --json
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 broker restart --json
```

A restart waits for an active request for up to 30 seconds by default. It resets the connection transport; it does **not** forcibly terminate arbitrary client work that may already be running.

## Configuration

The installer writes its own runtime configuration and keeps host changes limited to the owned Potassium MCP entry. See [config.example.json](config.example.json) for bounded message, timeout, artifact, and allowed HTTPS-host settings.

Keep the generated token file private to the Windows user account. Do not paste it into chat, commit it, add it to an MCP configuration, or put it in environment variables. The installer restricts its Windows file permissions. If you believe it was exposed, repair the installation to rotate local credentials and inspect the configured host entries.

## Administrative execution

Administrative execution is disabled by default. The `--allow-unsafe-execute` option is available only for an explicit install or repair action:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 repair --host codex --allow-unsafe-execute
```

Use it only after informed consent from the person who controls the machine and configured hosts. It can allow every configured local MCP host to request unrestricted administrative execution. Removing the option during a later repair returns the installation to the default disabled state.

## Broker recovery

Use the Setup app's repair/doctor controls first. For a command-line recovery, inspect the broker, restart it if needed, and then run both checks:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 broker restart --json
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 doctor --json
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 verify --json
```

Transport recovery disconnects and resets the local transport. It is not a process terminator and does not promise to stop arbitrary work already running in the connected client.

## Manual or generic MCP host

Choose `manual` to install the local runtime without guessing a host configuration:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 install --host manual
```

Then configure your MCP-capable desktop or CLI host to start the installed Potassium MCP proxy over stdio. Use the exact launcher and arguments returned by the installer or Setup's details screen. Do not copy an unpinned package command into a host configuration. The host must support local process-backed MCP; browser-only clients are not sufficient.

## Repair and uninstall

Repair refreshes only the runtime and registered entries that Potassium MCP can prove it owns:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 repair --host codex
```

To remove every owned host entry and the shared runtime when no owned entries remain:

```powershell
npx --yes @mrketa/potassium-mcp@0.9.0-beta.1 uninstall --all
```

Uninstall preserves unrelated host settings. Restart affected hosts after repair or uninstall.

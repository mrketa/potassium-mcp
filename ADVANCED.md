# Advanced setup and operation

This page is for people who manage their own MCP configuration. For the normal Windows experience, use the release `Setup.exe` described in [README.md](README.md).

## Architecture

Each configured host starts the installed MCP proxy using **stdio**, the standard local MCP transport. Proxies authenticate to one per-user broker on loopback. The broker owns authenticated Potassium Protocol 2 connections, maintains heartbeats and bounded reconnect, and routes executor-backed requests by explicit `clientId` whenever selection is ambiguous.

For each executor client, the broker permits up to four concurrent reads. A mutation waits for earlier reads and forms a FIFO barrier before later work; mutations never overlap reads. This makes several configured hosts safe to use without racing for one executor connection.

Configuration, token material, artifacts, and installation ownership data stay under the current Windows user's local application-data area. The package does not call Anthropic, OpenAI, Google, or other AI-provider APIs.

## Transports and policy

Stdio is the default and recommended transport. Its launcher configuration contains no token.

Streamable HTTP is optional. When enabled, it binds only to loopback and requires Bearer authentication. It is intended for a local MCP-capable client that supports HTTP—not for a browser-only client. Do not expose it through port forwarding, a reverse proxy, a LAN address, or a tunnel.

`/mcp` is a stateless POST-only route: each authenticated POST receives a fresh MCP server, while authenticated GET and DELETE return MCP-shaped `405` responses. `--stateful-http` additionally enables bounded `/mcp/session` POST/GET/DELETE sessions using `mcp-session-id`; at most 32 sessions may exist and idle sessions expire after 15 minutes.

Read, admin, and execute policy is immutable per stdio host and independent for HTTP. The default is read-only. Raw execution always also requires the global unsafe gate; neither loopback nor token authentication makes submitted code safe.

## Supported hosts

| Host | Configuration route | Real-host test status |
| --- | --- | --- |
| OMP | Project MCP registration | Verify on the target machine with `verify --json` |
| Codex | Host CLI registration | Verify on the target machine with `verify --json` |
| Claude Code | Host CLI registration | Verify on the target machine with `verify --json` |
| Claude Desktop | Managed local configuration | Verify on the target machine with `verify --json` |
| VS Code | Managed local configuration | Verify on the target machine with `verify --json` |
| Cursor | Managed local configuration | Verify on the target machine with `verify --json` |
| Gemini | Managed local configuration | Verify on the target machine with `verify --json` |
| Manual/generic | Your stdio JSON or TOML configuration | Verify through your host, then use the installed CLI verification |

The table describes supported installation adapters, not a claim that every version of every host has been live-tested. A successful `verify --json` is the real test for the installed host and machine.

## Command-line installer

Use explicitly selected hosts. The installer never guesses a host or rewrites every AI application.

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 install --host omp
```

Replace `omp` with one or more explicit values: `omp`, `codex`, `claude-code`, `claude-desktop`, `vscode`, `cursor`, `gemini`, or `manual`.

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 install --host codex --host vscode
```

Use `--scope user`, `--scope project`, or `--scope local` only when the chosen host supports that scope. Use `--mcp-config <path>` for one file-backed host configuration that you specify.

### Checks

`doctor --json` checks the installed files, owned host registration, and safe local configuration without opening a live MCP session.

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 doctor --json
```

`verify --json` is the live check. It initializes MCP through the installed proxy and calls `potassium_status` and `potassium_capabilities`. Use `potassium_list_clients` and explicit `clientId` routing when multiple executors are attached.

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 verify --json
```

The owned broker can be inspected or restarted with:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 broker status --json
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 broker restart --json
```

A restart waits for an active request to drain by default. It resets the connection transport; it does **not** forcibly terminate arbitrary client work that may already be running.

## HTTP setup

Enable stateless HTTP only when a trusted local HTTP MCP client actually needs it:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp --streamable-http --streamable-http-port 32147
```

The default endpoint is `http://127.0.0.1:32147/mcp`. Read the generated configuration's private `tokenFile` locally; do not put its value into host configuration, source control, shell history, or logs. Use `--stateful-http` only when the client needs MCP sessions. Repair preserves HTTP settings until explicitly revoked with `--no-streamable-http` or `--no-stateful-http`.

## Administrative execution

Administrative execution is disabled by default. On a private installation, enable the global unsafe gate and grant only the intended host:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp --allow-unsafe-execute --execute-host omp --admin-host omp
```

`--execute-host` and `--admin-host` are repeatable stdio grants. `--http-execute` and `--http-admin` configure HTTP separately. `--deny-read-host` and `--http-no-read` can revoke read access. Removing the global gate with `--no-unsafe-execute` returns the installation to no execution access.

Accepted asynchronous executions are FIFO and expose a bounded status/result interface. `potassium_async_job_console` pages separately captured, redacted `print`/`warn` output with an `afterCursor`; it is not an arbitrary console stream. Successful result envelopes larger than 64 KiB are returned as bounded artifact descriptors and read through `potassium_artifact_read`.

## Configuration and recovery

The installer writes its own runtime configuration and keeps host changes limited to entries it can prove it owns. Install and repair are transactional: if a change fails, the installer rolls back changed shared files and host registrations. Repair preserves existing HTTP, fallback, unsafe-execution, and policy choices unless an explicit `--no-*` option revokes them.

Keep the generated custom broker token private to the Windows user account. Do not paste it into chat, commit it, add it to an MCP configuration, or put it in environment variables. If it may have been exposed, rotate it—do not use repair as token recovery:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 rotate-token
```

Rotation is ownership-gated, changes only the custom broker token, restarts the broker, and requires Potassium reattach. It does not rotate a built-in fallback token.

For connection recovery, inspect or restart the broker, then run both checks:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 broker restart --json
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 doctor --json
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 verify --json
```

## Diagnostic built-in fallback

An optional fallback can use Potassium's fixed local endpoint only when separately configured with `--builtin-fallback-token-file <private-path>`. It is fixed at `http://127.0.0.1:8225/mcp`, requires a token distinct from the custom broker token, and exposes only bounded status, client listing, and console diagnostics. It never forwards native execution. Live compatibility is verified with Potassium 2.4.3 build `version-ce0bcd0fbd484804`.

## Manual or generic MCP host

Choose `manual` to install the local runtime without guessing a host configuration:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 install --host manual
```

Then configure your MCP-capable desktop or CLI host to start the installed Potassium MCP Bridge proxy over stdio. Use the exact launcher and arguments returned by the installer or Setup's details screen. Do not copy an unpinned package command into a host configuration. The host must support local process-backed MCP; browser-only clients are not sufficient.

Fresh CLI installs default to `%LOCALAPPDATA%\Potassium\workspace` and `%LOCALAPPDATA%\Potassium\autoexec`. Use both `--workspace <path>` and `--autoexec <path>` when Potassium uses another layout. Repair, verification, token rotation, Doctor, and uninstall automatically reuse roots from proven ownership metadata when these options are omitted; explicit roots that disagree with ownership are rejected.

## Repair and uninstall

Repair refreshes only the runtime and registered entries that Potassium MCP Bridge can prove it owns:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 repair --host omp
```

To remove every owned host entry and the shared runtime when no owned entries remain:

```powershell
npx --yes @mrketa/potassium-mcp@0.10.0-beta.3 uninstall --all
```

Selective uninstall retains the shared runtime while any owned host remains. Uninstall preserves unrelated host settings, the private token, and bounded artifacts. Restart affected hosts after repair or uninstall.

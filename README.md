# Advanced Potassium MCP

An extended MCP toolkit for Potassium — built for deeper inspection, reusable context and AI-assisted scripting.

Connect your AI assistant to explore a live session, save useful scene data, understand Luau code and run scripts.

**[Releases & Windows downloads](https://github.com/mrketa/potassium-mcp/releases)** · [1.1.0 release notes](CHANGELOG.md#110) · [Agent guide](docs/API.md#agent-workflow)

This source targets **1.1.0**. Use its version-specific release assets only once published; a source checkout or draft is not a qualified download.

## What makes it Advanced?

Potassium already includes a built-in MCP. This independent project is for users who want a broader workflow around their AI connection: reusable snapshots, saved maps and recordings, offline code analysis, and shared access for multiple assistants. It is not Potassium's official built-in server.

- **Explore the session.** Inspect objects, properties, UI, player state and nearby geometry.
- **Keep useful context.** Save scene snapshots and supported images so another session or agent can work from the same data.
- **Study maps and movement.** Save maps, record selected objects over time, and review their surfaces and motion later — including offline.
- **Understand Luau.** Find functions, calls and dependencies in code you provide, without running it.
- **Investigate changes.** Browse remote metadata, read logs and compare the state before and after an action.
- **Run scripts and follow results.** Execute Luau with the connection's permissions, track longer-running jobs and read their output.
- **Work across assistants and clients.** Share a connection between MCP apps and choose the intended Potassium client when several are attached.
- **Edit native drafts.** Opt into listing, reading and editing Potassium desktop tabs without attaching Roblox.
- **Inspect interactions.** Browse bounded click/prompt/touch metadata and dispatch one explicitly authorized native interaction at a time.

Live inspection sees what the connected client exposes, not the entire server. Captures can be partial; saved maps and recordings are data for analysis, not an automatic gameplay controller.

## Get started on Windows

You need **Windows 11 x64**, **Potassium**, and an AI app that lets you add a local MCP server. The installer includes its own runtime — no separate Node.js or npm installation is needed.

1. **Start Potassium once** so its workspace exists.
2. **Run Setup.exe.** Select your existing Potassium workspace with **Change folder** if needed, then click **Install**.
3. **Connect your AI app.** Use **Copy configuration** to add the connection in its MCP settings. Keep any existing server entries; Setup does not configure the AI app automatically.
4. **Restart your AI app**, then start Roblox and attach Potassium. Use **Check connection** in Setup to confirm the connection.

“MCP connected” and “Potassium attached” are separate states. The MCP connection can be healthy before Potassium is attached; live inspection needs both.

> **Only connect assistants you trust.** A fresh Windows Setup enables reading, administration and Luau execution. Executed code can change the connected client and is not sandboxed. Updates preserve existing permission restrictions. Read the [security guidance](SECURITY.md).

The Windows installer is **unsigned**, so Windows may show a security warning.

## Try asking your assistant

- “Show me the nearby objects and visible UI. Don't change anything.”
- “Save a snapshot of this area so we can compare it later.”
- “Analyze this Luau module and show which functions call each other.”
- “Record these selected objects moving, then summarize their paths.”

What is available depends on the connected client, its capabilities and your configured permissions.

## Updating

Updates are manual: download the newer version's verified Setup and run it using the same Windows account and installation folders after closing active MCP sessions. Choose **Update** when the installation is recognized. Setup installs its embedded, sealed bundle; it does not fetch a newer package automatically. Existing settings and saved data are preserved. Restart your AI app and manually restart/reattach Potassium afterward so the updated bootstrap runs.

Very old, manual or npm installations may need a different migration path. If Setup does not recognize the installation or reports a conflict, **do not delete your configuration to force an update**. See [update and migration guidance](docs/DEPLOYMENT.md#windows-maintenance-and-custom-roots).

## Prefer npm?

For the CLI route, use Node.js 22 or 24. Once 1.1.0 is published:

```sh
npm install --global @mrketa/potassium-mcp@1.1.0
```

Then follow the [CLI setup and connection guide](docs/AGENT-INSTALL.md). The CLI has its own permission setup; it does not automatically enable Windows Setup's full-access defaults.

## More information

- [Agent workflow](docs/API.md#agent-workflow) — using the tools effectively
- [Tool reference](docs/API.md) — available features and their limits
- [Configuration](docs/CONFIGURATION.md) — permissions and connection settings
- [Installation and maintenance](docs/DEPLOYMENT.md) — updates, repair and custom folders
- [Technical package reference](potassium-mcp/README.md) — compatibility, CLI options and implementation details
- [Security](SECURITY.md) · [Apache-2.0 license](LICENSE)

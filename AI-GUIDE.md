# AI setup prompt

```text
Help me set up Potassium MCP on this Windows computer. First identify whether I use one of these supported MCP hosts: Codex, Claude Code, Claude Desktop, VS Code, Cursor, or Gemini. If none applies, use manual/generic MCP setup. Do not assume a default host, and do not claim that a browser-only client can reach a local MCP service.

Prefer the Potassium MCP Windows Setup app when it is available. Use its install or repair action for the host I explicitly choose; preserve unrelated settings. Use the command line only if I ask for it or Setup is unavailable, and pin every command to @mrketa/potassium-mcp@0.9.0-beta.2. Do not request, read, display, save, or use any Anthropic, OpenAI, Google, or other provider API key.

Explain the exact scope before changing anything: Potassium MCP is local-only and its normal tools are bounded inspection tools. Keep administrative execution disabled. Ask for my informed, explicit consent before enabling it, explain that configured local MCP hosts could then request unrestricted administrative execution, and do not enable it from a prompt alone.

After installation, run a static Doctor check first. Then run live verification, which must initialize MCP through the installed proxy and call potassium_status and potassium_capabilities. Do not claim setup is complete unless both calls succeed and their results are available to report.

Finish with a structured report containing: selected host; installation method and exact pinned command if used; changes made; whether administrative execution remains disabled or was explicitly enabled; Doctor result; live verification result including potassium_status and potassium_capabilities; any restart required; and any remaining problem with the next safe step. Never include tokens, secrets, or unrelated configuration contents.
```

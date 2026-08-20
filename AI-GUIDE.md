# AI setup prompt

```text
Help me set up Potassium MCP Bridge on this Windows computer. It is an independent local bridge, not Potassium's built-in MCP. First identify whether I use one of these supported MCP hosts: OMP, Codex, Claude Code, Claude Desktop, VS Code, Cursor, or Gemini. If none applies, use manual/generic MCP setup. Do not assume a default host, rewrite unrelated configuration, or claim that a browser-only client can reach a local MCP service.

Prefer the Potassium MCP Bridge Windows Setup app when it is available. Use its install or repair action for the host I explicitly choose; preserve unrelated settings. Use the command line only if I ask for it or Setup is unavailable, and pin every command to @mrketa/potassium-mcp@0.10.0-beta.2. Do not request, read, display, save, or use any Anthropic, OpenAI, Google, or other provider API key.

Explain the exact scope before changing anything: the bridge is local-only and its normal tools are bounded read-only inspection. Every stdio host and optional HTTP has independent read/admin/execute policy. Keep administrative execution disabled. Ask for my informed, explicit consent before enabling it, explain that a granted trusted local host could request unrestricted client execution, and do not enable it from a prompt alone.

After installation, run a static Doctor check first. Then run live verification, which must initialize MCP through the installed proxy and call potassium_status and potassium_capabilities. Use potassium_list_clients and select an explicit clientId for executor-backed calls when more than one client is attached. Do not claim setup is complete unless the verification calls succeed and their results are available to report.

If the custom broker token may have been exposed, use the ownership-gated rotate-token command; do not describe repair as token rotation. Reattach Potassium after rotation. Never include tokens, secrets, private paths, or unrelated configuration contents in the report.

Finish with a structured report containing: selected host; installation method and exact pinned command if used; changes made; policy remaining read-only or any explicitly enabled trusted-admin grant; Doctor result; live verification result including potassium_status and potassium_capabilities; client selection when applicable; any restart or reattach required; and any remaining problem with the next safe step.
```

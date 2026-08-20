# Security policy

## Threat model

Potassium MCP Bridge is an independent local bridge for one Windows user running local MCP-capable software. Its trust boundary is the local machine and that user's account—not a network service, shared-workstation boundary, browser page, tunnel, remote AI provider, or official Potassium service.

The default transport is authenticated stdio proxies. Optional Streamable HTTP must remain loopback-only and Bearer-authenticated. Do not publish HTTP through a LAN address, reverse proxy, port forwarding, or tunnel. A browser-only client is not an authenticated local MCP host.

Normal tools are bounded inspection tools. They intentionally do not grant broad machine access, arbitrary network access, source access, input control, or remote control. Read-only access is the default. Per-host and HTTP read/admin/execute policies are independent and immutable after installation until an explicit policy-changing repair.

Administrative execution is disabled by default. Enabling the unsafe gate and granting admin or execute policy is a deliberate trust decision: the granted local host may request unrestricted execution in the connected client. Do not grant this to untrusted hosts, profiles, extensions, or prompts. Loopback binding and Bearer authentication do not sandbox submitted code.

Broker recovery resets the local connection transport and does not promise forced cancellation of arbitrary work already running in a connected client. The optional built-in fallback is diagnostic-only at fixed `127.0.0.1:8225`; it never forwards native execution.

## Tokens and local credentials

The installer creates local authentication material and restricts it to the current Windows user. Treat it as a password:

- Never paste it into chat, an issue, screenshot, log, environment variable, or host configuration.
- Never commit it or copy private installation data to shared storage.
- If the custom broker token may be exposed, run `npx --yes @mrketa/potassium-mcp@0.10.0-beta.1 rotate-token`, then restart or reload affected MCP hosts and reattach Potassium. **Repair preserves a valid token and is not credential rotation.**
- Token rotation is ownership-gated and does not rotate a distinct built-in fallback token; rotate that token through Potassium's supported native procedure.
- Keep the Windows account and configured MCP hosts protected; local malware or an untrusted host running as that account is outside this package's ability to distinguish safely.

Potassium MCP Bridge does not require or use Anthropic, OpenAI, Google, or other AI-provider API keys.

## Reporting a vulnerability

A private security-reporting channel is not currently published for this repository. Do not place active vulnerability details, tokens, executable payloads, private machine paths, or artifact contents in a public issue. If a private reporting channel is added, this policy will link to it.

## License notice

This project is licensed under Apache-2.0. Copies and redistributions must comply with the [LICENSE](LICENSE), including applicable license and notice requirements. This summary is informational and is not legal advice.

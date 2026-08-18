# Security policy

## Threat model

Potassium MCP is designed for a single Windows user running local MCP-capable software. Its normal trust boundary is the local machine and the user's account—not a network service, shared workstation boundary, browser page, tunnel, or remote AI provider.

The default MCP transport is stdio. Optional Streamable HTTP must remain loopback-only and authenticated. Do not publish it through a LAN address, reverse proxy, port forwarding, or tunnel. A browser-only client is not an authenticated local MCP host.

Normal tools are bounded inspection tools. They intentionally do not grant broad machine access, arbitrary network access, source access, input control, or remote control. Administrative execution is disabled by default. Enabling it is a deliberate local trust decision: configured local MCP hosts may then request unrestricted administrative execution. Do not enable it for untrusted hosts, profiles, extensions, or prompts.

Broker recovery resets the local connection transport and rejects pending work. It does not forcibly terminate arbitrary work that was already running in the connected client.

## Tokens and local credentials

The installer creates local authentication material and restricts it to the current Windows user. Treat that material as a password:

- Never paste it into a chat, issue, screenshot, log, environment variable, or host configuration.
- Never commit it or copy the installation's private data to shared storage.
- Use Repair to regenerate local credentials if you suspect exposure, then review configured hosts and restart them.
- Keep the Windows account and configured MCP hosts protected; local malware or an untrusted host running as that account is outside this package's ability to distinguish safely.

Potassium MCP does not require or use Anthropic, OpenAI, Google, or other AI-provider API keys.

## Reporting a vulnerability

A private security-reporting channel is not currently published for this repository. Do not place active vulnerability details, tokens, executable payloads, or private machine paths in a public issue. If a private reporting channel is added, this policy will link to it.

## License notice

This project is licensed under Apache-2.0. Copies and redistributions must comply with the [LICENSE](LICENSE), including applicable license and notice requirements. This summary is informational and is not legal advice.

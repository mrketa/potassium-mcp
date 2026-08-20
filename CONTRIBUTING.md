# Contributing

Open an issue before starting a substantial change. Keep Potassium MCP Bridge provider-neutral, local-only, independent from Potassium's built-in MCP, and understandable to Windows users.

Contributions must preserve these product boundaries:

- authenticated local stdio proxies and one shared broker by default;
- bounded read-only inspection as the normal tool surface;
- no provider API-key requirement;
- no default host selection or bulk rewriting of unrelated host configuration;
- explicit `clientId` routing where executor selection is ambiguous;
- immutable, independently configured per-host and HTTP read/admin/execute policy;
- administrative execution disabled unless a user makes an informed, explicit opt-in;
- loopback-only authenticated HTTP, with stateless `/mcp` and bounded optional `/mcp/session`;
- diagnostic-only fixed-port built-in fallback that never forwards native execution; and
- ownership-gated, transactional install, repair, token rotation, and uninstall behavior.

When an observable behavior changes, add focused contract coverage for that behavior and update the relevant user documentation. Do not submit credentials, tokens, private machine paths, executable payloads, private artifacts, unrelated generated artifacts, or changes that turn the package into a remote service.

By contributing, you agree that your contribution is provided under the Apache-2.0 license for this project. Retain required copyright, license, and notice material when copying or redistributing project content; see [LICENSE](LICENSE). This is a contribution policy, not legal advice.

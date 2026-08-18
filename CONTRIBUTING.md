# Contributing

Open an issue before starting a substantial change. Keep the public package provider-neutral, local-only, and understandable to Windows users.

Contributions must preserve these product boundaries:

- standard MCP over local stdio by default;
- bounded inspection as the normal tool surface;
- no provider API-key requirement;
- no default host selection or bulk rewriting of unrelated host configuration;
- administrative execution disabled unless a user makes an informed, explicit opt-in;
- no unauthenticated administrative access through an optional local HTTP transport.

When an observable behavior changes, add focused contract coverage for that behavior and update the relevant user documentation. Do not submit credentials, tokens, private machine paths, executable payloads, unrelated generated artifacts, or changes that turn the package into a remote service.

By contributing, you agree that your contribution is provided under the Apache-2.0 license for this project. Retain required copyright, license, and notice material when copying or redistributing project content; see [LICENSE](LICENSE). This is a contribution policy, not legal advice.

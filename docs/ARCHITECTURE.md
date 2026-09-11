# Architecture

Each MCP host runs the public `potassium-mcp serve --config <absolute-path> --host-id <unique-id>` command, which starts the existing token-free stdio proxy. Proxies authenticate to one per-user broker, which owns one or more mutually authenticated Protocol 2 executor connections over loopback. Callers explicitly select `clientId` when selection is ambiguous. Per executor, the scheduler permits up to four concurrent reads; a mutation waits behind earlier reads and forms a FIFO barrier before later work.

The stdio proxy owns socket error/close events continuously from connection creation through authentication and the forwarding handoff. Authentication installs its message handler before hello/ACK sends, checks terminal socket state, and preserves send/receive failures rather than leaving an unhandled-event gap between promises. Stdin remains unread until authentication and its sends complete. Invalid credentials or protocol frames fail closed; this is not reconnect/replay logic and does not increase configured phase deadlines.

If startup finishes after the socket has entered `CLOSING`, the proxy uses the existing shutdown-grace timer without consuming or forwarding queued stdin. Normal authenticated `OPEN` forwarding and its backpressure behavior are unchanged.

The executor bootstrap connects only to the configured loopback endpoint. Unauthenticated connection cycles fail closed after 10 seconds. Heartbeats detect stale sessions, reconnects retain client identity without replaying indeterminate mutations, and late responses are isolated from newer requests.

The default tools inspect bounded Roblox metadata, instances, properties, tags, logs, performance, and configured artifacts/traces/HTTPS hosts. Responses are bounded and redacted. Gameplay automation and generic filesystem/source/bytecode/hook access remain absent. Explicit trusted-admin execution is separately gated by global enablement and immutable per-host or HTTP policy.

npm owns package installation/update/removal. Hostless setup owns private configuration, credential evidence, and bootstrap deployment outside package/cache directories. Optional host adapters own only proven registrations; `config print` is read-only. A custom wrapper or unproven junction is a migration conflict, not authorization to replace user-managed files.

Read/admin/execute are independent policy axes; only execution needs the global unsafe gate. Host IDs identify trusted launcher policy, not adversarial identities: shared-token holders can claim other known IDs. Authentication is not a sandbox. Accepted async jobs may survive transport reconnect in one generation, but submission loss after send is indeterminate and must not trigger automatic replay. Running cancellation and transport reset cannot forcibly terminate arbitrary Luau.

The broker can additionally expose authenticated stateless `/mcp` and bounded stateful `/mcp/session` transports on loopback. Large async terminal envelopes may become bounded artifacts. Potassium's native MCP is independent; the optional fixed-port integration exposes only diagnostic status, client listing, and console reads.

MCP remains the SDK `1.30.0` legacy handshake epoch (newest negotiable revision `2025-11-25`, missing HTTP header fallback `2025-03-26`). This is separate from executor Protocol 2 and feature versions. No `2026-07-28` handshake-free, legacy HTTP+SSE endpoint, event-store replay, or standard MCP Tasks capability is claimed.

Generation-local references have explicit release and no TTL. A one-second lifecycle sweep handles active watch expiry and terminal-watch pruning. Terminal jobs and idle HTTP sessions are pruned lazily on relevant operations; artifact cleanup is activity-driven too. Isolated fixtures model engine services and cannot qualify real Roblox signal/destruction/scheduler behavior, real-time cleanup under stalls, or non-cooperative execution.

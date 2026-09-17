# Changelog

## 1.1.0

This section describes the selected release source. Availability and exact artifact qualification are established by the published release and its receipts, not by this changelog.

### Added

- Six opt-in native desktop editor tools: list tab metadata, read exact text and its UTF-8 SHA-256, open a draft, replace text with a hash precondition, activate a tab, and close a clean tab. They work without Roblox or an attached bootstrap. Text is limited to 256 KiB of UTF-8; known configured credential echoes are refused rather than silently altered, and raw editor source is not written to execution logs.
- Independent native editor credential configuration through `--native-editor-token-file`, with `--no-native-editor` to disable it. Editor integration remains off by default. List/read require read permission; mutations require the caller's existing execute permission and `allowUnsafeExecute`. Opt-in does not grant execution or change other host/HTTP permissions, diagnostic fallback, or existing synchronous/asynchronous Luau access.
- Read-gated interaction inventory with summary, rows, detail, and release views for ClickDetectors, ProximityPrompts, and observed TouchTransmitters. Bounded retained snapshots preserve original coverage, observation time, and query-bound pagination. Touch discovery is non-exhaustive; touch actions select explicit host BaseParts.
- One typed click, prompt, or boolean-touch dispatch through the existing serialized async job lifecycle. Exact queued object identities are rechecked without same-path rebinding. Queued cancellation prevents dispatch; cancellation after dispatch preserves the eventual outcome. Bootstrap build `lifecycle-6` advertises `interactionInventory` v1 and `interactionActions` v1.

### Boundaries

- Editor writes are serialized per tab within the broker, but the hash precondition is best-effort, not atomic against native UI or external edits. Dirty tabs are not force-closed, editor text is not executed, and uncertain mutations are never automatically replayed.
- Touch forwards the documented boolean unchanged. A successful interaction job reports native dispatch with `serverAcknowledged: false`, not gameplay success, begin/end phases, exactly one event, or a server acknowledgement. Owned-fixture observations do not establish universal native semantics.
- Existing installation ownership, ACL preservation, rollback, safe packaged defaults, and retained permissions remain in force. Only genuinely fresh Windows Setup state receives its existing generic-agent full-access defaults. Package updates do not replace an already running bootstrap; use the documented manual maintenance and reattach path.

## Historical 1.0.0 Windows maintenance

- Windows Setup preserves the original affected path and concrete native ACL failure details, including UTF-8 error text and readable native line breaks. Administrator guidance is limited to positively identified ACL access/privilege failures; process-start, module, and unknown failures do not trigger it. Ownership checks, ACL preservation, and rollback protections remain unchanged. This Windows maintenance rebuild is separate from the original npm 1.0.0 package and release tag.
- Release verification queries only the selected package's collaborators and requires the authenticated actor's reported read-write access. Authentication, package-permission, and registry-query failures retain only fixed categories and allowlisted provider codes, without credential or unrelated inventory disclosure. No authorization fallback or permission relaxation was added.

## 1.0.0

- Published the standalone MCP package and unsigned Windows Setup distribution with installation ownership, preserved configuration and permissions, bounded inspection, shared snapshots/maps/recordings, supplied-source Luau analysis, and explicit execution controls.
- Historical qualification belongs to its exact artifacts; it is not qualification of 1.1.0 or a later rebuild. The original technical records remain in the [public 1.0.0 archive](https://github.com/mrketa/potassium-mcp/tree/5677385f169c24c87f8879e72bb8f5beee86f0d6/release-evidence/v1.0.0).

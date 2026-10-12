# Proposal: a sandbox-safe CLI -> plugin message channel (and worker -> panel data push)

## Motivation

Pacer is a budget-aware delegation CLI. It wants to show live budget and task state in an Orca panel and react to CLI-side events. Orca's current plugin event contribution supports only `worktree.created`, `worktree.removed`, and `agent.status.changed` (`plugin-manifest.js`, `plugin-events.js`; F2, F5), and there is no CLI-to-plugin channel (F12).

## What exists today

- The event set is closed to `worktree.created`, `worktree.removed`, and `agent.status.changed` (`plugin-manifest.js`, `plugin-events.js`; F2, F5).
- The capability set is closed to `workspace:read`, `terminal:send`, `notifications:show`, `storage`, `secrets`, `events:subscribe`, and `settings:own`. The source notes that scoped kinds such as `net:fetch` and `process:exec` arrive in later phases (`plugin-capabilities.js`; F3).
- Panels run in a sandboxed `srcdoc` iframe with CSP `connect-src 'none'`; there is no host-to-panel or worker-to-panel data push (`plugin-panel-shell.js`, `plugin-panel-bridge.js`; F8).
- Plugin storage is backed by `storage.json`, and each `get` reads the file synchronously from disk (`app.asar`; F10).

## Pacer's current workarounds

- **Worker loopback HTTP:** Orca workers run as normal processes with full file, network, and process access, so pacer can use loopback HTTP today (`PluginConsentDialog.warning`, `main/plugin-host-entry.js`; F7). This is fragile because it depends on a local server being available and creates an ad hoc transport that Orca cannot authorize or route as a plugin message.
- **Writing the plugin's `storage.json`:** Orca reads plugin storage from disk on each call (`app.asar`; F10). Directly writing the file bypasses the host API's mediation and depends on Orca's on-disk layout and file behavior remaining stable.
- **Rewriting the development panel HTML:** Orca rereads a development plugin's panel entry from disk each time the panel opens, and development plugins have no content hash check (`plugin-panel-shell.js`, `plugin-consent-fingerprint.js`; F9). Rewriting the panel file works as a snapshot workaround, but it depends on development-path behavior and only appears after the panel is opened again.

## Proposal A: CLI-to-plugin channel

Add a CLI command:

```text
orca plugin send <publisher.id> --data <json> [--json]
```

Route the command over Orca's existing authenticated runtime RPC. Add the `plugin.message` event with payload:

```ts
{
  data: unknown; // JSON, at most 64 KiB
  sentAt: number;
  source: "cli";
}
```

Deliver each message only to the named plugin, and only when that plugin subscribes and has consent. Gate delivery on `events:subscribe`, or add a dedicated `messages:receive` capability. Apply a rate limit such as 30 messages per 10 seconds per plugin, make the channel discoverable through `orca agent-context`, and omit a reply channel in v1. Orca currently has a closed event set and capability set, so this proposal requires additive API support (`plugin-manifest.js`, `plugin-capabilities.js`; F2, F3, F12).

## Proposal B: worker-to-panel push

Add a worker-only host method:

```ts
panel.postMessage({ panelId, data })
```

Deliver `{ type: "orca-panel-message", data }` to open panel frames belonging to the same plugin. Apply the same 64 KiB payload limit and 30 messages per 10 seconds per plugin rate limit proposed for the CLI channel. Keep panels at `connect-src 'none'`; the panel receives data through the host bridge and gains no network access (`plugin-panel-shell.js`, `plugin-panel-bridge.js`; F8).

## Proposal C: agent profile contribution

Document the `contributes.agents` profile format, or remove the contribution until Orca consumes it. The manifest accepts agent profile paths, but Orca 1.4.224 has no consumer or defined profile format (`plugin-manifest.js`; F1, F13).

## Security considerations

- Enforce the 64 KiB JSON payload limit and per-plugin rate caps on both channels.
- Require plugin consent and an explicit subscription or receive capability before delivery.
- No new network capability is needed; the proposed channel uses authenticated runtime RPC and the panel continues to have `connect-src 'none'` (`plugin-capabilities.js`, `plugin-panel-shell.js`; F3, F8).
- Validate payloads with zod schemas, following the existing event schema approach in `plugin-events.js` (F5).

## Compatibility

This is additive within `pluginApi: 1`, which is currently marked experimental (`plugin-manifest.js`; F1). Pacer detects Proposal A through `orca agent-context`, while the plugin detects availability through successful `events.subscribe` (`plugin-host-api.js`; F4, F12).

---

Draft for the user's review. Not posted.

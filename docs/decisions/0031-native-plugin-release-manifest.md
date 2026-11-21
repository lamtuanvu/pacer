# ADR 0031 — Native plugin entries in the CLI release manifest

Date: 2026-11-21

Status: Accepted

Source: Deferred S4 from [PR #1153](https://github.com/lamtuanvu/pacer/pull/1153); [assistant backends design](../specs/2026-11-17-assistant-backends-design.md) decision 1; [ADR 0028](0028-assistant-backends.md).

## Context

`assistant-pacer` ships as a native binary (`pacer-assistant-pacer`) next to `pacer-core`. The CLI
manifest's `companions` array only admits `pacer-core`; older updaters reject any other companion
name. Releases already listed the assistant in `SHA256SUMS` and in npm/desktop packages, but
`pacer update` never installed or refreshed it.

## Decision

Each release asset may include an optional `nativePlugins` array:

```json
"nativePlugins": [{ "name": "pacer-assistant-pacer", "file": "pacer-assistant-pacer-<os>-<arch>", "sha256": "...", "size": 123 }]
```

- Pre-S4 updaters ignore unknown asset fields, so they keep working.
- `companions` remains `pacer-core` only.
- New updaters download, SHA256-verify (against both the field and `SHA256SUMS`), sign on the same
  path as `pacer-core`, and install atomically beside it during `update.apply`.
- Self-repair restores a missing or stale assistant when the release lists one; its reported
  version must match the installed front door.
- The host refuses a sibling whose `--version` does not match pacer, showing the same neutral
  Settings state as a missing sibling.

## Consequences

- CLI installs stay current with the native assistant without a separate package step.
- Adding another native bundled plugin later means extending the allowed `name` set in the same field.

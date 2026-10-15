# Orca panel commands decision — 2026-10-14

Status: accepted for protocol v2 migration; human live verification pending.
Source: `docs/specs/2026-10-14-core-contract-design.md`, section 5, on branch
`docs/remote-runners-design`, and the panel restrictions recorded in the
[earlier transport decision](2026-10-12-orca-link-transport.md).
This record supersedes that decision's transport priority and restrictions on
worker subprocesses and API operations; it does not claim a new live probe.

## Context

Orca host API v0 exposes only `workspace.readContext`, `terminal.sendText` and
`notifications.show` to panels. A panel cannot call its plugin worker or read
plugin storage. The worker can use the v2 API, but panel buttons still need a
host action that reaches a command handler.

## Decisions

- **D1. Worker reads through the v2 API:** use HTTP when `pacer serve` is
  running, otherwise spawn a `pacer api --stdio` child. Both transports carry
  the same protocol. Automatic transport selection tries `api`, then the
  legacy `http`, `channel` and `bridge` transports.
- **D2. Panel commands keep using the console:** buttons send a
  `: pacer '<json>'` line through `terminal.sendText` to a pacer console in the
  worktree. Commands in the shared mapping execute as v2 operations; other
  console commands retain their existing handlers.
- **D3. Deprecate bridge and channel:** the storage bridge and
  `orca plugin send` channel keep working for this release and are scheduled
  for removal in the next minor release.

## Consequences

- Panel buttons still need a pacer console in the worktree, with a live console
  registration. Moving worker reads to the API does not remove that requirement.
- Mapped commands have one execution path through operations across the CLI,
  dashboard and console, including commands sent by the panel.
- The worker can read state without a daemon by owning a stdio child; terminal
  text remains the panel's command transport during this migration.

## Revisit when

Orca exposes a panel-to-worker call. The proposed
[`plugin.invokeCommand`](../upstream/orca-panel-worker-call.md) action would let
panel buttons invoke registered worker commands and retire terminal-text
injection as a command transport.

# Orca plugin information-only decision — 2026-10-15

> Historical context: protocol 3.0 retired the v1 Orca link, storage bridge, channel sends, console command lines and unversioned read routes on 2026-10-18. The owner waived the release gate; `/v2` remains for one more pacer minor release. See [current protocol](../protocol.md).

Status: accepted; human live verification pending.
Source: the owner's request for an information-only plugin and a proper pacer
app as the place to act, following the client direction in the
[core contract design](../specs/2026-10-14-core-contract-design.md).
This record supersedes D2 of the
[panel commands decision](2026-10-14-orca-panel-commands.md); read transports
and their deprecation schedule remain unchanged. It does not claim a new live
probe.

## Context

The interactive Orca panel has three recurring problems:

- It resets to home on each rewrite: the sandboxed iframe cannot use
  sessionStorage, and Orca re-keys the frame for each document revision.
- Buttons fail outside the console's worktree because `terminal.sendText` is
  limited to the active worktree.
- Stray `pacer console` processes accumulate; 19 were found on one Mac.

The owner wants a proper pacer app as the place to delegate, review, block
executors and change settings. Until that app ships, `pacer dashboard` provides
those actions.

## Decisions

- **D1. The panel is read-only:** one scrolling status page shows budgets,
  tasks, alerts, versions and setup instructions. It has no buttons, inputs
  or executable scripts; commands are selectable text. Times are absolute,
  and `panel/live.html` is written only when the rendered HTML changes.
- **D2. The worker never starts or contacts consoles:** remove terminal-text
  sends, console open/forget requests and console-related event subscriptions.
  The old `autoConsole` setting is ignored. Read transports, alert
  notifications and update checks remain.
- **D3. "pacer: Open" points to where to act:** it is the only plugin command
  and shows a notification directing users to run `pacer dashboard` in a
  terminal until the app ships.
- **D4. The installer is unchanged:** marketplace bootstrap still installs
  pacer and starts setup or the dashboard through its own CLI terminal
  creation. The worker does not use `terminal.sendText`.

## Consequences

- Acting requires `pacer dashboard` until the pacer app ships; the Orca panel
  provides information and copyable commands.
- `pacer console` is deprecated but remains available for one release.
- The panel no longer depends on a console in the active worktree, and the
  worker no longer accumulates console processes.

## Revisit when

The pacer app ships: "pacer: Open" opens it.

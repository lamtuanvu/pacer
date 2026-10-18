<!-- New issue, template: Feature request -->

> Historical context: protocol 3.0 retired the v1 Orca link, storage bridge, channel sends, console command lines and unversioned read routes on 2026-10-18. The owner waived the release gate; `/v2` remains for one more pacer minor release. See [current protocol](../../protocol.md).
<!-- Title: [Feature]: Let a plugin create terminals and send text to terminals it created, in any worktree -->
<!-- Status: draft for review. Not posted. -->

### Problem or use case

**Summary:** `terminal.sendText` only accepts terminals in the active worktree, and a plugin cannot create a terminal. A plugin that needs a long-running helper process per worktree has to rely on something outside Orca to start it, and loses contact with it as soon as the user focuses another worktree.

I build pacer, a local tool that paces AI subscriptions and delegates work between agents. Its plugin panel sends commands into a small pacer "console" running in a terminal. Verified on Orca 1.4.224:

- The host rejects `terminal.sendText` for any terminal outside the active worktree (`"terminal is outside the active worktree"`). A console started in one worktree is unreachable from the panel as soon as the user switches worktrees.
- The plugin API has no way to create a terminal. pacer runs a local service that calls `orca terminal create --worktree <id> --command "pacer console"` whenever the user focuses a worktree that has no console. That puts a pacer tab in every worktree the user visits.

### Proposed solution

Either of these would remove the workaround:

1. **`terminal.create` in the plugin host API** (worker side, behind a capability such as `terminal:create`). It would take a worktree, a title and a command from the plugin's manifest, and return the handle. Terminals created this way would be **owned by the plugin**.
2. **Allow `terminal.sendText` to plugin-owned terminals in any worktree.** The active-worktree rule makes sense for terminals the user created, and it could stay. A terminal the plugin itself created holds the plugin's own process, so sending to it does not reach into the user's shells.

With both, a plugin could keep one helper terminal (or even a hidden one) instead of one per worktree.

### Alternatives or additional context

- A panel -> worker message channel (#25129) would make the helper terminal unnecessary for my case altogether. This request is for plugins that still need a terminal-hosted process.
- Related: #18214 (exec action).
- Today's workaround needs a separate always-on service just to open terminals on the plugin's behalf, plus heartbeats and clean-up when worktrees are deleted.

### Operating system

macOS

### Orca version

1.4.224

<!-- Comment for https://github.com/stablyai/orca/issues/25129 -->
<!-- Status: draft for review. Not posted. -->

Another concrete case for this, with what it costs today.

I build **pacer**, a local tool that paces several AI subscriptions (Claude, Codex, Cursor, others) and delegates work between them. Its Orca plugin has a budget panel with a few actions: Delegate a task, Switch strategy, Retry a failed task, and Start an agent session that builds a new strategy. Every one of them is something the plugin's worker could do directly, but the panel has no way to tell the worker.

Today, verified against Orca 1.4.224, the only route from a panel to anything is `terminal.sendText`, and the host refuses any terminal outside the **active** worktree (`"terminal is outside the active worktree"`). So pacer has to:

1. Run a small "console" process in a terminal **in every worktree** the user visits, and have the panel type a one-line command into it (`: pacer '<json>'`, a shell no-op if it ever lands in the wrong place).
2. Keep that console alive and discoverable: a heartbeat file, a registry of consoles per worktree, clean-up when a worktree is deleted, and re-registration after updates.
3. Run a local service that opens those consoles automatically when the user focuses a worktree, because the panel cannot open a terminal either.
4. Guard every click against typing into a terminal whose console has died, since the panel only knows what was true when its HTML was written.

All of that exists only because the panel cannot send one message to its own worker. A `panel -> worker` message (or the declared-loopback-origin option in this issue) would replace steps 1 to 4 with a single call.

Two smaller observations from building this, in case they help scope it:

- The worker already has full Node, so the worker side of any channel is easy. The missing half is the panel's way in.
- A CLI -> plugin channel (for example `orca plugin send <plugin> <json>` delivered as a plugin event) would cover the reverse direction for tools whose logic lives outside Orca. It could be the same channel.

Happy to test a build or a branch against pacer's plugin.

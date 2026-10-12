# pacer Orca plugin

This dependency-free plugin targets Orca >=1.4.224 and pluginApi 1. Build it with
`bun run plugin:build`; the committed `dist/` worker runs in Electron's Node,
without Bun at runtime. The generated assets are consumed by `pacer plugin install`.

Add the pacer-managed development directory printed by `pacer plugin install`
to Orca Settings > Plugins, enable the plugin system and grant the six declared
capabilities. Do not add `dist/` as an installed, integrity-checked copy: only a
managed development path with `.pacer-managed` allows the worker to update
`panel/live.html`. Orca settings and installed plugin trees are never edited.

Transport selection is HTTP on loopback (default port 4317, bearer token read
from `<pacerHome>/token`), a future `plugin.message` channel, then the storage
bridge. The channel is unavailable in current Orca and is probed safely.
Settings are `transport` (`auto`, `http`, `channel`, `bridge`), `port`,
`autoConsole` (default true), `pacerHome` (default `~/.pacer`), `pollSeconds` (5–300, default 10), and the
persisted `lastAlertAt` watermark. Orca filters `PACER_HOME` out of worker env;
set the plugin's `pacerHome` setting for a custom location.

With `pacer serve` running, the HTTP worker checks the active worktree every five
seconds and opens its own pacer console automatically. Orca 1.4.224 only accepts
terminal typing in the active worktree, so each worktree needs a console.
Use `pacer plugin set autoConsole off` (or `on`) and reload the plugin to change
this default; bridge/channel transports never open consoles. The panel shows
“Starting pacer console in this worktree...” while connected with autoConsole on;
otherwise “Start console” types `pacer console` with `enter:false` for you to run.

Serve retains its GET routes and adds one token-gated `POST /console/open`, with
JSON bodies capped at 4 KiB and validated terminal/branch selectors. It refuses
worktrees with a live console, limits opens to one per worktree per minute and
ten per hour overall, and creates a terminal without focusing it. The command
comes only from pacer's own executable argv; each open emits an info alert.

Manual fallback: run `pacer console --open` to enable Delegate and Switch strategy. Commands
use only the console's advertised terminal handle while its heartbeat is at
most 30 seconds old. Their `: pacer '<json>'` lines are inert in a POSIX shell.
Open console reports whether a console is running; it does not spawn a process.

The budget panel is a snapshot. Reopen it to refresh; alerts arrive through
Orca notifications. PluginApi 1 provides no push to an open panel. The worker
uses only loopback HTTP, token reads, and atomic writes to the managed panel.
No agent profiles, keybindings, subprocesses, external URLs, or dependencies
are included. Live verification is tracked by the separate spike checklist.

Run `bun run test && bun run typecheck` and `bunx tsc --noEmit -p orca-plugin`
after changes. Bundle freshness tests require rebuilding generated artifacts.

Execution defaults to `child-of-current`, using the current branch under the owning Orca project. An explicit `execution.base_branch` without `execution.worktree` preserves `new-child` placement from that branch; set `worktree` explicitly to override it.

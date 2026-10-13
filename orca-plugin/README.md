# pacer Orca plugin

Planner setup uses the [pacer CLI and installed skill](../docs/cli.md); MCP is optional.

This dependency-free plugin targets Orca >=1.4.224 and pluginApi 1. Build it with
`bun run plugin:build`; the committed `dist/` worker runs in Electron's Node,
without Bun at runtime. The generated assets are consumed by `pacer plugin install`.

Install the pacer CLI too: the plugin talks to the CLI's local service (`pacer serve`).
In Orca Settings > Plugins, add marketplace source URL
`https://github.com/lamtuanvu/pacer.git` with ref `main`, then install **pacer**
(`lamtuanvu.pacer`) and grant its declared capabilities. For a direct versioned
install, use `https://github.com/lamtuanvu/pacer.git#orca-plugin-v0.1.14`, replacing
the version with the release you want. Releases publish a root-level bundle on
the `orca-plugin` branch, with immutable `orca-plugin-v<version>` tags.

For local development, run `pacer plugin install`, add the pacer-managed
development directory it prints to Orca Settings > Plugins, enable the plugin
system and grant the six declared capabilities. Reinstalling migrates an older
`pacer.pacer` development install in place and clears its old storage bridge;
reload and enable `lamtuanvu.pacer` in Orca. `pacer plugin status` detects older
installs, and `pacer plugin uninstall` can remove either tracked identity.
Orca settings and installed plugin trees are never edited by these CLI commands.

Transport selection is HTTP on loopback (default port 4317, bearer token read
from `<pacerHome>/token`), a future `plugin.message` channel, then the storage
bridge. The channel is unavailable in current Orca and is probed safely.
Settings are `transport` (`auto`, `http`, `channel`, `bridge`), `port`,
`autoConsole` (default true), `pacerHome` (default `~/.pacer`), `pollSeconds` (5–300, default 10), and the
persisted `lastAlertAt` watermark. Orca filters `PACER_HOME` out of worker env;
set the plugin's `pacerHome` setting for a custom location.

With `pacer serve` running, the HTTP worker checks the active worktree every five
seconds and opens its own pacer console automatically.
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

## Known limitations (Orca pluginApi 1, verified on Orca 1.4.224)

| Limitation | What pacer does today | Upstream |
| --- | --- | --- |
| No panel → worker messaging | Panel buttons type shell-inert commands into a pacer console with a fresh heartbeat; each worktree needs its own console. The prospective channel transport is probed safely but unavailable. | [#25129 comment](https://github.com/stablyai/orca/issues/25129#issuecomment-6126817756) |
| `terminal.sendText` only reaches the active worktree; plugins cannot create terminals | The HTTP service opens a console in the focused worktree. Commands only target a console whose heartbeat is at most 30 seconds old. Manual fallback remains `pacer console --open`. | [#28008](https://github.com/stablyai/orca/issues/28008) |
| No worker → panel push | The panel is a snapshot: reopen it to refresh. Only a managed development path marked `.pacer-managed` permits `panel/live.html` rewrites when visible content changes. Marketplace and direct installed copies retain the bundled placeholder and have no live panel; worker commands and notifications still run. | [#26951 comment](https://github.com/stablyai/orca/issues/26951#issuecomment-6126818405), related [#15638](https://github.com/stablyai/orca/issues/15638) |
| Forms do not submit inside panels | Use `type="button"` controls and click handlers, with Enter handled in script. Native form submission and validation cannot be relied on. | [#28009](https://github.com/stablyai/orca/issues/28009) |
| No plugin exec / declared command API | Route panel actions through the terminal console and local service rather than executing a subprocess from the plugin. | [#18214 comment](https://github.com/stablyai/orca/issues/18214#issuecomment-6126819013) |

The worker uses loopback HTTP, token reads and atomic writes to the managed panel. It includes no agent profiles, keybindings, subprocesses, external URLs or dependencies. See the [upstream evidence](../docs/upstream/orca/README.md) and [roadmap](../ROADMAP.md) for the API changes that would remove these workarounds.

Run `bun run test && bun run typecheck` and `bunx tsc --noEmit -p orca-plugin`
after changes. Bundle freshness tests require rebuilding generated artifacts.

Execution defaults to `child-of-current`, using the current branch under the owning Orca project. An explicit `execution.base_branch` without `execution.worktree` preserves `new-child` placement from that branch; set `worktree` explicitly to override it.

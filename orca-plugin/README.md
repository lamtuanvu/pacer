# pacer Orca plugin

Planner setup uses the [pacer CLI and installed skill](../docs/cli.md); MCP is optional.

This dependency-free plugin targets Orca >=1.4.224 and pluginApi 1. Build it with
`bun run plugin:build`; the committed `dist/` worker runs in Electron's Node,
without Bun at runtime. The generated assets are consumed by `pacer plugin install`.

The marketplace plugin bootstraps pacer. It opens a live terminal dashboard and prepares the optional development folder.
In Orca Settings > Plugins, add marketplace source URL
`https://github.com/lamtuanvu/pacer.git` with ref `main`, then install **pacer**
(`lamtuanvu.pacer`) and grant its declared capabilities. For a direct versioned
install, use `https://github.com/lamtuanvu/pacer.git#orca-plugin-v0.1.22`, replacing
the version with the release you want. Releases publish a root-level bundle on
the `orca-plugin` branch, with immutable `orca-plugin-v<version>` tags.

The worker installs or updates the checksum-verified binary, then opens one
**pacer** terminal per Orca app PID in the focused worktree. It runs `pacer init`
when the strategy or login service is missing, otherwise `pacer dashboard`.
No focus means a retry in 30 seconds without a reserved launch. Reservations
survive worker restarts and closing the tab. Run `pacer init` manually to resume.
The worker never runs init or installs a service itself.

The static marketplace panel shows an installation spinner and manual setup
commands. It makes no host calls and never rewrites the verified marketplace
folder. `pacer init` prepares `~/.pacer/orca-plugin`, prompts separately before
changing each agent's files, and guides you to add the folder under Orca
Settings > Plugins > Development. It waits for the live heartbeat for up to five
minutes; Enter or Ctrl-C skips. Rerunning init completes remaining steps.

The development folder has a JSON `.pacer-managed` marker (`version`,
`installedAt`). Its worker writes `~/.pacer/plugin-live.json` on start and every
30 seconds and removes its own heartbeat on stop. A heartbeat younger than 90
seconds makes the marketplace worker dormant, with one notification per version
suggesting removal of the marketplace copy in Orca Settings. Pacer cannot
register a development folder or disable a plugin automatically.

While the repository is private, GitHub releases may return 404. Set **releaseBase**
in the plugin's own settings to a release folder, such as
`file:///path/to/releases`, `https://host/pacer/releases`, or
`http://127.0.0.1:8080/releases`. `PACER_RELEASE_BASE` is the fallback override.
The folder contains `latest.json`, `<version>/SHA256SUMS` and
`<version>/pacer-<os>-<arch>`; the plugin installs its own version.
Only HTTPS redirects are followed, at most five. Failure retries are bounded;
404 downloads show one friendly notification in bootstrap mode and retry on the next ten-minute cycle. Other failures retry after
60 seconds, with at most five quick attempts per hour. **Try again** refreshes
local feedback; it cannot signal the worker through the panel sandbox.
Manual install:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
```

For local development, run `pacer plugin install`, add the pacer-managed
development directory it prints to Orca Settings > Plugins, enable the plugin
system and grant the six declared capabilities. Reinstalling migrates an older
`pacer.pacer` development install in place;
reload and enable `lamtuanvu.pacer` in Orca. `pacer plugin status` detects older
installs, and `pacer plugin uninstall` can remove either tracked identity.
Orca settings and installed plugin trees are never edited by these CLI commands.

After the development-folder handoff, transport selection is HTTP on loopback (default port 4317, bearer token read
from `<pacerHome>/token`), a future `plugin.message` channel, then the storage
bridge. The channel is unavailable in current Orca and is probed safely.
Settings include `releaseBase` (optional release folder), `transport` (`auto`, `http`, `channel`, `bridge`), `port`,
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
| `terminal.sendText` only reaches the active worktree; the Node worker can create terminals through the Orca CLI | The HTTP service opens a console in the focused worktree. Commands only target a console whose heartbeat is at most 30 seconds old. Manual fallback remains `pacer console --open`. | [#28008](https://github.com/stablyai/orca/issues/28008) |
| No worker → panel push | Marketplace panels stay static and hand off to a managed development folder. Only that folder rewrites `panel/live.html`; reopen to refresh. | [#26951 comment](https://github.com/stablyai/orca/issues/26951#issuecomment-6126818405), related [#15638](https://github.com/stablyai/orca/issues/15638) |
| Forms do not submit inside panels | Use `type="button"` controls and click handlers, with Enter handled in script. Native form submission and validation cannot be relied on. | [#28009](https://github.com/stablyai/orca/issues/28009) |
| No plugin exec / declared command API | Panel actions use terminal IPC; the Node worker uses execFile for its own bootstrap and terminal preparation. | [#18214 comment](https://github.com/stablyai/orca/issues/18214#issuecomment-6126819013) |

The worker uses loopback HTTP, token reads, atomic writes only to its managed development panel, verified release downloads and execFile without a shell. It never edits agent configs automatically. See the [upstream evidence](../docs/upstream/orca/README.md) and [roadmap](../ROADMAP.md) for the API changes that would remove these workarounds.

Run `bun run test && bun run typecheck` and `bunx tsc --noEmit -p orca-plugin`
after changes. Bundle freshness tests require rebuilding generated artifacts.

Execution defaults to `child-of-current`, using the current branch under the owning Orca project. An explicit `execution.base_branch` without `execution.worktree` preserves `new-child` placement from that branch; set `worktree` explicitly to override it.

Update availability is checked on plugin startup and every six hours, with one
notification per new version. Marketplace: Orca Settings > Plugins > Refresh,
then Update plugin. Development folder: use the live panel's Updates card or
`pacer update`, then turn pacer off and on in Orca Settings > Plugins; if only the
plugin is behind the CLI, run `pacer plugin install` first. `pacer update --check
--json` reports versions without installing. Disable checks with
`PACER_NO_UPDATE_CHECK=1` or top-level `update_check: false` in the active strategy.
Checks only GET `latest.json`, time out after three seconds, and cache in
`~/.pacer/update-check.json`; CLI cache reuse lasts 24 hours. The static marketplace
panel has no update buttons or host calls, and the worker never installs a newer
release than the version shipped with its plugin.

## Setup flow

On install/enable the marketplace worker opens `pacer init` in the focused
worktree, or `pacer dashboard` if strategy and login service are already set up.
It opens once per Orca launch. Run `pacer init` manually to resume setup and
choose any supported planner; agent files change only after consent.

Init prepares the managed development folder and guides you to add and enable
it in Orca Settings > Plugins > Development. Its live heartbeat makes the
marketplace worker dormant; uninstall the marketplace copy through Settings.
Before publishing, run the [real-Orca bootstrap harness](../docs/testing/orca-e2e.md).

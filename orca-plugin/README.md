# pacer Orca plugin

Planner setup uses the [pacer CLI and installed skill](../docs/cli.md); MCP is optional.

This dependency-free plugin targets Orca >=1.4.224 and pluginApi 1. Build it with
`bun run plugin:build`; the committed `dist/` worker runs in Electron's Node,
without Bun at runtime. The generated assets are consumed by `pacer plugin install`.

The marketplace plugin bootstraps pacer. It prepares the development folder and sends a ready notification.
In Orca Settings > Plugins, add marketplace source URL
`https://github.com/lamtuanvu/pacer.git` with ref `main`, then install **pacer**
(`lamtuanvu.pacer`) and grant its declared capabilities. For a direct versioned
install, use `https://github.com/lamtuanvu/pacer.git#orca-plugin-v0.1.17`, replacing
the version with the release you want. Releases publish a root-level bundle on
the `orca-plugin` branch, with immutable `orca-plugin-v<version>` tags.

The worker runs `pacer plugin install` once per plugin version. When the ready
notification appears, in Orca Settings > Plugins:

1. Uninstall the marketplace pacer.
2. Under **Development**, add the absolute folder shown in the notification
   (normally `~/.pacer/orca-plugin`).
3. Enable pacer.

Orca only refreshes plugin panels added as a development folder, so the live
budget panel runs from there. Marketplace content is integrity checked and must
never be rewritten: [Orca #26951](https://github.com/stablyai/orca/issues/26951).
pacer never edits Orca settings to perform the handoff. The marketplace panel
stays static; the worker sends persisted progress notifications and prepares
`~/.pacer/orca-plugin` itself. Bootstrap mode does not create terminals or consoles.

The development folder has a JSON `.pacer-managed` marker (`version`,
`installedAt`). Without it the worker stays in bootstrap mode and never mutates
its plugin root. The marker is excluded from published bundles. The development
panel retains the live checklist and **Connect my agents**.

The worker installs only pacer's own binary (`~/.local/bin/pacer`), strategy
(`~/.pacer`) and login service automatically. It checks on activation and every
ten minutes, updates older releases to the plugin version, and never downgrades
newer or development builds. Downloads require a matching SHA-256 checksum.
Connecting agents is separate consent: the panel previews detected CLIs and the
files it will change, then your click runs `pacer setup --yes` in a writable
terminal in the active worktree. Skills, rules and hooks are installed; no MCP
servers are added. The manifest tracks connections and `pacer uninstall <agent>`
undoes each integration.

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

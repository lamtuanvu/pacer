# pacer desktop (U2)

An unsigned macOS Tauri v2 shell. Install the pacer CLI separately. The window
loads the existing web UI from the local service; only recovery screens are
bundled here. Closing the window keeps the native tray client running. Quit
from the tray to exit; the Dock icon or Open pacer restores the window.

## Build

Requires macOS, Xcode Command Line Tools, Rust 1.99.0 (pinned in
`src-tauri/rust-toolchain.toml`) and Bun. From this folder:

```sh
bun install --frozen-lockfile
cd src-tauri
cargo build --offline
cargo test --offline
cd ..
CARGO_NET_OFFLINE=true bunx tauri build --bundles app --no-sign
```

Offline builds require the locked crates and Bun packages to be cached first.
The app is at `src-tauri/target/release/bundle/macos/pacer.app`. The manual
`desktop.yml` workflow fetches the locked dependencies, tests and builds offline,
then uploads a zipped unsigned app. It does not publish a release. This build
is for owner testing; signing, notarization and updates are separate work.

Icons are generated from `design/assets/pacer-mark.svg` with `bunx tauri icon`.
`ui/tray.svg` uses the same geometry in monochrome for the macOS template icon.

## Local service and authentication

The shell searches the login shell's PATH, then `$HOME/.local/bin`,
`/opt/homebrew/bin` and `/usr/local/bin`. Only executable files qualify.
The login-shell PATH is cached for the launch and refreshed on focus or Try again;
unique output delimiters exclude profile banners.
It inherits `PACER_HOME` and `PACER_PORT`; discovery is delegated to the CLI,
so it never reads service discovery secrets or bearer tokens.

It runs `pacer open --print` twice: one code signs the native HTTP client in,
and a separate code navigates the webview through `/app/auth?code=…`. The
native cookie jar is memory-only and disables redirects and HTTP proxies.
The current GET exchange will be replaced by `POST /v2/session/exchange` when
that service operation exists. `/v2/hello` is checked before the auth exchange and gates protocol major 2; newer minors
and unknown event kinds are supported by refetching the snapshot.

One Rust task owns the native `/v2/events` stream, including while the window
is hidden. It parses incremental SSE, resumes by sequence, refreshes snapshots,
and reconnects with delay. A service restart returns to recovery and obtains
fresh sessions. The recovery page retries every five seconds and on focus;
Start pacer invokes `pacer service install` without a shell.

The tray uses service-owned `planner`, `attention`, `counts`, `running` and
`executors` fields when available. It also renders the current v2.0 budget and
running tasks. v2.0 does not yet provide authoritative Needs you/counts fields,
so those remain empty rather than computing service decisions in the shell.
The planned `src/view-model/words.ts` does not exist in this checkout; labels
use service text and minimal native menu wording. Pause delegation stays disabled and Switch strategy remains deferred until
their service operations exist. No delegation or review mutation runs in Rust.

Notifications use `notifications.get` (Off / Important / All), refresh that
preference after config events, and display alert text with up to two route
actions. An unavailable preference defaults to Important. Important includes
warning/error alerts and the structured important categories used by the
current Orca client. Notification clicks and `pacer://review/<id>` / session
links open the matching hash route. Service-side notification deduplication
is a service responsibility and is not changed here.

## Shell IPC

No static capabilities or plugin commands are exposed. Rust grants only the
active `http://127.0.0.1:<port>` origin in the main window these app commands:

```js
await window.__TAURI__.core.invoke('setLaunchAtLogin', { enabled: true });
await window.__TAURI__.core.invoke('setTheme', { theme: 'system' }); // light, dark
await window.__TAURI__.core.invoke('notifyRoute', { route: '#/review/t-example' });
```

Each handler also verifies the caller window and current service origin. Local
recovery pages, other origins and old service ports cannot invoke these
commands. Launch at login is off until enabled and is also available in the
tray. Window geometry and appearance preference are stored by the shell.

## Manual smoke checks

- Without an installed CLI: Install pacer first; install it and refocus.
- Stop the service: pacer isn't running; Start pacer loads the authenticated UI.
- Hide the window; change service state and confirm tray updates continue.
- Trigger an alert under Off / Important / All, and click its notification.
- Run `open 'pacer://review/t-example'`, including when the app is closed.
- Launch the app twice: only one tray and window remain.
- Resize/move/relaunch; test theme and launch at login, then turn autostart off.
- Return protocol 1.x / 3.x from a test service: update CLI / app respectively.
- Try IPC from another origin: denied. Confirm the three allowed IPC calls from
  the authenticated page work and all other plugin calls are denied.

Unit tests cover discovery order, auth URL validation, route validation,
protocol majors, fragmented SSE, tray projection and notification preferences.
The native HTTP tests are ignored by default because restricted sandboxes cannot
bind loopback sockets. Run `cargo test --offline -- --include-ignored` outside
the sandbox (CI does this). They check the pre-auth protocol probe, old-service
recovery, one-time exchange, cookie authentication,
loopback Host, client header and absence of bearer authorization.

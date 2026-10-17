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
It passes `PACER_HOME` (default `$HOME/.pacer`) to the discovered CLI and uses
that same directory's `token` file for native sign-in. `PACER_PORT` is inherited;
`pacer open --print` supplies the loopback service address and the one-time code
used only by the webview. The native client uses the bearer token exclusively
for `POST /v2/session/exchange`, then drops it and uses an in-memory cookie jar.
Tokens are never persisted or logged. Redirects and HTTP proxies are disabled.
All native requests include `X-Pacer-Client: desktop/<package version>`.
The authenticated `/v2/hello` gates protocol major 2; newer minors and unknown
event kinds are supported by refetching the snapshot.

One Rust task owns the native `/v2/events` stream, including while the window
is hidden. It parses incremental SSE, resumes by sequence, refreshes snapshots,
and reconnects with delay. A concurrent heartbeat renews the `client.register`
notifier lease every 30 seconds, including during snapshot reads and stream
reconnection. Failure returns to recovery, obtains fresh sessions, and registers
again. The lease lapses after exit, allowing the service to resume its fallback
notifications. Recovery retries every five seconds and on focus; Start pacer
invokes `pacer service install` without a shell.

The tray uses service-owned `planner`, `attention`, and `counts`. Needs you
preserves attention order. Pause delegation for 1 hour calls `delegation.pause`
with `{for:"1h"}`; while `snapshot.pause` is present the menu offers Resume
instead. Switch strategy lists snapshot strategies and calls `strategy.use`.

Native notifications consume service-selected `notify` events addressed to this
client, preserving the service's attention flags, notification preference, and
delivery ledger. Up to two supplied actions become buttons: operations POST to
`/v2/ops/<op>`, and `ui.open` navigates the window. Confirmation and answer text
are collected with native macOS dialogs before dispatch. Notification body clicks
and `pacer://review/<id>` / session links open the matching hash route.

**Service compatibility:** the current service cookie-write guard still requires
exactly `X-Pacer-Client: app`, while the desktop contract requires
`desktop/<version>` on every native request. That guard must accept the desktop
label before registration, heartbeats, and native operations can succeed; the
shell does not bypass it with bearer-authenticated operations. No service code is
changed by this desktop-only update.

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
- Trigger attention under Off / Important / All; test body and action clicks.
- Pause/resume delegation and switch strategies from the tray.
- Hide the app for over 45 seconds; confirm its notifier lease stays active.
- Run `open 'pacer://review/t-example'`, including when the app is closed.
- Launch the app twice: only one tray and window remain.
- Resize/move/relaunch; test theme and launch at login, then turn autostart off.
- Return protocol 1.x / 3.x from a test service: update CLI / app respectively.
- Try IPC from another origin: denied. Confirm the three allowed IPC calls from
  the authenticated page work and all other plugin calls are denied.

Unit tests cover discovery order, auth URL validation, route validation,
protocol majors, fragmented SSE, tray projection, attention notification mapping,
notifier targeting, and action dispatch parameters.
The native HTTP test is ignored by default because restricted sandboxes cannot
bind loopback sockets. Run `cargo test --offline -- --include-ignored` outside
the sandbox (CI does this). It checks POST exchange, memory cookie authentication,
loopback Host, Origin, versioned client headers, and absence of bearer authorization
on subsequent requests.

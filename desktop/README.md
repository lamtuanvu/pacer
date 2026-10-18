# pacer desktop (U2)

An unsigned macOS and Linux Tauri v2 shell. Install the pacer CLI separately. The window
loads the existing web UI from the local service; only recovery screens are
bundled here. Closing the window keeps the native tray client running. Quit
from the tray to exit; the Dock icon or Open pacer restores the window.

## Build

### macOS

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

### Linux

Requires Rust 1.99.0, Bun and a desktop session with WebKitGTK 4.1 and an
AppIndicator-compatible tray (GNOME may need an AppIndicator extension).
On Ubuntu 24.04, install the build dependencies:

```sh
sudo apt-get update
sudo apt-get install -y build-essential curl wget file libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
bun install --frozen-lockfile
cd src-tauri
cargo check --offline
cargo test --offline
cd ..
CARGO_NET_OFFLINE=true bunx tauri build --bundles appimage,deb --no-sign
```

Fetch locked crates with `cargo fetch --locked` in `src-tauri` before the offline
steps if they are not cached. Linux targets are configured in
`src-tauri/tauri.linux.conf.json`. Outputs are under
`src-tauri/target/release/bundle/appimage/` and `bundle/deb/`.
Run the AppImage with `chmod +x pacer_*.AppImage` then `./pacer_*.AppImage`
(FUSE 2 may be required; `--appimage-extract-and-run` avoids FUSE), or install
the matching `.deb` with `sudo apt install ./pacer_*.deb` and run `pacer-desktop`.
For development, run `bunx tauri dev` from this folder.
Install the pacer CLI separately and start its local service as on macOS.

The manual `desktop.yml` workflow also builds unsigned AppImage and `.deb`
artifacts on native Ubuntu x86_64 and arm64 runners. The arm64 job requires
`ubuntu-24.04-arm` runner availability. Each architecture uploads its own
artifact; no release or signing is performed.

Icons are generated from `design/assets/pacer-mark.svg` with `bunx tauri icon`.
`ui/tray.svg` uses the same geometry in monochrome for the macOS template icon.

## Local service and authentication

The shell searches the login shell's PATH, then `$HOME/.local/bin`,
`/opt/homebrew/bin` and `/usr/local/bin` on macOS. Linux searches PATH,
`$HOME/.local/bin/pacer`, `/usr/local/bin/pacer` and `/usr/bin/pacer`, in that
order (duplicates removed). Only executable files qualify.
The login-shell PATH is cached for the launch and refreshed on focus or Try again;
unique output delimiters exclude profile banners.
It passes `PACER_HOME` (default `$HOME/.pacer`) to the discovered CLI and uses
that same directory's `token` file for native sign-in. `PACER_PORT` is inherited;
`pacer open --print` supplies the loopback service address and the one-time code
used only by the webview. The native client uses the bearer token exclusively
for `POST /v2/session/exchange`, then drops it and uses an in-memory cookie jar.
Tokens are never persisted or logged. Redirects and HTTP proxies are disabled.
Native reads and exchange include `X-Pacer-Client: desktop/<package version>`;
cookie-authenticated writes use `X-Pacer-Client: app` with the service Origin.
The authenticated `/v2/hello` gates protocol major 2; newer minors and unknown
event kinds are supported by refetching the snapshot.

One Rust task owns the native `/v2/events` stream, including while the window
is hidden. It parses incremental SSE, resumes by sequence, refreshes snapshots,
and reconnects with delay. A concurrent heartbeat renews the `client.register`
notifier lease every 30 seconds, including during snapshot reads and stream
reconnection. Failure returns to recovery, obtains fresh sessions, and registers
again. The lease lapses after exit, allowing the service to resume its fallback
notifications. A 401 from either webview reports `session_expired` through origin-scoped IPC.
Page-load checks also catch expired sign-in links and cookie-less session-ended
pages (including older service pages). The single connection task signs in again
with `POST /v2/session/exchange` and a fresh webview code, reloads the saved main
route and recreates the tray after sign-in. Failed connections show the bundled
starting/stopped page. Attempts are at least five seconds apart, including focus
and repeated IPC signals, and recovery continues automatically.
Recovery retries every five seconds and on focus; Start pacer
invokes `pacer service install` without a shell.

The tray title uses service-owned planner usage and attention counts. Left-click
opens a separate `/app/tray.html` popover, created hidden once the main page has
signed in so it shares the webview cookie session. It reads snapshots and events
directly. The window is transparent, frameless, always on top, 340 px wide and
120–520 px tall, anchored below the icon. If the icon rectangle is unavailable,
it opens at the top centre of the monitor. Linux uses this fallback and adds
Show popover to the tray menu because appindicators may not emit left clicks.
Blur and Esc hide it. The native menu offers Open pacer, Pause 1h / Resume,
Quit, plus Show popover on Linux. Pause calls
`delegation.pause` with `{for:"1h"}`; while `snapshot.pause` is present it offers
Resume instead.

On Linux, notifications show the title and body without action buttons; use the
web UI for actions and questions. Launch at login uses an XDG autostart entry.
External links use `xdg-open` (install `xdg-utils` if unavailable).

Native notifications consume service-selected `notify` events addressed to this
client, preserving the service's attention flags, notification preference, and
delivery ledger. On macOS, up to two supplied actions become buttons: operations POST to
`/v2/ops/<op>`, and `ui.open` navigates the window. Confirmation and answer text
are collected with native macOS dialogs before dispatch. Notification body clicks
and `pacer://review/<id>` / session links open the matching hash route.

## Shell IPC

No static capabilities or plugin commands are exposed. Rust grants only the
active `http://127.0.0.1:<port>` origin in the main window these app commands:

```js
await window.__TAURI__.core.invoke('setLaunchAtLogin', { enabled: true });
await window.__TAURI__.core.invoke('setTheme', { theme: 'system' }); // light, dark
await window.__TAURI__.core.invoke('notifyRoute', { route: '#/review/t-example' });
await window.__TAURI__.core.invoke('session_expired'); // also allowed from tray
```

Each handler also verifies the caller window and current service origin. Local
recovery pages, other origins and old service ports cannot invoke these
commands. Launch at login is off until enabled in Settings. Main-window geometry
and appearance preference are stored by the shell; tray geometry is excluded.

The tray window has a separate capability grant for that same active origin:

```js
await window.__TAURI__.core.invoke('tray_resize', { height: 360 });
await window.__TAURI__.core.invoke('tray_open', { route: '#/review/t-example' });
await window.__TAURI__.core.invoke('tray_hide');
await window.__TAURI__.core.invoke('app_quit');
```

These commands check the `tray` label and active service origin. `tray_open`
uses the shared route validator, opens and focuses the main window at the route,
and hides the popover. The page invokes `tray_hide` on Esc. In a plain browser,
links open `/app/#<route>` and resizing is skipped.

## Manual smoke checks

- Without an installed CLI: Install pacer first; install it and refocus.
- Stop a loaded service: pacer stopped; Start pacer starts the job without reinstalling.
- A missing launchd job: pacer isn't installed; only this page offers Install.
- Block the service with a privacy dialog: pacer is busy, elapsed seconds update,
  and allowing access automatically opens the authenticated UI. Check the tray too.
- After 30 seconds busy without an identified prompt, Restart pacer is offered.
- Restart the service with the main window and popover open; both sign in again.
- Revoke app sessions, reload without a cookie, or load an expired sign-in URL;
  the shell recovers automatically. Stop the service during recovery; the bundled
  page appears and reconnects after restart without rapid retries.
- Hide the window; change service state and confirm tray updates continue.
- Trigger attention under Off / Important / All; test body and action clicks.
- Left-click (or Show popover in the Linux tray menu) toggles the popover;
  missing icon coordinates use the top-centred fallback. Blur and Esc hide it.
- Resize the popover via IPC; width stays 340 px and height clamps to 120–520 px.
- Open a route from the popover; the main window focuses and the popover hides.
- Right-click offers only Open pacer, Pause 1h / Resume, Quit; test each action.
- Hide the app for over 45 seconds; confirm its notifier lease stays active.
- Run `open 'pacer://review/t-example'` on macOS or
  `xdg-open 'pacer://review/t-example'` on Linux, including when the app is closed.
- Launch the app twice: only one tray and window remain.
- Resize/move/relaunch; test theme and launch at login, then turn autostart off.
- Return protocol 1.x / 3.x from a test service: update CLI / app respectively.
- Try IPC from another origin: denied. Confirm the three allowed IPC calls from
  the authenticated main page work, tray commands work only from the tray
  window, session expiration works from both, and all plugin calls are denied.

Unit tests cover discovery order, auth URL validation, route validation,
protocol majors, fragmented SSE, tray projection, attention notification mapping,
notifier targeting, and action dispatch parameters.
The native HTTP test is ignored by default because restricted sandboxes cannot
bind loopback sockets. Run `cargo test --offline -- --include-ignored` outside
the sandbox (CI does this). It checks POST exchange, memory cookie authentication,
loopback Host, Origin, versioned client headers, and absence of bearer authorization
on subsequent requests.

## Connection diagnostics and previews

The shell probes the loopback TCP port and `/health` separately (a two-second
health deadline). It polls about once a second while disconnected; unanswered
health requests can take two seconds. `PACER_PORT` selects the port, default 4317.
A listening service that cannot answer is **busy**, never described as uninstalled.
A starting health response or `service.starting` snapshot shows **Starting pacer…**.
Ready services sign in and load automatically. The tray uses the same diagnosis.

On macOS, a refused connection is checked against
`launchctl print gui/<uid>/com.pacer.serve`. A missing job offers installation;
a stopped, loaded job offers **Start pacer**, which runs `launchctl kickstart`
without opening a terminal. **Restart pacer** uses `kickstart -k` and appears
after 30 seconds busy with no identified consent prompt. Actions recheck the
current diagnosis before running. On Linux, the shell checks `pacer-serve.service`
and uses `systemctl --user start` / `restart`; the CLI is the fallback when no
unit can be found. Service-manager failures remain visible while polling resumes.

The macOS consent check reads only on-screen window metadata through
`CGWindowListCopyWindowInfo`, without requesting Screen Recording access.
It requires a consent-process owner and a title identifying pacer file access.
Redacted, missing, or unrelated titles are inconclusive: the shell then says
that macOS consent is a likely cause instead of claiming a specific dialog exists.
Linux busy copy does not mention macOS.

For screenshots, open `desktop/ui/index.html` directly in a browser, or serve
`desktop/ui/` with a static server. Query parameters render deterministic previews
without running commands or requiring Tauri:

- `?state=not_installed`, `?state=stopped`, `?state=starting`, `?state=ready`
- `?state=busy&prompt=1&for=14` — identified consent prompt, live elapsed timer
- `?state=busy&for=31` — likely-cause copy and Restart pacer
- `?state=busy&for=14&platform=linux` — Linux busy copy
- Add `&compact=1` for the tray layout (340 px wide).
- Existing pages: `install`, `oldService`, `oldApp`, `protocol`, `startFailed`.

The elapsed timer advances from the preview's `for` value. Live restart visibility
comes from the native diagnosis; previews choose it from `for` and `prompt`
(or explicitly `restart=1`). The shell CSS embeds the shared design tokens;
`test/desktop-shell.test.ts` checks that this copy stays in sync.

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
Install the pacer CLI separately and let the app manage its local service.

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
The login-shell PATH is cached for the launch and refreshed on focus;
unique output delimiters exclude profile banners.
It passes `PACER_HOME` (default `$HOME/.pacer`) to the discovered CLI and uses
that same directory's `token` file for native sign-in. `PACER_PORT` is inherited;
`pacer open --print` supplies the loopback service address and the one-time code
used only by the webview. The native client uses the bearer token exclusively
for `POST /v3/session/exchange`, then drops it and uses an in-memory cookie jar.
Tokens are never persisted or logged. Redirects and HTTP proxies are disabled.
Native reads and exchange include `X-Pacer-Client: desktop/<package version>`;
cookie-authenticated writes use `X-Pacer-Client: app` with the service Origin.
The authenticated `/v3/hello` accepts protocol majors 3 and 2 during the
compatibility window; newer minors and unknown event kinds are supported by
refetching the snapshot.

One Rust task owns the native `/v3/events` stream, including while the window
is hidden. It parses incremental SSE, resumes by sequence, refreshes snapshots,
and reconnects with delay. A concurrent heartbeat renews the `client.register`
notifier lease every 30 seconds, including during snapshot reads and stream
reconnection. Failure returns to recovery, obtains fresh sessions, and registers
again. The lease lapses after exit, allowing the service to resume its fallback
notifications. A 401 from either webview reports `session_expired` through origin-scoped IPC.
Page-load checks also catch expired sign-in links and cookie-less session-ended
pages (including older service pages). The single connection task signs in again
with `POST /v3/session/exchange` and a fresh webview code, reloads the saved main
route and recreates the tray after sign-in. Failed connections return to a small
Starting pacer… page and recover automatically.
One task owns retries, with at least one second between attempts.

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

macOS notification authorization is requested through `UNUserNotificationCenter`
when running an app bundle. Launch-at-login changes use `SMAppService.mainApp`
on macOS 13+ (the LaunchAgent plugin remains the fallback on older systems).
These native APIs own the approval UI; one-line explanations are shown only
while an identified pacer OS approval dialog is visible. Modern login item
registration requires a code-signed app, so it remains unverified in unsigned builds.

On Linux, notifications show the title and body without action buttons; use the
web UI for actions and questions. Launch at login uses an XDG autostart entry.
External links use `xdg-open` (install `xdg-utils` if unavailable).

Native notifications consume service-selected `notify` events addressed to this
client, preserving the service's attention flags, notification preference, and
delivery ledger. On macOS, up to two supplied actions become buttons: operations POST to
`/v3/ops/<op>`, and `ui.open` navigates the window. Confirmation and answer text
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

- With a located/bundled CLI and missing job: service installation and start happen automatically.
- Stop a loaded service: the app starts it automatically.
- Block on a volume permission: the main window and tray show the approval message;
  allowing access opens the app automatically, with no restart while waiting.
- With an unanswered health request and no OS prompt: automatic restarts back off
  from 20 to 40 to 80 seconds (capped).
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

## Automatic lifecycle and previews

The app owns the local service lifecycle. It probes loopback TCP and `/health`
with two-second deadlines. Missing jobs are installed through the located or
bundled CLI's service installer and then started. Stopped or refused services
are started with `launchctl kickstart gui/<uid>/com.pacer.serve` on macOS or
`systemctl --user start pacer-serve.service` on Linux. Linux without a working
user manager retains the direct CLI fallback. No terminal or recovery button is shown.
Lifecycle decisions and failures are written to the shell's stderr log.

A listening service that does not answer health is polled. After 20 seconds
without an OS prompt or a volume wait, the app restarts it automatically with
`launchctl kickstart -k` (systemd: restart), then waits 40 seconds and 80 seconds
between further restarts. A successful app connection resets recovery backoff.

The additive `service.waiting = { kind: "volume", path, since }` snapshot field
is understood in plain and wrapped snapshots. While present, the shell never
restarts and shows only the permission message with the path's basename, plus a
link to System Settings › Privacy & Security › Files and Folders. Without a known
path it says “your external drive”. Snapshot polling resumes automatically; when
the wait clears, the app signs in and loads. A positively identified on-screen
pacer file-access consent window uses the same message. Detection reads only
CoreGraphics window metadata; redacted titles are inconclusive and do not require
Screen Recording or Accessibility permission. Old blocked builds without this
snapshot field rely on visible consent detection and the health timeout fallback.
Protocol mismatch and incompatible installations still explain the required update.

Discovery prefers `PACER_BIN`, then a bundled executable beside the desktop shell
or in bundle Resources, then the normal login PATH candidates. A missing CLI
requires installing a complete app distribution; the shell never displays commands.

For screenshots, open `desktop/ui/index.html` or serve `desktop/ui/` statically:

- `?state=starting` — pacer mark and small starting status.
- `?state=permission&path=/Volumes/External/Project` — OS approval with “Project”.
- `?state=permission` — approval with “your external drive”.
- `?state=busy&prompt=1` — consent-window preview alias.
- `?state=oldService`, `?state=oldApp`, `?state=protocol` — incompatible installs.
- Add `&compact=1` for the 340 px tray layout.

Previews never run commands. The shell CSS embeds the shared design tokens;
`test/desktop-shell.test.ts` verifies those tokens and the page behavior.

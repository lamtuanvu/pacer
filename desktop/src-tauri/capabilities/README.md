There are no static capabilities. After CLI discovery and protocol validation,
Rust adds runtime capabilities for the exact `http://127.0.0.1:<port>` origin,
with local pages excluded:

- `service-<port>`, main window only: `allow-setLaunchAtLogin`, `allow-setTheme`,
  `allow-notifyRoute`, `allow-session-expired`, `allow-session-ready`,
  `allow-desktop-update-connection` (read-only native OTA connection state and public failure reason),
  `allow-desktop-version` (read-only native app version), `allow-native-validation-setup`,
  `allow-rounded-window-supported` (read-only transparent-window capability),
  `allow-native-titlebar-supported` (read-only macOS title-bar overlay capability),
  `allow-takeover-open` (asks the desktop to show its bundled service replacement
  page; it returns nothing, and only works while a takeover was detected),
  `allow-windowMinimize`, `allow-windowToggleMaximize`, `allow-windowClose`,
  `core:window:allow-start-dragging` and `core:window:allow-internal-toggle-maximize`.
  Window commands are restricted to the main window on the active service origin.
- `tray-service-<port>`, tray window only: `allow-tray-resize`, `allow-tray-open`,
  `allow-tray-hide`, `allow-app-quit`, `allow-session-expired`.

Each command also verifies its caller's label and current origin against the
active service. The tray is created hidden after the main webview finishes
signing in, sharing the default webview cookie store. Its navigation is restricted
to `/app/tray.html` on that origin. Recovery destroys it before signing in again.
No plugin commands are exposed to either page. Recovery actions use intercepted
navigation from the bundled recovery page, not an extra IPC command.

First-run actions use `tauri://localhost/action/<name>` sentinels: `begin`,
`consent?path=0|1`, `use-app`, `keep-mine`, `relink`, and `download`. Rust cancels
these navigations and accepts actions only from the bundled `tauri://localhost/`
or `/index.html` shell page. Other hosts, schemes, queries, and fragments are
rejected. The local `tauri://localhost/index.html?state=welcome` back link is
also intercepted, only from the bundled shell page, to return to Welcome.
The lifecycle loop serializes setup actions with service recovery;
no service installation runs while the bundled first-run consent gate is open.
An already healthy service can be attached without changing its installation.
These links add no IPC commands, static capabilities, or remote-origin grants.

Both service-origin page capabilities also allow `client_control`: a typed allowlist
for main-window visibility/geometry, tray visibility, launch at login and quit.
It validates the caller label and active origin; it cannot execute scripts or
arbitrary Tauri commands. Requests target a connected page and report completion
only after applying an action; process exit may leave the outcome unacknowledged.

The service replacement page (`tauri://localhost/index.html?state=takeover`) is
bundled, because the service's web app is served by the unverified build. It has
no capability and calls no IPC command: Rust injects its inspection data, progress
and a single-use action token with `window.eval`, as it does for recovery pages,
and only while its cached page is that bundled page. Its actions are sentinels:
`takeover-confirm?relink=0|1&token=<token>` and `takeover-dismiss?token=<token>`.
The restored page (`?state=takeoverRestored`) gets a token for `takeover-dismiss`
only. Rust accepts a sentinel only when its token equals the one issued to the
current bundled page and the shell still holds the service candidate the token
was issued for. A token is 32 random bytes in hex. It is consumed by any
well-formed attempt, kept across re-renders while the inspected candidate
(registration hash, process identity and program identity) is unchanged,
replaced when the candidate changes, and void as soon as any main-window
navigation or page load starts, so a service page loading after the bundled page
can never use it. The page marks **Use the app's service** `aria-disabled` and
ignores it for one second after a new token arrives or the window regains focus. A service page can only ask for the bundled page through `takeover_open`;
there is no service-page sentinel for it.

There are no static capabilities. After CLI discovery and protocol validation,
Rust adds runtime capabilities for the exact `http://127.0.0.1:<port>` origin,
with local pages excluded:

- `service-<port>`, main window only: `allow-setLaunchAtLogin`, `allow-setTheme`,
  `allow-notifyRoute`, `allow-session-expired`, `allow-session-ready`,
  `allow-desktop-update-connection` (read-only native OTA connection state and public failure reason),
  `allow-desktop-version` (read-only native app version), `allow-native-validation-setup`,
  `allow-host-file-actions` (read-only: which file hand-offs this platform supports),
  `allow-open-session-file` (ADR 0011: takes only `{ id, attempt, reference, action }`,
  resolves it through the service's `session.file.resolve`, re-walks the file with
  `O_NOFOLLOW` and matches its identity, then launches a fixed argument vector with no shell),
  `allow-rounded-window-supported` (read-only transparent-window capability),
  `allow-native-titlebar-supported` (read-only macOS title-bar overlay capability),
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

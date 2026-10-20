There are no static capabilities. After CLI discovery and protocol validation,
Rust adds runtime capabilities for the exact `http://127.0.0.1:<port>` origin,
with local pages excluded:

- `service-<port>`, main window only: `allow-setLaunchAtLogin`, `allow-setTheme`,
  `allow-notifyRoute`, `allow-session-expired`.
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

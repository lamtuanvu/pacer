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

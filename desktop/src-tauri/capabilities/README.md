There are no static capabilities. After CLI discovery and protocol validation,
Rust adds `service-<port>` for the exact `http://127.0.0.1:<port>` origin,
main window only, local pages excluded, with only these app permissions:
`allow-setLaunchAtLogin`, `allow-setTheme`, `allow-notifyRoute`.
Each command also verifies the current origin against the active service.
No plugin commands are exposed to the page. Recovery actions use intercepted
navigation from the bundled recovery page, not an extra IPC command.

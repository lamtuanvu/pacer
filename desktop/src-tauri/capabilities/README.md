The main and tray windows load only the bundled app origin. `main.json` and
`tray.json` are static local capabilities; no service origin receives IPC access.
Every command also checks the calling window label and bundled origin.

The main window receives the fixed v3 operation/read/event commands, typed
assistant/log/attachment commands, terminal commands and its existing native
controls. `terminal_ack` bounds outstanding terminal frames to 1 MiB; exceeding
that budget drops the attachment with a resync so the page requests a snapshot.
`stream_ack` applies the same 1 MiB acknowledged budget to assistant/log Channels;
overflow sends resync and closes the stream. `stream_cancel` cancels only streams
owned by the main window. The tray receives
only the shared service reads/operations/events and its existing tray controls.
Neither window has generic HTTP, file, shell or URL forwarding commands.

The operation forwarder checks the latest hello's exact operation list, excludes
`ui.open`, validates operation names and caps JSON params at 256 KiB. Page-forwarded requests
use Rust's exchanged app cookie, matching loopback Origin, app client header and
the page's instance identity. Native lifecycle reads retain the desktop version
label and no page instance; native cookie writes retain the required app CSRF
header but carry no driving-lease instance. Only the session exchange uses the owner bearer.

Recovery controls remain bundled shell states in the same document. Their
intercepted `tauri://localhost/action/...` sentinels preserve the existing
single-use, candidate-bound takeover tokens. Leaving a takeover state revokes
its token. These sentinels never navigate the document. Non-token actions require the
matching recovery overlay state. Navigation allows only fragment changes in the
bundled document (main bundle or tray.html); only non-loopback HTTPS links open
externally. Other schemes and documents are blocked. Service reconnects keep the
event cursor in Rust memory; a changed service identity or rewound snapshot
resets it and broadcasts one resync.

# ADR 0016: Sandboxed plugin web surfaces and plugin work capabilities

Status: Proposed, 2026-10-31. Amends [ADR 0010](0010-plugin-ui-contributions.md).

## Context

ADR 0010 made plugin UI host-rendered data: plugins ship no HTML, CSS or JavaScript, and each richer view needs a protocol addition. That works for lists, settings and status, but not for canvases, live previews or editors. Expressing those as view nodes would move each plugin's interaction model into the open host and need a protocol change for every interaction, which works against P13 (a minimal host).

Plugins also cannot start or steer work. They can read tasks, but they cannot create them, send messages to running tasks, or be called by agents through the CLI or MCP. A plugin that turns feedback into agent work has to go around routing, pacing and review, or it can't exist.

The obvious design for both needs has known risks:
- plugin code running beside the app could reach the service with the app's cookie;
- task text from a plugin could reach the host's shell through the acceptance command;
- an executor could delegate onward through a plugin, around API-5.

## Decision

1. **One exception to ADR 0010's data-only UI.** A plugin may contribute one sandboxed web surface (`contributes.ui.web`), placed as an activity page. Its isolation is layered, and no single layer is trusted alone:
   - a `sandbox allow-scripts` CSP on every surface response, so the document has an opaque origin even when it is opened top-level;
   - an unguessable token bound to the app session, plugin and surface;
   - path-scoped CSP sources with `connect-src 'none'` and `webrtc 'block'`;
   - same-origin policy with no CORS on service routes, and `Cross-Origin-Resource-Policy: same-origin` on service responses (surface assets alone send `Access-Control-Allow-Origin: null` and `Cross-Origin-Resource-Policy: cross-origin`, and only under a valid token);
   - an in-memory bundle snapshot taken when the plugin is enabled, with no symlinks and an allow-list of file types;
   - a required header on cookie-authenticated GETs, and single-use stream tickets for event streams;
   - the iframe sandbox;
   - a `MessageChannel` bridge that the app shell validates.

   The host draws the provenance chrome, the error states and every confirmation, and confirmations show each plugin-supplied field in full. A keyboard path out of the frame that works even when the surface captures every key is a requirement, verified in slice 3. On the desktop, runtime capability patterns narrow from `{origin}/*` to `{origin}/app/*`, and IPC from `/plugin-surface/` frames is refused (SEC-8). ADR 0010 stays in force for every other plugin surface.
2. **Plugin requests instead of direct task creation.** `tasks.create` stores a plugin request, which becomes `task.delegate` only after the user confirms it, so the task state machine is unchanged. Plugin-created tasks carry no acceptance command, and the host never runs plugin text. "Start without asking" is available only for plugins that agents cannot call, and it never chains more than one level. A plugin never records a review verdict.
3. **Messages follow `task.send` semantics.** A plugin can message only running tasks it started or the user attached to it. It gets no `force`, and a shared sanitizer plus a provenance prefix with the plugin's id apply.
4. **Executors cannot delegate through a plugin.** The host tracks its own in-flight executor calls to each plugin and refuses that plugin's work capabilities during them, whatever metadata the plugin returns. An executor session without a valid work grant is refused, not treated as the user. For 10 minutes after an executor call, sends to tasks the user attached are refused (`recent_executor_call`), and confirmations for requests made in that window show which task called. Caller policy refuses executors for the new plugin management ops (`plugin.surface.*`, `plugin.task.*`, `plugin.project.*`, `plugin.request.*`) and `app.stream.ticket`, and peer tiers exclude them (SEC-13). Plugin commands and tools stay callable by executors, by design.
5. **Plugin commands and tools live in separate namespaces.** These are `pacer x <plugin-id> …` and `plugin__<plugin-id>__<tool>`, so they can never collide with built-ins. Plugin tools reach planner sessions only after the user opts in. An executor's worktree is added as a file root bound to that one call only, with `.git` excluded. User and planner callers get no implicit roots, and remote and peer callers are refused. Project roots inside repositories are walked without following symlinks, reads and writes are descriptor-pinned, and worktree roots are never attachment sources.
6. **Additive versioning.** Everything ships as plugin protocol 1.7.0 with a `host >=1.7.0` floor, under ARCH-14. The open reference plugin in `plugins/examples/` exercises every addition.

## Consequences

- Rich plugin views become possible without growing the host's node set, and the interaction model stays with the plugin.
- UI-1, UI-19 to UI-21, UI-25 and UI-3 cannot be enforced inside a surface. Accessibility inside the surface is the plugin's responsibility. The host frame, prompts and states still follow every UI rule.
- The service's routes get stricter for cookie-authenticated app requests: CORP, a required header on GETs, and stream tickets that need a fresh ticket on every reconnect. Bearer clients are unchanged.
- Isolation claims depend on engines. The hostile-surface kit must run on Chromium, Firefox, WKWebView (macOS 11) and WebKitGTK, recording each version. Isolation is claimed only for engines that pass it, and failures are published as known gaps. None has run yet.
- The plugin process itself is still unsandboxed until plugin system milestone M3. These guarantees cover the surface, the capabilities and the host paths, not a hostile plugin process.
- **Accepted risk:** from the moment an executor's call to a plugin settles, including during the 10-minute window, the plugin can still message tasks it started itself. Those messages are rate limited and prefixed with the plugin's id, and within the window they're recorded with `via` for audit.
- Desktop keyboard escape relies on a native menu accelerator, with a Rust-only global-shortcut fallback if needed, and on focus returning to the chrome when the window is activated. That behavior is UNVERIFIED until the slice 3 probes run, as are the desktop subframe navigation checks, whether any page outside `/app/` needs IPC, and Orca's bracketed-paste support (slice 4). Focus returning to the chrome is unconditional: after switching away and back, focus lands on the chrome even for a well-behaved plugin, and the user moves back into the frame from there. This trade-off is accepted so that the escape never depends on the surface's cooperation.

Spec: [plugin web surfaces and work capabilities](../specs/2026-10-31-plugin-web-surfaces-and-work-capabilities-design.md).

# Plugin web surfaces and work capabilities

Date: 2026-10-31, revised the same day after independent security, architecture and protocol, and UI and repository reviews. Status: proposed, awaiting the maintainer's approval. Nothing is built.
Applies to: `src/plugins/**`, `src/api/ops.ts`, `src/api/caller-policy.ts`, `src/core/plugins.ts`, `src/serve/**`, `crates/server/src/serve/**`, `crates/cli/**`, `src/mcp/**`, `src/session/send.ts`, `src/messaging/participants.ts`, `src/attention/**`, `packages/plugin-sdk/**`, `crates/plugin-sdk/**`, `conformance/**`, `plugins/examples/**`, `scripts/plugin-protocol-doc.ts`, `docs/plugin-protocol.md`, `docs/plugin-protocol.schema.json`, `docs/protocol.md`, `app/**`, `desktop/src-tauri/src/**`.
Decision record: a new ADR that amends [ADR 0010](../decisions/0010-plugin-ui-contributions.md), written once this spec is approved.
Builds on:
- [plugin system](2026-10-19-plugin-system-design.md) and [plugin host core](2026-10-19-plugin-host-core-design.md)
- [plugin UI contributions](2026-10-28-plugin-ui-contributions-design.md) and ADR 0010
- [managed delegation enforcement](2026-10-27-managed-delegation-enforcement-design.md) (API-5 grants) and [agent messaging](2026-10-28-agent-messaging-design.md) (participants)

## Problem

Plugins can read tasks, read and write scoped files, spawn processes and draw host-rendered views. Some plugins need more:

1. **A rich view.** Canvases, live previews and editors cannot be expressed as view documents. ADR 0010 says each richer view needs a protocol addition. A canvas with pan and zoom, positioned pins and element hit-testing would need dozens of node types, every one of them carrying one plugin's interaction model into the open host.
2. **Starting work.** A plugin can read tasks but cannot create one. A plugin that turns user feedback into agent work has no way to do it through routing, pacing and review.
3. **Talking to running work.** A plugin cannot send a follow-up to a running task.
4. **Being called by agents.** Executors reach pacer through the CLI and the MCP server. A plugin cannot add a command or an MCP tool, so an agent cannot call it.

## Goals

- A plugin can ship one sandboxed web surface that runs its own code. That code cannot read pacer data, call the service, act as the app or reach another plugin's surface. Network egress is blocked on every engine that passes the egress probes. Engines that fail a probe are listed as known gaps, never claimed as isolated. The plugin process itself stays unsandboxed until plugin system milestone M3.
- A plugin can create tasks and send messages to running tasks. Both go through the same routing, pacing, delegation policy and review as the user's own work. A plugin never runs shell text on the host, never records a review verdict, and never lets an executor delegate around API-5.
- A plugin can contribute CLI commands and MCP tools in a namespace that cannot collide with pacer's own. When an executor calls one, the plugin's file access for that call is limited to that executor's worktree.
- Each addition is a new surface kind or capability in the grant. A version that asks for more prompts the user again.
- Every addition is additive under ARCH-14: plugin protocol 1.7.0, new v3 client ops, generated docs, and conformance tests backed by an open reference plugin in `plugins/examples/`. A manifest that uses any 1.7.0 contribution or capability sets `host` to `>=1.7.0`, enforced by the manifest schema as it is for earlier additions.

Done means:

- An example plugin built only from the protocol document and the SDK can show a web surface, create a task after the user confirms, send a follow-up to it, and serve a command and an MCP tool that an executor calls inside its worktree.
- The hostile-surface conformance kit (see Security) passes on Chromium, Firefox, the oldest supported WKWebView (macOS 11) and WebKitGTK (Linux desktop). Any probe that fails on an engine is recorded as a known gap in `docs/plugin-protocol.md`.
- Conformance shows that an executor calling a plugin tool cannot cause `tasks.create`, `tasks.send` or `plugin.task.attach` to succeed.
- Fresh installs behave as before. No bundled plugin declares any of the new contributions.

## Non-goals

- Sandboxing the plugin process. That remains M3, and ADR 0010's note about it still applies.
- A plugin marketplace, payments or license checks. The host never checks entitlements (P15).
- Plugin access to interactive sessions the user started outside pacer. Only pacer tasks can receive messages.
- Plugin-defined task kinds, acceptance commands, routing rules or review policy.
- Right-panel placement of web surfaces. 1.7.0 allows activity pages only.

## Decisions taken while brainstorming and review

| Question | Decision |
|---|---|
| Rich views: host-drawn canvas nodes or plugin code in a sandbox? | Plugin code in a sandbox. Host-drawn nodes would move one plugin's interaction model into the open core and need a protocol change for every interaction. |
| What isolates the surface? | Layers, none of which is trusted alone: a `sandbox` CSP on every surface response, so the opaque origin holds even when the page is opened top-level; an unguessable per-session path; same-origin policy with no CORS on service routes; `Cross-Origin-Resource-Policy` on service responses; a header requirement on credentialed GETs; and the iframe sandbox. |
| How does the surface talk to its plugin? | Only through a `MessageChannel` port that the app shell transfers after the frame first loads. The shell validates each message and forwards it as `ui.action`. Surface actions count as untrusted input, never as user consent. |
| Creating work | `tasks.create` records a **plugin request**, not a task. The task state machine is unchanged. When the user confirms the request, it becomes `task.delegate` with origin `plugin:<id>`. A plugin that offers no executor-callable commands or tools may be set to "start without asking". No acceptance command. |
| Messaging work | `task.send` semantics (driving lease, running tasks only, 4000 characters), not `msg.send`. Plugins never use `force`, and plugin participants can't be addressed through `msg.*` in 1.7.0. |
| Executor-originated calls | The host tracks its own in-flight calls. While any executor-sourced call to a plugin is in flight, that plugin's `tasks.create`, `tasks.send` and `plugin.task.attach` are refused, whatever metadata the plugin echoes. A plugin that executors can call never gets auto-start, so a request it makes later still needs the user. |
| Commands and MCP tools | `pacer x <plugin-id> <command>` and `plugin__<plugin-id>__<tool>`. Neither namespace can collide with pacer's built-in commands or tools. |
| Designer or role skills for agents | No new host contribution. A plugin returns role guidance through its own command or tool, or includes it in the briefs it creates. |

## 1. Web surfaces (`contributes.ui.web`)

### Manifest

```json
"host": ">=1.7.0",
"contributes": {
  "ui": {
    "web": [{ "id": "main", "title": "Main", "icon": "file", "entry": "web/index.html", "maxBundleBytes": 2097152 }]
  }
}
```

- At most one web surface per plugin, placed as an activity page.
- `entry` and its assets come from the plugin's installed folder. When the plugin is enabled, the host takes an **in-memory snapshot** of the bundle. It refuses symlinks, special files and extensions outside an allow-list (`.html` for the entry only, plus `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, `.webp`, `.woff2`; WebAssembly is not allowed in 1.7.0). It checks the total against `maxBundleBytes` (at most 4 MiB) and, for archive installs, binds the snapshot to the signed archive digest. Later changes to the folder have no effect until the plugin is enabled again. Nothing is fetched from the working directory, a repository or the network.
- Web surfaces add a surface kind to the grant (see Permissions).

### Serving

- The app shell gets a surface URL through the authenticated client op `plugin.surface.open { plugin, surface }`, which returns `{ url }` with an unguessable per-app-session token: `/plugin-surface/<token>/<plugin-id>/<surface-id>/<asset>`. The host returns 404 for any surface path with a missing or expired token, and never redirects from the surface path. Tokens end with the app session.
- **Every** surface response carries:
  - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src <P>; style-src <P> 'unsafe-inline'; img-src <P> data: blob:; font-src <P> data: blob:; frame-src blob:; connect-src 'none'; webrtc 'block'; form-action 'none'; base-uri 'none'; frame-ancestors <app origins>`. Here `<P>` lists the token path as host-sources for both loopback names (`http://127.0.0.1:<port>/plugin-surface/<token>/<plugin-id>/<surface-id>/` and the `localhost` form), never `'self'`.
  - `Permissions-Policy` denying every feature, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a content type from the extension allow-list, and `Cross-Origin-Resource-Policy: cross-origin` with `Access-Control-Allow-Origin: null` (never with credentials). Those last two are required because the surface's opaque origin otherwise blocks its own module scripts and fonts, and the token keeps assets unreadable to other pages.
  - For the HTML entry: refused when `Sec-Fetch-Dest` is present and is not `iframe`.
- Plugins cannot set headers. The surface path ignores cookies and bearer tokens.
- Theme tokens reach the surface only through the bridge's `theme` event. There is no shared stylesheet route.

### Hardening of service routes

The surface's opaque origin already makes SEC-4 refuse its non-GET requests. Reads need their own protection, which does not rely on browser cookie behavior or on Fetch Metadata being present:

- The primary control against reads is the same-origin policy with no CORS. Service routes never send CORS headers (SEC-4).
- `/v2`, `/v3`, `/app` and attachment responses gain `Cross-Origin-Resource-Policy: same-origin`, so `<img>`, `<script>` and `<link>` loads from a surface fail even when a cookie is sent.
- Cookie-authenticated `fetch` GETs must carry `X-Pacer-Client: app`. No-cors loads cannot set it, and a preflight from an opaque origin fails. The app's fetch helper adds it.
- Cookie-authenticated event streams and WebSockets need a stream ticket in the URL. The ticket comes from the new op `app.stream.ticket { path }`, called through the header-carrying fetch path. It is single use, expires after 30 s, is bound to the app session and the stream path, and is never logged. Native EventSource reconnects would reuse a spent ticket, so every app stream client (including the bare EventSource in `PlainLog.tsx` and the terminal WebSocket) closes on error and reconnects with a fresh ticket. Slice 2 covers this. Requests with `Origin: null` or `Sec-Fetch-Site: cross-site` are still refused when those headers are present.
- **Scope and compatibility.** Both rules apply only to cookie-authenticated (app) requests. Bearer-token clients (CLI, TUI, MCP, scripts) are unchanged, and no op or field changes, so API-2 needs no major bump. The app is served by the same service, so client and service always match. It is a user-visible change, so it updates the matching `docs/*.md` page and adds a CHANGELOG Unreleased entry under Security (REPO-7).
- The same rules are implemented in the Rust front door (`crates/server/src/serve/auth.rs`) and the TypeScript fallback (`src/serve/http.ts`), with a parity test (ARCH-15).

### Frame and bridge

- The app embeds the surface with `sandbox="allow-scripts"`. It sets no `allow-same-origin`, top-navigation, popups, forms or modals, and no `allow` attribute.
- The service-served app CSP gains `frame-src` for the surface path host-sources only. The desktop's bundled-page CSP (`tauri.conf.json`, `frame-src 'none'`) does not change. The desktop's runtime capability patterns narrow from `{origin}/*` to `{origin}/app/*`, and `command_authorized` refuses requests whose frame URL is under `/plugin-surface/` (SEC-8).
- **Bridge.** After the frame's first `load`, the shell creates a `MessageChannel` and transfers one port to the frame. All traffic uses that port, and the SDK ignores `window` messages. If the frame loads again (self-navigation), the shell discards the port and reloads the original URL. A surface token is bound to the app session, the plugin and the surface, and is given only to the shell. A surface therefore cannot learn or load another plugin's surface URL, so a port is never handed to another plugin's code. Envelopes:

```ts
// surface → shell
{ v: 1, type: "ready" }
{ v: 1, type: "action", id: string, action: string, payload: unknown, confirm?: { title: string, body: string } }
// shell → surface
{ v: 1, type: "result", id: string, ok: boolean, data?: unknown, error?: { code: string, message: string } }
{ v: 1, type: "event", name: "theme" | "visibility" | "invalidate", data: unknown }
```

- The shell validates every envelope with zod. A payload is at most 256 KiB. A surface may have 8 actions in flight and at most 120 a minute. Excess calls return `rate_limited` with a retry hint. The plugin UI spec uses `conflict` for its limit, and aligning the two is noted for its next revision. `confirm` makes the host draw a confirmation outside the surface before forwarding, as ADR 0010 does for view documents.
- `ui.action` gains `surface: "web"`, and its reply is JSON of at most 1 MiB. The SDK marks web actions as untrusted input.

### Host frame, accessibility and states

The host frame lives in `app/src/**`, and every UI rule applies to it.

- **Provenance chrome.** A host-drawn header shows the plugin's icon and name, a "Plugin interface" badge and the surface title. It is a labelled landmark (`<section aria-label="<plugin> plugin interface">`) and is always visible. The surface cannot overlap it. The host never asks for secrets, tokens or approvals inside a plugin region. Confirmations are host dialogs outside it.
- **Frame.** The iframe's `title` is "<surface title>, from <plugin name>". The frame comes after the chrome in tab order, and focus does not move into the frame on load.
- **Leaving the frame by keyboard.** Key events inside a scriptable sandboxed frame go to the frame's own document, and the host cannot listen there. So the host cannot stop a surface from capturing keys. The spec relies on mechanisms that work even when the surface doesn't cooperate:
  - In a browser, the browser's own focus keys (F6 and Cmd/Ctrl+L to the address bar) always work. Tab from the address bar reaches the skip link and the chrome before the frame.
  - In the desktop app, a native menu item, "Leave plugin interface" (Cmd+Shift+L on macOS, Ctrl+Shift+L on Linux), moves focus to the chrome. The desktop has no app menu or accelerators today, so whether a menu accelerator fires while a scriptable subframe has focus is UNVERIFIED on WKWebView and WebKitGTK. If the slice 3 probe shows it does not, the fallback is an OS-level shortcut through `tauri-plugin-global-shortcut`, a new desktop dependency reviewed in that slice. It is registered and unregistered from Rust only, and the webview gets no global-shortcut permission. The page reports only a typed "surface focused" flag through the existing window-label and origin checks. The shortcut is registered only while the main window has OS focus and a plugin frame is focused. It is unregistered on window blur, minimize, hide, frame blur or navigation, and plugin disable, so pacer never takes the key from another app. If registration fails because the key is taken, or on Wayland, where global shortcuts mostly don't work, the host shows a visible "Leave plugin interface" button in the chrome.
  - **Keyboard path that needs no shortcut (desktop).** Whenever the main window regains OS focus, for example after Cmd+Tab or Alt+Tab away and back, Rust moves focus to the chrome, not back into the plugin frame. Window focus events work on macOS, X11 and Wayland, so a keyboard-only user can always leave a surface that captures keys. When a shortcut or focus event fires, Rust runs a fixed, host-owned action (focus the chrome landmark) and never uses page-supplied content.
  - The SDK leaves Tab, Shift+Tab and Escape to the browser by default. WCAG 2.1.2 (no keyboard trap) inside the surface is the plugin's responsibility, checked by the conformance kit's keyboard probe on the reference plugin.
  - The hostile-surface kit includes a surface that captures every key. The desktop menu path and the browser path must still reach the chrome.
- **States.** These are drawn by the host with plain copy (UI-12), offering only actions that can work (UI-13):

| State | Shown as | Action |
|---|---|---|
| Loading (over 300 ms) | Skeleton in the frame area | — |
| Load failed, or no `ready` within 10 s | "This plugin's interface didn't load." | Reload |
| Bundle refused (size, file type, symlink) | "This plugin's interface can't be shown." with the reason in details | Open plugin settings |
| Plugin disabled, needs a grant or is failing | The existing plugin state copy | Enable or Review permissions, when possible |

- UI-1, UI-19 to UI-21, UI-25 and UI-3 cover authored `app/src/**` code. They cannot be enforced inside plugin code, so they don't apply inside the surface. The conformance kit includes an axe pass that plugin authors can run.

## 2. Work capabilities

### Plugin participant

Plugin-originated work and messages use the participant string `plugin:<plugin-id>`. Additive changes:
- `participantSchema` (`src/messaging/types.ts`) accepts `plugin:` followed by the plugin id grammar.
- `participantKind` (`src/messaging/participants.ts`) gains the kind `plugin`.
- `origin` stays a string.

In 1.7.0, a plugin participant appears only as a task's origin and as the sender of `tasks.send` messages. `msg.*` ops refuse it as a sender or recipient. The capabilities below enforce which tasks a plugin may reach. No messaging guardrail is involved. For audit, a request or `tasks.send` made within 10 minutes after an executor-sourced call to the plugin records `via: <calling task id>`. The pending request's confirmation shows it ("after a call from task <id>"), and the started task keeps it in its source metadata. Within that window, `tasks.send` to tasks the user attached is refused with `not_allowed` and `data.reason: "recent_executor_call"`. Sends to tasks the plugin itself started are allowed, because those are already the plugin's work and their transcripts show the provenance prefix. That remaining path is an accepted risk, recorded in the ADR.

### Executor-originated calls

The host does not trust plugin-supplied correlation for this check. It tracks every `command.run` and `mcpTool.call` it sends to a plugin. While any call with an `executor` caller is in flight to a plugin, that plugin's `tasks.create`, `tasks.send` and `plugin.task.attach` calls fail with `not_allowed` and `data.reason: "executor_call_in_flight"`. A plugin that declares `commands` or `mcpTools` cannot be set to "start without asking", so a request it makes after the call settles still waits for the user. A future version may map executor-originated requests to `dispatch.child` under the caller's grant (open decision 4).

### `capability.tasks.create`: plugin requests

```ts
params: {
  requestId: string,             // idempotency key, unique per plugin
  goal: string, title?: string, kind?: string,
  repo: string,                  // a registered repository where the user enabled this plugin
  context?: string, constraints?: string,
  executor?: string,             // a preference, subject to eligibility and pacing
  attachments?: { name: string, path: string }[],  // inside the plugin's repository project roots
  labels?: Record<string, string>                  // ≤ 16 entries, key ≤ 32, value ≤ 128 characters
}
result: { request: string, status: "pending" | "started", taskId?: string }
```

- **No shell text.** There is no `acceptance` field or any other field the host runs. The host never runs text from a plugin.
- **A request, not a task.** The call stores a plugin request `pr-…` (atomic writer, SEC-7). It does not create a `TaskRecord`, so `TaskState`, `TERMINAL_STATES`, review and retry are unchanged. A request is `pending`, then `started` (with its `taskId`), `declined` or `expired`. Only `pending` can change, and the other states are final. A request still pending after 24 hours becomes `expired`.
- **Confirmation.** A pending request raises an attention item. The host draws it and shows the plugin's text in separate labelled fields, never spliced into host copy: plugin (name and id), title, goal, context, constraints, repository, preferred executor, attachments (with a note that they travel to remote executors) and labels, each shown in full and as text. The user confirms or declines in the app, or from the CLI (ARCH-8) with:
  - `pacer plugin requests [--plugin <id>]`, backed by `plugin.request.list { plugin?, status? }`, which returns the requests and their `rev`.
  - `pacer plugin confirm <request>` and `pacer plugin decline <request>`, backed by `plugin.request.confirm` and `plugin.request.decline` with `{ request, expect_rev }`, which return `{ status, taskId?, rev }`. A stale `expect_rev` or a request that is no longer pending returns `conflict` (ARCH-3).
- **Start without asking.** This per-plugin setting is off by default and offered only for plugins that declare no `commands` or `mcpTools`. Eligibility is checked against the current manifest on every request. The setting is reset whenever the plugin's grant changes, so an update that adds tools cannot keep it. With it on, a request starts at once. Tasks started without asking cannot themselves lead to more requests without asking: a request made while one of the plugin's auto-started tasks is open or not yet reviewed waits for the user, which bounds the chain at one level. The setting says: "<plugin> can start agent tasks on its own, including from content it reads or shows in its interface." It is stored in the plugin's host settings, which executors cannot change.
- **On start.** The request becomes `task.delegate` with origin `plugin:<id>`. Routing, pacing, executor eligibility and managed delegation enforcement apply as for the user's own delegation. A refusal is recorded on the request with the same `CoreError` code `pacer delegate` would return, and the request moves to `declined` with that reason.
- The plugin never records a verdict. `task.review` has no plugin equivalent.
- **Limits:** 5 requests a minute, 10 pending or open, and 50 a day per plugin by default, all adjustable in plugin settings. Excess calls return `rate_limited` with a retry hint.
- **Attachments** come only from the plugin's repository project roots, never from worktree or caller-scoped roots. They are copied into the task through the attachments store, with its `checkedPath` and revalidation snapshot.
- Labels render as text only. The host attaches no secret aliases, endpoint keys or tokens to plugin-created tasks. Plugin text in briefs is untrusted input.

### `capability.tasks.send`

```ts
params: { taskId: string, requestId: string, body: string }
```

- Allowed for running tasks this plugin started, or that the user attached with `plugin.task.attach`.
- Semantics are those of `task.send`. The task must be running (otherwise `conflict`). The plugin takes the 60-second driving lease as the client `plugin:<id>`, gets `conflict` while another client holds it, and cannot use `force`. The body is 1–4000 characters. Each plugin may send 6 messages a minute to each task (`rate_limited` beyond that).
- **Shared sanitizer for all senders.** The send path, used by `task.send` too, removes every ESC sequence (so no `ESC[201~` paste-end marker survives), all C1 controls including `0x9B`, C0 controls other than `\n` and `\t`, and the bidi override and isolate characters U+202A–U+202E and U+2066–U+2069. Other text, including joiners, is unchanged. Text from the user and the planner that contains none of these is delivered exactly as today. It is a user-visible change, so it updates the matching `docs/*.md` page and adds a CHANGELOG Unreleased entry under Security (REPO-7).
- **Multi-line plugin text** is sent in bracketed paste where the backend supports it. Otherwise newlines in plugin bodies are refused with `invalid_input`. Existing `task.send` callers keep today's multi-line behavior. Whether Orca's terminal send supports bracketed paste is verified in slice 4 (UNVERIFIED until then).
- **Provenance in the text.** The host prefixes the delivered text with `[from plugin <plugin-id> via pacer] `, using the id, not the plugin's chosen display name. It strips look-alike prefixes from the body.

### `plugin.task.attach` and `plugin.task.detach` (client ops)

```ts
params: { plugin: string, task: string, expect_rev: number }
result: { attached: boolean, rev: number }
```

- The user's consent to let a plugin message a task they can see, whoever started it. A stale `expect_rev` returns `conflict` (ARCH-3). Unknown ids return `not_found`. CLI: `pacer plugin attach|detach <plugin> <task>`.
- Attachment records use the existing atomic writers (SEC-7) and are removed when the task ends.

### Project roots

- A manifest may declare `projectRoots: [{ path: ".pacer/<plugin-id>", access: "read" | "write" }]`. The path must be the plugin's own folder under `.pacer/`.
- The user enables a plugin per registered repository with the client ops `plugin.project.enable` and `plugin.project.disable`, `{ plugin, repo, expect_rev }` → `{ enabled, rev }` (`conflict` on a stale `rev`, `not_found` for an unknown plugin or repository), or with `pacer plugin enable-project|disable-project <plugin> <repo>`. Records use atomic writers (SEC-7).
- The host pins the **repository directory** as the anchor and walks `.pacer/<plugin-id>` component by component without following symlinks, refusing the root if any component is a symlink. Reads and writes both use descriptor-pinned access. A repository cannot widen a root by making `.pacer/<plugin-id>` a link.
- While a task the plugin started is open, the same relative root inside that task's worktree is readable under the same descriptor-pinned rules, so the plugin can show proposed changes before review. Worktree roots are never attachment sources.

### Caller policy for the new ops

`caller-policy.ts` refuses executors for `plugin.surface.*`, `plugin.task.*`, `plugin.project.*`, `plugin.request.*` and `app.stream.ticket`, in addition to today's `plugin.ui.*` and `plugin.settings.*`. All of them are excluded from every peer tier (SEC-13).

### Events

`events.subscribe` gains `task.*` metadata events (state, attempt, worktree changed) for tasks the plugin created or was attached to. They contain no transcripts or logs.

## 3. Commands and MCP tools

### Manifest

```json
"contributes": {
  "commands": [{ "name": "patch", "summary": "Apply a patch operation", "args": { "$ref": "…" } }],
  "mcpTools": [{ "name": "patch", "description": "…", "inputSchema": { … } }]
}
```

- **CLI:** `pacer x <plugin-id> <command> [args…]`. The `x` namespace is reserved for plugins, so no built-in command can ever collide with one. Command names follow the plugin id grammar.
- **MCP:** tools are listed as `plugin__<plugin-id>__<tool>`. Plugin ids and tool names cannot contain `_`, so a plugin tool cannot equal or prefix a built-in tool name. The full name must be at most 64 characters, and the manifest is refused otherwise. Descriptions are plain text up to 1 KiB, prefixed by the host with "[plugin <plugin-id>]". Results are marked as plugin content.
- Plugin tools are listed in executor MCP sessions (the grant-scoped branch of `src/mcp/server.ts`). In planner sessions they're listed only after the user opts in for that plugin, because tool text enters the planner's context and the planner holds review authority.
- At most 24 commands and 24 tools per plugin.
- **Routing (ARCH-15).** During M1/M2 the Rust front door forwards `pacer x …` to the TypeScript core like other commands that aren't yet native, and the MCP server runs in the core. A native implementation must keep the same namespace and caller derivation.
- Plugin stdout written to a terminal is passed through the same control-character sanitizer as `tasks.send`.

### Host methods

```ts
command.run   { name, argv: string[], stdin?: string, caller }  → { stdout, stderr, exitCode }  (chunked results allowed)
mcpTool.call  { name, input, caller }                            → { content, isError }
caller: { kind: "user" | "planner" | "executor", taskId?: string, workdir?: string, repo?: string }
```

- Arguments are an argv array, never a shell string (SEC-5).
- **Caller derivation.** `executor` is derived only from a validated work grant (`pwg_…`, API-5). A session that marks itself as an executor (for example `PACER_ROLE=executor`) without a valid grant is refused with `not_allowed`, never downgraded to `user`. Otherwise the caller is `user` or `planner`, following the existing caller policy. The plugin cannot set or widen `caller`.
- **Caller-scoped roots.** For an `executor` caller, the host adds that task's worktree as a read and write root bound to the call's `CallAuthority`, not to the plugin. The root is pinned like other roots and revoked when the call settles or reaches its deadline. Concurrent calls from different executors never see each other's worktrees. `.git` and other VCS metadata are excluded from caller-scoped write roots. `user` and `planner` callers get no implicit roots, only enabled project roots. Callers on remote hosts and paired machines are refused in 1.7.0.
- Caller scoping limits what the **plugin** can touch during the call. It does not change what the executor itself can do.
- Commands work with no app running (ARCH-8).

## Permissions shown to the user

| Contribution or capability | Prompt text |
|---|---|
| `ui.web` | Show its own interface inside pacer. The interface can't see your pacer data unless the plugin asks pacer for it. |
| `tasks.create` | Ask to start agent tasks that run commands in repositories you enable. You confirm each request. A plugin without agent-callable tools can be allowed to start tasks without asking. |
| `tasks.send` | Send messages to running tasks it started or you connect to it |
| `projectRoots` | Read or write its own `.pacer/<plugin-id>` folder in repositories you enable |
| `commands`, `mcpTools` | Add commands and tools that agents can call. When an agent calls one, it can work inside that agent's task folder. |

## Security

- **Threat model:** a hostile surface (including one that previews untrusted content), a plugin that forwards untrusted input, an executor trying to delegate through a plugin, and a hostile repository. A hostile plugin process is out of scope until M3, as in ADR 0010.
- **Hostile-surface conformance kit.** Each probe must fail on Chromium, Firefox, WKWebView (macOS 11) and WebKitGTK (Linux desktop). Each run records the engine version tested, because Fetch Metadata and `webrtc` support vary between versions and distributions:
  - `fetch`, XHR, `<img>`, `<script>`, `<link>`, `<video>` and module loads of `/v2`, `/v3`, `/app` and attachments
  - EventSource and WebSocket to the service
  - WebRTC ICE and DNS prefetch
  - `document.cookie`, `top.location`, `window.open`, form posts and `<meta http-equiv>` CSP overrides
  - opening the surface URL top-level, or opening an SVG asset, followed by `window.open('/app/')`
  - self-navigation to `/v3`, `/app` or another plugin's surface
  - `srcdoc` and `blob:` child frames making the same calls
  - sibling `postMessage` spoofing, and oversized or malformed envelopes
  - IPC calls from the surface frame in the desktop
  - a surface that captures every key: the browser focus keys, the desktop "Leave plugin interface" menu item or shortcut, and switching windows away and back must each still reach the chrome
- **Work probes:** an executor calls a plugin tool, and the plugin tries `tasks.create`, `tasks.send` and `plugin.task.attach` with and without echoing call metadata; a request made after the call settles stays pending; an executor session without a grant calls a plugin tool; a `tasks.send` body with `ESC[201~`, `0x9B`, bidi overrides and multi-line text; a repository whose `.pacer/<plugin-id>` is a symlink; concurrent executor calls checking that root binding stays per call.
- Plugin text sent to agents is untrusted input that carries its provenance. The planner reviews plugin-created work as usual.
- All new records (grants, project enablement, task attachments, plugin requests, the start-without-asking setting) use the existing atomic writers with restrictive modes (SEC-7).
- New ops are listed in `caller-policy.ts` and excluded from peer tiers unless deliberately allow-listed later (SEC-13).

## Delivery

One PR per row, each with conformance tests and the open example plugin in `plugins/examples/`.

| Slice | Content | Evidence |
|---|---|---|
| 1 | Protocol 1.7.0 schemas, `host` floor, grant kinds, generated docs | Protocol doc freshness tests (API-3, P11) |
| 2 | Service route hardening (CORP, GET header, stream tickets and reconnects) in Rust and TS | Parity test; CT-11 live run of the app on web and desktop to show nothing regressed |
| 3 | Surface serving, `plugin.surface.open`, app and desktop frame, bridge, states, hostile-surface kit. Includes the desktop keyboard escape (menu accelerator, global-shortcut fallback if adopted, and focus return on window activation). Also verifies two desktop items that are UNVERIFIED today: the main window's navigation checks allow `/plugin-surface/` subframes, and no service page outside `/app/` needs IPC. | Kit results per engine; UI-18 screenshots of the frame and each state at 1440 px in light and dark, plus 375 px; UI-24 compliance, UI/accessibility and QA reports, including keyboard and focus checks |
| 4 | Plugin participant, plugin requests and their ops, `tasks.send` with the shared sanitizer, attach ops, events | Work probes; UI-18/UI-24 evidence for the confirmation prompt and attention item; CT-11 run |
| 5 | Project roots, `commands`, `mcpTools`, caller-scoped roots | Root and caller probes; CT-11 run across CLI and MCP |
| 6 | End-to-end live validation (CT-11) of the example plugin across CLI, MCP, web app and desktop | Evidence report summary in the PR |

## Governance

- An ADR amending ADR 0010: plugin UI is host-rendered data, with one exception, a sandboxed web surface under the layered isolation above.
- Security review of slices 2–5 (SEC-3, SEC-4, SEC-5, SEC-7, SEC-8, SEC-13, API-5), including the desktop global-shortcut fallback and its dependency if slice 3 adopts it. Protocol compatibility review (ARCH-14, API-1 to API-4). UI/accessibility review of the host frame and prompts (UI-24).

## Open decisions

1. Should the surface also receive a read-only view of task state through the bridge, or only through its own plugin?
2. Bundle size cap: 2 MiB by default and 4 MiB at most, or larger?
3. Should surfaces get a separate loopback **host** (for example `localhost` for surfaces and `127.0.0.1` for the app) for stronger isolation? A separate port alone is the same site and shares cookies. The `sandbox` CSP stays either way.
4. Should a later version map executor-originated `tasks.create` to `dispatch.child` under the caller's grant, instead of refusing it?

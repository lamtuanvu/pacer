# Built-in terminal design

Status: approved for implementation on 2026-10-26. The user requested a feature-rich, general-purpose terminal so Pacer's app can handle shell work without opening an external terminal.

## Intent

Pacer should provide a first-party terminal comparable to an editor's integrated terminal. A person can open a shell in a chosen local workspace, keep several terminals open, switch between them, and return after navigating away or reconnecting the app. Pacer actions that need an interactive terminal should open a tab in that same surface and bring the person to it. Agent task sessions remain visible through the existing terminal renderer.

The browser app and Tauri desktop shell use the same service-owned terminal capability. The CLI and TUI keep their existing terminal and attach workflows, because they must remain complete without the web app (ARCH-8). An explicit user choice to open an external viewer remains available where the current workflow supports it.

## Goals

- General-purpose local shell tabs with a named working directory, full PTY semantics, ANSI output, input, resize, scrollback, copy and paste, keyboard focus, accessible status and a search affordance.
- A visible Terminal destination in Pacer, with create, switch, rename, split and close actions. Several windows can watch the same terminal, with exclusive input control and an explicit takeover prompt.
- Terminal processes survive app navigation, browser reloads and service restart. Their existence and exit state are discoverable after reconnecting. Closing a tab intentionally stops its process; leaving the page does not.
- Existing Pacer actions that launch an interactive command from the app use an integrated tab and navigate to it: account sign-in, interactive setup/runner addition, strategy planning and SSH host terminal. These action calls accept an optional client-generated `request_id` when launched from the app; a persisted result makes retries return the same tab and run the command once. Local task attachment navigates to the existing Task page's terminal view, with no second process.
- An ordinary shell defaults to the selected repository/worktree where one is available, or the user's home directory. The directory is shown before launch, and an invalid or missing directory produces a clear error.

## Non-goals and anti-goals

- A command-string API, arbitrary shell execution through an operation, or an executor grant for terminal creation. Operations accept a workspace and a fixed launch intent; actual shell input travels only over the authenticated interactive stream. This preserves API-5 and SEC-5.
- Replacing the existing task PTY recording protocol or making terminal tabs into tasks. Terminal tabs are distinct from supervised agent attempts and have their own lifecycle.
- Terminal multiplexing features that require shell integration scripts, such as command decorations, command history indexing, process status parsing or automatic command suggestions. The user's shell and its normal configuration provide those behaviors.
- Remote shell creation without using an existing configured SSH host. The existing BatchMode and timeout policy applies.

## Approaches

1. **Service-owned PTYs in the app (selected).** Reuse Bun PTY, the session frame protocol and xterm. Separate terminal records and routes from task sessions. This works in both browser and desktop, allows reconnect, and follows P1/ARCH-1.
2. **Desktop-native terminal.** Tauri would own local PTYs and render tabs. This leaves web users on external terminal applications and duplicates service state, so it does not satisfy the request.
3. **Expand task-session terminal only.** This is cheaper but cannot handle ordinary shell work or setup and host commands, so it does not satisfy the request.

## Service and protocol

`src/terminal/workspace.ts` owns the terminal registry under `$PACER_HOME/terminals/`. Each record has an opaque ID, title, launch kind, working directory, created time, process directory, revision and lifecycle state. Records and PTY artifacts are private (0700 directories, 0600 files) and written atomically. Creation accepts a required client-generated `request_id`; under a terminal-registry lock, the service reserves that ID and a terminal record before attempting the spawn. Retries find the reservation and return its running or failed state without spawning a second process. A reused ID with changed input returns `conflict`. A process whose spawn result is uncertain remains in a recoverable starting state until reconciliation; the service does not auto-launch it again. The service caps simultaneous live tabs and returns `conflict` for a stale rename or close revision. A dead process is reconciled to an exited record, never silently relaunched.

The operations are additive v3 operations: `terminal.list`, `terminal.create`, `terminal.rename`, and `terminal.close`. `terminal.create` accepts a required `request_id` and `{kind:"shell",cwd?}`. It never accepts a command string or argv from the API caller. Existing app-facing Pacer operations use their trusted internal argv construction and route their launch through the same terminal service, returning a terminal ID; they do not expose their argv as a new public parameter. The service resolves and validates directories and launch recipes, then starts a detached PTY host using argument vectors. The host's existing recording, snapshots, exclusive-control frames, bounded input and disconnect behavior are reused. The launch response includes the tab ID and a WebSocket path. `terminal.list` includes live/exited status, title, cwd, created time and geometry, but no environment variables or transcript content.

`/v3/terminals/:id/session` is an authenticated same-origin WebSocket endpoint using the existing session frame contract. It resolves only a terminal registry entry, then attaches to the corresponding local PTY socket or replays its recording after exit. The upgrade explicitly rejects work-grant and executor-role callers; only the app cookie or trusted local bearer may connect. The same Host, Origin and fetch-site checks used by task sessions apply. Input ownership remains exclusive across app windows. Terminal tabs are scoped to the local user, not to a particular browser window.

The app-facing action operations reuse their existing trusted command construction: account sign-in, account/runner interactive setup, strategy planning and configured-host SSH. Their app requests carry optional `request_id` fields for backward compatibility, and the same registry reservation/deduplication applies before launching the command. A repeated action and ID returns the same tab; a reused ID with different parameters returns `conflict`. Shell mode uses the user's configured login shell with a fixed login flag. The action result includes the integrated terminal ID. CLI and TUI callers retain their current behavior. A service action must not launch both integrated and external instances. Local task attachment navigates to `#/tasks/:id` and focuses that page's existing terminal view; it does not create a general terminal tab or launch a nested `pacer attach` process. Orca-backed task sessions retain their host-specific viewer. The integrated SSH action uses `["ssh","-o","BatchMode=yes","-o","ConnectTimeout=10",<configured alias>]` as argv, with no shell interpolation. It supports interactive remote shell use with preconfigured noninteractive authentication; password and passphrase prompts are intentionally unavailable under SEC-6. Remote live validation still requires separate maintainer authorization.

## App experience

The primary rail and narrow navigation gain a Terminal destination. The page has a tab strip with title and exit state, a New terminal action, a workspace selector or clearly shown default, split horizontally or vertically, and a close action that confirms when a live process will be stopped. A split displays two existing terminal tabs at once; each pane has its own focus and PTY geometry. Closing a pane leaves its terminal running until the tab is closed. Tabs are restored from `terminal.list` on mount and refreshed after reconnect; list order follows creation time and the selected tab is kept in the URL. An exited tab remains readable until closed.

The existing lazy xterm component gains a shell presentation mode rather than a second terminal renderer. It keeps theme tokens, FitAddon resize, screen reader mode, WebSocket reconnection and single-controller behavior. Shell mode labels input as going to the shell and provides search, copy/paste and a clear focus path. Terminal keyboard shortcuts must not steal shell input; global navigation shortcuts are suspended while the shell has control. On narrow screens the tab strip scrolls horizontally, the terminal resizes with the pane, and controls retain touch-size targets. Accessibility includes named tabs, selected state, visible focus, a polite connection/exit status and usable keyboard navigation.

When a Pacer action opens an integrated terminal, the app navigates to its tab. Local task attachment instead navigates to the Task page's existing terminal view. An operation that cannot start an integrated terminal shows a specific failure and a retry path. Existing external terminal affordances are no longer the app's default.

## Safety, compatibility and limits

- The service remains loopback-only; WebSocket upgrades use the established auth checks. No CORS or static Tauri capability is added (P6, SEC-3/4/8).
- An executor-role caller cannot create, rename, close or control a general-purpose terminal. The app's authenticated human session can. Terminal metadata and output may contain sensitive content and stay in private state; no transcript enters the snapshot, activity events or API results.
- Input and output size, backpressure, scrollback and terminal count are bounded. Shutdown sends TERM, waits for a bounded grace period, then KILL to avoid orphan shells. A service restart does not duplicate a still-running command.
- New fields and operations are additive. Protocol docs and embedded app assets are regenerated. User-facing behavior updates the terminal and testing docs and CHANGELOG (P4/P11, API-1/3, REPO-7).
- The live harness must recognize the new terminal operations and allow only sandbox-local shell tabs. It must refuse SSH and any operation that could change the real user environment. No live test targets the user's checkout or real Pacer home. SSH remains UNVERIFIED until a separately authorized remote test under SEC-6; a local release cannot claim CT-11 completion for that behavior before then.

## Validation and review

Tests cover directory validation, process persistence, create/list/rename/close conflicts, role policy, WebSocket authentication and reconnect, exclusive control, and command recipes. UI checks cover tabs, keyboard/focus, responsive containment and errors. `bun run typecheck`, `bun run test`, `bun run ui:check`, `bun run app:build` and protocol freshness run before review. CT-11 uses the sandbox service and the browser app to create a shell, run a harmless command in the disposable repo, navigate away and back, reconnect, resize, close, and inspect its recorded exit. Desktop behavior is exercised through the built Tauri app where available. Required before/after screenshots, the implementer compliance report, independent UI/accessibility and QA reports, and independent final-content project review live under `.work/`.

## Builder calls

The terminal uses the existing xterm bundle and visual tokens. No new terminal emulator dependency is needed. The exact maximum live-tab count and retention period follow existing session limits unless a measured limit requires a separate terminal setting. This design treats “no external terminal” as an app requirement; CLI and TUI remain terminal-native under ARCH-8.

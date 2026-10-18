# Clients over one local service decision — 2026-10-16

Status: owner decision recorded 2026-10-16.
Source: the 2026-10-16 UI/UX redesign of pacer's surfaces (web app overview,
review, session, settings and hosts; Orca panel; TUI; status line; tray;
notifications). The owner confirmed that the desktop app is one more type of
client, chosen for a native feel. This record builds on
[the app web UI decision](2026-10-15-app-web-ui.md) and
[the Orca plugin information-only decision](2026-10-15-orca-plugin-information-only.md),
and refines section 6 of the
[core contract design](../specs/2026-10-14-core-contract-design.md#6-clients-afterwards-out-of-scope-here-listed-for-direction).
The live-sessions design (`docs/specs/2026-10-16-live-sessions-design.md`,
proposed in PR #47) uses the same host/viewer split.

## Context

pacer now has, or plans, several surfaces: the web app at `/app/`, the
read-only Orca panel, `pacer dashboard` (TUI), `pacer status --line` for planner
status lines, a tray or menu-bar indicator, system notifications and a desktop
app. The redesign showed that the same screens appear in several of them.
Without a rule, each surface would grow its own copy of task, review and
session behaviour, and work would stop whenever the surface hosting it closed.

The protocol to share already exists. The v2 client protocol
(`PROTOCOL_VERSION` in `src/api/protocol.ts`, operations in `src/api/ops.ts`)
is served over HTTP and SSE by `pacer serve` and over JSON-RPC by
`pacer api --stdio`. The older v1 envelope in `src/link/envelope.ts` is the Orca
link transport, retired with protocol 3.0 on 2026-10-18.

The planner is not fixed: `PLANNERS` in `src/config/strategy.ts` lists
`claude-code`, `codex`, `cursor` and `opencode`.

## Decisions

- **D1. The local service owns all work.** `pacer serve` owns routing, the task
  lifecycle, scheduling, limits polling and live sessions (the PTY host in the
  live-sessions design). It keeps running when any UI closes, updates or
  crashes. A surface that goes away loses only its view.
- **D2. Every surface is a thin client of the v2 API.** The clients are:
  - the web app, served on 127.0.0.1 and openable in any browser, Orca's
    browser pane, or any desktop tool with a browser pane;
  - the Orca panel;
  - the TUI, `pacer dashboard`;
  - `pacer status --line`;
  - a tray or menu-bar helper;
  - the optional desktop app.

  No surface gets behaviour the API lacks. A missing capability is added to
  the core and exposed as an operation or event first, then used by surfaces.
  CLI commands that call the core in-process when no daemon runs (core
  contract decision 3) count as clients of the same core, not as a separate
  implementation.
- **D3. Several clients at once.** Operations must be safe when two or more
  clients act together: they validate the current state in the core, return a
  typed `conflict` error when it has moved on, and every client converges on
  the next snapshot or event. No client holds state that another client needs.
- **D4. The desktop app is a native wrapper around the web UI.** It gives
  pacer its own window, a tray or menu-bar item, actionable notifications and
  launch at login. It loads the same bundle the service serves at `/app/`, so
  there is never a second UI codebase. Tauri is preferred over Electron for
  its smaller footprint and use of the system webview. The app is optional:
  everything it does is also reachable from a browser and the CLI.
- **D5. Distributed outside the Mac App Store.** The App Store sandbox blocks
  access to agent credential folders, agent CLIs and SSH, which pacer needs.
  The desktop app ships as a signed and notarized download, with its own
  update channel.
- **D6. The CLI and TUI stay complete.** Headless and SSH-only users can do
  everything without a browser or desktop app.
- **D7. No surface assumes a planner or host app.** Nothing in a client
  depends on Claude Code, Orca or a particular planner from `PLANNERS`. Host
  integrations (Orca panel, planner status line, planner hooks) are adapters
  over the same API.

## Alternatives considered

- **Desktop app first.** Build a native app as the primary surface, as the
  core contract's decision 7 originally proposed. Rejected: it ties work to a
  process the user closes and updates, it does not reach headless or SSH-only
  users, and it would need its own UI codebase or would end up wrapping a web
  UI anyway. The app web UI decision already superseded it.
- **Orca plugin first.** Make the Orca panel the main place to act. Rejected:
  the sandboxed panel lost its state on each rewrite, could only send terminal
  text to the active worktree, and leaked console processes, which led to the
  information-only decision. It also makes pacer depend on Orca, which many
  users do not run.
- **Claude Code status line first.** Centre the experience on the planner's
  status line and hooks. Rejected: a status line has room for one line of
  budget and no way to review, delegate or watch a session. It also assumes
  Claude Code as the planner, while pacer supports four.

## Consequences

- One frontend serves the browser, Orca's browser pane and the desktop app.
  Design and fixes land once.
- The service becomes the single point that must stay healthy; its
  install, restart and update path (launchd on macOS, systemd user units on
  Linux, in `src/service/index.ts`) is critical infrastructure.
- Every new feature starts with an API change, which adds a step but keeps
  surfaces honest and lets third-party clients follow `docs/protocol.md`.
- Concurrency must be tested: two clients acting on one task, a client
  reconnecting after a gap, a client from an older version.
- The desktop app adds cost: an Apple Developer ID, signing and notarization
  in CI, Windows code signing if a Windows build ships, and an update channel
  that must stay in step with the service's protocol major version.
- A Windows desktop app requires Windows support in the engine first. Today
  the service manager handles launchd and systemd only, so the service, the
  supervisor and live-session PTYs need a Windows path before a Windows app
  is worth building.

## Open questions

- Whether the desktop app bundles its own `pacer` binary and service, or
  requires an installed CLI and only attaches to it.
- How the desktop app authenticates: the `pacer open` single-use code flow
  from the app web UI decision, or a token handed over locally at launch.
- Whether the tray helper lives inside the desktop app only, or also ships as
  a small standalone helper for users who do not want the app.
- Who owns system notifications when several clients are open, so the user
  is not notified twice.
## Retirement decision (2026-10-18)

The v1 Orca link is retired with protocol 3.0. The owner waived the release
gate; the Orca panel, TUI and app already consume the read model. The storage
bridge, channel sends, command lines, console and unversioned read routes are
removed. `/v2` is served through the compatibility adapter for one more pacer
minor release, then removed along with `hello.previous` and its reference doc.

## Revisit when

- A surface needs behaviour that cannot be expressed as an API operation or
  event.
- Windows engine support lands, or Tauri cannot meet a native requirement
  (notifications, tray, login items) on a supported platform.

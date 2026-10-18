# Implementing the redesigned pacer UI

Status: design agreed 2026-10-16. Builds on the [pacer app spec](2026-10-15-pacer-app-design.md), the [app web UI decision](../decisions/2026-10-15-app-web-ui.md), the [clients-over-one-service decision](../decisions/2026-10-16-clients-over-local-service.md) and the [live sessions spec](2026-10-16-live-sessions-design.md). The service behaviour and API contract the UI relies on are owned by the [UI functionality spec](2026-10-16-ui-functionality-design.md) (PR #50); this document only lists what the UI needs from it (see [Needs from the service](#needs-from-the-service)).

Reference design: the [redesign canvas](https://claude.ai/artifact/HyQe5GM84sRm3qUnRQNXxF) (start with `App.dc.html`, the clickable prototype), built on the [pacer design system](https://claude.ai/code/artifact/45ead394-e081-491f-a457-a4f772b09267). When the canvas and this spec disagree, the canvas wins on look (sizes, spacing, order on screen) and this spec wins on behaviour and words. A builder without access to the canvas gets an export of its boards from the owner.

## Why

The first app (PR #41) is a settings-shaped tool: a wide sidebar of seven sections, Home as one page among many. The redesign makes it a working view: compact, information dense, opening on what needs you and what is waiting for review, with executors shown as capacity and setup tucked behind a gear. This spec says how to build that without a second codebase, and in what order, so something useful ships early.

## Decisions

Owner decisions (this conversation, 2026-10-16):

1. **The desktop app is pacer's home.** It has its own window, Dock icon, menu-bar/tray item and system notifications, and stays open next to the editor all day.
2. **The browser tab is the fallback.** It is the same UI served by `pacer serve` at `/app/`, used when the desktop app is not installed and over SSH (port-forwarded) for remote machines.
3. **The Orca panel and the status line are for glancing, not acting.** This keeps the [information-only panel decision](../decisions/2026-10-15-orca-plugin-information-only.md).
4. **Overview and Review come first.** The first useful delivery is seeing what needs you and reviewing/accepting work fast.
5. **The desktop app requires pacer to be installed separately.** It does not bundle the `pacer` binary; the app and the CLI release independently, and the app tells people to install pacer when it cannot find it.
6. **No Apple Developer ID yet.** The first desktop builds are unsigned and for the owner only; signing and notarization are a separate step before anyone else gets the app.
7. **The frontend stack was handed to the implementer;** the choices below were proposed in the brainstorm and accepted.

Implementer's calls (accepted, but open to revisiting in review):

8. **Keep Preact, TypeScript/TSX and `Bun.build`**, and keep embedding the bundle in the binary (`src/app/assets.generated.ts`). No React, no Vite.
9. **One web UI for app, browser and desktop.** The Tauri shell loads the UI from the local `pacer serve`; it has no screens of its own and no second data path.
10. **Tokens are generated from the design system, never hand-edited**, with a build check against drift.
11. **xterm.js for the session view**, in a lazily loaded chunk.
12. **Tauri v2** for the desktop shell, in its own `desktop/` folder with its own release.
13. **Shared view models, not shared components, across surfaces.** The Orca panel, TUI, `pacer status --line` and the tray render the same view-model output with their own renderers.

## Goals

- The working view from the canvas, in the desktop app and in a browser, from one codebase.
- Answers first: Needs you and Review lead; a glance at the top bar says whether the planner is on pace.
- The app, canvas, Orca panel, TUI, status line and tray say the same thing in the same words, from the same data.
- Fast enough to leave open all day: first paint of Overview under 300 ms from a warm service on a laptop; no frame drops while events stream.
- Keyboard-first for review: you can clear a review queue without touching the mouse.

## Non-goals

- Deciding service behaviour or API shape (owned by the functionality spec).
- A desktop app that talks to remote pacer services directly. Remote machines are reached by forwarding the port of their `pacer serve`.
- Mobile layouts beyond keeping the narrow layout usable at phone width.
- Theming beyond light, dark and system.

## Anti-goals (failure even if it works)

- A second frontend codebase (desktop-only screens, a separate panel app).
- Clients computing decisions the service owns: which executor to retry on, what "needs you", what counts as on pace. The UI renders `actions` and verdicts it is given.
- Colour-only status, the `track` (lime) accent used as a status colour, or more than one primary (ink) button per screen.
- Keystrokes reaching an agent while the user has not explicitly taken control.
- A token value typed by hand in app CSS that differs from the design system.

## Surfaces and where their code lives

| Surface | Renders with | Data | Acts? |
| --- | --- | --- | --- |
| Desktop app (Tauri) | the web UI, loaded from `http://127.0.0.1:<port>/app/` | `/v2` over the cookie session | yes |
| Browser tab | the same web UI | same | yes |
| Narrow layout ("this repo first") | the same web UI below 560 px wide, or with `?scope=repo:<key>` | same | yes |
| Orca panel | static HTML from the plugin, script-free (decision above) | link snapshot | no, selectable commands only |
| `pacer dashboard` (TUI) | `src/dashboard/render.ts` | v2 client | yes (terminal) |
| `pacer status --line` | `src/render/line.ts` | local link | no |
| Tray / menu bar | native menu in the Tauri shell | `/v2` from the shell | a few: Delegate, Open, Switch strategy, Pause |
| Notifications | the Tauri shell when it is running; otherwise `pacer serve` as today | events | buttons that open a screen or call an action |

### Code layout

```
app/
  build.ts            # Bun.build; writes src/app/assets.generated.ts
  index.html
  src/
    main.tsx          # mounts <App/>, picks layout
    data/             # api.ts, store.ts (snapshot + events), selectors, jobs, ws session client
    shell/            # Rail, SettingsPanel, TopBar, Layout (wide / narrow), CommandHelp
    screens/          # Overview, Review, Sessions, Session, Settings/*, AddExecutor, Hosts, HostDetail, Delegate
    ds/               # generated tokens.css + tokens.ts, components.css, Button, Pill, Card, Mark,
                      # UsageMeter, AgentMark, StatusGlyph, Tooltip, Kbd
    term/             # xterm.js view (lazy chunk)
    keys/             # shortcut registry
src/view-model/       # shared, DOM-free: attention, capacity, planner meter, counts, words, times
desktop/              # Tauri v2 shell (Rust + tauri.conf.json), released separately
scripts/ds-sync.ts    # pulls tokens from the design system, writes app/src/ds/tokens.json
```

- `app/src/model/` view models that other surfaces also need move to `src/view-model/` (dependency-free, as `src/view-model/panel.ts` already is). App-only models stay in `app/src/data/` or next to the screen.
- Build output becomes three files plus a chunk: `index.html`, `app.js`, `app.css`, `term.js` (xterm.js and its CSS, loaded with `import()` when a session view opens). The CSP (`script-src 'self'`) already allows this.
- Bundle budget: `app.js` under 60 KB gzip without the terminal chunk; `term.js` under 150 KB gzip. The build prints both and a test fails above budget.

## Desktop shell (Tauri v2)

The shell is a thin native frame. Everything visible inside the window is the web UI.

- **Window.** Loads `http://127.0.0.1:<port>/app/` (port from `PACER_HOME`/the service's own discovery file, via the CLI). Remembers size and position. Minimum size 720×520; below 560 px the web UI switches to the narrow layout on its own.
- **Two clients in one app (my call).** The shell is itself a v2 client, separate from its webview:
  - The **Rust side** signs in with the service's desktop sign-in (Needs from the service, item 10), holds its own session and keeps one event stream open for as long as the app runs, including when the window is closed (the app stays in the tray). The tray and notifications are fed from that stream, so they never depend on the page being loaded.
  - The **webview** gets its own cookie session the same way (the shell hands it a one-time code and navigates to `/app/auth?code=…`) and runs the web UI exactly as a browser would.
  - The page reaches the shell only through a small Tauri IPC allow-list, enabled for the `http://127.0.0.1:<port>` origin only: `setLaunchAtLogin(bool)`, `setTheme(system|light|dark)`, `notifyRoute(route)` (the page tells the shell where it is, for deep links). The shell reaches the page only by navigating to a hash route. No data is relayed between them; both read the service.
  - The web UI detects the shell (`window.__TAURI__`) and shows desktop-only settings (launch at login) only there.
- **Finding pacer.** The app does not bundle the CLI. It looks for `pacer` on the login shell's `PATH` and in the standard install locations. If none is found, it shows "Install pacer first" with the install command and a link to the install docs, and checks again when the window regains focus.
- **Service not running.** The shell shows a native page: "pacer isn't running" with **Start pacer** (runs `pacer service install`/start through the installed CLI) and the command to run by hand. When the service comes back, it loads the app.
- **Version skew.** Because the two release independently, the shell reads `/v2/hello` and refuses to load only on a protocol major mismatch ("Update pacer" or "Update the pacer app", whichever is older); minor differences are fine.
- **Tray / menu bar.** Icon: the pacer mark with the planner's percentage; a dot only when something needs you, maintained by the Rust client's snapshot and event stream. Left-click toggles a rich webview popover like the Tray board. The separate `/app/tray.html` page reads `/v2/snapshot` and `/v2/events` using the main webview's cookie session. The shell pre-creates it hidden after the main window finishes signing in: label `tray`, frameless, transparent, always on top, non-resizable, skipped from the taskbar, 340 px wide (TrayPopover board). `tauri-plugin-positioner` anchors it below the icon at `Position::TrayBottomCenter`; it hides on blur or Esc (the page invokes `tray_hide`). Its size and position are excluded from saved main-window state.
  - The page uses only `tray_resize({height})` (clamped to 120–520 px, width fixed at 340 px, re-anchored under the icon), `tray_open({route})` (shared route validation, shows and focuses the main window at that hash route, then hides the popover), `tray_hide()`, and `app_quit()`. These runtime capability grants apply only to the `tray` window on the active `http://127.0.0.1:<port>` origin; each command also checks the caller's label and origin. Without `window.__TAURI__`, links open `/app/#<route>` and resizing is skipped.
  - Right-click keeps a minimal native fallback menu: Open pacer, Pause 1h / Resume, Quit.
- **Notifications.** When the shell runs, it posts system notifications for `alert` events whose notification level passes the user's setting, with up to two buttons taken from the event's `actions`. Clicking opens the matching screen (`pacer://review/<id>`, `pacer://session/<id>`). `pacer serve` must not post duplicates while a desktop client is connected (Needs from the service).
- **Deep links.** `pacer://` URLs map one-to-one to web routes (`pacer://review/t-0412` → `#/review/t-0412`). The CLI's `pacer open <screen>` opens the desktop app when it is installed, otherwise the browser.
- **Launch at login**, off by default, toggled in Settings › General (stored by the shell, not in pacer config).
- **Updates.** The web UI updates with the pacer binary, so most changes need no new desktop build. The shell itself updates by hand until signing exists, then with Tauri's updater (see Release).
- **Platforms:** macOS (arm64, x64) first; Linux (AppImage/deb) second. Windows follows the service.
- **Release:** separate workflow and tag (`desktop-v<version>`); the pacer CLI release is unchanged. The Rust toolchain is needed only for `desktop/`.
  - **First (Phase 2):** unsigned macOS builds for the owner only, built locally or by a manual workflow; opened with right-click › Open the first time. No auto-update channel yet: the owner installs new builds by hand.
  - **Later (Phase 2b):** once an Apple Developer ID exists, a signed and notarized download outside the Mac App Store (ADR D5), with Tauri's updater on a signed update feed. Nothing is published for other users before this step.

## Porting the prototype

The canvas is the visual reference. Inline styles in the canvas become classes in `components.css`/`styles.css` using tokens; no inline colour values in TSX.

### Shell

- **Rail** (56 px, icon-only): pacer mark, divider, Overview, Review, Sessions; spacer; gear at the bottom.
  - Each icon has a tooltip (shown on hover and on keyboard focus, `role="tooltip"`, referenced by `aria-describedby`) and an `aria-label` with the count ("Overview · 3 need you").
  - Badges: warn fill for Overview and Review counts, info for Sessions. Counts come from snapshot `counts`.
  - The gear shows a warn dot when setup has an open item.
- **Settings panel** (220 px, opens to the right of the rail): General, Remote hosts (with a count badge when a host has a problem), Add executor. Opening it routes to the first item; closing returns to the last working screen. `Esc` closes it.
- **Top bar** (44 px): screen title; then, right-aligned, the planner meter (AgentMark of the current planner, 80 px `UsageMeter` with the pace tick, "63%·77"), the mode pill (only when not Normal, in words), a live dot with the last-update time, and **Delegate** (the one primary button). The live dot turns grey with "Reconnecting…" while the event stream is down.
- **Delegate** opens a dialog (not a page) over the current screen: goal, done-when command, repo (defaults to the filter), executor (Auto by default). It reuses today's Delegate model.

### Routes

Hash routes, one static `index.html`, as today.

| Route | Screen |
| --- | --- |
| `#/` | Overview |
| `#/review` and `#/review/<task>` | Review (queue on the left, first item selected) |
| `#/sessions` and `#/sessions/<task>` | Sessions list (the Running section at full width) and Session view |
| `#/settings` and `#/settings/<section>` | Settings › General, scrolled to a section (planner, accounts, executors, routing, strategies, updates, notifications, appearance) |
| `#/settings/hosts` and `#/settings/hosts/<alias>` | Remote hosts |
| `#/settings/add-executor` | Add executor |

- Query `?repo=<key>` sets the repo filter on any screen and survives navigation; `?scope=repo:<key>` additionally means "this repo first" (narrow layout default for Orca browser tabs).
- Old routes (`#/tasks`, `#/tasks/<id>`, `#/executors`, `#/accounts`, `#/strategy`, `#/hosts`) redirect to their new homes for one minor release.

### Overview

Order is fixed: Needs you, Running, Capacity, Done today, Activity (the canvas's Main board).

- **Repo filter**: chips "All repos" plus one per repo with a count of needs-you + running items; pressed state in ink. `aria-pressed` on each chip; `/` focuses the chip row.
- **Needs you**: attention cards (`bad` tint for failures, default for waiting reviews), each with a status glyph (✕ failed, ◐ waiting/stuck) in the matching `*-fg`, AgentMark, goal, one detail line, and up to two buttons rendered from the item's `actions`. Empty: "Nothing needs you." with the count hidden in the rail.
- **Running**: dense rows (36 px): AgentMark, goal, repo, phase pill, elapsed, changes, last output ("idle 6m" in warn when the service says idle), and **Watch** (to the Session view) or **Stop** for queued.
- **Capacity**: one row per executor: mark, name, a sub-line in words ("on pace · this Mac + devbox"), `UsageMeter` with the pace tick when the service gives a pace, used %, slots "2/3". Broken executors are dimmed with a bad-fg sub-line. Clicking a row opens Settings › Executors at that executor.
- **Done today** and **Activity**: compact lists with absolute times.

### Review

Three columns, as the Review board: queue (260–300 px), the item (fluid), verdict panel (280–320 px).

- The item shows title and status pill, the run line (executor id, duration, branch → base, repo, finished at), three facts (Done when + result, Why this executor, Cost), the brief (collapsible), the executor's summary, and Changes (file list with +/− and the diff of the selected file, syntax-plain, mono, `good-bg`/`bad-bg` lines).
- Verdict panel: **Accept and bring back** (primary), Send back, Reject (bad outline), "Or retry on" select (options and their availability words from the service), Kind select (classifier correction), Note. A footer shows the equivalent CLI command.
- Keys: `j`/`k` move in the queue, `a` accept, `r` reject (asks for a note first, `Enter` confirms), `s` send back, `t` focuses retry, `o` opens in editor. After a verdict the next item is selected; an empty queue shows "Review queue is clear" with today's totals.
- Large diffs: render the file list at once and each file's diff on selection; files over 2,000 lines show the first 2,000 with "Open in editor".

### Sessions and the Session view

See [Session view](#session-view-embedded-terminal).

### Settings

Settings › General is one scrolling page with section anchors (the Settings board): Planner & pacing (policy segmented control, planner reserve, account mode), Accounts (Add account, Link Orca account), Executors (order, enable toggle, check status), Remote hosts summary, Routing (rules, Add rule), Strategies (Use, New from a brief), Updates & plugin (Check now), Notifications (Off / Important / All), Appearance (System / Light / Dark; launch at login in the desktop app).

- Each control saves on change through its op and shows the result inline (saved, or the op's `message` and `hint` next to the control). Consent previews (planner change, connecting an agent) keep the rules from the app spec.

### Add executor

A four-step flow in a centred card (the AddRunner board): agent → account → where it runs (this Mac or a host) → model & checks, with the generated executor id shown as you go. "Ready" only after the test task passes (job progress shown in place). Back keeps entered values; leaving keeps a draft in `sessionStorage`.

### Remote hosts

List and detail (the HostDetail board): Connect and check, Run checks, Open SSH terminal, Pause new work; slots, executors on the host, checks, repositories (Map a repo), account folders, worktrees on host (Clean up N), Remove host. Long checks and clean-ups are jobs with progress in place.

### Narrow layout ("this repo first")

Below 560 px wide, or with `?scope=repo:<key>`: the rail becomes a bottom bar with the same three icons and the gear; the top bar keeps the title, the planner meter and Delegate; Overview shows the Panel board's order: scope toggle (This repo · All repos), Needs you (with "+N in other repos"), Running, Capacity (compact), Done today. Buttons in this layout are 44 px tall. It is the same component tree with layout classes, not a separate screen set.

## Design tokens

- **Source of truth:** the pacer design system's `tokens.json`. `scripts/ds-sync.ts` reads a local copy (exported from the design-system artifact by a maintainer, committed as `app/src/ds/tokens.json`) and generates `app/src/ds/tokens.css` and `tokens.ts`. `app/build.ts` already generates CSS from the JSON; this extends it, it does not replace it.
- **Drift check:** a test regenerates the CSS from the committed `tokens.json` and fails if `tokens.css`/`tokens.ts` differ. Updating tokens is a manual step: the owner exports `tokens.json` from the design-system artifact, `bun scripts/ds-sync.ts <file>` copies it in, and the token diff shows in review.
- **Design-system changes the app needs** (the `terminal` tokens, `AgentMark`, the README fix, listed below) are made by the owner in the design system. The app does not wait: it adds them as provisional entries in a separate `app/src/ds/tokens.local.json`, merged at build time, and a test lists every provisional entry so it is removed once the design system has it.
- **Dark mode:** tokens carry light and dark values; CSS uses `prefers-color-scheme` guarded by `:root:not([data-theme="light"])`, plus `:root[data-theme="dark"]`. The Appearance setting sets `data-theme` (stored per device, `localStorage`, defaulting to System). The Tauri window follows the same attribute.
- **Density:** body 13/19, caption 12, label 11/600 uppercase 0.06em; list rows 30–36 px; buttons 32 px in rows, 44 px in the narrow layout and in forms. Use the token scale only (`--space-*`, `--radius-*`).
- **Numerals:** `font-variant-numeric: tabular-nums` on `body`; mono for ids, branches, paths and commands, always selectable.
- **Terminal colours:** the session view's palette (canvas: `#09090b` ground, zinc text, the ANSI set used in the boards) becomes a `terminal` token group, the same in both themes. If the design system lacks it, it is added there first (Needs from the design system, below).

## Shared pieces

### AgentMark

- One component, `AgentMark({agent, size})`, used by every screen, the tray (as template images rendered at build time) and, as colour names, the TUI and status line.
- Glyphs are vendored SVG paths with their licences: Simple Icons (CC0) for Claude, Cursor, Google/Antigravity, ByteDance/BytePlus, LM Studio/Local model, OpenCode, Gemini; Lobe Icons (MIT) for the OpenAI/ChatGPT mark. A `NOTICE` entry credits Lobe Icons.
- Each mark sits on a rounded tile (`radius = size × 0.28`) tinted with its brand colour at 14% (`color-mix`), glyph at 66% of the tile.
- Brand colours: Claude `#D97757`, Antigravity `#4285F4`, BytePlus `#3C8CFF`, Gemini `#8E75B2`; Cursor, Local model and OpenCode in `ink`.
- **Codex uses the ChatGPT mark in `ink` on a `surface-page` tile with a 1 px `line` hairline**, so it is black on white in light mode and white on black in dark mode without a second asset.
- Unknown agents get a two-letter monogram on an `ink` tile.
- The design system README still says Codex is a "Cx" monogram; that line is updated in the design system to match the canvas (Needs from the design system).
- `aria-label` is the agent's name; when a name is printed next to the mark, the mark is `aria-hidden`.

### UsageMeter

- Bar (`surface-lane` track, fill by verdict tone), a 2 px `ink` pace tick at the pace percentage, rounded ends. Sizes: 80×6 (top bar), 100%×8 (tray, capacity), 100%×6 (rows).
- No pace (unmetered, no window): no tick, and the label says why ("unmetered").
- Text always beside it: "63% used · pace 77%" or the compact "63%·77". `role="meter"` with `aria-valuenow`, and `aria-valuetext` in words ("63% used, pace 77%, behind pace").

### Status

- `StatusTone = good | warn | bad | info | neutral`, mapped from service verdict strings in one table in `src/view-model/words.ts`, used by every surface.
- Pills always carry words. Glyphs (✕ ◐ ✓) only appear with text. `track` is never used for status.

## Session view (embedded terminal)

Implements the viewer side of the [live sessions spec](2026-10-16-live-sessions-design.md). The app speaks the session socket frames over `GET /v2/tasks/<id>/session` (WebSocket); it never interprets the agent's output beyond rendering it.

- **Layout** (the Session board): header (AgentMark, goal, executor id, repo, branch, machine, started at, phase pill, "6 files · 2 commits · output 3s ago", Stop). Tabs: Terminal, Changes so far, Brief. Right column: Watch it elsewhere (Open in Orca terminal, Open in my terminal, `pacer attach <id>` with Copy), Done when, Timeline, Stop and retry on.
- **Terminal:** xterm.js in `term.js`, loaded on first open. On connect the client sends `hello {client: "app", label, cols, rows}`, renders `snapshot` (scrollback then screen), then appends `output`. It keeps the byte offset and reconnects with `from` after a drop (backoff 0.5 s → 5 s), falling back to a fresh snapshot on `resync`.
- **Read-only by default.** The status strip under the terminal says "Watching · read-only — nothing you type reaches the agent". xterm's `disableStdin` stays on; the terminal has no ink border.
- **Take control:** the button sends `take`. If someone else holds control, the app asks "Someone is in control from <label>. Take over?" and sends `take {force: true}` only on yes. While in control: a warn-fill 2 px border, "You have control — keystrokes go to the agent. Ctrl-] to release.", `disableStdin` off, input frames sent as binary, and `size` sent on resize (debounced 150 ms). `Ctrl-]` (and the button) sends `release`. A `control {reason: "taken"}` frame drops back to read-only with a notice.
- **Size:** read-only viewers render at the PTY size and scale the xterm element to fit the pane (CSS transform, never reflow). The status strip shows the PTY size.
- **Keyboard capture:** while in control, app shortcuts are off except `Ctrl-]`; while read-only, the terminal is focusable for selection and scrolling, and app shortcuts work.
- **Ended sessions:** an `exit` frame shows "Exited with code N at 12:14" and keeps the scrollback; offline replays come from the same endpoint (the service synthesizes frames).
- **Other hosts:** `host: "orca"` shows "This session runs in Orca" with **Open in Orca**; `host: "none"` shows the plain log (today's follow log) with a note. Remote sessions are read-only until the service supports control there; the take button is hidden when `capabilities.control` is false.
- **Accessibility:** xterm's `screenReaderMode` is a toggle in the status strip; control state changes are announced in a polite live region.
- **Sessions list** (`#/sessions`): the Running section at full width plus recently ended sessions with "Replay".

## Live data

- **Load:** `GET /v2/snapshot`, then `GET /v2/events?since=<seq>` (EventSource). The existing store (`app/src/store.ts`) stays the core: a pure reducer plus an effects wrapper. It grows to hold the new snapshot fields and entity events (upsert by id, `{id, removed: true}` deletes) defined by the functionality spec, and keeps today's rules: a `reset` event or a gap triggers a fresh snapshot; reconnect refreshes.
- **Selectors** are pure functions over the store, memoised per state object: `needsYou(scope)`, `running(scope)`, `capacity()`, `doneToday(scope)`, `counts()`, `repos()`, `plannerMeter()`. The same functions (from `src/view-model/`) feed the TUI, status line, tray and Orca panel.
- **Screen data not in the snapshot** (diffs, briefs, settings, host details) is fetched with ops when a screen opens and refetched on a matching `config` area or entity event, as today.
- **Actions:** a button calls the op in its `action` and shows a pending state on that button only. Success is shown when the resulting event arrives (not optimistically); a 10 s timeout without an event re-fetches the snapshot. Errors show the op's `message` and `hint` next to the button. A `conflict` error (another client acted first, ADR D3) shows "Already handled from <client>" and the item updates from the next event; it is not shown as a failure.
- **Jobs:** an op that returns `{job}` binds the control to that job; `job` events drive an inline progress line and the final result.
- **States:**
  - First load: skeleton rows in the section shapes for up to 1 s, then "Connecting to pacer…".
  - Disconnected: content stays; the top bar shows "Reconnecting…"; a bar appears after 5 s: "pacer isn't responding. Retrying…".
  - Session ended (401): "Session ended" page with `pacer open` (browser) or an automatic re-auth (desktop shell).
  - Empty: each section says what to do next ("No executors yet. Add one." with the link).
  - Stale budgets: the meter is drawn at reduced opacity with "as of 11:40".
- **Times:** relative in live sections ("8s ago", "14m"), absolute in Done today, Activity, Review and anywhere not live. One formatting module in `src/view-model/format.ts`.

## Keyboard shortcuts

A single registry (`app/src/keys/`) owns shortcuts, shows them in a `?` overlay, and disables single-key shortcuts while focus is in a text field, a select, or a terminal in control.

| Keys | Where | Does |
| --- | --- | --- |
| `g o` / `g r` / `g s` | anywhere | Overview / Review / Sessions |
| `,` | anywhere | open Settings |
| `d` | anywhere | Delegate dialog |
| `/` | Overview | focus the repo filter |
| `j` / `k`, `Enter` | lists, Review queue | move, open |
| `a` / `r` / `s` / `t` / `o` | Review | accept / reject / send back / retry on / open in editor |
| `w` | a running row | watch the session |
| `Ctrl-]` | Session view | release control |
| `Esc` | dialogs, settings panel | close |
| `?` | anywhere | shortcut help |

In the desktop app, `⌘D` (Delegate) and `⌘O` (open window) also work from the tray menu.

## Accessibility

- Every rail icon has an accessible name and a tooltip on focus; `aria-current="page"` marks the screen.
- Landmarks: `nav` (rail), `aside` (settings panel), `header` (top bar), `main`; a skip link to `main`.
- Status is never colour alone; contrast for `*-fg` on `*-bg` is 4.5:1 (from the design system); focus rings use `--focus` tokens and are always visible on keyboard focus.
- Live regions: one polite region for connection state and action results; attention count changes are announced at most once per 10 s.
- Respects `prefers-reduced-motion` (no animated meters or skeleton shimmer).
- Tested with VoiceOver on macOS for the Overview and Review journeys.

## Keeping the other surfaces in step

- **One vocabulary.** Words for verdicts, phases, modes and times live in `src/view-model/words.ts` and `format.ts`. The app, TUI, status line, tray and Orca panel import them; none spells a status on its own.
- **One order.** Needs you → Running → Capacity → Done today on every surface that shows more than a line (canvas: app, Orca panel, TUI, tray).
- **One data source.** Every surface reads the service's snapshot and events (the status line through the local link, as today). Counts in the rail badges, tray dot, status line `⚑N` and TUI header come from the same `counts` field.
- **TUI** (`pacer dashboard`): its model (`src/dashboard/model.ts`) is rebuilt on the shared selectors; layout follows the Terminal board (planner meter line, NEEDS YOU with inline actions, WHO RUNS NEXT, RUNNING, DONE TODAY) and the TerminalSettings board. The Attach action follows the live sessions spec.
- **Status line:** `src/render/line.ts` follows the StatusLine board: mark (tick amber ahead, red out), planner name in its brand colour, `used%·pace`, `▸running`, `⚑needs` (hidden at 0), mode when not normal; width-aware down to `▬┃63 ⚑1` at ≤20 columns; `--json` emits the same fields; offline says `pacer not running · pacer serve`.
- **Orca panel:** stays script-free static HTML; its sections follow the Panel board (this repo first, "+N in other repos") using the shared selectors and the generated `tokens.css`; actions appear as selectable commands, and "Open pacer" opens the desktop app or browser.
- **Golden tests:** one fixture snapshot (`test/fixtures/ui/snapshot.json`) is rendered by every surface; each output is snapshot-tested, and a cross-surface test asserts the same counts, verdict words and order appear in all of them.

## Testing

- **Unit** (`bun test`): reducer and selectors (new snapshot fields, entity upserts, gaps and resets), shortcut registry (disabled in inputs and in control), route parsing and redirects, token generation and drift, AgentMark table (every agent has a label, path or monogram, colour), UsageMeter ARIA values, words/format tables.
- **Component** (Preact render to string or happy-dom): Overview sections with empty/loading/error states; Review verdict flow; narrow layout switch.
- **Session client:** a fake session socket over WebSocket in the test server: snapshot then output, resume with `from`, `resync`, take/force/release, exit, read-only input dropping.
- **Server integration:** `startServer` on port 0 with a temp `PACER_HOME`; the app loads, authenticates with the code exchange, and receives events (as today).
- **Real UX, before each phase's PR is called done:** in the desktop app and in a browser against an isolated `PACER_HOME`: clear a review queue by keyboard; retry a failure from Needs you; watch a session, take and release control; leave Overview open for an hour; restart the service with the app open; switch light/dark; VoiceOver pass on Overview and Review. Each journey is recorded for the owner.
- **Desktop shell:** a smoke test on macOS (CI if a macOS runner is available, otherwise a scripted local run recorded in the PR) that builds the shell, starts a service on a temp home, and checks the window reaches `/app/` signed in.

## Build order

Each phase is its own PR (or small stack), ships something usable, and keeps the old screens working until they are replaced.

0. **Foundations.** Token sync and drift check; move shared view models to `src/view-model/` (words, format, attention, capacity, counts); `AgentMark`, new `UsageMeter`, `StatusGlyph`, `Tooltip`, `Kbd`; store support for the new snapshot fields and entity events (behind a protocol-version check, so it still works against today's service); shortcut registry. No visible change beyond marks and meters.
1. **New shell, Overview and Review (browser).** Rail, settings panel (pointing at the existing settings screens for now), top bar with planner meter, Delegate dialog, Overview with repo filter, Review with the verdict panel and keyboard flow. Old routes redirect. *This is the first useful delivery.* Needs the service's `attention`, `executors`, `counts`, `repos` and task `repo` (see below). My call: Phase 1 waits for those rather than reading today's snapshot through `attentionGroups`, because that model picks retry executors on the client, which the anti-goals forbid. Phase 0 does not wait and can land first.
2. **Desktop app (unsigned, owner only).** Tauri shell: finding the installed pacer, window, sign-in, "pacer isn't running" page, native tray menu, notifications with actions, deep links, launch at login; unsigned macOS app and Linux AppImage / .deb builds (x86_64 and arm64 where runners allow), manually dispatched artifacts; Linux notifications omit action buttons and the tray popover falls back to top centre; `pacer open` prefers the desktop app when installed.
   2b. **Signed release** (when an Apple Developer ID exists): signing, notarization, the updater feed and a public download.
3. **Settings, Add executor, Remote hosts.** Port the Settings, AddRunner and HostDetail boards onto the new shell, with jobs for checks and tests; remove the old Executors, Accounts, Strategy and Hosts screens.
4. **Sessions.** Sessions list and Session view with xterm.js, take/release, watch elsewhere; depends on the live sessions spec's app-facing phase (`task.session`, the WebSocket bridge).
5. **Narrow layout and the other surfaces.** "This repo first" narrow layout; TUI, status line, tray and Orca panel moved onto the shared selectors and words, with golden cross-surface tests.
6. **Clean-up.** Remove redirects and the last old screens; Linux desktop build.

## Needs from the service

Requirements for the [UI functionality spec](2026-10-16-ui-functionality-design.md) to settle (shape is theirs; the UI needs the information). The sibling's current direction already covers items 1–6.

1. **Needs-you items** derived by the service, each with a kind (failed, review, stuck, host down, planner), severity, the task or entity it refers to, a one-line detail in words, and ready-made `actions` (op, params, label, and which is primary). The UI never builds "Retry on Codex" itself.
2. **Capacity rows** per executor: agent, display name, sub-line in words, verdict tone, used %, pace % (or none, with a reason), slots busy/total, broken/blocked state with reason.
3. **Planner meter**: planner agent and name, used %, pace %, verdict, window, reset time, stale flag; and the current mode with whether it differs from Normal.
4. **Counts** for badges: needs you, waiting for review, running, setup items open, hosts with problems.
5. **Repos**: list with a stable key and label, and `repo` on every task, so the filter is client-side.
6. **Entity events** (upsert/remove) for attention, executors, hosts, jobs and activity; and **jobs** with progress for long operations.
7. **Review detail** in one op: brief, executor summary, done-when command and its result (passed/failed, counts, duration, where it ran), why this executor (in words), cost (executor share of window, planner share), changed files with +/−, and per-file diff on request; plus the list of retry targets with availability words.
8. **Verdict ops** for accept-and-bring-back, send back (with note), reject (with note and kind), and retry on a chosen executor, each returning the resulting task state or a job.
9. **Done today and activity**: recent finished tasks with verdict and time; an activity feed (budget refresh, mode changes, failures, executor status changes) with level and time.
10. **Desktop sign-in**: a way for the desktop shell to sign in without a terminal, for both its native client and its webview (PR #50 proposes a token-file → cookie exchange, `POST /v2/session/exchange`, alongside the `pacer open --print` code), and a way to tell the service a desktop client is connected.
11. **Notification hand-off**: while a desktop client is connected, `pacer serve` does not post its own system notifications; alerts carry `actions` and a target route for the click.
12. **Session endpoint** as in the live sessions spec: `task.session`, the `/v2/tasks/<id>/session` WebSocket, and `TaskData.session` in snapshot/events; plus "Changes so far" (files changed in the worktree while running) and a timeline of the task's steps.
13. **Settings data** already listed in the app spec (config, accounts, runners, routing, strategy, hosts, notifications, updates) plus: executor order and enabled flag, per-executor last check (result and time), host detail (slots, checks, repos mapped, account folders, worktrees to clean).
14. **Pause delegation for a duration** and **switch strategy** as ops (tray menu).
15. **Protocol version in `/v2/hello`** that the UI and the desktop shell can gate features on.

## Needs from the design system

- A `terminal` token group (ground, foreground, ANSI 16) used by the session view and the TUI boards.
- The README's iconography section updated: Codex uses the ChatGPT mark (ink on page with a hairline), not a "Cx" monogram; Lobe Icons (MIT) credited alongside Simple Icons.
- `AgentMark` added to the system's components so the canvas and app share one definition.

## Left to the builder

- Exact component boundaries and file names inside `app/src/`.
- Skeleton shapes, animation timings (within reduced-motion rules) and debounce values not given above.
- Diff rendering details (wrapping, word-level highlights) as long as large files stay responsive.
- How the Tauri shell discovers the binary and port, within the rule that it uses the CLI and never reads secrets.

## Not in this version

- Connecting the desktop app to remote services directly; multi-machine views.
- Windows desktop builds.
- Interactive agent TUIs inside the session view beyond what the live sessions spec ships.

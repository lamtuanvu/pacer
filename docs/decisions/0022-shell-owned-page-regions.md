# Shell-owned page regions: static page header, single main scroller, real side panels

Date: 2026-11-05

Status: Proposed. Accepted when the maintainer merges it.

Context: [design-system.md](../design-system.md) ("Frame slots"), [shared UI foundations ADR](2026-10-19-shared-ui-foundations.md), `app/src/shell/{AppFrame,Layout,slots}.tsx`.

Screens built their own two-column layouts for a "selected item" or "where this goes" panel (Tasks' `.pc-tasks-page__columns` beside `.pc-task-aside`, New task's `.pc-new-task__cols` beside `.pc-new-task__aside`), each with its own sticky positioning, border and fixed width. Meanwhile a page's own header (title, actions, filter tabs) lived inside the single scrolling region (`.pc-work`), so scrolling a long list also scrolled the header and filter strip out of view — exactly the regions a user needs to keep visible while reading the list below them.

The shell already owns one real side-panel mechanism (`FrameSlot name="left"/"right"`, backed by `SidePanel`), used by Workspace and the Session screen. Tasks and New task did not use it for their asides, so those asides never behaved like shell panels (no shared toggle, no `Alt+⌘B` shortcut, no persisted open state) and duplicated panel-shaped CSS locally.

## Decision

The app shell owns every fixed region of the window; a screen never builds a page-local column for content that belongs beside it.

- A new `FrameSlot name="header"` region, backed by a `pc-page-head` div `AppFrame` renders inside the work area immediately before `main`. A screen fills it with its own header, identity and filter strip. It is non-scrolling, carries the page's horizontal padding, and renders empty (no space taken) when no screen fills it.
- `main` becomes the frame's single scroll container (`overflow:auto; min-height:0`). `.pc-work` becomes a plain, non-scrolling flex column that frames the page head and `main`; the desktop overflow-clip chain is extended one level, from `.pc-body` through `.pc-work`, with `main` left as the one `overflow:auto` escape hatch, mirroring the existing browser rule.
- Tasks and New task move their asides into the real `right` `FrameSlot`, with an in-page fallback for `frame.inline` (the same pattern Workspace already uses for its own right panel), instead of a page-local flex column. A `tasksPanels` flag (mirroring `newTaskPanels`) makes the Tasks board's right region a first-class shell panel: shared open/close state (`usePanelState`), the title-bar "Toggle right panel" control, the `Alt+⌘B` shortcut and `View › Toggle right panel` command, and the shared close cascade (`closeLayoutView`). The same fix also wires `newTaskPanels` into the frame's actual `right` region condition, which previously only checked `workPanels` — New task's existing Inspector toggle did nothing before this change.
- Workspace is left as-is: it already manages its own fixed strip and internal scrolling (`.pc-task-workspace`'s explicit viewport-based height), so `.pc-main--workbench` keeps `overflow:hidden` to avoid gaining a second scroller.
- Narrow layouts (the top bar moved inside `.pc-work`, per the existing narrow rule) keep working unchanged: once `.pc-work` stops scrolling, the top bar and the new page head are flex:none siblings ahead of the scrolling `main`, so they stay visible without needing `position:sticky` at all. The existing narrow CSS that hides the Tasks aside below 768px is left untouched, so narrow/tablet visual behavior for that specific panel does not change in this pass.

## Consequences

A page's header and filter strip now stay visible while only the list or canvas beneath them scrolls, on every screen that adopts the `header` slot (Tasks and New task in this pass; other screens keep rendering their header inside `main` until migrated). Tasks and New task's side content becomes a real, togglable, persisted shell panel instead of page-local markup, and gets the same keyboard shortcut and close-cascade behavior as Workspace's and Dispatch's panels. Every screen that later wants a persistent side column reuses this same mechanism instead of inventing another local column.

The `header` slot and the `main`-only scroll model are both new constraints screens must follow going forward (UI-27, shared layout spacing belongs in `app/src/ds`): a screen must not redefine the page-local two-column layout the removed CSS provided. Migrating the remaining screens that still build a `<header>` directly inside `.pc-page` (Dispatch, Needs you, Settings, …) to the `header` slot is explicitly out of scope for this pass and left for a follow-up.

## Alternatives considered

- **Keep per-screen sticky headers inside `main`.** Rejected: every screen that wants a static header has to reimplement its own `position:sticky` offset against the frame's measured heights, and a header "sticky" inside the same scroller it needs to stay clear of is fragile under resize and dynamic content (as the two prior, reverted attempts at this showed).
- **Give Tasks and New task their own bespoke side-panel implementation instead of the shared `FrameSlot`/`SidePanel` mechanism.** Rejected: it would duplicate the toggle, shortcut, persisted state and close-cascade wiring `SidePanel` and `Layout` already provide for Workspace and Dispatch, and keep this codebase with two different "side panel" idioms.
- **Migrate every remaining screen's header into the new slot in the same change.** Rejected for scope: this pass is Tasks and New task only; Trace, Executors, Setup and the Settings width are explicitly deferred.

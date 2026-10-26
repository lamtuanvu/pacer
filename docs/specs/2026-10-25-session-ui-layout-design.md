# Session UI layout

Date: 2026-10-25. Status: approved. Applies to: `app/src/screens/session/`, `app/src/term/`.
Builds on the [tasks workspace](2026-10-25-tasks-workspace-design.md).

## Problem

The interactive conversation screen called its main view "Terminal" and sized the terminal with
`calc(100vh - 260px)`. The guess was wrong whenever the header wrapped, a notice appeared or the app
ran narrow, so the terminal ran past the bottom of the window and pushed its control strip off screen.

A terminal is the first way pacer shows a live session, not the only one. Pacer's control UI keeps
a header and a footer, and the session UI takes all the space between them.

## Design

A conversation opens in the task workspace. The workspace already provides the header: breadcrumb,
title, repository, executor, status and the task tabs (Session, Changes, Brief, Result). Inside the
Session tab the conversation fills the panel as a bounded flex column.

| Part | Contents | Size |
|------|----------|------|
| Action row | Files, Open in terminal, Resume conversation, End session (each only when it can work) | Natural height, pinned |
| Body | A failed session's error alert, queue and notice lines, the Files strip when open, then the session UI edge to edge | `flex:1; min-height:0`; scrolls only when an alert or files cannot fit |
| Footer | Session control strip: mode, keystroke hint, Take control / Release, Reconnect, cols×rows, Screen reader, connection messages | Natural height, pinned |

- **Session view boundary.** `SessionView` picks the renderer for the session host. The built-in
  terminal (`LazyTerminal`) is the only renderer today; other renderers plug in there.
- **Footer slot.** `TerminalView` accepts an optional `footer` element. When given, it renders its
  control strip into that element through a portal instead of under the frame. Without it (the
  supervised session view), the terminal keeps its inline strip.
- **Fit.** The workspace panel drops its padding and scrolling for a conversation, and the session UI
  fills what the action row and footer leave. While driving, the terminal fits its PTY to the pane;
  while watching, it keeps the controller's geometry and scrolls inside the pane. A pane that
  measures 0×0 is never fitted, so the agent's PTY is not shrunk.
- **Control.** The terminal takes control automatically on connect when nobody holds it (from the
  workspace change). While watching, Tab moves focus out of the terminal so the footer controls stay
  reachable.
- **Files.** The original request is on the workspace's Brief tab. Files stay with the session:
  paste and drop happen on the session UI, the Copy reference step belongs next to it, and Brief
  renders the supervised task view, which has no attachment UI. The Files action toggles the
  attachment strip, and pasting or dropping a file opens it.
- **Tabs.** The footer and session UI live in the Session tab. Other workspace tabs unmount the
  conversation, which releases control; automatic control takes it back on return to Session.
- **Driving cue.** While the user drives, the session UI shows a warning-colored left edge, and the
  footer's mode dot uses the same tone. The mode is also stated in text, so it is never color alone.
- **Narrow (≤767px).** The workspace is bounded to the viewport for a conversation so the footer stays
  pinned. The footer hides the hint and size; the mode takes its own row, and while driving the
  Ctrl-] hint stays visible.
- **Copy.** While watching, the hint keeps the reassurance "Closing this window leaves your
  conversation running."

## Naming

User-facing "Terminal" becomes "Session". "Open in terminal" keeps its name: it opens a real terminal
application.

## Verification

- DOM tests: the action row, body and footer order; no nested tab bar; empty and failed states.
- Browser test: the strip is portaled into the footer, the supervised view keeps its inline strip,
  Tab leaves a watched terminal, and a hidden pane never resizes the PTY.
- `bun run ui:check`, `bun run app:build` (bundle budgets, UI-3).
- Live validation (CT-11) and UI-18 screenshots at 1440 px light and dark and at 375 px.

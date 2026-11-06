# Workspace question as support UI

## Intent

When an agent asks a question in Workspace, the terminal/session view stays the main middle plane. The question is support UI: a floating idle mini-card, then the right-panel answer composer. The center column never hosts the answer form.

## Goals

- Keep the workspace center full-height for the agent/terminal UI while a question is pending.
- Surface a pending question with a floating mini-card (agent label + truncated question) that does not reflow the terminal.
- Answer only through the right-panel Overview composer (Workspace’s analogue of the session Details `result` / next-step slot).
- Chip click and `tab=answer` deep links open Overview (and the details panel when collapsed) and focus the answer field.
- Preserve messaging (`MessageAnswer`) and legacy (`task.question` / `WorkspaceQuestion`) answer paths, drafts, and managed-root behavior.

## Non-goals

- Redesigning Needs You `SideDialog` / `AnswerPanel`.
- Moving Waiting-to-start or settled Result blocks out of the center.
- A modal floating answer overlay, or a new right-panel tab.

## Behavior

1. **Pending question** on the active session panel’s task (or the selected task when it owns the question): show the floating mini-card over the center work area.
2. **Idle mini-card:** elevated compact card; does not change terminal layout. Hide while Overview already shows the answer section and the answer field is focused; show again if the user leaves Overview with the question still open.
3. **Open answer:** switch right tab to Overview, open the shell details panel if it is closed, mount the shared composer, focus the answer control (`message-answer:*` / `workspace-answer:*`).
4. **Center column:** while running / needs_input, render session output only (plus notice/chip). No stacked “The agent needs your answer” block above the terminal.

## Constraints

- Preact + `app/src/ds/`; token-only authored visuals (UI-1, UI-19–UI-21).
- One primary action in the answer region (UI-14); only offer actions that can succeed (UI-13).
- Accessible name and keyboard reachability for the chip and composer (UI-2).
- Shell-owned right region via `FrameSlot` (UI-28); do not invent a page-local side column.

## Builder notes

- Prefer composing `MessageAnswer` and the existing legacy Workspace answer path so Session and Workspace do not diverge.
- The active session panel’s task may differ from the selected workspace card (child session vs root); the Overview answer host must still reach the task that owns the pending question without requiring a selected-task change when deep-link focus is active.
- Evidence: browser tests, `ui:check`, UI-18 screenshots, live validation (CT-11), independent UI/QA review before completion.

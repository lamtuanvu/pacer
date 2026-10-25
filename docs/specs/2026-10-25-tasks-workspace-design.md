# Tasks workspace design

## Intent

Tasks opens to the familiar full list. Selecting a task opens its detail on the right while the list becomes a compact navigator on the left. The agent session has the largest usable area.

## Behavior

- The existing `#/tasks` route shows the full task list. `#/tasks/:id` shows the selected task in a split workspace. The primary Tasks rail link, a Tasks link in the header, and browser history all navigate back to the list. A row is a single navigation target; it does not repeat Open, View result, Watch, or Take over actions.
- The navigator preserves the current repository filter, running/completed groups, status labels, and the selected task. Switching tasks uses the same route system and keeps list loading state and scroll position.
- For a running task, Session opens first and occupies the main pane. Summary/result, changes, and brief remain reachable. The current terminal and conversation implementations continue to provide live interaction. Control is available immediately when the session permits it; Take over appears only when another controller or a headless session requires that transition.
- The task title, repository, executor, duration, and status occupy a compact header. Extra activity and technical details remain reachable without taking a permanent column from the session.
- The existing top bar, primary rail, footer, and responsive navigation stay in place. On narrow screens, the task detail uses the full width and the primary Tasks link returns to the list.

## Constraints and approach

Use the current Preact route model and shared design system. Compose existing task and session capabilities without changing the service protocol. The full list and navigator use the same task API and current snapshot; the full list retains its paginated history. UI and copy follow `.project/rules/ui.md` (especially UI-1, UI-2, UI-9–UI-18, UI-19–UI-27); route and browser behavior follow P1 and P3. Retain repo query parameters and native link behavior.

The rejected alternative was a standalone task page with an ad hoc back button and a large metadata/card column. It obscured the existing navigation path and reduced the agent workspace. A modal drawer would leave still less room and make task switching cumbersome.

## Validation

Verify list and task routes, selection, filtering, browser back, control states, and 1440/375 px light/dark layouts. Run affected tests, typecheck, `ui:check`, app build, and CT-11 live validation. Obtain independent UI/accessibility, QA, and repository-rule review before calling the implementation complete.

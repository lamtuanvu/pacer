# Task: finish the UI-18 screenshot set — WorkView only

Executor: codex. No time limit; produce every capture listed before reporting. No review verdict.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base origin/main 445241520. The previous capture task wrote .work/reviews/ui-review-int/shots/ and INDEX.md; reuse its method, seeds and proxies exactly (head: `bun run live up --seed ui --front-door rust --native-test-ops`; base: scratch detached worktree of 445241520 with the TypeScript front door, removed afterwards).

## What is left
`app/src/screens/work/WorkView.tsx` is the only changed component with a visible delta: when a managed action is unavailable, a `<p class="muted">` with the reason now renders and the review/answer/stop buttons get `aria-describedby` pointing at it. WorkView is NOT a route: it renders inside the task page (`#/tasks/<id>`, Screen.tsx `sessions` → LazyTrace → TaskResult.tsx:241 `work={task.data.work && <LazyWork id={id}/>}`) for a task whose detail has `work` (a managed dispatch root/child). Open `#/tasks/<managed task id>` and scroll to the work tree section.

Capture, base AND head, 1440 light, 1440 dark, 375 light, cropped or full-page so the work tree section is visible:
1. A managed task with work where retry/answer actions are available.
2. The same with the action unavailable: use the missing-op proxy (dispatch.retry removed, and separately dispatch.answer removed) from /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions/.work/live/managed-missing-op; head shows the reason text; base shows whatever it showed.
Record geometry JSON per capture (no horizontal overflow; button and reason-text boxes) and, on head, the DOM: the reason `<p id>` and each button's aria-describedby value.

Add rows to .work/reviews/ui-review-int/shots/INDEX.md and append a section "Not visually changed" listing: ResultPage.tsx and task-shared.tsx (unmount guards only), components.css/styles.css (`.sr-only` moved, identical rule), SideDialog.tsx (focus-return fallback; behavior, covered by the keyboard review), tray/main.tsx and tray/model.ts (state wiring; tray captures already present) — cite the hunks with `git diff 445241520 HEAD -- <file>`. Right-panel scroll is main's change, not this PR's; remove it from the missing list.

Rules: Orca's built-in browser (isolated profile) or the source branch's scripted headless capture; one live session at a time, ids `ui-shots2-`; clean tree and HEAD 4d11aeb82; no cargo; never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports; stop everything and remove the scratch worktree.

Report with orca orchestration worker_done listing the captures produced. Always end with worker_done.

# Task: web UI evidence for the Answer panel, dialog fallback, result states and the .sr-only move (UI gap closure)

Executor: codex (independent UI reviewer). Every row below must have an observation before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9 (the app is identical to 4d11aeb82). Base is main a8331c6b4. Check that `git status --short` is clean. The gaps are listed in `.work/reviews/m2-integration-ui-final-verdict.md`, rows for SideDialog.tsx, AnswerPanel.tsx, ResultPage.tsx, task-shared.tsx, Dispatch.tsx, components.css and styles.css. Read `git diff a8331c6b4 HEAD -- app/src`. Reuse the probes from `.work/reviews/m2-integration-ui-kb-live-a.md` and `-ui-kb-dispatch2.md` (`.work/kb-dispatch2-probe.ts`, the seed scripts).

Before any screenshot, dismiss or close the discovery prompt the reports mention, and record how you did it, so that no changed region is obscured. Take screenshots at 1440 light, 1440 dark and 375 light. For every row also capture the same state on base: a detached scratch worktree of a8331c6b4 with the TypeScript front door and the same fixtures, removed afterwards.

| Row | Required observation |
| --- | --- |
| W1 | Answer panel (SideDialog) for a managed question. Record: focus order forward and reverse (Shift+Tab); what Enter does inside the textarea (newline or submit); the Send button's disabled explanation (`aria-describedby` text) |
| W2 | Answer-panel submit that removes the opener card, so `fallbackFocusId` is used. Record the actual focus target after close, and its focus-visible ring and contrast in light and dark |
| W3 | Busy and error states of the Answer panel. Make a real error with the missing-op proxy or a refused answer. Record screenshots and the announced status text |
| W4 | Trace result states that use `useResultAction` (Accept, Reject, Retry). Before and after screenshots of the task page, unobscured, head vs base |
| W5 | Dispatch board: a managed review card's "Review result" link. Tab to it, focus visible, Enter, the destination; also the full board Tab traversal order, head vs base |
| W6 | `.sr-only`: computed style of every `.sr-only` element on the Answer panel, the board and the tray, head vs base. Values must be identical, and the elements must be visually hidden but present in the accessibility tree |

For each row, decide whether any difference from base is introduced or pre-existing. A known pre-existing pattern is focus falling to BODY after a successful managed action (see `m2-integration-focus-baseline.md`): record it, and classify it only against your own base observation.

Rules:
- Start with `bun run live up --front-door rust --native-test-ops --seed ui`, with the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME. Do NOT wrap `live up` in sbx-deny.
- Use session ids prefixed `ui-gap-web-`, and run one session at a time. Stop everything you start.
- Record one harness note per row with `bun scripts/live/cli.ts note --id <id> --behavior "<row>" --surface web --verdict PASS|FAIL|UNVERIFIED "<observation>"`, then render the report.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/m2-integration-ui-gap-web.md`:
- a verdict for each of rows W1–W6, with evidence paths;
- the contrast numbers;
- the harness Summary lines (head and base);
- the classification of each finding;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

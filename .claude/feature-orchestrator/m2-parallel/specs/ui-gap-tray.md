# Task: tray 340 evidence for the changed tray actions (UI gap closure)

Executor: codex (independent UI reviewer). Every row below must have an observation before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9 (the app is identical to 4d11aeb82). Base is main a8331c6b4. Check that `git status --short` is clean. The gaps are listed in `.work/reviews/m2-integration-ui-final-verdict.md`, rows for `app/src/tray/Tray.tsx`, `tray/main.tsx` and `tray/model.ts`. Read `git diff a8331c6b4 HEAD -- app/src/tray`. Reuse the tray probes and fixtures from `.work/reviews/m2-integration-ui-kb-live-a.md`, `-ui-images-a.md` and `-ui-review-final.md` (the missing-op proxies `missing-retry-final.json` and `missing-answer-final.json`, and `.work/ui-a11y-missing-proxy.cjs`).

All rows use the tray at 340 px wide, in light and dark.

| Row | Required observation |
| --- | --- |
| T1 | Managed question row: Tab to Answer, then Enter. Record the destination the tray opens (URL or IPC payload), what the destination shows, and where focus settles 1 s later |
| T2 | Managed failed row with the op present: Tab to Retry, then Enter. One `dispatch.retry`, HTTP 200. Record the settled focus target 1 s later, and the row's final content |
| T3 | Missing `dispatch.retry` (proxy): the "Open task" fallback. Tab, Enter, the destination, settled focus |
| T4 | Missing `dispatch.answer` (proxy): the fallback. Tab, Enter, the destination, settled focus |
| T5 | Row title activation (Enter) for a managed row: the destination |
| T6 | Full forward and reverse (Shift+Tab) traversal of the tray, with the order recorded |
| T7 | Focus ring contrast, against the adjacent background, for Answer, Retry and Open task in both themes. Include screenshots of each focused control (light and dark) |

If the tray opens a destination through desktop IPC, which the browser harness can't follow, record the exact IPC payload the tray emits and mark only the native-desktop half UNVERIFIED. For a browser-handled destination, verify the destination content.

Rules:
- Start with `bun run live up --front-door rust --native-test-ops --seed ui`, with the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME. Do NOT wrap `live up` in sbx-deny.
- Use session ids prefixed `ui-gap-tray-` and run one session at a time. Stop everything you start, including proxies and Chrome.
- Record one harness note per row with `bun scripts/live/cli.ts note --id <id> --behavior "<row>" --surface web --verdict PASS|FAIL|UNVERIFIED "<observation>"` and render the report, so the Summary line reflects the rows.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/m2-integration-ui-gap-tray.md`:
- a verdict for each of rows T1–T7, with evidence paths;
- contrast numbers;
- the harness Summary line;
- whether each finding is introduced or pre-existing. For any focus or behavior problem, compare against base: a detached scratch worktree of a8331c6b4, with the TypeScript front door and the same fixture, removed afterwards;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

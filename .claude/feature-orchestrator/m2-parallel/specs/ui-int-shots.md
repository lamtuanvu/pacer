# Task: UI-18 before/after screenshot set for the m2/integration PR

Executor: codex. No time limit. This task is ONLY screenshots and geometry; do every row of the table below before reporting. Do not write a review verdict.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 4d11aeb82; base origin/main 445241520. A previous reviewer already did part of this — read .work/reviews/m2-integration-ui-review.md and reuse its method: head session via `bun run live up --seed ui --front-door rust --native-test-ops`; base via a scratch detached worktree of 445241520 served with the TypeScript front door (no cargo build), removed afterwards; seeded disposable managed and ordinary failed/question fixtures (see .work/reviews/ui-review-int/seed.jsonl). Reuse the source-branch fixtures/proxies in /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions/.work/ (capture-managed-*.ts, live sessions managed-ui-matrix-e0324c45-final, managed-missing-op) for managed rows and missing-op proxies.

## Capture table (base AND head for every cell; seed equivalent fixture state in both)
| Screen / state | 1440 light | 1440 dark | 375 light |
|---|---|---|---|
| Work view with a managed failed task row (actions visible) | x | x | x |
| Work view with right panel open and content longer than viewport, scrolled (record scrollTop before/after, panel width, overflow) | x | x | x |
| Dispatch screen with managed work | x | x | x |
| Needs-you answer panel (side dialog) open on a managed question | x | x | x |
| Review result page for a managed task | x | x | x |
| Task detail (task-shared actions) for a managed task | x | x | x |
| Head only: managed failed row with `dispatch.retry` removed by the missing-op proxy | x | x | x |
| Head only: managed question with `dispatch.answer` removed by the missing-op proxy | x | x | x |

Tray at 340 px, light and dark, base and head: managed failed row; managed question row; head only: missing-answer filter.

For each capture also record a geometry JSON: document width vs viewport (no horizontal overflow), bounding boxes of the action buttons/footer, and any clipped or overlapping element. Name files `<base|head>-<screen>-<width>-<theme>.png/.json` under .work/reviews/ui-review-int/shots/ (untracked). Write .work/reviews/ui-review-int/shots/INDEX.md: one row per file with what it shows and any visual difference base→head (describe it; do not judge rules).

## Rules
- Use Orca's built-in browser with an isolated profile per session for interactive navigation; scripted headless Chrome captures (as the source-branch capture scripts do) are acceptable for the matrix. Login URL: open once; if expired, go to /app/#/settings.
- One live session at a time (memory pressure). Session ids prefixed `ui-shots-`. Confirm clean tree and HEAD 4d11aeb82 before the head session. Do not cargo clean/rebuild; target/debug/pacer is already built with test-ops.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. A QA reviewer may be running its own live session in this worktree; don't stop it.
- Stop every session, proxy, tab and profile; remove the scratch base worktree.

Report with orca orchestration worker_done: number of captures per screen, any capture you could not produce and why. Always end with worker_done.


Carry out the task described above.

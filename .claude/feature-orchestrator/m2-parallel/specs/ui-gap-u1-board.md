# Task: close two UI evidence gaps for the M2 integration PR (U-1 stale tray Retry, board CT-11 rows)

Executor: cursor-agent (independent live validator). Don't edit tracked files. Write scratch files only under `.work/`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head fff6b18b7 (clean tree; check `git status --short` is empty before and after). Base is main a8331c6b4. Follow `docs/testing/live-validation.md`. Read first:
- `.work/reviews/m2-integration-ui-final-verdict2.md`, findings U-1 and gap 1;
- `.work/reviews/m2-integration-ui-gap-tray.md` (how T2 was run: Rust native-test-ops UI-seeded sandbox, missing-op proxies, `head-T2watch-light/probe-T2.json`);
- `.work/reviews/m2-integration-ui-kb-dispatch2.md` (board A and B: managed `limit` card Retry and the Open task fallback).

Safety (AGENTS.md): never touch /Applications/pacer.app, ~/.local/bin/pacer*, ~/.pacer, com.pacer.serve, port 4317 or the model ports (11434, 1234, 41343). Use the harness (`bun run live up --front-door rust --native-test-ops --seed ui ...`). Do NOT wrap `live up` in sandbox-exec or sbx-deny: macOS rejects nested sandboxes. Notes: `bun scripts/live/cli.ts note --id <id> --behavior <b> --surface <s> --verdict PASS|FAIL|UNVERIFIED "<text>"` (text positional, no `--`), then `report`, then `down --id <id> --keep`. Web checks use headless Chrome or Playwright from the repo. Run one session at a time; memory and disk are tight. Stop everything you start.

Rows (every row must have an observation, evidence path and verdict):

| Row | What to establish |
| --- | --- |
| U1a | On head (Rust front door), after one successful tray Retry at 340 px: time until the row stops offering Retry, and what changes it (an SSE event, a poll, the queued attempt starting). Record the request log or event timestamps. |
| U1b | On head, press Retry a second time inside that window. Record the HTTP status and body, the number of `dispatch.retry` requests Core received, and whether a second attempt or task was created (count tasks and attempts before and after). Refused or idempotent no-op is acceptable; a duplicate attempt is an introduced defect. |
| U1c | Same as U1a with the head TypeScript front door (omit `--front-door`; the default is TypeScript) on the same seed, to separate Rust front-door lag from Core timing. If the TS front door refuses `dispatch.retry`, say so and instead measure the same row's refresh after an equivalent state change (for example `task.retry` or an out-of-band status write) on both front doors. |
| U1d | Classify the window: introduced by the Rust front door, introduced by this branch's Core or app code, or pre-existing Core timing (point at the code that sets the cadence). |
| B1 | Board (1440 light) managed `limit` card Retry with `dispatch.retry` present: Enter activates, one HTTP 200, the card state after. Harness note with behavior `board.managed.retry`, surface `web`. |
| B2 | Same card with `dispatch.retry` missing (proxy as in board B): the Open task fallback link, its destination and focus. Harness note with behavior `board.managed.open_task`, surface `web`. |

Write `.work/reviews/m2-integration-ui-gap-u1-board.md` with:
- the head and the session ids, and each session's report path and Summary line;
- the row table: row, observation, evidence path, verdict;
- the U-1 classification with reasons and code references;
- the cleanup (processes stopped, `live down --keep` run, tree clean).

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.

# Task: close QA rows R1, R2 and R6 (identical records, a usage fixture, and Core's grant responses)

Executor: codex. Every row below must have an observation before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9. Check that `git status --short` is clean. Read `.work/reviews/live-replay-sync-live.md` (the previous attempt) and its evidence under `.work/live/sync-live-native/` and `.work/live/sync-live-fwd/`. Read `crates/read-model/src/tasks.rs`, `crates/store/src/task_selection.rs` and `crates/store/src/task/cost_projection*` to learn the exact filter params and when the cost projection is created (`usageAtStart`, quota snapshots).

The previous attempt failed in three ways:
- it compared two separately seeded sessions, whose tied timestamps reordered results;
- it passed a path as the repo filter;
- the seed had no usage baseline, so cost was always null.

Fix these as follows:
- **Identical records.** Seed one session, stop it, and copy its `home/state/tasks.db*` and `home/tasks/` into the second session's home before starting the second service (or start the second session with a template, if the harness supports one). Both sessions then read byte-identical records. Record the sha256 of `tasks.db` in both sessions.
- **Native vs Core.** One session is `--front-door rust --native-test-ops`. The other adds `--native-forward-ops task.list,task.get`.

| Row | Required observation |
| --- | --- |
| R1 | `task.list` in both sessions: unfiltered; each state filter; executor filter; a repo filter in the parameter format the schema expects (read the op schema; use a repo the seeded tasks belong to, so the result is non-empty); limit and cursor paging across at least two pages. After normalizing only the volatile response fields (for example `updatedAt` if it is computed at read time; list each rule), native and Core must be deep-equal for every request. Save `r1-native.json`, `r1-core.json` and a diff |
| R2 | Add a usage fixture to two seeded tasks: `usageAtStart` plus the quota snapshot records the code reads (follow `crates/read-model/tests/cost_projection.rs` and `crates/store/tests/cost_projection.rs` for the minimal shape). Then `task.get` both tasks: cost fields non-null and equal between native and Core. Check the native session's tasks.db (read-only sqlite) before and after the first cost read: the private projection table and rows appear |
| R6 | `account.list` with `PACER_WORK_GRANT`. The harness guard strips the variable (`scripts/live/guard.ts`), so call the service the way a granted executor does, without the guard: use the session's `env.sh` and the session's own `bin/pacer`, against the session's private service port, never port 4317. Do it for a valid grant (issue one for a running managed task as in the previous attempt), an invalid grant and no grant. Capture the full response body and status for each, and the serve.log and Core log lines. Make the same three calls in the Core session, where everything is forwarded. Native-session grant calls must have no `native account.list` line and must equal the Core session's bodies |

Rules:
- Use the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME. Do NOT wrap `live up` in sbx-deny.
- Use session ids prefixed `sync-live2-`. Run one session at a time and stop each with `bun run live down --keep`.
- Another worker may run `v2eq-*` sessions; never stop them.
- Record a harness note per row and render the reports.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/live-replay-sync-live2.md`:
- the head and the tasks.db hashes;
- each session's report path and Summary line;
- rows R1, R2 and R6, each with a verdict, evidence paths and diffs;
- the normalization rules;
- the classification of any difference: introduced, pre-existing or fixture;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.

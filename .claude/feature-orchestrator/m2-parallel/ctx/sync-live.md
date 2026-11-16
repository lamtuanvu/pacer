# Task: live evidence for the main-sync integration points and the account.list work-grant branch

Executor: codex. Every row below must have an observation before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9. Check that `git status --short` is clean. Read `.work/reviews/m2-integration-qa-final.md` (rows "account.list/signin" and "background worker, locking, supervision/admission, cached reads") and the "Sync with main" section of `.work/reviews/m2-integration-handoff.md`. The first sync brought main's #859 (`git show e349874b1 --stat`; CHANGELOG: native task cost reads through a private projection, indexed task-history filters, title regexes, SSE interval) into this branch's read paths.

Method: compare the native path with Core at the same head, using the harness's own option `--native-forward-ops <ops>`, which forwards the named ops to TypeScript Core. Run two sessions with identical seed and fixtures:
- `sync-live-native`: `bun run live up --front-door rust --native-test-ops --seed ui`.
- `sync-live-fwd`: the same plus `--native-forward-ops task.list,task.get,events.list` (adjust to the real op names; check `bun run live --help` and the catalog).

Run identical requests in both sessions, then normalize timestamps, ids (match tasks by title) and dynamic host fields.

| Row | Required observation |
| --- | --- |
| R1 task history filters | `task.list` with no filter, a `repo` filter, each visible state filter present in the seed, an `executor` filter, and a page/limit: native results equal forwarded results; native marker in serve.log for the native session only |
| R2 cost projection | `task.get` for each seeded task that has usage: cost fields equal between native and forwarded; the first native cost read creates the private projection (inspect `state/tasks.db` read-only with sqlite3 `-readonly`) |
| R3 titles | Seeded titles and fullTitles equal in R1/R2 |
| R4 SSE incremental update | With an SSE client on the public proxy, perform one write in the native session (stop a seeded running/queued task via HTTP `task.stop`): an update event for that task arrives; record latency and seq advance |
| R5 background worker | Find what `state/background-worker.json` and `src/serve/worker-location.ts` represent. Under the Rust front door, record whether the worker is running (pid alive, matching command) and whether its state advances over 30 s. If the source shows it is not expected under the Rust front door, quote the code |
| R6 account.list work-grant forward | With `PACER_WORK_GRANT` set to a real grant (create one as `.work/live/live-sync-b*` or `.work/reviews/live-live-sync-b.md` did) and once to an invalid value, call `pacer api call account.list`: no `native account.list` line for these calls in serve.log; the result or refusal comes from Core (for the invalid grant, quote Core's message); a call without the variable still shows `native account.list` |

Rules:
- Start sessions with the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME. Do NOT wrap `live up` in sbx-deny.
- Use session ids prefixed `sync-live-`. Run the sessions one after the other, stopping each with `bun run live down --keep`.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/live-replay-sync-live.md`:
- the head;
- each session's report path and Summary line (add harness notes per row with `bun scripts/live/cli.ts note --id <id> --behavior .. --surface .. --verdict ..  "<text>"`);
- rows R1–R6, each with a verdict and evidence paths (saved JSON);
- any differences, with their classification;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.

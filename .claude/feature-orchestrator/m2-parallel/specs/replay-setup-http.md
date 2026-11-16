# Task: recapture two setup-candidate HTTP artifacts at the integration head

Executor: codex. Small task; finish both rows before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82 (check `git status --short` is clean and HEAD matches before each session). Read `.work/reviews/live-replay-replay-setup.md`: two HTTP results were observed but their saved raw responses were overwritten by later calls. Recapture each to its own file and never reuse a file name.

| Row | Session (new id) | Setup, copied from the prior session's session.json | Required observation |
| --- | --- | --- | --- |
| A delayed errors over HTTP | `replay-setuphttp-delay` | same options as `.work/live/replay-setup-delay2/session.json` (delayed-failure fixture) | `executor.setup.candidates` over authenticated public HTTP: status 200 and the order of failure notes (sign-ins, LM Studio, Ollama). Save to `.work/fixtures/replay-setuphttp-delay.json` |
| B reverse LM Studio over HTTP | `replay-setuphttp-reverse` | same options as `.work/live/replay-setup-reverse/session.json` | `executor.setup.candidates` over public HTTP: status 200, LM Studio fixture port and its two models. Save to `.work/fixtures/replay-setuphttp-reverse.json` |

For each row: `bun run live up --front-door rust --native-test-ops ...` with disposable HOME and PACER_HOME, the real CARGO_HOME/RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4 and TZ=Asia/Ho_Chi_Minh. Do NOT wrap `live up` in sbx-deny, because the harness sandboxes the model ports itself and macOS rejects a nested sandbox. Use curl with `--max-time 60` (a 15 s client cap can expire before the server answers; that timeout collision is known, pre-existing and not in scope). Record status, elapsed time and the `native executor.setup.candidates` line in serve.log. Add a harness note per row, then `bun run live down --keep`. Run the sessions one after the other.

Rules: never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports 11434, 1234 and 41343. Don't edit tracked files and don't stop other sessions.

Write `.work/reviews/live-replay-replay-setup-http.md` with the head, each session's report path and Summary line, rows A and B with result and evidence paths, and the cleanup. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.

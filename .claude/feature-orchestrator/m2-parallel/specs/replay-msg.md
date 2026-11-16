# Task: live replay of messaging at the synced integration head f5168b0f9

Executor: codex. No time limit; every row below must have an observation before you report.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head f5168b0f9 = merge of #869 (native msg.send live-answer delivery) into the integration. Before each session `git status --short` must be clean and HEAD f5168b0f9. Read docs/testing/live-validation.md (including the new `--waiting-session-fixture` section), the `msg.send` row of docs/testing/m2-ledger.md, `.work/reviews/live-replay-replay-send.md` and the #869 live evidence `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-native-msg-live-answer/.work/reviews/fix-native-msg-live-answer-handoff.md` (reuse its exact probes).

| Row | Session | Required observation |
| --- | --- | --- |
| A answer delivery CLI | `replay-msg-wait` (`bun run live up --front-door rust --native-test-ops --waiting-session-fixture`) | `pacer msg send <task> main --answer <question> --json` → `delivery: "live"`, text arrives in the fixture's `input`; serve.log shows the answer forwarded (not native) |
| B answer delivery HTTP | same session | the same via authenticated public HTTP `msg.send` with string `reply_to`; input arrives |
| C duplicate redelivery | same session | retry of a stored answer with the same request id (CLI and HTTP) matches Core: no second native delivery, forwarded, result as in the #869 handoff |
| D stale / retry fixtures | same session | the fixture's `retry` and `stale` entries behave as in the #869 handoff |
| E non-answer msg.send native | same session or `replay-msg-plain` (`--seed ui`) | plain message to a task and to `main` stays `native msg.send` in serve.log; refusals (empty body, nudge, policy) match `.work/reviews/live-replay-replay-send.md` |
| F stdio | same session | one answer and one plain message over the stdio front door fixture used by the #869 handoff, if it used one; otherwise mark UNVERIFIED with reason |

Rules: start sessions with `bun run live up --front-door rust --native-test-ops ...`, using the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4 and TZ=Asia/Ho_Chi_Minh. Do NOT wrap `live up` in sbx-deny, because macOS rejects nested sandboxes. Run one session at a time and stop each one with `bun run live down --keep`. Don't edit or commit tracked files. Use session ids prefixed `replay-msg-`, and never stop other sessions. Maintainer exceptions stay UNVERIFIED and are not exercised: the desktop app, real executors, PACER_FORWARD_OPS, D3/D8-guarded effects and Updates Install. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/live-replay-replay-msg.md` with the head, each session's report path and Summary line, a table with rows A–F (result and evidence paths), failures with their evidence, anything UNVERIFIED with the reason, and the cleanup. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.

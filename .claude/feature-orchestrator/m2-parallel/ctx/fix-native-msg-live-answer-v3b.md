# Task: live-harness waiting-session fixture and CT-11 evidence for native msg.send answers (v3b)

Executor: codex. No time limit; finish the fixture, its test, the live session and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-native-msg-live-answer (branch fix/native-msg-live-answer), head 41ea3fab0 (two signed commits on origin/main 445241520). target/debug/pacer is built with test-ops at this head. Read .work/reviews/fix-native-msg-live-answer-handoff.md (all sections) and review finding 2 in .work/reviews/fix-native-msg-live-answer-review.md.

## 1. Fixture
Add an opt-in live-harness fixture that creates a synthetic interactive run waiting on a question — modeled on what test/native-msg-live-answer-parity.test.ts sets up (synthetic run, ViewerHub socket, task state, question message) — with no real executor. Find the harness under scripts/ (search for `live up`, `--seed`, `--local-model-fixture`) and docs/testing/live-validation.md. Expose it as a new option (e.g. `--waiting-session-fixture` or a seed name) that leaves existing sessions unchanged; it must create everything under the session's disposable PACER_HOME (socket included) and be torn down by `live down`. Record what the fixture typed into the session so the evidence can show "typed once". Add a short note to docs/testing/live-validation.md and a focused test for the fixture if the harness has tests (test/live*.test.ts). Commit with `git commit -s -m "test(live): add a waiting interactive session fixture"`.

## 2. CT-11 session at the final clean head
`bun run live up --front-door rust --native-test-ops` plus your fixture option; session ids `live-msg-answer3-`. Each case in a fresh waiting state:
- `pacer msg send --answer` via the guarded CLI → answer typed once into the session, question answered, nothing pending, reply reports live delivery.
- The same via HTTP (`msg.send` with kind answer + reply_to) → same outcome.
- A duplicate retry with the same request_id → no second typing (matches TypeScript).
- A stale answer (question superseded) → refused/queued exactly as TypeScript does.
- A non-answer msg.send → stays native (serve log native marker).
Write the session report per docs/testing/live-validation.md with a Summary line.

## Checks
Serial, sbx-deny, disposable HOME/PACER_HOME (keep real CARGO_HOME/RUSTUP_HOME), TZ=Asia/Ho_Chi_Minh: `bun run typecheck`, any harness tests you touched, `git diff --check origin/main..HEAD`. If you change Rust (you should not need to), rerun the v3a cargo checks.

Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. One live session at a time (another worker may run a UI session in a different worktree — leave it alone). Stop everything you start.

Append a "Live fixture and CT-11 (v3b)" section to the handoff: commit, fixture design, commands with counts, session id, report path, Summary line, per-case results, UNVERIFIED with reasons, cleanup. Report with orca orchestration worker_done. Always end with worker_done.

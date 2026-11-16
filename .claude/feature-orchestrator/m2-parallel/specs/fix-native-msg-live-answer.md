# Task: native msg.send must deliver live answers like TypeScript (pre-existing on main)

Executor: codex. No time limit; finish implementation, tests, static checks, live validation and the report before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-native-msg-live-answer (branch fix/native-msg-live-answer, from origin/main 445241520). Read AGENTS.md, .project/constitution.md, .project/context.md and the scoped rules for messaging, Rust, API parity (RUST-7), testing (CT-11) and security before starting.

## Defect (found by independent review, confirmed present on origin/main)
Main #863 (ee856a558) made `msg send --answer` deliver the answer directly to an interactive session that is waiting on its question: `src/messaging/send.ts:51-53` (`directAnswerTarget` / `deliverLiveAnswer`, returns `{ delivery: "live" }`). But `msg.send` is native on the Rust front door (`crates/messaging-ops/src/msg_writes.rs` `send`, ~line 291; `msg_stays_forwarded` in `crates/messaging-ops/src/msg_ops.rs:59`). The native path records the answer and calls the bridge (`src/api/msg-bridge.ts:11`) with only the recipient; the bridge calls `turns.deliver`, never `deliverLiveAnswer`. For a live waiting run the native path can report delivery while the session stays blocked, and may undo the task answer / mark the question read. The #863 tests (`test/messaging-live.test.ts:494`) call TypeScript `sendMessage` directly, so they never exercise the native route.

## Required
1. **Reproduce first:** add a front-door parity test (native vs forwarded, in the style of the existing `test/native-*-parity.test.ts` files using `PACER_TEST_NATIVE_FRONT_DOOR`) for an answer to a question from a live waiting interactive session. It must fail on the unmodified tree. Save the failing output to `.work/fixtures/`.
2. **Fix** with the smallest correct change. Preferred: selectively forward `msg.send` to TypeScript before any native side effect when the message is an answer with `replyTo` whose question's sender has a live waiting session (mirror `directAnswerTarget`'s conditions exactly; if Rust cannot determine that cheaply and exactly, forward every `kind: "answer"` with `replyTo`). Alternative: a correctly scoped bridge that runs `deliverLiveAnswer` with identical retry and refusal semantics. Justify the choice. Keep #866's stale-answer guard behavior identical for the native path.
3. **Coverage:** parity for successful live delivery, refusal/stale-answer, retry, ambiguous typing, and the ordinary non-live answer (must stay native if you forward selectively). Update `docs/testing/m2-ledger.md`'s msg.send row (and the selective list/totals if msg.send becomes newly selective) so `docs/testing/m2-ledger.md` stays consistent.
4. **Checks** (serial, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, TZ=Asia/Ho_Chi_Minh, disposable HOME/PACER_HOME): `cargo fmt --all --check`, `cargo clippy -p pacer-messaging-ops -p pacer-server --all-targets -- -D warnings`, `cargo test -p pacer-messaging-ops`, `cargo xtask loc --check`, `cargo xtask deps`, `bun run typecheck`, `cargo build -p pacer --features test-ops`, then the new parity test and `test/messaging-live.test.ts`, `test/native-msg*` / any existing msg parity tests.
5. **Live (CT-11)** per docs/testing/live-validation.md: `bun run live up --front-door rust --native-test-ops`, session ids prefixed `live-msg-answer-`. Exercise `msg send --answer` via CLI and HTTP to a fixture interactive session waiting on a question (use the harness's fixture executor/session support; if a waiting interactive session cannot be produced without a real executor, report that surface UNVERIFIED with the reason, never use a real executor). Also a non-live answer and a stale answer. Clean tree at the exact head.
6. Commit with Conventional Commits and `git commit -s` (e.g. `fix(messaging): deliver live answers on the native msg.send path`). Do not push.

## Rules
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. The machine is short on memory: do not run the full Bun suite or workspace cargo test; one live session at a time. Never cargo clean another worktree's target.
- Another live worker is running in .work/worktrees/m2-integration; don't touch that worktree.
- Stop every session, process and profile you start.

Write `.work/reviews/fix-native-msg-live-answer-handoff.md` (in your worktree): head, root cause, the failing-then-passing test evidence, design choice, commands with counts, live session ids/Summary lines, UNVERIFIED items with reasons, cleanup. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.

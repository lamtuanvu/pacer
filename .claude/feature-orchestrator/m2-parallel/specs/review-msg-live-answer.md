# Independent review: fix(messaging): deliver live answers on the native msg.send path

You are the independent reviewer required by REPO-10. You did not write this commit. Review and report; do not change tracked files. Executor: codex. No time limit; finish every check before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-native-msg-live-answer (branch fix/native-msg-live-answer), head e25482db2, base origin/main 445241520. Read .work/reviews/fix-native-msg-live-answer-handoff.md, AGENTS.md, .project/rules (messaging/API parity RUST-7, CT-*, security) and the ledger header definitions in docs/testing/m2-ledger.md.

## Defect being fixed
Main #863 (ee856a558) added TypeScript live delivery of an answer to an interactive session waiting on its question (`src/messaging/send.ts` `directAnswerTarget`/`deliverLiveAnswer`). Native Rust `msg.send` (`crates/messaging-ops/src/msg_writes.rs`) bypassed it. The fix forwards every `kind: "answer"` with a string `reply_to` to TypeScript before validation and native side effects, on stdio and HTTP.

## Checks
1. Correctness and completeness of the forwarding predicate in crates/server/src/native.rs, serve/mod.rs, stdio_proxy.rs and crates/messaging-ops: every request TypeScript would route through `directAnswerTarget` must forward (compare field names/casing — `replyTo` vs `reply_to`, kind values, params shape on both transports, CLI `msg send --answer` param construction). Is anything forwarded that must not be (auth, work-grant callers, scoped callers)? Does forwarding before validation keep error parity for invalid answer requests?
2. #866's stale-answer guard: since answers with reply_to now forward, confirm the native guard is now unreachable for them or still correct; any dead code or ledger inconsistency.
3. Ledger: msg.send row and, if msg.send's selectivity changed, the selective list and totals. Run `bun .work/fixtures/m2-ledger-check.ts` if present, else copy it from /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration/.work/fixtures/m2-ledger-check.ts into this worktree's .work/fixtures/ (untracked) and run it.
4. Tests: is test/native-msg-live-answer-parity.test.ts a real front-door reproduction (does it fail on the parent binary? see .work/fixtures/native-msg-live-answer-before.txt) and does it cover live delivery, refusal/retry, ambiguous typing, stale reply and non-answer native path? Review the test/native-msg-writes-parity.test.ts change.
5. Run under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, TZ=Asia/Ho_Chi_Minh, disposable HOME/PACER_HOME, PACER_TEST_NATIVE_FRONT_DOOR=<abs path of this worktree's target/debug/pacer> (already built with test-ops at this head; verify its mtime is after the commit or that `cargo build -p pacer --features test-ops` is a no-op — you may run that one build command with CARGO_BUILD_JOBS=4 and CARGO_INCREMENTAL=0): the new parity file, test/native-msg-writes-parity.test.ts, other test/native-msg* files, test/messaging-live.test.ts, `bun run typecheck`, `git diff --check origin/main..HEAD`; confirm Signed-off-by. No other cargo commands, no full suites.
6. CT-11: assess the live report (.work/live/live-msg-answer-native/evidence/report.md). The waiting-session surface is UNVERIFIED because the harness has no waiting interactive-session fixture and real executors are a maintainer exception. Say whether the front-door parity test (real native binary vs forwarded) adequately covers it and whether a live fixture could reasonably be built; do not build it.

Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Leave the tree clean.

Write .work/reviews/fix-native-msg-live-answer-review.md: head, assessment per check, commands with counts, findings with severity/rule/evidence/remedy, verdict PASS or FAIL. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

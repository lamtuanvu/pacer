# Task: independent review of the second main sync into m2/integration

Executor: codex (reviewer, no implementation). Read-only on tracked files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration. Review merge commit f5168b0f9 (`chore: merge origin/main into m2/integration`), parents 4d11aeb82 (integration) and a8331c6b4 (main, PR #869 "deliver live answers on the native msg.send path"). Read .agents/skills/project-review/SKILL.md, .project/constitution.md, .project/context.md and the scoped rules for API/protocol, messaging, testing and repository.

Conflicts were resolved by the coordinator in: crates/server/src/native.rs (re-export of `msg_answer_stays_forwarded` plus the integration's `core_bridge_params`), docs/testing/m2-ledger.md (`msg.send` row: integration text plus #869's answer-forwarding sentences), scripts/live/cli.ts and scripts/live/core.ts (integration's model-port/core/forward fixtures plus main's `--waiting-session-fixture`; `up()` now takes `fixtures` then `waitingFixture`), test/live-harness.test.ts (both test sets; waiting test passes `{}` for fixtures).

Check:
1. `git diff 4d11aeb82 f5168b0f9` and `git diff a8331c6b4 f5168b0f9` for the conflicted files: nothing from either side lost, no duplicated or contradictory text, the #869 behavior (answer with string reply_to and duplicate stored-answer redelivery forward to Core over HTTP and stdio) still reaches the integration's split server modules (verify the call sites in serve/ and stdio_proxy.rs exist and are wired in the integration's module layout, not only in dead code).
2. The harness: waiting fixture and model fixtures can coexist; cleanup loops stop every group; `validateNativeFixtures` still runs; CLI flag validation for both.
3. Ledger: the `msg.send` row is accurate for the merged code; run `bun .work/fixtures/m2-ledger-check.ts` (expect PASS 231/157/74/83/3).
4. Coordinator ran: `bun run typecheck` PASS; `bun test test/live-harness.test.ts` 188 pass; `cargo test -p pacer-messaging-ops -p pacer-store` pass; with `PACER_TEST_NATIVE_FRONT_DOOR=.work/bin/pacer-native-test` (test-ops build of this head) `bun test test/native-msg-live-answer-parity.test.ts test/native-msg-writes-parity.test.ts test/native-dispatch-lifecycle-parity.test.ts` 12 pass. You may rerun scoped tests (no cargo clean, CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4, real CARGO_HOME/RUSTUP_HOME); do not start live sessions.

Rules: never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. No edits to tracked files.

Write .work/reviews/m2-integration-review-sync2.md: verdict PASS/FAIL, findings with severity and file:line, what you ran. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

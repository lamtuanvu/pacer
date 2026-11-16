# Independent review: sync merge of origin/main into m2/integration

You are the independent reviewer required by REPO-10. You did not write these commits. Review them and report; do not change anything. Executor: codex. No time limit; finish every check before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 3c483c420. Earlier reviews covered everything up to 8156b69a0. Your scope is exactly:
- **7a786ce95** signed merge of origin/main 445241520 (nine commits #858–#866: model management, incremental task updates, native msg.send stale-answer guard, SSE polling, background worker, right-panel scroll, cost projection) into 8156b69a0.
- **3c483c420** `fix: forward new dispatch child fields for validation` (crates/dispatch-ops/src/lifecycle_ops.rs, ledger row, test/native-dispatch-lifecycle-parity.test.ts).

Read the "Sync with main" section of .work/reviews/m2-integration-handoff.md first.

## Checks
1. **Conflict resolutions.** Use `git show --remerge-diff 7a786ce95` (and `git diff 445241520 7a786ce95 -- <file>` where useful). For every file where the merge result differs from both parents' straightforward union, decide whether anything from either side was dropped. Pay particular attention to: docs/testing/m2-ledger.md, src/api/ops.ts, src/core/task-detail.ts (integration's `userStarted` fix must survive alongside main's capacity projection), src/serve/http.ts (native bridges + main's background worker), src/api/v2-compat.ts, crates/server/src/serve/mod.rs, crates/read-model/src/tasks.rs, the MCP and v2 goldens, scripts/protocol-doc.ts and docs/protocol.md. src/app/assets.generated.ts must equal a fresh `bun run app:build` output (regenerate into a temp copy or check `git diff` after building, then `git checkout` it back so the tree stays clean).
2. **Semantic interactions** (code that merged cleanly but may now be wrong): every operation main added or changed (for example `runner.models.get/set`, the `dispatch.child` schema additions, msg.send's stale-answer guard, task list/detail changes) must be either registered natively with parity or forwarded, and the native registry, `crates/server/src/op_catalog.json`, `stdio_hello.json`, MCP catalog and generated protocol types must agree. Look for any other native validator in crates/*-ops that mirrors a Zod schema main changed (search the diff of src/api/ops.ts and src/**/schema*.ts against Rust validators) — 3c483c420 fixed one; find any others.
3. **3c483c420.** Is forwarding `dispatch.child` requests containing `difficulty` or `model` correct and minimal, versus updating the native validator? Does the native refusal path still match TypeScript for requests without those fields? Is the ledger row accurate?
4. **Ledger.** Run `bun .work/fixtures/m2-ledger-check.ts` (must PASS: 231 catalog, 157 native, 74 forwarded, 83 selective, 3 Rust-validated) and spot-check the two new forwarded model rows against the code.
5. **Commands** under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh, disposable HOME/PACER_HOME: `bun run typecheck`; `bun test test/native-dispatch-lifecycle-parity.test.ts test/native-task-get-parity.test.ts test/mcp-parity.test.ts test/m1-gate.test.ts test/messaging-user-retry.test.ts` plus any test file main added or changed that touches msg.send, task detail, models or v2 (set PACER_TEST_NATIVE_FRONT_DOOR to the absolute path of target/debug/pacer, already built with test-ops); `git diff --check 8156b69a0..HEAD`; confirm every commit in 8156b69a0..HEAD has Signed-off-by and no tracked file contains `/Users/` or `/Volumes/` paths added by this range.

Do NOT run cargo (build, test, clippy) — the machine is memory-constrained and the sync worker already ran the workspace suite (results in the handoff). Do not run the full Bun suite or the live harness. Leave the tree clean.

Write the report to .work/reviews/m2-integration-review-sync.md: head, per-commit assessment, per-file conflict assessment, commands with counts, findings with severity (blocking / non-blocking), rule, evidence and remedy. Verdict PASS or FAIL. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

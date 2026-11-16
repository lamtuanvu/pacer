# Independent final-revision review: integration commits after fix batch 1

You are the independent reviewer required by REPO-10. You did not write these commits. Review them and report; do not change anything.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 0835c8003. Earlier reviews covered everything up to ebdd2d5fe. Your scope is exactly the two commits after it:
- **0caf01ab0** `docs: qualify the runner.set forwarding condition`. This answers finding N1 in .work/reviews/m2-integration-review-fix1.md: the runner.set row must say that only a string `model` in otherwise valid params forwards, and that invalid params fail natively. Check this against crates/config-ops/src/runner_ops.rs:485-500.
- **0835c8003** `fix: preserve managed task detail and native gate coverage`. Phase B found three failures introduced by the integration and fixed them (see the "Phase B suite and fixes" section of .work/reviews/m2-integration-handoff.md):
  - src/core/task-detail.ts: the managed-work projection had overwritten the enriched `work` field and lost `userStarted`;
  - test/fixtures/mcp/ts-success-golden.json: updated for the intended managed-work projection;
  - scripts/gate/m1.ts and test/m1-gate.test.ts: the M1 gate now validates operations registered as indexed entries `ops()[i]` against their source arrays.

## Checks
1. For src/core/task-detail.ts:
   - Is the fix correct and minimal?
   - Which side of the merge lost `userStarted`? Use `git log -L` or blame on the region, and compare with main and with fix/managed-work-actions 18d289925.
   - Is any other enriched field still overwritten by the projection?
2. For the golden: does every changed field come from the managed-work projection, and nothing else? Compare the golden at 18d289925 (the source branch), at main, and here.
3. For scripts/gate/m1.ts:
   - It must still fail closed: an unresolvable index, a missing array, an out-of-range index, or a name not in the catalog must all fail.
   - The gate must not be weakened for literal registrations.
   - Construct and run a quick negative check without committing it. For example, copy the gate input to /tmp and break one index, or reason it through with the test.
4. Run under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, with TZ=Asia/Ho_Chi_Minh: `bun test test/m1-gate.test.ts test/messaging-user-retry.test.ts test/mcp-parity.test.ts`, plus any test touching task-detail (search test/ for task-detail and userStarted). Also run `bun run typecheck`, `git diff --check ebdd2d5fe..HEAD`, and confirm every commit has Signed-off-by.

Four live workers are using this worktree, so do not run cargo, the full suite or the live harness.

Write the report to .work/reviews/m2-integration-review-final.md. Include the head, a per-commit assessment, the commands and their counts, and any findings with severity, rule, evidence and remedy. The verdict is PASS or FAIL. Report with orca orchestration worker_done. Always end with worker_done.

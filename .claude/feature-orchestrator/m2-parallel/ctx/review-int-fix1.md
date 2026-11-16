# Independent re-review: integration fix batch 1

You are the independent reviewer required by REPO-10 for the fixes to earlier review findings. You did not write these fixes. Review them and report; do not change anything.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head ebdd2d5fe. Your scope is exactly two commits on top of d8c1b276c:
- e2622f031 `docs: restore runner.set selective forwarding and clarify the selective definition`
- ebdd2d5fe `chore: drop the orphaned handover bridge main removed`

## Findings these commits address
From .work/reviews/m2-integration-review-ledger.md (F1, F2), .work/reviews/m2-integration-review-a.md (A1–A3) and .work/reviews/m2-integration-review-b.md (orphan):
- **F1/A1:** runner.set's selective model forwarding was dropped by a merge.
- **F2:** the selective definition. The coordinator decided this: selective covers either forwarding the original request, or a whole-operation bridge whose Core result becomes the reply, for some inputs, callers or states. Effects and enrichment bridges, where Rust composes the reply, are excluded, and so is process-wide routing.
- **A2:** the service.install and update.apply summary contradicted their rows.
- **A3:** the plugin JSON nesting fallback descriptions had been dropped.
- **Orphan:** crates/server/src/native/handover_bridge.rs, which main deleted in 199b4de01.

## Checks (read-only; light commands only, because the machine is overloaded)
1. Each finding is fixed and matches the code. For each, give the ledger line and the code file and line that justify it:
   - runner_ops.rs:485-500 and the serve and stdio routing;
   - plugin-ops json.rs:154-201 and native/plugins.rs:316-324;
   - the service.install and update.apply handlers.
2. The definition text in the ledger header states the coordinator's decision accurately, and task.send's label is consistent with it. The handoff's "Fix batch 1" section has a whole-operation bridge scan that found task.send, service.install and update.apply. Spot-check that scan by searching crates/*/src for core-bridge calls whose result becomes the reply, and look for any whole-operation bridge it missed.
3. Totals are 229 = 157 native + 72 forwarded, and selective is 83. Rerun `bun .work/fixtures/m2-ledger-check.ts`. Compare `git diff 54ffba85d..HEAD -- docs/testing/m2-ledger.md` against main for any sentence still dropped by a merge where the code still matches. Report each one.
4. The orphan deletion: `rg handover_bridge crates/` shows no remaining reference, and no `mod` declaration ever included the file at d8c1b276c. `git diff --stat d8c1b276c..HEAD` touches only the ledger and that file, so there is no runtime change.

Do not run cargo, the full suite or the live harness.

Write the report to .work/reviews/m2-integration-review-fix1.md. Include:
- the head;
- a per-finding table;
- the scan spot-check;
- the comparison with main;
- any new findings, each with severity, rule, evidence and remedy;
- the verdict: PASS or FAIL.

Report with orca orchestration worker_done. Always end with worker_done.

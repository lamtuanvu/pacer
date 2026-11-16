# Independent review: M2 ledger recount (commit d8c1b276c)

You are the independent reviewer required by REPO-10. You did not write this change. Review it and report; do not fix it.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head d8c1b276c. Your scope is docs/testing/m2-ledger.md as changed in d8c1b276c (`git show d8c1b276c`), checked against the merged code at this head. Read the "Ledger recount" section of .work/reviews/m2-integration-handoff.md. The checker .work/fixtures/m2-ledger-check.ts already passes: catalog 229, registered 160, native 157, forwarded 72 (3 Rust-validated), selective 82. That checker counts the labels as written in the document; it does not derive them from handler logic. Your job is to derive them.

## Definitions (set by the coordinator; they are in the ledger header)
- **Native:** Rust produces the reply for at least some valid requests. An op that Rust only validates and then forwards every valid request for counts as Forwarded (Rust-validated).
- **Selective:** the op's own handler forwards the original request to TypeScript for some inputs, callers or on-disk states. Process-wide routing does not count: work-grant processes forwarding everything, and PACER_FORWARD_OPS. Neither do effects or enrichment bridges, where Rust keeps the reply.
- **Plugin ops:** native, with a note that stdio forwards them.

## Method (no time limit; cover every row before writing the verdict)
1. For every row labelled selective, and every row whose status changed in d8c1b276c, find the handler in the code and the exact branch where it forwards the original request: a forward return, a selective-forward error, or an equivalent. Give the file and line.
   - Where a selective label has no such branch, that is a finding.
   - Where a native op does forward the original request for some inputs but is not labelled selective, that is also a finding. Search the native handlers for the selective-forward mechanism (for example `forward`, `Forward`, `selective`, `NeedsCore`) to find unlabelled cases.
   - The relabels to check: setup.check, task.get, strategy.build, setup.init, dispatch.dependencies, job.list, job.get and job.cancel. Each must be justified by its code.
2. Check the three Rust-validated forwarded ops (doctor.run, setup.health and the third): Rust replies to no valid request.
3. Check the totals: catalog = native + forwarded, and every op appears exactly once. Rerun `bun .work/fixtures/m2-ledger-check.ts`.
4. Check that the prose in changed rows matches the code: no stale claims about bridges, paths or crates after the split. Check that the ledger contains no machine-specific paths.
5. Run `TZ=Asia/Ho_Chi_Minh bun test test/op-catalog-parity.test.ts` under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny. Do not run the full suite, the live harness or any cargo build.

Write the report to .work/reviews/m2-integration-review-ledger.md. Include:
- a table with one line per selective or relabelled row: the op, the label, the handler file and line, and your conclusion;
- the unlabelled-selective search and what it found;
- the totals check;
- findings with severity, rule, evidence and remedy;
- the verdict: PASS or FAIL.

Report with orca orchestration worker_done covering the verdict and findings. Always end with worker_done.

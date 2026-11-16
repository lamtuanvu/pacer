# Task: recount the M2 ledger on the integrated branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head f8f1f998f. All eight branches are now merged onto origin/main 54ffba85d. Read .work/reviews/m2-integration-handoff.md first. Safety rules from /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md apply.

The maintainer decided the ledger is recounted once, against the merged registry. Your only job is to make docs/testing/m2-ledger.md exactly true for this head. Do not run the full bun suite, live validation or any heavy build; another worker is running a full suite elsewhere. Finish completely.

## Steps
1. Derive every figure from code, not from the ledger's own text:
   - the catalog total, from the stdio_hello.json v3 in crates/server;
   - the natively registered op set, from the native registry code after the split;
   - the forwarded set;
   - the selective set, from the code's actual selective-forwarding decision. Find where an op that is registered natively can still be forwarded for some inputs (for example a plugin op, or task.get), and define "selective" by that code path.

   Earlier branches disagreed on the selective set: runner-ops counted the 12 plugin ops and excluded task.get, while task-send included task.get. Settle it from the code, and explain the definition in one sentence in the ledger. The provisional count at an earlier head was 229 catalog, 158 native and 71 forwarded; verify it, don't copy it.
2. Rewrite the ledger's totals, labels and rows so every row matches the code:
   - each op's status (native, forwarded or selective) and the PR or branch that made it native;
   - the pre-existing mismatches fixed (57 stated vs 68 listed; 225 vs 228);
   - no duplicate rows and no missing ops.

   Keep the ledger's existing format and tone, change only what the code requires, and keep main's existing rows (for example service.handover, service.work and pacing.balance) accurate.
3. Make it reproducible. If the repository already has a ledger or catalog consistency test, run it and extend it if needed. Otherwise put a small checker script under .work/fixtures/ (untracked): it parses the catalog, the registry and the ledger and asserts that the sets and totals match. Run it and paste its output into the handoff. The earlier checker at /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops/.work/fixtures/ledger-check.ts can be a starting point.
4. Run `bun run typecheck`, `git diff --check`, and any test that asserts ledger or catalog content (search test/ for m2-ledger and op_catalog). Commit with `git commit -s -m "docs: recount the M2 ledger against the merged registry"`.
5. Also record, for the PR body:
   - pacer-server line counts and per-crate counts from `cargo xtask loc` (reuse the existing target/ build output; do not rebuild);
   - the `cargo xtask deps` result.

Do not push. Append a "Ledger recount" section to the handoff covering:
- the definitions;
- each figure and how it was derived (file and function);
- the changes made;
- the checker's command and output;
- the line counts.

Report with orca orchestration worker_done: head, catalog, native, forwarded and selective figures, the definition, and the checks. Always end with worker_done.

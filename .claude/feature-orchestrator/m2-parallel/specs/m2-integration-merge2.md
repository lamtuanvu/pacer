# Task: finish merging the M2 integration branch (phase A: merges, ledger, static checks)

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration). Current head 3f0042a6b: origin/main 54ffba85d plus signed merges of m2/dispatch-ops (e17ac4e10) and m2/account-list (3f0042a6b). A previous worker stopped after those two; read its handoff at .work/reviews/m2-integration-handoff.md and continue from there. The full original brief is /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md (branch table, heads, worktrees, live session names, known conflicts, sandbox and safety rules); everything in it still applies.

This phase covers merges, the ledger recount and static and targeted checks. The full bun suite and live validation come in a later phase, so do not run them here. Work through every step without stopping early. If a step is genuinely blocked, commit what is consistent, record it, and still finish the steps that remain.

## Steps
1. Merge the remaining six branches with `git merge --no-ff --signoff`: m2/task-send 58b2769bd, m2/runner-ops e527e10ef, m2/service-handover 50a69ed98, m2/setup-doctor b0ad8f844, fix/managed-work-actions 18d289925, then refactor/split-pacer-server 6b962a4f9 last. The previous worker chose operation branches before the split. When you merge the split, carry every M2 addition (natively registered ops, bridge and registry edits, tests) into the files the split moved, so nothing is lost or duplicated. Check this with `git grep` for each M2 op name before and after the merge. For the ledger conflicts during merges, keep a consistent interim union. The real recount is step 2.
   - For each conflict, read both sides and main's commits that touched the file. Never drop main's changes or a branch's behaviour.
   - Regenerate src/app/assets.generated.ts with the project's generator; never hand-merge it.
   - Record every conflict and its resolution.
2. Recount docs/testing/m2-ledger.md against the merged code:
   - The catalog total from crates/server (or its moved location) stdio_hello.json v3.
   - The natively registered set and the forwarded set, both from the actual registry code.
   - The selective list, defined from the code's actual selective-forwarding decision and applied consistently. Previously, runner-ops counted the 12 plugin ops and excluded task.get, and task-send included task.get; settle this from the code.
   - Fix the pre-existing mismatches (57 stated vs 68 listed; 225 vs 228). Every row, label and total must match the code.
   - Add a small reproducible check to the handoff: the commands or script you used and their output.
3. Static checks with CARGO_INCREMENTAL=0: `cargo xtask loc --check`, `cargo xtask deps`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck`, `git diff --check`. Fix integration-introduced failures faithfully with signed commits. CRATE-1 and CRATE-9 exceptions are covered by PRs #848 and #849; report the loc and deps results either way.
4. Run `cargo test --workspace --exclude pacer-plugin-host` under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny. Also run, under sbx-deny, the bun test files that each source branch's final review named as its targeted tests, plus every test file touched by a conflict resolution. Find them in each branch worktree's latest .work/reviews/ reports. Set PACER_TEST_NATIVE_FRONT_DOOR to a built binary path, PACER_TEST_BROWSER, and TZ=Asia/Ho_Chi_Minh. Run each failing file on a clean origin/main scratch worktree to classify it (remove the scratch worktree afterwards), and fix the ones the integration introduced.
5. Stop if free disk falls below 10 GiB. Delete target/ at the end only if free disk is below 25 GiB; otherwise keep it for phase B.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Signed commits. Do not push. Overwrite .work/reviews/m2-integration-handoff.md with a complete phase-A handoff. It must cover:
- the merge order;
- every conflict and its resolution, including the previous worker's;
- the ledger figures, the selective definition and the reproducible check;
- static-check results;
- cargo and targeted bun results, with failure classification;
- anything left for phase B.

Report with orca orchestration worker_done: head, merges done, conflicts, ledger figures, check and test results, open items. Always end with worker_done.


Carry out the task described above.

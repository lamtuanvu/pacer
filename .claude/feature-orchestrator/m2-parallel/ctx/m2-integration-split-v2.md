# Task: merge the pacer-server split into the integration branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 3b510cd8d. It now merges all seven M2 operation branches onto origin/main 54ffba85d. Read .work/reviews/m2-integration-handoff.md first. The original brief, with its safety and sandbox rules, is /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md.

Your only job is to integrate refactor/split-pacer-server (6b962a4f9, worktree .work/worktrees/refactor-split-pacer-server) correctly and prove it. Leave the ledger recount, the full bun suite and live validation for later. Finish this integration completely; do not stop partway.

## Background
The split is a move-only refactor of crates/server:
- it creates crates pacer-core-bridge and pacer-mcp;
- it moves code into read-model, update, config-ops and task-ops;
- it shrinks pacer-server from 12054 to 7598 lines.

Read its final review reports and the split-final-6b962a live report in that worktree's .work/ (reviews and live) to understand what moved where and what it proved. The split was cut from an older main. Since then, main and the seven merged branches have edited files the split moves: native registry and bridge code, core_bridge_sync, service_effects_sync, and task-ops status_ops.

An exploratory merge showed these conflicts:
- core-bridge/core_bridge_sync;
- server/native;
- a rename/rename conflict: main renamed service_effects_sync to server/native/handover_bridge, while the split moved it to core-bridge/service_effects_sync;
- task-ops/status_ops.

Preserve main's handover changes (including whatever main removed).

## Approach
You may either merge with `git merge --no-ff --signoff`, or, if a textual merge proves unworkable, re-apply the split's moves on top of the current head as signed commits that reproduce its structure. The PR is squash-merged, so either is acceptable. State which you chose and why.

Either way, the result must have:
- the split's crate structure and dependency direction;
- every M2 addition and every main change, carried into the moved locations with nothing lost or duplicated;
- no behaviour change from the move itself.

## Proof
1. Before you start, record for each M2 op name and bridge function at the current head where it is registered or implemented: `git grep` for the op strings in crates/ and src/ (for example account.list, account.signin, task.send, the runner ops, service.handover, update.check, setup.doctor, setup.health, setup.init, executor.setup.candidates, strategy.build, and the dispatch ops). After the merge, show that every one is still registered and implemented, at its new path. Include both tables in the handoff.
2. Under sbx-deny with CARGO_INCREMENTAL=0, run these one at a time, never concurrently:
   - cargo fmt --check, clippy -D warnings, xtask loc --check and xtask deps (report CRATE-1 and CRATE-9 results; exceptions are in PRs #848 and #849);
   - bun run typecheck and git diff --check;
   - `cargo test --workspace --exclude pacer-plugin-host`;
   - the four plugin-host native_run tests once outside the sandbox, with a disposable HOME and PACER_HOME and a PACER_PORT other than 4317, as the split worker did.
3. Build the test-ops front door. Then, under sbx-deny with TZ=Asia/Ho_Chi_Minh and PACER_TEST_NATIVE_FRONT_DOOR and PACER_TEST_BROWSER set, run:
   - the split's targeted tests (test/native-host-set-parity.test.ts and the others its review named);
   - every native-*-parity and native-dispatch test file;
   - the targeted files of the other seven branches as listed in the handoff.
   Classify any failure against a clean origin/main scratch worktree (remove it afterwards) and fix the failures the integration introduced.
4. Stop if free disk falls below 10 GiB. Keep target/.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Signed commits. Do not push.

Append a "Split integration" section to the handoff covering:
- the approach and why you chose it;
- every conflict and its resolution;
- the before and after op-location tables;
- the line counts and dependency-check output;
- every command and its result;
- failure classification;
- open items.

Report with orca orchestration worker_done: head, approach, conflicts, op-preservation check, check and test results, open items. Always end with worker_done.

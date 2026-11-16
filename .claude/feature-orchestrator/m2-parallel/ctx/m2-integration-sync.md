# Task: sync the integration branch with the latest main

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 8156b69a0. That head is origin/main 54ffba85d plus eight merged M2 branches, reviewed and validated. Since then, origin/main has nine new commits (`git log 54ffba85d..origin/main`): #858, #860 and #861 (executor model management, phases 2 and 3), #859 (incremental task updates), #862, #863, #864, #865, and #866 (native msg.send stale-answer guard). Read .work/reviews/m2-integration-handoff.md first.

Finish every step without stopping partway.

## Steps
1. **Merge.** `git fetch origin`, then `git merge --no-ff origin/main`.
   - Resolve conflicts, then conclude with `git commit -s` so the merge commit carries Signed-off-by. Verify that it does: an earlier merge lost its sign-off.
   - Known conflicts: docs/testing/m2-ledger.md, and src/app/assets.generated.ts. Regenerate the assets file with the project's generator; never hand-merge it.
   - For every other file that main and this branch both changed, check the auto-merge semantically, reading main's commit for it. These include crates/server/src/serve/mod.rs, crates/read-model/src/tasks.rs, src/core/task-detail.ts (which 0835c8003 fixed), src/api/ops.ts, src/api/v2-compat.ts, src/serve/http.ts, the MCP and v2 goldens, and docs/protocol.md.
   - Pay particular attention to #866, which changed native msg.send, and the msg.send rows; and to #858 and #860, which may add or change ops such as runner.set models, account.models and allowed models.
2. **Recount the ledger against the merged registry** (maintainer rule: recount on each rebase). Use the definitions in the ledger header. Rerun `bun .work/fixtures/m2-ledger-check.ts`, extending it if main added registry shapes. Make the totals, rows and selective list exactly match the code. Classify any new or changed op from main by reading its handler and route.
3. **Checks,** with CARGO_INCREMENTAL=0 and one command at a time:
   - `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo xtask loc --check`, `cargo xtask deps`, `bun run typecheck`, `bun run ui:check` (if it exists), and `git diff --check`;
   - `cargo test --workspace --exclude pacer-plugin-host` under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny;
   - rebuild the test-ops front door (`cargo build` with the test-ops feature, as the live harness does) and set PACER_TEST_NATIVE_FRONT_DOOR to it. Then run these bun test files under sbx-deny with TZ=Asia/Ho_Chi_Minh and PACER_TEST_BROWSER set:
     - every test file changed by main's nine commits (`git diff --name-only 54ffba85d origin/main -- test/`);
     - every native-*-parity file;
     - native-dispatch, op-catalog-parity, m1-gate, mcp-parity, messaging-user-retry and native-task-get-parity;
     - the tests for files you resolved by hand.
   - Classify each failure against a clean origin/main scratch worktree, then remove that worktree. Fix failures the merge introduced faithfully, in signed commits.
   - Do not run the full suite or the live harness; PR CI and a later live pass cover those.
4. Stop if free disk falls below 10 GiB.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Do not push.

Append a "Sync with main" section to the handoff covering:
- the merge commit;
- each conflict and auto-merge check, with its resolution;
- the ledger figures and changes;
- the commands and their results;
- failure classification;
- the final head.

Report with orca orchestration worker_done: head, conflicts, ledger figures, checks, test counts. Always end with worker_done.

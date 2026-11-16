# Task: merge m2/setup-doctor into the integration branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 63c747406. It already merges six M2 branches onto origin/main 54ffba85d. Read .work/reviews/m2-integration-handoff.md first; the full original brief, with its safety and sandbox rules, is /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md.

Your only job is to merge m2/setup-doctor (b0ad8f844, worktree .work/worktrees/m2-setup-doctor) correctly and prove it with targeted checks. Do not merge the split. Do not do the ledger recount beyond a consistent interim union. Do not run the full bun suite or live validation. Finish this one merge completely; do not stop partway.

## What the conflicts are
Two earlier attempts aborted with conflicts in:
- crates/config-ops: executor_candidates_ops, lib, setup_effects, setup_init_ops and its tests;
- the config strategy;
- crates/server: native, core_bridge_sync, setup_effects_sync, serve/mod, stdio_proxy;
- the ledger;
- src/api/setup-bridge, stdio, serve/http;
- test endpoint-detect, native-dispatch, native-setup-parity, pinned-port and pinned-port.test.

Main moved on after the branch was cut. In particular, main's setup.init uses its own setup_init path, while the branch uses effects_stub, and main added service and update routes that must survive. Before resolving:
- run `git log --oneline 33e584bce..origin/main -- <file>` for each conflicting file;
- read main's commits that touched it;
- read the branch's final review reports in the setup-doctor worktree's .work/reviews/ so you know exactly what behaviour the branch adds: native setup.doctor / setup.check, executor candidates with the cold catalog cache forwarding executor.setup.candidates to Core, the PACER_TEST_LOCAL_SERVER_PORTS test seam (test-ops Rust and uncompiled TypeScript only), and the live-harness model-port fixtures.

The result must keep all of main's behaviour and all of the branch's behaviour; where they overlap (setup.init), integrate them and explain how. Use `git merge --no-ff --signoff`, with follow-up signed fix commits if needed.

## Validation (with CARGO_INCREMENTAL=0; never run cargo and bun at the same time, since concurrent builds overwrote target/debug/pacer last time)
1. Run cargo fmt --check, clippy -D warnings, xtask loc --check, xtask deps, and bun run typecheck.
2. Run cargo test for -p pacer-config-ops, -p pacer-server and any other crate you touched, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny. Then investigate the earlier E0463 doctest failure in pacer-account-ops (missing pacer_config, pacer_engine and pacer_foundation): rerun `cargo test -p pacer-account-ops --doc` alone, without any concurrent build. If it still fails, check whether it fails the same way on a clean origin/main scratch worktree, and remove that worktree afterwards.
3. Build the test-ops front door. Then, under sbx-deny with TZ=Asia/Ho_Chi_Minh, PACER_TEST_NATIVE_FRONT_DOOR set to the binary path and PACER_TEST_BROWSER set, run the setup-doctor branch's targeted bun tests (named in its final review) plus every test file touched by a conflict resolution. Classify any failure against a clean origin/main scratch worktree, fix the ones the integration introduced, and remove the scratch worktree.
4. Stop if free disk falls below 10 GiB. Keep target/.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Do not push.

Append a "Setup-doctor merge" section to .work/reviews/m2-integration-handoff.md. Cover every conflict and how it was resolved (especially setup.init), the commands you ran and their results, failure classification, and the doctest finding. Report with orca orchestration worker_done: head, conflicts and resolutions, check and test results, open items. Always end with worker_done.

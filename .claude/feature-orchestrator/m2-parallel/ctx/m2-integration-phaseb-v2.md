# Task: phase B, full validation of the M2 integration branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 1b031e613. All eight branches are merged and the ledger is recounted. Read .work/reviews/m2-integration-handoff.md, and the original brief /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md. That brief holds the branch table with each branch's final live session name and worktree, plus the safety and sandbox rules. An independent project review of this head is running in parallel; do not wait for it.

Finish every step. Do not stop partway. If one step is blocked, record it and continue with the rest.

## Steps
1. **Live validation (CT-11)** at the clean head, following docs/testing/live-validation.md. Start now.
   - Read each branch's final live report: in each source worktree's .work/live/<session>/, and the evidence summaries in its .work/reviews/.
   - Run one or more sessions with `bun run live` that repeat every branch's key surfaces, with the same fixtures and options those sessions used:
     - dispatch lifecycle ops;
     - account.list and account.signin;
     - task.send;
     - the runner ops and runner check;
     - service.handover;
     - setup.doctor, setup.health, setup.init and executor candidates, with the --local-model-ports fixtures and the macOS sandbox;
     - managed-work actions in the web UI (geometry, and the missing-op filter proxies);
     - the split's write families, v2, the MCP fixture and WebSocket.
   - Do web checks in Orca's built-in browser with new isolated profiles.
   - Live evidence must come from this exact head with a clean tree.
   - These maintainer exceptions stay UNVERIFIED, so do not exercise them: op-specific stdio beyond the fixed fixtures, the desktop app, the PACER_FORWARD_OPS override, D3/D8-guarded effects, the Updates Install control, and real executors.
   - Stop every session, proxy, fixture, tab and profile afterwards.
2. **Full bun suite.** Another worker is running a full suite in .work/worktrees/fix-test-port-isolation. Before you start yours, wait until no `bun test` process with that worktree as cwd remains: check with pgrep and lsof, sleeping 60 seconds between checks. Never run two full suites at once.
   - Then run the whole suite in shards with JUnit output, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, with TZ=Asia/Ho_Chi_Minh, PACER_TEST_NATIVE_FRONT_DOOR set to the built test-ops binary path, and PACER_TEST_BROWSER set. Use CARGO_INCREMENTAL=0 for builds.
   - Report total pass, skip and fail counts.
   - For every failing file, rerun it alone first, since contention causes timeouts. Then run it on a clean origin/main 54ffba85d scratch worktree to classify it as pre-existing or introduced.
   - Fix introduced failures faithfully, the smallest change consistent with the source branch's intent, in signed commits. Then rerun the affected files and any static check the fix touches.
   - Known pre-existing: the tray layout and board browser tests, and the 403s.
3. If you commit fixes after live validation, rerun the live surfaces those fixes touch, at the new head.
4. Stop if free disk falls below 10 GiB. At the end:
   - remove the scratch worktrees and target/ (target/ only if free disk is below 25 GiB);
   - stop all processes you started.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Signed commits. Do not push.

Append a "Phase B" section to the handoff covering:
- the live sessions, each report path and its Summary line;
- the surfaces covered, mapped to each branch;
- the UNVERIFIED items;
- the suite counts and per-file failure classification;
- any fixes;
- the final head;
- cleanup.

Report with orca orchestration worker_done: head, live Summary lines, suite counts, introduced failures and fixes, UNVERIFIED items, cleanup. Always end with worker_done.

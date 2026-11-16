# Task: M2 wave 4 W4-2 — fix review finding N1 (and N3, N4), rebase onto main

Executor: cursor-agent (default model, frontier tier: forward predicates guard a remote-runner exclusion). No subagents.

Read and follow the "Build and environment", "Live validation", "Safety" and "Output" sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never use `git stash` (shared by all worktrees).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-2, branch `feat/w4-routing-residue`, head `f552db759` on `main` `a05f95414`.

Inputs:
- Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-review.md (verdict PASS; findings N1–N4).
- Your previous handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-handoff.md and brief `w4-2.md`.

## Steps

1. **Rebase** onto `origin/main` (`git fetch origin`). `main` now has #945 (owner call authority), #960 (test mask) and #961 (W4-4: `server::native::usage_broker_params`, per-op broker params in `serve/mod.rs` and `stdio_proxy.rs`, `strategy_preview_ops`). Resolve conflicts keeping both sides; W4-4's broker-params plumbing and your `status_residue_stays_forwarded` must both survive. Rebuild and rerun your parity file before step 2.
2. **N1 (fix).** `task_retry_options_stays_forwarded` and `routing_route_stays_forwarded` (`crates/task-ops/src/status_ops.rs` ~98, ~109) decide host-runner forwarding on Rust's `load_strategy`, and `routing_route_stays_forwarded` returns false when that load fails. Forward whenever `native_load(home)` is not `Some(Ok(_))`, before the host-runner check, and use that loaded strategy for the host check. Add parity cases (driver and front door) with an absolute `active` strategy name (set through `strategy.use`, as the reviewer's probe `.work/fixtures/w4-2-review-probe5.*` did) and with a strategy only Bun can load; both must forward and keep "devbox paused". Show them red before the fix.
3. **N3 (nit).** `crates/engine/src/mode_hold.rs` ~28: print integral `until` in full below 1e21, as `JSON.stringify` does, instead of below 2^53. Add a byte-level case.
4. **N4 (doc).** Say in the ledger row or the PR-body text that the native repo route registers under the `repos` lock while TypeScript's `resolvePolicyRepoInput` does not, and that a lock timeout gives `internal`.
5. N2 is a pre-existing TypeScript defect; do not fix it. Write a short issue text for it in your handoff (title and body) so the coordinator can file it.

Required checks: those in `w4-common.md` for the touched crates, your parity file and the existing parity suites you ran before (native-retry-options, native-agent-limits, native-job-strategy-setup, native-project-strategy, native-runner-discovery-attention parity, mode-hold, api-project-strategies), plus `test/status-broker-parts-bridge.test.ts` and `test/native-job-strategy-setup-parity.test.ts` from #961.

CT-11: a focused live run (`bun run live up --front-door rust --native-test-ops --seed ui`) showing the absolute-active-name route forwards and keeps "devbox paused" with the fake `ssh`, and one normal repo route still native. Report, then `live down --keep`.

## Output

New commits on top of the rebased branch (signed off, Conventional), not pushed. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-fix-handoff.md with the rebase resolutions, the fix, red-then-green evidence, checks, CT-11 summary, the N2 issue text and an updated PR body. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-2-fix.md exactly. End with orca orchestration worker_done.

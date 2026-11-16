# Task: fix round for W4-6 — native `dispatch.preview` / `dispatch.explain` (arch+QA FAIL on F1; security PASS)

Executor: cursor-agent (default model, standard tier: two parity tests from a template, small hardening, PR text). No subagents. Never use `git stash`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never start the shared sccache server from a disposable HOME; if `sccache` misbehaves, build with `RUSTC_WRAPPER=`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-6, branch `feat/w4-dispatch-preview-native`, reviewed head `84b225a05` on `origin/main` `511a08543`. Do not push. Commit with `git commit -s`, Conventional, author Vu Lam <lamtuanvuqs@gmail.com>. First rebase onto `origin/main` (now includes #970 and #979/#976; conflicts are unlikely; if the native op list or ledger totals conflict, keep main's lists and add `dispatch.explain`/`dispatch.preview`).

Inputs: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-review.md (arch+QA, F1–F5), /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-security-review.md (PASS; nonblocking follow-ups), your handoff `.work/reviews/w4-6-handoff.md`, and the reviewer's template `.work/fixtures/w4-6-review-forwards.test.ts`.

## Fix

1. **F1 (blocking, CT-4).** Add parity cases for the agent-session forward and the executor-session cwd forward to `test/native-dispatch-preview-parity.test.ts` (use the template). Show each is red with its forward predicate removed (single-line mutation) and green at head.
2. **Security follow-ups (do them, they are small):**
   - an explicit 256 KiB request-body cap on the Core `/_internal/dispatch-parts` route (and the stdio kind if it lacks one), with a test;
   - refuse `draft` together with `cached: false` in the bridge schema if no caller sends that combination (check first), with a test;
   - a unit test for the 30 s bridge deadline (a stub Core that never answers; assert the error text and that nothing is left running).
   Keep `pacer-dispatch-ops` ≤ 3,000 production LOC (`cargo xtask loc --check`); put tests in `tests.rs`.
3. **PR body and handoff (F2–F5).** Correct the overstated F6/#978 locked-store claim and document the locked-store forward (F2); update the rebase numbers (native 168, selective 94, forwarded 66 or whatever main now gives) and `pacer-server` 8,949 → 9,047 or the actual figure (F3); fix the #848 wording (F4); list the undocumented deviations (F5). Keep the web draft-explain surface listed as UNVERIFIED with its reason, or exercise it live if you can.

## Verify

fmt; clippy `-D warnings` (with and without test-ops); tests for `pacer-store`, `pacer-dispatch`, `pacer-dispatch-ops`, `pacer-core-bridge`, `pacer-server`; `xtask loc --check`/`deps`; typecheck; the parity file and the handoff's Bun list with front doors built from your head (plain and `--features test-ops`). CT-11: rerun the native CLI explain and MCP `dispatch.preview` steps on the new head vs the TS front door (fixture homes, fake executors, separate port; stop everything you start), and record the head commit.

## Output

Update `.work/reviews/w4-6-handoff.md` (new head, per-finding resolution, red/green evidence, CT-11, updated PR body including both reviews' summaries). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-6-fix.md exactly. End with orca orchestration worker_done.

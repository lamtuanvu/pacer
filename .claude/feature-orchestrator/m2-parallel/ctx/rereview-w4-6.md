# Task: architecture, QA and security re-review of W4-6 after its fix round (REPO-10)

Executor: cursor-agent (default model, standard tier: a focused re-review of one fix commit against known findings). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never start the shared sccache server from a disposable HOME; if `sccache` misbehaves, use `RUSTC_WRAPPER=`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-6, branch `feat/w4-dispatch-preview-native`, head `6519213f8` on `origin/main` `1bf4103e4`. Commits: `e6df0fbae` (the feature, reviewed at `84b225a05` before the rebase) and `6519213f8` (the fix round). Not yet pushed.

Inputs:
- The earlier reviews: `.work/reviews/w4-6-review.md` (architecture/QA, FAIL on F1; F2-F6 documentation and advisory) and `.work/reviews/w4-6-security-review.md` (PASS; N1 256 KiB cap, N2 draft with `cached:false`, N5 30 s deadline untested).
- The author's handoff `.work/reviews/w4-6-handoff.md` and the PR body it names.
- `.project/reviewers/{architecture,qa,security}.md` (whichever exist), `docs/testing/m2-ledger.md`, `.project/rules/` scoped to Rust crates, API and tests.

Verify:
1. `git range-diff 84b225a05~1..84b225a05 1bf4103e4..e6df0fbae`: the feature commit is unchanged by the rebase apart from context.
2. F1 (blocking): the new parity cases cover the live-agent-session forward (driver, stdio, HTTP) and the executor-session explain forward (pacer worktree and Orca workspace cwd, stdio and HTTP). Reapply each mutation from the earlier review (drop one predicate at a time) in a `/tmp` copy and confirm the new cases turn red and that HEAD is green.
3. The hardening: the 256 KiB request cap on Core's `/_internal/dispatch-parts` route and stdio kind (checked before buffering an unbounded body, ordering with the 401/403 intact, a test with red evidence); the schema now refuses `draft` with `cached:false` and no Rust caller sends it; the Rust unit test for the 30 s bridge deadline exercises the timeout branch with a shortened deadline and does not slow the suite. Any new attack surface or behavior change for legitimate callers is a finding.
4. F2-F5: the PR body and handoff now state the #978 case accurately (what the read-only view proves and the locked-store forward), current numbers (server LOC, ledger 168 native / 94 selective / 66 forwarded), CRATE-1 wording and the listed deviations. Check the ledger totals against the ledger's own list.
5. Rerun on `6519213f8`: fmt, clippy `-D warnings` with and without `test-ops`, the touched crates' tests, `xtask` loc/deps, typecheck, and the 12 Bun files the handoff lists with front doors built from this head. CT-11: rerun at least the CLI preview/explain and MCP `dispatch_preview` comparison against the TS front door (`bun run live`, fixture homes, separate port, stop everything you start). Keep web surfaces UNVERIFIED unless you exercise them; say why.
6. Commits signed off and Conventional; no machine paths or personal emails in tracked files.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-rereview.md with a verdict (PASS / FAIL / UNVERIFIED) against `6519213f8`, the status of each earlier finding (F1-F6, N1, N2, N5), new findings with severity, and commands run. Report with `orca orchestration worker_done`. Always end with worker_done.

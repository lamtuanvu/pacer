# Task: QA and security re-review of PR #963 (owner parity R1) after its rebase onto H (#970) and G (#971) (REPO-10)

Executor: cursor-agent (default model, standard tier: a rebase whose only changes are two test adaptations and one ledger sentence). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never start the shared sccache server from a disposable HOME; if `sccache` misbehaves, use `RUSTC_WRAPPER=`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-r1, branch `fix/owner-hello-deadline`, head `9dc110135` on `origin/main` `1bf4103e4` (#970 merged). The previously reviewed revision is `07c7081d2` (PASS, `.work/reviews/parity-r1-review.md`); the pre-rebase head was `b23d6a7e1`.

Inputs: the PR body `.work/reviews/parity-r1-pr-body.md` (section "Rebase onto H (#970) and G (#971)"); the earlier review; ADR 0027 and `docs/testing/m2-ledger.md` on the branch; `.project/reviewers/{qa,security}.md`.

The coordinator rebased the branch, dropping `b23d6a7e1` (a ledger note about the door's divergence "until PR H"), then added:
- `001042ab6`: the R1 ledger entry now says every owner path's hello comes from the owner's sealed call, which the doors reach by relaying through Core since H.
- `9dc110135`: `crates/plugin-runtime/tests/hello_deadline.rs` authenticates with the session's key (G's `authenticate`) before its request, and `test/plugins-native-owner-hello-deadline.test.ts` makes in-process Core hold serve's `run/host.key` before calling the owner. Before this both failed with G's refusal.

Verify:
1. `git range-diff b23d6a7e1~3..b23d6a7e1~1 1bf4103e4..582ffc8b0`: the fix and docs commits are unchanged by the rebase apart from context.
2. The test adaptations keep each test's original assertions and strength (the 6 s hello passes; a silent hello fails at 10 s with flag-off's text; a shorter call deadline wins; flag-off vs the real owner). Reading `run/host.key` in a test is the established pattern (`native-plugin-ops-stdio.test.ts`) and leaks nothing. The red for each test still reproduces when the fix (`f691a893f`) is reverted in a `/tmp` copy.
3. The ledger and CHANGELOG are accurate after H: the doors relay through Core, so the R1 entry and the PR body's statements about door behavior (5 s ping bounds the hello on every door) match the code. Check one door path in code (serve or stdio `plugin.doctor` relays) and, if practical, live: `bun run live` with `--front-door rust --native-plugin-host`, a fixture plugin whose hello answers after 6 s and one that never answers, `plugin.doctor` over HTTP and stdio vs flag-off (fixture homes, separate port; stop everything you start). Otherwise mark the door path UNVERIFIED with the reason.
4. Rerun with front doors built from `9dc110135`: `cargo test -p pacer-plugin-runtime`, fmt, clippy `-D warnings`, typecheck, and the hello-deadline, owner call, native-plugin-ops (HTTP and stdio), host-bridge-auth and conformance suites. Commits signed off and Conventional; no machine paths or personal emails.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-r1-rereview.md with a verdict (PASS / FAIL / UNVERIFIED) against `9dc110135`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.

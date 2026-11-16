# Task: QA re-review of the owner test-hardening fix round (REPO-10)

Executor: cursor-agent (default model, standard tier: one small test-only commit). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md for the test environment, the sandbox and the sccache workaround.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/test-hardening, branch `test/owner-flake-hardening`, rebased onto `origin/main` `d688f46ce`; new commit `0dc2ed6b6` on top of the reviewed work (QA PASS at `54c1dcf9e`).

Inputs: your earlier review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/test-hardening-review.md (A1, A2, A3); the updated handoff `.work/reviews/test-hardening-handoff.md`; `.project/reviewers/qa.md` if present.

Verify:
1. The rebase dropped nothing: `git range-diff` of the reviewed commits against their rebased copies.
2. A3: `bridge_caller_auth.rs` spawn specs carry no runner environment beyond what the command needs (`PATH`); the 32 KiB pad reliably exceeds the Linux reset threshold on every runner; the frame-size assertion is real; no assertion or panic message prints a frame or env. Run the test with a large secret-looking env var set (e.g. `FAKE_SECRET=<40 KiB>`) and force one failure in a `/tmp` copy to confirm the variable never appears in output. Run the file 20 times; if Docker is available, reproduce the offline Linux check (`--rm`, `--network none`): green at head, red with the reset tolerance reverted.
3. A1: `scripts/ci/service-survival.ts` never passes a non-positive pid to `processIdentity` and still times out with a clear error. Check by reading, and with a small harness if practical; otherwise mark UNVERIFIED (it runs only in CI's Linux job).
4. A2: the duplex "service exit terminates…" test waits for a positive pid and still fails if the service outlives its parent (mutate in `/tmp`).
5. fmt, clippy `-D warnings` (`pacer-plugin-runtime`, all targets), typecheck, the edited Bun files with both front doors. Commit signed off and Conventional; no machine paths or personal emails in the diff. The handoff's PR body is accurate (including the corrected receipt-test claim).

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/test-hardening-rereview.md with a verdict (PASS / FAIL / UNVERIFIED) against `0dc2ed6b6`, findings with severity, and the commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-test-hardening.md exactly. End with orca orchestration worker_done.

# Task: independent QA review of the owner test hardening (REPO-10)

Executor: cursor-agent (default model, standard tier: test-only changes across 13 files). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. In zsh, pass test file lists as separate words.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/test-hardening, branch `test/owner-flake-hardening`, head `54c1dcf9e` on `main`.

Inputs: handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/test-hardening-handoff.md; brief `.claude/feature-orchestrator/m2-parallel/ctx/test-hardening-owner.md`; the findings that motivated it: `.work/reviews/parity-h-ci-rereview.md` F1 (pid 0 → `process.kill(0)`) and the #971 Rust ubuntu failure in `bridge_caller_auth.rs` (`a_wrong_proof_is_refused_and_the_connection_closed`, ECONNRESET at 275:50); `.project/reviewers/qa.md`, `.project/rules/code-and-testing.md`.

Verify:
1. `readPid`/`waitPid` in `test/helpers.ts` can never return 0, a negative number or NaN, time out with a clear message, and every racy pid-file read was replaced (search for any remaining `process.kill(Number(` or kill-after-readFileSync patterns). The crash fixture writes `held` atomically.
2. The caller-auth change still requires the `-32001` refusal before accepting a reset, still asserts nothing was started, and cannot pass when the owner accepts the wrong proof (mutate the product in a `/tmp` copy to accept it and show the test fails). Judge the decision not to change the product.
3. Reproduce the Linux evidence if feasible (Docker, the large-env trigger from the handoff, no credentials, no network beyond pulling the image), or at least confirm the reasoning.
4. No test lost coverage: compare each edited test's assertions before and after.
5. Checks: fmt, clippy `-D warnings`, `pacer-plugin-runtime` tests (caller-auth 20 times), typecheck, the edited bun files with both front doors built from the head (the crash suite 5 times). Commit signed off, Conventional, no machine paths. Confirm the two `plugins-executor-production-current` receipt timeouts also happen on `main` and whether they should be an issue.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/test-hardening-review.md with verdict (PASS / FAIL / UNVERIFIED) against `54c1dcf9e`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.

# Task: fix round for the owner test-hardening branch (A1, A2, A3 from the QA review)

Executor: cursor-agent (default model, standard tier: three small test-only changes with clear recipes). No subagents. Never use `git stash`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md for the test environment, the sandbox and the sccache workaround.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/test-hardening, branch `test/owner-flake-hardening`, reviewed head `54c1dcf9e` (QA PASS). Do not push. Commit with `git commit -s`, Conventional (`test:` or `fix(test):`), author Vu Lam <lamtuanvuqs@gmail.com>. First rebase onto `origin/main` (no overlap expected; resolve trivially or stop and report).

Inputs: review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/test-hardening-review.md (rows A1, A2, A3 and §5); handoff `.work/reviews/test-hardening-handoff.md`.

Do:
1. **A3 (most important).** In `crates/plugin-runtime/tests/bridge_caller_auth.rs`, stop embedding the runner's environment (`env::vars()`) in `spec()`/`sealed()`. Use a minimal env (`PATH`, plus anything the spawned command really needs). Add an explicit padding field or value so every sealed frame used by the reset-path test exceeds the size that triggers the Linux reset (the review measured about 8 KiB; choose comfortably above, e.g. 32 KiB) on every runner. Assertion messages must print only the method and the error, never the frame text. Verify the reset path is now exercised on every run: show the frame size in a test assertion, and if you can, rerun the reviewer's Docker Linux reproduction from `.work/fixtures/` (offline, `--rm`, `--network none`) with a small env: the whole file passes 20/20, and with the hardening reverted it fails.
2. **A1.** `scripts/ci/service-survival.ts`: wait until the wrapper's `child` file holds a positive integer pid (a `readPid`-style check inside `until(...)`) before calling `processIdentity`. Never pass a non-positive pid on.
3. **A2.** `test/plugins-capability-duplex.test.ts` "service exit terminates…": read the pid only once it is positive (wait in the subprocess, or use the existing `waitPid` helper in the parent) so a stub killed before writing can't produce pid 0.
4. Correct the handoff and its draft PR body per the review: the two production-current receipt tests pass under the project's `--timeout 30000` (`bun run test`) on main and the head, so no product issue; the audit now covers `service-survival.ts`.

Verify: fmt, clippy `-D warnings` for `pacer-plugin-runtime` (all targets); `cargo test -p pacer-plugin-runtime --test bridge_caller_auth` 20 times; typecheck; the edited Bun files with both front doors; `bun scripts/ci/service-survival.ts` if it runs on macOS (otherwise say UNVERIFIED and why). Grep the diff for machine paths and personal emails. No runtime behavior changes, so CT-11 does not apply; say so.

Output: update `.work/reviews/test-hardening-handoff.md` (new head, what changed, evidence, updated PR body). Report with `orca orchestration worker_done`. Always end with worker_done.

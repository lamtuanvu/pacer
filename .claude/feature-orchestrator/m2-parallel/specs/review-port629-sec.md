# Task: independent security and parity review of the #629 salvage port (REPO-10)

Executor: cursor-agent (default model), independent reviewer. You did not write this code. Read-only: do not edit tracked files, commit, push, start live sessions or build release. You may run `git`, `cargo test -p <crate>` for the touched crates (debug, uses the worktree's existing `target/`), and focused `bun test` files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, branch `fix/port-629-salvage`, base origin/main `acab1eca4`, head `5f2d2fd78` (5 commits). Implementer handoff: `.work/reviews/port-629-salvage-handoff.md`. Origin analysis: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/m2-stale-compare.md, section "#629". The closed PR's code is at `refs/compare/pr-629` (fetch with `git fetch origin pull/629/head:refs/compare/pr-629` if missing).

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/security.md` and `.project/reviewers/architecture.md`, and the rules in `.project/rules/{security,rust,rust-crates,architecture}.md`.

Review:
1. Fix 4, `crates/plugin-host/src/native_write.rs`: the authority recheck happens before staging and before commit (rename/unlink) on every write and remove path, matching `src/plugins/capability-write.ts` (`assertActive` at the same points). An expired or revoked authority can never publish. The sticky cleanup failure refuses later writes the same way TypeScript does. Look for TOCTOU gaps, symlink or hardlink escapes, and partial writes left behind.
2. Fix 1, `crates/plugin-host/src/native_hosts.rs`: every failure path (failed open, invalid handle, failed close, snapshot change, run error, invalid result) retires or closes the session, and a failed close stays retryable by `revoke`. The output bound sums stdout and stderr as `src/plugins/host-lease.ts` and `registry.ts` do. No session or child process can leak.
3. Fix 2, `native_orca.rs`: code-point bounds match Zod for every bounded parameter, including the max and max+1 cases with astral characters.
4. Fix 3, `crates/read-model/src/tasks.rs`: `placement` is `{mode, why}` only, the question field order matches TypeScript, and nothing else in the row changed.
5. The ported tests actually fail without the fix (spot-check by reverting a fix locally in a scratch copy or with `git stash`; restore afterwards) and test the TypeScript behavior, not a restatement of the Rust code.
6. CRATE-1: plugin-host went from 11,587 to 11,683 LOC (above 8,000). Does the PR description need the "why and named split" statement, and is the growth minimal?
7. Nothing from issue #889's list (Rust Orca attempt, SSH, Git bundle transfer, remote admission, lossless store) slipped in.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration/.work/reviews/port-629-review-sec.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity; findings (rule, severity blocking/nonblocking, location, evidence, impact, remedy), introduced separate from pre-existing; checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Do the read-only review above. Report with orca orchestration worker_done.

# Task: independent QA and repository-rule review of the #629 salvage port (REPO-10)

Executor: cursor-agent (default model), independent reviewer. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, focused `bun test` files, and `cargo test -p <crate>` for touched crates only after the security reviewer's cargo runs finish (check `pgrep -f "cargo test"`; if one is running in this worktree, wait).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, branch `fix/port-629-salvage`, base origin/main `acab1eca4`, head `5f2d2fd78` (5 commits). Implementer handoff: `.work/reviews/port-629-salvage-handoff.md`. Live reports: `.work/live/live-port629-rust/evidence/report.md` and `.work/live/live-port629-ts/evidence/report.md`.

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/qa.md` and `.project/rules/{code-and-testing,repository}.md` (REPO-4, REPO-7, REPO-10 to REPO-14, CT-11).

Review:
1. Tests: each fix has a test that fails without it and passes with it; the ported tests are deterministic (no sleeps racing, no real ports, temp homes only); test names and file placement follow the repo's conventions.
2. The `native_run` failures under sbx-deny: the handoff says 4 of 10 fail only inside sbx-deny, also on a revision equal to main except one Orca line, and pass 10/10 outside. Confirm from evidence or by running both ways if you can; classify as pre-existing environmental, or introduced.
3. CT-11: do the two live reports exercise the changed runtime surfaces that are reachable, and are the UNVERIFIED items (the `PACER_NATIVE_PLUGIN_HOST=1` paths) justified? Is a surface missing that the harness could reach?
4. REPO-4: every commit in `origin/main..HEAD` has Signed-off-by and a Conventional Commit subject; no `.work/` paths tracked; no machine paths or personal emails in added lines (`git diff origin/main HEAD | rg '^\+' | rg '/Users/|/Volumes/|@gmail|@icloud'`).
5. REPO-7: is a CHANGELOG `[Unreleased]` entry needed for these user-visible fixes (read-model `placement` shape, Orca bounds), and is one present? Do any docs or the M2 ledger need updating?
6. Item 6 (store surrogate test) was left out because it fails on main; it is now issue #891. Confirm nothing in the branch depends on it.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration/.work/reviews/port-629-review-qa.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity; findings (rule, severity blocking/nonblocking, location, evidence, impact, remedy), introduced separate from pre-existing; checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Do the read-only review above. Report with orca orchestration worker_done.

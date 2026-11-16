# Task: compare five stale M2 PRs against main and list what to salvage

Executor: cursor-agent (independent analyst). Read-only: don't edit tracked files, don't build, don't push, don't comment on GitHub. Write only `.work/reviews/m2-stale-compare.md`.

Repository: /Users/vulam/orca/workspaces/pacer/pinfish (use `git -C` there; don't check anything out). Main is `origin/main` (the M2 integration PR #870 has merged as acab1eca4). The PR heads are fetched as local refs:

| PR | Ref | Title |
| --- | --- | --- |
| #391 | `refs/compare/pr-391` | feat(core): probe comment-preserving strategy scalar edits |
| #393 | `refs/compare/pr-393` | feat(core): extend strategy editor and normalize basic YAML |
| #394 | `refs/compare/pr-394` | feat(config): preserve strategy map and list edit source ranges |
| #588 | `refs/compare/pr-588` | feat(cli): route executor guard and hook commands natively |
| #629 | `refs/compare/pr-629` | feat(plugin-runtime): Rust shadow Orca, SSH, Git transfer and admission ownership |

#391, #393 and #394 are stacked; most of their 266-273 changed files are old main drift, not their own work. Use `git log --oneline origin/main..refs/compare/pr-N` and each PR's own commits (`gh pr view N --json commits,body` is allowed, read-only) to find each PR's own changes, then `git diff` those commits.

For each PR, every row must have an observation:

| Column | What to record |
| --- | --- |
| Own changes | The PR's own commits and the files they touch (not merge drift). |
| Already on main | For each own change: is the same behaviour on main now (name the main file, function or test that covers it), superseded by a different design (name it), or absent? |
| Unique tests | Tests in the PR that check behaviour main doesn't test yet and that would still apply to main's code. Give the test name, file and what it checks. |
| Unique fixes | Bug fixes in the PR whose bug still exists on main. Show the main code that still has the bug. |
| Salvage plan | One of: nothing to salvage; port these tests; port this fix; or the work is still needed (say what). Estimate size (small, medium, large). |

Rules for judging: a test is only "unique" if main has no test for the same behaviour; check with `rg` on main's tree (`git grep <pattern> origin/main -- test crates`). A fix is only "unique" if you can point at the unfixed code on main. Don't recommend reviving whole PRs unless main still lacks the feature; say so explicitly for #629 (Rust shadow Orca, SSH, Git transfer and admission) and #588 (native guard and hook CLI commands).

Write `.work/reviews/m2-stale-compare.md` with a summary table (PR, own commits, salvage plan, size) and a section per PR with the evidence.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.

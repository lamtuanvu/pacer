# Task: independent review of wave 1 PR 0 (REPO-10) — JSON compatibility consolidated in `pacer-js-json`

Executor: cursor-agent (default model), independent reviewer. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `cargo test -p <crate>` / `cargo clippy -p <crate>` for the touched crates (debug, existing `target/`), `cargo xtask loc --check`, and focused `bun test` files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr0, branch `refactor/js-json-consolidate`, base origin/main `acab1eca4`, head `943d26417` (1 commit, 22 files, +332/−246). Implementer handoff: `.work/reviews/wave1-pr0-handoff.md`. Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md (maintainer decisions at the top, "PR 0"). Live report: the `live-wave1-pr0-final` session named in the handoff.

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/{architecture,qa}.md` and `.project/rules/{rust,rust-crates,architecture,code-and-testing,repository}.md`.

Review:
1. No behavior change: every moved function behaves byte-identically for every input its callers can pass. Where two copies were merged into one writer "with representation hooks", show the hooks preserve each caller's old output (key order, escaping, number spelling, quoted vs plain forms). Look for a caller whose output silently changed. Golden files must be unchanged (`git diff --stat origin/main HEAD -- '*golden*' 'test/fixtures/**'`).
2. Layering and CRATE rules: `pacer-js-json` stays layer 1 with no upward dependency; `pacer-repos` (4) and `pacer-plugin-ops` (5) depend on it legally; `xtask` deps check passes; CRATE-9 evidence is adequate for a dependency-set change.
3. `crates/mcp/src/json.rs` was left alone because its sentinel encoding differs. Is that justified, and should a follow-up issue exist?
4. `.project/rules/rust-crates.md` crate table lacks a `pacer-js-json` row and still says plugin-ops owns JSON compatibility. Rule files change only through the constitution's amendment process. Say whether this PR must carry an amendment, whether a follow-up is enough, and what exact table change is needed.
5. Tests: the moved unit tests still run under their new crate, nothing was dropped (compare test counts before and after), and the live smoke is adequate for a refactor (CT-11).
6. REPO-4: signed-off commit with a Conventional Commit subject and the maintainer identity; no `.work/` paths, machine paths or personal emails in added lines. REPO-7: a refactor with no user-visible change needs no CHANGELOG entry; confirm none is needed.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr0/.work/reviews/wave1-pr0-review.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity; findings (rule, severity blocking/nonblocking, location, evidence, impact, remedy), introduced separate from pre-existing; checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.

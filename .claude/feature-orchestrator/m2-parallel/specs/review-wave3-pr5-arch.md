# Task: independent architecture, crate and documentation review of M2 wave 3 PR 5 (REPO-10)

Executor: OpenCode GLM (glm-5.3, frontier tier; non-security review). Read-only: do not edit tracked files, commit, push or rebase. No subagents. Do not build or run cargo; read code and run `rg`/`git` only. A separate security reviewer covers process termination, sealing and OD-7 safety.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr5, branch `feat/owner-crash-backoff`, head `b96d8c9af`; review only `644c062e8..b96d8c9af` (four commits on top of wave 3 PR 2, #920).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-handoff.md (includes a draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave3-pr5.md.
- Plans: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md ("PR 5", §6 ledger rows) and /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-pr2-stdio-owner.md (§3.2, §4.2).
- ADR 0020, ADR 0026, ADR 0027 (`docs/decisions/`), `.project/rules/{architecture,rust-crates,repository,code-and-testing}.md`, `.project/reviewers/` files that match, `.agents/skills/project-review/SKILL.md`.

## Focus

1. Layering and crate boundaries (CRATE-4 strictly down, ADR 0026 layers): where crash reporting, backoff, the restart floor, teardown and OD-7 live; any new cross-crate dependency.
2. CRATE-1: `pacer-server` went from 8,753 to 8,870 code lines (WARN above 8,000); `pacer-plugin-runtime` growth. Is the stated justification and named next split accurate? Could any of the server growth sit lower?
3. CRATE-11 inline test blocks and file sizes; module docs updated (`serve_host.rs`, `native_host.rs`, `bridge_listener.rs`).
4. Plan conformance: everything in the revised PR 5 scope is done or explicitly deferred with a reason; deviations in the handoff are justified.
5. Docs (REPO-7): CHANGELOG Unreleased entries (crash/backoff, exit code 3, doctor check, known limits), ledger rows 22/23, ADR 0027 consequences if OD-7 behavior changed, the exit-code convention documented beside 1/2; no machine paths or personal emails.
6. The draft PR body in the handoff follows `.github/pull_request_template.md` and is accurate (executor/model line, linked issue, follow-ups).

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-arch-review.md: verdict (PASS / FAIL) against `b96d8c9af`, a findings table (ID, severity blocking/nonblocking, rule, code reference, evidence, fix). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-wave3-pr5-arch.md exactly. End with orca orchestration worker_done.

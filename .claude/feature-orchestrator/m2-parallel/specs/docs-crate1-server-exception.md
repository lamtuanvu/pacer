# Task: record a time-boxed CRATE-1 exception for pacer-server

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-crate1-server-exception
- Branch: docs/crate1-server-exception, based on origin/main. Work only here. Documentation only; no code changes.

## Background
CRATE-1 (.project/rules/rust-crates.md): above 12,000 LOC a crate is split before the PR merges, unless an exception is recorded in .project/decisions.md with an expiry. `cargo xtask loc` on origin/main reports `pacer-server` at 12,054 handwritten LOC (planned 2,000–2,500). Several in-flight M2 branches each add 100–250 LOC of op registration and bridges to it. The `cargo xtask loc --check` tool only warns above 12,000, although the rule's enforcement column says CI fails above 12,000.

## Maintainer decision (2026-11-10, @lamtuanvu, given in the coordinating session)
Record a time-boxed scoped exception so in-flight M2 native-op branches may merge while pacer-server exceeds 12,000 LOC, and split the crate in parallel (a separate branch, `refactor/split-pacer-server`, is being prepared).

## Required
1. Add a `## Scoped exception: pacer-server CRATE-1 size (2026-11-10)` section to .project/decisions.md, matching the style of the existing "Scoped exception" section at the top (Authority, Scope, Basis, Expiry). Content:
   - Authority: the maintainer's explicit decision in the coordinating session; not an AI reviewer approval or a governance amendment.
   - Scope: CRATE-1's 12,000 LOC split-before-merge requirement for `pacer-server` only. Applies to M2 native-op migration PRs that add op registration, bridges or front-door wiring to pacer-server. Each such PR states its pacer-server LOC delta in the description. No other crate and no other rule is waived; the 8,000 LOC justification requirement still applies (the split plan is the justification).
   - Basis: measured size on main (12,054), planned size, and the split branch in progress.
   - Expiry: when the pacer-server split merges, or 2026-12-01 23:59 UTC, whichever comes first. After expiry, PRs that leave pacer-server above 12,000 need the split or a new exception.
2. Note the enforcement mismatch (xtask warns rather than fails above 12,000) as an open item in the same section or in the open decisions table, without changing the tool in this PR.
3. Keep the wording consistent with .project/constitution.md's process: reviewers cannot grant exceptions; the maintainer's merge of this PR records it.

## Validation
Run whatever docs checks the repo has for .project/ and markdown (see package.json scripts and .project/rules/repository.md; e.g. link or format checks). No live validation is needed (no runtime change). Conventional Commit `docs: record a time-boxed CRATE-1 exception for pacer-server`, `git commit -s`. Do not push. No machine-specific paths or personal emails.

## Report
`orca orchestration worker_done` with the commit hash, the checks you ran, and the exact text added. Always end with worker_done.


Carry out the task described above, then report with worker_done.

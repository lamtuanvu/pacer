# Task: independent architecture and QA review of M2 wave 4 W4-5b — learned fit, reasons and the explanation builder in `pacer-dispatch` (REPO-10)

Executor: cursor-agent (default model, frontier tier: a large pure port with byte-exact explanation output). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. In zsh, pass test file lists as separate words.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-5b, branch `feat/w4-dispatch-explain-library`, head `0c40a65fc` on W4-5a `1bd85b6de` (PR #975, reviewed separately; do not re-review its commits).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5b-handoff.md (divergences, UNVERIFIED, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-5b.md.
- W4-5a's review and re-review (`.work/reviews/w4-5a-review.md`, `w4-5a-rereview.md`) for the findings that shaped this crate (tie-breaks, clamps, the read-only opener and issue #974).
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (Phase B, W4-6).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/{architecture,qa}.md`. Use `.agents/skills/project-review/SKILL.md`.

Verify:
1. **Architecture.** CRATE-8 (pure library, no op handlers), size (2,449 ≤ 3,000; CRATE-1 table), public surface small and sufficient for W4-6 (`dispatch.preview`/`explain` registration, the gathering the handoff leaves to W4-6), dependency direction (`cargo xtask deps`), CRATE-11.
2. **Port fidelity.** Module by module against `learning.ts`, `reasons.ts`, `dispatch-explain.ts` `build` and `dispatch-explain-ranked.ts`: thresholds, tie-breaks, ordering, rounding and number text, reason and exclusion codes and texts, unicode. Judge the divergences (internal CoreErrors for a malformed store vs TypeScript's TypeError; #974's opener applying to learning reads) and whether any is user-visible once W4-6 registers the ops.
3. **Tests.** Rerun `test/dispatch-explain-parity.test.ts` and the W4-5a differential; look for untested branches the way the W4-5a review did (mutate tie-breaks, thresholds, clamps, sort directions) and reproduce at least two of the handoff's eight mutations plus two of your own. fmt, clippy `-D warnings`, crate tests for `pacer-dispatch` and `pacer-dispatch-ops`, `xtask loc`/`deps`, typecheck, the three native-dispatch suites with both front doors built from the head.
4. CT-11: confirm nothing is reachable (library only).
5. Commit signed off and Conventional; no machine paths or personal emails.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5b-review.md with verdict (PASS / FAIL / UNVERIFIED) against `0c40a65fc`, findings with severity and code references, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.

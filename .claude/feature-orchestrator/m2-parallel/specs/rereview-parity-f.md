# Task: independent re-review of owner parity PR F after its rebase onto main (REPO-10)

Executor: cursor-agent (default model, frontier tier: a rebase across the sealed call authority). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-f, branch `feat/owner-observation-generations`, head `58ef737ad`, rebased onto `main` `30606ef07` (includes PR A #945). The pre-rebase head `abc791757` (backup `backup/parity-f-pre-main`) passed review; review what the rebase changed.

Inputs:
- Rebase handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-rebase-handoff.md (four conflicts and their resolutions; N8; three added commits; validation; CT-11 8 PASS / 2 UNVERIFIED flag-on, 4 PASS flag-off; one sbx-deny-only failure in `pacer-plugin-capabilities`).
- The original review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-review.md (N1–N8, n1, n2, P1).
- PR A's reviews (`parity-a-review.md`, `parity-a-rereview.md`) for A's sealed authority.
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,architecture,repository}.md`, `.project/reviewers/{security,qa}.md`, ADR 0027. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. Each conflict resolution keeps both sides' intent: `git range-diff abc791757~8..abc791757 30606ef07..58ef737ad` (adjust the ranges if the commit count differs), plus the diff of each conflicted file against both parents. No main change (A–E) was dropped.
2. N8: `observationFingerprint` survives A's sealed authority, cannot be set or overridden by a caller, and the new test is red without the change.
3. The ADR 0027 fix removes the contradiction with A's owning-call seal and matches the code.
4. The two added tests are meaningful (red without what they protect).
5. Rerun on this head: clippy and tests for `pacer-plugin-runtime` and `pacer-server`; `bun run typecheck`; conformance, matrix, assistant-key, `plugins-native-owner-call`, F's observation suites (both front doors built from this head). Confirm the `pacer-plugin-capabilities` failures are sbx-deny-only and pre-existing (run that crate's tests outside sbx-deny with a disposable HOME, and on `main`).
6. Judge the CT-11 UNVERIFIED items.

Environment: as in /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against `58ef737ad`, findings with severity and code references, and commands with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-parity-f.md exactly. End with orca orchestration worker_done.

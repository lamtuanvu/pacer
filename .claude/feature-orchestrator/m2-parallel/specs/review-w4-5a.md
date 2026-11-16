# Task: independent architecture and QA review of M2 wave 4 W4-5a — new `pacer-dispatch` library (REPO-10)

Executor: cursor-agent (default model, frontier tier: a new crate and byte-exact decision hashing). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-5a, branch `feat/w4-dispatch-library`, head `4c4431f2f` on `main` `1a4601837`.

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5a-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-5a.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (Phase B W4-5a/5b and W4-6, decision Q5, the crate size table).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/{architecture,qa}.md` (use whichever reviewer definitions exist). Use `.agents/skills/project-review/SKILL.md`.

Verify:
1. **Architecture (CRATE rules).** Layer 6 placement and dependency direction (`cargo xtask deps`); CRATE-8 (pure library, no op handlers, no I/O beyond the read-only store it is meant to own); the `model_inventory` move out of `pacer-dispatch-ops` keeps `dispatch.models` byte-identical and leaves no duplicate; the public API is small and fits W4-5b (learned fit, reasons, explanation) and W4-6 (registering `dispatch.preview`/`explain`) without churn; `rust-crates.md`, `context.md` and `xtask/crates.toml` updates are consistent with each other and with #849 if it has merged.
2. **Port fidelity (QA).** Compare each Rust module with its TypeScript source (`inventory.ts`, `candidates.ts`, `engines.ts` `decisionHash`, `ladder.ts`, `tier-select.ts`, `readonly.ts`, the status observation adapter): ordering, tie-breaks, defaults, number handling, error cases. `decisionHash` must match byte for byte (number spellings, negative zero, unicode, key order).
3. **Tests.** The differential test covers the risky inputs; rerun it and reproduce at least two of the seven red mutations; check the read-only store's WAL/immutable fallback the handoff marks UNVERIFIED and say whether it needs a test now. CRATE-11 (large suites in `tests.rs`). fmt, clippy `-D warnings`, crate tests for `pacer-dispatch` and `pacer-dispatch-ops`, `xtask loc`/`deps`, typecheck, the three native-dispatch suites.
4. CT-11: confirm nothing is reachable at runtime (library only), so "none" is correct.
5. Commit signed off and Conventional; no machine paths or personal emails; Cargo.lock change limited to the new crate.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5a-review.md with verdict (PASS / FAIL / UNVERIFIED) against `4c4431f2f`, findings with severity and code references, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-w4-5a.md exactly. End with orca orchestration worker_done.

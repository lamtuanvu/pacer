# Task: independent QA, protocol-compat and security review of M2 wave 4 W4-1 — runner models and tier targets native (REPO-10)

Executor: cursor-agent (default model, frontier tier: strategy and runner writes under a shared lock). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash` (shared by all worktrees); for temporary reverts work in a `git archive HEAD` copy under `/tmp` or save a patch under `.work/fixtures/` and `git apply -R` / `git apply`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-1, branch `feat/w4-runner-models`, head `8a039d95e`, two commits on `main` `a05f95414` (26 files, +2465/−57): `afcadc663` (pacer-models validation, pacer-config StrategyDoc and migration fixes) and `8a039d95e` (the five ops).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-handoff.md (behavior, six deviations, tests with red evidence, CT-11 8 PASS / 1 UNVERIFIED, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-1.md and `w4-common.md` next to it.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (§6 W4-1, decision Q10, the `runner.models.set` row in the op table).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,architecture,rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/{qa,protocol-compat,security}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Writes and locking (security).** Saves take the `executor-settings` lock, compare `expectedRevision` with the strategy sha256 inside the lock, migrate a legacy strategy through `ensure_migrated` with the same backup bytes and modes as TypeScript, write `strategy.yaml` atomically with TypeScript's modes, and publish the same `runners`/`strategy` events and activity line. One invalid runner in `set_many` writes nothing. No path writes outside the strategy file and its backup; no symlink or path trick in a runner id or strategy name changes the target. The double-read refusal in the gets is sound.
2. **Forward predicates.** Every one of the five ops forwards before the lock when the active strategy is not natively loadable (missing, YAML error, schema-invalid, unreproducible layout), and `set`/`set_many` forward whole when any named runner's listing is not `Known`. Check that Rust and Bun cannot load different strategies here (another W4-2 review found that an absolute `active` name made Rust's `load_strategy` and Bun read different files; confirm W4-1's predicate uses `native_load` or an equivalent and cover that case).
3. **Byte parity.** Replies, Zod issue texts and order, the 256-model / 64-strength bounds, hints ("closest" model), conflict text and hint, planner refusal, and `strategy.yaml` bytes match TypeScript on stdio and HTTP.
4. **pacer-config fixes (deviation 4).** The `delete_in` block fix, `emit_unpadded` and the migration trailing-blank strip change behavior of existing native ops (`runner.remove`, `runner.settings.save`, `set_in` on flow sequences). Confirm they move those ops toward TypeScript, not away, and that existing parity suites and goldens still pass. Check the `byte_index` offsets table for correctness on multi-byte UTF-8 and CRLF input.
5. **Wiring and layering.** `config_writes.rs` `area()` and `syncs_endpoints` match TypeScript's `mutation(...)` behavior for all three set ops; `src/core/accounts.ts` `finishNativeConfigEdit` allowlist matches; `tier_targets_ops` in `pacer-dispatch-ops` keeps the dependency direction (`cargo xtask deps`).
6. **Tests and evidence.** Rerun the new parity suite and the affected suites from the handoff with both front doors built from this head; reproduce at least two of the red mutations; fmt, clippy `-D warnings`, crate tests, `xtask loc` (pacer-config at 7,997, just under the WARN line), `xtask deps`, typecheck, `bun scripts/golden/strategy-doc.ts --check`. Commits signed off and Conventional; no machine paths or personal emails.
7. **CT-11.** Judge the handoff's live evidence, including the stdio run outside the guarded service and the UNVERIFIED desktop surface.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `8a039d95e`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-w4-1.md exactly. End with orca orchestration worker_done.

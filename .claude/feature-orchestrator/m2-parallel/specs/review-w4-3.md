# Task: independent security, QA and protocol-compat review of M2 wave 4 W4-3 — OpenCode discovery and `executor.models.available` native (REPO-10)

Executor: cursor-agent (default model, frontier tier: a new native subprocess with Core's env and cwd, a process-group kill and cache writes). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash` (shared by all worktrees); for temporary reverts work in a `git archive HEAD` copy under `/tmp` or save a patch under `.work/fixtures/` and `git apply -R` / `git apply`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-3, branch `feat/w4-opencode-models`, head `4a9962385` (one commit, 30 files, +1,489/−150) on W4-1 head `a50af2957` (PR #972, under review separately; do not re-review W4-1's commits).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-3-handoff.md (behavior, nine deviations, tests with red evidence, CT-11 45 PASS / 0 FAIL / 12 UNVERIFIED on the head, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-3.md and `w4-common.md` next to it.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (§6 W4-3, decision Q1 "native spawn for OpenCode").
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,architecture,rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Subprocess security (SEC rules).**
   - argv is fixed (`opencode models`), resolved by `PATH` exactly as TypeScript resolves it; no runner id, provider or param reaches argv, env or cwd.
   - The env the child gets equals the env TypeScript's `ctx.run` would give it, key for key, on both doors (`core_process.rs` `record_serve` and `record_stdio`). In particular: `PACER_HOST_SOCKET`, any host-socket key or capability variable (see PR #971, `fix/owner-bridge-caller-auth`, which adds a per-start owner key; check whether either branch could hand it to `opencode`), `PACER_INTERNAL_*`, API keys and tokens. Native must not pass anything TypeScript strips, and must not keep a secret the serve process holds but Core does not.
   - cwd and `PWD` match Core's. The recorded Core process is captured once and cannot be altered by a request.
   - Timeout and kill: 90 s, own process group, group SIGKILL, 2 s grace, kill on request drop (deviation 2). No orphan or zombie; no unbounded wait. Judge the uncapped stdout (TS parity) as a memory risk.
   - Cache write: path built only from trusted parts (no runner id or provider traversal, symlink at the temp or target path, or race that writes outside the cache dir); `create_new` 0600 temp, rename, dir 0700; failure leaves no temp file.
2. **Byte parity (protocol-compat).** Replies on stdio and HTTP match TypeScript: key order, notes, `fetchedAt` digits (deviation 4), catalog facts (`fact` rules), the verbatim echo of a fresh cache through `pacer-js-json`, `refresh: true`, failed and empty listings, `codex#team` (source none), unknown runner and invalid params. Check that the extra forwards in deviation 5 are sound and complete, and judge deviation 6 (`unavailable` after the CLI ran instead of forwarding).
3. **Write paths.** `runner.set`, `runner.models.set` and `set_many` now discover instead of forwarding on `NeedsDiscovery`. Confirm discovery runs before the `executor-settings` lock (no subprocess under the lock), that a discovery failure gives TypeScript's reply and writes nothing, and that the forwards that remain (unsupported cache or catalog, missing Core record, unloadable strategy, legacy migration) are correct.
4. **Layering and size.** `pacer-models` gaining `tokio`, `rustix` and `rand` fits its layer (`cargo xtask deps`, CRATE rules). CRATE-1 numbers in the handoff.
5. **Tests and evidence.** Rerun the four bun files (both front doors built from this head, `sbx-deny`, disposable HOME, unset `PACER_HOST_SOCKET*` and `CARGO_TARGET_DIR`) and the Rust tests; reproduce at least two red mutations, one of them on the env or cwd. Run fmt, clippy `-D warnings`, `xtask loc`/`deps` and typecheck. Check that the commit is signed off and Conventional, with no machine paths or personal emails.
6. **CT-11.** Judge the live evidence: the final-head run, the pre-rebase web run, and the UNVERIFIED surfaces (stdio through the live CLI, real OpenCode, desktop).

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest. The 90 s kill test is slow; run it once.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key, Keychain item or real OpenCode account. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-3-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `4a9962385`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-w4-3.md exactly. End with orca orchestration worker_done.

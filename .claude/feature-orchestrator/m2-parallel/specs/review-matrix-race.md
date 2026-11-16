# Task: independent QA review of the consumer-matrix usage-refresh race fix (REPO-10)

Executor: cursor-agent (default model, standard tier: a test-only timing fix). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/matrix-race, branch `test/matrix-usage-refresh-race`, head `bf9c6957c`, one commit on `main` `2c019db4f`. Only `test/plugins-native-owner-matrix.test.ts` changes (`usageRefreshSettled`).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-race-handoff.md (cause, change, validation, red evidence, two overload-only flakes left unfixed, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/matrix-race.md.
- A second CI failure: /Users/vulam/orca/workspaces/pacer/pinfish/.work/fixtures/matrix-race/ci-941-reconcile.log (PR #941, ubuntu shard 3, row "startup reconcile refreshes a deleted integration file and reports a hand-edited one", key `manifest after refresh: http forward vs http off`). In http forward the refreshed claude-code manifest entry has `notes: ["MCP server pacer was not registered"]`, `exact: true` on `.claude/rules/pacer.md`, and no `integration` fingerprint.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/code-and-testing.md`, `.project/reviewers/qa.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Correctness of the settle.** The new `usageRefreshSettled` waits for the right signals (the `budget_refreshed` line and `activity-status.json` `refreshed.{codex,plan}`), cannot return early, cannot hang (the 45 s deadline stops the door and throws with useful detail), and does not weaken any comparison (`expectIdentical`, known-difference lists and row coverage unchanged). Check the restart path (reconcile row) returns correctly, and that no row that opens a door bypasses the settle.
2. **The reconcile failure.** Decide whether the #941 reconcile failure is explained by this race (for example, the pump's first status pass overlapping the reconcile refresh's `claude mcp` registration or a stub timeout), or is a separate cause. Read the reconcile row, the planner/integration refresh path that writes `notes` / `integration` / `exact`, and the fixture's `claude` stub. If you can, reproduce it deterministically (for example, a temporary delay in a stub, reverted afterwards) on old and new code. Rule: covered by this fix, needs a further test-only fix (describe it), or a product bug (describe it; it must not be masked).
3. **Evidence.** Rerun the full matrix file at this head at least twice, and the old-vs-new 3 s `arkcli` delay reproduction once each (temporary edits only, reverted; `git status` clean at the end). Typecheck passes. Commit signed off and Conventional; no machine paths or personal emails.
4. **The two unfixed overload flakes** (`setup.health` Link-latency remedy not masked; `routing.route` rules timeout): agree or disagree they are separate, and whether either is likely on CI runners.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` (the shared sccache server is already running; never stop it or let it start inside a disposable HOME), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET -u PACER_HOST_SOCKET_KEY -u CARGO_TARGET_DIR`, with both front doors built from this head and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Run `bun install --frozen-lockfile` first. One cargo command at a time; keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-race-review.md: the verdict (PASS / FAIL / UNVERIFIED) against head `bf9c6957c`, findings with severity (blocking / nonblocking / nit) and code references, an explicit ruling on the reconcile failure, and the commands you ran with their results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-matrix-race.md exactly. End with orca orchestration worker_done.

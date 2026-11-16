# Task: independent project review of wave 3 PR 6 (REPO-10)

Executor: cursor-agent (default model, frontier tier); GLM is unavailable (OpenCode Go usage limit). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr6, branch `test/native-owner-consumer-matrix`, head `2951c0aeb`, nine commits on `origin/main` (rebased after #927 merged; the commits that landed on `main` in between touch only app, attention and read-model files).

Inputs:
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave3-pr6.md.
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md (matrix, divergences, I1, conformance subset, gate, live report).
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md ("PR 6", G1, §3) and 2026-11-12-m2-wave3-pr2-stdio-owner.md §4.3.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{code-and-testing,api-protocol,security,rust,repository,architecture}.md`, `.project/reviewers/{qa,protocol-compat,security}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **The three fixes** (`9463d6372`-equivalent `routing.status` shape and the status-parts bridge carrying `policy`, `calendarPace`, `warnings`; the plugin error-reply mapping in `crates/server`; the planner id fallback in `compose_status`): correct against the TypeScript reference (`src/engine/status.ts` `computeStatus`, `pluginReplyError` in `src/plugins/registry.ts`), byte-identical where the protocol requires it, no new data crossing a boundary it shouldn't (the status parts bridge now carries more fields: confirm none is secret or user-private beyond what `routing.status` already returns), each with a test that fails without it. Rerun at least one red-first mutation yourself.
2. **The matrix and conformance tests tell the truth.** Normalizations hide only timestamps, ids and documented `pid: null`; rows marked identical really compare the persisted stores and argv the brief lists; skipped or conditional paths are visible (count what ran with both front doors built). The `test.failing` routed tests genuinely reproduce their divergence (not failing for an unrelated reason such as a missing binary or a timeout) and will turn red when the divergence is fixed. The I1 test asserts current behavior as the brief required.
3. **Routing judgments.** For each divergence the worker routed to a security-sensitive executor, confirm the classification and the stated severity. In particular assess the `net.http` admission row: under what conditions a plugin gets network access flag-on without host-issued hosts, whether anything flag-off is affected, and whether it is reachable with the native plugin host off by default. Flag any routed row that is actually a test artifact.
4. **Docs (REPO-7):** ledger rows, CHANGELOG, live-validation docs and the PR 7 gate statement match the code and the evidence; no machine paths or personal emails; commits signed off and Conventional.
5. **Regressions:** run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`: clippy `-D warnings` and tests for `pacer-engine` and `pacer-server` (one cargo command at a time, debug); `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, the status-parts tests the handoff lists, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Report counts that ran. Other Rust workers may run at the same time; keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `2951c0aeb`, findings with severity (blocking / nonblocking / nit) and code references, your assessment of each routed row, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-wave3-pr6.md exactly. End with orca orchestration worker_done.

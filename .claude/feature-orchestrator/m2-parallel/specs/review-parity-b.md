# Task: independent review of owner parity PR B — run the door's native plugin calls through the sealed owner call (REPO-10)

Executor: cursor-agent (default model, frontier tier). Security review: the owner bridge, call-scoped capability authority, concurrency. Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-b, branch `fix/owner-sealed-door-calls`, head `c2391fabe`, three commit(s) on wave 3 PR 6 (`2951c0aeb`, reviewed PASS; a tests-and-docs fix round on PR 6 is running, and this branch will be rebased onto it).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-b-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-b.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR B" in §2 and the §1 items it closes).
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, code-and-testing, architecture, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **R1:** the door's native calls no longer install a call-scoped session in the owner's shared map; an unsealed `_host.plugin.call` can never see another call's resources, grants, host attach or Orca/worktree/executor contexts. Confirm by reading every path that installs or reads `sessions`, and rerun the R1 test against a mutation that reinstalls the shared session.
2. **Dropped bindings:** the worker removed the hosts/orca/worktree/executor binding from `call_native`. Confirm no method that reaches the door's native call path is issued those resources (search Core's issuers), so nothing loses a capability flag-on that it had before.
3. **R2/R3/R4, items 5 and 7, item 4 part 1:** one hello and one `ready` under concurrent first calls; no write to a stopping lane or closing roster; the `Failing` hint; reentrant plugins run concurrently with a per-call token where needed and the token cannot be replayed across calls or plugins; serve reports `ready` after an attached start; the observation bootstrap token is sealed and scoped. PR 5's shutdown-with-a-call-in-flight guarantees still hold.
4. **Deviations** the handoff lists (single 30 s deadline, ready after the call, bridge logs as `{level,message}`): judge each against TypeScript parity and the protocol rules.
5. `capability.log` lines reach the plugin log with their level and cannot be forged by the plugin to impersonate host lines beyond what TypeScript allows.
6. Every new or flipped test fails without its fix; tests tell the truth (no masking that hides a divergence). CT-11 evidence names this head (or one with only test-only commits after) and matches the code. Docs, ledger and CHANGELOG are accurate; no machine paths or personal emails; commits signed off and Conventional.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. One cargo command at a time, debug; other Rust workers run at the same time, keep memory modest. Note: the PR 6 conformance and matrix tests currently use fixed `/tmp/pcn` and `/tmp/pom-<row>` roots (being fixed on PR 6); do not run them at the same moment as another worker in the same root — if a run fails with a vanished home, rerun once and say so.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

Tests to run: clippy `-D warnings` and tests for `pacer-plugin-runtime` and `pacer-server`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-crash.test.ts`, `test/serve-plugin-native.test.ts`. Rerun at least two red-first mutations (R1 and R3).

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-b-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `c2391fabe`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-b.md exactly. End with orca orchestration worker_done.

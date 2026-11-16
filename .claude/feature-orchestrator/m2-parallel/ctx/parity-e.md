# Task: owner parity PR E — runners own their plugin children under the native owner

Executor: cursor-agent (default model, frontier tier). The plan assigns GLM with a cursor-agent review, but OpenCode Go is out of quota, and this moves a socket boundary. No subagents. No time limit; finish implementation, tests, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-e, branch `fix/runners-own-plugin-children`, stacked on wave 3 PR 6 (`test/native-owner-consumer-matrix` at `80b7d42f1`; PR #931, a CI-fix worker is still committing on it — the coordinator rebases you later). Sibling PRs A–D and F touch `crates/plugin-runtime`, `crates/server`, `crates/plugin-host` and `src/plugins`; stay in the files the plan lists for E. Run `bun install --frozen-lockfile` first.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md: maintainer decisions at the top (Q3: runners drop `PACER_HOST_SOCKET` and own their plugin children, extending ADR 0027's plain-CLI known limit to runners), "PR E" in §2, item 8 (I1), R4 (ADR text, Core-restart variant), R5 (ADR `crashed` clause) and S3 in §1. Recheck cited file:line against your base; follow the code and record deviations.

## Scope

As "PR E": a detached `_run` runner (and any runner process the lifecycle spawns) never inherits `PACER_HOST_SOCKET` — on serve or on a self-owned or attached stdio connection — so its Core owns its plugin children exactly as flag-off does (`src/tasks/api.ts` `runnerProcess`, `crates/lifecycle/src/run_spawn.rs` `build_run_spawn_plan`, and wherever serve inserts the socket into `ctx.env`). Check every other child the serve or stdio door spawns that inherits that env (search for the variable and for `ctx.env` clones) and state for each whether it should keep the socket (the door's own Core child must) or not. ADR 0027: the runner consequence, the `crashed` refusal clause (R5), the Core-restart failing-mark note (R4). The ledger's I1 row and gate line (only your row's words).

## Tests

Flip the matrix I1 test to assert no `PACER_HOST_SOCKET` in all three modes; a `build_run_spawn_plan` unit test; a test that a flag-on stdio self-owned dispatch's runner still completes its attempt after the connection ends, and a flag-on serve dispatch's runner after a service restart (or the closest test-level equivalent). Every new test fails without the fix; save red logs.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. Both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. Build only the crates you touch, one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`; never release or `--workspace` builds; other Rust workers run at the same time, keep memory modest. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-lifecycle` and any crate you touch; `cargo xtask loc --check`, `cargo xtask deps`, `cargo xtask gen --check`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, the task/run tests touching `runnerProcess` (find them), `test/native-plugin-ops-stdio.test.ts`, `test/live-harness.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-e/`.

## Live validation (CT-11)

Per the plan's PR E: on a `bun run live up --front-door rust --native-plugin-host` sandbox, a flag-on stdio self-owned dispatch of a direct-executor task, disconnect, and the attempt completes; a flag-on serve dispatch survives a `bun run live` service restart; the same flows flag-off; confirm from the runner's environment (`ps eww` or a fixture) that no `PACER_HOST_SOCKET` is present. `bun run live report`. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes, sockets or sidecars remain. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`; load no launchd job.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>), small logical commits. Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files. Docs also need the repository-rule review, which the coordinator arranges.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-e-handoff.md`: commits, per-file changes, the per-child socket inheritance table, deviations, test results with counts and red evidence, live report summary with UNVERIFIED items, follow-ups, and a draft PR body following `.github/pull_request_template.md` (include the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.

# Task: owner parity PR C — append native owner plugin stderr to the plugin log

Executor: cursor-agent (default model, medium tier). The plan assigns GLM, but OpenCode Go is out of quota. No authority or secret surface; bounds are fixed by tests. No subagents. No time limit; finish implementation, tests, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-c, branch `fix/owner-plugin-stderr-log`, stacked on wave 3 PR 6 (`test/native-owner-consumer-matrix` at `2951c0aeb`, under review). The coordinator rebases you onto `main` after PR 6 merges. Parallel PRs run at the same time: B (`crates/server/src/native/plugins.rs`, `bridge_call.rs`, `owner.rs` stopping checks, `registry.ts`), A (`capability.rs`, `native-call-authority.ts`, `registry.ts`) and D (`crates/plugin-host` framing). Your only shared file is `crates/plugin-runtime/src/owner.rs`: limit it to the log-directory field and its pass-through. Run `bun install --frozen-lockfile` first. Build only the crates you touch (one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); never release or `--workspace` builds; keep memory modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/qa.md`, ADR 0027, `docs/testing/live-validation.md`, and the plan /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR C" in §2, item 9 in §1). The TypeScript reference is the TS host's plugin log writer (find it from `logs/plugins` in `src/plugins/`): match its line format, `[stderr]` tag, timestamps, 1 MiB rotation and file mode exactly. Recheck cited file:line against your base.

## Scope

Pipe the owner's plugin child stderr (today `Stdio::null()` in `crates/plugin-runtime/src/process.rs`) to a reader that appends lines to `$PACER_HOME/logs/plugins/<id>.log` through a new `crates/plugin-runtime/src/plugin_log.rs`, with TypeScript's format and rotation. The reader must never block the child (bounded line length, drop or truncate as TypeScript does), must stop with the child, and must not leak file descriptors. Construct it from `serve_host.rs` and the stdio door with the home's log directory.

## Tests

The conformance `logs` case (`STDERR_DROPPED` in `test/plugin-conformance-native-owner.test.ts`) flips to passing on both owner doors. Rust tests: line format, partial last line, oversize line, rotation at the TypeScript limit, file mode, reader stops at child exit. A differential test comparing the log lines of a stderr-writing fixture flag-on and flag-off (timestamps masked). Every new test fails without the fix; save red logs.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. Both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR`, `PACER_TEST_NATIVE_FRONT_DOOR` as `--features test-ops`); report counts that ran. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime` and `pacer-server` if touched; `cargo xtask loc --check` (state CRATE-1 for `pacer-plugin-runtime`; the plan expects about +180 and warns it nears 5,000), `cargo xtask deps`; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/native-plugin-crash.test.ts`, `test/plugin-conformance.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-c/` in this worktree.

## Live validation (CT-11)

A fixture plugin that writes stderr on a `bun run live up --front-door rust --native-plugin-host` sandbox and a flag-off sandbox: compare `$PACER_HOME/logs/plugins/<id>.log` lines (timestamps masked); `bun run live report`. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes remain. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files. CHANGELOG Unreleased entry if user-visible.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-c-handoff.md`: commits, per-file changes, test results with counts and red evidence, LOC and CRATE-1 text, live report summary with UNVERIFIED items, follow-ups, and a draft PR body following `.github/pull_request_template.md` (include the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.

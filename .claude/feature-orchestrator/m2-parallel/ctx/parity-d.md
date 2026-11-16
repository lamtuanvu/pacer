# Task: owner parity PR D — frame plugin messages in JSON.stringify key order

Executor: cursor-agent (default model, medium tier). The plan assigns GLM, but OpenCode Go is out of quota. Mechanical wire-format parity; no authority change. No subagents. No time limit; finish implementation, tests, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-d, branch `fix/plugin-frame-key-order`, stacked on wave 3 PR 6 (`test/native-owner-consumer-matrix` at `2951c0aeb`, under review). The coordinator rebases you onto `main` after PR 6 merges. Parallel PRs A, B and C touch `crates/plugin-runtime`, `crates/server` and `src/plugins`; stay in `crates/plugin-host` and the matrix test. Run `bun install --frozen-lockfile` first. Build only the crates you touch (one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); never release or `--workspace` builds; keep memory modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,api-protocol,code-and-testing,repository}.md`, `.project/reviewers/{qa,protocol-compat}.md`, and the plan /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR D" in §2, item 3 in §1). Recheck cited file:line against your base.

## Scope

The owner bridge frames plugin messages as canonical (sorted-key) JSON (`crates/plugin-host/src/process.rs` `frame`, `observations.rs:230`), so a plugin's file write of `install-manifest.json` during planner reconnect and refresh comes out with sorted keys flag-on. Frame in the key order the TypeScript host produces with `JSON.stringify` (insertion order of the value as received/constructed), byte-identical for the same input, including nested objects, unicode escaping and number formatting. Confirm that nothing relies on sorted framing for a signature, hash or comparison (search for consumers of the framed bytes); if something does, stop and report instead of changing it. If `serde_json` is built without `preserve_order` in a crate on this path, state how you preserve order and the dependency or feature change (and `cargo xtask deps` result).

## Tests

Drop `PRIOR_ECHO_MANIFESTS` and flip the matrix's routed planner reconnect and refresh tests (HTTP and stdio) in `test/plugins-native-owner-matrix.test.ts` to plain passing tests. Rust tests in `crates/plugin-host/src/process/tests.rs` for nested key order, unicode and numbers against fixed TypeScript `JSON.stringify` outputs. Every new test fails without the fix; save red logs.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. Both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR`, `PACER_TEST_NATIVE_FRONT_DOOR` as `--features test-ops`); report counts that ran. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-host` and its dependents you rebuild (`pacer-plugin-capabilities`, `pacer-plugin-runtime`); `cargo xtask loc --check`, `cargo xtask deps`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugin-conformance.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-d/` in this worktree.

## Live validation (CT-11)

Planner reconnect and refresh on a `bun run live up --front-door rust --native-plugin-host` sandbox and a flag-off sandbox; diff `install-manifest.json` bytes; `bun run live report`. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes remain. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-d-handoff.md`: commits, per-file changes, test results with counts and red evidence, live report summary with UNVERIFIED items, follow-ups, and a draft PR body following `.github/pull_request_template.md` (include the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.

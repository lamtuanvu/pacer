# Task: fix wave 3 PR 6 CI failures (#931)

Executor: cursor-agent (default model, medium tier); GLM is out of quota. No subagents. Finish fixes, checks and the handoff note before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr6, branch `test/native-owner-consumer-matrix`, head `d207bbb5b`, open as PR #931 (reviewed PASS; auto-merge is on). Run `bun install --frozen-lockfile` first. Three sibling branches are stacked on this head; keep edits minimal and local.

CI run https://github.com/lamtuanvu/pacer/actions/runs/43354267342 (use `gh run view` and `gh api repos/{owner}/{repo}/actions/jobs/<id>/logs`) failed on:

1. **Rust (ubuntu-latest): `cargo xtask gen --check`** reports `crates/task-protocol/src/generated.rs` stale. Find which change in this PR feeds the generator (likely the `routing.status` / status-parts shape in `src/engine/status.ts` or a schema), run `cargo xtask gen`, and confirm the generated diff is exactly the PR's shape change. Check whether any other generated output (`docs/protocol.schema.json`, `docs/protocol.md`, op catalog) is also stale with `cargo xtask gen --check`.
2. **Test shard 0 (ubuntu): `test/p6e-parity.test.ts` "P6e goldens remain fresh against their current TS sources"** — the TypeScript reference output changed (likely from the `src/engine/status.ts` change). Regenerate the goldens with the project's documented regeneration command (find it in `test/fixtures/p6e/` or the docs), then confirm "P6e Rust decisions match current TypeScript goldens" still passes; if the Rust decisions now differ from the new goldens, that is a real parity gap — fix it in `crates/engine` (or wherever the decisions example's logic lives) with a test, and say so.
3. **Test shard 2 (ubuntu): `test/plugins-native-owner-matrix.test.ts`**:
   - "notifier: serve delivers attention through pacer-notify's sealed osascript command" timed out (72 s) on Linux. The notifier path is macOS-only (osascript): make the row run where the notifier actually delivers (skip with a stated reason on non-macOS, or use the portable path the TypeScript notifier uses on Linux), consistent with how other notifier tests in `test/` handle platforms.
   - "stdio rows: usage consumers self-owned and attached" failed with `limits.refresh all: stdio on owned vs stdio off`. Get the diff from the log. If it is the re-review's N9 race (`usageRefreshSettled` racing the `budget_refreshed` activity line; see /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-rereview.md), fix the wait so it is deterministic (wait on the persisted outcome, not timing). If it is a real divergence, report it rather than masking it.
4. Also check the latest run on this head (`gh pr checks 931`) for any other failure and fix or explain it.

## Checks

Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`; both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` with `--features test-ops`). `cargo xtask gen --check`; `cargo fmt --all --check`; clippy `-D warnings` for touched crates; `bun run typecheck`; `test/p6e-parity.test.ts`; `test/plugins-native-owner-matrix.test.ts` three times in a row (report each); `test/plugin-conformance-native-owner.test.ts`; `git diff --check`. Linux behavior can't be run locally: reason about it from the code and the CI log, and say what you could not verify.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Commits and output

Conventional Commits (`fix:`/`test:`/`chore:`), signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Never commit `.work/`.

Append a "CI fix" section to /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md (cause and fix per failure, commits, counts, anything unverified). Report with `orca orchestration worker_done`. Always end with worker_done; do not end your turn before that.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr6-ci.md exactly. End with orca orchestration worker_done.

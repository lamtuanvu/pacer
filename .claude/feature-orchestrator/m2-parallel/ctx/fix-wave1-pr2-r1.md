# Task: wave 1 PR 2 fix round 1, JavaScript-semantics registry read review findings

Executor: cursor-agent (default model). Small Rust change in `pacer-repos`, one test addition, docs. F3 closes a data-loss race on a write path, so it is security-adjacent. Memory and disk are tight: build only `pacer-repos` (and `pacer --features test-ops` once for the Bun differential), one cargo command at a time, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`; no release or `--workspace` builds.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr2, branch `fix/native-repo-registry-js-reads`, head `e0fe86177`, stacked on PR 1 (#910, `9b7e56e7e`). Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave1-pr2-review.md (PASS, F1–F6). Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave1-pr2-handoff.md. Not pushed.

## Fixes (coordinator decisions)

- **F1 (documentation, no behavior change):** `files.search` keeps reading the registry natively. Correct the new CHANGELOG `[Unreleased]` bullet so it no longer implies `files.search` forwards the residual shapes: say `files.search` reads such registries natively and searches fewer or none of their repositories. Record that residual in ledger row 38 (`files.search`): TypeError entries and relative paths skipped, lone surrogates or nesting past the depth limit list nothing, NaN-inconsistent orders left unsorted (which can change which repositories survive the repo limit), a FIFO lists nothing where TypeScript hangs.
- **F2:** add a non-canonical numeric key (`"07"`, and `"-0"` or `"1e1"`) to the Rust index-key test in `crates/repos/tests/registry.rs` and to the "integer index keys enumerate first" corpus row in `test/native-repo-front-door.ts`. Show the Rust test fails when the canonical-form check in `index_key` (`read.rs`, `n.to_string() == key`) is removed; save the red log under `.work/fixtures/wave1-pr2-r1/` in this worktree.
- **F3:** in `register_repo` (`crates/repos/src/identity.rs`), when the locked re-read reports `needs_core`, return a `conflict` (text: `repository registry changed during registration`, mirroring `repo.remove`'s `repository registry changed during removal`) instead of writing. Add a Rust test that makes the locked re-read see a forwarded shape (follow how PR 1 tests the `repo.remove` race) and asserts the files are unchanged; show it fails without the fix (red log in the same fixtures folder). Add the new conflict text to the `repo.add` residual list in ledger row 19.
- F4 (live provenance): rerun the `w1pr2-rs` live session once on the fixed head (`--front-door rust --native-test-ops --seed ui`, the same steps as the handoff), record the summary, `live down --keep`, and confirm no sandbox, browser or tmux processes remain.
- F5 and F6 are advisory; leave them.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH` (it has the `ps` shim) and `env -u PACER_TEST_NATIVE_FRONT_DOOR` for Bun tests: `cargo fmt --all --check`, `cargo clippy -p pacer-repos --all-targets -- -D warnings`, `cargo test -p pacer-repos`, `cargo xtask loc --check`, `git diff --check`, then `bun test test/native-repo-registry-parity.test.ts test/native-repo-add-parity.test.ts`.

Commit: `fix(repos): ...` / `test(repos): ...` / `docs: ...` Conventional Commit(s), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

## Handoff

Append a "Fix round 1" section to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave1-pr2-handoff.md`: commits, per-finding status, tests and red evidence, checks, live summary. Report with `orca orchestration worker_done`. Always end with worker_done.

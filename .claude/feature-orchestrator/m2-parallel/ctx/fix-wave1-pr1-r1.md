# Task: wave 1 PR 1 fix round 1 — native repo.remove review findings

Executor: cursor-agent (default model). Small Rust changes in `pacer-repos` plus docs; F3 closes a data-loss path, so it is security-adjacent. Memory and disk are very tight: build only `pacer-repos` (and `pacer` once if you rerun the Bun differential), one cargo command at a time, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`; no release or `--workspace` builds.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr1, branch `fix/native-repo-remove-ts-registries`, head `78e3e549c`, stacked on PR 0 (`943d26417`). Review: `.work/reviews/wave1-pr1-review.md` (PASS, F1–F10). Handoff: `.work/reviews/wave1-pr1-handoff.md`. Not pushed.

## Fixes (coordinator decisions)

- **F3:** after `fstat` confirms a regular file, clear `O_NONBLOCK` (`fcntl(F_SETFL)`) before reading, so a filesystem that honors it can't return `EAGAIN` and make Rust overwrite a registry TypeScript would keep. Test what can be tested (at least that the flag is cleared on a regular file).
- **F4:** add a deterministic Rust lock test: hold `pacer_home/orca/repos.lock` (as `with_lock` would see it held), run `remove_repo` on a thread, assert both files are unchanged while held, release, assert the write. Show it fails when `with_lock` is removed from `remove_repo` (save the red log under `.work/fixtures/wave1-pr1-r1/`).
- **F5:** make the ledger row 20 depth wording literal: "nesting deeper than 129 levels (node depth > 128)" (keep `DEPTH` as is); fix the handoff's "129 forwarded" claim.
- **F6:** CHANGELOG bullet: "Like TypeScript, it reads through symlinked state files, replaces a symlinked registry file with a regular file and overwrites an unreadable registry instead of refusing; its parameter errors now match the core."
- **F9:** list the residual divergences (race `conflict` text, write-error text, Q9 HTTP undecodable bodies — owner: wave 1 PR 2 after #901) in ledger row 20 if the row format allows, otherwise in the handoff's PR text.
- F1, F2, F10 are PR-description items the coordinator handles. F7, F8 are pre-existing; leave them.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`: `cargo fmt --check`, `cargo clippy -p pacer-repos --all-targets -- -D warnings`, `cargo test -p pacer-repos`, `cargo xtask loc --check`, `git diff --check`. Rebuild `cargo build -p pacer` once and rerun `PACER_TEST_NATIVE_FRONT_DOOR=target/debug/pacer bun test test/native-repo-remove-parity.test.ts` (after `bun install --frozen-lockfile` if needed). CT-11: F3 changes the read path; rerun the live session the handoff describes (`.work/fixtures/live-remove.ts` on a `--front-door rust --native-test-ops` sandbox) once and record the summary, then `live down --keep` and confirm no processes remain.

Commit: `fix(repos): ...` Conventional Commit(s), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

## Handoff

Append a "Fix round 1" section to `.work/reviews/wave1-pr1-handoff.md`: commits, per-finding status, tests and red evidence, checks, live summary. Report with `orca orchestration worker_done`. Always end with worker_done.

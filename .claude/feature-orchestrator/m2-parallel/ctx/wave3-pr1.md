# Task: M2 wave 3 PR 1, extract the native capability brokers into `pacer-plugin-capabilities`

Executor: cursor-agent (default model, frontier tier). The moved code is the plugin capability brokers (authority checks, native writes, process and host access), so the move must be byte-for-byte: no behavior, visibility-widening or wire change. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr1, branch `refactor/plugin-capabilities-crate`, based on `origin/main` `053a407ad`. Not pushed.

Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md. Read the header (maintainer decisions OD-1..OD-7; OD-6 = ADR 0026 plus the crate table, no constitution amendment), section 4 "Crate split (CRATE-1)" and section 5 "PR 1". The plan was measured at `acab1eca4`. Since then #907 (the #629 ports, the plan's PR 3) merged and changed `native_hosts.rs`, `native_orca.rs`, `native_write.rs` and `broker.rs`, so re-measure everything at this base and move the current files.

Before working, read `.agents/skills/project-governance/SKILL.md`, `.project/constitution.md`, `.project/context.md`, `.project/rules/rust-crates.md` (CRATE-1..11, especially CRATE-1 budgets, CRATE-4 layering, CRATE-8 checklist, CRATE-9 build timings), `.project/rules/rust.md`, `.project/rules/architecture.md`, `docs/decisions/0020-*.md` (the seam this PR takes).

## Scope

1. New crate `crates/plugin-capabilities` (`pacer-plugin-capabilities`, layer 5). Move, keeping file names and contents: `broker.rs` (+ `broker/tests.rs`), `native_{read,write,process,http,bundle,duplex,hosts,worktree,run,remote,orca}.rs` with their submodules and test files (`native_run/{directory.rs,state.rs,state/tests.rs,wrapper.sh}`, `native_process/tests.rs`, `native_read/tests.rs`), and `transfers.rs`. Move the integration tests in `crates/plugin-host/tests/` that exercise only moved modules to `crates/plugin-capabilities/tests/`, keeping test names. Use `git mv` so rename detection keeps the diff small. If a module the plan lists can't move without dragging a non-capability module along (or creating a cycle), stop and report it rather than redesigning.
2. `pacer-plugin-host` keeps `authority.rs`, `credentials.rs`, `host_lease.rs`, `manifest.rs` and the rest. The new crate depends on it (5→4). Only the visibility needed for the cross-crate use changes (`pub(crate)` → `pub` on items the moved code uses); list every such change in the handoff. Do not re-export the moved modules from `pacer-plugin-host` unless a consumer outside `pacer-plugin-runtime` needs them (search the workspace).
3. `pacer-plugin-runtime` moves to layer 6, depends on `pacer-plugin-capabilities`, and updates its imports (`capability.rs`, `orca_attach.rs`, `lib.rs` re-exports, tests). Any other consumer found by search (for example `pacer-server`, `pacer-plugin-ops`, the binary) updates its imports.
4. `xtask/crates.toml`: add `pacer-plugin-capabilities` (layer 5), set `pacer-plugin-runtime` to layer 6, and fix any crate whose layer must now be above 6. Workspace `Cargo.toml` members.
5. `.project/rules/rust-crates.md`: add the crate's row (domain: the native capability brokers for plugin calls) to the planned-crates table; update the `pacer-plugin-host` and `pacer-plugin-runtime` rows (layers, budgets).
6. New `docs/decisions/0026-native-plugin-capability-crate.md` (ADR format like 0020 and 0025): context (CRATE-1, `pacer-plugin-host` size before and after, ADR 0020's named seam), decision (seam, layers, budgets), consequences, the future exec/SSH/Git split for #889 kept out of this crate, and why it differs from the #629 split naming (`plugin-capabilities`/`plugin-execution`/`plugin-wire`: that branch was a 32k-line shadow rewrite; this moves main's modules as-is).
7. `docs/testing/m2-ledger.md`: update only text that names moved crate paths (search for `pacer-plugin-host` and `crates/plugin-host/src/native_`, `broker.rs`). Also search `docs/` and `.project/` for those paths and fix references that would now be wrong.
8. CHANGELOG: none (no user-visible change) unless the repository convention requires a line for internal refactors; check recent refactor PRs (for example #902) and follow them.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`. One cargo command at a time. Disk is tight (about 20 GB free): debug only, no release builds.

- `cargo fmt --all --check`
- `cargo check --workspace --all-targets --locked`
- `cargo clippy -p pacer-plugin-host -p pacer-plugin-capabilities -p pacer-plugin-runtime -p pacer-plugin-ops -p pacer-server --all-targets -- -D warnings`
- `cargo test --locked -p pacer-plugin-host -p pacer-plugin-capabilities -p pacer-plugin-runtime -p pacer-plugin-ops`, and `-p pacer-server` lib tests. Record test counts before (at the base) and after: the total for the moved tests must be equal, with the same names.
- `cargo xtask loc --check`, `cargo xtask deps`, `cargo xtask gen --check`
- `git diff --check`; `git diff -M --stat origin/main` showing the moves as renames.
- CRATE-9 build timings for the new crate: a clean `cargo build -p pacer-plugin-capabilities` (after `cargo clean -p pacer-plugin-capabilities -p pacer-plugin-host`) and an incremental rebuild after touching one moved file; record both, and the same for `pacer-plugin-host` at the base for comparison.
- REPO-7 evidence for a pure move: for every moved file, `git diff -M origin/main -- <old> <new>` shows only import-path and visibility lines changed. Put the per-file summary in the handoff.

CT-11: exempt (no runtime behavior change; moved code keeps its runtime callers). Say so in the handoff with the reason.

Commit: `refactor(plugin-host): extract the native capability brokers into pacer-plugin-capabilities`, plus a separate `docs:` commit for the ADR and rule table if that reads better. `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. No live sessions.

## Handoff

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr1-handoff.md`: commits; moved files and every non-move line change (by file); visibility changes; layer and dependency changes; LOC before and after per crate (CRATE-1); CRATE-9 timings; test counts before and after; checks; CT-11 exemption; open questions; and draft PR text (Summary, How tested, CRATE-1, CRATE-9, Executor). Report with `orca orchestration worker_done`. Always end with worker_done.

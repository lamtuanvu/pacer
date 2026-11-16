# Task: M2 wave 1 PR 1 — remove repositories natively from TypeScript-written registries

Executor: cursor-agent (default model). Rust parity work with differential tests, lock races and live validation; not a small task. No time limit; finish implementation, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr1, branch `fix/native-repo-remove-ts-registries`, stacked on PR 0 (`refactor/js-json-consolidate` at `943d26417`, which is under review; if PR 0 changes, the coordinator will tell you to rebase). No build yet; disk is shared, build debug only.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,security,api-protocol,code-and-testing,repository}.md`, `.project/reviewers/{security,protocol-compat,qa}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md`: maintainer decisions at the top, section 0, section 1b, "PR 1", the ledger table and the risks. Recheck each cited file:line; the plan was read, not run. PR 0's handoff (`/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr0/.work/reviews/wave1-pr0-handoff.md`) says what `pacer-js-json` now offers.

## Scope

1. Move `remove_repo` from `crates/config/src/repos.rs` into `pacer-repos` (for example `crates/repos/src/remove.rs`) so writes use the `pacer-js-json` stringify. Replace `requires_core_repo_parser` with a narrow predicate that forwards only: lone surrogates, a directory or non-regular file (including a FIFO; make sure Rust never blocks on one) at either registry path.
2. Port every "port" row of plan section 1b: fractional or large `lastUsed`, extra entry fields, integer-index keys, non-object top levels of `repos.json` (spread semantics) and `repo-paths.json` (written back without spreading, array holes as `null`), invalid JSON or invalid UTF-8 treated as TypeScript does, non-string alias values. Prove the string top-level case by test before porting it.
3. Fix the native param divergences in `crates/config-ops/src/repo_ops.rs`: strip unknown keys, `params: null` reads as `{}`, Zod 4 issue text for a missing or invalid `key`.
4. Maintainer decision Q3: match TypeScript. Follow symlinked state directories and files as `writeJsonAtomic` does, and treat an unreadable registry as `{}` and overwrite it, as TypeScript does. Remove the native refusals. This is a security-relevant change: in the handoff, describe exactly what Rust now writes through a symlink, and confirm the write stays under the same lock and atomic-rename discipline TypeScript uses.

Keep `pacer-config` under 8,000 LOC if the move allows it; record `cargo xtask loc` before and after for every touched crate (CRATE-1).

Size: about 700 changed lines. Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (the repository-local git config has it; if you use a disposable HOME, check `git config user.email` before committing). Do not push.

## Tests

Differential through both front doors (stdio and HTTP) against `PACER_FORWARD_OPS=repo.remove` on twin homes, comparing replies, `repos.json` and `repo-paths.json` bytes, and the repository change event, with `PACER_DEBUG_NATIVE=1` markers proving which side ran (`test/repo-native-parity.test.ts` or a new file): each row of section 1b, the param cases, the symlink and unreadable cases now matching TypeScript, and forwarding tests for the rows that stay forwarded. Move `crates/config/tests/repo_remove.rs` to `crates/repos/tests/`. Lock race: native `repo.remove` concurrent with forwarded `repo.add` on one home under the shared `repos` lock; the final bytes must equal one serial order. TypeScript caches registries by file stamp; bump mtimes explicitly in tests. Update ledger row 20 and the config-library boundary row the plan names.

## Checks

Serial in sbx-deny with disposable HOME and PACER_HOME (real CARGO_HOME and RUSTUP_HOME), TZ=Asia/Ho_Chi_Minh: `cargo fmt --check`, `cargo clippy -p <touched crates> --all-targets -- -D warnings`, `cargo test -p <touched crates>`, `cargo xtask loc --check`, `bun run typecheck`, the Bun tests added or touched, `git diff --check origin/main..HEAD`. Add a CHANGELOG `[Unreleased]` entry for the user-visible change (repository removal now runs natively on the Rust front door for normal registries).

## Live validation (CT-11)

Per docs/testing/live-validation.md, session ids `live-wave1-pr1-`: `bun run live up --front-door rust --native-test-ops`; remove the disposable repo from a TypeScript-written registry over the CLI, HTTP and stdio, show the native marker, and compare the resulting file bytes with the TypeScript front door (`live up` without `--front-door`). The web has no repository removal control that the plan found; check `app/src`, and if none exists, record web as not applicable. One live session at a time in this worktree; leave other workers' sessions alone. Stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343.

## Handoff

Write `.work/reviews/wave1-pr1-handoff.md` in the worktree: commits, per-row outcome (native or still forwarded and why), the symlink and unreadable behavior now and its security reasoning, LOC before and after, check commands with pass counts, live session id, report path and Summary line, UNVERIFIED surfaces, cleanup. Report with `orca orchestration worker_done`. Always end with worker_done.

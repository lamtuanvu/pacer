# Task: M2 wave 1 PR 5 — validate runner models natively for declared and cached models

Executor: cursor-agent (default model). A new Rust crate with exact TypeScript parity, differential tests and live validation; not a small task. No time limit; finish implementation, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr5, branch `feat/native-runner-models`, stacked on PR 0 (`refactor/js-json-consolidate` at `943d26417`, under review; the coordinator will tell you if you must rebase). No build yet. A shared sccache server is running; don't stop it. Build debug only.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,architecture,api-protocol,code-and-testing,repository}.md`, `.project/reviewers/{architecture,protocol-compat,qa}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md`: maintainer decisions at the top (Q6: a new `pacer-models` crate), section 0, section 1e, "PR 5", the ledger table and the risks. Recheck every cited file:line.

## Scope

1. New crate `pacer-models` (choose its layer per `.project/rules/rust-crates.md` and `xtask/crates.toml`; register it in `xtask/crates.toml`, the workspace `Cargo.toml`, and the crate index in `.project/context.md` if the repo keeps one there; provide CRATE-9 build timings for the new crate). Wave 4 will extend it with model discovery, so name and structure it for that.
2. Port `src/models/available.ts` branches that need no subprocess: source `none` (missing runner or account, native agent accounts), connection accounts (strategy-declared models prefixed `pacer-<account>/`, the empty-models note, `<model> is not offered by <provider/account>` with `Available: …` from `closestModels` using UTF-16 Levenshtein, top 3), and an opencode account with a fresh, well-shaped cache file (`cache/available-models/<sha256(runnerId)>.json`, TTL 600 s; the exact shape checks in the plan). Use `pacer-js-json` for the cache JSON.
3. `runner.set` (`crates/config-ops/src/runner_ops.rs`): narrow `runner_set_stays_forwarded` so only an opencode cache miss, a stale cache or an odd cache shape (where TypeScript would throw) forwards. Keep the refusal order (unknown runner, planner runner, invalid rank before the model check) and the warning order (`<model> could not be checked: <note>` after the `enabled=false` routing warnings).
4. A stale or missing cache must forward and must never spawn `opencode` natively.

Size: about 800 changed lines. Record `cargo xtask loc` before and after for touched crates (CRATE-1). Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`). Do not push.

## Tests

Differential through stdio and HTTP against `PACER_FORWARD_OPS=runner.set` on twin homes, comparing replies (errors, hints, warnings) and `strategy.yaml` bytes after accepted models, with `PACER_DEBUG_NATIVE=1` markers: connection accounts with offered, not offered and empty models; native agent runners; seeded fresh, stale and odd caches (stale and odd forward); non-ASCII model ids for the UTF-16 Levenshtein ranking. Update `crates/config-ops/src/runner_ops/tests.rs` and extend `scripts/live/native-config.ts` runner.set cases. Update ledger row 28 and add a CHANGELOG `[Unreleased]` entry.

## Checks

Serial in sbx-deny with disposable HOME and PACER_HOME (real CARGO_HOME and RUSTUP_HOME; keep `SCCACHE_DIR=$REAL_HOME/Library/Caches/Mozilla.sccache` if you set HOME), TZ=Asia/Ho_Chi_Minh: `cargo fmt --check`, `cargo clippy -p <touched crates> --all-targets -- -D warnings`, `cargo test -p <touched crates>`, `cargo xtask loc --check` and the deps check, `bun run typecheck`, the Bun tests added or touched, `git diff --check origin/main..HEAD`.

## Live validation (CT-11)

Per docs/testing/live-validation.md, session ids `live-wave1-pr5-`: `bun run live up --front-door rust --native-test-ops`; set a model on a connection-account runner (accepted and refused) and on an opencode runner with a seeded fresh cache, over the CLI and HTTP, with native markers, and compare with the TypeScript front door. Web Executor models and OpenCode setup screens (`settings/ExecutorModels.tsx`, `OpencodeSetup.tsx`): exercise them with the harness browser control (`--surface web`). Live stdio is refused by D3; report it UNVERIFIED. A cache-miss case: verify only that it forwards (trace). One live session at a time in this worktree; leave others alone; stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never run the real `opencode` against the maintainer's config from tests.

## Handoff

Write `.work/reviews/wave1-pr5-handoff.md` in the worktree: commits, the crate's layer and contents, per-branch outcome (native or forwarded and why), LOC and CRATE-9 timings, check commands with pass counts, live session ids, report paths and Summary lines including web, UNVERIFIED items, cleanup. Report with `orca orchestration worker_done`. Always end with worker_done.

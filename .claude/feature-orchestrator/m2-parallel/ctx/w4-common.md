# Common instructions for M2 wave 4 implementation workers

The plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (maintainer accepted Q1–Q13 as recommended on 2026-11-14). Read its summary, §0–§5, your PR's section in §6, §7 (ledger rows), §8 (conflicts) and §9 (risks). The plan was written read-only at `a62b42d60`; nothing in it was built or run, so every file:line, size and LOC number is UNVERIFIED. Recheck each against your base. If the code contradicts the plan, follow the code and record the deviation in your handoff; stop and ask through `orca orchestration` only if a deviation changes a maintainer decision, the security model or the PR's scope.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,api-protocol,rust,rust-crates,code-and-testing,security,repository}.md`, `.project/reviewers/{qa,protocol-compat}.md` (and `security.md` if your PR spawns processes, writes files or changes an internal route), `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the wave 1 and wave 2 plans under `.work/plans/2026-11-11-m2-wave*.md` for the native-op patterns (selective forwarding, forward predicates in `serve/mod.rs` and `stdio_proxy.rs`, differential parity tests).

Parallel work: other wave 4 workers (W4-1 runner models and tier targets, W4-2 routing residue, W4-4 status parts drafts) and wave 3 PRs (A #945, F, I, G, H, R1) run at the same time. Expect conflicts only in `crates/server/src/native.rs` OPS, the forward predicates and `docs/testing/m2-ledger.md`; keep your edits to those regions small and local, and do not reformat them.

## Build and environment

Run `bun install --frozen-lockfile` first. Build only the crates you touch, one cargo command at a time, debug, `CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4`; never release or `--workspace` builds. Other Rust workers run at the same time; keep memory modest. sccache: the shared server is already running; keep `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, never stop it and never let it start inside a disposable HOME (if a build fails with "Failed to create temp dir", run the build with `RUSTC_WRAPPER=` unset and tell the coordinator). If `cargo xtask ...` fails with "No such file or directory (os error 2)", sccache served an xtask binary built in another checkout (its `CARGO_MANIFEST_DIR` is baked in): `touch xtask/src/main.rs` and rerun with `RUSTC_WRAPPER=`.

Tests run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET -u PACER_HOST_SOCKET_KEY -u CARGO_TARGET_DIR`, with both front doors built from your head and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`).

Required checks: `cargo fmt --all --check`; clippy `-D warnings` and tests for every crate you touch; `cargo xtask loc --check`; `cargo xtask deps`; `bun run typecheck`; the parity and unit tests your PR section names, plus any existing native parity test for the ops you touch. Every new test needs red evidence (it fails before your change, or on `main`).

## Live validation (CT-11)

Follow `docs/testing/live-validation.md` and your PR section's CT-11 list: `bun run live up --front-door rust` (owner flag off), exercise each named surface (web screens through the sandbox app, CLI on HTTP and stdio, MCP where named), `bun run live report`, `bun run live down --keep`. Include the report summary and name the head it ran on. Surfaces you cannot exercise are UNVERIFIED with the reason. Fake executors, fake `ssh`/`opencode` and fixture accounts only.

## Safety

Never touch the maintainer's real pacer install: `/Applications/pacer.app`, `~/.local/bin/pacer*`, `~/.pacer`, the `com.pacer.serve` service. Never use ports 4317, 11434, 1234, 41343. Never use a real API key, Keychain item, real executor account or real SSH host. Stop every process you start (serve, live sandbox, loops) and confirm none remain before you report.

Never use `git stash`: all worktrees share one stash list, so another worker's `pop` takes your stash. For a red build or temporary revert, save a patch under `.work/fixtures/<task>-<what>.patch` and use `git apply` / `git apply -R`. Before committing, check `git diff --stat` for files outside your task.

## Output

Commit with `git commit -s` (Conventional Commits, author Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Write your handoff at the path in your brief: commits, deviations from the plan, tests with red evidence, the CT-11 summary, ledger changes, follow-ups, and a draft PR body with the title from the plan. Report with `orca orchestration worker_done`. Always end with worker_done.

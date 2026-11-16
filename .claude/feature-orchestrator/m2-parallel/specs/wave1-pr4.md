# Task: M2 wave 1 PR 4 — set planner and task backend natively when no integration or Orca check is needed

Executor: cursor-agent (default model). Rust parity work plus a live-harness policy change, differential tests and live validation; not a small task. No time limit; finish implementation, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr4, branch `fix/native-config-set-planner-backend`, base origin/main `acab1eca4`. No build yet. A shared sccache server is running; don't stop it. Build debug only. Disk is tight (about 19 GB free): don't build release, don't create extra target dirs.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,architecture,api-protocol,code-and-testing,repository,security}.md` (whichever exist), `.project/reviewers/{protocol-compat,qa,security}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md` (D3, D8), and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md`: maintainer decisions at the top (Q2, Q7, Q8, Q10), section 0, section 1d, "PR 4", the ledger table and the risks. Recheck every cited file:line; the plan is read-only analysis and may be off.

## Scope

1. Replace `config_set_stays_forwarded` (see `crates/server/src/native.rs` and both front doors, `crates/server/src/serve/mod.rs` and `crates/server/src/stdio_proxy.rs`) with an input-aware predicate. Forward only: `planner` with `integrations: "install"` (or absent where TypeScript would install) and a changed planner (wave 10 bridge), and `execution.backend` = `orca` without `PACER_BACKEND` (Q2: stays forwarded until wave 3). Everything else in plan table 1d marked "port" goes native: planner refusals (missing `integrations` with its hint, executor-session `not_allowed`, non-runner-id values, unknown account, preflight strategy validation failure), `planner` + `skip` (write via `set_planner_without_integrations`), `planner` + `install` with an unchanged planner (no write, publish the `config` event), `execution.backend` refusals, `execution.backend` = `direct`, and any backend value with `PACER_BACKEND` set (its hint). Remove the blanket refusal in `crates/config/src/settings.rs` (around line 490). Match TypeScript `src/core/config.ts` replies exactly (codes, messages, hints, undo text, warnings) and refusal order.
2. Q10: add a per-process in-flight key guard to native `config.set` matching TypeScript's `pendingEdits` (`This setting is already being changed`, same code). Key it the way TS does; release on every exit path (including errors and panics: use a drop guard). Test with two genuinely concurrent requests (not serialized by the test).
3. Q8, D8 amendment: change the live harness D8 guard so network `config.set` is allowed for every key except `planner`, and for `planner` only with `integrations: "skip"`; everything else in `config.set` stays refused with the same 403 shape and evidence note. This needs body inspection in `scripts/live/proxy.ts` (keep `BLOCKED_OPS` the documented source of truth; add a conditional rule rather than silently dropping the op; bounded body read; malformed or oversized bodies stay refused). Update the D8 table row and surrounding text in `docs/testing/live-validation.md`, and `test/live-harness.test.ts` (allowed and refused bodies, including `planner` with `install`, missing `integrations`, non-JSON, case/whitespace tricks in the key, duplicate JSON keys where the last wins in JS). The command bar `config-set` always sends `install`, so it stays refused for `planner`.
4. Ledger: row 10 (residual = changed planner with install; backend `orca` without env), the pure-key list at about 628 and 637-643 (add the missing `pacing.balance`), planner/backend dependency rows about 647-648. Totals stay 231/157/83/74. CHANGELOG `[Unreleased]` entry.
5. CRATE-1 (Q7): `pacer-config` is over 8,000 LOC. Record `cargo xtask loc` before and after for every touched crate, keep additions minimal (prefer putting new code in `pacer-config-ops` if that stays reasonable), and write the PR-description paragraph that states why and names the planned split in the handoff.

Size: about 700 changed lines. Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`). Do not push.

## Tests

Differential through stdio and HTTP against `PACER_FORWARD_OPS=config.set` on twin homes with `PACER_DEBUG_NATIVE=1` markers, for every "port" row of plan table 1d: compare replies (including hints and undo text), `strategy.yaml` bytes and the `config` SSE event; `PACER_BACKEND` set on both cores for the env rows. Add corpus inputs to `test/fixtures/config-settings/settings.json` used by `test/config-settings-parity.test.ts`, cases in `test/native-config-ops.test.ts`, and rewrite `crates/server/src/native/tests/config_writes.rs` (around line 293). The forwarded residue must stay forwarded: assert the forward marker for planner+install with a changed planner and backend `orca` without env. Each new native path must fail if reverted to forwarding.

## Checks

Serial in sbx-deny (`/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny`) with disposable HOME and PACER_HOME (real CARGO_HOME and RUSTUP_HOME; keep `SCCACHE_DIR=$REAL_HOME/Library/Caches/Mozilla.sccache` if you set HOME), TZ=Asia/Ho_Chi_Minh: `cargo fmt --check`, `cargo clippy -p <touched crates> --all-targets -- -D warnings`, `cargo test -p <touched crates>`, `cargo xtask loc --check` and the deps check, `bun run typecheck`, the Bun tests added or touched (including `test/live-harness.test.ts`), `git diff --check origin/main..HEAD`. The `native_run` tests that need `/bin/ps` fail inside sbx-deny for environmental reasons; note them, don't chase them.

## Live validation (CT-11)

Per docs/testing/live-validation.md, session ids `live-wave1-pr4-`: `bun run live up --front-door rust --native-test-ops`. With the amended D8: CLI and HTTP `config.set` for planner+skip, planner refusals, unchanged planner with install, backend `direct`, backend refusals, and backend with `PACER_BACKEND` set; with native markers; compare against the TypeScript front door. Show D8 still refuses planner+install through the proxy. Web Settings General (planner change with skip) and Machines (backend `direct`) via the harness browser control (`--surface web`); TUI settings if the harness can drive it, else UNVERIFIED. Live stdio is refused by D3; report it UNVERIFIED. One live session at a time in this worktree; leave others alone; stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never install or uninstall real planner integrations.

## Handoff

Write `.work/reviews/wave1-pr4-handoff.md` in the worktree: commits, per-input outcome (native or forwarded and why), the D8 change and its tests, LOC before and after and the CRATE-1 paragraph, check commands with pass counts, live session ids, report paths and Summary lines including web, UNVERIFIED items, cleanup. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and execute the task brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave1-pr4.md. Always finish with orca orchestration worker_done.

# Task: port the fixes and tests from closed PR #629 that still apply to main

Executor: cursor-agent (default model). Implementation in Rust and TypeScript tests with parity oracles; not a small task. No time limit; finish implementation, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, branch `fix/port-629-salvage` at origin/main `acab1eca4`. Its `target/` holds an earlier build of the same code; build there and do not create another target directory (disk has about 15 GiB free).

Source material:
- The analysis: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/m2-stale-compare.md, section "#629", subsections "Unique tests" and "Unique fixes". Every "would pass on main" in it is unverified; confirm by running.
- The #629 code: `git fetch origin pull/629/head:refs/compare/pr-629` (the ref may already exist in the main checkout), then read files with `git show refs/compare/pr-629:<path>`. Do not check out or merge the branch.
- Issue #889 holds the parts of #629 that are not ported here. Do not port anything from that list.

Before working, read AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,security,code-and-testing,repository}.md`, `.project/reviewers/{security,qa,architecture}.md`, and `docs/testing/live-validation.md`.

## Scope

Port onto main's existing layout (`crates/plugin-host`, `crates/read-model`, `crates/store`). Do not add #629's crate split, new crates or ADRs.

1. Fix 2: `crates/plugin-host/src/native_orca.rs` `valid_params` counts UTF-16 units for `abandon.reason`, `finish.summary`, `tail` and `launchBroken`. Zod counts code points. Use `codepoint_len`. Port `native_orca_parameter_boundaries_match_actual_zod_codepoints` with the parameter part of the oracle `test/fixtures/orca-text-parity.ts`; check against real Zod as the PR did.
2. Fix 3: `crates/read-model/src/tasks.rs` copies `placement` whole. TypeScript `src/link/pump.ts` emits `{mode, why}` only. Port `test/read-model-visible-task.test.ts` (7 Bun tests), adapted to main.
3. Fix 1: `crates/plugin-host/src/native_hosts.rs` session cleanup on failed open, failed close, snapshot change, run error and invalid result (`retire_pending`, `retire_session`, sticky cleanup failure), and the summed stdout+stderr bound that TypeScript `src/plugins/host-lease.ts` uses. Port the related retirement tests from `native_hosts.rs` / `host_lease_adversarial.rs`.
4. Fix 4: `crates/plugin-host/src/native_write.rs` authority recheck before staging and before commit, and sticky cleanup failure, matching `src/plugins/capability-write.ts`. Leave out the host-transaction `read_for_update` API.
5. Tests that need no code change: the `hardening.rs` policy-detail matrix, the two `native_write.rs` tests, the two `transfers_adversarial.rs` tests, the two `native_process.rs` tests, and `work_lease_guards.rs` with its oracle (adapt to `pacer_plugin_host::{WorkLease, begin_blocker}`). If one fails on main, that is a bug: fix it if small, otherwise leave the test out and record it in the handoff.
6. Item 5, verify only: add the store test `imports_ts_json_with_surrogates_without_discarding_the_record` against main. If it passes, keep it. If it fails, do not port the lossless store layer; leave the test out, and record the failure output in the handoff so the coordinator can file it.

Size: keep the diff under about 1,500 changed lines. If it grows past that, stop after items 1, 2 and 5 on this branch, commit, and record in the handoff which items remain.

CRATE-1: `pacer-plugin-host` is over budget. Do not add bulk; keep fixes 1 and 4 minimal. Run `cargo xtask loc --check` before and after and record both numbers. If the crate crosses a CRATE-1 threshold it was not already over, stop and report instead of splitting it.

Commits: Conventional Commits, `git commit -s`, one commit per item or a few coherent commits (for example `fix(plugin-host): count Zod code points in native Orca parameter bounds`). Do not push.

## Checks

Serial and inside sbx-deny, with disposable HOME and PACER_HOME (keep the real CARGO_HOME and RUSTUP_HOME), TZ=Asia/Ho_Chi_Minh:
- `cargo fmt --check`, `cargo clippy` for the touched crates with `-D warnings`, `cargo test -p` for each touched crate;
- `bun run typecheck` and the Bun tests you add or touch;
- `cargo xtask loc --check`;
- `git diff --check origin/main..HEAD`.

## Live validation (CT-11)

Follow docs/testing/live-validation.md. `bun run live up --front-door rust --native-test-ops --seed ui`, session ids `live-port629-`. Exercise what the harness can reach. At minimum, compare a task snapshot row with `placement` through the Rust front door and the TypeScript front door (`live up` without `--front-door`), and show `placement` has only `mode` and `why`. Exercise the native plugin-host paths (`PACER_NATIVE_PLUGIN_HOST=1`) only if the harness supports it; otherwise report them as UNVERIFIED with the reason. Write the session report with a Summary line. One live session at a time; stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343.

## Handoff

Write `.work/reviews/port-629-salvage-handoff.md` in the worktree: commits, per-item status (ported, fixed, left out and why), test commands with pass counts, the CRATE-1 numbers, live session id, report path and Summary line, UNVERIFIED surfaces with reasons, and cleanup done. Report with `orca orchestration worker_done`. Always end with worker_done.

# Task: wave 2 PR 2 fix round 1 — review findings and the admitted host.check live run

Executor: cursor-agent (default model). Security-sensitive (enforcement refusal coverage) Rust/TS tests plus live validation. Memory and disk are tight: build only touched crates and the `pacer` binaries once, one cargo command at a time, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`; no release or `--workspace` builds.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr2, branch `feat/native-host-check-clean`, head `5556ebf59`, stacked on wave 2 PR 1 (`13a077eea`; PR #893 has since been rebased on GitHub onto a newer main — do not rebase; the coordinator will). Review: `.work/reviews/wave2-pr2-review.md` (UNVERIFIED pending the live run; F1–F9 nonblocking). Handoff: `.work/reviews/wave2-pr2-handoff.md`. Not pushed.

## Fixes (coordinator decisions)

- **F2:** add an HTTP scenario to `test/native-host-check-clean-parity.test.ts` that covers the enforcement identity (a serve started with `PACER_ENFORCEMENT_TOKEN`, or whatever HTTP caller reaches `admit` with the enforcement identity — check how TS identifies it) and a cookie (app-session) caller, compared against forced forwarding. Show it goes red with `authorize(ctx)?` removed from `admit` (save the log under `.work/fixtures/wave2-pr2-r1/`).
- **F3:** extend the dry-run "nothing written" proof to `strategy.yaml` bytes and the task-store SQLite files (contents, not mtimes, if `TaskStore::open` touches them identically on both sides; explain).
- **F6:** use a `git` read variant that does not call `mark_unreachable` for the dry-run reads, if one exists or can be added in `pacer-repos` without changing other callers; otherwise keep it and record it as an accepted residual in the ledger row.
- **F4:** relabel the live rows in the handoff and PR text (generic stdio fixture rows and the in-process CLI row are not native host evidence).
- **F1, F5, F9:** PR text: name the `pacer-server` split (ADR 0020's server seam / moving native dispatch wiring out, as wave 3 names it); note for PR 3 to move the totals 159→160 / 85→86 / 72→71; name the executor and tier.
- F7, F8: no change; note F7 in the live evidence method.

## Admitted host.check live run (CT-11, required)

Wave 2 PR 4's fake-ssh fixture is ready on branch `test/live-fake-ssh-host` (worktree /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, commits `370219796` and `f5bbd6dd2`). In a scratch branch off your fixed head (do not commit the PR 4 changes to `feat/native-host-check-clean`), cherry-pick those two commits, build the debug binaries, and run `bun run live native-host-effects` per `docs/testing/live-validation.md` and the PR 4 handoff. It must show, for admitted `host.check` on a `--front-door rust --native-test-ops` sandbox versus a forced-forward sandbox: the job lifecycle via native `job.get`, the job file, `host-checks.json` and SSE `job` events equal, and Core-side evidence that the bridge (HTTP) or forward (stdio) carried the admitted request (not the native trace alone, per F7). Record both report summaries. Stop every session (`live down --keep`), confirm no processes remain, and delete the scratch branch afterwards.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`: fmt, clippy `-D warnings` and tests for the touched crates, `cargo xtask loc --check`, `bun run typecheck`, the parity test and existing host tests, `git diff --check`.

Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never contact a real SSH host.

## Handoff

Append a "Fix round 1" section to `.work/reviews/wave2-pr2-handoff.md`: commits, per-finding status, red evidence, checks, the live run summaries and evidence paths, and the final PR-description text. Report with `orca orchestration worker_done`. Always end with worker_done.

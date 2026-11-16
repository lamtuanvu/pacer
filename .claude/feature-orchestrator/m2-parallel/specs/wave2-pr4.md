# Task: M2 wave 2 PR 4 — fake-ssh host fixture for native host checks in the live harness (TypeScript)

Executor: cursor-agent (default model). The change touches the live sandbox environment and real-install isolation (`scripts/live/core.ts`, `scripts/lib/real-install-guard.ts` boundaries), so it is security-adjacent; frontier tier. No time limit.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, branch `test/live-fake-ssh-host`, at origin/main. TypeScript and scripts only: run `bun install --frozen-lockfile`; do not edit Rust. You may build the debug `pacer` binaries once (`cargo build -p pacer`, `CARGO_INCREMENTAL=0`) to run a Rust front-door sandbox; never release or `--workspace` builds.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,code-and-testing,repository}.md`, `.project/reviewers/{security,qa}.md`, `docs/testing/live-validation.md`, `scripts/live/**`, `scripts/lib/real-install-guard.ts`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md`, especially §6 and "PR 4". Recheck every cited file:line.

## Scope (PR 4 only)

Per the plan: `scripts/live/core.ts` puts a fake `ssh` (reuse `test/fixtures/bin/ssh` semantics) and a fake host home inside the sandbox, mirroring the `security` stub; a fixed fixture `scripts/live/native-host-effects.ts` that drives `host.check` through the guarded proxy on a `--front-door rust --native-test-ops` sandbox, compares with a `--native-forward-ops host.check` sandbox, verifies the job file, `state/host-checks.json` and SSE `job` events, and records the D8 refusals for `host.clean` and `host.repo.setup` as UNVERIFIED notes; wire it as a `bun run live` subcommand like existing fixtures; `test/live-harness.test.ts` coverage; `docs/testing/live-validation.md` section. The fake ssh must never fall through to a real `ssh` binary or a real host: PATH inside the sandbox must resolve the fake first, and the fixture must fail closed if it doesn't (test this).

On main today `host.check` is still forwarded (native registration lands in wave 2 PR 2, being built in parallel), so on this branch the native-vs-forward comparison will show both sessions forwarding. Make the fixture report that honestly (for example a note that the Rust session traced no `native host.check`) rather than failing, and make it assert native traces when they appear. The coordinator will rerun it against PR 2.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`: `bun run typecheck`, `test/live-harness.test.ts`, `test/live-api-guard.test.ts`, and any test that covers `scripts/live` (`rg -l "scripts/live" test`), `git diff --check`.

CT-11: `scripts/live/**` changes require exercising the changed commands (see the live-validation table). Run the new fixture end to end on disposable sandboxes and include the report summary. Stop every session (`live down --keep`) and confirm no processes remain.

Commits: Conventional Commits (`test:`), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never contact a real SSH host.

## Handoff

Write `.work/reviews/wave2-pr4-handoff.md` in the worktree: commits, the fixture contract, fail-closed evidence for the fake ssh, test results with counts, live report summaries, and how to rerun it against PR 2. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave2-pr4.md exactly. End with orca orchestration worker_done.

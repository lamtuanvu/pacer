# Task: wave 2 PR 4 fix round 2 — guard allowlist for host repo subcommands (N1) and docs exception (N2)

Executor: cursor-agent (default model). Small guard change; fail-closed security hardening. TypeScript and scripts only; do not build Rust.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, branch `test/live-fake-ssh-host`, head `f5bbd6dd2`. Re-review: `.work/reviews/wave2-pr4-rereview.md` (PASS; N1, N2). Not pushed.

- **N1:** in `scripts/live/guard.ts`, replace the two-word `repo map` match with an allowlist: the guarded CLI admits `host repo` only with the read-only subcommands the TS CLI actually has (check `src/cli.ts` / `src/commands/host*.ts`; the reviewer suggests `list` and `check`), found as the first non-flag argument after `repo` wherever flags appear; everything else under `host repo` is refused like the other host forms. Tests in `test/live-api-guard.test.ts` (or wherever the host-form tests live) for `host repo --repo /abs map`, flags before and after, `--`, and the admitted forms. Mutation-check the allowlist (red without it).
- **N2:** name the integrations fixture as an exception in the fake-ssh docs sentence in `docs/testing/live-validation.md`, with the reason the reviewer gives.

Checks serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`: `bun run typecheck`, `test/live-harness.test.ts`, `test/live-api-guard.test.ts`, `git diff --check`. CT-11: exercise one refused and one admitted `host repo` form through the guard on a disposable sandbox (existing `target/debug` binaries if present, otherwise the TypeScript front door), then `live down --keep` and confirm no processes remain.

One commit, `fix(live): admit only read-only host repo subcommands in the CLI guard`, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never contact a real SSH host.

Append a "Fix round 2" section to `.work/reviews/wave2-pr4-handoff.md` (commit, tests, red evidence, live note). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave2-pr4-r2.md exactly. End with orca orchestration worker_done.

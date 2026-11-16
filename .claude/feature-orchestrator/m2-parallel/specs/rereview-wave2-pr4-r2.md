# Task: independent review of wave 2 PR 4 fix round 2, host repo allowlist in the CLI guard (REPO-10)

Executor: cursor-agent (default model), independent reviewer. Small fail-closed guard change. You did not write this code. Read-only: do not edit tracked files, commit, push. Do not build Rust. You may run `git`, `bun run typecheck` and focused `bun test` files inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, branch `test/live-fake-ssh-host`. Review `git diff f5bbd6dd2..593c1e7a2`. Prior re-review: `.work/reviews/wave2-pr4-rereview.md` (N1, N2). Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave2-pr4-r2.md. Handoff "Fix round 2": `.work/reviews/wave2-pr4-handoff.md`.

Check: the guard admits `host repo` only for the read-only subcommands, in every spelling the TS CLI parser accepts (flags before and after, flag values that look like subcommands such as `--repo map list`, `--`, `--json`), and refuses everything else under `host repo` with the same refusal as the other host forms; the "first non-dash word and parseFlags agree" rule cannot be fooled into admitting a write form (try at least three adversarial spellings against `src/cli.ts`'s actual parsing, and one mutation in a scratch copy under /tmp, discarded afterwards); no other guard behavior changed; N2 docs accurate; tests pass; REPO-4 and hygiene for the new commit.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4/.work/reviews/wave2-pr4-rereview-r2.md`: verdict on the first line, scope, reviewer identity, findings table, checks, what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-wave2-pr4-r2.md exactly. End with orca orchestration worker_done.

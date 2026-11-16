# Task: independent re-review of wave 2 PR 4 fix round 1, fake-ssh fixture and guard (REPO-10)

Executor: cursor-agent (default model), independent reviewer. Security-adjacent: the D3 guard now refuses the CLI host forms, and the fake ssh runs sandbox "remote" commands locally. You did not write this code. Read-only: do not edit tracked files, commit, push. Do not build Rust. You may run `git`, `bun install --frozen-lockfile`, `bun run typecheck` and focused `bun test` files inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never contact a real SSH host.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, branch `test/live-fake-ssh-host`, reviewed head `370219796`, fix head `f5bbd6dd2`. Prior review: `.work/reviews/wave2-pr4-review.md` (PASS, F1–F6). Fix brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave2-pr4-r1.md. Handoff "Fix round 1": `.work/reviews/wave2-pr4-handoff.md`.

Follow `.agents/skills/project-review/SKILL.md`; apply `.project/reviewers/{security,qa}.md` and `.project/rules/{security,code-and-testing,repository}.md`.

Review `git diff 370219796..f5bbd6dd2`:
1. F5: D3 refuses every guarded-CLI form of the host operations D8 refuses (`host add`, `host account add`, `host repo map`, `host clean`, `host terminal`, `host setup`) in every spelling the CLI parser accepts (flags before/after, `--json`, `--`); nothing legitimate the live docs rely on became refused. Mutation-check one refusal in a scratch copy under /tmp (discard afterwards).
2. F6: `live down` removes only the sandbox's own `/tmp/pacer-ssh-<uid>-<hash>` directory, derived with pacer's own `controlDirPath`; it can never remove another path (check symlink and non-directory cases).
3. F3, F4: checks run before any request or write for both sandboxes; the missing-fixture refusal is tested.
4. F1, F2: docs accurate.
5. Tests pass (live-harness, live-api-guard); REPO-4; no `.work/` paths, machine paths or personal emails in added lines.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4/.work/reviews/wave2-pr4-rereview.md`: verdict on the first line; scope, heads, reviewer identity; per finding status; new findings table; checks; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.

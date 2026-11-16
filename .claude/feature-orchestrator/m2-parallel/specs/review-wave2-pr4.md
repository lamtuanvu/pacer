# Task: independent review of wave 2 PR 4, fake-ssh host fixture in the live harness (REPO-10)

Executor: cursor-agent (default model), independent reviewer. Security-adjacent: the change alters every live sandbox's PATH and environment and must never let a live run reach a real `ssh` or real host, or the maintainer's real install. You did not write this code. Read-only: do not edit tracked files, commit, push. Do not build Rust (memory is very tight). You may run `git`, `bun install --frozen-lockfile`, `bun run typecheck` and focused `bun test` files inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`. You may run the new fixture once on disposable sandboxes using the existing `target/debug` binaries in the worktree if present (stop every session with `live down --keep`); if no binaries are present, read the worker's live reports instead.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, branch `test/live-fake-ssh-host`, head `370219796`, base origin/main `acab1eca4`. Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md (§6, "PR 4"). Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave2-pr4.md. Handoff: `.work/reviews/wave2-pr4-handoff.md`.

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/{security,qa}.md` and `.project/rules/{security,code-and-testing,repository}.md`, plus `docs/testing/live-validation.md` and `scripts/lib/real-install-guard.ts`.

Review:
1. Fail-closed fake ssh: inside every sandbox, PATH resolves the fake first; the fixture and `core.ts` refuse to proceed if `ssh` resolves elsewhere; nothing in the fake can exec a real `ssh`; the fake host home is inside the sandbox; no path reaches `~/.ssh`, the real `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`. Prove at least one fail-closed case by mutation in a scratch copy under /tmp (discard afterwards).
2. Adding the fake ssh to every sandbox (not only the new fixture) changes no other fixture's behavior; check the SEC-6 implications (contacting SSH hosts needs approval) and that no existing live flow relied on a real ssh.
3. The fixture's checks are meaningful: job file, `state/host-checks.json`, SSE `job` events, native-vs-forced-forward comparison, D8/D3 refusals recorded as notes; it reports honestly that `host.check` is still forwarded on main and will assert native traces once wave 2 PR 2 lands.
4. Tests (`test/live-harness.test.ts` additions) cover the fail-closed path; the 5 `scripts/live` failures the worker attributes to sbx-deny EPERM really reproduce on the base (read the tests; you may run them on the base in a scratch worktree only if cheap).
5. Docs (`docs/testing/live-validation.md`) accurate; REPO-4 (signed off, Conventional Commit, identity Vu Lam); no `.work/` paths, machine paths or personal emails in added lines.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4/.work/reviews/wave2-pr4-review.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity; findings table (ID, rule, severity blocking/nonblocking, location, evidence, impact, remedy); checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-wave2-pr4.md exactly. End with orca orchestration worker_done.

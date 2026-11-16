# Task: wave 2 PR 4 fix round 1 — fake-ssh fixture review findings

Executor: cursor-agent (default model). Security-adjacent live-harness guard change. TypeScript and scripts only; do not build Rust (memory is very tight; reuse existing `target/debug` binaries for the live rerun if present).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr4, branch `test/live-fake-ssh-host`, head `370219796`. Review: `.work/reviews/wave2-pr4-review.md` (PASS, findings F1–F6). Handoff: `.work/reviews/wave2-pr4-handoff.md`. Not pushed.

## Fixes (coordinator decisions)

- **F5 (fix in this PR):** the fake ssh now runs sandbox "remote" commands locally, so a host declared with an absolute path could run `CLEAN`/`START`/git upload-pack against real local paths. Make the live D3 guard (`scripts/live/guard.ts`) refuse the guarded-CLI forms of every host operation D8 refuses over the API (`scripts/live/proxy.ts:23-33`: `host add`, `host account add`, `host repo map`, `host clean`, `host terminal`, plus the existing `host setup`), with the same refusal style and a test per form in `test/live-api-guard.test.ts` or `test/live-harness.test.ts`. If the new fixture itself needs one of these forms to declare its fake host, have it write the strategy directly (as a fixture-owned file inside the sandbox) instead of going through the guarded CLI, and keep the refusal for everyone else. Mutation-check one refusal (red without it).
- **F1:** add a sentence to the "Sandbox SSH stream faults" section of `docs/testing/live-validation.md`: the SSH task reaches only the sandbox fake host; full-session prerequisites (glibc ≥ 2.17) need a Linux machine, otherwise report UNVERIFIED. Put the "no real-ssh option in the harness" policy change in the handoff's PR-description text.
- **F2:** scope the docs sentence at line ~81 to sandboxes started by `live up` and the guarded CLI, and name the upgrade and OTA fixtures as exceptions (they declare no hosts).
- **F3:** run both sandboxes' reuse and pre-configured-hosts checks before the first request (split checks from writes), so the fixture refuses before consuming either sandbox. Test it.
- **F4:** add the missing-fixture refusal test (temporary checkout copy or an injectable fixture path) or drop the claim; drop or test the uid-owner claim.
- **F6:** remove the sandbox's `/tmp/pacer-ssh-<uid>-<hash>` control directory in `live down` only if pacer's own derivation (`src/remote/ssh.ts:10-29`) can be reused exactly; otherwise document it. Never remove any other `/tmp` entry.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`: `bun run typecheck`, `test/live-harness.test.ts`, `test/live-api-guard.test.ts`, other `rg -l "scripts/live" test` files (known sbx EPERM failures reproduce on base; say which), `git diff --check`. CT-11: rerun `bun run live native-host-effects` end to end on disposable sandboxes and include the summary; exercise one refused CLI host form live through the guard. Stop every session (`live down --keep`) and confirm no processes remain.

Commit: `test(live): ...` or `fix(live): ...` Conventional Commit(s), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never contact a real SSH host.

## Handoff

Append a "Fix round 1" section to `.work/reviews/wave2-pr4-handoff.md`: commits, per-finding status, tests and red evidence, live summary, updated PR-description text. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave2-pr4-r1.md exactly. End with orca orchestration worker_done.

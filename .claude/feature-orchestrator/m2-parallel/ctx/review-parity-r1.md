# Task: independent QA and protocol-compat review of owner parity R1 — the native owner's plugin.hello deadline and text (REPO-10)

Executor: cursor-agent (default model, frontier tier). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash` (shared by all worktrees); for temporary reverts work in a `git archive HEAD` copy under `/tmp` or save a patch under `.work/fixtures/` and `git apply -R` / `git apply`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-r1, branch `fix/owner-hello-deadline`, head `07c7081d2`, two commits on `main` `30606ef07` (6 files, +229/−3).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-r1-handoff.md (changes, tests with red evidence, CT-11 with one UNVERIFIED case, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-r1.md and `w4-common.md` next to it.
- Coordinator decisions during the task: scope option B (owner hello cap and text only; the serve door's flat 30 s `CALL_DEADLINE` for its own `plugin.doctor`/`plugin.ui.*` calls belongs to PR H, which also owns that ledger row). Flag-off's hello-timeout crash accounting (stops the child, restarts 1) is not matched, because the owner's `CrashBook` counts only unrequested exits; it stays a red PR 7 gate row.
- Flag-off reference: `src/plugins/registry.ts` (`HELLO_DEADLINE_MS` ~174, the request timer and hello failure ~2093), `src/plugins/protocol.ts` (method deadlines ~221).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,code-and-testing,api-protocol,repository}.md`, `.project/reviewers/{qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Deadline.** The owner's hello wait is `min(10 s, time left on the call's own absolute deadline)`, as flag-off, where the method deadline also bounds `plugin.hello`. No path waits longer than the call's deadline; a call with less than 10 s left fails as an expired call, not as a hello timeout.
2. **Text and code.** A hello that outlives its own 10 s cap fails with flag-off's code and exact text ("plugin.hello passed its 10000 ms deadline"); every other hello failure (crash, process error, the call's deadline) keeps its previous code and text. Check `hello_failure`'s match on `ProcessError::Timeout` text and `wait == HELLO_DEADLINE` for cases that could misclassify.
3. **No new accounting.** Confirm that matching the crash/restart difference would need new accounting, and that the ledger records it accurately as an open difference.
4. **Tests and evidence.** Rerun `crates/plugin-runtime/tests/hello_deadline.rs`, `test/plugins-native-owner-hello-deadline.test.ts`, the conformance and owner suites (`plugin-conformance-native-owner`, `plugins-native-owner-call`, `plugins-native-owner-matrix`, `serve-plugin-native`, `native-plugin-ops`, `native-plugin-ops-stdio`) with both front doors built from this head; reproduce the red evidence for at least one Rust and one TS test. The fixture gains `startDelayMs`; check it cannot change other fixture behavior. fmt, clippy `-D warnings` for `pacer-plugin-runtime` and `pacer-server`, typecheck. Commit signed off and Conventional; no machine paths or personal emails; CHANGELOG (REPO-7).
5. **CT-11.** Judge the handoff's live evidence and the UNVERIFIED over-10 s Core case (covered by the real-owner test): acceptable, or a real gap?

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-r1-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `07c7081d2`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.

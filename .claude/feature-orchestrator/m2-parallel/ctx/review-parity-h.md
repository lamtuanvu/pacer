# Task: independent security, QA and protocol-compat review of owner parity PR H — the serve door's plugin doctor and UI calls relayed through Core (REPO-10)

Executor: cursor-agent (default model, frontier tier: a private relay path that carries secrets and signing). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash` (shared by all worktrees); for temporary reverts work in a `git archive HEAD` copy under `/tmp` or save a patch under `.work/fixtures/` and `git apply -R` / `git apply`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch `fix/door-plugin-calls-via-core`, head `b13d4dd90`, three commits on `main` `30606ef07` (14 files, +252/−537).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-handoff.md (changes, tests with red evidence, CT-11 flag-on 18 PASS / 1 UNVERIFIED and flag-off 5 PASS, follow-ups, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-h.md and `w4-common.md` next to it.
- Coordinator decisions during the task: the hello-timeout crash accounting difference and "readiness after a failed first call" are new red PR 7 gate rows with expected-fail checks (not fixed here); the dead `call_door`/`DoorCall`/`DoorReady`/door-hello code in `pacer-plugin-runtime` is removed after R1 merges; H owns the door-deadline ledger row.
- Flag-off reference: `src/plugins/registry.ts`, `src/plugins/protocol.ts` (method deadlines ~221), `src/plugins/host.ts`, `src/serve/plugin-native.ts`, `src/api/stdio.ts`.
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,architecture,repository}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027 (and ADR 0021 for door/Core roles). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Relay authority (security).** Core now accepts the private relay kind over HTTP when it has an owner socket. Confirm only the owning door can send it: the same internal bearer / sealed-key checks as the existing stdio relay, no path for a work grant, task token, cookie or public-port caller, and no way to name a plugin, method or resources Core would not seal for that caller. `secrets.resolve` and `identity.sign` are answered by Core under flag-off's rules (declared, granted, audited); an undeclared `identity.sign` is refused and audited exactly as flag-off.
2. **Deadlines.** The relayed `plugin.doctor` (`diagnostic.ping` 5 s) and `plugin.ui.*` (`ui.render` 2 s, `ui.action` 10 s, `ui.settings.validate` 2 s) get flag-off's per-method deadlines, and the method deadline also bounds `plugin.hello`. Same error code and text as flag-off. The door's flat 30 s `CALL_DEADLINE` no longer applies to these calls.
3. **Test tolerances.** `b13d4dd90` allows 1.5 s past each door deadline under load. Judge whether the rows still prove the deadline (for example, a 3 s render must still fail, and a call that finished at the old 30 s cap would still be red), or whether the margin hides a regression.
4. **Removed code and differences.** The Rust door's own doctor/UI path is removed (−537 lines); confirm nothing still calls it and nothing else lost behavior. The DOOR_SECRET_TEXT known differences are gone from the conformance and assistant-key tests and those rows compare equal to flag-off. The two expected-fail rows (crash accounting, readiness) assert the current difference and will flip when fixed.
5. **Tests and evidence.** Rerun the required checks from the brief with both front doors built from this head: clippy `-D warnings` and tests for `pacer-server` and `pacer-plugin-runtime`, `plugin-conformance-native-owner`, `plugins-native-owner-call`, `plugins-native-owner-assistant-key`, `serve-plugin-native`, `native-plugin-ops`, `native-plugin-ops-stdio`, `plugins-native-owner-matrix`, `native-plugin-crash`, typecheck. Reproduce the red evidence on base for the secret-text and deadline rows. Commit sign-off, Conventional subjects, no machine paths or personal emails, CRATE-1 (`pacer-server` shrinks), CHANGELOG (REPO-7), ADR 0027 text matches the code.
6. **CT-11.** Judge the handoff's live evidence and its UNVERIFIED item.

Note: R1 (branch `fix/owner-hello-deadline`, in review) adds a fixture option `startDelayMs` for the same purpose as H's `helloDelayMs`. Do not ask H to change it; just say whether `helloDelayMs` (held after stdin opens) is needed for H's rows, or whether R1's start delay would prove the same thing.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `b13d4dd90`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.

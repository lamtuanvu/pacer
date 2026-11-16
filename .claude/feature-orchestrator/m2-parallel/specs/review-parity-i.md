# Task: independent security review of owner parity PR I — detached stop and inspect under the native owner, owner socket out of service terminals (REPO-10)

Executor: cursor-agent (default model, frontier tier: one-use stop and inspect grants answered across the owner bridge). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-i, branch `fix/owner-detached-stop-grants`, head `681d14aa3`, two commits (`15d8aaca4`, `681d14aa3`) on PR A (`aafa8159d`, reviewed PASS, open as #945). PR E (runners own their plugin children) has since merged to `main` as #944; this branch will be rebased onto `main` after #945.

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-i-handoff.md (remedy chosen and why, tests, CT-11, deviations, follow-ups).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-i.md.
- The finding being fixed: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-e-review.md, F1 and F2, with the reviewer's repro in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/fixtures/parity-e-review/`.
- PR A's reviews for the call-authority model this builds on: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-review.md and parity-a-rereview.md.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,code-and-testing,repository}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Authority (remedy b: Core keeps the grants and answers `capability.process.stopRun`, `capability.process.inspectRun` and `capability.hosts.stopOwned` as sealed `coreMethods`).**
   - A grant stays one-use and bound to its run (task, attempt, run directory, wrapper pid), exactly as flag-off; a second use, another run, or another plugin's call is refused with the flag-off text.
   - A call that was not issued the grant cannot reach Core's answer: the owner never forwards an unsealed method, and `core_capability`'s new arms cannot be used to smuggle other methods into `coreMethods`.
   - The narrow `hostBroker` admits only pacer-exec-direct's `stopOwned`, as flag-off `answerHosts` does; nothing else from `hosts` becomes reachable.
   - The answers travel only on the issuing call's own bridge connection (relate this to #918 / PR G and A's N1 same-user caveat; say whether this PR widens what a same-uid bridge peer could do before PR G).
2. **Parity.** Flag-on stop and inspect match flag-off in outcome, codes and refusal texts; the logged reconcile errors (`stop reconcile failed`, `remote stop reconcile failed`) follow the service log's existing form and contain no secrets.
3. **F2.** `viewerEnv` strips `PACER_HOST_SOCKET` from every service-launched terminal and viewer path (`launchViewer` both paths, `openSessionAdmitted`, `openInTerminal` launchers, built-in terminals) and nowhere it is needed (the door's Core child, runners already handled by PR E). Search for any other user-facing terminal spawn that still passes `ctx.env` unchanged.
4. **Tests.** Each new test fails without its fix (rerun two red mutations: the registry change for the unit tests, and the Rust `core_capability` arm). The e2e launches the attempt flag-off in both modes because PR E was not on the base; now that PR E is on `main`, say whether the test must switch to a flag-on launch before merge or can follow. The sandbox-only failure in `test/plugins-remote-prepare-recover.test.ts` is pre-existing (confirm on the base).
5. **CT-11.** Evidence at `681d14aa3` plus PR E applied uncommitted (now merged as #944, so acceptable if the rebased head matches); the terminal env UNVERIFIED row and its reason are stated in the draft PR body.
6. **Docs.** ADR 0027 consequence and rejected alternative, ledger F1 row and F2 note, CHANGELOG; no machine paths or personal emails; commits signed off and Conventional.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` (the shared sccache server is already running; never stop it or let it start inside a disposable HOME), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET -u CARGO_TARGET_DIR`, with both front doors built from this head and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Run `bun install --frozen-lockfile` first. One cargo command at a time, debug; other Rust workers run at the same time, so keep memory modest. Known: `native_run` capability tests fail in sbx-deny (setuid `/bin/ps`); the matrix doctor activity-order race is pre-existing.

Tests to run: clippy `-D warnings` and tests for `pacer-plugin-runtime`; `bun run typecheck`; `test/plugins-native-owner-detached-grants.test.ts`, `test/plugins-native-owner-detached-stop.test.ts`, `test/plugins-native-owner-matrix.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/api.test.ts`, `test/session-service.test.ts`, `test/terminal-open.test.ts`, `test/terminal-workspace.test.ts`.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real executor account, API key or Keychain item.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-i-review.md: the verdict (PASS / FAIL / UNVERIFIED) against head `681d14aa3`, findings with severity (blocking / nonblocking / nit) and code references, a ruling on the e2e flag-off launch, and the commands you ran with their results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-i.md exactly. End with orca orchestration worker_done.

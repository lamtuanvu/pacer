# Task: wave 3 PR 4 fix round 1, owner bridge endpoint and Orca review findings

Executor: cursor-agent (default model, frontier tier). Security-sensitive: what crosses the sealed owner bridge. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr4, branch `feat/owner-bridge-endpoint-orca`, head `ec28240ef` (your commit 1713d2840, rebased onto `origin/main` after #917 merged; no conflicts). Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-review.md (FAIL: B1 blocking, N1–N7). Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-handoff.md. Plan header OD-3/OD-4 in /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md. Not pushed.

## Fixes (coordinator decisions)

- **B1 (blocking):** narrow the empty-binding allowance in `callNativeOwner` to the calls this PR carries with parity, `endpoint.launchEnv` (and only that method, plus whatever the Orca attempt path needs if it also passes `[]`; check). Keyless `endpoint.models` and keyless `classifier.ask` keep the base flag-on behavior (refused with the existing `plugin_unavailable` text), as before this PR. Do not carry them in this PR; record both in the handoff as follow-ups for the PR 6 consumer matrix (`endpoint.models` needs the issued-host HTTP scope narrowing `endpointHttpScopes` on the owner; `classifier.ask` needs generation config and admission parity). Tests: a flag-on keyless `endpoint.models` and a flag-on keyless `classifier.ask` assert the refusal (not `.catch(() => undefined)`); a mutation widening the allowance back to any method must turn them red. Update CHANGELOG and ledger wording so they name exactly what is carried.
- **N1:** add a flag-on case with an invalid `executor.run` (and one of `executor.stop` / `executor.sessionState`) result asserting the refusal text, so deviation 5 is covered; show the mutation that restores the old condition goes red.
- **N2:** cover deviation 6 on both flags: flag-off `$/progress` during an Orca attempt fails the attempt with the documented text; flag-on, the owner drops the notification (current Rust behavior). Make the code comment state both behaviors accurately, and record the flag-on/flag-off difference in the ledger row and the CHANGELOG line.
- **N3:** remove `PACER_HOST_SOCKET` from `executorEnv` (`src/exec/process.ts`) so executors never inherit the owner socket path, with a test. Write an issue draft at `/Users/vulam/orca/workspaces/pacer/pinfish/.work/issues/owner-bridge-caller-auth.md` (title, problem, evidence, proposal) for authenticating bridge callers beyond same-uid; the coordinator files it.
- **N4:** if cheap, model the owner's hello gate (forwarding before Core is bound is refused) in `test/fixtures/native-owner-relay.ts`; otherwise list the unmodeled behaviors in the fixture's header comment.
- N5–N7: no code change; keep Orca UNVERIFIED live as reported.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`. One cargo command at a time; debug only. Another Rust worker runs at the same time; keep memory use modest. `cargo fmt --all --check`; clippy `-D warnings` and tests for the touched crates; `cargo xtask loc --check`; `bun run typecheck`; the touched and neighbouring Bun tests (`test/plugins-native-owner-call.test.ts`, `test/native-plugin-ops.test.ts`, exec and classifier tests); `git diff --check`. Save mutation logs under `.work/fixtures/wave3-pr4-r1/` in this worktree.

CT-11: rerun the flag-on `runner.check` endpoint launch sandbox once on the fixed head (same steps as the first run, short sandbox id), confirm the launch still goes through the owner, and add a keyless `endpoint.models` call showing the refusal. Temporary sandboxes only, never ports 4317, 11434, 1234, 41343, no real provider endpoints. Tear down and confirm no processes remain.

Commits: Conventional Commits (`fix(plugin-runtime): ...`, `test: ...`), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

## Handoff

Append a "Fix round 1" section to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-handoff.md`: commits, per-finding status, tests and red evidence, checks, live summary, follow-ups, and the updated draft PR text. Report with `orca orchestration worker_done`. Always end with worker_done.

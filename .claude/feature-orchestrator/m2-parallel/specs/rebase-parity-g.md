# Task: owner parity PR G — rebase onto main and apply the review's rebase items

Executor: cursor-agent (default model, frontier tier: authentication code and a multi-PR rebase). No subagents. Never use `git stash` (shared by all worktrees); save patches under `.work/fixtures/parity-g-<what>.patch` instead.

Read and follow the "Build and environment", "Live validation", "Safety" and "Output" sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-g, branch `fix/owner-bridge-caller-auth`, head `ad1c801b1`: five commits `efb1ab4c3..ad1c801b1` on PR B's pre-merge head `693b1b182`.

Inputs:
- Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-review.md (PASS; §4 lists the expected conflicts; findings N1–N7, A1, rulings R-a to R-c).
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-handoff.md; brief `parity-g.md`.
- `main` now has PR B, C (#941), A (#945, sealed owning-call authority), E (runners own their plugins), F (#962, observation generations) and the others since. Read A's and F's ADR 0027 sections before resolving.

## Steps

1. Back up the branch (`git branch backup/parity-g-ad1c801b1 ad1c801b1`), `git fetch origin`, then `git rebase --onto origin/main 693b1b182`. Resolve each conflict keeping both sides' intent:
   - `test/plugins-native-owner-matrix.test.ts`: PR E replaced the I1 probe with a `fixture.sockets()` recorder. Port G's `PACER_HOST_SOCKET_KEY` capture and the `runnerKeys` assertion into it (N3).
   - `CHANGELOG.md`, ADR 0027, `docs/testing/m2-ledger.md`: union, then fix the wording below.
2. **N2.** ADR 0027 must not contradict itself. Merge A's Q1 bullet ("Until the bridge authenticates its callers (#918), a same-user process can reach the resolved key…") with G's "Caller authentication closes the Q1 residual risk" into one bullet: closed by item 9, with the accepted residual. Apply the same to A's CHANGELOG and ledger wording.
3. **N3.** Drop the runner-refusal sentences made stale by PR E (ADR 0027 ~164-167, CHANGELOG "Until task runners own their plugins…"). Keep "no runner inherits the credential".
4. **N4.** When an attached Core's serve restarted, the new owner proves first with its new key and Core rejects it. Give that failure a hint that names both causes: the service restarted, so reconnect; or the socket is not this connection's owner. Correct the ADR's Rotation bullet. Change the TS stand-in in `test/host-bridge-auth.test.ts` to prove with a different key, so the test exercises the real path.
5. **N5.** Adopt the reviewer's probes from `.work/fixtures/parity-g-review/review_limits.rs` into `crates/plugin-runtime/tests/bridge_caller_auth.rs`: the 10 s deadline (make it configurable for the test if that keeps it fast), the 4 KiB auth-line cap and reflection.
6. **A1 (doc).** In the ADR residual, name the item-5 per-user directory as well as `run/`, and list a peer check (Core verifies the owner pid the door hands it) with the follow-ups.
7. **N1 (ledger).** Keep #918 item 3 (executor sandbox profiles must deny reads of `$PACER_HOME/run/` and the per-user directory, and `connect()` to its sockets) as an open, red PR 7 gate row, and say so in the ledger.

Parallel work: PR H (`fix/door-plugin-calls-via-core`, being fixed) rewrites the door's plugin calls in `crates/server/src/native/plugins.rs` and touches `bridge_call.rs`, `registry.ts`, ADR 0027 and the ledger; R1 (#963) edits `bridge_call.rs` near `HELLO_DEADLINE`. Whichever lands later rebases; keep your edits to shared files local.

Required checks: fmt; clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-plugin-host`, `pacer-server`; `xtask loc` and `deps`; typecheck; `test/host-bridge-auth.test.ts`, `test/plugins-native-owner-matrix.test.ts` (I1), the A+G assistant-key e2e (`test/plugins-native-owner-assistant-key.test.ts`), `plugin-conformance-native-owner`, `plugins-native-owner-call`, `serve-plugin-native`, `native-plugin-ops`, `native-plugin-ops-stdio`, and the observation suites from F. Red evidence for the new N4 and N5 tests.

CT-11 on the final head (name the head in the report, N7): flag on and flag off, covering the handshake, a refused peer without the key, the attached-Core reconnect after a serve restart (N4) and one owner call per door. Report, then `live down --keep`.

## Output

Rebased commits plus new commits (signed off, Conventional), not pushed. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-rebase-handoff.md with each conflict resolution, each fix with evidence, checks, CT-11 summary and an updated PR body. The PR body must say `Part of #918`, never `Closes #918`. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rebase-parity-g.md exactly. End with orca orchestration worker_done.

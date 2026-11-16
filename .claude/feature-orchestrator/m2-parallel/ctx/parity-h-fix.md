# Task: owner parity PR H — fix review finding B1 and the cheap nonblocking items

Executor: cursor-agent (default model, frontier tier). No subagents. Never use `git stash` (shared by all worktrees); save patches under `.work/fixtures/parity-h-<what>.patch` instead.

Read and follow the "Build and environment", "Live validation", "Safety" and "Output" sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch `fix/door-plugin-calls-via-core`, head `b13d4dd90` on `main` `30606ef07`.

Inputs:
- Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-review.md (verdict FAIL on B1; N1–N7, nits). The reviewer's probe: `.work/fixtures/parity-h-review/log-probe.test.ts` and `head-log-probe.log`.
- Your handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-handoff.md, brief `parity-h.md`.

## Steps

1. **Rebase** onto `origin/main` (`git fetch origin`; `main` now has #960 and #961; #959 and #962 may land while you work, so rebase again before the final checks if `origin/main` moved). Keep both sides in any conflict.
2. **B1 (fix, blocking).** A failed or timed-out sealed call must keep its call-scoped `capability.log` lines, as flag-off does (`src/plugins/host.ts:159` writes each line on arrival). Carry the call's logs on the bridge error reply (`crates/plugin-runtime/src/bridge_call.rs` `call_sealed` ~350 returns before building `logs`; for example put them in `error.data.logs`). Have `callNativeOwner` (`src/plugins/registry.ts` ~2641) write them on its failure path as well as on success. This covers the serve door, self-owned stdio, attached stdio relays and Core's own owner calls. Turn the reviewer's probe into a conformance row (fixture `callCapability: "log"`, ping delayed past its 5 s deadline): logged on both doors and on Core calls, red on this head before the fix. Keep the change small; R1 (`fix/owner-hello-deadline`, PR #963) edits `bridge_call.rs` near `HELLO_DEADLINE` and `hello_failure`, and PR F (#962) and G edit `registry.ts`, so touch only what B1 needs.
3. **N4 fixture.** Drop `helloDelayMs` and the `input()` wrapper. Use R1's option instead, with exactly R1's text so the two branches merge cleanly. In `conformance/fixtures/plugin.ts`, the `interface Fixture` line starts `interface Fixture { startDelayMs?: number; pingProbe?: ...` (the rest unchanged). Right after `if (fixture.exitAtStart) process.exit(3);` add these two lines:
   `// Reading stdin late delays the answer to \`plugin.hello\`.`
   `if (fixture.startDelayMs) await new Promise<void>(resolve => setTimeout(resolve, fixture.startDelayMs));`
   Check with `git diff origin/fix/owner-hello-deadline -- conformance/fixtures/plugin.ts` (fetch first) that the fixture is identical to R1's.
4. **N3.** Make the delays exceed deadline + margin, so the time bound discriminates on its own: hello and ping 7 s, render 4 s. Keep the 1.5 s margin, or narrow it if your runs allow.
5. **N2.** In the expected-fail crash row, compare `restarts` and accept either flag-off text ("owning plugin call ended" or "plugin.hello passed its … ms deadline"), so the row can't flake when it flips to green.
6. **N7.** Restore an end-to-end assertion of the failing-plugin hint "Enable the plugin through the pacer service." (a Rust door test or a Bun row).
7. **N1 and nits (docs).** Ledger readiness row: name the self-owned stdio connection too, and say this PR introduces the gap on the doors. ADR 0027 and the ledger log sentence: correct after the B1 fix (logs kept on failure too); "records the hello" still holds only for successful calls. Update the PR body accordingly ("this PR causes the readiness row").
8. N5 (ui.action / ui.settings.validate rows) and N6 (retire `spawn_spec`, `call_authority`, `ready` kinds) are follow-ups; list them in the handoff.

Required checks: those in the original brief `parity-h.md`, plus the B1 row red-then-green. CT-11: a focused live run on the final head (flag on) showing a failed door doctor ping keeps its log line in `logs/plugins/<id>.log`, plus one rerun of your earlier door-deadline rows; flag-off reference for the same step. Report, then `live down --keep`.

## Output

New commits (signed off, Conventional), not pushed. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-fix-handoff.md with the rebase result, each fix with red-then-green evidence, checks, CT-11 summary, follow-ups and an updated PR body. Report with `orca orchestration worker_done`. Always end with worker_done.

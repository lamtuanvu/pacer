# Task: final QA verdict for the M2 integration PR

Executor: codex (independent QA reviewer). Read-only: don't start live sessions, don't run cargo builds, don't edit tracked files. You may run `bun .work/fixtures/m2-ledger-check.ts`, `git` commands and file reads.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9 (signed merge of main a8331c6b4 = #869 into 4d11aeb82). Read `.project/constitution.md` and the CT-* and REPO-10 rules, `docs/testing/live-validation.md`, and your earlier `.work/reviews/m2-integration-qa-review.md`. That earlier review was UNVERIFIED. It holds the behavior → live matrix; re-decide each of its rows.

Evidence since then, in `.work/reviews/`:
- Live replays:
  - `live-replay-replay-ops.md`, `-ops-rest.md` and `-send.md` (at 4d11aeb82);
  - `-setup.md` and `-setup-http.md` (at 4d11aeb82);
  - `-msg.md` and `-split.md` (at f5168b0f9; read the coordinator addendum in `-split.md`).
- Diagnosis:
  - `m2-integration-candidates-cli.md`: pre-existing 15 s CLI deadline race.
  - `m2-integration-focus-baseline.md`.
- Code review of the sync: `m2-integration-review-sync2.md` (PASS).
- Harness session reports under `.work/live/<session>/evidence/report.md`.

Coordinator positions to verify, not to accept blindly:
1. Evidence from 4d11aeb82 stays valid at f5168b0f9 outside messaging. Check this with `git diff --stat 4d11aeb82 f5168b0f9`: the runtime changes should be limited to messaging (crates/messaging-ops, crates/store messages, the msg answer paths in serve/mod.rs and stdio_proxy.rs) plus the live harness. If anything else runtime-relevant changed, name it and the replay rows it invalidates.
2. replay-msg: the first session's failures come from the pre-existing waiting-session fixture being swept about 12 s after startup ("cannot resume: executor codex is no longer configured"). This was reproduced on clean main a8331c6b4, as recorded in `.claude/feature-orchestrator/m2-parallel/notes/followups.md`. The recheck session counts as the evidence.
3. The executor.setup.candidates CLI failure is a pre-existing deadline race (same 15 s timeouts on main); HTTP and web pass.
4. Messaging over stdio has no live fixture; the parity tests cover it.
5. `/v2` equality stays UNVERIFIED, as on the source branch.

Decide one overall QA verdict: PASS, FAIL or UNVERIFIED. Maintainer exceptions don't block PASS when they are disclosed: the desktop app, real executors, op-specific stdio beyond fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install, and VoiceOver (waived).

Write `.work/reviews/m2-integration-qa-final.md` with:
- the verdict on the first line;
- the re-decided matrix: row, evidence (session and report), revision, verdict;
- the positions you confirm or reject;
- introduced defects separate from pre-existing ones;
- the remaining UNVERIFIED items and PR disclosures.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

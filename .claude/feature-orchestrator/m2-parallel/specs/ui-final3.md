# Task: third final UI and accessibility verdict for the M2 integration PR

Executor: cursor-agent (independent UI reviewer). Read-only: don't start live sessions, don't run builds, don't edit tracked files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 3c5a87dc3. Since fff6b18b7 the head adds two docs-only commits (check `git diff --stat fff6b18b7 3c5a87dc3`): 3a84c194a records a maintainer exception in `.project/decisions.md`, and 3c5a87dc3 adds CHANGELOG entries and the task `work` field to the protocol docs. The app and desktop code are unchanged since your previous verdict.

Your previous verdict, `.work/reviews/m2-integration-ui-final-verdict2.md`, was UNVERIFIED with three open items. Re-decide each:
1. Board Retry and Open task fallback CT-11 harness rows: see `.work/reviews/m2-integration-ui-gap-u1-board.md` (rows B1, B2; sessions u1b-rust and u1b-ts; their `.work/live/<session>/evidence/report.md`).
2. U-1 stale tray Retry window and second press: same report, rows U1a-U1d (classified pre-existing Core timing at `src/link/pump.ts`; second press an idempotent 200 replay with no new attempt or task). Verify the classification against the code and the measurements; don't accept it blindly.
3. Native desktop rows (notification Answer for managed questions, native `tray_open` T1/T3/T4/T5): the maintainer granted a PR #870-only UI-24 exception on 2026-11-11, recorded as the last row of the exceptions table in `.project/decisions.md`. Check that the row's scope matches exactly the rows you listed.

Also keep in force: I-1 (Answer panel footer error as a narrow column at 1440) is introduced, low severity and advisory; the maintainer chose to disclose it in the PR and file a follow-up. Pre-existing focus-loss patterns (T2, W2, W4, board Retry) are disclosed follow-ups. VoiceOver is waived under VO-TEMP-2026-10 through 2026-11-22.

Rules: .project/constitution.md, `.project/rules/ui.md` (UI-2, UI-13, UI-15, UI-18, UI-24 and the UI review readiness procedure), `.project/reviewers/ui-accessibility.md`, and the `pacer-ui-evidence` manifest in `.github/pull_request_template.md`.

Decide one overall verdict for the UI evidence manifest: PASS, FAIL or UNVERIFIED. Write `.work/reviews/m2-integration-ui-final-verdict3.md` with:
- the overall verdict on the first line;
- the open-item table: item, evidence, closed or open, reason;
- introduced defects separate from pre-existing ones;
- the exact disclosures the PR body must carry (UNVERIFIED rows with reasons, the exception, I-1, pre-existing follow-ups).

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

# Task: second final UI and accessibility verdict for the M2 integration PR

Executor: cursor-agent (independent UI reviewer). Read-only: don't start live sessions, don't run builds, don't edit tracked files. Read every report listed below before deciding.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head fff6b18b7. fff6b18b7 adds only test changes on top of f5168b0f9 (check with `git diff --stat f5168b0f9 fff6b18b7`); the app is unchanged since 4d11aeb82 (`git diff 4d11aeb82 HEAD -- app/`). Base is main a8331c6b4. App changes against main: `git diff a8331c6b4 HEAD --stat -- app/src`. Rules: .project/constitution.md and `.project/rules/` UI-*, specifically UI-2, UI-15, UI-18, UI-24, and the PR template's `pacer-ui-evidence` manifest in .github/.

Your previous verdict, `.work/reviews/m2-integration-ui-final-verdict.md`, was UNVERIFIED. Its blocking gaps were: unobscured Trace and workspace result images; tray destinations and settled focus; missing traversal, activation, focus and contrast measurements; SideDialog fallback focus target and focus appearance; async busy and error lifecycles; right-panel scroll; harness summaries with no PASS rows.

New evidence in `.work/reviews/`:
- `m2-integration-ui-gap-tray.md` and `ui-gap-tray/`: tray T1-T7 at 340 px, light and dark, head against base a8331c6b4.
- `m2-integration-ui-gap-web.md` and its evidence folder: web W1-W6 at 1440 light and dark and 375, head and base.
- The harness session reports those two files cite (`.work/live/<session>/evidence/report.md`).

Coordinator positions to verify, not to accept blindly:
1. The right-panel scroll CSS is main's own change, not this branch's: `git diff a8331c6b4 HEAD -- app/src '*.css'` should show only the `.sr-only` rule moving from styles.css to ds/components.css with identical values.
2. Tray T-row FAIL (focus to BODY when the retried row disappears 11-13 s later) and web W2/W4 FAILs (focus to BODY or ring-less MAIN#main-content) are pre-existing because base shows the same. W2 is newly reachable for managed answers, which base refused with 403; decide whether that makes it introduced or a disclosed pre-existing pattern, with reasons.
3. Native desktop handling of `tray_open` is the desktop-app maintainer exception.
4. VoiceOver is waived under VO-TEMP-2026-10 through 2026-11-22.
5. WorkView (`TaskRoute`), the itemActions `dispatch.answer` branch and the standalone `NeedsYouList` are unreachable on base and head; component fixtures cover them.

Decide one overall verdict: PASS, FAIL or UNVERIFIED. PASS requires that every changed, reachable UI surface has UI-18 screenshots (1440 light and dark, 375, tray 340 where relevant), keyboard and focus evidence, and contrast evidence, with no introduced defect open. Every previous blocking gap must have a row: closed (with evidence path), still open, or not applicable (with reason).

Write `.work/reviews/m2-integration-ui-final-verdict2.md` with:
- the overall verdict on the first line;
- the per-file table (surface, evidence, verdict, gap);
- the previous-gap table;
- the positions you confirm or reject, with reasons;
- introduced defects separate from pre-existing ones;
- remaining UNVERIFIED items and PR disclosures.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

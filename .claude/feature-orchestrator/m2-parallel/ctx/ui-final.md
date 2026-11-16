# Task: final UI and accessibility verdict for the M2 integration PR

Executor: codex (independent UI reviewer). Read-only: don't start live sessions or edit tracked files. Read every report listed below before deciding.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9 (the app is unchanged since 4d11aeb82; check with `git diff 4d11aeb82 HEAD -- app/`). Base is main a8331c6b4. App changes against main: `git diff a8331c6b4 HEAD --stat -- app/src` (11 files). Rules: read .project/constitution.md and `.project/rules/` for UI-*, specifically UI-2, UI-15, UI-18, UI-24, and the PR template's `pacer-ui-evidence` manifest in .github/.

Reports in `.work/reviews/`:
- m2-integration-ui-review.md, -ui-review-final.md, -ui-visual.md, -ui-images-a.md, -ui-images-b.md;
- -ui-contrast.md, -ui-keyboard.md, -ui-kb-fixture.md, -ui-kb-live-a.md, -ui-kb-live-b.md;
- -focus-baseline.md, -ui-kb-dispatch.md, -ui-kb-dispatch2.md;
- the screenshots under ui-review-int/ (shots/INDEX.md, matrix/) and kb-dispatch2/.

Coordinator dispositions to verify, not to accept blindly:
1. Focus moves to BODY after successful Trace Accept and Reject, workspace Retry task, and board Retry. focus-baseline shows the same on main 445241520 for the first three. Board Retry with the op present renders the same ActionButton as main; only the missing-op fallback is new. These are classed pre-existing, disclosed, and tracked as a follow-up.
2. kb-dispatch FAIL came from a wrong brief premise: `#/needs-you` is NeedsYou.tsx and is unchanged. kb-dispatch2 covers the reachable changed controls.
3. The `itemActions` `dispatch.answer` branch and the standalone `NeedsYouList` (actions=2) are not rendered by any route, so they can't be exercised live. WorkView (`TaskRoute`) is unreachable on base and head, so it's covered only by component fixtures.
4. Trace and workspace dialog Close, Cancel, radio and note rows in kb-live-b stay UNVERIFIED. Those dialog components are unchanged by this branch (confirm with git diff).
5. VoiceOver is waived under VO-TEMP-2026-10 through 2026-11-22.
6. Known pre-existing and out of scope: tray board/footer browser tests, and the mobile "Ask pacer" overlap with the bottom nav.

Decide one overall verdict for the UI evidence manifest: PASS, FAIL or UNVERIFIED. PASS requires that every changed, reachable UI surface has UI-18 screenshots (1440 light and dark, 375, tray 340 where relevant), keyboard and focus evidence, and contrast evidence, with no introduced defect open. For each changed file, give the surface, its evidence, its verdict and any gap. List the introduced defects (if any) separately from the pre-existing ones.

Write `.work/reviews/m2-integration-ui-final-verdict.md` with:
- the overall verdict on the first line;
- the per-file table;
- the dispositions you confirm or reject, with reasons;
- the remaining UNVERIFIED items;
- disclosures for the PR.

Report with orca orchestration worker_done. Always end with worker_done.

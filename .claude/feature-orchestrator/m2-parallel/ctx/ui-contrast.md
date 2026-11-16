# Independent UI review: remaining contrast, focus boundary and reduced motion

You are an independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md); you did not write this code. Do not change tracked files. Executor: codex. No time limit. This is a SMALL task: every item listed must have an entry before you report.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base 445241520. The 11 changed app files: `git diff 445241520 HEAD -- app/`. Prior partial reviews (reuse; do not redo): .work/reviews/m2-integration-ui-review-final.md, .work/reviews/m2-integration-ui-visual.md. Screenshots and geometry JSON: .work/reviews/ui-review-int/shots/ (INDEX.md describes each). No live session, no cargo. Run anything under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh and disposable HOME. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports.

## Task (headless Chrome via the existing fixtures: test/fixtures/ui/*.tsx and the scripts .work/ui-visual-work-check.ts and the matrix check referenced in the prior reports)
Measure in light AND dark, recording computed colors, effective backgrounds and ratios, for each of these (one row each):
1. AnswerPanel: disabled Send (text/background; note WCAG exempts disabled controls from 1.4.3 but record it), the missing-answer explanation, Send focus ring — measure the actual outline boundary: outline color vs the surface immediately outside the outline (given outline-offset) and vs the button fill; decide pass/fail against WCAG 2.4.11/1.4.11 (3:1 against adjacent colors) and UI-2.
2. Tray: Answer button and Open task fallback (text and focus ring).
3. Dispatch: each managed action control changed in Dispatch.tsx (text and focus ring).
4. WorkView: Details, Accept, Reject, Answer and resume, Stop work focus rings (text already measured for the reason).
5. SideDialog fallback focus target: its focus indicator.
Reduced motion: for items 1, 2, 3 and 5 compare computed transition/animation durations under prefers-reduced-motion no-preference vs reduce.

Write .work/reviews/m2-integration-ui-contrast.md: tables, findings with severity/rule/remedy, verdict PASS/FAIL/UNVERIFIED. Report with orca orchestration worker_done. Always end with worker_done.

# Independent UI review part: visual adjudication, contrast and reduced motion (no live session)

You are an independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md); you did not write this code. Do not change tracked files. Executor: codex. No time limit; complete all three sections before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base 445241520. Read .work/reviews/m2-integration-ui-review-final.md (prior partial review; reuse its evidence, do not redo it) and .work/reviews/ui-review-int/shots/INDEX.md.

Out of scope: right-panel scrolling — `git diff --stat 445241520 HEAD -- app/src/shell/panels/` is empty, so it is main's unchanged behavior; WorkView's route (pre-existing unrouted; component evidence only).

## 1. Visual adjudication (UI-18)
Open EVERY image listed in shots/INDEX.md at full size (not contact sheets). For each base→head pair, list each visible difference and classify: intended (cite the diff hunk in one of the 11 app files), fixture/state noise (explain), or defect (rule ID). For each geometry JSON candidate intersection/clip, open the image and decide real issue vs offscreen/overlay artifact. Table: image, differences, classification.

## 2. Contrast for every changed control
Enumerate every control/text element added or restyled in the 11-file diff (`git diff 445241520 HEAD -- app/`): AnswerPanel missing-answer explanation and disabled Send, Tray Open task fallbacks and retry/answer buttons, Dispatch managed actions, WorkView reason text and buttons, SideDialog focus target. Measure text/background (4.5:1, 3:1 large) and focus-indicator/adjacent (3:1, UI-2/WCAG 1.4.11) in light and dark using computed styles in a headless browser via the existing fixtures (test/fixtures/ui/*.tsx, the matrix check script referenced in the prior report). Resolve the prior note about the Send answer focus ring (2.64/1.73 against the button fill) by measuring the actual ring boundary against both the fill and the surrounding surface.

## 3. Reduced motion
For each changed element, compare computed transition/animation under prefers-reduced-motion: no-preference vs reduce; any non-essential motion must stop under reduce.

Run under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, TZ=Asia/Ho_Chi_Minh, disposable HOME. No cargo, no live session. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports.

Write .work/reviews/m2-integration-ui-visual.md: base/head, the three tables, findings with severity/rule/remedy, per-section verdict PASS/FAIL/UNVERIFIED. Report with orca orchestration worker_done. Always end with worker_done.

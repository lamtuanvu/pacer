# Independent UI review: keyboard and focus — WorkView and SideDialog (component fixtures, no live)

You are an independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md); you did not write this code. Do not change tracked files. Executor: codex. No time limit. SMALL task: every row listed must have an observation before you report.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base 445241520. Changed app files: `git diff 445241520 HEAD -- app/`. Prior partial keyboard evidence (reuse, do not redo): .work/reviews/m2-integration-ui-review-final.md and .work/reviews/m2-integration-ui-keyboard.md.

Method: write an UNTRACKED probe script under .work/ (headless Chrome via the same tooling the repo's *browser*.test.ts files use, or Playwright if already available) that, for each control, presses Tab/Shift+Tab from a known start, records document.activeElement (role, accessible name, aria-describedby and the referenced text), whether :focus-visible matches and the computed outline, then presses Enter and Space (buttons) and Escape (dialogs) and records the result (network request, dialog open/closed, where focus lands). Save JSON and one screenshot per focused control. A row is PASS only with recorded evidence.

Run under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh and disposable HOME. No cargo. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Stop everything you start.

## Rows
Rows: WorkView (test/fixtures/ui/work-focus-browser.tsx; drive it as test/*work*browser*.test.ts* does) connected AND disconnected: Details, Accept, Reject, Answer and resume (textarea + button), Stop work — order, focus-visible, Enter/Space, and when disconnected the reason `<p id>` referenced by each button's aria-describedby. SideDialog (app/src/ds/SideDialog.tsx; use or minimally mount it in an untracked fixture like the existing ds browser fixtures): open from a button, Escape → focus returns to the opener; open, remove the opener from the DOM, close → focus lands on the fallbackFocusId element; Tab cycles inside the dialog (cycleDialogFocus).

Write .work/reviews/m2-integration-ui-kb-fixture.md: table row per control with evidence paths, findings with severity/rule/remedy, verdict PASS/FAIL/UNVERIFIED. Report with orca orchestration worker_done. Always end with worker_done.

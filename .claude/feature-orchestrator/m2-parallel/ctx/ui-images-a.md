# Independent UI review: screenshot adjudication batch A

You are an independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md); you did not write this code. Do not change tracked files. Executor: codex. No time limit. This is a SMALL task: every item listed must have an entry before you report.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base 445241520. The 11 changed app files: `git diff 445241520 HEAD -- app/`. Prior partial reviews (reuse; do not redo): .work/reviews/m2-integration-ui-review-final.md, .work/reviews/m2-integration-ui-visual.md. Screenshots and geometry JSON: .work/reviews/ui-review-int/shots/ (INDEX.md describes each). No live session, no cargo. Run anything under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh and disposable HOME. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports.

## Task
For EACH pair below, open BOTH images at full size (use your image viewing tool on the .png file itself, not a contact sheet) and the matching .json geometry files. For each pair write one table row: visible differences base→head; classification of each difference as intended (cite the diff hunk file and line), fixture/state noise (explain), or defect (UI rule ID + severity); and each geometry-JSON candidate intersection/clip adjudicated as real or offscreen/overlay artifact (look at the image).

Pairs (base-X ↔ head-X):
- answer-1440-dark
- answer-1440-light
- answer-375-light
- dispatch-1440-dark
- dispatch-1440-light
- dispatch-375-light
- tray-failed-340-dark
- tray-failed-340-light
- tray-question-340-dark
- tray-question-340-light
Head-only (no base pair; judge each alone): head-answer-missing-1440-dark, head-answer-missing-1440-light, head-answer-missing-375-light, head-tray-missing-answer-340-dark, head-tray-missing-answer-340-light.

Write .work/reviews/m2-integration-ui-images-a.md with the table and a verdict PASS/FAIL/UNVERIFIED for this batch. Report with orca orchestration worker_done. Always end with worker_done.

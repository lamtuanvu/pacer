# Independent UI review: keyboard and focus — Needs-you answer panel and tray (live)

You are an independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md); you did not write this code. Do not change tracked files. Executor: codex. No time limit. SMALL task: every row listed must have an observation before you report.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base 445241520. Changed app files: `git diff 445241520 HEAD -- app/`. Prior partial keyboard evidence (reuse, do not redo): .work/reviews/m2-integration-ui-review-final.md and .work/reviews/m2-integration-ui-keyboard.md.

Method: write an UNTRACKED probe script under .work/ (headless Chrome via the same tooling the repo's *browser*.test.ts files use, or Playwright if already available) that, for each control, presses Tab/Shift+Tab from a known start, records document.activeElement (role, accessible name, aria-describedby and the referenced text), whether :focus-visible matches and the computed outline, then presses Enter and Space (buttons) and Escape (dialogs) and records the result (network request, dialog open/closed, where focus lands). Save JSON and one screenshot per focused control. A row is PASS only with recorded evidence.

Run under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh and disposable HOME. No cargo. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Stop everything you start.

## Rows
Live: `bun run live up --seed ui --front-door rust --native-test-ops`, id prefix kb-a-, seed the same managed fixtures and missing-op proxies as session ui-a11y-final (see .work/reviews/m2-integration-ui-review-final.md and its evidence). Login URL: open once in the probe browser; if expired, go to /app/#/settings. Clean tree and HEAD 4d11aeb82 first. One session; other workers run their own sessions — never stop theirs.
Rows: Needs-you list Answer opener; answer panel: every focusable control in order (textarea, Send, Close, Open session/links), Send via Enter and via Space (dispatch.answer 200), Escape and Close → focus to opener; missing-answer proxy: explanation text, Send disabled and its aria-describedby/explanation association, Tab still reaches Close and the explanation context. Tray at 340 px: each managed row and its Retry / Answer / Open task controls, Enter and Space, focus after action; with missing-retry and missing-answer proxies, Open task reachable and activates.

Write .work/reviews/m2-integration-ui-kb-live-a.md: table row per control with evidence paths, findings with severity/rule/remedy, verdict PASS/FAIL/UNVERIFIED. Report with orca orchestration worker_done. Always end with worker_done.

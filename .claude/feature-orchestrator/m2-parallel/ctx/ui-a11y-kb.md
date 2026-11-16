# Independent UI review part: keyboard and focus matrix (live)

You are an independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md); you did not write this code. Do not change tracked files. Executor: codex. No time limit; every row of the matrix must have an observation before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82. Read .work/reviews/m2-integration-ui-review-final.md (prior partial review: answer panel Enter/Escape/Close focus return and tray Space retry already observed — reuse, extend, don't repeat) and its session ui-a11y-final evidence for setup (seed, missing-op proxies, cargo no-op shim).

Head session: `bun run live up --seed ui --front-door rust --native-test-ops`, id `ui-kb-`, Orca's built-in browser with an isolated profile, same seeded managed fixtures and missing-op proxies as ui-a11y-final. One session at a time; clean tree and HEAD 4d11aeb82 first.

## Matrix (one row per control; columns: Tab reaches it in logical order, :focus-visible indicator visible (screenshot), Enter activates, Space activates (buttons), Escape behavior where a dialog/panel is open, focus after action/close)
- Needs-you: Answer opener; answer panel textarea, Send, Close, any other panel controls; disabled Send with missing-answer explanation (the explanation must be announced via aria-describedby or adjacent text — record the DOM).
- Tray (340 px): each managed row, Retry, Answer, Open task fallback (missing retry and missing answer proxies).
- Dispatch: every managed work action control.
- Task page (`#/tasks/<id>`, Trace): task actions using useResultAction (retry/review buttons) and their dialogs, focus return after submit and after Escape.
- Workspace task result: Retry and its dialog (Space, Escape, focus return — the prior review did Enter only).
- WorkView at component level via test/fixtures/ui/work-focus-browser.tsx (connected and disconnected): Details, Accept, Reject, Answer and resume, Stop work, with the reason `<p id>` and aria-describedby.
- SideDialog: open from an element that is then removed, confirm focus goes to the fallbackFocusId target (the new behavior), and normal return otherwise.

Maintainer exceptions (desktop app, real executors, screen-reader speech, D3/D8 effects, Updates Install, PACER_FORWARD_OPS, op-specific stdio) stay UNVERIFIED and do not by themselves withhold PASS. Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. No cargo. Stop everything you start.

Write .work/reviews/m2-integration-ui-keyboard.md: base/head, session id/report, the matrix with evidence paths, findings with severity/rule/remedy, verdict PASS/FAIL/UNVERIFIED for the keyboard/focus scope. Report with orca orchestration worker_done. Always end with worker_done.

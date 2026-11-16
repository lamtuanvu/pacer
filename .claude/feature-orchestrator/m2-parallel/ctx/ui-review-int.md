# Independent UI/accessibility review: m2/integration PR

You are the independent UI/accessibility reviewer (.project/reviewers/ui-accessibility.md). You did not write this code. Review and report; do not change tracked files. Executor: codex. No time limit; finish every check before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 4d11aeb82, base origin/main 445241520. Read .project/rules/ui.md (UI-1..UI-25), .project/reviewers/ui-accessibility.md, docs/testing/live-validation.md.

## Scope
`git diff --stat 445241520 HEAD -- app/` (11 files: ds/SideDialog.tsx, ds/components.css, screens/dispatch/Dispatch.tsx, screens/needs-you/AnswerPanel.tsx, screens/review/ResultPage.tsx, screens/task-shared.tsx, screens/work/WorkView.tsx, styles.css, tray/Tray.tsx, tray/main.tsx, tray/model.ts). These come from the managed-work action change (source branch fix/managed-work-actions 18d289925, whose last UI review was PASS: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions/.work/reviews/2026-11-10-fix-managed-work-actions-ui-review8.md) now merged with main's right-panel scroll rule and model-settings screens. Read ui-review5..8 there and reuse their matrix, fixtures and capture scripts (`.work/` in that worktree: capture-managed-*.ts, ui-review5-matrix, sessions managed-ui-final-08731, managed-ui-matrix-e0324c45-final, managed-visible-final, managed-missing-op).

## Required checks
1. Line-by-line review of the 11 app files against UI rules (design system use, tokens, focus, roles/labels, disabled/hidden action semantics, copy).
2. **Full managed-work geometry and responsive matrix** at this head (this is the part post-sync live left UNVERIFIED): Work view, Dispatch, Needs-you answer panel, Review result page, side dialog, tray — including managed rows with each action available/missing (missing dispatch.retry / dispatch.answer filter proxies), and main's right-panel scroll.
3. **UI-18 screenshots**: before (origin/main 445241520) and after (this head) of each changed screen at 1440 light and dark, 375, and the tray at 340. For "before", use a scratch detached worktree of 445241520 served without a cargo build if the live harness supports a TypeScript front door; otherwise reuse the before set from the source branch reviews (state which, and that main's only app delta since is the right-panel scroll and model settings). Store under .work/reviews/ui-review-int/ (untracked).
4. Keyboard and focus order, visible focus, Escape/close behavior of the side dialog and answer panel; contrast (light/dark) and reduced-motion for changed elements.
5. Run `bun run ui:check` and any app tests touching the changed files (search test/ and app/ for their names) under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh.

## Rules
- Live: `bun run live up --front-door rust --native-test-ops` (target/debug/pacer is already built; do not cargo clean or rebuild other feature sets). Session ids prefixed `ui-int-`. One session at a time (memory pressure). Orca's built-in browser, isolated profile per session. Login URL: open once; if expired, go to /app/#/settings (pre-existing Orca double request).
- Confirm `git status --short` is clean and HEAD is 4d11aeb82 before each session.
- Maintainer exceptions (recorded, disclosed as UNVERIFIED in the PR, and not by themselves grounds to withhold PASS for in-scope surfaces): desktop app, real executors, op-specific stdio beyond fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install, actual screen-reader speech. Failures reproduced on clean origin/main are pre-existing (cite evidence), not introduced.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Stop every session, tab and profile you start.

Write .work/reviews/m2-integration-ui-review.md: reviewed base/head, governance version (.project/constitution.md), scope and rule IDs, checks with evidence paths, screenshot index, findings with severity/rule/remedy, PASS/FAIL/UNVERIFIED per surface, overall verdict. Report with orca orchestration worker_done. Always end with worker_done.

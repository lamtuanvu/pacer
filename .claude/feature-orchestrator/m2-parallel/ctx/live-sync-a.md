# Task: post-sync live validation, part A (web surfaces)

Executor: codex. No time limit; finish every surface before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 3c483c420. This is the combined PR of eight M2 branches, now merged with origin/main (#858–#866). Replay your surfaces at this exact head with a clean tree (CT-11), following docs/testing/live-validation.md. Read .work/reviews/m2-integration-handoff.md (sections "Phase B" and "Sync with main") and the earlier web report .work/reviews/live-live-web.md.

## Your surfaces (finish all)
1. **Managed-work geometry and missing-op filter proxies** (geometry assertions; a missing dispatch.retry; the tray missing-answer filter). References in /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions: the latest ui-review report under .work/reviews/, and kept sessions under .work/live/: managed-ui-final-08731, managed-ui-matrix-e0324c45-final, managed-visible-final, managed-missing-op. Reuse their fixtures and proxy setup. Main added a right-panel scroll rule (app/src/styles.css, app/src/shell/panels/work-panels.css); confirm the managed-work panel still lays out and scrolls.
2. **Tray retry and the tray/Needs-you answer lifecycle**, from m2-dispatch-ops session m2-lifecycle-web4 (report: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops/.work/live/m2-lifecycle-web4/evidence/report.md).
3. **Same-revision task.get.** For a human-origin managed task after task.retry, read task.get through the guarded CLI API and HTTP at the same task revision with no runner activity between (stop the fixture runner or read immediately). Compare `rev` in both replies; both must show the same `work`, including `userStarted`.
4. **Main's web surfaces on the integrated build:** Settings → executor models / dispatcher model choice (#858/#860: `runner.models.get/set`, forwarded to TypeScript) — view and change a model for a fixture executor and confirm it persists; the trace Overview cost display (#859 cost projection) on a fixture task; and incremental task updates in the task list over SSE (a task state change appears without reload).

Login note: Orca's built-in browser requests the single-use login URL twice; the second gets 403. Pre-existing on main (/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/login-baseline.md). Open it once; if you land on the expired page, go to /app/#/settings. Not a failure.

## Rules
- Session ids prefixed `live-sync-a-`. Always start with `bun run live up --front-door rust --native-test-ops` plus surface options (--local-model-ports / --local-model-fixture where needed). Never cargo clean, never delete target/, don't build other feature sets.
- Before each session confirm `git status --short` is clean and HEAD is 3c483c420. Do not edit or commit. If a surface fails, gather evidence (logs, request/response, report) and report it; do not fix it.
- Web checks in Orca's built-in browser, a new isolated profile per session. Capture screenshots for each web surface into the session evidence dir (needed for the PR's UI evidence).
- Maintainer exceptions stay UNVERIFIED; do not exercise: op-specific stdio beyond the fixed fixtures, the desktop app, PACER_FORWARD_OPS override, D3/D8-guarded effects, Updates Install, real executors.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.
- Memory pressure: one session at a time. An independent reviewer is reading this worktree concurrently (no cargo); that's fine.
- Stop every session, proxy, fixture, tab and profile when done.

Write .work/reviews/live-live-sync-a.md: head; each session id, report path and Summary line; a surface → result → evidence table; failures with evidence; UNVERIFIED items with reasons; screenshot paths; cleanup. Report with orca orchestration worker_done covering the Summary lines, failures and UNVERIFIED items. Always end with worker_done.

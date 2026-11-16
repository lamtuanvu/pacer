# Task: final-head live validation, live-web2

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 8156b69a0. This is the combined PR of eight M2 branches. Each branch passed live validation on its own base. Your job is to replay your assigned surfaces at this exact head with a clean tree (CT-11), following docs/testing/live-validation.md. Read .work/reviews/m2-integration-handoff.md (the Phase B section lists what is still UNVERIFIED). Use the original brief for each branch's final live session: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md has the table of source worktrees and session names. Read those reports in each source worktree's .work/live/<session>/evidence/report.md and reuse their scenarios, fixtures and options.

## Your surfaces
The head is now 8156b69a0, which adds only a test on top of 0835c8003, so runtime is unchanged. An earlier web worker (.work/reviews/live-live-web.md) already passed managed review, retry and answer, the CLI user retry, split HTTP reads and SSE. Do not redo those. Do these, and finish all of them before reporting:
1. **Managed-work geometry and missing-op filter proxies** (geometry assertions; a missing dispatch.retry; the tray missing-answer filter). The source geometry session was not kept. Use as references:
   - fix-managed-work-actions' final UI review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions/.work/reviews/ (the latest ui-review report);
   - its kept sessions in that worktree's .work/live/: managed-ui-final-08731, managed-ui-matrix-e0324c45-final, managed-visible-final, managed-missing-op.
   Reuse their fixtures and proxy setup.
2. **Tray retry, and the tray/Needs-you answer lifecycle,** from m2-dispatch-ops session m2-lifecycle-web4 (report in /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops/.work/live/m2-lifecycle-web4/evidence/report.md).
3. **Same-revision task.get.** For a human-origin managed task after task.retry, read task.get through the guarded CLI API and through HTTP at the same task revision, with no runner activity in between. Check `rev` in both replies, and either stop the fixture runner or read immediately. Both must show the same `work`, including userStarted. An earlier "failure" came from comparing revision 4 with revision 6, after the fixture runner removed the work node.

Login note: Orca's built-in browser navigation requests the single-use login URL twice; the second request gets 403. This is pre-existing on main (see /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/login-baseline.md). Open the login URL once. If you land on the expired page, go to /app/#/settings to recover the session. Do not report it as a failure.
## Rules
- No other live worker is using this worktree now. Use your own session ids prefixed 'live-web2-'. Always start sessions with `bun run live up --front-door rust --native-test-ops` plus any surface-specific options such as --local-model-ports or --local-model-fixture, so every worker builds the same target/debug/pacer. Cargo's lock serializes the first build. Never run cargo clean, never delete target/, and do not build other feature sets.
- Before each session, confirm that `git status --short` is clean and that HEAD is 8156b69a0. Do not edit or commit anything. If a surface fails, gather evidence (logs, the request and response, the report) and report it. Do not fix it.
- Do web checks in Orca's built-in browser, with a new isolated profile per session.
- These maintainer exceptions stay UNVERIFIED, so do not exercise them: op-specific stdio beyond the fixed fixtures, the desktop app, the PACER_FORWARD_OPS override, D3/D8-guarded effects, the Updates Install control, and real executors.
- Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports.
- The machine is under memory pressure, so run one session at a time.
- Stop every session, proxy, fixture, tab and profile when done.

Write .work/reviews/live-live-web2.md. Include the head; each session id, report path and Summary line; a table mapping each surface to its result and evidence; any failures with evidence; the UNVERIFIED items with reasons; and cleanup. Report with orca orchestration worker_done covering the Summary lines, failures and UNVERIFIED items. Always end with worker_done.

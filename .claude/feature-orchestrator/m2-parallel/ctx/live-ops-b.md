# Task: final-head live validation, live-ops-b

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 0835c8003. This is the combined PR of eight M2 branches. Each branch passed live validation on its own base. Your job is to replay your assigned surfaces at this exact head with a clean tree (CT-11), following docs/testing/live-validation.md. Read .work/reviews/m2-integration-handoff.md (the Phase B section lists what is still UNVERIFIED). Use the original brief for each branch's final live session: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md has the table of source worktrees and session names. Read those reports in each source worktree's .work/live/<session>/evidence/report.md and reuse their scenarios, fixtures and options.

## Your surfaces
An earlier worker (report .work/reviews/live-live-ops.md) already passed task.send delivery, the driving lease race and the HTTP runner.check. Do not redo those. Do these, and finish all of them before reporting:
- **The remaining runner ops.** Use m2-runner-ops's live report runner-check-web6 for the list and scenarios.
- **The web runner check in Orca's built-in browser.** The earlier worker's web login bounced back to sign-in. Sign in through the harness's documented web login flow (see docs/testing/live-validation.md for the app cookie and login, and how runner-check-web6 did it). If the bounce reproduces, capture the evidence and check whether it also happens on the source branch's session flow. Report it as a finding only if the integration causes it.
- **task.send task-record lock races.** Use m2-task-send's report m2-send-r4 for the scenario.
## Rules
- Three other live workers share this worktree. Use your own session ids prefixed 'live-ops-b-'. Always start sessions with `bun run live up --front-door rust --native-test-ops` plus any surface-specific options such as --local-model-ports or --local-model-fixture, so every worker builds the same target/debug/pacer. Cargo's lock serializes the first build. Never run cargo clean, never delete target/, and do not build other feature sets.
- Before each session, confirm that `git status --short` is clean and that HEAD is 0835c8003. Do not edit or commit anything. If a surface fails, gather evidence (logs, the request and response, the report) and report it. Do not fix it.
- Do web checks in Orca's built-in browser, with a new isolated profile per session.
- These maintainer exceptions stay UNVERIFIED, so do not exercise them: op-specific stdio beyond the fixed fixtures, the desktop app, the PACER_FORWARD_OPS override, D3/D8-guarded effects, the Updates Install control, and real executors.
- Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports.
- The machine is under memory pressure, so run one session at a time.
- Stop every session, proxy, fixture, tab and profile when done.

Write .work/reviews/live-live-ops-b.md. Include the head; each session id, report path and Summary line; a table mapping each surface to its result and evidence; any failures with evidence; the UNVERIFIED items with reasons; and cleanup. Report with orca orchestration worker_done covering the Summary lines, failures and UNVERIFIED items. Always end with worker_done.

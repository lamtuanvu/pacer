# Task: final-head live validation, live-web

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 0835c8003. This is the combined PR of eight M2 branches. Each branch passed live validation on its own base. Your job is to replay your assigned surfaces at this exact head with a clean tree (CT-11), following docs/testing/live-validation.md. Read .work/reviews/m2-integration-handoff.md (the Phase B section lists what is still UNVERIFIED). Use the original brief for each branch's final live session: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md has the table of source worktrees and session names. Read those reports in each source worktree's .work/live/<session>/evidence/report.md and reuse their scenarios, fixtures and options.

## Your surfaces
- managed-work actions in the web UI: complete geometry checks and the missing-op filter proxies, as in fix-managed-work-actions session managed-geometry-18d28992;
- the dispatch lifecycle in the web UI and API: answer, plus the other lifecycle scenarios from m2-dispatch-ops session m2-lifecycle-web4;
- task detail after 0835c8003: a managed task's detail keeps the enriched work field, and userStarted is preserved after a user retry (see test/messaging-user-retry.test.ts for the scenario), checked via API and in the web UI.

## Rules
- Three other live workers share this worktree. Use your own session ids prefixed 'live-web-'. Always start sessions with `bun run live up --front-door rust --native-test-ops` plus any surface-specific options such as --local-model-ports or --local-model-fixture, so every worker builds the same target/debug/pacer. Cargo's lock serializes the first build. Never run cargo clean, never delete target/, and do not build other feature sets.
- Before each session, confirm that `git status --short` is clean and that HEAD is 0835c8003. Do not edit or commit anything. If a surface fails, gather evidence (logs, the request and response, the report) and report it. Do not fix it.
- Do web checks in Orca's built-in browser, with a new isolated profile per session.
- These maintainer exceptions stay UNVERIFIED, so do not exercise them: op-specific stdio beyond the fixed fixtures, the desktop app, the PACER_FORWARD_OPS override, D3/D8-guarded effects, the Updates Install control, and real executors.
- Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports.
- The machine is under memory pressure, so run one session at a time.
- Stop every session, proxy, fixture, tab and profile when done.

Write .work/reviews/live-live-web.md. Include the head; each session id, report path and Summary line; a table mapping each surface to its result and evidence; any failures with evidence; the UNVERIFIED items with reasons; and cleanup. Report with orca orchestration worker_done covering the Summary lines, failures and UNVERIFIED items. Always end with worker_done.


Carry out the task described above.

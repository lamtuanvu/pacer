# Task: same-runtime live replay at the integration head — ops (task-send, runner ops, accounts, service)

Executor: codex. No time limit; replay EVERY scenario listed before reporting. This closes CT-11 at the final head; earlier evidence at 0835c8003 predates the main sync (86 runtime files changed) and does not count.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 4d11aeb82, runtime-identical to 3c483c420. Read docs/testing/live-validation.md, .work/reviews/m2-integration-qa-review.md (the behavior→live matrix; your rows are listed below) and the prior reports named below. For each prior session, open its .work/live/<session>/evidence/report.md (paths are in the prior reports) and replay the SAME scenarios, fixtures and options at this head.

## Your scope
Prior reports: .work/reviews/live-live-ops.md, live-live-ops-a.md, live-live-ops-b.md, live-live-ops-c.md (and the source sessions they cite in the m2-task-send / m2-runner-ops / m2-service-handover worktrees).
1. task.send: native validation refusals, lock/lease behavior and the two task-record lock races, and DELIVERY into a live terminal. The sync-b inert hub had no live terminal; build the delivery case the way the original task-send source session did (find it in its report) so input is actually delivered and observed.
2. runner.check via CLI, HTTP and web (Settings runner check) through to COMPLETION (result recorded/displayed), unknown-runner refusal; runner.set native path and string-model forward; runner list/check status.
3. account.list native/forwarded branch matrix as in the source session (each branch that selects native vs TypeScript); account.signin and service.handover only up to their guard refusal (exception).
4. Service status with sandbox plist, setup/diagnostics install refusals, Updates check (not Install), guarded CLI results, public API guards and bridge isolation (live-ops-c scenarios).

## Rules
- Start sessions with `bun run live up --front-door rust --native-test-ops` plus the prior sessions' options. target/debug/pacer is already built with test-ops at this runtime; `live up` may invoke cargo — that is allowed only as the harness's own incremental build (CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4); never cargo clean, never other feature sets. Session ids prefixed `replay-ops-`. One session at a time.
- Before each session: `git status --short` clean and HEAD 4d11aeb82. Do not edit or commit tracked files. If a scenario fails, collect evidence (logs, request/response, report), then reproduce the same scenario on clean origin/main 445241520 only if needed to classify it (scratch detached worktree, TypeScript front door, no cargo; remove it afterwards). Do not fix anything.
- Web checks: Orca's built-in browser, isolated profile per session. Login URL: open once; if expired go to /app/#/settings (pre-existing Orca double request).
- Maintainer exceptions stay UNVERIFIED and are not exercised: desktop app, real executors, op-specific stdio beyond fixed fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install. Known pre-existing: native msg.send live-answer gap (separate PR), tray board/footer browser tests.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Other workers run live sessions in this and another worktree; use your own ids and never stop theirs. Stop everything you start.

Write .work/reviews/live-replay-replay-ops.md: head; each session id, report path and Summary line; a scenario → prior session → result at HEAD → evidence table covering every listed scenario; failures with evidence and classification; UNVERIFIED with reasons; cleanup. Report with orca orchestration worker_done. Always end with worker_done.

# Task: same-runtime live replay at the integration head — server split and transports

Executor: codex. No time limit; replay EVERY scenario listed before reporting. This closes CT-11 at the final head; earlier evidence at 0835c8003 predates the main sync (86 runtime files changed) and does not count.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head f5168b0f9, runtime-identical to 3c483c420. Read docs/testing/live-validation.md, .work/reviews/m2-integration-qa-review.md (the behavior→live matrix; your rows are listed below) and the prior reports named below. For each prior session, open its .work/live/<session>/evidence/report.md (paths are in the prior reports) and replay the SAME scenarios, fixtures and options at this head.

## Your scope
Prior reports: .work/reviews/live-live-split.md and live-live-web.md (split HTTP reads, SSE replay) and their source sessions in the refactor-split-pacer-server worktree.
1. Native HTTP reads and writes through the split modules: routing, msg (non-answer), review, setup.init write path, host.set/host.remove, native task.stop (CLI and HTTP).
2. Stdio front door: the fixed-fixture stdio requests the source session used, including internal bridge isolation.
3. WebSocket frames via the public proxy, SSE replay with Last-Event-ID, MCP transport fixture (initialize, tools/list, a tool call).
4. /v2 characterization requests the source session made (exact equality may stay UNVERIFIED as on the source branch; record the diff).

## Rules
- Start sessions with `bun run live up --front-door rust --native-test-ops` plus the prior sessions' options. target/debug/pacer is already built with test-ops at this runtime; `live up` may invoke cargo — that is allowed only as the harness's own incremental build (CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4); never cargo clean, never other feature sets. Session ids prefixed `replay-split-`. One session at a time.
- Before each session: `git status --short` clean and HEAD f5168b0f9. Do not edit or commit tracked files. If a scenario fails, collect evidence (logs, request/response, report), then reproduce the same scenario on clean origin/main 445241520 only if needed to classify it (scratch detached worktree, TypeScript front door, no cargo; remove it afterwards). Do not fix anything.
- Web checks: Orca's built-in browser, isolated profile per session. Login URL: open once; if expired go to /app/#/settings (pre-existing Orca double request).
- Maintainer exceptions stay UNVERIFIED and are not exercised: desktop app, real executors, op-specific stdio beyond fixed fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install. Known pre-existing: native msg.send live-answer gap (separate PR), tray board/footer browser tests, and the CLI's 15 s HTTP client deadline racing the 15 s OpenCode probe in executor.setup.candidates ("Service request failed").
- Do NOT wrap `bun run live up` in sbx-deny: the harness applies its own sandbox-exec for model ports and macOS rejects nested sandboxes.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Other workers run live sessions in this and another worktree; use your own ids and never stop theirs. Stop everything you start.

Write .work/reviews/live-replay-replay-split.md: head; each session id, report path and Summary line; a scenario → prior session → result at HEAD → evidence table covering every listed scenario; failures with evidence and classification; UNVERIFIED with reasons; cleanup. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.

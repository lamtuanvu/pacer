# Task: post-sync live validation, part B (API, CLI and stdio surfaces)

Executor: codex. No time limit; finish every surface before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 4d11aeb82 (docs-only ledger fix on 3c483c420; eight M2 branches merged with origin/main #858–#866). Replay your surfaces at this exact head with a clean tree (CT-11), following docs/testing/live-validation.md. Read .work/reviews/m2-integration-handoff.md ("Phase B", "Sync with main") and the earlier live reports in .work/reviews/live-live-*.md (setup, split, ops-a/b/c) for scenarios, fixtures and options to reuse.

## Your surfaces (finish all)
1. **Main's overlap on the native front door:**
   - `msg.send` stale-answer guard (#866): through the guarded CLI and HTTP, an answer to a question that was already answered or superseded is refused with the same error as TypeScript; a fresh answer is accepted. Compare native (`--front-door rust`) with a forwarded run where the harness supports it without PACER_FORWARD_OPS.
   - `runner.models.get` / `runner.models.set` (#858/#860, forwarded): read and set a model for a fixture executor via CLI and HTTP; the change persists in strategy and in `runner.models.get`.
   - `dispatch.child` with `difficulty`/`model` (fix 3c483c420): an invalid value returns Core's full validation error over HTTP and stdio; a request without those fields still gets the native refusal (for example a caller without a work grant).
   - `task.list` / task detail after main's cost projection (#859): `task.get` and `task.list` replies for a fixture task include the cost fields and agree between CLI and HTTP.
   - `/v3/events` SSE incremental task updates: a task state change arrives as an event without a snapshot reload.
2. **Smoke replay of integrated M2 surfaces at the synced head** (one short session each, reuse earlier scenarios): setup doctor/health/check/candidates with `--local-model-ports` and `--local-model-fixture` (ok fixture only); split native reads + `host.set`/`host.remove` + WebSocket + MCP transport fixture; runner ops (`runner.check`, `runner.set` native vs string-model forward); task.send delivery; service status with sandbox plist; updates check.

## Rules
- Session ids prefixed `live-sync-b-`. Always start with `bun run live up --front-door rust --native-test-ops` plus surface options. Never cargo clean, never delete target/, don't build other feature sets.
- Before each session confirm `git status --short` is clean and HEAD is 4d11aeb82. Do not edit or commit. If a surface fails, gather evidence and report it; do not fix it.
- Any web check uses Orca's built-in browser with an isolated profile. Login URL: open once; if expired, go to /app/#/settings (pre-existing Orca double request, not a failure).
- Maintainer exceptions stay UNVERIFIED; do not exercise: op-specific stdio beyond the fixed fixtures, the desktop app, PACER_FORWARD_OPS override, D3/D8-guarded effects, Updates Install, real executors.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.
- Memory pressure: one session at a time. Stop every session, proxy, fixture, tab and profile when done.

Write .work/reviews/live-live-sync-b.md: head; each session id, report path and Summary line; a surface → result → evidence table; failures with evidence; UNVERIFIED items with reasons; cleanup. Report with orca orchestration worker_done covering the Summary lines, failures and UNVERIFIED items. Always end with worker_done.

Known issue, do not report as a new failure: native `msg.send` does not deliver an answer live to an interactive session waiting on its question (main #863 added that only in TypeScript `src/messaging/send.ts`; it is pre-existing on origin/main and fixed in a separate PR). For the stale-answer guard surface use a non-live (no waiting interactive session) recipient; if you observe the live-answer gap, record it as "pre-existing, tracked separately".


Carry out the task described above.

# Task: same-runtime live replay at the integration head — setup and doctor

Executor: codex. No time limit; replay EVERY scenario listed before reporting. This closes CT-11 at the final head; earlier evidence at 0835c8003 predates the main sync (86 runtime files changed) and does not count.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 4d11aeb82, runtime-identical to 3c483c420. Read docs/testing/live-validation.md, .work/reviews/m2-integration-qa-review.md (the behavior→live matrix; your rows are listed below) and the prior reports named below. For each prior session, open its .work/live/<session>/evidence/report.md (paths are in the prior reports) and replay the SAME scenarios, fixtures and options at this head.

## Your scope
Prior report: .work/reviews/live-live-setup.md (ok, delay and reverse fixtures) and its source sessions in the m2-setup-doctor worktree.
1. setup.health, doctor.run, setup.check, setup candidates — ok, delay and reverse local-model fixtures (`--local-model-ports` with non-default ports, `--local-model-fixture`), CLI and HTTP, plus web candidates.
2. setup.init SUCCESS: seed a strategy that satisfies its preconditions (the qa-int-setup attempt failed only because the seed lacked a default codex account — use the source session's seed/options), and the starter selection it produces.
3. Delayed-error and browser probe ordering as in the source session.

## Rules
- Start sessions with `bun run live up --front-door rust --native-test-ops` plus the prior sessions' options. target/debug/pacer is already built with test-ops at this runtime; `live up` may invoke cargo — that is allowed only as the harness's own incremental build (CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4); never cargo clean, never other feature sets. Session ids prefixed `replay-setup-`. One session at a time.
- Before each session: `git status --short` clean and HEAD 4d11aeb82. Do not edit or commit tracked files. If a scenario fails, collect evidence (logs, request/response, report), then reproduce the same scenario on clean origin/main 445241520 only if needed to classify it (scratch detached worktree, TypeScript front door, no cargo; remove it afterwards). Do not fix anything.
- Web checks: Orca's built-in browser, isolated profile per session. Login URL: open once; if expired go to /app/#/settings (pre-existing Orca double request).
- Maintainer exceptions stay UNVERIFIED and are not exercised: desktop app, real executors, op-specific stdio beyond fixed fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install. Known pre-existing: native msg.send live-answer gap (separate PR), tray board/footer browser tests.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Other workers run live sessions in this and another worktree; use your own ids and never stop theirs. Stop everything you start.

Write .work/reviews/live-replay-replay-setup.md: head; each session id, report path and Summary line; a scenario → prior session → result at HEAD → evidence table covering every listed scenario; failures with evidence and classification; UNVERIFIED with reasons; cleanup. Report with orca orchestration worker_done. Always end with worker_done.

## Extra item (from the ops replay)
4. runner.set forwarding proof: over HTTP and CLI, send `runner.set` with a string `model` that is NOT in the provider's model listing for a fixture runner (the listing comes from `availableModels`, which only TypeScript owns — see crates/config-ops/src/runner_ops.rs `runner_set_stays_forwarded` and src/models/available.ts). Record the refusal text and compare it with the TypeScript handler's message; then send a valid listed model and confirm it persists. Also send invalid params (e.g. non-object) and confirm the native error. This proves the forward branch without a log marker. Prior evidence: .work/reviews/live-replay-replay-ops-rest.md.


Carry out the task described above.

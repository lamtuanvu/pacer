# Independent QA review: m2/integration PR

You are the independent QA reviewer (.project/reviewers/qa.md). You did not write this code. Review and report; do not change tracked files. Executor: codex. No time limit; finish every check before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 4d11aeb82, base origin/main 445241520. This PR combines eight M2 branches (task-send, runner-ops, service-handover, managed-work actions, setup-doctor, pacer-server split, dispatch ops, ledger recount) plus a sync with main and fixes. Read .project/reviewers/qa.md, .project/rules/code-and-testing.md (CT-*), docs/testing/live-validation.md, and .work/reviews/m2-integration-handoff.md.

## Evidence to assess (all in .work/reviews/ of the worktree)
- Reviews: m2-integration-project-review.md, -review-a, -review-b*, -review-ledger, -review-fix1, -review-final, -review-test, -review-sync (with coordinator disposition: its blocking msg.send live-answer finding is pre-existing on origin/main and fixed in a separate PR).
- Live: live-live-ops*.md, live-live-setup.md, live-live-split.md, live-live-web*.md, live-live-sync-a.md, live-live-sync-b.md, and the session reports they cite under .work/live/. Note: live-sync-b's "task.list lacks cost" FAIL is a brief error — on main only task detail (`src/core/task-detail.ts` costFor) carries cost; verify that and classify it. Its stale-answer UNVERIFIED: messaging code (crates/messaging-ops, src/messaging, src/api/msg-bridge.ts) is identical to main; verify with git diff.
- Suites: handoff "Phase B suite and fixes" and "Sync with main" (cargo workspace 1019/3/0; targeted bun 738/5/2 with 2 reproduced on clean main).

## Required checks
1. Map every changed runtime behavior (per source branch and the sync) to test coverage and a live verdict at a revision whose runtime equals HEAD (state which revisions are runtime-equivalent: diffs since must be docs/tests only — verify with git diff --stat). List gaps.
2. Re-run, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh, disposable HOME/PACER_HOME and PACER_TEST_NATIVE_FRONT_DOOR=<abs path of target/debug/pacer>: the native parity tests (`test/native-*.test.ts`), `test/mcp-parity.test.ts`, `test/m1-gate.test.ts`, `test/messaging-user-retry.test.ts`, the app/tray tests for the changed app files, `bun run typecheck`, `bun run ui:check`, and the ledger checker `bun .work/fixtures/m2-ledger-check.ts`. Run files serially. For any failure, reproduce on a scratch detached worktree of origin/main 445241520 (bun only, no cargo; remove it afterwards) to classify pre-existing vs introduced.
3. Spot-check one live surface yourself at HEAD if any behavior lacks same-runtime live evidence (`bun run live up --front-door rust --native-test-ops`, session ids prefixed `qa-int-`, one session at a time).

## Rules
- Do NOT run cargo (memory pressure); target/debug/pacer is already built with test-ops at this runtime. Do not run the full Bun suite. Another reviewer (UI) may run a live session concurrently — use your own session ids and don't stop theirs.
- Maintainer exceptions (recorded, disclosed as UNVERIFIED in the PR, and not by themselves grounds to withhold PASS for in-scope surfaces): desktop app, real executors, op-specific stdio beyond fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install, screen-reader speech. Failures reproduced on clean origin/main are pre-existing, not introduced; tray browser test failures are known pre-existing and tracked separately.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Leave the tree clean; stop everything you start.

Write .work/reviews/m2-integration-qa-review.md: reviewed base/head, governance version, scope/rule IDs, behavior→test→live matrix, commands with counts, failures classified, findings with severity/rule/remedy, PASS/FAIL/UNVERIFIED per surface, overall verdict. Report with orca orchestration worker_done. Always end with worker_done.

## Also (REPO-10 final-revision check)
Confirm 4d11aeb82 `docs: drop duplicate runner.models rows from the ledger summary` is docs-only, correct (rows 136-137 remain, summary totals unchanged) and signed; include it in the report.


Carry out the independent review described above and write the report.

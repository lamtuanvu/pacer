# Task: second final QA verdict for the M2 integration PR, and review of the CI test fix

Executor: cursor-agent (independent QA reviewer). Read-only: don't start live sessions, don't run cargo builds, don't edit tracked files. You may run `bun .work/fixtures/m2-ledger-check.ts`, `git` commands, file reads, and `bun test` on the two test files named below.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head fff6b18b7. Read `.project/constitution.md`, the CT-* and REPO-10 rules, `docs/testing/live-validation.md`, and your previous `.work/reviews/m2-integration-qa-final.md` (UNVERIFIED). Re-decide every row of its matrix.

## Part A: review of the test-only fix fff6b18b7

`git show fff6b18b7` changes two parity tests that failed on Ubuntu CI for PR #870:
- `test/native-account-list-parity.test.ts`: launcher lines were sorted before the platform terminal (`open -a X` on macOS, `x-terminal-emulator -e` on Linux) was replaced with `<terminal>`, so on Linux the line sorted last.
- `test/native-setup-doctor-parity.test.ts`: the normalizer masked the measured Link latency level but not the `doctor.fix.delegate` remedy that `src/install/doctor-remedy.ts` adds to warn and fail checks.

Check that the diff is test-only, that each change fixes the stated cause without hiding a real native/Core difference, and that nothing else is masked. Run the two files with `PACER_TEST_NATIVE_FRONT_DOOR=$PWD/.work/bin/pacer-native-test TZ=Asia/Ho_Chi_Minh bun test <file>` and record the result. Give Part A its own verdict (PASS or FAIL with findings).

## Part B: QA verdict

Your previous blocking gaps were: the account.list scoped-grant branch; the supervision, admission, locking and cached-read rows without same-runtime live evidence; and /v2 equality.

New evidence in `.work/reviews/` (runtime unchanged between f5168b0f9 and fff6b18b7; confirm with `git diff --stat f5168b0f9 fff6b18b7`):
- `live-replay-sync-live.md`: R3, R4, R5 PASS; R1, R2, R6 UNVERIFIED there.
- `live-replay-sync-live2.md`: R1 task.list filter parity, R2 cost projection creation, R6 account.list work-grant forwarding.
- `live-replay-v2-equal.md`: /v2 C1 equal; C2/C3 differ only by session identities and the additive `work` lineage field (`src/api/read-model/tasks.ts`).
- `m2-integration-ui-gap-tray.md`, `m2-integration-ui-gap-web.md`: managed answer and retry flows through the UI.
- The harness session reports they cite (`.work/live/<session>/evidence/report.md`).

Coordinator positions to verify, not to accept blindly:
1. sync-live2's FAIL probe (overlapping peers on different accounts: native reports shared cost, Core a delta) is pre-existing because the rule is unchanged from main. Check the cost code's diff against a8331c6b4.
2. `pacer api call` refused at GET /v3/hello under a grant is pre-existing.
3. The additive /v2 `work` field is intended and is disclosed, not a defect.
4. Rows the previous verdict listed as non-blocking UNVERIFIED (MCP task.send, HTTP enforcement identity, positive messaging forwarding trace, cold-cache browser attribution) are covered by maintainer exceptions or parity tests; say which, or name them as blocking.

Decide one overall QA verdict: PASS, FAIL or UNVERIFIED. Maintainer exceptions don't block PASS when disclosed: the desktop app, real executors, op-specific stdio beyond fixtures, PACER_FORWARD_OPS, D3/D8-guarded effects, Updates Install, and VoiceOver (waived).

Write `.work/reviews/m2-integration-qa-final2.md` with:
- the overall verdict on the first line, then the Part A verdict;
- the re-decided matrix: row, evidence (session and report), revision, verdict;
- the previous-gap table: closed (evidence), open, or excepted;
- the positions you confirm or reject;
- introduced defects separate from pre-existing ones;
- remaining UNVERIFIED items and PR disclosures.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

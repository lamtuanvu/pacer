# Independent review: test commit 8156b69a0

You are the independent reviewer required by REPO-10. You did not write this commit. Review it and report; do not change anything.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration). Your scope is exactly commit 8156b69a0, `test: cover native task.get managed work after a user retry`, which adds one test to test/native-task-get-parity.test.ts.

Context: a live check reported that native HTTP task.get omitted `work` after a user retry. A follow-up investigation found that the live check had compared reads at two different revisions, so it was a false alarm. It then added this test, asserting that native and forwarded task.get return the same `work` (with `userStarted: true`) after task.retry. See the "Native task.get work" section of .work/reviews/m2-integration-handoff.md.

## Check
1. **The test is meaningful.** It sets up a human-origin managed task, retries it, and compares the native front door with forced forwarding at the same revision. It would fail if native task.get dropped or altered `work`. Check this by reasoning, or by a quick local mutation in a temporary copy that you discard afterwards.
2. **Isolation:** disposable HOME and PACER_HOME (via the test/setup.ts preload and fakeCtx), and nothing can reach 127.0.0.1:4317, the model ports or real-install paths. The `exchange` helper spawns the front door, so check its environment.
3. **Style:** it matches the file's conventions and helpers, and contains no machine paths.
4. **Run it** under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh and PACER_TEST_NATIVE_FRONT_DOOR=$PWD/target/debug/pacer: `bun test --timeout 120000 test/native-task-get-parity.test.ts`. Also confirm the commit has a Signed-off-by line.

Do not run cargo, the full suite or the live harness; a live worker is using this worktree. Write the report to .work/reviews/m2-integration-review-test.md, with the verdict PASS or FAIL and any findings with severity, rule, evidence and remedy. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.

# Task: final-head strict proof for fix/test-port-isolation

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-test-port-isolation (branch fix/test-port-isolation), head 196036d8e. Do not change source unless step 4 applies. Read .work/reviews/port-isolation-worker-handoff.md, .work/reviews/port-isolation-comparison.md and .work/reviews/port-isolation-review.md first.

Two independent review passes found no blocking defect. What is missing is final-head evidence: native front-door tests, and a whole-suite run in which no test process touches the real install or the protected ports. Your job is to produce that evidence.

The maintainer approved running this alongside another worker that is doing Cargo and Bun work in a different worktree, so expect some CPU contention. Rerun any timeout failure on its own before you classify it.

## Steps
1. Build both front doors with CARGO_INCREMENTAL=0, as the earlier worker did: the test-ops binary for PACER_TEST_NATIVE_FRONT_DOOR, which must be a binary path, and the production binary.
2. Run every native-*-parity file and native-dispatch under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict, with TZ=Asia/Ho_Chi_Minh and PACER_TEST_NATIVE_FRONT_DOOR and PACER_TEST_BROWSER set. sbx-strict SIGKILLs any process on contact with ports 4317, 11434, 1234 and 41343, with reads of data inside ~/.pacer, with writes to protected install paths, or with launchctl.
   - Accepted exception: native-setup-parity contacts the model ports until this branch is rebased after setup-doctor merges. Run it under sbx-deny instead and report it separately.
3. Run the whole bun suite at 196036d8e under sbx-strict, in shards with JUnit output as before, with the same environment. Run the suite once, never two at the same time.
   - Accepted exception: desktop process enumeration does read-only inspection, which the strict profile's read restriction denies. Run that file under sbx-deny and report it separately.
   - Report the total pass, skip and fail counts.
   - Report every exit 137 or SIGKILL, with its file and the protected resource involved. Find the resource by rerunning that file under sbx-deny, or with selective profiles.
   - Compare the failing files against the existing base comparison by name. Rerun on their own any new failures, and any timeouts.
4. A tripwire kill outside the two accepted exceptions is a blocking finding. If you can fix it with a test-only change consistent with this branch (a stub, a fixture port or an environment pin), make a signed commit, rerun the affected files under sbx-strict, and say so plainly. Otherwise stop and report it.
5. Stop if free disk falls below 10 GiB. When you finish, delete this worktree's target/ and any scratch directories. Stop every process you started.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Do not push.

Write .work/reviews/port-isolation-strict-proof.md with the head, the commands, the counts, the kill list (zero or each one with its cause), the separately run exception files, the failure comparison with base, and cleanup. Report with orca orchestration worker_done covering the head, counts, kills, new failures and cleanup. Always end with worker_done.


Carry out the task described above.

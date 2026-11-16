# Task: make the live harness's --local-model-ports option safe (m2/setup-doctor)

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor (branch m2/setup-doctor), head 3c2183784. Work only here; commit with git commit -s; do not push.

Independent review .work/reviews/2026-11-10-m2-setup-doctor-rereview4.md found one blocking defect (CT-11 / repository safety): scripts/live/core.ts:237 and docs/testing/live-validation.md:90. The new `bun run live up --local-model-ports` accepts 11434, 1234 and any other port except 4317 and passes them to the probe implementation (PACER_TEST_LOCAL_SERVER_PORTS). A normal harness run has no network sandbox, so selecting the defaults, or any port where a real model server listens, directs discovery to a real server. The docs claim the option means probes never reach real servers, which is false. The candidates-screen live evidence itself was accepted.

Required:
1. Enforce isolation in the harness rather than relying on the operator: refuse known default local-model ports (at least 11434 and 1234, plus any other default the probe code uses; read them from the probe code, not a hard-coded guess) and 4317. Also refuse any port that is already listening when the session starts unless the harness itself started a fixture on it (or, if the harness has no fixture concept, require that the ports are not listening at session start and are bound by fixtures supplied via a documented option), so a real server on a non-default port cannot be targeted. Fail closed with a clear message.
2. Optionally (preferred if simple and portable): when --local-model-ports is given on macOS, run the service and Core under the same sandbox-exec profile the tests use (deny outbound to localhost 4317, 11434, 1234), reusing scripts/test-sandbox.ts or the existing guard wrappers; record in session.json whether the sandbox was applied.
3. Correct docs/testing/live-validation.md to state exactly what the option guarantees.
4. Tests in test/live-harness.test.ts: rejection of 11434, 1234, 4317 and of an already-listening port not owned by a fixture; acceptance of fixture ports.
5. Validation: run test/live-harness.test.ts and test/endpoint-detect.test.ts under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx; tsc; git diff --check. Then a live run at the exact new clean head: repeat the setup-doctor-10c case (native, two fixture probe failures in non-server order; see .work/live/setup-doctor-10c/ and 10d for how it was run) with the new safeguards, plus a recorded refusal of --local-model-ports 11434. The target/ dir was deleted to save disk: build only what bun run live needs, with CARGO_INCREMENTAL=0, and delete target/ afterwards.
6. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service, port 4317 or real local model servers.

Report with orca orchestration worker_done: head, commits, the safeguards, test counts, live report path and Summary, and cleanup confirmation. Always end with worker_done.


Carry out the task described above.

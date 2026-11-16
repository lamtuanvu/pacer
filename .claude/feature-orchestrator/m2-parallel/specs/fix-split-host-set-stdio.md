# Task: add stdio host.set parity coverage on refactor/split-pacer-server

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server (branch refactor/split-pacer-server). Head dcf81545c, clean. Read .work/reviews/2026-11-10-split-pacer-server-rereview2.md (second finding) first.

Finding: `crates/core-bridge/src/host_mut_sync.rs` (`call_stdio_set`, moved from the server crate, called from `crates/server/src/stdio_proxy.rs:740`) is the stdio-only orchestration for host.set (write, endpoint finish via config_sync, read parts, summary). No automated test drives it: `test/native-dispatch.test.ts:45` only lists the name and `test/host-detail.test.ts` is TypeScript-only. The maintainer exception for op-specific stdio live runs requires automated coverage instead.

1. Add a tracked test that drives host.set over the real native stdio front door (PACER_TEST_NATIVE_FRONT_DOOR) and compares it with forced TypeScript forwarding (PACER_FORWARD_OPS covering host.set), following the existing native parity test patterns (for example test/native-msg-writes-parity.test.ts or test/native-setup-parity.test.ts): disposable HOME/PACER_HOME per run, a pinned non-4317 port via the existing helpers, no real hosts or network (use a local alias with safe parameters; if host.set probes the host, point it at a local fixture or an unreachable reserved address the existing tests use). Assert: the reply matches between native and forwarded; the native path is actually taken (native trace or the established marker); the effect is identical (host.list afterwards, and the written config/host files inside the disposable home). Include an invalid-params case and an update of an existing alias.
2. Confirm the test fails if the stdio host.set path is broken (temporarily break call_stdio_set, e.g. skip the endpoint finish, show the failure, restore; never commit the break).
3. Build the front door with CARGO_INCREMENTAL=0 and run the new test plus test/native-dispatch.test.ts under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict with PACER_PORT=1 and TZ=Asia/Ho_Chi_Minh. Also run the same new test against a base build (scratch worktree of 33e584bce with the test file copied in) to show identical behavior; remove the scratch worktree and its target afterwards.
4. Run `cargo fmt --all --check`, `bun run typecheck` (through sbx-strict) and `git diff --check`. Commit signed (git commit -s, Conventional Commits, `test:`). Do not push. Delete target/ when done.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service, port 4317 or the model ports 11434 and 1234.

Add a section to .work/reviews/split-server-worker-handoff.md, then report with orca orchestration worker_done: new head and commit, test cases, base and head results, the mutation result, and cleanup. Always end with worker_done.


Carry out the task described above.

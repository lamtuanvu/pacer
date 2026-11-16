# Task: native task.get omits managed `work` after a user retry

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 0835c8003. This is the combined PR of eight M2 branches. Live validation at this head failed: see .work/reviews/live-live-web.md and the evidence in .work/live/live-web-final/:
- http-task-get.json: HTTP native task.get on a human-origin managed task after task.retry returns 200, but with no `work` field;
- human-after.json: the core CLI (TypeScript) task.get for the same task returns `work.userStarted: true`.

The M2 ledger says native task.get is composed by pacer_read_model::task_detail plus Core enrichment through /_internal/task-read-parts (`_internal.task-read.parts`), and that the enrichment includes dispatch `work`/`managedSkip`. Commit 0835c8003 fixed the TypeScript side: src/core/task-detail.ts had let the managed-work projection overwrite the enriched `work` field.

## Steps (finish all of them)
1. **Reproduce it in a test,** without the live harness.
   - Find the existing native task.get parity tests (search test/ for task.get, task-read-parts, native front door) and the TypeScript test test/messaging-user-retry.test.ts.
   - Write or extend a parity test: a human-origin managed task, a user retry, then task.get through the native front door and through forced forwarding. Assert that `work` (including `userStarted`) matches between the two.
   - Run it under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh and PACER_TEST_NATIVE_FRONT_DOOR set to target/debug/pacer. The live harness built that binary with test-ops. Rebuild with `CARGO_INCREMENTAL=0 cargo build` and the same features only if you change Rust. No live worker is running now.
2. **Find the root cause.** Trace how native task.get gets `work`: the read-parts bridge request and reply, the Rust composition in read-model task_detail, and the TypeScript task-read-parts handler. Then work out where the field goes missing:
   - Core does not return it in the parts;
   - Rust drops it;
   - or Rust composes `work` itself without the enrichment.
3. **Attribute it.** Run the same test on a clean origin/main scratch worktree (54ffba85d) and on fix/managed-work-actions (18d289925), with their own builds. Do this only if disk stays above 15 GiB, and remove the scratch worktrees afterwards. This tells you whether the bug is:
   - pre-existing on main;
   - introduced by the managed-work branch;
   - or introduced by the integration's merge resolutions.
4. **Fix it if it is introduced** by the managed-work branch or by the integration. Make the smallest faithful change so native task.get returns the same `work` as TypeScript. Keep the new parity test. Commit signed: `fix: keep managed work in native task detail`.
   - If it is pre-existing on main, still add the test as a skipped-with-reason or known-failure test only if the repository has a convention for that. Otherwise do not commit; report it.
5. Run the new test and the existing task.get, task-detail, managed-work and read-parts tests (search test/), plus `cargo test -p pacer-read-model` if you touch it, `bun run typecheck`, `cargo fmt --check`, `cargo clippy -p <touched> -- -D warnings`, and `git diff --check`.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Do not push.

Append a "Native task.get work" section to .work/reviews/m2-integration-handoff.md covering the reproduction, the root cause with file and line, the attribution with evidence, the fix, and the commands and their results. Report with orca orchestration worker_done covering the head, root cause, attribution, fix and tests. Always end with worker_done.

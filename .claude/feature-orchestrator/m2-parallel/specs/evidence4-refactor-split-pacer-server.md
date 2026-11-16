# Task: live proof for the split's bridge write families

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server (branch refactor/split-pacer-server). Head dcf81545c, clean. Read .work/reviews/2026-11-10-split-pacer-server-rereview.md (UNVERIFIED only for this gap) and the last section of .work/reviews/split-server-worker-handoff.md (how sessions split-gap-dcf were seeded: the inert Unix-socket session fixture, seeded tasks, the fixed native stdio fixture). Do not change tracked files; if you find a defect in branch code, stop and report it. No pushes. This is the only heavy job on the machine.

At the clean head, in a new live session (`bun run live`, new id, temporary HOME/PACER_HOME, non-4317 port), prove each write-effect bridge family moved into crates/core-bridge works end to end. For each family, pick one representative operation from its module (crates/core-bridge/src/config_sync.rs, host_mut_sync.rs, msg_write_sync.rs, setup_effects_sync.rs, task_stop_sync.rs, task_review_sync.rs), call it over the HTTP front door, and record: the request, HTTP status, the native trace (or forwarding evidence) in serve.log, and the effect actually observed afterwards (a follow-up read op, or the file/state change inside the session's PACER_HOME). Specifically:
- config_sync: a config write, then config.get showing the change.
- host_mut_sync: a host add or update, then host.list showing it (and remove it if there is a remove op).
- msg_write_sync: a message send/post to a seeded task or project, then the corresponding read op showing it.
- setup_effects_sync: a setup effect that stays inside the sandbox (no service install, no real executor, no network beyond the session's own fixtures), then the state change.
- task_stop_sync: a successful task.stop on a seeded running task backed by the inert session fixture (or a harness test-ops stub), then task.get showing it stopped.
- task_review_sync: a successful task.review on a seeded task in a reviewable state, then task.get showing the result.
For any family with a stdio path, also make the same call over the stdio bridge once.
If an operation is D3/D8-guarded or needs a real executor, record it as UNVERIFIED under the maintainer exception and use the closest unguarded operation in the same family instead.

Run any bun test only through /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service, port 4317 or the model ports 11434 and 1234. CARGO_INCREMENTAL=0; build only what bun run live needs. Afterwards stop the session, proxies and fixtures, and delete target/ and build outputs.

Add a section to the handoff, then report with orca orchestration worker_done: head, live report path and Summary line, per-family result (op, status, trace, observed effect), UNVERIFIED items and cleanup. Always end with worker_done.


Carry out the task described above.

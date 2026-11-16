# Task: consolidated live validation of refactor/split-pacer-server at its final head

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server (branch refactor/split-pacer-server). Head 6b962a4f9 (test-only commit on top of dcf81545c). Confirm HEAD and a clean tracked tree first; do not change tracked files or commit. No pushes. This is the only heavy job on the machine.

Previous clean-head sessions at dcf81545c: .work/live/split-server-dcf-evidence, .work/live/split-gap-dcf and .work/live/split-write-dcf. Read their reports, session.json and evidence, and the last sections of .work/reviews/split-server-worker-handoff.md for the exact seeding (inert Unix-socket session fixture, seeded tasks, v2 snapshot normalization, MCP stdio fixture, write families).

Repeat them at this head in ONE new live session where possible (new session id, `bun run live`, temporary HOME/PACER_HOME, non-4317 port), following docs/testing/live-validation.md:
- Orca's built-in browser with a new isolated profile: Tasks and Budget & pacing screens.
- HTTP native reads with traces: routing.status, task.list, task.get, snapshot.get, config.get, host.list, setup.check, task.wait, desktop.reconcile.status; SSE replay.
- Write families with traces and verified effects: routing.set (routing.get), host.set and host.remove (host.list), msg.send (msg.log), task.stop and task.review (task.get), setup.init (config.get); config.set expected D8 refusal.
- v2 snapshot: compare with the base snapshot saved in .work/fixtures/gap-evidence/ using the same normalization (do not rebuild base unless the saved base is unusable).
- MCP stdio transport fixture and the WebSocket stream on the inert session fixture.
Op-specific stdio beyond the fixed stdio fixture, the desktop app, the PACER_FORWARD_OPS override and real executors stay UNVERIFIED under the maintainer exception. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service, port 4317 or the model ports 11434 and 1234; run any bun test only through /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict. CARGO_INCREMENTAL=0. Afterwards stop the session, proxies and fixtures, close the tab, delete the profile, and delete target/ and build outputs.

Add a section to the handoff, then report with orca orchestration worker_done: head, session id, report path and Summary line, per-surface results, UNVERIFIED items and cleanup. Always end with worker_done.


Carry out the live validation described above.

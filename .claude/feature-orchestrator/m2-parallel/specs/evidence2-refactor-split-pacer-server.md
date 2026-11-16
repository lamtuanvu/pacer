# Task: finish the evidence for refactor/split-pacer-server

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server (branch refactor/split-pacer-server). Head dcf81545c, clean. Base 33e584bce. Read .work/reviews/split-server-worker-handoff.md (all three sections) and .work/reviews/serial-native-parity-table.md first. The previous dispatches stopped for disk; disk now has about 47 GiB free. This is the only heavy job running on the machine; keep it that way (no parallel builds).

Do not change tracked files unless a test reveals a real defect; if so, stop and report it with evidence instead of fixing it. No pushes.

1. Serial base-vs-head native parity table. Complete `.work/reviews/serial-native-parity-table.md`:
   - Base: rerun only the base files that were not run, stopped or partial (the seven not run, native-retry-options, native-runner-discovery-attention, native-setup-parity). Use one scratch worktree of 33e584bce under .work/worktrees/, CARGO_INCREMENTAL=0, the same binaries the earlier base runs used. Then `cargo clean` it and remove the scratch worktree before building head.
   - Head: build head binaries with CARGO_INCREMENTAL=0 and run every file in the table one at a time.
   - Run every bun test as `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict bun test <file>` with disposable HOME/PACER_HOME and a non-4317 PACER_PORT. sbx-strict SIGKILLs (exit 137) any process that connects to 127.0.0.1:4317, 11434 or 1234, reads data inside or writes ~/.pacer, touches /Applications/pacer.app, ~/.local/bin/pacer(-core), the com.pacer.serve plist, or execs /bin/launchctl. A 137 or 'Killed' is a finding: rerun that file alone, name the test and process, and record it; also run the same file at base to say whether it is pre-existing.
   - Files that spawn many descendants (the earlier 40/41 cap): give each file a generous per-file timeout (for example 15 minutes) instead of a descendant cap, and record the peak descendant count; stop a file only if it exceeds the timeout, and record that as UNVERIFIED with the partial counts.
   - For every file give base and head pass/fail/skip and a verdict (same, improved, regressed, pre-existing failure). Explain every head failure or skip.
   - Stop and report if free disk falls below 10 GiB.
2. Cargo at head: `cargo xtask loc --check`, `cargo xtask deps`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --exclude pacer-plugin-host` under sbx (sbx-strict if it works for cargo; otherwise sbx), recording counts. The plugin-host native_run tests that need /bin/ps cannot run under any sandbox; keep the earlier evidence for them.
3. Live validation at the clean head, following docs/testing/live-validation.md (new session id, temporary HOME/PACER_HOME, non-4317 port, Orca's built-in browser with a new isolated profile). Cover what the 4340608 session did (Tasks and Budget & pacing in the browser; routing.status, task.list, desktop.reconcile.status over HTTP with native traces) plus the moved surfaces: one representative operation per Core bridge family (HTTP and stdio bridge clients now in pacer-core-bridge), MCP (catalog/list and one tool call over the stdio transport now in pacer-mcp), a v2 compatibility snapshot (now in pacer-read-model) compared with base behavior, SSE events and the WebSocket stream, and desktop reconciliation status (pacer-update). Op-specific stdio, desktop app, PACER_FORWARD_OPS override and real executor runs stay UNVERIFIED under the maintainer exception. Stop the session, proxies, tabs and profile afterwards.
4. Delete target/ and any scratch build outputs when done.

Update the handoff with a new section, then report with orca orchestration worker_done: head, the completed parity table summary (counts and every regression or kill), cargo results, live report path and Summary line, UNVERIFIED items and cleanup. Always end with worker_done.


Carry out the task described above.

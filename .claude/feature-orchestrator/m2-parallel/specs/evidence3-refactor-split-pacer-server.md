# Task: close the remaining split evidence gaps

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server (branch refactor/split-pacer-server). Head dcf81545c, clean. Base 33e584bce. Read the last section of .work/reviews/split-server-worker-handoff.md and .work/reviews/serial-native-parity-table.md. This is the only heavy job on the machine; no parallel builds. Do not change tracked files; if you find a real defect, stop and report it with evidence. No pushes. Stop and report if free disk falls below 10 GiB.

1. Strict-sandbox failures. Six files fail or are killed identically at base and head under sbx-strict: native-msg-policy-parity, native-plugin-ops, native-setup-parity, native-snapshot-get-parity, native-task-review-parity and native-service-update-parity (killed in "native service.status matches TypeScript service-manager probes"). Earlier base runs of some of these passed under plain sbx (for example native-plugin-ops 20/0/0). For each of the six files:
   a. Run it at head AND at base under plain `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx` (denies only 4317) with disposable HOME/PACER_HOME and a non-4317 PACER_PORT; record pass/fail/skip; this is the fair base-vs-head comparison.
   b. Identify which protected resource the strict run touched. Make temporary copies of sbx-strict under .work/sandbox-bin/ (for example sbx-strict-net, sbx-strict-files, sbx-strict-exec), each keeping only one group of rules, and rerun the failing test with each to name the resource (port 11434/1234, a ~/.pacer path, a real install path, or /bin/launchctl). Delete the temporary copies afterwards. Record per file: resource, process and test name. This is evidence for a separate test-isolation task, not something to fix here.
   Update the parity table with a "plain sbx base / head" column and the identified resource.
2. Live validation at the clean head (new session id, temporary HOME/PACER_HOME, non-4317 port, Orca's built-in browser with a new isolated profile for any web check), covering what the last session left UNVERIFIED:
   a. v2 compatibility snapshot compared with base: run the same seeded fixture and request against a base build (scratch worktree of 33e584bce, CARGO_INCREMENTAL=0) and the head, normalize volatile fields (ids, timestamps, ports), and diff; report identical or every difference.
   b. One representative operation for each Core bridge family moved into pacer-core-bridge: list the families from crates/core-bridge, exercise each over the HTTP front door and, where the family has a stdio path, over the stdio bridge, with the native trace or forwarding evidence.
   c. MCP over the stdio transport now in pacer-mcp: initialize, list the catalog and make one read-only tool call.
   d. The WebSocket stream: seed or start a task that has a live session in the sandbox (use the harness's fixture executor or a test-ops stub; never a real executor), connect, and record frames.
   Op-specific stdio beyond the above, the desktop app, the PACER_FORWARD_OPS override and real executor runs remain UNVERIFIED under the maintainer exception.
3. Stop all sessions, proxies, tabs and profiles; remove the scratch base worktree, target/ and build outputs.

Add a section to the handoff, then report with orca orchestration worker_done: head, the six-file plain-sbx comparison and identified resources, live report path and Summary line, the v2 diff result, each bridge family's result, MCP and WebSocket results, UNVERIFIED items and cleanup. Always end with worker_done.


Carry out the task described above.

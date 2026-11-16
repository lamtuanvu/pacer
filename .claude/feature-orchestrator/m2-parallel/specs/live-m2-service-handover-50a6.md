# Task: live validation of m2/service-handover at its new head

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover (branch m2/service-handover). Head 50a69ed98 (docs-only commit "docs(m2): reconcile ledger rows and figures with the catalog" on top of 0144811c0, which passed independent review with live session .work/live/m2-svc-0144). The previous implementer was stopped (resource problem) before rerunning live; the live policy requires evidence from the exact reviewed head with a clean tree.

1. Confirm git status is clean and HEAD is 50a69ed98. Do not change tracked files.
2. Run the ledger check: bun .work/fixtures/ledger-check.ts. Its row/label/catalog checks must pass (every v3 op exactly one row, labels match registry, catalog 228, unregistered 0); messages about 'stated figure not found' and 'selective rows not in the selective list' come from another branch's wording and can be ignored only if this ledger's own selective list equals its rows marked selective (check that yourself and state the count).
3. Repeat the live validation of .work/live/m2-svc-0144 (read its evidence/report.md and session.json for the scope and options) at this head with a new session id, following docs/testing/live-validation.md and .claude/skills/live-validate if present: same surfaces, Orca's built-in browser with a new isolated profile for web checks, the real-install guards, temporary HOME/PACER_HOME, non-4317 port. The Updates Install control remains UNVERIFIED under the maintainer exception (harness forces PACER_NO_UPDATE_CHECK=1).
4. Resources are very tight (disk and memory): build only what bun run live needs, with CARGO_INCREMENTAL=0; delete target/ after the session is down and the report is written. Run any bun test only through /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx.
5. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or port 4317.

Report with orca orchestration worker_done: head, ledger-check result and selective count, live report path and Summary line, UNVERIFIED items, and confirmation that all processes, sessions and the browser profile were cleaned up. Always end with worker_done.


Carry out the task described above.

# Task: finish fix/test-port-isolation

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-test-port-isolation (branch fix/test-port-isolation). Head f3bd9557d. Read the original brief (.claude/feature-orchestrator/m2-parallel/ctx/fix-test-port-isolation.md in the main checkout: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-test-port-isolation.md) and the full handoff .work/reviews/port-isolation-worker-handoff.md first. Work was paused for disk; disk now has about 47 GiB free and this is the only heavy job on the machine (no parallel builds or suites besides your own).

## New scope found since the pause (pre-existing defects on main, in this branch's remit)
Strict sandbox evidence from another branch (same tests exist on main) attributed protected-resource contact to these unchanged test files:
- test/native-service-update-parity.test.ts:85 — `compare([status()], () => {})` has no fake service manager, so service.status runs the real `launchctl print` against the maintainer's `com.pacer.serve` label (src/service/index.ts:230, :359), and also reached TCP 4317.
- test/native-plugin-ops.test.ts, test/native-snapshot-get-parity.test.ts, test/native-task-review-parity.test.ts — exec of /bin/launchctl.
- test/native-msg-policy-parity.test.ts — TCP 4317.
- test/native-setup-parity.test.ts — TCP 11434 and 1234.
Fix each at the source (fake service manager or manager stub, pinned ports, fixture model ports) without changing product behavior; if a product path cannot be isolated without a seam, report it. Extend the macOS test sandbox in scripts/test-sandbox.ts to also refuse exec of /bin/launchctl and writes to the real install paths (~/.pacer, /Applications/pacer.app, ~/.local/bin/pacer and pacer-core, ~/Library/LaunchAgents/com.pacer.serve.plist), keeping the four denied ports; keep the disposable-listener self-check and extend it to show the launchctl denial. The reference profile is /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny (deny-only) and sbx-strict (same rules, SIGKILL on contact). Do not copy machine paths into tracked files: derive the home directory at runtime.

## Validation still outstanding
1. Final `bun run typecheck` and `git diff --check`.
2. Contact proof: run each of the six files above, and then the whole suite, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict (tripwire: SIGKILL on contact with 4317/11434/1234, real-install paths or launchctl) wrapping `bun run test` or bun test; zero kills is the acceptance bar. Any kill: identify the test and process and fix it.
3. Base comparison: compare per-file pass/fail/skip between the branch and its merge-base with origin/main (git merge-base HEAD origin/main) on this machine, both under the deny-only boundary (sbx-deny around the base run, the branch's own wrapper for the branch run), with TZ pinned as before, PACER_TEST_BROWSER set (install Playwright Chromium if missing, inside the worktree's node_modules) and the native front door built (CARGO_INCREMENTAL=0). Run in shards (for example by directory or file list chunks) so a disk stop does not lose everything; record per-file counts in .work/reviews/port-isolation-comparison.md. Stop and report if free disk falls below 10 GiB; clean the scratch base worktree and targets afterwards.
4. Classify every branch failure: same at base (pre-existing), environmental (explain), or introduced (fix). The 48 failures from the earlier branch run must each be accounted for. Known pre-existing: tray layout/board browser tests (separate task), hard-coded /bin/ps fixtures under any sandbox.
5. Record the unresolved structural boundary from the handoff (plugin registry sealed env without PACER_PORT; macOS sandbox as the boundary) in the report.

Commit fixes signed (git commit -s; `test:` or `fix(test):`). Do not push. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Stop everything you start.

Update the handoff with a new section, then report with orca orchestration worker_done: head and commits, the six-file fixes, sandbox profile changes, typecheck, tripwire result (kills: none or list), branch vs base per-file comparison summary and every failure's classification, UNVERIFIED items, cleanup. Always end with worker_done.

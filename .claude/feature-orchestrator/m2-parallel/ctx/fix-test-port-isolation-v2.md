# Implementation task: make every test process unable to reach the real pacer service

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-test-port-isolation
- Branch: fix/test-port-isolation, based on origin/main. Work only here.

## Problem
AGENTS.md forbids touching the maintainer's real pacer install, including the `com.pacer.serve` service. Core's `connectClient` (`src/api/client.ts`) probes `http://127.0.0.1:${PACER_PORT ?? 4317}/health` whenever PACER_HOME has a token and uses that service if it answers, and always targets that port when `PACER_WORK_GRANT` is set. `src/guard/guard.ts`, `src/setup/check.ts`, `src/dashboard/client.ts`, `src/service/index.ts` health checks and the Rust CLI (`crates/cli/src/dispatch/guard.rs`, `status_line/runtime.rs`, `dispatch.rs`) also default to 4317. Tests that spawn processes (Bun.spawn, child_process, the built front door, `_run` runners, fixtures that spawn further children) with a disposable HOME/PACER_HOME but no PACER_PORT can therefore reach the real service on a developer machine. This has already happened once on a branch (requests with a bogus work grant hit the real service and were refused). Pre-existing example on main: `test/native-dispatch.test.ts`.

## Required
1. A small shared test helper (e.g. in `test/` support code) that builds child-process environments: disposable HOME and PACER_HOME, and PACER_PORT always set (the test's own server port when given, otherwise a reserved closed port obtained by binding an ephemeral port and closing it). Never 4317. Keep it simple and idiomatic for this codebase.
2. Audit EVERY test and fixture under `test/` (and Rust integration tests that spawn the CLI or front door, if any) that spawns processes; switch them to the helper or otherwise pin PACER_PORT for the child and all descendants. Also consider in-process tests whose ctx.env lacks PACER_PORT while calling code paths that may contact the service (`connectClient`, guard, setup check); pin there too (e.g. in the shared fake ctx / test setup preload) if that is the established seam.
3. A regression guard that runs in CI: for example a test that scans test sources for spawn calls whose env is not built by the helper, or a runtime guard in the test preload that fails any test whose spawned env lacks PACER_PORT or uses 4317. Choose whichever is reliable and low-noise; justify it in the commit message.
4. Do not change product behaviour. If you find a product path that cannot be isolated from tests without a seam, report it rather than adding one silently.

## Validation
- Full `bun test` (record pass/skip/fail counts and compare against origin/main's counts on the same machine: run the base in a temp worktree; any new failure must be explained or fixed), `bun run typecheck` (or the project's type check), and `cargo test` if Rust tests change.
- Show that no test contacts 127.0.0.1:4317. You cannot bind 4317 while the real service holds it, so rely on the code audit plus the regression guard, and where possible observe the suite's connections (for example with `lsof -i` sampling) to show none target 4317. Never stop, restart or reconfigure the real service to test this.
- This change only touches tests and test support, so `bun run live` is not required unless you change runtime code; if you do change runtime code, live validation per docs/testing/live-validation.md is required.

## Governance
Read first: AGENTS.md, .project/constitution.md, .project/context.md, .agents/skills/project-governance/SKILL.md; rules .project/rules/repository.md, code-and-testing.md, security.md. Conventional Commits (`test:` or `fix(test):`), `git commit -s`. Do not push. Do not commit .work/. No machine-specific paths or personal emails in tracked files.

## Hard safety rules
Never touch /Applications/pacer.app, ~/.local/bin/pacer and pacer-core, ~/.pacer, the com.pacer.serve service or launchd label. Stop everything you start.

## Report
Report with `orca orchestration worker_done`: commit hashes, files changed, the guard you chose, test counts for branch and base, and anything left UNVERIFIED. Always end with worker_done.

## Continuation brief
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

## Later coordinator directions
- Extend macOS sandbox denial to LM Studio's internal port 41343 as well as 4317, 11434 and 1234.
- Gate only the real-OpenCode case in test/api-ops-endpoint.test.ts behind PACER_TEST_REAL_OPENCODE=1, because its third-party provider auto-detection probes real model ports and cannot be redirected.
- Do not add a product seam for native setup model probes: m2/setup-doctor adds PACER_TEST_LOCAL_SERVER_PORTS; native-setup-parity is pinned after that branch merges.
- Read-only desktop process enumeration is permitted.

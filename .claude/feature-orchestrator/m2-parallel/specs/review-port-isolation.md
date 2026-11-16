# Independent project review: fix/test-port-isolation

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-test-port-isolation`
- Branch: `fix/test-port-isolation`
- Base (merge-base with origin/main): `33e584bce245764f169ead5b44ac19ae2740a589`
- Reviewed head: `196036d8ea57e65d1ea3ac68e94ed7d9c8887d1d`
- Commits in scope:
  - 196036d8e test: require opt-in for real OpenCode endpoint probe
  - 489b93616 test: stub service probe in FIFO fixture
  - 0ffcf5a0e test: isolate service probes and protect real installation
  - f3bd9557d test: leave non-macOS test runner unchanged
  - 954ddcc99 test: check combined sandbox deny rules
  - 9feb815f8 test: prevent sandbox bypass through inherited environment
  - c32c8950d test: fail closed when safe port allocation stalls
  - d6fb84e63 test: align simulated service label port
  - 720f42b8c test: preserve mock service registration port
  - 6cc0f2aad test: stub local models in endpoint candidate fixture
  - 23279977f test: isolate local model server discovery
  - fb3e0b0f5 test: expect isolated port in console discovery
  - 4f963235e test: block real service port for macOS test trees
  - ac3cf44b5 test: retain acceptance fixture environment
  - fde6e00e9 test: pin remote and plugin fixture descendants
  - b56000ab9 test: pin fixture and recovery process ports
  - 4a636062b test: preserve isolated port when replacing contexts
  - 7bdda07c2 test: isolate explicit child environments
  - 6d7462231 test: isolate native parity child service ports
  - 64ce38419 test: pin inherited and fake context service ports
  - 6e770df90 test: isolate native dispatch fixture port
- Raw changes: `git diff 33e584bce245764f169ead5b44ac19ae2740a589..196036d8ea57e65d1ea3ac68e94ed7d9c8887d1d` and `git log -p 33e584bce245764f169ead5b44ac19ae2740a589..196036d8ea57e65d1ea3ac68e94ed7d9c8887d1d`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
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
---

## Governance context

Read first: `AGENTS.md`, `.project/constitution.md`, `.project/context.md`, `.agents/skills/project-review/SKILL.md`.
Rules that apply to these paths: `.project/rules/repository.md`, `.project/rules/code-and-testing.md`, `.project/rules/rust.md`, `.project/rules/rust-crates.md`, `.project/rules/architecture.md`, `.project/rules/api-protocol.md`, `.project/rules/security.md`.
Reviewer definitions: `.project/reviewers/architecture.md`, `.project/reviewers/protocol-compat.md`, `.project/reviewers/qa.md`, `.project/reviewers/security.md`. Also check `.project/decisions.md` for relevant open decisions.

## What to check

- The change does what the requirements ask, or each deviation is justified and safe.
- Native Rust behavior matches the TypeScript reference byte-for-byte for every case the parity claims cover (error codes, messages, refusals), and anything not native is forwarded unchanged.
- Bridges and forwarding preserve the caller's auth, enforcement identity and timeouts; no new privilege or unauthenticated path.
- Tests actually exercise the claims (parity tests compare against the TypeScript path, not a fixture of themselves). `docs/testing/m2-ledger.md` rows and totals match what the code registers.
- No machine-specific paths or personal emails in tracked files; commits are signed off (DCO).

You may run read-only and test commands (git, rg, cargo test, cargo clippy, cargo fmt --check, bun test for the touched tests). Do not edit tracked files, commit, push, or change branches. Never touch the real pacer install (`/Applications/pacer.app`, `~/.local/bin/pacer*`, `~/.pacer`, `com.pacer.serve`); do not run `bun run live`. If a check cannot run, record it as UNVERIFIED.

## Re-review context

Coordinator scope note for this review:
- Read the worker handoff .work/reviews/port-isolation-worker-handoff.md and comparison .work/reviews/port-isolation-comparison.md in the worktree, then verify their claims against code and with targeted runs.
- RESOURCE RULE: do NOT run the full bun suite or any sharded whole-suite run; another worker is running heavy cargo work and the maintainer requires heavy jobs to be serialized. The coordinator will run a final whole-suite sbx-strict zero-kill proof separately after your review. Run targeted files only (every test file the diff touches plus the specific files the handoff names as fixed or gated), under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict (now denies 4317, 11434, 1234 and 41343 with SIGKILL). Any exit 137 is a finding.
- Known accepted scope: native-setup-parity model-port contact is deferred to the setup-doctor rebase; the real-OpenCode case is opt-in by coordinator direction; read-only desktop enumeration is permitted. Pre-existing base failures are out of scope unless the diff makes them worse.
- Focus: no test can reach the real install, ~/.pacer, com.pacer.serve, launchctl, or the protected ports; isolation changes do not weaken what tests assert (no silently skipped or neutered coverage beyond the opt-in gate); stubs are test-only and do not leak into product code; Linux/non-macOS behaviour unchanged; no machine-specific paths in tracked files.


Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.
- Ledger accuracy (ONLY for branches that change docs/testing/m2-ledger.md or the native op registry; for other branches, a pre-existing ledger inconsistency in an untouched file is out of scope, not a finding): docs/testing/m2-ledger.md aggregate totals (native, stdio, not native) and the selective list must match this branch's actual registry in crates/server/src/native.rs, recounted from the registry, not adjusted from the base. Stale totals are blocking.
- Front-door tests: the native front-door cases skip unless PACER_TEST_NATIVE_FRONT_DOOR is set (and some need a release front door). When you run tests, set it (build the test-ops front door once if needed, in this worktree's existing target dir; disk is tight) so those cases actually run, and report their pass/skip/fail counts. Skipped cases are not evidence.
- (Same scope.) Ledger figures are relative to THIS branch's own crates/server/src/stdio_hello.json and registry at its merge base (bases differ: some branches have 225 v3 ops, newer ones 228). Do not flag a figure as stale because origin/main differs; flag only internal inconsistency with this branch's own catalog and registry. A final recount happens at merge.

- SAFETY: run every bun test / test script you execute as `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx <cmd>` (sandbox denying localhost:4317, with a non-setuid ps on PATH so process checks work). A test that fails only because the sandbox refused 4317 is a test-isolation finding, not a reason to run unsandboxed.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-test-port-isolation/.work/reviews/port-isolation-review.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent review described above and write the report.

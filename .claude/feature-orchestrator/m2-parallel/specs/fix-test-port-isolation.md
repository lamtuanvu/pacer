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


Carry out the implementation task described above, then report with worker_done.

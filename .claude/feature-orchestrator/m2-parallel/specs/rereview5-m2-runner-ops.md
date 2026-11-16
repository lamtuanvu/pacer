# Independent project review: m2/runner-ops

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops`
- Branch: `m2/runner-ops`
- Base (merge-base with origin/main): `561d7ceb185393604c9f76fda786bda3751fc034`
- Reviewed head: `4ace6c37503d6d0fd8a41948af3bd2a1a4fe1fa3`
- Commits in scope:
  - 4ace6c375 docs(m2): reconcile the selective-forwarding count with the registry
  - b2d232796 test(m2): prove forwarded runner.check keeps caller identity and deadline
  - 383a864c1 test(m2): pin PACER_PORT for spawned test processes
  - ef7ed3238 test(m2): exercise runner.check through the stdio front door
  - 4f87d9e84 docs(m2): describe runner.check as native refusals with forwarded checks
  - 332715914 feat(m2): make runner.check refusals native in Rust
- Raw changes: `git diff 561d7ceb185393604c9f76fda786bda3751fc034..4ace6c37503d6d0fd8a41948af3bd2a1a4fe1fa3` and `git log -p 561d7ceb185393604c9f76fda786bda3751fc034..4ace6c37503d6d0fd8a41948af3bd2a1a4fe1fa3`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-runner-ops — runner.check native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops

## Task
Implement `runner.check` as a native Rust operation. Do this step by step:

### Step 1: Create the runner check ops module
Create file: `crates/config-ops/src/runner_check_ops.rs`
- Add module with `runner_check` function
- Validate params: runner id, optional `test` flag
- If `test: true` or omitted, return `Forwarded` (needs job orchestration)
- If `test: false`, run checks natively:
  - Detect agent CLI
  - Check sign-in status
  - Read usage
  - Run scratch test task (forward to job bridge)
- Return results matching TypeScript format

### Step 2: Export the module
In `crates/config-ops/src/lib.rs`: add `pub mod runner_check_ops;`

### Step 3: Register native op
In `crates/server/src/native.rs`:
- Add `use pacer_config_ops::runner_check_ops;`
- Add `NativeOp { name: "runner.check", call: runner_check_ops::runner_check_stub, }`
- Add import for `needs_runner_check_bridge` in `pacer_config_ops`

### Step 4: Create Core bridge
Create `crates/server/src/native/runner_check_sync.rs` with bridge for check steps

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `runner.check` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-runner-check-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-config-ops -p pacer-server && cargo clippy --locked -p pacer-config-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/config-ops/src/runner_check_ops.rs`
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

Re-review of the final revision. Previous report .work/reviews/2026-11-10-m2-runner-ops-rereview4.md: FAIL only on REPO-9 ledger: the selective total said 58 while listing 69 (pre-existing mismatch carried forward). New commit 4ace6c375 (docs only, docs/testing/m2-ledger.md): audited against native.rs, stdio_hello.json and the stdio/HTTP forwarding paths; 228 catalog ops (stale 225 pin fixed), 146 native (134 stdio + 12 plugin), 82 not native, 84 selective = the 69 listed names (none dropped) + job.list/get/cancel + all 12 HTTP plugin ops, on the grounds that they forward request bodies nested deeper than 512 levels. Verify every figure against this branch's registry and catalog in both directions. Specifically judge the plugin-op classification: does a generic depth-limit fallback make an op 'selective' under the ledger's own definition of selective forwarding, or is that a transport-level fallback that should be described once rather than listed per op? Note for consistency: m2/task-send (passed) lists job.* but not the plugin ops (73 entries). Report which reading the ledger's definition supports; a defensible, internally consistent and documented choice is not blocking, but an internal inconsistency is. The implementer reports sandboxed front-door runs 66 pass / 0 skip / 0 fail over 6 files; rerun the affected ones yourself under the sbx wrapper. Live: .work/live/runner-check-web5/evidence/report.md, session HEAD 4ace6c375, clean, 5 PASS / 0 FAIL / 7 UNVERIFIED (5 maintainer-scoped exceptions plus 2 automatic D8 notes).

Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.
- Ledger accuracy: docs/testing/m2-ledger.md aggregate totals (native, stdio, not native) and the selective list must match this branch's actual registry in crates/server/src/native.rs, recounted from the registry, not adjusted from the base. Stale totals are blocking.
- Front-door tests: the native front-door cases skip unless PACER_TEST_NATIVE_FRONT_DOOR is set (and some need a release front door). When you run tests, set it (build the test-ops front door once if needed, in this worktree's existing target dir; disk is tight) so those cases actually run, and report their pass/skip/fail counts. Skipped cases are not evidence.
- Ledger figures are relative to THIS branch's own crates/server/src/stdio_hello.json and registry at its merge base (bases differ: some branches have 225 v3 ops, newer ones 228). Do not flag a figure as stale because origin/main differs; flag only internal inconsistency with this branch's own catalog and registry. A final recount happens at merge.

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops/.work/reviews/2026-11-10-m2-runner-ops-rereview5.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent review described above and write the report.

# Independent project review: m2/task-send

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send`
- Branch: `m2/task-send`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `58b2769bdd3d9b0c742542bb67791ff91ee40772`
- Commits in scope:
  - 58b2769bd docs(m2): make the ledger's selective list match its rows and registry
  - 0b192827c test(m2): recount the native ledger for task.send and cover its bridge refusals
  - 1a1619867 test(m2): pin PACER_PORT for spawned test processes
  - 663b1e85f fix(m2): refuse enforcement identities and decide task.send refusals under the task lock
  - 6360dd2f8 feat(m2): make task.send native in Rust
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..58b2769bdd3d9b0c742542bb67791ff91ee40772` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..58b2769bdd3d9b0c742542bb67791ff91ee40772`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-task-send — task.send native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send

## Task
Implement `task.send` as a native Rust operation.

### Step 1: Create the task send ops module
Create file: `crates/task-ops/src/task_send_ops.rs`
- Add module with `task_send` function
- Validate params: task id, text to send, optional `expect_rev`
- Check driving lease
- Forward to Core bridge for live worker injection
- Return result matching TypeScript format

### Step 2: Export the module
In `crates/task-ops/src/lib.rs`: add `pub mod task_send_ops;`

### Step 3: Register native op
In `crates/server/src/native.rs`:
- Add `use pacer_task_ops::task_send_ops;`
- Add `NativeOp { name: "task.send", call: task_send_ops::task_send_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/task_send_sync.rs` with bridge for live worker injection

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `task.send` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-task-send-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-task-ops -p pacer-server && cargo clippy --locked -p pacer-task-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/task-ops/src/task_send_ops.rs`
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

Re-review of the final revision. Previous report .work/reviews/2026-11-10-m2-task-send-rereview3.md: FAIL only because the ledger's selective list omitted task.get (marked selective in its row). New commit 58b2769bd (docs only, docs/testing/m2-ledger.md): the selective list now equals the native ops whose rows are marked selective, 73 entries ('Seventy-three'); adds task.get and job.list/get/cancel; marks config.set, job.* and desktop.reconcile.request/cancel selective in their rows; scopes dispatch.dependencies to 'waive selective'; fixes pre-existing stale items: update.check now has its own native row (update.apply keeps the Forwarded row), adds missing rows for agent.undo and doctor.fix.delegate, catalog size 225 -> 228. Totals 134 stdio + 12 plugin.* = 146 native, 82 not native. Independently verify every one of these claims against this branch's registry (crates/server/src/native.rs, excluding test-ops) and stdio_hello.json, both directions (selective rows == list; every v3 op has a row; native rows == registry), and that each newly selective op really forwards some inputs/effects in code (e.g. job_stays_forwarded). The implementer's report does not state its Bun runs were sandboxed, so rerun the affected tests yourself under the sandbox wrapper with PACER_TEST_NATIVE_FRONT_DOOR set and report counts. Live: .work/live/m2-send-r4/evidence/report.md, session HEAD 58b2769bd, clean, 5 PASS / 0 FAIL / 6 UNVERIFIED.

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send/.work/reviews/2026-11-10-m2-task-send-rereview4.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

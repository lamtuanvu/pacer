# Independent project review: m2/task-send

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send`
- Branch: `m2/task-send`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `1a1619867bab3302ff9e53cfdb48d71f45d45318`
- Commits in scope:
  - 1a1619867 test(m2): pin PACER_PORT for spawned test processes
  - 663b1e85f fix(m2): refuse enforcement identities and decide task.send refusals under the task lock
  - 6360dd2f8 feat(m2): make task.send native in Rust
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..1a1619867bab3302ff9e53cfdb48d71f45d45318` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..1a1619867bab3302ff9e53cfdb48d71f45d45318`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

Re-review of the final revision. This branch passed independent review at 663b1e85f (.work/reviews/ in this worktree). New commit 1a1619867 (test-only) pins PACER_PORT for every spawn in the branch's changed tests via test/pinned-port.ts (closedPort, pinnedEnv refusing 4317/missing): native-task-send-parity (front door, core child, lock-holder fixture, built-in run wrapper) and send.test.ts (startRun session host and agent, run wrapper); fixtures record the inherited PACER_PORT and tests assert it; guard test added. Also the session-host startup wait grew to 15 s because the new assertion exposed slow cold starts: check that this does not mask a real failure or weaken a timing assertion. Verify all spawn sites and descendants are pinned and nothing else changed. Live: .work/live/m2-send-final/evidence/report.md, session HEAD 1a1619867, clean, 5 PASS / 0 FAIL / 6 UNVERIFIED. Duplicate helpers across branches are advisory (a canonical repo-wide helper is in progress).

Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send/.work/reviews/2026-11-10-m2-task-send-rereview2.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

# Independent project review: m2/account-list

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list`
- Branch: `m2/account-list`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `34f2fd382aae0e34617153d991bcc01c1ae99968`
- Commits in scope:
  - 34f2fd382 test(m2): pin PACER_PORT for spawned test processes
  - c8990a763 test(server): check account.signin request ids and Linux terminal hand-off
  - cbb64b100 test(server): forward admitted account.signin unchanged through both front doors
  - ad9d4c215 test(server): pin a strategy edit between the native account.list read and the bridge load
  - ee4facaf8 fix(server): bind native account.list rows to the bridge's strategy snapshot
  - 92f759fd7 feat(server): serve account.list and account.signin natively
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..34f2fd382aae0e34617153d991bcc01c1ae99968` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..34f2fd382aae0e34617153d991bcc01c1ae99968`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-account-list — account.list and account.signin native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list

## Task
Implement `account.list` and `account.signin` as native Rust operations in `pacer-account-ops`.

### Step 1: Create account list ops module
Create file: `crates/account-ops/src/account_list_ops.rs`
- Add `account_list` function: return accounts from strategy with basic info
- Add `account_signin` function: return login command for account
- Forward for usage/endpoint/Orca reads
- Return results matching TypeScript format

### Step 2: Export the module
In `crates/account-ops/src/lib.rs`: add `pub mod account_list_ops;`

### Step 3: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_account_ops::account_list_ops;`
- Add `NativeOp { name: "account.list", call: account_list_ops::account_list_stub, }`
- Add `NativeOp { name: "account.signin", call: account_list_ops::account_signin_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/account_list_sync.rs` with bridge for usage/endpoint/Orca reads

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `account.list` and `account.signin` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-account-list-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-account-ops -p pacer-server && cargo clippy --locked -p pacer-account-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/account-ops/src/account_list_ops.rs`
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

Re-review of the final revision. Previous report .work/reviews/2026-11-10-m2-account-list-rereview2.md: no code defect; its only gap was PR disclosure of exceptions and UNVERIFIED surfaces, which the coordinator will write into the PR description (record it as pending PR text, not as a code finding). New commit 34f2fd382 (test-only): test/port-isolation.ts (closedPort, spawnPinned, assertPinnedPort refusing missing, non-numeric or 4317); all 8 spawns in test/native-dispatch.test.ts, all in native-account-list-parity.test.ts and the core-stdin-proxy fixture go through it; always-on regression test. Verify all spawn sites and descendants are pinned (including executor/work-grant callers and the serve child's core), the stand-ins still shadow every launcher, and nothing else changed. Live: .work/live/m2-account-list-34f/evidence/report.md, session HEAD 34f2fd382, clean, 5 PASS / 0 FAIL / 6 UNVERIFIED.

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list/.work/reviews/2026-11-10-m2-account-list-rereview3.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

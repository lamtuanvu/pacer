# Independent project review: m2/service-handover

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover`
- Branch: `m2/service-handover`
- Base (merge-base with origin/main): `cc313a0d6222d4c35bf01815b50ee3e8b374f1f6`
- Reviewed head: `0144811c0bfa3d87758b85dd7f2240aae8d93c98`
- Commits in scope:
  - 0144811c0 test(m2): pin PACER_PORT for spawned test processes
  - 3246c652f test(m2): catch a reintroduced deadline on the install and update effects bridge
  - b4f476b7b test(m2): prove service.handover and service.work stay forwarded through both front doors
  - b2f728eaa fix(m2): keep forwarded completion semantics for native service.install and update.apply
  - 232049266 feat(m2): make service.install and update.apply native over a Core effects bridge
  - 1e93193d4 feat(m2): make service.handover and service.work native in Rust
- Raw changes: `git diff cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..0144811c0bfa3d87758b85dd7f2240aae8d93c98` and `git log -p cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..0144811c0bfa3d87758b85dd7f2240aae8d93c98`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-service-handover — service.install and update.apply native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover

## Task
Implement `service.install` and `update.apply` as native Rust operations.

### Step 1: Create service install ops module
Create file: `crates/install/src/install_ops.rs`
- Add `service_install` function: validate params, write install manifest, call Core bridge for launchctl/systemctl
- Add `service_uninstall` function (if needed)

### Step 2: Create update apply ops module
Create file: `crates/update/src/apply.rs`
- Add `update_apply` function: validate params, run update job, call Core bridge for download/verify/replace/restart

### Step 3: Export modules
In `crates/install/src/lib.rs`: add `pub mod install_ops;`
In `crates/update/src/lib.rs`: add `pub mod apply;`

### Step 4: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_install::install_ops;`
- Add `use pacer_update::apply;`
- Add `NativeOp { name: "service.install", call: install_ops::service_install_stub, }`
- Add `NativeOp { name: "update.apply", call: apply::update_apply_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/install_apply_sync.rs` with bridge for launchctl/systemctl and update job

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `service.install` and `update.apply` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-install-apply-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-install -p pacer-update -p pacer-server && cargo clippy --locked -p pacer-install -p pacer-update -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/install/src/install_ops.rs` and `crates/update/src/apply.rs`
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

Final re-review. Previous report .work/reviews/2026-11-10-m2-service-handover-rereview2.md: UNVERIFIED only for the Updates Install control (the maintainer has since granted an explicit exception for it; see the policy below) plus a nonblocking CT-4 note that the 1.5 s delayed call could not catch a reintroduced 120 s bridge deadline. New commit 3246c652f adds a test-ops-only seam PACER_TEST_BRIDGE_DEADLINE_MS shortening the bridge deadline, and a regression test through the real HTTP and stdio front doors: a 2 s service.install and a 2 s held update.apply preflight must answer with Core's results while a setup.check control times out at 300 ms. Verify the seam is compiled only with test-ops (release behaviour unchanged), the test fails if a deadline is put on either effect, and the change is otherwise minimal. Also verify PACER_PORT isolation for every spawn in the branch's tests (the implementer was asked to check this; it is not mentioned in its report). Live: .work/live/m2-svc-3246/evidence/report.md, session HEAD 3246c652f, clean, 11 PASS / 0 FAIL / 20 UNVERIFIED. CRATE-1: pacer-server exceeds 12,000 LOC on main already; a time-boxed maintainer exception is being recorded separately (docs/crate1-server-exception); record this branch's pacer-server LOC delta, not a blocking finding.

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover/.work/reviews/2026-11-10-m2-service-handover-rereview3.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

# Independent project review: m2/service-handover

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover`
- Branch: `m2/service-handover`
- Base (merge-base with origin/main): `cc313a0d6222d4c35bf01815b50ee3e8b374f1f6`
- Reviewed head: `50a69ed98f0157d5be646500cef27c8b47f614c7`
- Commits in scope:
  - 50a69ed98 docs(m2): reconcile ledger rows and figures with the catalog
  - 0144811c0 test(m2): pin PACER_PORT for spawned test processes
  - 3246c652f test(m2): catch a reintroduced deadline on the install and update effects bridge
  - b4f476b7b test(m2): prove service.handover and service.work stay forwarded through both front doors
  - b2f728eaa fix(m2): keep forwarded completion semantics for native service.install and update.apply
  - 232049266 feat(m2): make service.install and update.apply native over a Core effects bridge
  - 1e93193d4 feat(m2): make service.handover and service.work native in Rust
- Raw changes: `git diff cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..50a69ed98f0157d5be646500cef27c8b47f614c7` and `git log -p cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..50a69ed98f0157d5be646500cef27c8b47f614c7`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

Light final re-review at HEAD 50a69ed98. Previous report .work/reviews/2026-11-10-m2-service-handover-rereview3.md passed the code at 0144811c0. The only new commit since 0144811c0 is 50a69ed98, a docs-only change adding missing rows to docs/testing/m2-ledger.md. Scope: (1) confirm 0144811c0..50a69ed98 touches only the ledger and adds no code; (2) check the new ledger rows are accurate against the native op registry and catalog on this branch (row, label and catalog checks; you may run /tmp/ledger-check.ts or .work/fixtures/ledger-check.ts, whose selective-list wording parser is known stale and exits 1 for that reason only; confirm the selective list independently); (3) confirm live evidence .work/live/m2-svc-50a69/evidence/report.md (9 PASS, 0 FAIL, 15 UNVERIFIED) is from HEAD 50a69ed98 with a clean tree and covers the same surfaces as the earlier m2-svc-0144 report (rows were consolidated, not dropped), with UNVERIFIED items limited to maintainer exceptions and D3/D8 guards. Do not rebuild or rerun the full suite; code was accepted at 0144811c0. Write the report to .work/reviews/2026-11-10-m2-service-handover-rereview4.md.


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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover/.work/reviews/2026-11-10-m2-service-handover-rereview4.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent review described above and write the report.

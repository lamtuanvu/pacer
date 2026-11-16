# Independent project review: m2/service-handover

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover`
- Branch: `m2/service-handover`
- Base (merge-base with origin/main): `cc313a0d6222d4c35bf01815b50ee3e8b374f1f6`
- Reviewed head: `b4f476b7b0a978eb60d0cedc857400cc173fc886`
- Commits in scope:
  - b4f476b7b test(m2): prove service.handover and service.work stay forwarded through both front doors
  - b2f728eaa fix(m2): keep forwarded completion semantics for native service.install and update.apply
  - 232049266 feat(m2): make service.install and update.apply native over a Core effects bridge
  - 1e93193d4 feat(m2): make service.handover and service.work native in Rust
- Raw changes: `git diff cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..b4f476b7b0a978eb60d0cedc857400cc173fc886` and `git log -p cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..b4f476b7b0a978eb60d0cedc857400cc173fc886`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is the second re-review, of the final revision. Earlier reports in this worktree: `.work/reviews/2026-11-10-m2-service-handover-review.md` (initial, FAIL) and the first re-review report plus its follow-up addendum under `.work/reviews/` (no code blockers; UNVERIFIED because service.handover / service.work lacked front-door end-to-end tests and the Setup / Install web controls were not exercised).

Maintainer decisions still in force: `service.handover` and `service.work` stay FORWARDED on this branch (making them native is a separate task); the D3/D8-guarded ops (service.install, update.apply, service.handover, service.work) are covered by the maintainer-scoped exception, provided isolated end-to-end tests through the real HTTP and stdio front doors exist and really exercise them.

New since the first re-review: commit b4f476b7b adds end-to-end tests through the real Rust HTTP and stdio front doors with disposable homes and a fixture core, asserting service.handover and service.work replies are byte-identical to PACER_FORWARD_OPS forcing, including errors and caller identity (13 HTTP cases; operator, executor and work-grant stdio sessions), plus a registry test that neither op is native. Check that these tests really go through the front doors, would fail if the ops were made native or mis-forwarded, cover successful (not only error) cases, preserve caller identity, and clean up processes; and that the commit changes nothing else unexpectedly.

Live evidence for this head: `.work/live/m2-svc-b4f4/evidence/report.md` (session HEAD b4f476b7b, clean, 11 PASS / 0 FAIL / 19 UNVERIFIED). The Setup service step and Diagnostics Install service repair were driven in an isolated Orca browser profile and hit the D8 403 with the refusal shown (PASS as guard evidence). The Updates Install control is recorded UNVERIFIED because the harness forces PACER_NO_UPDATE_CHECK=1 and the only update-offering flow bootstraps launchd jobs. Judge whether that reason is sound and whether automated tests cover the update.apply bridge path well enough under the exception; if not, specify the exact test needed.

Known cross-branch issue: large numeric JSON-RPC ids on stdio (fixed separately in afd3622fb on m2/dispatch-ops). Record as a shared dependency only.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover/.work/reviews/2026-11-10-m2-service-handover-rereview2.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

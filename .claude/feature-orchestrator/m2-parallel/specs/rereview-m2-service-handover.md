# Independent project review: m2/service-handover

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover`
- Branch: `m2/service-handover`
- Base (merge-base with origin/main): `cc313a0d6222d4c35bf01815b50ee3e8b374f1f6`
- Reviewed head: `b2f728eaabfaecd2b795f00f2ded2c844b4a7485`
- Commits in scope:
  - b2f728eaa fix(m2): keep forwarded completion semantics for native service.install and update.apply
  - 232049266 feat(m2): make service.install and update.apply native over a Core effects bridge
  - 1e93193d4 feat(m2): make service.handover and service.work native in Rust
- Raw changes: `git diff cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..b2f728eaabfaecd2b795f00f2ded2c844b4a7485` and `git log -p cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..b2f728eaabfaecd2b795f00f2ded2c844b4a7485`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is a re-review of the final revision. The previous independent review is at `.work/reviews/2026-11-10-m2-service-handover-review.md` in this worktree. Maintainer decision for its finding 1: `service.handover` and `service.work` stay FORWARDED on this branch and are tracked as a separate task; treat that as the requirement, and check that the ledger, docs and commit messages say so accurately (including that earlier commit 1e93193d4 overstates its change). Findings 2 (the 120 s bridge timeout changing service.install/update.apply completion semantics) and 3 (no end-to-end test through the real HTTP and stdio front doors and bridge) were to be fixed. Verify each fix and its tests thoroughly: does the bridge now preserve the forwarded path's timeout and completion semantics on both transports? Do the e2e tests use the real front doors with disposable homes and safe injected effects, and do they fail without the fix? Is there any path left where an install can be reported as failed while Core continues? Re-check every change since the previous report and the rest of the diff. Never run anything that could reach a real service manager. The implementer is running live validation in parallel; if a report for this revision appears under `.work/live/` before you finish, assess it, otherwise record live validation as UNVERIFIED.

Known cross-branch issue: on stdio the shared native JSON-RPC responder preserves large numeric request ids exactly, while forwarding rounds them like JavaScript. A shared fix is being made separately on the m2/dispatch-ops branch and will land before or with these branches. If you see it here, record it as a known shared dependency (note whether this branch adds exposure), not as a new investigation.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover/.work/reviews/2026-11-10-m2-service-handover-rereview.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent re-review described above and write the report.

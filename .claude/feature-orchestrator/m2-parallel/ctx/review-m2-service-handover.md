# Independent project review: m2/service-handover

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover`
- Branch: `m2/service-handover`
- Base (merge-base with origin/main): `cc313a0d6222d4c35bf01815b50ee3e8b374f1f6`
- Reviewed head: `2320492666f06c5c45357acadb5514a657bec144`
- Commits in scope:
- 232049266 feat(m2): make service.install and update.apply native over a Core effects bridge
- 1e93193d4 feat(m2): make service.handover and service.work native in Rust
- Raw changes: `git diff cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..2320492666f06c5c45357acadb5514a657bec144` and `git log -p cc313a0d6222d4c35bf01815b50ee3e8b374f1f6..2320492666f06c5c45357acadb5514a657bec144`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief for the latest commit follows. For any earlier commit in scope, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

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

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover/.work/reviews/2026-11-10-m2-service-handover-review.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

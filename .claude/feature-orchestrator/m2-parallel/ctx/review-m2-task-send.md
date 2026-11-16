# Independent project review: m2/task-send

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send`
- Branch: `m2/task-send`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `6360dd2f8b0cafb3b0576ca04f52e5df06ee9b5e`
- Commits in scope:
- 6360dd2f8 feat(m2): make task.send native in Rust
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..6360dd2f8b0cafb3b0576ca04f52e5df06ee9b5e` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..6360dd2f8b0cafb3b0576ca04f52e5df06ee9b5e`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief for the latest commit follows. For any earlier commit in scope, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

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

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send/.work/reviews/2026-11-10-m2-task-send-review.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

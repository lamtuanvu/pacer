# Independent project review: m2/task-send

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send`
- Branch: `m2/task-send`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `663b1e85f983006ce0625f76537ace969860ae80`
- Commits in scope:
  - 663b1e85f fix(m2): refuse enforcement identities and decide task.send refusals under the task lock
  - 6360dd2f8 feat(m2): make task.send native in Rust
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..663b1e85f983006ce0625f76537ace969860ae80` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..663b1e85f983006ce0625f76537ace969860ae80`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is a re-review of the final revision. The previous independent review is at `.work/reviews/2026-11-10-m2-task-send-review.md` in this worktree. Both of its blocking findings were to be fixed: (1) the native handler skipped `authorizeWorkOperation`, so an enforcement identity without an executor role could get a record refusal or reach a live send; (2) stale revision, waiting, state and lease refusals were decided from a read outside the task lock and never rechecked. Verify each fix and its tests thoroughly: enforcement must be refused before params are parsed exactly as TypeScript does, for valid and invalid params, with no effects; every record-dependent refusal must be decided under the same lock TypeScript uses, or left to Core; do the new tests fail without the fix? Re-check every change since the previous report and the rest of the diff. The implementer is running live validation in parallel; if a report for this revision appears under `.work/live/` before you finish, assess it, otherwise record live validation as UNVERIFIED.

Known cross-branch issue: on stdio the shared native JSON-RPC responder preserves large numeric request ids exactly, while forwarding rounds them like JavaScript. A shared fix is being made separately on the m2/dispatch-ops branch and will land before or with these branches. If you see it here, record it as a known shared dependency (note whether this branch adds exposure), not as a new investigation.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send/.work/reviews/2026-11-10-m2-task-send-rereview.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

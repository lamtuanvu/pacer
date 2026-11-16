# Independent project review: m2/dispatch-ops

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops`
- Branch: `m2/dispatch-ops`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `996c529db5e30aa60e30f916d8a9cd5fe098e75a`
- Commits in scope:
  - 996c529db fix(server): forward dispatch lifecycle bodies Rust cannot represent
  - 88df34c06 feat(server): register dispatch lifecycle ops natively with selective forwarding
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..996c529db5e30aa60e30f916d8a9cd5fe098e75a` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..996c529db5e30aa60e30f916d8a9cd5fe098e75a`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-dispatch-ops — dispatch lifecycle ops native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops

## Task
Implement `dispatch.submit`, `dispatch.child`, `dispatch.wait`, `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` as native Rust operations.

### Step 1: Create dispatch lifecycle ops module
Create file: `crates/dispatch-ops/src/lifecycle_ops.rs`
- Add `dispatch_submit` function: validate params, check work grants, queue mutation, call Core bridge for worker spawn
- Add `dispatch_child` function: scoped child admission
- Add `dispatch_wait` function: poll until work item settles
- Add `dispatch_review` function: review acceptance/rejection
- Add `dispatch_retry` function: retry with same revision
- Add `dispatch_answer` function: handle executor Q&A
- Add `dispatch_stop` function: stop work item and subtree
- All functions forward for worker/supervision bridging

### Step 2: Export the module
In `crates/dispatch-ops/src/lib.rs`: add `pub mod lifecycle_ops;`

### Step 3: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_dispatch_ops::lifecycle_ops;`
- Add `NativeOp` entries for all 7 operations with `_stub` calls

### Step 4: Create Core bridge
Create `crates/server/src/native/dispatch_lifecycle_sync.rs` with bridge for worker/supervision

### Step 4: Update ledger
In `docs/testing/m2-ledger.md`: change all 7 dispatch ops from Forwarded to Native (selective)

### Step 5: Add parity test
Create `test/native-dispatch-lifecycle-parity.test.ts`

### Step 6: Run tests
Run: `cargo test -p pacer-dispatch-ops -p pacer-server && cargo clippy --locked -p pacer-dispatch-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/dispatch-ops/src/lifecycle_ops.rs`
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

This is a re-review of the final revision. The previous independent review is at `.work/reviews/2026-11-10-m2-dispatch-ops-review.md` in this worktree. It had two blocking findings. For finding 1 (lifecycle work forwarded rather than native), the maintainer ACCEPTED the narrower scope: refusals are native and all lifecycle work is forwarded. Treat that decision as the requirement now, replacing the brief's native-lifecycle steps, and check that the ledger and commit messages describe it accurately. Finding 2 (HTTP bodies serde_json rejects no longer reaching Core) was to be fixed; verify the fix and its tests thoroughly, including whether any other body or number shape still diverges from forced forwarding. Re-check every change since the previous report and the rest of the diff. The implementer is running live validation in parallel; if a report appears under `.work/live/` before you finish, assess it, otherwise record live validation as UNVERIFIED.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops/.work/reviews/2026-11-10-m2-dispatch-ops-rereview.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

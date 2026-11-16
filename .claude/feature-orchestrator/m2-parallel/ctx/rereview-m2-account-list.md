# Independent project review: m2/account-list

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list`
- Branch: `m2/account-list`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `ee4facaf879d5d35ca5dd5d07481d97c42896b72`
- Commits in scope:
  - ee4facaf8 fix(server): bind native account.list rows to the bridge's strategy snapshot
  - 92f759fd7 feat(server): serve account.list and account.signin natively
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..ee4facaf879d5d35ca5dd5d07481d97c42896b72` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..ee4facaf879d5d35ca5dd5d07481d97c42896b72`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is a re-review of the final revision. The previous independent review is at `.work/reviews/2026-11-10-m2-account-list-review.md` in this worktree. Both of its blocking findings were to be fixed: (1) account.list could mix data from two strategy snapshots during concurrent edits; (2) the m2 ledger totals and selective-forward list were stale. Verify each fix and its tests thoroughly (do the regressions fail without the fix? is every value in a row now taken from one snapshot? do the ledger totals match the actual registry and protocol?). Re-check every change since the previous report and the rest of the diff. A live report for this revision may exist under `.work/live/`; assess it.

Known cross-branch issue: on stdio the shared native JSON-RPC responder preserves large numeric request ids exactly, while forwarding rounds them like JavaScript. A shared fix is being made separately on the m2/dispatch-ops branch and will land before or with these branches. If you see it here, record it as a known shared dependency (note whether this branch adds exposure), not as a new investigation.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list/.work/reviews/2026-11-10-m2-account-list-rereview.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

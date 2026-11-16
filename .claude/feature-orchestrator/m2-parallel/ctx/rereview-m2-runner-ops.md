# Independent project review: m2/runner-ops

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops`
- Branch: `m2/runner-ops`
- Base (merge-base with origin/main): `561d7ceb185393604c9f76fda786bda3751fc034`
- Reviewed head: `4f87d9e84932e435a43ce1ed7bfb7dcffd8465bf`
- Commits in scope:
  - 4f87d9e84 docs(m2): describe runner.check as native refusals with forwarded checks
  - 332715914 feat(m2): make runner.check refusals native in Rust
- Raw changes: `git diff 561d7ceb185393604c9f76fda786bda3751fc034..4f87d9e84932e435a43ce1ed7bfb7dcffd8465bf` and `git log -p 561d7ceb185393604c9f76fda786bda3751fc034..4f87d9e84932e435a43ce1ed7bfb7dcffd8465bf`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-runner-ops — runner.check native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops

## Task
Implement `runner.check` as a native Rust operation. Do this step by step:

### Step 1: Create the runner check ops module
Create file: `crates/config-ops/src/runner_check_ops.rs`
- Add module with `runner_check` function
- Validate params: runner id, optional `test` flag
- If `test: true` or omitted, return `Forwarded` (needs job orchestration)
- If `test: false`, run checks natively:
  - Detect agent CLI
  - Check sign-in status
  - Read usage
  - Run scratch test task (forward to job bridge)
- Return results matching TypeScript format

### Step 2: Export the module
In `crates/config-ops/src/lib.rs`: add `pub mod runner_check_ops;`

### Step 3: Register native op
In `crates/server/src/native.rs`:
- Add `use pacer_config_ops::runner_check_ops;`
- Add `NativeOp { name: "runner.check", call: runner_check_ops::runner_check_stub, }`
- Add import for `needs_runner_check_bridge` in `pacer_config_ops`

### Step 4: Create Core bridge
Create `crates/server/src/native/runner_check_sync.rs` with bridge for check steps

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `runner.check` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-runner-check-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-config-ops -p pacer-server && cargo clippy --locked -p pacer-config-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/config-ops/src/runner_check_ops.rs`
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

This is a re-review of the final revision. A previous independent review is at `.work/reviews/2026-11-10-m2-runner-ops-review.md` in this worktree. Its one blocking finding was that the brief's native `test: false` checks were not implemented. The maintainer has since decided to ACCEPT the narrower scope: `runner.check` refusals are native, every check is forwarded, and there is no protocol change. Treat that decision as the requirement now, replacing the brief's native-check steps. Check that the final revision accurately reflects it (ledger row, totals, commit messages), re-check every change since the previous report, and re-check the rest of the diff for anything the previous review missed.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops/.work/reviews/2026-11-10-m2-runner-ops-rereview.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

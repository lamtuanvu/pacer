# Independent project review: m2/dispatch-ops

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops`
- Branch: `m2/dispatch-ops`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `afd3622fbee8b0f5196bbb3beb5fd8e29fc9f619`
- Commits in scope:
  - afd3622fb fix(server): forward stdio requests whose id JavaScript cannot round-trip
  - 996c529db fix(server): forward dispatch lifecycle bodies Rust cannot represent
  - 88df34c06 feat(server): register dispatch lifecycle ops natively with selective forwarding
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..afd3622fbee8b0f5196bbb3beb5fd8e29fc9f619` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..afd3622fbee8b0f5196bbb3beb5fd8e29fc9f619`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is the second re-review of the final revision. Earlier reports in this worktree: `.work/reviews/2026-11-10-m2-dispatch-ops-review.md` and `.work/reviews/2026-11-10-m2-dispatch-ops-rereview.md`. The maintainer accepted the refusals-only scope for the lifecycle ops (treat it as the requirement). The second report's one blocking finding was that the shared stdio JSON-RPC responder preserved large numeric request ids exactly while forwarding rounded them; it was to be fixed in the shared responder as a separate, self-contained commit that can land on origin/main on its own. Verify that fix thoroughly: is the native/forward gate exactly the set of ids JavaScript round-trips unchanged? Is every reply site gated? Are protocol state and hello handling still correct? Do the raw-wire tests write raw bytes and fail without the fix? Does the commit really apply to origin/main independently (try `git merge-tree`)? Confirm HTTP is not exposed. Re-check every change since the previous report. The implementer is rerunning live validation at this head; if a report whose session HEAD equals the reviewed head appears under `.work/live/` before you finish, assess it, otherwise record live validation as UNVERIFIED.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops/.work/reviews/2026-11-10-m2-dispatch-ops-rereview2.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent re-review described above and write the report.

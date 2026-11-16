# Independent project review: m2/dispatch-ops

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops`
- Branch: `m2/dispatch-ops`
- Base (merge-base with origin/main): `46f74750fd04bd444b6584a0fb079eba4b99aab0`
- Reviewed head: `6737cf7c14d86b354645659086a28b2339b31e27`
- Commits in scope:
  - 6737cf7c1 test(server): drive valid dispatch review, retry and answer through the stdio front door
  - afd3622fb fix(server): forward stdio requests whose id JavaScript cannot round-trip
  - 996c529db fix(server): forward dispatch lifecycle bodies Rust cannot represent
  - 88df34c06 feat(server): register dispatch lifecycle ops natively with selective forwarding
- Raw changes: `git diff 46f74750fd04bd444b6584a0fb079eba4b99aab0..6737cf7c14d86b354645659086a28b2339b31e27` and `git log -p 46f74750fd04bd444b6584a0fb079eba4b99aab0..6737cf7c14d86b354645659086a28b2339b31e27`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is the final re-review. Earlier reports in this worktree's `.work/reviews/` (initial, rereview, rereview2, and `final-m2-dispatch-ops.md`, UNVERIFIED: stdio tests sent review/retry/answer only with a missing work id). Maintainer decisions in force: refusals-only native scope; the two pre-existing tray task.retry and Needs-you task.answer 403s are a separate fix task and non-blocking here (must be disclosed in the PR); WorkView controls UNVERIFIED is accepted (not mounted).

New since then: commit 6737cf7c1. It adds test/native-dispatch-lifecycle-effects.test.ts (seeds reviewable, retryable and needs-input managed work with Core store calls in disposable homes; sends valid dispatch.review/retry/answer through the real `api --stdio`; asserts Core replies, string and numeric ids, no native trace except the deliberately invalid review, and persisted review, brief.feedback + work.retry_requested, brief.qa + work.answer_recorded; refusing executor PATH stubs, runners killed). It also types HTTP parity bodies for tsc, and changes test/native-stdio-request-id-parity.test.ts to leave `hello` out of the id comparison because under load the front door's 2 s core-descriptor timeout drops coreBuild from hello. Scrutinize that last change: confirm it does not weaken the JSON-RPC id guarantee that afd3622fb fixes (ids of the op requests must still be compared exactly, including large numeric ids), and that the hello timeout behaviour is pre-existing on main. Also check the seeded runners and "detached runners Core launches after a restart" are killed and cannot run anything real.

Live evidence: `.work/live/m2-lifecycle-web2/evidence/report.md`, session HEAD 6737cf7c1, clean, 7 PASS / 2 FAIL (the pre-existing ones) / 2 UNVERIFIED; web-bodies-*.json now record exact request bodies and Core responses.

Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops/.work/reviews/2026-11-10-m2-dispatch-ops-rereview3.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

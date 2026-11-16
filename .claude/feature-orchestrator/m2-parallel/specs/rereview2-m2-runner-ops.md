# Independent project review: m2/runner-ops

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops`
- Branch: `m2/runner-ops`
- Base (merge-base with origin/main): `561d7ceb185393604c9f76fda786bda3751fc034`
- Reviewed head: `ef7ed32383386b065847c810bf8335820181a7e8`
- Commits in scope:
  - ef7ed3238 test(m2): exercise runner.check through the stdio front door
  - 4f87d9e84 docs(m2): describe runner.check as native refusals with forwarded checks
  - 332715914 feat(m2): make runner.check refusals native in Rust
- Raw changes: `git diff 561d7ceb185393604c9f76fda786bda3751fc034..ef7ed32383386b065847c810bf8335820181a7e8` and `git log -p 561d7ceb185393604c9f76fda786bda3751fc034..ef7ed32383386b065847c810bf8335820181a7e8`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

This is the final re-review. Earlier reports in this worktree's `.work/reviews/`: the initial review, `2026-11-10-m2-runner-ops-rereview.md`, and `final-m2-runner-ops.md` (FAIL: no test sent runner.check through `api --stdio`; add-agent wizard interaction unverified because its browser test skipped). Maintainer scope decision still in force: refusals are native, checks are forwarded.

New since then: commit ef7ed3238 adds test/native-runner-check-stdio.test.ts and test/fixtures/runner-check-core.ts. The implementer reports: drives the built front door over `api --stdio` with disposable homes and protocol-3 hello; asserts exact JSON-RPC refusals plus native traces for unknown/invalid runners, and finished TypeScript check jobs with no native trace for {id:codex} and {id:codex,test:false} via a stubbed core fixture; request ids and exit checked. Bun 62 pass / 2 skip / 0 fail; Rust runner_check_ops 2 and native::tests 12 pass. app-settings-6b-browser (local Chrome): 15 pass, 4 fail; all six Add agent tests pass, including the one asserting runner.check after Add agent; the 4 failures are in Agents/Machines layout and save-bar tests the branch does not touch (CI's Chromium step does not list this file). Verify that claim against the merge-base if you can (or record UNVERIFIED), and that the new stdio test really exercises the stdio call site and would fail if runner.check were mis-gated or not forwarded.

Live evidence: `.work/live/runner-check-web2/evidence/report.md`, session HEAD ef7ed3238, clean, 5 PASS / 0 FAIL / 7 UNVERIFIED (D8 refusal of runner.add recorded as PASS; post-add check UNVERIFIED live but backed by the passing browser test).

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops/.work/reviews/2026-11-10-m2-runner-ops-rereview2.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent re-review described above and write the report.

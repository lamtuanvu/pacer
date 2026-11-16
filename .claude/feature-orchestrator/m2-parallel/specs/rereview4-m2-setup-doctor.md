# Independent project review: m2/setup-doctor

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor`
- Branch: `m2/setup-doctor`
- Base (merge-base with origin/main): `eb969c1851d4a39f53ffbdc298c53dda8bf50a48`
- Reviewed head: `3c218378496f47326ce883922c3c07c6d4b3c0f2`
- Commits in scope:
  - 3c2183784 test: apply the discover plan fixture to HTTP serving too
  - aa7abe8c5 test(live): let test-ops sandboxes use model probe fixtures and forced forwarding
  - fc13ed7b1 test: wait for the Orca readiness probe in the execution.backend case
  - ab3aaea0f fix(m2): keep candidate probe failures in settlement order
  - 0bcda7c21 test(m2): keep in-process init tests off the real Ollama
  - 09d3bd9e3 fix(m2): probe Ollama for native setup.init through Core's fetch
  - b1f1e1b45 test(m2): pin PACER_PORT for spawned test processes
  - f4f8ab513 test(m2): keep setup parity tests off the machine's local model servers
  - 551fe1f74 fix(m2): address review of setup doctor and setup init native ops
  - 734d292f7 feat(m2): make setup.health and doctor.run native in Rust
  - 28ff2c65b feat(m2): make strategy.build, executor.setup.candidates and setup.init native in Rust
- Raw changes: `git diff eb969c1851d4a39f53ffbdc298c53dda8bf50a48..3c218378496f47326ce883922c3c07c6d4b3c0f2` and `git log -p eb969c1851d4a39f53ffbdc298c53dda8bf50a48..3c218378496f47326ce883922c3c07c6d4b3c0f2`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation Task: m2-setup-doctor — setup.health and doctor.run native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor

## Task
Implement `setup.health` and `doctor.run` as native Rust operations in `pacer-install` crate.

### Step 1: Create doctor ops module
Create file: `crates/install/src/doctor_ops.rs`
- Add `setup_health` function: run setup.check + bounded doctor checks natively
- Add `doctor_run` function: run diagnostics natively, forward plugin checks
- Both return results matching TypeScript format

### Step 2: Export the module
In `crates/install/src/lib.rs`: add `pub mod doctor_ops;`

### Step 3: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_install::doctor_ops;`
- Add `NativeOp { name: "setup.health", call: doctor_ops::setup_health_stub, }`
- Add `NativeOp { name: "doctor.run", call: doctor_ops::doctor_run_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/setup_doctor_sync.rs` with bridge for plugin checks

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `setup.health` and `doctor.run` from Forwarded to Native (selective)

### Step 5: Add parity test
Create `test/native-setup-doctor-parity.test.ts`

### Step 6: Run tests
Run: `cargo test -p pacer-install -p pacer-server && cargo clippy --locked -p pacer-install -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/install/src/doctor_ops.rs`
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

FINAL light re-review of m2/setup-doctor at head 3c2183784. Previous report .work/reviews/2026-11-10-m2-setup-doctor-rereview3.md (at fc13ed7b1): no blocking code defect; UNVERIFIED only because the executor-candidates web screen and probe failure order had no live evidence. Since fc13ed7b1 only test/live-harness files changed (verify this with git diff --stat fc13ed7b1..HEAD: no product code): aa7abe8c5 adds bun run live up options --local-model-ports (PACER_TEST_LOCAL_SERVER_PORTS), --core-fixture (a .ts file under test/fixtures used as PACER_CORE_ARGV) and --native-forward-ops (PACER_FORWARD_OPS), each requiring --native-test-ops and recorded in session.json, with docs and harness tests; 3c2183784 makes the core-discover-plan test fixture replace discoverEndpointModels when Bun loads endpoint-adapter.ts (HTTP serve had no op deps). Judge: (a) safety of the new harness options: can any of them point a live session at the real install, the real 4317 service, or real model servers, or be enabled without --native-test-ops; does the real-install guard still hold; is --core-fixture confined to test/fixtures; (b) whether the fixture's module replacement can leak into production code paths (only when loaded as a test fixture); (c) the live evidence: .work/live/setup-doctor-10a..10d (session HEAD 3c2183784, clean): sandbox denying 4317/11434/1234 for the service and Core; native vs forced-forward replies equal for a fixture model (10a/10b) and for two failures in settlement order differing from server order (10c/10d); real Ollama log check; screenshots. Decide whether the CT-11 candidates-screen gap is closed. RESOURCES: the machine is out of disk and memory; do NOT build Rust (target/ was deleted) and do not run native front-door suites; product code is unchanged since fc13ed7b1, whose front-door suites were independently run (164/0/0 implementer, reviewer rereview3 sandboxed runs). Run only test/live-harness.test.ts and test/endpoint-detect.test.ts under the sbx wrapper. Verdict PASS/FAIL/UNVERIFIED.

Shared safety: run any bun test only via /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx; never touch the maintainer's real pacer install, ~/.pacer, port 4317 or real local model servers.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor/.work/reviews/2026-11-10-m2-setup-doctor-rereview4.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the light independent re-review described above and write the report.

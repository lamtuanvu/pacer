# Independent project review: m2/setup-doctor

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor`
- Branch: `m2/setup-doctor`
- Base (merge-base with origin/main): `eb969c1851d4a39f53ffbdc298c53dda8bf50a48`
- Reviewed head: `b0ad8f844e1ad2cb2aa06c885e84afe6c1cfcedf`
- Commits in scope:
  - b0ad8f844 test: serve local model fixtures in live harness
  - e3c4958bc fix: isolate live model probe ports
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
- Raw changes: `git diff eb969c1851d4a39f53ffbdc298c53dda8bf50a48..b0ad8f844e1ad2cb2aa06c885e84afe6c1cfcedf` and `git log -p eb969c1851d4a39f53ffbdc298c53dda8bf50a48..b0ad8f844e1ad2cb2aa06c885e84afe6c1cfcedf`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

Empirical test-isolation audit at HEAD b0ad8f844 (base eb969c185), rerun with a corrected tripwire. Previous report .work/reviews/2026-11-10-m2-setup-doctor-rereview7.md: FAIL only because the first tripwire killed every Bun suite in the preload guard test/setup.ts:17,23 (realpathSync of ~/.pacer, a guard AGAINST the real home, opens the directory itself). Its Rust results stand (cargo test -p pacer-config-ops 27/0/0, pacer-server native::tests 12/0/0 under the tripwire); do not rerun Rust tests. The orchestrator has revised /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-strict: it now allows opening the ~/.pacer directory itself but still SIGKILLs (exit 137) any process that reads data inside ~/.pacer, writes ~/.pacer, reads or writes /Applications/pacer.app, ~/.local/bin/pacer, ~/.local/bin/pacer-core or the com.pacer.serve plist, connects to 127.0.0.1:4317, 11434 or 1234, or execs /bin/launchctl. Verify that yourself first with harmless probes (sbx-strict curl -m 2 http://127.0.0.1:11434/ must exit 137; sbx-strict bun -e realpathSync of the home .pacer must succeed; never contact 4317 outside the sandbox).
1. Build the debug front door once with CARGO_INCREMENTAL=0 (the binary the native tests need, as rereview7 did) and set PACER_TEST_NATIVE_FRONT_DOOR to its absolute path; set PACER_TEST_BROWSER if a test needs it.
2. Run each of test/api-ops-config.test.ts, test/endpoint-detect.test.ts, test/live-harness.test.ts, test/native-dispatch.test.ts, test/native-setup-doctor-parity.test.ts, test/native-setup-parity.test.ts, test/onboarding-wave1.test.ts, test/pinned-port.test.ts under sbx-strict with PACER_PORT=1 and TZ=Asia/Ho_Chi_Minh, one file at a time; record pass/fail/skip. Any 137/Killed or unexplained abrupt child exit is a FAIL finding: rerun that file alone to name the test and process (file:line). Explain every skip; fix missing configuration you can supply and rerun.
3. Report a per-file table and a verdict: PASS if every file passes with no tripwire kill and no unexplained skip, otherwise FAIL with evidence. Delete target/ when done (disk is limited). Write the report to .work/reviews/2026-11-10-m2-setup-doctor-rereview8.md.


Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.
- Ledger accuracy (ONLY for branches that change docs/testing/m2-ledger.md or the native op registry; for other branches, a pre-existing ledger inconsistency in an untouched file is out of scope, not a finding): docs/testing/m2-ledger.md aggregate totals (native, stdio, not native) and the selective list must match this branch's actual registry in crates/server/src/native.rs, recounted from the registry, not adjusted from the base. Stale totals are blocking.
- Front-door tests: the native front-door cases skip unless PACER_TEST_NATIVE_FRONT_DOOR is set (and some need a release front door). When you run tests, set it (build the test-ops front door once if needed, in this worktree's existing target dir; disk is tight) so those cases actually run, and report their pass/skip/fail counts. Skipped cases are not evidence.
- (Same scope.) Ledger figures are relative to THIS branch's own crates/server/src/stdio_hello.json and registry at its merge base (bases differ: some branches have 225 v3 ops, newer ones 228). Do not flag a figure as stale because origin/main differs; flag only internal inconsistency with this branch's own catalog and registry. A final recount happens at merge.

- SAFETY: run every bun test / test script you execute as `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx <cmd>` (sandbox denying localhost:4317, with a non-setuid ps on PATH so process checks work). A test that fails only because the sandbox refused 4317 is a test-isolation finding, not a reason to run unsandboxed.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor/.work/reviews/2026-11-10-m2-setup-doctor-rereview8.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent empirical audit described above and write the report.

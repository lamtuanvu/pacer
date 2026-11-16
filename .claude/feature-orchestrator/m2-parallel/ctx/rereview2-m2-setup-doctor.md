# Independent project review: m2/setup-doctor

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor`
- Branch: `m2/setup-doctor`
- Base (merge-base with origin/main): `eb969c1851d4a39f53ffbdc298c53dda8bf50a48`
- Reviewed head: `0bcda7c2131d1274aa9dc1aa35aa1cc58423338e`
- Commits in scope:
  - 0bcda7c21 test(m2): keep in-process init tests off the real Ollama
  - 09d3bd9e3 fix(m2): probe Ollama for native setup.init through Core's fetch
  - b1f1e1b45 test(m2): pin PACER_PORT for spawned test processes
  - f4f8ab513 test(m2): keep setup parity tests off the machine's local model servers
  - 551fe1f74 fix(m2): address review of setup doctor and setup init native ops
  - 734d292f7 feat(m2): make setup.health and doctor.run native in Rust
  - 28ff2c65b feat(m2): make strategy.build, executor.setup.candidates and setup.init native in Rust
- Raw changes: `git diff eb969c1851d4a39f53ffbdc298c53dda8bf50a48..0bcda7c2131d1274aa9dc1aa35aa1cc58423338e` and `git log -p eb969c1851d4a39f53ffbdc298c53dda8bf50a48..0bcda7c2131d1274aa9dc1aa35aa1cc58423338e`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

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

Re-review of the final revision. Previous report .work/reviews/2026-11-10-m2-setup-doctor-rereview.md: FAIL on a blocking parity defect: native setup.init dropped the OLLAMA_HOST query string (crates/config-ops/src/setup_init_ops.rs vs src/install/init.ts:35), plus concerns that the hand-written client read to EOF before checking Content-Length and capped at 4 MiB. New commits 09d3bd9e3 and 0bcda7c21 (head 0bcda7c21): instead of patching the hand-written client, native setup.init now asks Core for one parameterless setup effect {kind: ollama_model} over the existing setup effects bridge (registry entry effects_stub, uses_effects/call). Core runs ollamaModel(ctx), extracted from detect() in src/install/init.ts and shared by both paths, so URL building and fetch framing are TypeScript's. Rust keeps validation, CLI detection, lms, starter strategy, migration and publication. Removed ollama_target, the TcpStream client, http_response, dechunk, their unit tests and the https forward. The bridge refuses ollama_model with any extra key. New front-door test compares native vs forced-forward setup.init across 14 OLLAMA_HOST forms against a query-sensitive fixture, plus keep-alive and a 5 MiB body. 0bcda7c21 points in-process init tests (api-ops-config, onboarding-wave1) at a closed OLLAMA_HOST because they were contacting the real local Ollama on 11434. Judge: (a) whether routing this effect through Core is acceptable under the Rust migration rules (RUST-*/CRATE-* and the effects-bridge pattern already used by setup.init's other effects) and correctly recorded in the ledger as selective; (b) the bridge's input validation and auth (internal key, work-grant callers) and that no new forwarding widens what a caller can reach; (c) parity test strength (would it fail if the query were dropped again?); (d) ledger recount on this branch's own 225-op catalog: native 134, selective 58, not native 91 (check both directions); (e) the implementer notes other suites calling init paths with the default fakeCtx (e.g. install-commands, app-ux-fixes) may still reach the real Ollama: record as advisory unless this branch changed them. Implementer suite runs may predate the sandbox rule: rerun the affected suites yourself under the sbx wrapper with PACER_TEST_NATIVE_FRONT_DOOR set and report counts. Live: .work/live/setup-doctor-7/evidence/report.md, session HEAD 0bcda7c21, clean, 7 PASS / 0 FAIL / 6 UNVERIFIED.

Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.
- Ledger accuracy: docs/testing/m2-ledger.md aggregate totals (native, stdio, not native) and the selective list must match this branch's actual registry in crates/server/src/native.rs, recounted from the registry, not adjusted from the base. Stale totals are blocking.
- Front-door tests: the native front-door cases skip unless PACER_TEST_NATIVE_FRONT_DOOR is set (and some need a release front door). When you run tests, set it (build the test-ops front door once if needed, in this worktree's existing target dir; disk is tight) so those cases actually run, and report their pass/skip/fail counts. Skipped cases are not evidence.
- Ledger figures are relative to THIS branch's own crates/server/src/stdio_hello.json and registry at its merge base (bases differ: some branches have 225 v3 ops, newer ones 228). Do not flag a figure as stale because origin/main differs; flag only internal inconsistency with this branch's own catalog and registry. A final recount happens at merge.

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor/.work/reviews/2026-11-10-m2-setup-doctor-rereview2.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.

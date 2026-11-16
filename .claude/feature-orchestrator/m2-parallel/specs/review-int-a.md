# Independent project review: m2/integration

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration`
- Branch: `m2/integration`
- Base (merge-base with origin/main): `54ffba85de0bedbd9b32bd38095e44692f989421`
- Reviewed head: `d8c1b276ca24157c34459126ed26e34233526fbf`
- Commits in scope:
  - d8c1b276c docs: recount the M2 ledger against the merged registry
  - a29aa00fa test: align task send port guard expectations
  - a713e1c7b refactor: merge pacer server split
  - f29c533ab chore: merge m2/setup-doctor
  - 0e13e2668 test: reconcile native registry and runner check expectations
  - d05f3c1cf fix: retain forwarded handover after merge
  - a21b88cff fix: satisfy attention test lint
  - d301f1a39 fix: preserve integration test and update wiring
  - 6b5eb5c0b chore: merge fix/managed-work-actions
  - 6adbc890c chore: merge m2/service-handover
  - 29394c0b1 chore: merge m2/runner-ops
  - 66b386df7 chore: merge m2/task-send
  - 3f0042a6b chore: merge m2/account-list
  - e17ac4e10 chore: merge m2/dispatch-ops
  - 6b962a4f9 test: cover stdio host set parity
  - 18d289925 test: assert managed action geometry stays stable
  - f842ff429 fix: hide managed action announcements in tray
  - b0ad8f844 test: serve local model fixtures in live harness
  - e0324c451 fix: announce managed action progress
  - e3c4958bc fix: isolate live model probe ports
  - 08731ad0e fix: preserve action focus and ignore stale completions
  - 3c2183784 test: apply the discover plan fixture to HTTP serving too
  - f721830d5 fix: guard rapid tray actions and test dispatch errors
  - aa7abe8c5 test(live): let test-ops sandboxes use model probe fixtures and forced forwarding
  - fc13ed7b1 test: wait for the Orca readiness probe in the execution.backend case
  - ab3aaea0f fix(m2): keep candidate probe failures in settlement order
  - 091178763 fix: preserve managed attention in v2 projection
  - dcf81545c docs: restore crate planning rules
  - 50a69ed98 docs(m2): reconcile ledger rows and figures with the catalog
  - e527e10ef docs(m2): give every v3 op one ledger row that matches the registry
  - 0541b623c fix: explain unavailable managed actions
  - 4340608e9 refactor(server): split bridge and protocol support crates
  - 4ace6c375 docs(m2): reconcile the selective-forwarding count with the registry
  - 0bcda7c21 test(m2): keep in-process init tests off the real Ollama
  - 58b2769bd docs(m2): make the ledger's selective list match its rows and registry
  - 09d3bd9e3 fix(m2): probe Ollama for native setup.init through Core's fetch
  - b2d232796 test(m2): prove forwarded runner.check keeps caller identity and deadline
  - 76a1161b4 refactor(server): name the stdio native-id predicate for what it answers
  - 4791064e6 docs(m2): recount the ledger summary against the registry and v3 catalog
  - 0b192827c test(m2): recount the native ledger for task.send and cover its bridge refusals
  - c0263ddba fix: gate managed attention actions by service support
  - 6e5863363 refactor(server): move native domain operations into crates
  - b1f1e1b45 test(m2): pin PACER_PORT for spawned test processes
  - 0144811c0 test(m2): pin PACER_PORT for spawned test processes
  - 1a1619867 test(m2): pin PACER_PORT for spawned test processes
  - 3246c652f test(m2): catch a reintroduced deadline on the install and update effects bridge
  - e610bfe64 test(m2): pin PACER_PORT for spawned test processes
  - 34f2fd382 test(m2): pin PACER_PORT for spawned test processes
  - 383a864c1 test(m2): pin PACER_PORT for spawned test processes
  - ab3537273 fix: route managed attention actions through dispatch
  - f4f8ab513 test(m2): keep setup parity tests off the machine's local model servers
  - c8990a763 test(server): check account.signin request ids and Linux terminal hand-off
  - 6737cf7c1 test(server): drive valid dispatch review, retry and answer through the stdio front door
  - cbb64b100 test(server): forward admitted account.signin unchanged through both front doors
  - ef7ed3238 test(m2): exercise runner.check through the stdio front door
  - b4f476b7b test(m2): prove service.handover and service.work stay forwarded through both front doors
  - ad9d4c215 test(server): pin a strategy edit between the native account.list read and the bridge load
  - 551fe1f74 fix(m2): address review of setup doctor and setup init native ops
  - afd3622fb fix(server): forward stdio requests whose id JavaScript cannot round-trip
  - 663b1e85f fix(m2): refuse enforcement identities and decide task.send refusals under the task lock
  - b2f728eaa fix(m2): keep forwarded completion semantics for native service.install and update.apply
  - ee4facaf8 fix(server): bind native account.list rows to the bridge's strategy snapshot
  - 996c529db fix(server): forward dispatch lifecycle bodies Rust cannot represent
  - 4f87d9e84 docs(m2): describe runner.check as native refusals with forwarded checks
  - 6360dd2f8 feat(m2): make task.send native in Rust
  - 92f759fd7 feat(server): serve account.list and account.signin natively
  - 232049266 feat(m2): make service.install and update.apply native over a Core effects bridge
  - 734d292f7 feat(m2): make setup.health and doctor.run native in Rust
  - 88df34c06 feat(server): register dispatch lifecycle ops natively with selective forwarding
  - 332715914 feat(m2): make runner.check refusals native in Rust
  - 1e93193d4 feat(m2): make service.handover and service.work native in Rust
  - 28ff2c65b feat(m2): make strategy.build, executor.setup.candidates and setup.init native in Rust
- Raw changes: `git diff 54ffba85de0bedbd9b32bd38095e44692f989421..d8c1b276ca24157c34459126ed26e34233526fbf` and `git log -p 54ffba85de0bedbd9b32bd38095e44692f989421..d8c1b276ca24157c34459126ed26e34233526fbf`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Task: integrate eight passed branches into one PR branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration, created from origin/main 54ffba85d). The maintainer chose one combined PR for eight branches that each passed independent review and live validation on their own base. Your job is to combine them onto current main, resolve conflicts faithfully, recount the ledger once, and validate the result. Do not push; the coordinator opens the PR.

## Branches (passed heads; worktrees under /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/)
| Branch | Head | Worktree | Final live session (in that worktree's .work/live) |
| --- | --- | --- | --- |
| m2/dispatch-ops | 76a1161b4 | m2-dispatch-ops | m2-lifecycle-web4 |
| m2/account-list | 34f2fd382 | m2-account-list | m2-account-list-final |
| m2/task-send | 58b2769bd | m2-task-send | m2-send-r4 |
| m2/runner-ops | e527e10ef | m2-runner-ops | runner-check-web6 |
| m2/service-handover | 50a69ed98 | m2-service-handover | m2-svc-50a69 |
| m2/setup-doctor | b0ad8f844 | m2-setup-doctor | setup-doctor-13a, -13b, -13d, -13e |
| fix/managed-work-actions | 18d289925 | fix-managed-work-actions | managed-geometry-18d28992 |
| refactor/split-pacer-server | 6b962a4f9 | refactor-split-pacer-server | split-final-6b962a (plus split-write-dcf) |

Each worktree's .work/reviews/ holds its final review reports; read the latest ones for the accepted scope, exceptions and caveats. Notes: dispatch-ops carries the shared numeric stdio JSON-RPC id fix afd3622fb that others need; the split is a move-only refactor that moves server code into new crates pacer-core-bridge and pacer-mcp and into read-model, update, config-ops and task-ops (its crate rows are proposed in PR #849, its size exception in PR #848); setup-doctor adds the PACER_TEST_LOCAL_SERVER_PORTS test seam and live harness model-port fixtures.

## Steps
1. Merge each branch with `git merge --no-ff --signoff` (Conventional message such as `chore: merge m2/dispatch-ops`), dispatch-ops first. Choose the remaining order to minimise semantic risk, and justify it. The split moves files the M2 branches edit (for example native registry and bridge code in crates/server), so decide whether to merge the split before or after the M2 op branches and carry every M2 addition into the moved location. Known conflicts against main: docs/testing/m2-ledger.md (all M2), crates/update/src/handover/* (service-handover), five crates/config-ops files (setup-doctor), src/app/assets.generated.ts (managed-work: regenerate with the project's build, never hand-merge), crates/task-ops/src/status_ops.rs (split). Resolve each conflict by understanding both sides (read main's commits that touched the file); never drop main's changes or a branch's behaviour. Record every conflict and its resolution in the handoff.
2. Ledger recount (maintainer decision): recount docs/testing/m2-ledger.md against the merged registry and catalog: catalog total (crates/server/src/stdio_hello.json v3), registered, native, forwarded, the selective list, and every row and label. Fix the pre-existing mismatches (selective count stated 57 while 68 listed; catalog 225 vs 228) and reconcile the selective definition that differed between branches (runner-ops counted the 12 plugin ops and excluded task.get; task-send included task.get): define it from the code's actual selective-forwarding decisions and apply it consistently. The checker .work/fixtures/ledger-check.ts in the m2-runner-ops worktree can help; its phrase checks are wording-specific.
3. Static checks: `cargo xtask loc --check`, `cargo xtask deps`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck`, `git diff --check`. Builds with CARGO_INCREMENTAL=0.
4. Tests. Every bun test runs under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny (refuses ports 4317/11434/1234, data in ~/.pacer, real install paths, launchctl). `cargo test --workspace --exclude pacer-plugin-host` under sbx-deny (plugin-host native_run needs /bin/ps, which no sandbox allows; run those four tests once outside the sandbox with a disposable HOME/PACER_HOME and non-4317 PACER_PORT, as the split worker did). Then the full bun suite in shards with PACER_TEST_NATIVE_FRONT_DOOR set to a built binary path, PACER_TEST_BROWSER set, TZ=Asia/Ho_Chi_Minh. RESOURCE RULE: another worker (fix/test-port-isolation) may be running a full bun suite; before starting your full suite, wait until no other `bun test --parallel` process from another worktree is running (check with pgrep; sleep between checks), and never run two full suites at once. For every failing file, run the same file on a clean origin/main worktree (scratch, removed afterwards) to classify it as pre-existing or introduced; fix introduced failures faithfully (smallest change consistent with the source branch's intent) and commit signed. Known pre-existing: tray layout/board browser tests.
5. Live validation (CT-11) at the final clean head, following docs/testing/live-validation.md: one or more sessions that repeat each branch's final live session surfaces (read each report listed above), using the same fixtures and options (setup-doctor's --local-model-ports fixtures with the macOS sandbox; managed fixture with missing-op filter proxies; split's write families, v2, MCP fixture, WebSocket). Web checks in Orca's built-in browser with new isolated profiles. Maintainer exceptions stay UNVERIFIED: op-specific stdio beyond the fixed fixtures, desktop app, PACER_FORWARD_OPS override, D3/D8-guarded effects, the Updates Install control, real executors. Stop every session, proxy, fixture, tab and profile afterwards.
6. Stop and report if free disk falls below 10 GiB. Delete target/ and scratch worktrees when done.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Commits signed (git commit -s / merge --signoff). Do not push. Write a handoff at .work/reviews/m2-integration-handoff.md (merge order and why, every conflict and resolution, ledger recount figures and definition, check and test results with per-file failure classification, live reports and Summary lines, UNVERIFIED items).

Report with orca orchestration worker_done: head, merge order, conflicts resolved, ledger figures, static checks, test counts and failure classification, live Summary lines, UNVERIFIED items, cleanup. Always end with worker_done.

## Later sub-briefs and coordinator decisions

### m2-integration-merge2
# Task: finish merging the M2 integration branch (phase A: merges, ledger, static checks)

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration). Current head 3f0042a6b: origin/main 54ffba85d plus signed merges of m2/dispatch-ops (e17ac4e10) and m2/account-list (3f0042a6b). A previous worker stopped after those two; read its handoff at .work/reviews/m2-integration-handoff.md and continue from there. The full original brief is /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md (branch table, heads, worktrees, live session names, known conflicts, sandbox and safety rules); everything in it still applies.

This phase covers merges, the ledger recount and static and targeted checks. The full bun suite and live validation come in a later phase, so do not run them here. Work through every step without stopping early. If a step is genuinely blocked, commit what is consistent, record it, and still finish the steps that remain.

## Steps
1. Merge the remaining six branches with `git merge --no-ff --signoff`: m2/task-send 58b2769bd, m2/runner-ops e527e10ef, m2/service-handover 50a69ed98, m2/setup-doctor b0ad8f844, fix/managed-work-actions 18d289925, then refactor/split-pacer-server 6b962a4f9 last. The previous worker chose operation branches before the split. When you merge the split, carry every M2 addition (natively registered ops, bridge and registry edits, tests) into the files the split moved, so nothing is lost or duplicated. Check this with `git grep` for each M2 op name before and after the merge. For the ledger conflicts during merges, keep a consistent interim union. The real recount is step 2.
   - For each conflict, read both sides and main's commits that touched the file. Never drop main's changes or a branch's behaviour.
   - Regenerate src/app/assets.generated.ts with the project's generator; never hand-merge it.
   - Record every conflict and its resolution.
2. Recount docs/testing/m2-ledger.md against the merged code:
   - The catalog total from crates/server (or its moved location) stdio_hello.json v3.
   - The natively registered set and the forwarded set, both from the actual registry code.
   - The selective list, defined from the code's actual selective-forwarding decision and applied consistently. Previously, runner-ops counted the 12 plugin ops and excluded task.get, and task-send included task.get; settle this from the code.
   - Fix the pre-existing mismatches (57 stated vs 68 listed; 225 vs 228). Every row, label and total must match the code.
   - Add a small reproducible check to the handoff: the commands or script you used and their output.
3. Static checks with CARGO_INCREMENTAL=0: `cargo xtask loc --check`, `cargo xtask deps`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck`, `git diff --check`. Fix integration-introduced failures faithfully with signed commits. CRATE-1 and CRATE-9 exceptions are covered by PRs #848 and #849; report the loc and deps results either way.
4. Run `cargo test --workspace --exclude pacer-plugin-host` under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny. Also run, under sbx-deny, the bun test files that each source branch's final review named as its targeted tests, plus every test file touched by a conflict resolution. Find them in each branch worktree's latest .work/reviews/ reports. Set PACER_TEST_NATIVE_FRONT_DOOR to a built binary path, PACER_TEST_BROWSER, and TZ=Asia/Ho_Chi_Minh. Run each failing file on a clean origin/main scratch worktree to classify it (remove the scratch worktree afterwards), and fix the ones the integration introduced.
5. Stop if free disk falls below 10 GiB. Delete target/ at the end only if free disk is below 25 GiB; otherwise keep it for phase B.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Signed commits. Do not push. Overwrite .work/reviews/m2-integration-handoff.md with a complete phase-A handoff. It must cover:
- the merge order;
- every conflict and its resolution, including the previous worker's;
- the ledger figures, the selective definition and the reproducible check;
- static-check results;
- cargo and targeted bun results, with failure classification;
- anything left for phase B.

Report with orca orchestration worker_done: head, merges done, conflicts, ledger figures, check and test results, open items. Always end with worker_done.

### m2-integration-setup
# Task: merge m2/setup-doctor into the integration branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 63c747406. It already merges six M2 branches onto origin/main 54ffba85d. Read .work/reviews/m2-integration-handoff.md first; the full original brief, with its safety and sandbox rules, is /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md.

Your only job is to merge m2/setup-doctor (b0ad8f844, worktree .work/worktrees/m2-setup-doctor) correctly and prove it with targeted checks. Do not merge the split. Do not do the ledger recount beyond a consistent interim union. Do not run the full bun suite or live validation. Finish this one merge completely; do not stop partway.

## What the conflicts are
Two earlier attempts aborted with conflicts in:
- crates/config-ops: executor_candidates_ops, lib, setup_effects, setup_init_ops and its tests;
- the config strategy;
- crates/server: native, core_bridge_sync, setup_effects_sync, serve/mod, stdio_proxy;
- the ledger;
- src/api/setup-bridge, stdio, serve/http;
- test endpoint-detect, native-dispatch, native-setup-parity, pinned-port and pinned-port.test.

Main moved on after the branch was cut. In particular, main's setup.init uses its own setup_init path, while the branch uses effects_stub, and main added service and update routes that must survive. Before resolving:
- run `git log --oneline 33e584bce..origin/main -- <file>` for each conflicting file;
- read main's commits that touched it;
- read the branch's final review reports in the setup-doctor worktree's .work/reviews/ so you know exactly what behaviour the branch adds: native setup.doctor / setup.check, executor candidates with the cold catalog cache forwarding executor.setup.candidates to Core, the PACER_TEST_LOCAL_SERVER_PORTS test seam (test-ops Rust and uncompiled TypeScript only), and the live-harness model-port fixtures.

The result must keep all of main's behaviour and all of the branch's behaviour; where they overlap (setup.init), integrate them and explain how. Use `git merge --no-ff --signoff`, with follow-up signed fix commits if needed.

## Validation (with CARGO_INCREMENTAL=0; never run cargo and bun at the same time, since concurrent builds overwrote target/debug/pacer last time)
1. Run cargo fmt --check, clippy -D warnings, xtask loc --check, xtask deps, and bun run typecheck.
2. Run cargo test for -p pacer-config-ops, -p pacer-server and any other crate you touched, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny. Then investigate the earlier E0463 doctest failure in pacer-account-ops (missing pacer_config, pacer_engine and pacer_foundation): rerun `cargo test -p pacer-account-ops --doc` alone, without any concurrent build. If it still fails, check whether it fails the same way on a clean origin/main scratch worktree, and remove that worktree afterwards.
3. Build the test-ops front door. Then, under sbx-deny with TZ=Asia/Ho_Chi_Minh, PACER_TEST_NATIVE_FRONT_DOOR set to the binary path and PACER_TEST_BROWSER set, run the setup-doctor branch's targeted bun tests (named in its final review) plus every test file touched by a conflict resolution. Classify any failure against a clean origin/main scratch worktree, fix the ones the integration introduced, and remove the scratch worktree.
4. Stop if free disk falls below 10 GiB. Keep target/.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Do not push.

Append a "Setup-doctor merge" section to .work/reviews/m2-integration-handoff.md. Cover every conflict and how it was resolved (especially setup.init), the commands you ran and their results, failure classification, and the doctest finding. Report with orca orchestration worker_done: head, conflicts and resolutions, check and test results, open items. Always end with worker_done.

### m2-integration-split
# Task: merge the pacer-server split into the integration branch

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head 3b510cd8d. It now merges all seven M2 operation branches onto origin/main 54ffba85d. Read .work/reviews/m2-integration-handoff.md first. The original brief, with its safety and sandbox rules, is /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md.

Your only job is to integrate refactor/split-pacer-server (6b962a4f9, worktree .work/worktrees/refactor-split-pacer-server) correctly and prove it. Leave the ledger recount, the full bun suite and live validation for later. Finish this integration completely; do not stop partway.

## Background
The split is a move-only refactor of crates/server:
- it creates crates pacer-core-bridge and pacer-mcp;
- it moves code into read-model, update, config-ops and task-ops;
- it shrinks pacer-server from 12054 to 7598 lines.

Read its final review reports and the split-final-6b962a live report in that worktree's .work/ (reviews and live) to understand what moved where and what it proved. The split was cut from an older main. Since then, main and the seven merged branches have edited files the split moves: native registry and bridge code, core_bridge_sync, service_effects_sync, and task-ops status_ops.

An exploratory merge showed these conflicts:
- core-bridge/core_bridge_sync;
- server/native;
- a rename/rename conflict: main renamed service_effects_sync to server/native/handover_bridge, while the split moved it to core-bridge/service_effects_sync;
- task-ops/status_ops.

Preserve main's handover changes (including whatever main removed).

## Approach
You may either merge with `git merge --no-ff --signoff`, or, if a textual merge proves unworkable, re-apply the split's moves on top of the current head as signed commits that reproduce its structure. The PR is squash-merged, so either is acceptable. State which you chose and why.

Either way, the result must have:
- the split's crate structure and dependency direction;
- every M2 addition and every main change, carried into the moved locations with nothing lost or duplicated;
- no behaviour change from the move itself.

## Proof
1. Before you start, record for each M2 op name and bridge function at the current head where it is registered or implemented: `git grep` for the op strings in crates/ and src/ (for example account.list, account.signin, task.send, the runner ops, service.handover, update.check, setup.doctor, setup.health, setup.init, executor.setup.candidates, strategy.build, and the dispatch ops). After the merge, show that every one is still registered and implemented, at its new path. Include both tables in the handoff.
2. Under sbx-deny with CARGO_INCREMENTAL=0, run these one at a time, never concurrently:
   - cargo fmt --check, clippy -D warnings, xtask loc --check and xtask deps (report CRATE-1 and CRATE-9 results; exceptions are in PRs #848 and #849);
   - bun run typecheck and git diff --check;
   - `cargo test --workspace --exclude pacer-plugin-host`;
   - the four plugin-host native_run tests once outside the sandbox, with a disposable HOME and PACER_HOME and a PACER_PORT other than 4317, as the split worker did.
3. Build the test-ops front door. Then, under sbx-deny with TZ=Asia/Ho_Chi_Minh and PACER_TEST_NATIVE_FRONT_DOOR and PACER_TEST_BROWSER set, run:
   - the split's targeted tests (test/native-host-set-parity.test.ts and the others its review named);
   - every native-*-parity and native-dispatch test file;
   - the targeted files of the other seven branches as listed in the handoff.
   Classify any failure against a clean origin/main scratch worktree (remove it afterwards) and fix the failures the integration introduced.
4. Stop if free disk falls below 10 GiB. Keep target/.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Signed commits. Do not push.

Append a "Split integration" section to the handoff covering:
- the approach and why you chose it;
- every conflict and its resolution;
- the before and after op-location tables;
- the line counts and dependency-check output;
- every command and its result;
- failure classification;
- open items.

Report with orca orchestration worker_done: head, approach, conflicts, op-preservation check, check and test results, open items. Always end with worker_done.

### m2-integration-ledger2
# Task: recount the M2 ledger, with definitions decided

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head f8f1f998f, with all eight branches merged. A previous worker investigated but changed nothing. Read the "Ledger recount — incomplete investigation" section of .work/reviews/m2-integration-handoff.md; its findings stand:
- the old checker misses 13 `module::ops()[index].name` registry entries;
- doctor.run and setup.health are validation-only.

The safety rules in /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/m2-integration.md apply. Do not run the full bun suite, live validation or any heavy build.

The coordinator has decided the definitions below; apply them, don't reopen them. Finish completely: the ledger edit, the checker, the checks and a signed commit.

## Definitions (write them in one short paragraph at the top of the ledger, replacing any older definition text)
- **Native:** the op is registered in the native registry and Rust produces the reply for at least some valid requests. An op that Rust registers only to validate parameters, and then sends every valid request whole to Core, counts as **Forwarded (Rust-validated)**. The ledger already counts doctor.run that way; apply the same to setup.health and any other op with this pattern.
- **Selective:** a native op whose own handler forwards the original request to TypeScript for some inputs, callers or on-disk states, while Rust answers the others. These do not make an op selective:
  - process-wide routing: work-grant processes forwarding everything in run_stdio and run_serve, and the PACER_FORWARD_OPS escape hatch;
  - Core bridge calls for sub-effects or enrichment, where Rust still owns the reply (task.get's task-read-parts enrichment, msg.send's effects bridge, endpoint-plugin sync).
  Check each existing "(selective)" label against the code. Keep the label where the handler really forwards the original request for some inputs. Otherwise relabel the row without "selective" and keep its explanation of the bridge. List every relabel in the handoff with the code location that justifies it.
- **Plugin ops (HTTP native, stdio forwarded):** count them as native with a front-door note, not as selective. Their HTTP nesting fallback is context-wide, not input-dependent. Their rows must say plainly that stdio forwards them.
- **Totals:** catalog = native + forwarded, where catalog is the op count in stdio_hello.json v3. Selective is a subset of native. Each total must equal the number of op names in the rows carrying that status.

## Steps
1. Write a checker at .work/fixtures/m2-ledger-check.ts (untracked). It must:
   - parse the catalog;
   - parse the native registry, including indexed `ops()[i]` entries resolved from their arrays and the validation-only registrations, from the source files after the split;
   - parse every ledger row's op names and status;
   - assert that set equality and the totals hold;
   - print the sets and figures.
2. Update docs/testing/m2-ledger.md: totals, labels and rows, keeping its format and tone and changing only what the code and definitions require. Fix the pre-existing mismatches (57 stated vs 68 listed; 225 vs 228; now catalog 229). Every op appears exactly once.
3. Run the checker until it passes. Then run `bun run typecheck`, `git diff --check` and `TZ=Asia/Ho_Chi_Minh bun test test/op-catalog-parity.test.ts` plus any other test that reads the ledger or catalog. Commit with `git commit -s -m "docs: recount the M2 ledger against the merged registry"`.
4. Replace the incomplete ledger section of the handoff with a "Ledger recount" section covering:
   - the definitions;
   - the figures (catalog, native, forwarded including Rust-validated, selective);
   - how each figure was derived;
   - every relabel and status change with its justification;
   - the checker's command and full output;
   - the line counts and deps output already recorded (pacer-server 8,215 LOC; CRATE-1 warnings for config, server, lifecycle and plugin-host).

Do not push. Report with orca orchestration worker_done: head, figures, relabels, checks. Always end with worker_done.
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

Coordinator scope note: integration review PART A of two.
- The branch was rebuilt to add DCO sign-offs to four conflicted merges; head d8c1b276c has a tree byte-identical to 1b031e613, and all eight passed source heads remain ancestors. Verify that with `git rev-parse d8c1b276c^{tree} 1b031e613^{tree}` and check that every commit in 54ffba85d..HEAD has Signed-off-by.
- A first review pass (.work/reviews/m2-integration-project-review.md) audited selected hunks only. You must audit every conflict-resolution hunk in your assigned part, line by line: `git show --remerge-diff <merge>` for each assigned merge, and `git show <c>` for each assigned fix commit. In the report, list every hunk or file with what you checked and your conclusion. Missing coverage counts against the verdict.
- This is one PR combining eight branches that each already passed review and live validation on their own base. Review the integration (conflict resolutions, fix commits, nothing lost), not the features afresh. Source-branch reviews are in each source worktree's .work/reviews/. Read .work/reviews/m2-integration-handoff.md.
- RESOURCE RULE: a full suite and live validation are running in parallel. Do NOT run the full suite, the live harness or workspace-wide cargo test. Targeted cargo tests for the crates you touch, and targeted bun files under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, are fine (TZ=Asia/Ho_Chi_Minh; PACER_TEST_NATIVE_FRONT_DOOR=$PWD/target/debug/pacer if it exists; do not rebuild workspace-wide).
- Full-suite and live evidence are coordinator-pending. These are disclosed and accepted, not findings: CRATE-1 size warnings (PR #848), new crate rows (PR #849), pre-existing tray and 403 failures, production pacer mcp still in TypeScript, and the maintainer live exceptions.
- Write your report to the report path below. Verdict PASS or FAIL for your part.
- YOUR PART: the merges of m2/dispatch-ops (e17ac4e10), m2/account-list (3f0042a6b), m2/task-send (66b386df7), m2/runner-ops (29394c0b1), m2/service-handover (6adbc890c) and fix/managed-work-actions (6b5eb5c0b), and the fix commits d301f1a39, a21b88cff, d05f3c1cf and 0e13e2668. Check that main's changes since 33e584bce in each conflicted file survive (git log 33e584bce..54ffba85d -- <file>), and that each branch's behaviour survives. The service-handover merge with main's handover changes (#840 service.handover/service.work) needs particular care. src/app/assets.generated.ts must equal a fresh regeneration: run the project generator into a temp copy and diff. Leave the setup-doctor merge, the split merge, the ledger and later commits to part B.


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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration/.work/reviews/m2-integration-review-a.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent review described above and write the report.

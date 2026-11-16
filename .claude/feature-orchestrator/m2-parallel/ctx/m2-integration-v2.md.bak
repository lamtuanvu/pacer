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

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


Carry out the task described above.

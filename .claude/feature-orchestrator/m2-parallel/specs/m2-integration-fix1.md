# Task: fix the ledger findings and remove the orphan handover bridge

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head d8c1b276c. Another worker (phase B) is running live validation and the full suite in this worktree. Do not run either, and do not build anything workspace-wide. Make only the changes below. Use small signed commits (`git commit -s`), and run `git status` right before each commit so you stage only your own files.

## 1. Ledger findings (from .work/reviews/m2-integration-review-ledger.md; read it)
- **F1: runner.set.** crates/config-ops/src/runner_ops.rs:489-500 sends a valid request with a string `model` to Core (serve/mod.rs:205-212, stdio_proxy.rs:282). Main's ledger already stated this: "`runner.set` with a string `model` selectively forwards to TypeScript first, because validating the model needs the provider's model listing (`availableModels`) that only TypeScript owns; all other `runner.set` inputs stay native." The merge resolution dropped that text. Split runner.set out of the grouped row, or annotate it, so it carries that sentence and the selective label. Then add it to the selective list.
- **F2: definition, decided by the coordinator.** Broaden the ledger header's definition of selective as follows. An op is selective if its own handler hands execution of the operation to TypeScript for some inputs, callers or on-disk states, in either of two ways: it forwards the original request, or it uses a whole-operation bridge whose Core result becomes the reply. task.send's admitted sends, for example, are reconstructed and executed by Core. Bridges for effects or enrichment, where Rust still composes the reply, do not make an op selective. Process-wide routing does not either: work-grant processes forwarding everything, and PACER_FORWARD_OPS. task.send keeps its selective label.
  - Re-scan every native handler for whole-operation bridges under the broadened definition. Do not stop at task.send. Search crates/*/src for core-bridge calls whose result becomes the reply. For each candidate, decide selective or not and record the file and line.
  - Ops where Rust replies to no valid request remain Forwarded (Rust-validated).
- Update the totals and the selective list, and extend .work/fixtures/m2-ledger-check.ts if needed. Rerun it until it passes. Then commit: `docs: restore runner.set selective forwarding and clarify the selective definition`.

## 2. Orphan file
crates/server/src/native/handover_bridge.rs is not declared by any module. Main deleted it in 199b4de01, and the split merge resolution re-added it. Delete it with `git rm`. Confirm that nothing references it: `rg handover_bridge crates/`. Confirm it is not compiled: `cargo check -p pacer-server` with CARGO_INCREMENTAL=0 is the only build allowed here. Commit: `chore: drop the orphaned handover bridge main removed`.

## 3. Checks
Run `bun run typecheck`, `git diff --check`, the ledger checker, and `TZ=Asia/Ho_Chi_Minh bun test test/op-catalog-parity.test.ts` under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny. Show that `git diff d8c1b276c..HEAD --stat` touches only docs/testing/m2-ledger.md and the deleted file. That proves there is no runtime change.

Append a "Fix batch 1" section to .work/reviews/m2-integration-handoff.md covering:
- the definition text;
- the whole-operation bridge scan, as a table of op, file and line, and decision;
- the new figures;
- the checker output;
- the diff stat.

Do not push. Report with orca orchestration worker_done covering the head, figures, scan results and checks. Always end with worker_done.


Carry out the task described above.

# Independent integration review, part B: setup-doctor and split merges

You are the independent reviewer required by REPO-10. You did not write this code. Review it and report; do not fix it.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head d8c1b276c, base origin/main 54ffba85d. The branch combines eight branches that each already passed independent review and live validation. Review the integration only: conflict resolutions and fix commits. Do not re-review the features.

An earlier pass (.work/reviews/m2-integration-review-b.md) already established the following; do not redo it:
- the ledger checker passes and 17 targeted tests pass;
- `crates/server/src/native/handover_bridge.rs` is an uncompiled orphan that main deleted in 199b4de01 and the split resolution re-added. It is a known finding; the coordinator will delete it.

## Your scope: exactly these commits
- f29c533ab: merge of m2/setup-doctor.
- a713e1c7b: merge of refactor/split-pacer-server.
- a29aa00fa: fix commit.

The ledger is reviewed separately; skip it.

## Method (no time limit; cover every item before writing the verdict)
1. Write each merge's conflict-resolution diff to a file with `git show --remerge-diff <merge> > /tmp/int-b-<sha>.diff`, then list the files in it.
2. For each file, check that the resolution keeps both sides:
   - main's side: `git log --oneline 33e584bce..54ffba85d -- <file>`; read those commits;
   - the branch's side: the source branch's diff for that file.
   For split hunks, map moved paths back to their pre-split origin (`git log --follow`, or compare against 6b962a4f9). Record one line per file: the merge, the file, what each side contributed, and your conclusion (OK, or a finding with evidence).

   Key points:
   - setup.init must keep main's planner validation, strategy update/create, migration and publication, plus the branch's Core Ollama fetch effect.
   - Main's service, update and install routes must survive.
   - The PACER_TEST_LOCAL_SERVER_PORTS seam must be honoured only by test-ops Rust builds and TypeScript tests. Check the cfg or feature gating, and that the release build ignores it.
   - Crate structure and dependency direction must match the split branch: compare crates/*/Cargo.toml with 6b962a4f9 and run `cargo xtask deps`.
   - Every M2 op is registered at its post-split path: check the handoff's op tables against the code.
3. Check a29aa00fa: is the change needed, minimal and faithful?
4. Isolation check, only for test files that appear in your conflict diffs or fix commit: every spawned front door, core or CLI process has a disposable HOME and PACER_HOME and cannot reach 127.0.0.1:4317, the model ports or real-install paths.
5. Run the bun test files touched in steps 1 to 3 under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, with TZ=Asia/Ho_Chi_Minh and with PACER_TEST_NATIVE_FRONT_DOOR=$PWD/target/debug/pacer if that file exists. Also run `cargo test -p` for touched crates. Report the counts. Do not run the full suite, the live harness, a workspace-wide cargo test or a rebuild; a parallel worker is doing those.

Accepted and disclosed, not findings: CRATE-1 size warnings (PR #848); new crate rows (PR #849); pre-existing tray and 403 failures; production `pacer mcp` still in TypeScript; the maintainer's live exceptions. Full-suite and live evidence are coordinator-pending.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports.

Write the report to .work/reviews/m2-integration-review-b.md, replacing the earlier one but keeping its orphan finding. Include:
- the head;
- a per-file table for both merges and the fix commit;
- the isolation check;
- the commands you ran and their counts;
- findings with severity, rule, evidence and remedy;
- the verdict: PASS (no blocking finding and every item covered) or FAIL.

Report with orca orchestration worker_done covering the verdict and findings. Always end with worker_done.


Carry out the independent review described above and write the report.

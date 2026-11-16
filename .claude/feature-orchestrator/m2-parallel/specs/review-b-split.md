# Independent integration review: hunk audit b-split

You are the independent reviewer required by REPO-10. You did not write this code. Review it and report; do not fix it.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head d8c1b276c, base origin/main 54ffba85d. The branch combines eight branches that each already passed independent review and live validation on their own base. Your only job is to audit the conflict resolution of merge a713e1c7b in exactly these files:
every file in `git show --remerge-diff a713e1c7b` (about 10 files: core-bridge core_bridge_sync and lib, the deleted service bridge, server manifest and native.rs, native/setup_doctor_sync.rs, task-ops status_ops.rs, and any others)

## Method (no time limit; finish every hunk before writing the verdict)
1. Run `git show --remerge-diff a713e1c7b -- <file>` for each file. Each hunk shows the conflicted region as git would have produced it, set against the committed resolution.
2. For each hunk, determine both sides:
   - main's side: run `git log --oneline 33e584bce..54ffba85d -- <path>` and read those commits;
   - the branch's side: the source branch's own change to that region, from `git log -p <first-parent>..<second-parent> -- <path>`.
   Decide whether the resolution keeps both sides' behaviour, with nothing dropped, duplicated or altered.
3. Record one row per hunk in the report, giving the file, the hunk header (@@ line), main's contribution, the branch's contribution, and the result: OK, or a finding with evidence.
4. This merge also moves code. For moved files, compare against the pre-split origin, using `git diff <first-parent>:<old path> HEAD:<new path>`, so that every M2 addition made at the old path is present at the new path. Also check the split fix commit a29aa00fa. Then run `CARGO_INCREMENTAL=0 cargo test -p pacer-core-bridge -p pacer-task-ops -p pacer-server` under sbx-deny, reusing target/, and report the counts.
5. Never write UNVERIFIED for a hunk because you ran short of time; finish it. UNVERIFIED is only for a hunk you cannot decide from the code; state what is missing.

These are not findings:
- the uncompiled orphan crates/server/src/native/handover_bridge.rs (already being deleted);
- PACER_TEST_LOCAL_SERVER_PORTS being honoured by uncompiled TypeScript (accepted setup-doctor design; release builds ignore it);
- CRATE-1 warnings (PR #848) and new crate rows (PR #849);
- pre-existing tray and 403 failures;
- the maintainer's live exceptions.

Do not run the full suite, the live harness, a workspace-wide cargo test or a rebuild. Targeted runs use /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports.

Write the report to .work/reviews/m2-integration-review-b-split.md. It must contain:
- the head;
- the per-hunk table;
- the commands and their results;
- findings, each with severity, rule, evidence and remedy;
- a verdict: PASS (every hunk decided, no blocking finding) or FAIL.

Report with orca orchestration worker_done covering the verdict and findings. Always end with worker_done.


Carry out the independent review described above and write the report.

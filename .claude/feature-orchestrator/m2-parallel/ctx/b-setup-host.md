# Independent integration review: hunk audit b-setup-host

You are the independent reviewer required by REPO-10. You did not write this code. Review it and report; do not fix it.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration (branch m2/integration), head d8c1b276c, base origin/main 54ffba85d. The branch combines eight branches that each already passed independent review and live validation on their own base. Your only job is to audit the conflict resolution of merge f29c533ab in exactly these files:
every file in `git show --remerge-diff f29c533ab` that is NOT under crates/config-ops or crates/config: crates/server native.rs, native/core_bridge_sync.rs, native/setup_effects_sync.rs, serve/mod.rs, stdio_proxy.rs; src/api/setup-bridge.ts, src/api/stdio.ts, src/serve/http.ts; test/endpoint-detect.test.ts, native-dispatch.test.ts, native-setup-parity.test.ts, pinned-port.ts, pinned-port.test.ts; docs/testing/m2-ledger.md is reviewed elsewhere, so skip it

## Method (no time limit; finish every hunk before writing the verdict)
1. Run `git show --remerge-diff f29c533ab -- <file>` for each file. Each hunk shows the conflicted region as git would have produced it, set against the committed resolution.
2. For each hunk, determine both sides:
   - main's side: run `git log --oneline 33e584bce..54ffba85d -- <path>` and read those commits;
   - the branch's side: the source branch's own change to that region, from `git log -p <first-parent>..<second-parent> -- <path>`.
   Decide whether the resolution keeps both sides' behaviour, with nothing dropped, duplicated or altered.
3. Record one row per hunk in the report, giving the file, the hunk header (@@ line), main's contribution, the branch's contribution, and the result: OK, or a finding with evidence.
4. For every test file in scope, also check that each spawned process gets a disposable HOME and PACER_HOME and cannot reach 127.0.0.1:4317, the model ports or real-install paths. Run those test files under sbx-deny with PACER_TEST_NATIVE_FRONT_DOOR=$PWD/target/debug/pacer if it exists, and report the counts.
5. Never write UNVERIFIED for a hunk because you ran short of time; finish it. UNVERIFIED is only for a hunk you cannot decide from the code; state what is missing.

These are not findings:
- the uncompiled orphan crates/server/src/native/handover_bridge.rs (already being deleted);
- PACER_TEST_LOCAL_SERVER_PORTS being honoured by uncompiled TypeScript (accepted setup-doctor design; release builds ignore it);
- CRATE-1 warnings (PR #848) and new crate rows (PR #849);
- pre-existing tray and 403 failures;
- the maintainer's live exceptions.

Do not run the full suite, the live harness, a workspace-wide cargo test or a rebuild. Targeted runs use /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with TZ=Asia/Ho_Chi_Minh. Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports.

Write the report to .work/reviews/m2-integration-review-b-setup-host.md. It must contain:
- the head;
- the per-hunk table;
- the commands and their results;
- findings, each with severity, rule, evidence and remedy;
- a verdict: PASS (every hunk decided, no blocking finding) or FAIL.

Report with orca orchestration worker_done covering the verdict and findings. Always end with worker_done.

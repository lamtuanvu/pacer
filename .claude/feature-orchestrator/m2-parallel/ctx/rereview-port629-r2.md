# Task: independent review of #629 salvage fix round 2 (R1, broker host lease) (REPO-10)

Executor: cursor-agent (default model), independent reviewer. Small, security-sensitive capability-broker change. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `cargo test -p pacer-plugin-host` and `cargo clippy -p pacer-plugin-host --all-targets` (debug, existing `target/`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`), `cargo xtask loc --check`, inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`. The 4 `native_run` failures inside sbx-deny are known. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, branch `fix/port-629-salvage`, head `dbfb1d961`; the previous reviewed head was `62d7fe3ce` (re-review PASS with R1: `.work/reviews/port-629-rereview.md`). Fix brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-port629-r2.md. Handoff "Fix round 2": `.work/reviews/port-629-salvage-handoff.md`.

Follow `.agents/skills/project-review/SKILL.md`; apply `.project/reviewers/{security,qa}.md` and `.project/rules/{security,rust,code-and-testing,repository}.md`.

Review `git diff 62d7fe3ce..dbfb1d961`:
1. R1 fixed as remedied: the broker releases its `HostLeaseBroker` lease when the native effect errors on run, fetch or close, matching `src/plugins/host-lease.ts` retire (~165) and capacity (~189–190). Cite lines.
2. Nothing else changed behavior: successful paths, the native session state, close-result handling.
3. The edge case the implementer recorded: a native fetch refused because an earlier ticket is unclaimed does not retire the native session, but the broker drops its lease. Compare with TS for that exact case; decide whether it is a new divergence and whether it must block (no production provider implements fetch).
4. The three new tests fail at `62d7fe3ce` (spot-check one by reverting the fix in a scratch copy under /tmp, then discard).
5. Checks: fmt, clippy, plugin-host tests, LOC 11,691 (limit 12,000); REPO-4 for the new commit.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration/.work/reviews/port-629-rereview-r2.md`: verdict on the first line; scope, heads, reviewer identity; findings table; checks; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.

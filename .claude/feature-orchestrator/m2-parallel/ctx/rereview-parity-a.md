# Task: independent security re-review of owner parity PR A fix round 1 (REPO-10)

Executor: cursor-agent (default model, frontier tier: capability authority and secrets). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-a, branch `fix/owner-call-authority`, head `aafa8159d`: seven commits on current `main` (`5ea064809`, which includes PR B as #940). The fix round was built at `96c07f63c` on PR B's pre-merge head `c28deb114`; the coordinator then rebased it onto `main` with no conflicts (`git range-diff c28deb114..96c07f63c 5ea064809..aafa8159d` should show no content changes).

Inputs:
- First review (PASS with N1–N9): /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-review.md (§4 rebase guidance, §Findings).
- Handoff, especially "Fix round 1": /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-handoff.md.
- Fix-round brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-parity-a-r1.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR A"; maintainer decisions Q1 and Q4 at the top).
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,code-and-testing,repository}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Rebase onto B (review §4).** The seal is applied once, in `prepare_sealed` immediately after `session_for_call_in(...)` and before `bind_core_methods` and the hello, using `&sealed.authority`, so it covers the bridge and both doors; no leftover seal in `crates/server/src/native/plugins.rs`; test-file, ledger, CHANGELOG and `registry.ts` conflicts kept both sides' intent (B's `ROUTED_*` constants, doctor rows, log tag; A's `coreMethods` and `nativeIssueCallAuthority`). Confirm the range-diff.
2. **Each finding.** N2 (undeclared `identity.sign` flag-on refused and audited exactly as flag-off `refuseSign(…, "capability not declared")`), N3 (door seal test; fails with the seal removed), N4 (Core-originated call by another plugin during a held assistant turn gets the flag-off refusal), N5 (`onRequest` name check pinned), N6/N7 (CT-11 head named; runtime test count right), N8 (CHANGELOG "may use"; ADR 0027 same-user caveat until #918/PR G). N1 and N9 left as briefed; the door still fails closed for secrets and signatures (PR H).
3. **No new leak.** The assistant key and signatures cross only Core's own connection; no new path lets a plugin, a bridge peer or another plugin's call obtain them; audit lines contain no secret material.
4. **The open observation.** One assistant-key e2e run (flag-on door scenario, right after the conformance suite) failed with "plugin call passed its absolute deadline" and `authorized:false`; four reruns passed. Judge whether this is load-related flakiness or a real ordering/deadlock risk in the sealed path (for example a held turn waiting on a lock the Core call needs). Rerun the test at least three times, once directly after the conformance suite, and report.
5. **Tests and evidence.** Every new test fails without its fix (rerun two red mutations: the N3 door seal and the N2 audit). CT-11 evidence names `96c07f63c` (pre-rebase head; acceptable because the rebase is conflict-free — confirm) and matches the code. Commits are signed off and Conventional; no machine paths or personal emails in tracked files.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built from this head and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Run `bun install --frozen-lockfile` first. One cargo command at a time, debug; other Rust workers run at the same time, so keep memory modest. Known: `native_run` capability tests fail in sbx-deny (setuid `/bin/ps`); the matrix doctor activity-order race is pre-existing (rerun once and say so).

Tests to run: clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-server`, `pacer-endpoints`; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/serve-plugin-native.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance.test.ts`, and the assistant-key e2e test.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-rereview.md: the verdict (PASS / FAIL / UNVERIFIED) against head `aafa8159d`, per-finding status, findings with severity (blocking / nonblocking / nit) and code references, a ruling on the deadline stall, and the commands you ran with their results. Report with `orca orchestration worker_done`. Always end with worker_done.

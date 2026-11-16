# Task: owner parity R1 — align the native owner's plugin.hello deadline and text with flag-off (PR 7 gate)

Executor: cursor-agent (default model, standard tier: a small parity fix in the plugin runtime). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-r1, branch `fix/owner-hello-deadline`, based on `main` (includes PR A #945).

Read and follow the "Build and environment", "Safety" and "Output" sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Also read AGENTS.md, `.project/rules/{rust,code-and-testing,api-protocol,repository}.md`, ADR 0027 and `docs/testing/m2-ledger.md` (the PR 7 gate list).

## The finding

From PR A's re-review (/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-rereview.md, "R1" and "Ruling on the deadline stall"):

- Owner: `crates/plugin-runtime/src/bridge_call.rs:33` `HELLO_DEADLINE = 5 s`, used near line 671 (`remaining(until)?.min(HELLO_DEADLINE)`). A hello timeout maps to "plugin call passed its absolute deadline" through `call_failure`.
- Flag-off: `src/plugins/registry.ts:174` `HELLO_DEADLINE_MS = 10_000`; a hello timeout fails with "plugin.hello passed its 10000 ms deadline" and records a crash (read the code around `registry.ts:2093` for the exact text, error code and crash accounting).
- Impact: under load a slow-starting bundled plugin (the assistant) fails flag-on where flag-off succeeds, with a misleading text. It fails closed.

## Scope

1. Make the owner's hello cap 10 s, still bounded by the call's own absolute deadline, and give a hello timeout flag-off's text and error code. Match flag-off's crash/backoff accounting for a hello timeout if the owner has an equivalent (record what you find; do not invent new accounting).
2. Check every owner path that sends `plugin.hello` (HTTP serve owner, stdio owner, attached and self-owned stdio, the lazy-start path used by `plugin.doctor`), not only `bridge_call.rs`; one constant and one text.
3. Tests, each red first: a Rust unit or integration test with a fixture plugin that answers hello after 6 s (passes flag-on now; failed before) and one that never answers (fails at 10 s with flag-off's text, not "absolute deadline"); a TypeScript-level comparison flag-off vs flag-on on the same slow fixture if the existing conformance harness supports it (`test/plugin-conformance-native-owner.test.ts`). Keep test runtime modest (use a shorter deadline only if the constant is injectable for tests; otherwise accept the 10 s case).
4. Ledger: mark R1 green in the PR 7 gate list (add the row if missing). CHANGELOG entry (REPO-7).

Required checks: as in `w4-common.md`, for `pacer-plugin-runtime` and any crate you touch, plus `test/plugin-conformance-native-owner.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugins-native-owner-assistant-key.test.ts`.

CT-11: `bun run live up --front-door rust --native-plugin-host` and flag-off; use a sandbox fixture plugin with a delayed hello (6 s) and show `plugin.doctor` succeeds in both modes, and a never-answering one fails with the same text in both. Name the head. Report surfaces you cannot exercise as UNVERIFIED.

Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-r1-handoff.md. PR title: `fix(plugin-runtime): give the native owner's plugin.hello flag-off's 10 s deadline and text`.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-r1.md exactly. End with orca orchestration worker_done.

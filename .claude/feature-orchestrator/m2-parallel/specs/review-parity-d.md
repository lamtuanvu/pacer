# Task: independent review of owner parity PR D — frame plugin messages in JSON.stringify key order (REPO-10)

Executor: cursor-agent (default model, medium tier); GLM would review this but its quota is exhausted. Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-d, branch `fix/plugin-frame-key-order`, head `6df765f27`, two commit(s) on wave 3 PR 6 (`2951c0aeb`, reviewed PASS; a tests-and-docs fix round on PR 6 is running, and this branch will be rebased onto it).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-d-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-d.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR D" in §2 and the §1 items it closes).
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, code-and-testing, architecture, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. `pacer_js_json::stringify` framing is byte-identical to Bun's `JSON.stringify` for every value shape the owner frames (nested objects, arrays, unicode including lone surrogates, numbers including `-0`, large integers and exponents, `undefined`-like absent fields), and the `$/event` size check measures the same bytes TypeScript measures.
2. Nothing relies on sorted framing (a hash, signature, dedupe or comparison of framed bytes) anywhere in the Rust workspace or TypeScript; search for consumers of the framed output.
3. Whether insertion order is truly preserved end to end (the `serde_json::Value` maps on this path: is `preserve_order` enabled for the crates involved, and does any step re-sort?).
4. The handoff says four `pacer-plugin-capabilities` `native_run` tests fail identically at the base on this machine: confirm they fail at `2951c0aeb` too and why (sandbox or environment), so this PR is not hiding a regression.
6. Every new or flipped test fails without its fix; tests tell the truth (no masking that hides a divergence). CT-11 evidence names this head (or one with only test-only commits after) and matches the code. Docs, ledger and CHANGELOG are accurate; no machine paths or personal emails; commits signed off and Conventional.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. One cargo command at a time, debug; other Rust workers run at the same time, keep memory modest. Note: the PR 6 conformance and matrix tests currently use fixed `/tmp/pcn` and `/tmp/pom-<row>` roots (being fixed on PR 6); do not run them at the same moment as another worker in the same root — if a run fails with a vanished home, rerun once and say so.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

Tests to run: clippy `-D warnings` and tests for `pacer-plugin-host`, `pacer-plugin-capabilities`, `pacer-plugin-runtime`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugin-conformance.test.ts`. Rerun the red-first mutation for one framing test.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-d-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `6df765f27`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-d.md exactly. End with orca orchestration worker_done.

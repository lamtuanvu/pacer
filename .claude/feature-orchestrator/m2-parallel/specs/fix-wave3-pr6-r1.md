# Task: wave 3 PR 6 fix round 1 (tests and docs only)

Executor: OpenCode Go GLM `glm-5.2` (medium tier): test and documentation corrections, no runtime or authority change. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr6, branch `test/native-owner-consumer-matrix`, head `2951c0aeb`. Three other branches (PRs B, C, D) are stacked on this head and edit `test/plugins-native-owner-matrix.test.ts` and `test/plugin-conformance-native-owner.test.ts`: keep your edits to those files minimal and local (no reformatting, no moving blocks) so their rebase stays easy. Run `bun install --frozen-lockfile` first.

Input: the review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-review.md ("Findings"). Rules: AGENTS.md, `.project/rules/{code-and-testing,repository}.md`.

## Fix

- **N1:** route the admission row accurately: Core auto-issues a granted manifest's exact `net.http` hosts and exact `fs.read` paths for any owner call without host resources (`autoIssueFromManifest`). Update the ledger (`docs/testing/m2-ledger.md` gate line and plugin rows), and add an exact-path `fs.read` relay case to the routed set in `test/plugin-conformance-native-owner.test.ts` (expected-fail, failing for that reason).
- **N2:** give the `ui.render` or `ui.action` fixture error a hint so the flag-off/flag-on comparison covers hint preservation; show the hint-dropping mutation in `plugin_reply_error` turns the test red (save the log).
- **N3:** mask ids by value shape (uuid, generated `t-…` style) or path instead of every `"id"`, and stop masking fixture-fixed `resetsAt`; if a narrower mask exposes a real divergence, keep it visible and report it.
- **N4:** assert the refusal text for the four known-refused keys on the flag-on stdio runs, as the HTTP row does.
- **N6:** per-run `mkdtempSync("/tmp/pcn-")` for the conformance subset and one mkdtemp root per run for the matrix (short enough for sockets); `afterAll` removes only its own root.
- **N8 (optional, if small):** a shorter barrier self-timeout in the reentrant probe with an assertion that receipts show no overlap.
- **D1:** move the `/// Rank statuses…` rustdoc back onto `pub fn rank_executors` (`crates/engine/src/lib.rs`).
- **D2:** the ledger's reconcile and notifier rows are serve-only (HTTP).
- **N5:** correct the PR body wording in the handoff (distinct sorted Ark CLI argv; hit counts only in conformance relays).
- N7: record as a watch item in the handoff follow-ups.

## Checks

Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`; both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts` (report counts that ran); `cargo fmt --all --check`, clippy `-D warnings` for `pacer-engine`; `git diff --check`. Save logs under `.work/fixtures/wave3-pr6-r1/`. No live run needed (no runtime change); say so.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Commits and output

Conventional Commits (`test:` / `docs:`), signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Never commit `.work/`.

Append a "Fix round 1" section to /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md (per-finding status, commits, counts, red evidence) and an updated draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done; do not end your turn before that.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr6-r1.md exactly. End with orca orchestration worker_done.

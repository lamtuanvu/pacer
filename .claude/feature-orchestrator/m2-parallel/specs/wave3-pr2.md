# Task: M2 wave 3 PR 2, answer the plugin operations natively on stdio and own children per connection (OD-2)

Executor: cursor-agent (default model, frontier tier). Security-sensitive: a new sealed private stdio IPC, per-connection Unix sockets, a socket-attach probe with peer-uid checks, and process ownership of plugin children. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr2, branch `feat/plugin-ops-stdio-owner`, based on wave 3 PR 1 (#917, branch `refactor/plugin-capabilities-crate`, head `74b5240d5`), which extracts `pacer-plugin-capabilities` and moves `pacer-plugin-runtime` to layer 6. #917 is reviewed and in CI; if it changes, the coordinator rebases you. Not pushed.

Plans (read fully before starting):
- /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-pr2-stdio-owner.md, the authoritative design for this PR: sections 1–2 (the coexistence rule), 3.1, 4.1 (scope, files, budgets, tests, CT-11), 4.3, the ledger delta, and the maintainer answers Q1–Q8 in its header (all accepted: Q1 CLI duplicates are a known limit; Q3 sealed owner-relay kind; Q4 attach decision final per connection; Q5 socket `run/s<12-hex>.sock` with a bind-time length guard; Q7 ADR 0027 in this PR; Q8 stdio CT-11 evidence from the fixed stdio fixture). Q2 and Q6 are PR 5 work, not this PR.
- /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md: header decisions OD-1..OD-7 (OD-2: a Rust `ProcessOwner` per stdio connection; OD-7: a second serve refuses to start, productized in PR 5), sections 0–2 for ground truth, and the original PR 2 test list.

Before working, read `.agents/skills/project-governance/SKILL.md`, `.project/constitution.md`, `.project/context.md`, and the rules and reviewers that apply: `.project/rules/{security,rust,rust-crates,api-protocol,architecture,code-and-testing,repository}.md`, `.project/reviewers/{security,protocol-compat,qa}.md`, `docs/testing/live-validation.md`, `docs/decisions/0020-*.md`, `docs/decisions/0026-*.md`.

## Scope

Implement plan section 4.1 as written: the twelve `plugin.*` operations native on the stdio front door; the core-IPC transport trait with the HTTP implementation unchanged; flag-off composition through the TS core child over the sealed `_internal.plugins` stdio method; flag-on ownership per section 2 (probe the live serve `host.sock` and attach, else own children per connection on a per-connection socket passed as `PACER_HOST_SOCKET` at core spawn, torn down at connection end); the owner-relay kind; nesting and deep fallbacks replaying the original line; refusals before hello v3; `PACER_FORWARD_OPS` parity. New ADR 0027 (the one-owner-per-home rule, coexistence, OD-7 in consequences). CHANGELOG, ledger rows per the plan's delta (totals unchanged), module docs. CRATE-1: `pacer-server` will pass 8,000; state why and name the next split in the PR text, per the plan.

If the code at this base contradicts the plan (line numbers moved, an assumption no longer holds), follow the code, record the deviation in the handoff, and stop to ask through `orca orchestration` only if the deviation changes the security model or a maintainer decision.

## Tests

Plan section 4.1's differential list: `test/native-plugin-ops-stdio.test.ts` (stdio vs forced-forward goldens for all twelve, HTTP and stdio byte parity, nesting 512±1 fallbacks, deep `ui.render` refusal, in-flight `conflict` and pipelined ordering, lone surrogates, on-disk effects, `_internal.plugins` unreachable without the sync key and before hello v3, descendants cannot inherit), plus the two-owner races (i)–(vi), except (iv) OD-7 refusal, which belongs to PR 5 (keep a placeholder note). Crate tests for the transport trait, the path-parameterized bind and the length guard. Show red evidence for the security checks (sync-key sealing, uid check on attach, pre-hello refusal) by mutation; save logs under `.work/fixtures/wave3-pr2/` in this worktree.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH` (it has the `ps` shim), and `env -u PACER_TEST_NATIVE_FRONT_DOOR` unless you point it at this worktree's own build. Run `bun install --frozen-lockfile` first if `node_modules` is missing (outside the deny sandbox only if it needs the network). One cargo command at a time; debug only; no release builds. Another Rust worker runs at the same time; keep memory use modest.

`cargo fmt --all --check`; clippy `-D warnings` on `pacer-server`, `pacer-plugin-ops`, `pacer-plugin-runtime`, `pacer-plugin-capabilities`; `cargo test` for those crates; `cargo xtask loc --check`, `deps`, `gen --check`; `bun run typecheck`; the new and neighbouring Bun tests (`test/native-plugin-ops*.test.ts`, `test/plugins-native-owner-call.test.ts`); `git diff --check`.

## CT-11

Per plan 4.1: extend the existing native stdio harness fixture so the D3 guard admits the fixed stdio plugin-op sequence (record it in `docs/testing/live-validation.md`), then run: flag-off and flag-on stdio sessions on a serve-less sandbox home, flag-on attach (live sandbox serve plus a stdio session sharing children), HTTP/serve regressions, web Settings › Plugins unchanged, and `live down` with a stdio session attached to a dying serve. Use temporary sandboxes only (`bun run live up ...` with a temp `PACER_HOME`, never the real install), never ports 4317, 11434, 1234, 41343. Desktop rows stay UNVERIFIED under the 2026-11-02 exception. Tear everything down (`live down --keep`), and confirm no sandbox, browser or tmux processes remain.

Commits: Conventional Commits (`feat(plugin-ops): ...`, `docs: ...`), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve` or its launchd label.

## Handoff

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-handoff.md`: commits; per-file changes; the ownership flow as built (attach, self-own, teardown) with code references; security mechanisms and their red evidence; tests and checks with counts; CRATE-1 numbers and the server split paragraph; CT-11 summary per surface (PASS, FAIL, UNVERIFIED); deviations from the plan; open questions; draft PR text following `.github/pull_request_template.md`. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave3-pr2.md exactly. End with orca orchestration worker_done.

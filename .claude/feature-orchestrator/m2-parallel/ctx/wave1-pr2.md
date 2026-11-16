# Task: M2 wave 1 PR 2 — read unusual repository registries like JavaScript

Executor: cursor-agent (default model). Rust parity work over shared registry readers with differential tests and live validation; frontier tier. No time limit; finish implementation, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr2, branch `fix/native-repo-registry-js-reads`, stacked on wave 1 PR 1 (`fix/native-repo-remove-ts-registries`, open as #910, reviewed PASS). Run `bun install --frozen-lockfile` first. Memory and disk are tight: build only touched crates and the `pacer` binaries once, one cargo command at a time, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`; never release or `--workspace` builds.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{qa,protocol-compat,security}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md` in full, especially §1a, §1b, decisions Q1–Q10 in the header and "PR 2". PR 1's handoff and reviews (`.work/reviews/wave1-pr1-{handoff,review,rereview}.md` in /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr1) show the reader, spread semantics and test patterns PR 1 established; reuse them. Recheck every cited file:line; the plan was read, not run, and PR 1 moved code.

## Scope (PR 2 only)

Exactly the plan's "PR 2": rewrite `registry_needs_core` and the readers (`registry()`, `list`, `prune`) in `pacer-repos` to apply spread semantics, index-key order, `__proto__` own keys, ToPropertyKey alias lookup, ToNumber sort keys and `Infinity` → `null` on write; narrow forwarding to the "keep" rows of §1a (Q4 relative paths and Q5 nesting stay forwarded); update the call sites in `pacer-config-ops` (`repo_registry_ops.rs`, `project_strategy_ops.rs`) and `pacer-issues` only if the signature changes. Do not change the HTTP undecodable-body forwarding (#909 is separate). Do not touch `config.set` code (#901).

## Tests

Extend `test/native-repo-registry-parity.test.ts` and `test/native-repo-add-parity.test.ts` with the §1a corpus (each row: reply, file bytes after `repo.add`, prune timing) against `PACER_FORWARD_OPS` on twin homes over stdio and HTTP; normalize per-home values such as `machineId` (Linux CI gives each home its own). Add `issue.list` and `project.strategy.list` smokes over one odd registry. Lock race: native `repo.add` vs forwarded `repo.remove`; native prune (locked) vs TS prune (unlocked) — document the existing divergence. Rust unit tests in `crates/repos/tests/`. Every new behavior must fail without its change (red evidence for at least spread, alias lookup and sort order).

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`: fmt, clippy `-D warnings` and tests for the touched crates, `cargo xtask loc --check` (state the CRATE-1 paragraph for any touched crate over 8,000 per Q7 and name the split), `cargo xtask deps`, `bun run typecheck`, the parity tests, `git diff --check`.

## CT-11

Per the plan: web New Task / Start Session repo picker with a seeded odd registry, CLI `pacer api call repo.list`, HTTP and stdio, TUI project list if drivable (otherwise UNVERIFIED with reason), on a `--front-door rust --native-test-ops` sandbox and a TypeScript sandbox; D8 admits `repo.add` only for the disposable repo. Record report summaries; stop every session (`live down --keep`) and confirm no processes remain.

Ledger rows and CHANGELOG `[Unreleased]` per REPO-7. Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never install or uninstall real planner integrations.

## Handoff

Write `.work/reviews/wave1-pr2-handoff.md` in the worktree: commits, per §1a row outcome (native, forwarded, why), tests with counts and red evidence, LOC and CRATE-1 text, live summaries and UNVERIFIED items, executor and tier. Report with `orca orchestration worker_done`. Always end with worker_done.

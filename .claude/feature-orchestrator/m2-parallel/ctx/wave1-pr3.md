# Task: M2 wave 1 PR 3 — serve project strategies and previews natively when the strategy file is broken

Executor: cursor-agent (default model). Rust parity work with differential tests and live validation; not a small task. No time limit; finish implementation, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr3, branch `fix/native-project-strategy-broken-strategy` at origin/main `acab1eca4`. No build yet. Disk has about 39 GiB free shared with other workers: build debug only, never release.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,api-protocol,code-and-testing,repository}.md`, `.project/reviewers/{protocol-compat,qa}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md`: the maintainer decisions at the top, section 0, sections 1c and 1f, "PR 3", the ledger table and the risks. Recheck every file:line the plan cites; it was read, not run.

## Scope

Independent of PR 0–2: do not touch the repository-registry predicate (`registry_needs_core`) or the registry readers.

1. `project.strategy.list/get/set/remove` (`crates/config-ops/src/project_strategy_ops.rs`): narrow the strategy-load forward to YAML syntax and I/O errors. Serve a missing strategy and a schema-invalid strategy natively with TypeScript's reply: TypeScript returns code `internal` here (plain `Error` through `toApiError`); fix the `strategy()` error mapping that gives `invalid_input`.
2. `project-strategies.json` read and validation errors: port only after a validator-equivalence corpus passes against TypeScript (Zod schema, `parseRunnerId`, `projectKey` versus `crates/lifecycle/src/projects.rs`). Corpus at least: version `1.0`/`"1"`, rev 0/1.5/2^53/-1, duplicate executors, bad references, a `__proto__` key, a BOM, invalid UTF-8, unreadable file, directory in place of the file. Fix validator mismatches you find. Inputs where TypeScript's text comes from Node or Bun stay forwarded.
3. `strategy.preview` (`crates/config-ops/src/strategy_preview_ops.rs`): serve a missing and a schema-invalid current strategy natively (`invalid_input` plus `STRATEGY_HINT`, as `strategyAction` wraps it). YAML syntax and I/O errors, unreadable drafts, and drafts that change provider inputs stay forwarded.

CRATE-1: `pacer-lifecycle` is over 8,000 LOC. If you change it, keep the change minimal and add to the handoff a short "why, and the named split" note for the PR description. Record `cargo xtask loc` for touched crates before and after.

Size: about 600 changed lines. Commits: Conventional Commits, `git commit -s` (for example `fix(config-ops): serve project strategies natively when the strategy is missing or invalid`). Do not push.

## Tests

Differential, both front doors (stdio and HTTP), against `PACER_FORWARD_OPS=<op>` on twin homes, comparing reply JSON, `project-strategies.json` bytes after `set`/`remove`, and SSE events, with `PACER_DEBUG_NATIVE=1` trace markers proving which side ran:
- new `test/native-project-strategy-parity.test.ts` (missing and invalid strategy, the policy-file corpus, file bytes);
- extend `test/native-job-strategy-setup-parity.test.ts` for `strategy.preview` with a missing or invalid current strategy;
- a lock race: two concurrent `project.strategy.set` on one key, one native and one forwarded; the `rev` conflict text must match;
- forwarding tests for the inputs that stay forwarded.
Update the ledger rows 131 and 125 in `docs/testing/m2-ledger.md` to the new residuals, and regenerate any generated docs the repo requires.

## Checks

Serial and inside sbx-deny, with disposable HOME and PACER_HOME (keep the real CARGO_HOME and RUSTUP_HOME), TZ=Asia/Ho_Chi_Minh: `cargo fmt --check`, `cargo clippy -p <touched crates> --all-targets -- -D warnings`, `cargo test -p <touched crates>`, `cargo xtask loc --check`, `bun run typecheck`, the Bun tests you add or touch, `git diff --check origin/main..HEAD`.

## Live validation (CT-11)

Per docs/testing/live-validation.md, session ids `live-wave1-pr3-`: `bun run live up --front-door rust --native-test-ops`. Break the disposable home's strategy (missing, then schema-invalid), then exercise `project.strategy.list/get/set/remove` and `strategy.preview` over the CLI, HTTP and stdio, and compare with the TypeScript front door (`live up` without `--front-door`). Web Dispatcher settings and setup and the TUI project strategy screen: exercise them if the harness reaches them, otherwise report UNVERIFIED with the reason. Write the report with a Summary line. One live session at a time in this worktree; another worker runs its own session elsewhere, leave it alone. Stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343.

## Handoff

Write `.work/reviews/wave1-pr3-handoff.md` in the worktree: commits, per-input outcome (now native / still forwarded and why), validator mismatches found and fixed, LOC before and after, check commands with pass counts, live session id, report path and Summary line, UNVERIFIED surfaces with reasons, cleanup. Report with `orca orchestration worker_done`. Always end with worker_done.

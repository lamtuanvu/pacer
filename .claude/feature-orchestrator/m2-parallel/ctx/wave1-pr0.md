# Task: M2 wave 1 PR 0 — consolidate JavaScript JSON compatibility into `pacer-js-json`

Executor: cursor-agent (default model). A cross-crate Rust refactor with layering rules; not a small task. No time limit; finish the change, checks, the smoke and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr0, branch `refactor/js-json-consolidate` at origin/main `acab1eca4`. It has no build yet; disk is tight (about 19 GiB free), so build only the crates you touch (`cargo test -p ...`) and never run release builds. The live smoke needs the debug `pacer` binaries; build them once.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{rust,rust-crates,architecture,code-and-testing,repository}.md`, `.project/reviewers/architecture.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md` (the maintainer decisions at the top, section 0, and "PR 0").

## Scope

`pacer-js-json` (`crates/js-json`, layer 1) already exists on main. Do not add a new crate. Move the JavaScript `JSON.parse` acceptance and `JSON.stringify` code into it:
- `crates/plugin-ops/src/json.rs` and `crates/repos/src/json.rs` become thin re-exports or are removed, with call sites switched to `pacer_js_json`;
- reconcile overlaps with what `pacer-js-json` already has (`parse.rs` depth limit 128, `js_semantics`), keeping one implementation of each behavior; where two copies differ, keep the stricter JavaScript-faithful one and add a test showing the difference;
- `crates/mcp/src/json.rs`: migrate only if its API matches without behavior change; otherwise leave it and say why.

No behavior change. Existing tests move with the code and still pass unchanged; golden files must not change. Keep layering valid (`pacer-repos` is layer 4, `pacer-plugin-ops` layer 5; both may depend on layer 1). Record LOC before and after for every touched crate with `cargo xtask loc` (CRATE-1). Report CRATE-9 build timings if the crate's dependency set changes.

Size: about 600 changed lines. Commit with `git commit -s -m "refactor: share JavaScript JSON compatibility in pacer-js-json"` (more commits are fine). Do not push.

## Checks

Serial and inside sbx-deny, with disposable HOME and PACER_HOME (keep the real CARGO_HOME and RUSTUP_HOME), TZ=Asia/Ho_Chi_Minh: `cargo fmt --check`; `cargo clippy -p <each touched crate> --all-targets -- -D warnings`; `cargo test -p` each touched crate and its direct dependents that use the moved functions (find them with `rg`); `cargo xtask loc --check`; any Bun parity tests that cover repo registry reads (`test/native-repo-registry-parity.test.ts`, `test/native-repo-add-parity.test.ts`) if they run against a debug build you already have; `git diff --check origin/main..HEAD`.

## Live validation (CT-11)

No runtime behavior change is intended. Still run a short smoke per docs/testing/live-validation.md: `bun run live up --front-door rust --native-test-ops`, session id `live-wave1-pr0-`, `repo.list` and `repo.add` on the disposable repo over HTTP and stdio, and a plugin-ops call that parses JSON if the harness has one. Write the report with a Summary line. Stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Another worker uses its own live session in another worktree; leave it alone.

## Handoff

Write `.work/reviews/wave1-pr0-handoff.md` in the worktree: commits, what moved where, behavior differences found between copies and how resolved, LOC before and after, check commands with pass counts, live session id and Summary line, UNVERIFIED items. Report with `orca orchestration worker_done`. Always end with worker_done.

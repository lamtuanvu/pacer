# Task: fix round 1 for wave 1 PR 3

Executor: cursor-agent (default model). Rust parity fixes, corpus additions and a web live check; not a small task. No time limit; finish fixes, checks, live and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr3, branch `fix/native-project-strategy-broken-strategy`, head `477476299`. Reuse its `target/`. Read the review `.work/reviews/wave1-pr3-review.md` in full and your handoff `.work/reviews/wave1-pr3-handoff.md`. Same rules and constraints as the original brief (`/Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave1-pr3.md`).

## Fixes

For each defect, either match TypeScript exactly or keep the input forwarded. Prefer forwarding when matching needs Bun or JavaScriptCore behavior Rust cannot reproduce faithfully; never leave a native reply that differs from TypeScript.

1. F1: an absolute active strategy name. Rust `PathBuf::join` replaces the base, so Rust reports the wrong path or reads outside PACER_HOME. Match TypeScript's path construction exactly, or forward. Reading a file outside PACER_HOME must not happen natively unless TypeScript does the same; state which in the handoff.
2. F2: `project-strategies.json` with a lone surrogate, nesting deeper than 128, `1e400`, or invalid UTF-8 inside an own `__proto__` value or an overwritten duplicate key. TypeScript reads these; Rust rejects them as invalid. Use the `pacer-js-json` parse (JavaScript `JSON.parse` acceptance) where it gives the same result, and forward the rest.
3. F3: tab-indented and multi-document strategy YAML, which Rust parses but Bun reads differently. Forward these (and any other YAML shape where the Rust and Bun parsers can disagree that you find) unless you can prove identical results.
4. Add every input from F1–F3 to the corpus and the differential tests (stdio and HTTP), with forwarding assertions for the ones that stay forwarded.
5. Correct ledger rows 125 and 131 and the CHANGELOG entry to the final residuals.
6. Any nonblocking findings in the review that are small: fix them; otherwise list them in the handoff.

## Live validation

Rerun the live checks touched by the fixes (session ids `live-wave1-pr3-r1-`). Then exercise the web Dispatcher settings and setup screens with the harness's browser control (`--surface web`; see `scripts/live/` and docs/testing/live-validation.md, which the reviewer says reaches them): with a missing and with an invalid strategy, show what the screens display through the Rust front door and the TypeScript front door, and capture the harness evidence. Live stdio stays UNVERIFIED (D3). Stop everything you start.

Commits: new signed commits (Conventional Commits), identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`). Do not push.

## Checks

As before: fmt, clippy `-D warnings`, `cargo test -p` touched crates, `cargo xtask loc --check`, `bun run typecheck`, the touched Bun tests, `git diff --check origin/main..HEAD`.

## Handoff

Append a "Fix round 1" section to `.work/reviews/wave1-pr3-handoff.md`: per finding the change (commit) or reason, which inputs went native versus forwarded, tests added, check results, live session ids, report paths and Summary lines including the web surface, UNVERIFIED items. Report with `orca orchestration worker_done`. Always end with worker_done.


Do the task above end to end. Report with orca orchestration worker_done.

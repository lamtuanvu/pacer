# Task: revise the design of M2 wave 3 PR 2 for the maintainer's OD-2 and OD-7 decisions (read-only planning)

Executor: OpenCode Go GLM 5.3 (frontier tier): a design revision with process-ownership and security consequences, no code. Read-only: do not edit tracked files, build, run tests, commit or push. You may run `git`, `rg`, and read files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-wave1-plan (detached at origin/main `acab1eca4`).

Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md. Read it in full, especially the maintainer decisions header, §2, §3, §5 PR 2, PR 5, PR 7 and §7.

The maintainer decided differently from two recommendations:
- **OD-2:** the stdio front door gets a native Rust `ProcessOwner` per connection (the plan recommended keeping the TypeScript core child as owner on stdio).
- **OD-7:** a second serve on a home whose `run/host.sock` owner is live refuses to start (the plan recommended falling back to TypeScript ownership with a warning).

Read the code at `acab1eca4` that these touch: `crates/plugin-runtime/src/{owner,process,serve_host,bridge_listener,native_host}.rs` (whichever exist), `crates/server/src/native/plugins.rs`, `crates/server/src/stdio_proxy.rs`, `crates/server/src/serve/mod.rs`, `src/api/stdio.ts`, `src/serve/plugin-native.ts`, `src/plugins/registry.ts`, `src/plugins/host-bridge.ts`, and the ADRs on process ownership (`rg -l "process owner|ProcessOwner|single owner" docs/decisions`), plus ADR 0021 and `.project/rules/{architecture,security,rust-crates}.md`.

Answer, with file:line evidence:
1. With a Rust owner per stdio connection, how do plugin children, plugin state (`state/plugins*`, locks, settings, restart/backoff records) and Core's plugin registry stay consistent when (a) serve is running on the same home with its own owner, (b) two stdio connections are open at once, (c) the CLI core child also spawns plugins? Name every place two owners could race the same plugin child, lock or socket.
2. Propose the concrete coexistence rule, for example: a stdio owner attaches to serve's live owner over `run/host.sock` when one exists and owns children only when none exists; or stdio owners are per-connection and isolated by an ownership lease. Pick one, justify it against the "no second process owner" constraint and ADRs, and say whether any decision record must change (and if so whether that is an ADR or a constitution amendment).
3. How OD-7's refuse-to-start interacts with your rule (stdio owner holding the socket when serve starts; serve live when stdio connects; stale socket after a crash; the live harness, tests and `service restart` flows that start a serve while another may still be shutting down). List every existing flow that could now fail to start and how PR 5 must handle it (exit code, error text, `pacer doctor` hint).
4. Revised PR 2 (and PR 5 if it changes): scope, files/crates, CRATE-1 budgets (estimate; `cargo xtask loc` is authoritative), differential tests (including the two-owner races), CT-11 live surfaces, size, dependencies, and whether PR 2 must now come after PR 1 and PR 5.
5. Any new open questions for the maintainer, each with a recommended answer.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-pr2-stdio-owner.md` with those sections and an UNVERIFIED list. Report with `orca orchestration worker_done`. Always end with worker_done.

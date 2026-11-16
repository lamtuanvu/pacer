# Task: owner parity PR G — authenticate native owner bridge callers (#918)

Executor: cursor-agent (default model, frontier tier). Security-sensitive: bridge caller authentication and lane binding. No subagents. No time limit; finish implementation, tests, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-g, branch `fix/owner-bridge-caller-auth`, stacked on PR B (`fix/owner-sealed-door-calls` at `693b1b182`, reviewed PASS; it sits on wave 3 PR 6). PR A (owning-call authority; reviewed PASS on a sibling branch, it will rebase onto B) and PR F (observation generations, stacked on B, in progress) run at the same time; PR F also edits `bridge_call.rs`, so keep your edits there minimal and local. Run `bun install --frozen-lockfile` first.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, `gh issue view 918`, and the plan /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md: maintainer decisions at the top (Q5: #918 gates PR 7), "PR G" in §2, and R1 in §1. Also the PR A security review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-review.md, finding N1: until G, a same-uid peer can get Core to resolve the assistant key or sign for a process it controls, by stopping, spawning or pre-spawning the `pacer-assistant` lane with its own spawn spec (`crash.rs` reuses any live lane; the unsealed `_host.plugin.spawn` and `stop` are accepted) or by impersonating the socket. PR A is not in your base; read its branch `fix/owner-call-authority` for the Core-answered `secrets.resolve`/`identity.sign` path you must protect. Recheck cited file:line; follow the code and record deviations; stop and ask through `orca orchestration` only if a deviation changes the security model.

## Scope

As "PR G" plus A's N1 remedy:
1. Authenticate every bridge caller beyond same-uid (`crates/plugin-runtime/src/bridge_listener.rs` `PeerAuth` and dispatch, `serve_host.rs`, the stdio door's bridge setup in `crates/server`, the client credential in `src/plugins/host-bridge.ts`): only Core (serve's Core and each owning or attached stdio door's Core) can call. Design the credential so it never touches disk readable by others, is not inherited by plugin children or runners (PR E removes `PACER_HOST_SOCKET` from runners; make sure your credential is not in any child env either), and rotates per owner start. Record the design in ADR 0027.
2. Refuse the unsealed `_host.plugin.call` and `_host.plugin.spawn`/`stop` forms on a live owner (R1 hardening), or bind Core-sealed calls to lanes started from Core's own spawn spec (compare a spec fingerprint), so no caller can substitute a lane a sealed call will use.
3. ADR 0027: the Q1 bullet's residual-risk clause (state it is closed by this PR).

## Tests

A same-uid peer without the Core credential is refused on every bridge method (including the private kinds and the unsealed forms); a peer cannot pre-spawn, stop or replace a lane that a sealed call then uses (the `pacer-assistant` case from A's N1); Core, attached stdio Cores and serve's Core still work (the full PR 6 matrix and conformance subset pass); the credential does not appear in any child's environment, argv or log. Every new test fails without its fix; save red logs.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. Both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. Build only the crates you touch, one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`; never release or `--workspace` builds; other Rust workers run at the same time, keep memory modest. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-server` and any crate you touch; `cargo xtask loc --check` (state CRATE-1; the plan estimates `pacer-plugin-runtime` +150), `cargo xtask deps`, `cargo xtask gen --check`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/serve-plugin-native.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-crash.test.ts`, `test/doctor-host-socket*.test.ts` if present; `git diff --check`. Save logs under `.work/fixtures/parity-g/`.

## Live validation (CT-11)

On a `bun run live up --front-door rust --native-plugin-host` sandbox: a hand-made same-uid client (a small script connecting to the sandbox's `run/host.sock` and to a stdio door's private socket) is refused on every method; the `native-plugin-owner` and `native-plugin-stdio` scenarios pass; a flag-off sandbox comparison; `bun run live report`. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes, sockets or sidecars remain. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`; load no launchd job.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>), small logical commits. Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-handoff.md`: commits, per-file changes, the credential design (issue, transport, verification, rotation, what children can see) with code references, deviations, test results with counts and red evidence, LOC and CRATE-1 text, live report summary with UNVERIFIED items, follow-ups, and a draft PR body following `.github/pull_request_template.md` (with `Closes #918` and the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-g.md exactly. End with orca orchestration worker_done.

# Task: M2 wave 3 PR 6 — flag-on consumer matrix for usage, doctor, setup and planners (tests first)

Executor: OpenCode Go GLM, `glm-5.3` (frontier tier). This PR is verification: differential tests and live evidence, with small fixes for divergences you find. Routing rule: if a divergence needs a change to a security boundary — the sealed owner bridge or relay, `crashed`/`relay` private kinds, credential bindings or secrets, socket permissions or peer checks, capability authority or grants — do **not** fix it. Write it up with a reproducing test (marked skipped or expected-fail with a reason) and report it in the handoff; the coordinator routes it to a security-sensitive executor. No subagents. No time limit; finish tests, any allowed fixes, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr6, branch `test/native-owner-consumer-matrix`, stacked on wave 3 PR 5 (`feat/owner-crash-backoff` at `eb43c4c7b`, open as #927, reviewed PASS, in CI; the coordinator rebases you onto `main` after it merges). Wave 3 PRs 1–4 (the plugin-capabilities crate split, the #629 ports, #920 stdio owner, #921 endpoint/Orca bridge) are on `main` and in your base. Run `bun install --frozen-lockfile` first. Build only the crates you touch (one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); never release or `--workspace` builds. Other Rust workers may run at the same time; keep memory use modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{code-and-testing,api-protocol,security,rust,repository,architecture}.md`, `.project/reviewers/{qa,protocol-compat}.md`, `docs/testing/m2-ledger.md` (rows 22–24), `docs/testing/live-validation.md`, ADR 0026 and ADR 0027 (`docs/decisions/`), and the plans:
- `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md`: §1 G1 (conformance against the native owner), §3 consumer table rows 1–3 and the "already crossing" list, "PR 6", "PR 7" gate, OD-1, risk R4.
- `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-pr2-stdio-owner.md` §4.3 (stdio flag-on rows, conformance subset against a stdio owner door).
Maintainer decision OD-1: PRs 1–6 land now; the default-on flip (PR 7) happens only if this PR's matrix is green. So the matrix's job is to tell the truth about what works flag-on, not to look green. The plans predate PRs 2, 4 and 5: recheck every cited file:line against your base.

## Scope

1. **Consumer matrix (`test/plugins-native-owner-matrix.test.ts`, new).** Each case runs three ways on the Rust front door — `PACER_NATIVE_PLUGIN_HOST=1`, `PACER_NATIVE_PLUGIN_HOST=0`, and forced forward (`PACER_FORWARD_OPS=*`) — and compares results, error codes and hints, activity log lines and persisted stores (`cache/arkcli-usage-plan.json`, `state/codex-cursors.json`, plugin settings) byte for byte, normalizing only timestamps and ids, each normalization justified in a comment-free helper name or the handoff. Rows:
   - usage: `limits.refresh` (selective forward with a provider command and the Ark CLI path), `account.usage.check`, `account.list` (parts bridge), `limits.check`/`routing.status` parts;
   - doctor and setup: `doctor.run`, `setup.health`, `setup.check` (planner check, integration freshness, usage checks, diagnostics remedies);
   - planners with a fixture planner plugin: `agent.preview`, `agent.connect`, `agent.disconnect`, the `agent.detect` miss path, startup reconcile; `onboarding.skip`; `strategy.build` status-text effect;
   - notifier and assistant calls;
   - the wave 3 PR 4 shapes: `endpoint.launchEnv` with an empty binding list crosses; keyed or keyless `endpoint.models`, `endpoint.test` and `classifier.ask` stay refused with the documented `plugin_unavailable` text — record these as known refused rows, not failures;
   - I1 from the PR 4 re-review: whether a `_run` runner process inherits `PACER_HOST_SOCKET` flag-on (`src/tasks/api.ts:151-160`, `crates/lifecycle/src/run_spawn.rs:200`, `crates/server/src/serve/mod.rs:755-761`). Assert what happens and report it; changing it touches the socket boundary, so do not fix it here.
2. **Stdio rows.** The same consumer ops on a flag-on stdio front door, both self-owning and attached to a live serve owner, compared with flag-off.
3. **Conformance subset against the native owner (`test/plugin-conformance-native-owner.test.ts`, new).** Run a representative subset of `conformance/` CASES — serialisation and reentrancy, fs read/write transfers, process, http, events subscription bootstrap — against a flag-on HTTP front door and a stdio owner door with fixture plugins. Keep the full CASES list on the TypeScript host. Add a front-door host option to `conformance/run.ts` only if needed.
4. **Extend the P4d-1 flag-on set** (`test/native-plugin-ops.test.ts`, the flag-on block near the default-serve tests) with the matrix ops where it fits better than the new file.
5. **Fixes** for divergences outside the security boundary list above land here, each with a test that fails without it. Keep fixes small; if one grows past ~150 changed lines, stop and report.
6. **Docs (REPO-7):** ledger rows 22–24 and the PR 7 gate status (green, or the exact red rows), CHANGELOG Unreleased only if user-visible behavior changes, live-validation docs if you add a harness scenario.

Out of scope: the default-on flip (PR 7); the PR 5 re-review's R1–R3 concurrency follow-ups (tracked for before PR 7); bridge caller authentication (#918); real-key endpoints, direct-executor spawn admission and SSH host runners (plan §3 rows 6–8).

## Test rules

Temp homes (short `/tmp` homes where sockets are involved), no fixed ports, fixture plugins and fake providers only, no network. Both front doors are needed or the parity tests skip: build `cargo build --locked -p pacer` and `cargo build --locked -p pacer --features test-ops`, copy each binary to a temp dir, and point `PACER_TEST_FRONT_DOOR` and `PACER_TEST_NATIVE_FRONT_DOOR` at the copies. Report the number of matrix cases that actually ran. Show each fix's test red before the fix. Known flakes you may meet: `plugins-native-owner-call` "planner configuration generation changes mid-call" under load, `native-msg-writes-parity`, "pending final checks reserve overlapping checkouts", the account wizard — rerun once and say so.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. `bun run typecheck`; the new tests plus `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-crash.test.ts` (if present), `test/plugin-conformance.test.ts`, `test/native-dispatch.test.ts`, doctor and setup tests, `test/live-harness.test.ts`; if you touch Rust: `cargo fmt --all --check`, clippy `-D warnings` and tests for each touched crate, `cargo xtask loc --check`, `cargo xtask deps`; `git diff --check`. Save logs under `.work/fixtures/wave3-pr6/` in this worktree.

## Live validation (CT-11)

The full front-door live run with the native plugin host on, on a `--front-door rust --native-plugin-host` sandbox (see `docs/testing/live-validation.md` and the `native-plugin-owner`/`native-plugin-stdio` scenarios): CLI `pacer doctor`, `pacer limits`, setup-adjacent flows, HTTP and stdio, web Diagnostics (remedies) and Settings › Plugins, plugin UI render and action. Then the same flows on a flag-off sandbox for comparison, and confirm `PACER_NATIVE_PLUGIN_HOST=0` restores TypeScript ownership. Real accounts, real delegation, real Orca and desktop stay UNVERIFIED per the existing exceptions. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes, sockets or sidecars remain.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`.

## Commits

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>), small logical commits. Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files.

## Output

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md`: commits; the matrix as a table (row, HTTP flag-on, stdio self-owned, stdio attached, verdict: identical / known refused / divergent, with evidence); divergences found and whether fixed here or routed out (with the reproducing test); I1 result; conformance subset results; the PR 7 gate status in one sentence; test counts with red evidence for fixes; live report summary with UNVERIFIED items; follow-ups; and a draft PR body following `.github/pull_request_template.md` (include the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave3-pr6.md exactly. End with orca orchestration worker_done.

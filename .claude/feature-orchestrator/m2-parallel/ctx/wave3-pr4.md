# Task: M2 wave 3 PR 4, carry endpoint launches and Orca attempts over the native owner bridge

Executor: cursor-agent (default model, frontier tier). Security-sensitive: what crosses the sealed owner bridge (credential bindings, Orca attempt and live-control authority). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr4, branch `feat/owner-bridge-endpoint-orca`, based on wave 3 PR 1 (#917, branch `refactor/plugin-capabilities-crate`, head `74b5240d5`), which extracts `pacer-plugin-capabilities` and moves `pacer-plugin-runtime` to layer 6. PR 3 (the #629 ports, including the Orca code-point bounds) is already on main as #907. #917 is reviewed and in CI; if it changes, the coordinator rebases you. Not pushed.

Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md. Read the header (maintainer decisions: OD-3 allow empty credential-binding lists across the bridge and keep non-empty lists refused; OD-4 carry `orcaAttempt` in this PR and leave `orcaLive` for #889 unless this PR's budget holds), sections 0–2 (ground truth, gaps G1–G8), and section 5 "PR 4". The plan was measured at `acab1eca4`; since then #907 and #917 moved code, so re-read every cited line at this base.

Before working, read `.agents/skills/project-governance/SKILL.md`, `.project/constitution.md`, `.project/context.md`, and `.project/rules/{security,rust,rust-crates,api-protocol,code-and-testing,repository}.md`, `.project/reviewers/{security,protocol-compat,qa}.md`, `docs/testing/live-validation.md`, `docs/decisions/0026-*.md`.

## Scope

- `src/plugins/registry.ts` (`callNativeOwner` and the refusal at the credential-binding check): allow an **empty** `credentialBindings` list over the bridge; any non-empty list keeps refusing with the current error (OD-3). Nothing secret may cross the bridge.
- Carry `orcaAttempt` in the sealed call authority so Orca executor attempt runs work through the native owner (`src/plugins/executor-orca.ts`; owner side already has `bind_process_owner_orca`, `orca_context_from_value`, `OrcaCallContext` and the test `process_owner_answers_orca_prepare_when_core_seals_attempt`; confirm at this base). Drop the no-op `onProgress: () => {}` in the attempt call so host-only options stay empty. Per OD-4, `orcaLive` (live control: stop and inspect) stays refused unless it fits this PR's budget with its own tests; decide by measuring, record the decision, and if deferred keep the refusal text unchanged and note #889.
- `src/plugins/host-bridge.ts`, `src/plugins/endpoint-adapter.ts` (call shape only), `crates/plugin-runtime/src/capability.rs` if envelope validation changes.
- Ledger and CHANGELOG for the flag-on behavior change (flag-off unchanged). CRATE-1 budgets per the plan (runtime ≤ 4,500 per ADR 0026).

## Tests

Extend `test/plugins-native-owner-call.test.ts` and add flag-on front-door cases, per the plan's PR 4 list: `endpoint.launchEnv` with empty bindings over the bridge returns launch settings with exact env/secretEnv validation parity against flag-off; non-empty credential references still refuse (`plugin_unavailable`); `executor.run` Orca attempt through the owner with a fixture `pacer-exec-orca` peer (fake Orca): the sealed `orcaAttempt` matches task id, attempt, provider and session, and output is byte-identical to flag-off; an attempt call past its deadline fails without publishing; if `orcaLive` lands, stop and inspect through the owner. Rust tests for any envelope validation change. Red evidence by mutation for the empty-only rule (a non-empty list must not pass) and the attempt sealing (a mismatched task id or provider must refuse); logs under `.work/fixtures/wave3-pr4/` in this worktree.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH` (it has the `ps` shim). Run `bun install --frozen-lockfile` first if `node_modules` is missing (outside the deny sandbox only if it needs the network). One cargo command at a time; debug only; no release builds. Another Rust worker runs at the same time; keep memory use modest.

`cargo fmt --all --check`; clippy `-D warnings` and `cargo test` on `pacer-plugin-runtime`, `pacer-plugin-capabilities`, `pacer-plugin-host`; `cargo xtask loc --check`, `deps`; `bun run typecheck`; the touched and neighbouring Bun tests (`test/plugins-native-owner-call.test.ts`, `test/native-plugin-ops.test.ts`, endpoint and Orca executor tests); `git diff --check`.

## CT-11

Per the plan: a sandbox task delegated to an `opencode#` endpoint runner with a fake key from a `file:` source (SEC-2), through a flag-on (`PACER_NATIVE_PLUGIN_HOST=1`) sandbox serve; show the launch goes through the owner bridge (trace or core log) and matches flag-off. Real Orca is UNVERIFIED (the live guard refuses `orca`); rely on the fixture parity and say so. HTTP and stdio `plugin.*` regression. Temporary sandboxes only (`bun run live up ...` with a temp `PACER_HOME`), never ports 4317, 11434, 1234, 41343, no real model or provider endpoints. Tear everything down and confirm no processes remain.

Commits: Conventional Commits (`feat(plugin-runtime): ...`), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve` or its launchd label.

## Handoff

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-handoff.md`: commits; per-file changes; exactly what crosses the bridge before and after (fields, who seals them, who checks them); the `orcaLive` decision with measurements; tests, red evidence and checks with counts; CRATE-1 numbers; CT-11 summary per surface; deviations; open questions; draft PR text following `.github/pull_request_template.md`. Report with `orca orchestration worker_done`. Always end with worker_done.

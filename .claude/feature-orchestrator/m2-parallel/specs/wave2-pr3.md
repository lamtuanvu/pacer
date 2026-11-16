# Task: M2 wave 2 PR 3 — register host repo setup with consent refusals and the effects bridge (Rust)

Executor: cursor-agent (default model). Security-sensitive Rust routing: a consent-gated remote clone and identity write over the sealed host-effects bridge; frontier tier. No time limit; finish implementation, tests, live validation where possible, and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr3, branch `feat/native-host-repo-setup`, from `origin/main` `077e4fb23` (wave 2 PR 1 #893 and PR 2 #913 merged). Run `bun install --frozen-lockfile` first. Build only the crates you touch (`cargo test -p ...`, one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); build the debug `pacer` binaries once for the differential and live run; never run release or `--workspace` builds. Another Rust worker runs at the same time; keep memory use modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md` in full, especially §1–§3, "PR 3", §5, §6 and §7. The maintainer accepted all eight recommendations (Q1–Q8). PR 2's handoff and reviews are in /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr2/.work/reviews/ (`wave2-pr2-handoff.md` and the review files; read, do not edit that worktree). Follow PR 2's patterns (`host_check_clean_setup_ops.rs`, `needs_host_effects`, host-effects futures in `serve/mod.rs`, stdio refusals with admitted calls forwarded, `test/native-host-check-clean-parity.test.ts`). Recheck every cited file:line; the plan was written before PR 2 landed.

## Scope (PR 3 only)

Exactly the plan's "PR 3" section: the `host.repo.setup` arm in `crates/config-ops/src/host_check_clean_setup_ops.rs` (`consent` must be literal `true`, refused natively otherwise with the TypeScript error body; unknown alias, canonical-key and repo-not-mapped refusals native; admitted → whole-operation bridge kind `host.repo.setup`); register it in `crates/server/src/native.rs` (OPS, predicate, dispatch), `serve/mod.rs`, `stdio_proxy.rs` the same way PR 2 did; add `host.repo.setup` to the pinned native op list in `test/native-dispatch.test.ts`; the ledger row 15 and totals per §5 (check whether PR 2 already moved the totals as the plan says, and make them consistent); a CHANGELOG line folded into the existing front-door bullet in the `Unreleased` section (do not add a second bullet). Do not change the live harness (D8 and D3 keep refusing `host.repo.setup`; do not amend them).

## Tests

`test/native-host-setup-parity.test.ts` per the plan (PR 2's pattern: test-ops front door, fake ssh `test/fixtures/bin/ssh` + `PACER_FAKE_HOST_HOME`, `PACER_FORWARD_OPS` comparison, stdio and HTTP): consent missing / non-true → refused natively with no core trace and byte-identical to forwarded; unknown alias, canonical-key and repo-not-mapped refusals native; admitted setup native vs forwarded compares the cloned checkout in the fake host home, `git config --local user.name/email`, job file steps (Clone / Set identity / Check), `host-checks.json`, the "checkout already exists" skip and the identity-only variants; the consent-preview mismatch (`capability_denied: configured clone changed after consent`) passes through byte-identically; enforcement token refused natively and work-grant caller forwards, as for PR 2. Every new test must fail without its fix (show red evidence for the consent and refusal arms at least). Temp homes, no fixed ports.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, and `env -u PACER_TEST_NATIVE_FRONT_DOOR` unless you set it to your own build: `cargo fmt --all --check`, clippy `-D warnings` and tests for `pacer-config-ops`, `pacer-core-bridge`, `pacer-server`; `cargo xtask loc --check` (restate the CRATE-1 paragraph for `pacer-config-ops` and `pacer-server`); `cargo xtask deps`; `bun run typecheck`; the new parity test, `test/native-dispatch.test.ts` and `test/native-host-check-clean-parity.test.ts` with `PACER_TEST_NATIVE_FRONT_DOOR` pointing at your `cargo build -p pacer --features test-ops` binary copied to a temp dir (see `.github/workflows/ci.yml` "Build production and native dispatch test front doors"); existing host tests (`rg -l "host\.repo\.setup|host setup" test`); `git diff --check`. Process-group kill tests in `test/remote*` fail inside `sbx-deny` for sandbox reasons; if you run them, run them outside it with a disposable HOME.

## Live validation (CT-11)

Wave 2 PR 4's fake-ssh live fixture (#912) may or may not be on `main` when you start; use it if present. Per the plan §6: `host.repo.setup` op-level live is UNVERIFIED (D8 refuses it at the proxy, D3 refuses CLI `host setup`); record those refusals as the guard working on a `--front-door rust --native-test-ops` sandbox, exercise the native refusals (missing consent, unknown alias) through stdio on the sandbox, and cite the e2e differential as the op-level evidence. Stop every session (`live down --keep`) and confirm no processes remain.

Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`). Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never contact a real SSH host.

## Handoff

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave2-pr3-handoff.md`: commits, what changed per file, routing table (native vs forwarded per caller and params), consent, sealing and enforcement evidence, test results with counts and red evidence, LOC and the CRATE-1 text, live report summaries and UNVERIFIED items, and a draft PR body following `.github/pull_request_template.md`. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave2-pr3.md exactly. End with orca orchestration worker_done.

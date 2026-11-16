# Task: wave 1 PR 4 fix round 1 — review findings N1-N4 and P1-P3

Executor: cursor-agent (default model). You implemented this branch (or continue its work). No time limit; finish fixes, checks, affected live validation and the handoff update before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr4, branch `fix/native-config-set-planner-backend`, head `3d10b9c33`. Existing `target/` (debug). A shared sccache server is running; don't stop it. Disk is tight (about 15 GB free) and the machine is under heavy load: build debug only, no release builds, no extra target dirs.

Read: the independent review `.work/reviews/wave1-pr4-review.md` (verdict PASS; findings table), your handoff `.work/reviews/wave1-pr4-handoff.md`, and the original brief /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave1-pr4.md (rules, checks, safety constraints all still apply).

## Coordinator decisions

Fix all of these in this PR:

1. **N1:** if the planner changes between the predicate and the native handler, don't return `unavailable` "planner requires the forwarded config.set operation". Reply as TypeScript does for a strategy that changed during the edit (`conflict`, "Strategy changed during edit", hint "Refresh and retry." — confirm the exact TS text in `src/core/config.ts` / the strategy writer). Add a unit test that forces the race.
2. **N2:** add one sentence to ledger row 10 (or the config boundary section): the in-flight guard is per front-door process and does not span native and forwarded edits; each side's file-changed check still prevents silent overwrites.
3. **N3:** add a committed corpus or differential case for `planner account not found` (legacy `providers: {claude-code: {}}`, planner → `codex`, `install`), checking stdio and HTTP parity.
4. **N4:** in the handoff's PR-description text, call out the D3 change explicitly for maintainer acknowledgment (what changed and why it is safe).
5. **P1 (safety):** D3 (`scripts/live/guard.ts`) must refuse `config set planner …` from the guarded CLI, because the TS CLI always calls `config.set` with `integrations: "install"` in-process (`src/commands/config.ts`), bypassing D8, and an unseeded session does not sandbox `HOME`, `CODEX_HOME` or `CLAUDE_CONFIG_DIR`. Use the same exit-3 named-rule refusal style as the other D3 rules. Cover argument variants (`config set planner=x` if the CLI accepts it, extra flags, `--` separators, `pacer -- config set planner`). Add tests in `test/live-api-guard.test.ts` or `test/live-harness.test.ts`, and update the D3/D8 text in `docs/testing/live-validation.md`.
6. **P2 (maintainer decision Q9):** add `config.set` to the HTTP front door's undecodable-body forward (`forwards_undecodable_body` or equivalent in `crates/server/src/serve/mod.rs`), so a body serde rejects (BOM prefix, lone surrogate) goes to TypeScript as stdio already does. Differential test over HTTP for both examples (reply and `strategy.yaml` bytes), and a ledger note.
7. **P3 (hardening):** in `scripts/live/proxy.ts`, refuse (403, same D8 shape and evidence note) any `/v2/ops/` or `/v3/ops/` request whose path is not exactly `/v[23]/ops/<registered op name>` (trailing slash, percent-encoding, double slashes, unknown names). Make sure legitimate requests the harness, web app and CLI send still pass (check `test/live-harness.test.ts` and run the harness tests). Add tests.

Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. Keep crate growth minimal (CRATE-1: `pacer-config` 8,107 and `pacer-server` 8,195 are over the warning line); record LOC after.

## Checks

As in the original brief, serial in sbx-deny with disposable HOME and PACER_HOME: `cargo fmt --check`, `cargo clippy -p <touched crates> --all-targets -- -D warnings`, `cargo test -p <touched crates>`, `cargo xtask loc --check` and deps, `bun run typecheck`, touched and harness Bun tests, `git diff --check origin/main..HEAD`.

## Live validation (CT-11)

Rerun only what the fixes affect, session ids `live-wave1-pr4-r1-`: with the Rust front door, show (a) D3 now refuses `pacer config set planner …` with exit 3, (b) D8 still allows planner+skip and refuses planner+install, (c) the D8 proxy refuses a malformed ops path, (d) an HTTP `config.set` with a BOM-prefixed body matches the TypeScript front door. Live stdio stays UNVERIFIED (D3). One live session at a time; stop everything you start.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never install or uninstall real planner integrations.

## Handoff

Append a "Fix round 1" section to `.work/reviews/wave1-pr4-handoff.md`: per finding, what changed and its test; check commands with pass counts; live session ids and Summary lines; updated LOC; updated PR-description text (CRATE-1 paragraph, D3 call-out). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and execute the task brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave1-pr4-r1.md. Always finish with orca orchestration worker_done.

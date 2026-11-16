# Task: rebase owner parity PR F (observation generations) onto main after PR A, then revalidate

Executor: cursor-agent (default model, frontier tier: a 26-commit rebase across the plugin runtime and the TypeScript call authority). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-f, branch `feat/owner-observation-generations`, head `abc791757` (backup branch `backup/parity-f-pre-main`). F was built on PR B's pre-merge head `693b1b182`. Since then `main` gained B (#940), C (#941, owner plugin stderr log), D (#942, key-order framing), E (#944, runners own their plugin children), A (#945, sealed owning-call authority in `src/plugins/native-call-authority.ts` and `registry.ts`, `bridge_call.rs`, `capability.rs`, `broker.rs`), and test-only fixes. Rebase with `git rebase --onto origin/main 693b1b182`. A trial rebase stops on the first commit (`1a7c1a46d`) in `crates/plugin-runtime/src/process/tests.rs`.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, ADR 0027, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and:
- F's review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-review.md (PASS at `abc791757`'s parent; findings N1–N8, n1, n2, P1). **N8 is required in this rebase**: carry `observationFingerprint` into A's `CallAuthorityOptions` (`native-call-authority.ts`) and into the `sealCallAuthority` spread in `registry.ts`; taking A's side drops it.
- F's handoff and PR body: `.work/reviews/parity-f-handoff.md`, `.work/reviews/parity-f-pr-body.md`.
- A's review and re-review (`parity-a-review.md`, `parity-a-rereview.md`) for what A changed.

## Rules for the rebase

- Resolve every conflict by keeping both sides' intent: main's code (B–E, A) plus F's observation-generation changes. Never drop a main change to make F apply. Where both sides add known-difference entries, tests, ledger rows or CHANGELOG bullets, keep both and check the result still reads correctly.
- After each conflicted commit, the tree must compile for the crates touched (`cargo check -p <crate>`); typecheck after any TypeScript conflict. Do not squash F's commits.
- ADR 0027: keep F's `abc791757` wording (between-call refusals; `config.get` sealed at the first call's hello) and A's text; remove any contradiction.
- If a conflict changes the security model or F's design, stop and ask through `orca orchestration`.

## Validate (on the rebased head)

Environment as in /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md ("Build and environment"; four Rust workers run at once, keep memory modest).

Required: `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-plugin-capabilities`, `pacer-server` (and any crate F touches); `cargo xtask loc --check`; `cargo xtask deps`; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugins-native-owner-matrix.test.ts`, `test/serve-plugin-native.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, the assistant-key e2e, F's observation tests, and a test proving N8 (an observation-bearing owning call keeps its fingerprint through A's sealed authority; red without the N8 change).

CT-11 (`bun run live`): rerun F's observation scenario with `--native-plugin-host` and flag-off, as in F's handoff; name the head.

## Output

Commit fixes with `git commit -s` (author Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-rebase-handoff.md: the new head, each conflict and how you resolved it, the N8 change and its test, validation results, CT-11 summary, and an updated PR body (`.work/reviews/parity-f-pr-body.md` content adjusted for the new base). Report with `orca orchestration worker_done`. Always end with worker_done.

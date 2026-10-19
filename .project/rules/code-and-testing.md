# TypeScript and testing rules

Applies to: `src/**`, `app/**`, `orca-plugin/**`, `scripts/**`, `test/**`. Rust code under `desktop/src-tauri/**` follows only CT-8.
Out of scope: generated files (`orca-plugin/dist/**`, `src/app/assets.generated.ts`, generated design-token files).
Owner: @lamtuanvu
Canonical sources: `tsconfig.json`, `app/tsconfig.json`, `package.json`, `bunfig.toml`, `test/setup.ts`, `.editorconfig`, [CONTRIBUTING.md](../../CONTRIBUTING.md), `.github/workflows/ci.yml`

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| CT-1 | TypeScript is `strict`. `bun run typecheck` (root and `app/`) passes. | Established | tsconfig.json; CI | `bun run typecheck` |
| CT-2 | Tests use `bun:test` in the flat `test/` dir, named `<area>-<topic>.test.ts(x)`. Fixtures go in `test/fixtures/` and use `$HOME` or temp dirs, never machine paths. | Established | Repo layout; AGENTS.md | Review |
| CT-3 | Run tests with `bun run test` (pinned TZ). Tests run with `HOME`/`PACER_HOME` isolated by `test/setup.ts` and must not touch the real user state. | Established | CONTRIBUTING.md; bunfig.toml | `bun run test` |
| CT-4 | Behavior changes and bug fixes come with tests covering the changed behavior. | Established | PR template ("How tested", tests pass) | Review |
| CT-5 | When an input changes, regenerate its generated artifact: `plugin:build` for `orca-plugin/`, `app:build` for `app/`, `protocol:doc` for the API. Freshness tests must pass. | Established | CONTRIBUTING.md; freshness tests | `bun run test` |
| CT-6 | Errors crossing the API are `CoreError`. Don't swallow failures silently. Surface them with a code and hint. | Established | `src/core/errors.ts` | Review |
| CT-7 | Formatting follows `.editorconfig` (2-space, LF, final newline). Match the readability of the surrounding code. Do not write new code in minified-dense style. | Established (editorconfig) / Proposed (density) | .editorconfig; observed drift | Review |
| CT-8 | Rust in `desktop/` passes `cargo test --offline`. | Established (manual workflow only) | desktop/README.md, desktop.yml | `cargo test --offline` |
| CT-9 | Adopt a TS linter and formatter (e.g. Biome) and add `cargo fmt --check`, `clippy` and `cargo test` to CI for `desktop/`. | Proposed | No lint config; Rust not in PR CI | Pending decision |
| CT-11 | A task that changes runtime behavior counts as done only after it passes live validation with the harness (`bun run live`, [docs/testing/live-validation.md](../../docs/testing/live-validation.md)). The run exercises the changed behavior on every affected surface (CLI/API, TUI, web/tray, Orca panel, desktop) with real executors where delegation is involved. It records the evidence in `.work/live/<id>/evidence/report.md` and summarizes it in the PR's "How tested" section. If a surface cannot be exercised, the task is reported as **UNVERIFIED**, not done. Docs-only, test-only and CI-only changes are exempt. | Established | Maintainer decision 2026-10-18; [harness spec](../../docs/specs/2026-10-18-live-validation-harness-design.md) | `evidence/report.md` with a verdict per changed behavior |
| CT-10 | Real-Orca e2e (`scripts/e2e/orca-bootstrap.ts`) stays outside `bun test`. It runs before plugin releases. | Established | docs/testing/orca-e2e.md | Manual |

Relevant reviewers: [qa](../reviewers/qa.md)
Exceptions and open decisions: CT-7 (density) and CT-9. CT-11 states the done criterion. The proposed constitution 0.4.0 amendment makes required UI/QA evidence, including applicable CT-11 reports, a pre-merge requirement for UI-affecting changes; other reviewer gates remain OD-6.

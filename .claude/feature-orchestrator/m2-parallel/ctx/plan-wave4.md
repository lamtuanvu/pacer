# Task: read-only plan for M2 wave 4 — usage and pacing

Executor: cursor-agent (default model, frontier tier: a multi-PR migration plan across Rust crates and the TypeScript core). Read-only: do not edit tracked files, build, run tests, commit or push. No subagents. You may run read-only commands (`rg`, `git log`, `git show`, `gh issue view`, `gh pr view`).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave4-plan (detached at `origin/main` `a62b42d60`).

## Scope

Wave 4 of M2 (from `docs/testing/m2-ledger.md` and the wave list in `.work/reviews/m2-waves-inventory.md` if present): **usage and pacing** — `limits.refresh`, routing (`routing.*`), models (`runner.models.*`, `executor.models.available`), and `dispatch.preview` / `dispatch.explain` / `dispatch.refresh` / `dispatch.enforcement*`. Size M/L; depends on wave 3 (the native plugin process owner and its consumers; owner default-on is PR 7 of wave 3, not yet merged). Confirm the exact op list from the ledger and `crates/server/src/native.rs` OPS, and say which ops are already native, partly native or forwarded.

Earlier waves deferred items to wave 4; collect them all:
- `.work/plans/2026-11-11-m2-wave1-repo-config.md`: the opencode `opencode models` cache miss for `runner.set` with `model` (runner-models bridge, `executor.models.available`), draft-aware status for `strategy.preview` (draft-aware `computeStatus`, status broker parts), and open question Q6 (runner model validation in `pacer-config-ops` vs a new `pacer-models` crate).
- `.work/plans/2026-11-11-m2-wave3-plugin-host.md` (line ~205): `runner.models.*` / `executor.models.available`, the `dispatch.preview/explain/refresh/enforcement` classifier deep dependency.
- `.work/plans/2026-11-11-m2-wave2-host-effects.md`: the passive Codex usage read / `cache/remote-usage/<account>.json` if it bears on `limits.refresh`.
- Any "M2 parity follow-up" issues touching usage, routing, models or dispatch (`gh issue list --label ...`; find the label name first).

## Follow the established plan format

Match the structure and rigor of `.work/plans/2026-11-11-m2-wave2-host-effects.md` and `.work/plans/2026-11-11-m2-wave1-repo-config.md`: the base commit; a ten-line summary; per-op inventory (TypeScript reference with file:line, current Rust state, effects, classification native / bridge / core-effect); the bridges each op needs and their sealing and deadlines (HTTP `/_internal/...` under the internal bearer token, stdio sealed `_internal.*`); what can port natively now vs after wave 3 PR 7; crate placement with CRATE-1 line counts (replicate the xtask counter by hand, ±2%), and a ruling on wave 1's Q6; a PR split with order, size, dependencies and the parity and live-validation evidence each PR needs (CT-11, with the live surfaces named); risks; and numbered open decisions for the maintainer, each with a recommended option.

Rules to load: `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,api-protocol,rust,rust-crates,code-and-testing,security,repository}.md`, ADRs under `docs/decisions/` that touch usage, routing, classification or models (for example 0002 idle usage adapters), and `docs/specs/` designs touching them. Cite rule IDs.

Note the parallel work in flight: wave 3 PRs A (#945, sealed owning-call authority), F (observation generations), I (detached stop/inspect), G (bridge caller auth), H (door relays plugin.doctor/ui to Core), R1 (owner hello cap), PR 7 (owner default-on). Flag any wave 4 PR that would conflict with them.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md. Do not commit it. Report with `orca orchestration worker_done`, summarizing the PR split and the open decisions. Always end with worker_done.

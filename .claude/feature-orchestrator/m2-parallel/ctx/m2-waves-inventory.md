# Task: M2 remaining-work inventory and stale-PR triage (read-only)

Model tier: Codex default (analysis only, no builds). Executor: codex. No time limit; finish the whole report.

## Context

Repository: lamtuanvu/pacer (public). Milestone M2 exit (docs/specs/2026-10-20-rust-host-migration-design.md section 2.1): the forward table is empty — every operation, route, CLI command and the TUI are native in Rust; plans 1-9 in that table.

The source of truth for current status is the integration branch checkout at
`.work/worktrees/m2-integration` (relative to this repo root; branch `m2/integration`, head 7a786ce95 = origin/main + 8 merged M2 branches). Read files there; DO NOT write, checkout, stash, build or run tests in that worktree (another worker is running cargo there).

Key files there:
- `docs/testing/m2-ledger.md` — per-operation status (Native / Selective / Forwarded / Forwarded (Rust-validated)), with definitions in its header. Totals: 229 catalog = 157 native + 72 forwarded; 83 selective.
- `crates/server/src/op_catalog.json` — the catalog.
- The design spec above, ADRs in `docs/decisions/`, `.project/decisions.md`, `.project/rules/` (CRATE-*, RUST-7 parity, CT-11 live, REPO-10 review).

## Hard constraints

- Read-only. No `cargo`, `bun test`, `bun run live`, no builds. Machine is memory-constrained.
- Never touch the real pacer install (`/Applications/pacer.app`, `~/.local/bin/pacer*`, `~/.pacer`, `com.pacer.serve`).
- Do not push, comment on, close or edit any PR or issue. `gh pr view/diff/list` reads are fine.
- Write only the report file below.

## Deliverable

Write `.work/reviews/m2-waves-inventory.md` (repo root of THIS checkout, not the integration worktree) with:

1. **Stale M2 PR triage** for open PRs #399, #400, #401, #403, #404, #578, #588, #629 (and any other open PR whose branch starts with `m2/` or `codex/m2-`). For each: title, what it makes native, whether the integration branch already contains equivalent behavior (cite file:line or ledger row), and a recommendation: `close-superseded` (cite the superseding code), `rebase-and-finish` (what is left), or `needs-maintainer`. Do not act on it.
2. **Remaining-work inventory**: every operation that is Forwarded, Forwarded (Rust-validated) or Selective at the integration head, grouped by design plan (2-9). For each group: op list, what TypeScript still owns (the ledger's reason), the blocker if any (missing bridge, vt100 gate, D3/D8 guard, desktop, plugin host, etc.), and an estimate S/M/L.
3. **Non-op M2 items** still TypeScript: routes (`/v3/snapshot`, `/v2`, `/app` auth, session WebSocket, MCP server `pacer mcp`), CLI commands not in clap, TUI dashboard. Cite evidence.
4. **Proposed wave order**: 6-12 slices, each sized for one reviewable PR (aim <1500 changed lines), dependency-ordered, unblocked first. For each slice: name, ops/surfaces, reference TypeScript files, Rust crate it lands in (respect CRATE-1 budgets; note crates already over budget: pacer-config, pacer-lifecycle, pacer-plugin-host), parity tests to add, live-validation surfaces, and risks. Mark slices that are blocked (e.g. sessions until native vt100 gate passes) separately.

Be precise; cite paths and ledger rows. When done, report the report path and a 10-line summary.

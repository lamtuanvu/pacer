# ADR 0030 — Account usage has one owner

Date: 2026-11-20

Status: Proposed. Accepted when the maintainer merges it.

Source: [account usage single owner design](../specs/2026-11-20-account-usage-single-owner-design.md).

## Context

[ADR 0002 (executor eligibility)](0002-executor-eligibility.md) reconciles timestamped evidence into one eligibility decision and says presentation does not decide permission from quota percentages. [ADR 0002 (idle usage)](0002-idle-usage-adapters.md) says the browser, CLI and service need the same account result. Neither named who owns the usage state that clients display, so two pipelines grew: the status pipeline, which merges evidence and limit marks, and the account list, which returns the raw provider reading. Clients then formatted each source themselves. The same account showed 100% and 0% on the same screen, and the account and executor rows of one status could report opposite verdicts.

## Decisions

1. **The status computation is the only producer of usage state.** It emits one `UsageState` record per account and per runner, with the figure, windows, active limit, observation time, freshness, verdict, eligibility, spend and error. No other code turns a provider reading into a displayed figure or verdict.
2. **Every operation returns that record.** `snapshot.get`, `account.list`, `limits.check`, `routing.status`, the hook text, `pacer status` and MCP read it from status. Raw provider readings are diagnostics only. Rust operations pass the record through and do not re-derive it.
3. **Account and runner records cannot contradict each other.** Execution facts keep their actual scope ([ADR 0002](0002-executor-eligibility.md)). The account record lists blocked runners and is EXHAUSTED when every runner is blocked by quota. Mode is the active hold, else the planner runner record's verdict, else `normal`, in every implementation.
4. **Missing data is a state.** Sources without a quota query report no windows. No reader invents a percentage or stamps a reading with the current time.
5. **Freshness rules live in one module.** Thresholds, lifetimes and cooldowns are defined once in `src/usage/freshness.ts` and shared with Rust through `cargo xtask gen` (RUST-5).
6. **The core owns the usage cache.** Last good readings and refresh outcomes persist in the pacer home, keyed by evidence identity, so a CLI process and the service see the same reading and a re-created account starts empty.
7. **One presentation function formats usage.** `usageView` in `src/view-model/usage.ts` produces every label, reset text, freshness text and tone. The Rust TUI and status line match it through golden tests.
8. **Disagreement is a test failure.** A cross-surface test checks that every operation and surface reports the same figure, verdict, reset and freshness for shared fixture states, and an import rule keeps clients off raw readings.

## Consequences

`account.list` gains `usage` and `diagnostics`. `usageReading` is deprecated for the rest of protocol 3.x and removed in 4.0 through the compat adapter (API-2); for reactive and unmetered accounts it no longer carries an invented window. The `usage.read` plugin protocol does not change. Account-level verdicts become stricter where runner limits were hidden before; routing, which already uses runner records, does not change. Mode can change from `normal` to a stricter mode when the planner runner is limited, which matches what the Rust read model already reported. The per-surface usage helpers in `app/` and `src/view-model/` are removed. New surfaces that show usage must call `usageView`.

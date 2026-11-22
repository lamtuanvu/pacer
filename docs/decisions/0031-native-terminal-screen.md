# ADR 0031 — Native terminal screen via an in-tree layer, not a stock crate

Date: 2026-11-22

Status: Proposed. Accepted when the maintainer merges it.

## Context

Session terminals still run on the TypeScript host while [ADR 0008 (built-in
terminal)](0008-built-in-terminal.md) and [ADR 0018 (keyboard/terminal
architecture)](0018-orca-terminal-worker-executor-extraction.md) push toward a
Rust screen. [M2 B5] installs a replay gate
(`scripts/replay-gate/`, schema 2) so a native engine can be accepted or
rejected on hard evidence instead of assumption. The gate's oracle is the
in-tree TypeScript `Screen` and xterm.js 6 UnicodeV6 widths.

The open question is which native emulator to target. Stock crates are
available (`vt100`, `alacritty_terminal`), but none is known to reproduce
xterm.js cell state, and the gate is the first way to measure that.

## Options considered

1. **Stock `vt100` crate.** Measured through the gate (isolated driver,
   `.work/fixtures/b5-replay/vt100`): **FAIL**. H1 (state) and H11 (plain
   text) fail on all 39 scripted streams; H5 (continuation, 7), H7 (query
   replies, 1), H9 (resize, 2) and H3 (pixel parity, 11) also fail. vt100's
   public API exposes only setters for scroll region and most modes, offers no
   Unicode width table, and its cell model diverges from xterm.js run
   structure. H8 only passes because the reference width table was injected.
2. **`alacritty_terminal` (0.26.0, crates.io).** Desk-checked NO-GO: no public
   Unicode width table matching xterm.js; width behavior is the documented
   reason for third-party width-fix forks.
3. **`wezterm-term`.** Desk-checked NO-GO: not published to crates.io (only
   third-party forks exist), so it cannot be a dependency — fails at Stage 0.
4. **In-tree `vte` (parse-events only).** Desk-checked NO-GO: parse events are
   not a terminal model; rebuilding cell state, width and query replies on top
   of `vte` is a full emulator with no reuse of xterm semantics.

## Decision

**Build an in-tree native terminal screen as a layer that (a) wraps `vt100`,
(b) is provably identical to the TS `Screen` on the replay gate, and (c) owns
the surface the stock crate withholds — Unicode width, scroll region, cursor and
mode flags, and query replies.** This is the B5 plan. No stock crate is
acceptable on measurement; the migration target must be an in-tree emulator
whose contract is: gate-match the reference, then replace it.

Rollout: accept the gate harness and this decision as proposed; land B5-2 (the
in-tree layer) behind the gate. The session WebSocket and offline replay stay on
the TypeScript host until a full native gate passes (parity with [M2 P7]).

## Consequences

- `scripts/replay-gate/` is the single acceptance instrument for the native
  screen. A candidate is accepted only on a full PASS (H1–H11), not on a
  subset.
- The in-tree layer must expose scroll region, cursor visibility, insert /
  origin / autowrap modes and a Unicode width table as first-class state
  (the mode scanner the spike needed is folded into the layer).
- Character width follows the committed **xterm.js 6 UnicodeV6 table, default
  renderer** (`test/fixtures/sessions/xterm-unicode-v6-widths.json`); any
  bump of the width reference is itself gated so the native screen and the TS
  host never disagree on width.
- vTwo stock-crate shortcuts (ii, iii) are closed on Stage-0 or measurement
  grounds and recorded here so they are not re-litigated without new evidence.
- `gate:m3 --report` counts are unchanged by this commit (harness added, no
  runtime behavior change) — the gate is instrumentation first, migration
  second.
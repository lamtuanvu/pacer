# Inactive dashboard frame port

`pacer-tui` renders loaded dashboard snapshots and UI state into a ratatui
`TestBackend`. No binary depends on it. It registers no native operation, opens
no terminal or service connection, executes no action, and writes no state.
The TypeScript dashboard remains the active implementation and reference.

The shared corpus in `test/fixtures/dashboard-frame/` contains explicit inputs
and complete, untrimmed TypeScript frames. Rust renders the inputs independently
and compares every backend row with those goldens. The fixtures cover Home,
Needs you, Tasks/workspace, task details and threads, setup, all eleven settings
sections, CLI updates, every desktop update and service adoption phase, overlays,
resource failures, empty screens, selection, scrolling, scoping and connection
states. Standard views run at 60×16, 80×24, 120×40 and 160×50; boundary cases also
exercise undersized terminals, the 109/110-cell pane switch and the 160-cell
content cap. Every selectable baseline row gets a narrow and wide viewport.

This slice covers the fixed no-color, Unicode, non-animated theme with UTC times.
Goldens compare text and geometry, including selection markers and trailing
spaces; they do not certify ANSI colors, keyboard handling, terminal accessibility,
service mutations or desktop behavior. Those require validation before activation.
The backend uses the TS cell-width rules when painting and skips wide-character
continuation cells when serializing. ECMAScript number coercion, formatting,
rounding, whitespace, title fallback, UTC times and UTF-16 path lengths have
separate TS-produced reference fixtures. Radix coercion follows the reference
Bun runtime's intermediate floating-point rounding. Path tests compare the
original UTF-16 code units, including slices through surrogate pairs; frame
goldens compare terminal UTF-8, where isolated surrogate halves become `�`.

Run the checks from the repository root:

```sh
bun run test test/dashboard-frame-parity.test.ts
cargo test -p pacer-tui --locked
```

To intentionally refresh references after a TypeScript renderer change:

```sh
bun test/fixtures/dashboard-frame/generate.ts
```

Tests check reference freshness and never regenerate their own expected output.
The Rust implementation never reads the golden output at runtime.

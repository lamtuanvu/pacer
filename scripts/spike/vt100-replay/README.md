# vt100 session replay spike

Preparation for M2-07 Task 1 only. Sessions remain forwarded. This harness does not activate a Rust session implementation, change production dependencies, or satisfy the session cutover gate.

The committed corpus contains 24 deterministic synthetic UTF-8 terminal streams at 120 columns × 40 rows. It includes prompts, carriage-return redraw, cursor addressing/save/restore, erase/insert/delete, ANSI/palette/RGB colors, attributes, CJK, combining marks, emoji/ZWJ, wrapping, scrollback, scroll regions/origin mode, alternate buffers, hidden cursors, application keypad/cursor, bracketed paste, focus reporting, mouse tracking and full-screen redraw. Repeating byte chunk sizes `1,2,3,5,8,13` deliberately split escape sequences and multibyte characters. No personal session, account, executor or credential output is included.

The reference imports the actual `src/session/screen.ts`, whose checkpoint uses xterm headless plus SerializeAddon. It checks the checkpoint against the original source terminal, including every buffered cell's text/width/colors/attributes/wrap bit, cursor, viewport, active buffer and public modes. A separately compiled Rust adapter processes the same bytes with vt100, exports formatted contents plus cursor/attributes/input modes and explicit alternate-buffer selection, and supplies replay payloads. Candidate engine/version fields are descriptive; they are not evidence that native code executed. Keep the compiler invocation, adapter and scratch Cargo lock with the run evidence.

Chromium renders the reference checkpoint and Rust replay into fresh xterm.js instances with identical 120×40 geometry, font, DPR 1, focus and disabled cursor blinking. Terminal screenshots are decoded to RGBA in Chromium and compared by dimensions and SHA-256. Every mismatch retains both PNGs. This uses xterm's installed default renderer; it does **not** validate a separately installed canvas/WebGL addon. Browser availability errors remain UNVERIFIED. The state check additionally catches nonvisual mode/history differences that a single screenshot misses.

## Reproduce

Run from the checkout root with existing Bun dependencies and a Playwright-compatible Chromium installed. `VT100_SPIKE_CHROMIUM` can select an explicit executable; otherwise Playwright uses its installed browser cache. The browser uses a fresh context and no user browser profile.

```sh
bun test scripts/spike/vt100-replay
mkdir -p .work/fixtures/vt100-replay
bun scripts/spike/vt100-replay/run.ts --rust-input > .work/fixtures/vt100-replay/input.json
```

For the actual native experiment, create a disposable crate outside the production workspace:

```sh
mkdir -p .work/fixtures/vt100-replay/rust-current/src
cp scripts/spike/vt100-replay/vt100.rs .work/fixtures/vt100-replay/rust-current/src/main.rs
cat > .work/fixtures/vt100-replay/rust-current/Cargo.toml <<'TOML'
[package]
name = "pacer-vt100-replay-spike"
version = "0.0.0"
edition = "2021"
publish = false
[workspace]
[dependencies]
vt100 = "=0.18.1"
serde_json = "1"
base64 = "0.22"
TOML
cargo run --quiet --manifest-path .work/fixtures/vt100-replay/rust-current/Cargo.toml < .work/fixtures/vt100-replay/input.json > .work/fixtures/vt100-replay/candidate-current.json
bun scripts/spike/vt100-replay/run.ts --candidate .work/fixtures/vt100-replay/candidate-current.json --out .work/fixtures/vt100-replay/results
```

Scratch Cargo dependencies/lock/target stay untracked. No root Cargo file changes are needed. `--no-browser` runs state checks only. Without `--candidate`, the harness checks the xterm oracle and browser determinism; it cannot establish vt100 parity. Exit codes: 0 PASS, 1 observed FAIL, 2 UNVERIFIED. Reports distinguish reference and native verdicts; a known state failure remains FAIL when browser evidence is unavailable.

The candidate JSON has schema 1, engine `vt100`, version, exact corpus file SHA-256, and exactly one `{id,replayBase64}` entry per stream. Missing/duplicate/unknown IDs, wrong digests and malformed base64 are rejected. The report also records reference source, adapter source and candidate file hashes.

## Observed results, 2026-10-22

Actual scratch Rust execution with vt100 **0.18.1** and Chromium **145.0.7632.6** failed. The preliminary 0.15.2 adapter had the same failure categories. This is an experiment against these explicit export adapters, not proof that every possible vt100-based implementation must fail.

| Stream | Native state mismatch | Reference-versus-native raster |
| --- | --- | --- |
| `insert-mode` | Insert mode lost; `cdef` overwritten instead of shifted after `XY` | Different |
| `attributes` | SGR 9 strikethrough lost | Different |
| `emoji` | Cursor X expected 12, replay 14 after ZWJ sequence | Different |
| `wrap-edge` | Row 1 wrapped flag lost at the wide-character boundary | Equal |
| `scrollback` | baseY/viewportY expected 26, replay 0; history omitted | Different |
| `scroll-region-origin` | Origin mode lost | Different |
| `input-modes` | Focus-reporting mode lost; keypad/cursor/paste/mouse retained | Equal |
| `wrap-disabled` | Autowrap restored as enabled; cursor `(120,0)` becomes `(5,1)` and text wraps | Different |
| `alternate-active` | Public cell state matches | Different: reference shows cursor; native hides it |
| `full-screen-redraw` | Public cell state matches | Different: reference shows cursor; native hides it |

Eight streams fail native state comparison, eight fail raster comparison, and ten distinct streams fail either check. The reference itself also fails the `scroll-region-origin` roundtrip: original cursor `(3,19)` becomes `(0,0)` after SerializeAddon restore. This is recorded independently; changing production behavior is outside this spike. Other self-checks passed. Four harness tests passed, including real browser negative controls for text/cursor/color/wide-character corruption, and candidate-format refusal controls. Strict scoped TypeScript checking passed.

Limits: the corpus is synthetic, not twenty real recorded executor sessions; no Claude/Codex sessions were captured. Canvas/WebGL renderer, other operating systems/fonts/browser versions, resize/reflow, full saved-buffer state, continuation after restore, private terminal internals, title/bell side effects and live session/delegation surfaces remain UNVERIFIED. No CT-11 live runtime claim is made. M2-07 Task 1 and M3-02 remain blocked by observed parity failures and missing required recorded-session/canvas evidence.

Applicable project context: constitution 0.8.0; ARCH-1/12 (no production host cutover), RUST-1/3/7 (safe argv/native parity), CRATE-4/5 (no production crate/dependency activation), SEC-1/2/5 (synthetic data/no credential reads/argv commands), CT-2/3/4/11 (isolated fixtures, meaningful negative controls, explicit live limits). QA and security reviewer definitions apply to eventual cutover review; this experiment is not an independent review or merge approval.

## Follow-up: distinguish exporters, parsers and the reference

`vt100-public.rs` is a second real native adapter using the same 0.18.1 scratch dependency. Copy it to the scratch crate's `src/main.rs`, rerun Cargo with the same input, then pass `--adapter scripts/spike/vt100-replay/vt100-public.rs` alongside `--candidate` to record the correct adapter source hash.

This variant uses `write_contents_formatted_basic(Full(...))`, converts its bare line feeds to raw-terminal CRLF, and restores cursor/attributes/modes afterward. That closes the scrollback mismatch with public APIs. It records unhandled CSI sequences and tracks focus reporting via the documented callback; that closes `input-modes`. These were exporter gaps, not evidence the core parser discarded scrollback or could not preserve a nonvisual mode through an adapter.

The harness now reports three comparisons separately: original xterm source versus its own checkpoint (`referenceRoundtrip`/`oraclePixels`), original source versus native replay (`nativeDifferences`/`sourcePixels`), and restored xterm checkpoint versus native replay (`checkpointDifferences`/`pixels`). A serializer defect is no longer presented as a native source-rendering failure. It still fails the strict checkpoint contract and is retained in evidence rather than normalized away.

Actual public-exporter run: six native source-state failures remain (`insert-mode`, `attributes`, `emoji`, `wrap-edge`, `scroll-region-origin`, `wrap-disabled`); four native source-raster failures remain (`insert-mode`, `attributes`, `emoji`, `wrap-disabled`). Three reference raster defects are independently observed (`scroll-region-origin`, `alternate-active`, `full-screen-redraw`). The two alternate-buffer native replays match the original hidden-cursor rendering: those initial raster failures were reference serializer artifacts. Origin-mode parsing retains the correct original cursor `(3,19)` internally, but public replay does not export the origin setting/region; xterm's checkpoint independently misplaces the cursor.

The callback evidence identifies unsupported `CSI 4 h`, SGR 9 and `CSI ? 7 l`; these require genuine drawing/attribute changes, not just replay suffixes. The wide-edge wrap policy intentionally differs from xterm in vt100 source, and the Unicode cursor difference is present in native parser state before export. A small fork/upstream patch feasibility experiment continues only under untracked `.work/` and does not activate production code. Native cutover remains blocked.

## Reference-oracle investigation, 2026-10-24

Reproduced at the isolated preparation base with the unchanged production `Screen`
checkpoint, native vt100 0.18.1 public adapter, and Chrome 155. The observed six
native source-state failures and four source-raster failures remain exactly those
listed above. No production dependency, session host or forwarding route changed.

The state oracle now observes DECTCEM through xterm's public parser callbacks,
returning `false` so normal parsing still runs. Cursor visibility is absent from
`term.modes`; previously a state-only run missed the two hidden-cursor checkpoint
defects. The actual reference now has **three state failures and three raster
failures**: `scroll-region-origin`, `alternate-active`, `full-screen-redraw`.

Two reference serializer causes are demonstrated by the installed addon source:
it emits DECOM after restoring the cursor, which homes it, and never serializes
DECTCEM. A **prospective, spike-only** export appends the observed scroll region,
DECOM-relative cursor placement and visibility restoration. Its separate
`prospectiveReference` report fields have zero state/raster failures across all
24 synthetic streams. The report hashes the spike reference implementation as
well as the actual production source. These diagnostic fields never participate
in the verdict: the unchanged actual checkpoint still fails the strict gate.
This is evidence for a later TypeScript serializer correction, not evidence that
production checkpoints were fixed or live-validated.

The prospective export is bounded to this corpus. It is not a complete terminal
serializer: resize/reflow, per-buffer saved margins, saved cursors, pending-wrap
continuation and arbitrary application output still require dedicated tests.
Actual production serializer correction and CT-11 live validation remain pending.

The existing vt100 APIs still do not establish a faithful exporter: callback
observations can preserve otherwise unhandled nonvisual modes, but cannot recover
cell state discarded by unsupported insert mode, SGR 9 or disabled autowrap.
The dependency explicitly uses a different wide-edge wrap policy, and the emoji
cursor difference already exists before export. Origin-region restoration is an
export gap; repairing only that gap cannot resolve the other five native state
failures. A dependency change or additional terminal model would require a
separate architecture proposal and validation; this spike makes neither change.

Applicable governance at this run: constitution 0.10.0 (established rules stay in
force while proposed amendments remain proposals), CT-1–4/11, REPO-1/3–5,
ARCH-1/9/12 and RUST-7. This is test-only preparation, exempt from CT-11 runtime
validation; all live session, CLI/API, web/tray and desktop cutover behavior remains
UNVERIFIED. M2-07 Task 1 and M3-02 stay blocked.

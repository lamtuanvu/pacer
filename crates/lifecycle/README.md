# pacer-lifecycle (P6e pure decisions)

Layer 6, with no runtime callers or native operation registrations. No runner,
supervisor, transport, plugin implementation, filesystem, process, clock or timer
code is imported. No state is written, so SEC-7 persistence remains the future
owner's responsibility (atomic exclusive temporary files, 0600/0700 modes).

The modules reproduce the current TypeScript source:

| Module | Reference | Decisions |
| --- | --- | --- |
| attention | `src/attention/{rules,store}.ts`, `src/core/task-attention.ts` | Rule precedence, retry supersession, sorting, raised times, dismiss/snooze lifecycle |
| clients | `src/clients/registry.ts` | Whole-file schema validation, register/heartbeat, retention, newest live notifier |
| jobs | `src/jobs/registry.ts` | Creation/deduplication, steps, cancellation, restart recovery, asynchronous handover completion, retention |
| hosts | `src/remote/hosts.ts`, `src/config/hosts.ts` | Probe facts/checks, setup consent, clone snapshot comparison, cleanup fate/result, summary state |
| notify | `src/notify/decide.ts` | Candidate deduplication, notification URLs, ledger retention, transition candidates |
| runner_check | `src/core/runner-check.ts`, `src/endpoints/state.ts` | CLI/sign-in/usage/test outcomes, native first-reading collection, sanitized check result |

Callers supply validated configuration/read-model snapshots, time in f64 seconds,
generated IDs, retry targets and effect outcomes. The JSON snapshots retain the TS
field spelling. Hosts and runner checks return the result plus the ordered step
transitions; they execute nothing. Clone snapshot comparison requires the actual
host fingerprint captured by the effectful owner. A cleanup outcome never grants
permission to delete anything. The eventual owner must recheck configuration,
consent, transfer proof, persisted task/attempt identity and plugin grants at the
effect boundary. Separate effect failures are supplied as failed probe/task results.

`JsText` stores UTF-16 units, including a lone surrogate produced by JS `slice`.
The serializer emits these units losslessly. Source JSON snapshots use Unicode
scalar strings; pass `JsText` directly when composing an item from existing UTF-16
text. JS number rendering uses ryu-js and JSON parsing enables round-trip floats.
Whitespace uses the ECMAScript set (BOM included, NEL excluded). Attention ordering
uses ICU root collation, matching the reference runtime's default English
collation in the goldens; a future locale-configurable service must supply its
collation contract before activating the port.

`examples/decisions.rs` and its helper are test adapters only. They simulate effect
results and never register operations. Runtime ownership, disk/lock protocols,
plugin calls, delivery, abort signaling, daemon observers, controllers, publication
and timers remain in TypeScript. All P6e operations continue to forward there.

Validation:

- `bun scripts/p6e-goldens.ts` regenerates `test/fixtures/p6e/goldens.json` from
  current TS source with in-memory effect boundaries; it imports no runner,
  supervisor or plugin implementation.
- `cargo test -p pacer-lifecycle --locked` runs the same goldens without Bun and
  exercises boundary/race transitions. The comparator preserves lone surrogates.
- `bun run test test/p6e-parity.test.ts` checks Rust output against the goldens and
  verifies their freshness against current TS source and fixture inputs.

CT-11 runtime coverage is **UNVERIFIED** under the 2026-11-01 unreachable-library
exception in `.project/decisions.md`. The first runtime cutover must exercise all
these behaviors through the live harness; this slice activates nothing.

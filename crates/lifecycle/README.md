# pacer-lifecycle

Layer 6. Task admission (brief validation, capacity, lineage, strategy, prepared
admission, queue drain and revision-checked mutation) alongside P6e attention,
client, job, host, notification and runner-check decisions. The first served lifecycle op is store-only `task.request_review`. P6b adds
`run_spawn` (`self_command`, `runner_log_path`, `build_run_spawn_plan`,
`RunSpawnOwner`, `validate_run_spawn_plan`) so drain launch hooks and future
native supervisors share the same `_run` argv/env/log contract as
`src/tasks/api.ts`; effectful spawn remains TypeScript-owned. P6c adds
store-only `record_review_verdict` (accept/reject SQLite fields matching
`taskReview` without labels or gates). P6d adds store-only `record_task_stop`
and `task_wait_settled` (matching `taskStop` store fields and the `taskWait`
poll exit predicate without drain, supervision or signals). Runner/_run-dependent
**operations** stay forwarded after P6d.

Admission uses `pacer-store` and `pacer-foundation` for transactional task state,
publication and mutation locks. Capacity characterization covers `slot_use`,
strategy-derived `slot_limit` / `queue_capacity_for` (TS `slotLimit` /
`queueCapacity`) and precomputed `queue_capacity` goldens. Machine-signal
collection stays outside this crate; callers pass an evaluated guard snapshot.
Its disposable `task_admission_probe` binary exercises the shared Bun/Rust
admission boundaries in tests.

The P6e modules import no runner, supervisor, transport, plugin implementation,
filesystem, process, clock or timer code. They write no state, so their SEC-7
persistence remains the future owner's responsibility (atomic exclusive temporary
files, 0600/0700 modes). They retain separate JS text helpers because admission
also parses arbitrary JSON containing unpaired UTF-16 units.

The P6e modules reproduce the current TypeScript source:

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
collation contract before activating the port. ICU is pinned to the same 2.4
release as `pacer-server`; the P6e goldens validate that collation contract.

`examples/decisions.rs` and its helper are test adapters only. They simulate effect
results and never register operations. Runtime ownership, disk/lock protocols,
plugin calls, delivery, abort signaling, daemon observers, controllers, publication
and timers remain in TypeScript. All P6e operations continue to forward there.

Validation:

- `bun scripts/p6e-goldens.ts` regenerates `test/fixtures/p6e/goldens.json` from
  current TS source with in-memory effect boundaries; it imports no runner,
  supervisor or plugin implementation.
- `cargo test -p pacer-lifecycle --locked` runs the same goldens without Bun and
  exercises P6e boundary/race transitions and admission regressions. The P6e
  comparator preserves lone surrogates; the admission cross-runtime suite also
  invokes Bun to check revisions, descendant budgets and slot contention.
- `bun run test test/p6e-parity.test.ts` checks Rust output against the goldens and
  verifies their freshness against current TS source and fixture inputs.

CT-11 runtime coverage is **UNVERIFIED** under the 2026-11-01 unreachable-library
exception in `.project/decisions.md`. The first runtime cutover must exercise all
these behaviors through the live harness; this slice activates nothing.

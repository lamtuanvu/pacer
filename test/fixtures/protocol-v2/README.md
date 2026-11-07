# v2 compatibility goldens

The original endpoint captures (`hello.json`, `snapshot.json`, task and event
files) retain the pre-upgrade contract. Do not replace them with current output.
`conversions.json` retains the initial pure-conversion cases, plus the removal of
v3-only params such as `notifier` on `client.heartbeat`.

`characterization.json` records the current TypeScript reference adapter without
changing runtime code. Both `test/v2-parity.test.ts` and
`crates/server/tests/v2_compat.rs` consume these exact expected values. Its cases
cover:

- Params: object guards, delegate dispatch removal, client capture removal,
  accepted validation and verdict precedence, and unchanged operations.
- Results: client registration, version, diff, task array/page/scalar shapes,
  task get/review wrappers, legacy task-list overrides and setup checks.
- Events: every excluded type, config area string coercion, cursor boundaries,
  explicit legacy events (including null), and desktop-update precedence.
- Snapshots: derived and legacy budgets, null planner, provider eligibility,
  account fallback, blocked/down reasons, ranking, strategies, setup remapping,
  attention filtering/sorting/actions, counts, alerts, service installation,
  console defaults, fixed/null/unlimited capacity and additive fields.
- Coercions: JavaScript whitespace and numeric syntax, radix rounding/overflow,
  fractional cursors/slots, Unicode detail preservation and locale collation.
- Discovery detection, legacy setup rows, complete hello visibility, and the
  full operation-schema projection (including property order).

Private JavaScript symbols are represented as a separate `legacy` field in the
fixture and explicit optional arguments in Rust. Absence and explicit null are
different cases. The Rust adapter is pure and unregistered; dispatch and transport
remain on the existing TypeScript fallback. No state persistence is introduced.

Regenerate only when intentionally accepting reference changes:

```sh
bun test/fixtures/protocol-v2/characterize.ts
bun run test test/v2-parity.test.ts test/api-v2-compat.test.ts
cargo test -p pacer-server --test v2_compat --locked
```

Numeric coercions that yield NaN are tested individually against a reference
rank: mixing NaN with ordered ranks produces a non-transitive comparator whose
ordering depends on the JavaScript engine's sorting implementation. Operation
result transformations consume the protocol's JSON wire shapes; arbitrary
JavaScript values and lone UTF-16 surrogates are outside those schemas.

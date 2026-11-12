# Config settings parity corpus

`order.json` records ECMAScript trim behavior for comma-separated pacing order.
`settings.json` records TypeScript core results for every setting key,
including invalid types, bounds, number formatting, UTF-16 length, terminal
quoting, previous values, sources, exact YAML bytes, diff and undo. Planner and
task backend cases may set `integrations` and `env` (`PACER_ROLE`,
`PACER_BACKEND`); they cover refusals, `skip` writes, an unchanged planner with
`install` and the `PACER_BACKEND` override hint. A changed planner with
`install` is not recorded because the TypeScript reference would install real
integrations.

The `base` YAML is shared by cases without `before`. Each case's `expected.keys`
is an index into `views`, which deduplicates complete config.get key/source maps.
An omitted `expected.after` means the input YAML must remain byte-identical.
`getError` records execution validation failures encountered by config.get.
Paths in results are normalized to `strategy.yaml`; tests use disposable homes.

Verify with:

```sh
bun run test test/config-settings-parity.test.ts
cargo test -p pacer-config --locked
```

Refresh deliberately from the TypeScript reference with:

```sh
UPDATE_CONFIG_SETTINGS=1 bun run test test/config-settings-parity.test.ts
```

The Rust helper tests separately assert host-field passthrough, backend environment
precedence, refusal of a changed planner install, private atomic writes and no-op edits.
Planner integrations, backend readiness, terminal detection and host accounts are
not performed by the Rust helpers; see the M2 forwarding ledger.

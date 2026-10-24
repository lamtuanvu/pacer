# Migration parity driver preparation

`parity-harness.ts` runs explicit reference and candidate argument vectors,
requires a successful protocol 3.0.0 hello, sends sequential correlated JSON-RPC requests, checks optional
success/error expectations, drains both processes at EOF, and compares their
complete copied fixture homes (including permissions, empty directories and
symlinks created by the peers). Fixture symlinks are refused recursively before
either child starts, so copied homes cannot refer back to shared fixture state. Each child gets an isolated HOME/PACER_HOME and a minimal environment;
provider credentials and host socket settings are not inherited. Temporary homes
are removed on success and failure. Request deadlines include stdin write/flush
and reply reads; shutdown deadlines include stdin EOF, exit and stdout drain.
Cleanup is bounded separately even when a descendant retains stdout.

JSON object ordering is immaterial; arrays and JSONL line ordering remain
significant. Other files are compared byte for byte. Responses and JSON state
retain timestamps, IDs, paths and error details exactly. This intentionally
conservative baseline may reject legitimate nondeterminism. A future port must
add explicit correlation-preserving mappings with negative controls before
relaxing comparisons. No default log or lock exclusions conceal persisted data.

The driver refuses any nonempty `native` requirement: the current host exposes
no trusted native execution evidence. Equal forwarded results cannot certify a
migration. There is no debug endpoint or production change in this preparation.
Unsolicited notifications are rejected rather than silently discarded; event
parity and native execution remain UNVERIFIED.

Run `bun run test test/parity-harness.test.ts`. An optional forwarding-only smoke
uses `PACER_TEST_FRONT_DOOR` and defaults to source TypeScript as reference.
`PACER_TEST_REFERENCE_CORE` can select a matching compiled companion instead;
record that distinction in evidence. Stale source/build versions correctly fail.
The always-enabled TypeScript smoke uses source on both sides and checks the
driver wiring, not cross-runtime parity. The controlled peer proves mismatch,
transport failure, timeout and native-gate detection independently of the host.

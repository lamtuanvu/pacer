# StrategyDoc byte oracle

These synthetic, sanitized fixtures record TypeScript `StrategyDoc` behavior for M2 plan 2's YAML spike. They contain example identities and paths only. No user config was read. At initial recording there were no strategy `.yaml` or `.yml` files under `test/fixtures`; the base strategy mirrors the structural cases in `test/config-edit.test.ts`.

Source baseline: `71bb689180e8e9066b6170623d4c9bfa4c69da7d`, `src/config/edit.ts` SHA-256 `f52c7b01f28f6158fd20d64fdcda42dd7aa9218d518ad0b4f84433519a9791d8`. Recorder: Bun 1.4.2 and the repository-locked `yaml` package. The source checksum describes the initial oracle, not a requirement to keep unrelated future HEADs fixed.

Run `bun scripts/golden/strategy-doc.ts` to regenerate `goldens.json`, inspect every output change, then run `bun scripts/golden/strategy-doc.ts --check`. `cases.json` is the input corpus; output records retain `before`, `op`, `path`, `value` when supplied, byte-exact `after`, optional normalized `getIn` result and exact errors. JSON escaping preserves CRLF and literal scalar newlines. `getIn` distinguishes absent values from null and serializes YAML nodes to JSON for cross-language reads. Editing comparisons must use `after` as text, never parse and normalize YAML.

## Call forms at the baseline

| Operation | Production callers / shape | Corpus |
| --- | --- | --- |
| `getIn` | core config, executor settings, runners, routing and endpoints inspect a scalar, map or sequence | present scalar/map, absent and null |
| `setIn` | config migration; core accounts/endpoints/runners/executor settings; plugin config; remote hosts; paths include numeric routing indices and missing nested parents | existing/new map keys, scalar/collection replacement, nested maps, empty maps, missing parents |
| `setScalar` | setup planner and migration of pacing/routing runner IDs | strings, numeric index, booleans, numbers, null, single/double/plain/block scalar styles |
| `setList` | migration, runners, routing, executor settings and endpoints append/reorder/filter runner IDs or replace routing objects | block/flow/padded flow, surviving comments and quotes, duplicates, empty/missing/non-list values, rule objects |
| `replaceNode` | migration clones the provider map; runners splice/filter routing nodes; routing restores surviving nodes after list resizing | cloned map mutation, sequence append/insert/remove, literal replacement node, flow-parent coercion, retained comments |
| `renameKey` | migration providers to accounts; routing default to executors and back | nested sequence mapping, quoted replacement key, collision/missing key refusals |
| `deleteIn` | endpoints remove obsolete keys; plugins revoke grants; remote hosts remove an alias; routing removes kinds | first/middle/last/sole flow keys, block keys/null values, absent keys, wrong-parent refusal |
| `addMappingEntry` | accounts, endpoint setup and runners add account/runner declarations | both sections, duplicate refusal |
| `removeMappingEntry` | accounts, runner removal and account rollback | both sections, last-entry empty-map rendering |

Comment, scalar quoting, collection style, insertion and deletion cases run against LF; six representative edit cases also run against CRLF. No-final-newline insertion and parser errors are recorded. Error cases leave `after` unchanged. `replaceNode.value` is a serializable recipe for constructing/cloning a YAML node (`yaml`, `append`, `insertAt`, `removeAt`, `setEntries`), rather than pretending a plain JSON object carries node comments or style. This is an editor operation corpus, not a full recording of every multi-edit handler transaction.

## What this proves

The tests replay the TypeScript implementation deterministically and compare it with reviewed outputs. Negative controls change a newline, comment, quote or flow padding and remove a case; comparison must reject each mutation. Explicit assertions prevent unexpected thrown errors from silently counting as successful edit cases.

No Rust emitter or source-span parser has been evaluated here. **Rust parity is UNVERIFIED for every class.** The goldens do not test YAML schema validation, atomic writes/locks, event publication, config operation dispatch or live surfaces. No config operation should become native based on this corpus alone: M2 plan 2's proposed native configuration/routing/runner/repository/host/strategy operations remain forwarded until the Rust implementation passes the byte corpus plus handler parity and live validation. Unsupported Rust classes must retain that forwarding; TypeScript output must not be changed to accommodate a candidate emitter.

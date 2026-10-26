# Strategy document source-span spike

M2 plan 2 requires byte-identical `StrategyDoc` edits before native config writers can be selected. The TypeScript byte oracle already contains 67 cases in `test/fixtures/strategy-doc/`, recorded by `scripts/golden/strategy-doc.ts`. This spike adds a Rust parser and emitter subset; it does not select any new native operation.

## Parser finding

The `saphyr-parser` 0.3.2 event stream gives scalar start and end markers for existing values. Those markers count Unicode characters, so the editor converts them to UTF-8 byte offsets before splicing source text. The probe covered block and flow mappings, a flow sequence, inline comments, CRLF and Unicode before an edited value. Plain scalar spans isolate the value. Quoted scalar spans can include the trailing comment; the editor recognizes only simple quoted source and narrows the range to its closing quote. Escaped/doubled source quotes remain unsupported.

Collection events are insufficient on their own for a general `StrategyDoc` port. A flow map's start span covers `{`, while its end span can include `}` and a following inline comment; block collection start and end events can have empty spans. The TypeScript editor uses node `range[1]` and `range[2]` separately when replacing and deleting collections. A full port must reconstruct those ranges and match the `yaml` emitter's quoting, indentation, flow padding and comments against all 67 goldens. A parser event span is not a drop-in replacement for that contract.

## Implemented subset

`pacer_config::doc::replace_existing_scalar` parses one YAML document, finds one existing scalar through string map keys and nonnegative sequence indices, and replaces only that scalar's source range. Its emitter accepts a conservative grammar: plain identifier or ordinary Unicode letter strings, three proven double-quoted plain-string cases, simple single/double-quoted source style, JavaScript-safe integers, short finite decimals, booleans and null. Complex quote escapes, block scalars, multiline strings, tags and aliases remain unsupported.

`pacer_config::doc::insert_missing_flow_scalar` adds a simple scalar key/value to either an empty `{}` or an unpadded flow map whose last value is a plain scalar. It checks the opening and closing delimiters and inserts before `}` without changing neighboring bytes. Padded maps, block maps and nested values remain unsupported. Both functions do no file I/O.

The functions match TypeScript `after` bytes for **15 of 26** `setIn`/`setScalar` cases (13 existing scalar edits plus `flow-insert` and `empty-flow-insert`). A corpus-wide selector test checks every selected existing-scalar case, and focused tests compare both flow insertions. Adversarial tests check quote escapes, padded maps and JavaScript-unsafe integers; a Unicode comment before the target does not corrupt UTF-8 offsets.

The remaining 11 `setIn`/`setScalar` classes, plus the other 41 oracle cases, are **UNVERIFIED in Rust**. They include block map insertion, nested maps, missing parents, multiline/block scalars, list edits, deletion, rename, `replaceNode`, comments on moved nodes and `getIn`. All configuration write operations remain with TypeScript until the editor covers every class they need and their validation, locks, activity and outbox behavior pass parity and live checks. No TypeScript behavior was changed for this spike.

## Next gate

Extend the emitter and node range model against the oracle, then port strategy load/validation/migration. A native write selector must reject unsupported document/edit shapes before taking the strategy lock and must repeat its compatibility check inside that lock. Only after byte and handler parity may Plan 2 writers move from the forward table.

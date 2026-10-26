# Strategy document source-span spike

M2 plan 2 requires byte-identical `StrategyDoc` edits before native config writers can be selected. The TypeScript byte oracle already contains 67 cases in `test/fixtures/strategy-doc/`, recorded by `scripts/golden/strategy-doc.ts`. This spike adds a Rust parser and emitter subset; it does not select any new native operation.

## Parser finding

The `saphyr-parser` 0.3.2 event stream gives scalar start and end markers for existing values. Those markers count Unicode characters, so the editor converts them to UTF-8 byte offsets before splicing source text. The probe covered block and flow mappings, a flow sequence, inline comments, CRLF and Unicode before an edited value. In these cases scalar spans isolate the value and leave neighboring comments and delimiters untouched.

Collection events are insufficient on their own for a general `StrategyDoc` port. A flow map's start span covers `{`, while its end span can include `}` and a following inline comment; block collection start and end events can have empty spans. The TypeScript editor uses node `range[1]` and `range[2]` separately when replacing and deleting collections. A full port must reconstruct those ranges and match the `yaml` emitter's quoting, indentation, flow padding and comments against all 67 goldens. A parser event span is not a drop-in replacement for that contract.

## Implemented subset

`pacer_config::doc::replace_existing_plain_scalar` parses one YAML document, finds one existing scalar through string map keys and nonnegative sequence indices, and replaces only that scalar's source range. It accepts an existing plain scalar and a conservative emitted value: a simple ASCII identifier string, JavaScript-safe integer, boolean or null. It rejects aliases, tags, missing or duplicate target keys, invalid YAML, quoted/block scalars, collection values, unsafe strings and other unsupported cases. It does no file I/O.

The function matches the TypeScript `after` bytes for six of the 26 `setIn`/`setScalar` corpus cases: `scalar-inline-comment`, `scalar-plain`, `scalar-boolean`, `scalar-null`, `set-index` and `crlf-scalar`. A corpus-wide selector test checks every selected `setIn`/`setScalar` case against the oracle. Separate tests prove unsupported classes return `None` and a Unicode comment before the target does not corrupt UTF-8 offsets.

The remaining 20 `setIn`/`setScalar` classes, plus the other 41 oracle cases, are **UNVERIFIED in Rust**. They include quoted and multiline scalars, floats, maps and sequences, insertion, deletion, rename, `replaceNode`, comments on moved nodes and `getIn`. All configuration write operations remain with TypeScript until the editor covers every class they need and their validation, locks, activity and outbox behavior pass parity and live checks. No TypeScript behavior was changed for this spike.

## Next gate

Extend the emitter and node range model against the oracle, then port strategy load/validation/migration. A native write selector must reject unsupported document/edit shapes before taking the strategy lock and must repeat its compatibility check inside that lock. Only after byte and handler parity may Plan 2 writers move from the forward table.

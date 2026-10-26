# M2 TypeScript coexistence ledger

Native operations retain their TypeScript handler where forced forwarding or the standalone `pacer-core` still requires it. This ledger names code kept during coexistence; the final sweep is M2 plan 9.

| Native operation | TypeScript code kept | Reason | Removal plan |
| --- | --- | --- | --- |
| `notifications.get` | `src/api/ops.ts` handler and `src/core/notify.ts` `getLevel` | `PACER_FORWARD_OPS` escape hatch, standalone core, internal TypeScript callers, and settings JSON with lone-surrogate escapes that Rust's JSON parser rejects | M2 plan 9, after the forward table is empty and that JSON compatibility case has a native reader |

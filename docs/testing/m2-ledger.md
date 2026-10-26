# M2 TypeScript coexistence ledger

Native operations retain their TypeScript handler where forced forwarding or the standalone `pacer-core` still requires it. This ledger names code kept during coexistence; the final sweep is M2 plan 9.

Both runtimes take the shared `orca/notifications.lock` around notification settings reads and writes. The lock protects the single settings file while v2 and cookie requests continue through the TypeScript core.

| Native operation | TypeScript code kept | Reason | Removal plan |
| --- | --- | --- | --- |
| `notifications.get` | `src/api/ops.ts` handler and `src/core/notify.ts` `getLevel` | `PACER_FORWARD_OPS` escape hatch, standalone core, internal TypeScript callers, and settings JSON with lone-surrogate escapes that Rust's JSON parser rejects | M2 plan 9, after the forward table is empty and that JSON compatibility case has a native reader |
| `notifications.set` | `src/api/ops.ts` handler, `src/core/notify.ts` `setLevel`, and the activity/outbox writers | `PACER_FORWARD_OPS` escape hatch, standalone core, cookie and v2 requests during coexistence, and settings JSON with lone-surrogate escapes, array-index object keys or numbers needing JavaScript serialization | M2 plan 9, after all public requests and event writers are native |

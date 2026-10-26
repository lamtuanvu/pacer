# M2 TypeScript coexistence ledger

Native operations retain their TypeScript handler where forced forwarding or the standalone `pacer-core` still requires it. This ledger names code kept during coexistence; the final sweep is M2 plan 9.

Both runtimes take the shared `orca/notifications.lock` around notification settings reads and writes. The lock protects the single settings file while v2 and cookie requests continue through the TypeScript core.

| Native operation | TypeScript code kept | Reason | Removal plan |
| --- | --- | --- | --- |
| `notifications.get` | `src/api/ops.ts` handler and `src/core/notify.ts` `getLevel` | `PACER_FORWARD_OPS` escape hatch, standalone core, internal TypeScript callers, and settings JSON with lone-surrogate escapes that Rust's JSON parser rejects | M2 plan 9, after the forward table is empty and that JSON compatibility case has a native reader |
| `notifications.set` | `src/api/ops.ts` handler, `src/core/notify.ts` `setLevel`, and the activity/outbox writers | `PACER_FORWARD_OPS` escape hatch, standalone core, cookie and v2 requests during coexistence, and settings JSON with lone-surrogate escapes, array-index object keys or numbers needing JavaScript serialization | M2 plan 9, after all public requests and event writers are native |
| `repo.remove` | `src/api/ops.ts` handler and `src/core/repos.ts` `removeRepo` | Forced forwarding, standalone core, cookie/v2 requests, and repository JSON requiring JavaScript parsing | M2 plan 9, after all repository reads and writes are native |
| `repo.add` | `src/api/ops.ts` handler and `src/core/repos.ts` `addRepo`/`resolveRepo` | Forced forwarding, standalone core, cookie/v2 requests, internal TypeScript callers, and unsupported registry JSON; native Git output has a conservative 64 KiB bound | M2 plan 9, after internal callers and repository JSON compatibility move |
| `routing.get` | `src/api/ops.ts` handler, `src/core/routing-config.ts` `get`, and `src/config/strategy.ts` loading | Forced forwarding, standalone core, cookie/v2 requests, and strategy YAML beyond the native read-only subset | M2 plan 9, after the full strategy loader and transports are native |
| `host.suggest` | `src/api/ops.ts` handler, `src/remote/hosts.ts` `suggest`, and `src/remote/ssh-config.ts` `sshAliases` | Forced forwarding, standalone core, cookie/v2 requests, advanced strategy/SSH config shapes, and globbed Includes | M2 plan 9, after the full strategy and SSH discovery behavior is native |

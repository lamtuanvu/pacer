# pacer TypeScript plugin SDK

`@pacer/plugin` is the plugin-side stdio runtime. This repository's Bun workspace
exports it from source; it is not a claim that an npm package is published.
`serve({ manifest, handlers })` handles the handshake and dispatches extension
methods. A handler receives `(params, host, signal)`. Use the handler's `host`
inside that call; do not retain it for background work after cancellation or return.
See the [wire protocol](../../docs/plugin-protocol.md) for canonical method schemas.

## Writing a usage reader

A manifest declares `contributes.usage.providers` and the capabilities it needs.
The host selects a contributing plugin and calls `usage.read`. Provider code
interprets data; `createUsageReaderIO(host)` performs host capability calls with
that handler's authority. It does not grant access merely because a path, store
name or command appears in plugin parameters.

This reusable handler connects a provider reader to the current SDK. Pass your
provider's async reader as `readProvider`, then register the result under
`handlers["usage.read"]`. The host validates the complete incoming method schema;
this local input view names only fields needed to construct `ReaderContext`.

```ts
import {
  createUsageReaderIO,
  type Handler,
  type ReaderContext,
  type UsageReading,
} from "@pacer/plugin";

type Input = { now: number; readOnly: boolean; resources?: ReaderContext["resources"] };

export function usageHandler(
  readProvider: (context: ReaderContext) => Promise<UsageReading>,
): Handler {
  return async (params, host, signal): Promise<UsageReading> => {
    const input = params as Input; // The host validates usage.read parameters.
    signal.throwIfAborted();
    const reading = await readProvider({
      io: createUsageReaderIO(host), now: input.now,
      readOnly: input.readOnly, resources: input.resources,
    });
    signal.throwIfAborted();
    return reading; // Preserve alternatives, evidence, spending and other fields.
  };
}
```

The callback returns the full `UsageReading`; do not rebuild it from only its
windows. Alternatives, evidence, availability, spending, errors and timestamps
must survive transport. See the actual bundled [entrypoint](../../plugins/pacer-usage/index.ts)
and [Claude reader](../../plugins/pacer-usage/claude.ts) for complete provider code.
The host retains aggregation, freshness/auth/exhausted marks, remote merging and
its public cache; reactive and unmetered accounts remain host fast paths.

### Reader I/O and state

- `read(path)` returns `{ text, mtime }` or `null`; `mtime` is Unix seconds.
  `stat`/`list` return `FileInfo` with `mtimeMs` in milliseconds, size, inode and
  device. Listing asks the host to scan the authorized tree and returns at most the
  newest 1,000 matching files.
- `range(path, offset, length, expectedInfo)` reads at most 256 KiB against the
  captured file identity. A disappeared file reports `ENOENT`; changed identity
  fails instead of accepting another file's bytes. Provider code decides its
  parsing/tail policy. Transport chunking does not impose a new total Claude-file
  limit; the bundled Codex reader retains its own 4,000,000-byte tail policy.
- `run(argv, timeoutMs)` uses only the exact host-issued executable/argv authority.
  It returns `RunResult`; it is not an arbitrary subprocess API. Bundled usage
  resources permit fixed read-only ArkCLI/OpenCode commands, not environment,
  working-directory or stdin overrides chosen by the plugin.
- `cachedFetch(key, ttlS, maxStaleS, fetcher, { now, refresh, readOnly })` uses a
  host-issued opaque cache key. Freshness uses the supplied observation clock;
  failed refresh may return a permitted stale value and error. `readOnly` avoids
  cache persistence. Keys are not filesystem paths.
- `cursors(storeId, version, validAggregate, action)` hydrates validated per-file
  cursors under a host-owned lease. Supply the provider's actual aggregate
  validator. Replace or delete cursor entries to mark changes; mutating a nested
  aggregate in place does not mark it dirty. The host serializes the global store,
  projects the current account root, preserves foreign roots, and owns persistence
  and dirty retries. A persistence failure does not discard a successfully
  interpreted reading. Do not hold a lease across unrelated work or nest a second
  cursor transaction in the callback.

Create a ReaderIO per handler and await each operation. Calls share one exclusive
capability window; an overlapping operation fails rather than queuing unlimited
work. Parent deadlines include startup, callbacks and rich-result assembly.
Cancellation revokes access; cleanup can outlast the public timeout and must
settle before host resources are reused. Negotiated result chunking preserves
large rich readings without enlarging the ordinary stdio line limit.

Use host-derived `resources.claudeFiles`/`resources.codexSessions`; do not discover
ambient homes, credentials or executables inside a reader. The host issues store
keys and command descriptors, so a new provider needing resources must first have
that host contract reviewed. Manifest declarations, grants and call descriptors
all apply. These checks are not an OS sandbox. Tests should inject ReaderIO for
pure parser cases and use the real SDK/host transport for authority, cancellation
and persistence behavior.

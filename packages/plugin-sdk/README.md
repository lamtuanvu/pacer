# pacer TypeScript plugin SDK

`@pacer/plugin` is the plugin-side stdio runtime. This repository's Bun workspace
exports it from source; it is not a claim that an npm package is published.
`serve({ manifest, handlers })` handles the handshake and dispatches extension
methods. A handler receives `(params, host, signal)`. Use the handler's `host`
inside that call; do not retain it for background work after cancellation or return.
See the [wire protocol](../../docs/plugin-protocol.md) for canonical method schemas.

## HTTP and secret references

Declare `net.http` with destination host scopes and, when needed, `secrets.resolve`.
Use the handler's client; it carries the owning call's captured grants and deadline:

```ts
const response = await host.http({
  url: "https://api.example.com/classify",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ state }),
  timeoutMs: 3000,
  authorization: { secretRef: "secrets:CLASSIFIER_KEY" },
});
if (response.status !== 200) throw new Error(`Classifier HTTP ${response.status}`);
const answer = JSON.parse(response.body);
```

`host.secrets.present(ref)` returns a boolean. The host resolves authorization
references and injects the key; the plugin never receives its value. HTTP redirects are refused. If an injected key appears
in response headers or body, the host refuses the entire response.

Request and response bodies are strings, each limited to 4 MiB of UTF8 bytes.
With mutually negotiated `httpBodyChunks`, the SDK transfers large encoded
bodies through owner-bound handles using chunks of at most 256 KiB of decoded
bytes. The existing 1 MiB cap applies to each complete encoded JSON-RPC envelope,
including metadata. A peer without that feature
refuses an oversized body rather than truncating it.

Concurrent `host.http` calls within one handler run as complete transactions in
sequence, including release and failure cleanup. Queue time consumes the original
owning deadline. HTTP timeouts must be positive integers at most 120,000 ms;
unsupported values are rejected without clamping. Cancellation also rejects
queued work before it emits capability requests. Raw `host.call` operations do
not gain that transaction queue and may return a conflict for occupied resources.

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

### Writing a notifier

A notifier contributes `notifier: { kinds: ["os"] }` and handles
`notifier.deliver` (plugin protocol 1.3). Its input is `{ key, title, body, url }`;
title and body are limited to 256 and 2048 characters. Return
`{ delivered: true }` only after successful delivery, otherwise
`{ delivered: false }`. The host tries enabled notifiers in ID order with a
five-second deadline, stopping on success. A registered client notifier takes
precedence. The host retains notification levels, retry policy and the delivery
ledger.

The bundled `pacer-notify` plugin receives the host platform through
`host.config()`. It requests `capability.process.spawn` with the fixed bare tool
`osascript` or `notify-send`, passing title and body as separate literal arguments.
The host resolves and pins the executable and grants only that message's exact
argument vector. Plugins cannot choose an executable path, shell script, working
directory or environment. Disabling `pacer-notify` removes its delivery path;
there is no built-in OS fallback.

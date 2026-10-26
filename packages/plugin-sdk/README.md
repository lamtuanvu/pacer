# pacer TypeScript plugin SDK

`@pacer/plugin` is the plugin-side stdio runtime. This repository's Bun workspace
exports it from source; it is not a claim that an npm package is published.
`serve({ manifest, handlers })` handles the handshake and dispatches extension
methods. A handler receives `(params, host, signal)`. Use the handler's `host`
inside that call; do not retain it for background work after cancellation or return.
See the [wire protocol](../../docs/plugin-protocol.md) for canonical method schemas.

## Task reads and event callbacks

The TypeScript runtime supports `tasks.read(id)`, `tasks.list({ states, limit })`,
`events.subscribe(types)` and `serve({ manifest, handlers, onEvent })` when both
peers negotiate protocol 1.5 `policyObservations`. Declare and obtain grants for
`tasks.read` and `events.subscribe`; callback `log` and `config` also retain their
existing declaration/grant checks. Task results use the public API projections,
with list default 100 and maximum 500, state filtering before the limit, and the
existing complete-frame bound. Work grants retain their task scope and expiry.

An initial subscription must run during an actual host-owned doctor
`diagnostic.ping` or `policy.before` call. With `onEvent`, the SDK subscribes to all
event types before replying to the first such call unless the handler already
subscribed to a selected set. Enabling a plugin only changes metadata; it does
not start a process or establish a subscription. A usage call cannot bootstrap
one. Old or nonnegotiating peers reject these helpers.

Subscription acknowledgement supplies a separate process-generation `readOwner`.
It survives the transient call's settlement and authorizes only task read/list
and subscription management. Each callback receives an isolated
`ObservationClient` with `tasks`, `events`, `log` and `config`; it has no generic
`call`, filesystem, process, HTTP, secret or install client. Do not retain a
handler's effect client for a callback. Disabling/removing the plugin, changing
its manifest/config/grants, stdout EOF or process exit revokes the read owner and
aborts pending callback reads. Global event subscriptions are refused under an
executor work grant.

Events use the canonical v3 API stream, starting at the current cursor without
replaying history, and do not require a public API subscriber. Requested types
are filtered, but `reset` is always delivered: discard incremental assumptions
and re-read the snapshot. Host delivery and SDK callback backlogs are bounded to
128 notifications and 256 KiB including active delivery. Overflow replaces
obsolete queued events with a bounded reset. Persistent blocked delivery/reset
ends the process or SDK lifecycle; recovery needs a fresh valid generation and
subscription. Callback exceptions are contained with a safe diagnostic.

This describes the TypeScript SDK. Rust SDK read-owner/task/event helpers are
not implemented; the standalone policy protocol crate supplies contracts only.

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

### Endpoint configuration and tests

The bundled `pacer-endpoints` plugin handles OpenAI-compatible model discovery,
OpenCode configuration rendering and the fixed endpoint test. The host keeps
account edits, key storage and endpoint state. Discovery inputs carry credential
references; returned launch settings separate plain `env` from `secretEnv`.
Rendering with a null selected account updates all managed providers without
requesting a credential, including an empty provider set after the last removal.

Protocol 1.4 adds `host.fs.write(path, text, 0o600)`, `mkdir(path)` and
`remove(path, recursive?)`. Declare `fs.write` scopes. Each operation also needs
an exact resource issued by the host for the current call; a manifest scope alone
is insufficient. Writes preserve unchanged contents and use private modes.
The SDK negotiates `fileWriteChunks` for requests that exceed one wire frame,
with a 4 MiB UTF-8 file limit and bounded chunks. Without the chunk feature, the SDK only attempts fitting inline writes; the
host must still implement and authorize `fs.write`. Oversized writes fail before
a file operation.

A host-issued process command may include an exact working directory and
an environment whose values are strings or `{ secretRef }`. Contextual commands
receive only that captured environment. Secret injection requires
`secrets.resolve`, an owner-bound reference and matching command authority.
Injected credential reflection is refused before stdout/stderr is returned.
Legacy commands without an issued context retain their existing environment
behavior. Bun's reserved `__proto__` environment entry is unsupported; endpoint
credential variable names use the `PACER_KEY_` prefix.

### Pure installation helpers

Import `@pacer/plugin/install` for managed text blocks, comment-preserving JSONC
edits, hook editing and compatible undo records. These helpers do not read or
write files. The host's existing uninstall path can consume their undo format.

`backupPath(path, now, occupied)` requires an explicit predicate describing
occupied backup names. It preserves collision suffixes and local-time naming;
it does not reserve a path or establish permission to write it. Installation
transactions, locking and recovery remain separate from these pure helpers.


### Planner preparation and host settlement

`preparePlannerInstall` and `PreparedPlannerBuilder` prepare integration files
and record notes using host-supplied reads and real command results. Call
`prepare()` to close and drain preparation. It returns data; it never commits
files or claims durability. `createPlannerIO(host, signal)` requires observed
file modes, checks ranged identity/mode consistency, and uses the negotiated
`plannerInstallTransactions` broker. A large prior record is a call-bound JSON
projection read with `readPlannerPrior`, not a manifest path.

The trusted host chooses install, uninstall, reconcile or preview purpose.
Only install/uninstall can admit new planner command intents; reconcile is
file-only, and preview/detection/check cannot acquire install effects. The host
captures immutable undo before a command starts, drains peer work, validates the
final plan and owns SDK journal settlement and recovery. The private compensation
budget is reserved before admitting undo work and retains the original exact
pins after peer cancellation. Native credential stores and host private state
are excluded from installation sources and destinations.

Manifest v1 and file-journal schema1 remain compatible. Recovery covers FILE
before-images; it does not promise durable restoration of arbitrary external CLI
state after a whole-host crash. Deliberate no-undo commands retain that limit.

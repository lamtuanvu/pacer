# ADR 0027 — One native plugin process owner per home

Date: 2026-11-12

Status: Proposed. Accepted when the maintainer merges it.

With the native plugin host on (`PACER_NATIVE_PLUGIN_HOST=1`), `pacer serve` runs a Rust
`ProcessOwner` that starts and supervises plugin children. It publishes that owner on
`$PACER_HOME/run/host.sock`, and passes the socket to its TypeScript Core child as
`PACER_HOST_SOCKET`. A Core with that variable set refuses to start plugin children itself
and sends every plugin call to the socket.

The stdio front door (`pacer api --stdio`) left plugin operations in TypeScript, with the
note "no second process owner". That note recorded the earlier per-connection design; it
was not a project rule. For M2 wave 3 the maintainer decided (OD-2) that the stdio front door
answers plugin operations natively and owns plugin children per connection. That decision
also requires a stdio owner to coexist with a serve owner on the same home without two owners
racing the same plugin children.

## Decision

A pacer home has at most one native plugin owner that other front doors attach to. A live
`run/host.sock` is that owner's lease.

1. **Only serve binds `run/host.sock`.** A live socket means an owner exists. A socket that
   refuses connections is stale and the next serve replaces it. The socket always stays in the
   home, and serve refuses a `host.sock` path longer than 103 bytes before it creates anything,
   so a home that deep cannot run a flag-on serve.
2. **A stdio connection decides once, before its Core child starts.** It probes
   `run/host.sock`. The run directory must be a real directory owned by the current user with
   no group or other access, the socket must be owned by the same user, and the process that
   accepts the connection must run as the same user (peer credentials).
3. **Live owner: the connection attaches.** Its Core child gets
   `PACER_HOST_SOCKET=<home>/run/host.sock`, and the door starts no children. The door still
   composes every public plugin operation natively (admission, epochs, manifest checks). Plugin
   calls go through a sealed `relay` kind on the private stdio channel: Core runs its existing
   sealed owner call against the serve owner. `plugin.disable` and `plugin.remove` stop a
   running child with one `_host.plugin.stop` frame on the owner socket, after checking the
   peer's user again.
4. **No live owner: the connection owns its children.** It starts a `ProcessOwner` and a
   bridge listener on its own `run/s<12-hex>.sock`, and its Core child gets that socket. Only
   same-user peers are served. When the connection ends, or the door receives SIGTERM, the door
   closes the listener, removes the socket and stops the children it started.
5. **A deep home's connection socket goes to a private per-user directory.** When
   `run/s<12-hex>.sock` would be longer than 103 bytes (the `sockaddr_un` limit on macOS; Linux
   allows 107), the connection binds in `<user dir>/pacer-<hash>/` instead. `<user dir>` is the
   operating system's private directory for the user: `confstr(_CS_DARWIN_USER_TEMP_DIR)` on
   macOS (read through `/usr/bin/getconf`, since the workspace forbids unsafe code) and
   `$XDG_RUNTIME_DIR` on Linux, never a shared `/tmp` name or `$TMPDIR`. `<hash>` is a 64-bit
   FNV-1a hash of the canonical home, so each home gets its own directory. The door checks
   `<user dir>` with `lstat`, creates `pacer-<hash>` with mode 0700 and checks it again: each
   must be a real directory, not a symlink, owned by the current user, with no group or other
   access. If there is no such directory or a check fails, the connection refuses to start
   and names `PACER_NATIVE_PLUGIN_HOST=0` and a shorter `PACER_HOME`. Homes whose `run/` path
   fits keep their socket in `run/`.
6. **Connection sockets are private and swept.** Every socket is bound in a directory checked
   as above, then set to 0600 by path; the process umask is never changed. Before binding, the
   door removes stale connection sockets in that directory: `s<12-hex>.sock` sockets owned by
   the current user, never symlinks, older than ten seconds (so a socket another connection is
   binding right now survives), that refuse connections.
7. **A probe the door cannot trust is not attached.** If another user owns the run directory
   or socket, or the directory is open to others or is a symlink, the door prints a warning
   and owns its children instead.
8. **Without the native host flag**, stdio composes plugin operations natively through the
   TypeScript Core child, which stays the process owner, exactly as HTTP does flag-off. The door
   removes an inherited `PACER_HOST_SOCKET` from that Core child, so a shell started under a
   flag-on serve that sets `PACER_NATIVE_PLUGIN_HOST=0` gets TypeScript ownership rather than a
   socket the door never checked. Scoped work connections (`PACER_WORK_GRANT`) forward every
   operation and keep their environment.

The private stdio channel is `_internal.plugins`. Core answers it only when the request
carries the connection's sync key (`PACER_NATIVE_CONFIG_SYNC_KEY`, which Core removes from
its environment before plugin children start), the session negotiated protocol 3, and no
work grant is set. It carries the same request kinds as HTTP's `/_internal/plugins`, plus
`relay`. Core refuses `relay` on HTTP and on a stdio connection that is not attached. It
refuses `crashed` without an owner socket and on an attached connection, because serve's
owner reports its children's crashes to serve's Core.

## Consequences

- Stdio and serve never race one plugin child on the same home. When serve is live, every
  stdio connection uses serve's children.
- Two stdio connections on a home without serve each own their children. This is the same
  duplication any two TypeScript Core processes have today. Durable plugin state still goes
  through the existing `plugin-settings` and `plugins` locks and the settings revision check.
- The attach decision is final for a connection. If serve starts after a connection decided
  to own, both owners run until that connection ends; serve is never blocked by it, and the
  next connection attaches.
- An attached connection whose serve exits gets `plugin_unavailable` with the hint "Restart the
  pacer service." until it reconnects.
- Crash counts, restart counts and a child's lifecycle state stay in each Core's memory. The
  owner reports each crash of a child it did not stop to the Core of the door that owns it, with
  the private `crashed` request kind, and Core records it as the TypeScript owner records an
  exit: `restarts`, `error`, the restart backoff (1 s, doubling to 30 s) and `failing` after
  three crashes within a minute. Core seals the earliest next start in `spawn_spec`, and the
  owner waits for it. An attached connection's Core is not told: its `plugin.list` can show a
  child the service runs as `idle` until it has called it, and its `plugin.doctor` can show
  different `restarts` than serve's. The owner therefore keeps its own restart floor per plugin
  with the same ramp and the same `failing` rule: after three crashes within a minute it starts
  the plugin again only once it is enabled. So no door restarts a crash-looping child faster
  than the owning door, or a failing one at all. A native `plugin.enable` through the owning
  door clears the floor. An enable through an attached connection, or forwarded to TypeScript
  (`PACER_FORWARD_OPS`), clears only that Core's state, so the owner keeps its floor and its
  failing mark (known limit). A restart of the owning door's Core child does the same: the new
  Core starts with no crash state, while the owner keeps refusing a failing plugin until a native
  `plugin.enable` through that door. A report that reaches the owning door while its Core
  restarts is dropped, not retried; that crash counts only toward the owner's floor.
- Serve shutdown and an owning connection's end (EOF or SIGTERM) stop accepting new starts and
  send each child SIGTERM at once and SIGKILL 2 seconds later, before the socket is removed. A
  plugin call in flight does not delay this: the owner reaches its children through a lane
  roster kept outside the owner lock, no call holds that lock while it waits for its plugin,
  and the call fails with `plugin_unavailable` once its child exits. On EOF the connection
  first lets its in-flight plugin operations answer, as it does for every request. A child
  that closes its output while still running gets the same SIGTERM, then SIGKILL.
- With the native host on, `plugin.doctor` reports `pid: null` for owner-supervised children on
  both front doors, because Core's snapshot does not know the owner's process IDs.
- A deep home keeps native stdio ownership, but its connection sockets live outside the home,
  where `pacer doctor` does not look yet. A temporary-file cleaner that removes a long-lived
  connection's socket makes that connection's Core plugin calls fail until it reconnects.
- A deep home cannot run a flag-on serve, because `host.sock` must stay in the home as the
  owner lease. PR 7 decides how such homes run the service before the flag turns on by
  default.
- Plain CLI commands start their own Core and, flag-on, still start TypeScript children beside
  a live serve owner. This is a known limit for this wave.
- Detached task runners (`_run`) are the same kind of Core. Core removes `PACER_HOST_SOCKET`
  from every runner it starts, on serve and on attached and self-owned stdio connections, so a
  runner owns its plugin children as it does with the flag off. An attempt therefore keeps its
  executor plugin, and the host-side `executor.run` options the owner bridge does not carry,
  when the connection that dispatched it ends or the service restarts. While a runner is alive,
  a plugin can run under two owners on the home: the runner's and the door's. This extends the
  plain CLI known limit to runners.
- **OD-7.** The maintainer decided that a second serve on a home whose `run/host.sock` owner is
  live refuses to start, instead of falling back to TypeScript ownership. A flag-on serve on
  another port that finds the socket live waits up to 5 seconds (`PACER_SERVE_OWNER_WAIT_MS`),
  checking every 250 ms, so a restart whose old serve is still stopping goes through (the old
  serve frees its port before the socket). While the owner still listens on the port, a second
  serve on that same port fails to bind first and exits 1. If the owner is still
  live it exits with code 3 and "another pacer owns the plugin host socket at `<path>` (pid N):
  stop the other pacer (pacer service stop) or wait for it to exit". The owner writes its pid
  to `run/host.sock.pid` (0600) and removes it at shutdown. `pacer doctor` reports a live socket
  with that pid and a stale one as replaced at the next start. A hung owner that keeps its
  socket live keeps a new serve from starting until it is stopped; launchd keeps retrying the
  service, so a restart converges once the old process exits.
- **Owning calls.** Core seals into each `call_authority` whether TypeScript would give the call a
  call authority (`owning`, the registry's `needsAuthority`) and whether an installed plugin
  granted `net.http` may use a declared `*` host scope (`explicitWildcardGrant`). It issues no
  path or host from the manifest. Outside an owning call the owner refuses every scoped
  capability with TypeScript's `scoped capability requires an active owning call`. A missing or
  malformed seal grants neither (maintainer decision Q4 on the refusal text).
- **The assistant's endpoint key crosses the owner (maintainer decision Q1).** Core answers
  `capability.secrets.resolve` itself when the plugin declares it, and `capability.identity.sign`
  on every call it makes, so an undeclared signing request is refused and audited in Core as
  flag-off does. The owner forwards the request on the bridge connection of the call that issued
  it, and Core runs its flag-off check (`assistantSecret` admits only `pacer-assistant` and its
  chosen endpoint account's key, the Keychain lookup stays in Core; signing keeps the machine key
  and the audit in Core). The resolved key crosses only that connection (0600 socket, same user)
  and the child's stdin, as the reply to the child's own request. The owner keeps nothing and
  logs no frame. Endpoint and classifier calls that carry credential bindings stay refused. The
  Rust door's own owner calls (`plugin.doctor`, `plugin.ui.*`) forward no Core method, so there
  the owner refuses both with its own text and audits no refused signing request.
  Until the bridge authenticates its callers (#918), a same-user process can reach the resolved
  key or a signature: it can put its own process in the assistant's or a signing plugin's lane
  (the bridge's unsealed spawn and stop, or a lane it started first), or stand in for the socket,
  and Core then answers that process. This gives it nothing a same-user process cannot already
  read: the Keychain items have no access list, and file and environment keys are same-user
  readable.
- **Detached stop, inspection and remote stop grants stay in Core.** Serve's supervision stops an
  orphaned direct-executor attempt with a one-use `detachedStop` grant, inspects one with
  `detachedInspect`, and stops a remote one with `remoteStop`. Core does not seal these grants
  into `call_authority`. When it issues one, it seals `capability.process.stopRun`,
  `capability.process.inspectRun` or `capability.hosts.stopOwned` as a Core method of that call,
  and answers the plugin's request on the call's bridge connection with its flag-off broker. The
  grant is therefore consumed once and bound to its task, attempt, run directory and wrapper pid
  exactly as flag-off, with the same refusal codes and texts. The owner forwards an unsealed
  request to none of them, so a plugin cannot stop or inspect a run its call was not issued.
  The flag-on remote stop then needs the SSH host runner, which the owner does not serve yet.
- `run/host.sock` and the plugin installation owner in [ADR 0021](0021-single-installation-owner.md)
  are different things: ADR 0021 decides which pacer installation runs the service; this
  record decides which process inside it owns plugin children.

## Rejected alternatives

- **A per-connection `flock` lease in `run/`.** The socket already shows whether an owner is
  alive and is safe to replace when stale. A lock file adds a second coordination primitive,
  and a stdio connection holding it would block serve from starting.
- **Stdio connections bind `run/host.sock`.** Serve would then have to refuse to start while a
  terminal session is open, and two stdio connections would race for the socket.
- **Every stdio connection always owns its children, beside serve.** Two owners would run the
  same plugins against the same home, which OD-2 rules out.
- **A deep home refuses flag-on stdio, or falls back to Core ownership.** Refusing loses stdio
  for every deep home once the flag is on by default. A fallback would choose the trust and
  supervision model by path length, which a programmatic client cannot see.
- **A deep home's socket in a shared `/tmp` name or under `$TMPDIR`.** Another user can create
  a shared name first, and `$TMPDIR` comes from the caller's environment.
- **Stdio leaves ownership to TypeScript when serve is live.** The stdio Core would start its
  own TypeScript children beside serve's native owner: the two-owner problem this record
  exists to avoid.
- **Sealing the detached stop and inspection grants for the owner's native process broker.**
  The grants would cross the socket as new `call_authority` resources, the native broker would
  need a second one-use implementation with its own refusal texts, and a remote stop would
  still need Core's host runner, which the bridge refuses.

## Addendum: observation generations under the owner (2026-11-13)

A policy plugin that subscribes to events gets the same events with the owner on as with the
owner off: the same filtering, payload bytes and order. With the owner on, the plugin's
subscription belongs to its lane, not to the call that made it, and lives as long as the
child.

- **Generation.** Core's `call_authority` seals `observation.generation`, the SHA-256 of the
  plugin's observation fingerprint (manifest, config and grant). The first sealed call that
  subscribes starts the lane's generation under that name. A later call sealed under another
  name stops the old child and starts a fresh one, as the registry does for a local child.
- **Source.** The owning door's Core supplies the events and task reads through the private
  kinds `observation_events`, `observation_read` and `observation_retired`. A flag-off Core
  refuses them, and so does a stdio Core attached to the service's `host.sock`. On every
  request Core checks again that the plugin is enabled, declares and is granted the
  capability, and still has the fingerprint the generation was sealed with. Core filters events
  to the subscribed types plus `reset`. `since: null` returns only the current end of the
  outbox, so a new subscription sees only later events.
- **Delivery.** The lane asks Core for new events every 100 ms. A separate task writes each
  `$/event` line within 2 s, in outbox order, with `JSON.stringify` key order and number text.
  The queue keeps the TypeScript bounds: 128 events and 256 KiB.
- **Retirement.** The generation retires when:
  - its child exits or is stopped;
  - the owner closes (serve stops or the stdio connection ends);
  - Core refuses it, for example because the plugin was disabled or reconfigured. The owner
    stops the child and records no failure.
  - a pump or delivery fails. Core logs `[observation] <reason>` and marks the plugin
    `failing`, and the owner stops the child.

  A retired generation's read owner is refused.
- **Between calls.** A request that arrives while no call is pending, or that names a read
  owner, goes to the lane's idle session. It is never answered by the next call's session.
  - The idle session answers `capability.log`, which it sends to Core with its level, and
    `capability.config.get` from the sealed hello.
  - It answers task reads and subscriptions only under the generation's read owner.
  - It refuses everything else with code `capability_denied`. Before the idle session exists,
    and for "capability token has no active pending request" and "read owner cannot authorize
    this method", the text matches the TypeScript owner. The idle session is no owning call
    (see **Owning calls** above), so once it exists a declared scoped capability is refused
    with TypeScript's "scoped capability requires an active owning call" too.

**Differences from the TypeScript owner:**

- While Core is unavailable, the lane keeps its cursor and asks again on the next tick. The
  TypeScript registry runs inside Core and has no such gap.
- Requests between calls are answered one at a time.
- Between calls, `secrets.resolve` and `identity.sign` are refused. The registry answers them
  outside a call.
- `config.get` returns the config sealed at the first call's hello, and the idle session is
  not refreshed. The registry returns the current config for every plugin. An observing child
  sees the same result because a config change moves its generation and restarts it; a child
  without a live generation keeps the stale config between calls. Calls get the current
  config, because each call seals a fresh hello.

**Rejected.** The owner reading the outbox and task store directly. That would duplicate
Core's protocol 3 event conversion and task projection, and split the authority checks
between two processes.

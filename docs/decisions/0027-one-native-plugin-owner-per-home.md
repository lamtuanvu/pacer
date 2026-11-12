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
`relay`. Core refuses `relay` on HTTP and on a stdio connection that is not attached.

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
- Crash counts, restart counts and a child's lifecycle state stay in each Core's memory. An
  attached connection's `plugin.list` can show a child the service runs as `idle` until that
  connection's Core has called it, and its `plugin.doctor` can show different `restarts` than
  serve's. PR 5 adds an owner-side restart floor.
- With the native host on, `plugin.doctor` reports `pid: null` for owner-supervised children on
  both front doors, because Core's snapshot does not know the owner's process IDs.
- A deep home keeps native stdio ownership, but its connection sockets live outside the home,
  where `pacer doctor` does not look yet. A temporary-file cleaner that removes a long-lived
  connection's socket makes that connection's Core plugin calls fail until it reconnects.
- A deep home cannot run a flag-on serve, because `host.sock` must stay in the home as the
  owner lease. PR 5 or PR 7 decides how such homes run the service before the flag turns on
  by default.
- Plain CLI commands start their own Core and, flag-on, still start TypeScript children beside
  a live serve owner. This is a known limit for this wave.
- **OD-7.** The maintainer decided that a second serve on a home whose `run/host.sock` owner is
  live refuses to start, instead of falling back to TypeScript ownership. `ReverseBridge`
  already refuses to replace a live socket, so serve exits today with "live reverse-bridge
  socket already present". PR 5 makes this a stable message with exit code 3 and adds a
  doctor check. A hung owner that keeps its socket live keeps a new serve from starting until
  it is stopped.
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

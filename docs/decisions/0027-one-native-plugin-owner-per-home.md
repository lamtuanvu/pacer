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
   refuses connections is stale and the next serve replaces it.
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
   bridge listener on its own `run/s<12-hex>.sock`, and its Core child gets that socket. The
   socket is 0600 in the 0700 run directory. Only same-user peers are served, and the path
   length is checked before anything is created. When the connection ends, the door closes the
   listener, removes the socket and stops the children it started.
5. **A probe the door cannot trust is not attached.** If another user owns the run directory
   or socket, or the directory is open to others or is a symlink, the door prints a warning
   and owns its children instead.
6. **Without the native host flag**, stdio composes plugin operations natively through the
   TypeScript Core child, which stays the process owner, exactly as HTTP does flag-off.

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
- Crash and restart counts stay in each Core's memory, so an attached connection's
  `plugin.doctor` can show different `restarts` than serve's. PR 5 adds an owner-side restart
  floor.
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
- **Stdio leaves ownership to TypeScript when serve is live.** The stdio Core would start its
  own TypeScript children beside serve's native owner: the two-owner problem this record
  exists to avoid.

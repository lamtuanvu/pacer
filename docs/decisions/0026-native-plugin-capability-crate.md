# ADR 0026 — Native plugin capability crate

Date: 2026-11-12

Status: Proposed. Accepted when the maintainer merges it.

`pacer-plugin-host` had grown to 11,691 hand-written lines, above CRATE-1's 8,000-line
warning threshold and close to the 12,000-line hard limit. The next M2 and #889 work
(Orca attempt ownership, SSH transport, Git bundle transfer, remote admission) would
add thousands more lines to the same crate. [ADR 0020](0020-native-plugin-read-operations-crate.md)
had already named the next seam: "Its native capability brokers are the next split seam
as M2 ports acquire their callers." Those brokers now have their runtime caller,
`pacer-plugin-runtime`'s capability sessions.

## Decision

`pacer-plugin-capabilities` (`crates/plugin-capabilities`) owns the native capability
brokers for plugin calls: the capability broker and transfers, and the native read,
process, HTTP, bundle, duplex, hosts, worktree, run, remote and Orca effects. The modules
moved from `pacer-plugin-host` with their file names, contents and tests unchanged except
for import paths and visibility. No behavior, wire format or public operation changes.

It is an unpublished layer-5 domain crate with a planned budget of 7,500 hand-written lines.
It measured 6,331 at the split. It depends on `pacer-plugin-host` (layer 4), `pacer-store`
and `pacer-foundation`, and takes `reqwest` with the native HTTP effect. `pacer-plugin-host`
no longer allows `reqwest`. `pacer-plugin-runtime` moves from layer 5 to layer 6 because it
depends on the new crate. It measured 3,682 lines, with a planned budget of 4,500.
`pacer-server` (layer 9) is still the runtime's only consumer, so no other layer changes.

`pacer-plugin-host` keeps the plugin registry, frame codec, call authority, credentials,
host leases, manifests, policy, observations and pairing. It measured 5,378 lines after
the split, with a planned budget of 6,000. It also keeps the following, which a pure move could not take because modules
that stay in the host depend on them:

- `BrokerError`, now in the host's `error.rs`. Credentials, hardening, observations,
  policy, pairing, spawn specifications and work leases return it. Its conversion from
  task store errors stays beside it because of the orphan rule. The conversion inlines the
  native run effect's denial message.
- The Orca attempt and live resources and the Orca provider identity, now in `authority.rs`
  beside the other call resources. `CallResources` carries them.
- The Bun.Glob matcher, now in the host's `bun_glob` module. Declared-scope checks in
  `authority.rs` and native reads both use it.
- The native write effect. Discovery pairing writes its state through it. It is the next
  candidate to move if pairing moves out of the host.

The host exposes `js_semantics`, `bun_glob`, the path helpers, the Codex request constant
and the command and credential methods that the brokers call as `pub` items. The call
authority's expiry test seam moves from `cfg(test)` to the host's non-default `testing`
feature. Only the capability crate's dev-dependency enables it.

`CredentialBindings::resolve`, which returns a bound secret, is one of those `pub` methods.
It yields only values the holder registered through the already public `bind` methods, so
it adds no way around the call authority. Moving `CredentialBindings` into the capability
crate would let `resolve` stay crate-private, but spawn specifications in the host still
use the credential reference check, so that move waits for a split of `credentials.rs`.

## Consequences

Editing a broker rebuilds the capability crate and the runtime, not the host. The host
returns inside CRATE-1's warning threshold. Both crates are above the 5,000-line target.
The host's next seams are the observation read owner and registry policy, if it grows.
PR evidence records exact sizes and CRATE-9 clean and incremental build timings. The
heavy dependency moves rather than spreads; no profile change is needed.

The executor domain #889 needs (native Orca attempt ownership, SSH transport, verified Git
bundle transfer with compare-and-swap, remote admission) stays out of this crate. When #889
starts, that work lands in its own `pacer-plugin-exec`-area crate above the capability
crate. This keeps the capability crate below 8,000 lines, as CRATE-1 asks: state why and
name the split.

This differs from the #629 branch's split into `plugin-capabilities`, `plugin-execution`,
`plugin-wire` and `bun-glob`. That branch was a 32,000-line shadow rewrite that diverged from main's
single `crates/plugin-host` layout, and its ADR number is taken. This decision moves main's
modules as they are, under the name ADR 0020 anticipated, and leaves execution and wire
splits to the work that needs them.

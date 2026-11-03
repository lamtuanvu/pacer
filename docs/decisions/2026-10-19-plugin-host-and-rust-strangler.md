# Plugin host and strangler migration to Rust — 2026-10-19

Status: owner decision recorded 2026-10-19.
Source: [plugin system design](../specs/2026-10-19-plugin-system-design.md) and
[plugin host core design](../specs/2026-10-19-plugin-host-core-design.md). Builds on
[clients over one local service](2026-10-16-clients-over-local-service.md).

## Context

Every adapter (usage readers, execution backends, remote hosts, endpoint vendors,
classifiers, notifiers, planner installers, surfaces) is hard-wired in the core and
ships in one Bun binary. The product goal is a small open core with a growing set of
capabilities, some commercial, and a runtime-free binary. The client protocol
(`src/api/`) already separates surfaces from the service; nothing separates the
service from its adapters.

## Decisions

- **D1. The host is minimal.** `pacer serve` keeps the client API, plugin registry and
  lifecycle, capability broker, event bus, task store and activity log, config,
  strategy and routing, and the pacing engine. Every other capability is a plugin
  against one versioned plugin protocol (`docs/plugin-protocol.md`). Bundled reference
  plugins are the open implementations of that contract; the host never falls back to
  a built-in once an adapter is extracted.
- **D2. One contract, two transports.** Phase 1 runs plugins as subprocesses over
  newline-delimited JSON-RPC 2.0 on stdio, reusing the client transport's framing.
  Phase 2 adds in-process wasm components on the Rust host, where capabilities are
  host imports and the manifest is enforced by construction. Bundled plugins use the
  same transport as installed ones (the binary re-executes itself with
  `pacer plugin run <id>`), so failure semantics and conformance are identical.
- **D3. Open core by feature tier.** Host, protocol, SDKs, reference plugins and the
  conformance suite are Apache-2.0 in this repository. Commercial plugins are built
  with the same SDKs in a separate repository. If a commercial plugin needs something
  the SDK lacks, the SDK gains it in the open first.
- **D4. The host never checks entitlements.** A commercial plugin verifies its own
  license and reports status through the `entitlement.report` capability. The
  manifest's `tier` is informational.
- **D5. Strangler migration.** M0 lands the contract on the TypeScript host and
  extracts reference plugins one extension point per PR. M1 puts a Rust binary in
  front, speaking the client protocol and forwarding unimplemented operations to the
  TypeScript core as a subprocess. M2 moves core modules inward in dependency order.
  M3 removes the TypeScript core and adds the wasm transport. Each milestone is a
  complete product.
- **D6. Rust CI is required from M1.** `cargo fmt --check`, `clippy` and `cargo test`
  run on every PR once the Cargo workspace exists (resolves OD-3 for that scope).

## Consequences

- Dependency direction becomes clients → API → host core → plugin protocol → plugins.
  Only the plugin host (`src/plugins/`) and its operation handlers import the bundled
  plugin list.
- The plugin protocol is versioned under the same compatibility rule as the client
  protocol (P4) and documented from zod schemas with a freshness test (P11).
- A plugin's failure degrades one capability and is visible through `plugin.list`,
  `plugin.doctor`, the `plugin` event and the activity log; it never stops the service.
- Routing and strategy stay in the core so no plugin can hold the host hostage.
- The remote Codex usage probe and Claude stream telemetry remain host-owned
  integration paths during the migration. They are not generic fallback readers
  for an unavailable usage plugin. Host-owned planner journal recovery likewise
  remains available when the planner plugin is gone.
- The release still ships one binary. npm and Homebrew paths do not change.

## Open questions

- Product name and portal for the commercial line.
- Whether the Orca panel stays a surface plugin or a client only.
- Publisher key management for signed plugin archives (shipped list, or a key server
  with a later registry).

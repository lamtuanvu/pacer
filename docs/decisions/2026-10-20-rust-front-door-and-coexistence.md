# Rust front door and coexistence contract — 2026-10-20

Status: owner decision recorded 2026-10-20.
Source: [Rust host migration design](../specs/2026-10-20-rust-host-migration-design.md) §0
and §1.3. Builds on [plugin host and strangler migration to Rust](2026-10-19-plugin-host-and-rust-strangler.md) (D5).

## Context

The strangler migration puts a Rust binary in front of the TypeScript core, moving
modules inward one at a time until the runtime is removed in M3. That requires
two binaries shared across a pacer home during M1 and M2, so we must decide how
the front door resolves and runs the core, how the two runtimes stay safe on one
home, and how releases ship and update the pair.

## Decisions

- **D1. Two binaries.** The installed CLI is `pacer` (Rust); the TypeScript
  core ships alongside it as `pacer-core` (bun-compiled). `pacer` answers
  anything it implements natively and forwards everything else by exec'ing
  `pacer-core` with the original argv.
- **D2. Native paths first.** The status line and `--version` are the first
  native paths, measured at about 4 ms vs about 110 ms for the Bun-run CLI.
  `pacer-core` is resolved as a sibling of the canonicalized executable.
  `PACER_CORE_ARGV` (a JSON array, for development, e.g.
  `["bun","/abs/src/cli.ts"]`) overrides that resolution.
- **D3. `PACER_BIN` points at the front door.** The front door sets `PACER_BIN`
  to its own path in the child's environment when unset, so every place that
  re-execs pacer (hooks, service units, runner spawns, the bundled-plugin
  re-exec) writes the Rust binary, not the core.
- **D4. Shared on-disk state and the lock protocol are the only contract
  between runtimes.** All shared state is files under `$PACER_HOME`; writers in
  both runtimes follow one lock and atomic-write protocol (lock file
  `$PACER_HOME/orca/<name>.lock` with `O_CREAT | O_EXCL`, stale takeover after
  120 s, 50 ms poll and 20 s timeout, temp-then-rename writes, secrets 0600 and
  secret directories 0700, SEC-7). The contract is proven by a cross-runtime
  lock test in which a Bun writer and a Rust writer increment one counter file
  under one lock name for a fixed number of iterations and assert no lost update.
- **D5. Releases stay unchanged until the paired release in M1 plan 5.** Until
  then the release still ships and updates one binary; the paired two-binary
  release (assets, manifest companions, self-repair, sign and update as a pair)
  lands together in its own plan.

## Consequences

- M1 and M2 ship two files to sign and ship (`pacer` and `pacer-core`), updated
  as a pair once the paired release in M1 plan 5 lands. Before that plan, the
  release is unchanged from M0.
- The lock and atomic-write rules are implemented in Rust in
  `crates/foundation/src/{lock,fsutil}.rs` and must match the TypeScript
  writers exactly, or the cross-runtime lock test fails.
- `PACER_BIN` means every re-exec path converges on the Rust front door from M1.
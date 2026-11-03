# Native plugin attempt runtime

This is an unpublished shadow library. `pacer-plugin-host` re-exports its existing
capability types so the registry and RPC admission API remain compatible. The
TypeScript plugin host is authoritative; this crate registers no client operation
and does not select executors or introduce a runtime fallback.

The layer-5 runtime owns the private Orca attempt/policy/session unit and its
task-attempt journals. Direct/remote runs, run directories, Git/worktree receipts
and SSH transfer live in layer-4 `pacer-plugin-execution`; runtime re-exports those
modules and the pinned descriptors, executable images and byte/process resources
defined by layer-3 `pacer-plugin-capabilities`. `OrcaPolicy`, `OrcaAttemptSpec` and `RemoteIntent` are private
host composition inputs, never plugin parameters. Orca providers receive only the
task/attempt contract. SSH programs are fixed copies of `src/remote/scripts.ts`,
with a Bun freshness test; arguments are quoted separately and binary input stays
in host memory or private stages. Remote bundles are checked in a disposable Git
object database before compare-and-swap publication of the admitted local ref.

Desktop admission uses the existing `desktop-updates/admission.sqlite` state and
transaction protocol. Pending work without completion proof stays pending. Native
leases currently use a null process identity, which the TS schema permits and
which keeps recovery conservative; no process is inferred dead from a PID alone.

## Validation seams

| TS reference | Rust coverage |
| --- | --- |
| `sp02-authority`, `sp02-capability-security`, `plugins-write-authority`, `plugins-capability-write` | `authority`, `native_read/tests`, `native_write`, broker scope and numeric matrices |
| `plugins-file-write-transfers`, `plugins-http-body-transfers` | `transfers_adversarial`, `capability_delivery`, broker transfer tests |
| `plugins-host-lease`, `plugins-host-lease-fetch`, `plugins-remote-preflight` | `host_lease_adversarial`, `native_hosts`, `native_git` preflight matrix |
| `plugins-capability-duplex`, `sp02-spawn-security` | `native_duplex`, `native_process`, `spawn_modes`, `ssh_transport` process-group tests |
| `plugins-remote-prepare-recover`, `remote-transfer`, `remote-committed-work` | `native_remote`, `native_git` concrete pipe and transfer fixture |
| `plugins-policy`, planner restrictions from #503 | `hardening`, `policy_adversarial`, `policy_evaluation` |
| `orca-attempt`, `orca-host`, terminal-worker contracts | `orca_attempt`, `orca_effects`, `work_lease` |

These are grouped coverage references, not a claim that every original TS
assertion has an independent Rust equivalent. Public-surface native execution is
unavailable until native registration; live reports must distinguish the TS
forwarding smoke check from native library fixtures.

## Size boundary

Candidate B separated pinned byte/process capabilities (4,213 LOC, layer 3),
task attempts (this crate: 7,781 LOC, layer 4), and registry/RPC admission
(plugin-host: 4,970 LOC, layer 5). All public runtime/host module and type paths
remain re-exports of the same definitions. BrokerError and CapabilityEffect live
below; the Store2 error conversion retains its exact existing denial and creates
no lower TaskStore access. No private attempt/session/journal field is widened.

The 2026-11-03 split moved direct/remote run and transfer ownership into
`pacer-plugin-execution` (3,765 LOC, layer 4). This crate (4,534 LOC) moves to
layer 5 and host (4,972 LOC) to layer 6; all are below the 5,000 target. Execution
modules keep their bytes and `src/`-relative paths, and existing runtime/host paths
re-export the same items. Tests stay at these facades. Matched build timings
accompany each graph change; they do not establish a shared-host speedup.

## Native composition and delivery

`OrcaAttempt::from_policy` captures a host configuration snapshot. Preparation
resolves Git placement and its immutable base, Orca repository ownership,
coordinator/run recovery and named group parents. Terminal creation composes the
account folder, profile-only default folder record, Codex trust argv and Claude
per-run settings. MCP answers are read from the source checkout and selected
account; a rejection wins and malformed source settings leave the prompt enabled.
No native agent configuration is written.

Stopped conversational lanes release only a worktree with verified Orca identity,
no uncommitted changes and no commits beyond its base. Empty group parents need
an explicit empty child list and a clean tree. Uncertain ownership/removal retains
the worktree; a released path is cleared from the task. The same checks serve
fresh attempts and live-owner stop calls.

`pacer-plugin-wire` owns bounded payload staging; `pacer-js-json` owns JavaScript
value semantics below both the runtime and task store.
Its `WireReply` serializes UTF-16 slices without replacing a lone surrogate.
Use `OrcaSessionOwner::invoke_wire` and `CapabilityBroker::handle_wire` at a
future Orca RPC boundary. The scalar `Value` convenience API rejects a reply that
needs non-scalar UTF-16 delivery. These APIs register no public operation.

Clipped question text uses the same lossless representation in the task record.
The task store preserves it through SQLite/JSON import and later metadata updates;
`read_wire` delivers the exact JSON, while `read` is a scalar metadata preview.
Question text overlays cannot change task identity/state/revision. A concrete
Orca fixture verifies the 1,000-unit JS clip through settlement and reopening,
then asks Bun to check its length and final UTF-16 code unit.

Host-provider adapters retain pending external effects across future cancellation.
`retire_pending` must settle those effects before retirement can succeed; its
default returns cleanup uncertainty. A cancelled close retains its exact session
so retirement can retry it. Cleanup failures remain sticky.

Issued Codex log roots permit only rollout JSONL descendants and metadata-only
root stat. Reads walk pinned, no-follow ancestry and revalidate the original root
before returning bytes; configured canonical aliases work without permitting
later target replacement. Repeated preparation preserves the first pins.
`pacer-bun-glob` holds the unchanged Bun scan/scope matcher below this crate.

Spawn, duplex and bundle owners retain their exact child across cancellation.
Owned retirement waits for process-group termination and reaping; failed private
stage cleanup stays visible and never removes a replacement directory. Secret
input and captured output are erased on revocation. Filesystem mutations check
the original authority again at staging and commit boundaries, including recursive
removal, so an elapsed deadline cannot publish staged bytes.

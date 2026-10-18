# Architecture rules

Applies to: `src/**`, `app/**`, `orca-plugin/**` and `desktop/**`. Also applies to any change that adds a capability, a client surface or an execution backend.
Out of scope: internal refactors inside one module that leave its imports and public operations unchanged.
Owner: @lamtuanvu
Canonical sources: [ADR clients-over-local-service](../../docs/decisions/2026-10-16-clients-over-local-service.md), [ADR orca-plugin-information-only](../../docs/decisions/2026-10-15-orca-plugin-information-only.md), [ADR remote-hosts-ssh](../../docs/decisions/2026-10-15-remote-hosts-ssh.md), [core contract spec](../../docs/specs/2026-10-14-core-contract-design.md), `test/core-boundaries.test.ts`

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| ARCH-1 | `pacer serve` owns work and state. Clients (CLI, TUI, web/tray, Orca panel, desktop) read and act only through the versioned API operations and events, never through private files or internal modules of the service. | Established | Clients ADR D1–D2 | Review imports from client code. `test/view-model-client-migration.test.ts` |
| ARCH-2 | A new capability goes in the core as an operation or event first. Clients come after. | Established | Clients ADR D2 | Review: the diff adds an op in `src/api/ops.ts` before client use |
| ARCH-3 | Operations are multi-client safe. A conflicting concurrent change returns a `conflict` error instead of a last-write-wins overwrite. | Established | Clients ADR | Tests for concurrent ops |
| ARCH-4 | Core code reaches `orca-plugin/` only through `src/serve/panel.ts`. `src/core` never imports `src/exec/orca`. | Established | core-boundaries test | `bun run test` (core-boundaries) |
| ARCH-5 | Nothing assumes a fixed planner (Claude) or host (Orca). Planner and host integrations live behind installers or adapters. | Established | Clients ADR; ROADMAP | Review for hard-coded planner and host names in the core |
| ARCH-6 | The Orca plugin only shows information. The worker uses loopback HTTP or stdio API reads and writes only its panel. It spawns nothing and touches no consoles. | Established | Orca information-only ADR | Review `orca-plugin/src/**` |
| ARCH-7 | Remote hosts are driven over SSH (BatchMode) with no pacer or Bun installed on them. Results return as a verified git bundle, and acceptance runs locally. | Established | Remote-hosts ADR | `test/remote-*` tests; review |
| ARCH-8 | The CLI and TUI stay complete and need no other surface. | Established | Clients ADR | Review |
| ARCH-9 | Durable architectural choices get an ADR in `docs/decisions/`. | Established | GOVERNANCE.md | Review the PR for a matching ADR |
| ARCH-10 | Remove retired transport code (`src/link/`, `src/console/`, the `link/consoles` watcher) or move what is still used (e.g. `OutboxEvent`) into its owning module. | Proposed | 3.0 retired the link transport (#77) | Pending decision |
| ARCH-11 | Rename phase-numbered modules (`src/commands/plan2b.ts`…`plan7.ts`) after what they do. | Proposed | Observed naming drift | Pending decision |

Relevant reviewers: [architecture](../reviewers/architecture.md), [protocol-compat](../reviewers/protocol-compat.md)
Exceptions and open decisions: ARCH-10 and ARCH-11 are proposals (see [decisions.md](../decisions.md)).

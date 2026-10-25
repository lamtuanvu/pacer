# Intelligent work dispatch boundaries

Date: 2026-10-24
Status: Accepted design by maintainer conversation; implementation staged.

## Context

Pacer needs to select work destinations using capabilities and preferences as well as subscription capacity. Model availability and usage sources vary, and future recommendation models must be replaceable without owning execution authority. See [approved design](../specs/2026-10-24-intelligent-work-dispatcher-design.md).

## Decision

Keep three explicit boundaries: authoritative service control, replaceable recommendation engines, and typed observation adapters. Control owns identity, policy/eligibility, durable work state, reservations and execution. Engines receive normalized snapshots and return ordered candidate proposals; their output is validated before control acts. Adapters provide scoped, timestamped facts through a serializable contract; provider implementations later bind to the versioned plugin protocol. Existing extracted plugins never gain a built-in fallback.

Use an ordered ladder with ranking inside the first qualifying step as the default engine. Preserve account quota pools across models and distinguish declared capabilities from observed evidence and unknowns. The first release exposes read-only previews; legacy dispatch keeps existing semantics.

## Consequences and adoption

Decision history can identify the engine/configuration and evidence independently of task/executor integrations. A model-based engine can later be substituted without bypassing permissions or hard limits. Observation transport can change without changing the decision consumer. Initial previews use cached status and configured model inventory, not universal live provider discovery or learned quality.

Bounded child delegation is implemented under the proposed constitution amendment 0.14.0. The service issues attempt-bound work grants and confines child creation, review and reads to the caller's subtree; executor sessions without a grant remain denied. API-5's existing blanket refusal remains established until maintainer merge. Existing authentication, thin-client, SSH and protocol compatibility rules remain in force.

The dispatch preview schema pushed the existing generated client crate above its established 10,000-line ceiling. Generate dispatch parameters in the layer-0 `pacer-dispatch-protocol` area crate, following the existing session-area split (CRATE-3). The generator owns all emitted types; no host logic or new external dependency is added. Record clean/incremental before-and-after timings for this split under CRATE-9.

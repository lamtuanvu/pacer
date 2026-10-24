# Automatic integration reconciliation

Date: 2026-10-23. Status: Accepted by the maintainer's design approval.

## Context

An installed agent skill or hook can remain unchanged after the Pacer binary is
upgraded. The CLI updater previously refreshed only default integration keys, and
historical file integrity did not establish freshness against the running assets.
Desktop and package-manager upgrades need the same behavior without separate
migration implementations.

## Decision

The updated service reconciles previously connected integrations at startup.
Local execution admission and new resume/takeover processes check the selected
integration before launch. Agent hooks do not perform reconciliation. Integration
adapters supply file-only plans; one installation boundary owns fingerprinting,
conflict detection, serialized application, atomic writes and recovery.

Fingerprints represent managed content and target/command identity, not release
versions. Named accounts retain their recorded folders. Unrelated configuration
survives; customized managed content produces a repair hint instead of being
overwritten. An account without a recorded integration remains unconnected.
Remote host configuration and already loaded agent conversations are unchanged.

The CLI updater invokes the replacement binary's reconciler so the desired assets
come from the new runtime. Other upgrade channels converge when the new service
is adopted. Doctor remains read-only and reports freshness as well as integrity.

## Consequences

Successful upgrades require no routine repair step. A conflicting connected
account cannot launch until its managed assets are reconciled; other accounts and
existing sessions can continue. Native agents may still require trust approval
when a hook command changes. Installation records now retain owned-content hashes
and reconciliation fingerprints; an interrupted transaction remains recoverable.

See [approved design](../specs/2026-10-23-integration-reconciliation-design.md).

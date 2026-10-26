# Idle usage refresh through provider adapters

Status: accepted 2026-10-26. Design: [idle usage refresh](../specs/2026-10-25-idle-usage-refresh-design.md).

## Context

Pacer previously learned most quota changes while an executor ran or from its local session records. An idle account could retain an old reading even while its provider's quota reset or changed. The browser, CLI and service need the same account result without starting a coding turn.

## Decision

The local service owns a 15-minute refresh cycle for all configured accounts. Each usage adapter declares whether it can issue a provider command, read passive local telemetry, or has no quota query. The v3 `limits.refresh` operation and `pacer limits refresh [account]` use the same coordinator as the timer; the app calls that operation and reloads account readings. Concurrent requests for one account share work, while an explicit provider refresh waits for any in-progress passive read and then issues its own request.

Codex uses its read-only app-server `account/rateLimits/read` method under the selected account home. ArkCLI and OpenCode keep their native usage commands. Claude reads the status-line cache; an idle Claude account can remain unchanged until Claude supplies new telemetry. Reactive and unmetered accounts have no active quota query. Pacer does not inspect provider credential files or start an executor turn to obtain usage.

Failed refreshes retain the previous measured windows as historical with an error. They cannot create current quota evidence or bypass the routing freshness checks. The API returns an explicit per-account outcome. Protocol v2 remains frozen.

## Consequences

Provider integration stays behind `src/usage/` rather than accumulating provider branches in the service or UI. A new provider implements the adapter contract and states its refresh capability. The service makes bounded native requests even when all executors are idle, so provider failures and timeouts must remain isolated by account.

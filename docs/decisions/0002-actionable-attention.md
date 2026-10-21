# Actionable attention and optional outcome verdicts

Date: 2026-10-21
Status: Accepted design; implementation under validation.

## Context

Every unreviewed completed execution previously became a review obligation. A
planner could review, integrate and deliver outside that queue, leaving redundant
human bookkeeping. Acceptance records a verdict and does not merge a branch.

## Decision

The service derives attention from questions, failed checks, incomplete work and
explicit human handoffs. Completion alone never requests review. Preserve verdict
operations and benchmark labels while showing execution, quality outcome and
integration knowledge as distinct facts. Clients use the service attention and
shared vocabulary; Tasks offers history independently of the recent snapshot.

Add optional review-request metadata and an additive revision-safe operation,
with CLI and MCP handoff entry points. Existing task records are not accepted,
dismissed or rewritten as a migration. Retention safeguards remain unchanged.

## Consequences

Users need only act on genuine decisions and problems. Planners must explicitly
request human review and record their own verdicts after actually reviewing.
Unknown quality and integration remain visible as unknown. Old clients retain
existing operation names; old routes alias the new destinations. This design
introduces neither automatic integration nor a mandatory approval gate.

See [the design](../specs/2026-10-21-actionable-attention-design.md).

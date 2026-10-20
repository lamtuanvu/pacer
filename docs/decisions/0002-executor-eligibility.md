# Executor eligibility from timestamped evidence

Status: Proposed for maintainer review
Date: 2026-10-20
Issue: #213

## Context

Pacing verdicts, cached usage and execution failures previously served as competing approximations of execution permission. File writes could renew old quota, passed reset predictions could invent headroom, and a displayed ready state could disagree with delegation.

## Decision

Adapters emit timestamped availability, budget and spending facts. The core reconciles them within account/source identity and optional runner, model and host scopes. Newest valid observations win; equal-time source precedence is deterministic and contradictions remain explicit. State persistence is atomic and revisioned. Only completed JSONL records can supply persistent evidence. Account removal records a lifetime boundary, preventing delayed reads and identical-name recreation from reopening old facts. Execution-derived facts retain their actual runner, model and host scope; name-only legacy marks cannot acquire a new source identity.

A pure evaluator returns eligible, uncertain or ineligible with reasons, references, evidence age and a validity boundary. Pacing ranks inside those groups. Automatic delegation permits labelled uncertain fallbacks after eligible choices, as selected by the maintainer. Guards require a confirmed eligible alternative before redirecting local work. Credits never replace configured paid permission.

Launch refresh is capability-aware. Dispatch rechecks local evidence, restrictions and configuration after refresh. Execution outcomes update only the fact they establish. Additive protocol fields carry this decision to clients and persisted attempts; presentation does not decide permission from quota percentages.

## Consequences

Old logs and incomplete measurements can produce more visible uncertainty, including after a predicted reset. Passive logs cannot guarantee a current provider-side budget, and unknown paid-spend risk remains unknown. Uncertain attempts may fail; their provenance is preserved. Bounded local discovery and cache versioning avoid treating legacy modification times as observation times.

See the [approved design](../specs/2026-10-20-executor-eligibility-design.md) and [operator documentation](../executors.md#execution-eligibility-and-evidence).

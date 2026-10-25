# Intelligent work dispatcher

Date: 2026-10-24
Status: Design approved by the maintainer in conversation on 2026-10-24; implementation and governance adoption remain separate. No runtime behavior or policy is changed.

## Intent

Evolve Pacer from subscription usage control into an intelligent work dispatcher. Any supported agent can receive work, plan it, and ask Pacer to delegate bounded subtasks. Pacer selects an executor, account and model using explicit strategies, observed availability and capacity, and evidence about task suitability. Usage control remains a constraint and optimization input.

The user selected an ordered strategy ladder with ranking within each step as the default replaceable decision engine. The user subsequently confirmed three explicit boundaries: adapter-based observation providers, a replaceable decision engine, and an authoritative Pacer control layer. The default favors another capable model with spare capacity when a preferred specialist has little capacity. Every preference, capacity threshold and fallback is configurable. Delegation history is a first-class foundation for user visualization and analysis.

## Current foundations and gaps

The current implementation has runner/account/model configuration (`src/config/accounts.ts`), endpoint model discovery (`src/endpoints/models.ts`), task-kind routing, project selection and priority/even/burn-before-reset/cheapest-first ranking (`src/engine/`). MCP exposes routing, delegation and task review (`src/mcp/server.ts`).

Today routing selects configured runners with a model already attached. A configured planner account is excluded from executor ranking; executor sessions are explicitly refused delegation. Capability tiers, per-task model expansion, bounded child delegation and learned task-fit ranking described here are new work. Technical model metadata does not establish model quality.

## Goals, boundaries and alternatives

Goals: role-neutral delegation; explainable, configurable selection; account-aware model selection; automatic observation where supported; durable work lineage; safe concurrency; comparable review outcomes; complete CLI access.

Non-goals for the first release: autonomous changes to project policy, automatic purchase of capacity, universal model quality certification, unrestricted recursive delegation, an LLM making opaque dispatch decisions, or a complete visual graph editor. Pacer dispatches and supervises; agents remain responsible for planning and reviewing results. Human acceptance and merge authority remain unchanged.

Alternatives considered:

- Pure first-match runner ladder: easy to explain, but static ordering wastes live capacity among equivalent matches.
- One global weighted score: expressive, but competing objectives are difficult to predict and inspect.
- Selected approach: first matching strategy step chooses the candidate pool; a named ranking policy chooses within it. Explicit precedence remains visible while ranking handles changing capacity.

## Domain model

- Account: access reference, provider, usage observations and quota pools. Never contains copied native credentials.
- Model: provider-qualified identity, declared/observed technical capabilities, optional tier and strengths, provenance and freshness.
- Executor: an adapter/tool capable of launching selected models on a host.
- Runner: an authorized executor/account/host binding with allowed models, launch settings and concurrency limits. Existing fixed-model runners remain valid singleton choices.
- Candidate: a concrete runner/account/model combination, with capacity constraints and selection evidence.
- Task: goal, repository, acceptance criteria, requirements, optional preferences, dependencies and delegation policy.
- Attempt: one execution of a task on a concrete candidate. Retries are attempts, not new child tasks.
- Delegation edge: parent task requested a distinct child task. Each child has exactly one parent and a root; dependency edges may form a DAG across tasks within authorized scope.

Planner and executor are roles within a task relationship. An agent executing a parent can plan child work without becoming a globally reserved planner. Optional account reserves remain explicit strategy settings rather than blanket exclusion. Pacer does not silently grant delegation authority to arbitrary callers.

## Replaceable components and authoritative control

### Pacer control layer

The service owns task state, identity, authorization, hard policy constraints, candidate eligibility, quota accounting, atomic reservations, dispatch, cancellation and recovery. It supplies bounded decision inputs and validates every returned choice against current state before launch. No decision engine or observation adapter can authorize work, mutate task state directly, relax requirements, reserve capacity or launch executors. Configured preferences and ranking are distinct from non-bypassable control constraints.

### Observation adapters

Define a typed adapter contract before wiring provider implementations. Adapters report model inventory, capabilities, usage, quota-pool identity, health and actual-model evidence only for supported methods. Inputs contain explicit account/runner scope and access references; outputs use the common observation envelope with provenance, timestamps, expiry and uncertainty. Unsupported, unavailable and failed observations are distinct results. The host schedules refreshes, applies deadlines/backoff, validates and redacts results, and stores normalized observations.

Begin with adapters around existing readers/discovery code rather than embedding provider logic in the dispatcher. The contract must be serializable and transport-neutral so a later versioned plugin binding can expose the same methods without changing dispatch logic. Preserve existing plugin-owned implementations behind their plugin boundaries; do not reintroduce built-in fallbacks for extracted adapters. New observation providers should use the plugin binding when that capability is available. This stages adapter extraction before plugin exposure, without weakening ARCH-12/13 or the minimal-host principle.

### Decision engine contract

An engine receives a versioned, immutable decision request: task requirements/preferences and their provenance, eligible candidate IDs and model metadata, normalized observation snapshots, enforceable constraints, strategy configuration/revision, and decision deadline. Inputs use structured data and bounded summaries; secrets and unrestricted task transcripts are excluded. Pacer computes eligibility; an engine may narrow candidates but cannot add unauthorized candidates.

It returns a versioned proposal: an ordered list of candidate IDs, structured ranking factors and reasons, uncertainty, or an explicit abstention/no-match result. Pacer validates schema, unique known IDs, finite factors, required evidence references and deadline, then rechecks hard eligibility and reserves resources. Free-form engine explanations are untrusted display data, never instructions. Strategies must declare which engine-specific options they use; unsupported options are rejected rather than silently ignored. Queue/fail/fallback behavior belongs to explicit control configuration, not engine side effects.

The ladder is the default engine. A future decision model (for example Jev, subject to its actual integration interface) can replace the complete recommendation algorithm or implement a ranking component inside a ladder step. Both use explicit engine contracts, not calls hidden inside the dispatcher. Engines can run in-process initially or through a future versioned plugin/remote adapter; transport does not grant control privileges. The host retains routing orchestration and enforcement as required by ARCH-12. Any broader movement of host authority would require a separate governance decision.

Record engine ID, implementation/configuration version or hash, input snapshot/hash, output proposal, validation result, duration and fallback chain alongside the final dispatch decision. Model-backed engines record model identity and relevant inference settings when available. Recorded decisions remain auditable; replay of nondeterministic engines is not promised to reproduce outputs. Stable snapshots allow deterministic ladder replay and offline comparison of alternative engines.

Set bounded engine deadlines, input/output limits and fallback depth. Timeout, unavailable, malformed or invalid output cannot trigger a launch. Default failure behavior is queue with an explanation; falling back to the deterministic ladder is an explicit configurable policy and must preserve every hard constraint. Abstention and no-match are distinct from engine failure. No automatic repeated decision calls or paid remote inference without configured authorization and budget. Strategy preview uses the same engine contract and reports whether it is deterministic, cached, or model-backed; preview never launches execution, but decision inference may consume its separately configured budget. Engine swaps require compatible strategy configuration and validation/preview before activation; they do not alter task history or executor adapters.

## Default ladder selection algorithm

1. Normalize the brief and resolve repository policy, caller identity, task lineage, strategy revision and inherited limits.
2. Expand allowed runner/model combinations. Explicit model pinning narrows the set; it never bypasses requirements or permissions.
3. Apply hard eligibility: project permissions, executor/model compatibility, required tools/modalities/context, host health, authentication, hard quota limits, concurrency and delegation budgets. Unknown required capability cannot count as satisfied.
4. Evaluate strategy steps in declared order. Each step matches task attributes, filters candidates and declares capacity conditions. The first step with qualifying candidates wins. An empty step is skipped with reasons recorded.
5. Rank that step's candidates using its named policy, then a stable configured order and canonical candidate ID as deterministic tie-breaks.
6. Atomically reserve concurrency and any enforceable budget allowance. Recheck mutable eligibility before launch. If reservation loses a race, reevaluate remaining candidates against fresh state, with bounded retries.
7. Persist the decision and attempt before launching through the executor adapter. Record the actual resolved model when available.

Ranking policies include spare-capacity, configured preference, task-fit, burn-before-reset and cheapest-first. Composite ranking is lexicographic with an explicit ordered list of factors; arbitrary hidden weights are excluded initially. Existing ranking policies retain their existing semantics in legacy strategies.

A preview explains the selected step, candidate order, exclusions, observation freshness and uncertainties. Preview makes no reservation and may differ from dispatch as capacity changes. Every dispatch records its own decision snapshot.

## Strategy example and defaults

The following is proposed syntax, not accepted current configuration:

```yaml
version: 2
steps:
  - id: architecture-specialist
    match: { task_kind: architecture }
    require: { min_tier: medium, tools: true }
    prefer: { models: [provider/specialist] }
    candidates: { models: [provider/specialist] }
    capacity: comfortable
    rank: [task-fit, spare-capacity]
  - id: burn-codex
    match: { task_kind: coding }
    candidates: { executors: [codex] }
    require: { min_tier: medium, tools: true }
    capacity: comfortable
    rank: [burn-before-reset, task-fit]
  - id: capable-with-headroom
    match: {}
    capacity: comfortable
    rank: [task-fit, spare-capacity]
  - id: usable-fallback
    match: {}
    capacity: usable
    rank: [task-fit, spare-capacity]
on_no_match: queue
```

Task classification and requirements come from the requesting agent or explicit project defaults and carry that provenance. Missing task kind matches generic steps only; Pacer does not silently invent a tier requirement. Explicit project constraints and inherited task requirements take precedence over task preferences; step preferences refine task preferences only according to an explicitly declared strategy precedence, defaulting to step preferences then task preferences. Task requirements apply to every step, including generic fallbacks. `require` adds hard requirements; `prefer` affects ranking only, and `candidates` restricts the pool. A specialist-only step is what makes a specialist preference take precedence over later alternatives. The example illustrates available choices; the default template need not prefer Codex or any provider.

Capacity profiles are configurable predicates over relevant quota windows, reset times, reserve and estimated task demand. Initial suggested defaults (builder proposal): comfortable means fresh measured headroom of at least 20 percentage points in every applicable quota window after configured reserve; usable means no observed exhaustion and positive measured headroom after reserve. Estimated demand, when available, must also fit. Thresholds are heuristics, not guarantees; reactive or unknown usage cannot satisfy measured profiles. Unmetered resources qualify when health/concurrency are known and no other quota constraint applies. Unknown capacity requires an explicit fallback step, disabled in the default template. Reserve defaults to zero unless configured. Profile definitions and measurement age are visible in preview.

No-match actions are queue or fail with a structured explanation; user intervention can supply a new strategy or relax a preference. Hard requirements are never relaxed automatically. A queued task subscribes to relevant capacity/configuration/health changes, reevaluates at reset or cooldown deadlines, and has configurable expiry and cancellation. Queue reevaluation must avoid busy loops and starvation through stable enqueue ordering within configured task priority.

## Model metadata and account selection

Tier is optional configurable metadata: small, medium, frontier, or unknown. It is an ordinal routing label, not parameter count, cost, or independently proven quality. Strengths are separate task tags. Technical capabilities (tools, modality, context/output limits) remain separate hard facts. Metadata belongs to a concrete model, with runner-specific overrides for execution differences.

An account declares allowed models; discovery can populate suggestions or refresh observed availability but cannot expand an administrator's allowed list automatically. An explicit opt-in discovery policy can allow newly discovered models within configured provider/capability constraints. Exact model IDs are preserved; aliases and automatic model selection are marked unresolved until execution evidence identifies the actual model. Unknown tiers cannot satisfy a minimum tier. User-supplied tier/strength declarations remain usable but visibly declared rather than measured.

Quota pools attach to the provider's actual accounting boundary: account-wide, model-specific or shared group. A candidate must satisfy all applicable pools. Three models sharing one subscription do not provide three independent budgets. Reservations for concurrent launches use the same shared pool. Where demand cannot be measured or reserved precisely, Pacer records uncertainty and enforces observed hard limits and configured admission ceilings; it does not promise prevention of provider-side exhaustion.

Fallback between models is a new attempt with its own explanation and accounting. A pinned model fails or queues rather than silently changing. Remote runners follow existing SSH execution and verified bundle acceptance boundaries.

## Automatic observation and learning

Discovery and usage readers implement the observation adapter contract described above; versioned plugin capabilities can expose that contract later. Existing plugin capabilities remain plugin-owned. The host owns dispatch orchestration and admission, while the selected decision engine supplies recommendations. Adapters report supported observation methods, scope and errors. Pacer never reads or copies native credentials; approved APIs/CLI metadata and existing usage adapters supply observations.

Each observation records value, source, account/model/pool scope, observed time, expiry, confidence and error state. Keep observed data separate from overrides. Configuration wins over inference for policy labels; an override cannot turn an observed hard limit into permission to launch. Stale model availability is uncertain rather than proof of removal; confirmed removal blocks new launches without erasing history.

Observe model lists, technical capabilities, usage/limits, health and actual executed identity where supported. Unsupported facts stay unknown. Refresh on bounded schedules, relevant failures and explicit requests, with backoff and rate limits. Provider discovery is not proof of account entitlement; authorization or launch failures update eligibility.

Learning uses task kind, declared difficulty, review outcome, attempts, time, measured usage and provenance. Separate human review, requesting-agent review, automated validation and executor self-report. Unreviewed completion is not success. Do not compare token counts as a universal cost or quality measure; report missing measurements and separate task difficulty and executor/model settings.

Initial learning is advisory and explainable. Proposed conservative defaults: task-fit uses configured strengths until at least 20 independently reviewed comparable attempts exist for a model/task category; learned ranking requires opt-in and displays sample size, recency and uncertainty. This threshold is a configurable starting heuristic, not statistical proof. No automatic tier promotion, strategy edits or exploration spending. Historical decisions remain reproducible from recorded evidence even as rankings evolve. Users can disable learning, exclude projects and reset derived aggregates without rewriting task history.

## Delegation lifecycle and controls

Child creation requires an authenticated, service-issued task/attempt-scoped delegation grant. The service derives caller/parent/root identity; caller-supplied IDs cannot impersonate another task. Installers expose the same delegation contract to supported agents, while the service checks authority across every transport. Grants expire/revoke with the attempt and permit only the allowed repository, task subtree and operations. Children inherit the intersection of parent/project permissions and remaining root limits; they cannot broaden them.

Proposed initial defaults: child delegation explicitly enabled per root task, maximum depth 3, maximum 20 descendant tasks and at most 4 concurrent attempts per root, further constrained by account/runner limits. Users can configure these; bounded finite limits are mandatory. Enforce count/depth/concurrency transactionally. Cost or token ceilings are hard only when reliably measurable; otherwise use admission bounds and label the financial ceiling unenforceable. Descendants cannot reset root budgets.

Reject dependency cycles, self-dependency and invalid lineage. Request idempotency keys prevent duplicate children on retries; advisory similarity warnings identify likely repeated goal delegation without blocking legitimate similar work. A parent waiting on a child releases execution capacity only when the adapter supports suspend/resume; otherwise admission must avoid waiting-parent deadlock by queueing/rejecting child requests that cannot make progress and explaining the limitation. Parent completion requires required children to reach accepted or explicitly waived outcomes; child completion alone does not accept a parent.

Parent stop revokes grants and cancels queued/running descendants by default. Terminal parents cannot create children; late results are retained as canceled-attempt evidence and do not resurrect work. Failed children leave parents needing a decision or following an explicitly configured bounded retry policy. Worktree isolation and acceptance prevent concurrent children from blindly overwriting a shared checkout; dependency order and merge/conflict handling remain explicit. An agent may request review, but cannot certify its own result as independently reviewed.

## Durable history and future visualization

Persist tasks, attempts, delegation/dependency edges, grants by reference, decision snapshots, observations by reference, reviews and append-only lifecycle events in service-owned durable storage. Task metadata and its event are committed together. Events have stable IDs and service sequence numbers; clients reconnect using cursors and resnapshot after retention gaps. State mutations use revisions/conflict errors; delegate requests have idempotency keys. Restart reconciliation marks lost/unknown attempts honestly and never launches duplicate work solely because the service restarted.

Decision snapshots include strategy revision/hash, matched/skipped steps, candidate identities and exclusions, ranking factors, observation timestamps, overrides and reservations. Preserve both requested and actual model. Store bounded summaries, not secrets or unrestricted raw provider responses. Retention/deletion must preserve referential integrity: pruning a subtree explicitly reports impact, keeps required ancestry summaries or removes the whole authorized scope, and does not silently break live dependencies. Existing task-retention behavior needs a migration decision before implementation.

The first usable view is CLI tree plus task detail/timeline. Later API-driven web/TUI/desktop views show root-to-child delegation, dependency links, selected models and reasons, active/waiting/blocked work, retry history, reviews and measured usage. Aggregate root usage without counting child totals twice. Queue wait, execution time and time waiting on dependencies are separate. UI graph layout is a later design task; the data contract is in scope now.

## Service and protocol boundaries

Add core operations/events before clients. Proposed operation families: model inventory/observations, dispatch preview, delegation with task requirements/preferences, task tree/dependencies and decision detail. Extend existing task operations where compatible rather than introducing a parallel task system. All supported surfaces use the same authoritative engine; MCP does not implement separate ranking or permission rules. CLI/TUI remain complete.

API changes should be additive, with generated schemas/docs and freshness tests. Preserve existing fields and fixed-model runner behavior. Legacy strategies retain existing ranking until explicitly migrated. Retain the legacy planner setting as a compatibility/default-session concept during transition; only an opted-in bounded delegation policy removes the old planner-account exclusion for that work. Older clients can display tasks without understanding lineage; they cannot accidentally enable recursive delegation. Removing or renaming contracts requires the existing major-version and compatibility-window process.

## Governance and adoption

Context: constitution 0.12.0; applicable P1–P6/P8–P15, ARCH-1–5/7–9/12–14, API-1–6, REPO-1–3/9–10. Security and code/testing rules apply to implementation; UI rules apply when visual clients change. Current canonical sources are `.project/constitution.md`, `.project/context.md`, `.project/rules/architecture.md`, `.project/rules/api-protocol.md`, `.project/rules/repository.md` and `.project/reviewers/architecture.md`.

Conflict requiring explicit amendment: API-5 currently refuses delegation inside executor sessions. Adoption must amend that clause to permit service-authorized bounded child delegation while preserving the prohibition on free-form shell API operations. Update the constitution/decision log and canonical protocol/security documentation through the constitution's amendment process. This design does not waive or silently alter API-5. Record the durable dispatch architecture in an ADR alongside adoption; existing historical ADRs remain clearly scoped. No unresolved governance exception is assumed.

## Delivery slices

1. Adopt ADR/rule amendment and additive domain contracts; define observation adapter and decision engine interfaces; preserve legacy routing; introduce model inventory/provenance and explicit allowed-model bindings.
2. Implement candidate expansion, the ladder behind the replaceable decision engine contract, capacity profiles, shared quota-pool accounting/reservations, atomic admission and explainable preview/decision snapshots; retain fixed-runner compatibility. Verify replacement using a contract-conforming test engine.
3. Add bounded task-scoped delegation, lineage, dependencies, idempotency, cancellation, restart recovery and isolated acceptance; expose CLI tree/timeline.
4. Expand supported observation adapters, actual-model evidence and quota-pool discovery; expose adapters through versioned plugin capabilities without changing control/decision consumers. Shared accounting already exists in slice 2; unsupported surfaces remain explicit.
5. Add advisory task-fit analytics, then opt-in learned ranking after sufficient review evidence.
6. Design and implement visual delegation/dependency views using the same API, with required UI/accessibility and live evidence.

Each slice must deliver usable behavior and its scoped documentation, tests and review; this sequence is a design proposal rather than an implementation plan. No implementation begins before design approval.

## Validation and acceptance

Design acceptance: a builder can identify entity ownership, routing precedence, fallback behavior, observation uncertainty, security boundaries and migration requirements without guessing the core product behavior.

Implementation acceptance includes deterministic ladder/tie tests; hard requirements preserved through fallback; shared quota and multi-client reservation races; stale/unknown observations; fixed-model compatibility; alias/actual-model mismatch; denied/forged grants; depth/count/budget boundaries; dependency cycle and deadlock handling; duplicate requests; parent cancellation and late results; recovery after restart; no double-counted aggregates; and reproducible decision explanations. Verify engine replacement without task/executor changes; unknown/forged candidate IDs; engine timeout, malformed output, abstention and configured fallback; adapter failure/staleness isolation; equivalent normalized observations across direct and plugin transports; and explicit accounting of model-backed decision calls. Compare legacy strategies against existing routing fixtures.

Follow `.agents/skills/project-review/SKILL.md` for independent scoped review and final-revision re-review. Runtime changes require `bun run live` per `docs/testing/live-validation.md` (CT-11), with real supported executors, evidence summaries and explicit UNVERIFIED surfaces. Remote live checks require the established separate approval. Visual clients need applicable UI evidence/reviews. This document alone changes no runtime behavior, so live execution is not applicable to the design-only delivery.

## Builder decisions proposed for approval

The specific tier vocabulary, capacity thresholds, learning sample threshold, root delegation opt-in and default delegation bounds above are proposals made in this design, not previous user commitments. Accepting the design accepts these as initial configurable defaults. Provider-specific discovery and usage coverage will be enumerated during implementation planning; no universal discovery/usage support is promised.

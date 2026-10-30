# Tier-aware routing and required task difficulty

Date: 2026-10-29. Status: proposed, awaiting the maintainer's approval. Applies to: model inventory, dispatch ranking and learning, delegate briefs, CLI/API/MCP submission, strategy configuration, doctor, task records and route explanations. This document changes no runtime behavior.

Builds on:
- [Intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md) and [ADR 0006](../decisions/0006-intelligent-work-dispatcher.md).
- [Dispatcher settings](2026-10-26-dispatcher-settings-design.md) and [route explanation](2026-10-28-route-explanation-design.md).
- [Planner session dispatch](2026-10-27-planner-session-dispatch-design.md).

Governance: constitution 0.17.0; P1/P3/P4/P9, API-1–4/API-6, CT-11 and REPO-1–3/REPO-10 apply. REPO-11–14 remain proposals under amendment 0.15.0; the records below support REPO-13 without claiming its adoption. Implementation and protocol review remain separate from approval of this design.

## Problem

A planner cannot reliably request the smallest capable model. `requirements.minTier` is a hard floor, not a target: allowing `small` also allows `medium` and `frontier`. After eligibility filtering, tier has no effect on ranking. A frontier model with more headroom can therefore win a trivial task.

Making `minTier` mandatory would create a different failure. Models without a declared tier are `unknown`, below `small` in the floor comparison. Every possible floor excludes them, including existing runners that use an executor's default model. Requiring a floor would break those configurations without making the resulting choice cheaper.

Difficulty already participates in learned fit, but omitted values silently become `standard`. Explicitly labelled standard work and work whose difficulty nobody supplied are indistinguishable. That weakens the meaning of the learning cohorts; it does not establish how many existing tasks were explicitly labelled.

## Current behavior

These are implementation facts, rather than guarantees introduced by this proposal:

| Source | Behavior today |
|---|---|
| `src/dispatch/candidates.ts` | `meetsRequirements` compares `unknown: -1`, `small: 0`, `medium: 1`, `frontier: 2`. It checks an optional floor, tools and context. Candidate construction also checks runner availability, exact model pins, fresh health observations and exhausted quota. Capacity is known only with positive health and sufficient usage evidence; unknown capacity has null headroom. |
| `src/dispatch/inventory.ts` | Inventory projects explicitly permitted runner models. A legacy `runner.model` gets an exact binding with unknown tier; a runner with no model declaration gets an executor-default binding with unknown tier. Opted-in discovery adds only allowlisted models and gives them unknown tier. Capability and actual-model observations enrich records, but do not establish a tier. |
| `src/dispatch/types.ts` | Model declarations default their tier to unknown. Requirements expose optional `minTier`; there is no target-tier setting. Decision tasks allow optional difficulty, while `previewInputSchema` does not expose it. Default ladder steps are comfortable capacity, then usable capacity. |
| `src/dispatch/ladder.ts` | The first qualifying ladder step wins. Reserve and capacity thresholds filter candidates. Model preferences precede the configured rank factors; these can include strengths/task fit, learned fit, spare capacity, burn before reset and cost. Stable candidate ID breaks ties. No rank factor compares tier. Unknown tier alone does not push a candidate to the bottom; its numeric ordering is used for floor filtering. |
| `src/dispatch/work.ts` | `workOptionsSchema.difficulty` defaults to standard. Child work inherits hard requirements, including a floor that it cannot lower. Difficulty is not such an inherited hard requirement. |
| `src/core/dispatch.ts` | Preview obtains eligible runners, observations and inventory, builds candidates, applies learned fit and invokes the configured engine. It uses dependency-supplied difficulty or standard. Plugins can replace the ladder; invalid or timed-out decisions follow the configured engine fallback. Preview reserves nothing. |
| `src/dispatch/learning.ts` | Reviewed outcomes are grouped by kind, difficulty, runner, actual model and settings hash. Learning is off by default; when enabled, it requires a known actual model and enough comparable recent reviews (default 20 within 90 days). Learned fit affects the ladder's task-fit factor. |
| `src/tasks/api.ts`, `src/tasks/types.ts` | Delegate input accepts `dispatch` options, but has no top-level difficulty field; the stored `Brief` interface has none either. Difficulty can be supplied as `dispatch.difficulty`. Adding an unrecognized top-level field today does not make it reach the work options. |

`routing.route` is currently executor/kind ranking, not model-aware dispatch. `dispatch.explain` distinguishes the delegate and dispatch paths. The implementation must preserve that distinction until the paths share tier selection; it must not attach a tier promise to an executor-only recommendation.

## Goals

1. Prefer the lowest declared tier that meets the task's target and has usable headroom, with larger models available as fallback.
2. Require an explicit difficulty for planner delegations after a staged migration, including delegate briefs and child work.
3. Keep undeclared-tier configurations usable where no hard floor requires proof, and explain the uncertainty.
4. Record the request, selection and actual execution separately so a reviewer can assess the model choice.

Non-goals: inferring capability from a model name, guaranteeing price from a tier, changing budget/slot/security gates, automatically downgrading below the target, or replacing learned fit. A small model can have a higher observed price than another model; tier expresses the strategy owner's capability/cost policy, not a provider billing contract.

## Selection policy

### Difficulty sets the target

The default mapping is:

| Requested difficulty | Target tier |
|---|---|
| `simple` | `small` |
| `standard` | `medium` |
| `complex` | `frontier` |

Add `dispatch.tierTargets` to strategy configuration, with these three keys and declared-tier values only. Partial configuration fills missing keys from the defaults; unknown keys or `unknown` values are invalid. Require the mapping to be nondecreasing, so complex work cannot target a lower tier than simple work. Strategy preview shows the effective mapping and changed choices before saving it.

`requirements.minTier` stays an optional hard floor, including inherited child floors. The effective target is the higher of the mapped target and that floor. A simple task with `minTier: frontier` therefore targets frontier. A floor never becomes a ceiling or a mandatory field.

### Precedence and fallback

1. Apply existing authorization, project policy, capability, health, quota, reserve, slot and enforcement gates. Tier policy cannot admit an otherwise excluded runner or model.
2. Honor explicit model/executor selection before automatic tier preference, subject to those gates and hard requirements. A pin may intentionally select below the difficulty target, but cannot bypass `minTier`, tools or context. Keep any existing executor-fallback contract visible; do not silently choose a different executor because its tier is preferable. Contradictory model/executor pins return an actionable input error.
3. For automatic selection, consider declared tiers at or above the effective target in ascending order. Within each tier, apply the configured ladder steps and their capacity gates. A candidate must have positive usable headroom after reserve to qualify as a known-capacity choice. Prefer a usable small candidate over a comfortable frontier candidate for a small target. Move to a higher tier only when the lower tier has no qualifying candidate.
4. Within the selected tier and ladder step, retain configured preferences, learned fit, headroom, burn, cost and deterministic tie-breaking. Neither model preferences nor learned fit silently promote a different tier. An intentional exact model choice uses a pin.
5. Only after the declared tiers have no available choice, consider unknown-tier candidates under the compatibility rule below. Keep unknown capacity distinct from unknown tier: an explicitly configured unknown-capacity step remains necessary for the former. Exhausted or reserve-blocked candidates never qualify through either fallback.

This deliberately changes the current global first-step behavior: tier preference comes before comfortable-versus-usable selection, while step ordering remains meaningful inside a tier. Custom strategies that previously used preferences or step order to promote a frontier model must use an explicit pin or change their target mapping if that is their intent.

Example: a simple task sees small at 25% headroom and frontier at 80%. If both satisfy the reserve and capability requirements, small wins. If small has no usable headroom, frontier can run and the decision records an upward fallback. If the request is complex and only small is declared, pacer does not silently downgrade it.

### Unknown tiers and rejection

An unknown tier is missing evidence, not evidence of a small model. It cannot satisfy a hard floor. With no hard floor, retain unknown-tier runners as a final compatibility fallback and label the result `tier unverified`; do not relabel them as meeting the target. This includes all-unknown legacy configurations and cases where declared target-capable runners are temporarily unavailable. Prefer any available declared target-capable candidate over an unknown one.

A tier-related permanent rejection is appropriate only when no permitted declared model can meet the effective target or hard floor and no permitted unknown-tier compatibility fallback can be used. Declared models below the target do not satisfy it. If suitable declarations exist but capacity, health or slots temporarily prevent execution, use the existing queue/fail strategy policy and report the operational reason, rather than claiming that the model tier is unsupported. Existing security, invalid-input and other hard-requirement rejections still apply.

An unsatisfiable request returns a structured `CoreError` using the documented error envelope, with the requested difficulty, effective target, optional floor and excluded inventory summary. Its hint names a concrete remedy: declare a suitable model tier in `runners.<id>.models`, enable a permitted suitable runner, choose a justified different difficulty, or use a deliberate pin. For a floor that excludes unknown models, explicitly say that their capability cannot be verified and that declaring their tier is required. Never suggest removing an inherited floor.

## Difficulty input and migration

### One field across entry points

Add top-level **`difficulty`** to the delegate JSON brief schema: `simple | standard | complex`. Carry it through `parseDelegateBrief`, `DelegateInput`, the stored brief and managed work options. Add `--difficulty` to `pacer delegate`; flags override the corresponding file value. A planner can write:

```json
{
  "goal": "Document the routing policy",
  "kind": "docs",
  "difficulty": "standard",
  "source": "planner"
}
```

Keep `dispatch.difficulty` as a compatible alias for existing delegate clients. Equal values in both locations are accepted; conflicting values are rejected with a hint to provide one value. Do not silently let a default mask an explicit value. New documentation and installed planner instructions use the top-level field.

`dispatch.submit`, `dispatch.child`, previews, explanations and their CLI/API/MCP schemas expose the same difficulty enum in their native options. The executor-scoped MCP delegate tool must forward difficulty to child work as well. Every child receives its own explicit label; it does not inherit its parent's difficulty, since a complex parent may delegate a simple lookup. Existing grant limits and inherited hard requirements remain unchanged.

Apply validation in the service's common submission path, before task creation or launch, not only in a CLI flag parser. Resolve caller origin through the established caller/session context, preserve it through daemon forwarding, and treat granted child work as agent-originated. A planner must not evade the requirement by submitting a bare API request or claiming `source: cli`. Interactive UI/CLI defaults require a trustworthy human-origin path; unresolved machine/API/MCP origin follows planner validation. This is input provenance, not a new authentication mechanism.

### Release A: warn and preserve omission

For one announced release, planner-originated omission is accepted with a structured warning naming the field, valid values and enforcement release. CLI warnings go to stderr; JSON results and API/MCP clients receive structured diagnostics without corrupting stdout. Record the requested difficulty as **`unspecified`**, rather than writing standard into the request record.

For routing compatibility only, omitted difficulty uses an effective standard value and the configured standard target. Record that this was defaulted. `unspecified` is a stored provenance state, not a fourth caller-selectable difficulty. It must remain separate from explicit standard work in analytics and must not train explicitly labelled difficulty cohorts.

Human UI/CLI submissions may continue to default to standard, but record `requestedDifficulty: unspecified`, `effectiveDifficulty: standard` and a human-default origin. A user who selects standard explicitly is distinguishable from that default.

Update installed planner instructions, examples and generated tool schemas during this release. Report warning counts so operators can find integrations that still omit the field. Existing queued tasks and retries retain their original omission/provenance; do not invalidate them retroactively.

### Release B: enforce for planners

In the following release, reject new planner-originated delegations and agent child submissions without explicit difficulty. Return an input error before creating a task, reservation or worktree, with examples for the top-level delegate field and native dispatch options. Pins do not waive this requirement: the label is also learning and review evidence.

Human UI/CLI defaults remain allowed. Read-only previews may explain a defaulted draft and show the missing label; a successful preview is not submission authorization. Retries of existing tasks retain their recorded label; newly created child tasks require their own label.

## Tier declaration diagnostics

Config load emits bounded, deduplicated warnings for unknown tiers in explicit model lists, legacy single-model runners and executor-default bindings. Warnings identify the runner/model binding and the declaration to add; they do not fail an otherwise valid configuration or rewrite it. `pacer doctor` reports the same inventory gaps and whether the default target mapping can be satisfied by declared models.

Discovered or observed actual models do not acquire a tier from their names. An observed actual identity can use an existing explicit declaration for that same authorized binding; otherwise it remains unknown. Doctor suggests declarations but never grants model permission through discovery.

Route and explain results expose requested difficulty, effective target, selected declared tier and a structured reason for upward or unknown-tier fallback. Distinguish `no declared tier meets target`, `target tier has no usable capacity`, `unknown model tier`, `unknown capacity` and `explicit override`. A route that only ranks executors says target evaluation was not performed; when tier inputs are supplied, route must use the shared model-aware dispatch policy. CLI, API, MCP and explain must not implement competing tier comparisons. Explain retains its read-only guarantee and cached-preview uncertainty.

Plugin decision engines receive the same normalized target and candidate policy. The host checks that an automatic choice respects the currently eligible tier bucket; an out-of-policy choice is invalid and follows the configured engine fallback. A plugin cannot silently restore tier-blind ranking.

## Records and reports

Persist intent at submission and snapshot the decision per attempt. Proposed names below are additive metadata; implementation must carry them through task summaries, work trees, API read models, events and executor reports rather than leaving them only in a raw decision blob.

| Field | Meaning |
|---|---|
| `requestedDifficulty` | Explicit enum value, or `unspecified` when omitted |
| `difficultySource` | Explicit request, human default, migration default, or legacy unknown |
| `effectiveDifficulty` | Value actually used for routing |
| `targetTier` | Effective mapped target after the optional floor |
| `selectedTier` | Tier declared for the selected binding, including unknown |
| `actualTier` | Tier corresponding to the model observed to run, or unknown |
| `tierReason` | Target match, upward fallback, unknown-tier fallback or explicit override, with structured causes |

Keep requested model, selected binding and observed actual model identity alongside these fields. `actualTier` is unknown until execution evidence supports the identity and its authorized declaration; selection alone is not proof of what ran. Record declaration provenance and the strategy/mapping revision used by each attempt, so later configuration changes do not rewrite history. Retries may select a different tier and need separate snapshots.

A report can then say: “standard requested; medium targeted; frontier selected because medium had no usable headroom; frontier observed.” For an executor-default binding with no identity evidence it instead says: “actual model/tier unknown.” This supplies the chosen executor/tier and fallback evidence for proposed REPO-13. The planner still supplies the reason the task needs its difficulty; pacer does not infer that justification from success.

Retain existing learning sample, age, review-provenance and settings safeguards. Include target-policy identity in learning comparability where policy changes affect cohorts. Historical standard rows cannot reliably be separated into explicit and defaulted labels: mark their provenance legacy unknown, preserve the original data, and keep them out of newly labelled difficulty cohorts unless explicit input evidence exists. Do not silently relabel old tasks as simple or complex.

## Compatibility and protocol changes

Release A adds input fields, strategy settings, diagnostics and record metadata. Follow P4/API-1: old readers ignore unknown result fields; old records remain readable with unknown provenance. Audit strict schemas and generated clients, since accepting new metadata cannot be assumed from a TypeScript interface alone. Expand internal records with provenance fields rather than adding `unspecified` to an existing public three-value difficulty enum in place.

Release B makes a previously optional planner input required, a breaking contract even though its field name is unchanged. Ship the requirement under a new protocol major and serve the preceding major for one pacer minor release through the compatibility adapter, as P4/API-2 require. The old-major adapter retains Release A's warn-and-record behavior during that window; it must not pretend its omitted label was explicit. Publish exact release numbers and the adapter retirement release in the changelog before enforcement. A warning release alone is not permission to break the current major.

Version or negotiate the plugin decision contract where strict plugin schemas cannot accept the new target policy. Older engines must either receive a documented compatible request constrained by the host or be reported incompatible; do not send a silently changed enum to them. Regenerate protocol documentation, schemas, Rust types and MCP tool declarations from their sources, with freshness checks (API-3/P11). This design does not hand-edit those artifacts.

The default tier mapping changes automatic choices even for clients that keep working. Document that behavior in configuration/executor guidance and the changelog (REPO-7). Existing pins, hard floors and explicit permission boundaries remain authoritative. The implementation must cover both delegate and managed dispatch paths before claiming tier-aware routing across the product.

## Alternatives considered

- **Mandatory `minTier`: rejected.** A floor still lets frontier win simple work; it cannot express “prefer small.” Unknown-tier runners fail every floor, and callers would need to learn inventory details merely to submit a task. It also confuses capability requirements with spending preference.
- **Cheapest-first ranking alone: rejected.** Cost observations can be absent and subscription burn is not a universal model price. Price cannot replace a capability target, and a configurable rank factor can still be outranked by preferences or fit.
- **Infer tier or difficulty automatically: rejected as the default.** Model names and goal text do not supply dependable declarations. Silent inference would repeat today's provenance problem. A future suggestion may help a person choose a label, provided acceptance is explicit and recorded.
- **Reject every unknown-tier runner immediately: rejected.** It breaks legacy and executor-default configurations. Warnings plus a visible, constrained compatibility fallback allow incremental declarations without claiming their tier is verified.
- **Use tier only as the final tie-breaker: rejected.** Better headroom would still select a frontier model for trivial work. Tier must precede ordinary automatic rank factors to deliver the intended policy.

## Test plan

1. Pure selection tests cover all default mappings, partial configuration, invalid/nonmonotonic mappings, floors above targets, all tier pairs and deterministic ties. A usable target-tier candidate beats a comfortable higher tier; a blocked target tier permits upward fallback. Learned fit and preferences cannot cross the tier bucket.
2. Inventory and diagnostics tests cover declared tiers, omitted tiers, legacy single-model runners, executor-default bindings, permitted discovery and actual-model observations. Unknown tier and unknown capacity have independent outcomes. Warnings neither rewrite configuration nor grant access.
3. Rejection tests distinguish permanently insufficient declarations from temporary capacity/health/slot failures; cover all-unknown compatibility routing, unknown excluded by a floor, below-target-only inventory and actionable hints. Exercise configured queue/fail behavior separately from invalid input.
4. Input tests cover brief-file and flag precedence, both difficulty locations, conflicting aliases, API/MCP and scoped child tools. Release A records unspecified and warns; Release B rejects missing planner/child labels before side effects. Human defaults, forwarded caller origin and attempts to claim a false CLI origin receive explicit coverage.
5. Pin tests cover below-target overrides, hard-floor conflicts, mismatched model/executor pins and the existing executor-fallback contract. Child tests preserve inherited floors while allowing a simpler explicit difficulty.
6. Persistence and learning tests cover reloads, legacy reads, retries under changed strategies, observed model mismatch, absent actual identity and report/summary projection. Unspecified and legacy-default reviews cannot contaminate explicit standard cohorts.
7. Contract tests cover previous-major compatibility, old clients, generated artifact freshness and plugin decisions that violate tier policy. Explain/dispatch parity tests compare the same snapshots and prove explain performs no writes, probes, reservations or launches.

Run affected tests and the repository's required checks for the implementation; do not treat this proposed matrix as executed evidence.

## Live validation (CT-11)

This docs-only change is exempt from live execution. The implementation is not done until it passes [the live-validation harness](../testing/live-validation.md) with evidence for every affected surface.

1. Start an unseeded sandbox with `bun run live up --id tier-routing`. Use only its disposable repository and strategy; never the operator's real pacer state or checkout. Declare tiers for installed, permitted executors in that sandbox. Use the public guarded CLI/API path.
2. Preview and explain simple, standard and complex requests with competing declared tiers. Submit small real delegations to verify that the model which runs matches the recorded target/selection. Record unavailable tiers as UNVERIFIED; synthetic observations can prove ranking logic, not real launch behavior.
3. Exercise target-capacity exhaustion, upward fallback, unknown-tier compatibility and an impossible declared target. Inspect doctor/config warnings, structured errors and queue behavior. Compare cached explain output to admission-time decisions and account for changed observations.
4. Exercise delegate briefs, CLI flags, API and MCP, including a granted child, Release A omission warnings and Release B rejection. Verify no task or worktree is created on rejected input. Confirm human default handling and previous-major compatibility separately.
5. Inspect task details and reports through affected TUI, web/tray and desktop surfaces, including unknown actual tier and retry history. Any changed presentation also needs applicable UI evidence; an unchanged client surface can be marked not applicable with a reason. Do not claim API inspection proves native presentation.
6. Run `bun run live report --id tier-routing`, then `bun run live down --id tier-routing --keep`. Retain the evidence report under `.work/live/tier-routing/evidence/report.md`, name the reviewed revision and real executors/models, and summarize PASS/FAIL/UNVERIFIED per behavior in the result and PR. Missing executor availability, guarded operations or unexercised surfaces remain UNVERIFIED; do not bypass harness guards.

Before delivery, obtain independent project review of the implementation and final fixes under REPO-10, including protocol compatibility and QA criteria. Design approval does not waive live evidence or the maintainer's merge decision.

## Open questions

- Which exact releases are A and B, and which release retires the preceding protocol major? Publish these before warning messages promise a deadline.
- Should a later strategy option disable unknown-tier compatibility fallback after operators complete declarations? This proposal keeps it enabled without a hard floor and always visible.
- Should strategies eventually support targets per task kind as well as difficulty? The first version uses one mapping to keep planner labels comparable.
- What evidence should verify the actual tier for executor-default bindings that report an actual model but have no matching explicit model declaration? Until decided, report unknown rather than infer it.
- Which plugin protocol capability/version advertises target-policy support? Host validation is required regardless of the chosen negotiation mechanism.
- Should tier-aware `routing.route` return model candidates directly or link to dispatch explanation? Either choice must preserve the existing executor-only contract and avoid two ranking implementations.

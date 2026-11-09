# Executor model management and difficulty-based model choice

Date: 2026-11-09. Status: approved 2026-11-09. Applies to: strategy configuration (`runners.<id>.model`, `runners.<id>.models`, `dispatch.tierTargets`), model discovery per agent, Settings › Executors and Add executor, delegate and managed dispatch, runner checks, diagnostics, CLI/API/MCP. This document changes no runtime behavior.

Design canvas (private to the maintainer): Executor model management, 2026-11-09.

Builds on:
- [Tier-aware routing and required task difficulty](2026-10-29-tier-aware-routing-design.md). This design is its user-facing half and its first implementation slice; it does not restate that design's selection rules.
- [Intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md) and [dispatcher settings](2026-10-26-dispatcher-settings-design.md).
- [Route explanation](2026-10-28-route-explanation-design.md).

Governance: constitution, P1/P3/P4, API-1–4, CT-11 and REPO-1–3/REPO-10 apply. UI changes follow the design canvas and the UI evidence gate.

## Why

The maintainer added an OpenCode Go executor and could not use it: its model was missing, and no screen let them pick another (fixed narrowly by `fix/opencode-agent-model`). The fix exposed the general gap. The maintainer wants pacer to:

1. control which model each executor uses, per provider and per executor;
2. select and update that default model at any time, from the screen where executors are managed;
3. choose a model per task from the task's difficulty, so simple work runs on small models and complex work on frontier models.

Today the model is decided once, at setup, and then read-only. Runners can already declare several models with tiers (`runners.<id>.models`), and managed dispatch can launch a chosen model (`selectedDispatchModel` in `src/tasks/runner.ts`). No interface shows or edits those declarations, the delegate path never picks a model per task, and nothing checks whether a model is still served.

## Goals

1. **One place per executor** shows its default model, the models it may use, each model's tier, and whether each is currently valid; all of it is editable there.
2. **A model is always one the provider serves.** Pickers list live models; saved models that disappear are flagged with a one-click replacement, never left as a silent failure.
3. **Per-task model choice by difficulty** on both delegate and managed dispatch paths, using the tier-aware routing policy: difficulty → target tier → the cheapest declared model that meets it, with visible upward fallback.
4. **Explain every choice**: tasks, reports and route explanations name the requested difficulty, target tier, chosen model and why.

## Non-goals

- Inferring tiers or capability from model names. Tiers are declared by the user; the UI may *suggest* one from catalog facts, and accepting it is explicit.
- Automatic difficulty inference from goal text. The planner labels difficulty (tier-aware spec, Release A/B).
- Price guarantees from tiers, or replacing budget, quota, reserve and slot gates.
- Editing provider keys. OpenCode keeps its keys; pacer never sees them.

## Anti-goals (would count as failure even if it works)

- An executor that saves a model the provider does not serve, or keeps failing on one without saying so.
- A second, competing tier comparison in the UI or CLI. All surfaces read the one dispatch policy.
- Model choice that a reviewer cannot reconstruct afterwards.
- Making existing configurations stop working: undeclared tiers stay usable as the visible compatibility fallback.

## Concepts and configuration

No new configuration shape. The existing fields gain an interface and a meaning the user can see:

| Field | Meaning | Edited from |
|---|---|---|
| `runners.<id>.model` | **Default model.** Used when nothing more specific is chosen, for the runner check, and by executor-only routes. | Executor › Models › Default |
| `runners.<id>.models[]` | **Models this executor may use**, each `{id, tier, strengths?, tools?, context?}`. When present, per-task selection chooses among these. The default must be one of them (enforced on save). | Executor › Models › list |
| `dispatch.tierTargets` | Difficulty → tier mapping (`simple→small`, `standard→medium`, `complex→frontier` by default), per the tier-aware spec. | Settings › Dispatcher › Model choice |

A runner with only `model` behaves exactly as today. A runner with `models` but no `model` takes the first listed model as its default when saving (the UI always writes `model` explicitly).

**Granularity.** Providers supply the *available* list; executors own the *allowed* list and default. Two executors on one provider (for example two OpenCode Go executors) may allow different models. Account-level settings (usage type, cap) are unchanged.

## Model sources per agent

A new read operation `executor.models.available {runner}` returns `{models: [{id, context?, output?, tools?, costIn?, costOut?, release?}], source, fetchedAt, note?}`. One adapter per agent kind:

| Agent / account | Source of truth | Facts from |
|---|---|---|
| OpenCode, `source: opencode` | `opencode models` filtered to `<provider>/` (as `opencodeModelIds`) | models.dev catalog entry, when present |
| OpenCode, managed endpoint (`connection`) | `connection.models` (plus endpoint discovery when the endpoint lists models) | declared connection facts |
| OpenCode, local server | endpoint discovery | discovery |
| Claude Code, Codex, Cursor, Antigravity | the agent CLI's own model listing where one exists; otherwise a short curated list shipped with pacer | catalog where it matches |
| Anything else | none: the UI accepts a free-text model id | — |

The live listing wins over the catalog: catalog-only models are never offered (the fix shipped this for setup). Results are cached per runner with a short TTL and a manual refresh; a failed listing is reported as unknown, not as "no models".

## Validity and drift

- **On save**, `runner.set` and the new `runner.models.set` reject a model that is absent from a *successful* live listing, with a hint naming the closest available ids. When the listing is unknown, saving is allowed and the model is marked unverified.
- **In the background**, the existing runner check gains a "Model offered" step: it compares the default and allowed models with the live listing. A missing default fails the check with the replacement action; missing allowed models warn and are skipped by selection.
- **Diagnostics** gain a remedy, "Model no longer offered", whose action opens the executor's Models section with the recommended replacement preselected (diagnostics remedies model).
- The leftover-account case the fix handled (account without executor, executor without model) is also reported by doctor with the same repair action.

## Interface

### Settings › Executors › executor detail: Models

A section on the executor detail, following the design canvas:

- **Default model**: a searchable picker of available models, with facts (context, price per M when known) and "(recommended)" on the setup recommendation. Saving runs the runner check.
- **Models for tasks** (optional): a list of allowed models, each row with its tier chip (Small / Medium / Frontier / Unrated), validity state, and remove. "Add model" opens the same picker. New rows start **Unrated**; when catalog facts support a suggestion, the row shows "Suggested: Medium" as a one-click action. Accepting it writes the tier. *(Builder's call: a declared tier is the user's policy and should not be set by default.)*
- **Validity**: a row whose model is no longer offered shows the warning inline with "Replace…".
- A one-line summary of how tasks pick a model on this executor ("Simple → glm-5.3-flash · Standard → kimi-k3 · Complex → kimi-k3.1-pro", or "Always uses the default model" when no list is declared).

The read-only "Model" fact on the executor row and detail becomes a link to this section.

### Add executor

The step 2 model picker stays (with the fix: added providers open "change model"). An optional "Use different models by task difficulty" disclosure lets the user pick up to one model per tier at setup; skipped, the executor starts with a default only.

### Settings › Dispatcher › Model choice

Shows the effective difficulty → tier mapping, a per-executor preview table (which model each difficulty would get now), and the warnings for unrated models and executors that list none. Changes preview before saving, as strategy edits already do.

### Task detail and reports

Show "standard requested · medium targeted · kimi-k3 on opencode#opencode-go", the fallback reason when any, and the observed actual model when evidence exists — the record fields of the tier-aware spec.

## Selection behavior

Implements the tier-aware spec's selection policy for both paths:

- **Managed dispatch** already selects among model records; it gains the tier bucket ordering and target mapping.
- **Delegate** (`pacer delegate`, `task.delegate`): plain delegate tasks have no work node, candidate list, reservation or `work_decisions` row today; they are routed by `rankExecutors` alone, and only work-backed tasks launch a selected model (`selectedDispatchModel` in `src/tasks/runner.ts`). This design does **not** turn delegate tasks into work. *(Builder's call, recorded here.)* Instead:
  - Extract the tier bucketing from the ladder into one pure function, `selectModel(records, {difficulty, requirements, pin})`, used by both the ladder and the delegate path, so there is still one tier comparison.
  - After `rankExecutors` picks the executor, the delegate path builds that executor's model records (`buildModelInventory` filtered to the runner), calls `selectModel`, and passes the chosen model id into the launch (`cfg.model` override, as the work path does).
  - An explicit `model` in the brief pins it, subject to the hard gates. Without `models` declared, the default is used, as today.
  - When the routed executor declares no model at or above the target tier, see **Delegate fallback** below.
- Difficulty input, migration (Release A warn / Release B enforce), records and explain follow the tier-aware spec unchanged.

**Delegate fallback.** When the routed executor's declared models cannot meet the target, the delegate path uses that executor's default model, launches, and records `tierReason: executor-fixed-below-target` so the task detail says so. It does not fail and does not reroute.

**Records for delegate tasks.** The tier-aware record fields (`requestedDifficulty`, `difficultySource`, `effectiveDifficulty`, `targetTier`, `selectedTier`, `actualTier`, `tierReason`, plus the selected model) are stored per attempt on the task record for plain delegate tasks too, so goal 4 holds for the most common path. This is an additive task-record schema change carried through the read model and generated API/CLI/MCP types in phase 3.

Executor choice is not widened by this design: tier preference never moves work to a different executor than routing chose on the delegate path. Managed dispatch, which ranks models across executors, keeps the tier-aware spec's cross-executor rules.

## API, CLI and MCP

Additive operations (P4/API-1), generated into protocol docs, schemas, Rust types and MCP declarations:

| Operation | Purpose |
|---|---|
| `executor.models.available {runner, refresh?}` | Live list with facts and source |
| `runner.models.set {id, default, models: [{id, tier, …}], expectedRevision}` | Atomic edit of default and allowed list, validated against the live list |
| `runner.set {model}` | Unchanged; also validated against the live list |
| `dispatch.tierTargets.get/set` | Read/edit the mapping (or through the existing strategy edit with preview) |

CLI: `pacer executor models <id>` (list available and allowed), `pacer executor models <id> --default <m>`, `--allow <m>:<tier>`, `--remove <m>`. Delegate gains `--difficulty` and `--model` per the tier-aware spec.

## Delivery in phases

Each phase is shippable and validated on its own.

1. **Default model everywhere.** `executor.models.available` adapters, the Models section with the default picker only, save-time validity, "Model offered" check step and the diagnostics remedy. Fixes the general version of the reported bug for every agent.
2. **Allowed models and tiers.** `runner.models.set`, the Models list with tier chips, config-load warnings for unrated models, doctor inventory output.
3. **Difficulty-based choice.** Tier bucket selection in dispatch and delegate, `dispatch.tierTargets`, Dispatcher › Model choice preview, task records and explain — the tier-aware spec's Release A.
4. **Enforcement.** The tier-aware spec's Release B under a new protocol major, with its compatibility window.

## Tests and live validation

- Unit: each model-source adapter (success, failure as unknown, catalog-only filtering), save-time validation (absent, unknown listing, default outside allowed list), drift detection, migration of runners without `models`.
- UI: Models section states (no list, list with unrated rows, invalid default, unknown listing), Add executor disclosure, Dispatcher preview; UI evidence per the readiness gate.
- Selection: the tier-aware spec's test plan, plus delegate-path model choice restricted to the routed executor and pins.
- Live (CT-11): in a `bun run live` sandbox, change an OpenCode executor's default model and observe the next test task use it; remove a served model from a fake provider and observe the check, the diagnostics remedy and the replacement; run simple/standard/complex delegations against an executor with three tiered models and confirm the launched model per task. Unavailable agents' adapters are reported UNVERIFIED.

## Left to the builder

- Exact component layout within the canvas conventions, and the curated model lists for agents without a listing command.
- Cache TTL for live listings (suggested: 10 minutes, invalidated by refresh and by a failed task citing an unknown model).
- Whether `runner.models.set` is a new operation or an extension of `runner.settings.save` — either is fine if it is atomic and revision-checked.

## Decisions

Approved by the maintainer on 2026-11-09, with the design canvas.

1. **Delegate fallback.** When routing picks an executor whose declared models cannot meet the target, the task runs on that executor's default model and records `tierReason: executor-fixed-below-target`. It does not fail, and difficulty does not move work to another executor on the delegate path.
2. **On when declared.** Per-task model choice is active for every executor that declares `models`; there is no separate switch. Executors without `models` behave exactly as before and record no tier.
3. **Phase 1 agents.** Live model lists cover OpenCode (`source: opencode`), managed endpoints and local servers. Claude Code, Codex, Cursor and Antigravity take a typed model id until adapters exist.

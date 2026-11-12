# Model choice redesign and model matrix

Date: 2026-11-12. Status: approved 2026-11-12. Applies to: Settings › Dispatcher › Model choice, a new Settings › Dispatcher › Model matrix page, and the service operations they need. Builds on [executor model management](2026-11-09-executor-model-management-design.md).

## Why

The current Model choice section asks for a tier per difficulty through three full-width selects and previews a table that repeats the same value in every cell. On a typical install the choice changes nothing: native agents pick their own model and other executors run one unrated model, so `selectModel` falls back to the same record for every difficulty. The page never says so. Saving also forces a new setup name, because the app cannot update the active setup.

## Model choice (Settings › Dispatcher)

1. **Answer card.** States how many executors the tier choice steers ("0 of 9 executors follow it") and why, computed from `dispatch.models`: an executor is *steered* when it has at least one exact model with a rated tier. When none are, the card offers *Open model matrix*.
2. **Tier grid.** One row per difficulty (Simple, Standard, Complex), one column per tier (Small, Medium, Frontier), as radio groups. Picking a cell lowers earlier rows above it and raises later rows below it, so `dispatch.tierTargets` never decreases and the validation error can no longer be reached. Presets: Economical (small, small, medium), Balanced (small, medium, frontier), Quality first (medium, frontier, frontier), Frontier only. A non-matching mapping shows *Custom*.
3. **Preview grouped by behavior**, using the same `selectModel` the dispatcher uses:
   - *Follow the tier*: per difficulty, the chosen model, or, when no model is at or above the target, the executor's configured default or its provider's default — a follow runner always runs something, it is never *Not used* — with a note for upward fallback.
   - *Unrated, tier ignored*: one line per executor, its model "for every difficulty".
   - *Choose their own model*: one row of chips for executors with only an `executor-default` record.
   - Column headers give the target tier and how many executors can take that difficulty.
4. **Save bar** appears only with unsaved changes: Discard, *Save as new setup…* (existing `strategy.save` + `strategy.use`, name asked in a dialog), and *Save*, which updates the active setup in place through `dispatch.tierTargets.set`. Save works for every setup, including the default one, as executor model edits already do. The name field and the "up to date" line are removed.

## Model matrix (Settings › Dispatcher › Model matrix)

Route `#/settings/models`, highlighted under Dispatcher in the settings menu.

- **Rows:** agent › provider › model. Each executor is a group (agent name, provider from `executor.models.available.provider` or the account, runner id, "n models · m on"). Rows are the union of the provider listing (`executor.models.available`) and the declared models (`runner.models.get`). Executors whose listing is unknown (`source: "none"`) show their declared models plus *Add model* (free text). Executors with no models show "Uses its default and can take any difficulty".
- **Columns:** On (switch), model id with Default tag, context, tools, price (`costOut` per million tokens, or Local / —), Size (Small / Medium / Frontier radio; none selected = unrated), Takes (difficulties it can serve under the saved tier targets).
- **Side list** filters by agent and provider.
- **Suggest:** proposes on/off and a size per model from listing facts (`suggestTier`; tools required to suggest on). Suggestions show as highlighted rows with the reason; Accept per row or Accept all; Dismiss. Nothing is written until Save. A later phase lets the user ask an executor for suggestions; it is not part of this delivery.
- **Coverage cards:** per difficulty, how many enabled rated models can take it, plus the executors that use their default.
- **Save matrix** writes every changed executor in one revision-checked edit (`runner.models.set_many`). Turning the default model off moves the default to the first enabled model; turning all off clears `models` and keeps the default. The planner runner is read-only here, as `runner.models.set` already refuses it.

## Service operations

| Op | Params → result |
| --- | --- |
| `dispatch.tierTargets.set` | `{expectedRevision, targets: TierTargets}` → `{revision, targets}`. Edits `dispatch.tierTargets` in the active strategy file under the `executor-settings` lock, with the same `strategyRevision` check as `runner.models.set`. Refuses a decreasing mapping (`invalid_input`). A setup without a `dispatch` block gains `dispatch.tierTargets` only. |
| `runner.models.set_many` | `{expectedRevision, runners: [{id, default, models}]}` (1–64 runners) → `{revision, runners: RunnerModels[], warnings[]}`. Validates every runner as `runner.models.set` does, then commits all in one edit; any failure writes nothing. |

The current revision for both comes from `runner.models.get` (any runner) or a new `dispatch.tierTargets.get` → `{revision, targets}`. Both are TypeScript operations; the native server forwards them. Both are v3-only.

## Tests and live validation

- Unit: grid adjustment, preset matching, preview grouping against `selectModel`, set/set_many conflicts, atomicity and refusals, default-move rules.
- App: the two screens render from fixtures; keyboard reachability of the grid, switches and size radios; save, discard and conflict paths.
- Live (CT-11): in a sandbox `PACER_HOME`, rate models in the matrix, change the grid, save, and confirm `dispatch.config.get` and a `dispatch.explain` reflect it.

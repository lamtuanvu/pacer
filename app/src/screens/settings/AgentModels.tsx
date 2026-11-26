import type { AvailableModels } from "../../../../src/models/available";
import { executorLabel } from "../../../../src/view-model/words";
import { Combobox } from "../../ds/Combobox";
import { Radio, Switch } from "../../ds/Controls";
import { IconButton } from "../../ds/Button";
import { Pill } from "../../ds/Pill";
import { SegmentedControl } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { tierLabels, modelWarning } from "../../model/executor-models";
import { addModelOptions, modelNote, suggestedSize, type ModelSize } from "../../model/agents";
import type { MatrixDraft, MatrixTier } from "../../model/model-matrix";
import type { ModelDraftsState } from "./useModelDrafts";

const SIZES: readonly ModelSize[] = ["small", "medium", "frontier"];
const SIZE_MARK: Record<ModelSize, string> = { small: "S", medium: "M", frontier: "F" };

/** A size badge for the pick list: the letter is decorative, the size name is the option's text. */
function SizeBadge({ tier }: { tier: ModelSize | null }) {
  return <><span aria-hidden="true" className={`pc-agent-size pc-agent-size--${tier ?? "none"}`}>{tier ? SIZE_MARK[tier] : "?"}</span><span>{tier ? `${tierLabels[tier]}, suggested` : "Size after adding"}</span></>;
}

/**
 * One agent's models (from the page draft) and Add a model. Edits stay in the draft until the page's save bar
 * saves them through `runner.models.set_many`; the planner's rows feed only the tier fallback.
 */
export function AgentModels({ runner, agent, models, planner, disabled }: { runner: string; agent: string; models: ModelDraftsState; planner: boolean; disabled: boolean }) {
  const draft = models.draftOf(runner), base = models.baseOf(runner), available = models.available[runner];
  const name = executorLabel(runner), loadError = models.errors[runner];
  const locked = disabled || models.busy;
  if (loadError) return <section className="pc-stack pc-stack--compact" aria-labelledby={`models-${runner}`}>
    <SectionHeading as="h3" id={`models-${runner}`}>Models</SectionHeading>
    <p className="u3-muted">{loadError}</p>
  </section>;
  if (!draft) return <section className="pc-stack pc-stack--compact" aria-labelledby={`models-${runner}`}>
    <SectionHeading as="h3" id={`models-${runner}`}>Models</SectionHeading>
    <p className="u3-muted" role="status">Loading models…</p>
  </section>;
  const options = addModelOptions(agent, available, draft.rows.map(row => row.id));
  const listed = available?.models?.length ?? 0;
  const source = listed ? `${listed} ${listed === 1 ? "model" : "models"} from ${available?.provider ?? name}` : agent === "claude-code" ? "From Claude Code" : undefined;
  return <>
    <section className="pc-stack pc-stack--compact" aria-labelledby={`models-${runner}`}>
      <SectionHeading as="h3" id={`models-${runner}`}>Models</SectionHeading>
      {draft.rows.length ? <ModelTable runner={runner} agent={agent} draft={draft} base={base} available={available} models={models} disabled={locked} />
        : <p className="u3-muted">{planner ? "No models yet. To let the planner take complex tasks as a fallback, add one and size it." : `No models yet: ${name} picks its own model and can take any task. Add models to let task difficulty choose between them.`}</p>}
    </section>
    <Combobox label={draft.rows.length ? "Add a model" : "Add models"} mono disabled={locked} options={options.map(option => ({ value: option.id, description: option.note, group: option.group, meta: <SizeBadge tier={option.tier} /> }))}
      placeholder={listed ? `Search ${name}'s models, or type any model id` : `Type a model id for ${name}`} source={source}
      customLabel={value => `Add ${value} (not listed)`} pickedLabel={value => `${value} added. Save to keep it.`}
      hint="Picking a model adds it with the suggested size; you can change it in the table. Arrow keys move, Enter adds."
      emptyLabel="Type a model id to add it."
      onPick={value => models.edits.add(runner, value, suggestedSize(agent, available, value))} />
  </>;
}

function ModelTable({ runner, agent, draft, base, available, models, disabled }: { runner: string; agent: string; draft: MatrixDraft; base?: MatrixDraft; available?: AvailableModels; models: ModelDraftsState; disabled: boolean }) {
  return <div className="pc-agent-models">
    <table>
      <thead><tr><th scope="col">Model</th><th scope="col">Size</th><th scope="col">Default</th><th scope="col">On</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
      <tbody>{draft.rows.map(row => {
        const added = !base?.rows.some(old => old.id === row.id);
        const warning = available && !added ? modelWarning(available, row.id, available.provider ?? runner) : null;
        const note = [modelNote(agent, available, row.id), warning].filter(Boolean).join(" · ");
        const isDefault = draft.default === row.id;
        return <tr key={row.id}>
          <td>
            <span className="pc-agent-models__id"><code>{row.id}</code>{added && <Pill tone="info">Added, not saved</Pill>}</span>
            {note && <span className="pc-agent-card__caption">{note}</span>}
          </td>
          <td>
            <SegmentedControl label={`Size of ${row.id}`} value={row.tier} disabled={disabled}
              options={SIZES.map(tier => ({ value: tier, label: tierLabels[tier] }))} onChange={tier => models.edits.size(runner, row.id, tier as MatrixTier)} />
            {row.tier === "unknown" && <span className="pc-agent-card__caption pc-agent-card__caption--warn">Unrated: runs for any difficulty</span>}
          </td>
          <td><label className="pc-agent-models__default"><Radio name={`default-${runner}`} checked={isDefault} disabled={disabled || !row.on} onChange={() => models.edits.makeDefault(runner, row.id)} /><span>{isDefault ? "Default" : "Make default"}<span className="sr-only">: {row.id}</span></span></label></td>
          <td><Switch size="sm" aria-label={`${row.id} on`} checked={row.on} disabled={disabled} onChange={event => models.edits.toggle(runner, row.id, event.currentTarget.checked)} /></td>
          <td><IconButton icon="close" size="sm" variant="quiet" aria-label={`Remove ${row.id}`} disabled={disabled} onClick={() => models.edits.remove(runner, row.id)} /></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

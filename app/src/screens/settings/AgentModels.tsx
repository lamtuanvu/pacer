import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModels } from "../../../../src/models/available";
import { executorLabel } from "../../../../src/view-model/words";
import { Combobox, type ComboboxOption } from "../../ds/Combobox";
import { Radio, Switch } from "../../ds/Controls";
import { Button, IconButton } from "../../ds/Button";
import { Pill } from "../../ds/Pill";
import { SegmentedControl } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { tierLabels, modelWarning } from "../../model/executor-models";
import { addModelOptions, AGENT_LISTINGS, modelNote, suggestedSize, type ModelSize } from "../../model/agents";
import type { MatrixDraft, MatrixTier } from "../../model/model-matrix";
import type { ModelDraftsState } from "./useModelDrafts";

const SIZES: readonly MatrixTier[] = ["small", "medium", "frontier", "unknown"];
const SIZE_MARK: Record<ModelSize, string> = { small: "S", medium: "M", frontier: "F" };
const ALREADY = "Already added";

/** A size badge for the pick list: the letter is decorative, the size name is the option's text. */
function SizeBadge({ tier }: { tier: ModelSize | null }) {
  return <><span aria-hidden="true" className={`pc-agent-size pc-agent-size--${tier ?? "none"}`}>{tier ? SIZE_MARK[tier] : "?"}</span><span>{tier ? `${tierLabels[tier]}, suggested` : "Size after adding"}</span></>;
}

/** Every pickable model plus the agent's own ids as disabled "Already added" options, so retyping one never adds another. */
export function pickOptions(agent: string, available: AvailableModels | undefined, taken: readonly string[]): ComboboxOption[] {
  const listed = addModelOptions(agent, available, []);
  const options: ComboboxOption[] = listed.map(option => ({ value: option.id, description: option.note, group: option.group, meta: <SizeBadge tier={option.tier} />, ...(taken.includes(option.id) ? { disabled: true, disabledLabel: ALREADY } : {}) }));
  for (const id of taken) if (!listed.some(option => option.id === id)) options.push({ value: id, disabled: true, disabledLabel: ALREADY });
  return options;
}

/**
 * One agent's models (from the page draft) and Add a model. Edits stay in the draft until the page's save bar
 * saves them through `runner.models.set_many`; the planner's rows feed only the tier fallback.
 */
export function AgentModels({ runner, agent, models, planner, disabled }: { runner: string; agent: string; models: ModelDraftsState; planner: boolean; disabled: boolean }) {
  const draft = models.draftOf(runner), base = models.baseOf(runner), available = models.available[runner];
  const name = executorLabel(runner), loadError = models.errors[runner];
  const locked = disabled || models.busy;
  const comboId = `add-model-${runner}`;
  const [replacing, setReplacing] = useState<string | null>(null);
  // Removing a row moves focus to the next row's Remove button, or to Add a model when none is left.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (document.querySelector<HTMLElement>(`[data-remove="${CSS.escape(target)}"]`) ?? document.getElementById(comboId))?.focus();
  });
  if (loadError) return <section className="pc-stack pc-stack--compact" aria-labelledby={`models-${runner}`}>
    <SectionHeading as="h3" id={`models-${runner}`}>Models</SectionHeading>
    <p className="u3-muted">{loadError}</p>
  </section>;
  if (!draft) return <section className="pc-stack pc-stack--compact" aria-labelledby={`models-${runner}`}>
    <SectionHeading as="h3" id={`models-${runner}`}>Models</SectionHeading>
    <p className="u3-muted" role="status">Loading models…</p>
  </section>;
  const taken = draft.rows.map(row => row.id);
  const listed = available?.models?.length ?? 0;
  // An agent's own list is named after the agent ("from Cursor"); a provider listing after the provider.
  const from = available && AGENT_LISTINGS.includes(available.source) ? name : available?.provider ?? name;
  const source = listed ? `${listed} ${listed === 1 ? "model" : "models"} from ${from}` : agent === "claude-code" ? "From Claude Code" : undefined;
  const remove = (id: string) => {
    const at = taken.indexOf(id);
    focusNext.current = taken[at + 1] ?? taken[at - 1] ?? "";
    models.edits.remove(runner, id);
  };
  const empty = planner ? "No models yet. To let the planner take complex tasks as a fallback, add one and size it."
    : draft.default ? `No models declared: ${name} uses ${draft.default} for every task. Adding a model keeps ${draft.default} as one of its models.`
    : `No models yet: ${name} picks its own model and can take any task. Add models to let task difficulty choose between them.`;
  return <>
    <section className="pc-stack pc-stack--compact" aria-labelledby={`models-${runner}`}>
      <SectionHeading as="h3" id={`models-${runner}`} tabIndex={-1}>Models</SectionHeading>
      {draft.rows.length ? <ModelTable runner={runner} agent={agent} draft={draft} base={base} available={available} models={models} disabled={locked} remove={remove}
          replace={id => { setReplacing(id); queueMicrotask(() => document.getElementById(comboId)?.focus()); }} />
        : <p className="u3-muted">{empty}</p>}
    </section>
    <Combobox inputId={comboId} label={replacing ? `Replace ${replacing} with` : draft.rows.length ? "Add a model" : "Add models"} mono disabled={locked} options={pickOptions(agent, available, taken)}
      placeholder={listed ? `Search ${name}'s models, or type any model id` : `Type a model id for ${name}`} source={source}
      customLabel={value => `${replacing ? "Use" : "Add"} ${value} (not listed)`} pickedLabel={value => replacing ? `${replacing} replaced with ${value}. Save to keep it.` : `${value} added. Save to keep it.`}
      hint={replacing ? "Pick the model that takes its place; it keeps its size and default." : "Picking a model adds it with the suggested size; you can change it in the table. Arrow keys move, Enter adds what you typed or the highlighted model."}
      emptyLabel="Type a model id to add it."
      onPick={value => {
        if (replacing) { models.edits.replace(runner, replacing, value, suggestedSize(agent, available, value)); setReplacing(null); }
        else models.edits.add(runner, value, suggestedSize(agent, available, value));
      }} />
    {replacing && <div><Button size="sm" variant="quiet" onClick={() => setReplacing(null)}>Cancel replacing {replacing}</Button></div>}
  </>;
}

function ModelTable({ runner, agent, draft, base, available, models, disabled, remove, replace }: { runner: string; agent: string; draft: MatrixDraft; base?: MatrixDraft; available?: AvailableModels; models: ModelDraftsState; disabled: boolean; remove: (id: string) => void; replace: (id: string) => void }) {
  return <div className="pc-agent-models">
    <table>
      <thead><tr><th scope="col">Model</th><th scope="col">Size</th><th scope="col">Default</th><th scope="col">On</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
      <tbody>{draft.rows.map(row => {
        const added = !base?.rows.some(old => old.id === row.id);
        const warning = available && !added ? modelWarning(available, row.id, available.provider ?? runner) : null;
        const note = [modelNote(agent, available, row.id), warning].filter(Boolean).join(" · ");
        const isDefault = draft.default === row.id;
        return <tr key={row.id}>
          <td><div className="pc-agent-models__cell">
            <span className="pc-agent-models__id"><code>{row.id}</code>{added && <Pill tone="info">Added, not saved</Pill>}</span>
            {note && <span className="pc-agent-card__caption">{note}</span>}
            {warning && <div><Button size="sm" variant="quiet" disabled={disabled} onClick={() => replace(row.id)}>Replace<span className="sr-only"> {row.id}</span>…</Button></div>}
          </div></td>
          <td>
            <SegmentedControl label={`Size of ${row.id}`} value={row.tier} disabled={disabled}
              options={SIZES.map(tier => ({ value: tier, label: tierLabels[tier] }))} onChange={tier => models.edits.size(runner, row.id, tier as MatrixTier)} />
            {row.tier === "unknown" && <span className="pc-agent-card__caption pc-agent-card__caption--warn">Unrated: runs for any difficulty</span>}
          </td>
          <td><label className="pc-agent-models__default"><Radio name={`default-${runner}`} checked={isDefault} disabled={disabled || !row.on} onChange={() => models.edits.makeDefault(runner, row.id)} /><span>{isDefault ? "Default" : row.on ? "Make default" : "Off"}<span className="sr-only">: {row.id}</span></span></label></td>
          <td><Switch size="sm" aria-label={`${row.id} on`} checked={row.on} disabled={disabled} onChange={event => models.edits.toggle(runner, row.id, event.currentTarget.checked)} /></td>
          <td><IconButton icon="close" size="sm" variant="quiet" aria-label={`Remove ${row.id}`} data-remove={row.id} disabled={disabled} onClick={() => remove(row.id)} /></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

import { useEffect, useRef, useState } from "preact/hooks";
import type { DispatchConfig, TierTargets } from "../../../../src/dispatch/types";
import { TIERS } from "../../../../src/dispatch/candidates";
import type { BrowserApi } from "../../data/api";
import { choiceModel, difficulties, difficultyLabels, tierLabels } from "../../model/executor-models";
import { Button } from "../../ds/Button";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Field, TextInput } from "../../ds/Controls";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { ResourceState, Section, useResource } from "./shared";
import type { DispatcherInventory } from "./Dispatcher";

type ConfigView = { strategy: string; config: DispatchConfig };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mappingError = (targets: TierTargets) => TIERS[targets.simple] > TIERS[targets.standard] || TIERS[targets.standard] > TIERS[targets.complex]
  ? "dispatch.tierTargets must not decrease from simple to complex" : null;

export async function saveTierTargets(call: BrowserApi["call"], saved: ConfigView, targets: TierTargets, profileName = "model-choices"): Promise<void> {
  const error = mappingError(targets);
  if (error) throw new Error(error);
  if (profileName === "default") throw new Error("Choose a name for the saved setup; default is protected.");
  if (profileName === saved.strategy) throw new Error("Choose a new saved setup name; the active setup cannot be overwritten.");
  const latest = await call<ConfigView>("dispatch.config.get", {});
  if (!same(latest.config, saved.config) || latest.strategy !== saved.strategy) throw new Error("The active saved setup changed in another client. Discard to load it.");
  const draft = { from: saved.strategy, set: { "dispatch.tierTargets": targets } };
  const preview = await call<{ ok: boolean; errors: string[] }>("strategy.preview", { draft });
  if (!preview.ok) throw new Error(preview.errors?.join(" ") || "Model choices could not be validated.");
  await call("strategy.save", { name: profileName, draft, reason: "Update model choices by task difficulty" });
  try { await call("strategy.use", { name: profileName }); }
  catch (error) { throw new Error(`Saved model choices, but the setup could not be activated: ${error instanceof Error ? error.message : String(error)}`); }
}

export function DispatcherModelChoice({ initialConfig, initialInventory, initialTargets, onSaved }: {
  initialConfig?: ConfigView; initialInventory?: DispatcherInventory; initialTargets?: TierTargets; onSaved?: () => void;
}) {
  const { api } = useTaskContext();
  const config = useResource<ConfigView>("dispatch.config.get", {}, initialConfig);
  const inventory = useResource<DispatcherInventory>("dispatch.models", {}, initialInventory);
  const [base, setBase] = useState(initialConfig);
  const [targets, setTargets] = useState(initialTargets ?? initialConfig?.config.tierTargets);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState("");
  const pending = useRef(false);
  const [profileName, setProfileName] = useState("model-choices");
  const dirty = !!targets && !same(targets, base?.config.tierTargets);
  useEffect(() => {
    if (config.data && !dirty) { setBase(config.data); setTargets(config.data.config.tierTargets); }
  }, [config.data]);
  const invalid = targets ? mappingError(targets) : null;
  const save = async () => {
    if (!base || !targets || invalid || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); setNotice("");
    try {
      const name = profileName;
      await saveTierTargets(api.call.bind(api), base, targets, name);
      setBase({ ...base, strategy: name, config: { ...base.config, tierTargets: targets } });
      setNotice("Model choices saved."); config.reload(); onSaved?.();
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const groups = new Map<string, NonNullable<typeof inventory.data>["models"]>();
  for (const record of inventory.data?.models ?? []) groups.set(record.runner, [...(groups.get(record.runner) ?? []), record]);
  return <Section id="model-choice" title="Model choice" detail="Choose the model tier for each task difficulty. Preview uses the current model inventory; availability can change at dispatch time.">
    <ResourceState resource={config}>
      {targets && <>
        {difficulties.map(difficulty => <Field key={difficulty} label={difficultyLabels[difficulty]}>
          <ChoicePicker value={targets[difficulty]} disabled={busy} options={(["small", "medium", "frontier"] as const).map(value => ({ value, label: tierLabels[value] }))}
            onValueChange={value => { setTargets({ ...targets, [difficulty]: value }); setNotice(""); }} />
        </Field>)}
        {invalid && <p role="alert">{invalid}</p>}
        <ResourceState resource={inventory}>
          <div className="u3-table-wrap"><table className="u3-table"><caption>Managed dispatch preview by executor</caption><thead><tr><th scope="col">Executor</th>{difficulties.map(d => <th scope="col" key={d}>{difficultyLabels[d]}</th>)}</tr></thead>
            <tbody>{[...groups].map(([executor, records]) => <tr key={executor}><th scope="row">{executor}</th>{difficulties.map(d => <td key={d} data-label={difficultyLabels[d]}>{choiceModel(records, d, targets)}</td>)}</tr>)}</tbody>
          </table></div>
          {!groups.size && <p className="u3-muted">No executors in the model inventory.</p>}
          {[...groups].filter(([, records]) => records.some(record => record.tier === "unknown")).map(([executor]) => <p key={executor} className="u3-muted">{executor}: Unrated models may be used when no rated model is usable.</p>)}
        </ResourceState>
        <Field label="Saved setup name" help="Save these choices as a new setup, then make it active."><TextInput value={profileName} disabled={busy} onInput={event => setProfileName(event.currentTarget.value)} /></Field>
        <div className="u3-actions"><Button variant="primary" disabled={busy || !dirty || !!invalid} onClick={() => void save()}>Save model choices</Button>
          {dirty && <Button disabled={busy} onClick={() => { if (config.data) { setBase(config.data); setTargets(config.data.config.tierTargets); } setError(undefined); setNotice(""); }}>Discard</Button>}</div>
        {!dirty && <p className="u3-muted">Model choices are up to date.</p>}
        <ErrorMessage error={error}/><p role="status" aria-live="polite">{notice}</p>
      </>}
    </ResourceState>
  </Section>;
}

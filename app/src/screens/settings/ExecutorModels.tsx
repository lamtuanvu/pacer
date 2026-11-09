// Models section on the executor detail (Settings › Executors): pick or change the default model,
// with a searchable picker of the models the provider serves and a free-text fallback when the
// listing is unknown. Lives next to the executor's facts (app/src/screens/settings/Executors.tsx).
import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModel, AvailableModels } from "../../../../src/models/available";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Field, TextInput } from "../../ds/Controls";
import { Feedback, ResourceState, Section, useOperation, useResource } from "./shared";
import { displayModel, modelWarning } from "../../model/executor-models";
import { contextLabel, modelFacts } from "../../model/opencode-setup";

/** Picker options show facts when the catalog knows them (context, price per M when known). */
function optionDescription(model: AvailableModel): string | undefined {
  return model.context !== undefined && model.costIn != null && model.costOut != null
    ? modelFacts({ context: model.context, costIn: model.costIn, costOut: model.costOut })
    : model.context !== undefined ? contextLabel(model.context) : undefined;
}

export function ExecutorModels({runner, model, provider, initialAvailable}:{runner:string; model:string|null; provider:string; initialAvailable?:AvailableModels}) {
  const [refresh, setRefresh] = useState(false);
  const list = useResource<AvailableModels>("executor.models.available", refresh ? {runner, refresh: true} : {runner}, initialAvailable);
  const [picked, setPicked] = useState(model ?? "");
  useEffect(() => { setPicked(model ?? ""); }, [model]);
  const picker = useRef<HTMLButtonElement>(null);
  const save = useOperation(), check = useOperation();
  const models = list.data?.models ?? null, listing = list.data;
  const warning = listing ? modelWarning(listing, model, provider) : null;
  const saveModel = () => {
    // The picker holds full ids; the free-text fallback holds the id as the user typed it. An empty
    // field changes nothing, because saving an empty model id is not valid input.
    const chosen = picked.trim();
    if (!chosen) return;
    void save.run("runner.set", {id: runner, model: chosen}, () => { void check.run("runner.check", {id: runner}); });
  };
  return <Section id="models" title="Models" actions={<Button size="sm" onClick={() => { setRefresh(true); list.reload(); }}>Refresh list</Button>}>
    <ResourceState resource={list}>
      {models?.length ? <>
        {warning && <Alert tone="warning" title={warning}><Button size="sm" onClick={() => picker.current?.focus()}>Replace…</Button></Alert>}
        <Field label="Default model">
          <ChoicePicker ref={picker} value={picked} searchable className="pc-choice-picker--mono"
            options={models.map(m => ({ value: m.id, label: displayModel(m.id), description: optionDescription(m) }))}
            onValueChange={setPicked} />
        </Field>
      </> : <>
        <p role="alert" className="u3-muted">{listing?.note ?? "The model list is not available."} Save a model id anyway; the next test task verifies it.</p>
        <Field label="Model id">
          <TextInput value={picked} onInput={e => setPicked(e.currentTarget.value)} />
        </Field>
      </>}
      <div className="u3-actions">
        <Button variant="primary" disabled={!!save.unavailable || (save.busy)} onClick={saveModel}>Save model</Button>
      </div>
      <Feedback action={save} />
      <Feedback action={check} />
    </ResourceState>
  </Section>;
}

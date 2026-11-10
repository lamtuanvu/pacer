// Models section on the executor detail (Settings › Executors): pick or change the default model,
// with a searchable picker of the models the provider serves and a free-text fallback when the
// listing is unknown. Lives next to the executor's facts (app/src/screens/settings/Executors.tsx).
import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModel, AvailableModels } from "../../../../src/models/available";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Field, TextInput } from "../../ds/Controls";
import { TextAction } from "../../ds/Button";
import { Feedback, ResourceState, Section, useOperation, useResource } from "./shared";
import { useTaskContext } from "../task-shared";
import { displayModel, modelWarning } from "../../model/executor-models";
import { contextLabel, modelFacts } from "../../model/opencode-setup";

/** Picker options show facts when the catalog knows them (context, price per M when known). */
function optionDescription(model: AvailableModel): string | undefined {
  return model.context !== undefined && model.costIn != null && model.costOut != null
    ? modelFacts({ context: model.context, costIn: model.costIn, costOut: model.costOut })
    : model.context !== undefined ? contextLabel(model.context) : undefined;
}

/** In-page jump for hash-labelled sections: the app routes on location.hash, so a bare #id link
 * would replace the settings route instead of scrolling (same pattern as Dispatcher.tsx). */
export function focusSection(event: { preventDefault: () => void }, id: string): void {
  event.preventDefault();
  const target = document.getElementById(id);
  if (target) { target.tabIndex = -1; target.focus(); target.scrollIntoView({ block: "start" }); }
}

/** The Model fact on the executor detail: opens the Models section in page, not a new route. */
export function ModelFactLink({model}:{model:string|null}) {
  return <TextAction href="#models" onClick={event => focusSection(event, "models")}>{model ?? "Agent default"}</TextAction>;
}

export function ExecutorModels({runner, model, provider, initialAvailable, onSaved}:{runner:string; model:string|null; provider:string; initialAvailable?:AvailableModels; onSaved?:()=>void}) {
  const list = useResource<AvailableModels>("executor.models.available", {runner}, initialAvailable);
  const {api} = useTaskContext();
  const [refreshing, setRefreshing] = useState(false);
  // Refresh list is one-shot: only this call passes refresh:true and bypasses the listing cache;
  // later reloads (reconnects, invalidations) keep the cached listing instead of re-busting it.
  const refreshList = async () => {
    setRefreshing(true);
    try { list.setData(await api.call<AvailableModels>("executor.models.available", {runner, refresh: true})); }
    catch { list.reload(); }
    finally { setRefreshing(false); }
  };
  const [picked, setPicked] = useState(model ?? "");
  useEffect(() => { setPicked(model ?? ""); }, [model]);
  const picker = useRef<HTMLButtonElement>(null);
  const save = useOperation(), check = useOperation();
  const models = list.data?.models ?? null, listing = list.data;
  // The listing knows the provider it came from (cached or unknown listings fall back to the account name).
  const warning = listing ? modelWarning(listing, model, listing.provider ?? provider) : null;
  const chosen = picked.trim();
  const unchanged = !chosen || chosen === (model ?? "");
  const saveModel = () => {
    // The picker holds full ids; the free-text fallback holds the id as the user typed it. Saving
    // only happens on a change: an empty field or the current model id are not edits.
    if (unchanged) return;
    void save.run("runner.set", {id: runner, model: chosen}, () => {
      // The saved default reroutes work to the provider that serves it now: refresh the cached
      // listing so the no-longer-offered warning matches, and let the executor detail refresh
      // its facts (Model fact, row state) instead of waiting for the next page reload.
      void refreshList();
      onSaved?.();
      void check.run("runner.check", {id: runner});
    });
  };
  return <Section id="models" title="Models" actions={<Button size="sm" disabled={refreshing} onClick={() => void refreshList()}>Refresh list</Button>}>
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
        <Button variant="primary" disabled={!!save.unavailable || save.busy || unchanged} onClick={saveModel}>Save model</Button>
      </div>
      <Feedback action={save} />
      <Feedback action={check} />
    </ResourceState>
  </Section>;
}

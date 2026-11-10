import type { DispatchConfig } from "../../../../src/dispatch/types";
// Executor model defaults and task declarations are edited locally and saved together.
import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModel, AvailableModels } from "../../../../src/models/available";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Field, TextInput } from "../../ds/Controls";
import { TextAction } from "../../ds/Button";
import { Feedback, ResourceState, Section, useOperation, useResource } from "./shared";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { displayModel, modelWarning, editModels, suggestTier, tierLabels, tierSummary, type ModelsEdit } from "../../model/executor-models";
import { contextLabel, modelFacts } from "../../model/opencode-setup";

import type { RunnerModels, ModelDeclaration } from "../../../../src/core/runner-models";
import { FilterChip } from "../../ds/Patterns";

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

export function ExecutorModels({runner, model, provider, initialAvailable, initialModels, initialConfig, onSaved}:{runner:string; model:string|null; provider:string; initialAvailable?:AvailableModels; initialModels?:RunnerModels; initialConfig?:{config:DispatchConfig}; onSaved?:()=>void}) {
  const config = useResource<{config:DispatchConfig}>("dispatch.config.get", {}, initialConfig);
  const list = useResource<AvailableModels>("executor.models.available", {runner}, initialAvailable);
  const {api} = useTaskContext();
  const declarations = useResource<RunnerModels>("runner.models.get", {id: runner}, initialModels);
  const [draft, setDraft] = useState(initialModels);
  const [base, setBase] = useState(initialModels);
  const [adding, setAdding] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const addPicker = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    if (declarations.data?.runner === runner && (!draft || draft.runner !== runner)) {
      setDraft(declarations.data); setBase(declarations.data);
    }
  }, [declarations.data, runner]);
  const edit = (change: ModelsEdit) => { setDraft(d => d ? editModels(d, change) : d); setNotice(""); };
  const declared = !!draft?.models.length;
  const saveDeclarations = async () => {
    if (!draft || !draft.default || pending.current) return;
    pending.current = true; setSaving(true); setError(undefined); setNotice(""); setWarnings([]);
    try {
      const result = await api.call<RunnerModels & {warnings: string[]}>("runner.models.set", {
        id: runner, expectedRevision: draft.revision, default: draft.default, models: draft.models,
      });
      setDraft(result); setBase(result); setPicked(result.default ?? ""); setWarnings((result.warnings ?? []).filter(w => !/^runners\..+: (?:model ".*" is unrated \(tier unknown\)|default model ".*" is not in models)$/.test(w))); setNotice("Saved.");
      void refreshList();
      void check.run("runner.check", {id: runner});
      onSaved?.();
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "conflict") {
        try {
          const current = await api.call<RunnerModels>("runner.models.get", {id: runner});
          setDraft(current); setBase(current); setPicked(current.default ?? ""); setNotice("Changed elsewhere; reloaded");
        } catch (reloadError) { setError(reloadError); }
      } else setError(e);
    } finally { pending.current = false; setSaving(false); }
  };
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
  const warning = listing ? modelWarning(listing, declared ? draft.default : model, listing.provider ?? provider) : null;
  const changePicked = (value: string) => {
    setPicked(value);
    if (base?.models.length) setDraft(d => d ? {...d, default: value.trim()} : d);
  };
  const chosen = picked.trim();
  const hasDeclarations = declared || !!base?.models.length;
  const unchanged = hasDeclarations ? JSON.stringify(draft) === JSON.stringify(base) : !chosen || chosen === (model ?? "");
  const saveModel = () => {
    // The picker holds full ids; the free-text fallback holds the id as the user typed it. Saving
    // only happens on a change: an empty field or the current model id are not edits.
    if (unchanged || saving || (hasDeclarations && (!draft || draft.runner !== runner || declarations.loading || declarations.error))) return;
    if (hasDeclarations) { void saveDeclarations(); return; }
    void save.run("runner.set", {id: runner, model: chosen}, async () => {
      // The saved default reroutes work to the provider that serves it now: refresh the cached
      // listing so the no-longer-offered warning matches, and let the executor detail refresh
      // its facts (Model fact, row state) instead of waiting for the next page reload.
      try {
        const current = await api.call<RunnerModels>("runner.models.get", {id: runner});
        setDraft(current); setBase(current); setPicked(current.default ?? "");
      } catch (e) { setError(e); }
      void refreshList();
      onSaved?.();
      void check.run("runner.check", {id: runner});
    });
  };
  const replace = (id: string) => {
    setReplacing(id); setAdding(""); addPicker.current?.focus();
  };
  const chooseAddition = (id: string) => {
    if (replacing) {
      edit({type: "replace", id: replacing, with: id}); setReplacing(null); setAdding("");
    } else setAdding(id);
  };
  const addModel = () => {
    setDraft(d => d ? editModels(!d.models.length ? {...d, default: picked.trim() || d.default} : d, {type: "add", id: adding.trim()}) : d);
    setNotice(""); setAdding("");
  };
  return <Section id="models" title="Models" actions={<Button size="sm" disabled={refreshing} onClick={() => void refreshList()}>Refresh list</Button>}>
    <ResourceState resource={list}>
      {declared ? <>
        {warning && <Alert tone="warning" title={warning}><Button size="sm" disabled={saving} onClick={() => replace(draft.default!)}>Replace…</Button></Alert>}
        <Field label="Default model">
        <ChoicePicker value={draft.default ?? ""} disabled={saving} options={draft.models.map(m => ({value: m.id, label: displayModel(m.id)}))}
          onValueChange={id => edit({type: "default", id})} />
      </Field></> : models?.length ? <>
        {warning && <Alert tone="warning" title={warning}><Button size="sm" onClick={() => picker.current?.focus()}>Replace…</Button></Alert>}
        <Field label="Default model">
          <ChoicePicker ref={picker} value={hasDeclarations ? draft?.default ?? "" : picked} disabled={saving} searchable className="pc-choice-picker--mono"
            options={models.map(m => ({ value: m.id, label: displayModel(m.id), description: optionDescription(m) }))}
            onValueChange={changePicked} />
        </Field>
      </> : <>
        <p role="alert" className="u3-muted">{listing?.note ?? "The model list is not available."} Save a model id anyway; the next test task verifies it.</p>
        <Field label="Model id">
          <TextInput value={hasDeclarations ? draft?.default ?? "" : picked} disabled={saving} onInput={e => changePicked(e.currentTarget.value)} />
        </Field>
      </>}
      <ResourceState resource={declarations}>
        <h3>Models for tasks</h3>
        <ResourceState resource={config}>{draft && config.data && <p className="u3-muted">{tierSummary(draft.models, config.data.config.tierTargets)}</p>}</ResourceState>
        {draft?.models.map(row => {
          const offered = models?.find(m => m.id === row.id);
          const suggestion = offered && row.tier === "unknown" ? suggestTier(offered) : null;
          const rowWarning = listing ? modelWarning(listing, row.id, listing.provider ?? provider) : null;
          return <div key={row.id} role="group" aria-label={displayModel(row.id)}>
            <p>{displayModel(row.id)}</p>
            {rowWarning && <Alert tone="warning" title={rowWarning}><Button size="sm" disabled={saving} onClick={() => replace(row.id)}>Replace…</Button></Alert>}
            <div className="u3-actions" role="group" aria-label={`Tier for ${displayModel(row.id)}`}>
              {(Object.keys(tierLabels) as ModelDeclaration["tier"][]).map(tier => <FilterChip key={tier} selected={row.tier === tier} disabled={saving}
                onClick={() => edit({type: "tier", id: row.id, tier})}>{tierLabels[tier]}</FilterChip>)}
              {suggestion && <Button size="sm" disabled={saving} onClick={() => edit({type: "tier", id: row.id, tier: suggestion})}>Suggested: {tierLabels[suggestion]}</Button>}
              <Button size="sm" disabled={saving} aria-label={`Remove ${displayModel(row.id)}`} onClick={() => edit({type: "remove", id: row.id})}>Remove</Button>
            </div>
          </div>;
        })}
        <Field label={replacing ? `Replace ${displayModel(replacing)}` : "Add model"}>
          {models?.length ? <ChoicePicker ref={addPicker} value={adding} searchable disabled={saving || save.busy}
            options={models.filter(m => !draft?.models.some(row => row.id === m.id)).map(m => ({value: m.id, label: displayModel(m.id), description: optionDescription(m)}))}
            onValueChange={chooseAddition} /> : <TextInput value={adding} disabled={saving} onInput={e => setAdding(e.currentTarget.value)} />}
        </Field>
        <Button size="sm" disabled={!draft || saving || save.busy || !adding.trim() || draft.models.some(m => m.id === adding.trim())}
          onClick={addModel}>Add model</Button>
      </ResourceState>
      <ErrorMessage error={error} />
      {notice && <p role="status">{notice}</p>}
      {warnings.map(w => <Alert key={w} tone="warning" title={w} />)}
      <div className="u3-actions">
        <Button variant="primary" disabled={!!save.unavailable || save.busy || saving || unchanged || (hasDeclarations && (declarations.loading || !!declarations.error || !draft || draft.runner !== runner || !draft.default || (declared && !draft.models.some(m => m.id === draft.default))))} onClick={saveModel}>Save model</Button>
      </div>
      <Feedback action={save} />
      <Feedback action={check} />
    </ResourceState>
  </Section>;
}

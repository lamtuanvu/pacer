import type { DispatchConfig } from "../../../../src/dispatch/types";
import { executorLabel } from "../../../../src/view-model/words";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { Field, TextArea, TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Identicon } from "../../ds/Identicon";
import { Pill } from "../../ds/Pill";
import { SaveBar } from "../../ds/SaveBar";
import { SectionHeading } from "../../ds/SectionHeading";
import { SortableList } from "../../ds/SortableList";
import type { Rule } from "../../model/executors";
import type { ProjectStrategyView } from "../../model/project-strategies";
import type { StrategyRow } from "../../model/strategy";
import { countSetupChanges, discardSetup, ladderChanges, type EligibilityDraft, type SetupDraft } from "../../model/dispatcher-setup";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { DispatcherLadderFields, type DispatcherConfigView } from "./Dispatcher";
import { Feedback, ResourceState, Section, useOperation, useResource } from "./shared";

/** Saved setups are named strategy profiles; each is marked with a deterministic identicon. */
export function SavedSetups({ initialData, onActivated }: { initialData?: StrategyRow[]; onActivated?: () => void }) {
  const query = useResource("strategy.list", {}, initialData), action = useOperation(query.reload);
  const [building, setBuilding] = useState(false), [brief, setBrief] = useState("");
  return <Section id="saved-profiles" title="Saved setups" detail="Each setup saves global planner, pacing, eligibility and dispatcher settings. Switch anytime."
    actions={<Button onClick={() => setBuilding(value => !value)} aria-expanded={building}>New from a brief</Button>}>
    <ResourceState resource={query} empty="No saved setups yet.">
      {query.data?.map(strategy => <div className="u3-setting" key={strategy.name}>
        <div><span className="u3-actions"><Identicon seed={strategy.name} /><strong>{strategy.name}</strong></span></div>
        <div className="u3-row">
          <span>{strategy.summary}</span>
          {strategy.active ? <Pill tone="good">Active</Pill>
            : <Button aria-label={`Use ${strategy.name}`} disabled={action.busy} onClick={() => void action.run("strategy.use", { name: strategy.name }, onActivated)}>Use</Button>}
        </div>
      </div>)}
    </ResourceState>
    {building && <form className="pc-card" onSubmit={event => { event.preventDefault(); void action.run("strategy.build", { brief }); }}>
      <Field label="What should this setup do?"><TextArea value={brief} maxLength={2000} required onInput={event => setBrief(event.currentTarget.value)} /></Field>
      <div><Button type="submit" disabled={action.busy}>Build setup</Button></div>
      <p className="u3-muted">Opens a planning session or returns a command to run.</p>
    </form>}
    <Feedback action={action} />
  </Section>;
}

export type EligibilitySource =
  | { kind: "global"; rules: Rule[]; available: string[] }
  | { kind: "project"; repo: string; repoLabel: string; view: ProjectStrategyView };

const ruleTitle = (rule: Rule) => rule.kinds ? (rule.kinds.length ? `Task kinds: ${rule.kinds.join(", ")}` : "New task-kind rule") : "Everything else";
const splitKinds = (value: string) => value.split(",").map(kind => kind.trim()).filter(Boolean);
const rank = (index: number) => <span className="u3-muted">{index === 0 ? "First choice" : `Fallback ${index}`}</span>;
const profileName = /^[a-z0-9][a-z0-9-]{0,39}$/;

function ExecutorPool({ label, pool, onAdd, disabled }: { label: string; pool: { key: string; label: string }[]; onAdd: (key: string) => void; disabled?: boolean }) {
  return <div className="pc-stack pc-stack--compact" role="group" aria-label={label}>
    <SectionHeading>Available executors</SectionHeading>
    {pool.length ? <div className="u3-actions">{pool.map(item => <Button key={item.key} size="sm" variant="quiet" disabled={disabled}
      aria-label={`Add ${item.label}`} onClick={() => onAdd(item.key)}>Add {item.label}</Button>)}</div>
      : <p className="u3-muted">Every executor is already in this list.</p>}
  </div>;
}

function GlobalRules({ rules, available, disabled, onChange }: { rules: Rule[]; available: string[]; disabled: boolean; onChange: (rules: Rule[]) => void }) {
  const patch = (index: number, rule: Rule) => onChange(rules.map((item, at) => at === index ? rule : item));
  const addRule = () => { const at = rules.findIndex(rule => !rule.kinds); const next = [...rules]; next.splice(at < 0 ? next.length : at, 0, { kinds: [], executors: [] }); onChange(next); };
  return <div className="pc-stack pc-stack--normal">
    <p>Each task kind gets an ordered list of executors. The first matching rule wins, and &ldquo;Everything else&rdquo; covers the rest.</p>
    {rules.map((rule, index) => {
      const title = ruleTitle(rule);
      return <div className="pc-card" key={index}>
        <div className="u3-row"><SectionHeading>{title}</SectionHeading>
          {rule.kinds && <Button size="sm" variant="quiet" disabled={disabled} aria-label={`Remove rule ${title}`} onClick={() => onChange(rules.filter((_, at) => at !== index))}>Remove rule</Button>}</div>
        {rule.kinds && <Field label={`Rule ${index + 1} task kinds`} help="Separate task kinds with commas."><TextInput value={rule.kinds.join(", ")} disabled={disabled} placeholder="For example, tests, docs"
          onChange={event => patch(index, { ...rule, kinds: splitKinds(event.currentTarget.value) })} /></Field>}
        <div className="u3-settings-grid">
          {rule.executors.length ? <SortableList label={`Executors for ${title}, in priority order`} disabled={disabled}
            items={rule.executors.map((id, at) => ({ key: id, label: executorLabel(id), detail: rank(at) }))}
            onReorder={executors => patch(index, { ...rule, executors })}
            onRemove={id => patch(index, { ...rule, executors: rule.executors.filter(item => item !== id) })} />
            : <p role="status">Add at least one executor to this rule.</p>}
          <ExecutorPool label={`Executors to add to ${title}`} disabled={disabled}
            pool={available.filter(id => !rule.executors.includes(id)).map(id => ({ key: id, label: executorLabel(id) }))}
            onAdd={id => patch(index, { ...rule, executors: [...rule.executors, id] })} />
        </div>
      </div>;
    })}
    <div><Button disabled={disabled} onClick={addRule}>Add task-kind rule</Button></div>
  </div>;
}

function ProjectOrder({ source, executors, disabled, onChange, onUseGlobal }: { source: Extract<EligibilitySource, { kind: "project" }>; executors: string[]; disabled: boolean; onChange: (executors: string[]) => void; onUseGlobal: () => void }) {
  const label = (reference: string) => source.view.available.find(runner => runner.reference === reference)?.label ?? reference;
  return <div className="pc-stack pc-stack--normal">
    <p>{source.view.executors ? `${source.repoLabel} uses its own executor order, overriding the global rules.` : `${source.repoLabel} uses the global rules. Add executors to give it its own order.`} Unavailable executors are skipped, and fallback stays within this list.</p>
    <div className="u3-settings-grid">
      {executors.length ? <SortableList label={`Allowed executors for ${source.repoLabel}, in priority order`} disabled={disabled}
        items={executors.map((reference, at) => ({ key: reference, label: label(reference), detail: rank(at) }))}
        onReorder={onChange} onRemove={reference => onChange(executors.filter(item => item !== reference))} />
        : <p className="u3-muted">{source.view.executors ? "Saving removes this project order, and the global rules apply again." : "No project order yet."}</p>}
      <ExecutorPool label={`Executors to add for ${source.repoLabel}`} disabled={disabled}
        pool={source.view.available.filter(runner => !executors.includes(runner.reference)).map(runner => ({ key: runner.reference, label: runner.label }))}
        onAdd={reference => onChange([...executors, reference])} />
    </div>
    {source.view.executors && executors.length > 0 && <div><Button disabled={disabled} onClick={onUseGlobal}>Use global rules</Button></div>}
  </div>;
}

function initialSetup(view: DispatcherConfigView, source: EligibilitySource): SetupDraft {
  const eligibility: EligibilityDraft = source.kind === "global"
    ? { kind: "global", saved: source.rules, draft: structuredClone(source.rules) }
    : { kind: "project", saved: source.view.executors ?? [], draft: [...(source.view.executors ?? [])] };
  return { eligibility, savedLadder: view.config, ladder: structuredClone(view.config) };
}

function blockedReason(setup: SetupDraft, ladderDirty: boolean, name: string, reason: string, connected: boolean): string | undefined {
  if (!connected) return "Reconnect to save. Your changes stay here.";
  const { eligibility } = setup;
  if (eligibility.kind === "global" && rulesChanged(eligibility)) {
    if (eligibility.draft.some(rule => !rule.executors.length)) return "Each rule needs at least one executor.";
    if (eligibility.draft.some(rule => rule.kinds && !rule.kinds.length)) return "Name the task kinds for each rule.";
  }
  if (ladderDirty && (!profileName.test(name) || name === "default")) return "Name the new profile in step 3 using lowercase letters, numbers or hyphens.";
  if (ladderDirty && !reason.trim()) return "Give a reason for the ladder change in step 3.";
  return undefined;
}
const rulesChanged = (eligibility: Extract<EligibilityDraft, { kind: "global" }>) => JSON.stringify(eligibility.saved) !== JSON.stringify(eligibility.draft);

/**
 * Steps 2 and 3 of the guided setup with one SaveBar. Eligibility saves through the routing
 * or project operations; a ladder change is validated, saved as a new profile, then activated.
 */
export function SetupEditor({ view, eligibility: source, onSaved, onDirtyChange, notice }: { view: DispatcherConfigView; eligibility: EligibilitySource; onSaved: (notice: string) => void; onDirtyChange: (dirty: boolean) => void; notice?: string }) {
  const { state, api } = useTaskContext();
  const [setup, setSetup] = useState(() => initialSetup(view, source));
  const [name, setName] = useState(""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const count = countSetupChanges(setup), ladderDirty = ladderChanges(setup.savedLadder, setup.ladder) > 0;
  useEffect(() => onDirtyChange(count > 0), [count > 0]);
  const disabled = busy || !state.connected;
  const setEligibility = (draft: Rule[] | string[]) => setSetup(current => ({ ...current, eligibility: { ...current.eligibility, draft } as EligibilityDraft }));
  const discard = () => { setSetup(discardSetup); setError(undefined); };
  const blocked = blockedReason(setup, ladderDirty, name, reason, state.connected);
  const call = api.call.bind(api);

  const save = async () => {
    if (busy || blocked || !count) return;
    setBusy(true); setError(undefined);
    const done: string[] = [];
    try {
      const { eligibility } = setup;
      if (eligibility.kind === "global" && rulesChanged(eligibility)) {
        await call("routing.set", { rules: eligibility.draft });
        done.push("executor rules");
      }
      if (eligibility.kind === "project" && source.kind === "project" && JSON.stringify(eligibility.saved) !== JSON.stringify(eligibility.draft)) {
        if (eligibility.draft.length) {
          await call("project.strategy.set", { repo: source.repo, executors: eligibility.draft, expect_rev: source.view.rev });
          done.push("project order");
        } else {
          await call("project.strategy.remove", { repo: source.repo, expect_rev: source.view.rev });
          done.push(`removal of the project order; ${source.repoLabel} now uses the global rules`);
        }
      }
      if (ladderDirty) {
        const latest = await call<DispatcherConfigView>("dispatch.config.get", {});
        if (latest.strategy !== view.strategy || JSON.stringify(latest.config) !== JSON.stringify(view.config)) throw new Error("The active profile changed in another client. Reload this page before saving the ladder.");
        const draft = { from: view.strategy, set: { dispatch: setup.ladder } };
        const validation = await call<{ ok: boolean; errors: string[] }>("strategy.preview", { draft });
        if (!validation.ok) throw new Error(validation.errors.join(" ") || "The ladder needs changes before it can be saved.");
        await call("strategy.save", { name, draft, reason: reason.trim() });
        try { await call("strategy.use", { name }); }
        catch (failure) { throw new Error(`Saved ${name}, but it could not be activated: ${failure instanceof Error ? failure.message : String(failure)}`); }
        done.push(`profile ${name}, now active`);
      }
      onSaved(`Saved ${done.join(" and ")}.`);
    } catch (failure) {
      setError(done.length ? new Error(`Saved ${done.join(" and ")}. ${failure instanceof Error ? failure.message : String(failure)}`) : failure);
      if (done.length) onSaved("");
    } finally { setBusy(false); }
  };

  return <>
    <Section id="executor-eligibility" title="2. Who may do the work" detail={source.kind === "global" ? "Global rules for every repository without its own order." : `Executor order for ${source.repoLabel}.`}>
      {setup.eligibility.kind === "global" && source.kind === "global"
        ? <GlobalRules rules={setup.eligibility.draft} available={source.available} disabled={disabled} onChange={setEligibility} />
        : source.kind === "project" && setup.eligibility.kind === "project"
          ? <ProjectOrder source={source} executors={setup.eligibility.draft} disabled={disabled} onChange={setEligibility} onUseGlobal={() => setEligibility([])} />
          : null}
    </Section>
    <Section id="decision-ladder" title="3. Choice ladder" detail="Pacer ranks eligible accounts and models with the first matching step. The ladder applies to every repository.">
      {view.config.engine !== "ladder"
        ? <p>This setup uses the plugin decision engine {view.config.engine.slice(7)}. Edit its plugin configuration in the strategy file. {view.config.engineFallback === "ladder" ? "If the plugin cannot decide, Pacer uses the ladder." : "If the plugin cannot decide, Pacer queues the work."}</p>
        : <div className="pc-stack pc-stack--section">
          <DispatcherLadderFields config={setup.ladder} disabled={disabled} onChange={ladder => setSetup(current => ({ ...current, ladder }))} />
          {ladderDirty && <div className="pc-card pc-stack pc-stack--normal">
            <SectionHeading>Save the ladder as a new profile</SectionHeading>
            <p>The current profile stays active until the new one is saved, validated and activated.</p>
            <Field label="Profile name" help="Lowercase letters, numbers and hyphens. The default profile stays unchanged."><TextInput value={name} maxLength={40} disabled={disabled} onInput={event => setName(event.currentTarget.value)} /></Field>
            <Field label="Reason for change"><TextInput value={reason} maxLength={500} disabled={disabled} onInput={event => setReason(event.currentTarget.value)} /></Field>
          </div>}
        </div>}
    </Section>
    <SaveBar count={count} busy={busy} onSave={() => void save()} onDiscard={discard} blockedReason={blocked} notice={notice || undefined}
      saveLabel={ladderDirty ? "Validate and save" : "Save setup"}>
      {busy || error ? <>{busy && <p>Saving…</p>}<ErrorMessage error={error} /></> : undefined}
    </SaveBar>
  </>;
}

function ScopedEditor({ view, scope, repoLabel, onSaved, onDirtyChange, notice }: { view: DispatcherConfigView; scope: string; repoLabel: string; onSaved: (notice: string) => void; onDirtyChange: (dirty: boolean) => void; notice: string }) {
  const query = useResource<{ rules: Rule[]; available: string[] } | ProjectStrategyView>(scope ? "project.strategy.get" : "routing.get", scope ? { repo: scope } : {});
  const data = query.data;
  if (!data) return <Section id="executor-eligibility" title="2. Who may do the work">
    <p role={query.error ? "alert" : "status"}>{query.error ? "Executor settings could not be loaded." : "Loading executor settings…"}</p>
    <ErrorMessage error={query.error} />{query.error && <div><Button onClick={query.reload}>Try again</Button></div>}
  </Section>;
  const source: EligibilitySource = scope && "repo" in data ? { kind: "project", repo: scope, repoLabel, view: data } : { kind: "global", rules: (data as { rules: Rule[] }).rules, available: (data as { available: string[] }).available };
  const revision = JSON.stringify(["repo" in data ? data.rev : data.rules, view.strategy, view.config]);
  return <SetupEditor key={revision} view={view} eligibility={source} onDirtyChange={onDirtyChange} notice={notice}
    onSaved={notice => { onSaved(notice); query.reload(); }} />;
}

type ScopeOption = { value: string; label: string };
/** Repositories with a saved override stay editable even when their checkout is absent. */
function ProjectScopeOptions({ children }: { children: (options: ScopeOption[]) => preact.ComponentChildren }) {
  const { state } = useTaskContext();
  const policies = useResource<ProjectStrategyView[]>("project.strategy.list", {});
  const options = new Map((state.snapshot?.repos ?? []).map(repo => [repo.key, repo.label]));
  for (const policy of policies.data ?? []) if (!options.has(policy.repo.key)) options.set(policy.repo.key, `${policy.repo.label} (not checked out)`);
  return <>{children([...options].map(([value, label]) => ({ value, label })))}</>;
}

/** The guided dispatcher setup: scope, who may work, the choice ladder; Try a task follows it. */
export function DispatcherGuidedSetup({ view, onSaved }: { view: DispatcherConfigView; onSaved: () => void }) {
  const { state } = useTaskContext();
  const ops = state.features.ops;
  const projectOps = ["get", "list", "set", "remove"].every(op => ops.has(`project.strategy.${op}`));
  if (!ops.has("routing.get") || !ops.has("routing.set")) return <Section id="dispatcher-scope" title="Guided setup"><p>Update the service to edit executor rules here.</p></Section>;
  return projectOps ? <ProjectScopeOptions>{repos => <GuidedSetup view={view} onSaved={onSaved} repos={repos} />}</ProjectScopeOptions>
    : <GuidedSetup view={view} onSaved={onSaved} repos={[]} />;
}
function GuidedSetup({ view, onSaved, repos }: { view: DispatcherConfigView; onSaved: () => void; repos: ScopeOption[] }) {
  const [scope, setScope] = useState(""), [dirty, setDirty] = useState(false), [notice, setNotice] = useState("");
  const options = [{ value: "", label: "All repositories" }, ...repos];
  return <>
    <Section id="dispatcher-scope" title="1. Scope" detail="Choose whether to edit the rules for every repository or one repository's own executor order.">
      <Field label="Edit settings for" help={dirty ? "Save or discard your changes to switch scope." : undefined}>
        <ChoicePicker value={scope} searchable={options.length > 8} disabled={dirty} options={options} onValueChange={value => { setScope(value); setNotice(""); }} />
      </Field>
    </Section>
    <ScopedEditor key={scope} view={view} scope={scope} notice={notice} repoLabel={options.find(option => option.value === scope)?.label ?? scope}
      onDirtyChange={setDirty} onSaved={message => { setNotice(message); onSaved(); }} />
  </>;
}

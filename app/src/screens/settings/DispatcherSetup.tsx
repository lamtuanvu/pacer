import { agentKey, markAgent } from "../../../../src/view-model/agents";
import { executorReadiness } from "../../../../src/view-model/capacity";
import { executorLabel } from "../../../../src/view-model/words";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ButtonLink, IconButton, TextAction, Button } from "../../ds/Button";
import { Disclosure, Field, TextArea, TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { AgentMark } from "../../ds/AgentMark";
import { Icon } from "../../ds/icons";
import { SegmentedControl, Tabs } from "../../ds/Patterns";
import { hrefFor, routes } from "../../router";
import { Identicon } from "../../ds/Identicon";
import { Tooltip } from "../../ds/Tooltip";
import { Pill } from "../../ds/Pill";
import { SettingRow } from "../../ds/SettingRow";
import { SaveBar } from "../../ds/SaveBar";
import { SectionHeading } from "../../ds/SectionHeading";
import { SortableList, useFocusAfterRender, useStableKeys } from "../../ds/SortableList";
import type { Rule } from "../../model/executors";
import type { SortableItem } from "../../ds/SortableList";
import type { ProjectStrategyView } from "../../model/project-strategies";
import type { StrategyRow } from "../../model/strategy";
import { countSetupChanges, discardSetup, eligibilityChanges, ladderChanges, PartialSaveError, reconcileSetup, saveSetup, strategyDraft, type EligibilityDraft, type SetupDraft, type StrategyDraft } from "../../model/dispatcher-setup";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { DispatcherLadderFields, DispatcherReadError, ListField, type DispatcherConfigView } from "./Dispatcher";
import { Feedback, ResourceState, Section, useOperation, useResource, containTooltipEscape } from "./shared";

export type EligibilitySource =
  | { kind: "global"; rules: Rule[]; available: string[] }
  | { kind: "project"; repo: string; repoLabel: string; view: ProjectStrategyView };

const ruleTitle = (rule: Rule) => rule.kinds ? (rule.kinds.length ? `Task kinds: ${rule.kinds.join(", ")}` : "New task-kind rule") : "Everything else";
const splitKinds = (value: string) => value.split(",").map(kind => kind.trim()).filter(Boolean);
const profileName = /^[a-z0-9][a-z0-9-]{0,39}$/, reconnect = "Reconnect to save. Your changes stay here.";

const buttons = (root: Element | null | undefined, selector: string) => [...(root?.querySelectorAll<HTMLButtonElement>(selector) ?? [])];

/** An ordered executor list beside the pool of executors that can still be added. */
function OrderWithPool({ label, title, items, onChange, pool, empty, disabled }: { label: string; title?: string; items: (SortableItem & { id?: string })[]; onChange: (keys: string[]) => void; pool: { key: string; label: string; id?: string }[]; empty: string; disabled: boolean }) {
  const { state } = useTaskContext();
  const keys = items.map(item => item.key), group = useRef<HTMLDivElement>(null), focusAfter = useFocusAfterRender();
  const metadata = (id: string) => {
    const runner = state.snapshot?.executors?.find(row => row.id === id);
    const status = runner && state.snapshot ? executorReadiness(runner, state.snapshot) : undefined;
    return { runner, status };
  };
  const add = (key: string, index: number) => { focusAfter(() => { const left = buttons(group.current, "button"); return left[Math.min(index, left.length - 1)] ?? group.current; }); onChange([...keys, key]); };
  return <div className="dispatcher-order-container">
    <div className="dispatcher-order-grid">
      <div className="pc-stack pc-stack--compact">
        {title && <SectionHeading as="h3">{title}</SectionHeading>}
        <SortableList iconControls label={`${label}, in priority order`} disabled={disabled} items={items.map((item, index) => {
          const { runner, status } = metadata(item.id ?? item.key);
          const name = executorLabel(item.id ?? item.key);
          return { ...item, displayLabel: name,
            leading: <><span className="pc-executor-rank">{index + 1}</span><AgentMark agent={agentKey(markAgent(runner?.id ?? item.id ?? item.key, runner?.account)) ?? "opencode"} size={24} labelled={false} /></>,
            detail: item.detail,
            trailing: status && <span className="pc-executor-state" onKeyDown={containTooltipEscape}><Tooltip text={`${status.reason}. ${status.tooltip}`}><span tabIndex={0}><Pill tone={status.tone}>{status.label}</Pill></span></Tooltip></span> };
        })} onReorder={onChange} onRemove={key => { if (keys.length === 1) focusAfter(() => buttons(group.current, "button")[0] ?? group.current); onChange(keys.filter(item => item !== key)); }} />
        {!items.length && <p>{empty}</p>}
      </div>
      <div className="pc-stack pc-stack--compact">
        <SectionHeading as="h3">Available executors</SectionHeading>
        <div ref={group} className="pc-executor-pool" role="group" aria-label={`Add to ${label}`} tabIndex={-1} data-executor-pool="">
          {pool.length ? pool.map((item, index) => {
            const { runner, status } = metadata(item.id ?? item.key);
            const unavailable = runner && (runner.eligibility?.state === "ineligible" || ["disabled", "blocked", "down", "failing", "exhausted"].includes(runner.state));
            return <div key={item.key} className={`pc-executor-pool__row${unavailable ? " pc-executor-pool__row--unavailable" : ""}`}>
              <AgentMark agent={agentKey(markAgent(runner?.id ?? item.id ?? item.key, runner?.account)) ?? "opencode"} size={20} labelled={false} />
              <span className="pc-executor-pool__identity"><strong>{item.label}</strong><span onKeyDown={containTooltipEscape}>{status ? <Tooltip text={status.tooltip}><span className="pc-executor-caption" tabIndex={0}>{status.reason}</span></Tooltip> : <span className="pc-executor-caption">Refresh to confirm availability</span>}</span></span>
              {unavailable ? <TextAction href={hrefFor(routes.settings("executors"))}>Fix</TextAction> : <IconButton size="sm" disabled={disabled} aria-label={`Add ${item.label}`} onClick={() => add(item.key, index)}><span aria-hidden="true">+</span></IconButton>}
            </div>;
          }) : <p className="pc-executor-caption pc-executor-pool__empty">Every executor is in the list.</p>}
          <ButtonLink size="sm" variant="quiet" className="pc-executor-pool__setup" href={hrefFor(routes.addExecutor())}>+ Set up a new executor</ButtonLink>
        </div>
      </div>
    </div>
    {items.length === 1 && <p className="pc-dispatcher-callout pc-dispatcher-callout--warn"><span className="pc-dispatcher-callout__glyph" aria-hidden="true">◐</span>Only one executor: if {items[0]!.label} cannot take work, these tasks wait in the queue. There is no fallback.</p>}
  </div>;
}

const kindLabel = (rule: Rule) => rule.kinds ? rule.kinds.length ? rule.kinds.join(", ") : "New task-kind rule" : "Everything else";
function GlobalRules({ rules, available, disabled, onChange, onActiveKind }: { rules: Rule[]; available: string[]; disabled: boolean; onChange: (rules: Rule[]) => void; onActiveKind: (kind: string) => void }) {
  const root = useRef<HTMLDivElement>(null), keys = useStableKeys(rules.length), focusAfter = useFocusAfterRender();
  const [selected, setSelected] = useState(0), tabId = useId();
  const active = Math.min(selected, Math.max(0, rules.length - 1));
  const rule = rules[active];
  useEffect(() => onActiveKind(rule ? kindLabel(rule) : "Everything else"), [rule && kindLabel(rule)]);
  const patch = (index: number, value: Rule) => onChange(rules.map((item, at) => at === index ? value : item));
  const addRule = () => {
    const at = rules.findIndex(rule => !rule.kinds), index = at < 0 ? rules.length : at, next = [...rules];
    next.splice(index, 0, { kinds: [], executors: [] });
    keys.current.splice(index, 0, `new${Date.now()}`);
    setSelected(index);
    focusAfter(() => root.current?.querySelector<HTMLInputElement>("[data-list-field=kinds]"));
    onChange(next);
  };
  const removeRule = (index: number) => {
    keys.current.splice(index, 1);
    const next = Math.min(index, rules.length - 2);
    setSelected(Math.max(0, next));
    focusAfter(() => buttons(root.current, '[role="tab"]')[Math.max(0, next)] ?? buttons(root.current, "[data-rule-add]")[0]);
    onChange(rules.filter((_, at) => at !== index));
  };
  return <div ref={root} className="pc-stack pc-stack--normal">
    <Tabs label="Task type" id={`rule-${tabId}`} value={String(keys.current[active])} onChange={value => setSelected(keys.current.findIndex(key => String(key) === value))}
      options={rules.map((value, index) => ({ value: String(keys.current[index]), label: <>{kindLabel(value)} <span className="pc-dispatcher-tabs__count">{value.executors.length}</span></> }))} />
    {rules.map((_, index) => index !== active && <div key={keys.current[index]} hidden role="tabpanel" id={`rule-${tabId}-${keys.current[index]}-panel`} aria-labelledby={`rule-${tabId}-${keys.current[index]}-tab`} />)}
    {rule && <div role="tabpanel" id={`rule-${tabId}-${keys.current[active]}-panel`} aria-labelledby={`rule-${tabId}-${keys.current[active]}-tab`} className="pc-stack pc-stack--normal">
      {rule.kinds && <div className="u3-row">
        <ListField label={`Rule ${active + 1} task kinds`} help="Separate task kinds with commas." marker="kinds" value={rule.kinds} disabled={disabled}
          placeholder="For example, tests, docs" onText={text => patch(active, { ...rule, kinds: splitKinds(text) })} />
        <Button size="sm" variant="quiet" disabled={disabled} data-rule-remove="" aria-label={`Remove rule: ${ruleTitle(rule)}`} onClick={() => removeRule(active)}>Remove rule</Button>
      </div>}
      <OrderWithPool label={`Executors for ${ruleTitle(rule)}`} title={`${kindLabel(rule)}${rule.kinds ? " tasks" : ""} · in order`} disabled={disabled} empty="Add at least one executor to this rule."
        items={rule.executors.map(id => ({ key: id, label: executorLabel(id) }))} onChange={executors => patch(active, { ...rule, executors })}
        pool={available.filter(id => !rule.executors.includes(id)).map(id => ({ key: id, label: executorLabel(id) }))} />
    </div>}
    <div><Button disabled={disabled} data-rule-add="" onClick={addRule}>Add task-kind rule</Button></div>
  </div>;
}

function ProjectOrder({ source, executors, disabled, onChange }: { source: Extract<EligibilitySource, { kind: "project" }>; executors: string[]; disabled: boolean; onChange: (executors: string[]) => void }) {
  const root = useRef<HTMLDivElement>(null), focusAfter = useFocusAfterRender();
  const runner = (reference: string) => source.view.available.find(item => item.reference === reference);
  const useGlobal = () => { focusAfter(() => buttons(root.current, "[data-executor-pool] button")[0] ?? root.current?.querySelector<HTMLElement>("[data-executor-pool]")); onChange([]); };
  return <div ref={root} className="pc-stack pc-stack--normal">
    <p>{source.view.executors ? "Agents marked Skipped, Cannot take work or Off receive no new work." : "Add executors to give this repository its own order."}</p>
    <OrderWithPool label={`Allowed executors for ${source.repoLabel}`} disabled={disabled} onChange={onChange}
      empty={source.view.executors ? "Saving restores the global rules." : "No project order yet."}
      items={executors.map(reference => ({ key: reference, id: runner(reference)?.id, label: runner(reference)?.label ?? executorLabel(reference),
        detail: !runner(reference) && <span className="u3-muted">Unavailable in the active setup</span> }))}
      pool={source.view.available.filter(item => !executors.includes(item.reference)).map(item => ({ key: item.reference, id: item.id, label: item.label }))} />
    {source.view.executors && executors.length > 0 && <div><Button disabled={disabled} onClick={useGlobal}>Use global rules</Button></div>}
  </div>;
}

function initialSetup(view: DispatcherConfigView, source: EligibilitySource): SetupDraft {
  const eligibility: EligibilityDraft = source.kind === "global"
    ? { kind: "global", saved: source.rules, draft: structuredClone(source.rules) }
    : { kind: "project", saved: source.view.executors ?? [], draft: [...(source.view.executors ?? [])], rev: source.view.rev };
  return { eligibility, savedLadder: view.config, ladder: structuredClone(view.config), strategy: view.strategy };
}

function blockedReason(setup: SetupDraft, ladderDirty: boolean, name: string, reason: string, connected: boolean): string | undefined {
  if (!connected) return reconnect;
  const { eligibility } = setup;
  if (eligibility.kind === "global" && eligibilityChanges(eligibility)) {
    if (eligibility.draft.some(rule => !rule.executors.length)) return "Each rule needs at least one executor.";
    if (eligibility.draft.some(rule => rule.kinds && !rule.kinds.length)) return "Name the task kinds for each rule.";
  }
  if (ladderDirty && (!profileName.test(name) || name === "default")) return "Name the new saved setup in step 3.";
  if (ladderDirty && !reason.trim()) return "Give a reason in step 3.";
  return undefined;
}

/**
 * Steps 2 and 3 of the guided setup with one SaveBar. Freshly loaded settings merge into the
 * open draft part by part (see reconcileSetup), so a refetch or a partial save never drops edits.
 */
export function SetupEditor({ view, eligibility: source, onSaved, onDirtyChange, onLadderDraft, notice }: { view: DispatcherConfigView; eligibility: EligibilitySource; onSaved: (notice: string) => void; onDirtyChange: (dirty: boolean) => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void; notice?: string }) {
  const { state, api } = useTaskContext();
  const incoming = initialSetup(view, source);
  const latest = useRef(incoming); latest.current = incoming;
  const [setup, setSetup] = useState(() => incoming);
  const [activeKind, setActiveKind] = useState(source.kind === "global" && source.rules[0] ? kindLabel(source.rules[0]) : "Everything else");
  const [conflict, setConflict] = useState(false), [savedScope, setSavedScope] = useState("");
  const [name, setName] = useState(""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const signature = JSON.stringify([incoming.eligibility.saved, incoming.eligibility.kind === "project" ? incoming.eligibility.rev : null, incoming.savedLadder, incoming.strategy]);
  useEffect(() => {
    setSetup(current => { const merged = reconcileSetup(current, latest.current); setConflict(merged.conflict); return merged.setup; });
  }, [signature]);
  const count = countSetupChanges(setup), ladderDirty = ladderChanges(setup.savedLadder, setup.ladder) > 0;
  useEffect(() => onDirtyChange(count > 0), [count > 0]);
  // Try a task can preview the unsaved ladder; report it whenever it changes.
  const draft = strategyDraft(setup), draftKey = JSON.stringify(draft ?? null);
  useEffect(() => { onLadderDraft?.(draft); }, [draftKey]);
  useEffect(() => () => onLadderDraft?.(undefined), []);
  // With nothing left to save, follow the latest saved settings, so a later edit never builds on a stale base.
  useEffect(() => { if (!count) { setSetup(discardSetup(latest.current)); setConflict(false); setName(""); setReason(""); } }, [count]);
  const listScope = source.kind === "project" ? `${source.repoLabel} list` : `Global list for ${activeKind}${activeKind === "Everything else" ? "" : " tasks"}`;
  const setupScope = name || "New saved setup";
  // Both parts save together, so name both.
  const scopeText = ladderDirty ? (eligibilityChanges(setup.eligibility) ? `${listScope} and ${setupScope}` : setupScope) : listScope;
  const disabled = busy || !state.connected;
  const setEligibility = (draft: Rule[] | string[]) => setSetup(current => ({ ...current, eligibility: { ...current.eligibility, draft } as EligibilityDraft }));
  // Discard loads the latest saved settings, which also resolves a conflict.
  const discard = () => { setSetup(discardSetup(latest.current)); setConflict(false); setError(undefined); };
  const blocked = blockedReason(setup, ladderDirty, name, reason, state.connected);
  const [editingLadder, setEditingLadder] = useState(false);
  const engine = view.config.engine, ladderEditable = engine === "ladder" || view.config.engineFallback === "ladder";

  const save = async () => {
    if (busy || blocked || !count) return;
    setBusy(true); setError(undefined);
    try {
      const done = await saveSetup({ call: api.call.bind(api), setup, repo: source.kind === "project" ? { key: source.repo, label: source.repoLabel } : undefined, profile: { name, reason } });
      setSavedScope(scopeText);
      onSaved(`Saved ${done.join(" and ")}.`);
    } catch (failure) {
      setError(failure);
      // Reload what did save; the unsaved part stays in the draft (reconcileSetup keeps it).
      if (failure instanceof PartialSaveError) onSaved("");
    } finally { setBusy(false); }
  };

  return <>
    {!state.connected && <p role="status" className="u3-muted">{reconnect}</p>}
    <Section step={2} id="executor-eligibility" title="Who may do the work?" detail={source.kind === "global" ? "This list limits who can be chosen. Pacer picks from it in step 3; the first executor is not always the one that runs." : `Executor order for ${source.repoLabel}.`}>
      {setup.eligibility.kind === "global" && source.kind === "global"
        ? <GlobalRules onActiveKind={setActiveKind} rules={setup.eligibility.draft} available={source.available} disabled={disabled} onChange={setEligibility} />
        : source.kind === "project" && setup.eligibility.kind === "project"
          ? <ProjectOrder source={source} executors={setup.eligibility.draft} disabled={disabled} onChange={setEligibility} />
          : null}
    <SaveBar inline alwaysVisible statusDot size="sm" scope={!count && notice && savedScope ? savedScope : scopeText} count={count} busy={busy} onSave={() => void save()} onDiscard={discard} blockedReason={blocked} notice={notice || undefined}
      saveLabel={ladderDirty ? "Validate and save" : "Save choices"}>
      {conflict || error ? <>
        {conflict && <p role="status">Another client changed these settings. Your changes are kept; Discard loads theirs.</p>}
        <ErrorMessage error={error} />
      </> : undefined}
    </SaveBar>
    </Section>
    <Section step={3} id="decision-ladder" title="How should Pacer choose?" detail={`One choice method for every repository. It runs after step 2 has decided who is eligible. From saved setup ${view.strategy}.`}>
      {engine !== "ladder" && <p>This setup uses a plugin choice method; configure it in the saved setup. If the plugin cannot decide, Pacer {view.config.engineFallback === "ladder" ? "uses this fallback ladder" : "queues the work"}.</p>}
      {ladderEditable && <><ol className="pc-choice-ladder">{setup.ladder.steps.map((step,index) => <li key={step.id}><span>{index + 1}</span><strong>{step.id === "capable-with-headroom" ? "Capable model with spare capacity" : "Usable fallback"}</strong><span className="u3-muted">Share: Not recorded</span></li>)}</ol><Button size="sm" onClick={() => setEditingLadder(value => !value)} aria-expanded={editingLadder}>Edit choice method</Button>{editingLadder && <div className="pc-stack pc-stack--section">
        <DispatcherLadderFields config={setup.ladder} disabled={disabled} onChange={ladder => setSetup(current => ({ ...current, ladder }))} />
        {ladderDirty && <div className="pc-card pc-stack pc-stack--normal">
          <SectionHeading as="h3">Save the ladder as a new saved setup</SectionHeading>
          <p>The current saved setup stays active until this one is validated and activated.</p>
          <SettingRow variant="board" label="Setup name" description="Lowercase letters, numbers and hyphens."><TextInput value={name} maxLength={40} disabled={disabled} onInput={event => setName(event.currentTarget.value)} /></SettingRow>
          <SettingRow variant="board" label="Reason for change"><TextInput value={reason} maxLength={500} disabled={disabled} onInput={event => setReason(event.currentTarget.value)} /></SettingRow>
        </div>}
      </div>}</>}
    </Section>

  </>;
}

function ScopedEditor({ view, scope, repoLabel, onSaved, onDirtyChange, onLadderDraft, notice }: { view: DispatcherConfigView; scope: string; repoLabel: string; onSaved: (notice: string) => void; onDirtyChange: (dirty: boolean) => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void; notice: string }) {
  const query = useResource<{ rules: Rule[]; available: string[] } | ProjectStrategyView>(scope ? "project.strategy.get" : "routing.get", scope ? { repo: scope } : {});
  const data = query.data;
  if (!data) return <Section step={2} id="executor-eligibility" title="Who may do the work?">
    <p role={query.error ? "alert" : "status"}>{query.error ? "Executor settings could not be loaded." : "Loading executor settings…"}</p>
    <ErrorMessage error={query.error} />{query.error && <div><Button onClick={query.reload}>Try again</Button></div>}
  </Section>;
  const source: EligibilitySource = scope && "repo" in data ? { kind: "project", repo: scope, repoLabel, view: data } : { kind: "global", rules: (data as { rules: Rule[] }).rules, available: (data as { available: string[] }).available };
  return <>
    <DispatcherReadError error={query.error} reload={query.reload} subject="executor settings" />
    <SetupEditor view={view} eligibility={source} onDirtyChange={onDirtyChange} onLadderDraft={onLadderDraft} notice={notice}
      onSaved={message => { onSaved(message); query.reload(); }} />
  </>;
}

type ScopeOption = { value: string; label: string; ownList?: boolean };
/** Repositories with a saved override stay editable even when their checkout is absent. */
function ProjectScopeOptions({ children }: { children: (options: ScopeOption[], listError: ComponentChildren) => ComponentChildren }) {
  const { state } = useTaskContext();
  const policies = useResource<ProjectStrategyView[]>("project.strategy.list", {});
  const options = new Map((state.snapshot?.repos ?? []).map(repo => [repo.key, repo.label]));
  for (const policy of policies.data ?? []) if (!options.has(policy.repo.key)) options.set(policy.repo.key, `${policy.repo.label} (no checkout)`);
  const listError = <DispatcherReadError error={policies.error} reload={policies.reload} subject="repositories with saved orders" />;
  return <>{children([...options].map(([value, label]) => ({ value, label, ownList: policies.data?.some(policy => policy.repo.key === value && !!policy.executors) })), listError)}</>;
}

/** The guided dispatcher setup: scope, who may work, the choice ladder; Try a task follows it. */
export function DispatcherGuidedSetup({ view, onSaved, onLadderDraft }: { view: DispatcherConfigView; onSaved: () => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void }) {
  const { state } = useTaskContext();
  const ops = state.features.ops;
  const projectOps = ["get", "list", "set", "remove"].every(op => ops.has(`project.strategy.${op}`));
  if (!ops.has("routing.get") || !ops.has("routing.set")) return <Section id="dispatcher-scope" title="Guided setup"><p>Update the service to edit executor rules here.</p></Section>;
  return projectOps ? <ProjectScopeOptions>{(repos, listError) => <GuidedSetup view={view} onSaved={onSaved} onLadderDraft={onLadderDraft} repos={repos} listError={listError} />}</ProjectScopeOptions>
    : <GuidedSetup view={view} onSaved={onSaved} onLadderDraft={onLadderDraft} repos={[]} />;
}
function GuidedSetup({ view, onSaved, onLadderDraft, repos, listError }: { view: DispatcherConfigView; onSaved: () => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void; repos: ScopeOption[]; listError?: ComponentChildren }) {
  const [scope, setScope] = useState(""), [dirty, setDirty] = useState(false), [notice, setNotice] = useState("");
  const [oneRepo, setOneRepo] = useState(false);
  const pickScope = (one: boolean) => { if (dirty || one === oneRepo) return; setOneRepo(one); setScope(one ? repos[0]?.value ?? "" : ""); setNotice(""); };
  const options = [{ value: "", label: "All repositories" }, ...repos];
  return <>
    <Section step={1} id="dispatcher-scope" title="Where should this apply?">
      <div className="pc-dispatcher-scope-row">
        <SegmentedControl variant="board" label="Scope" value={oneRepo ? "one" : "all"} disabled={dirty}
          describedBy={dirty ? "dispatcher-scope-reason" : !repos.length ? "dispatcher-scope-no-repo" : undefined}
          options={[{ value: "all", label: "All repositories" }, { value: "one", label: "One repository", disabled: !repos.length }]}
          onChange={value => pickScope(value === "one")} />
        {oneRepo && <div className="dispatcher-repo-picker"><ChoicePicker aria-label="Repository" className="pc-choice-picker--mono" value={scope} searchable={repos.length > 8} disabled={dirty} options={repos} onValueChange={value => { setScope(value); setNotice(""); }} /></div>}
        {oneRepo && repos.find(repo => repo.value === scope)?.ownList && <Pill tone="info">Has its own list</Pill>}
      </div>
      {dirty && <p id="dispatcher-scope-reason">Save or discard your changes to switch scope.</p>}
      {!repos.length && <p id="dispatcher-scope-no-repo" className="u3-muted">Add a repository to edit its own executor list.</p>}
      <p className="pc-dispatcher-callout pc-dispatcher-callout--info"><span className="pc-dispatcher-callout__glyph" aria-hidden="true"><Icon name="info" /></span>A repository's executor list takes precedence over the global task-type lists, and it stays in place when you switch saved setups.</p>
      {listError}
    </Section>
    <ScopedEditor key={scope} view={view} scope={scope} notice={notice} repoLabel={options.find(option => option.value === scope)?.label ?? scope}
      onDirtyChange={setDirty} onLadderDraft={onLadderDraft} onSaved={message => { setNotice(message); onSaved(); }} />
  </>;
}

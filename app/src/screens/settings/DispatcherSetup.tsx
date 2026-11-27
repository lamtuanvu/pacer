import { agentKey, markAgent } from "../../../../src/view-model/agents";
import { executorReadiness } from "../../../../src/view-model/capacity";
import { executorLabel } from "../../../../src/view-model/words";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ButtonLink, IconButton, TextAction, Button } from "../../ds/Button";
import { TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { AgentMark } from "../../ds/AgentMark";
import { Card, Tabs } from "../../ds/Patterns";
import { hrefFor, routes } from "../../router";
import { Tooltip } from "../../ds/Tooltip";
import { Pill } from "../../ds/Pill";
import { SettingRow } from "../../ds/SettingRow";
import { SaveBar } from "../../ds/SaveBar";
import { SectionHeading } from "../../ds/SectionHeading";
import { SortableList, useFocusAfterRender, useStableKeys } from "../../ds/SortableList";
import type { Rule } from "../../model/executors";
import type { SortableItem } from "../../ds/SortableList";
import type { ProjectStrategyView } from "../../model/project-strategies";
import { kinds as TASK_KINDS } from "../../model/tasks";
import { defaultRuleIndex, listAvailability, rulesSummary, type HubAgent } from "../../model/dispatcher-hub";
import { countSetupChanges, discardSetup, eligibilityChanges, ladderChanges, orderChanges, ruleChanges, PartialSaveError, reconcileSetup, saveSetup, strategyDraft, type EligibilityDraft, type SetupDraft, type StrategyDraft } from "../../model/dispatcher-setup";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { DispatcherLadderFields, DispatcherReadError, ListField, type DispatcherConfigView } from "./Dispatcher";
import { useDispatcherStyles } from "./dispatcher-styles";
import { Section, useResource, containTooltipEscape, useScoped } from "./shared";

export type EligibilitySource =
  | { kind: "global"; rules: Rule[]; available: string[] }
  | { kind: "project"; repo: string; repoLabel: string; view: ProjectStrategyView };

const ruleTitle = (rule: Rule) => rule.kinds ? (rule.kinds.length ? `Task kinds: ${rule.kinds.join(", ")}` : "New task-kind list") : "Default list";
const splitKinds = (value: string) => value.split(",").map(kind => kind.trim()).filter(Boolean);
const profileName = /^[a-z0-9][a-z0-9-]{0,39}$/, reconnect = "Reconnect to save. Your changes stay here.";

const buttons = (root: Element | null | undefined, selector: string) => [...(root?.querySelectorAll<HTMLButtonElement>(selector) ?? [])];
/** Agents as the snapshot describes them, with the shared readiness vocabulary (UI-10). */
function useHubAgents(): HubAgent[] {
  const { state } = useTaskContext(), snapshot = state.snapshot;
  return (snapshot?.executors ?? []).map(row => ({ runner: row.id, name: executorLabel(row.id), readiness: executorReadiness(row, snapshot!) }));
}

/** An ordered agent list beside the pool of agents that are not listed yet. */
function OrderWithPool({ label, title, items, onChange, pool, empty, disabled }: { label: string; title?: string; items: (SortableItem & { id?: string })[]; onChange: (keys: string[]) => void; pool: { key: string; label: string; id?: string }[]; empty: string; disabled: boolean }) {
  const { state } = useTaskContext();
  const scoped = useScoped();
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
        <SortableList layout="executor" iconControls label={`${label}, in priority order`} disabled={disabled} items={items.map((item, index) => {
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
        <SectionHeading as="h3">Not listed</SectionHeading>
        <div ref={group} className="pc-executor-pool" role="group" aria-label={`Add to ${label}`} tabIndex={-1} data-executor-pool="">
          {pool.length ? pool.map((item, index) => {
            const { runner, status } = metadata(item.id ?? item.key);
            const unavailable = runner && (runner.eligibility?.state === "ineligible" || ["disabled", "blocked", "down", "failing", "exhausted"].includes(runner.state));
            return <div key={item.key} className={`pc-executor-pool__row${unavailable ? " pc-executor-pool__row--unavailable" : ""}`}>
              <AgentMark agent={agentKey(markAgent(runner?.id ?? item.id ?? item.key, runner?.account)) ?? "opencode"} size={20} labelled={false} />
              <span className="pc-executor-pool__identity"><strong>{item.label}</strong><span onKeyDown={containTooltipEscape}>{status ? <Tooltip text={status.tooltip}><span className="pc-executor-caption" tabIndex={0}>{status.reason}</span></Tooltip> : <span className="pc-executor-caption">Refresh to confirm availability</span>}</span></span>
              {unavailable ? <TextAction href={scoped(hrefFor(routes.agents(runner!.id)))} aria-label={`Fix ${item.label}`}>Fix</TextAction> : <IconButton geometry="board" size="sm" disabled={disabled} aria-label={`Add ${item.label}`} onClick={() => add(item.key, index)}><span aria-hidden="true">+</span></IconButton>}
            </div>;
          }) : <p className="pc-executor-caption pc-executor-pool__empty">Every agent is in the list.</p>}
          <ButtonLink size="sm" variant="quiet" className="pc-executor-pool__setup" href={scoped(hrefFor(routes.addExecutor()))}>+ Add an agent</ButtonLink>
        </div>
      </div>
    </div>
    {items.length === 1 && <p className="pc-dispatcher-callout pc-dispatcher-callout--warn"><span className="pc-dispatcher-callout__glyph" aria-hidden="true">◐</span>Only one agent: if {items[0]!.label} cannot take work, these tasks wait in the queue. There is no fallback.</p>}
  </div>;
}

const kindLabel = (rule: Rule) => rule.kinds?.length ? rule.kinds.join(", ") : "New list";
/** The kind rules (routing keeps the default list last); the default rule stays where it is. */
const withKindRules = (rules: readonly Rule[], kindRules: readonly Rule[]) => [...kindRules, ...rules.filter(rule => !rule.kinds)];

/** Dispatcher › Who can run what › Default list: the rule without task kinds. */
function DefaultList({ rules, available, disabled, onChange }: { rules: Rule[]; available: string[]; disabled: boolean; onChange: (rules: Rule[]) => void }) {
  const at = defaultRuleIndex(rules), rule = rules[at];
  if (!rule) return <p>This setup has no default list. Every task kind needs its own list.</p>;
  return <OrderWithPool label="Default list" disabled={disabled} empty="Add at least one agent to the default list."
    items={rule.executors.map(id => ({ key: id, label: executorLabel(id) }))} onChange={executors => onChange(rules.map((item, index) => index === at ? { ...item, executors } : item))}
    pool={available.filter(id => !rule.executors.includes(id)).map(id => ({ key: id, label: executorLabel(id) }))} />;
}

/** Task kinds with their own list, as roving tabs, and the kinds that use the default list. */
function KindRules({ rules: all, available, disabled, onChange, onActiveKind }: { rules: Rule[]; available: string[]; disabled: boolean; onChange: (rules: Rule[]) => void; onActiveKind: (kind: string) => void }) {
  const rules = all.filter(rule => rule.kinds);
  const root = useRef<HTMLDivElement>(null), keys = useStableKeys(rules.length), focusAfter = useFocusAfterRender();
  const [selected, setSelected] = useState(0), tabId = useId();
  const active = Math.min(selected, Math.max(0, rules.length - 1));
  const rule = rules[active];
  useEffect(() => onActiveKind(rule ? kindLabel(rule) : "Default list"), [rule && kindLabel(rule)]);
  const change = (next: Rule[]) => onChange(withKindRules(all, next));
  const patch = (index: number, value: Rule) => change(rules.map((item, at) => at === index ? value : item));
  const listed = new Set(rules.flatMap(item => item.kinds ?? []));
  const onDefault = TASK_KINDS.filter(kind => !listed.has(kind));
  const addRule = (kind?: string) => {
    const index = rules.length, fallback = all.find(item => !item.kinds)?.executors ?? [];
    keys.current.splice(index, 0, `new${Date.now()}`);
    setSelected(index);
    focusAfter(() => root.current?.querySelector<HTMLInputElement>("[data-list-field=kinds]"));
    // A new list starts as a copy of the default list, so it can take work before it is edited.
    change([...rules, { kinds: kind ? [kind] : [], executors: [...fallback] }]);
  };
  const removeRule = (index: number) => {
    keys.current.splice(index, 1);
    const next = Math.min(index, rules.length - 2);
    setSelected(Math.max(0, next));
    focusAfter(() => buttons(root.current, '[role="tab"]')[Math.max(0, next)] ?? buttons(root.current, "[data-rule-add]")[0]);
    change(rules.filter((_, at) => at !== index));
  };
  return <div ref={root} className="pc-stack pc-stack--normal">
    {rules.length > 0 && <>
      <Tabs variant="pills" label="Task kinds with their own list" id={`rule-${tabId}`} value={String(keys.current[active])} onChange={value => setSelected(keys.current.findIndex(key => String(key) === value))}
        options={rules.map((value, index) => ({ value: String(keys.current[index]), label: <>{kindLabel(value)} <span className="pc-dispatcher-tabs__count">{value.executors.length}</span></> }))} />
      {rules.map((_, index) => index !== active && <div key={keys.current[index]} hidden role="tabpanel" id={`rule-${tabId}-${keys.current[index]}-panel`} aria-labelledby={`rule-${tabId}-${keys.current[index]}-tab`} />)}
      {rule && <div role="tabpanel" id={`rule-${tabId}-${keys.current[active]}-panel`} aria-labelledby={`rule-${tabId}-${keys.current[active]}-tab`} className="pc-stack pc-stack--normal">
        <div className="u3-row">
          <ListField label={`List ${active + 1} task kinds`} help="Separate task kinds with commas." marker="kinds" value={rule.kinds} disabled={disabled}
            placeholder="For example, tests, docs" onText={text => patch(active, { ...rule, kinds: splitKinds(text) })} />
          <Button size="sm" variant="quiet" disabled={disabled} data-rule-remove="" aria-label={`Use the default list for ${ruleTitle(rule)}`} onClick={() => removeRule(active)}>Use the default list</Button>
        </div>
        <OrderWithPool label={`Agents for ${ruleTitle(rule)}`} title={`${kindLabel(rule)} tasks · in order`} disabled={disabled} empty="Add at least one agent to this list."
          items={rule.executors.map(id => ({ key: id, label: executorLabel(id) }))} onChange={executors => patch(active, { ...rule, executors })}
          pool={available.filter(id => !rule.executors.includes(id)).map(id => ({ key: id, label: executorLabel(id) }))} />
      </div>}
    </>}
    {onDefault.length > 0 && <div className="pc-hub-kinds" role="group" aria-label="Task kinds using the default list">
      {onDefault.map(kind => <Button key={kind} size="sm" variant="secondary" className="pc-chip" disabled={disabled} aria-label={`Give ${kind} its own list`} onClick={() => addRule(kind)}>{kind} <span className="pc-hub-chip-count">default</span></Button>)}
    </div>}
    <div><Button size="sm" disabled={disabled} data-rule-add="" onClick={() => addRule()}>Give task kinds their own list</Button></div>
  </div>;
}

/** One repository's own list, replacing the default list for its tasks. */
function ProjectOrder({ source, executors, disabled, onChange }: { source: Extract<EligibilitySource, { kind: "project" }>; executors: string[]; disabled: boolean; onChange: (executors: string[]) => void }) {
  const root = useRef<HTMLDivElement>(null), focusAfter = useFocusAfterRender();
  const runner = (reference: string) => source.view.available.find(item => item.reference === reference);
  const useDefault = () => { focusAfter(() => buttons(root.current, "[data-executor-pool] button")[0] ?? root.current?.querySelector<HTMLElement>("[data-executor-pool]")); onChange([]); };
  return <div ref={root} className="pc-stack pc-stack--normal">
    <p>{source.view.executors ? "Agents marked Skipped, Cannot take work or Off receive no new work." : "Add agents to give this repository its own list."}</p>
    <OrderWithPool label={`Agents for ${source.repoLabel}`} disabled={disabled} onChange={onChange}
      empty={source.view.executors ? "Saving makes this repository use the default list." : "No list of its own yet."}
      items={executors.map(reference => ({ key: reference, id: runner(reference)?.id, label: runner(reference)?.label ?? executorLabel(reference),
        detail: !runner(reference) && <span className="u3-muted">Unavailable in the active profile</span> }))}
      pool={source.view.available.filter(item => !executors.includes(item.reference)).map(item => ({ key: item.reference, id: item.id, label: item.label }))} />
    {source.view.executors && executors.length > 0 && <div><Button disabled={disabled} onClick={useDefault}>Use the default instead</Button></div>}
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
    if (eligibility.draft.some(rule => !rule.executors.length)) return "Each list needs at least one agent.";
    if (eligibility.draft.some(rule => rule.kinds && !rule.kinds.length)) return "Name the task kinds for each list.";
  }
  if (ladderDirty && (!profileName.test(name) || name === "default")) return "Name the new profile under How Pacer chooses.";
  if (ladderDirty && !reason.trim()) return "Give a reason under How Pacer chooses.";
  return undefined;
}

const stepCopy: Record<string, [string, string]> = {
  "capable-with-headroom": ["A capable model with spare capacity", "Model size fits the task, and the account has room"],
  "usable-fallback": ["Any usable fallback", "Anyone who can still take work, even with little room left"],
};
const capacityCopy = (capacity: string) => capacity === "comfortable" ? "needs spare capacity" : capacity === "usable" ? "needs some capacity" : "allows unknown capacity";
const stepName = (id: string) => stepCopy[id]?.[0] ?? id.replaceAll("-", " ").replace(/^\w/, letter => letter.toUpperCase());

/**
 * Who can run what: the default list, task-kind lists or one repository's list, and the choice method, with
 * one SaveBar. Freshly loaded settings merge into the open draft part by part (see reconcileSetup), so a refetch
 * or a partial save never drops edits. `between` renders between the lists and the choice method.
 */
export function SetupEditor({ view, eligibility: source, onSaved, onDirtyChange, onLadderDraft, notice, repoLists = 0, between }: { view: DispatcherConfigView; eligibility: EligibilitySource; onSaved: (notice: string) => void; onDirtyChange: (dirty: boolean) => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void; notice?: string; repoLists?: number; between?: ComponentChildren }) {
  useDispatcherStyles();
  const { state, api } = useTaskContext();
  const agents = useHubAgents();
  const incoming = initialSetup(view, source);
  const latest = useRef(incoming); latest.current = incoming;
  const [setup, setSetup] = useState(() => incoming);
  const [activeKind, setActiveKind] = useState("Default list");
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
  // Name the lists that changed: the default list, the task-kind lists (the open one by name), or both.
  const changed = setup.eligibility.kind === "global" ? {
    defaults: orderChanges(setup.eligibility.saved.find(rule => !rule.kinds)?.executors ?? [], setup.eligibility.draft.find(rule => !rule.kinds)?.executors ?? []) > 0,
    kinds: ruleChanges(setup.eligibility.saved.filter(rule => rule.kinds), setup.eligibility.draft.filter(rule => rule.kinds)) > 0,
  } : { defaults: false, kinds: false };
  const listScope = source.kind === "project" ? `${source.repoLabel} list`
    : changed.defaults && changed.kinds ? "Default and task-kind lists"
    : changed.kinds && activeKind !== "Default list" ? `List for ${activeKind} tasks`
    : changed.kinds ? "Task-kind lists" : "Default list";
  const setupScope = name || "New profile";
  // Both parts save together, so name both.
  const scopeText = ladderDirty ? (eligibilityChanges(setup.eligibility) ? `${listScope} and ${setupScope}` : setupScope) : listScope;
  const disabled = busy || !state.connected;
  const setEligibility = (draft: Rule[] | string[]) => setSetup(current => ({ ...current, eligibility: { ...current.eligibility, draft } as EligibilityDraft }));
  // Discard loads the latest saved settings, which also resolves a conflict.
  const discard = () => { setSetup(discardSetup(latest.current)); setConflict(false); setError(undefined); };
  const blocked = blockedReason(setup, ladderDirty, name, reason, state.connected);
  const [editingLadder, setEditingLadder] = useState(false);
  const engine = view.config.engine, ladderEditable = engine === "ladder" || view.config.engineFallback === "ladder";
  const plannerRunner = state.snapshot?.executors?.find(row => row.rank === "planner")?.id ?? null;
  // Right now needs the snapshot's readiness; without it the page does not guess who can take work.
  const summary = agents.length && source.kind === "global" && setup.eligibility.kind === "global"
    ? rulesSummary({ list: source.rules.find(rule => !rule.kinds)?.executors ?? [], agents, available: source.available, plannerRunner, repoLists }) : undefined;
  const draftDefault = setup.eligibility.kind === "global" ? setup.eligibility.draft.find(rule => !rule.kinds)?.executors ?? [] : [];
  const missing = summary?.add.filter(id => !draftDefault.includes(id)) ?? [];
  const addMissing = () => setSetup(current => current.eligibility.kind !== "global" ? current
    : { ...current, eligibility: { ...current.eligibility, draft: current.eligibility.draft.map(rule => rule.kinds ? rule : { ...rule, executors: [...rule.executors, ...missing] }) } });
  const repoAvailability = source.kind === "project" ? listAvailability(setup.eligibility.draft as string[], agents) : undefined;

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
  const tryTask = () => document.querySelector<HTMLInputElement>("#dispatch-preview input[aria-label=Task]")?.focus();

  const ladder = <section className="pc-stack pc-stack--normal" id="decision-ladder" aria-labelledby="decision-ladder-h">
    <div className="pc-hub-section-head__text">
      <SectionHeading id="decision-ladder-h">How Pacer chooses</SectionHeading>
      <p className="u3-muted">Runs after the list decides who may do the work. Pacer tries each step in order. From profile {view.strategy || "default"}.</p>
    </div>
    {engine !== "ladder" && <p>This profile uses a plugin choice method; configure it in the profile. If the plugin cannot decide, Pacer {view.config.engineFallback === "ladder" ? "uses this fallback ladder" : "queues the work"}.</p>}
    {ladderEditable && <>
      <ol className="pc-choice-ladder pc-hub-ladder">
        {setup.ladder.steps.map((step, index) => <li key={step.id}>
          <span className={`pc-ladder-number pc-ladder-number--${step.capacity === "comfortable" ? "good" : step.capacity === "usable" ? "warn" : "muted"}`}>{index + 1}</span>
          <span className="pc-hub-ladder__text"><strong>{stepName(step.id)}</strong><span className="u3-muted">{stepCopy[step.id]?.[1] ?? `${step.match.kind ? `${step.match.kind} tasks` : "Any task kind"} · ${capacityCopy(step.capacity)}`}</span></span>
        </li>)}
        <li><span className="pc-ladder-number pc-ladder-number--muted" aria-hidden="true">·</span>
          <span className="pc-hub-ladder__text"><strong>Nobody fits</strong><span className="u3-muted">{setup.ladder.onNoMatch === "fail" ? "Pacer reports that nobody can take the task" : "The task waits in the queue until someone can take it"}</span></span></li>
      </ol>
      <div className="pc-choice-ladder-actions"><Button size="sm" variant="secondary" onClick={() => setEditingLadder(value => !value)} aria-expanded={editingLadder}>Edit choice method</Button><span className="u3-muted">Saved into a new profile you can switch to.</span><TextAction size="caption" href={hrefFor(routes.settings("planner"))}>Planner reserve and pacing</TextAction></div>
      {editingLadder && <div className="pc-stack pc-stack--section">
        <DispatcherLadderFields config={setup.ladder} disabled={disabled} onChange={ladder => setSetup(current => ({ ...current, ladder }))} />
        {ladderDirty && <div className="pc-card pc-stack pc-stack--normal">
          <SectionHeading as="h3">Save the choice method as a new profile</SectionHeading>
          <p>The active profile stays active until this one is checked and switched to.</p>
          <SettingRow variant="board" label="Profile name" description="Lowercase letters, numbers and hyphens."><TextInput value={name} maxLength={40} disabled={disabled} onInput={event => setName(event.currentTarget.value)} /></SettingRow>
          <SettingRow variant="board" label="Reason for change"><TextInput value={reason} maxLength={500} disabled={disabled} onInput={event => setReason(event.currentTarget.value)} /></SettingRow>
        </div>}
      </div>}
    </>}
  </section>;

  return <div className="pc-hub pc-stack pc-stack--section">
    {!state.connected && <p role="status" className="u3-muted">{reconnect}</p>}
    {summary && <Card tone="sunken" className="pc-hub-now pc-hub-now--single" aria-labelledby="rules-now-h">
      <div className="pc-hub-now__text">
        <SectionHeading id="rules-now-h">Right now</SectionHeading>
        <p className="pc-hub-now__headline">{summary.headline}</p>
        <p className="pc-hub-now__consequence">{summary.consequence}</p>
      </div>
      {summary.action && missing.length > 0 && <div className="pc-hub-now__actions"><Button size="sm" variant="secondary" disabled={disabled} onClick={addMissing}>{summary.action.label}</Button></div>}
    </Card>}
    <div className="pc-hub-columns">
      <div className="pc-stack pc-stack--section">
        {setup.eligibility.kind === "global" && source.kind === "global" ? <>
          <section className="pc-stack pc-stack--normal" id="executor-eligibility" aria-labelledby="default-list-h">
            <div className="pc-hub-section-head__text">
              <SectionHeading id="default-list-h">Default list · every repository</SectionHeading>
              <p className="u3-muted">Who may do the work. Pacer chooses among them with the method below; the first one doesn't always run. Drag or use the move buttons to reorder.</p>
            </div>
            <DefaultList rules={setup.eligibility.draft} available={source.available} disabled={disabled} onChange={setEligibility} />
          </section>
          <section className="pc-stack pc-stack--normal" id="kind-lists" aria-labelledby="kind-lists-h">
            <div className="pc-hub-section-head__text">
              <SectionHeading id="kind-lists-h">By task kind</SectionHeading>
              <p className="u3-muted">{setup.eligibility.draft.some(rule => rule.kinds) ? "These kinds use their own list; every other kind uses the default list." : "Every kind uses the default list."} Give one its own list when it needs different agents, for example docs on cheap models only.</p>
            </div>
            <KindRules onActiveKind={setActiveKind} rules={setup.eligibility.draft} available={source.available} disabled={disabled} onChange={setEligibility} />
          </section>
        </> : source.kind === "project" && setup.eligibility.kind === "project" ? <section className="pc-stack pc-stack--normal" id="executor-eligibility" aria-labelledby="repo-list-h">
          <div className="pc-hub-section-head__text">
            <span className="pc-hub-repo-title"><SectionHeading id="repo-list-h">{source.repoLabel} list</SectionHeading>{repoAvailability && setup.eligibility.draft.length > 0 && <Pill tone={repoAvailability.tone}>{repoAvailability.text}</Pill>}</span>
            <p className="u3-muted">Agents for tasks in {source.repoLabel}, in order. A repository with its own list ignores the default list, and keeps it when you switch profiles.</p>
          </div>
          <ProjectOrder source={source} executors={setup.eligibility.draft} disabled={disabled} onChange={setEligibility} />
        </section> : null}
      </div>
      <div className="pc-stack pc-stack--section">
        {between}
        {ladder}
      </div>
    </div>
    <SaveBar inline alwaysVisible statusDot size="sm" scope={!count && notice && savedScope ? savedScope : scopeText} count={count} busy={busy} onSave={() => void save()} onDiscard={discard} blockedReason={blocked} notice={notice || undefined}
      saveLabel={ladderDirty ? "Validate and save" : "Save lists"}>
      <div className="pc-hub-save-note"><span>{source.kind === "project" ? <>This list saves for {source.repoLabel} and stays when you switch profiles.</> : <>Lists save into the active profile, <strong>{view.strategy || "default"}</strong>. Repository lists are kept separately.</>}</span>
        {(state.features.ops.has("dispatch.explain") || state.features.ops.has("dispatch.preview")) && <Button size="sm" variant="quiet" onClick={tryTask}>Try a task</Button>}</div>
      {conflict && <p role="status">Another client changed these settings. Your changes are kept; Discard loads theirs.</p>}
      <ErrorMessage error={error} />
    </SaveBar>
  </div>;
}

function ScopedEditor({ view, scope, repoLabel, onSaved, onDirtyChange, onLadderDraft, notice, repoLists, between }: { view: DispatcherConfigView; scope: string; repoLabel: string; onSaved: (notice: string) => void; onDirtyChange: (dirty: boolean) => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void; notice: string; repoLists: number; between?: ComponentChildren }) {
  const query = useResource<{ rules: Rule[]; available: string[] } | ProjectStrategyView>(scope ? "project.strategy.get" : "routing.get", scope ? { repo: scope } : {});
  const data = query.data;
  if (!data) return <section id="executor-eligibility" aria-label="Who can run what">
    <p role={query.error ? "alert" : "status"}>{query.error ? "Agent lists could not be loaded." : "Loading agent lists…"}</p>
    <ErrorMessage error={query.error} />{query.error && <div><Button onClick={query.reload}>Try again</Button></div>}
  </section>;
  const source: EligibilitySource = scope && "repo" in data ? { kind: "project", repo: scope, repoLabel, view: data } : { kind: "global", rules: (data as { rules: Rule[] }).rules, available: (data as { available: string[] }).available };
  return <>
    <DispatcherReadError error={query.error} reload={query.reload} subject="agent lists" />
    <SetupEditor view={view} eligibility={source} onDirtyChange={onDirtyChange} onLadderDraft={onLadderDraft} notice={notice} repoLists={repoLists} between={between}
      onSaved={message => { onSaved(message); query.reload(); }} />
  </>;
}

type ScopeOption = { value: string; label: string; ownList?: boolean };
type Policies = ReturnType<typeof useResource<ProjectStrategyView[]>>;
/** Repositories with a saved list stay editable even when their checkout is absent. */
function ProjectScopeOptions({ children }: { children: (options: ScopeOption[], policies: Policies | undefined, listError: ComponentChildren) => ComponentChildren }) {
  const { state } = useTaskContext();
  const policies = useResource<ProjectStrategyView[]>("project.strategy.list", {});
  const options = new Map((state.snapshot?.repos ?? []).map(repo => [repo.key, repo.label]));
  for (const policy of policies.data ?? []) if (!options.has(policy.repo.key)) options.set(policy.repo.key, `${policy.repo.label} (no checkout)`);
  const listError = <DispatcherReadError error={policies.error} reload={policies.reload} subject="repository lists" />;
  return <>{children([...options].map(([value, label]) => ({ value, label, ownList: policies.data?.some(policy => policy.repo.key === value && !!policy.executors) })), policies, listError)}</>;
}

/** Who can run what: the lists, the repositories with their own list and the choice method; Try a task follows it. */
export function DispatcherGuidedSetup({ view, onSaved, onLadderDraft }: { view: DispatcherConfigView; onSaved: () => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void }) {
  const { state } = useTaskContext();
  const ops = state.features.ops;
  const projectOps = ["get", "list", "set", "remove"].every(op => ops.has(`project.strategy.${op}`));
  if (!ops.has("routing.get") || !ops.has("routing.set")) return <Section id="dispatcher-scope" title="Who can run what"><p>Update the service to edit agent lists here.</p></Section>;
  return projectOps ? <ProjectScopeOptions>{(repos, policies, listError) => <GuidedSetup view={view} onSaved={onSaved} onLadderDraft={onLadderDraft} repos={repos} policies={policies} listError={listError} />}</ProjectScopeOptions>
    : <GuidedSetup view={view} onSaved={onSaved} onLadderDraft={onLadderDraft} repos={[]} />;
}

/** Repositories with their own list: who is on it, how many can take work, and the edit actions. */
function RepositoryLists({ policies, repos, disabled, reason, onEdit }: { policies?: ProjectStrategyView[]; repos: ScopeOption[]; disabled: boolean; reason?: string; onEdit: (repo: string) => void }) {
  const agents = useHubAgents();
  const own = (policies ?? []).filter(policy => policy.executors?.length);
  const without = repos.filter(repo => !repo.ownList);
  const label = (policy: ProjectStrategyView, reference: string) => policy.available.find(item => item.reference === reference)?.label ?? executorLabel(reference);
  const id = (policy: ProjectStrategyView, reference: string) => policy.available.find(item => item.reference === reference)?.id ?? reference;
  return <section className="pc-stack pc-stack--normal" id="dispatcher-scope" aria-labelledby="repo-lists-h">
    <div className="pc-hub-section-head__text">
      <SectionHeading id="repo-lists-h">Repository lists</SectionHeading>
      <p className="u3-muted">A repository with its own list ignores the default list. These stay when you switch profiles.</p>
    </div>
    {own.length ? <ul className="pc-hub-repos">{own.map(policy => {
      const ids = policy.executors!.map(reference => id(policy, reference)), availability = listAvailability(ids, agents);
      return <li key={policy.repo.key} className="pc-hub-repo">
        <span className="pc-hub-repo__head"><code title={policy.repo.label}>{policy.repo.label}</code><Pill tone={availability.tone}>{availability.text}</Pill></span>
        <ol className="pc-hub-repo__list" aria-label={`${policy.repo.label} order`}>{policy.executors!.map((reference, index) => <li key={reference}>
          <span className="pc-executor-rank">{index + 1}</span><AgentMark agent={markAgent(id(policy, reference))} size={16} labelled={false} /><span>{label(policy, reference)}</span>
        </li>)}</ol>
        <span className="pc-hub-repo__actions"><Button size="sm" variant="quiet" disabled={disabled} aria-describedby={reason ? "dispatcher-scope-reason" : undefined} aria-label={`Edit the ${policy.repo.label} list`} onClick={() => onEdit(policy.repo.key)}>Edit list</Button></span>
      </li>;
    })}</ul> : <p className="u3-muted">No repository has its own list. Every repository uses the default list.</p>}
    {without.length > 0 && <div><Button size="sm" variant="secondary" disabled={disabled} aria-describedby={reason ? "dispatcher-scope-reason" : undefined} onClick={() => onEdit(without[0]!.value)}>Give a repository its own list</Button></div>}
    {!repos.length && <p className="u3-muted">Add a repository to give it its own list.</p>}
    {reason && <p id="dispatcher-scope-reason" className="u3-muted">{reason}</p>}
  </section>;
}

function GuidedSetup({ view, onSaved, onLadderDraft, repos, policies, listError }: { view: DispatcherConfigView; onSaved: () => void; onLadderDraft?: (draft: StrategyDraft | undefined) => void; repos: ScopeOption[]; policies?: Policies; listError?: ComponentChildren }) {
  const [scope, setScope] = useState(""), [dirty, setDirty] = useState(false), [notice, setNotice] = useState("");
  const pick = (value: string) => { if (dirty || value === scope) return; setScope(value); setNotice(""); };
  const reason = dirty ? "Save or discard your changes to switch lists." : undefined;
  const repoLists = (policies?.data ?? []).filter(policy => policy.executors?.length).length;
  const label = repos.find(option => option.value === scope)?.label ?? scope;
  const between = scope ? <section className="pc-stack pc-stack--compact" id="dispatcher-scope" aria-label="Choose a repository">
    <div className="pc-hub-scope">
      <span className="dispatcher-repo-picker"><ChoicePicker aria-label="Repository" className="pc-choice-picker--mono" value={scope} searchable={repos.length > 8} disabled={dirty} options={repos} onValueChange={pick} /></span>
      {repos.find(repo => repo.value === scope)?.ownList && <Pill tone="info">Has its own list</Pill>}
      <Button size="sm" variant="secondary" disabled={dirty} aria-describedby={reason ? "dispatcher-scope-reason" : undefined} onClick={() => pick("")}>Back to the default list</Button>
    </div>
    {reason && <p id="dispatcher-scope-reason" className="u3-muted">{reason}</p>}
    {listError}
  </section> : <>{policies && <RepositoryLists policies={policies.data} repos={repos} disabled={dirty} reason={reason} onEdit={pick} />}{listError}</>;
  return <ScopedEditor key={scope} view={view} scope={scope} notice={notice} repoLabel={label} repoLists={repoLists} between={between}
    onDirtyChange={setDirty} onLadderDraft={onLadderDraft} onSaved={message => { setNotice(message); policies?.reload(); onSaved(); }} />;
}

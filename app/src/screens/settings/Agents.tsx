import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ExecutorRow } from "../../../../src/api/read-model/types";
import type { TierTargets } from "../../../../src/dispatch/types";
import { markAgent } from "../../../../src/view-model/agents";
import { executorReadiness, machineHardCap } from "../../../../src/view-model/capacity";
import { ago } from "../../../../src/view-model/time";
import { captionReset, usageView } from "../../../../src/view-model/usage";
import { executorLabel, paceStatus } from "../../../../src/view-model/words";
import { spendCopy } from "../../../../src/view-model/copy";
import { useActions } from "../../data/action-context";
import { registerNavigationGuard, canLeaveScreen } from "../../data/navigation-guard";
import { useNotifications } from "../../data/notification-context";
import { AgentMark } from "../../ds/AgentMark";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { Switch, TextInput } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { ImmediateSave } from "../../ds/ImmediateSave";
import { Icon } from "../../ds/icons";
import { PageColumns } from "../../ds/Page";
import { Card, ListRowLink } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { SaveBar } from "../../ds/SaveBar";
import { SectionHeading } from "../../ds/SectionHeading";
import { StatusPill } from "../../ds/StatusPill";
import { Tooltip } from "../../ds/Tooltip";
import { UsageMeter } from "../../ds/UsageMeter";
import { useDialogs } from "../../ds/useDialogs";
import { agentCaption, modelChanges, modelCoverage } from "../../model/agents";
import { accountRecord, type Account } from "../../model/accounts";
import { moveExecutor } from "../../model/executor-settings";
import { tierLabels } from "../../model/executor-models";
import type { ConfigData } from "../../model/strategy";
import { FrameSlot, useFrame } from "../../shell/slots";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { AccountUsage } from "./AccountUsage";
import { AgentAccount } from "./AgentAccount";
import { AgentModels } from "./AgentModels";
import { ImmediateSetting } from "./ImmediateSetting";
import { Feedback, containTooltipEscape, time, useOperation, useResource, useScoped, useSettingsStyles } from "./shared";
import { useExecutorSettings, type ExecutorSettingsState } from "./useExecutorSettings";
import { useModelDrafts, type ModelDraftsState } from "./useModelDrafts";
import type { AgentsTabProps } from "./agents-tab-props";

interface ConfigView { planner: string; plannerAccount: string; config: { tierTargets?: TierTargets } }
const DEFAULT_TARGETS: TierTargets = { simple: "small", standard: "medium", complex: "frontier" };
const agentsHref = (id?: string) => id ? `#/settings/agents?${new URLSearchParams({ agent: id })}` : "#/settings/agents";

/**
 * Dispatcher › Agents: the agent list (shell side panel, or in page when panels cannot show) and the selected
 * agent's usage, account, host, models and limits. Models and limits share one page draft and one save bar;
 * Takes work and the planner fallback apply immediately.
 */
export function AgentsTab({ agent: requested, initialAccounts, initialConfig }: AgentsTabProps) {
  useSettingsStyles();
  const { state, api } = useTaskContext(), scoped = useScoped(), frame = useFrame(), actions = useActions(), notifications = useNotifications(), dialogs = useDialogs();
  const rows = state.snapshot?.executors;
  const known = useRef(new Map<string, ExecutorRow>());
  for (const row of rows ?? []) known.current.set(row.id, row);
  const config = useResource<ConfigView>("dispatch.config.get");
  const settingsConfig = useResource<ConfigData>("config.get", {}, initialConfig);
  const accounts = useResource<Account[]>("account.list", {}, initialAccounts);
  const targets = config.data?.config?.tierTargets ?? DEFAULT_TARGETS;
  const settings = useExecutorSettings();
  const runnerIds = (rows ?? []).map(row => row.id);
  const models = useModelDrafts(runnerIds, targets);
  const plannerRow = rows?.find(row => row.rank === "planner");
  const plannerId = plannerRow?.id ?? state.snapshot?.planner?.runner ?? null;
  // Priority order first (the page draft), then any agent the snapshot knows that the settings do not list yet.
  const ordered = settings.draft?.order ?? [];
  const executorRows = [...ordered, ...(rows ?? []).filter(row => row.rank !== "planner" && !ordered.includes(row.id)).map(row => row.id)]
    .map(id => rows?.find(row => row.id === id) ?? known.current.get(id)).filter((row): row is ExecutorRow => !!row && row.id !== plannerId);
  const all = [...(plannerRow ? [plannerRow] : []), ...executorRows];
  const selected = all.find(row => row.id === requested) ?? all[0];
  const addAgent = useRef<HTMLAnchorElement>(null);
  const [saving, setSaving] = useState(false), [leaving, setLeaving] = useState(false), [refreshedAt, setRefreshedAt] = useState<number | null>(null), [refreshingAll, setRefreshingAll] = useState(false);
  const leave = useRef<(value: boolean) => void>();
  const modelLines = models.drafts.flatMap(draft => modelChanges(draft, models.baseOf(draft.runner)).map(line => draft.runner === selected?.id || models.drafts.length === 1 ? line : `${executorLabel(draft.runner)}: ${line}`));
  const limitLines = settingsChanges(settings);
  const count = modelLines.length + limitLines.length;
  const dirty = models.dirty || settings.dirty;
  const blockedReason = !state.connected ? "Save is available when the service reconnects."
    : Object.keys(settings.errors).length ? "Enter a whole number from 1 to 16 for Tasks at once."
    : settings.conflict ? "Settings changed elsewhere. Reload the saved settings first."
    : models.conflict ? "Model settings changed elsewhere. Discard to load them."
    : models.blocked.length ? `${models.blocked.map(id => executorLabel(id)).join(", ")} ${models.blocked.length === 1 ? "has" : "have"} every model off and no default. Turn a model on first.`
    : undefined;
  const fallbackValue = settingsConfig.data?.keys?.["pacing.planner_tier_fallback"]?.value;
  const fallbackOn = fallbackValue !== "off";
  const coverageNow = modelCoverage(models.drafts, plannerId, targets), coverageSaved = modelCoverage(models.bases, plannerId, targets);
  const freesPlanner = dirty && fallbackOn && !!plannerId && coverageSaved.counts.complex === 0 && coverageNow.counts.complex > 0;

  const saveAll = async (): Promise<boolean> => {
    if (saving || !dirty || blockedReason) return false;
    setSaving(true);
    try {
      let revision: string | undefined;
      if (models.dirty) {
        const result = await models.save();
        if (!result.ok) return false;
        revision = result.revision;
      }
      if (settings.dirty) {
        if (revision) settings.rebase(revision);
        if (!await settings.save(revision)) return false;
        models.reload();
      } else if (revision) void settings.refresh();
      notifications?.notify({ key: "agents-save", tone: "success", title: "Agent settings saved" });
      void actions.refetch();
      return true;
    } finally { setSaving(false); }
  };
  const discard = () => { settings.discard(); void models.discard(); };
  const current = useRef({ dirty, saveAll });
  current.current = { dirty, saveAll };
  useEffect(() => {
    const unregister = registerNavigationGuard(target => {
      // Choosing another agent keeps this page and its draft mounted.
      if (!current.current.dirty || target?.startsWith("#/settings/agents")) return Promise.resolve(true);
      if (leave.current) return Promise.resolve(false);
      setLeaving(true);
      return new Promise(resolve => { leave.current = resolve; });
    });
    const unload = (event: BeforeUnloadEvent) => { if (current.current.dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => { unregister(); window.removeEventListener("beforeunload", unload); leave.current?.(false); };
  }, []);
  const finishLeave = (value: boolean) => { const resolve = leave.current; leave.current = undefined; setLeaving(false); resolve?.(value); };
  /** Actions that change configuration outside the draft ask first when the draft holds edits. */
  const independent = async (action: () => void | Promise<void>) => { if (dirty && !await canLeaveScreen()) return; await action(); };
  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      await Promise.all([
        ...runnerIds.map(id => models.refreshListing(id)),
        state.features.ops.has("limits.refresh") ? api.call("limits.refresh", {}).catch(() => null) : Promise.resolve(null),
      ]);
      accounts.reload(); void actions.refetch(); setRefreshedAt(Date.now() / 1000);
    } finally { setRefreshingAll(false); }
  };
  // The list belongs in the shell's side panel: open it once when the frame offers one.
  useLayoutEffect(() => { if (frame?.details && !frame.details.open && !frame.inline) frame.details.toggle(); }, [!!frame?.details]);

  const now = state.snapshot?.at ?? Date.now() / 1000;
  const listedTimes = Object.values(models.available).map(listing => listing.fetchedAt).filter(at => at > 0);
  const checkedAt = refreshedAt ?? (listedTimes.length ? Math.min(...listedTimes) : null);
  const item = (row: ExecutorRow) => {
    const caption = models.errors[row.id] ? { text: "Models could not load", warn: true } : agentCaption(models.draftOf(row.id), row.model);
    const off = row.rank !== "planner" && !(settings.draft?.runners[row.id]?.enabled ?? row.enabled);
    return <li key={row.id}><ListRowLink layout="nav" href={scoped(agentsHref(row.id))} aria-current={row.id === selected?.id ? "page" : undefined}>
      <AgentMark agent={markAgent(row.id, row.account)} size={24} labelled={false} />
      <span className="pc-agent-list__text"><strong>{executorLabel(row.id)}</strong><span className={caption.warn ? "pc-agent-card__caption pc-agent-card__caption--warn" : "pc-agent-card__caption"}>{off ? `Off · ${caption.text}` : caption.text}</span></span>
    </ListRowLink></li>;
  };
  const list = <nav className="pc-agent-list" aria-label="Agents">
    <ButtonLink ref={addAgent} variant="secondary" size="sm" href={scoped("#/settings/add-executor")}><Icon name="plus" />Add agent</ButtonLink>
    <div className="pc-agent-list__refresh">
      <span className="pc-agent-card__caption">{all.length} {all.length === 1 ? "agent" : "agents"}{checkedAt !== null ? ` · checked ${ago(checkedAt, Math.max(now, checkedAt))}` : ""}</span>
      <Button variant="ghost" size="sm" busy={refreshingAll} disabled={!state.connected} aria-label="Refresh all agents: models, sign-in and usage" onClick={() => void refreshAll()}><Icon name="refresh" />Refresh all</Button>
    </div>
    {!rows ? <p className="u3-muted" role="status">Loading agents…</p> : !all.length ? <p className="u3-muted">No agents yet. Add an agent.</p> : <>
      {plannerRow && <div className="pc-agent-list__group"><span className="pc-agent-list__heading" id="agents-planner">Planner</span><ul aria-labelledby="agents-planner">{item(plannerRow)}</ul></div>}
      {executorRows.length > 0 && <div className="pc-agent-list__group"><span className="pc-agent-list__heading" id="agents-executors">Executors</span><ul aria-labelledby="agents-executors">{executorRows.map(item)}</ul></div>}
    </>}
  </nav>;
  const detail = <section className="pc-agent-detail" aria-label={selected ? `${executorLabel(selected.id)} details` : "Agent details"}>
    {dialogs.dialog}
    {leaving && <Dialog title="Unsaved agent changes" close={() => finishLeave(false)}><p>Save your agent changes before leaving?</p><div className="u3-actions"><Button disabled={saving} onClick={() => finishLeave(false)}>Stay</Button><Button disabled={saving} onClick={() => { discard(); finishLeave(true); }}>Discard changes</Button><Button variant="primary" busy={saving} disabled={!!blockedReason} onClick={async () => { if (await current.current.saveAll()) finishLeave(true); }}>Save and leave</Button></div></Dialog>}
    <ErrorMessage error={settings.query.error} />
    {settings.conflict && <Alert tone="warning" title="Settings changed elsewhere">Your draft is preserved. Reload the saved settings before making further changes. <Button size="sm" onClick={async () => { if (await dialogs.confirm("Discard this draft and load the latest saved settings?", "Reload saved settings", "Reload")) discard(); }}>Reload saved settings</Button></Alert>}
    {!state.connected && <Alert tone="warning" title="Reconnecting">Your edits are preserved. Save will be available when the service reconnects.</Alert>}
    {selected ? <AgentDetail key={selected.id} executor={selected} planner={selected.id === plannerId} position={settings.draft?.order.indexOf(selected.id) ?? -1} count={settings.draft?.order.length ?? 0}
      settings={settings} models={models} accounts={accounts.data} config={settingsConfig.data} reloadAccounts={accounts.reload} independent={independent} busy={saving}
      fallback={fallbackValue === undefined ? undefined : { on: fallbackOn, reload: settingsConfig.reload, complex: coverageNow.counts.complex, plannerFits: coverageNow.plannerFits, target: targets.complex }}
      onRemoved={() => queueMicrotask(() => addAgent.current?.focus())} />
      : rows && <p className="u3-muted">Add an agent to give it delegated work.</p>}
    {freesPlanner && <Card tone="warn"><strong>These changes free the planner</strong><span className="u3-muted">Complex tasks would go to an executor with a {tierLabels[targets.complex].toLowerCase()} model instead of {executorLabel(plannerId)}, so the planner stops spending its quota on them.</span></Card>}
    {models.notice && <p role="status" className="u3-muted">{models.notice}</p>}
    <SaveBar count={count} busy={saving || settings.busy || models.busy} onSave={() => void saveAll()} onDiscard={discard} blockedReason={blockedReason}>
      {count > 0 && <p className="pc-agent-card__caption">{[...modelLines, ...limitLines].join(" · ")}</p>}
      <ErrorMessage error={settings.error} /><ErrorMessage error={models.error} />
    </SaveBar>
  </section>;
  const side = !!frame?.right && !frame.inline;
  return <>
    <FrameSlot name="right">{side ? list : null}</FrameSlot>
    {side ? detail : <PageColumns layout="agents" main={detail} aside={list} />}
  </>;
}

/** Plain lines for unsaved order and parallel-limit edits. */
function settingsChanges(settings: ExecutorSettingsState): string[] {
  const { saved, draft } = settings;
  if (!saved || !draft || !settings.dirty) return [];
  const lines = saved.runners.filter(runner => draft.runners[runner.id] && draft.runners[runner.id]!.maxTasks !== String(runner.maxTasks)).map(runner => `${executorLabel(runner.id)} runs ${draft.runners[runner.id]!.maxTasks || "?"} at once`);
  if (JSON.stringify(saved.order) !== JSON.stringify(draft.order)) lines.push("Priority order changed");
  return lines;
}

function FactCard({ title, children }: { title: string; children: ComponentChildren }) {
  return <section className="pc-agent-card" aria-label={title}><span className="pc-agent-card__caption">{title}</span>{children}</section>;
}

function AgentDetail({ executor, planner, position, count, settings, models, accounts, config, reloadAccounts, independent, busy, fallback, onRemoved }: {
  executor: ExecutorRow; planner: boolean; position: number; count: number;
  settings: ExecutorSettingsState; models: ModelDraftsState; accounts?: Account[]; config?: ConfigData; reloadAccounts: () => void;
  independent: (action: () => void | Promise<void>) => Promise<void>; busy: boolean;
  fallback?: { on: boolean; reload: () => void; complex: number; plannerFits: boolean; target: TierTargets["complex"] };
  onRemoved: () => void;
}) {
  const { state, api } = useTaskContext(), scoped = useScoped(), action = useOperation(), check = useOperation(), dialogs = useDialogs();
  const name = executorLabel(executor.id), snapshot = state.snapshot!;
  const readiness = executorReadiness(executor, snapshot);
  const blocked = executor.state === "blocked" || executor.eligibility?.reasons.some(reason => reason.code === "blocked");
  const signIn = readiness.reason.includes("Sign-in");
  // A problem the user can act on gets its own card; the reason is then stated there only (UI-15).
  const attention = (readiness.tone === "bad" || readiness.tone === "warn") && (!!blocked || signIn);
  const account = accounts?.find(a => a.name === executor.account);
  // The agent's own usage record (ADR 0030), else its account's: one record, quoted through usageView.
  const summary = snapshot.accounts?.find(a => a.name === executor.account);
  const record = executor.usageState ?? (account ? accountRecord(account, summary) : summary?.usageState);
  const view = usageView(record, snapshot.at ?? Date.now() / 1000);
  const stale = record?.freshness === "historical";
  // A historical reading states its age instead of a reset it may already have passed.
  const usageWords = [view.summary, stale ? "" : captionReset(view.reset), view.freshness].filter(Boolean).join(" · ");
  const accountRecordNow = account ? accountRecord(account, summary) : summary?.usageState;
  const spend = spendCopy(record?.spend?.usdWeek ?? accountRecordNow?.spend?.usdWeek ?? null, record?.spend?.capUsdWeek ?? accountRecordNow?.spend?.capUsdWeek ?? null);
  const signedIn = summary?.signedIn ?? account?.signedIn;
  const usageStatus = record?.error ? { ...paceStatus("unknown"), label: "Usage check failed", tone: "warn" as const }
    : signedIn !== false && record ? (stale && record.figure ? { ...paceStatus("unknown"), label: "Historical usage" } : record.verdict ? paceStatus(record.verdict) : null) : null;
  const value = settings.draft?.runners[executor.id];
  const cap = machineHardCap(snapshot.machine);
  const [refreshing, setRefreshing] = useState(false), [refreshNote, setRefreshNote] = useState<string>();
  const listing = models.available[executor.id];
  const disabled = busy || settings.busy || settings.enabledBusy || !settings.draft;
  const refresh = async () => {
    setRefreshing(true); setRefreshNote(undefined);
    const before = new Set((listing?.models ?? []).map(model => model.id));
    try {
      const [fresh, usage] = await Promise.all([
        models.refreshListing(executor.id),
        state.features.ops.has("limits.refresh") ? api.call("limits.refresh", { account: executor.account }).then(() => true, () => false) : Promise.resolve(true),
      ]);
      reloadAccounts();
      const added = (fresh?.models ?? []).filter(model => !before.has(model.id)).length;
      setRefreshNote([!fresh ? "Couldn't list models" : fresh.models ? `Listed just now${listing?.models && added ? ` · ${added} new ${added === 1 ? "model" : "models"}` : ""}` : fresh.note ?? "No model list for this agent", usage ? "" : "couldn't refresh usage"].filter(Boolean).join(" · "));
    } finally { setRefreshing(false); }
  };
  // Planner connection facts are only those the service observed.
  const console_ = snapshot.console, reserve = config?.keys?.["pacing.planner_reserve"]?.value;
  const connected = !!console_ && (snapshot.at ?? 0) - console_.heartbeatAt <= 30;
  const plannerFacts = ["Plans and reviews", `Hooks ${console_ ? "observed" : "not observed"}`, reserve != null ? `${Math.round(Number(reserve))}% reserve` : "", console_ ? `connection seen ${ago(console_.heartbeatAt, snapshot.at ?? console_.heartbeatAt)}` : ""].filter(Boolean).join(" · ");
  const [moveTo, setMoveTo] = useState(String(position + 1));
  useEffect(() => setMoveTo(String(position + 1)), [position]);
  const move = (text: string) => {
    setMoveTo(text);
    const target = Number(text);
    if (!Number.isInteger(target) || target < 1 || target > count || target === position + 1) return;
    settings.edit(draft => moveExecutor(draft, executor.id, target - 1 - position));
  };
  return <>
    <header className="pc-agent-detail__head">
      <AgentMark agent={markAgent(executor.id, executor.account)} size={40} />
      <div className="pc-agent-detail__title">
        <SectionHeading as="h2" variant="headline">{name} {planner && <Pill tone="info">Planner</Pill>} <span onKeyDown={containTooltipEscape}><Tooltip text={readiness.tooltip}><span tabIndex={0}><StatusPill status={readiness} /></span></Tooltip></span></SectionHeading>
        <span className="pc-agent-card__caption"><code>{executor.id}</code>{readiness.reason && !attention ? ` · ${readiness.reason}` : ""}</span>
      </div>
      <div className="pc-agent-detail__refresh">
        <span className="pc-agent-card__caption" role="status">{refreshNote ?? (listing && listing.fetchedAt > 0 ? `Models checked ${ago(listing.fetchedAt, Math.max(snapshot.at ?? 0, listing.fetchedAt))}` : "")}</span>
        <Button variant="secondary" size="sm" busy={refreshing || !!models.refreshing[executor.id]} disabled={!state.connected} aria-label={`Refresh ${name}: models, sign-in and usage`} onClick={() => void refresh()}><Icon name="refresh" />Refresh</Button>
      </div>
    </header>
    {dialogs.dialog}
    {attention && <Card tone={readiness.tone === "bad" ? "bad" : "warn"}><strong>{readiness.label}</strong><span className="u3-muted">{readiness.reason}</span><div className="u3-actions">
      {blocked && <Button size="sm" disabled={!!action.unavailable || action.busy || disabled} onClick={() => void independent(async () => { await action.run("runner.unblock", { id: executor.id }); })}>Unblock {name}</Button>}
      {signIn && <span className="u3-muted">Fix sign-in under Account below.</span>}
    </div></Card>}
    <div className="pc-agent-cards">
      <FactCard title="Usage">
        {usageStatus && <span><StatusPill status={usageStatus} /></span>}
        <strong className="pc-agent-card__figure">{view.figure}</strong>
        {view.meter !== null && <UsageMeter used={view.meter} pace={stale ? null : executor.pacePct ?? summary?.pacePct ?? null} tone={stale ? "neutral" : view.tone} size="slim" text="none" label={`${name} usage`} stale={stale} />}
        {usageWords !== view.figure && <span className="pc-agent-card__caption">{usageWords}</span>}
        <span className="pc-agent-card__caption">{view.source}</span>
        {spend && <span className="pc-agent-card__caption">{spend}</span>}
        {account && <AccountUsage account={account} reload={reloadAccounts} sourceError={account.usageState?.error?.message} />}
      </FactCard>
      <FactCard title="Account"><AgentAccount executor={executor} accounts={accounts} config={config} reload={reloadAccounts} /></FactCard>
      <FactCard title="Runs on">
        <strong>{executor.host ? <TextAction href={scoped(`#/settings/hosts/${encodeURIComponent(executor.host)}`)}>{executor.host}</TextAction> : "This machine"}</strong>
        <span className="pc-agent-card__caption">{[!planner && `Up to ${value?.maxTasks ?? executor.slots.max} ${(value?.maxTasks ?? String(executor.slots.max)) === "1" ? "task" : "tasks"} at once`, !planner && cap !== null && `machine limit ${cap}`, executor.lastCheck ? `test task ${executor.lastCheck.passed ? "passed" : "failed"} ${time(executor.lastCheck.at)}` : "Test task not run yet"].filter(Boolean).join(" · ")}</span>
        <div><Button size="sm" variant="quiet" disabled={!!check.unavailable || check.busy} onClick={() => void check.run("runner.check", { id: executor.id })}>Run test task<span className="sr-only"> for {name}</span></Button></div>
        <Feedback action={check} />
      </FactCard>
    </div>
    {planner && fallback && <Card tone="sunken" className="pc-agent-fallback">
      <div className="pc-agent-fallback__text">
        <strong id="planner-fallback-label">Take complex tasks when no executor can</strong>
        <span className="u3-muted">{!fallback.on ? "Off: Pacer sends the planner no delegated tasks." : `If no other agent has a ${tierLabels[fallback.target].toLowerCase()} model on, Pacer sends complex tasks here and spends planner quota, even when the planner is ahead of pace. ${fallback.complex === 0 ? "Right now that is the case." : `Right now ${fallback.complex} executor ${fallback.complex === 1 ? "model takes" : "models take"} them instead.`}${fallback.plannerFits ? "" : ` Size one of the planner's models ${tierLabels[fallback.target]} to let it take them.`}`}</span>
      </div>
      <ImmediateSetting value={fallback.on} operation={on => ({ op: "config.set", params: { key: "pacing.planner_tier_fallback", value: on ? "on" : "off" } })} onSaved={fallback.reload}>{(on, change, saving) =>
        <Switch aria-labelledby="planner-fallback-label" checked={on} disabled={saving || !state.connected} onChange={event => change(event.currentTarget.checked)} />}</ImmediateSetting>
    </Card>}
    <AgentModels runner={executor.id} agent={executor.agent} models={models} planner={planner} disabled={busy || settings.busy} />
    <section className="pc-stack pc-stack--compact" aria-labelledby="agent-limits-h">
      <SectionHeading as="h3" id="agent-limits-h">{planner ? "Role" : "Limits"}</SectionHeading>
      <div className="pc-agent-limits">
        {planner ? <div className="pc-agent-limits__row">
          <span className="pc-agent-limits__text"><strong>Planner {connected && <Pill tone="good">Connected</Pill>}</strong><span className="pc-agent-card__caption">The planner organizes the work. Only one agent can be the planner.</span><span className="pc-agent-card__caption">{plannerFacts}</span></span>
          <ButtonLink size="sm" variant="secondary" href={scoped("#/settings/planner")}>Change planner</ButtonLink>
        </div> : <>
          <div className="pc-agent-limits__row">
            <span className="pc-agent-limits__text"><strong id="takes-work-label">Takes work</strong><span className="pc-agent-card__caption">Applies now. Turn off to keep it out of every task without removing it. Agents marked Skipped, Cannot take work or Off receive no new work.</span></span>
            <ImmediateSave value={settings.saved?.runners.find(runner => runner.id === executor.id)?.enabled ?? executor.enabled} save={async enabled => { await settings.saveEnabled(executor.id, enabled); models.reload(); }}>{(on, change, saving) =>
              <Switch size="sm" aria-label={`${name} takes work`} checked={on} disabled={disabled || saving || !state.connected} onChange={event => change(event.currentTarget.checked)} />}</ImmediateSave>
          </div>
          {value && <div className="pc-agent-limits__row">
            <span className="pc-agent-limits__text"><label htmlFor="agent-tasks-at-once"><strong>Tasks at once</strong></label><span className="pc-agent-card__caption">{cap !== null ? `Delegated tasks it runs in parallel, up to ${cap} on this machine` : "Delegated tasks it runs in parallel"}</span>{settings.errors[executor.id] && <small className="pc-field__error" role="alert">{settings.errors[executor.id]}</small>}</span>
            <TextInput id="agent-tasks-at-once" className="pc-agent-limits__number" type="number" min="1" max="16" step="1" required value={value.maxTasks} disabled={disabled} onInput={event => { const text = event.currentTarget.value; settings.edit(draft => { draft.runners[executor.id]!.maxTasks = text; }); }} />
          </div>}
          {position >= 0 && <div className="pc-agent-limits__row">
            <span className="pc-agent-limits__text"><label htmlFor="agent-priority"><strong>Priority</strong></label><span className="pc-agent-card__caption">{count === 1 ? "Only one executor; priority cannot change." : `1 is tried first, of ${count}. Applies under the Priority policy, within Who can run what.`}</span></span>
            <TextInput id="agent-priority" className="pc-agent-limits__number" type="number" min="1" max={String(count)} step="1" value={moveTo} disabled={disabled || count < 2} onInput={event => move(event.currentTarget.value)} />
          </div>}
          <div className="pc-agent-limits__row">
            <span className="pc-agent-limits__text"><strong>Remove agent</strong><span className="pc-agent-card__caption">Removing keeps its task history.</span></span>
            <Button size="sm" variant="secondary" disabled={!!action.unavailable || action.busy || disabled} onClick={() => void independent(async () => { if (await dialogs.confirm(`Remove ${name}? Its task history stays.`, "Remove agent", "Remove")) await action.run("runner.remove", { id: executor.id }, onRemoved); })}>Remove {name}</Button>
          </div>
        </>}
      </div>
    </section>
    <Feedback action={action} />
  </>;
}

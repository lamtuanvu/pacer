import { assistantPreferences, setAssistantPreferences, watchAssistantPreferences } from "../../shell/assistant-entry";
import { containTooltipEscape } from "./shared";
import { Tooltip } from "../../ds/Tooltip";
import { markAgent } from "../../../../src/view-model/agents";
import { percentage, accountLabel } from "../../../../src/view-model/words";
import { ExecutorsSection } from "./Executors";
export { ExecutorsSection } from "./Executors";
import { PluginsSection } from "./Plugins";
import { AccountsSection } from "./Accounts";
export { AccountsSection } from "./Accounts";
import { MachineSection } from "./Machines";
export { TaskBackendField } from "./Machines";
import { AddExecutor } from "./AddExecutor";
import { HostDetail } from "./Hosts";
import { UpdatesSection } from "./Updates";
import { LazyDispatcher } from "./LazyDispatcher";
import { LazyAssistantSettings } from "./LazyAssistantSettings";

import { withQuery, type RouteQuery } from "../../router";
import { DensityContext } from "../../ds/Density";
import { settingsPageId } from "../../settings-pages";
import { SettingRow } from "../../ds/SettingRow";
import { Page, Stack } from "../../ds/Page";
import { Card } from "../../ds/Patterns";
import { UsageMeter } from "../../ds/UsageMeter";
import { modeWords, toneFor } from "../../../../src/view-model/words";
import { StatusDot } from "../../ds/StatusDot";
import { desktopUpdateIndicator } from "../../../../src/view-model/updates";
import { DiagnosticsSection } from "./Diagnostics";
import {
  Checkbox,
  Switch,
  Disclosure,
  Range,
  TextInput,
} from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { clock } from "../../../../src/view-model/time";
import { spendCopy } from "../../../../src/view-model/copy";
import { useDialogs } from "../../ds/useDialogs";
import {
  accountNeedsSignIn,
  accountStatus,
  executorLabel,
} from "../../../../src/view-model/words";
import { StatusPill } from "../../ds/StatusPill";
import {
  accountUsageFreshness,
  capacityNote,
  executorReadiness,
  machineHardCap,
} from "../../../../src/view-model/capacity";
import { desktopHost } from "../../data/desktop";
import { applyTheme, THEME_KEY, type ThemeChoice } from "../../theme";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ExecutorRow } from "../../../../src/api/read-model/types";
import { Pill } from "../../ds/Pill";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { arkcliRefreshMessage, arkcliSignInRequired, type Account } from "../../model/accounts";
import type { ConfigData, StrategyRow } from "../../model/strategy";
import type { RoutingRules } from "../../model/executors";
import type { AgentPreview } from "../../model/settings";
import { consentAction, plannerAgent } from "../../model/settings";
import { Dialog, useTaskContext } from "../task-shared";
import {
  Feedback,
  Field,
  ResourceState,
  Section,
  Segment,
  time,
  useOperation,
  useResource,
  words,
  SettingsPageContext,
  SettingsQueryContext,
  useSettingsStyles,
} from "./shared";
interface AssistantStatus { available: boolean; configured: boolean; account?: string; reason?: string }

export interface SettingsData {
  assistant?: AssistantStatus;
  config?: ConfigData;
  accounts?: Account[];
  routing?: RoutingRules;
  strategies?: StrategyRow[];
  notifications?: { level: string };
  updates?: {
    current: string;
    latest: string | null;
    available: boolean;
    error?: string;
    disabled?: boolean;
    checkedAt?: number;
  };
}
/** Pages whose changes reach routing; Overview, App preferences and Diagnostics do not. */
const DISPATCH_NOTE = new Set(["accounts", "machine", "hosts", "dispatcher"]);
/** Mount only the selected editor: inactive pages must not fetch or run effects. */
export function SettingsGeneral({
  section,
  initialData = {},
  query = { repo: null, scope: null },
  host,
  alias,
}: {
  section?: string;
  initialData?: SettingsData;
  query?: RouteQuery;
  /** Add agent prefills this host; host detail shows this alias. */
  host?: string;
  alias?: string;
}) {
  let content: ComponentChildren;
  switch (section) {
    case "planner":
      content = <PlannerPacing initialData={initialData.config} initialAccounts={initialData.accounts} />;
      break;
    case "accounts":
      content = <AccountsSection initialData={initialData.accounts} initialConfig={initialData.config} />;
      break;
    case "executors":
      content = <ExecutorsSection />;
      break;
    case "machine":
    case "hosts":
      if (alias) return <DensityContext.Provider value="settings"><HostDetail key={alias} alias={alias} /></DensityContext.Provider>;
      content = <MachineSection initialData={initialData.config} />;
      break;
    case "add-executor":
      content = <AddExecutor host={host} />;
      break;
    case "dispatcher":
      content = <LazyDispatcher query={query} />;
      break;
    case "app":
    case "updates":
    case "notifications":
    case "appearance":
      content = <AppPreferences section={section} initialData={initialData} />;
      break;
    case "assistant":
      content = <LazyAssistantSettings />;
      break;
    case "diagnostics":
      content = <DiagnosticsSection />;
      break;
    default:
      content = <GeneralOverview query={query} initialData={initialData} />;
  }
  return (
    <DensityContext.Provider value="settings">
      <SettingsPageContext.Provider
        value={section === "planner" ? "pacing" : section ? settingsPageId(section) : null}
      >
        <SettingsQueryContext.Provider value={query}>
        <Page width="full" className="u3-settings u3-settings-page">
          {section === "dispatcher" && <h1>Dispatcher</h1>}
          <div className="u3-general-sections">{content}</div>
          {DISPATCH_NOTE.has(section ?? "") && (
            <p className="u3-settings-note">
              Changes apply on the next routing decision.
            </p>
          )}
        </Page>
        </SettingsQueryContext.Provider>
      </SettingsPageContext.Provider>
    </DensityContext.Provider>
  );
}

/** Readiness uses service facts only; missing capabilities do not become placeholder rows. */
function GeneralOverview({ query, initialData }: { query: RouteQuery; initialData: SettingsData }) {
  useSettingsStyles();
  const { state } = useTaskContext();
  const config = useResource<ConfigData>("config.get", {}, initialData.config);
  const snapshot = state.snapshot;
  const executors = snapshot?.executors;
  const stale = (e: ExecutorRow) => e.stale || snapshot?.accounts?.some(a => a.name === e.account && a.stale);
  const readiness = (e: ExecutorRow) => executorReadiness(e, snapshot!);
  // Readiness follows execution evidence, independently of whether a task is running.
  const ready = executors?.filter(e => ["Ready", "Ahead of pace"].includes(readiness(e).label)) ?? [];
  const needs = executors?.filter(e => ["Skipped", "Cannot take work"].includes(readiness(e).label) && readiness(e).tone !== "neutral") ?? [];
  const active = snapshot?.strategies?.find(s => typeof s !== "string" && s.active);
  const setup = typeof active === "object" ? active : initialData.strategies?.find(s => s.active);
  const value = (key: string) => config.data?.keys[key]?.value;
  const href = (page: string) => withQuery(`#/settings/${page}`, query);
  const update = desktopUpdateIndicator(snapshot?.desktopUpdates);
  const checks: { title: string; detail?: string; tooltip?: string; tone: "good" | "bad" | "warn" | "neutral"; page: string; link: string }[] = [];
  for (const e of executors ?? []) {
    const status = readiness(e);
    if (status.label !== "Ready") checks.push({ title: `${executorLabel(e.id)} · ${status.label}`, detail: status.reason, tone: status.tone === "info" ? "neutral" : status.tone, tooltip: status.tooltip, page: "executors", link: "Open agent" });
  }
  for (const account of snapshot?.accounts ?? []) {
    if (account.stale && !executors?.some(e => e.account === account.name && stale(e))) checks.push({ title: `${accountLabel(account)} usage reading is stale`, detail: accountUsageFreshness(account) ?? undefined, tone: "warn", page: "executors", link: "Agents" });
  }
  if (snapshot?.console) checks.push({ title: "Planner connection observed", detail: `Last seen ${time(snapshot.console.heartbeatAt)}`, tone: "neutral", page: "executors", link: "Agents" });
  if (executors) checks.push({ title: `${ready.length} ${ready.length === 1 ? "executor" : "executors"} ready`, detail: ready.map(e => executorLabel(e.id)).join(", "), tone: ready.length ? "good" : "warn", page: "executors", link: "Agents" });
  if (setup) checks.push({ title: `Saved setup ${setup.name} is active`, detail: setup.summary, tone: "good", page: "dispatcher", link: "Dispatcher" });
  if (update) checks.push({ title: update.label, tone: update.tone === "bad" ? "bad" : "warn", page: "app", link: "App" });
  else if (initialData.updates?.available && initialData.updates.latest) checks.push({ title: `pacer ${initialData.updates.latest} is available`, detail: `You have ${initialData.updates.current}`, tone: "warn", page: "app", link: "App" });
  const tiles: { label: string; value: string; note?: string; page: string }[] = [];
  if (executors) tiles.push({ label: "Agents", value: `${snapshot?.planner ? `${executorLabel(snapshot.planner.agent)} plans · ` : ""}${executors.length} executors`, note: ready.length ? `${ready.length} ready to take work` : "No executors ready", page: "executors" });
  if (setup) tiles.push({ label: "Dispatcher", value: `Saved setup ${setup.name}`, note: setup.summary, page: "dispatcher" });
  if (value("pacing.planner_reserve") != null) tiles.push({ label: "Budget", value: `${percentage(Number(value("pacing.planner_reserve")))} planner reserve`, note: [value("pacing.accounts") ? `${words(String(value("pacing.accounts")))} accounts` : "", value("pacing.fill_threshold") != null ? `move on at ${percentage(Number(value("pacing.fill_threshold")))}` : ""].filter(Boolean).join(" · "), page: "planner" });
  if (snapshot?.machine) tiles.push({ label: "Machines", value: machineHardCap(snapshot.machine) === null ? "No limit" : `${machineHardCap(snapshot.machine)} parallel`, note: snapshot.hosts ? `${snapshot.hosts.length} remote hosts` : undefined, page: "machine" });
  return <div className="pc-settings-board pc-settings-board--overview">
    <header className="pc-settings-board__header"><h1>Overview</h1><p>What pacer needs before it can dispatch freely.</p></header>
    {executors && <Card tone="sunken"><div className="pc-readiness-summary">
      <div className="pc-readiness-summary__copy"><strong>{ready.length} of {executors.length} agents can take work. {needs.length} {needs.length === 1 ? "needs" : "need"} you.</strong>
        {needs.length > 0 && <p>{needs.map(e => `${executorLabel(e.id)}: ${readiness(e).reason}`).join(" · ")}</p>}
      </div><div className="pc-readiness-marks">{executors.map(e => <span key={e.id} className="pc-readiness-mark" title={`${executorLabel(e.id)} · ${readiness(e).label} · ${readiness(e).tooltip}`}><AgentMark agent={markAgent(e.id,e.account)} size={28}/><StatusDot tone={readiness(e).tone} label={`${executorLabel(e.id)}: ${readiness(e).label}`} paired="glyph"/></span>)}</div>
    </div></Card>}
    {checks.length > 0 && <section className="pc-settings-board__section" aria-labelledby="readiness-h"><h2 id="readiness-h" className="pc-settings-board__label">Readiness</h2><div className="pc-readiness-list">{checks.map((c, i) => <div key={i} className={`pc-readiness-row pc-readiness-row--${c.tone}`}><span className="pc-readiness-glyph" aria-hidden="true">{({good:"✓",bad:"✕",warn:"◐",neutral:"○"})[c.tone]}</span><span className="pc-readiness-row__copy" onKeyDown={c.tooltip ? containTooltipEscape : undefined}>{c.tooltip ? <Tooltip text={c.tooltip}><strong tabIndex={0}>{c.title}</strong></Tooltip> : <strong>{c.title}</strong>}{c.detail && <span className="pc-settings-board__caption">{c.detail}</span>}</span><a className="pc-inline-link" href={href(c.page)}>{c.link}</a></div>)}</div></section>}
    {tiles.length > 0 && <section className="pc-settings-board__section" aria-labelledby="setup-h"><h2 id="setup-h" className="pc-settings-board__label">Current setup</h2><div className="pc-settings-tiles">{tiles.map(t => <a key={t.label} className="pc-inline-link pc-settings-tile" href={href(t.page)}><span className="pc-settings-board__label">{t.label}</span><strong>{t.value}</strong>{t.note && <span className="pc-settings-board__caption">{t.note}</span>}</a>)}</div></section>}
  </div>;
}

/** Updates, notifications and appearance share one page; their old deep links scroll to their section. */
function AppPreferences({ section, initialData }: { section: string; initialData: SettingsData }) {
  useEffect(() => {
    if (section === "app") return;
    // The shell focuses the main region after this effect, and sections above may still be loading:
    // keep the target aligned until it settles, the user scrolls, or two seconds pass.
    const target = () => document.getElementById(section);
    const align = () => target()?.scrollIntoView({ block: "start" });
    const frame = requestAnimationFrame(align);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    const page = target()?.parentElement;
    if (page) observer?.observe(page);
    const stop = () => { observer?.disconnect(); cancelAnimationFrame(frame); };
    const timer = setTimeout(stop, 2000);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    events.forEach(name => addEventListener(name, stop, { once: true, passive: true }));
    return () => { stop(); clearTimeout(timer); events.forEach(name => removeEventListener(name, stop)); };
  }, [section]);
  return (
    <div className="pc-settings-board pc-settings-board--app">
      <header className="pc-settings-board__header"><h1>App preferences</h1><p>How the app looks and talks to you. These stay on this device and never affect routing.</p></header>
      <AppearanceSection />
      <NotificationsSection initialData={initialData.notifications} />
      <WorkspacePreferences initialAssistant={initialData.assistant} />
      <UpdatesSection initialData={initialData.updates} initialConfig={initialData.config} />
      <PluginsSection />
    </div>
  );
}

/** Budget controls use only existing service operations; account readings supply all windows. */
export function PlannerPacing({ initialData, initialAccounts }: { initialData?: ConfigData; initialAccounts?: Account[] }) {
  const query = useResource("config.get", {}, initialData),
    accounts = useResource<Account[]>("account.list", {}, initialAccounts),
    action = useOperation(query.reload),
    { state } = useTaskContext();
  const [chosen, setChosen] = useState("");
  const paceClock = useResource<{ calendarPace: boolean }>("routing.status");
  const config = query.data, planner = state.snapshot?.planner,
    value = (key: string) => String(config?.keys[key]?.value ?? "");
  const save = (key: string, value: string | number) => void action.run("config.set", { key, value });
  const agent = planner?.agent ?? plannerAgent(value("planner")), name = executorLabel(agent);
  const modes = ["emergency", "strict", "normal", "relaxed"];
  const mode = planner?.mode;
  const delta = planner?.usedPct != null && planner.pacePct != null ? Math.round(planner.usedPct - planner.pacePct) : null;
  const modeCopy = mode === "relaxed" ? "so it may do small edits itself." : mode === "normal" ? "so it delegates substantial work." : mode === "strict" ? "so it delegates everything." : mode === "emergency" ? "so it reserves quota for planning and review." : "";
  const sentence = planner?.stale ? `${name} has a stale usage reading.` : delta !== null
    ? `${name} is ${delta === 0 ? "on pace" : `${Math.abs(delta)} points ${delta < 0 ? "under" : "ahead of"} pace`}${modeCopy ? `, ${modeCopy}` : "."}`
    : planner?.advice;
  const summary = state.snapshot?.accounts ?? [];
  // account.list exposes every measured window; the snapshot supplies pace/verdict only for its binding window.
  const windows = (accounts.data ?? []).flatMap(account => {
    const binding = summary.find(row => row.name === account.name);
    const readings = account.usageReading?.windows.length ? account.usageReading.windows : (binding?.window ? [{ name: binding.window, usedPct: binding.usedPct, resetsAt: binding.resetsAt }] : []);
    return readings.map(window => {
      const matched = binding?.window === window.name ? binding : undefined;
      const stale = window.stale ?? account.usageReading?.stale ?? matched?.stale;
      const capturedAt = account.usageReading?.capturedAt ?? matched?.capturedAt;
      const note = stale ? `Stale${capturedAt != null ? ` · ${Math.floor(Math.max(0, Date.now() / 1000 - capturedAt) / 3600)}h old` : ""}`
        : [window.usedPct != null ? `${Math.round(window.usedPct)}%` : "Usage unknown", matched?.pacePct != null ? `pace ${Math.round(matched.pacePct)}%` : null, matched?.verdict === "AHEAD" ? "ahead" : null].filter(Boolean).join(" · ");
      return { account, window, binding: matched, stale, capturedAt, note };
    });
  });
  return <div id="pacing" className="pc-settings-board pc-settings-board--budget">
    <header className="pc-settings-board__header"><h1>Budget &amp; pacing</h1><p>How much of each subscription pacer may use, and how fast. Changes apply to the next decision.</p></header>
    {planner && <Card tone="sunken"><div className="pc-budget-summary">
      <div className="pc-budget-summary__copy">
        <div className="pc-budget-identity"><AgentMark agent={agent} size={20}/><b>{name}</b><Pill tone="info">Planner</Pill>{mode && <Pill tone={mode === "relaxed" ? "good" : mode === "strict" ? "warn" : mode === "emergency" ? "bad" : "neutral"}>{modeWords(mode)} mode</Pill>}</div>
        {sentence && <strong className="pc-budget-sentence">{sentence}</strong>}
        <UsageMeter used={planner.usedPct ?? null} pace={planner.pacePct ?? null} tone={toneFor(planner.verdict)} size="bar" label={`${name} ${planner.window ?? "budget"} usage`} stale={planner.stale} text="none"/>
        <span className="pc-settings-board__caption">{[planner.usedPct != null ? `${percentage(planner.usedPct)}${planner.window ? ` of ${planner.window}` : ""} used` : null, planner.pacePct != null ? `pace ${percentage(planner.pacePct)}` : null, value("pacing.planner_reserve") ? `${percentage(Number(value("pacing.planner_reserve")))} kept for planning and review` : null, planner.resetsAt != null ? `resets ${time(planner.resetsAt)}` : null].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="pc-budget-modes" role="img" aria-label={`Pace modes: Emergency, Strict, Normal, Relaxed; ${mode && modes.includes(mode) ? `${modeWords(mode)} is active` : "active mode unavailable"}`}>
        <span className="pc-settings-board__label">Mode is set by pace</span>
        <div className="pc-budget-modes__bar">{modes.map(m => <span key={m} className={`pc-budget-mode pc-budget-mode--${m}${mode === m ? " pc-budget-mode--active" : ""}`}><span className="pc-budget-mode__fill"/><span>{modeWords(m)}</span></span>)}</div>
        <span className="pc-settings-board__caption">Strict delegates everything; relaxed lets the planner do small work when it has quota to spare.</span>
      </div>
    </div></Card>}
    <ResourceState resource={query}>{config && <>
      <section className="pc-preferences-section" aria-labelledby="budget-planner-h"><h2 id="budget-planner-h" className="pc-settings-board__label">Planner</h2>
        <SettingRow headingLevel={3} variant="budget" label="Keep back for planning and review" description="The planner never delegates this share away. Raise it if reviews get cut short.">
          <div className="pc-budget-reserve"><Range aria-label="Keep back for planning and review" min="0" max="50" step="5" value={value("pacing.planner_reserve")} disabled={action.busy} onChange={e => { if (e.currentTarget.validity.valid) save("pacing.planner_reserve", Number(e.currentTarget.value)); }}/><output>{percentage(Number(value("pacing.planner_reserve")))}</output><span className="pc-settings-board__caption">0–50%</span></div>
        </SettingRow>
        <SettingRow headingLevel={3} variant="budget" label="Mode" description="Automatic follows the pace above. Hold keeps one mode until the planner window resets.">
          <Segment variant="board" label="Mode" value={planner?.modeHeldUntil != null ? mode ?? "" : "auto"} disabled={action.busy} options={[{ value: "auto", label: "Automatic" }, { value: "strict", label: "Hold strict" }, { value: "relaxed", label: "Hold relaxed" }]} onChange={v => { void action.run(v === "auto" ? "mode.release" : "mode.hold", v === "auto" ? {} : { mode: v }); }}/>
          {mode && <span className="pc-settings-board__caption">Now: {modeWords(mode).toLowerCase()}{planner?.modeHeldUntil != null ? `, held until ${time(planner.modeHeldUntil)}` : ""}.</span>}
        </SettingRow>
        <SettingRow headingLevel={3} variant="budget" label="Planner" description="Who plans and reviews. Changing it rewires that agent's hooks and status line.">
          <div className="pc-budget-planner">
            <ChoicePicker sizing="content" aria-label="Planner" value={value("planner")} placeholder="Choose a planner" disabled={action.busy} options={config.planners.map(planner => ({ value: planner, label: executorLabel(planner) }))} onValueChange={setChosen}/>
            <Button size="sm" disabled={action.busy || !value("planner")} onClick={() => setChosen(value("planner"))}>Review integration changes</Button>
          </div>
        </SettingRow>
        <SettingRow headingLevel={3} variant="budget" label="Pace clock" description="How pacer spreads a weekly budget over time. Set automatically.">
          <ResourceState resource={paceClock}><div className="pc-budget-clock">
            <b>{paceClock.data?.calendarPace ? "Calendar time" : "Your working hours"}</b>
            <span className="pc-settings-board__caption">{paceClock.data?.calendarPace ? "Not enough activity history yet." : `Learned from activity${planner?.activeHoursLeft != null ? `: about ${Math.round(planner.activeHoursLeft)} active hours left in this budget window` : "."}`}</span>
          </div></ResourceState>
        </SettingRow>
      </section>
      <section className="pc-preferences-section" aria-labelledby="budget-executors-h"><h2 id="budget-executors-h" className="pc-settings-board__label">Executors</h2>
        <SettingRow headingLevel={3} variant="budget" label="Pacing policy" description="How work spreads across executors that may take it.">
          <Segment variant="board" label="Pacing policy" value={value("pacing.policy")} disabled={action.busy} onChange={v => save("pacing.policy", v)} options={[{ value: "priority", label: "Priority" }, { value: "even", label: "Even" }, { value: "burn-before-reset", label: "Burn before reset" }, { value: "cheapest-first", label: "Cheapest first" }]}/>
          <span className="pc-settings-board__caption">Priority uses the order on the Agents page and skips one only when it is out of quota or ahead of pace. Readings older than <b>24 hours</b> count as unknown.</span>
        </SettingRow>
      </section>
    </>}</ResourceState>
    <section className="pc-settings-board__section" aria-labelledby="budget-windows-h"><h2 id="budget-windows-h" className="pc-settings-board__label">Budget windows</h2>
      <ResourceState resource={accounts}>{windows.length ? <div className="pc-budget-windows">{windows.map(({ account, window, binding, stale, capturedAt, note }) => <div className="pc-budget-window" key={`${account.name}:${window.name}`}>
        <span className="pc-budget-identity"><AgentMark agent={markAgent(account.runners?.[0] ?? binding?.agent ?? account.kind,account.name)} size={20}/><b>{accountLabel(account)}</b></span>
        <span className="pc-settings-board__caption">{words(window.name)}</span>
        <span className="pc-budget-window__usage"><UsageMeter used={window.usedPct} pace={binding?.pacePct ?? null} tone={toneFor(binding?.verdict ?? "unknown")} size="row" label={`${accountLabel(account)} ${window.name} usage`} stale={stale} staleAt={capturedAt ?? undefined} text="none"/><span className="pc-settings-board__caption">{note}</span></span>
        <span className="pc-settings-board__caption">{window.resetsAt != null ? time(window.resetsAt) : ""}</span>
      </div>)}</div> : <span className="pc-settings-board__caption">No budget windows reported.</span>}</ResourceState>
    </section>
    <Feedback action={action}/>
    {chosen && <PlannerConsent planner={chosen} close={() => setChosen("")} done={query.reload}/>}
  </div>;
}

function PlannerConsent({
  planner,
  close,
  done,
}: {
  planner: string;
  close: () => void;
  done: () => void;
}) {
  const agent = plannerAgent(planner),
    query = useResource<AgentPreview>("agent.preview", { agent }),
    action = useOperation(done);
  const save = (integrations: "install" | "skip") => {
    const op = consentAction(query.data, planner, integrations);
    void action.run(op.op, op.params, close);
  };
  return (
    <Dialog title="Planner integration changes" close={close}>
      <div className="u3-settings">
        <p>
          Review the files pacer will change before connecting this planner.
        </p>
        <ResourceState resource={query}>
          {query.data && (
            <>
              <ul>
                {query.data.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
              <p>
                Undo: <code>{query.data.undo}</code>
              </p>
              <p>
                Change and connect removes the previous planner’s integration.
                Change only keeps its existing hooks.
              </p>
              <div className="u3-actions">
                <Button disabled={action.busy} onClick={() => save("install")}>
                  Change and connect
                </Button>
                <Button disabled={action.busy} onClick={() => save("skip")}>
                  Change only
                </Button>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      "agent.connect",
                      { agent, consent: true },
                      done,
                    )
                  }
                >
                  Connect {agent}
                </Button>
              </div>
            </>
          )}
        </ResourceState>
        <Feedback action={action} />
      </div>
    </Dialog>
  );
}
function NotificationsSection({
  initialData,
}: {
  initialData?: { level: string };
}) {
  const query = useResource("notifications.get", {}, initialData),
    action = useOperation(query.reload);
  return (
    <section id="notifications" className="pc-preferences-section" aria-labelledby="notifications-h">
      <h2 id="notifications-h" className="pc-settings-board__label">Notifications</h2>
      <ResourceState resource={query}>
        <SettingRow variant="board" label="Notify me about" description="Important: failures, stuck tasks and results waiting for review.">
          <Segment
            variant="board" label="Notify me about"
            value={query.data?.level ?? ""}
            disabled={action.busy}
            options={[
              { value: "off", label: "Nothing" },
              { value: "important", label: "Important" },
              { value: "all", label: "Everything" },
            ]}
            onChange={(level) => void action.run("notifications.set", { level })}
          />
        </SettingRow>

      </ResourceState>
      <Feedback action={action} />
    </section>
  );
}
function AppearanceSection() {
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem("pacer.density") === "compact" ? "compact" : "normal"; }
    catch { return "normal"; }
  });
  const [theme, setTheme] = useState(() => {
      try {
        const saved = localStorage.getItem("pacer.theme");
        return saved && ["system", "light", "dark"].includes(saved)
          ? saved
          : "system";
      } catch {
        return "system";
      }
    }),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const sync = () => { try { setTheme(localStorage.getItem(THEME_KEY) ?? "system"); setDensity(localStorage.getItem("pacer.density") === "compact" ? "compact" : "normal"); } catch { /* device storage unavailable */ } };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <section id="appearance" className="pc-preferences-section" aria-labelledby="look-h">
      <h2 id="look-h" className="pc-settings-board__label">Look</h2>
      <SettingRow variant="board" label="Theme" description="System follows macOS.">
      <Segment
        variant="board" label="Theme"
        value={theme}
        options={["system", "light", "dark"].map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
        }))}
        onChange={(value) => {
          setTheme(value);
          applyTheme(value as ThemeChoice);
          try {
            localStorage.setItem(THEME_KEY, value);
            setMessage("Saved on this device.");
          } catch {
            setMessage(
              "Applied for this session. Device storage is unavailable.",
            );
          }
        }}
      />
      </SettingRow>
      <SettingRow variant="board" label="Density" description="Compact fits more rows on screen.">
        <Segment variant="board" label="Density" value={density} options={[{ value: "compact", label: "Compact" }, { value: "normal", label: "Comfortable" }]} onChange={value => {
          setDensity(value);
          window.dispatchEvent(new CustomEvent("pacer:density", { detail: value }));
          try { localStorage.setItem("pacer.density", value); setMessage("Saved on this device."); }
          catch { setMessage("Applied for this session. Device storage is unavailable."); }
        }}/>
      </SettingRow>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

/** Assistant availability is supplied by the service. */
function WorkspacePreferences({ initialAssistant }: { initialAssistant?: AssistantStatus }) {
  const assistant = useResource<AssistantStatus>("assistant.status", {}, initialAssistant);
  const status = assistant.data;
  const [preferences, setPreferences] = useState(assistantPreferences);
  useEffect(() => watchAssistantPreferences(() => setPreferences(assistantPreferences())), []);
  return <section className="pc-preferences-section" aria-labelledby="workspace-h">
    <h2 id="workspace-h" className="pc-settings-board__label">Workspace</h2>
    <SettingRow variant="board" label="Assistant" description="Open with ⌘J from anywhere. Runs on one endpoint account you choose; until then the button opens the setup.">
      <div className="pc-assistant-preferences"><Switch size="sm" label="Show the button" aria-label="Show assistant button" checked={preferences.showButton} onChange={event => setAssistantPreferences({ showButton: event.currentTarget.checked })} />
      <Switch size="sm" label="Still aurora" aria-label="Reduce assistant motion" checked={preferences.stillAurora} onChange={event => setAssistantPreferences({ stillAurora: event.currentTarget.checked })} /></div>
      <ResourceState resource={assistant}>{status && <span role="status">{status.available ? "Available" : status.configured ? "Unavailable" : "Not configured"}{status.account ? ` · ${status.account}` : ""}{status.reason ? ` · ${status.reason}` : ""}</span>}</ResourceState>
      <a className="pc-inline-link" href="#/settings/assistant">Choose account and limits</a>
    </SettingRow>
  </section>;
}

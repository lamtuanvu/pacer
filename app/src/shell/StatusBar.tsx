import { useDialogs } from "../ds/useDialogs";
import { browserSessionIdentity, sessionRuntimes } from "../term/runtime";
import { useEffect, useRef, useState } from "preact/hooks";
import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { capacity, counts as snapshotCounts, plannerMeter } from "../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { executorLabel } from "../../../src/view-model/words";
import { usageSourceWords, usageView, usageWindowView } from "../../../src/view-model/usage";
import { AgentMark } from "../ds/AgentMark";
import { Kbd } from "../ds/Kbd";
import { Icon } from "../ds/icons";
import { UsageMeter } from "../ds/UsageMeter";
import { Button, IconButton } from "../ds/Button";
import { Tooltip } from "../ds/Tooltip";
import { PopoverDialog } from "../ds/Dialog";
import type { Account } from "../model/accounts";
import { useQuery, useTaskContext } from "../screens/task-shared";
import type { KeyRegistry } from "../keys/registry";
import type { Route } from "../router";

export function dismissUsageOnEscape(event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">, close: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

/** `terminal` adds the dock toggle; it is omitted wherever the dock cannot open. */
export function StatusBar({ route, snapshot, registry, terminal }: { route?: Route; snapshot: ClientSnapshot | null; registry: KeyRegistry; terminal?: { open: boolean; toggle: () => void } }) {
  const [, runtimeChanged] = useState(0);
  useEffect(() => sessionRuntimes.subscribe(() => runtimeChanged(n => n + 1)), []);
  useEffect(() => sessionRuntimes.updateTasks(browserSessionIdentity(), snapshot?.tasks ?? []), [snapshot?.tasks]);
  const hiddenControl = sessionRuntimes.hiddenDriving();
  const dialogs = useDialogs();
  const [help, setHelp] = useState(() => registry.list().find(shortcut => shortcut.keys === "?"));
  useEffect(() => { const update = () => setHelp(registry.list().find(shortcut => shortcut.keys === "?")); update(); return registry.subscribe(update); }, [registry]);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageButton = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!usageOpen) return;
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(timer);
  }, [usageOpen]);
  const planner = snapshot ? plannerMeter(snapshot) : null;
  const plannerView = planner ? usageView(planner.usageState, now) : null;
  // A record without a figure is a state, never a number: the chip hides instead of showing a percent (UI-10).
  const visiblePlanner = planner && plannerView && plannerView.meter !== null ? planner : null;
  // The Dispatch home's Planner budget states the figure; here the planner keeps only its mark (UI-15).
  const plannerFigure = route?.name !== "dispatch";
  const markedPlanner = plannerFigure ? visiblePlanner : planner;
  const markedPlannerView = markedPlanner ? usageView(markedPlanner.usageState, now) : null;
  const executors = snapshot ? capacity(snapshot).filter(executor => {
    const view = usageView(executor.usageState, now);
    return view.meter !== null && !(markedPlanner && executor.id === markedPlanner.runner);
  }) : [];
  const historical = (state: { freshness?: string } | null | undefined) => state?.freshness === "historical";
  // One warning word per chip, shown as "!" and spoken in the button's label (UI-2).
  const warningFor = (state: Parameters<typeof usageView>[0]) => historical(state) ? "Historical usage"
    : state?.verdict === "AHEAD" ? "Ahead of pace"
    : state?.verdict === "NEAR_LIMIT" ? "Near limit"
    : state?.verdict === "EXHAUSTED" ? "Out of quota" : null;
  const spoken = (state: Parameters<typeof usageView>[0], figure: string) => { const w = warningFor(state); return w && w !== figure ? `, ${w.toLowerCase()}` : ""; };
  const usageNames = [
    ...(markedPlanner && markedPlannerView ? [`${agentInfo(markedPlanner.agent).name} planner${plannerFigure ? ` ${markedPlannerView.figure}${spoken(markedPlanner.usageState, markedPlannerView.figure)}` : ", shown in Planner budget"}`] : []),
    ...executors.map(executor => {
      const view = usageView(executor.usageState, now);
      return `${executorLabel(executor.id)} ${view.figure}${spoken(executor.usageState, view.figure)}`;
    }),
  ];
  const counts = snapshot ? snapshotCounts(snapshot) : null;
  const hints = usageOpen ? [{ keys: "Escape", label: "close usage" }] : [];
  const budget = (key: string, agent: string, name: string, state: Parameters<typeof usageView>[0]) => {
    const view = usageView(state, now);
    // The meter takes the record's tone; the warning follows the verdict, not the label string (NEAR_LIMIT and EXHAUSTED warn too).
    const warning = warningFor(state);
    return <span className="pc-statusbar__item" key={key} title={`${name} · ${view.figure}${warning ? ` · ${warning.toLowerCase()}` : ""}`}>
      <AgentMark agent={agent} size={16} labelled={false} /><span className="pc-num pc-statusbar__pct">{view.figure}</span>
      <UsageMeter used={view.meter} pace={null} tone={view.tone} size="mini" text="none" label={`${name} usage`} stale={historical(state)} />
      {warning && <span className="pc-statusbar__stale" role="img" aria-label={warning}>!</span>}
    </span>;
  };
  return <footer className="pc-statusbar" aria-label="Status bar">
    <Button ref={usageButton} size="sm" className="pc-statusbar__usage-button" aria-label={`Usage details${usageNames.length ? `: ${usageNames.join(", ")}` : ": unavailable"}`} aria-expanded={usageOpen} aria-controls="pc-usage-details" onClick={() => setUsageOpen(open => !open)}>
      {markedPlanner && !plannerFigure && <span className="pc-statusbar__item" key="planner" title={`${agentInfo(markedPlanner.agent).name} planner, shown in Planner budget`}><AgentMark agent={markedPlanner.agent} size={16} labelled={false} /></span>}
      {visiblePlanner && plannerFigure && visiblePlanner.usageState && budget("planner", visiblePlanner.agent, agentInfo(visiblePlanner.agent).name, visiblePlanner.usageState)}
      {executors.map(executor => budget(executor.id, markAgent(executor.id, executor.account), executorLabel(executor.id), executor.usageState))}
      {!usageNames.length && <span>Usage</span>}
    </Button>
    <span className="grow" />
    {dialogs.dialog}
    <span role="status" aria-live="polite">{hiddenControl.length > 0 && <Button size="sm" variant="quiet" onClick={() => { void handBackHidden(hiddenControl, message => dialogs.confirm(message, 'Hand back control', 'Hand back')); }}><Icon name="status-terminal" />{hiddenControlLabel(hiddenControl.length)}</Button>}</span>
    {counts && <a href="#/tasks" className="pc-statusbar__work pc-inline-link"><span className="pc-statusbar__dot" aria-hidden="true" />{counts.running} running · {counts.queued} queued</a>}
    {terminal && <Button size="sm" variant="quiet" className="pc-statusbar__terminal" aria-label="Terminal" aria-keyshortcuts="Control+`" aria-expanded={terminal.open} aria-controls={terminal.open ? "pc-terminal-dock" : undefined} onClick={terminal.toggle}><Icon name="status-terminal" />Terminal <span className="pc-statusbar__keys">Ctrl+`</span></Button>}
    <div className="pc-statusbar__hints">{hints.length ? hints.map(hint => <span className="pc-statusbar__hint" key={`${hint.keys}:${hint.label}`}><Kbd>{hint.keys === "Escape" ? "Esc" : hint.keys}</Kbd> {hint.label}</span>) : help && <Button size="sm" variant="quiet" className="pc-statusbar__help" onClick={help.run}>? shortcuts</Button>}</div>
    <span className="pc-statusbar__version">pacer {snapshot?.service?.version ?? ""}</span>
    {usageOpen && <PopoverDialog id="pc-usage-details" title="Usage details" close={() => setUsageOpen(false)}><UsagePopover close={() => setUsageOpen(false)} now={now} /></PopoverDialog>}
  </footer>;
}

export function UsagePopover({ close, now }: { close: () => void; now: number }) {
  const { api } = useTaskContext();
  const query = useQuery<Account[]>("account.list", {});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>();
  const [refreshMessage, setRefreshMessage] = useState("");
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(undefined);
    setRefreshMessage("");
    try {
      const result = await api.call<{ accounts: { outcome: string }[] }>("limits.refresh", {});
      const updated = result.accounts.filter(account => account.outcome === "updated").length;
      const failed = result.accounts.filter(account => account.outcome === "failed").length;
      setRefreshMessage(failed ? `${updated} updated; ${failed} could not be refreshed.` : updated ? `${updated} account${updated === 1 ? "" : "s"} updated.` : "No new usage reported.");
      query.reload();
    } catch (error) { setRefreshError(error); }
    finally { setRefreshing(false); }
  }
  return <>
    <div className="pc-dialog-popover__head pc-usage-popover__head"><strong>Usage</strong><span className="grow" />
      <Tooltip text="Refresh usage"><IconButton variant="quiet" icon="refresh" aria-label="Refresh usage" onClick={refresh} busy={refreshing} /></Tooltip>
      <Tooltip text="Close"><IconButton variant="quiet" icon="close" aria-label="Close" onClick={close} /></Tooltip>
    </div>
    <div className="pc-dialog-popover__body">
    {refreshError && <p role="alert">Could not refresh usage. Try again.</p>}
    {refreshMessage && <p role="status">{refreshMessage}</p>}
    {query.error && <p role="alert">Could not load usage. Try refreshing.</p>}
    {query.loading && !query.data && <p className="muted">Loading usage…</p>}
    {query.data && <UsageDetails accounts={query.data} now={now} />}
    </div>
  </>;
}

export function UsageDetails({ accounts, now }: { accounts: Account[]; now: number }) {
  if (!accounts.length) return <p className="muted">No accounts configured.</p>;
  return <div className="pc-usage-details">{accounts.map(account => {
    // The account's one usage record; the deprecated raw reading is not read (ADR 0030).
    const state = account.usageState;
    const view = usageView(state, now);
    // Source and read failure render only when known; an unknown source is not a label (UI-10).
    const meta = [view.source === "Source unknown" ? null : view.source, state?.error ? "Reading failed" : null].filter(Boolean).join(" · ");
    return <section className="pc-usage-account" key={account.name} aria-label={`${account.name} usage`}>
      <div className="pc-usage-account__head"><AgentMark agent={markAgent(account.kind === "claude" ? "claude-code" : account.kind, account.name)} size={20} labelled={false} /><strong>{account.name}</strong><span className="muted">{[view.figure, view.freshness].filter(Boolean).join(" · ")}</span></div>
      {state?.windows.length ? state.windows.map(window => {
        const row = usageWindowView(window, now, !!state.limit);
        return <div className="pc-usage-window" key={window.name}>
          <span>{row.label}</span>
          {/* Each window keeps its own staleness and verdict tone; the record's freshness is the head's words (fixture f). */}
          <UsageMeter used={row.meter} pace={null} tone={row.tone} size="top" text="none" label={`${account.name} ${row.label} usage`} stale={row.stale} staleAt={state.observedAt ?? undefined} now={now} />
          {/* A limit row's figure is its verdict: say it once, in the words column, so it never crowds the number column. */}
          <span className="pc-num">{row.figure === "Out of quota" ? "" : row.figure}</span>
          <span className="muted">{[row.figure === "Out of quota" || row.tone === "warn" || row.tone === "bad" ? row.verdictLabel : null, row.reset].filter(Boolean).join(" · ")}</span>
        </div>;
      }) : <p className="muted">{view.figure} · no quota windows reported.</p>}
      {meta && <p className="pc-usage-account__meta muted">{meta}</p>}
    </section>;
  })}</div>;
}

export function hiddenControlLabel(count: number) {
  return `In control of ${count} hidden ${count === 1 ? 'session' : 'sessions'} · Hand back`;
}

export async function handBackHidden(runtimes: readonly { release(): unknown }[], confirm: (message: string) => Promise<boolean>) {
  if (await confirm(`Hand back control of ${runtimes.length} hidden ${runtimes.length === 1 ? 'session' : 'sessions'}? This includes any hidden terminal shells.`)) {
    runtimes.forEach(runtime => runtime.release());
  }
}

import { useEffect, useRef, useState } from "preact/hooks";
import { ago, clock } from "../../../src/view-model/time";
import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { capacity, counts as snapshotCounts, plannerMeter } from "../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { executorLabel, paceStatus } from "../../../src/view-model/words";
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

const usageSources: Record<string, string> = { "status-line": "Status line", "session-log": "Session logs", "provider-cli": "Provider reading", metered: "Measured spend", reactive: "Observed limits", unmetered: "No quota limit" };

export function dismissUsageOnEscape(event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">, close: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

/** `terminal` adds the dock toggle; it is omitted wherever the dock cannot open. */
export function StatusBar({ route, snapshot, registry, terminal }: { route?: Route; snapshot: ClientSnapshot | null; registry: KeyRegistry; terminal?: { open: boolean; toggle: () => void } }) {
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
  const visiblePlanner = planner?.usedPct !== null ? planner : null;
  // The Dispatch home's Planner budget states the figure; here the planner keeps only its mark (UI-15).
  const plannerFigure = route?.name !== "dispatch";
  const markedPlanner = plannerFigure ? visiblePlanner : planner;
  const executors = snapshot ? capacity(snapshot).filter(executor => executor.usedPct !== null && !(markedPlanner && executor.id === markedPlanner.runner)) : [];
  const usageNames = [
    ...(markedPlanner ? [`${agentInfo(markedPlanner.agent).name} planner${plannerFigure ? ` ${Math.round(markedPlanner.usedPct!)}%${markedPlanner.verdict === "ahead" ? ", ahead of pace" : ""}${markedPlanner.stale ? " historical usage" : ""}` : ", shown in Planner budget"}`] : []),
    ...executors.map(executor => `${executorLabel(executor.id)} ${Math.round(executor.usedPct!)}%${executor.stale ? " historical usage" : ""}`),
  ];
  const counts = snapshot ? snapshotCounts(snapshot) : null;
  const hints = usageOpen ? [{ keys: "Escape", label: "close usage" }] : [];
  const budget = (key: string, agent: string, name: string, used: number, stale: boolean | undefined, ahead: boolean) => {
    const warning = stale ? "Stale reading" : ahead ? "Ahead of pace" : null;
    return <span className="pc-statusbar__item" key={key} title={`${name} · ${Math.round(used)}%${ahead ? " · ahead of pace" : ""}${stale ? " · stale reading" : ""}`}>
      <AgentMark agent={agent} size={16} labelled={false} /><span className="pc-num pc-statusbar__pct">{Math.round(used)}%</span>
      <UsageMeter used={used} pace={null} tone={ahead ? "warn" : "good"} size="mini" text="none" label={`${name} usage`} stale={stale} />
      {warning && <span className="pc-statusbar__stale" role="img" aria-label={warning}>!</span>}
    </span>;
  };
  return <footer className="pc-statusbar" aria-label="Status bar">
    <Button ref={usageButton} size="sm" className="pc-statusbar__usage-button" aria-label={`Usage details${usageNames.length ? `: ${usageNames.join(", ")}` : ": unavailable"}`} aria-expanded={usageOpen} aria-controls="pc-usage-details" onClick={() => setUsageOpen(open => !open)}>
      {markedPlanner && !plannerFigure && <span className="pc-statusbar__item" key="planner" title={`${agentInfo(markedPlanner.agent).name} planner, shown in Planner budget`}><AgentMark agent={markedPlanner.agent} size={16} labelled={false} /></span>}
      {visiblePlanner && plannerFigure && budget("planner", visiblePlanner.agent, agentInfo(visiblePlanner.agent).name, visiblePlanner.usedPct!, visiblePlanner.stale, paceStatus(visiblePlanner.verdict).label === paceStatus("ahead").label)}
      {executors.map(executor => budget(executor.id, markAgent(executor.id, executor.account), executorLabel(executor.id), executor.usedPct!, executor.stale, false))}
      {!usageNames.length && <span>Usage</span>}
    </Button>
    <span className="grow" />
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
    const reading = account.usageReading;
    return <section className="pc-usage-account" key={account.name} aria-label={`${account.name} usage`}>
      <div className="pc-usage-account__head"><AgentMark agent={markAgent(account.kind === "claude" ? "claude-code" : account.kind, account.name)} size={20} labelled={false} /><strong>{account.name}</strong><span className="muted">{reading?.stale ? "Historical usage" : reading?.capturedAt != null ? `Updated ${ago(reading.capturedAt, now)}` : reading?.windows.length ? "Reading time unknown" : "Usage unavailable"}</span></div>
      {reading?.windows.length ? reading.windows.map(window => <div className="pc-usage-window" key={window.name}>
        <span>{window.name}</span>
        <UsageMeter used={window.usedPct} pace={null} tone="neutral" size="top" text="none" label={`${account.name} ${window.name} usage`} stale={reading.stale} staleAt={reading.capturedAt ?? undefined} now={now} />
        <span className="pc-num">{window.usedPct === null ? "Usage unknown" : `${Math.round(window.usedPct)}%`}</span>
        <span className="muted">{window.resetsAt === null ? "Reset unknown" : `resets ${clock(window.resetsAt, now)}`}</span>
      </div>) : <p className="muted">Usage unknown · no quota windows reported.</p>}
      {(reading?.source || reading?.stale || reading?.error) && <p className="pc-usage-account__meta muted">{[reading.source ? usageSources[reading.source] ?? "Source unknown" : null, reading.capturedAt != null && reading.stale ? `read ${ago(reading.capturedAt, now)}` : null, reading.error ? "Reading failed" : null].filter(Boolean).join(" · ")}</p>}
    </section>;
  })}</div>;
}

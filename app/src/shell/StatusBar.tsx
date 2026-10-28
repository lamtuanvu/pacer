import { useEffect, useRef, useState } from "preact/hooks";
import { ago, clock } from "../../../src/view-model/time";
import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { capacity, plannerMeter } from "../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { executorLabel } from "../../../src/view-model/words";
import { AgentMark } from "../ds/AgentMark";
import { Kbd } from "../ds/Kbd";
import { UsageMeter } from "../ds/UsageMeter";
import { Button } from "../ds/Button";
import { PopoverDialog } from "../ds/Dialog";
import type { Account } from "../model/accounts";
import { useQuery, useTaskContext } from "../screens/task-shared";
import type { KeyRegistry, Shortcut } from "../keys/registry";
import type { Route } from "../router";

export interface StatusHint { keys: string; label: string }

const shortLabels: Record<string, string> = {
  "Delegate a task": "delegate",
  "Show keyboard shortcuts": "shortcuts",
  "Focus the repo filter": "focus filter",
  "Close the settings panel": "close settings",
  "Stop session": "stop session",
};
const usageSources: Record<string, string> = { "status-line": "Status line", "session-log": "Session logs", "provider-cli": "Provider reading", metered: "Measured spend", reactive: "Observed limits", unmetered: "No quota limit" };

export function dismissUsageOnEscape(event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">, close: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

function compactKeys(keys: string[]): string {
  return keys.length > 1 && keys.every((key, index) => key === String(index + Number(keys[0])))
    ? `${keys[0]}–${keys.at(-1)}`
    : keys.join(" ");
}

/** The compact hint bar only advertises keys actually registered for this screen. */
export function screenHints(shortcuts: Shortcut[], route: Route): StatusHint[] {
  const local = shortcuts.filter(shortcut => shortcut.scope === route.name);
  const global = shortcuts.filter(shortcut => shortcut.scope === "global" && ["d", "?"].includes(shortcut.keys));
  const selected = local.length ? [...local, ...global] : global;
  const byLabel = new Map<string, string[]>();
  for (const shortcut of selected) {
    const keys = byLabel.get(shortcut.label) ?? [];
    if (!keys.includes(shortcut.keys)) keys.push(shortcut.keys);
    byLabel.set(shortcut.label, keys);
  }
  const hints = [...byLabel].map(([label, keys]) => ({
    label: shortLabels[label] ?? label,
    keys: compactKeys(keys),
  }));
  // Keep the status bar short; the help dialog has the complete key list.
  return hints.length > 6 ? [...hints.slice(0, 5), { keys: "?", label: "shortcuts" }] : hints;
}

/** `terminal` adds the dock toggle; it is omitted wherever the dock cannot open. */
export function StatusBar({ route, snapshot, registry, terminal }: { route: Route; snapshot: ClientSnapshot | null; registry: KeyRegistry; terminal?: { open: boolean; toggle: () => void } }) {
  const [shortcuts, setShortcuts] = useState(() => registry.list());
  const [usageOpen, setUsageOpen] = useState(false);
  const usageButton = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const update = () => setShortcuts(registry.list()); const unsubscribe = registry.subscribe(update); update(); return unsubscribe; }, [registry]);
  useEffect(() => {
    if (!usageOpen) return;
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(timer);
  }, [usageOpen]);
  const planner = snapshot ? plannerMeter(snapshot) : null;
  const visiblePlanner = planner?.usedPct !== null ? planner : null;
  const executors = snapshot ? capacity(snapshot).filter(executor => executor.usedPct !== null && !(visiblePlanner && executor.id === visiblePlanner.runner)) : [];
  const usageNames = [
    ...(visiblePlanner ? [`${agentInfo(visiblePlanner.agent).name} planner ${Math.round(visiblePlanner.usedPct!)}%${visiblePlanner.stale ? " historical usage" : ""}`] : []),
    ...executors.map(executor => `${executorLabel(executor.id)} ${Math.round(executor.usedPct!)}%${executor.stale ? " historical usage" : ""}`),
  ];
  const hints = usageOpen ? [{ keys: "Escape", label: "close usage" }] : screenHints(shortcuts, route);
  return <footer className="pc-statusbar" aria-label="Status bar">
    <Button ref={usageButton} size="sm" className="pc-statusbar__usage-button" aria-label={`Usage details${usageNames.length ? `: ${usageNames.join(", ")}` : ": unavailable"}`} aria-expanded={usageOpen} aria-controls="pc-usage-details" onClick={() => setUsageOpen(open => !open)}>
      {visiblePlanner && <span className="pc-statusbar__item" aria-hidden="true"><AgentMark agent={visiblePlanner.agent} size={16} labelled={false} /><span className="pc-num">{Math.round(visiblePlanner.usedPct!)}%</span>{visiblePlanner.stale && <span className="pc-statusbar__stale" title="Stale usage reading">!</span>}</span>}
      {executors.map(executor => <span className="pc-statusbar__item" aria-hidden="true" key={executor.id}><AgentMark agent={markAgent(executor.id, executor.account)} size={16} labelled={false} /><span className="pc-num">{Math.round(executor.usedPct!)}%</span>{executor.stale && <span className="pc-statusbar__stale" title="Stale usage reading">!</span>}</span>)}
      {!usageNames.length && <span>Usage</span>}
    </Button>
    <div className="pc-statusbar__hints" aria-label="Shortcuts">{hints.map(hint => <span className="pc-statusbar__hint" key={`${hint.keys}:${hint.label}`}><Kbd>{hint.keys === "Enter" ? "⏎" : hint.keys === "Escape" ? "Esc" : hint.keys}</Kbd> {hint.label}</span>)}</div>
    {terminal && <Button size="sm" variant="quiet" className="pc-statusbar__terminal" aria-label="Terminal" aria-keyshortcuts="Control+`" aria-expanded={terminal.open} aria-controls={terminal.open ? "pc-terminal-dock" : undefined} onClick={terminal.toggle}>Terminal <Kbd>Ctrl `</Kbd></Button>}
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
    <div className="pc-usage-popover__head"><strong>Usage</strong><span className="grow" /><Button size="sm" onClick={refresh} busy={refreshing}>Refresh usage</Button><Button size="sm" onClick={close}>Close</Button></div>
    {refreshError && <p role="alert">Could not refresh usage. Try again.</p>}
    {refreshMessage && <p role="status">{refreshMessage}</p>}
    {query.error && <p role="alert">Could not load usage. Try refreshing.</p>}
    {query.loading && !query.data && <p className="muted">Loading usage…</p>}
    {query.data && <UsageDetails accounts={query.data} now={now} />}
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

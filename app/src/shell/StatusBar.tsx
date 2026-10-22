import { useEffect, useState } from "preact/hooks";
import { executorPace } from "../../../src/view-model/capacity";
import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { capacity, plannerMeter } from "../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { executorLabel, paceStatus } from "../../../src/view-model/words";
import { AgentMark } from "../ds/AgentMark";
import { Kbd } from "../ds/Kbd";
import { UsageMeter } from "../ds/UsageMeter";
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

export function StatusBar({ route, snapshot, registry }: { route: Route; snapshot: ClientSnapshot | null; registry: KeyRegistry }) {
  const [shortcuts, setShortcuts] = useState(() => registry.list());
  useEffect(() => { const update = () => setShortcuts(registry.list()); const unsubscribe = registry.subscribe(update); update(); return unsubscribe; }, [registry]);
  const planner = snapshot ? plannerMeter(snapshot) : null;
  const visiblePlanner = planner?.usedPct !== null ? planner : null;
  const executors = snapshot ? capacity(snapshot).filter(executor => executor.usedPct !== null && !(visiblePlanner && executor.id === visiblePlanner.runner)) : [];
  const hints = screenHints(shortcuts, route);
  return <footer className="pc-statusbar" aria-label="Status bar">
    <div className="pc-statusbar__usage" aria-label="Usage">
      {visiblePlanner && <span className="pc-statusbar__item" title={`${agentInfo(visiblePlanner.agent).name} planner usage${visiblePlanner.stale ? " · historical" : ""}`}>
        <AgentMark agent={visiblePlanner.agent} size={16} labelled={false} /><span>Planner</span>
        <UsageMeter used={visiblePlanner.usedPct} pace={visiblePlanner.pacePct} tone={paceStatus(visiblePlanner.verdict).tone} verdict={visiblePlanner.verdict} size="top" label={`${agentInfo(visiblePlanner.agent).name} planner usage`} stale={visiblePlanner.stale} text="compact" />
      </span>}
      {executors.map(executor => <span className="pc-statusbar__item" key={executor.id} title={`${executorLabel(executor.id)} usage${executor.stale ? " · historical" : ""}`}>
        <AgentMark agent={markAgent(executor.id, executor.account)} size={16} labelled={false} /><span>{executorLabel(executor.id)}</span>
        <UsageMeter used={executor.usedPct} pace={executor.pacePct} tone={executorPace(executor, snapshot!).tone} size="top" label={`${executorLabel(executor.id)} usage`} stale={executor.stale} text="compact" />
      </span>)}
      {!visiblePlanner && !executors.length && <span className="muted">Usage unavailable</span>}
    </div>
    <div className="pc-statusbar__hints" aria-label="Shortcuts">{hints.map(hint => <span className="pc-statusbar__hint" key={`${hint.keys}:${hint.label}`}><Kbd>{hint.keys === "Enter" ? "⏎" : hint.keys}</Kbd> {hint.label}</span>)}</div>
    <span className="pc-statusbar__version">pacer {snapshot?.service?.version ?? ""}</span>
  </footer>;
}

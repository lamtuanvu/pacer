import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PlannerMeter } from "../../../src/api/read-model/types";
import { agentInfo } from "../../../src/view-model/agents";
import { clock } from "../../../src/view-model/time";
import { modeWords, paceStatus } from "../../../src/view-model/words";
import { AgentMark } from "../ds/AgentMark";
import { DensityContext } from "../ds/Density";
import { TitleBar } from "./TitleBar";
import { Button, IconButton } from "../ds/Button";
import { Pill } from "../ds/Pill";
import { isMacPlatform } from "../keys/commands";
import { UsageMeter } from "../ds/UsageMeter";

/** A frame region the top bar can show or hide; `open` is its current state. */
export interface PanelToggle { open: boolean; toggle: () => void }
export interface TopBarProps {
  /** The pacer mark (a link home), shown before the title on desktop. */
  brand?: ComponentChildren;
  /** Centre slot, such as the command search. Empty by default. */
  search?: ComponentChildren;
  /** The search as a single button where the centre slot does not fit (narrow screens). */
  narrowSearch?: ComponentChildren;
  /** Only regions that exist on this route get a button. */
  panels?: { left?: PanelToggle; dock?: PanelToggle; right?: PanelToggle };
  narrow?: boolean; title: string; planner: PlannerMeter | null; mode: string; connected: boolean; lastUpdate: number | null;
  showActions?: boolean; pageHeading?: boolean; now?: number; onDelegate: () => void;
}
const modeTone = (mode: string) => ({ normal: "neutral", relaxed: "good" } as const)[mode.toLowerCase() as "normal"] ?? "warn";
function LayoutToggle({ icon, label, keys, toggle }: { icon: "panel-left" | "panel-bottom" | "panel-right"; label: string; keys: string; toggle: PanelToggle }) {
  return <IconButton icon={icon} size="sm" variant="quiet" aria-label={label} title={label} aria-keyshortcuts={keys} aria-pressed={toggle.open} onClick={toggle.toggle} />;
}
/** One compact page header, including native controls in the desktop shell. */
export function TopBar({ brand, search, narrowSearch, panels = {}, narrow = false, title, planner, mode, connected, lastUpdate, now: fixedNow, onDelegate, showActions = true, pageHeading = false }: TopBarProps) {
  const [tick, setTick] = useState(() => Date.now() / 1000);
  useEffect(() => { if (fixedNow !== undefined) return; const t = setInterval(() => setTick(Date.now() / 1000), 1000); return () => clearInterval(t); }, [fixedNow]);
  const now = fixedNow ?? tick;
  const narrowMeter = narrow && planner && planner.verdict !== "unknown" && planner.usedPct !== null;
  return <header className="pc-topbar" data-tauri-drag-region>
    {!narrow && <TitleBar />}
    {!narrow && brand && <span className="pc-topbar__brand">{brand}</span>}
    {showActions && !pageHeading && <h1 data-tauri-drag-region title={title}>{title}</h1>}
    <span className="grow" data-tauri-drag-region />
    {!narrow && showActions && <div className="pc-topbar__search">{search}</div>}
    {!narrow && showActions && <span className="grow" data-tauri-drag-region />}
    {narrow && showActions && narrowSearch}
    {showActions && <>
    {planner && <span className="pc-planner">
      <AgentMark agent={planner.agent} size={narrow ? 18 : 20} labelled={false} />
      <span className="pc-planner__name">{agentInfo(planner.agent).name}</span>
      {mode && <Pill tone={modeTone(mode)}>{modeWords(mode)}{planner.modeHeldUntil ? ` · held until ${clock(planner.modeHeldUntil, now)}` : ""}</Pill>}
      {narrowMeter && <UsageMeter used={planner.usedPct} pace={planner.pacePct} tone={paceStatus(planner.verdict).tone} verdict={planner.verdict} size="top" text="compact" label={`${agentInfo(planner.agent).name} planner usage`} stale={planner.stale} staleAt={lastUpdate ?? undefined} now={now} />}
    </span>}
    {!narrow && <div role="group" aria-label="Layout" className="pc-layout-toggles">
      {panels.left && <LayoutToggle icon="panel-left" label="Toggle left panel" keys={isMacPlatform() ? "Meta+B" : "Control+B"} toggle={panels.left} />}
      {panels.dock && <LayoutToggle icon="panel-bottom" label="Toggle terminal panel (Ctrl+`)" keys="Control+`" toggle={panels.dock} />}
      {panels.right && <LayoutToggle icon="panel-right" label="Toggle right panel" keys="Alt+Meta+B" toggle={panels.right} />}
    </div>}
    {!connected && <span className="pc-live" role="status"><span className="pc-live-dot pc-live-dot--off" aria-hidden="true" />Reconnecting…</span>}
    <DensityContext.Provider value="compact"><Button variant="secondary" size="sm" onClick={onDelegate}>Delegate</Button></DensityContext.Provider>
    </>}
  </header>;
}

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PlannerMeter } from "../../../src/api/read-model/types";
import { agentInfo } from "../../../src/view-model/agents";
import { clock } from "../../../src/view-model/time";
import { modeWords, paceStatus } from "../../../src/view-model/words";
import { AgentMark } from "../ds/AgentMark";
import { DensityContext } from "../ds/Density";
import { TitleBar } from "./TitleBar";
import type { FrameHeading } from "./slots";
import { ButtonLink, IconButton } from "../ds/Button";
import { Pill } from "../ds/Pill";
import { isMacPlatform } from "../keys/commands";
import { UsageMeter } from "../ds/UsageMeter";

/** A frame region the top bar can show or hide; `open` is its current state. */
export interface PanelToggle {
  open: boolean; toggle: () => void;
  /** What the region is called in the button name ("Toggle <label>"), when "right panel" is too generic. */
  label?: string;
  /** aria-keyshortcuts, when the region has a shortcut of its own. */
  keys?: string;
}
export interface TopBarProps {
  /** The pacer mark (a link home), shown before the title on desktop. */
  brand?: ComponentChildren;
  /** Centre slot, such as the command search. Empty by default. */
  search?: ComponentChildren;
  /** The search as a single button where the centre slot does not fit (narrow screens). */
  narrowSearch?: ComponentChildren;
  /** Absent regions retain a disabled button with a reason tooltip. */
  panels?: { left?: PanelToggle; dock?: PanelToggle; right?: PanelToggle };
  narrow?: boolean; title: string; planner: PlannerMeter | null; mode: string; connected: boolean; lastUpdate: number | null;
  showActions?: boolean; now?: number; onDelegate: () => void;
  /** False where the page has its own New task button, so the action is offered once. */
  delegate?: boolean;
  /** False where the page carries its own h1 (Dispatch), so the title appears once (UI-9). */
  pageTitle?: boolean;
  /** False where the page itself states the planner figure (Dispatch), so the narrow meter is not repeated (UI-15). */
  plannerFigure?: boolean;
  /** A screen's own title and agent, shown instead of `title`. */
  heading?: FrameHeading | null;
  /** Receives the active panel action slot right of search. */
  actions?: (element: HTMLElement | null) => void;
  /** Receives the title-bar area a screen fills with its facts and actions. */
  context?: (element: HTMLElement | null) => void;
}
const modeTone = (mode: string) => ({ normal: "neutral", relaxed: "good" } as const)[mode.toLowerCase() as "normal"] ?? "warn";
function LayoutToggle({ icon, label, keys, toggle }: { icon: "topbar-left" | "topbar-bottom" | "topbar-right"; label: string; keys: string; toggle?: PanelToggle }) {
  return <IconButton icon={icon} size="sm" variant="quiet" aria-label={label} title={toggle ? label : `This screen has no ${label.replace("Toggle ", "").replace(/ \(.*$/, "")}`} disabled={!toggle} aria-keyshortcuts={keys} aria-pressed={toggle?.open} onClick={toggle?.toggle} />;
}
/** One compact page header, including native controls in the desktop shell. */
export function TopBar({ brand, search, narrowSearch, panels = {}, narrow = false, title, planner, mode, connected, lastUpdate, now: fixedNow, onDelegate, showActions = true, delegate = true, pageTitle = true, plannerFigure = true, heading, context, actions }: TopBarProps) {
  const [tick, setTick] = useState(() => Date.now() / 1000);
  useEffect(() => { if (fixedNow !== undefined) return; const t = setInterval(() => setTick(Date.now() / 1000), 1000); return () => clearInterval(t); }, [fixedNow]);
  const now = fixedNow ?? tick;
  const narrowMeter = narrow && plannerFigure && planner && planner.verdict !== "unknown" && planner.usedPct !== null;
  return <header className="pc-topbar" aria-label={showActions ? heading?.title ?? title : undefined} data-tauri-drag-region>
    {!narrow && <TitleBar />}
    {!narrow && brand && <span className="pc-topbar__brand">{brand}</span>}
    {narrow && showActions && heading?.agent && <AgentMark agent={heading.agent} size={18} />}
    {showActions && pageTitle && !heading && <h1 data-tauri-drag-region title={title}>{title}</h1>}
    {showActions && context && <fieldset ref={context} className="pc-topbar__context" disabled={!connected} title={!connected ? "pacer is offline" : undefined} />}
    <span className="grow" data-tauri-drag-region />
    {!narrow && showActions && <div className="pc-topbar__search">{search}</div>}
    {!narrow && showActions && <span className="grow" data-tauri-drag-region />}
    {narrow && showActions && narrowSearch}
    {showActions && <>
    {actions && <fieldset ref={actions} className="pc-frame-actions" disabled={!connected} title={!connected ? "pacer is offline" : undefined} />}
    {planner && !(narrow && title === "Dispatch") && <a href="#/settings/planner" className="pc-planner pc-inline-link">
      <AgentMark agent={planner.agent} size={18} labelled={false} />
      <span className="pc-planner__name">{agentInfo(planner.agent).name}</span>
      {mode && <Pill tone={modeTone(mode)}>{modeWords(mode)}{planner.modeHeldUntil ? ` · held until ${clock(planner.modeHeldUntil, now)}` : ""}</Pill>}
      {narrowMeter && <UsageMeter used={planner.usedPct} pace={planner.pacePct} tone={paceStatus(planner.verdict).tone} verdict={planner.verdict} size="top" text="compact" label={`${agentInfo(planner.agent).name} planner usage`} stale={planner.stale} staleAt={lastUpdate ?? undefined} now={now} />}
    </a>}
    {(!narrow || heading) && <div role="group" aria-label="Layout" className="pc-layout-toggles">
      {!narrow && <LayoutToggle icon="topbar-left" label="Toggle left panel" keys={isMacPlatform() ? "Meta+B" : "Control+B"} toggle={panels.left} />}
      {!narrow && <LayoutToggle icon="topbar-bottom" label="Toggle terminal panel (Ctrl+`)" keys="Control+`" toggle={panels.dock} />}
      {!narrow && <LayoutToggle icon="topbar-right" label="Toggle right panel" keys={panels.right?.keys ?? "Alt+Meta+B"} toggle={panels.right} />}
    </div>}
    {!connected && <span className="pc-live" role="status"><span className="pc-live-dot pc-live-dot--off" aria-hidden="true" />Reconnecting…</span>}
    {narrow && title === "Dispatch" ? <IconButton icon="plus" aria-label="New task" onClick={onDelegate} /> : (!narrow || delegate) && <DensityContext.Provider value="compact"><ButtonLink href="#/tasks/new" className="pc-topbar__new" variant="secondary" size="sm" onClick={event => { event.preventDefault(); onDelegate(); }}>New task</ButtonLink></DensityContext.Provider>}
    </>}
  </header>;
}

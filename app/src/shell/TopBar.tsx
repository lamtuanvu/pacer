import { useEffect, useState } from "preact/hooks";
import type { PlannerMeter } from "../../../src/api/read-model/types";
import { agentInfo } from "../../../src/view-model/agents";
import { ago, clock } from "../../../src/view-model/time";
import { modeWords, paceStatus } from "../../../src/view-model/words";
import { AgentMark } from "../ds/AgentMark";
import { DensityContext } from "../ds/Density";
import { TitleBar } from "./TitleBar";
import { Button } from "../ds/Button";
import { Pill } from "../ds/Pill";
import { UsageMeter } from "../ds/UsageMeter";

export interface TopBarProps {
  narrow?: boolean; title: string; planner: PlannerMeter | null; mode: string; connected: boolean; lastUpdate: number | null;
  showActions?: boolean; now?: number; onDelegate: () => void; delegatePrimary?: boolean;
  /** False where the page has its own New task button, so the action is offered once. */
  delegate?: boolean;
  /** False where the page carries its own h1 (Dispatch), so the title appears once (UI-9). */
  pageTitle?: boolean;
  /** False where the page itself states the planner figure (Dispatch), so the narrow meter is not repeated (UI-15). */
  plannerFigure?: boolean;
}
/** One compact page header, including native controls in the desktop shell. */
export function TopBar({ narrow = false, title, planner, mode, connected, lastUpdate, now: fixedNow, onDelegate, delegatePrimary = true, delegate = true, pageTitle = true, showActions = true, plannerFigure = true }: TopBarProps) {
  const [tick, setTick] = useState(() => Date.now() / 1000);
  useEffect(() => { if (fixedNow !== undefined) return; const t = setInterval(() => setTick(Date.now() / 1000), 1000); return () => clearInterval(t); }, [fixedNow]);
  const now = fixedNow ?? tick;
  const narrowMeter = narrow && plannerFigure && planner && planner.verdict !== "unknown" && planner.usedPct !== null;
  return <header className="pc-topbar" data-tauri-drag-region>
    {!narrow && <TitleBar />}
    {showActions && pageTitle && <h1 data-tauri-drag-region title={title}>{title}</h1>}
    <span className="grow" data-tauri-drag-region />
    {showActions && <>
    {planner && <span className="pc-planner">
      <AgentMark agent={planner.agent} size={18} labelled={false} />
      <span className="pc-planner__name">{agentInfo(planner.agent).name}</span>
      {narrowMeter && <UsageMeter used={planner.usedPct} pace={planner.pacePct} tone={paceStatus(planner.verdict).tone} verdict={planner.verdict} size="top" text="compact" label={`${agentInfo(planner.agent).name} planner usage`} stale={planner.stale} staleAt={lastUpdate ?? undefined} now={now} />}
    </span>}
    {mode && <Pill tone={mode.toLowerCase() === "normal" ? "neutral" : "warn"}>{modeWords(mode)}{planner?.modeHeldUntil ? ` · held until ${clock(planner.modeHeldUntil, now)}` : ""}</Pill>}
    <span className="pc-live"><span className={`pc-live-dot${connected ? "" : " pc-live-dot--off"}`} aria-hidden="true" />{connected ? (lastUpdate ? `updated ${ago(lastUpdate, now)}` : "live") : "Reconnecting…"}</span>
    <span className="pc-clock muted">{clock(now, now)}</span>
    {delegate && <DensityContext.Provider value="compact"><Button variant={delegatePrimary ? "primary" : "secondary"} size="sm" onClick={onDelegate}>Delegate</Button></DensityContext.Provider>}
    </>}
  </header>;
}

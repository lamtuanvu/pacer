import { useEffect, useState } from "preact/hooks";
import type { PlannerMeter } from "../../../src/api/read-model/types";
import { agentInfo } from "../../../src/view-model/agents";
import { ago, clock } from "../../../src/view-model/format";
import { modeWords, toneFor } from "../../../src/view-model/words";
import { AgentMark } from "../ds/AgentMark";
import { Button } from "../ds/Button";
import { Pill } from "../ds/Pill";
import { UsageMeter } from "../ds/UsageMeter";

export interface TopBarProps {
  narrow?: boolean; title: string; planner: PlannerMeter | null; mode: string; connected: boolean; lastUpdate: number | null;
  now?: number; onDelegate: () => void; delegatePrimary?: boolean;
}
/** 44 px bar: title, planner meter, mode, live state, the time and Delegate. */
export function TopBar({ narrow = false, title, planner, mode, connected, lastUpdate, now: fixedNow, onDelegate, delegatePrimary = true }: TopBarProps) {
  const [tick, setTick] = useState(() => Date.now() / 1000);
  useEffect(() => { if (fixedNow !== undefined) return; const t = setInterval(() => setTick(Date.now() / 1000), 1000); return () => clearInterval(t); }, [fixedNow]);
  const now = fixedNow ?? tick;
  const known = planner && planner.verdict !== "unknown" && planner.usedPct !== null;
  return <header className="pc-topbar">
    <h1>{title}</h1>
    <span className="grow" />
    {planner && <span className="pc-planner">
      <AgentMark agent={planner.agent} size={18} labelled={false} />
      <span className="pc-planner__name">{agentInfo(planner.agent).name}</span>
      {known && <UsageMeter used={planner.usedPct} pace={planner.pacePct} tone={toneFor(planner.verdict)} verdict={planner.verdict} size="top" text={narrow ? "compact" : "full"} label={`${agentInfo(planner.agent).name} planner usage`} stale={planner.stale} staleAt={lastUpdate ?? undefined} now={now} />}
    </span>}
    {mode && <Pill tone={mode.toLowerCase() === "normal" ? "neutral" : "warn"}>{modeWords(mode)}{planner?.modeHeldUntil ? ` · held until ${clock(planner.modeHeldUntil, now)}` : ""}</Pill>}
    <span className="pc-live"><span className={`pc-live-dot${connected ? "" : " pc-live-dot--off"}`} aria-hidden="true" />{connected ? (lastUpdate ? `updated ${ago(lastUpdate, now)}` : "live") : "Reconnecting…"}</span>
    <span className="pc-clock muted">{clock(now, now)}</span>
    <Button variant={delegatePrimary ? "primary" : "secondary"} size="sm" onClick={onDelegate}>Delegate</Button>
  </header>;
}

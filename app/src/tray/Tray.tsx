import type { ActivityEntry } from "../../../src/activity/log";
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { BrowserApi } from "../data/api";
import type { Action } from "../../../src/attention/types";
import { agentInfo, runnerAgent } from "../../../src/view-model/agents";
import { backIn, clock, elapsed, meterText } from "../../../src/view-model/format";
import { phaseWords, toneFor } from "../../../src/view-model/words";
import { plannerMeter } from "../../../src/view-model/selectors";
import { AgentMark } from "../ds/AgentMark";
import { UsageMeter } from "../ds/UsageMeter";
import { Pill } from "../ds/Pill";
import { Kbd } from "../ds/Kbd";
import { appHref, type TrayIpc } from "./ipc";
import { actionRoute, executorValue, primaryAction, shortTitle, trayModel } from "./model";

export interface TrayProps { snapshot: ClientSnapshot | null; api: BrowserApi; ipc: TrayIpc; connected?: boolean; sessionEnded?: boolean; activity?: ActivityEntry[] }
export async function performAction(action: Action, api: BrowserApi, ipc: TrayIpc) {
  if (action.op === "ui.open") await ipc.open(actionRoute(action));
  else await api.call(action.op, action.params);
}
/** Native Tab order is also the arrow-key order, including expanded strategies. */
export function moveFocus(root: HTMLElement, key: string): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  const rows = [...root.querySelectorAll<HTMLElement>("a[href],button:not(:disabled)")];
  if (!rows.length) return false;
  const at = rows.indexOf(root.ownerDocument.activeElement as HTMLElement);
  const index = key === "Home" ? 0 : key === "End" ? rows.length - 1 : (at + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
  rows[index]!.focus();
  return true;
}
export function Tray({ snapshot, api, ipc, connected = true, sessionEnded = false, activity = [] }: TrayProps) {
  const root = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    void work().catch(e => setError(e instanceof Error ? e.message : "Action failed")).finally(() => setBusy(false));
  };
  useLayoutEffect(() => {
    const measure = () => { if (root.current) void ipc.resize(root.current.getBoundingClientRect().height).catch(() => {}); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    return () => observer?.disconnect();
  });
  const navigate = (route: string) => (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => { event.preventDefault(); act(() => ipc.open(route)); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); void ipc.hide().catch(e => setError(e instanceof Error ? e.message : "Could not hide tray")); return; }
    if (event.metaKey || event.ctrlKey) {
      const action = ({ d: () => ipc.open("/delegate"), o: () => ipc.open("/"), q: ipc.quit } as Record<string, () => Promise<unknown>>)[event.key.toLowerCase()];
      if (action) { event.preventDefault(); act(action); }
      return;
    }
    if (root.current && moveFocus(root.current, event.key)) event.preventDefault();
  };
  useLayoutEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });
  const planner = snapshot && plannerMeter(snapshot);
  const tone = planner ? ({ behind: "good", on_pace: "good", ahead: "warn", out: "bad", unknown: "neutral" } as const)[planner.verdict] : "neutral";
  const model = snapshot && trayModel(snapshot, activity);
  const mode = snapshot?.pause ? "Paused" : ({ normal: "Normal", relaxed: "Relaxed", strict: "Strict" } as Record<string, string>)[planner?.mode ?? snapshot?.mode?.mode ?? snapshot?.budget?.mode ?? "normal"] ?? "Normal";
  const pauseLabel = snapshot?.pause ? "Resume delegation" : "Pause delegation for 1 hour";
  const next = model?.queued[0];
  const nextExecutor = next?.executor ? agentInfo(runnerAgent(next.executor)).name : "executor";
  const timeOnly = (at: number) => new Date(at * 1000).toLocaleTimeString("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  return <main className="tray" ref={root} aria-label="pacer tray" aria-busy={busy}>
    <header className="tray-planner">
      <div className="tray-line">{planner && <AgentMark agent={planner.agent} size={18} labelled={false} />}<strong>{planner ? agentInfo(planner.agent).name : "pacer"}</strong><span className="tray-planner-label tray-grow">planner</span><Pill tone={tone}>{planner ? ({ behind: "Behind", on_pace: "On pace", ahead: "Ahead", out: "Ahead", unknown: "Usage unknown" })[planner.verdict] : "Usage unknown"}</Pill><span className="tray-mode">{mode}</span></div>
      <UsageMeter used={planner?.usedPct ?? null} pace={planner?.pacePct ?? null} tone={tone} size="bar" label="Planner usage" text="none" stale={planner?.stale} />
      <div className="tray-caption"><span>{meterText(planner?.usedPct ?? null, planner?.pacePct ?? null, "full")}</span><span>{planner?.resetsAt != null ? `resets ${clock(planner.resetsAt, snapshot!.at)}` : backIn(null, snapshot?.at ?? 0)}{snapshot?.pause?.until != null && ` · paused until ${timeOnly(snapshot.pause.until)}`}</span></div>
    </header>
    {sessionEnded ? <p className="tray-notice" role="alert">Session ended. Run pacer open.</p> : !snapshot ? <p className="tray-notice" role="status">Connecting to pacer…</p> : !connected && <p className="tray-notice" role="status">Reconnecting…</p>}
    {model && <>
      <nav className="tray-counts" aria-label="Task counts">{[
        { n: model.needsCount, label: "needs you", route: "/", warn: true },
        { n: model.active.length, label: "running", route: "/sessions" },
        { n: model.waiting, label: "waiting", route: "/sessions?filter=waiting" },
        { n: model.done, label: "done today", route: "/sessions?filter=done" },
      ].map(cell => <a key={cell.label} className="tray-count" href={appHref(cell.route)} onClick={navigate(cell.route)}><b className={!cell.n ? "tray-muted" : cell.warn ? "tray-idle" : undefined}>{cell.n}</b><span>{cell.label}</span></a>)}</nav>
      {model.attention.length ? <section className="tray-section" aria-label="Needs you"><h2 className="tray-attention-heading">Needs you</h2>
        {model.attention.slice(0, 3).map(item => {
          const action = primaryAction(item.actions);
          const task = snapshot?.tasks.find(t => t.id === item.taskId);
          const glyph = item.kind === "failed" ? "✕" : item.kind === "question" ? "?" : item.kind === "review" ? "◐" : "!";
          return <div className={`tray-attention tray-attention--${item.kind}`} key={item.id}>
            <span className="tray-glyph" aria-hidden="true">{glyph}</span>
            <span className="tray-grow"><strong className="tray-ellipsis">{shortTitle({ title: item.title, goal: task?.goal })}</strong><span className="tray-reason tray-ellipsis">{[item.repo?.label ?? task?.repo?.label, item.detail].filter(Boolean).join(" · ")}</span></span>
            {action && <button className={`tray-action${action.style === "primary" ? " tray-action--primary" : ""}`} type="button" disabled={busy || sessionEnded} onClick={() => act(() => performAction(action, api, ipc))}>{action.label}</button>}
          </div>;
        })}
        {model.needsCount > 3 && <a className="tray-more" href={appHref("/")} onClick={navigate("/")}>+{model.needsCount - 3} more in the app</a>}
      </section> : <section className="tray-clear" aria-label="Needs you"><span className="tray-check" aria-hidden="true">✓</span><span><strong>Nothing needs you</strong>{model.lastReview !== null && <span className="tray-reason">Last review cleared {timeOnly(model.lastReview)}</span>}</span></section>}
      {model.active.length > 0 && <section className="tray-section" aria-label="Running"><h2>Running</h2>
        {model.active.slice(0, 3).map(task => <a key={task.id} className="tray-running" href={appHref(`/tasks/${encodeURIComponent(task.id)}`)} onClick={navigate(`/tasks/${encodeURIComponent(task.id)}`)}>
          <AgentMark agent={runnerAgent(task.executor ?? "unknown")} size={16} labelled={false} /><span className="tray-grow tray-ellipsis">{shortTitle(task)}</span>
          <span className="tray-repo tray-ellipsis">{task.repo?.label}</span><span className={`tray-phase ${task.progress?.phase === "idle" ? "tray-idle" : "tray-secondary"}`}>{phaseWords(task.progress?.phase ?? "starting").toLowerCase()} {elapsed(snapshot!.at - (task.attemptStartedAt ?? task.updatedAt))}</span>
        </a>)}
        {model.active.length > 3 && <a className="tray-more" href={appHref("/sessions")} onClick={navigate("/sessions")}>+{model.active.length - 3} more in the app</a>}
      </section>}
      {model.waiting > 0 && <a className="tray-waiting" href={appHref("/sessions?filter=waiting")} onClick={navigate("/sessions?filter=waiting")}><span aria-hidden="true">⏳</span><span className="tray-grow tray-ellipsis">{snapshot?.pause ? `${model.waiting} waiting · delegation paused${snapshot.pause.until !== null ? ` for ${Math.max(0, Math.ceil((snapshot.pause.until - snapshot.at) / 60))} min` : ""}` : `${model.waiting} waiting for a ${nextExecutor} slot · next: ${shortTitle(next!)}`}</span><span aria-hidden="true">›</span></a>}
      <section className="tray-executors" aria-label="Executors">{model.executors.map(executor => {
        const value = executorValue(executor);
        const label = `${agentInfo(executor.agent).name}: ${executor.state} · ${executor.sub}${executor.reason ? ` · ${executor.reason}` : ""} · ${executor.slots.used}/${executor.slots.max} slots${executor.usedPct !== null ? ` · ${meterText(executor.usedPct, executor.pacePct, "full")}` : ""}`;
        return <a className={`tray-executor${value === "off" ? " tray-executor--off" : ""}${value === "out" ? " tray-executor--out" : ""}`} key={executor.id} href={appHref("/executors")} onClick={navigate("/executors")} aria-label={label} title={label}><span className="tray-executor-mark"><AgentMark agent={executor.agent} size={16} labelled={false} /><span className={`tray-dot tray-dot--${value === "off" ? "neutral" : toneFor(executor.tone)}`} /></span><span>{value}</span></a>;
      })}</section>
    </>}
    {error && <p role="alert" className="tray-error">{error}</p>}
    <nav className="tray-footer" aria-label="pacer actions">
      <a className="tray-action tray-action--primary" href={appHref("/delegate")} onClick={navigate("/delegate")}>Delegate <Kbd>⌘D</Kbd></a>
      <a className="tray-action" href={appHref("/")} onClick={navigate("/")}>Open pacer <Kbd>⌘O</Kbd></a>
      <span className="tray-grow" />
      <button className="tray-icon" type="button" title={pauseLabel} aria-label={pauseLabel} disabled={!snapshot || busy || sessionEnded} onClick={() => act(() => api.call(snapshot?.pause ? "delegation.resume" : "delegation.pause", snapshot?.pause ? {} : { for: "1h" }))}>{snapshot?.pause ? "▶" : "⏸"}</button>
      <button className="tray-icon" type="button" title="Strategy, launch at login, quit" aria-label="More" aria-expanded={menuOpen} aria-controls="tray-menu" onClick={() => { setMenuOpen(!menuOpen); setStrategiesOpen(false); }}>⋯</button>
    </nav>
    {menuOpen && <nav id="tray-menu" className="tray-menu" aria-label="More actions">
      <button type="button" aria-expanded={strategiesOpen} aria-controls="tray-strategies" onClick={() => setStrategiesOpen(!strategiesOpen)}>Switch strategy <span aria-hidden="true">{strategiesOpen ? "▾" : "▸"}</span></button>
      {strategiesOpen && <div id="tray-strategies" className="tray-strategies">{snapshot?.strategies?.length ? snapshot.strategies.map(strategy => {
        const name = typeof strategy === "string" ? strategy : strategy.name;
        const active = typeof strategy !== "string" ? strategy.active : snapshot.budget?.strategy === name;
        return <button key={name} type="button" disabled={busy || sessionEnded} aria-pressed={active} onClick={() => act(async () => { await api.call("strategy.use", { name }); setStrategiesOpen(false); setMenuOpen(false); })}>{name}{active && <span aria-label="Active">✓</span>}</button>;
      }) : <span className="tray-notice">No strategies available</span>}</div>}
      <a href={appHref("/settings/general")} onClick={navigate("/settings/general")}>Launch at login</a>
      <button type="button" disabled={!ipc.desktop} onClick={() => act(ipc.quit)}>Quit<Kbd>⌘Q</Kbd></button>
    </nav>}
  </main>;
}

import { DensityProvider } from "../ds/Density";
import { ListRow, ListRowLink, LoadingState } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import { Button, ButtonLink, IconButton, TextAction } from "../ds/Button";
import type { ActivityEntry } from "../../../src/activity/log";
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { BrowserApi } from "../data/api";
import type { Action } from "../../../src/attention/types";
import { agentInfo, markAgent, runnerAgent } from "../../../src/view-model/agents";
import { backIn, clock, elapsed } from "../../../src/view-model/time";
import { meterText } from "../../../src/view-model/format";
import { attentionStatus, paceStatus, taskStatus } from "../../../src/view-model/words";
import { plannerMeter } from "../../../src/view-model/selectors";
import { AgentMark } from "../ds/AgentMark";
import { UsageMeter } from "../ds/UsageMeter";
import { StatusPill } from "../ds/StatusPill";
import { StatusGlyph } from "../ds/StatusGlyph";
import { executorPace, executorEligibility } from "../../../src/view-model/capacity";
import { Kbd } from "../ds/Kbd";
import { appHref, type TrayIpc } from "./ipc";
import { actionRoute, executorValue, primaryAction, shortTitle, trayModel } from "./model";

export interface TrayProps { snapshot: ClientSnapshot | null; api: BrowserApi; ipc: TrayIpc; connected?: boolean; sessionEnded?: boolean; activity?: ActivityEntry[] }
/** One short verb per row, as on the board; the full label stays in the tooltip. */
export function rowLabel(label: string): string {
  // "Open planner settings" and the like: the row title already says what; the button says where.
  if (/^open\b.*\bsettings$/i.test(label)) return "Settings";
  return label.replace(/ on .+$/, "");
}

export async function performAction(action: Action, api: BrowserApi, ipc: TrayIpc) {
  if (action.op === "task.answer" && typeof action.params.text !== "string") await ipc.open(`/tasks/${encodeURIComponent(String(action.params.id))}`);
  else if (action.op === "ui.open") await ipc.open(actionRoute(action));
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
/** Close in-app menus even when native hide is a no-op in browser preview. */
export async function dismissTray(closeMenus: () => void, hide: () => Promise<unknown>, report: (message: string) => void) {
  closeMenus();
  try { await hide(); }
  catch (error) { report(error instanceof Error ? error.message : "Could not hide tray"); }
}
export function Tray({ snapshot, api, ipc, connected = true, sessionEnded = false, activity = [] }: TrayProps) {
  const root = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
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
    if (event.key === "Escape") { event.preventDefault(); void dismissTray(() => { setMenuOpen(false); setStrategiesOpen(false); if (menuOpen) moreButton.current?.focus(); }, ipc.hide, setError); return; }
    if (event.metaKey || event.ctrlKey) {
      const action = ({ d: () => ipc.open("/"), o: () => ipc.open("/"), q: ipc.quit } as Record<string, () => Promise<unknown>>)[event.key.toLowerCase()];
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
  const tone = paceStatus(planner?.verdict ?? "unknown").tone;
  const model = snapshot && trayModel(snapshot, activity);
  const mode = snapshot?.pause ? "Paused" : ({ normal: "Normal", relaxed: "Relaxed", strict: "Strict" } as Record<string, string>)[planner?.mode ?? snapshot?.mode?.mode ?? snapshot?.budget?.mode ?? "normal"] ?? "Normal";
  const pauseLabel = snapshot?.pause ? "Resume delegation" : "Pause delegation for 1 hour";
  const next = model?.queued[0];
  const nextExecutor = next?.executor ? agentInfo(runnerAgent(next.executor)).name : "executor";
  const timeOnly = (at: number) => clock(at, snapshot?.at ?? Date.now() / 1000);
  return <DensityProvider value="compact"><main className="tray" ref={root} aria-label="pacer tray" aria-busy={busy}>
    <header className="tray-planner">
      <div className="tray-line">{planner && <AgentMark agent={planner.agent} size={18} labelled={false} />}<strong>{planner ? agentInfo(planner.agent).name : "pacer"}</strong><span className="tray-planner-label tray-grow">planner</span><StatusPill status={paceStatus(planner?.verdict ?? "unknown")} /><span className="tray-mode">{mode}</span></div>
      <UsageMeter used={planner?.usedPct ?? null} pace={planner?.pacePct ?? null} tone={tone} size="bar" label="Planner usage" text="none" stale={planner?.stale} />
      <div className="tray-caption"><span>{meterText(planner?.usedPct ?? null, planner?.pacePct ?? null, "full")}</span><span>{planner?.resetsAt != null ? `resets ${clock(planner.resetsAt, snapshot!.at)}` : backIn(null, snapshot?.at ?? 0)}{snapshot?.pause?.until != null && ` · paused until ${timeOnly(snapshot.pause.until)}`}</span></div>
    </header>
    {sessionEnded ? <p className="tray-notice" role="alert">Session ended. Run pacer open.</p> : !snapshot ? <LoadingState label="Connecting to pacer…" /> : !connected && <p className="tray-notice" role="status">Reconnecting…</p>}
    {model && <>
      <nav className="tray-counts" aria-label="Task counts">{[
        { n: model.needsCount, label: "needs you", route: "/", warn: true },
        { n: snapshot.counts?.running ?? model.active.length, label: "running", route: "/sessions" },
        { n: model.waiting, label: "waiting", route: "/sessions?filter=waiting" },
        { n: model.done, label: "done today", route: "/sessions?filter=done" },
      ].map(cell => <TextAction key={cell.label} className="tray-count" href={appHref(cell.route)} onClick={navigate(cell.route)}><b className={!cell.n ? "tray-muted" : cell.warn ? "tray-idle" : undefined}>{cell.n}</b><span>{cell.label}</span></TextAction>)}</nav>
      {/* Update status sits above the fold: it can need action before the task lists. */}
      {model.update && <TextAction className="tray-waiting" href={appHref(model.update.route)} onClick={navigate(model.update.route)}><StatusGlyph status={model.update}/><span className="tray-grow">{model.update.label}</span><span aria-hidden="true">›</span></TextAction>}
      {model.attention.length ? <section className="tray-section" aria-label="Needs you"><SectionHeading className="tray-attention-heading">Needs you</SectionHeading>
        {model.attention.slice(0, 3).map(item => {
          const action = primaryAction(item.actions);
          const task = snapshot?.tasks.find(t => t.id === item.taskId);
          const status = attentionStatus(item, snapshot.tasks);
          const detail = item.detail?.trim();
          return <ListRow className={`tray-attention tray-attention--${item.kind}`} key={item.id}
            leading={<span title={status.label}><StatusGlyph status={status} /></span>}
            content={<><strong className="tray-ellipsis" title={shortTitle({ ...item, fullTitle: task?.fullTitle })}>{shortTitle({ ...item, fullTitle: task?.fullTitle })}</strong><span className="tray-reason tray-ellipsis" title={detail}>{[item.repo?.label ?? task?.repo?.label, status.label, detail?.toLowerCase() === status.label.toLowerCase() ? undefined : detail].filter(Boolean).join(" · ")}</span></>}
            actions={action && <Button size="sm" busy={busy} disabled={sessionEnded} title={action.label} onClick={() => act(() => performAction(action, api, ipc))}><span className="tray-action__label">{rowLabel(action.label)}</span></Button>}
          />;
        })}
        {model.needsCount > 3 && <TextAction className="tray-more" href={appHref("/")} onClick={navigate("/")}>+{model.needsCount - 3} more in the app</TextAction>}
      </section> : <section className="tray-clear" aria-label="Needs you"><span className="tray-check" aria-hidden="true">✓</span><span><strong>Nothing needs you</strong>{model.lastReview !== null && <span className="tray-reason">Last review cleared {timeOnly(model.lastReview)}</span>}</span></section>}
      {model.active.length > 0 && <section className="tray-section" aria-label="Running"><SectionHeading>Running</SectionHeading>
        {model.active.slice(0, 3).map(task => <ListRowLink key={task.id} className="tray-running" href={appHref(`/sessions/${encodeURIComponent(task.id)}`)} onClick={navigate(`/sessions/${encodeURIComponent(task.id)}`)}>
          <AgentMark agent={runnerAgent(task.executor ?? "unknown")} size={16} labelled={false} /><span className="tray-grow tray-ellipsis" title={shortTitle(task)}>{shortTitle(task)}</span>
          <span className="tray-repo tray-ellipsis">{task.repo?.label}</span><span className={`tray-phase pc-status--${taskStatus(task).tone}`}><StatusGlyph status={taskStatus(task)} />{taskStatus(task).label} · running for {elapsed(snapshot!.at - (task.attemptStartedAt ?? task.updatedAt))}</span>
        </ListRowLink>)}
        {model.active.length > 3 && <TextAction className="tray-more" href={appHref("/sessions")} onClick={navigate("/sessions")}>+{model.active.length - 3} more in the app</TextAction>}
      </section>}
      {model.waiting > 0 && <TextAction title={next ? shortTitle(next) : undefined} className="tray-waiting" href={appHref("/sessions?filter=waiting")} onClick={navigate("/sessions?filter=waiting")}><span aria-hidden="true">⏳</span><span className="tray-grow tray-ellipsis">{snapshot?.pause ? `${model.waiting} waiting · delegation paused${snapshot.pause.until !== null ? ` for ${Math.max(0, Math.ceil((snapshot.pause.until - snapshot.at) / 60))} min` : ""}` : `${model.waiting} waiting for parallel tasks on ${nextExecutor} · next: ${shortTitle(next!)}`}</span><span aria-hidden="true">›</span></TextAction>}
      <section className="tray-executors" aria-label="Executors">{model.executors.map(executor => {
        const value = executorValue(executor);
        const readiness = executorEligibility(executor, snapshot.at);
        const valueStatus = value === "?" ? readiness : value.endsWith("%") ? executorPace(executor, snapshot) : readiness;
        const label = `${agentInfo(executor.agent).name}: ${readiness.label} · ${readiness.detail}${readiness.age ? ` · ${readiness.age}` : ""} · ${executorPace(executor, snapshot).label}${executor.reason ? ` · ${executor.reason}` : ""} · ${executor.slots.used}/${executor.slots.max} parallel tasks${executor.usedPct !== null ? ` · ${meterText(executor.usedPct, executor.pacePct, "full")}` : ""}`;
        return <TextAction className={`tray-executor${value === "off" ? " tray-executor--off" : ""}${value === "out" ? " tray-executor--out" : ""}`} key={executor.id} href={appHref("/settings/executors")} onClick={navigate("/settings/executors")} aria-label={label} title={label}><span className="tray-executor-mark"><AgentMark agent={markAgent(executor.id, executor.account)} size={16} labelled={false} /><StatusGlyph status={readiness} /></span><span className={`pc-status--${valueStatus.tone}`}>{value}</span></TextAction>;
      })}</section>
    </>}
    {error && <p role="alert" className="tray-error">{error}</p>}
    <nav className="tray-footer" aria-label="pacer actions">
      <ButtonLink variant="primary" href={appHref("/")} onClick={navigate("/")}>Delegate <Kbd>⌘D</Kbd></ButtonLink>
      <ButtonLink href={appHref("/")} onClick={navigate("/")}>Open pacer <Kbd>⌘O</Kbd></ButtonLink>
      <span className="tray-grow" />
      <IconButton variant="quiet" type="button" title={pauseLabel} aria-label={pauseLabel} disabled={!snapshot || busy || sessionEnded} onClick={() => act(() => api.call(snapshot?.pause ? "delegation.resume" : "delegation.pause", snapshot?.pause ? {} : { for: "1h" }))}>{snapshot?.pause ? "▶" : "⏸"}</IconButton>
      <IconButton ref={moreButton} variant="quiet" type="button" title="Strategy, launch at login, quit" aria-label="More" aria-expanded={menuOpen} aria-controls="tray-menu" onClick={() => { setMenuOpen(!menuOpen); setStrategiesOpen(false); }}>⋯</IconButton>
    </nav>
    {menuOpen && <nav id="tray-menu" className="tray-menu" aria-label="More actions">
      <Button variant="quiet" type="button" aria-expanded={strategiesOpen} aria-controls="tray-strategies" onClick={() => setStrategiesOpen(!strategiesOpen)}>Switch strategy <span aria-hidden="true">{strategiesOpen ? "▾" : "▸"}</span></Button>
      {strategiesOpen && <div id="tray-strategies" className="tray-strategies">{snapshot?.strategies?.length ? snapshot.strategies.map(strategy => {
        const name = typeof strategy === "string" ? strategy : strategy.name;
        const active = typeof strategy !== "string" ? strategy.active : snapshot.budget?.strategy === name;
        return <Button key={name} type="button" disabled={busy || sessionEnded} aria-pressed={active} onClick={() => act(async () => { await api.call("strategy.use", { name }); setStrategiesOpen(false); setMenuOpen(false); })}>{name}{active && <span aria-label="Active">✓</span>}</Button>;
      }) : <span className="tray-notice">No strategies available</span>}</div>}
      <TextAction className="pc-text-action" href={appHref("/settings/general")} onClick={navigate("/settings/general")}>Launch at login</TextAction>
      {ipc.desktop && <Button variant="quiet" type="button" onClick={() => act(ipc.quit)}>Quit<Kbd>⌘Q</Kbd></Button>}
    </nav>}
  </main></DensityProvider>;
}

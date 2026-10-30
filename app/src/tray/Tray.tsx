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
import { backIn, clock, durationWords } from "../../../src/view-model/time";
import { meterText } from "../../../src/view-model/format";
import { attentionStatus, paceStatus, taskStatus } from "../../../src/view-model/words";
import { plannerMeter } from "../../../src/view-model/selectors";
import { AgentMark } from "../ds/AgentMark";
import { UsageMeter } from "../ds/UsageMeter";
import { Pill } from "../ds/Pill";
import { StatusGlyph } from "../ds/StatusGlyph";
import { executorPace, executorEligibility, machineWaitWords } from "../../../src/view-model/capacity";
import { Icon, type IconName } from "../ds/icons";
import type { Status } from "../../../src/view-model/words";
import { Switch } from "../ds/Controls";
import { Kbd } from "../ds/Kbd";
import { appHref, type TrayIpc } from "./ipc";
import { actionError, actionRoute, visibleFailure, executorValue, offExecutorLabel, primaryAction, resetCaption, shortTitle, trayModel } from "./model";

export interface TrayProps { snapshot: ClientSnapshot | null; api: BrowserApi; ipc: TrayIpc; connected?: boolean; sessionEnded?: boolean; activity?: ActivityEntry[] }
/** One short verb per row, as on the board; the full label stays in the tooltip. */
export function rowLabel(label: string): string {
  // "Open planner settings" and the like: the row title already says what; the button says where.
  if (/^open\b.*\bsettings$/i.test(label)) return "Settings";
  // "Retry on Codex" names where the retry goes; other long labels ("Review changes") keep their verb only.
  if (/^retry on \S/i.test(label) || label.length <= 12) return label;
  return label.trim().split(/\s+/)[0] ?? label;
}

/** Preserve the shared status vocabulary while using strokes for transport controls. */
function TrayStatusGlyph({ status }: { status: Status }) {
  const icon = ({ "\u25b6": "play", "\u23f8": "pause", "\u22ef": "more", "\u23f3": "time" } as Record<string, IconName>)[status.glyph];
  return icon ? <span className={`pc-status--${status.tone}`} aria-hidden="true"><Icon name={icon} /></span> : <StatusGlyph status={status} />;
}

export async function performAction(action: Action, api: BrowserApi, ipc: TrayIpc) {
  if (action.op === "task.answer" && typeof action.params.text !== "string") await ipc.open(`/needs-you?answer=${encodeURIComponent(String(action.params.id))}`);
  else if (action.op === "ui.open") await ipc.open(actionRoute(action));
  else await api.call(action.op, action.params);
}
/** Native Tab order is also the arrow-key order, including expanded strategies. */
export function moveFocus(root: HTMLElement, key: string): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  const rows = [...root.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled)")];
  const visibleRows = rows.filter(row => !row.hidden);
  rows.splice(0, rows.length, ...visibleRows);
  if (!rows.length) return false;
  const at = rows.indexOf(root.ownerDocument.activeElement as HTMLElement);
  const index = at === -1 && key === "ArrowUp" ? rows.length - 1 : key === "Home" ? 0 : key === "End" ? rows.length - 1 : (at + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
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
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [login, setLogin] = useState<boolean | null>(null);
  const strip = useRef<HTMLElement>(null);
  const model = snapshot && trayModel(snapshot, activity);
  const stripData = JSON.stringify(model?.executors);
  // A failure on a Needs you row belongs to that row: it clears once the row is gone.
  const [failure, setFailure] = useState<{ message: string; item?: string } | null>(null);
  const setError = (message: string) => setFailure(message ? { message } : null);
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>, item?: string) => {
    if (busy) return;
    setBusy(true); setFailure(null);
    void work().catch(e => setFailure({ message: actionError(e), item })).finally(() => setBusy(false));
  };
  useLayoutEffect(() => {
    const measure = () => {
      if (!root.current) return;
      const popup = menu.current;
      const popupStyle = popup && getComputedStyle(popup);
      const needed = popup && popupStyle
        ? Math.min(popup.scrollHeight + parseFloat(popupStyle.borderTopWidth) + parseFloat(popupStyle.borderBottomWidth), parseFloat(popupStyle.getPropertyValue("--size-340"))) + parseFloat(popupStyle.bottom)
        : 0;
      // Main content does not stretch with the open menu, so resize can shrink too.
      const main = root.current.querySelector<HTMLElement>(".tray-main")!;
      const footer = root.current.querySelector<HTMLElement>(".tray-actions")!;
      const height = main.scrollHeight + footer.getBoundingClientRect().height;
      // The window is the body's border box: add its border around the tray.
      const body = getComputedStyle(root.current.ownerDocument.body);
      const frame = parseFloat(body.borderTopWidth) + parseFloat(body.borderBottomWidth);
      void ipc.resize(Math.min(560, Math.max(height, needed) + frame)).catch(() => {});
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (root.current) {
      observer?.observe(root.current);
      observer?.observe(root.current.querySelector(".tray-main")!);
    }
    if (menu.current) observer?.observe(menu.current);
    return () => observer?.disconnect();
  });
  useLayoutEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>("button:not(:disabled),a[href]")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !moreButton.current?.contains(event.target as Node)) {
        setMenuOpen(false); setStrategiesOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (!menuOpen || !ipc.desktop) return;
    let current = true;
    setLogin(null);
    void ipc.loginItem().then(value => { if (current) setLogin(value); }).catch(e => { if (current) setError(e instanceof Error ? e.message : "Could not read login item"); });
    return () => { current = false; };
  }, [menuOpen, ipc.desktop]);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => {
      const items = [...element.querySelectorAll<HTMLElement>("[data-executor]")];
      const overflow = element.querySelector<HTMLElement>("[data-overflow]")!;
      items.forEach(item => { item.hidden = false; });
      overflow.hidden = false;
      overflow.textContent = `+${items.length}`;
      const style = getComputedStyle(element), gap = parseFloat(style.columnGap);
      const fixed = [...element.children].filter(child => !child.hasAttribute("data-executor") && !child.hasAttribute("data-overflow") && !child.classList.contains("tray-grow"));
      const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - fixed.reduce((sum, child) => sum + child.getBoundingClientRect().width + gap, 0);
      const widths = items.map(item => item.getBoundingClientRect().width + gap);
      let remaining = available;
      let count = items.length;
      if (widths.reduce((sum, width) => sum + width, 0) > available) {
        count = 0;
        for (const [index, width] of widths.entries()) {
          const hidden = items.length - index - 1;
          overflow.textContent = `+${hidden}`;
          const reserve = hidden > 0 ? overflow.getBoundingClientRect().width + gap : 0;
          if (width + reserve > remaining) break;
          remaining -= width;
          count++;
        }
      }
      items.forEach((item, index) => { item.hidden = index >= count; });
      overflow.hidden = count === items.length;
      overflow.textContent = `+${items.length - count}`;
      overflow.title = items.slice(count).map(item => item.title).join("\n");
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [stripData]);
  const navigate = (route: string) => (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => { event.preventDefault(); act(() => ipc.open(route)); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); void dismissTray(() => { setMenuOpen(false); setStrategiesOpen(false); if (menuOpen) moreButton.current?.focus(); }, menuOpen ? async () => {} : ipc.hide, setError); return; }
    if (event.metaKey || event.ctrlKey) {
      const action = ({ n: () => ipc.open("/tasks/new"), ",": () => ipc.open("/settings"), o: () => ipc.open("/"), ...(ipc.desktop ? { q: ipc.quit } : {}) } as Record<string, () => Promise<unknown>>)[event.key.toLowerCase()];
      if (action) { event.preventDefault(); act(action); }
      return;
    }
    if (root.current && moveFocus(menuOpen && menu.current ? menu.current : root.current, event.key)) event.preventDefault();
  };
  useLayoutEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });
  const planner = snapshot && plannerMeter(snapshot);
  const pace = paceStatus(planner?.verdict ?? "unknown");
  const tone = pace.tone;
  const offExecutors = model?.executors.filter(executor => executorValue(executor) === "off") ?? [];
  const mode = snapshot?.pause ? "Paused" : ({ normal: "Normal", relaxed: "Relaxed", strict: "Strict" } as Record<string, string>)[planner?.mode ?? snapshot?.mode?.mode ?? snapshot?.budget?.mode ?? "normal"] ?? "Normal";
  const pauseLabel = snapshot?.pause ? "Resume delegation" : "Pause delegation for 1 hour";
  const next = model?.queued[0];
  const nextExecutor = next?.executor ? agentInfo(runnerAgent(next.executor)).name : "executor";
  const machineWait = next?.queue ? machineWaitWords(next.queue)?.replace(/^Waiting: /, "") : undefined;
  const error = visibleFailure(failure, model?.attention);
  const timeOnly = (at: number) => clock(at, snapshot?.at ?? Date.now() / 1000);
  const waitingRow = model && model.waiting > 0 && !snapshot?.pause && <TextAction title={next ? shortTitle(next) : undefined} className="tray-waiting" href={appHref("/tasks")} onClick={navigate("/tasks")}><Icon name="time" /><span className="tray-grow tray-ellipsis">{machineWait ? `${model.waiting} waiting · ${machineWait}` : `${model.waiting} waiting for a free ${nextExecutor} slot`}{next ? ` · next: ${shortTitle(next)}` : ""}</span></TextAction>;
  return <DensityProvider value="compact"><div className={menuOpen ? "tray tray--menu-open" : "tray"} ref={root} aria-busy={busy}><main className="tray-main" aria-label="pacer tray">
    <section className="tray-planner" aria-label="Planner budget">
      <div className="tray-line">{planner && <AgentMark agent={planner.agent} size={18} labelled={false} />}<strong title={`${planner ? agentInfo(planner.agent).name : "pacer"} planner`}>{planner ? agentInfo(planner.agent).name : "pacer"}</strong><span className="tray-planner-label">planner</span><span className="tray-grow" /><Pill tone={pace.tone} title={pace.label}><StatusGlyph status={pace} /><span className="tray-pace-label">{pace.label}</span></Pill><span className="tray-mode" title={mode}><span className="tray-mode-label">{mode}</span></span></div>
      <UsageMeter used={planner?.usedPct ?? null} pace={planner?.pacePct ?? null} tone={tone} size="bar" label="Planner usage" text="none" stale={planner?.stale} />
      <div className="tray-caption"><span>{planner?.usedPct != null ? `${Math.round(planner.usedPct)}% of week used · pace ${planner.pacePct != null ? Math.round(planner.pacePct) + "%" : "unknown"}` : meterText(null, planner?.pacePct ?? null, "full")}</span><span>{planner?.resetsAt != null ? `resets ${resetCaption(planner.resetsAt, snapshot!.at)}` : backIn(null, snapshot?.at ?? 0)}</span></div>
      {model && <div className="tray-policy">{model.policy}</div>}
    </section>
    {snapshot?.pause && <div className="tray-paused" role="status"><Icon name="pause" /><span className="tray-grow"><strong>Delegation paused</strong><span className="tray-reason">New work waits {snapshot.pause.until === null ? "until you resume" : `until ${timeOnly(snapshot.pause.until)}`}{!!model?.waiting && ` · ${model.waiting} ${model.waiting === 1 ? "task" : "tasks"} waiting`}</span></span><Button size="sm" busy={busy} disabled={sessionEnded} onClick={() => act(() => api.call("delegation.resume", {}))}>Resume</Button></div>}
    {sessionEnded ? <p className="tray-notice" role="alert">Session ended. Run pacer open.</p> : !snapshot ? <LoadingState label="Connecting to pacer…" /> : !connected && <p className="tray-notice" role="status">Reconnecting…</p>}
    {model && <>
      <nav className="tray-counts" aria-label="Task counts">{[
        { n: model.needsCount, label: "needs you", route: "/needs-you", warn: true },
        { n: snapshot.counts?.running ?? model.active.length, label: "running", route: "/sessions" },
        { n: model.waiting, label: "waiting", route: "/tasks" },
        { n: model.done, label: "done today", route: "/tasks" },
      ].map(cell => <TextAction key={cell.label} className="tray-count" href={appHref(cell.route)} onClick={navigate(cell.route)}><b className={!cell.n ? "tray-muted" : cell.warn ? "tray-idle" : undefined}>{cell.n}</b><span>{cell.label}</span></TextAction>)}</nav>
      {/* Update status sits above the fold: it can need action before the task lists. */}
      {model.update && <TextAction className="tray-waiting" href={appHref(model.update.route)} onClick={navigate(model.update.route)}><TrayStatusGlyph status={model.update}/><span className="tray-grow">{model.update.label}</span><span className="tray-chevron"><Icon name="chevron-right" /></span></TextAction>}
      {model.attention.length ? <section className="tray-section" aria-label="Needs you"><div className="tray-section-heading"><SectionHeading className="tray-attention-heading">Needs you</SectionHeading><TextAction href={appHref("/needs-you")} onClick={navigate("/needs-you")}>All {model.needsCount} in Needs you</TextAction></div>
        {model.attention.slice(0, 3).map(item => {
          const action = primaryAction(item.actions);
          const task = snapshot?.tasks.find(t => t.id === item.taskId);
          const status = attentionStatus(item, snapshot.tasks);
          const detail = item.detail?.trim();
          return <ListRow className={`tray-attention tray-attention--${item.kind}`} key={item.id}
            leading={<span className={`tray-attention-glyph tray-attention-glyph--${item.kind === "failed" ? "bad" : item.kind === "review" ? "info" : "warn"}`} title={status.label} aria-hidden="true">{item.kind === "failed" ? "✕" : item.kind === "review" ? "●" : "◐"}</span>}
            content={<><strong className="tray-ellipsis" title={shortTitle({ ...item, fullTitle: task?.fullTitle })}>{shortTitle({ ...item, fullTitle: task?.fullTitle })}</strong><span className="tray-reason tray-ellipsis" title={detail}>{[item.repo?.label ?? task?.repo?.label, status.label, detail?.toLowerCase() === status.label.toLowerCase() ? undefined : detail].filter(Boolean).join(" · ")}</span></>}
            actions={action && <Button variant={item.id === model.recommendedId ? "primary" : "secondary"} size="sm" busy={busy} disabled={sessionEnded} title={action.label} onClick={() => act(() => performAction(action, api, ipc), item.id)}><span className="tray-action__label">{rowLabel(action.label)}</span></Button>}
          />;
        })}
      </section> : <section className="tray-clear" aria-label="Needs you"><span className="tray-check"><Icon name="check-circle" /></span><span><strong>Nothing needs you</strong>{model.lastReview !== null && <span className="tray-reason">Last review cleared {timeOnly(model.lastReview)}</span>}</span></section>}
      {model.active.length > 0 ? <section className="tray-section tray-running-section" aria-label="Running"><div className="tray-section-heading"><SectionHeading>Running</SectionHeading><TextAction href={appHref("/sessions")} onClick={navigate("/sessions")}>All {snapshot.counts?.running ?? model.active.length} in Tasks</TextAction></div>
        {model.active.slice(0, 2).map(task => <ListRowLink key={task.id} className="tray-running" href={appHref(`/sessions/${encodeURIComponent(task.id)}`)} onClick={navigate(`/sessions/${encodeURIComponent(task.id)}`)}>
          <AgentMark agent={runnerAgent(task.executor ?? "unknown")} size={20} labelled={false} /><span className="tray-grow"><strong className="tray-ellipsis" title={shortTitle(task)}>{shortTitle(task)}</strong><span className="tray-running-caption"><span className="tray-phase">{taskStatus(task).label}</span><span className="tray-ellipsis">{[durationWords(snapshot!.at - (task.attemptStartedAt ?? task.updatedAt)), task.repo?.label].filter(Boolean).map(part => `\u00a0· ${part}`).join("")}</span></span></span><span className="tray-chevron"><Icon name="chevron-right" /></span>
        </ListRowLink>)}
        {waitingRow}
      </section> : waitingRow}
      <section ref={strip} className="tray-executors" aria-label="Executors">{model.executors.filter(executor => executorValue(executor) !== "off").map(executor => {
        const value = executorValue(executor);
        const readiness = executorEligibility(executor, snapshot.at);
        const valueStatus = value === "?" || value === "—" ? { ...readiness, tone: "muted" } : value.endsWith("%") ? executorPace(executor, snapshot) : readiness;
        const label = `${agentInfo(executor.agent).name}: ${readiness.label} · ${readiness.detail}${readiness.age ? ` · ${readiness.age}` : ""} · ${executorPace(executor, snapshot).label}${executor.reason ? ` · ${executor.reason}` : ""} · ${executor.slots.used}/${executor.slots.max} parallel tasks${executor.usedPct !== null ? ` · ${meterText(executor.usedPct, executor.pacePct, "full")}` : ""}`;
        return <TextAction data-executor className={`tray-executor${value === "off" ? " tray-executor--off" : ""}${value === "out" ? " tray-executor--out" : ""}`} key={executor.id} href={appHref("/settings/executors")} onClick={navigate("/settings/executors")} aria-label={label} title={label}><span className="tray-executor-mark"><AgentMark agent={markAgent(executor.id, executor.account)} size={16} labelled={false} /></span><span className={`tray-executor-value tray-executor-value--${value === "off" ? "off" : value === "out" ? "bad" : ({ good: "good", warn: "warn", bad: "bad" } as Record<string, string>)[valueStatus.tone] ?? "muted"}`}>{value}</span></TextAction>;
      })}<TextAction data-overflow hidden className="tray-executor tray-muted" href={appHref("/settings/executors")} onClick={navigate("/settings/executors")} />{offExecutors.length > 0 && <TextAction className="tray-executor tray-executor--off tray-muted" title={`Turned off or unable to take work: ${offExecutors.map(offExecutorLabel).join(" · ")}`} href={appHref("/settings/executors")} onClick={navigate("/settings/executors")}><span className="tray-executor-mark"><AgentMark agent={markAgent(offExecutors[0]!.id, offExecutors[0]!.account)} size={16} labelled={false} /></span>{offExecutors.length} off</TextAction>}<span className="tray-grow" /><span className="tray-reason">executors</span></section>
    </>}
    {error && <p role="alert" className="tray-error">{error}</p>}
    </main><div className="tray-actions">
      <nav className="tray-footer" aria-label="pacer actions">
        <ButtonLink aria-keyshortcuts="Meta+N" size="sm" variant="primary" href={appHref("/tasks/new")} onClick={navigate("/tasks/new")}>New task <Kbd>⌘N</Kbd></ButtonLink>
        <ButtonLink aria-keyshortcuts="Meta+O" size="sm" href={appHref("/")} onClick={navigate("/")}>Open pacer <Kbd>⌘O</Kbd></ButtonLink>
        <span className="tray-grow" />
        <IconButton variant="quiet" type="button" title={pauseLabel} aria-label={pauseLabel} disabled={!snapshot || busy || sessionEnded} onClick={() => act(() => api.call(snapshot?.pause ? "delegation.resume" : "delegation.pause", snapshot?.pause ? {} : { for: "1h" }))}><Icon name={snapshot?.pause ? "play" : "pause"} /></IconButton>
        <IconButton ref={moreButton} variant="quiet" type="button" className={menuOpen ? "tray-more-open" : undefined} title="More" aria-label="More" aria-expanded={menuOpen} aria-controls="tray-menu" onClick={() => { setMenuOpen(!menuOpen); setStrategiesOpen(false); }}><Icon name="more" /></IconButton>
      </nav>
      {/* Local menu: DS ActionMenu supports plain labels, not strategy expansion, shortcut hints or dividers. */}
      {menuOpen && <nav ref={menu} id="tray-menu" className="tray-menu" aria-label="More actions">
        <Button variant="quiet" type="button" aria-expanded={strategiesOpen} aria-controls="tray-strategies" onClick={() => setStrategiesOpen(!strategiesOpen)} className="tray-menu-item"><Icon name="strategy" /><span className="tray-grow">Strategy</span><span className="tray-reason">{snapshot?.strategies?.flatMap(s => typeof s !== "string" && s.active ? [s.name] : [])[0] ?? snapshot?.budget?.strategy ?? snapshot?.mode?.strategy}</span><span className={strategiesOpen ? "tray-chevron tray-chevron--down" : "tray-chevron"}><Icon name="chevron-right" /></span></Button>
        {strategiesOpen && <div id="tray-strategies" className="tray-strategies">{snapshot?.strategies?.length ? snapshot.strategies.map(strategy => {
          const name = typeof strategy === "string" ? strategy : strategy.name;
          const active = typeof strategy !== "string" ? strategy.active : snapshot.budget?.strategy === name;
          return <Button key={name} type="button" disabled={busy || sessionEnded} aria-pressed={active} onClick={() => act(async () => { await api.call("strategy.use", { name }); setStrategiesOpen(false); setMenuOpen(false); })}>{name}{active && <span aria-label="Active"><Icon name="check-circle" /></span>}</Button>;
        }) : <span className="tray-notice">No strategies available</span>}</div>}
        {ipc.desktop && <label className="tray-menu-item"><svg className="tray-login-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0" /></svg><span className="tray-grow">Open at login</span><Switch aria-label="Open at login" checked={login ?? false} disabled={login === null || busy} onChange={event => { const enabled = event.currentTarget.checked; act(async () => { setLogin(await ipc.loginItem(enabled)); }); }} /></label>}
        <TextAction aria-keyshortcuts="Meta+Comma" className="tray-menu-item" href={appHref("/settings")} onClick={navigate("/settings")}><Icon name="settings" /><span className="tray-grow">Settings</span><Kbd>⌘,</Kbd></TextAction>
        {ipc.desktop && <><div className="tray-menu-divider" /><Button aria-keyshortcuts="Meta+Q" className="tray-menu-item" variant="quiet" type="button" onClick={() => act(ipc.quit)}><span className="tray-menu-icon-slot" /><span className="tray-grow">Quit pacer</span><Kbd>⌘Q</Kbd></Button></>}
      </nav>}
    </div>
  </div></DensityProvider>;
}

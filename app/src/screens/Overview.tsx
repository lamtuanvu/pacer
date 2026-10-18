import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { ActivityEntry, AttentionItem } from "../../../src/api/read-model/types";
import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { ago, clock, elapsed, meterText } from "../../../src/view-model/format";
import { capacity, counts, doneToday, needsYou, otherReposNeedingYou, plannerMeter, running, type Scope } from "../../../src/view-model/selectors";
import type { ClientSnapshot, ClientTask } from "../../../src/view-model/snapshot";
import { executorLabel, phaseWords, taskStatus, toneFor } from "../../../src/view-model/words";
import { useActions } from "../data/action-context";
import type { ActionRunner } from "../data/actions";
import { AgentMark } from "../ds/AgentMark";
import { Kbd } from "../ds/Kbd";
import { Pill } from "../ds/Pill";
import { StatusGlyph } from "../ds/StatusGlyph";
import { UsageMeter } from "../ds/UsageMeter";
import { overviewHints } from "../keys/registry";
import { keys } from "../keys/instance";
import { withQuery, type RouteQuery } from "../router";
import { ActionButton } from "./ActionButton";
import { QuickDelegate } from "./QuickDelegate";
import { repoChoices, RepoFilter } from "./RepoFilter";
import { useQuery, useTaskContext } from "./task-shared";

const BAD_KINDS = new Set(["failed", "limit", "executor_down", "host_down"]);
const OFF_STATES = new Set(["down", "failing", "disabled", "blocked", "exhausted"]);
const gone = (item: AttentionItem) => (s: { snapshot: ClientSnapshot | null }) => !s.snapshot?.attention?.some(a => a.id === item.id && a.since === item.since);

/** Older services put the full goal in attention.title; reuse their task title in that case. */
function attentionTitle(item: AttentionItem, snapshot: ClientSnapshot): string {
  const task = snapshot.tasks.find(task => task.id === item.taskId);
  return item.title === task?.goal ? task.title ?? item.title : item.title;
}

function NeedsYou({ snapshot, scope, runner, now }: { snapshot: ClientSnapshot; scope: Scope; runner: ActionRunner; now: number }) {
  const items = needsYou(snapshot, scope), others = otherReposNeedingYou(snapshot, scope);
  return <section className="pc-section" aria-labelledby="needs-you"><div className="pc-section__head"><h2 id="needs-you">Needs you</h2>{items.length > 0 && <span className="pc-count pc-count--warn">{items.length}</span>}<span className="grow" /><a href={withQuery("#/review", { repo: scope.repo, scope: null })}>Open review queue</a></div>
    {items.map(item => <div key={item.id} tabIndex={0} data-attention-id={item.id} className={`pc-attn${BAD_KINDS.has(item.kind) ? " pc-attn--bad" : ""}`}>
      <StatusGlyph kind={BAD_KINDS.has(item.kind) ? "failed" : "waiting"} />
      {item.executor && <AgentMark agent={markAgent(item.executor)} size={20} labelled={false} />}
      <div className="grow"><div className="pc-attn__title">{attentionTitle(item, snapshot)}{item.repo && <code className="pc-repo-chip">{item.repo.label}</code>}</div><div className="muted">{item.detail} · {clock(item.raisedAt, now)}</div></div>
      <div className="row-actions">{item.actions.slice(0, 2).map((action, i) => <ActionButton key={i} runner={runner} id={`${item.id}:${i}`} action={action} confirmDone={gone(item)} strong={i === 0} />)}</div>
    </div>)}
    {!items.length && <p className="muted">Nothing needs you.</p>}
    {others > 0 && <a href={withQuery("#/", { repo: null, scope: null })}>+{others} in other repos</a>}
  </section>;
}

function lastOutput(t: ClientTask, now: number) {
  // The service decides when a task is idle (its stuck threshold) and says so in the phase.
  if (t.progress?.phase === "idle" && t.progress.lastOutputAt) return <span className="pc-warn-text">idle {elapsed(now - t.progress.lastOutputAt)}</span>;
  return t.progress?.lastOutputAt ? <span className="muted">output {ago(t.progress.lastOutputAt, now)}</span> : null;
}
function Running({ snapshot, scope, now, runner }: { snapshot: ClientSnapshot; scope: Scope; now: number; runner: ActionRunner }) {
  const rows = running(snapshot, scope);
  return <section className="pc-card-section" aria-labelledby="running"><div className="pc-card-section__head"><h2 id="running">Running</h2><span className="muted">{rows.length}</span></div>
    {rows.map(t => <div key={t.id} className="pc-row">
      {t.executor ? <AgentMark agent={markAgent(t.executor)} size={20} labelled={false} /> : <span className="pc-row__gap" />}
      <div className="grow pc-row__goal">{t.goal}</div>
      <span className="muted">{t.repo?.label}</span>
      <Pill tone={t.state === "queued" ? "neutral" : "info"}>{phaseWords(t.state === "queued" ? "queued" : t.progress?.phase ?? t.state)}</Pill>
      {t.state === "queued"
        ? <><span className="muted">{t.queue?.reason === "no_slot" ? "waiting for a slot" : "queued"}</span><ActionButton runner={runner} id={`${t.id}:stop`} action={{ label: "Stop", op: "task.stop", params: { id: t.id } }} confirmDone={s => !s.snapshot?.tasks.some(x => x.id === t.id && x.state === "queued")} /></>
        : <>{t.attemptStartedAt && <span className="muted">{elapsed(now - t.attemptStartedAt)}</span>}
          {t.progress && <span className="muted">{t.progress.files} files · {t.progress.commits} commits</span>}
          {lastOutput(t, now)}<a className="pc-btn pc-btn--secondary pc-btn--sm" href={`#/sessions/${encodeURIComponent(t.id)}`}>Watch</a><ActionButton runner={runner} id={`${t.id}:takeover`} action={{label:"Take over",op:"task.takeover",params:{id:t.id}}}/></>}
    </div>)}
    {!rows.length && <p className="muted">Nothing running. Delegate a task, or ask your planner to.</p>}
  </section>;
}

function Capacity({ snapshot }: { snapshot: ClientSnapshot }) {
  const rows = capacity(snapshot), c = counts(snapshot);
  return <section className="pc-card-section" aria-labelledby="capacity"><div className="pc-card-section__head"><h2 id="capacity">Capacity</h2>{c && <span className="muted">{c.ready}/{c.executors} executors ready</span>}<span className="grow" /><a href="#/settings/executors">Details</a></div>
    {rows.map(e => <a key={e.id} href="#/settings/executors" className={`pc-row pc-cap${OFF_STATES.has(e.state) ? " pc-cap--off" : ""}`}>
      <AgentMark agent={markAgent(e.id, e.account)} size={20} labelled={false} />
      <div className="pc-cap__name"><div>{executorLabel(e.id)}</div><div className={OFF_STATES.has(e.state) ? "pc-bad-text" : "muted"}>{OFF_STATES.has(e.state) && e.reason ? e.reason : e.usedPct === null ? <><StatusGlyph kind="waiting" /> Unknown · {e.paceReason ?? e.reason ?? "no usage reported"}</> : e.sub}</div></div>
      <div><UsageMeter used={e.usedPct} pace={e.pacePct} paceReason={e.paceReason} tone={toneFor(e.tone)} size="row" text="none" label={`${executorLabel(e.id)} usage`} /></div>
      <span className="muted pc-num">{e.usedPct === null ? "—" : `${Math.round(e.usedPct)}%`}</span>
      <span className="muted pc-num">{e.slots.used}/{e.slots.max}</span>
    </a>)}
    {!rows.length && <p className="muted">No executors yet. <a href="#/settings/add-executor">Add one.</a></p>}
  </section>;
}

function DoneToday({ snapshot, scope, now }: { snapshot: ClientSnapshot; scope: Scope; now: number }) {
  const rows = doneToday(snapshot, scope), today = snapshot.today;
  return <section className="pc-card-section" aria-labelledby="done-today"><div className="pc-card-section__head"><h2 id="done-today">Done today</h2>{today && <span className="muted">{today.done} · {today.accepted} accepted</span>}<span className="grow" /><a href="#/sessions">All tasks</a></div>
    {rows.map(t => { const status = taskStatus(t); return <div key={t.id} className="pc-row">
      <span className="muted pc-num">{clock(t.updatedAt, now)}</span><div className="grow pc-row__goal">{t.goal}</div>
      <span className="muted">{t.repo?.label}</span><span className="muted">{executorLabel(t.executor)}</span><Pill tone={status.tone}>{status.label}</Pill>
    </div>; })}
    {!rows.length && <p className="muted">Nothing finished yet today.</p>}
  </section>;
}

function Activity({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  return <section className="pc-card-section" aria-labelledby="activity"><div className="pc-card-section__head"><h2 id="activity">Activity</h2></div>
    {entries.slice(0, 20).map(e => <div key={e.id} className="pc-row pc-activity"><span className="muted pc-num">{clock(e.at, now)}</span><span className={`pc-dot pc-dot--${e.level}`} aria-label={e.level} /><span className="grow">{e.text}</span></div>)}
    {!entries.length && <p className="muted">No activity yet.</p>}
  </section>;
}

function PlannerStrip({ snapshot, now }: { snapshot: ClientSnapshot; now: number }) {
  const p = plannerMeter(snapshot), c = counts(snapshot);
  if (!p) return null;
  const name = agentInfo(p.agent).name;
  const extra = [p.activeHoursLeft !== null ? `${Math.round(p.activeHoursLeft)} active-h` : null, p.resetsAt !== null ? `resets ${clock(p.resetsAt, now)}` : null].filter(Boolean).join(" · ");
  const stat = (n: number | string | undefined, label: string, warn = false) => <div className="pc-stat"><div className={`pc-stat__n${warn && n ? " pc-warn-text" : ""}`}>{n ?? 0}</div><div className="muted">{label}</div></div>;
  return <section className="pc-planner-strip" aria-label="Planner">
    <AgentMark agent={p.agent} size={28} labelled={false} />
    <div className="pc-planner-strip__body">
      <div className="row"><span className="pc-label">Planner · {name}</span><span className="pc-planner-strip__advice">{p.advice}</span></div>
      {p.usedPct !== null && <div className="row"><div className="grow"><UsageMeter used={p.usedPct} pace={p.pacePct} tone={toneFor(p.verdict)} verdict={p.verdict} size="bar" text="none" label={`${name} planner usage`} stale={p.stale} staleAt={snapshot.at} now={now} /></div><span className="muted">{meterText(p.usedPct, p.pacePct, "full")}{extra ? ` · ${extra}` : ""}</span></div>}
    </div>
    <div className="pc-stats">{stat(c?.attention, "need you", true)}{stat(c?.running, "running")}{stat(snapshot.today?.done, "done today")}{stat(`${c?.ready ?? 0}/${c?.executors ?? 0}`, "executors ready")}</div>
  </section>;
}
function KeysFooter({ version }: { version?: string }) {
  return <footer className="pc-keys-footer muted">{overviewHints.map((hint, i) => <span key={hint.keys}>{i > 0 && " · "}<Kbd>{hint.keys === "Enter" ? "⏎" : hint.keys}</Kbd> {hint.label}</span>)}<span className="grow" /><span>pacer {version ?? "version unknown"}</span></footer>;
}

export interface OverviewProps { snapshot: ClientSnapshot; query: RouteQuery; now: number; runner: ActionRunner; activity: ActivityEntry[]; ops: ReadonlySet<string>; quickDelegate?: ComponentChildren }
/** The canvas Main board: planner strip and repo chips, then Needs you, Running and Done today with Capacity, Quick delegate and Activity alongside. */
export function OverviewView({ snapshot, query, now, runner, activity, ops, quickDelegate }: OverviewProps) {
  const scope: Scope = { repo: query.repo };
  return <div className="pc-overview">
    <PlannerStrip snapshot={snapshot} now={now} />
    <RepoFilter snapshot={snapshot} query={query} />
    <div className="pc-overview__cols">
      <div className="pc-overview__main">
        <NeedsYou snapshot={snapshot} scope={scope} runner={runner} now={now} />
        <Running snapshot={snapshot} scope={scope} now={now} runner={runner} />
        <DoneToday snapshot={snapshot} scope={scope} now={now} />
      </div>
      <div className="pc-overview__side">
        <Capacity snapshot={snapshot} />
        <section className="pc-card-section" aria-labelledby="quick-delegate"><div className="pc-card-section__head"><h2 id="quick-delegate">Quick delegate</h2></div><div className="pc-card-section__body">{quickDelegate}</div></section>
        <Activity entries={activity} now={now} />
      </div>
    </div>
    <KeysFooter version={snapshot.service?.version} />
  </div>;
}

export function Overview({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext();
  const runner = useActions();
  const page = useQuery<{ entries: ActivityEntry[] }>(state.features.ops.has("activity.list") ? "activity.list" : "version.get", state.features.ops.has("activity.list") ? { limit: 20 } : {});
  const seen = new Set<string>();
  const activity = [...state.activity, ...(Array.isArray(page.data?.entries) ? page.data.entries : [])].filter(e => !seen.has(e.id) && !!seen.add(e.id));
  const focusRef = useRef(() => document.querySelector<HTMLButtonElement>("#repo-filter button")?.focus());
  useEffect(() => keys.register({ keys: "/", label: "Focus the repo filter", scope: "overview", run: () => focusRef.current() }), []);
  const current = useRef({ snapshot: state.snapshot, query }); current.current = { snapshot: state.snapshot, query };
  useEffect(() => {
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-attention-id]")];
    const move = (by: number) => { const all = rows(), at = all.indexOf(document.activeElement?.closest("[data-attention-id]") as HTMLElement); all[Math.max(0, Math.min(all.length - 1, at + by))]?.focus(); };
    const selected = () => current.current.snapshot?.attention?.find(a => a.id === (document.activeElement?.closest("[data-attention-id]") as HTMLElement)?.dataset.attentionId);
    const actions: Record<string, () => void> = {
      j: () => move(1), k: () => move(-1), Enter: () => { const active = document.activeElement as HTMLElement; (active?.tagName === "BUTTON" ? active as HTMLButtonElement : active?.closest("[data-attention-id]")?.querySelector("button"))?.click(); },
      v: () => { const item = selected(); location.hash = item?.taskId ? `#/review/${encodeURIComponent(item.taskId)}` : "#/review"; },
      x: () => { const item = selected(); if (item && state.features.ops.has("attention.dismiss")) void runner.run(`${item.id}:dismiss`, { label: "Dismiss", op: "attention.dismiss", params: { id: item.id } }, gone(item)); },
    };
    const offs = overviewHints.flatMap(hint => hint.keys === "d" ? [] : (hint.keys === "1–4" ? ["1", "2", "3", "4"] : hint.keys.split(" ")).map(key => keys.register({ keys: key, label: hint.label, scope: "overview", run: actions[key] ?? (() => {
      const { snapshot, query } = current.current;
      const repo = snapshot && repoChoices(snapshot, query.repo).chips[Number(key) - 1];
      if (repo) location.hash = withQuery("#/", { ...query, repo: repo.key });
    }) })));
    return () => offs.forEach(off => off());
  }, [runner, state.features.ops]);
  if (!state.snapshot) return null;
  return <OverviewView snapshot={state.snapshot} query={query} now={Date.now() / 1000} runner={runner} activity={activity} ops={state.features.ops} quickDelegate={<QuickDelegate filterRepo={query.repo} />} />;
}

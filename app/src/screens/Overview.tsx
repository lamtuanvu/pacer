import { useEffect, useRef } from "preact/hooks";
import type { ActivityEntry, AttentionItem } from "../../../src/api/read-model/types";
import { runnerAgent } from "../../../src/view-model/agents";
import { ago, clock, elapsed } from "../../../src/view-model/format";
import { capacity, counts, doneToday, needsYou, otherReposNeedingYou, repos, running, type Scope } from "../../../src/view-model/selectors";
import type { ClientSnapshot, ClientTask } from "../../../src/view-model/snapshot";
import { executorLabel, phaseWords, taskStatus, toneFor } from "../../../src/view-model/words";
import { useActions } from "../data/action-context";
import type { ActionRunner } from "../data/actions";
import { AgentMark } from "../ds/AgentMark";
import { Pill } from "../ds/Pill";
import { StatusGlyph } from "../ds/StatusGlyph";
import { UsageMeter } from "../ds/UsageMeter";
import { keys } from "../keys/instance";
import { withQuery, type RouteQuery } from "../router";
import { ActionButton } from "./ActionButton";
import { useQuery, useTaskContext } from "./task-shared";

const BAD_KINDS = new Set(["failed", "limit", "executor_down", "host_down"]);
const OFF_STATES = new Set(["down", "failing", "disabled", "blocked", "exhausted"]);
const gone = (item: AttentionItem) => (s: { snapshot: ClientSnapshot | null }) => !s.snapshot?.attention?.some(a => a.id === item.id && a.since === item.since);

function RepoFilter({ snapshot, query }: { snapshot: ClientSnapshot; query: RouteQuery }) {
  const byRepo = counts(snapshot)?.byRepo ?? {};
  const go = (repo: string | null) => { location.hash = withQuery(location.hash.split("?")[0] || "#/", { ...query, repo }); };
  const chip = (repo: string | null, label: string, n?: number) =>
    <button type="button" key={repo ?? "all"} className={`pc-chip${query.repo === repo ? " on" : ""}`} aria-pressed={query.repo === repo ? "true" : "false"} onClick={() => go(repo)}>{label}{n !== undefined && <> <span className="pc-chip__n">{n}</span></>}</button>;
  return <div className="pc-filter">
    <div className="pc-chips" role="group" aria-label="Repository filter" id="repo-filter">
      {chip(null, "All repos")}
      {repos(snapshot).map(r => chip(r.key, r.label, (byRepo[r.key]?.attention ?? 0) + (byRepo[r.key]?.running ?? 0)))}
    </div>
    <p className="muted">Budgets are shared across repos; the filter only narrows work.</p>
  </div>;
}

function NeedsYou({ snapshot, scope, runner, canDismiss }: { snapshot: ClientSnapshot; scope: Scope; runner: ActionRunner; canDismiss: boolean }) {
  const items = needsYou(snapshot, scope), others = otherReposNeedingYou(snapshot, scope);
  return <section className="pc-section" aria-labelledby="needs-you"><h2 id="needs-you">Needs you</h2>
    {items.map(item => <div key={item.id} className={`pc-attn${BAD_KINDS.has(item.kind) ? " pc-attn--bad" : ""}`}>
      <StatusGlyph kind={BAD_KINDS.has(item.kind) ? "failed" : "waiting"} />
      {item.executor && <AgentMark agent={runnerAgent(item.executor)} size={20} labelled={false} />}
      <div className="grow"><div className="pc-attn__title">{item.title}</div><div className="muted">{item.detail}</div></div>
      <div className="row-actions">{item.actions.slice(0, 2).map((action, i) => <ActionButton key={i} runner={runner} id={`${item.id}:${i}`} action={action} confirmDone={gone(item)} strong={action.style === "primary"} />)}
        {canDismiss && <ActionButton runner={runner} id={`${item.id}:dismiss`} action={{ label: "Dismiss", op: "attention.dismiss", params: { id: item.id } }} confirmDone={gone(item)} />}</div>
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
  return <section className="pc-section" aria-labelledby="running"><h2 id="running">Running</h2>
    {rows.map(t => <div key={t.id} className="pc-row">
      {t.executor ? <AgentMark agent={runnerAgent(t.executor)} size={20} labelled={false} /> : <span className="pc-row__gap" />}
      <div className="grow pc-row__goal">{t.goal}</div>
      <span className="muted">{t.repo?.label}</span>
      <Pill tone={t.state === "queued" ? "neutral" : "info"}>{phaseWords(t.state === "queued" ? "queued" : t.progress?.phase ?? t.state)}</Pill>
      {t.state === "queued"
        ? <><span className="muted">{t.queue?.reason === "no_slot" ? "waiting for a slot" : "queued"}</span><ActionButton runner={runner} id={`${t.id}:stop`} action={{ label: "Stop", op: "task.stop", params: { id: t.id } }} confirmDone={s => !s.snapshot?.tasks.some(x => x.id === t.id && x.state === "queued")} /></>
        : <>{t.attemptStartedAt && <span className="muted">{elapsed(now - t.attemptStartedAt)}</span>}
          {t.progress && <span className="muted">{t.progress.files} files · {t.progress.commits} commits</span>}
          {lastOutput(t, now)}<a className="pc-btn pc-btn--secondary pc-btn--sm" href={`#/sessions/${encodeURIComponent(t.id)}`}>Watch</a></>}
    </div>)}
    {!rows.length && <p className="muted">Nothing running. Delegate a task, or ask your planner to.</p>}
  </section>;
}

function Capacity({ snapshot }: { snapshot: ClientSnapshot }) {
  const rows = capacity(snapshot), c = counts(snapshot);
  return <section className="pc-section" aria-labelledby="capacity"><div className="row"><h2 id="capacity">Capacity</h2>{c && <span className="muted">{c.ready}/{c.executors} executors ready</span>}</div>
    {rows.map(e => <a key={e.id} href="#/settings/executors" className={`pc-row pc-cap${OFF_STATES.has(e.state) ? " pc-cap--off" : ""}`}>
      <AgentMark agent={e.agent} size={20} labelled={false} />
      <div className="pc-cap__name"><div>{executorLabel(e.id)}</div><div className={OFF_STATES.has(e.state) ? "pc-bad-text" : "muted"}>{OFF_STATES.has(e.state) && e.reason ? e.reason : e.sub}</div></div>
      <div className="grow"><UsageMeter used={e.usedPct} pace={e.pacePct} paceReason={e.paceReason} tone={toneFor(e.tone)} size="row" text="none" label={`${executorLabel(e.id)} usage`} /></div>
      <span className="muted pc-num">{e.usedPct === null ? "—" : `${Math.round(e.usedPct)}%`}</span>
      <span className="muted pc-num">{e.slots.used}/{e.slots.max}</span>
    </a>)}
    {!rows.length && <p className="muted">No executors yet. <a href="#/settings/add-executor">Add one.</a></p>}
  </section>;
}

function DoneToday({ snapshot, scope, now }: { snapshot: ClientSnapshot; scope: Scope; now: number }) {
  const rows = doneToday(snapshot, scope), today = snapshot.today;
  return <section className="pc-section" aria-labelledby="done-today"><div className="row"><h2 id="done-today">Done today</h2>{today && <span className="muted">{today.done} · {today.accepted} accepted</span>}</div>
    {rows.map(t => { const status = taskStatus(t); return <div key={t.id} className="pc-row">
      <span className="muted pc-num">{clock(t.updatedAt, now)}</span><div className="grow pc-row__goal">{t.goal}</div>
      <span className="muted">{t.repo?.label}</span><span className="muted">{executorLabel(t.executor)}</span><Pill tone={status.tone}>{status.label}</Pill>
    </div>; })}
    {!rows.length && <p className="muted">Nothing finished yet today.</p>}
  </section>;
}

function Activity({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  return <section className="pc-section" aria-labelledby="activity"><h2 id="activity">Activity</h2>
    {entries.slice(0, 20).map(e => <div key={e.id} className="pc-row pc-activity"><span className="muted pc-num">{clock(e.at, now)}</span><span className={`pc-dot pc-dot--${e.level}`} aria-label={e.level} /><span className="grow">{e.text}</span></div>)}
    {!entries.length && <p className="muted">No activity yet.</p>}
  </section>;
}

export interface OverviewProps { snapshot: ClientSnapshot; query: RouteQuery; now: number; runner: ActionRunner; activity: ActivityEntry[]; ops: ReadonlySet<string> }
/** Needs you → Running → Capacity → Done today → Activity. Everything here is the service's data, filtered by repo. */
export function OverviewView({ snapshot, query, now, runner, activity, ops }: OverviewProps) {
  const scope: Scope = { repo: query.repo };
  return <div className="pc-overview">
    <RepoFilter snapshot={snapshot} query={query} />
    <NeedsYou snapshot={snapshot} scope={scope} runner={runner} canDismiss={ops.has("attention.dismiss")} />
    <Running snapshot={snapshot} scope={scope} now={now} runner={runner} />
    <Capacity snapshot={snapshot} />
    <DoneToday snapshot={snapshot} scope={scope} now={now} />
    <Activity entries={activity} now={now} />
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
  if (!state.snapshot) return null;
  return <OverviewView snapshot={state.snapshot} query={query} now={Date.now() / 1000} runner={runner} activity={activity} ops={state.features.ops} />;
}

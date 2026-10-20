import { executorEligibility } from "../../../src/view-model/capacity";
import { ListRow, ListRowLink, EmptyState } from "../ds/Patterns";
import { ButtonLink, TextAction } from "../ds/Button";
import { displayTitle } from "../../../src/view-model/titles";
import { SetupBanner } from "./setup/SetupBanner";
import { executorPace, queueWait } from "../../../src/view-model/capacity";
import { SectionHeading } from "../ds/SectionHeading";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { ActivityEntry, AttentionItem } from "../../../src/api/read-model/types";
import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { ago, clock, elapsed } from "../../../src/view-model/time";
import { meterText } from "../../../src/view-model/format";
import { capacity, counts, doneToday, needsYou, otherReposNeedingYou, plannerMeter, running, type Scope } from "../../../src/view-model/selectors";
import type { ClientSnapshot, ClientTask } from "../../../src/view-model/snapshot";
import { attentionStatus, executorLabel, executorStatus, paceStatus, taskStatus } from "../../../src/view-model/words";
import { useActions } from "../data/action-context";
import type { ActionRunner } from "../data/actions";
import { AgentMark } from "../ds/AgentMark";
import { Kbd } from "../ds/Kbd";
import { StatusPill } from "../ds/StatusPill";
import { StatusGlyph } from "../ds/StatusGlyph";
import { UsageMeter } from "../ds/UsageMeter";
import { overviewHints } from "../keys/registry";
import { keys } from "../keys/instance";
import { activeRepo, NarrowContext, useNarrow } from "../shell/narrow";
import { withQuery, type RouteQuery } from "../router";
import { ActionButton } from "./ActionButton";
import { BulkReview, ReviewCheckbox } from "./review/BulkReview";
import { QuickDelegate } from "./QuickDelegate";
import { repoChoices, RepoFilter } from "./RepoFilter";
import { useQuery, useTaskContext } from "./task-shared";

const OFF_STATES = new Set(["down", "failing", "disabled", "blocked", "exhausted"]);
const gone = (item: AttentionItem) => (s: { snapshot: ClientSnapshot | null }) => !s.snapshot?.attention?.some(a => a.id === item.id && a.since === item.since);

/** Older services put the full goal in attention.title; reuse their task title in that case. */
function attentionTitle(item: AttentionItem, snapshot: ClientSnapshot): string {
  const task = snapshot.tasks.find(task => task.id === item.taskId);
  return task?.fullTitle ?? (item.title === task?.goal ? displayTitle(task) : item.title);
}

function NeedsYou({ snapshot, scope, runner, now, query, narrow }: { snapshot: ClientSnapshot; scope: Scope; runner: ActionRunner; now: number; query: RouteQuery; narrow: boolean }) {
  const items = needsYou(snapshot, scope), others = otherReposNeedingYou(snapshot, scope);
  const otherRepos = others > 0 ? <TextAction className="pc-text-action" href={withQuery("#/", { ...query, repo: "" })}>+{others} in other repos</TextAction> : null;
  const reviewQueue = <TextAction className="pc-text-action" href={withQuery("#/review", { ...query, repo: scope.repo ?? query.repo })}>Open review queue</TextAction>;
  return <section className="pc-section" aria-labelledby="needs-you"><div className="pc-section__head"><SectionHeading id="needs-you">Needs you</SectionHeading>{items.length > 0 && <span className="pc-count pc-count--warn">{items.length}</span>}<span className="grow" />{narrow && otherRepos ? otherRepos : reviewQueue}</div>
    <BulkReview key={scope.repo ?? "all"} snapshot={snapshot} repo={scope.repo} runner={runner}>
    {items.map(item => { const status = attentionStatus(item, snapshot.tasks); return <ListRow key={item.id} tabIndex={0} data-attention-id={item.id} className={`pc-attn${status.tone === "bad" ? " pc-attn--bad" : ""}`}
      leading={<><ReviewCheckbox item={item} /><span className={`pc-status--${status.tone}`}><StatusGlyph status={status} />{status.label}</span>{item.executor && <AgentMark agent={markAgent(item.executor)} size={20} labelled={false} />}</>}
      content={<><div className="pc-attn__title"><span className="pc-ellipsis grow" title={attentionTitle(item, snapshot)}>{attentionTitle(item, snapshot)}</span>{item.repo && <code className="pc-repo-chip" title={item.repo.label}>{item.repo.label}</code>}</div><div className="muted">{item.detail} · {clock(item.raisedAt, now)}</div></>}
      actions={item.actions.slice(0, 2).map((action, i) => <ActionButton key={i} runner={runner} id={`${item.id}:${i}`} action={action} confirmDone={gone(item)} />)}
    />; })}
    </BulkReview>
    {!items.length && <EmptyState title="Nothing needs you." />}
    {narrow && otherRepos ? reviewQueue : otherRepos}
  </section>;
}

function lastOutput(t: ClientTask, now: number) {
  // The service decides when a task is idle (its stuck threshold) and says so in the phase.
  if (t.progress?.phase === "idle" && t.progress.lastOutputAt) return <span className="pc-warn-text">idle {elapsed(now - t.progress.lastOutputAt)}</span>;
  return t.progress?.lastOutputAt ? <span className="muted">output {ago(t.progress.lastOutputAt, now)}</span> : null;
}
/** Running comes from the service counts; queued rows shown in the same list are counted separately. */
function runningCount(snapshot: ClientSnapshot, scope: Scope, rows: ClientTask[]): string {
  const c = counts(snapshot), n = (scope.repo === null ? c?.running : c?.byRepo[scope.repo]?.running) ?? rows.filter(t => t.state === "running").length;
  const queued = rows.filter(t => t.state === "queued").length;
  return queued ? `${n} · ${queued} queued` : String(n);
}
function Running({ snapshot, scope, now, runner, query }: { snapshot: ClientSnapshot; scope: Scope; now: number; runner: ActionRunner; query: RouteQuery }) {
  const rows = running(snapshot, scope);
  return <section className="pc-card-section" aria-labelledby="running"><div className="pc-card-section__head"><SectionHeading id="running">Running</SectionHeading><span className="muted">{runningCount(snapshot, scope, rows)}</span></div>
    {rows.map(t => <ListRow key={t.id}
      leading={t.executor ? <AgentMark agent={markAgent(t.executor)} size={20} labelled={false} /> : <span className="pc-row__gap" />}
      content={<strong className="pc-ellipsis" title={displayTitle(t)}>{displayTitle(t)}</strong>}
      meta={<><span>{t.repo?.label}</span><StatusPill status={taskStatus(t)} />{t.state === "queued" ? <span>{queueWait(t, snapshot)}</span> : <>{t.attemptStartedAt && <span>running for {elapsed(now - t.attemptStartedAt)}</span>}{t.progress && <span>{t.progress.files} files · {t.progress.commits} commits</span>}{lastOutput(t, now)}</>}</>}
      actions={t.state === "queued"
        ? <ActionButton runner={runner} id={`${t.id}:stop`} action={{ label: "Stop", op: "task.stop", params: { id: t.id } }} confirmDone={s => !s.snapshot?.tasks.some(x => x.id === t.id && x.state === "queued")} />
        : <><ButtonLink size="sm" href={withQuery(`#/sessions/${encodeURIComponent(t.id)}`, query)}>Watch</ButtonLink><ActionButton runner={runner} id={`${t.id}:takeover`} action={{label:"Take over",op:"task.takeover",params:{id:t.id}}}/></>}
    />)}
    {!rows.length && <EmptyState title="Nothing running. Delegate a task, or ask your planner to." />}
  </section>;
}

function Capacity({ snapshot, narrow, query }: { snapshot: ClientSnapshot; narrow: boolean; query: RouteQuery }) {
  const rows = capacity(snapshot), c = counts(snapshot);
  const next = rows.find(e => e.next), down = rows.filter(e => e.state === "down" || e.state === "failing").length;
  return <section className="pc-card-section" aria-labelledby="capacity"><div className="pc-card-section__head"><SectionHeading id="capacity">Capacity</SectionHeading>{!narrow && c && <span className="muted">{c.ready}/{c.executors} executors ready</span>}<span className="grow" />{narrow && next ? <span className="muted">next: <b>{executorLabel(next.id)}</b></span> : <TextAction className="pc-text-action" href={withQuery("#/settings/executors", query)}>Details</TextAction>}</div>
    <div className={narrow ? "pc-capacity--compact" : "pc-capacity"}>{rows.map(e => <ListRowLink key={e.id} aria-label={narrow ? `${executorLabel(e.id)} · ${executorEligibility(e, snapshot.at).label}${e.reason ? ` · ${e.reason}` : ""}` : undefined} href={withQuery("#/settings/executors", query)} className={`pc-row pc-cap${OFF_STATES.has(e.state) ? " pc-cap--off" : ""}`}>
      <AgentMark agent={markAgent(e.id, e.account)} size={20} labelled={false} />
      {narrow && <span className={`pc-cap__dot pc-cap__dot--${executorEligibility(e, snapshot.at).tone}`} />}
      <div className="pc-cap__name"><div>{executorLabel(e.id)}</div><StatusPill status={executorEligibility(e, snapshot.at)} /><div className="muted" title={[executorEligibility(e, snapshot.at).detail, executorEligibility(e, snapshot.at).age].filter(Boolean).join(" · ")}>{executorEligibility(e, snapshot.at).detail}{executorEligibility(e, snapshot.at).age ? ` · ${executorEligibility(e, snapshot.at).age}` : ""}</div><div className="muted"><StatusGlyph status={executorPace(e, snapshot)} />{executorPace(e, snapshot).label}{e.reason || e.paceReason ? ` · ${e.reason ?? e.paceReason}` : ""}</div></div>
      <div><UsageMeter used={e.usedPct} pace={e.pacePct} paceReason={e.paceReason} tone={executorPace(e, snapshot).tone} size="row" text="none" label={`${executorLabel(e.id)} usage`} /></div>
      <span className="muted pc-num">{e.usedPct === null ? "—" : `${Math.round(e.usedPct)}%`}</span>
      <span className="muted pc-num" aria-label={`${e.slots.used} of ${e.slots.max} parallel tasks`}>{e.slots.used}/{e.slots.max}</span>
    </ListRowLink>)}{narrow && <span className="muted">{c?.ready ?? 0} ready · {down} down</span>}</div>
    {!rows.length && <p className="muted">No executors yet. <TextAction className="pc-text-action" href={withQuery("#/settings/add-executor", query)}>Add one.</TextAction></p>}
  </section>;
}

function DoneToday({ snapshot, scope, now, query }: { snapshot: ClientSnapshot; scope: Scope; now: number; query: RouteQuery }) {
  const rows = doneToday(snapshot, scope), today = snapshot.today;
  const done = scope.repo === null ? today?.done : today?.byRepo[scope.repo] ?? rows.length;
  const accepted = scope.repo === null ? today?.accepted : rows.filter(t => t.review?.accepted).length;
  return <section className="pc-card-section" aria-labelledby="done-today"><div className="pc-card-section__head"><SectionHeading id="done-today">Done today</SectionHeading>{today && <span className="muted">{done} · {accepted} accepted</span>}<span className="grow" /><TextAction className="pc-text-action" href={withQuery("#/sessions", query)}>All tasks</TextAction></div>
    {rows.map(t => <ListRow key={t.id} leading={<span className="muted pc-num">{clock(t.updatedAt, now)}</span>}
      content={<strong className="pc-ellipsis" title={displayTitle(t)}>{displayTitle(t)}</strong>}
      meta={<><span>{t.repo?.label}</span><span>{executorLabel(t.executor)}</span><StatusPill status={taskStatus(t)} /></>}
    />)}
    {!rows.length && <EmptyState title="Nothing finished yet today." />}
  </section>;
}

function Activity({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  return <section className="pc-card-section" aria-labelledby="activity"><div className="pc-card-section__head"><SectionHeading id="activity">Activity</SectionHeading></div>
    {entries.slice(0, 20).map(e => <ListRow key={e.id} className="pc-activity" leading={<><span className="muted pc-num">{clock(e.at, now)}</span><span className={`pc-dot pc-dot--${e.level}`} role="img" aria-label={e.level === "error" ? "Error" : e.level === "warn" ? "Warning" : "Information"} /></>} content={e.text} />)}
    {!entries.length && <EmptyState title="No activity yet." />}
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
      <div className="row"><SectionHeading as="span">Planner · {name}</SectionHeading><span className="pc-planner-strip__advice">{p.advice}</span></div>
      {p.usedPct !== null && <div className="row"><div className="grow"><UsageMeter used={p.usedPct} pace={p.pacePct} tone={paceStatus(p.verdict).tone} verdict={p.verdict} size="bar" text="none" label={`${name} planner usage`} stale={p.stale} staleAt={snapshot.at} now={now} /></div><span className="muted">{meterText(p.usedPct, p.pacePct, "full")}{extra ? ` · ${extra}` : ""}</span></div>}
    </div>
    <div className="pc-stats">{stat(c?.attention, "need you", true)}{stat(c?.running, "running")}{stat(snapshot.today?.done, "done today")}{stat(`${c?.ready ?? 0}/${c?.executors ?? 0}`, "executors ready")}</div>
  </section>;
}
function KeysFooter({ version }: { version?: string }) {
  return <footer className="pc-keys-footer muted">{overviewHints.map((hint, i) => <span key={hint.keys}>{i > 0 && " · "}<Kbd>{hint.keys === "Enter" ? "⏎" : hint.keys}</Kbd> {hint.label}</span>)}<span className="grow" /><span>pacer {version ?? "version unknown"}</span></footer>;
}

export interface OverviewProps { snapshot: ClientSnapshot; query: RouteQuery; now: number; runner: ActionRunner; activity: ActivityEntry[]; ops: ReadonlySet<string>; quickDelegate?: ComponentChildren }
/** Shared Main / Panel tree; CSS places Capacity alongside work on desktop. */
export function OverviewView({ snapshot, query, now, runner, activity, ops, quickDelegate }: OverviewProps) {
  const narrow = useNarrow(query);
  const scope: Scope = { repo: narrow ? activeRepo(query) : query.repo || null };
  return <NarrowContext.Provider value={narrow}><div className={`pc-overview${narrow ? " pc-overview--narrow" : ""}`}>
    <SetupBanner />
    {!narrow && <PlannerStrip snapshot={snapshot} now={now} />}
    <RepoFilter snapshot={snapshot} query={query} narrow={narrow} />
    <div className="pc-overview__cols">
      <div className="pc-overview__main">
        <NeedsYou snapshot={snapshot} scope={scope} runner={runner} now={now} query={query} narrow={narrow} />
        <Running snapshot={snapshot} scope={scope} now={now} runner={runner} query={query} />
        <Capacity snapshot={snapshot} narrow={narrow} query={query} />
        <DoneToday snapshot={snapshot} scope={scope} now={now} query={query} />
      </div>
      <div className="pc-overview__side" hidden={narrow}>
        {!narrow && <section className="pc-card-section" aria-labelledby="quick-delegate"><div className="pc-card-section__head"><SectionHeading id="quick-delegate">Quick delegate</SectionHeading></div><div className="pc-card-section__body">{quickDelegate}</div></section>}
        {!narrow && <Activity entries={activity} now={now} />}
      </div>
    </div>
    {!narrow && <KeysFooter version={snapshot.service?.version} />}
  </div></NarrowContext.Provider>;
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
      v: () => { const item = selected(); location.hash = withQuery(item?.taskId ? `#/review/${encodeURIComponent(item.taskId)}` : "#/review", current.current.query); },
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

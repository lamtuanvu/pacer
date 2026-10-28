import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../../../src/api/read-model/types";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { explainRepo, kpiTiles, needsYouCards, nextFromExplanation, queueReason, periodHeading, periodRange, PERIODS, plannerCaption, plannerPace, tokenSpread, type InsightsSummary, type KpiTile, type NeedsYouCard, type Period, type RouteExplanationView } from "../../../../src/view-model/dispatch";
import { executorPace } from "../../../../src/view-model/capacity";
import { eligibilityPresentation } from "../../../../src/view-model/eligibility";
import { capacity, counts, needsYou, otherReposNeedingYou, plannerMeter, type Scope } from "../../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../../src/view-model/snapshot";
import { scopedTaskTree, type TaskNodeView } from "../../../../src/view-model/task-tree";
import { ago, clock } from "../../../../src/view-model/time";
import { attentionStatus, executorLabel, paceStatus } from "../../../../src/view-model/words";
import { useActions } from "../../data/action-context";
import type { ActionRunner } from "../../data/actions";
import { AgentMark } from "../../ds/AgentMark";
import { Button, TextAction } from "../../ds/Button";
import { Icon, type IconName } from "../../ds/icons";
import { Kbd } from "../../ds/Kbd";
import { Pill } from "../../ds/Pill";
import { Page } from "../../ds/Page";
import { EmptyState, ListRow, ListRowLink, LoadingState, SegmentedControl } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { StackedShareBar } from "../../ds/StackedShareBar";
import { StatusGlyph } from "../../ds/StatusGlyph";
import { StatusPill } from "../../ds/StatusPill";
import { TaskCard } from "../../ds/TaskCard";
import { UsageMeter } from "../../ds/UsageMeter";
import { keys } from "../../keys/instance";
import { overviewHints } from "../../keys/registry";
import type { Account } from "../../model/accounts";
import type { Routing } from "../../model/home";
import { withQuery, type RouteQuery } from "../../router";
import { activeRepo, NarrowContext, useNarrow } from "../../shell/narrow";
import { ActionButton } from "../ActionButton";
import { useOverviewPage } from "../overview-page";
import { repoChoices, RepoFilter } from "../RepoFilter";
import { SetupBanner } from "../setup/SetupBanner";
import { StartWork } from "../StartSession";
import { useQuery, useTaskContext } from "../task-shared";

const gone = (item: AttentionItem) => (s: { snapshot: ClientSnapshot | null }) => !s.snapshot?.attention?.some(a => a.id === item.id && a.since === item.since);
const taskLink = (query: RouteQuery) => (id: string) => withQuery(`#/tasks/${encodeURIComponent(id)}`, query);

/** Expansion is kept by task id, so it survives snapshot refreshes and reordering. */
function useExpansion() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return { expanded: (id: string) => !!open[id], toggle: (id: string) => setOpen(previous => ({ ...previous, [id]: !previous[id] })) };
}
/**
 * The card's actions: one on Dispatch, as on the board, and both on the standalone Needs you page. A task failure's first action is
 * the primary; executor, host and setup problems keep secondary actions. An answer opens the task.
 */
function itemActions(item: AttentionItem, runner: ActionRunner, strong: boolean, count: 1 | 2) {
  return item.actions.slice(0, count).map((action, i) => <ActionButton key={i} runner={runner} id={`${item.id}:${i}`} strong={strong && i === 0}
    action={action.op === "task.answer" ? { label: action.label, op: "ui.open", params: { view: "task", id: item.taskId } } : action} confirmDone={gone(item)} />);
}

/** A compact Needs you card: glyph, title, one caption line and one action. Status words stay readable beside the glyph. */
function AttentionCard({ card, snapshot, runner, now, query, actions }: { card: NeedsYouCard; snapshot: ClientSnapshot; runner: ActionRunner; now: number; query: RouteQuery; actions: 1 | 2 }) {
  const item = card.kind === "task" ? card.items[0]! : card.item, bad = (card.kind === "task" ? card.node.attention : card.level) === "bad";
  const status = attentionStatus(item, snapshot.tasks), title = card.kind === "task" ? card.node.title : item.title;
  // The board's caption: the service's detail, then when it was raised.
  const caption = [item.detail, clock(item.raisedAt, now)].filter(Boolean).join(" · ");
  const more = card.kind === "task" && card.items.length > 1 ? ` · ${card.items.length - 1} more` : "";
  return <li data-attention-id={item.id} tabIndex={0} className="pc-dispatch-card">
    <ListRow className="pc-attn-card" outlined tone={bad ? "bad" : "warn"}
      leading={<StatusGlyph status={status} />}
      content={<><div className="pc-attn-card__title"><span className="sr-only">{status.label}: </span>{card.kind === "task"
        ? <TextAction className="pc-ellipsis" href={taskLink(query)(card.id)} title={title}>{title}</TextAction>
        : <span className="pc-ellipsis" title={title}>{title}</span>}</div>
        <div className="pc-attn-card__caption muted" title={caption}>{caption}{more}</div></>}
      actions={itemActions(item, runner, bad && card.kind === "task", actions)} />
  </li>;
}

/** Needs you as compact cards, most urgent first, one per root task; executor, host and setup items are cards of their own. */
export function NeedsYouList({ snapshot, scope, runner, now, query, narrow, standalone = false }: { snapshot: ClientSnapshot; scope: Scope; runner: ActionRunner; now: number; query: RouteQuery; narrow: boolean; standalone?: boolean }) {
  // The count is of items, like the activity bar and tray; one card can carry several items about the same task.
  const cards = needsYouCards(snapshot, scope, { now }), waiting = needsYou(snapshot, scope).length, others = otherReposNeedingYou(snapshot, scope);
  const page = useOverviewPage(cards, "Needs you", standalone ? Math.max(1, cards.length) : 5, scope.repo ?? "");
  const otherRepos = others > 0 ? <TextAction className="pc-text-action" href={withQuery(standalone ? "#/needs-you" : "#/", { ...query, repo: "" })}>+{others} in other repos</TextAction> : null;
  const all = <TextAction className="pc-text-action" href={withQuery("#/needs-you", { ...query, repo: scope.repo ?? query.repo })}>All open items</TextAction>;
  return <section className={standalone ? "pc-section" : "pc-section pc-dispatch-attention"} aria-labelledby="needs-you">
    <div className="pc-section__head">
      <SectionHeading id="needs-you">{standalone ? "Decisions and problems" : "Needs you"}</SectionHeading>
      {!standalone && waiting > 0 && <span className="pc-count pc-count--bad">{waiting}</span>}
      <span className="grow" />{standalone ? otherRepos : narrow && otherRepos ? otherRepos : all}
    </div>
    {cards.length > 0 && <ul className="pc-dispatch-cards pc-dispatch-cards--flush" aria-label="Needs you, most urgent first">
      {page.rows.map(card => <AttentionCard key={card.id} card={card} snapshot={snapshot} runner={runner} now={now} query={query} actions={standalone ? 2 : 1} />)}
    </ul>}
    {!cards.length && <EmptyState title="Nothing needs your attention" description={<TextAction href={withQuery("#/tasks", query)}>View Tasks</TextAction>} />}
    {!standalone && page.footer}
    {!standalone && narrow && otherRepos ? all : !standalone ? otherRepos : null}
  </section>;
}

const live = (node: TaskNodeView): boolean => node.active || node.children.some(live);
/** Running and queued work as compact task cards. Running comes from the service counts; queued is counted beside it. */
function LiveDispatch({ snapshot, scope, now, runner, query }: { snapshot: ClientSnapshot; scope: Scope; now: number; runner: ActionRunner; query: RouteQuery }) {
  const nodes = scopedTaskTree(snapshot, scope, { now }).filter(live);
  const page = useOverviewPage(nodes, "Live dispatch", 5, scope.repo ?? "");
  const expansion = useExpansion();
  const c = counts(snapshot);
  const byState = (state: string) => snapshot.tasks.filter(t => t.state === state && nodes.some(n => n.id === t.id)).length;
  const runningNow = (scope.repo === null ? c?.running : c?.byRepo[scope.repo]?.running) ?? byState("running"), queued = byState("queued");
  return <section className="pc-card-section" aria-labelledby="live-dispatch">
    <div className="pc-card-section__head"><SectionHeading id="live-dispatch">Live dispatch</SectionHeading>
      {nodes.length > 0 && <span className="muted">{runningNow} running{queued ? ` · ${queued} queued` : ""}</span>}</div>
    {nodes.length > 0 && <ul className="pc-dispatch-cards" aria-label="Running and queued work">{page.rows.map(node => {
      const task = snapshot.tasks.find(t => t.id === node.id);
      const actions = task?.state === "queued"
        ? <ActionButton runner={runner} id={`${node.id}:stop`} aria-label={`Stop ${node.title}`} action={{ label: "Stop", op: "task.stop", params: { id: node.id } }} confirmDone={s => !s.snapshot?.tasks.some(x => x.id === node.id && x.state === "queued")} />
        : task?.state === "running" ? <ActionButton runner={runner} id={`${node.id}:takeover`} aria-label={`Take over ${node.title}`} action={{ label: "Take over", op: "task.takeover", params: { id: node.id } }} /> : null;
      return <li key={node.id}><TaskCard node={node} density="compact" expanded={expansion.expanded(node.id)} onToggle={expansion.toggle} href={taskLink(query)} actions={actions} /></li>;
    })}</ul>}
    {!nodes.length && <EmptyState title="Nothing running" description="Start work, delegate a task, or ask your planner to." />}
    {page.footer}
  </section>;
}

/**
 * The dispatcher's current answer for new work, from the same routing preview the delegate forms show.
 * `explain` is the dispatcher's own explanation (`dispatch.explain`) when the service has it and a repository is known;
 * it names the ladder step and the chain. Readiness still comes from the preview.
 */
export interface RoutingPreview { data?: Routing; loading: boolean; error?: unknown; explain?: RouteExplanationView }

/** The planner half: the one place on Dispatch that states the planner's budget (UI-15); the status bar shows only its mark here. */
function PlannerHalf({ snapshot, now, shortWindowPct }: { snapshot: ClientSnapshot; now: number; shortWindowPct?: number | null }) {
  const p = plannerMeter(snapshot);
  if (!p) return null;
  const name = agentInfo(p.agent).name, pace = paceStatus(p.verdict), words = plannerPace(p.verdict), caption = plannerCaption(p, now, shortWindowPct);
  return <div className="pc-dispatch-split__half" id="planner-budget" aria-label="Planner budget" role="group">
    <div className="pc-dispatch-who"><AgentMark agent={p.agent} size={20} labelled={false} /><strong title={name}>{name}</strong><Pill tone="info">Planner</Pill><StatusPill status={{ ...pace, label: words.label }} /></div>
    {p.advice && <p className="pc-dispatch-advice">{p.advice}</p>}
    {p.usedPct !== null && <UsageMeter used={p.usedPct} pace={p.pacePct} tone={pace.tone} verdict={p.verdict} size="bar" label={`${name} ${p.window ? `${p.window} ` : ""}usage`} stale={p.stale} staleAt={snapshot.at} now={now} />}
    {caption && <span className="muted">{caption}</span>}
  </div>;
}

/** The next-task half: who takes new work, then the chain after it, ending in the queue. */
function NextHalf({ routing, query, strategy, now }: { routing: RoutingPreview; query: RouteQuery; strategy: string | null; now: number }) {
  const ranked = Array.isArray(routing.data?.ranked) ? routing.data!.ranked : [];
  const explained = routing.explain ? nextFromExplanation(routing.explain) : null;
  // With an explanation the dispatcher's own pick and chain win; the preview only supplies readiness.
  const nextId = routing.explain ? explained?.next : ranked[0]?.id;
  const chain = routing.explain ? explained?.then ?? [] : ranked.slice(1).map(row => row.id);
  const then = chain.slice(0, 3), more = chain.length - then.length;
  const row = ranked.find(r => r.id === nextId);
  const readiness = row ? eligibilityPresentation(row.eligibility, now) : null;
  const shown = routing.explain?.strategy.name ?? strategy;
  const waits = routing.explain && !explained ? queueReason(routing.explain, now) : null;
  const chevron = <span className="pc-dispatch-chain__sep"><Icon name="chevron-right" /></span>;
  return <div className="pc-dispatch-split__half pc-dispatch-split__half--page" role="group" aria-labelledby="next-task">
    <span className="pc-dispatch-label" id="next-task">Next task goes to</span>
    {routing.loading && !routing.data ? <span className="muted">Checking routing…</span>
      : routing.error ? <span className="muted">Could not check routing. It is checked again on the next update.</span>
      : nextId && (readiness || explained) ? <>
        <div className="pc-dispatch-next"><AgentMark agent={markAgent(nextId)} size={32} labelled={false} />
          <div className="pc-dispatch-next__who"><strong>{executorLabel(nextId)}</strong>{/* The step says why this agent; an uncertain readiness keeps its detail on the next line. */}{explained?.step && <span className="muted">{explained.step}</span>}{readiness && readiness.tone !== "good" && readiness.detail ? <span className="muted">{readiness.detail}</span> : explained?.step ? null : routing.data?.policy ? <span className="muted">Project order for this repository</span> : null}</div>
          {readiness && <StatusPill status={readiness} />}</div>
        {routing.explain?.outcome !== "fail" && <div className="pc-dispatch-chain"><span className="muted">Then:</span><ol aria-label="Then, in order">
          {then.map(id => <li key={id}><span className="pc-dispatch-chip"><AgentMark agent={markAgent(id)} size={18} labelled={false} />{executorLabel(id)}</span>{chevron}</li>)}
          {more > 0 && <li><span className="muted">+{more} more</span>{chevron}</li>}
          <li><span className="pc-dispatch-chip pc-dispatch-chip--queue"><span className="pc-dispatch-chip__tile" aria-hidden="true">Q</span>Queue</span></li>
        </ol></div>}
      </> : <span className="muted">{routing.explain?.outcome === "fail" ? "No agent can take new work now, and new tasks are refused rather than queued." : "No agent can take new work now. It waits in the queue."}{waits ? ` ${waits}` : ""}{routing.explain?.outcome === "fail" ? " Change the strategy or make an agent available to accept new tasks." : ""}</span>}
    <TextAction className="pc-text-action" href={withQuery("#/settings/dispatcher", query)}>{shown ? `Strategy: ${shown} · change` : "Change strategy"}</TextAction>
  </div>;
}

/** Planner budget and the next decision as one split section, as on the board. */
function PlannerAndNext({ snapshot, now, routing, query, shortWindowPct }: { snapshot: ClientSnapshot; now: number; routing: RoutingPreview | null; query: RouteQuery; shortWindowPct?: number | null }) {
  const planner = <PlannerHalf snapshot={snapshot} now={now} shortWindowPct={shortWindowPct} />;
  if (!plannerMeter(snapshot) && !routing) return null;
  return <section className="pc-dispatch-split" aria-label="Planner budget and next decision">
    {planner}{routing && <NextHalf now={now} routing={routing} query={query} strategy={snapshot.mode?.strategy ?? null} />}
  </section>;
}

/** Narrow layouts hide the status bar, so executor usage and pace stay reachable here (desktop keeps them in the status bar). A stale reading says so. */
function AgentUsage({ snapshot, query }: { snapshot: ClientSnapshot; query: RouteQuery }) {
  const rows = capacity(snapshot).filter(row => row.rank !== "planner");
  if (!rows.length) return null;
  return <section className="pc-card-section" aria-labelledby="agent-usage">
    <div className="pc-card-section__head"><SectionHeading id="agent-usage">Executors</SectionHeading></div>
    <ul className="pc-dispatch-agents">{rows.map(row => {
      // Pace words come from the shared vocabulary, including "Historical usage" for a stale reading (UI-10).
      const pace = executorPace(row, snapshot), usage = row.usedPct === null ? "usage unknown" : `${Math.round(row.usedPct)}% used`;
      return <li key={row.id}><ListRowLink className="pc-dispatch-agent" href={withQuery("#/settings/executors", query)} aria-label={`${executorLabel(row.id)} · ${usage} · ${pace.label}`}>
        <AgentMark agent={markAgent(row.id, row.account)} size={20} labelled={false} /><span className="pc-dispatch-agent__name">{executorLabel(row.id)}</span>
        <span className="pc-num">{usage}</span><StatusPill status={pace} />
      </ListRowLink></li>;
    })}</ul>
  </section>;
}

/** `insights.summary` for the period (which carries the period before it) and for today. */
export interface InsightsState { supported: boolean; loading: boolean; error?: unknown; current?: InsightsSummary; today?: InsightsSummary }

const KPI_ICON: Record<KpiTile["id"], IconName> = { handled: "stack", tokens: "bolt", outside: "fork", accepted: "check-circle" };
const KPI_TONE: Record<KpiTile["id"], string> = { handled: "info", tokens: "neutral", outside: "good", accepted: "good" };
/** The at-a-glance strip, named by `aria-label` as on the board. Figures come only from `insights.summary`; without it the strip says why, never a zero or a dash. */
function Glance({ period, insights }: { period: Period; insights: InsightsState }) {
  const tiles = insights.current ? kpiTiles(insights.current, period, { today: insights.today ?? null }) : [];
  return <section className="pc-glance-strip" aria-label={periodHeading(period)} id="glance">
    {tiles.length ? <ul className="pc-glance" role="list">{tiles.map(tile => <li key={tile.id} className="pc-glance__tile">
      <span className={`pc-glance__icon pc-glance__icon--${KPI_TONE[tile.id]}`}><Icon name={KPI_ICON[tile.id]} /></span>
      <div className="pc-glance__body"><span className="pc-glance__label">{tile.label}</span><span className="pc-glance__value">{tile.value}</span>
      {(tile.delta || tile.note) && <span className="pc-glance__note">{tile.delta && <span className={`pc-glance__delta pc-glance__delta--${tile.delta.tone}`}>{tile.delta.text}</span>}{tile.delta && tile.note ? " " : ""}{tile.note}</span>}</div>
    </li>)}</ul>
      : <p className="pc-glance-strip__state muted">{!insights.supported ? "These figures need a newer pacer service with task insights."
        : insights.loading ? <LoadingState label="Loading figures…" />
        : "Could not load these figures. They are checked again on the next update."}</p>}
  </section>;
}

/** Where the tokens went, as a share bar and table by agent. Hidden until token accounting measures something. */
function TokenShare({ summary, planner }: { summary?: InsightsSummary; planner: string | null }) {
  const spread = tokenSpread(summary, planner);
  if (!spread) return null;
  return <section className="pc-card-section pc-dispatch-spread" aria-labelledby="token-share">
    <div className="pc-card-section__head"><SectionHeading id="token-share">Where the tokens went</SectionHeading></div>
    <div className="pc-card-section__body pc-dispatch-budget"><span className="muted">{spread.caption}</span><StackedShareBar label="Token share" segments={spread.segments} />{spread.plannerNote && <span className="muted">{spread.plannerNote}</span>}</div>
  </section>;
}

/** The current time, ticking every second like the top bar's clock, so the update age counts up while the service is quiet. */
export function useTick(from: number): number {
  const [tick, setTick] = useState(from);
  useEffect(() => { const t = setInterval(() => setTick(Date.now() / 1000), 1000); return () => clearInterval(t); }, []);
  return Math.max(from, tick);
}

/** The page title with its live line, then the period, repos and the primary New task. New task opens Delegate until the New task composer lands. */
function DispatchHeader({ snapshot, query, narrow, period, onPeriod, connected, now }: { snapshot: ClientSnapshot; query: RouteQuery; narrow: boolean; period: Period; onPeriod?: (period: Period) => void; connected: boolean; now: number }) {
  const age = useTick(now);
  const agents = capacity(snapshot).filter(row => row.rank !== "planner" && row.usedPct !== null).length + (snapshot.planner ? 1 : 0);
  // The page line carries the update age, as on the board; the top bar drops its own on Dispatch (UI-15). No snapshot time, no age.
  const live = connected ? ["Live", agents ? `${agents} agent${agents === 1 ? "" : "s"} connected` : null, snapshot.at > 0 ? `updated ${ago(snapshot.at, age)}` : null].filter(Boolean).join(" · ") : "Reconnecting…";
  // The period only changes figures from task insights, so the switch shows only when the service has them.
  const controls = <div className="pc-dispatch__controls">
    {onPeriod && <SegmentedControl label="Period" value={period} options={PERIODS} onChange={value => onPeriod(value as Period)} />}
    {!narrow && <RepoFilter snapshot={snapshot} query={query} menu />}
    <Button variant="primary" onClick={() => window.dispatchEvent(new Event("pacer:delegate"))} aria-keyshortcuts="d">New task{!narrow && <> <Kbd>D</Kbd></>}</Button>
  </div>;
  const title = <div className="pc-dispatch__title"><h1>Dispatch</h1><span className="pc-dispatch__live muted"><span className={`pc-live-dot${connected ? "" : " pc-live-dot--off"}`} aria-hidden="true" />{live}</span></div>;
  // Phones keep the scope toggle on its own row; the controls follow on the next.
  return narrow ? <>{title}<RepoFilter snapshot={snapshot} query={query} narrow />{controls}</>
    : <header className="pc-dispatch__header">{title}{controls}</header>;
}

export interface DispatchProps {
  snapshot: ClientSnapshot; query: RouteQuery; now: number; runner: ActionRunner;
  /** The routing preview for new work; null when the service cannot preview routing. */
  routing?: RoutingPreview | null;
  period?: Period; onPeriod?: (period: Period) => void;
  insights?: InsightsState; startWork?: ComponentChildren;
  /** False while the service is not answering; the live line then says so. */
  connected?: boolean;
  /** The planner account's 5-hour window, when its reading reports one. */
  shortWindowPct?: number | null;
}
const dispatchScope = (query: RouteQuery, narrow: boolean): Scope => ({ repo: narrow ? activeRepo(query) : query.repo || null });
const NO_INSIGHTS: InsightsState = { supported: false, loading: false };
/** The Dispatch home in the board's order: planner budget and next task, the period's figures, tokens and Needs you, then live work. Phones lead with Needs you and live work. */
export function DispatchView({ snapshot, query, now, runner, routing = null, period = "7d", onPeriod, insights = NO_INSIGHTS, startWork, connected = true, shortWindowPct = null }: DispatchProps) {
  const narrow = useNarrow(query);
  const scope = dispatchScope(query, narrow);
  const plannerAndNext = <PlannerAndNext snapshot={snapshot} now={now} routing={routing} query={query} shortWindowPct={shortWindowPct} />;
  const glance = <Glance period={period} insights={insights} />, share = <TokenShare summary={insights.current} planner={snapshot.planner?.agent ?? null} />;
  const needs = <NeedsYouList snapshot={snapshot} scope={scope} runner={runner} now={now} query={query} narrow={narrow} />;
  const liveWork = <LiveDispatch snapshot={snapshot} scope={scope} now={now} runner={runner} query={query} />;
  return <NarrowContext.Provider value={narrow}><Page width="full" className={`pc-dispatch${narrow ? " pc-dispatch--narrow" : ""}`}>
    <SetupBanner />
    <DispatchHeader snapshot={snapshot} query={query} narrow={narrow} period={period} onPeriod={insights.supported ? onPeriod : undefined} connected={connected} now={now} />
    {narrow ? <>
      {/* Phones lead with what needs action; the figures and budgets follow. */}
      {needs}{liveWork}{plannerAndNext}<AgentUsage snapshot={snapshot} query={query} />{glance}{share}
    </> : <>
      {plannerAndNext}
      {glance}
      <div className="pc-dispatch__pair pc-dispatch__pair--wide">{share}{needs}</div>
      {liveWork}
    </>}
    {startWork}
  </Page></NarrowContext.Provider>;
}

function useAttentionKeys(query: RouteQuery) {
  const { state } = useTaskContext();
  const runner = useActions();
  const current = useRef({ snapshot: state.snapshot, query }); current.current = { snapshot: state.snapshot, query };
  useEffect(() => keys.register({ keys: "/", label: "Focus the repo filter", scope: "dispatch", run: () => document.querySelector<HTMLButtonElement>("#repo-filter button")?.focus() }), []);
  useEffect(() => {
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-attention-id]")];
    const move = (by: number) => { const all = rows(), at = all.indexOf(document.activeElement?.closest("[data-attention-id]") as HTMLElement); all[Math.max(0, Math.min(all.length - 1, at + by))]?.focus(); };
    const selected = () => current.current.snapshot?.attention?.find(a => a.id === (document.activeElement?.closest("[data-attention-id]") as HTMLElement)?.dataset.attentionId);
    const actions: Record<string, () => void> = {
      j: () => move(1), k: () => move(-1),
      Enter: () => { const active = document.activeElement as HTMLElement; (active?.tagName === "BUTTON" ? active as HTMLButtonElement : active?.closest("[data-attention-id]")?.querySelector("button"))?.click(); },
      v: () => { const item = selected(); location.hash = withQuery(item?.taskId ? `#/tasks/${encodeURIComponent(item.taskId)}` : "#/needs-you", current.current.query); },
      x: () => { const item = selected(); if (item && state.features.ops.has("attention.dismiss")) void runner.run(`${item.id}:dismiss`, { label: "Dismiss", op: "attention.dismiss", params: { id: item.id } }, gone(item)); },
    };
    const offs = overviewHints.flatMap(hint => hint.keys === "d" ? [] : (hint.keys === "1–4" ? ["1", "2", "3", "4"] : hint.keys.split(" ")).map(key => keys.register({ keys: key, label: hint.label, scope: "dispatch", run: actions[key] ?? (() => {
      const { snapshot, query } = current.current;
      const repo = snapshot && repoChoices(snapshot, query.repo).chips[Number(key) - 1];
      if (repo) location.hash = withQuery("#/", { ...query, repo: repo.key });
    }) })));
    return () => offs.forEach(off => off());
  }, [runner, state.features.ops]);
}

/** Re-anchor at least this often; settling or reviewing a task moves the anchor sooner. */
const REANCHOR_S = 300;
type Read = { op: string; params: unknown };
/**
 * The two reads behind the strip: the period, and today unless Today is the period. A read that is not needed asks `version.get`,
 * never `insights.summary` without a range. `to` is exclusive, so a range that starts at the anchor still covers one second.
 */
export function insightsReads(period: Period, anchor: number, repo: string | null, supported: boolean): { current: Read; today: Read } {
  const none: Read = { op: "version.get", params: {} };
  if (!supported) return { current: none, today: none };
  const range = periodRange(period, anchor);
  const read = (r: { from: number; to: number }): Read => ({ op: "insights.summary", params: { from: r.from, to: Math.max(r.to, r.from + 1), bucket: "day", ...(repo ? { repo } : {}) } });
  return { current: read(range), today: period === "today" ? none : read(range.today) };
}
export interface HeldInsights { key: string; current?: InsightsSummary; today?: InsightsSummary }
/**
 * Keeps the last figures for this period and repo while a moved range loads, so the strip neither blanks nor reflows;
 * figures from another period or repo are never shown.
 */
export function holdInsights(held: HeldInsights, period: Period, repo: string | null, current: { data?: InsightsSummary; loading: boolean; error?: unknown }, today: { data?: InsightsSummary }): { held: HeldInsights; state: InsightsState } {
  const key = `${period}|${repo ?? ""}`;
  const next: HeldInsights = held.key === key ? { ...held } : { key };
  if (current.data) next.current = current.data;
  if (today.data && period !== "today") next.today = today.data;
  const shown = current.data ?? next.current;
  return { held: next, state: { supported: true, loading: current.loading && !shown, error: shown ? undefined : current.error, current: shown, today: period === "today" ? undefined : today.data ?? next.today } };
}

function useInsights(period: Period, repo: string | null): InsightsState {
  const { state } = useTaskContext();
  const supported = state.features.ops.has("insights.summary");
  // The range ends at an anchor that moves when a task settles or is reviewed, and at least every five minutes, not on every render.
  const [anchor, setAnchor] = useState(() => Math.floor(Date.now() / 1000));
  const settled = state.snapshot?.tasks.filter(task => task.state !== "running" && task.state !== "queued").map(task => `${task.id}:${task.state}:${task.review?.accepted ?? ""}`).join(",") ?? "";
  useEffect(() => { setAnchor(Math.floor(Date.now() / 1000)); }, [settled]);
  useEffect(() => { const t = setInterval(() => setAnchor(Math.floor(Date.now() / 1000)), REANCHOR_S * 1000); return () => clearInterval(t); }, []);
  const reads = insightsReads(period, anchor, repo, supported);
  const current = useQuery<InsightsSummary>(reads.current.op, reads.current.params), today = useQuery<InsightsSummary>(reads.today.op, reads.today.params);
  const held = useRef<HeldInsights>({ key: "" });
  if (!supported) return NO_INSIGHTS;
  const result = holdInsights(held.current, period, repo, current, period === "today" ? {} : today);
  held.current = result.held;
  return result.state;
}

/** The planner account's 5-hour window from its own usage reading; nothing when the reading has none or is stale. */
export function plannerShortWindow(accounts: Account[] | undefined, runner: string | undefined): number | null {
  const account = runner ? accounts?.find(a => a.runners?.includes(runner)) : undefined;
  const window = account?.usageReading && !account.usageReading.stale ? account.usageReading.windows.find(w => w.name.toLowerCase() === "5h") : undefined;
  return window?.usedPct ?? null;
}

export function DispatchHome({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext();
  const runner = useActions();
  useAttentionKeys(query);
  const [period, setPeriod] = useState<Period>("7d");
  const supported = state.features.ops.has("routing.route"), scope = dispatchScope(query, useNarrow(query));
  // The explanation needs a repository and a goal; new work has no goal yet, so it asks about a generic one.
  const repo = explainRepo(scope.repo, state.snapshot?.repos);
  const canExplain = supported && state.features.ops.has("dispatch.explain") && repo !== null;
  const revision = JSON.stringify([state.snapshot?.executors?.map(e => [e.id, e.state]),
    state.snapshot?.tasks.filter(t => t.state === "running").length, state.snapshot?.tasks.filter(t => t.state === "queued").length]);
  const routing = useQuery<Routing>(supported ? "routing.route" : "version.get", supported && repo ? { repo } : {}, supported ? revision : "");
  const explain = useQuery<RouteExplanationView>(canExplain ? "dispatch.explain" : "version.get", canExplain ? { repo, goal: "New task" } : {}, revision);
  const accounts = useQuery<Account[]>(state.features.ops.has("account.list") ? "account.list" : "version.get", {});
  const insights = useInsights(period, scope.repo);
  if (!state.snapshot) return null;
  return <DispatchView snapshot={state.snapshot} query={query} now={Date.now() / 1000} runner={runner} routing={supported ? { ...routing, ...(canExplain && explain.data && !explain.error ? { explain: explain.data } : {}) } : null}
    period={period} onPeriod={setPeriod} insights={insights} connected={state.connected}
    shortWindowPct={Array.isArray(accounts.data) ? plannerShortWindow(accounts.data, state.snapshot.planner?.runner) : null} startWork={<StartWork />} />;
}

export function NeedsYouPage({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext(), runner = useActions();
  if (!state.snapshot) return null;
  return <Page width="full"><RepoFilter snapshot={state.snapshot} query={query} /><NeedsYouList snapshot={state.snapshot} scope={{ repo: query.repo || null }} runner={runner} now={Date.now() / 1000} query={query} narrow={false} standalone /></Page>;
}

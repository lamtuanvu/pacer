import { LazyWorkPanels } from "../../shell/panels/LazyWorkPanels";
import styles from "./dispatch.css" with { type: "text" };
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../../../src/api/read-model/types";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { explainRepo, explanationApplies, kpiTiles, needsYouCards, nextFromExplanation, queueReason, periodHeading, periodRange, PERIODS, plannerBudget, plannerPace, tokenSpread, type InsightsSummary, type KpiTile, type NeedsYouCard, type Period, type RouteExplanationView } from "../../../../src/view-model/dispatch";
import { executorPace } from "../../../../src/view-model/capacity";
import { eligibilityPresentation } from "../../../../src/view-model/eligibility";
import { capacity, needsYou, otherReposNeedingYou, plannerMeter, type Scope } from "../../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../../src/view-model/snapshot";
import { scopedTaskTree, workTasks, type WorkRow } from "../../../../src/view-model/task-tree";
import { ago, clock } from "../../../../src/view-model/time";
import { attentionStatus, executorLabel, paceStatus } from "../../../../src/view-model/words";
import { useActions } from "../../data/action-context";
import type { ActionRunner } from "../../data/actions";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { Icon, type IconName } from "../../ds/icons";
import { Kbd } from "../../ds/Kbd";
import { Pill } from "../../ds/Pill";
import { Page } from "../../ds/Page";
import { EmptyState, ListRow, ListRowLink, LoadingState, SegmentedControl } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { StatusGlyph } from "../../ds/StatusGlyph";
import { StatusPill } from "../../ds/StatusPill";
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
import type { AgentDetection } from "../../../../src/install/detection";
import type { SetupChecklist } from "../../../../src/setup/checklist";
import { SetupContext } from "../setup/context";
import { SetupBanner } from "../setup/SetupBanner";
import { ErrorMessage, useAction, useDelayedBusy, useQuery, useTaskContext } from "../task-shared";

const styledDocuments = new WeakSet<Document>();
function useDispatchStyles() {
  useEffect(() => {
    if (styledDocuments.has(document)) return;
    const sheet = new CSSStyleSheet(); sheet.replaceSync(styles);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; styledDocuments.add(document);
  }, []);
}

const gone = (item: AttentionItem) => (s: { snapshot: ClientSnapshot | null }) => !s.snapshot?.attention?.some(a => a.id === item.id && a.since === item.since);
const taskLink = (query: RouteQuery) => (id: string) => withQuery(`#/tasks/${encodeURIComponent(id)}`, query);

/** Card actions retain scoped result links and open questions in the Answer panel. */
function itemActions(item: AttentionItem, runner: ActionRunner, strong: boolean, count: 1 | 2, query: RouteQuery) {
  return item.actions.slice(0, count).map((action, i) => {
    if (action.op === "task.answer") {
      return <TextAction key={i} href={withQuery(`#/needs-you?answer=${encodeURIComponent(item.taskId!)}`, query)}>{action.label}</TextAction>;
    }
    if (item.taskId && ((item.kind === "review" && i === 0) || /inspect|review|checks/i.test(action.label))) {
      return <TextAction key={i} href={withQuery(`#/tasks/${encodeURIComponent(item.taskId)}/${item.kind === "review" ? "review" : "failure"}`, query)}>{item.kind === "review" ? "Review result" : "Inspect failures"}</TextAction>;
    }
    return <ActionButton key={i} runner={runner} id={`${item.id}:${i}`} strong={strong && i === 0} action={action} confirmDone={gone(item)} />;
  });
}

/** A compact Needs you card: glyph, title, one caption line and one action. Status words stay readable beside the glyph. */
function AttentionCard({ card, snapshot, runner, now, query, actions, narrow = false }: { narrow?: boolean; card: NeedsYouCard; snapshot: ClientSnapshot; runner: ActionRunner; now: number; query: RouteQuery; actions: 1 | 2 }) {
  const item = card.kind === "task" ? card.items[0]! : card.item, bad = (card.kind === "task" ? card.node.attention : card.level) === "bad";
  const rawStatus = attentionStatus(item, snapshot.tasks), status = item.kind === "question" ? {...rawStatus,glyph:"◐"} : rawStatus, title = card.kind === "task" ? card.node.title : item.title;
  // The board's caption: the service's detail, then when it was raised.
  const caption = [item.detail, clock(item.raisedAt, now)].filter(Boolean).join(" · ");
  const more = card.kind === "task" && card.items.length > 1 ? ` · ${card.items.length - 1} more` : "";
  const destination = item.taskId && ["question", "failed", "review"].includes(item.kind) ? {
    label: item.kind === "question" ? "Answer" : item.kind === "failed" ? "Inspect failures" : "Review",
    href: item.kind === "question" ? `#/needs-you?answer=${encodeURIComponent(item.taskId)}` : `#/tasks/${encodeURIComponent(item.taskId)}/${item.kind === "failed" ? "failure" : "review"}`,
  } : null;
  if (narrow && destination) return <li data-attention-id={item.id} className="pc-dispatch-card"><ListRowLink className={`pc-narrow-attention pc-narrow-attention--${bad ? "bad" : item.kind === "review" ? "review" : "warn"}`} href={withQuery(destination.href, query)}><StatusGlyph status={item.kind === "review" ? { ...status, tone: "info", glyph: "●" } : status} /><span className="pc-dispatch-decision__task"><strong className="pc-ellipsis" title={title}>{title}</strong><span className="pc-attn-card__caption muted" title={caption}>{caption}</span></span><span className="pc-narrow-attention__action">{item.kind === "failed" ? "Inspect" : destination.label}</span></ListRowLink></li>;
  return <li data-attention-id={item.id} tabIndex={0} className="pc-dispatch-card">
    <ListRow className={`pc-attn-card${actions === 1 && item.kind === "review" ? " pc-attn-card--review" : ""}`} outlined tone={bad ? "bad" : actions === 1 && item.kind === "review" ? undefined : "warn"}
      leading={<StatusGlyph status={actions === 1 && item.kind === "review" ? { ...status, tone: "info", glyph: "●" } : status} />}
      content={<div className={actions === 1 ? "pc-dispatch-attention-copy" : undefined}><div className="pc-attn-card__title"><span className="sr-only">{status.label}: </span>{card.kind === "task"
        ? <TextAction className="pc-ellipsis" href={taskLink(query)(card.id)} title={title}>{title}</TextAction>
        : <span className="pc-ellipsis" title={title}>{title}</span>}</div>
        <div className="pc-attn-card__caption muted" title={caption}>{caption}{more}</div></div>}
      actions={actions === 1 && destination ? <ButtonLink size="sm" variant={item.kind === "failed" ? "primary" : "secondary"} href={withQuery(destination.href, query)}>{destination.label}</ButtonLink> : itemActions(item, runner, bad && card.kind === "task", actions, query)} />
  </li>;
}

/** Needs you as compact cards, most urgent first, one per root task; executor, host and setup items are cards of their own. */
export function NeedsYouList({ snapshot, scope, runner, now, query, narrow, standalone = false }: { snapshot: ClientSnapshot; scope: Scope; runner: ActionRunner; now: number; query: RouteQuery; narrow: boolean; standalone?: boolean }) {
  // The count is of items, like the activity bar and tray; one card can carry several items about the same task.
  const cards = needsYouCards(snapshot, scope, { now }), waiting = needsYou(snapshot, scope).length, others = otherReposNeedingYou(snapshot, scope);
  const page = useOverviewPage(cards, "Needs you", standalone ? Math.max(1, cards.length) : 3, scope.repo ?? "");
  const otherRepos = others > 0 ? <TextAction className="pc-text-action" href={withQuery(standalone ? "#/needs-you" : "#/", { ...query, repo: "" })}>+{others} in other repos</TextAction> : null;
  const all = <TextAction className="pc-text-action" href={withQuery("#/needs-you", { ...query, repo: scope.repo ?? query.repo })}>{standalone ? "All open items" : narrow ? `All ${waiting}` : "All in Needs you"}</TextAction>;
  return <section className={standalone ? "pc-section" : "pc-section pc-dispatch-attention"} aria-labelledby="needs-you">
    <div className="pc-section__head">
      <SectionHeading variant={standalone ? undefined : "headline"} id="needs-you">{standalone ? "Decisions and problems" : "Needs you"}</SectionHeading>
      {!standalone && waiting > 0 && <span className="pc-count pc-count--bad">{waiting}</span>}
      <span className="grow" />{standalone ? otherRepos : all}
    </div>
    {cards.length > 0 && <ul className="pc-dispatch-cards pc-dispatch-cards--flush" aria-label="Needs you, most urgent first">
      {page.rows.map(card => <AttentionCard key={card.id} card={card} snapshot={snapshot} runner={runner} now={now} query={query} narrow={narrow && !standalone} actions={standalone ? 2 : 1} />)}
    </ul>}
    {!cards.length && <EmptyState title="Nothing needs your attention" description={<TextAction href={withQuery("#/tasks", query)}>View Tasks</TextAction>} />}

  </section>;
}

/** Active work and recent decisions in the board's seven-column dispatch ledger. */
function LiveDispatch({ snapshot, scope, now, query, workRows, workLoading, workUpdating, workError, onWorkReload, narrow = false }: { narrow?: boolean; snapshot: ClientSnapshot; scope: Scope; now: number; runner: ActionRunner; query: RouteQuery; workRows: WorkRow[]; workLoading?: boolean; workUpdating?: boolean; workError?: unknown; onWorkReload?: () => void }) {
  const busy = useDelayedBusy(!!workUpdating);
  const nodes = scopedTaskTree(snapshot, scope, { now, extra: workTasks(workRows) });
  // A missing parent never turns a known subtask into a Dispatch row.
  const subtasks = new Set(workRows.filter(row => row.parentId).map(row => row.id));
  const roots = nodes.filter(node => !subtasks.has(node.id));
  const visible = roots.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 6);
  const byState = (state: string) => snapshot.tasks.filter(t => t.state === state && roots.some(n => n.id === t.id)).length;
  const runningNow = byState("running"), queued = byState("queued");
  if (narrow) return <section className="pc-narrow-running" aria-labelledby="running-title"><SectionHeading variant="headline" id="running-title">Running</SectionHeading>
    {workError ? <div><ErrorMessage error={workError} /><Button onClick={onWorkReload}>Try again</Button></div> : roots.filter(node => snapshot.tasks.some(task => task.id === node.id && task.state === "running")).map(node => <ListRowLink key={node.id} href={withQuery(`#/tasks/${encodeURIComponent(node.id)}`, query)} className="pc-narrow-running__row"><AgentMark agent={node.agents[0] ?? "local"} size={20} labelled={false} /><span className="pc-dispatch-decision__task"><strong className="pc-ellipsis" title={node.title}>{node.title}</strong><span className="pc-dispatch-caption">{node.state.label} · {node.repo}</span></span></ListRowLink>)}
  </section>;
  return <section aria-busy={busy || undefined} className={`pc-card-section pc-live-dispatch${busy ? " pc-query-refreshing" : ""}`} aria-labelledby="live-dispatch">
    <div className="pc-card-section__head"><SectionHeading variant="headline" id="live-dispatch">Live dispatch</SectionHeading>
      <Pill tone="info">{runningNow} running</Pill><Pill tone="neutral">{queued} queued</Pill><span className="grow" /><span className="pc-dispatch-caption">Kind · routed to · why · tokens</span></div>
    {workError ? <div><ErrorMessage error={workError} /><Button onClick={onWorkReload}>Try again</Button></div> : workLoading ? <LoadingState label="Loading dispatch…" /> : visible.length > 0 ? <ul className="pc-dispatch-ledger" aria-label="Running work and recent dispatch decisions">{visible.map(node => {
      const task = snapshot.tasks.find(t => t.id === node.id);
      const running = task?.state === "running";
      // Preserve attention and conversational states; only ordinary active phases use the board's Working label.
      const status = task?.state === "needs_input" ? {label:"Needs your answer",tone:"warn" as const} : task?.acceptanceState === "failed" ? { label: "Checks failed", tone: "bad" as const }
        : task?.review?.accepted ? { label: "Accepted", tone: "good" as const }
        : running && node.state.tone === "info" ? { ...node.state, label: "Working" } : node.state;
      const why = task?.queue?.detail ?? task?.brokenReason ?? (task?.retryOf ? "Retried on executor" : null);
      const lead = node.agents.length > 1 ? `${node.agents.length} agents` : task?.executor ? executorLabel(task.executor) : "Not assigned";
      return <li key={node.id}><ListRowLink layout="dispatch" className="pc-dispatch-decision" href={withQuery(`#/tasks/${encodeURIComponent(node.id)}${running ? "" : "/trace"}`, query)}>
        <span className="pc-dispatch-caption">{node.updatedAt ? clock(node.updatedAt, now) : ""}</span>
        <span className="pc-dispatch-decision__task"><strong className="pc-ellipsis" title={node.title}>{node.title}</strong><span className="pc-dispatch-caption pc-dispatch-decision__repo pc-ellipsis">{node.repo}{node.children.length > 0 ? ` · ${node.children.length} subtasks` : ""}</span></span>
        <span><Pill tone="neutral">{task?.kind ?? "Unclassified"}</Pill></span>
        <span className="pc-dispatch-decision__agents">{node.agents.map((agent, i) => <AgentMark key={`${agent}:${i}`} agent={agent} size={20} labelled={false} />)}<strong className="pc-ellipsis">{lead}</strong></span>
        <span className="pc-dispatch-caption pc-ellipsis" title={why ?? undefined}>{why ?? "Routing reason not recorded"}</span>
        <strong className={`pc-dispatch-decision__tokens${node.tokens ? "" : " muted"}`} title={node.tokens ? undefined : "Token usage has not been measured for this task."}>{node.tokens?.replace(/ tokens$/, "") ?? "—"}</strong>
        <span className="pc-dispatch-decision__status"><Pill tone={status.tone}>{status.label}</Pill></span>
      </ListRowLink></li>;
    })}</ul> : <EmptyState bodyTitle title="Nothing running" description="Start work, delegate a task, or ask your planner to." />}
  </section>;
}

/**
 * The dispatcher's current answer for new work, from the same routing preview the delegate forms show.
 * `explain` is the dispatcher's own explanation (`dispatch.explain`) when the service has it and a repository is known;
 * it names the ladder step and the chain. Readiness still comes from the preview.
 */
export interface RoutingPreview { data?: Routing; loading: boolean; error?: unknown; explain?: RouteExplanationView; strategy?: string }

/** The planner half: the one place on Dispatch that states the planner's budget (UI-15); the status bar shows only its mark here. */
function PlannerHalf({ snapshot, now, shortWindowPct }: { snapshot: ClientSnapshot; now: number; shortWindowPct?: number | null }) {
  const p = plannerMeter(snapshot);
  if (!p) return null;
  const name = agentInfo(p.agent).name, pace = paceStatus(p.verdict), words = plannerPace(p.verdict), budget = plannerBudget(snapshot, now, shortWindowPct)!;
  const delta = budget.meter?.live && p.pacePct !== null && p.usedPct !== null ? Math.round(Math.abs(p.pacePct - p.usedPct)) : null;
  const advice = delta !== null && p.verdict === "behind" ? `${name} is ${delta} points under pace. Small edits can stay on the planner; bulk work still goes out.`
    : delta !== null && p.verdict === "ahead" ? `${name} is ${delta} points ahead of pace. Keep room for planning and review; send execution to another agent.`
    : budget.meter?.live && p.verdict === "on_pace" ? `${name} is on pace. Keep room for planning and review; bulk work still goes out.`
    : budget.lead;
  // The shared budget caption assumes a visible meter number for borrowed/historical readings.
  // Keep that number in our one caption when the meter's duplicate text is hidden.
  const caption = budget.meter && !budget.meter.live
    ? [budget.meter.stale ? "Historical usage" : null, `${Math.round(budget.meter.used)}% used`, budget.caption].filter(Boolean).join(" · ") : budget.caption;
  return <div className="pc-dispatch-split__half" id="planner-budget" aria-label="Planner budget" role="group">
    <div className="pc-dispatch-who"><AgentMark agent={p.agent} size={20} labelled={false} /><strong title={name}>{name}</strong><Pill tone="info">Planner</Pill>{/* The verdict belongs to the planner's own live reading; a borrowed or historical figure would sit under "Usage unknown". */}{(!budget.meter || budget.meter.live) && <StatusPill status={{ ...pace, label: words.label }} />}</div>
    {advice && <p className="pc-dispatch-advice">{advice}</p>}
    {budget.meter && <UsageMeter used={budget.meter.used} pace={budget.meter.pace} stale={budget.meter.stale} label={budget.meter.label} tone={budget.meter.live ? pace.tone : "neutral"} verdict={budget.meter.live ? p.verdict : undefined} size="bar" text="none" now={now} />}
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
  const shown = routing.explain?.strategy.name ?? routing.strategy ?? strategy;
  const waits = routing.explain && !explained ? queueReason(routing.explain, now) : null;
  const chevron = <span className="pc-dispatch-chain__sep"><Icon name="chevron-right" /></span>;
  return <div className="pc-dispatch-split__half pc-dispatch-split__half--page" role="group" aria-labelledby="next-task">
    <span className="pc-dispatch-label" id="next-task">Next task goes to</span>
    {routing.loading && !routing.data ? <span className="muted">Checking routing…</span>
      : routing.error ? <span className="muted">Could not check routing. It is checked again on the next update.</span>
      : nextId && (readiness || explained) ? <>
        <div className="pc-dispatch-next"><AgentMark agent={markAgent(nextId)} size={32} labelled={false} />
          <div className="pc-dispatch-next__who"><strong>{executorLabel(nextId)}</strong>{/* The step says why this agent; an uncertain readiness keeps its detail on the next line. */}{explained?.step && <span className="muted">{explained.step}</span>}{readiness && readiness.tone !== "good" && readiness.detail ? <span className="muted">{readiness.detail}</span> : explained?.step ? null : <span className="muted">{routing.data?.policy ? "Project order for this repository" : readiness?.detail || "Routing reason not recorded"}</span>}</div>
          {readiness && (readiness.tone === "good" ? <Pill tone="good">Ready</Pill> : <StatusPill status={readiness} />)}</div>
        {routing.explain?.outcome !== "fail" && <div className="pc-dispatch-chain"><span className="muted">Then:</span><ol aria-label="Then, in order">
          {then.map(id => <li key={id}><span className="pc-dispatch-chip"><AgentMark agent={markAgent(id)} size={18} labelled={false} />{executorLabel(id)}</span>{chevron}</li>)}
          {more > 0 && <li><span className="muted">+{more} more</span>{chevron}</li>}
          <li><span className="pc-dispatch-chip pc-dispatch-chip--queue"><span className="pc-dispatch-chip__tile" aria-hidden="true">Q</span>Queue</span></li>
        </ol></div>}
      </> : <span className="muted">{routing.explain?.outcome === "fail" ? "No agent can take new work now, and new tasks are refused rather than queued." : "No agent can take new work now. It waits in the queue."}{waits ? ` ${waits.replace(/\s*\(\d+ of \d+ running\)/g, "")}` : ""}{routing.explain?.outcome === "fail" ? " Change the strategy or make an agent available to accept new tasks." : ""}</span>}
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
export interface InsightsState { supported: boolean; loading: boolean; updating?: boolean; reload?: () => void; error?: unknown; current?: InsightsSummary; today?: InsightsSummary }

const KPI_ICON: Record<KpiTile["id"], IconName> = { handled: "stack", tokens: "bolt", outside: "fork", accepted: "check-circle" };
const KPI_TONE: Record<KpiTile["id"], string> = { handled: "info", tokens: "neutral", outside: "good", accepted: "good" };
/** The at-a-glance strip, named by `aria-label` as on the board. Figures come only from `insights.summary`; without it the strip says why, never a zero or a dash. */
function Glance({ period, insights }: { period: Period; insights: InsightsState }) {
  const measured = insights.current ? kpiTiles(insights.current, period, { today: insights.today ?? null }) : [];
  const labels: Record<KpiTile["id"], string> = { handled: "Root tasks handled", tokens: "Tokens spent", outside: "Ran outside planner", accepted: "Accepted first try" };
  const tiles: KpiTile[] = insights.current ? (Object.keys(labels) as KpiTile["id"][]).map(id => measured.find(tile => tile.id === id) ?? { id, label: labels[id], value: "Not measured", note: id === "outside" ? "Needs planner token attribution" : "No measured data for this period" }) : [];
  const busy = useDelayedBusy(!!insights.updating);
  return <section aria-busy={busy || undefined} className={`pc-glance-strip${busy ? " pc-query-refreshing" : ""}`} aria-label={periodHeading(period)} id="glance">
    {tiles.length ? <ul className="pc-glance" role="list">{tiles.map(tile => <li key={tile.id} className="pc-glance__tile">
      <span className={`pc-glance__icon pc-glance__icon--${KPI_TONE[tile.id]}`}><Icon name={KPI_ICON[tile.id]} /></span>
      <div className="pc-glance__body"><span className="pc-glance__label">{tile.label}</span><span className="pc-glance__value">{tile.value}</span>
      {(tile.delta || tile.note) && <span className="pc-glance__note">{tile.delta && <span className={`pc-glance__delta pc-glance__delta--${tile.delta.tone}`}>{tile.delta.text}</span>}{tile.delta && tile.note ? " " : ""}{tile.note}</span>}</div>
    </li>)}</ul>
      : <p className="pc-glance-strip__state muted">{!insights.supported ? "These figures need a newer pacer service with task insights."
        : insights.loading ? <LoadingState label="Loading figures…" />
        : "Could not load these figures. They are checked again on the next update."}</p>}
    {insights.current && insights.error && <div role="alert">Could not refresh figures. Showing the previous reading. <Button size="sm" onClick={insights.reload}>Try again</Button></div>}
  </section>;
}

/** Where the tokens went, as a share bar and table by agent. Hidden until token accounting measures something. */
function TokenShare({ summary, planner }: { summary?: InsightsSummary; planner: string | null }) {
  const spread = tokenSpread(summary, planner);
  if (!spread) return null;
  return <section className="pc-card-section pc-dispatch-spread" aria-labelledby="token-share">
    <div className="pc-card-section__head"><SectionHeading variant="headline" id="token-share">Where the tokens went</SectionHeading><span className="grow" /><TextAction href="#/insights">Open insights</TextAction></div>
    <div className="pc-card-section__body pc-dispatch-budget"><span className="muted">{spread.caption}</span><div className="pc-dispatch-share" role="img" aria-label={`Token share: ${spread.segments.map(segment => `${segment.label} ${segment.share}%`).join(", ")}`}>
        {spread.segments.filter(segment => segment.share > 0).map(segment => <span key={segment.id} className={`pc-dispatch-share__segment pc-dispatch-share__segment--${segment.series}`} style={{ flex: `${segment.share} 0 0` }} />)}
      </div>
      <table className="pc-dispatch-share-table" aria-label="Token share by agent"><thead><tr><th scope="col">Agent</th><th scope="col">Tasks</th><th scope="col">Tokens</th><th scope="col">Share</th></tr></thead><tbody>
        {spread.segments.map(segment => <tr key={segment.id}><th scope="row"><span className="pc-dispatch-share-table__agent"><span className={`pc-dispatch-share-table__swatch pc-dispatch-share__segment--${segment.series}`} aria-hidden="true" />{segment.agent && <AgentMark agent={segment.agent} size={20} labelled={false} />}<strong>{segment.label}</strong>{segment.role && <span className="pc-dispatch-caption">{segment.role}</span>}</span></th><td>{segment.tasks}</td><td><strong>{segment.tokens}</strong></td><td>{segment.share}%</td></tr>)}
      </tbody></table></div>
  </section>;
}

/** The current time, ticking every second like the top bar's clock, so the update age counts up while the service is quiet. */
export function useTick(from: number): number {
  const [tick, setTick] = useState(from);
  useEffect(() => { const t = setInterval(() => setTick(Date.now() / 1000), 1000); return () => clearInterval(t); }, []);
  return Math.max(from, tick);
}

/** The page title with its live line, then the period, repos and the primary New task. New task opens Delegate until the New task composer lands. */
function DispatchHeader({ snapshot, query, narrow, period, onPeriod, connected, now, hideNewTask = false }: { hideNewTask?: boolean; snapshot: ClientSnapshot; query: RouteQuery; narrow: boolean; period: Period; onPeriod?: (period: Period) => void; connected: boolean; now: number }) {
  const age = useTick(now);
  const agents = capacity(snapshot).filter(row => row.rank !== "planner" && row.usedPct !== null).length + (snapshot.planner ? 1 : 0);
  // The page line carries the update age, as on the board; the top bar drops its own on Dispatch (UI-15). No snapshot time, no age.
  const live = connected ? ["Live", agents ? `${agents} agent${agents === 1 ? "" : "s"} connected` : null, snapshot.at > 0 ? `updated ${ago(snapshot.at, age)}` : null].filter(Boolean).join(" · ") : "Reconnecting…";
  // The period only changes figures from task insights, so the switch shows only when the service has them.
  const controls = <div className="pc-dispatch__controls">
    {onPeriod && <SegmentedControl variant="board" label="Period" value={period} options={PERIODS} onChange={value => onPeriod(value as Period)} />}
    {!narrow && <RepoFilter snapshot={snapshot} query={query} menu />}
    {!hideNewTask && <Button variant="primary" size="sm" onClick={() => window.dispatchEvent(new Event("pacer:delegate"))} aria-keyshortcuts="Meta+N">New task{!narrow && <> <Kbd>⌘N</Kbd></>}</Button>}
  </div>;
  const title = <div className="pc-dispatch__title"><h1>Dispatch</h1><span className="pc-dispatch__live muted"><span className={`pc-live-dot${connected ? "" : " pc-live-dot--off"}`} aria-hidden="true" />{live}</span></div>;
  return narrow ? null
    : <header className="pc-dispatch__header">{title}{controls}</header>;
}

/** First run requires known missing integration and no configured executors. */
export function isFirstRun(snapshot: ClientSnapshot, checklist?: SetupChecklist): boolean {
  return !snapshot.executors?.some(executor => executor.rank !== "planner") && (checklist ? checklist.items.some(item => item.id === "connect" && item.status !== "done") : !snapshot.planner);
}
export function FirstRun({ detections, planner, query, error, retry }: { detections?: AgentDetection[]; planner?: string; query: RouteQuery; error?: unknown; retry?: () => void }) {
  return <section className="pc-first-run" aria-labelledby="first-run-title">
    <div><h2 id="first-run-title">Let your planner hand off work</h2><p>pacer keeps {planner ? agentInfo(planner).name : "your planner"} on pace by sending execution to the other agents you already pay for.</p></div>
    {error ? <div><ErrorMessage error={error} /><Button size="sm" onClick={retry}>Check again</Button></div> : !detections ? <LoadingState label="Looking for agent CLIs…" /> : <ul className="pc-first-run__agents">{detections.map(agent => <li key={agent.agent}>
      <AgentMark agent={agent.agent} size={20} labelled={false} /><span className="grow"><b>{agentInfo(agent.agent).name}</b> <span className="pc-dispatch-caption">{agent.version ?? (agent.found ? "CLI detected" : "not installed")}{agent.agent === planner ? " · will plan and review" : ""}</span></span>
      {agent.agent === planner ? <Pill tone="info">Planner</Pill> : agent.found ? <Pill tone="good">Found</Pill> : <TextAction href={withQuery(`#/settings/add-executor`, query)} title={agent.install_hint}><Pill tone="neutral">How to get it</Pill></TextAction>}
    </li>)}</ul>}
    <div className="pc-first-run__actions"><ButtonLink size="sm" variant="primary" href={withQuery("#/settings/dispatcher", query)}>Set up delegation</ButtonLink><ButtonLink size="sm" href={withQuery("#/settings/add-executor", query)}>Add another agent</ButtonLink><span className="pc-dispatch-caption">About 2 minutes · nothing runs until you finish</span></div>
  </section>;
}
export function EmptyDispatch({ query, sampleTask }: { query: RouteQuery; sampleTask?: ComponentChildren }) {
  return <section className="pc-empty-dispatch" aria-label="No work delegated yet"><strong>No work delegated yet</strong><span>Ask your planner to delegate, or start a task here. Pacer chooses an eligible executor and model for each task.</span><div className="pc-first-run__actions"><ButtonLink size="sm" variant="primary" href={withQuery("#/tasks/new", query)}>New task</ButtonLink>{sampleTask}</div></section>;
}
export function SampleTask({ query }: { query: RouteQuery }) {
  const action = useAction();
  const { state } = useTaskContext();
  return <><Button size="sm" disabled={!state.connected} title={!state.connected ? "pacer is offline" : undefined} busy={action.busy} onClick={() => void action.run<{ task_id: string }>("onboarding.try", {}, result => { location.hash = withQuery(`#/tasks/${encodeURIComponent(result.task_id)}`, query); })}>Try a sample task</Button><ErrorMessage error={action.error} />{action.message && <span role="status">{action.message}</span>}</>;
}
function FirstRunData({ snapshot, query }: { snapshot: ClientSnapshot; query: RouteQuery }) {
  const { state } = useTaskContext();
  const supported = state.features.ops.has("agent.detect");
  const detection = useQuery<AgentDetection[]>(supported ? "agent.detect" : "version.get", {});
  return supported ? <FirstRun detections={detection.data} planner={snapshot.planner?.agent} query={query} error={detection.error} retry={detection.reload} /> : <FirstRun detections={[]} planner={snapshot.planner?.agent} query={query} />;
}

function NarrowPlanner({ snapshot, now, routing, shortWindowPct }: { snapshot: ClientSnapshot; now: number; routing: RoutingPreview | null; shortWindowPct: number | null }) {
  const p = plannerMeter(snapshot), budget = plannerBudget(snapshot, now, shortWindowPct);
  const next = routing?.explain ? nextFromExplanation(routing.explain)?.next : routing?.data?.ranked?.[0]?.id;
  return <section className="pc-narrow-planner" aria-label="Planner budget">
    {p ? <><div className="pc-dispatch-who"><AgentMark agent={p.agent} size={20} labelled={false} /><strong className="grow">{agentInfo(p.agent).name}</strong><StatusPill status={budget?.meter && !budget.meter.live ? { tone: "neutral", glyph: "◷", label: "Historical usage" } : { ...paceStatus(p.verdict), label: p.verdict === "behind" ? "Under pace" : p.verdict === "ahead" ? "Ahead of pace" : plannerPace(p.verdict).label }} /></div>
      {budget?.meter && <UsageMeter used={budget.meter.used} pace={budget.meter.pace} stale={budget.meter.stale} label={budget.meter.label} tone={budget.meter.live ? paceStatus(p.verdict).tone : "neutral"} size="bar" text="none" now={now} />}
      <span className="pc-dispatch-caption">{budget?.caption ?? "Planner usage is not measured yet"}</span></> : <span>Choose a planner in Dispatcher settings.</span>}
    <span className="pc-dispatch-caption">{next ? <>Next capable task goes to <b>{executorLabel(next)}</b></> : routing?.loading ? "Checking routing…" : "No agent can take new work now."}</span>
  </section>;
}

export interface DispatchProps {
  snapshot: ClientSnapshot; query: RouteQuery; now: number; runner: ActionRunner;
  /** The routing preview for new work; null when the service cannot preview routing. */
  routing?: RoutingPreview | null;
  period?: Period; onPeriod?: (period: Period) => void;
  contentRepo?: string | null;
  insights?: InsightsState; startWork?: ComponentChildren;
  /** Work rows supply parent links and token roll-ups absent from the snapshot. */
  workRows?: WorkRow[]; workLoading?: boolean; workUpdating?: boolean; workError?: unknown; onWorkReload?: () => void;
  /** False while the service is not answering; the live line then says so. */
  connected?: boolean;
  /** The planner account's 5-hour window, when its reading reports one. */
  shortWindowPct?: number | null;
  firstRun?: ComponentChildren; sampleTask?: ComponentChildren;
}
const dispatchScope = (query: RouteQuery, narrow: boolean): Scope => ({ repo: narrow ? activeRepo(query) : query.repo || null });
const NO_INSIGHTS: InsightsState = { supported: false, loading: false };
/** The Dispatch home in the board's order: planner budget and next task, the period's figures, tokens and Needs you, then live work. Phones lead with Needs you and live work. */
export function DispatchView({ snapshot, query, now, runner, routing = null, period = "7d", onPeriod, insights = NO_INSIGHTS, connected = true, shortWindowPct = null, workRows = [], workLoading, workUpdating, workError, onWorkReload, firstRun, sampleTask, contentRepo }: DispatchProps) {
  useDispatchStyles();
  const narrow = useNarrow(query);
  const scope = dispatchScope(contentRepo === undefined ? query : { ...query, repo: contentRepo }, narrow);
  const plannerAndNext = <PlannerAndNext snapshot={snapshot} now={now} routing={routing} query={query} shortWindowPct={shortWindowPct} />;
  const glance = <Glance period={period} insights={insights} />, share = <TokenShare summary={insights.current} planner={snapshot.planner?.agent ?? null} />;
  const needs = <NeedsYouList snapshot={snapshot} scope={scope} runner={runner} now={now} query={query} narrow={narrow} />;
  const empty = snapshot.tasks.length === 0 && !(snapshot.attention?.length) && workRows.length === 0 && !workLoading && !workError;
  const liveWork = <LiveDispatch narrow={narrow} workUpdating={workUpdating} workLoading={workLoading} workError={workError} onWorkReload={onWorkReload} workRows={workRows} snapshot={snapshot} scope={scope} now={now} runner={runner} query={query} />;
  return <NarrowContext.Provider value={narrow}><Page width="full" className={`pc-dispatch${narrow ? " pc-dispatch--narrow" : ""}`}>
    <SetupBanner />
    <DispatchHeader hideNewTask={empty || !!firstRun} snapshot={snapshot} query={query} narrow={narrow} period={period} onPeriod={insights.supported ? onPeriod : undefined} connected={connected} now={now} />
    {firstRun ? firstRun : empty ? <EmptyDispatch query={query} sampleTask={sampleTask} /> : narrow ? <>
      {<NarrowPlanner snapshot={snapshot} now={now} routing={routing} shortWindowPct={shortWindowPct} />}{needs}{liveWork}
    </> : <>
      {plannerAndNext}
      {glance}
      <div className="pc-dispatch__pair pc-dispatch__pair--wide">{share}{needs}</div>
      {liveWork}
    </>}
  </Page></NarrowContext.Provider>;
}

function useAttentionKeys(query: RouteQuery) {
  const { state } = useTaskContext();
  const runner = useActions();
  const current = useRef({ snapshot: state.snapshot, query, connected: state.connected }); current.current = { snapshot: state.snapshot, query, connected: state.connected };
  useEffect(() => keys.register({ keys: "/", label: "Focus the repo filter", scope: "dispatch", run: () => document.querySelector<HTMLButtonElement>("#repo-filter button")?.focus() }), []);
  useEffect(() => {
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-attention-id]")];
    const move = (by: number) => { const all = rows(), at = all.indexOf(document.activeElement?.closest("[data-attention-id]") as HTMLElement); all[Math.max(0, Math.min(all.length - 1, at + by))]?.focus(); };
    const selected = () => current.current.snapshot?.attention?.find(a => a.id === (document.activeElement?.closest("[data-attention-id]") as HTMLElement)?.dataset.attentionId);
    const actions: Record<string, () => void> = {
      j: () => move(1), k: () => move(-1),
      Enter: () => { const active = document.activeElement as HTMLElement; (["BUTTON", "A"].includes(active?.tagName) ? active : active?.closest("[data-attention-id]")?.querySelector<HTMLElement>(".pc-list-row__actions button, .pc-list-row__actions a"))?.click(); },
      v: () => { const item = selected(); location.hash = withQuery(item?.taskId ? `#/tasks/${encodeURIComponent(item.taskId)}` : "#/needs-you", current.current.query); },
      x: () => { const item = selected(); if (current.current.connected && item && state.features.ops.has("attention.dismiss")) void runner.run(`${item.id}:dismiss`, { label: "Dismiss", op: "attention.dismiss", params: { id: item.id } }, gone(item)); },
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
 * parameter changes retain their previous reading through the query hook until revalidation finishes.
 */
export function holdInsights(held: HeldInsights, period: Period, repo: string | null, current: { data?: InsightsSummary; loading: boolean; error?: unknown }, today: { data?: InsightsSummary }): { held: HeldInsights; state: InsightsState } {
  const key = `${period}|${repo ?? ""}`;
  const next: HeldInsights = held.key === key ? { ...held } : { key };
  if (current.data) next.current = current.data;
  if (today.data && period !== "today") next.today = today.data;
  const shown = current.data ?? next.current;
  return { held: next, state: { supported: true, loading: current.loading && !shown, error: current.error, current: shown, today: period === "today" ? undefined : today.data ?? next.today } };
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
  const current = useQuery<InsightsSummary>(reads.current.op, reads.current.params, "", true), today = useQuery<InsightsSummary>(reads.today.op, reads.today.params, "", true);
  const held = useRef<HeldInsights>({ key: "" });
  if (!supported) return NO_INSIGHTS;
  const result = holdInsights(held.current, period, repo, current, period === "today" ? {} : today);
  held.current = result.held;
  return { ...result.state, updating: current.updating || (period !== "today" && today.updating), error: current.error ?? today.error, reload: () => { current.reload(); today.reload(); } };
}

/** The planner account's 5-hour window from its own usage reading; nothing when the reading has none or is stale. */
export function plannerShortWindow(accounts: Account[] | undefined, runner: string | undefined): number | null {
  const account = runner ? accounts?.find(a => a.runners?.includes(runner)) : undefined;
  const window = account?.usageReading && !account.usageReading.stale ? account.usageReading.windows.find(w => w.name.toLowerCase() === "5h") : undefined;
  return window?.usedPct ?? null;
}

/** Finish the work pages before publishing: an older page may hold a recent root's children. */
function useDispatchWork(repo: string | null) {
  const { api } = useTaskContext();
  type WorkPage = { tasks: WorkRow[]; next: string | null };
  const page = useQuery<WorkPage>("dispatch.list", { relation: "all", limit: 100, ...(repo ? { repo } : {}) }, "", true);
  const [complete, setComplete] = useState<{ source: WorkPage; repo: string | null; rows: WorkRow[]; error?: unknown }>();
  useEffect(() => {
    if (!page.data || page.loading || page.error) return;
    const source = page.data;
    let cancelled = false;
    void (async () => {
      try {
        const rows = [...source.tasks];
        let next = source.next;
        while (next) {
          const older = await api.call<WorkPage>("dispatch.list", { relation: "all", limit: 100, before: next, ...(repo ? { repo } : {}) });
          if (cancelled) return;
          rows.push(...older.tasks);
          next = older.next;
        }
        if (!cancelled) setComplete({ source, repo, rows });
      } catch (error) {
        if (!cancelled) setComplete(previous => previous ? { ...previous, source, error } : { source, repo, rows: [], error });
      }
    })();
    return () => { cancelled = true; };
  }, [api, page.data, page.loading, repo]);
  const current = complete;
  return { repo: current?.repo, rows: current?.rows, loading: !current, updating: !!current && !page.error && !current.error && (page.loading || current.source !== page.data), error: page.error ?? current?.error, reload: page.reload };
}

export function DispatchHome({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext();
  const { checklist } = useContext(SetupContext);
  const runner = useActions();
  useAttentionKeys(query);
  const [period, setPeriod] = useState<Period>("7d");
  const supported = state.features.ops.has("routing.route"), scope = dispatchScope(query, useNarrow(query));
  // The explanation needs a repository and a goal; new work has no goal yet, so it asks about a generic one.
  const repo = explainRepo(scope.repo, state.snapshot?.repos);
  const canExplain = supported && state.features.ops.has("dispatch.explain") && repo !== null;
  const revision = JSON.stringify([state.snapshot?.executors?.map(e => [e.id, e.state]),
    state.snapshot?.tasks.filter(t => t.state === "running").length, state.snapshot?.tasks.filter(t => t.state === "queued").length]);
  const routing = useQuery<Routing>(supported ? "routing.route" : "version.get", supported && repo ? { repo } : {}, supported ? revision : "", true);
  const explain = useQuery<RouteExplanationView>(canExplain ? "dispatch.explain" : "version.get", canExplain ? { repo, goal: "New task" } : {}, revision, true);
  const accounts = useQuery<Account[]>(state.features.ops.has("account.list") ? "account.list" : "version.get", {});
  const work = useDispatchWork(scope.repo);
  const insights = useInsights(period, scope.repo);
  if (!state.snapshot) return null;
  return <><LazyWorkPanels query={query} selected={null} /><DispatchView snapshot={state.snapshot} query={query} now={Date.now() / 1000} runner={runner} routing={supported ? { ...routing, ...(canExplain && explain.data && !explain.error ? explanationApplies(explain.data) ? { explain: explain.data } : { strategy: explain.data.strategy.name } : {}) } : null}
    sampleTask={state.features.ops.has("onboarding.try") && checklist?.complete && state.snapshot.executors?.some(e => e.rank !== "planner" && e.enabled && e.state === "ready") ? <SampleTask query={query} /> : undefined}
    firstRun={isFirstRun(state.snapshot, checklist) ? <FirstRunData snapshot={state.snapshot} query={query} /> : undefined}
    contentRepo={work.repo} period={period} onPeriod={setPeriod} insights={insights} connected={state.connected} workRows={work.rows} workLoading={work.loading} workUpdating={work.updating} workError={work.error} onWorkReload={work.reload}
    shortWindowPct={Array.isArray(accounts.data) ? plannerShortWindow(accounts.data, state.snapshot.planner?.runner) : null} /></>;
}

export { NeedsYouPage } from "../needs-you/NeedsYou";

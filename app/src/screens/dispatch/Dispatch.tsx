import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../../../src/api/read-model/types";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { glanceTiles, needsYouCards, tokenSpread, type NeedsYouCard, type TokenReport } from "../../../../src/view-model/dispatch";
import { executorEligibility } from "../../../../src/view-model/capacity";
import { eligibilityPresentation } from "../../../../src/view-model/eligibility";
import { capacity, counts, needsYou, otherReposNeedingYou, plannerMeter, type Scope } from "../../../../src/view-model/selectors";
import type { ClientSnapshot } from "../../../../src/view-model/snapshot";
import { scopedTaskTree, type TaskNodeView } from "../../../../src/view-model/task-tree";
import { clock } from "../../../../src/view-model/time";
import { attentionStatus, executorLabel, paceStatus } from "../../../../src/view-model/words";
import { useActions } from "../../data/action-context";
import type { ActionRunner } from "../../data/actions";
import { AgentMark } from "../../ds/AgentMark";
import { TextAction } from "../../ds/Button";
import { Page } from "../../ds/Page";
import { EmptyState, ListRow, ListRowLink } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { StackedShareBar } from "../../ds/StackedShareBar";
import { StatusGlyph } from "../../ds/StatusGlyph";
import { StatusPill } from "../../ds/StatusPill";
import { TaskTreeNode } from "../../ds/TaskTreeNode";
import { UsageMeter } from "../../ds/UsageMeter";
import { keys } from "../../keys/instance";
import { overviewHints } from "../../keys/registry";
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
function itemActions(item: AttentionItem, runner: ActionRunner) {
  return item.actions.slice(0, 2).map((action, i) => <ActionButton key={i} runner={runner} id={`${item.id}:${i}`}
    action={action.op === "task.answer" ? { label: action.label, op: "ui.open", params: { view: "task", id: item.taskId } } : action} confirmDone={gone(item)} />);
}

function AttentionCard({ card, snapshot, runner, now, query, expansion }: { card: NeedsYouCard; snapshot: ClientSnapshot; runner: ActionRunner; now: number; query: RouteQuery; expansion: ReturnType<typeof useExpansion> }) {
  if (card.kind === "task") {
    const lead = card.items[0]!;
    return <li data-attention-id={lead.id} tabIndex={0} className="pc-dispatch-card">
      <TaskTreeNode node={card.node} density="regular" expanded={expansion.expanded(card.id)} onToggle={expansion.toggle} href={taskLink(query)} actions={itemActions(lead, runner)} />
    </li>;
  }
  const { item } = card, status = attentionStatus(item, snapshot.tasks);
  return <li data-attention-id={item.id} tabIndex={0} className="pc-dispatch-card">
    <ListRow className="pc-attn" outlined tone={card.level === "bad" ? "bad" : undefined}
      leading={<span className={`pc-status--${status.tone}`}><StatusGlyph status={status} />{status.label}</span>}
      content={<><div className="pc-attn__title"><span className="pc-ellipsis grow" title={item.title}>{item.title}</span>{item.repo && <code className="pc-repo-chip" title={item.repo.label}>{item.repo.label}</code>}</div><div className="muted">{item.detail} · {clock(item.raisedAt, now)}</div></>}
      actions={itemActions(item, runner)} />
  </li>;
}

/** Needs you as task tree cards, most urgent first; executor, host and setup items keep their own rows. */
export function NeedsYouList({ snapshot, scope, runner, now, query, narrow, standalone = false }: { snapshot: ClientSnapshot; scope: Scope; runner: ActionRunner; now: number; query: RouteQuery; narrow: boolean; standalone?: boolean }) {
  // The count is of items, like the activity bar and tray; one card can carry several items about the same task.
  const cards = needsYouCards(snapshot, scope, { now }), waiting = needsYou(snapshot, scope).length, others = otherReposNeedingYou(snapshot, scope);
  const page = useOverviewPage(cards, "Needs you", standalone ? Math.max(1, cards.length) : 5, scope.repo ?? "");
  const expansion = useExpansion();
  const otherRepos = others > 0 ? <TextAction className="pc-text-action" href={withQuery(standalone ? "#/needs-you" : "#/", { ...query, repo: "" })}>+{others} in other repos</TextAction> : null;
  const all = <TextAction className="pc-text-action" href={withQuery("#/needs-you", { ...query, repo: scope.repo ?? query.repo })}>All attention</TextAction>;
  return <section className={standalone ? "pc-section" : "pc-card-section pc-dispatch-attention"} aria-labelledby="needs-you">
    <div className={standalone ? "pc-section__head" : "pc-card-section__head"}>
      <SectionHeading id="needs-you">{standalone ? "Decisions and problems" : "Needs you"}</SectionHeading>
      {!standalone && waiting > 0 && <span className="pc-count pc-count--warn">{waiting}</span>}
      <span className="grow" />{standalone ? otherRepos : narrow && otherRepos ? otherRepos : all}
    </div>
    {cards.length > 0 && <ul className={standalone ? "pc-dispatch-cards pc-dispatch-cards--flush" : "pc-dispatch-cards"} aria-label="Needs you, most urgent first">
      {page.rows.map(card => <AttentionCard key={card.id} card={card} snapshot={snapshot} runner={runner} now={now} query={query} expansion={expansion} />)}
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
        ? <ActionButton runner={runner} id={`${node.id}:stop`} action={{ label: "Stop", op: "task.stop", params: { id: node.id } }} confirmDone={s => !s.snapshot?.tasks.some(x => x.id === node.id && x.state === "queued")} />
        : task?.state === "running" ? <ActionButton runner={runner} id={`${node.id}:takeover`} action={{ label: "Take over", op: "task.takeover", params: { id: node.id } }} /> : null;
      return <li key={node.id}><TaskTreeNode node={node} density="compact" expanded={expansion.expanded(node.id)} onToggle={expansion.toggle} href={taskLink(query)} actions={actions} /></li>;
    })}</ul>}
    {!nodes.length && <EmptyState title="Nothing running. Start work, delegate a task, or ask your planner to." />}
    {page.footer}
  </section>;
}

/** The one place on Dispatch that states the planner's budget (UI-15); the status bar shows only its mark here. */
function PlannerBudget({ snapshot, now }: { snapshot: ClientSnapshot; now: number }) {
  const p = plannerMeter(snapshot);
  if (!p) return null;
  const name = agentInfo(p.agent).name, pace = paceStatus(p.verdict);
  return <section className="pc-card-section" id="planner-budget" aria-labelledby="planner-budget-h">
    <div className="pc-card-section__head"><SectionHeading id="planner-budget-h">Planner budget</SectionHeading></div>
    <div className="pc-card-section__body pc-dispatch-budget">
      <div className="pc-dispatch-who"><AgentMark agent={p.agent} size={20} labelled={false} /><strong>{name}</strong><StatusPill status={pace} /></div>
      {p.advice && <p className="pc-dispatch-advice">{p.advice}</p>}
      {p.usedPct !== null && <UsageMeter used={p.usedPct} pace={p.pacePct} tone={pace.tone} verdict={p.verdict} size="bar" label={`${name} planner usage`} stale={p.stale} staleAt={snapshot.at} now={now} />}
      {(p.window || p.resetsAt) && <span className="muted">{[p.window, p.resetsAt ? `resets ${clock(p.resetsAt, now)}` : null].filter(Boolean).join(" · ")}</span>}
    </div>
  </section>;
}

/** The dispatcher's current answer for new work, from the same routing preview the delegate forms show. */
export interface RoutingPreview { data?: Routing; loading: boolean; error?: unknown }
function NextTask({ routing, query }: { routing: RoutingPreview; query: RouteQuery }) {
  const ranked = Array.isArray(routing.data?.ranked) ? routing.data!.ranked : [];
  const next = ranked[0], then = ranked.slice(1, 4), more = ranked.length - 1 - then.length;
  const readiness = next ? eligibilityPresentation(next.eligibility, Date.now() / 1000) : null;
  return <section className="pc-card-section" aria-labelledby="next-task">
    <div className="pc-card-section__head"><SectionHeading id="next-task">Next task goes to</SectionHeading><span className="grow" /><TextAction className="pc-text-action" href={withQuery("#/settings/dispatcher", query)}>Dispatcher settings</TextAction></div>
    <div className="pc-card-section__body pc-dispatch-budget">
      {routing.loading && !routing.data ? <span className="muted">Checking routing…</span>
        : routing.error ? <span className="muted">Could not check routing. It is checked again on the next update.</span>
        : next && readiness ? <>
          <div className="pc-dispatch-who"><AgentMark agent={markAgent(next.id)} size={28} labelled={false} /><strong>{executorLabel(next.id)}</strong><StatusPill status={readiness} /></div>
          {readiness.tone !== "good" && readiness.detail && <span className="muted">{readiness.detail}</span>}
          {then.length > 0 && <div className="pc-dispatch-then"><span className="muted">Then</span><ol aria-label="Then, in order">{then.map(row => <li key={row.id} className="pc-dispatch-chip"><AgentMark agent={markAgent(row.id)} size={16} labelled={false} />{executorLabel(row.id)}</li>)}</ol>{more > 0 && <span className="muted">+{more} more</span>}</div>}
          {routing.data?.policy && <span className="muted">Project order for this repository</span>}
        </> : <span className="muted">No agent can take new work now. It waits in the queue.</span>}
    </div>
  </section>;
}

/** Narrow layouts hide the status bar, so agent usage and readiness stay reachable here (desktop keeps them in the status bar). */
function AgentUsage({ snapshot, query }: { snapshot: ClientSnapshot; query: RouteQuery }) {
  const rows = capacity(snapshot).filter(row => row.rank !== "planner");
  if (!rows.length) return null;
  return <section className="pc-card-section" aria-labelledby="agent-usage">
    <div className="pc-card-section__head"><SectionHeading id="agent-usage">Agents</SectionHeading></div>
    <ul className="pc-dispatch-agents">{rows.map(row => {
      const ready = executorEligibility(row, snapshot.at), usage = row.usedPct === null ? "usage unknown" : `${Math.round(row.usedPct)}% used`;
      return <li key={row.id}><ListRowLink className="pc-dispatch-agent" href={withQuery("#/settings/executors", query)} aria-label={`${executorLabel(row.id)} · ${usage} · ${ready.label}`}>
        <AgentMark agent={markAgent(row.id, row.account)} size={20} labelled={false} /><span className="pc-dispatch-agent__name">{executorLabel(row.id)}</span>
        <span className="pc-num">{usage}</span><StatusPill status={ready} />
      </ListRowLink></li>;
    })}</ul>
  </section>;
}

/** Facts pacer measured today; token figures join once token accounting reports them. Nothing is shown as a placeholder. */
function Glance({ snapshot, scope, tokens }: { snapshot: ClientSnapshot; scope: Scope; tokens: TokenReport | null }) {
  const tiles = glanceTiles(snapshot, scope, tokens);
  if (!tiles.length) return null;
  return <section className="pc-card-section" aria-labelledby="glance">
    <div className="pc-card-section__head"><SectionHeading id="glance">Today at a glance</SectionHeading></div>
    <dl className="pc-glance">{tiles.map(tile => <div key={tile.id} className="pc-glance__tile">
      <dt className="muted">{tile.label}</dt><dd className="pc-stat__n">{tile.value}</dd>{tile.detail && <dd className="muted">{tile.detail}</dd>}
    </div>)}</dl>
  </section>;
}

function TokenShare({ tokens }: { tokens: TokenReport | null }) {
  const spread = tokenSpread(tokens);
  if (!spread) return null;
  return <section className="pc-card-section" aria-labelledby="token-share">
    <div className="pc-card-section__head"><SectionHeading id="token-share">Where the tokens went</SectionHeading></div>
    <div className="pc-card-section__body pc-dispatch-budget"><span className="muted">{spread.caption}</span><StackedShareBar label="Token share" segments={spread.segments} /></div>
  </section>;
}

export interface DispatchProps {
  snapshot: ClientSnapshot; query: RouteQuery; now: number; runner: ActionRunner;
  /** The routing preview for new work; null when the service cannot preview routing. */
  routing?: RoutingPreview | null; tokens?: TokenReport | null; startWork?: ComponentChildren;
}
const dispatchScope = (query: RouteQuery, narrow: boolean): Scope => ({ repo: narrow ? activeRepo(query) : query.repo || null });
/** The Dispatch home: start work, what needs you, live work, then the planner budget, routing and today's figures. */
export function DispatchView({ snapshot, query, now, runner, routing = null, tokens = null, startWork }: DispatchProps) {
  const narrow = useNarrow(query);
  const scope = dispatchScope(query, narrow);
  return <NarrowContext.Provider value={narrow}><Page width="full" className={`pc-dispatch${narrow ? " pc-dispatch--narrow" : ""}`}>
    <SetupBanner />
    <RepoFilter snapshot={snapshot} query={query} narrow={narrow} />
    <div className="pc-dispatch__cols">
      <div className="pc-dispatch__main">
        {startWork}
        <NeedsYouList snapshot={snapshot} scope={scope} runner={runner} now={now} query={query} narrow={narrow} />
        <LiveDispatch snapshot={snapshot} scope={scope} now={now} runner={runner} query={query} />
      </div>
      <div className="pc-dispatch__side">
        <PlannerBudget snapshot={snapshot} now={now} />
        {routing && <NextTask routing={routing} query={query} />}
        {narrow && <AgentUsage snapshot={snapshot} query={query} />}
        <Glance snapshot={snapshot} scope={scope} tokens={tokens} />
        <TokenShare tokens={tokens} />
      </div>
    </div>
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

export function DispatchHome({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext();
  const runner = useActions();
  useAttentionKeys(query);
  const supported = state.features.ops.has("routing.route"), scope = dispatchScope(query, useNarrow(query));
  const routing = useQuery<Routing>(supported ? "routing.route" : "version.get", supported && scope.repo ? { repo: scope.repo } : {});
  if (!state.snapshot) return null;
  // Token figures arrive with `insights.summary` (attempt token accounting); until then they stay hidden, never zero.
  return <DispatchView snapshot={state.snapshot} query={query} now={Date.now() / 1000} runner={runner} routing={supported ? routing : null} tokens={null} startWork={<StartWork />} />;
}

export function NeedsYouPage({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext(), runner = useActions();
  if (!state.snapshot) return null;
  return <Page width="full"><RepoFilter snapshot={state.snapshot} query={query} /><NeedsYouList snapshot={state.snapshot} scope={{ repo: query.repo || null }} runner={runner} now={Date.now() / 1000} query={query} narrow={false} standalone /></Page>;
}

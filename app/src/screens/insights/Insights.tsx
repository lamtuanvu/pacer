import { useMemo, useState } from "preact/hooks";
import { AgentMark } from "../../ds/AgentMark";
import { Pill } from "../../ds/Pill";
import { Card, EmptyState, LoadingState, Page, PageHeader, SegmentedControl, Section, Stack } from "../../ds/Patterns";
import { ErrorMessage, useQuery } from "../task-shared";
import { executorLabel } from "../../../../src/view-model/words";
import type { RouteQuery } from "../../router";
import { agentClass, bars, compact, percent, periodRange, PERIODS, type PeriodKey, type Summary } from "./model";

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "warn" | "bad" }) {
  return <div className="pc-insights__kpi"><span className="pc-insights__label">{label}</span><strong>{value}</strong>{note && <span className={`pc-insights__note${tone ? ` pc-insights__note--${tone}` : ""}`}>{note}</span>}</div>;
}
const delta = (now: number, before: number) => before === 0 ? undefined : `${now >= before ? "+" : "−"}${Math.round(Math.abs(now - before) / before * 100)}% vs previous`;

export function Insights({ query }: { query: RouteQuery }) {
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const range = useMemo(() => periodRange(period, Date.now()), [period]);
  const result = useQuery<Summary>("insights.summary", { ...range, ...(query.repo ? { repo: query.repo } : {}) });
  const s = result.data;
  // Sorted by name so an agent keeps its color when the period changes.
  const agents = useMemo(() => s ? [...new Set([...s.spread.map(g => g.agent), ...s.daily.flatMap(d => Object.keys(d.byAgent))])].sort() : [], [s]);
  const label = (agent: string) => executorLabel(agent);
  return <Page width="full"><Stack space="section">
    <PageHeader description="How the work and tokens were spread across agents. Token counts are volumes, not costs."
      actions={<SegmentedControl label="Period" value={period} options={PERIODS} onChange={value => setPeriod(value as PeriodKey)} />} />
    {result.error && <ErrorMessage error={result.error} />}
    {!s ? <LoadingState label="Loading insights…" /> : s.rootTasksHandled === 0 && s.tokens.attempts === 0 ? <EmptyState title="Nothing in this period" description="No root task settled and no attempt ended. Try a longer period." /> : <>
      <section aria-label="Key numbers" className="pc-insights__kpis">
        <Kpi label="Root tasks" value={String(s.rootTasksHandled)} note={delta(s.rootTasksHandled, s.previous.rootTasksHandled)} />
        <Kpi label="Subtasks" value={String(s.subtasks)} note={s.rootTasksHandled ? `${(s.subtasks / s.rootTasksHandled).toFixed(1)} per root` : undefined} />
        <Kpi label={s.tokens.lowerBound ? "Tokens (at least)" : "Tokens"} value={compact(s.tokens.total)} note={delta(s.tokens.total, s.previous.tokens.total)} />
        <Kpi label={s.tokens.lowerBound ? "Per root task (at least)" : "Per root task"} value={s.rootTasksHandled && s.tokens.total ? compact(Math.round(s.tokens.total / s.rootTasksHandled)) : "—"} />
        <Kpi label="Accepted first try" value={percent(s.acceptedFirstTryRate)} note={s.reviewedRoots ? `${s.acceptedFirstTry} of ${s.reviewedRoots} reviewed` : "none reviewed yet"} />
        <Kpi label="Retries" value={String(s.retryAttempts)} note={s.retryAttempts ? "extra attempts" : undefined} />
      </section>
      <Card aria-label="Coverage">
        <p>{s.tokens.measuredAttempts} attempts measured, {s.tokens.partialAttempts} partial, {s.tokens.unknownAttempts} unknown. {s.tokens.lowerBound ? "Totals are a lower bound." : "Totals are complete for the attempts shown."}</p>
        {s.planner.coverage === "unknown" && <p className="pc-insights__note">Planner: not measured, so the share that ran outside the planner is not shown.</p>}
      </Card>
      <Section title="Tokens per day, by agent" description={`Bars show tokens per ${s.bucket}; segments are separated and listed in the legend.`}>
        <ul className="pc-insights__legend" aria-label="Agents">{agents.map((a, i) => <li key={a}><span className={`pc-insights__swatch ${agentClass(i)}`} />{label(a)}</li>)}</ul>
        {s.daily.length ? <><ol className="pc-insights__bars" aria-hidden="true">{bars(s.daily, agents).map(d => <li key={d.at} >
          <svg viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">{d.rects.map(r => <rect key={r.agent} className={agentClass(r.index)} x={0} width={10} y={r.y} height={r.height} />)}</svg>
          <small>{new Date(d.at * 1000).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}</small></li>)}</ol>
          <div className="sr-only"><table><caption>Tokens per {s.bucket}, by agent</caption><thead><tr><th scope="col">Date</th>{agents.map(a => <th scope="col" key={a}>{label(a)}</th>)}</tr></thead><tbody>{s.daily.map(d => <tr key={d.at}><th scope="row">{new Date(d.at * 1000).toLocaleDateString()}</th>{agents.map(a => <td key={a}>{compact(d.byAgent[a] ?? 0)}</td>)}</tr>)}</tbody></table></div></>
          : <p className="pc-insights__note">No tokens recorded in this period.</p>}
      </Section>
      <Section title="Agents, ranked by tokens" description="A root task is what was asked for; subtasks are what it was split into.">
        <div className="pc-insights__scroll" tabIndex={0} role="region" aria-label="Agents table, scrollable"><table className="pc-insights__table"><caption className="sr-only">Agents ranked by tokens</caption>
          <thead><tr><th scope="col">Agent</th><th scope="col">Root tasks</th><th scope="col">Attempts</th><th scope="col">Tokens</th><th scope="col">Share</th><th scope="col">{s.tokens.lowerBound ? "Per task (at least)" : "Per task"}</th><th scope="col">Accepted</th></tr></thead>
          <tbody>{s.spread.map(g => { const i = agents.indexOf(g.agent); return <tr key={g.agent}>
            <th scope="row"><span className="pc-insights__agent"><span className={`pc-insights__swatch ${agentClass(i)}`} /><AgentMark agent={g.agent} size={20} labelled={false} />{label(g.agent)}</span></th>
            <td>{g.rootTasks}</td><td>{g.attempts}</td>
            <td><strong>{compact(g.total)}</strong>{g.unknownAttempts + g.partialAttempts > 0 && <> <Pill tone="warn">{g.unknownAttempts + g.partialAttempts} not complete</Pill></>}</td>
            <td><span className="pc-insights__share">{g.share !== null && <progress value={Math.round(g.share * 100)} max={100} aria-label={`Share of tokens: ${percent(g.share)}`} />}{percent(g.share)}</span></td>
            <td>{g.tokensPerTask === null || !g.total ? "—" : compact(g.tokensPerTask)}</td><td>{percent(g.acceptanceRate)}</td>
          </tr>; })}</tbody></table></div>
      </Section>
      <div className="pc-insights__pair">
        <Section title="Who got which kind of work" description="Tasks by kind and agent">
          {s.kindByAgent.length ? <div className="pc-insights__scroll" tabIndex={0} role="region" aria-label="Task kinds table, scrollable"><table className="pc-insights__table"><caption className="sr-only">Tasks by kind and agent</caption>
            <thead><tr><th scope="col">Kind</th>{agents.map(a => <th scope="col" key={a}>{label(a)}</th>)}</tr></thead>
            <tbody>{s.kindByAgent.map(k => <tr key={k.kind}><th scope="row">{k.kind}</th>{agents.map(a => <td key={a}>{k.byAgent[a] ?? 0}</td>)}</tr>)}</tbody></table></div>
            : <p className="pc-insights__note">No attempts in this period.</p>}
        </Section>
        <Section title="How the dispatcher decided" description={`${s.ladder.reduce((n, l) => n + l.count, 0)} attempts with a recorded rule, by the rule that picked the agent`}>
          <ul className="pc-insights__list">{s.ladder.map(l => <li key={l.rule}><span>{l.rule}</span><strong>{l.count}</strong></li>)}</ul>
          {s.skipReasons.length > 0 && <><h3 className="pc-insights__label">Why agents were skipped</h3>
            <ul className="pc-insights__list">{s.skipReasons.map(r => <li key={`${r.agent}${r.reason}`}><span>{label(r.agent)}: {r.reason}</span><strong>{r.count}</strong></li>)}</ul></>}
        </Section>
      </div>
      <p className="pc-insights__note">Tokens are read from each agent's run log when an attempt ends. Counts from different providers are not comparable costs.</p>
    </>}
  </Stack></Page>;
}

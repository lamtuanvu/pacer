import { useEffect, useMemo, useState } from "preact/hooks";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink } from "../../ds/Button";
import { Pill } from "../../ds/Pill";
import { SearchPicker } from "../../ds/SearchPicker";
import { Card, EmptyState, LoadingState, Page, SegmentedControl, Stack } from "../../ds/Patterns";
import { ErrorMessage, useQuery, useTaskContext } from "../task-shared";
import { executorLabel } from "../../../../src/view-model/words";
import { markAgent, runnerAgent } from "../../../../src/view-model/agents";
import type { Account } from "../../model/accounts";
import { withQuery, type RouteQuery } from "../../router";
import { agentSlot, bars, CHART_DAYS, chartRange, compact, dayLabel, fullDay, niceMax, percent, periodRange, PERIODS, rangeLabel, slotClass, summaryCsv, versus, type PeriodKey, type Summary } from "./model";

type Tone = "good" | "warn" | "bad";
function Kpi({ label, value, delta, tone, note }: { label: string; value: string; delta?: string; tone?: Tone; note?: string }) {
  return <div className="pc-insights__kpi"><span className="pc-insights__label">{label}</span><strong>{value}</strong>
    <span className="pc-insights__caption">{delta && <span className={`pc-insights__delta${tone ? ` pc-insights__delta--${tone}` : ""}`}>{delta}</span>}{delta && note ? " " : ""}{note}</span></div>;
}
/** A change against the previous period; `up` says which direction is good. */
const change = (now: number, before: number, up: "good" | "warn", unit = ""): { delta?: string; tone?: Tone } => {
  if (before === 0 && now === 0) return {};
  const diff = now - before, sign = diff >= 0 ? "+" : "−";
  const text = unit === "%" ? (before === 0 ? undefined : `${sign}${Math.round(Math.abs(diff) / before * 100)}%`) : `${sign}${Math.abs(diff)}${unit}`;
  if (!text) return {};
  const better = up === "good" ? diff >= 0 : diff <= 0;
  return { delta: text, tone: diff === 0 ? undefined : better ? "good" : "warn" };
};

function budgetOf(agent: string, accounts: Account[] | undefined): { label: string; tone: "good" | "warn" | "bad" | "neutral" } {
  const own = (accounts ?? []).filter(a => a.runners?.some(r => markAgent(r) === agent || runnerAgent(r) === agent));
  const windows = own.flatMap(a => a.usageReading?.windows.map(w => ({ ...w, stale: !!a.usageReading?.stale })) ?? []);
  if (!windows.length) return { label: "No usage reading", tone: "neutral" };
  if (windows.every(w => w.stale)) return { label: "Stale reading", tone: "warn" };
  const used = Math.max(...windows.map(w => w.usedPct ?? 0));
  return { label: `${Math.round(used)}% used`, tone: used >= 97 ? "bad" : used >= 85 ? "warn" : "good" };
}

export function Insights({ query }: { query: RouteQuery }) {
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const now = Date.now();
  const range = useMemo(() => periodRange(period, now), [period]);
  const chart = useMemo(() => chartRange(now), []);
  const repo = query.repo ? { repo: query.repo } : {};
  const result = useQuery<Summary>("insights.summary", { ...range, ...repo });
  const series = useQuery<Summary>("insights.summary", { ...chart, ...repo });
  const accounts = useQuery<Account[]>("account.list", {});
  const { state } = useTaskContext();
  const s = result.data;
  const label = (agent: string) => executorLabel(agent);
  const agents = useMemo(() => [...new Set([...(s?.spread.map(g => g.agent) ?? []), ...(series.data?.daily.flatMap(d => Object.keys(d.byAgent)) ?? []), ...(s?.kindByAgent.flatMap(k => Object.keys(k.byAgent)) ?? [])])].sort((a, b) => agentSlot(a) - agentSlot(b) || a.localeCompare(b)), [s, series.data]);
  const repos = state.snapshot?.repos ?? [];
  const goRepo = (value: string | null) => { location.hash = withQuery(location.hash.split("?")[0] || "#/insights", { ...query, repo: value }); };
  const csv = useMemo(() => s ? URL.createObjectURL(new Blob([summaryCsv(s, label)], { type: "text/csv" })) : null, [s]);
  useEffect(() => () => { if (csv) URL.revokeObjectURL(csv); }, [csv]);
  const versusWord = versus(period);
  const atLeast = s?.tokens.lowerBound ? " · at least" : "";
  const prev = s?.previous;
  const top = Math.max(0, ...(series.data?.daily.map(d => Object.values(d.byAgent).reduce((n, v) => n + v, 0)) ?? [0])), max = niceMax(top);
  const days = series.data ? bars(series.data.daily, agents, chart.from, CHART_DAYS, max) : [];
  const todayAt = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const total = s?.tokens.total ?? 0, retried = s?.retryAttempts ?? 0;
  return <Page width="full"><Stack space="section">
    <header className="pc-insights__header">
      <div className="pc-insights__title"><h1>Insights</h1><span className="pc-insights__caption">How well the dispatcher spread the work{s ? ` · ${rangeLabel(s.from, s.to)}` : ""}</span></div>
      <SegmentedControl label="Period" value={period} options={PERIODS} onChange={value => setPeriod(value as PeriodKey)} />
      <SearchPicker label={query.repo ? `Repo · ${repos.find(r => r.key === query.repo)?.label ?? query.repo}` : `All repos · ${repos.length}`} searchLabel="Search repositories" placeholder="Search repositories…" emptyLabel="No matching repositories."
        value={query.repo || null} onChange={goRepo} options={[{ value: null, label: "All repos" }, ...repos.map(r => ({ value: r.key, label: r.label, searchText: `${r.label} ${r.key}` }))]} />
      {csv && s ? <ButtonLink href={csv} download={`pacer-insights-${new Date(s.from * 1000).toISOString().slice(0, 10)}.csv`}>Export CSV</ButtonLink> : <Button disabled>Export CSV</Button>}
    </header>
    {result.error && <ErrorMessage error={result.error} />}
    {!s ? <LoadingState label="Loading insights…" /> : s.rootTasksHandled === 0 && s.tokens.attempts === 0 ? <EmptyState title="Nothing in this period" description="No root task settled and no attempt ended. Try a longer period." /> : <>
      <Card className="pc-insights__summary">
        <div className="pc-insights__headline"><strong>{compact(total)} tokens went to executors{s.tokens.lowerBound ? " (at least)" : ""}, and planner tokens are not measured yet.</strong>
          <span>{s.tokens.measuredAttempts} attempts measured, {s.tokens.partialAttempts} partial, {s.tokens.unknownAttempts} unknown. {s.tokens.lowerBound ? "Totals are a lower bound." : "Totals are complete for the attempts shown."} Once planner tokens are measured, this card shows how much ran outside the planner.</span></div>
        <div className="pc-insights__planner"><span className="pc-insights__label">Planner share of tokens</span>
          <div className="pc-insights__stripe" role="img" aria-label="Planner share is not measured" />
          <span className="pc-insights__caption"><b>Not measured</b> for planning and review · <b>{compact(total)}</b> on executors</span></div>
      </Card>
      <section aria-label="Key numbers" className="pc-insights__kpis">
        <Kpi label="Root tasks" value={String(s.rootTasksHandled)} {...change(s.rootTasksHandled, prev!.rootTasksHandled, "good")} note={prev!.rootTasksHandled || s.rootTasksHandled ? versusWord : undefined} />
        <Kpi label="Subtasks" value={String(s.subtasks)} delta={s.rootTasksHandled ? `${(s.subtasks / s.rootTasksHandled).toFixed(1)}×` : undefined} note="fan-out" />
        <Kpi label="Tokens" value={compact(total)} {...change(total, prev!.tokens.total, "warn", "%")} note={`${versusWord}${atLeast}`} />
        <Kpi label="Per root task" value={s.rootTasksHandled && total ? compact(Math.round(total / s.rootTasksHandled)) : "—"} {...(s.rootTasksHandled && prev!.rootTasksHandled && prev!.tokens.total ? change(total / s.rootTasksHandled, prev!.tokens.total / prev!.rootTasksHandled, "warn", "%") : {})} note={`${versusWord}${atLeast}`} />
        <Kpi label="Accepted first try" value={percent(s.acceptedFirstTryRate)} {...(s.acceptedFirstTryRate !== null && prev!.acceptedFirstTryRate !== null ? (() => { const pts = Math.round((s.acceptedFirstTryRate! - prev!.acceptedFirstTryRate!) * 100); return { delta: `${pts >= 0 ? "+" : "−"}${Math.abs(pts)} pts`, tone: (pts === 0 ? undefined : pts > 0 ? "good" : "warn") as Tone | undefined }; })() : {})} note={s.reviewedRoots ? `${s.acceptedFirstTry} of ${s.reviewedRoots} reviewed` : "none reviewed yet"} />
        <Kpi label="Retries" value={String(retried)} delta={retried ? "extra attempts" : undefined} tone={retried ? "bad" : undefined} />
      </section>
      <section className="pc-insights__card" aria-labelledby="daily-h">
        <div className="pc-insights__cardhead"><h2 id="daily-h">Tokens per day, by agent</h2>
          <ul className="pc-insights__legend" aria-label="Agents">{agents.map(a => <li key={a}><span className={`pc-insights__swatch ${slotClass(agentSlot(a))}`} />{label(a)}</li>)}</ul></div>
        {series.data ? <div className="pc-insights__chart" aria-hidden="true">
          <div className="pc-insights__axis"><span>{compact(max)}</span><span>{compact(max / 2)}</span><span>0</span></div>
          <ol className="pc-insights__bars">{days.map(d => <li key={d.at} className={d.at === todayAt ? "pc-insights__today" : undefined}>
            <svg viewBox="0 0 10 100" preserveAspectRatio="none">{d.rects.map(r => <rect key={r.agent} className={slotClass(r.slot)} x={0} width={10} y={r.y} height={r.height} />)}</svg></li>)}</ol>
          <ol className="pc-insights__days">{days.map(d => <li key={d.at} className={d.at === todayAt ? "pc-insights__today" : undefined}>{dayLabel(d.at)}</li>)}</ol></div>
          : <LoadingState label="Loading chart…" />}
        {series.data && <div className="sr-only"><table><caption>Tokens per day for the last {CHART_DAYS} days, by agent</caption><thead><tr><th scope="col">Date</th>{agents.map(a => <th scope="col" key={a}>{label(a)}</th>)}</tr></thead>
          <tbody>{days.map(d => <tr key={d.at}><th scope="row">{fullDay(d.at)}</th>{agents.map(a => <td key={a}>{compact(series.data!.daily.find(x => x.at === d.at)?.byAgent[a] ?? 0)}</td>)}</tr>)}</tbody></table></div>}
      </section>
      <section className="pc-insights__card pc-insights__card--flush" aria-labelledby="agents-h">
        <div className="pc-insights__cardhead pc-insights__cardhead--bar"><h2 id="agents-h">Agents, ranked by tokens</h2><span className="pc-insights__caption">A root task is what you or the planner asked for; subtasks are what it was split into.</span></div>
        <div className="pc-insights__scroll" tabIndex={0} role="region" aria-label="Agents table, scrollable"><table className="pc-insights__table"><caption className="sr-only">Agents ranked by tokens</caption>
          <thead><tr><th scope="col">Agent</th><th scope="col">Root tasks</th><th scope="col">Subtasks</th><th scope="col">Attempts</th><th scope="col">Tokens</th><th scope="col">Share</th><th scope="col">Per task</th><th scope="col">Accepted</th><th scope="col">Budget</th></tr></thead>
          <tbody>{s.spread.map(g => { const slot = agentSlot(g.agent), budget = budgetOf(g.agent, accounts.data), accept = g.acceptanceRate;
            return <tr key={g.agent}>
              <th scope="row"><span className="pc-insights__agent"><span className={`pc-insights__swatch ${slotClass(slot)}`} /><AgentMark agent={g.agent} size={24} labelled={false} /><span className="pc-insights__name"><strong>{label(g.agent)}</strong><span className="pc-insights__caption">Executor</span></span></span></th>
              <td>{g.rootTasks}</td><td>{g.subtasks}</td><td>{g.attempts}</td>
              <td><strong>{compact(g.total)}</strong>{g.unknownAttempts + g.partialAttempts > 0 && <> <Pill tone="warn">{g.unknownAttempts + g.partialAttempts} not complete</Pill></>}</td>
              <td><span className="pc-insights__share">{g.share !== null && <progress className={slotClass(slot)} value={Math.round(g.share * 100)} max={100} aria-label={`Share of tokens: ${percent(g.share)}`} />}<span>{percent(g.share)}</span></span></td>
              <td>{g.tokensPerTask === null || !g.total ? "—" : compact(g.tokensPerTask)}</td>
              <td className={accept === null ? "" : accept >= 0.75 ? "pc-insights__good" : accept >= 0.5 ? "pc-insights__warn" : "pc-insights__bad"}><strong>{percent(accept)}</strong></td>
              <td><Pill tone={budget.tone}>{budget.label}</Pill></td></tr>; })}</tbody></table></div>
      </section>
      <div className="pc-insights__pair">
        <section className="pc-insights__card" aria-labelledby="kind-h"><h2 id="kind-h">Who got which kind of work</h2><span className="pc-insights__caption">Tasks by kind and agent · darker = more</span>
          {s.kindByAgent.length ? <div className="pc-insights__scroll" tabIndex={0} role="region" aria-label="Task kinds table, scrollable"><table className="pc-insights__table pc-insights__heat"><caption className="sr-only">Tasks by kind and agent</caption>
            <thead><tr><th scope="col">Kind</th>{agents.map(a => <th scope="col" key={a} aria-label={label(a)}><AgentMark agent={a} size={20} labelled={false} /></th>)}</tr></thead>
            <tbody>{s.kindByAgent.map(k => <tr key={k.kind}><th scope="row">{k.kind}</th>{agents.map(a => { const n = k.byAgent[a] ?? 0; return <td key={a} className={`pc-insights__cell pc-insights__cell--${n === 0 ? 0 : n < 4 ? 1 : n < 10 ? 2 : 3}`}>{n}</td>; })}</tr>)}</tbody></table></div>
            : <p className="pc-insights__caption">No attempts in this period.</p>}
        </section>
        <section className="pc-insights__card" aria-labelledby="ladder-h"><h2 id="ladder-h">How the dispatcher decided</h2><span className="pc-insights__caption">{s.ladder.reduce((n, l) => n + l.count, 0)} attempts with a recorded rule · which rule picked the agent</span>
          <ul className="pc-insights__ladder">{(() => { const sum = s.ladder.reduce((n, l) => n + l.count, 0) || 1; return s.ladder.map((l, i) => <li key={l.rule}>
            <span className="pc-insights__step">{i + 1}</span>
            <span className="pc-insights__rule"><span className="pc-insights__rulehead"><strong>{l.rule}</strong><span className="pc-insights__caption">{l.count} decisions</span></span><progress className={i === 0 ? "pc-insights__p-good" : i === 1 ? "pc-insights__p-warn" : "pc-insights__p-muted"} value={Math.round(l.count / sum * 100)} max={100} aria-label={`${l.rule}: ${Math.round(l.count / sum * 100)}% of decisions`} /></span>
            <strong>{Math.round(l.count / sum * 100)}%</strong></li>); })()}</ul>
          {s.skipReasons.length > 0 && <div className="pc-insights__skips"><span className="pc-insights__label">Why agents were skipped</span>
            <ul className="pc-insights__skiplist">{s.skipReasons.map(r => <li key={`${r.agent}${r.reason}`}><AgentMark agent={r.agent} size={20} labelled={false} /><span className="pc-insights__why">{label(r.agent)}: {r.reason}</span><Pill tone="warn">{r.count}× skipped</Pill></li>)}</ul></div>}
        </section>
      </div>
      <p className="pc-insights__caption">Tokens are read from each agent's run log at the end of every attempt. Counts from different providers are volumes, not comparable costs.</p>
    </>}
  </Stack></Page>;
}

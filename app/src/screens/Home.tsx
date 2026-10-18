import { AgentMark } from "../ds/AgentMark";
import { markAgent } from "../../../src/view-model/agents";
import { useState } from "preact/hooks";
import { Card } from "../ds/Card";
import { Pill } from "../ds/Pill";
import { Button } from "../ds/Button";
import { UsageMeter } from "../ds/UsageMeter";
import { homeModel, type Routing, type Runner } from "../model/home";
import { executorStatus, runnerAccount, routingStatus } from "../model/executors";
import { executorLabel } from "../../../src/view-model/words";
import { Delegate } from "./Delegate";
import { ErrorMessage, SnapshotRow, useQuery, useTaskContext } from "./task-shared";
export const resetTime = (at: number) => new Date(at * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
export function Home() {
  const { state } = useTaskContext();
  const [delegate, setDelegate] = useState(false);
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  // Refetch when executors change: the 2.x executors rows, or the v1 budget on an older service.
  const revision = state.snapshot?.executors ? state.snapshot.executors.map(e => `${e.id}:${e.state}`).join() : String(state.snapshot?.budget?.generatedAt);
  const runners = useQuery<Runner[]>("runner.list", {}, revision);
  const routing = useQuery<Routing>("routing.route", {}, revision);
  if (!state.snapshot) return null;
  const excludedLabel = (id: string, reason: string) => {
    const runner = runners.data?.find(r => r.id === id);
    if (runner && runner.state !== "ok") return executorStatus(runner, runnerAccount(id, accounts.data ?? [])).label;
    return ({exhausted:"Out of quota", "not installed":"Not installed", planner:"Planner", "not configured":"Not configured"} as Record<string,string>)[reason] ?? reason;
  };
  const model = homeModel(state.snapshot, runners.data ?? [], accounts.data ?? []);
  const plannerId = state.snapshot.planner?.runner ?? state.snapshot.budget?.planner;
  return <section className="screen"><div className="top"><h1>Home</h1><Pill>{model.mode} mode</Pill><span className="grow" /><Button variant={delegate ? "secondary" : "primary"} onClick={() => setDelegate(true)}>Delegate a task</Button></div>
    <Card tone="sunken"><div className="row">{plannerId && <AgentMark agent={state.snapshot.planner?.agent ?? markAgent(plannerId)} labelled={false} />}<h2>Planner · {model.planner?.name ?? executorLabel(plannerId, accounts.data ?? [])}</h2><Pill tone={model.planner?.tone ?? "neutral"}>{model.planner?.label ?? "Usage unknown"}</Pill><span className="grow" />{model.planner?.resetsAt && <span className="muted">Resets {resetTime(model.planner.resetsAt)}</span>}</div><p className="headline">{model.headline}</p>
    {model.planner?.used != null && <><div><strong className="usage-number">{Math.round(model.planner.used)}%</strong> <span className="muted">of the {model.planner.window ?? "current"} budget used{model.planner.pace !== null && ` · pace marker at ${Math.round(model.planner.pace)}%`}</span></div><UsageMeter used={model.planner.used} pace={model.planner.pace} tone={model.planner.tone} size="bar" text="none" label="Planner usage" /></>}{model.planner?.stale && <Pill tone="warn">Usage is stale</Pill>}</Card>
    <Card><div className="row"><h2>Needs your attention</h2><Pill tone={model.attention.length ? "warn" : "neutral"}>{model.attentionCount} items</Pill></div><ErrorMessage error={runners.error} />{model.attention.map(item => <div className="task-row" key={item.key}><Pill tone={item.tone}>{item.label}</Pill><div className="grow"><div>{item.title}</div><div className="muted">{item.detail}{item.until ? ` · back ${resetTime(item.until)}` : ""}</div></div><a href={item.href}>{item.label === "Review" ? "Review" : "Details"}</a></div>)}{!model.attention.length && <p className="muted">Nothing needs your attention.</p>}</Card>
    <Card><div className="row"><h2>Who runs next</h2><span className="grow" /><a href="#/strategy">Change order</a></div><ErrorMessage error={routing.error} />{routing.loading && !routing.data && <p>Checking executors…</p>}{routing.data?.ranked.map((runner, index) => <div className="task-row" key={runner.id}><span className="muted">{index + 1}</span><div className="grow"><div>{executorLabel(runner.id, accounts.data ?? [])}</div></div><Pill tone={routingStatus(runner).tone}>{routingStatus(runner).label}</Pill></div>)}{routing.data && !routing.data.ranked.length && <p>No executor can take work. <a href="#/executors">Check executors</a>.</p>}{!!routing.data?.excluded.length && <p className="muted">Skipped: {routing.data.excluded.map(r => `${executorLabel(r.id, accounts.data ?? [])} (${excludedLabel(r.id, r.reason)})`).join(", ")}</p>}</Card>
    <Card><div className="row"><h2>Running</h2><span className="grow" /><a href="#/tasks">All tasks</a></div>{model.running.map(task => <SnapshotRow key={task.id} task={task} />)}{!model.running.length && <p className="muted">No tasks running. Delegate one, or ask your planner to.</p>}</Card>
    {delegate && <Delegate close={() => setDelegate(false)} />}
  </section>;
}

import { useState } from "preact/hooks";
import type { AttentionItem } from "../../../../src/attention/types";
import { needsYou, capacity } from "../../../../src/view-model/selectors";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { durationWords, clock } from "../../../../src/view-model/time";
import { ButtonLink, TextAction } from "../../ds/Button";
import { Page } from "../../ds/Page";
import { Pill } from "../../ds/Pill";
import { AgentMark } from "../../ds/AgentMark";
import { Tabs, EmptyState } from "../../ds/Patterns";
import { useActions } from "../../data/action-context";
import { withQuery, type RouteQuery } from "../../router";
import { RepoFilter } from "../RepoFilter";
import { ActionButton } from "../ActionButton";
import { useTaskContext } from "../task-shared";
import { AnswerPanel } from "./AnswerPanel";

export const answerHref = (id: string) => `#/needs-you?answer=${encodeURIComponent(id)}`;
export function attentionDestination(item: AttentionItem): string {
  const task = `#/tasks/${encodeURIComponent(item.taskId ?? "")}`;
  return item.kind === "question" ? answerHref(item.taskId!) : `${task}/${item.kind === "review" ? "review" : "failure"}`;
}
const tabs = [{ value: "all", label: "All" }, { value: "question", label: "Questions" }, { value: "failed", label: "Failed" }, { value: "review", label: "To review" }];
export function NeedsYouPage({ query }: { query: RouteQuery }) {
  const { state } = useTaskContext(), runner = useActions();
  const [tab, setTab] = useState("all");
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const now = Date.now() / 1000;
  const items = needsYou(snapshot, { repo: query.repo || null }).filter(item => item.taskId && ["question", "failed", "review"].includes(item.kind));
  const shown = items.filter(item => tab === "all" || item.kind === tab);
  const unavailable = capacity(snapshot).filter(row => row.rank !== "planner" && ["down", "blocked", "exhausted", "disabled"].includes(row.state));
  const answer = new URLSearchParams(typeof location === "undefined" ? "" : location.hash.split("?")[1]).get("answer");
  const oldest = items.length ? Math.min(...items.map(item => item.raisedAt)) : null;
  return <Page width="full" className="pc-needs-you pc-needs-board">
    <header className="ny-header"><div className="ny-heading"><h1>Needs you</h1><span className="ny-cap">{items.length ? `${items.length} ${items.length === 1 ? "task is" : "tasks are"} waiting on you` : "Nothing needs your attention"}{oldest !== null ? ` · the oldest for ${durationWords(now - oldest)}` : ""} · {needsYou(snapshot, { repo: query.repo || null }).some(item => !item.taskId && item.severity === "blocked") ? "agents need attention below" : "nothing else is blocked"}</span></div><RepoFilter snapshot={snapshot} query={query} menu /></header>
    <Tabs id="needs-kind" label="Kind" value={tab} options={tabs.map(option => ({ ...option, label: <>{option.label} <span className="ny-cap">{option.value === "all" ? items.length : items.filter(item => item.kind === option.value).length}</span></> }))} onChange={setTab} />
    <section className="ny-list" aria-label="Waiting on you" role="tabpanel" id={`needs-kind-${tab}-panel`} aria-labelledby={`needs-kind-${tab}-tab`}>
      {shown.map(item => {
        const task = snapshot.tasks.find(task => task.id === item.taskId), question = item.kind === "question", review = item.kind === "review";
        const agent = markAgent(item.executor ?? task?.executor ?? "codex", item.account), name = agentInfo(agent).name;
        const href = withQuery(attentionDestination(item), query);
        const stop = item.actions.find(action => action.op === "task.stop");
        return <div key={item.id} className="ny-item" data-attention-id={item.id}>
          <span aria-hidden="true" className={`ny-glyph ny-glyph--${question ? "warn" : review ? "info" : "bad"}`}>{question ? "◐" : review ? "●" : "✕"}</span>
          <TextAction className="ny-content" href={href}><span className="ny-title-line"><span className="ny-title" title={task?.title ?? item.title}>{task?.title ?? item.title}</span><Pill tone={question ? "warn" : review ? "info" : "bad"}>{question ? "Question" : review ? "Ready for review" : "Checks failed"}</Pill></span>
            <span className="ny-reason">{question ? `${name} asks: ${task?.question?.text ?? item.detail}` : item.detail}</span>
            <span className="ny-meta ny-cap"><AgentMark agent={agent} size={16} labelled={false} /><span className="ny-mono">{item.repo?.label ?? item.repo?.key ?? "Repository unknown"}</span> · {question ? "asked " : review ? "finished " : ""}{question || review ? `${durationWords(now - item.raisedAt)} ago` : clock(item.raisedAt, now)}</span>
          </TextAction>
          <span className="ny-actions">{question ? <ButtonLink size="sm" href={`#/tasks/${encodeURIComponent(item.taskId!)}`}>Open session</ButtonLink> : review ? <ButtonLink size="sm" href={`#/tasks/${encodeURIComponent(item.taskId!)}/trace`}>Dispatch trace</ButtonLink> : stop ? <ActionButton runner={runner} id={`${item.id}:stop`} action={{ ...stop, label: "Stop task" }} /> : null}<ButtonLink size="sm" variant="primary" href={href}>{question ? "Answer" : review ? "Review" : "Inspect failures"}</ButtonLink></span>
        </div>;
      })}
      {!shown.length && <EmptyState title="Nothing needs your attention" description="Tasks appear here when they need an answer, a fix or a review." />}
    </section>
    {!!unavailable.length && <section className="ny-warning"><span className="ny-glyph ny-glyph--warn" aria-hidden="true">◐</span><div className="ny-heading"><b>{unavailable.length} {unavailable.length === 1 ? "agent can't" : "agents can't"} take work</b><span className="ny-cap">{unavailable.map(row => `${agentInfo(markAgent(row.id, row.account)).name}: ${row.reason ?? row.sub}`).join("; ")}. New work skips them until you fix them.</span></div><ButtonLink size="sm" href="#/settings/executors">Fix in Agents</ButtonLink></section>}
    <span className="ny-cap">Answering, retrying or accepting here resumes the task where it stopped. Everything you do is recorded in the task's dispatch trace.</span>
    {answer && <AnswerPanel key={answer} id={answer} close={() => { location.hash = withQuery("#/needs-you", query); }} />}
  </Page>;
}

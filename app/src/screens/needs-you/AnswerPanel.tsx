import { useState } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { durationWords } from "../../../../src/view-model/time";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { Checkbox, TextArea } from "../../ds/Controls";
import { SideDialog } from "../../ds/SideDialog";
import { useOutputTail } from "./output-tail";
import { ErrorMessage, useAction, useQuery } from "../task-shared";

export function AnswerPanel({ id, close }: { id: string; close: () => void }) {
  const { data: task, loading, error } = useQuery<TaskDetail>("task.get", { id });
  const log = useOutputTail(id);
  const action = useAction(), [text, setText] = useState("");
  const agent = markAgent(task?.executor ?? "codex"), name = agentInfo(agent).name;
  const question = task?.question as (NonNullable<TaskDetail["question"]> & { options?: string[] }) | undefined;
  const available = task?.state === "needs_input" && question && question.answer === undefined && !task.retriedBy;
  const session = `#/tasks/${encodeURIComponent(id)}`;
  const send = () => {
    if (!text.trim() || text.length > 2000 || !available || action.busy) return;
    void action.run("task.answer", { id, text: text.trim(), expect_rev: task.rev }, close);
  };
  return <SideDialog title={`${name} asks`} mark={<AgentMark agent={agent} size={20} labelled={false} />} close={close} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); send(); } }} footer={<>
    <span className="ny-cap ny-resume">{name} resumes on send · ⌘↵</span><ButtonLink href={session}>Answer in the terminal</ButtonLink><Button variant="primary" busy={action.busy} onClick={send} disabled={!available || !text.trim() || text.length > 2000}>Send answer</Button>
  </>}>
    {loading && <span role="status">Loading question…</span>}<ErrorMessage error={error} />
    {task && <>
      <div className="ny-heading"><strong>{task.title ?? task.goal}</strong><span className="ny-cap"><span className="ny-mono">{task.repo?.label ?? task.repo?.key}</span>{task.branch && <> · <span className="ny-mono">{task.branch}</span></>} · waiting {durationWords(Date.now() / 1000 - (question?.at ?? task.updatedAt))} · <TextAction href={session}>Open session</TextAction></span></div>
      {question && <div className="ny-question">{question.text}</div>}
      <div className="ny-output"><span className="ny-label">What it was doing</span><ErrorMessage error={log.error} /><pre className="ny-mono">{log.loading ? "Loading output…" : log.text || "No output recorded yet."}</pre></div>
      {!!question?.options?.length && <div className="ny-quick"><span className="ny-label">Quick answers</span><div className="ny-options">{question.options.map(option => <Button className="ny-chip" key={option} onClick={() => setText(option)}>{option}</Button>)}</div></div>}
      {available ? <><label className="ny-answer"><span className="ny-label">Your answer</span><TextArea rows={4} value={text} maxLength={2000} onInput={event => setText(event.currentTarget.value)} placeholder={`Answer in your own words. ${name} continues from here.`} /></label><div className="ny-heading"><Checkbox checked disabled label="Add this answer to the task's brief" /><span className="ny-cap">Answers are always included in the resumed task's brief.</span></div>{!text.trim() && <span className="ny-cap">Enter an answer to send.</span>}</> : <span role="status">This task is no longer waiting for an answer. Open its session to see what happened.</span>}
    </>}
    <ErrorMessage error={action.error} />{action.message && <span role="status">{action.message}</span>}
  </SideDialog>;
}

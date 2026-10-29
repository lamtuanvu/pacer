import { useState } from "preact/hooks";
import type { TaskDetail, RetryOption } from "../../../../src/core/task-detail";
import { markAgent } from "../../../../src/view-model/agents";
import { reasonCopy } from "../../../../src/view-model/copy";
import { executorLabel } from "../../../../src/view-model/words";
import { clock } from "../../../../src/view-model/time";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { RadioGroup, OptionRow } from "../../ds/Composer";
import { Field, TextArea } from "../../ds/Controls";
import { Pill } from "../../ds/Pill";
import { blankNewTask, NEW_TASK_DRAFT_KEY } from "../../model/new-task";
import { hrefFor, routes, type RouteQuery } from "../../router";
import { ErrorMessage, useQuery, useTaskContext } from "../task-shared";
import { ResultHeader, useResultAction, type WorkResult } from "../review/ResultPage";
import { acceptanceRows, reviewAvailable, retryRequest } from "./model";

export function Failure({task, query, reload, tree}: {task: TaskDetail; query: RouteQuery; reload: () => void; tree?: WorkResult}) {
  const {state} = useTaskContext(), action = useResultAction();
  const options = useQuery<RetryOption[]>("task.retry_options", {id:task.id}, String(task.rev));
  const recommended = options.data?.find(option => option.state === "ready");
  const executor = task.executor ?? task.attempts.at(-1)?.executor;
  const sameReady = !!executor && state.snapshot?.executors?.some(row => row.id === executor && row.state === "ready");
  const [choice, setChoice] = useState<string>(), [note, setNote] = useState(""), [notice, setNotice] = useState("");
  const selected = choice ?? recommended?.id ?? (sameReady ? executor : undefined);
  const node = tree?.nodes.find(n => n.taskId === task.id);
  const available = task.work ? !!node?.retryEligibility?.allowed : reviewAvailable(task) && state.features.ops.has("task.review");
  const feedbackUnsupported = !task.work && !!note.trim() && selected !== executor && selected !== "edit";
  const canRetry = !feedbackUnsupported && available && (task.work ? state.features.ops.has("dispatch.retry") : !!selected && (selected === executor ? sameReady : options.data?.some(o => o.id === selected && o.state === "ready")));
  const checks = acceptanceRows(task), failed = checks.filter(check => check.state === "failed").length;
  const edit = () => {
    try {
      localStorage.setItem(NEW_TASK_DRAFT_KEY, JSON.stringify({...blankNewTask, request:[task.brief.goal, task.brief.scope, task.brief.context, task.brief.constraints, note].filter(Boolean).join("\n\n"), repo:task.brief.repo, base:task.base ?? "", kind:task.kind ?? "", checks:JSON.stringify(checks.map((check,i) => ({id:`check-${i}`,text:check.cmd,command:check.cmd,on:true})))}));
      location.hash = hrefFor(routes.newTask(query));
    } catch {setNotice("Could not save the brief. Browser storage is unavailable.");}
  };
  const retry = () => {
    if (selected === "edit") {edit(); return;}
    if (!canRetry) return;
    const request = retryRequest(task, selected ?? "", note);
    void action.run(request.op, request.params, result => {
      const response = result as {retry?: {task_id?: string; id?: string}; task_id?: string};
      const id = response.retry?.task_id ?? response.retry?.id ?? response.task_id ?? task.id;
      setNotice("Retry requested. Previous attempts remain in the trace."); reload();
      location.hash = hrefFor(routes.task(id, query));
    });
  };
  const stop = state.snapshot?.attention?.filter(item => item.taskId === task.id).flatMap(item => item.actions).find(item => item.op === "task.stop" || item.op === "dispatch.stop");
  return <><ResultHeader task={task} query={query} failure actions={<><ButtonLink href={hrefFor(routes.task(task.id, query))}>Open last session</ButtonLink>{stop && <Button busy={action.busy} onClick={() => void action.run(stop.op, {...stop.params,expect_rev:task.rev}, () => {setNotice("Task stopped."); reload();})}>Stop task</Button>}</>}/>
    <ErrorMessage error={action.error}/><div className="pc-failure-columns"><div className="pc-failure-main">
      <section className="pc-failure-checks" aria-labelledby="failed-heading"><div className="pc-failure-checks-header"><h2 id="failed-heading">What failed</h2><span className="pc-result-caption">{failed} of {checks.length} acceptance checks{task.acceptance.summary ? ` · ${task.acceptance.summary}` : ""}</span></div>
        {checks.map(check => <div className="pc-failure-check" key={check.cmd}><span className={check.state === "failed" ? "pc-result-bad" : check.state === "passed" ? "pc-result-good" : "pc-result-caption"} aria-label={check.state}>{check.state === "failed" ? "✕" : check.state === "passed" ? "✓" : "–"}</span><div><code className="pc-result-mono pc-code-scroll">{check.cmd}</code>{check.output && <pre className="pc-failure-output pc-result-mono">{check.output}</pre>}</div><span className="pc-result-caption">{check.durationS == null ? "Time unknown" : `${check.durationS}s`}</span></div>)}
        {!checks.length && <p className="pc-result-caption">No acceptance checks recorded.</p>}
      </section>
      <section className="pc-failure-attempts" aria-labelledby="attempts-heading"><h2 id="attempts-heading">Attempts</h2>{task.attempts.map((attempt, i) => <div className="pc-failure-attempt" key={i}><AgentMark agent={markAgent(attempt.executor)} size={20} labelled={false}/><div><b>Attempt {i+1} · {executorLabel(attempt.executor)}</b><span className="pc-result-caption">{attempt.brokenReason ?? (attempt.timedOut ? "Time limit reached" : attempt.limitHit ? "Usage limit reached" : attempt.exitCode === 0 ? "Executor finished" : `Executor exited with code ${attempt.exitCode}`)}</span></div><span className="pc-result-caption">{clock(attempt.endedAt, Date.now()/1000)}</span><span>{attempt.tokens?.total == null ? "Unknown" : Intl.NumberFormat("en",{notation:"compact"}).format(attempt.tokens.total)}</span></div>)}
        <div className="pc-result-caption pc-result-report">Executor's own summary of attempt {task.attempts.length}: {task.summary ? `“${task.summary}”` : "No summary provided."} <TextAction href={hrefFor(routes.task(task.id, query))}>Full dispatch trace</TextAction></div>
      </section></div>
      <aside className="pc-failure-next" aria-labelledby="next-heading"><h2 id="next-heading">What next</h2>
        {!available && <span className="pc-result-caption">{node?.retryEligibility?.reason ?? (task.work && !tree ? "Checking retry eligibility…" : task.review ? "This task has already been reviewed." : task.retriedBy ? "This task has been superseded by a retry." : task.dismissed ? "This task has been dismissed." : ["queued", "running"].includes(task.state) ? "Wait for this attempt to finish." : "Retry is not available from this service.")}</span>}
        <RadioGroup label="Retry choice">
          {task.work && available && <OptionRow variant="retry" checked={selected !== "edit"} onSelect={() => setChoice("automatic")} title="Retry task" leading={<span className="pc-failure-radio" aria-hidden="true"/>} sub="Retry uses the dispatcher’s current routing and keeps this task’s lineage and worktree. Executor selection is automatic."/>}
          {!task.work && available && recommended && <OptionRow variant="retry" checked={selected === recommended.id} onSelect={() => setChoice(recommended.id)} title={<>Retry on {executorLabel(recommended.id)} <Pill tone="good">Recommended</Pill></>} leading={<span className="pc-failure-radio" aria-hidden="true"/>} sub={reasonCopy(recommended.reason)}/>}
          {!task.work && available && sameReady && executor && <OptionRow variant="retry" checked={selected === executor} onSelect={() => setChoice(executor)} title={`Retry on ${executorLabel(executor)} with a note`} leading={<span className="pc-failure-radio" aria-hidden="true"/>} sub="Same executor, with what you add below."/>}
          <OptionRow variant="retry" checked={selected === "edit"} onSelect={() => setChoice("edit")} title="Edit the brief, then retry" leading={<span className="pc-failure-radio" aria-hidden="true"/>} sub="Opens the task's brief and checks in New task."/>
        </RadioGroup>
        <Field label={<span className="pc-result-label">Note for the next attempt</span>}><TextArea className="pc-result-note" rows={3} maxLength={2000} value={note} onInput={event => setNote(event.currentTarget.value)}/></Field>
        {canRetry || selected === "edit" ? <Button variant="primary" busy={action.busy} onClick={retry}>{selected === "edit" ? "Edit the brief, then retry" : task.work ? "Retry task" : `Retry on ${executorLabel(selected)}`}</Button> : <span className="pc-result-caption">{feedbackUnsupported ? "This service cannot pass feedback to a different executor. Edit the brief or choose the same executor." : "No executor is ready to retry."}</span>}
        <span className="pc-result-caption">Retrying keeps previous attempts in the trace. The task leaves Needs you and shows as Running in Tasks.</span>
        <ErrorMessage error={options.error}/>
      </aside></div><div role="status" aria-live="polite">{notice}</div></>;
}

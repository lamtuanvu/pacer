import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Pill } from "../ds/Pill";
import { parseDiff } from "../model/diff";
import { routingStatus } from "../model/executors";
import type { Routing } from "../model/home";
import { activeTask, mergeTask, needsReview, taskHref, type TaskSummary } from "../model/tasks";
import { executorLabel, taskStatus } from "../../../src/view-model/words";
import { ErrorMessage, useAction, useDraft, useQuery, useTaskContext } from "./task-shared";
interface TaskDiff { base: string | null; worktree: string; diff: string; untracked: string[]; truncated: boolean }
function LiveLog({ id }: { id: string }) {
  const { api } = useTaskContext();
  const [log, setLog] = useState(""), [status, setStatus] = useState("Connecting"), [error, setError] = useState<unknown>();
  const box = useRef<HTMLPreElement>(null), follow = useRef(true);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let active = true;
    const source = new EventSource(`/v2/tasks/${encodeURIComponent(id)}/log?follow=1`);
    source.addEventListener("open", () => { if (active) { setLog(""); setStatus("Live"); setError(undefined); } });
    source.addEventListener("log", event => {
      if (!active) return;
      try {
        const chunk = JSON.parse((event as MessageEvent).data);
        setLog(value => (value + (typeof chunk.stdout === "string" ? chunk.stdout : "") + (typeof chunk.stderr === "string" ? chunk.stderr : "")).slice(-512 * 1024));
      } catch { setError(new Error("Couldn't read this log chunk.")); }
    });
    source.addEventListener("done", () => { if (active) { setStatus("Finished"); source.close(); } });
    source.addEventListener("error", () => {
      if (!active) return;
      setStatus("Reconnecting");
      void api.hello().catch(error => { if (active) setError(error); });
    });
    return () => { active = false; source.close(); };
  }, [id, api]);
  useLayoutEffect(() => { if (follow.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [log]);
  return <Card><div className="row"><Pill tone={status === "Live" ? "info" : "neutral"}>{status}</Pill><span className="muted">stdout and stderr · latest 512 KiB</span>{paused && <Button onClick={() => { follow.current = true; setPaused(false); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}>Resume scrolling</Button>}</div><ErrorMessage error={error} /><pre ref={box} className="task-log" role="log" aria-label="Task log" tabIndex={0} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 32; setPaused(!follow.current); }}>{log || "Waiting for output…"}</pre></Card>;
}
function Changes({ id, revision }: { id: string; revision: string }) {
  const query = useQuery<TaskDiff>("task.diff", { id }, revision);
  return <Card><h2>Changes</h2><ErrorMessage error={query.error} />{query.error && <Button onClick={query.reload}>Try again</Button>}{query.loading && !query.data && <p>Loading changes…</p>}{query.data && <>
    <p className="muted">Compared with {query.data.base ?? "HEAD"} · <code>{query.data.worktree}</code></p>
    {parseDiff(query.data.diff).map((file, index) => <details className="diff-file" key={`${file.path}-${index}`}><summary><code>{file.path}</code> <Pill tone="good">+{file.added}</Pill> <Pill tone="bad">−{file.removed}</Pill>{file.binary && <Pill>Binary file</Pill>}</summary><pre className="diff" aria-label={`Diff of ${file.path}`}>{file.lines.map((line, i) => <span key={i} className={`diff-${line.kind}`}>{line.text || " "}</span>)}</pre></details>)}
    {!query.data.diff && <p>No tracked changes.</p>}{query.data.truncated && <Pill tone="warn">Diff truncated at 1 MiB</Pill>}
    {!!query.data.untracked.length && <><h2>Untracked files</h2><ul>{query.data.untracked.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
  </>}</Card>;
}
function Review({ task, reload }: { task: TaskSummary; reload: () => void }) {
  const [draft, setDraft] = useDraft(`pacer.review.${task.task_id}`, { note: "", executor: "" });
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const routing = useQuery<Routing>("routing.route", task.kind ? { kind: task.kind } : {});
  const action = useAction();
  const review = (accepted: boolean) => { void action.run("task.review", { id: task.task_id, accepted, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) }, () => { setDraft({ ...draft, note: "" }); reload(); }); };
  return <Card><h2>Your review</h2>{task.review && <><Pill tone={task.review.accepted ? "good" : "bad"}>{task.review.accepted ? "Accepted" : "Rejected"}</Pill>{task.review.note && <p>{task.review.note}</p>}</>}
    {needsReview(task) && <><label htmlFor="taskdetail-review-note" className="field">Note (optional)<textarea id="taskdetail-review-note" maxLength={2000} value={draft.note} onInput={e => setDraft({ ...draft, note: e.currentTarget.value })} /></label><div className="row"><Button variant="primary" disabled={action.busy} onClick={() => review(true)}>Accept</Button><Button disabled={action.busy} onClick={() => review(false)}>Reject</Button></div><p className="muted">Accepting records your review. The branch stays for you to merge.</p></>}
    {!activeTask(task.state) && <div className="form-row"><label htmlFor="taskdetail-retry-executor" className="field">Retry executor (optional)<select id="taskdetail-retry-executor" value={draft.executor} onChange={e => setDraft({ ...draft, executor: e.currentTarget.value })}><option value="">Automatic</option>{routing.data?.ranked.map(r => <option value={r.id} key={r.id}>{executorLabel(r.id, accounts.data ?? [])} · {routingStatus(r).label}</option>)}</select></label><Button disabled={action.busy} onClick={() => { void action.run<{ retry: TaskSummary }>("task.retry", { id: task.task_id, ...(draft.executor ? { executor: draft.executor } : {}) }, result => { location.hash = taskHref(result.retry.task_id); }); }}>Retry</Button><ErrorMessage error={routing.error} /></div>}
    {activeTask(task.state) && <Button disabled={action.busy} onClick={() => { void action.run("task.stop", { id: task.task_id }, reload); }}>Stop</Button>}
    <div aria-live="polite"><ErrorMessage error={action.error} />{action.message}</div>
  </Card>;
}
export function TaskDetail({ id }: { id: string }) {
  return <Task key={id} id={id} />;
}
function Task({ id }: { id: string }) {
  const { state } = useTaskContext();
  const live = state.snapshot?.tasks.find(task => task.id === id);
  const revision = JSON.stringify(live);
  const query = useQuery<TaskSummary>("task.get", { id }, revision);
  const [tab, setTab] = useState("changes");
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const task = query.data && mergeTask(query.data, live);
  const status = taskStatus({ state: task?.state ?? live?.state ?? "Loading", review: live?.review ?? task?.review });
  return <section className="screen"><a href="#/sessions">← Sessions</a><div className="top"><h1>{task?.goal || live?.goal || id}</h1><Pill tone={status.tone}>{status.label}{task && needsReview(task) ? " · waiting for review" : ""}</Pill></div><ErrorMessage error={query.error} />{query.error && <Button onClick={query.reload}>Try again</Button>}
    {task && <><Card><dl className="facts"><dt>Executor</dt><dd>{executorLabel(live?.executor ?? task.result?.executor ?? task.attempts.at(-1)?.executor ?? task.requested_executor, accounts.data ?? [])}</dd><dt>Kind</dt><dd>{task.kind ?? "Not specified"}</dd><dt>Where</dt><dd><code>{live?.worktree ?? task.result?.worktree ?? "Not available"}</code></dd><dt>Changes</dt><dd>{live?.progress ? `${live.progress.files} files · ${live.progress.commits} commits` : task.result?.files || "Not available"}</dd>{task.result?.acceptance && <><dt>Acceptance</dt><dd><Pill tone={task.result.acceptance.passed ? "good" : "bad"}>{task.result.acceptance.passed ? "Passed" : "Failed"}</Pill><pre className="acceptance-output">{task.result.acceptance.tail}</pre></dd></>}</dl></Card>
    <div className="tabs" aria-label="Task view">{["changes", "log", "brief"].map(key => <Button className={tab === key ? "tab on" : "tab"} aria-pressed={tab === key} key={key} onClick={() => setTab(key)}>{key === "changes" ? "Changes" : key === "log" ? "Log" : "Brief"}</Button>)}</div>
    {tab === "changes" && <Changes id={id} revision={revision} />}{tab === "log" && <LiveLog id={id} />}{tab === "brief" && <Card><h2>Goal</h2><p>{task.goal || live?.goal || "Goal not available."}</p><h2>Executor report</h2><pre className="report">{task.result?.report || "No report yet."}</pre></Card>}
    <Review task={task} reload={query.reload} /></>}
  </section>;
}

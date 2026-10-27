import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import type { TaskDetail } from "../../../src/core/task-detail";
import type { ApiTask } from "../../../src/api/read-model/types";
import { executorLabel, taskOutcome, taskStatus } from "../../../src/view-model/words";
import { scopedTaskTree, taskTree } from "../../../src/view-model/task-tree";
import { clock } from "../../../src/view-model/time";
import { Button, TextAction } from "../ds/Button";
import { Disclosure, Field, TextArea } from "../ds/Controls";
import { EmptyState, LoadingState, Tabs } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import { useActions } from "../data/action-context";
import { withQuery, type RouteQuery } from "../router";
import { SessionRoute } from "./session/controller";
import { TaskNavigator } from "./session/TaskNavigator";
import { useQuery, useTaskContext } from "./task-shared";
import { VerdictPanel } from "./review/VerdictPanel";
import { parseDiff } from "../model/diff";
import { Diff } from "./review/Diff";
import type { Verdict } from "./review/model";
import { Page, PageTitle, Stack } from "../ds/Page";
import { LazyWork } from "./work/LazyWork";

export function resultSummary(task: TaskDetail): string {
  if (task.state === "queued") return "Waiting to start. Follow this task in Session.";
  if (task.state === "running") return "Execution is in progress. Follow output in Session.";
  const text = task.summary?.trim();
  if (text && text.split("\n").length <= 8 && !/I'll start|Let me (?:read|look|check|explore)/i.test(text)) return text;
  return task.state === "done" ? "Execution finished. Inspect the checks and changes below." : task.state === "partial" ? "Execution ended with incomplete work." : "Execution ended. Inspect the result below.";
}
export function TaskResultView({ task, verdict, changes, question, onChanges, embedded = false }: {
  task: TaskDetail; verdict?: ComponentChildren; changes?: ComponentChildren; question?: ComponentChildren; onChanges?: () => void; embedded?: boolean;
}) {
  const problem = task.acceptance.state === "failed" || ["partial","failed","limit"].includes(task.state);
  const openReview = !!task.reviewRequest && !task.review && !task.resolved && !task.dismissed && !task.retriedBy;
  return <Page width="full" embedded={embedded}>
    {!embedded && <TaskHeading task={task}/>}
    <div className="pc-page-columns"><div className="pc-page-columns__main"><div className="pc-stack pc-stack--section">
      <section className="pc-section"><SectionHeading>Result</SectionHeading><p>{resultSummary(task)}</p><p className="muted">{taskOutcome(task).label}</p></section>
      <section className="pc-section"><SectionHeading>Checks &amp; changes</SectionHeading>
        <p className={task.acceptance.state === "failed" ? "pc-warn-text" : "muted"}>{task.acceptance.state === "failed" ? "Checks failed" : task.acceptance.state === "passed" ? "Checks passed" : task.acceptance.state === "none" ? "No acceptance checks recorded" : "Checks have no final result"}{task.acceptance.summary ? ` · ${task.acceptance.summary}` : ""}</p>
      <Stack space="compact">
        {task.acceptance.tail && <Disclosure className="pc-disclosure-panel" summary="Acceptance output" open={task.acceptance.state === "failed"}><div className="pc-disclosure-panel__body"><pre className="mono pc-code-scroll">{task.acceptance.tail}</pre></div></Disclosure>}
        <Disclosure className="pc-disclosure-panel" summary={`Changes · ${task.files.length} files`} onToggle={e => { if (e.currentTarget.open) onChanges?.(); }}><div className="pc-disclosure-panel__body">{changes ?? <p className="muted">Expand to load changes.</p>}</div></Disclosure>
      <Disclosure className="pc-disclosure-panel" summary="Executor transcript"><div className="pc-disclosure-panel__body"><pre className="mono pc-code-scroll">{task.summary ?? "No executor output recorded."}</pre></div></Disclosure>
      <Disclosure className="pc-disclosure-panel" summary="Brief"><div className="pc-disclosure-panel__body"><p className="report">{task.brief.goal}</p>{task.brief.acceptance && <code className="pc-code-scroll">{task.brief.acceptance}</code>}</div></Disclosure>
      <Disclosure className="pc-disclosure-panel" summary="Technical routing and cost"><div className="pc-disclosure-panel__body"><pre className="mono pc-code-scroll">{JSON.stringify({ routing: task.routing, cost: task.cost }, null, 2)}</pre></div></Disclosure>
      </Stack>
      </section>
    </div></div><aside className="pc-page-columns__aside">
      <section className="pc-action-panel"><SectionHeading>Next step</SectionHeading>
        {task.work ? <p>Use the Work tab for decisions and history.</p> : question ?? (openReview || problem ? <><p>{task.reviewRequest?.note ?? (task.acceptance.state === "failed" ? "Inspect the failed checks before continuing." : task.state === "partial" ? "Inspect the incomplete work before continuing." : "Inspect the failure and retry when ready.")}</p>{verdict}</> : <><p className="muted">{task.acceptance.state === "failed" ? "Inspect the failed checks before deciding how to continue." : task.state === "partial" ? "Inspect the incomplete work before continuing." : task.review ? "This result has a recorded verdict." : "No acknowledgment required."}</p>{verdict && <Disclosure className="pc-disclosure" summary="Optional verdict">{verdict}</Disclosure>}</>)}
      </section>
      <section className="pc-section"><SectionHeading>Delivery</SectionHeading><p className="muted">Integration not recorded</p>{task.branch && <code className="pc-code-scroll">{task.branch}</code>}<p className="muted">Accepting records a verdict. Integrate changes separately.</p></section>
    </aside></div>
  </Page>;
}

export function ResultChanges({patch,untracked,truncated,note}:{patch:string;untracked:string[];truncated:boolean;note?:string}) {
  const files=parseDiff(patch);
  return <>{note&&<p className="muted">{note}</p>}{files.map(file=><Diff key={file.path} path={file.path} patch={patch} binary={file.binary} truncated={truncated}/>)}
    {!files.length&&patch&&<pre className="mono pc-code-scroll">{patch}</pre>}
    {!patch&&!untracked.length&&<p className="muted">No changes recorded.</p>}
    {untracked.length>0&&<><SectionHeading>Untracked files</SectionHeading><pre className="mono pc-code-scroll">{untracked.join("\n")}</pre></>}
  </>;
}

function TaskResultLoaded({ task, reload }: { task: TaskDetail; reload: () => void }) {
  const { api, state } = useTaskContext(), runner = useActions();
  const [note,setNote] = useState(""), [kind,setKind] = useState(task.kind ?? ""), [executor,setExecutor] = useState("");
  const [noteFor,setNoteFor] = useState<"reject" | "send_back" | null>(null);
  const [pending,setPending] = useState(false), [message,setMessage] = useState("");
  const [changes,setChanges] = useState<{patch:string;untracked:string[];truncated:boolean;note?:string}>();
  const [changesError,setChangesError] = useState(""), [loadingChanges,setLoadingChanges] = useState(false);
  const inFlight = useRef(false), noteRef = useRef<HTMLTextAreaElement>(null);
  const [answer,setAnswer] = useState("");
  async function loadChanges() {
    if (changes || loadingChanges) return;
    setLoadingChanges(true);setChangesError("");
    try { setChanges(await api.call("task.diff", {id:task.id})); }
    catch { setChangesError("Changes unavailable. The worktree may have been removed."); }
    finally { setLoadingChanges(false); }
  }
  async function submit(verdict: Verdict["verdict"]) {
    if (inFlight.current) return;
    if ((verdict === "send_back" || verdict === "reject") && !note.trim()) { setMessage("Add a note before confirming.");noteRef.current?.focus();return; }
    inFlight.current = true;setPending(true);setMessage("");
    try {
      const key = `result:${task.id}:verdict`;
      const result = await runner.run(key,{label:"Record verdict",op:"task.review",params:{id:task.id,verdict,expect_rev:task.rev,...(note.trim()?{note:note.trim()}:{}),...(kind?{kind}:{}),...(verdict==="retry"?{executor}:{})}});
      if (result.status === "error" || result.status === "handled") setMessage(result.message);
      else {
        const response = runner.result(key) as {retry?:{id:string}} | undefined;
        setMessage(verdict === "accept" ? "Marked accepted. Integration is separate." : "Verdict recorded.");
        if (response?.retry?.id) location.hash = `#/tasks/${encodeURIComponent(response.retry.id)}`;
      }
      reload();
    } finally { inFlight.current=false;setPending(false); }
  }
  const canReview = legacyReviewAvailable(task,state.features.ops.has("task.review"));
  const panel = canReview ? <VerdictPanel recovery={task.acceptance.state === "failed" || ["partial","failed","limit"].includes(task.state)} task={task} note={note} kind={kind} executor={executor} noteFor={noteFor} pending={pending} noteRef={noteRef}
    onNote={setNote} onKind={setKind} onExecutor={setExecutor} onOpenNote={v=>{setNoteFor(v);queueMicrotask(()=>noteRef.current?.focus());}} onCancel={()=>setNoteFor(null)} onSubmit={v=>void submit(v)} /> : undefined;
  const isQuestion = legacyQuestionPending(task);
  const question = isQuestion ? <><p>{task.question!.text}</p><Field label="Your answer"><TextArea value={answer} rows={4} onInput={e=>setAnswer(e.currentTarget.value)} /></Field><Button variant="primary" busy={pending} disabled={!answer.trim()} onClick={async()=>{
    if(inFlight.current)return;inFlight.current=true;setPending(true);
    try { const result=await runner.run(`answer:${task.id}`,{label:"Answer",op:"task.answer",params:{id:task.id,text:answer,expect_rev:task.rev}});setMessage(result.status==="error"||result.status==="handled"?result.message:"Answer sent.");reload(); }
    finally {inFlight.current=false;setPending(false);}
  }}>Send answer</Button></> : undefined;
  return <><TaskResultView embedded task={task} verdict={panel} question={question} onChanges={()=>void loadChanges()} changes={loadingChanges ? <LoadingState label="Loading changes…"/> : changesError ? <p role="status">{changesError}</p> : changes ? <ResultChanges {...changes}/> : undefined}/><p role="status" aria-live="polite">{message}</p></>;
}
export function legacyQuestionPending(task: TaskDetail): boolean {
  return !task.work && task.state === "needs_input" && !!task.question && task.question.answer === undefined && !task.retriedBy && !task.dismissed;
}
export function legacyReviewAvailable(task: TaskDetail, supportsReview: boolean): boolean {
  return !task.work && !["queued", "running"].includes(task.state) && supportsReview && !task.review && !task.resolved && !task.dismissed && !task.retriedBy;
}
export function TaskHeading({ task }: { task: TaskDetail }) {
  const title = task.title?.trim() || task.fullTitle?.trim() || task.goal;
  const status = taskStatus(task);
  return <header className="pc-task-workspace__head"><div className="pc-task-workspace__identity"><PageTitle title={title}>{title}</PageTitle><div className="pc-task-workspace__meta"><span title={task.repo.label}>{task.repo.label}</span><span aria-hidden="true">·</span>{executorLabel(task.executor)}{task.endedAt && <><span aria-hidden="true">·</span>finished {clock(task.endedAt, Date.now() / 1000)}</>}</div></div><span className={`pc-task-workspace__status pc-task-workspace__status--${status.tone}`}>{status.label}</span></header>;
}

export function TaskDetailFrame({ task, query, tab, onTab, children, navigator }: {
  task: TaskDetail; query: RouteQuery; tab: string; onTab: (value: string) => void; children: ComponentChildren; navigator?: ComponentChildren;
}) {
  const id = `task-${task.id}`;
  return <div className="pc-task-workspace">{navigator}<div className="pc-task-workspace__main">
    <div className="pc-task-workspace__navigation">
      <nav aria-label="Task navigation" className="pc-task-workspace__breadcrumb"><TextAction href={withQuery("#/tasks", query)}>Tasks</TextAction><span aria-hidden="true">/</span><span>Task</span></nav>
      <TaskHeading task={task}/>
      <div className="pc-task-workspace__tabs"><Tabs label="Task views" id={id} value={tab} options={[{value:"session",label:"Session"},{value:"changes",label:"Changes"},{value:"brief",label:"Brief"},{value:"result",label:"Result"},...(task.work?[{value:"work",label:"Work"}]:[])]} onChange={onTab}/></div>
    </div>
    <div role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}-tab`} tabIndex={0} className="pc-task-workspace__panel">{children}</div>
  </div></div>;
}

export function TaskRoute({ id, query }: { id: string; query: RouteQuery }) {
  const [selection, setSelection] = useState<{id:string;tab:string}>();
  const { state } = useTaskContext();
  const task = useQuery<TaskDetail>("task.get", {id});
  const history = useQuery<{tasks:ApiTask[]}>("task.list",{all:true,limit:20,...(query.repo?{repo:query.repo}:{})});
  if (!task.data) return task.error ? <EmptyState title="Could not load task" description="Try refreshing the page."/> : <LoadingState label="Loading task…"/>;
  // The selected task joins the tree with its parent link, so a subtask opens under its root.
  const selected={...task.data,parentId:task.data.work?.parentId??null};
  const extra=[...(history.data?.tasks??[]),selected];
  const now=Date.now()/1000;
  const nodes=state.snapshot?scopedTaskTree(state.snapshot,{repo:query.repo||null},{now,extra,pinned:id}):taskTree({tasks:extra.filter(item=>!query.repo||item.repo?.key===query.repo||item.id===id)},{now});
  const navigator=<TaskNavigator selectedId={id} nodes={nodes} query={withQuery('',query)}/>;
  const tab = selection?.id === id ? selection.tab : (["queued", "running"].includes(task.data.state) ? "session" : "result");
  return <TaskDetailFrame task={task.data} query={query} tab={tab} onTab={value=>setSelection({id,tab:value})} navigator={navigator}>
    {tab === "work" ? <LazyWork id={id}/> : tab === "result" ? <TaskResultLoaded key={id} task={task.data} reload={task.reload}/> : <SessionRoute id={id} embedded view={tab === "changes" ? "changes" : tab === "brief" ? "brief" : "terminal"}/>}
  </TaskDetailFrame>;
}

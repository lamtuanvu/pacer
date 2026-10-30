import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../../../src/session/service";
import type { TaskDetail } from "../../../../src/core/task-detail";
import { executorLabel } from "../../../../src/view-model/words";
import { clock } from "../../../../src/view-model/time";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { TextArea } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { LoadingState, SegmentedControl, SelectableRow } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { useActions } from "../../data/action-context";
import { hrefFor, routes, type RouteQuery } from "../../router";
import { ErrorMessage, useQuery, useTaskContext } from "../task-shared";
import { Failure } from "../failure/Failure";
import { reviewAvailable } from "../failure/model";
import { Diff } from "./Diff";
import { canOpenResultFile, retryReviewedWork, verdictParams } from "./model";
import type { ResultPageProps } from "./LazyResultPage";

export interface WorkResult { nodes: { taskId: string; parentId: string | null; review: {accepted: boolean} | null; waivedChildren: string[]; retryEligibility?: {allowed: boolean; reason?: string} }[] }
export function useResultAction() {
  const runner = useActions(), inFlight = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  async function run(op: string, params: Record<string, unknown>, done: (result: unknown) => void | Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const key = `result:${op}:${JSON.stringify(params)}`;
      const outcome = await runner.run(key, {label: "Update task", op, params});
      if (outcome.status === "done") await done(runner.result(key));
      else if (outcome.status === "error" || outcome.status === "handled") setError(new Error(outcome.message));
    } catch (error) { setError(error); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return {run, busy, error};
}
export const tokenCount = (total: number | null | undefined) => total == null ? "Unknown tokens" : `${Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1}).format(total)} tokens`;
export function ResultHeader({task, query, failure, actions, requesting, subtasks}: {task: TaskDetail; query: RouteQuery; failure?: boolean; actions?: ComponentChildren; requesting?: boolean; subtasks?: number}) {
  const accepted = task.review?.accepted;
  const status = failure ? "Checks failed" : accepted === true ? "Accepted" : requesting ? "Changes requested" : accepted === false ? "Rejected" : "Waiting for review";
  return <><nav aria-label="Breadcrumb" className="pc-result-breadcrumb"><TextAction href={hrefFor(routes.needsYou(query))}>Needs you</TextAction><span aria-hidden="true">/</span><span className="pc-result-mono">{task.id}</span></nav>
    <header className="pc-result-header"><div className="pc-result-identity"><h1>{task.title || task.fullTitle || task.goal}</h1><div className="pc-result-meta">
      <Pill tone={failure ? "bad" : accepted === true ? "good" : requesting ? "warn" : accepted === false ? "bad" : "info"}>{status}</Pill>
      {!failure && <Pill tone={task.acceptance.state === "passed" ? "good" : task.acceptance.state === "failed" ? "bad" : "neutral"}>{task.acceptance.state === "passed" ? "Checks passed · 1 of 1" : task.acceptance.state === "failed" ? "Checks failed · 1 of 1" : "No final checks"}</Pill>}
      {task.kind && <Pill>{task.kind}</Pill>}<span className="pc-result-caption pc-result-mono">{task.repo.label} · {task.branch ?? "Branch unknown"}{!failure && task.base ? ` → ${task.base}` : ""}</span>
      <span className="pc-result-caption">· {failure ? `${task.attempts.length} attempt${task.attempts.length === 1 ? "" : "s"} on ${executorLabel(task.executor ?? task.attempts.at(-1)?.executor)}` : `${subtasks ? `${subtasks} subtasks · ` : ""}${[...new Set(task.attempts.map(a => executorLabel(a.executor)))].join(", ") || executorLabel(task.executor)}`} · {tokenCount(task.tokens && task.tokens.unknownAttempts === task.attempts.length ? null : task.tokens?.total)}{failure && task.endedAt ? ` · last ${clock(task.endedAt, Date.now()/1000)}` : ""}</span>
    </div></div><div className="pc-result-actions">{actions}</div></header></>;
}
export function ResultPage({id, query, failure}: ResultPageProps) {
  const task = useQuery<TaskDetail>("task.get", {id});
  const {api} = useTaskContext();
  const [tree, setTree] = useState<WorkResult>(), [treeError, setTreeError] = useState<unknown>();
  useEffect(() => {
    if (!task.data?.work) return;
    let active = true;
    void api.call<WorkResult>("dispatch.tree", {id}).then(value => {if (active) {setTree(value); setTreeError(undefined);}}).catch(error => {if (active) setTreeError(error);});
    return () => {active = false;};
  }, [api, id, task.data?.rev, !!task.data?.work]);
  if (!task.data) return <div className="pc-result-page">{task.error ? <><ErrorMessage error={task.error}/><Button onClick={task.reload}>Try again</Button></> : <LoadingState label="Loading result…"/>}</div>;
  return <div className={`pc-result-page${failure ? " pc-result-page--failure" : ""}`}><ErrorMessage error={task.error ?? treeError}/>{failure
    ? <Failure task={task.data} query={query} reload={task.reload} tree={tree}/>
    : <ReviewResult task={task.data} query={query} reload={task.reload} tree={tree}/>}</div>;
}
interface ResultDiff {patch: string; truncated?: boolean; note?: string}
function ReviewResult({task, query, reload, tree}: {task: TaskDetail; query: RouteQuery; reload: () => void; tree?: WorkResult}) {
  const action = useResultAction(), {api, state} = useTaskContext();
  const [requesting, setRequesting] = useState(false), [rejecting, setRejecting] = useState(false), [note, setNote] = useState("");
  const [recorded, setRecorded] = useState<"accept" | "reject" | "send_back">(), [selected, setSelected] = useState<string>(), [layout, setLayout] = useState("unified");
  const [file, setFile] = useState<{path: string; text: string}>(), [fileError, setFileError] = useState<unknown>(), [opening, setOpening] = useState(false);
  const path = task.files.some(f => f.path === selected) ? selected! : task.files[0]?.path;
  const session = useQuery<SessionInfo>("task.session", {id: task.id});
  const diff = useQuery<ResultDiff>("task.diff", {id: task.id, ...(path ? {path} : {})});
  const node = tree?.nodes.find(n => n.taskId === task.id), children = tree?.nodes.filter(n => n.parentId === task.id) ?? [];
  const childrenReady = !task.work || !!node && children.every(child => child.review?.accepted || node.waivedChildren?.includes(child.taskId));
  const canReview = reviewAvailable(task) && !recorded && state.features.ops.has(task.work ? "dispatch.review" : "task.review");
  const executor = executorLabel(task.executor ?? task.attempts.at(-1)?.executor);
  const submit = (verdict: "accept" | "reject" | "send_back") => {
    const op = task.work ? "dispatch.review" : "task.review";
    const params = task.work ? {id:task.id, expect_rev:task.rev, accepted:verdict === "accept", ...(note.trim() ? {note:note.trim()} : {})} : verdictParams(task, {verdict, note});
    void action.run(op, params, async () => {
      try {
        if (task.work && verdict === "send_back") await retryReviewedWork(task.id, note, api.call.bind(api));
        setRecorded(verdict); setRequesting(false); setRejecting(false);
      } finally {reload();}
    });
  };
  const remaining = state.snapshot?.attention ? new Set(state.snapshot.attention.filter(item => item.taskId && item.taskId !== task.id).map(item => item.taskId)).size : undefined;
  const canOpen = state.features.ops.has("session.file.read") && canOpenResultFile(task, session.data, path);
  const accepted = recorded === "accept" || task.review?.accepted === true;
  const openFile = async () => {
    if (!path || !canOpen || opening) return;
    setOpening(true); setFileError(undefined);
    try { const result = await api.call<{text:string}>("session.file.read", {id:task.id, attempt:session.data!.attempt!, reference:path}); setFile({path, text:result.text}); }
    catch (error) {setFileError(error);} finally {setOpening(false);}
  };
  return <><ResultHeader task={recorded === "accept" ? {...task,review:{...task.review,accepted:true} as TaskDetail["review"]} : task} query={query} subtasks={tree?.nodes.filter(n => n.taskId !== task.id).length} requesting={requesting || recorded === "send_back"} actions={canReview && !requesting && !rejecting && <>
    <Button busy={action.busy} onClick={() => {setRejecting(true); setNote("");}}>Reject</Button>
    {(task.work || task.executor) && <Button busy={action.busy} onClick={() => {setRequesting(true); setNote("");}}>Request changes</Button>}
    {childrenReady ? <Button variant="primary" busy={action.busy} onClick={() => submit("accept")}>Accept result</Button> : <span className="pc-result-caption">Review required child work before accepting.</span>}
  </>}/>
    <ErrorMessage error={action.error}/>
    {accepted && <div role="status" className="pc-result-accepted"><span className="pc-result-good" aria-hidden="true">✓</span><span><b>Accepted.</b> Branch <span className="pc-result-mono">{task.branch ?? "(unknown)"}</span> is kept with its {task.files.length} files; the report is filed on the task. {remaining === 0 ? "Nothing else needs you." : remaining === undefined ? "" : `${remaining} more ${remaining === 1 ? "needs" : "need"} you · `}{remaining !== undefined && remaining > 0 && <TextAction className="pc-result-good" href={hrefFor(routes.needsYou(query))}>Open Needs you</TextAction>}</span><ButtonLink size="sm" href={hrefFor(routes.tasks(query))}>Back to Tasks</ButtonLink></div>}
    {recorded === "reject" && <p role="status">Result rejected. The verdict is filed on the task.</p>}
    {recorded === "send_back" && <p role="status">Changes requested. Sent back to {executor}.</p>}
    {(requesting || rejecting) && <section className="pc-result-request" aria-labelledby="request-heading"><h2 id="request-heading">{rejecting ? "Why reject this result?" : "What should change?"}</h2>
      <TextArea className="pc-result-note" aria-label={rejecting ? "Rejection note" : "What should change?"} autoFocus rows={3} maxLength={2000} value={note} onInput={event => setNote(event.currentTarget.value)}/>
      <div className="pc-result-actions"><Button busy={action.busy} onClick={() => {setRequesting(false); setRejecting(false); setNote("");}}>Cancel</Button><Button variant="primary" busy={action.busy} disabled={!note.trim()} onClick={() => submit(rejecting ? "reject" : "send_back")}>{rejecting ? "Reject result" : `Send back to ${executor}`}</Button></div>{!note.trim() && <span className="pc-result-caption">Add a note to continue.</span>}</section>}
    <section className="pc-result-summary" aria-labelledby="report-heading"><h2 id="report-heading">What the agents report</h2><div className="pc-result-report">{task.summary ?? "No summary provided."}</div></section>
    <div className="pc-result-changes"><nav className="pc-result-files" aria-label="Changed files"><span className="pc-result-label">Changed · {task.files.length} files</span>{task.files.map(item => <SelectableRow key={item.path} className="pc-result-file" selected={path === item.path} onClick={() => {setSelected(item.path); setFileError(undefined);}}><span className="pc-result-mono pc-result-filepath" title={item.path}>{item.path}</span><span className="pc-result-good pc-result-mono">{item.binary ? "bin" : `+${item.added}`}</span>{item.removed > 0 && <span className="pc-result-bad pc-result-mono">−{item.removed}</span>}</SelectableRow>)}{!task.files.length && <span className="pc-result-caption">No changed files recorded.</span>}</nav>
      <section className="pc-result-diff" aria-label={path ? `Diff of ${path}` : "Changes"}><div className="pc-result-diff-header"><span className="pc-result-mono pc-result-filepath" title={path}>{path ?? "No file selected"}</span>{path && <><SegmentedControl variant="result" label="Diff layout" value={layout} options={[{value:"unified",label:"Unified"},{value:"split",label:"Split"}]} onChange={setLayout}/>{canOpen && <Button variant="quiet" size="sm" busy={opening} onClick={() => void openFile()}>Open file</Button>}</>}</div>
        <ErrorMessage error={diff.error ?? fileError}/>{diff.loading && !diff.data ? <LoadingState label="Loading diff…"/> : path && diff.data ? <Diff path={path} patch={diff.data.patch} binary={task.files.find(f => f.path === path)?.binary} truncated={diff.data.truncated} note={diff.data.note} layout={layout === "split" ? "split" : "unified"}/> : <p className="pc-result-caption">No diff available.</p>}
      </section></div>
    {file && <Dialog title={file.path} close={() => setFile(undefined)}><pre className="pc-result-mono pc-code-scroll">{file.text}</pre></Dialog>}
  </>;
}

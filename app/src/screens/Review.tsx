import type { ComponentChildren } from "preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../../src/api/read-model/types";
import type { TaskDetail } from "../../../src/core/task-detail";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { reviewQueue } from "../../../src/view-model/selectors";
import { clock, elapsed } from "../../../src/view-model/format";
import { executorLabel, taskStatus } from "../../../src/view-model/words";
import { Pill } from "../ds/Pill";
import { withQuery, type Route } from "../router";
import { useActions } from "../data/action-context";
import type { ActionRunner } from "../data/actions";
import type { KeyRegistry } from "../keys/registry";
import { keys } from "../keys/instance";
import { VerdictPanel } from "./review/VerdictPanel";
import { ErrorMessage, useQuery, useTaskContext } from "./task-shared";
import { Diff } from "./review/Diff";
import { initialReview, reviewReducer, verdictParams, type Verdict, type ReviewAction, type ReviewView as ReviewState } from "./review/model";

export interface ReviewDiff { base: string | null; worktree: string; files: TaskDetail["files"]; patch: string; diff: string; untracked: string[]; truncated: boolean; note?: string }
export interface ReviewProps {
  snapshot: ClientSnapshot; view: ReviewState; task?: TaskDetail; now: number;
  filePath?: string; diff?: ReviewDiff; loading?: boolean; error?: unknown;
  onSelect?: (id: string) => void; onFile?: (path: string) => void; onOpen?: () => void;
  verdictPanel?: ComponentChildren; announcement?: string;
}
function Queue({ items, selected, onSelect }: { items: AttentionItem[]; selected: string | null; onSelect?: (id: string) => void }) {
  return <nav className="pc-review-queue" aria-label="Review queue"><h2>Review queue · {items.length}</h2>
    {items.map(item => <button type="button" key={item.id} aria-current={item.taskId === selected ? "true" : undefined} onClick={() => item.taskId && onSelect?.(item.taskId)}>
      <strong>{item.title}</strong><span className="muted">{item.repo?.label}</span><span className="muted">{item.detail}</span>
    </button>)}
  </nav>;
}
export function ReviewView({ snapshot, view, task, now, filePath, diff, loading, error, onSelect, onFile, onOpen, verdictPanel, announcement }: ReviewProps) {
  const status = task && taskStatus(task), acceptance = task?.acceptance;
  return <><div className="pc-review">
    {!view.queue.length ? <section className="pc-review-empty"><h1>Review queue is clear</h1><p className="muted">Accepted today {snapshot.today?.accepted ?? 0} · rejected {snapshot.today?.rejected ?? 0}</p></section> : <>
      <Queue items={view.queue} selected={view.selectedId} onSelect={onSelect} />
      <article className="pc-review-item" aria-busy={loading}><ErrorMessage error={error} />
        {view.missing ? <section className="pc-notice"><h2>Already reviewed</h2><p><code>{view.missing}</code> is no longer waiting for review. <a href={`#/sessions/${encodeURIComponent(view.missing)}`}>Open it in Sessions</a>, or pick one from the queue.</p></section>
        : !task ? (error ? null : <p className="muted">Loading task…</p>) : <>
          <div className="row"><h1 className="headline">{task.goal}</h1><Pill tone={status!.tone}>{status!.label}</Pill></div>
          <p className="pc-review-run muted"><code title={executorLabel(task.executor)}>{task.executor}</code>{task.startedAt !== null && task.endedAt !== null && <> · {elapsed(task.endedAt - task.startedAt)}</>} · {task.branch} → {task.base} · {task.repo.label}{task.endedAt !== null && <> · finished {clock(task.endedAt, now)}</>}</p>
          <section><h2>Done when</h2>{acceptance?.state === "none" ? <p>No done-when command</p> : <>
            <code>{acceptance?.cmd}</code><p>{acceptance?.state === "passed" ? "✓ " : ""}{acceptance?.summary ?? acceptance?.state}{acceptance?.durationS !== undefined && ` · ${acceptance.durationS} s`}{acceptance?.machine && ` · run by pacer on ${acceptance.machine}`}</p>
            {acceptance?.tail && <details><summary>Acceptance output</summary><pre className="acceptance-output">{acceptance.tail}</pre></details>}
          </>}</section>
          <section><h2>Why this executor</h2><p>{task.routing?.why ?? "No routing explanation"}</p>{task.routing?.skipped.map((s, i) => <p className="muted" key={i}><code>{s.executor}</code> · {s.reason}</p>)}</section>
          {task.cost.executor && <section><h2>Cost</h2><p>{task.cost.executor.account} · {task.cost.executor.deltaPct === null ? (task.cost.executor.reason === "shared" ? "Shared usage" : "No reading") : `${task.cost.executor.deltaPct}%`}{task.cost.executor.window && ` · ${task.cost.executor.window}`}</p></section>}
          <details><summary>Brief</summary><dl className="facts pc-review-brief">
            {([["Goal", task.brief.goal], ["Repository", task.brief.repo], ["Scope", task.brief.scope], ["Done when", task.brief.acceptance], ["Constraints", task.brief.constraints], ["Context", task.brief.context], ["Feedback", task.brief.feedback], ["Base", task.brief.base]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            {task.brief.qa?.map((entry, i) => <div key={i}><dt>{entry.q}</dt><dd>{entry.a}</dd></div>)}
          </dl></details>
          <section><h2>Executor summary</h2><p className="report">{task.summary ?? "No summary provided"}</p></section>
          <section><h2>Changes</h2><div className="pc-review-files" role="group" aria-label="Changed files">{task.files.map(file => <button type="button" key={file.path} aria-pressed={(filePath ?? task.files[0]?.path) === file.path} onClick={() => onFile?.(file.path)}><code>{file.path}</code><span className="muted">{file.status}</span><span>+{file.added} −{file.removed}</span>{file.binary && <span>Binary file</span>}</button>)}</div>
            {diff && <Diff path={filePath ?? task.files[0]?.path ?? ""} patch={diff.patch} binary={task.files.find(f => f.path === filePath)?.binary} truncated={diff.truncated} note={diff.note} onOpen={onOpen} />}
          </section>
        </>}
      </article>
      {!view.missing && <aside className="pc-review-verdict" aria-label="Verdict">{verdictPanel}</aside>}
    </>}
  </div><div role="status" aria-live="polite">{announcement}</div></>;
}

export interface ReviewKeyActions { move: (by: 1 | -1) => void; accept: () => void; openNote: (v: "reject" | "send_back") => void; retry: () => void; open: () => void }
export function registerReviewKeys(registry: KeyRegistry, actions: ReviewKeyActions) {
  const entries: [string, string, () => void][] = [
    ["j", "Next review", () => actions.move(1)], ["k", "Previous review", () => actions.move(-1)],
    ["a", "Accept and bring back", actions.accept], ["r", "Reject with a note", () => actions.openNote("reject")],
    ["s", "Send back with a note", () => actions.openNote("send_back")], ["t", "Focus retry executor", actions.retry],
    ["o", "Copy worktree path", actions.open],
  ];
  const offs = entries.map(([key, label, run]) => registry.register({ keys: key, label, scope: "review", run }));
  return () => offs.forEach(off => off());
}
/** Shared by buttons and shortcuts; validation happens before the action runner is invoked. */
export async function submitVerdict(task: TaskDetail, verdict: Verdict, runner: ActionRunner, dispatch: (a: ReviewAction) => void, announce: (s: string) => void, getView: () => ReviewState) {
  let params: Record<string, unknown>;
  try { params = verdictParams(task, verdict); }
  catch (error) { announce((error as Error).message); return; }
  dispatch({ type: "verdict-sent" });
  const result = await runner.run(`review:${task.id}`, { label: "Record verdict", op: "task.review", params },
    s => !s.snapshot?.attention?.some(a => a.kind === "review" && a.taskId === task.id));
  dispatch({ type: "verdict-settled" });
  if (result.status === "done") {
    const next = reviewReducer(getView(), { type: "verdict-done", id: task.id });
    dispatch({ type: "verdict-done", id: task.id });
    const goal = next.queue.find(i => i.taskId === next.selectedId)?.title;
    const label = { accept: "Accepted", reject: "Rejected", send_back: "Sent back", retry: "Retry requested" }[verdict.verdict];
    announce(`${label}${goal ? ` · next: ${goal}` : " · review queue is clear"}`);
  } else if (result.status === "handled" || result.status === "error") announce(result.message);
  else if (result.status === "idle") announce("Waiting for the review queue to update.");
}
export async function copyWorktreePath(worktree: string | null | undefined, announce: (s: string) => void, copy: (path: string) => Promise<void>) {
  if (!worktree) { announce("No worktree path available"); return; }
  try { await copy(worktree); announce("Worktree path copied"); }
  catch { announce("Could not copy worktree path"); }
}
function ReviewLoaded({ id, snapshot, view, dispatch, getView, announce, announcement, detail }: {
  id: string; detail: TaskDetail; snapshot: ClientSnapshot; view: ReviewState; dispatch: (a: ReviewAction) => void;
  getView: () => ReviewState; announce: (s: string) => void; announcement: string;
}) {
  const [filePath, setFile] = useState<string>();
  const path = detail.files.some(f => f.path === filePath) ? filePath : detail.files[0]?.path;
  const diff = useQuery<ReviewDiff>("task.diff", { id, ...(path ? { path } : {}) });
  const runner = useActions();
  const [note, setNote] = useState(""), [kind, setKind] = useState(detail.kind ?? ""), [executor, setExecutor] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null), retryRef = useRef<HTMLSelectElement>(null);
  const inFlight = useRef(false);
  useEffect(() => { if (view.noteFor) noteRef.current?.focus(); }, [view.noteFor]);
  const openNote = (v: "reject" | "send_back") => { if (!view.pending) dispatch({ type: "open-note", for: v }); };
  const submit = async (verdict: Verdict["verdict"]) => {
    if (view.pending || inFlight.current) return;
    inFlight.current = true;
    try { await submitVerdict(detail, { verdict, note, kind, ...(verdict === "retry" ? { executor } : {}) }, runner, dispatch, announce, getView); }
    finally { inFlight.current = false; }
  };
  const open = () => copyWorktreePath(diff.data?.worktree ?? detail.worktree, announce, path => navigator.clipboard.writeText(path));
  const handlers = useRef<ReviewKeyActions>(null!);
  handlers.current = { move: by => { if (!view.pending) dispatch({ type: "move", by }); }, accept: () => { void submit("accept"); }, openNote, retry: () => retryRef.current?.focus(), open: () => { void open(); } };
  useEffect(() => registerReviewKeys(keys, {
    move: by => handlers.current.move(by), accept: () => handlers.current.accept(),
    openNote: v => handlers.current.openNote(v), retry: () => handlers.current.retry(), open: () => handlers.current.open(),
  }), []);
  return <ReviewView snapshot={snapshot} view={view} task={detail} now={Date.now() / 1000}
    filePath={path} diff={!diff.loading ? diff.data : undefined} loading={diff.loading}
    error={diff.error} onSelect={selected => { if (!view.pending) dispatch({ type: "select", id: selected }); }}
    onFile={setFile} onOpen={() => { void open(); }} announcement={announcement}
    verdictPanel={<VerdictPanel task={detail} note={note} kind={kind} executor={executor}
      noteFor={view.noteFor} pending={view.pending} noteRef={noteRef} retryRef={retryRef}
      onNote={setNote} onKind={setKind} onExecutor={value => { setExecutor(value); dispatch({ type: "close-note" }); }}
      onOpenNote={openNote} onCancel={() => dispatch({ type: "close-note" })} onSubmit={v => { void submit(v); }} />} />;
}
function ReviewItem(props: {
  id: string; snapshot: ClientSnapshot; view: ReviewState; dispatch: (a: ReviewAction) => void;
  getView: () => ReviewState; announce: (s: string) => void; announcement: string;
}) {
  const task = useQuery<TaskDetail>("task.get", { id: props.id });
  return task.data
    ? <ReviewLoaded {...props} detail={task.data} />
    : <ReviewView snapshot={props.snapshot} view={props.view} now={Date.now() / 1000} error={task.error} loading={task.loading}
        onSelect={id => props.dispatch({ type: "select", id })} announcement={props.announcement} />;
}
function ReviewController({ snapshot, route }: { snapshot: ClientSnapshot; route: Route & { id?: string } }) {
  const [view, dispatch] = useReducer(reviewReducer, initialReview, v => {
    const queued = reviewReducer(v, { type: "queue", items: reviewQueue(snapshot) });
    return route.id ? reviewReducer(queued, { type: "request", id: route.id }) : queued;
  });
  const [announcement, announce] = useState("");
  const current = useRef(view); current.current = view;
  useEffect(() => { dispatch({ type: "queue", items: reviewQueue(snapshot) }); }, [snapshot]);
  useEffect(() => { if (route.id) dispatch({ type: "request", id: route.id }); }, [route.id]);
  useEffect(() => {
    history.replaceState(null, "", withQuery(view.selectedId ? `#/review/${encodeURIComponent(view.selectedId)}` : "#/review", route.query));
  }, [view.selectedId]);
  return view.selectedId
    ? <ReviewItem key={view.selectedId} id={view.selectedId} snapshot={snapshot} view={view} dispatch={dispatch} getView={() => current.current} announce={announce} announcement={announcement} />
    : <ReviewView snapshot={snapshot} view={view} now={Date.now() / 1000} announcement={announcement} />;
}
export function Review({ route }: { route: Route & { id?: string } }) {
  const { state } = useTaskContext();
  return state.snapshot ? <ReviewController snapshot={state.snapshot} route={route} /> : null;
}

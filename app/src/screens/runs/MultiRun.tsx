/**
 * Board 8: several runs at once. One attention queue across runs ranked by what each answer unblocks, runs as coloured
 * lines with fixed letters, focus mode, "since you last looked" summaries, quiet mode and the shared executor bench.
 * A thin client: the queue's order, letters and priorities arrive from the service; nothing is ranked here.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { buildRunsListState, initialRunsStore, mergeDetailRefresh, mergeListRefresh, mergeSnapshotRuns, refreshRunDetail, refreshRunsList, RUNS_UNAVAILABLE, type RunsStoreState } from "../../data/runs";
import { runAge, runStatus } from "../../../../src/view-model/runs";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink } from "../../ds/Button";
import { Switch } from "../../ds/Controls";
import { Page } from "../../ds/Page";
import { EmptyState } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { SectionHeading } from "../../ds/SectionHeading";
import { PageHead } from "../../shell/slots";
import type { RouteQuery } from "../../router";
import { useTaskContext } from "../task-shared";
import { useMounted, useRetryFocus } from "./run-data";
import { RunQuestionCard } from "./run-shared";
import { useLiveStyles } from "./LiveBoard";
import { Creature } from "./MascotArt";
import { buildMultiRun, countWords, type RunLineRow } from "./multi-run";
import { liveHref, runViewHref } from "./live-links";

/** Details are read for this many runs, one after another, for their summaries and step counts. */
export const SUMMARY_RUNS = 8;
const LIVE = new Set(["running", "waiting", "paused"]);

/** Generated child runs belong to their parent's board, so they are not runs of their own here. */
export const childRunIds = (rows: Array<{ id: string; parentRunId?: string }>): Set<string> => new Set(rows.filter(r => r.parentRunId).map(r => r.id));

/** Live runs first, then the newest finished ones; children never. */
export function summaryRunIds(rows: Array<{ id: string; status: string; createdAt: number; parentRunId?: string }>): string[] {
  return rows.filter(r => !r.parentRunId)
    .sort((a, b) => (LIVE.has(b.status) ? 1 : 0) - (LIVE.has(a.status) ? 1 : 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, SUMMARY_RUNS).map(r => r.id);
}

function StepBar({ line }: { line: RunLineRow }) {
  const { done, running, waiting, failed } = line.counts;
  const total = done + running + waiting + failed;
  if (!total) return null;
  let x = 0;
  const segs = ([["done", done], ["running", running], ["waiting", waiting], ["failed", failed]] as const).filter(([, n]) => n > 0).map(([kind, n]) => {
    const w = (n / total) * 100;
    const seg = <rect key={kind} className={`mr-seg--${kind}`} x={x} y={0} width={w} height={6} />;
    x += w;
    return seg;
  });
  return <svg className="mr-bar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`Run ${line.letter}: ${countWords(line.counts)}`}>{segs}</svg>;
}

export function MultiRun({ query }: { query: RouteQuery }) {
  useLiveStyles();
  const { state, api } = useTaskContext();
  const ops = state.features.ops;
  const now = state.snapshot?.at ?? Date.now() / 1000;
  const [store, setStore] = useState<RunsStoreState>(() => initialRunsStore());
  const storeRef = useRef(store);
  storeRef.current = store;
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [answerId, setAnswerId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retry = useRetryFocus(headingRef);
  const mounted = useMounted();
  const loadSeq = useRef(0);
  const appliedList = useRef(0);
  const appliedDetail = useRef(new Map<string, number>());

  /**
   * The list first, then each live run's detail for its summary. As on the run view, a response is dropped after
   * unmount or once a newer one has been applied; a merely superseded one still applies.
   * Resolves true when everything was read without any error.
   */
  const load = async () => {
    const mine = ++loadSeq.current;
    let next = await refreshRunsList(api, storeRef.current, ops);
    if (!mounted.current) return false;
    const listed = next;
    if (mine > appliedList.current) {
      appliedList.current = mine;
      setStore(current => mergeListRefresh(current, listed));
    }
    let ok = !listed.listError;
    const kids = childRunIds(next.list);
    const ids = summaryRunIds(mergeSnapshotRuns(next.list, state.snapshot?.runs).filter(r => !kids.has(r.id)));
    for (const id of ids) {
      // A newer load already brought this run: no need to read it again.
      if ((appliedDetail.current.get(id) ?? 0) > mine) continue;
      next = await refreshRunDetail(api, next, id, ops);
      if (!mounted.current) return false;
      if (next.details[id]?.error) ok = false;
      if (mine > (appliedDetail.current.get(id) ?? 0)) {
        appliedDetail.current.set(id, mine);
        const read = next;
        setStore(current => mergeDetailRefresh(current, read, id));
      }
    }
    return ok;
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the latest store through a ref
  }, [api, ops, state.connectionRevision, state.invalidations.runs, state.invalidations.attention]);

  const listState = useMemo(() => buildRunsListState({
    ops, attention: state.snapshot?.attention, snapshotRuns: state.snapshot?.runs, store, now,
  }), [ops, state.snapshot?.attention, state.snapshot?.runs, store, now]);
  const children = useMemo(() => childRunIds(store.list), [store.list]);
  const runs = useMemo(() => listState.runs.filter(r => !children.has(r.id)), [listState.runs, children]);
  // A focused run that has ended or vanished must not leave the board empty.
  const focus = focusId && runs.some(r => r.id === focusId) ? focusId : null;
  const model = useMemo(() => buildMultiRun({
    runs, queue: listState.queue, snapshotRuns: state.snapshot?.runs, details: store.details,
    executors: state.snapshot?.executors, focusId: focus, quiet,
  }), [runs, listState.queue, state.snapshot?.runs, state.snapshot?.executors, store.details, focus, quiet]);
  const answering = answerId ? model.queue.find(q => q.id === answerId) ?? null : null;
  const canAnswer = ops.has("question.answer");
  const unavailable = listState.unavailable;
  // Until the first list read answers, an empty page is still loading.
  const loading = !unavailable && !listState.error && !listState.runs.length && !listState.queue.length && !store.listStamp;
  const hiddenWords = [
    model.hidden.quietBackgroundItems ? `${model.hidden.quietBackgroundItems} ${model.hidden.quietBackgroundItems === 1 ? "question" : "questions"} from background runs` : "",
    model.hidden.quietItems ? `${model.hidden.quietItems} informational ${model.hidden.quietItems === 1 ? "item" : "items"}` : "",
    model.hidden.quietRuns ? `${model.hidden.quietRuns} background ${model.hidden.quietRuns === 1 ? "run" : "runs"}` : "",
  ].filter(Boolean);

  return <>
    <PageHead>
      <header className="lb-header">
        <div className="lb-heading"><h1 ref={headingRef} tabIndex={-1}>Several runs</h1></div>
        <div className="lb-links"><ButtonLink typography="board" size="sm" href="#/runs">Runs list</ButtonLink></div>
      </header>
    </PageHead>
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <Page width="full" className="lb" aria-label="Several runs at once">
      {unavailable && <EmptyState title={RUNS_UNAVAILABLE} description="This service does not offer run.list yet." />}
      {listState.error && !listState.runs.length && !listState.queue.length && (
        <Alert tone="error" title="Couldn't load runs"><p>{listState.error}</p><Button size="sm" onClick={e => { void retry(e.currentTarget, load); }}>Try again</Button></Alert>
      )}
      {listState.error && (listState.runs.length > 0 || listState.queue.length > 0) && (
        <Alert tone="warning" title="These runs may be out of date"><p>The last refresh failed, so you are seeing the version loaded earlier.</p><Button size="sm" onClick={e => { void retry(e.currentTarget, load); }}>Try again</Button></Alert>
      )}
      {loading && <p className="lb-cap" role="status">Loading runs…</p>}
      {!unavailable && !loading && !listState.error && listState.empty && <EmptyState title="No runs yet" description="Start one with `pacer run start`." />}
      {!unavailable && (listState.runs.length > 0 || listState.queue.length > 0) && <>
        <div className="mr-controls" role="group" aria-label="View">
          <Switch label="Quiet mode" help="Hide informational questions and background runs." checked={quiet}
            onChange={e => { const on = (e.currentTarget as HTMLInputElement).checked; setQuiet(on); setAnnounce(on ? "Quiet mode on" : "Quiet mode off"); }} />
          {focus ? <Button size="sm" onClick={() => { setFocusId(null); setAnnounce("Showing all runs"); }}>Show all runs</Button> : null}
        </div>
        {focus ? <p className="lb-cap">Focused on run {model.lines[0]?.letter ?? ""}. {model.hidden.focus} other {model.hidden.focus === 1 ? "run is" : "runs are"} hidden.</p> : null}
        {quiet && hiddenWords.length ? <p className="lb-cap">Quiet mode is hiding {hiddenWords.join(", ")}.</p> : null}

        <section className="lb-section" aria-labelledby="mr-queue">
          <h2 className="pc-section-heading" id="mr-queue" ref={queueHeading} tabIndex={-1}>Needs you</h2>
          {model.queue.length === 0 ? <p className="lb-cap">Nothing needs you{quiet || focus ? " in this view" : ""}.</p> : (
            <ol className="lb-list" aria-label="Questions across runs, most blocking first">
              {model.queue.map(q => (
                <li key={q.id} className={`mr-row mr-tone-${q.tone}`} data-queue={q.id}>
                  <div className="mr-head">
                    <span className="pc-run-letter mr-letter" role="img" aria-label={`Run ${q.letter}`}>{q.letter}</span>
                    <span className="mr-title">{q.text}</span>
                    <Pill tone={q.unblocks === "run" ? "warn" : "neutral"}>{q.rank}</Pill>
                    <span className="lb-cap">{q.runTitle}</span>
                  </div>
                  <div className="lb-row">
                    <Button size="sm" variant={answerId === q.id ? "secondary" : "quiet"} aria-expanded={answerId === q.id} aria-label={`Answer the question from run ${q.letter}`} onClick={() => setAnswerId(answerId === q.id ? null : q.id)}>
                      Answer
                    </Button>
                    <ButtonLink size="sm" variant="quiet" href={liveHref(q.runId, undefined, query)} aria-label={`Live board of run ${q.letter}`}>Live board</ButtonLink>
                    <ButtonLink size="sm" variant="quiet" href={runViewHref(q.runId, query)} aria-label={`Run view of run ${q.letter}`}>Run view</ButtonLink>
                  </div>
                  {answering?.id === q.id ? (
                    <RunQuestionCard question={q.question} canAnswer={canAnswer} api={api}
                      onAnswered={() => { setAnswerId(null); setAnnounce("Answer submitted"); queueMicrotask(() => queueHeading.current?.focus({ preventScroll: true })); void load(); }}
                      onConflict={() => { setAnnounce("This question changed. Showing the latest version."); void load(); }} />
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="lb-section" aria-labelledby="mr-runs">
          <SectionHeading id="mr-runs">Runs</SectionHeading>
          {model.lines.length === 0 ? <p className="lb-cap">No runs in this view.</p> : (
            <ul className="lb-list">
              {model.lines.map(line => {
                const st = runStatus(line.pausedReason ? "paused" : line.status);
                return (
                  <li key={line.id} className={`mr-row mr-tone-${line.tone}`} data-run={line.id}>
                    <div className="mr-head">
                      <span className="pc-run-letter mr-letter" role="img" aria-label={`Run ${line.letter}`}>{line.letter}</span>
                      <span className="mr-title">{line.title}</span>
                      <Pill tone={st.tone}><span aria-hidden="true">{st.glyph} </span>{st.label}</Pill>
                      <span className="lb-cap">{line.priorityLabel} priority · Waits on {line.waitsOn} · {line.age}</span>
                    </div>
                    <StepBar line={line} />
                    <p className="lb-cap">{countWords(line.counts)}{line.questions ? ` · ${line.questions} ${line.questions === 1 ? "question" : "questions"} for you` : ""}</p>
                    <p className="mr-since"><strong>Since you last looked: </strong>{line.summary
                      ? <>{line.summary.text}{line.summary.at ? <span className="lb-cap"> · written {runAge(line.summary.at, now)}</span> : null}</>
                      : store.details[line.id]?.error && !store.details[line.id]?.run ? "The summary couldn't be loaded." : "No summary yet."}</p>
                    <div className="lb-row">
                      <Button size="sm" variant={focus === line.id ? "secondary" : "quiet"} aria-pressed={focus === line.id}
                        onClick={() => { setFocusId(focus === line.id ? null : line.id); setAnnounce(focus === line.id ? "Showing all runs" : `Focused on run ${line.letter}`); }}>
                        Focus on {line.letter}
                      </Button>
                      <ButtonLink size="sm" variant="quiet" href={liveHref(line.id, undefined, query)} aria-label={`Live board of run ${line.letter}`}>Live board</ButtonLink>
                      <ButtonLink size="sm" variant="quiet" href={liveHref(line.id, "journey", query)} aria-label={`Replay journey of run ${line.letter}`}>Replay journey</ButtonLink>
                      <ButtonLink size="sm" variant="quiet" href={runViewHref(line.id, query)} aria-label={`Run view of run ${line.letter}`}>Run view</ButtonLink>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="lb-section" aria-labelledby="mr-bench">
          <SectionHeading id="mr-bench">Executor bench</SectionHeading>
          <p className="lb-cap">One bench serves every run; the dispatcher fills free executors by run priority.{model.capacity ? ` ${model.capacity.used} of ${model.capacity.max} ${model.capacity.max === 1 ? "slot is" : "slots are"} in use.` : ""}</p>
          {model.bench.length === 0 ? <p className="lb-cap">No executors are set up.</p> : (
            <ul className="mr-bench">
              {model.bench.map(b => (
                <li key={b.id} className="mr-bench-item" data-executor={b.id}>
                  <svg width="32" height="36" viewBox="0 0 32 36" aria-hidden="true"><Creature identity={b.id} x={0} y={0} size={32} /></svg>
                  <span className="mr-bench-text">
                    <span className="mr-title">{b.label}</span>
                    <span className="lb-cap">{b.slots ? `${b.slots.used} of ${b.slots.max} ${b.slots.max === 1 ? "slot" : "slots"} in use` : ""}</span>
                  </span>
                  <Pill tone={b.tone}><span aria-hidden="true">{b.glyph} </span>{b.state}</Pill>
                </li>
              ))}
            </ul>
          )}
        </section>
      </>}
    </Page>
  </>;
}

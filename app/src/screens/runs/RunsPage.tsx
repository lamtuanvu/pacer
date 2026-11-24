import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import styles from "./runs.css" with { type: "text" };
import {
  buildRunsListState,
  initialRunsStore,
  markRunSeen,
  questionFromEntity,
  refreshRunDetail,
  refreshRunsList,
  runRowPriorityLabel,
  runRowStatusLabel,
  runsBadgeCount,
  type RunQuestionView,
  type RunsStoreState,
} from "../../data/runs";
import { QuestionForm, type QuestionFormQuestion } from "../../ds/QuestionForm";
import { Alert } from "../../ds/Alert";
import { ButtonLink, TextAction } from "../../ds/Button";
import { Dialog } from "../../ds/Dialog";
import { Page } from "../../ds/Page";
import { EmptyState, ListRow } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { ApiError } from "../../data/api";
import { useActions } from "../../data/action-context";
import { withQuery, type RouteQuery } from "../../router";
import { PageHead } from "../../shell/slots";
import { useTaskContext } from "../task-shared";
import { RUNS_EMPTY, RUNS_UNAVAILABLE } from "../../../../src/view-model/runs";

const styledDocuments = new WeakSet<Document>();
function useRunsStyles() {
  useEffect(() => {
    if (styledDocuments.has(document)) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    styledDocuments.add(document);
  }, []);
}

type HeldAnswer = {
  question: QuestionFormQuestion;
  itemTitle: string;
};

function mapQuestionGet(raw: unknown, fallbackRunId: string): RunQuestionView | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;
  const runId = typeof data.runId === "string" ? data.runId
    : typeof data.run_id === "string" ? data.run_id
      : fallbackRunId;
  return questionFromEntity(data, runId);
}

export function RunsPage({ query, runId }: { query: RouteQuery; runId?: string }) {
  useRunsStyles();
  const { state, api } = useTaskContext();
  const runner = useActions();
  const [store, setStore] = useState<RunsStoreState>(() => initialRunsStore());
  const [answerId, setAnswerId] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldAnswer | null>(null);
  /** Authoritative question from question.get / Reload; overrides stale snapshot attention. */
  const [reloaded, setReloaded] = useState<QuestionFormQuestion | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [focusTitle, setFocusTitle] = useState(false);
  const [announce, setAnnounce] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seen = useRef<string | null>(null);
  const alsoListedId = useId();
  const ops = state.features.ops;
  const now = state.snapshot?.at ?? Date.now() / 1000;

  const listState = useMemo(() => buildRunsListState({
    ops,
    attention: state.snapshot?.attention,
    snapshotRuns: state.snapshot?.runs,
    store,
    now,
  }), [ops, state.snapshot?.attention, state.snapshot?.runs, store, now]);

  useEffect(() => {
    let active = true;
    void refreshRunsList(api, store, ops).then(next => { if (active) setStore(next); });
    return () => { active = false; };
    // Refresh when connection or workflow entity invalidations change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store intentionally omitted to avoid loop
  }, [api, ops, state.connectionRevision, state.invalidations.runs, state.invalidations.attention]);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    if (seen.current !== runId) {
      seen.current = runId;
      void markRunSeen(api, runId, ops);
    }
    void refreshRunDetail(api, store, runId, ops).then(next => { if (active) setStore(next); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ops, runId, state.connectionRevision, state.invalidations.runs]);

  const fromQueue = answerId
    ? listState.queue.find(q => q.question.id === answerId) ?? null
    : null;
  const fromQueueRev = fromQueue?.question.rev;
  const fromQueueText = fromQueue?.question.text;

  // Keep the last known question while answering so a refresh that drops it
  // does not unmount the conflict / Reload UI.
  useEffect(() => {
    if (!answerId) {
      setHeld(null);
      setReloaded(null);
      setReloadError(null);
      setFocusTitle(false);
      return;
    }
    const entry = listState.queue.find(q => q.question.id === answerId);
    if (entry) setHeld({ question: entry.question, itemTitle: entry.item.title });
    // fromQueueRev/text track store refreshes without depending on a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queue identity is read inside
  }, [answerId, fromQueueRev, fromQueueText, listState.queue]);

  // Prefer a Reload-fetched question over stale snapshot attention until attention catches up.
  const answering = (() => {
    if (!answerId) return null;
    if (reloaded && reloaded.id === answerId) {
      const title = fromQueue?.item.title ?? held?.itemTitle ?? reloaded.text;
      return { question: reloaded, itemTitle: title };
    }
    if (fromQueue) return { question: fromQueue.question, itemTitle: fromQueue.item.title };
    if (held && held.question.id === answerId) return held;
    return null;
  })();
  const questionMissing = !!answerId && !fromQueue && !!held && !reloaded;

  const closeAnswer = () => {
    setAnswerId(null);
    setHeld(null);
    setReloaded(null);
    setReloadError(null);
    setFocusTitle(false);
  };

  const submitAnswer = async (input: { answer: string; note?: string; expect_rev: number }) => {
    if (!answering) return;
    // Prefer the action runner so confirm/conflict handling stays consistent; keep `this` bound.
    const call = runner
      ? <T,>(op: string, params?: unknown) => runner.call<T>(op, params)
      : api.call.bind(api);
    await call("question.answer", {
      id: answering.question.id,
      answer: input.answer,
      expect_rev: input.expect_rev,
      ...(input.note !== undefined && input.note !== "" ? { note: input.note } : {}),
    });
    closeAnswer();
    setAnnounce("Answer submitted");
    // Restore focus to the Runs heading; the Answer control that opened the dialog is gone.
    queueMicrotask(() => headingRef.current?.focus({ preventScroll: true }));
    const next = await refreshRunsList(api, store, ops);
    setStore(next);
  };

  const reloadAnswer = () => {
    if (!answering) return;
    setReloadError(null);
    setFocusTitle(false);
    void (async () => {
      try {
        let nextQuestion: QuestionFormQuestion | null = null;
        if (ops === undefined || ops.has("question.get")) {
          const raw = await api.call<unknown>("question.get", { id: answering.question.id });
          const mapped = mapQuestionGet(raw, answering.question.runId);
          if (!mapped) throw new Error("Couldn't reload this question");
          nextQuestion = mapped;
        } else {
          // No question.get: refresh list + hope attention/SSE updates; still clear held conflict via list.
          const next = await refreshRunsList(api, store, ops);
          setStore(next);
          throw new Error("Couldn't reload this question (question.get unavailable)");
        }
        const next = await refreshRunsList(api, store, ops);
        setStore(next);
        setReloaded(nextQuestion);
        setHeld({ question: nextQuestion, itemTitle: answering.itemTitle });
        setFocusTitle(true);
      } catch (error) {
        const message = error instanceof ApiError
          ? error.message
          : error instanceof Error ? error.message : "Couldn't reload this question";
        setReloadError(message);
      }
    })();
  };

  const canAnswer = ops.has("question.answer");

  return <>
    <PageHead>
      <header className="runs-header">
        <div className="runs-heading">
          <h1 ref={headingRef} tabIndex={-1}>Runs</h1>
          <span className="runs-cap">
            {listState.badge
              ? `${listState.badge} ${listState.badge === 1 ? "question needs" : "questions need"} you`
              : listState.empty
                ? "No runs yet"
                : `${listState.runs.length} ${listState.runs.length === 1 ? "run" : "runs"}`}
          </span>
        </div>
      </header>
    </PageHead>
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <Page width="full" className="pc-runs-page">
      {listState.unavailable && (
        <EmptyState title={RUNS_UNAVAILABLE} description="This service does not offer run.list yet." />
      )}
      {listState.error && (
        <Alert tone="error" title="Couldn't refresh runs"><p>{listState.error}</p></Alert>
      )}

      {!listState.unavailable && listState.queue.length > 0 && (
        <section className="runs-queue" aria-label="Needs your answer">
          <h2 className="runs-section-title">Needs your answer</h2>
          <ul className="runs-queue-list">
            {listState.queue.map(({ item, question }) => {
              const letter = item.run!.letter;
              return (
                <li key={item.id} className="runs-queue-item">
                  <ListRow
                    layout="attention"
                    leading={<span className="pc-run-letter" aria-hidden="true">{letter}</span>}
                    content={
                      <>
                        <span className="runs-queue-title" title={item.run!.title}>{item.run!.title}</span>
                        <span className="runs-queue-detail" title={question.text}>{question.text}</span>
                        <span className="runs-meta">
                          <Pill tone="warn">Needs you</Pill>
                        </span>
                      </>
                    }
                    actions={
                      <>
                        <ButtonLink typography="board" size="sm" href={withQuery(`#/runs/${encodeURIComponent(item.run!.id)}`, query)}>Open run</ButtonLink>
                        {canAnswer && (
                          <ButtonLink
                            typography="board"
                            size="sm"
                            variant="primary"
                            href={withQuery(`#/runs?answer=${encodeURIComponent(question.id)}`, query)}
                            onClick={event => {
                              event.preventDefault();
                              setAnswerId(question.id);
                              setHeld({ question, itemTitle: item.title });
                              setReloaded(null);
                              setReloadError(null);
                              setFocusTitle(false);
                              setAnnounce("");
                            }}
                          >
                            Answer
                          </ButtonLink>
                        )}
                      </>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!listState.unavailable && (
        <section className="runs-list" aria-label="Runs">
          <h2 className="runs-section-title">All runs</h2>
          {listState.loading && <p className="runs-cap" role="status">Loading runs…</p>}
          {listState.empty && (
            <EmptyState title="No runs yet" description={RUNS_EMPTY} />
          )}
          {!listState.empty && (
            <ul className="runs-table">
              <li className="runs-table-head" aria-hidden="true">
                <span />
                <span>Run</span>
                <span>Status</span>
                <span>Waits on</span>
                <span>Priority</span>
                <span>Age</span>
              </li>
              {listState.runs.map(run => {
                const status = runRowStatusLabel(run.status);
                const alsoQueued = listState.queue.some(q => q.question.runId === run.id);
                const describedBy = alsoQueued ? `${alsoListedId}-${run.id}` : undefined;
                return (
                  <li key={run.id} className={`runs-table-row${run.priority === "background" ? " runs-table-row--dim" : ""}`}>
                    <span className="pc-run-letter" title={`Run ${run.letter}`} role="img" aria-label={`Run ${run.letter}`}>{run.letter}</span>
                    <span className="runs-table-title-wrap">
                      <TextAction
                        className="runs-table-title"
                        href={withQuery(`#/runs/${encodeURIComponent(run.id)}`, query)}
                        title={run.title}
                        aria-describedby={describedBy}
                      >
                        {run.title}
                      </TextAction>
                      {alsoQueued ? <span id={describedBy} className="sr-only">Also listed above</span> : null}
                    </span>
                    <span className="runs-table-status">
                      <span aria-hidden="true">{status.glyph}</span>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </span>
                    <span className="runs-table-waits">
                      <span className="sr-only runs-field-label">Waits on:</span>
                      {run.waitsOn}
                    </span>
                    <span className="runs-table-priority">
                      <span className="sr-only runs-field-label">Priority:</span>
                      {runRowPriorityLabel(run.priority)}
                    </span>
                    <span className="runs-table-age">
                      <span className="sr-only runs-field-label">Age:</span>
                      {run.age}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {runId && (
        <section className="runs-open" aria-label="Opened run">
          <h2 className="runs-section-title">Opened run</h2>
          <p className="runs-cap">Marked as seen. Full run boards land in a later phase.</p>
          <ButtonLink typography="board" size="sm" href={withQuery("#/runs", query)}>Back to list</ButtonLink>
        </section>
      )}

      {answering && (
        <Dialog title="Answer question" close={closeAnswer}>
          {reloadError ? (
            <Alert tone="error" title="Couldn't reload">
              <p>{reloadError}</p>
            </Alert>
          ) : null}
          {questionMissing ? (
            <Alert tone="warning" title="Question no longer available">
              <p>This question left the queue. Close and refresh the list, or wait if it returns.</p>
            </Alert>
          ) : (
            <QuestionForm
              key={`${answering.question.id}:${answering.question.rev}`}
              question={answering.question}
              canAnswer={canAnswer}
              focusTitle={focusTitle}
              onSubmit={submitAnswer}
              onConflict={reloadAnswer}
            />
          )}
        </Dialog>
      )}
    </Page>
  </>;
}

export { runsBadgeCount };

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import styles from "./runs.css" with { type: "text" };
import {
  buildRunsListState,
  initialRunsStore,
  markRunSeen,
  refreshRunDetail,
  refreshRunsList,
  runRowPriorityLabel,
  runRowStatusLabel,
  runsBadgeCount,
  type RunsStoreState,
} from "../../data/runs";
import { QuestionForm } from "../../ds/QuestionForm";
import { Alert } from "../../ds/Alert";
import { ButtonLink, TextAction } from "../../ds/Button";
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

export function RunsPage({ query, runId }: { query: RouteQuery; runId?: string }) {
  useRunsStyles();
  const { state, api } = useTaskContext();
  const runner = useActions();
  const [store, setStore] = useState<RunsStoreState>(() => initialRunsStore());
  const [answerId, setAnswerId] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
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

  const answering = answerId
    ? listState.queue.find(q => q.question.id === answerId)
    : null;

  const submitAnswer = async (input: { answer: string; note?: string; expect_rev: number }) => {
    if (!answering) return;
    const call = runner?.call ?? api.call.bind(api);
    try {
      await call("question.answer", {
        id: answering.question.id,
        answer: input.answer,
        expect_rev: input.expect_rev,
        ...(input.note ? { note: input.note } : {}),
      });
      setAnswerId(null);
      const next = await refreshRunsList(api, store, ops);
      setStore(next);
    } catch (error) {
      throw error instanceof ApiError ? error : error;
    }
  };

  const canAnswer = ops.has("question.answer");

  return <>
    <PageHead>
      <header className="runs-header">
        <div className="runs-heading">
          <h1>Runs</h1>
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
                    leading={<span className={`pc-run-letter pc-run-letter--tone-${letterTone(letter)}`} aria-hidden="true">{letter}</span>}
                    content={
                      <>
                        <span className="runs-queue-title" title={item.title}>{item.title}</span>
                        <span className="runs-queue-detail" title={question.text}>{question.text}</span>
                        <span className="runs-meta">
                          <Pill tone="warn">Needs you</Pill>
                          <span className="runs-cap">{item.run!.title}</span>
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
                            onClick={event => { event.preventDefault(); setAnswerId(question.id); }}
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
                return (
                  <li key={run.id} className={`runs-table-row${run.priority === "background" ? " runs-table-row--dim" : ""}`}>
                    <span className={`pc-run-letter pc-run-letter--tone-${run.letterTone}`} title={`Run ${run.letter}`} aria-label={`Run ${run.letter}`}>{run.letter}</span>
                    <TextAction className="runs-table-title" href={withQuery(`#/runs/${encodeURIComponent(run.id)}`, query)} title={run.title}>
                      {alsoQueued ? `${run.title} · also listed above` : run.title}
                    </TextAction>
                    <span className="runs-table-status">
                      <span aria-hidden="true">{status.glyph}</span>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </span>
                    <span className="runs-table-waits">{run.waitsOn}</span>
                    <span className="runs-table-priority">{runRowPriorityLabel(run.priority)}</span>
                    <span className="runs-table-age">{run.age}</span>
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
        <div className="runs-answer-panel" role="dialog" aria-modal="true" aria-label="Answer question">
          <QuestionForm
            question={answering.question}
            canAnswer={canAnswer}
            onSubmit={submitAnswer}
            onConflict={() => {
              void refreshRunsList(api, store, ops).then(setStore);
              setAnswerId(null);
            }}
          />
          <ButtonLink typography="board" size="sm" href={withQuery("#/runs", query)} onClick={event => { event.preventDefault(); setAnswerId(null); }}>
            Close
          </ButtonLink>
        </div>
      )}
    </Page>
  </>;
}

function letterTone(letter: string): number {
  let n = 0;
  for (const c of letter.toUpperCase()) {
    if (c < "A" || c > "Z") continue;
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n === 0 ? 0 : (n - 1) % 5;
}

export { runsBadgeCount };

/** Run loading shared by the run view, the Live board and the journey: one set of load, seen, naming and retry-focus rules. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { displayRunLetter, runLettersForList, RUN_HEADING } from "../../../../src/view-model/runs";
import type { SnapshotRun } from "../../../../src/api/read-model/runs";
import {
  initialRunsStore, markRunSeen, mergeDetailRefresh, mergeListRefresh, mergeSnapshotRuns, refreshRunDetail, refreshRunsList,
  type RunsStoreState,
} from "../../data/runs";
import { useTaskContext } from "../task-shared";

export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

/**
 * One run's detail. A response is dropped after unmount, or once a newer load has been applied. One that is merely
 * superseded still applies, so frequent invalidations cannot keep the view from ever updating.
 */
export function useRunDetail(runId: string) {
  const { state, api } = useTaskContext();
  const ops = state.features.ops;
  const [store, setStore] = useState<RunsStoreState>(() => initialRunsStore());
  const storeRef = useRef(store);
  storeRef.current = store;
  const mounted = useMounted();
  const loadSeq = useRef(0);
  const appliedSeq = useRef(0);
  /** Resolves true when this run was read without any error. */
  const load = async () => {
    const mine = ++loadSeq.current;
    const listed = await refreshRunsList(api, storeRef.current, ops);
    const next = await refreshRunDetail(api, listed, runId, ops);
    if (mounted.current && mine > appliedSeq.current) {
      appliedSeq.current = mine;
      setStore(current => mergeDetailRefresh(mergeListRefresh(current, listed), next, runId));
    }
    return next.details[runId]?.error === null;
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the latest store through a ref
  }, [api, ops, runId, state.connectionRevision, state.invalidations.runs, state.invalidations.attention]);
  return { state, api, ops, store, detail: store.details[runId], load };
}

/** Opening a run marks it seen. `failed` stays true until a call works; the next refresh tries again. */
export function useRunSeen(runId: string) {
  const { state, api } = useTaskContext();
  const ops = state.features.ops;
  const mounted = useMounted();
  const seen = useRef<string | null>(null);
  const [failedRun, setFailedRun] = useState<string | null>(null);
  /** The failure alert stays until a call works, so its button keeps focus through a failed retry. */
  const markSeen = async () => {
    seen.current = runId;
    const result = await markRunSeen(api, runId, ops);
    if (seen.current !== runId) return false;
    // A failed call is retried by the next refresh, or by the alert's button.
    if (result === "failed") seen.current = null;
    if (mounted.current) setFailedRun(result === "failed" ? runId : null);
    return result !== "failed";
  };
  useEffect(() => {
    if (seen.current !== runId) void markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markSeen reads the current run
  }, [api, ops, runId, state.connectionRevision, state.invalidations.runs, state.invalidations.attention]);
  return { failed: failedRun === runId, markSeen };
}

/** A retry button leaves the page only when it works: then move focus to the page title, unless the person moved on. */
export function useRetryFocus(target: RefObject<HTMLElement>) {
  const mounted = useMounted();
  return async (button: EventTarget | null, attempt: () => Promise<boolean>) => {
    if (!await attempt() || !mounted.current) return;
    const active = document.activeElement;
    if (!active || active === document.body || active === button) target.current?.focus({ preventScroll: true });
  };
}

/** A run's letter and heading. Never the raw run id, and a letter only when the list, the snapshot or the run supplies it. */
export function runIdentity(runId: string, run: Record<string, unknown> | null, list: RunsStoreState["list"], snapshotRuns: SnapshotRun[] | undefined) {
  // A guessed letter can name another run.
  const letter = runLettersForList(mergeSnapshotRuns(list, snapshotRuns)).get(runId)
    ?? (typeof run?.letter === "string" && run.letter ? displayRunLetter({ id: runId, letter: run.letter }) : undefined);
  const runName = letter ? `Run ${letter}` : RUN_HEADING;
  const listRow = list.find(r => r.id === runId);
  const title = (typeof run?.title === "string" && run.title) || (typeof run?.workflow === "string" && run.workflow)
    || (listRow?.title !== runId && listRow?.title) || snapshotRuns?.find(r => r.id === runId)?.title || runName;
  return { letter, runName, title };
}

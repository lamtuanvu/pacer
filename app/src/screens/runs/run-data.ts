/** One run's detail for the Live board and journey: loaded like the run view, latest load wins, stale data stays on screen. */
import { useEffect, useRef, useState } from "preact/hooks";
import { initialRunsStore, refreshRunDetail, refreshRunsList, type RunsStoreState } from "../../data/runs";
import { useTaskContext } from "../task-shared";

/** Latest load wins: `begin()` returns a check that is true only while that load is the newest and the owner is still mounted. */
export function createLoadGuard() {
  let seq = 0;
  let alive = true;
  return {
    begin(): () => boolean { const mine = ++seq; return () => alive && mine === seq; },
    mount() { alive = true; },
    unmount() { alive = false; },
  };
}

export function useRunDetail(runId: string) {
  const { state, api } = useTaskContext();
  const ops = state.features.ops;
  const [store, setStore] = useState<RunsStoreState>(() => initialRunsStore());
  const storeRef = useRef(store);
  storeRef.current = store;
  const guard = useRef(createLoadGuard());
  useEffect(() => { guard.current.mount(); return () => guard.current.unmount(); }, []);
  /** A response that arrives after a newer load started, or after unmount, is dropped. */
  const load = async () => {
    const current = guard.current.begin();
    const listed = await refreshRunsList(api, storeRef.current, ops);
    const next = await refreshRunDetail(api, listed, runId, ops);
    if (current()) setStore(next);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the latest store through a ref
  }, [api, ops, runId, state.connectionRevision, state.invalidations.runs, state.invalidations.attention]);
  return { state, api, ops, store, detail: store.details[runId], load };
}

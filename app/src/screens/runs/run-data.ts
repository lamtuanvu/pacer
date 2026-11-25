/** One run's detail for the Live board and journey: loaded like the run view, latest load wins, stale data stays on screen. */
import { useEffect, useRef, useState } from "preact/hooks";
import { initialRunsStore, refreshRunDetail, refreshRunsList, type RunsStoreState } from "../../data/runs";
import { useTaskContext } from "../task-shared";

export function useRunDetail(runId: string) {
  const { state, api } = useTaskContext();
  const ops = state.features.ops;
  const [store, setStore] = useState<RunsStoreState>(() => initialRunsStore());
  const storeRef = useRef(store);
  storeRef.current = store;
  const mounted = useRef(true);
  const seq = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** A response that arrives after a newer load started, or after unmount, is dropped. */
  const load = async () => {
    const mine = ++seq.current;
    const listed = await refreshRunsList(api, storeRef.current, ops);
    const next = await refreshRunDetail(api, listed, runId, ops);
    if (mounted.current && mine === seq.current) setStore(next);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the latest store through a ref
  }, [api, ops, runId, state.connectionRevision, state.invalidations.runs, state.invalidations.attention]);
  return { state, api, ops, store, detail: store.details[runId], load };
}

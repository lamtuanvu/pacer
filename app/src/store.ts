import { parseEnvelope, reduce, type LinkSnapshot } from "../../src/link/envelope";
import type { ApiEvent } from "../../src/api/protocol";
import { ApiError, createApi, type BrowserApi } from "./api";

export interface StoreState {
  snapshot: LinkSnapshot | null; connected: boolean; sessionEnded: boolean; needsSnapshot: boolean;
  invalidations: Record<string, number>; version: string | null;
}
export type StoreAction = { type: "snapshot"; snapshot: LinkSnapshot } | { type: "event"; event: ApiEvent } | { type: "disconnected" | "reconnected" | "session-ended" } | { type: "version"; version: string };
export function initialState(): StoreState { return { snapshot: null, connected: false, sessionEnded: false, needsSnapshot: true, invalidations: {}, version: null }; }
export function reduceStore(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case "snapshot": return { ...state, snapshot: action.snapshot, needsSnapshot: false };
    case "disconnected": return { ...state, connected: false };
    case "reconnected": return { ...state, connected: true, needsSnapshot: true };
    case "session-ended": return { ...state, sessionEnded: true, connected: false };
    case "version": return { ...state, version: action.version };
    case "event": {
      const event = action.event;
      if (event.type === "reset") return { ...state, needsSnapshot: true };
      if (!state.snapshot || state.needsSnapshot || event.seq <= state.snapshot.seq) return state;
      const envelope = parseEnvelope({ v: 1, type: event.type, data: event.data });
      if (!envelope) return state;
      const snapshot = { ...reduce(state.snapshot, envelope, event.at), seq: event.seq };
      return { ...state, snapshot, invalidations: envelope.type === "config" ? { ...state.invalidations, [envelope.data.area]: (state.invalidations[envelope.data.area] ?? 0) + 1 } : state.invalidations };
    }
  }
}

/** Effects live here; the reducer above remains usable without a DOM. */
export function createStore(injectedApi?: BrowserApi, Events: typeof EventSource = EventSource) {
  let state = initialState();
  const listeners = new Set<() => void>();
  let stream: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let generation = 0;
  const dispatch = (action: StoreAction) => { state = reduceStore(state, action); for (const listener of listeners) listener(); };
  const endSession = () => { stream?.close(); clearTimeout(timer); dispatch({ type: "session-ended" }); };
  const api = injectedApi ?? createApi(endSession);
  async function refresh() {
    const current = ++generation;
    stream?.close();
    clearTimeout(timer);
    try {
      const [hello, result] = await Promise.all([api.hello(), api.snapshot()]);
      if (stopped || current !== generation) return;
      dispatch({ type: "version", version: hello.pacer });
      dispatch({ type: "snapshot", snapshot: { ...result.snapshot, seq: result.seq } });
      const source = stream = new Events(`/v2/events?since=${result.seq}`);
      let failed = false;
      const active = () => !stopped && stream === source && !state.sessionEnded;
      source.addEventListener("open", () => {
        if (!active()) return;
        if (failed) { dispatch({ type: "reconnected" }); void refresh(); }
        else { state = { ...state, connected: true }; for (const listener of listeners) listener(); }
      });
      source.addEventListener("error", () => {
        if (!active()) return;
        failed = true;
        dispatch({ type: "disconnected" });
        // EventSource does not expose HTTP status. A normal request detects expired cookies.
        void api.hello().catch(error => { if (active() && error instanceof ApiError && error.status === 401) endSession(); });
      });
      for (const type of ["budget", "task", "mode", "alert", "config", "reset"] as const) source.addEventListener(type, event => {
        if (!active()) return;
        try {
          const message = event as MessageEvent;
          const seq = Number(message.lastEventId);
          if (!Number.isSafeInteger(seq) || seq < 0) return;
          dispatch({ type: "event", event: { seq, at: Date.now() / 1000, type, data: JSON.parse(message.data) } });
          if (state.needsSnapshot) void refresh();
        } catch { dispatch({ type: "reconnected" }); void refresh(); }
      });
    } catch (error) {
      if (stopped || current !== generation) return;
      if (error instanceof ApiError && error.status === 401) { endSession(); return; }
      dispatch({ type: "disconnected" });
      timer = setTimeout(() => { void refresh(); }, 1000);
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { stopped = false; void refresh(); return () => { stopped = true; generation++; stream?.close(); clearTimeout(timer); }; },
  };
}

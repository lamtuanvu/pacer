import { parseEnvelope, reduce, type LinkSnapshot } from "../../../src/link/envelope";
import type { ApiEvent } from "../../../src/api/protocol";
import type { Hello } from "../../../src/api/client-types";
import { ENTITY_EVENT_TYPES, type ActivityEntry, type AttentionItem, type Job } from "../../../src/api/read-model/types";
import type { ClientSnapshot as SnapshotV2 } from "../../../src/view-model/snapshot";
/** The service's entity events plus pause, which a later service may send as an event. */
const READ_MODEL_EVENTS: readonly string[] = [...ENTITY_EVENT_TYPES, "pause"];
type EntityEventType = (typeof ENTITY_EVENT_TYPES)[number] | "pause";
import { attentionOrder } from "../../../src/view-model/selectors";
import { ApiError, createApi, type BrowserApi } from "./api";
import { invalidateQueryCache } from "./query";

export interface Features { readModel: boolean; ops: ReadonlySet<string> }
export interface StoreState {
  snapshot: SnapshotV2 | null; connectionRevision: number; connected: boolean; sessionEnded: boolean; needsSnapshot: boolean;
  invalidations: Record<string, number>; version: string | null;
  features: Features; jobs: Record<string, Job>; activity: ActivityEntry[];
}
type EventType = ApiEvent["type"] | EntityEventType;
export type StoreAction = { type: "snapshot"; snapshot: LinkSnapshot | SnapshotV2 } | { type: "event"; event: Omit<ApiEvent, "type"> & { type: EventType } } | { type: "disconnected" | "reconnected" | "session-ended" } | { type: "hello"; hello: Hello };
const V1_EVENTS = ["budget", "task", "mode", "alert", "config", "reset"] as const;
const TASK_CAP = 200, ACTIVITY_CAP = 200;
export function initialState(): StoreState {
  return { snapshot: null, connectionRevision: 0, connected: false, sessionEnded: false, needsSnapshot: true, invalidations: {}, version: null, features: { readModel: false, ops: new Set() }, jobs: {}, activity: [] };
}
/** The 2.1 read model is on when the service says protocol >= 2.1 and announces attention events. */
export function featuresOf(hello: Hello): Features {
  const [major = 0, minor = 0] = hello.protocol.split(".").map(Number);
  return { readModel: (major > 2 || (major === 2 && minor >= 1)) && hello.events.includes("attention"), ops: new Set(hello.ops) };
}

type Keyed = Record<string, unknown>;
const isObj = (v: unknown): v is Keyed => typeof v === "object" && v !== null && !Array.isArray(v);
/** Applies one entity event to a list: upsert by key, or remove on { id, removed: true }. Returns null when nothing changed. */
function upsert<T>(list: T[] | undefined, data: Keyed, key: string, place: "end" | "start" | ((items: T[]) => T[])): T[] | null {
  const items = list ?? [], id = data.removed === true ? data.id : data[key];
  if (typeof id !== "string") return null;
  const at = items.findIndex(item => (item as Keyed)[key] === id);
  if (data.removed === true) return at < 0 ? null : items.filter((_, i) => i !== at);
  if (at >= 0) return items.map((item, i) => i === at ? data as T : item);
  if (place === "end") return [...items, data as T];
  if (place === "start") return [data as T, ...items];
  return place([...items, data as T]);
}
function reduceReadModel(state: StoreState, snapshot: SnapshotV2, type: EventType, data: unknown, seq: number, at: number): StoreState {
  if (!isObj(data)) return state;
  const patch = (fields: Partial<SnapshotV2>): StoreState => ({ ...state, snapshot: { ...snapshot, ...fields, seq, at } });
  const list = <K extends "tasks" | "attention" | "executors" | "accounts" | "hosts" | "repos">(field: K, key: string, place: Parameters<typeof upsert>[3]) => {
    const next = upsert(snapshot[field] as unknown[] | undefined, data, key, place);
    return next ? patch({ [field]: next } as Partial<SnapshotV2>) : state;
  };
  switch (type) {
    case "task": return list("tasks", "id", items => [items.at(-1)!, ...items.slice(0, -1)].slice(0, TASK_CAP));
    case "attention": {
      // Re-sort on update too: a changed severity or raisedAt moves the item.
      const next = upsert(snapshot.attention, data, "id", "end");
      return next ? patch({ attention: next.sort(attentionOrder) }) : state;
    }
    case "executor": return list("executors", "id", "end");
    case "account": return list("accounts", "name", "end");
    case "host": return list("hosts", "alias", "end");
    case "repo": return list("repos", "key", "start");
    case "desktop.update": {
      if (typeof data.installationId !== "string" || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0) return state;
      const previous = snapshot.desktopUpdates?.find(item => item.installationId === data.installationId);
      const adoptionRevision = isObj(data.adoption) && Number.isSafeInteger(data.adoption.revision) && Number(data.adoption.revision) >= 0 ? Number(data.adoption.revision) : -1;
      const previousAdoptionRevision = previous?.adoption?.revision ?? -1;
      if (previous && previous.revision > Number(data.revision)) return patch({});
      // Durable revisions guard mutations; connection safety and notification
      // delivery can change without a disk write. Newer event sequence numbers
      // must refresh those controls even when both durable revisions are equal.
      if (previous && previous.revision === Number(data.revision) && adoptionRevision <= previousAdoptionRevision) {
        if (adoptionRevision < previousAdoptionRevision || data.phase !== previous.phase) return patch({});
        // Equal revisions may only refresh volatile safety/delivery fields.
        // An old phase or candidate must never replace persisted update state.
        const next = upsert(snapshot.desktopUpdates, { ...previous, actions: data.actions, error: data.error }, "installationId", "end");
        return next ? patch({ desktopUpdates: next }) : state;
      }
      // Independently persisted revisions can produce an incomparable response.
      // Refresh the authoritative pair instead of combining stale controls.
      if (previous && adoptionRevision < previousAdoptionRevision) return { ...patch({}), needsSnapshot: true };
      const next = upsert(snapshot.desktopUpdates, data, "installationId", "end");
      return next ? patch({ desktopUpdates: next }) : state;
    }
    case "planner": return patch({ planner: data as unknown as SnapshotV2["planner"] });
    case "counts": return patch({ counts: data as unknown as SnapshotV2["counts"] });
    case "pause": return patch({ pause: (data.removed === true || !Object.keys(data).length ? null : data) as SnapshotV2["pause"] });
    case "job": return typeof data.id === "string" ? { ...state, jobs: { ...state.jobs, [data.id]: data as unknown as Job }, snapshot: { ...snapshot, seq, at } } : state;
    case "activity": return typeof data.id === "string" ? { ...state, activity: [data as unknown as ActivityEntry, ...state.activity].slice(0, ACTIVITY_CAP), snapshot: { ...snapshot, seq, at } } : state;
    default: return state;
  }
}
export function reduceStore(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case "snapshot": return { ...state, snapshot: action.snapshot as SnapshotV2, needsSnapshot: false };
    case "disconnected": return { ...state, connected: false, connectionRevision: state.connectionRevision + 1 };
    case "reconnected": return { ...state, connected: true, needsSnapshot: true, connectionRevision: state.connectionRevision + 1 };
    case "session-ended": return { ...state, sessionEnded: true, connected: false, connectionRevision: state.connectionRevision + 1 };
    case "hello": return { ...state, version: action.hello.pacer, features: featuresOf(action.hello) };
    case "event": {
      const event = action.event;
      if (event.type === "reset") return { ...state, needsSnapshot: true };
      if (!state.snapshot || state.needsSnapshot || event.seq <= state.snapshot.seq) return state;
      // Plugin surfaces re-render on any plugin event; the catalog follows this counter.
      if (event.type === "plugin") return { ...state, invalidations: { ...state.invalidations, plugin: (state.invalidations.plugin ?? 0) + 1 } };
      // A machine seen on the network changes discovery.list without a config change.
      if (event.type === "discovery.found") return { ...state, invalidations: { ...state.invalidations, discovery: (state.invalidations.discovery ?? 0) + 1 } };
      // 2.1 entities carry fields the v1 envelope parser would strip, so they skip it.
      if (state.features.readModel && (event.type === "task" || READ_MODEL_EVENTS.includes(event.type))) return reduceReadModel(state, state.snapshot, event.type, event.data, event.seq, event.at);
      // Without the read model, an attention or counts event means the snapshot is out of date.
      if (event.type === "attention" || event.type === "counts") return { ...state, needsSnapshot: true };
      const envelope = parseEnvelope({ v: 1, type: event.type, data: event.data });
      if (!envelope) return state;
      const snapshot = { ...state.snapshot, ...reduce(state.snapshot as LinkSnapshot, envelope, event.at), seq: event.seq } as SnapshotV2;
      return { ...state, snapshot, needsSnapshot: envelope.type === "config" || state.needsSnapshot, invalidations: envelope.type === "config" ? { ...state.invalidations, [envelope.data.area]: (state.invalidations[envelope.data.area] ?? 0) + 1 } : state.invalidations };
    }
  }
}

/** Hide only the exact attention rows acknowledged by a successful review write.
 * A later question or review with a new timestamp remains visible. */
export function withoutReviewedAttention(snapshot: SnapshotV2, acknowledged: ReadonlySet<string>): SnapshotV2 {
  if (!snapshot.attention) return snapshot;
  const attention = snapshot.attention.filter(item => !acknowledged.has(`${item.id}:${item.since}`));
  return attention.length === snapshot.attention.length ? snapshot : {...snapshot, attention};
}

/** Effects live here; the reducer above remains usable without a DOM. */
export function createStore(injectedApi?: BrowserApi, Events: typeof EventSource = EventSource) {
  let state = initialState();
  const listeners = new Set<() => void>();
  let stream: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let generation = 0;
  let retryDelay = 1000;
  const acknowledgedReviews = new Set<string>();
  const dispatch = (action: StoreAction) => { if (["disconnected", "reconnected", "session-ended"].includes(action.type)) invalidateQueryCache(api); state = reduceStore(state, action); if (state.snapshot && acknowledgedReviews.size) state = {...state,snapshot:withoutReviewedAttention(state.snapshot,acknowledgedReviews)}; api.setConnected?.(state.connected); for (const listener of listeners) listener(); };
  const endSession = () => { stream?.close(); clearTimeout(timer); dispatch({ type: "session-ended" }); };
  const api = injectedApi ?? createApi(endSession);
  const retry = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!stopped && !state.sessionEnded) void refresh(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  async function refresh() {
    const current = ++generation;
    stream?.close();
    clearTimeout(timer);
    try {
      const [hello, result] = await Promise.all([api.hello(), api.snapshot()]);
      if (stopped || current !== generation) return;
      dispatch({ type: "hello", hello });
      dispatch({ type: "snapshot", snapshot: { ...result.snapshot, seq: result.seq } });
      const source = stream = new Events(`${hello.protocol.split(".")[0] === "3" ? "/v3/events?since=" : "/v2/events?since="}${result.seq}`);
      let failed = false;
      const active = () => !stopped && stream === source && !state.sessionEnded;
      source.addEventListener("open", () => {
        if (!active()) return;
        retryDelay = 1000;
        if (failed) { dispatch({ type: "reconnected" }); void refresh(); }
        else { state = { ...state, connected: true }; api.setConnected?.(true); for (const listener of listeners) listener(); }
      });
      source.addEventListener("error", () => {
        if (!active()) return;
        failed = true;
        // Own retries: HTTP errors can permanently close the native EventSource.
        source.close();
        retry();
        dispatch({ type: "disconnected" });
        // EventSource does not expose HTTP status. A normal request detects expired cookies.
        void api.hello().catch(error => { if (active() && error instanceof ApiError && error.status === 401) endSession(); });
      });
      for (const type of new Set<string>([...V1_EVENTS, ...hello.events])) source.addEventListener(type, event => {
        if (!active()) return;
        try {
          const message = event as MessageEvent;
          const seq = Number(message.lastEventId);
          if (!Number.isSafeInteger(seq) || seq < 0) return;
          dispatch({ type: "event", event: { seq, at: Date.now() / 1000, type: type as EventType, data: JSON.parse(message.data) } });
          if (state.needsSnapshot) void refresh();
        } catch { dispatch({ type: "reconnected" }); void refresh(); }
      });
    } catch (error) {
      if (stopped || current !== generation) return;
      if (error instanceof ApiError && error.status === 401) { endSession(); return; }
      dispatch({ type: "disconnected" });
      retry();
    }
  }
  return {
    getState: () => state,
    acceptReview(id: string) {
      if (!state.snapshot) return;
      for (const item of state.snapshot.attention ?? []) if (item.taskId === id) acknowledgedReviews.add(`${item.id}:${item.since}`);
      dispatch({type:"snapshot",snapshot:state.snapshot});
    },
    /** Refetch the snapshot now (an action saw no event in time). */
    refresh: () => refresh(),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { stopped = false; void refresh(); return () => { stopped = true; generation++; stream?.close(); clearTimeout(timer); }; },
  };
}

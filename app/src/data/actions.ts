import type { Action } from "../../../src/api/read-model/types";
import { ApiError, type BrowserApi } from "./api";
import type { StoreState } from "./store";

export type ActionState =
  | { status: "idle" } | { status: "pending" } | { status: "done" }
  | { status: "error"; message: string; hint?: string }
  | { status: "handled"; message: string }
  | { status: "job"; jobId: string };
export interface ActionDeps {
  call: BrowserApi["call"];
  /** Resolves true once match holds for the store, false after timeoutMs. */
  waitFor: (match: (s: StoreState) => boolean, timeoutMs: number) => Promise<boolean>;
  refetch: () => Promise<void> | void;
  reviewAccepted?: (id: string) => void;
  navigate: (hash: string) => void;
}
const CONFIRM_TIMEOUT_MS = 10_000;

import { settingsPath } from "../router";
/** ui.open is the one client-side action: every client maps it to its own screen. */
export function uiHref(params: Record<string, unknown>): string {
  const id = typeof params.id === "string" ? encodeURIComponent(params.id) : "";
  switch (params.view) {
    case "review": return id ? `#/tasks/${id}` : "#/needs-you";
    case "task": return id ? `#/tasks/${id}${params.tab === "answer" ? "?tab=answer" : ""}` : "#/tasks";
    case "session": return id ? `#/workspace?task=${id}` : "#/workspace";
    case "settings": return `#${settingsPath(params.section)}`;
    default: return "#/";
  }
}

/** Runs the service's actions. Success is shown only when the resulting event arrives, never optimistically. */
export function createActionRunner(deps: ActionDeps) {
  const results = new Map<string, unknown>();
  const states = new Map<string, ActionState>();
  const listeners = new Set<() => void>();
  const set = (key: string, state: ActionState) => { states.set(key, state); for (const l of listeners) l(); return state; };
  return {
    result: (key: string): unknown => results.get(key),
    state: (key: string): ActionState => states.get(key) ?? { status: "idle" },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    needsConfirm: (action: Action): string | null => action.confirm ?? null,
    /** Fetches the snapshot again, for a screen that changed state outside run(). */
    refetch: () => deps.refetch(),
    async run(key: string, action: Action, confirmDone?: (s: StoreState) => boolean): Promise<ActionState> {
      if (action.op === "ui.open") { deps.navigate(uiHref(action.params)); return set(key, { status: "done" }); }
      set(key, { status: "pending" });
      results.delete(key);
      let result: unknown;
      try { result = await deps.call(action.op, action.params); }
      catch (error) {
        // The service's conflict says the state moved on (another client acted first); it names no client.
        if (action.op.startsWith("desktop.update.")) await deps.refetch();
        if (error instanceof ApiError && error.code === "conflict" && action.op !== "mode.hold" && action.op !== "mode.release" && action.op !== "task.takeover" && action.op !== "agent.connect" && action.op !== "runner.settings.save" && !action.op.startsWith("desktop.update.") && !action.op.startsWith("project.strategy.")) return set(key, { status: "handled", message: "Already handled elsewhere" });
        const e = error instanceof ApiError ? error : null;
        return set(key, { status: "error", message: e?.message ?? (error instanceof Error ? error.message : String(error)), ...(e?.hint ? { hint: e.hint } : {}) });
      }
      results.set(key, result);
      if ((action.op === "task.review" || action.op === "dispatch.review") && (action.params.verdict === "accept" || action.params.accepted === true) && typeof action.params.id === "string") deps.reviewAccepted?.(action.params.id);
      if (action.op === "mode.hold" || action.op === "mode.release" || action.op.startsWith("desktop.update.") || action.op === "task.review" || action.op === "dispatch.review") await deps.refetch();
      if (action.op === "task.takeover") {
        const state = (result as {state?: string})?.state;
        deps.navigate(`${uiHref({view:"session",id:action.params.id})}${state === "starting" || state === "driving" ? `&panel=session&takeover=${state}` : ""}`);
      }
      const job = (result as { job?: { id?: unknown } } | null)?.job;
      if (job && typeof job.id === "string") return set(key, { status: "job", jobId: job.id });
      if (!confirmDone) return set(key, { status: "done" });
      if (await deps.waitFor(confirmDone, CONFIRM_TIMEOUT_MS)) return set(key, { status: "done" });
      await deps.refetch();
      return set(key, { status: "idle" });
    },
  };
}
export type ActionRunner = ReturnType<typeof createActionRunner>;

/** waitFor over a store: checks now, then on every change, up to timeoutMs. */
export function storeWaiter(store: { getState: () => StoreState; subscribe: (l: () => void) => () => void }): ActionDeps["waitFor"] {
  return (match, timeoutMs) => new Promise(resolve => {
    if (match(store.getState())) { resolve(true); return; }
    const off = store.subscribe(() => { if (match(store.getState())) { clearTimeout(timer); off(); resolve(true); } });
    const timer = setTimeout(() => { off(); resolve(false); }, timeoutMs);
  });
}

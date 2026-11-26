/** Hash links between the run view, the Live board, its journey playback and the several-runs board. */
import { withQuery, type RouteQuery } from "../../router";

const enc = encodeURIComponent;
/** `#/live` is the several-runs board; `#/live/<run>` is that run's Live board; `#/live/<run>/journey` replays it. */
export function liveHref(id: string | undefined, view: "journey" | undefined, query: RouteQuery): string {
  return withQuery(`#/live${id ? `/${enc(id)}${view === "journey" ? "/journey" : ""}` : ""}`, query);
}
export const runViewHref = (id: string, query: RouteQuery): string => withQuery(`#/runs/${enc(id)}`, query);
export const sessionHref = (taskId: string, query: RouteQuery): string => withQuery(`#/workspace?task=${enc(taskId)}&panel=session`, query);

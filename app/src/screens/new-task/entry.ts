import { hrefFor, inheritQuery, routes, type RouteQuery } from "../../router";

/**
 * The one way into the New task composer. The ⌘N / Ctrl+N shortcut uses it, and the title-bar and Dispatch
 * "New task" buttons (other slices) call `openNewTask()` or link to `newTaskHref(query)`.
 */
export const newTaskHref = (query?: RouteQuery): string => hrefFor(routes.newTask(), query);
export function openNewTask(location: { hash: string } = globalThis.location): void {
  location.hash = inheritQuery(newTaskHref(), location.hash);
}

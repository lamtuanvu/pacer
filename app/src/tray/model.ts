import { settingsPath } from "../router";
import type { Action } from "../../../src/attention/types";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { ActivityEntry } from "../../../src/activity/log";
import type { ExecutorRow } from "../../../src/api/read-model/types";
import { capacity, needsYou, running } from "../../../src/view-model/selectors";

/** Older services send only goals, which can include local paths and long prose. */
export function shortTitle(item: { title?: string; goal?: string }): string {
  const text = (item.title?.trim() || item.goal || "Task")
    .replace(/(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)[^\s]+|\b[\w.-]+(?:[\\/][\w.@-]+)+/g, "")
    .replace(/\s+/g, " ").trim() || "Task";
  if (text.length <= 60) return text;
  const head = text.slice(0, 59), boundary = head.lastIndexOf(" ");
  return `${head.slice(0, boundary > 0 ? boundary : 59).trimEnd()}…`;
}
export function actionRoute(action: Action): string {
  const { route, view, id, section } = action.params;
  if (typeof route === "string" && /^#?\//.test(route)) return route.replace(/^#/, "");
  if ((view === "task" || view === "session" || view === "review") && typeof id === "string") return `/${view === "review" ? "review" : "sessions"}/${encodeURIComponent(id)}`;
  if (view === "settings" && typeof section === "string") return settingsPath(section);
  return ({ overview: "/", home: "/", delegate: "/", settings: "/settings", executors: "/settings/executors", accounts: "/settings/accounts", hosts: "/settings/hosts", setup: "/", tasks: "/sessions", strategy: "/settings/strategies" } as Record<string, string>)[String(view)] ?? "/";
}
export const primaryAction = (actions: Action[]) => actions.find(a => a.style === "primary") ?? actions[0];
/** Compact capacity values never invent an unknown usage percentage. */
const OFF_STATES = new Set(["disabled", "down", "failing", "blocked"]);
export function executorValue(executor: ExecutorRow): string {
  // Same off states Overview's Capacity dims (e.g. BytePlus without an active coding plan is "down").
  if (!executor.enabled || OFF_STATES.has(executor.state) || /no (active )?(coding[- ])?plan|no subscription/i.test(`${executor.sub} ${executor.reason ?? ""}`)) return "off";
  if (executor.state === "exhausted") return "out";
  if (executor.slots.max > 0 && executor.slots.used >= executor.slots.max) return `${executor.slots.used}/${executor.slots.max}`;
  if (executor.usedPct !== null) return `${Math.round(executor.usedPct)}%`;
  return executor.slots.used > 0 ? `${executor.slots.used}/${executor.slots.max}` : "free";
}
export function trayModel(snapshot: ClientSnapshot, activity: ActivityEntry[] = []) {
  const attention = needsYou(snapshot, { repo: null });
  const tasks = running(snapshot, { repo: null });
  const active = tasks.filter(t => t.state === "running");
  const queued = tasks.filter(t => t.state === "queued").sort((a, b) => (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity) || (a.queue?.since ?? a.updatedAt) - (b.queue?.since ?? b.updatedAt));
  const reviews = [...snapshot.tasks.flatMap(t => t.review?.accepted ? [t.review.at] : []),
    ...activity.filter(e => e.kind === "verdict" && /^Accepted\b/.test(e.text)).map(e => e.at)];
  return { attention, active, queued, waiting: queued.length, needsCount: snapshot.counts?.attention ?? attention.length,
    done: snapshot.today?.done ?? 0, lastReview: reviews.length ? Math.max(...reviews) : null, executors: capacity(snapshot) };
}

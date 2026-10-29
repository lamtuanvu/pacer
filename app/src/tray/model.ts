import { agentInfo, markAgent } from "../../../src/view-model/agents";
import { clock } from "../../../src/view-model/time";
import { policyCaption } from "../../../src/view-model/words";
import { desktopUpdateIndicator } from "../../../src/view-model/updates";
import { settingsPath } from "../router";
import type { Action } from "../../../src/attention/types";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { ActivityEntry } from "../../../src/activity/log";
import type { ExecutorRow } from "../../../src/api/read-model/types";
import { capacity, needsYou, running, counts } from "../../../src/view-model/selectors";

export { displayTitle as shortTitle } from "../../../src/view-model/titles";
export function actionRoute(action: Action): string {
  const { route, view, id, section } = action.params;
  if (typeof route === "string" && /^#?\//.test(route)) return route.replace(/^#/, "");
  if ((view === "task" || view === "session" || view === "review") && typeof id === "string") return `/tasks/${encodeURIComponent(id)}${view === "task" && action.params.tab === "answer" ? "?tab=answer" : ""}`;
  if (view === "settings" && typeof section === "string") return settingsPath(section);
  return ({ overview: "/", home: "/", delegate: "/", settings: "/settings", executors: "/settings/executors", accounts: "/settings/accounts", hosts: "/settings/hosts", setup: "/", tasks: "/tasks", strategy: "/settings/dispatcher" } as Record<string, string>)[String(view)] ?? "/";
}
export const primaryAction = (actions: Action[]) => actions.find(a => a.style === "primary") ?? actions[0];
/** Compact capacity values never invent an unknown usage percentage. */
const OFF_STATES = new Set(["disabled", "down", "failing", "blocked"]);
export function executorValue(executor: ExecutorRow): string {
  // Eligibility is authoritative; operational failures and old prose can coexist
  // with a permitted budget. Never let those legacy hints hide a real reading.
  if (!executor.enabled || executor.state === "disabled") return "off";
  if (executor.eligibility?.state === "eligible" && executor.usedPct !== null) return `${Math.round(executor.usedPct)}%`;
  if (executor.eligibility?.state === "uncertain") return "?";
  if (executor.eligibility?.state === "ineligible") return executor.eligibility.budget === "exhausted" ? "out" : "off";
  if (!executor.enabled || OFF_STATES.has(executor.state) || /no (active )?(coding[- ])?plan|no subscription/i.test(`${executor.sub} ${executor.reason ?? ""}`)) return "off";
  if (executor.state === "exhausted") return "out";
  if (executor.state === "checking" || (executor.usedPct === null && executor.paceReason !== "unmetered")) return "?";
  if (executor.usedPct !== null) return `${Math.round(executor.usedPct)}%`;
  if (executor.slots.max > 0 && executor.slots.used >= executor.slots.max) return `${executor.slots.used}/${executor.slots.max}`;
  return executor.slots.used > 0 ? `${executor.slots.used}/${executor.slots.max}` : "—";
}
/** Off rows use state, never stale eligibility prose, to explain availability. */
export function offExecutorLabel(executor: ExecutorRow): string {
  const name = agentInfo(markAgent(executor.id, executor.account)).name;
  const reason = !executor.enabled || executor.state === "disabled" ? "turned off"
    : executor.reason ?? (executor.state === "down" ? "unavailable" : /eligible/i.test(executor.sub) ? "unable to take work" : executor.sub);
  return `${name}: ${reason || "unable to take work"}`;
}
export function trayModel(snapshot: ClientSnapshot, activity: ActivityEntry[] = []) {
  const attention = needsYou(snapshot, { repo: null });
  const recommendedId = attention.slice(0, 3).find(item => {
    const action = primaryAction(item.actions);
    return (item.kind === "failed" || item.kind === "limit") && action?.op === "task.retry" && typeof action.params.executor === "string" && action.params.executor.trim().length > 0;
  })?.id;
  const tasks = running(snapshot, { repo: null });
  const active = tasks.filter(t => t.state === "running");
  const queued = tasks.filter(t => t.state === "queued").sort((a, b) => (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity) || (a.queue?.since ?? a.updatedAt) - (b.queue?.since ?? b.updatedAt));
  const reviews = [...snapshot.tasks.flatMap(t => t.review?.accepted ? [t.review.at] : []),
    ...activity.filter(e => e.kind === "verdict" && /^Accepted\b/.test(e.text)).map(e => e.at)];
  return { policy: policyCaption(snapshot.policy), update: desktopUpdateIndicator(snapshot.desktopUpdates), attention, recommendedId, active, queued, waiting: queued.length, needsCount: counts(snapshot)?.attention ?? attention.length,
    done: snapshot.today?.done ?? 0, lastReview: reviews.length ? Math.max(...reviews) : null, executors: capacity(snapshot).filter(row => row.rank !== "planner" && row.id !== snapshot.planner?.runner) };
}

/** Future resets in this week use the board's weekday + local time. */
export function resetCaption(at: number, now: number): string {
  if (at < now || at - now >= 7 * 86400) return clock(at, now);
  const date = new Date(at * 1000);
  const time = date.toLocaleTimeString("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString("en-GB", { weekday: "short" });
  return `${day} ${time}`;
}

import type { Action } from "../../../src/attention/types";
import type { LinkSnapshot } from "../../../src/link/envelope";
import { activeTask, executorLabel, needsReview, taskHref, taskStatus, type Tone } from "./tasks";
import type { Account } from "./accounts";
export interface Runner { id: string; state: "ok" | "blocked" | "broken" | "exhausted"; until: number | null; reason: string | null }
export interface Routing { ranked: { id: string; verdict: string; reason: string }[]; excluded: { id: string; reason: string }[] }
export function homeModel(snapshot: LinkSnapshot, runners: Runner[], accounts: Account[] = []) {
  const provider = snapshot.budget?.providers.find(p => p.id === snapshot.budget?.planner);
  const tone = provider?.usedPct == null ? "neutral" : provider?.verdict === "EXHAUSTED" ? "bad" : provider && (provider.verdict === "AHEAD" || (provider.usedPct !== null && provider.pacePct !== null && provider.usedPct - provider.pacePct > 10)) ? "warn" : "good";
  const planner = provider ? { name: executorLabel(provider.id, accounts), used: provider.usedPct, pace: provider.pacePct, resetsAt: provider.resetsAt, window: provider.window, stale: provider.stale, tone: tone as "good" | "warn" | "bad" | "neutral", label: provider.usedPct === null ? "Usage unknown" : tone === "bad" ? "Out of quota" : tone === "warn" ? "Ahead of pace" : "On pace" } : null;
  const attention: { key: string; label: string; tone: Tone; title: string; detail: string; href: string; until?: number | null; actions?: Action[] }[] = snapshot.attention === undefined ? snapshot.tasks.filter(needsReview).map(t => ({ key: t.id, label: "Review", tone: "info", title: t.goal, detail: `${taskStatus(t).label} on ${executorLabel(t.executor, accounts)} · waiting for review`, href: taskHref(t.id) })) : [];
  if (snapshot.attention === undefined) {
    // Prefer runner.list, and retain budget-only failures while that query loads.
    const failures = new Map(runners.filter(r => r.state === "broken" || r.state === "exhausted").map(r => [r.id, r]));
    for (const p of snapshot.budget?.providers ?? []) if (p.id !== snapshot.budget?.planner && !runners.some(r => r.id === p.id) && (p.brokenReason || p.verdict === "EXHAUSTED")) failures.set(p.id, { id: p.id, state: p.brokenReason ? "broken" : "exhausted", reason: p.brokenReason ?? null, until: p.resetsAt });
    for (const runner of failures.values()) attention.push({ key: runner.id, label: runner.state === "broken" ? "Not working" : "Limit", tone: runner.state === "broken" ? "bad" : "warn", title: executorLabel(runner.id, accounts), detail: runner.reason ?? "Out of quota · work goes to the next executor", href: "#/executors", until: runner.until });
  } else {
    attention.splice(0, attention.length, ...snapshot.attention.map(item => {
      const navigation = item.actions.find(action => action.op === "ui.open");
      const view = navigation?.params.view;
      const href = view === "review" || view === "task" ? taskHref(String(navigation?.params.id ?? item.taskId ?? "")) : view === "settings" ? "#/settings" : item.taskId ? taskHref(item.taskId) : "#/settings";
      return { key: item.id, label: ({ review: "Review", failed: "Failed", limit: "Limit", stuck: "Stuck", account_signin: "Sign in", executor_down: "Not working", host_down: "Host down", planner_quota: "Planner quota", setup: "Setup", update: "Update" } as Record<string, string>)[item.kind] ?? item.kind, tone: (item.severity === "blocked" ? "bad" : item.severity === "problem" ? "warn" : "info") as Tone, title: item.title, detail: item.detail, href, actions: item.actions };
    }));
  }
  return { counts: snapshot.counts, attentionCount: snapshot.counts?.attention ?? attention.length, planner, mode: snapshot.mode?.mode ?? snapshot.budget?.mode ?? "Unknown", headline: !planner || planner.used === null ? "Planner usage isn't available yet." : tone === "bad" ? "Your planner is out of quota. Hand execution to another agent." : tone === "warn" ? "You're ahead of pace. Keep room for planning and review." : "You're on pace. Room for normal planning.", attention, running: snapshot.tasks.filter(t => activeTask(t.state) && !t.dismissed) };
}

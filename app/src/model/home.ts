import { needsYou, counts } from "../../../src/view-model/selectors";
import type { Action } from "../../../src/attention/types";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { activeTask, needsReview, taskHref } from "./tasks";
import { executorLabel, taskStatus, toneFor, verdictWords, type Tone } from "../../../src/view-model/words";
import type { Account } from "./accounts";
export interface Runner { id: string; state: "ok" | "blocked" | "broken" | "exhausted"; until: number | null; reason: string | null }
export interface Routing { policy?: {source:"project";repoKey:string;rev:number;executors:string[]}; ranked: { id: string; verdict: string; reason: string }[]; excluded: { id: string; reason: string }[] }
const plannerLabel = (verdict: string) => { const words = verdictWords(verdict); return words === "Available" ? "On pace" : words === "Unknown" ? "Usage unknown" : words; };
export function homeModel(snapshot: ClientSnapshot, runners: Runner[], accounts: Account[] = []) {
  // A 2.x service sends the planner meter; the v1 budget is the fallback for an older one and goes away in 3.0.
  const meter = snapshot.planner ?? null;
  const provider = meter ? undefined : snapshot.budget?.providers.find(p => p.id === snapshot.budget?.planner);
  const used = meter ? meter.usedPct : provider?.usedPct ?? null;
  const verdict = meter ? meter.verdict : provider?.verdict ?? "unknown";
  const tone = used == null ? "neutral" : toneFor(verdict);
  const planner = meter || provider ? {
    name: executorLabel(meter ? meter.runner : provider!.id, accounts), used, pace: meter ? meter.pacePct : provider!.pacePct,
    resetsAt: meter ? meter.resetsAt : provider!.resetsAt, window: meter ? meter.window : provider!.window, stale: meter ? meter.stale : provider!.stale,
    tone: tone as "good" | "warn" | "bad" | "neutral", label: used === null ? "Usage unknown" : plannerLabel(verdict),
  } : null;
  const attention: { key: string; label: string; tone: Tone; title: string; detail: string; href: string; until?: number | null; actions?: Action[] }[] = snapshot.attention === undefined ? snapshot.tasks.filter(needsReview).map(t => ({ key: t.id, label: "Review", tone: "info", title: t.goal, detail: `${taskStatus(t).label} on ${executorLabel(t.executor, accounts)} · waiting for review`, href: taskHref(t.id) })) : [];
  if (snapshot.attention === undefined) {
    // Prefer runner.list, and retain budget-only failures while that query loads.
    const failures = new Map(runners.filter(r => r.state === "broken" || r.state === "exhausted").map(r => [r.id, r]));
    for (const p of snapshot.budget?.providers ?? []) if (p.id !== snapshot.budget?.planner && !runners.some(r => r.id === p.id) && (p.brokenReason || p.verdict === "EXHAUSTED")) failures.set(p.id, { id: p.id, state: p.brokenReason ? "broken" : "exhausted", reason: p.brokenReason ?? null, until: p.resetsAt });
    for (const runner of failures.values()) attention.push({ key: runner.id, label: runner.state === "broken" ? "Not working" : "Limit", tone: runner.state === "broken" ? "bad" : "warn", title: executorLabel(runner.id, accounts), detail: runner.reason ?? "Out of quota · work goes to the next executor", href: "#/settings/executors", until: runner.until });
  } else {
    attention.splice(0, attention.length, ...needsYou(snapshot, {repo:null}).map(item => {
      const navigation = item.actions.find(action => action.op === "ui.open");
      const view = navigation?.params.view;
      const href = view === "review" || view === "task" ? taskHref(String(navigation?.params.id ?? item.taskId ?? "")) : view === "settings" ? "#/settings" : item.taskId ? taskHref(item.taskId) : "#/settings";
      return { key: item.id, label: ({ question: "Question", review: "Review", failed: "Failed", limit: "Limit", stuck: "Stuck", account_signin: "Sign in", executor_down: "Not working", host_down: "Host down", planner_quota: "Planner quota", setup: "Setup", update: "Update" } as Record<string, string>)[item.kind] ?? item.kind, tone: (item.severity === "blocked" ? "bad" : item.severity === "problem" ? "warn" : "info") as Tone, title: item.title, detail: item.detail, href, actions: item.actions };
    }));
  }
  return { counts: counts(snapshot), attentionCount: counts(snapshot)?.attention ?? attention.length, planner, mode: snapshot.mode?.mode ?? meter?.mode ?? snapshot.budget?.mode ?? "Unknown", headline: !planner || planner.used === null ? "Planner usage isn't available yet." : tone === "bad" ? "Your planner is out of quota. Hand execution to another agent." : tone === "warn" ? "You're ahead of pace. Keep room for planning and review." : "You're on pace. Room for normal planning.", attention, running: snapshot.tasks.filter(t => activeTask(t.state) && !t.dismissed) };
}

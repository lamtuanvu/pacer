import type { LinkSnapshot } from "../../../src/link/envelope";
import { activeTask, needsReview, taskHref } from "./tasks";
import { executorLabel, taskStatus, toneFor, type Tone } from "../../../src/view-model/words";
import type { Account } from "./accounts";
export interface Runner { id: string; state: "ok" | "blocked" | "broken" | "exhausted"; until: number | null; reason: string | null }
export interface Routing { ranked: { id: string; verdict: string; reason: string }[]; excluded: { id: string; reason: string }[] }
export function homeModel(snapshot: LinkSnapshot, runners: Runner[], accounts: Account[] = []) {
  const provider = snapshot.budget?.providers.find(p => p.id === snapshot.budget?.planner);
  const tone = provider?.usedPct == null ? "neutral" : toneFor(provider.verdict);
  const planner = provider ? { name: executorLabel(provider.id, accounts), used: provider.usedPct, pace: provider.pacePct, resetsAt: provider.resetsAt, window: provider.window, stale: provider.stale, tone: tone as "good" | "warn" | "bad" | "neutral", label: provider.usedPct === null ? "Usage unknown" : tone === "bad" ? "Out of quota" : tone === "warn" ? "Ahead of pace" : "On pace" } : null;
  const attention: { key: string; label: string; tone: Tone; title: string; detail: string; href: string; until?: number | null }[] = snapshot.tasks.filter(needsReview).map(t => ({ key: t.id, label: "Review", tone: "info", title: t.goal, detail: `${taskStatus(t).label} on ${executorLabel(t.executor, accounts)} · waiting for review`, href: taskHref(t.id) }));
  // Prefer runner.list, and retain budget-only failures while that query loads.
  const failures = new Map(runners.filter(r => r.state === "broken" || r.state === "exhausted").map(r => [r.id, r]));
  for (const p of snapshot.budget?.providers ?? []) if (p.id !== snapshot.budget?.planner && !runners.some(r => r.id === p.id) && (p.brokenReason || p.verdict === "EXHAUSTED")) failures.set(p.id, { id: p.id, state: p.brokenReason ? "broken" : "exhausted", reason: p.brokenReason ?? null, until: p.resetsAt });
  for (const runner of failures.values()) attention.push({ key: runner.id, label: runner.state === "broken" ? "Not working" : "Limit", tone: runner.state === "broken" ? "bad" : "warn", title: executorLabel(runner.id, accounts), detail: runner.reason ?? "Out of quota · work goes to the next executor", href: "#/executors", until: runner.until });
  return { planner, mode: snapshot.mode?.mode ?? snapshot.budget?.mode ?? "Unknown", headline: !planner || planner.used === null ? "Planner usage isn't available yet." : tone === "bad" ? "Your planner is out of quota. Hand execution to another agent." : tone === "warn" ? "You're ahead of pace. Keep room for planning and review." : "You're on pace. Room for normal planning.", attention, running: snapshot.tasks.filter(t => activeTask(t.state) && !t.dismissed) };
}

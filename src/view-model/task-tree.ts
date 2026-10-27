/** The one descriptor for "a task in a tree". Tasks, the Session panel, Needs you and the tray all build it here (UI-10). */
import type { AttentionItem } from "../attention/types";
import type { ClientSnapshot, ClientTask } from "./snapshot";
import { markAgent } from "./agents";
import { needsYou, type Scope } from "./selectors";

import { sessionTime } from "./copy";
import { attentionStatus, taskOutcome, taskStatus, type Tone } from "./words";

export type TaskAttention = "none" | "warn" | "bad";
/** Icon names shared with the DS icon set; kept as a subset so the view model never imports the app. */
export type TaskMetaIcon = "time" | "files" | "pr" | "checks" | "layers" | "review";
export interface TaskMetaItem { icon: TaskMetaIcon; text: string; tone?: Tone; title?: string }
export interface TaskNodeView {
  id: string; title: string;
  state: { tone: Tone; live: boolean; label: string };
  /** Running or queued: the work is still in flight. */
  active: boolean;
  attention: TaskAttention; attentionLabel?: string;
  /** Omitted while the machine is not known (queued work, or a source that does not report it). */
  host?: { name: string; kind: "local" | "remote" }; branch?: string;
  agents: string[]; tokens?: string;
  meta: TaskMetaItem[]; children: TaskNodeView[];
}
/** Token readings follow the attempt-token-accounting spec; a missing or unknown reading is never shown. */
export interface TreeTokens { coverage: "measured" | "partial" | "unknown"; total: number | null }
export type TreeTask = ClientTask & {
  parentId?: string | null; branch?: string | null; pr?: { number: number } | null; tokens?: TreeTokens | null;
  acceptance?: { state?: string; summary?: string } | null; diffstat?: { files: number; added: number; removed: number } | null;
};
export interface TreeSnapshot { tasks: TreeTask[]; attention?: AttentionItem[] }

const rank: Record<TaskAttention, number> = { none: 0, warn: 1, bad: 2 };
const worst = (a: TaskAttention, b: TaskAttention) => rank[b] > rank[a] ? b : a;

function compact(n: number): string {
  const [div, unit] = n >= 1e6 ? [1e6, "M"] : n >= 1e3 ? [1e3, "k"] : [1, ""];
  const value = n / div;
  return `${value >= 100 || div === 1 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
}
function tokenText(tokens: TreeTokens | null | undefined): string | undefined {
  if (!tokens || tokens.coverage === "unknown" || tokens.total == null) return undefined;
  return `${tokens.coverage === "partial" ? "≥ " : ""}${compact(tokens.total)} tokens`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ownAttention(task: TreeTask, items: AttentionItem[], tasks: TreeTask[]): { level: TaskAttention; label?: string } {
  const item = items.filter(i => i.taskId === task.id).sort((a, b) => (b.severity === "decide" ? 0 : 1) - (a.severity === "decide" ? 0 : 1))[0];
  if (item) return { level: item.severity === "decide" ? "warn" : "bad", label: attentionStatus(item, tasks).label };
  const status = taskStatus(task);
  if (task.acceptanceState === "failed" || task.acceptance?.state === "failed") return { level: "bad", label: "Checks failed" };
  if (task.state === "needs_input" || status.label === "Needs input") return { level: "warn", label: status.label };
  if (task.state === "failed" || task.state === "limit") return { level: "bad", label: status.label };
  return { level: "none" };
}

function meta(task: TreeTask, now: number): TaskMetaItem[] {
  const items: TaskMetaItem[] = [];
  if (task.repo?.label) items.push({ icon: "layers", text: task.repo.label });
  if (task.updatedAt) items.push({ icon: "time", text: sessionTime(task, now) });
  if (task.progress) items.push({ icon: "files", text: `${plural(task.progress.files, "file")} · ${plural(task.progress.commits, "commit")}` });
  else if (task.diffstat) items.push({ icon: "files", text: `${plural(task.diffstat.files, "file")} · +${task.diffstat.added} −${task.diffstat.removed}` });
  if (task.acceptance?.summary && (task.acceptance.state === "passed" || task.acceptance.state === "failed"))
    items.push({ icon: "checks", text: task.acceptance.summary, tone: task.acceptance.state === "passed" ? "good" : "bad" });
  if (task.review) { const outcome = taskOutcome(task); items.push({ icon: "review", text: outcome.label, tone: outcome.tone }); }
  if (task.pr?.number) items.push({ icon: "pr", text: `PR #${task.pr.number}` });
  return items;
}

/** Roots are ordered attention first (problems before decisions), then running and queued work, then the rest by recency. */
function order(a: TaskNodeView & { at: number; queued: boolean }, b: TaskNodeView & { at: number; queued: boolean }): number {
  return rank[b.attention] - rank[a.attention]
    || Number(b.active) - Number(a.active)
    || Number(a.queued) - Number(b.queued)
    || b.at - a.at;
}

export function taskTree(snapshot: TreeSnapshot, opts: { now: number; extra?: TreeTask[] }): TaskNodeView[] {
  const byId = new Map<string, TreeTask>();
  for (const task of [...(opts.extra ?? []), ...snapshot.tasks]) byId.set(task.id, task);
  const tasks = [...byId.values()];
  const items = snapshot.attention ?? [];
  type Built = TaskNodeView & { at: number; queued: boolean };
  const built = new Map<string, Built>();
  for (const task of tasks) {
    const status = taskStatus(task);
    const attention = ownAttention(task, items, tasks);
    const branch = task.branch ?? undefined;
    const tokens = tokenText(task.tokens);
    built.set(task.id, {
      id: task.id, title: task.fullTitle ?? task.title ?? task.goal,
      state: { tone: status.tone, live: task.state === "running", label: status.label },
      active: task.state === "running" || task.state === "queued",
      attention: attention.level, ...(attention.label ? { attentionLabel: attention.label } : {}),
      ...(task.host ? { host: { name: task.host, kind: "remote" as const } } : task.host === null && task.state !== "queued" ? { host: { name: "This Mac", kind: "local" as const } } : {}),
      ...(branch ? { branch } : {}), agents: task.executor ? [markAgent(task.executor)] : [], ...(tokens ? { tokens } : {}),
      meta: meta(task, opts.now), children: [], at: task.updatedAt, queued: task.state === "queued",
    });
  }
  const roots: Built[] = [];
  for (const task of tasks) {
    const node = built.get(task.id)!;
    const parent = task.parentId && task.parentId !== task.id ? built.get(task.parentId) : undefined;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const finish = (node: Built, seen: Set<string>): TaskNodeView => {
    seen.add(node.id);
    const children = (node.children as Built[]).filter(child => !seen.has(child.id)).sort(order).map(child => finish(child, seen));
    let attention = node.attention;
    const agents = [...node.agents];
    for (const child of children) { attention = worst(attention, child.attention); for (const agent of child.agents) if (!agents.includes(agent)) agents.push(agent); }
    const { at: _at, queued: _queued, ...view } = node;
    return { ...view, attention, agents, children };
  };
  // Roll attention up before ordering roots, so a root with a failing child sorts with the problems.
  const seen = new Set<string>();
  const finished = roots.map(root => ({ view: finish(root, seen), at: root.at, queued: root.queued }));
  return finished.sort((a, b) => order({ ...a.view, at: a.at, queued: a.queued }, { ...b.view, at: b.at, queued: b.queued })).map(item => item.view);
}

/** What screens call: the repository scope, the Needs you attention rules and the running list's dismissal rule, applied once. */
export function scopedTaskTree(snapshot: ClientSnapshot, scope: Scope, opts: { now: number; extra?: TreeTask[] }): TaskNodeView[] {
  const keep = (task: TreeTask) => (scope.repo === null || !task.repo || task.repo.key === scope.repo)
    && !(task.dismissed && (task.state === "running" || task.state === "queued"));
  return taskTree({ tasks: snapshot.tasks.filter(keep), attention: needsYou(snapshot, scope) }, { now: opts.now, extra: opts.extra?.filter(keep) });
}

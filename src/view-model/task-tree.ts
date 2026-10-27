/** The one descriptor for "a task in a tree". Tasks, the Session panel, Needs you and the tray all build it here (UI-10). */
import type { AttentionItem } from "../attention/types";
import type { ClientSnapshot, ClientTask } from "./snapshot";
import { markAgent } from "./agents";
import { needsYou, type Scope } from "./selectors";

import { sessionTime } from "./copy";
import { attentionStatus, localHostWords, subtaskAttentionWords, taskOutcome, taskStatus, type Status, type Tone } from "./words";

export type TaskAttention = "none" | "warn" | "bad";
/** Icon names shared with the DS icon set; kept as a subset so the view model never imports the app. */
export type TaskMetaIcon = "time" | "files" | "pr" | "checks" | "layers" | "review" | "routing" | "notes";
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

/** 1234 → "1.2k", 18400000 → "18.4M": the one compact count format for token figures. */
export function compactCount(n: number): string {
  const [div, unit] = n >= 1e6 ? [1e6, "M"] : n >= 1e3 ? [1e3, "k"] : [1, ""];
  const value = n / div;
  return `${value >= 100 || div === 1 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
}
function tokenText(tokens: TreeTokens | null | undefined): string | undefined {
  if (!tokens || tokens.coverage === "unknown" || tokens.total == null) return undefined;
  return `${tokens.coverage === "partial" ? "≥ " : ""}${compactCount(tokens.total)} tokens`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Tint, pill colour and words come from one vocabulary status, so they never disagree (UI-10). */
const fromStatus = (status: Status): { level: TaskAttention; label: string } => ({ level: status.tone === "bad" ? "bad" : "warn", label: status.label });
/** Within one tint, Needs you's own order breaks ties: blocked, then problems, then decisions. */
const urgency: Record<AttentionItem["severity"], number> = { blocked: 0, problem: 1, decide: 2 };
const calm = 3;
/**
 * With a Needs you list (a snapshot), attention comes only from it, so a resolved, snoozed or decided item never tints a card.
 * Without one (history or work pages fetched alone), the task's own state is the only evidence.
 */
function ownAttention(task: TreeTask, items: AttentionItem[] | undefined, tasks: TreeTask[]): { level: TaskAttention; label?: string; urgency?: number } {
  if (items) {
    const item = items.filter(i => i.taskId === task.id).sort((a, b) => urgency[a.severity] - urgency[b.severity])[0];
    if (!item) return { level: "none" };
    // A task's own status can be calm (a stuck run still reads "Editing"); then the item's kind supplies the words.
    const own = attentionStatus(item, tasks);
    return { ...fromStatus(own.tone === "warn" || own.tone === "bad" ? own : attentionStatus(item)), urgency: urgency[item.severity] };
  }
  if (task.resolved || task.dismissed || task.retriedBy || task.review) return { level: "none" };
  const status = taskStatus(task);
  if (task.acceptanceState === "failed" || task.acceptance?.state === "failed")
    return fromStatus(attentionStatus({ kind: "failed", taskId: task.id }, [{ ...task, acceptanceState: "failed" }]));
  if (task.state === "needs_input" || (task.state === "running" && task.conversation?.activity === "waiting")) return fromStatus(status);
  if (task.state === "failed" || task.state === "limit" || task.state === "partial") return fromStatus(status);
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

type Sortable = TaskNodeView & { at: number; queued: boolean; urgency: number };
/** Roots are ordered attention first (bad, then warn; Needs you severity within each), then running and queued work, then the rest by recency. */
function order(a: Sortable, b: Sortable): number {
  return rank[b.attention] - rank[a.attention]
    || a.urgency - b.urgency
    || Number(b.active) - Number(a.active)
    || Number(a.queued) - Number(b.queued)
    || b.at - a.at;
}

export function taskTree(snapshot: TreeSnapshot, opts: { now: number; extra?: TreeTask[] }): TaskNodeView[] {
  const byId = new Map<string, TreeTask>();
  // Snapshot rows are fresher, but only a fetched detail or work page knows the parent link, so keep it.
  for (const task of [...(opts.extra ?? []), ...snapshot.tasks]) {
    const previous = byId.get(task.id);
    byId.set(task.id, previous?.parentId != null && task.parentId == null ? { ...task, parentId: previous.parentId } : task);
  }
  const tasks = [...byId.values()];
  const items = snapshot.attention;
  type Built = Sortable;
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
      ...(task.host ? { host: { name: task.host, kind: "remote" as const } } : task.host === null && task.state !== "queued" ? { host: { name: localHostWords, kind: "local" as const } } : {}),
      ...(branch ? { branch } : {}), agents: task.executor ? [markAgent(task.executor)] : [], ...(tokens ? { tokens } : {}),
      meta: meta(task, opts.now), children: [], at: task.updatedAt, queued: task.state === "queued",
      urgency: attention.level === "none" ? calm : attention.urgency ?? urgency.problem,
    });
  }
  const strip = ({ at: _at, queued: _queued, urgency: _urgency, ...view }: Sortable): TaskNodeView => view;
  const roots: Built[] = [];
  for (const task of tasks) {
    const node = built.get(task.id)!;
    const parent = task.parentId && task.parentId !== task.id ? built.get(task.parentId) : undefined;
    if (parent) parent.children.push(node);
    else {
      // A subtask whose parent is not loaded stays reachable as a root, and says what it is.
      if (task.parentId && task.parentId !== task.id) node.meta.unshift({ icon: "routing", text: "Subtask" });
      roots.push(node);
    }
  }
  const finish = (node: Built, seen: Set<string>): Sortable => {
    seen.add(node.id);
    const children = (node.children as Built[]).filter(child => !seen.has(child.id)).map(child => finish(child, seen)).sort(order);
    let attention = node.attention, attentionLabel = node.attentionLabel, nodeUrgency = node.urgency;
    const agents = [...node.agents];
    for (const child of children) {
      // A worse subtask lends its words along with its tint, so a collapsed card never shows colour alone (UI-2).
      if (rank[child.attention] > rank[attention]) { attention = child.attention; attentionLabel = child.attentionLabel && subtaskAttentionWords(child.attentionLabel.replace(/^Subtask: /, "")); }
      if (child.attention === attention) nodeUrgency = Math.min(nodeUrgency, child.urgency);
      for (const agent of child.agents) if (!agents.includes(agent)) agents.push(agent);
    }
    const { attentionLabel: _label, ...rest } = node;
    return { ...rest, attention, ...(attentionLabel ? { attentionLabel } : {}), agents, children: children.map(strip), urgency: nodeUrgency };
  };
  // Roll attention up before ordering roots, so a root with a failing child sorts with the problems.
  const seen = new Set<string>();
  return roots.map(root => finish(root, seen)).sort(order).map(strip);
}

/**
 * What screens call: the repository scope, the Needs you attention rules and the running list's dismissal rule, applied once.
 * `pinned` (the open task) is exempt from the filters, so the navigator always shows it.
 */
export function scopedTaskTree(snapshot: ClientSnapshot, scope: Scope, opts: { now: number; extra?: TreeTask[]; pinned?: string }): TaskNodeView[] {
  const keep = (task: TreeTask) => task.id === opts.pinned || (scope.repo === null || !task.repo || task.repo.key === scope.repo)
    && !(task.dismissed && (task.state === "running" || task.state === "queued"));
  return taskTree({ tasks: snapshot.tasks.filter(keep), attention: needsYou(snapshot, scope) }, { now: opts.now, extra: opts.extra?.filter(keep) });
}

/** Run step tree from `run.get` (shared by the TUI run view and the app run view). Framework-free. */
import type { RunDetail, RunQuestion, RunStepRow } from "../dashboard/screens/types";
import { fanoutAttempt } from "../workflow/fanout";
export interface TreeLine {
  id: string;
  stepId: string;
  attempt: number;
  branch?: string;
  taskId?: string;
  status: string;
  depth: number;
  /** Collapsed retry count shown as `(N)`. */
  attempts: number;
  label: string;
  waitsOnYou: boolean;
}

export function stepTypeOf(detail: RunDetail, stepId: string): string | undefined {
  return detail.definition?.steps[stepId]?.type;
}

/** Collapse attempts: keep the highest attempt per (stepId, branch). */
function collapseAttempts(steps: RunStepRow[]): { latest: Map<string, RunStepRow>; attemptCount: Map<string, number> } {
  const latest = new Map<string, RunStepRow>();
  const attemptCount = new Map<string, number>();
  for (const step of steps) {
    const key = `${step.stepId}\0${step.branch ?? ""}`;
    attemptCount.set(key, (attemptCount.get(key) ?? 0) + 1);
    const prev = latest.get(key);
    if (!prev || step.attempt >= prev.attempt) latest.set(key, step);
  }
  return { latest, attemptCount };
}

/** Order root step ids from definition edges (BFS from entry); unknown ids append by startedAt. */
function graphOrder(detail: RunDetail, stepIds: string[]): string[] {
  const def = detail.definition;
  if (!def?.edges?.length && !def?.entry) {
    return [...stepIds].sort((a, b) => {
      const sa = detail.steps.find(s => s.stepId === a)?.startedAt ?? 0;
      const sb = detail.steps.find(s => s.stepId === b)?.startedAt ?? 0;
      return sa - sb || a.localeCompare(b);
    });
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  const queue: string[] = def.entry ? [def.entry] : [];
  const outs = new Map<string, string[]>();
  for (const e of def.edges ?? []) {
    const list = outs.get(e.from) ?? [];
    list.push(e.to);
    outs.set(e.from, list);
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (stepIds.includes(id)) ordered.push(id);
    for (const to of outs.get(id) ?? []) queue.push(to);
  }
  for (const id of stepIds) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

function fanoutStatus(branches: RunStepRow[], join?: RunStepRow): string {
  if (join) return join.status;
  if (branches.some(b => b.status === "failed")) return "failed";
  if (branches.some(b => b.status === "running")) return "running";
  if (branches.some(b => b.status === "waiting")) return "waiting";
  if (branches.length && branches.every(b => b.status === "done")) return "done";
  return branches[0]?.status ?? "running";
}

/** Match a question to a tree row on (stepId, attempt, branch). Missing attempt matches any. */
export function questionMatchesStep(
  q: Pick<RunQuestion, "stepId" | "attempt" | "branch">,
  step: { stepId: string; attempt: number; branch?: string },
): boolean {
  if (q.stepId !== step.stepId) return false;
  if ((q.branch ?? "") !== (step.branch ?? "")) return false;
  if (q.attempt !== undefined && q.attempt !== step.attempt) return false;
  return true;
}

function openQuestionKeys(questions: RunQuestion[]): Set<string> {
  const keys = new Set<string>();
  for (const q of questions) {
    if (!q.stepId) continue;
    keys.add(`${q.stepId}\0${q.attempt ?? ""}\0${q.branch ?? ""}`);
  }
  return keys;
}

function stepWaitsOnYou(
  openKeys: Set<string>,
  step: { stepId: string; attempt: number; branch?: string; status: string },
): boolean {
  if (step.status !== "waiting") return false;
  const exact = `${step.stepId}\0${step.attempt}\0${step.branch ?? ""}`;
  if (openKeys.has(exact)) return true;
  // Questions without attempt still bind to the visible (collapsed) row of that branch.
  return openKeys.has(`${step.stepId}\0\0${step.branch ?? ""}`);
}

/**
 * Build tree lines only from `run.get` steps, definition edges/types and graph versions.
 * Fan-out branch rows share the fan-out stepId (engine key); they nest under that step.
 * Generated graphs nest under their generate step keyed by stepId AND attempt.
 * When the exact definition is missing, roots are ordered by startedAt (flat list).
 */
export function buildRunTree(detail: RunDetail, openQuestions: RunQuestion[] | Set<string> = []): TreeLine[] {
  const steps = detail.steps;
  if (!steps.length) return [];
  const { latest, attemptCount } = collapseAttempts(steps);
  const rows = [...latest.values()];
  const openKeys = openQuestions instanceof Set
    ? new Set([...openQuestions].map(id => `${id}\0\0`))
    : openQuestionKeys(openQuestions);

  const approvedByGenerate = new Map<string, typeof detail.graphs[number]>();
  for (const g of detail.graphs) {
    if (g.status !== "approved") continue;
    const key = `${g.stepId}\0${g.attempt}`;
    const prev = approvedByGenerate.get(key);
    if (!prev || g.version >= prev.version) approvedByGenerate.set(key, g);
  }

  // Fan-out: branch rows share the fan-out stepId; join is the branch-less row of the same id.
  // Prefer definition.type === "fanout"; without a definition, any stepId that has branch rows is fan-out.
  const fanoutIds = new Set<string>();
  for (const s of rows) {
    if (stepTypeOf(detail, s.stepId) === "fanout" || s.branch) fanoutIds.add(s.stepId);
  }
  const branchesByFanout = new Map<string, RunStepRow[]>();
  const joinByFanout = new Map<string, RunStepRow>();
  for (const s of rows) {
    if (!fanoutIds.has(s.stepId)) continue;
    if (s.branch) {
      const list = branchesByFanout.get(s.stepId) ?? [];
      list.push(s);
      branchesByFanout.set(s.stepId, list);
    } else {
      joinByFanout.set(s.stepId, s);
    }
  }
  for (const [, list] of branchesByFanout) {
    list.sort((a, b) => (a.branch ?? "").localeCompare(b.branch ?? "") || a.startedAt - b.startedAt);
  }

  const lines: TreeLine[] = [];
  const pushLine = (line: TreeLine) => { lines.push(line); };
  const pushStep = (step: RunStepRow, depth: number) => {
    const key = `${step.stepId}\0${step.branch ?? ""}`;
    const attempts = attemptCount.get(key) ?? 1;
    const waitsOnYou = stepWaitsOnYou(openKeys, step);
    const branch = step.branch ? `/${step.branch}` : "";
    const attemptLabel = attempts > 1 ? ` (${attempts})` : "";
    pushLine({
      id: `step:${step.stepId}:${step.attempt}:${step.branch ?? ""}`,
      stepId: step.stepId,
      attempt: step.attempt,
      ...(step.branch ? { branch: step.branch } : {}),
      ...(step.taskId ? { taskId: step.taskId } : {}),
      status: step.status,
      depth,
      attempts,
      label: `${step.stepId}${branch}${attemptLabel}`,
      waitsOnYou,
    });
    if (!step.branch) {
      const graph = approvedByGenerate.get(`${step.stepId}\0${step.attempt}`);
      if (graph) {
        pushLine({
          id: `graph:${step.stepId}:${step.attempt}:${graph.version}`,
          stepId: step.stepId,
          attempt: step.attempt,
          status: "done",
          depth: depth + 1,
          attempts: 1,
          label: `graph v${graph.version} (${graph.stepCount} steps)`,
          waitsOnYou: false,
        });
      }
    }
  };

  const pushFanout = (stepId: string, depth: number) => {
    const branches = branchesByFanout.get(stepId) ?? [];
    const join = joinByFanout.get(stepId);
    const attempt = join?.attempt ?? Math.max(0, ...branches.map(fanoutAttempt));
    const status = fanoutStatus(branches, join);
    const parentKey = `${stepId}\0`;
    const attempts = join
      ? (attemptCount.get(parentKey) ?? 1)
      : Math.max(1, ...branches.map(b => attemptCount.get(`${b.stepId}\0${b.branch ?? ""}`) ?? 1));
    const attemptLabel = attempts > 1 ? ` (${attempts})` : "";
    const waitsOnYou = stepWaitsOnYou(openKeys, {
      stepId, attempt, status, ...(join?.branch ? { branch: join.branch } : {}),
    });
    pushLine({
      id: `step:${stepId}:${attempt}:`,
      stepId,
      attempt,
      ...(join?.taskId ? { taskId: join.taskId } : {}),
      status,
      depth,
      attempts,
      label: `${stepId}${attemptLabel}`,
      waitsOnYou,
    });
    for (const child of branches) pushStep(child, depth + 1);
  };

  const rootIds = new Set<string>();
  for (const s of rows) {
    if (fanoutIds.has(s.stepId)) rootIds.add(s.stepId);
    else if (!s.branch) rootIds.add(s.stepId);
  }
  const ordered = graphOrder(detail, [...rootIds]);
  const emitted = new Set<string>();
  for (const stepId of ordered) {
    if (emitted.has(stepId)) continue;
    emitted.add(stepId);
    if (fanoutIds.has(stepId)) pushFanout(stepId, 0);
    else {
      const step = rows.find(s => s.stepId === stepId && !s.branch);
      if (step) pushStep(step, 0);
    }
  }
  return lines;
}


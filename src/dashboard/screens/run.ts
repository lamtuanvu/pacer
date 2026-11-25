/** Run view: indented step tree from `run.get`, with a details pane (Phase 8 Task 2). */
import {
  answerTypeLabel,
  displayRunLetter,
  nextRunPriority,
  orchestratorBlock,
  questionStatusLabel,
  stepMarkerFor,
  stepMarkerGlyph,
} from "../../view-model/runs";
import { elapsed } from "../../view-model/time";
import { cols, flex, heading, span, statusSpans, wrap } from "../frame";
import type { Act, Item } from "../state";
import { blank, empty, MARK, opAct } from "./common";
import { MSG_BODY_MAX } from "./answer-encoding";
import { questionAnswerAct } from "./question-form";
import type { Row, RunDetail, RunQuestion, RunStepRow, ScreenCtx, ScreenView } from "./types";

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

function stepTypeOf(detail: RunDetail, stepId: string): string | undefined {
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
    const attempt = join?.attempt ?? Math.max(0, ...branches.map(b => b.attempt));
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

function resultSummary(result: unknown, maxLines = 20): string[] {
  if (result === undefined || result === null) return [];
  try {
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept.push(`… ${lines.length - maxLines} more lines`);
    return kept;
  } catch {
    return [String(result)];
  }
}

function stepDetailRows(ctx: ScreenCtx, detail: RunDetail, line: TreeLine | undefined): Row[] {
  if (!line || line.id.startsWith("graph:")) {
    return [empty("Select a step to see its result, decisions and questions.")];
  }
  const step = detail.steps.find(s =>
    s.stepId === line.stepId && s.attempt === line.attempt && (s.branch ?? "") === (line.branch ?? ""));
  const rows: Row[] = [];
  rows.push({ line: heading(ctx.theme, line.label) });
  rows.push({
    line: statusSpans(ctx.theme, {
      label: line.waitsOnYou ? "Waits on you" : line.status,
      tone: line.waitsOnYou ? "warn" : line.status === "failed" ? "bad" : line.status === "done" ? "good" : "info",
      glyph: stepMarkerGlyph(stepMarkerFor({ status: line.status, waitsOnYou: line.waitsOnYou }), ctx.theme.unicode),
    }),
  });
  if (step?.taskId) rows.push({ line: [span(`Task ${step.taskId}`, { fg: "muted" })] });
  const pending = detail.pendingApproval;
  if (pending && pending.stepId === line.stepId && pending.attempt === line.attempt) {
    rows.push(blank());
    rows.push({ line: heading(ctx.theme, "Pending approval") });
    rows.push({ line: [span(`Generated graph v${pending.version} awaits approval`, { fg: "warn" })] });
    if (pending.replanSummary) {
      for (const w of wrap(pending.replanSummary, ctx.wide ? 48 : ctx.width - MARK)) {
        rows.push({ line: [span(w, { fg: "secondary" })] });
      }
    }
    rows.push({ line: [span("Answer with a to approve or revise", { fg: "muted" })] });
  }
  if (step?.error) {
    rows.push(blank());
    rows.push({ line: heading(ctx.theme, "Error") });
    for (const w of wrap(step.error, ctx.wide ? 48 : ctx.width - MARK)) rows.push({ line: [span(w, { fg: "bad" })] });
  }
  const summary = resultSummary(step?.result);
  if (summary.length) {
    rows.push(blank());
    rows.push({ line: heading(ctx.theme, "Result") });
    for (const w of summary) rows.push({ line: [span(w, { fg: "secondary" })] });
  }
  const decisions = (Array.isArray(detail.decisions) ? detail.decisions : []).filter(d => d.stepId === line.stepId && d.attempt === line.attempt);
  if (decisions.length) {
    rows.push(blank());
    rows.push({ line: heading(ctx.theme, "Decisions") });
    for (const d of decisions) {
      rows.push({ line: [span(`${d.choice}`, { bold: true }), span(` · ${d.reason}`, { fg: "secondary" })] });
    }
  }
  const questions = (detail.questions ?? []).filter(q => questionMatchesStep(q, line));
  if (questions.length) {
    rows.push(blank());
    rows.push({ line: heading(ctx.theme, "Questions") });
    for (const q of questions) {
      for (const w of wrap(q.text, ctx.wide ? 48 : ctx.width - MARK)) rows.push({ line: [span(w)] });
      rows.push({ line: [span(`${answerTypeLabel(q.answerType)} · ${questionStatusLabel(q.status)}`, { fg: "muted" })] });
    }
  }
  if (!summary.length && !decisions.length && !questions.length && !step?.error) {
    rows.push(blank());
    rows.push(empty("No result, decisions or questions for this step yet."));
  }
  return rows;
}

function runActions(ctx: ScreenCtx, detail: RunDetail, selectedQuestion?: RunQuestion, selectedStep?: TreeLine): { actions: Act[]; keys: Record<string, Act>; hints: string[] } {
  const run = detail.run;
  const rev = run.rev;
  const keys: Record<string, Act> = {};
  const actions: Act[] = [];
  const hints: string[] = [];
  const stepType = selectedStep ? stepTypeOf(detail, selectedStep.stepId) : undefined;
  const pending = detail.pendingApproval;
  const isPendingApproval = !!selectedStep && !!pending
    && pending.stepId === selectedStep.stepId
    && pending.attempt === selectedStep.attempt
    && !selectedStep.branch;
  const isHumanWait = !selectedQuestion
    && selectedStep?.status === "waiting"
    && !selectedStep.taskId
    && !selectedStep.branch
    && stepType === "human";
  const answer = questionAnswerAct({
    question: selectedQuestion,
    humanStep: (isHumanWait || isPendingApproval) && selectedStep
      ? { runId: run.id, stepId: selectedStep.stepId, expectRev: rev }
      : undefined,
    supports: ctx.supports,
  });
  if (answer) { keys.a = answer; actions.push(answer); }

  const paused = run.status === "paused"
    || (typeof (run as { paused_reason?: unknown }).paused_reason === "string")
    || (typeof (run as { pausedReason?: unknown }).pausedReason === "string");
  if (paused) {
    if (ctx.supports("run.resume")) {
      const act = opAct(ctx, "Resume", "run.resume", { id: run.id, expect_rev: rev });
      if (act) { keys.p = act; actions.push(act); }
    }
    // When resume is absent while paused, offer nothing (not Pause).
  } else if (ctx.supports("run.pause")) {
    const act = opAct(ctx, "Pause", "run.pause", { id: run.id, expect_rev: rev });
    if (act) { keys.p = act; actions.push(act); }
  }
  const stop = opAct(ctx, "Stop", "run.stop", { id: run.id, expect_rev: rev }, {
    danger: true,
    confirm: { title: "Stop this run?", body: [run.title || run.workflow], yes: "Stop" },
  });
  if (stop) { keys.s = stop; actions.push(stop); }

  if (ctx.supports("run.set_priority")) {
    const next = nextRunPriority(run.priority);
    const act = opAct(ctx, `Priority → ${next}`, "run.set_priority", { id: run.id, priority: next, expect_rev: rev });
    if (act) { keys.P = act; actions.push(act); }
  }
  if (ctx.supports("run.set_auto")) {
    const next = !(run.auto ?? true);
    const act = opAct(ctx, next ? "Auto on" : "Auto off", "run.set_auto", { id: run.id, auto: next, expect_rev: rev });
    if (act) { keys.A = act; actions.push(act); }
  }
  if (ctx.supports("msg.send") && run.orchestratorTaskId) {
    const to = `task:${run.orchestratorTaskId}`;
    keys.m = {
      label: "Message orchestrator",
      effect: {
        type: "prompt",
        prompt: {
          title: "Message the orchestrator",
          label: "Message",
          required: "Write a message first.",
          maxLength: MSG_BODY_MAX,
          submit: body => ({
            type: "action",
            action: { label: "Message sent", op: "msg.send", params: { to, body } },
          }),
        },
      },
    };
    actions.push(keys.m);
  }
  hints.push("Esc back");
  return { actions, keys, hints };
}

export function runViewScreen(ctx: ScreenCtx, runId: string): ScreenView {
  const resource = ctx.data.runDetails?.get(runId);
  const list: Row[] = [];
  const items: Item[] = [];
  if (resource?.error) {
    list.push({ line: [span(resource.error.message, { fg: "bad" })] });
    return { list, items, hints: ["Esc back"] };
  }
  if (!resource?.value) {
    list.push(empty(resource?.loading ? "Loading run…" : "Run details unavailable."));
    return { list, items, hints: ["Esc back"] };
  }
  const detail = resource.value;
  const openQs = (Array.isArray(detail.questions) ? detail.questions : []).filter(q => q.status === "open" && q.answerer === "person");
  const tree = buildRunTree(detail, openQs);

  const orchLine = orchestratorBlock(detail.run.orchestrator, ctx.now, ctx.timeZone);
  const orchIdle = orchLine === "Orchestrator idle";
  list.push({
    line: [span(orchLine, orchIdle ? { fg: "muted" } : { fg: "warn", bold: true })],
  });
  list.push({
    line: [
      span(`${displayRunLetter(detail.run)} `, { bold: true, fg: "ink" }),
      span(detail.run.title || detail.run.workflow, { bold: true }),
      span(` · ${detail.run.workflow}`, { fg: "muted" }),
    ],
  });
  if (!detail.definition) {
    list.push({
      line: [span("Workflow definition for this version is unavailable; steps listed by start time.", { fg: "muted" })],
    });
  }
  list.push(blank());

  if (!tree.length) list.push(empty("No steps yet."));

  for (const line of tree) {
    const question = openQs.find(q => questionMatchesStep(q, line));
    const openTask: Act | undefined = line.taskId
      ? { label: "Open task", effect: { type: "navigate", screen: "sessions", id: line.taskId } }
      : undefined;
    const { actions, keys } = runActions(ctx, detail, question, line);
    const primary = openTask ?? keys.a;
    const item: Item = {
      id: line.id,
      ...(primary ? { primary } : {}),
      actions,
      keys,
    };
    items.push(item);

    const marker = stepMarkerGlyph(stepMarkerFor({ status: line.status, waitsOnYou: line.waitsOnYou }), ctx.theme.unicode);
    const indent = "  ".repeat(line.depth);
    const elapsedFor = elapsed(Math.max(0, ctx.now - (detail.steps.find(s => s.stepId === line.stepId && s.attempt === line.attempt && (s.branch ?? "") === (line.branch ?? ""))?.startedAt ?? ctx.now)));
    // Qualifier + duration so truncated cells still show running/waiting (N4).
    const timing = line.status === "running" ? `running ${elapsedFor}`
      : line.status === "waiting" ? `waiting ${elapsedFor}`
      : "";
    const statusWord = line.waitsOnYou ? "waits on you" : line.status;
    const w = flex(ctx.wide ? 52 : ctx.width - MARK, [{ weight: 1, min: 8 }, { fixed: 12 }, { fixed: 14 }]);
    list.push({
      item: item.id,
      line: cols([
        { content: `${indent}${marker} ${line.label}`, width: w[0]!, style: { bold: line.waitsOnYou } },
        { content: statusWord, width: w[1]!, style: { fg: line.waitsOnYou ? "warn" : "secondary" } },
        { content: timing, width: w[2]!, align: "right", style: { fg: "muted" } },
      ], 2, ctx.theme),
    });
  }

  // Screen-level actions when no step selected yet still need stop/etc on the first item or a synthetic row.
  if (!items.length) {
    const { actions, keys, hints } = runActions(ctx, detail);
    items.push({ id: `run:${runId}`, actions, keys });
    return { list, items, hints };
  }

  const selectedId = ctx.state.selected.runs;
  const selected = items.find(i => i.id === selectedId) ?? items[0];
  const selectedLine = tree.find(t => t.id === selected?.id);
  const selectedQuestion = selectedLine ? openQs.find(q => questionMatchesStep(q, selectedLine)) : undefined;
  // Rebind keys on the selected item so `a` targets the selected step's question.
  if (selected && selectedLine) {
    const rebound = runActions(ctx, detail, selectedQuestion, selectedLine);
    selected.keys = { ...selected.keys, ...rebound.keys };
    selected.actions = rebound.actions;
    if (selectedLine.taskId) {
      selected.primary = {
        label: "Open task",
        effect: { type: "navigate", screen: "sessions", id: selectedLine.taskId },
      };
    }
  }

  const detailRows = stepDetailRows(ctx, detail, selectedLine);
  const listWidth = ctx.wide ? 52 : ctx.width;
  const { hints } = runActions(ctx, detail, selectedQuestion, selectedLine);
  return {
    list,
    detail: detailRows,
    listWidth,
    items,
    hints,
    needs: selectedLine?.taskId ? [selectedLine.taskId] : [],
  };
}

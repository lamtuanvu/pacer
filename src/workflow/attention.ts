// Workflow-run attention derived from live run state (D2.4 / round-2 I3): budget
// exhaustion and orchestrator failures, with actions that include expect_rev and
// concrete run.set_budget / run.set_planner params. since/raisedAt are stable via
// spent.attention_at (no orchestrator-attention.json / budget-attention.json).
// Phase 4 also raises /v3-only items for open person-answerer structured questions (D10).
import type { Ctx } from "../types";
import type { Action, AttentionItem, AttentionUnblocks } from "../attention/types";
import { sortItems } from "../attention/rules";
import { PLANNERS } from "../config/strategy";
import { agentInfo } from "../view-model/agents";
import {
  getRun,
  listOpenPersonQuestions,
  liveRuns,
  workflowSchemaPresent,
  type QuestionAskerKind,
  type QuestionBlocks,
  type QuestionRow,
  type RunRow,
} from "./store";
import { taskDatabase } from "../tasks/store";
import { isBudgetBlocked, parseBudget, parseSpent } from "./budget";

/** Person-facing cue so human-step / planner / executor questions differ on Dispatch. */
function askerCue(kind: QuestionAskerKind): string {
  if (kind === "human_step") return "Needs your approval";
  if (kind === "orchestrator") return "Asked by the workflow planner";
  return "Asked by a step";
}

/** Clip to `max` Unicode code points (never split a surrogate pair). */
export function clipCodePoints(s: string, max: number, ellipsis = false): string {
  const points = Array.from(s);
  if (points.length <= max) return s;
  const head = points.slice(0, max).join("");
  return ellipsis ? `${head}…` : head;
}

const OPTION_DETAIL_CLIP = 40;
const OPTION_BUTTON_MAX_CODE_POINTS = 80;
const ANSWER_CHAR_LIMIT = 2000;
const OPTION_BUTTON_CAP = 3;

/** Plain-word option list for the attention detail (yes_no always yes/no). */
function optionWords(q: QuestionRow): string[] | null {
  if (q.answerType === "yes_no") return ["yes", "no"];
  if (q.answerType === "approve_revise") {
    return q.options?.length ? q.options.map(o => o.value) : ["approve", "revise"];
  }
  if (q.options?.length) return q.options.map(o => o.value);
  return null;
}

function complementaryYesNo(first: string): string {
  const lower = first.toLowerCase();
  if (lower === "yes") {
    if (first === "Yes") return "No";
    if (first === "YES") return "NO";
    return "no";
  }
  if (first === "No") return "Yes";
  if (first === "NO") return "YES";
  return "yes";
}

/** An option that would not fit a Dispatch button (m2). */
function optionFitsButton(value: string): boolean {
  return value.length <= ANSWER_CHAR_LIMIT
    && Array.from(value).length <= OPTION_BUTTON_MAX_CODE_POINTS;
}

/** Up to 3 option buttons; recommended first. Shared by `single` and custom `approve_revise`. */
function optionChoiceActions(
  id: string,
  expect_rev: number,
  values: string[],
  recommended?: string | null,
): Action[] {
  if (values.length === 0) return [];
  const ordered = recommended && values.includes(recommended)
    ? [recommended, ...values.filter(v => v !== recommended)]
    : values;
  const buttonable = ordered.filter(optionFitsButton);
  return buttonable.slice(0, OPTION_BUTTON_CAP).map((answer, i) => {
    const action: Action = {
      label: clipCodePoints(answer, OPTION_DETAIL_CLIP, true),
      op: "question.answer",
      params: { id, expect_rev, answer },
    };
    if (i === 0) action.style = "primary";
    return action;
  });
}

/**
 * Actions whose first entry can succeed via a direct op call (UI-13 / Dispatch
 * renders only the first action). Text/multi and other shapes have no op action.
 */
export function runQuestionActions(q: QuestionRow): Action[] {
  const id = q.id;
  const expect_rev = q.rev;
  if (q.answerType === "yes_no") {
    const first = q.recommended && ["yes", "no"].includes(q.recommended.toLowerCase())
      ? q.recommended
      : "Yes";
    const second = complementaryYesNo(first);
    return [
      { label: first, op: "question.answer", params: { id, expect_rev, answer: first }, style: "primary" },
      { label: second, op: "question.answer", params: { id, expect_rev, answer: second } },
    ];
  }
  if (q.answerType === "approve_revise") {
    const values = q.options?.map(o => o.value) ?? [];
    if (values.length === 0) {
      return [
        { label: "Approve", op: "question.answer", params: { id, expect_rev, answer: "approve" }, style: "primary" },
      ];
    }
    const approveSpelling = values.find(v => v.toLowerCase() === "approve");
    if (approveSpelling !== undefined) {
      return [
        {
          label: "Approve",
          op: "question.answer",
          params: { id, expect_rev, answer: approveSpelling },
          style: "primary",
        },
      ];
    }
    // Custom options without "approve" — same as single (I-1).
    return optionChoiceActions(id, expect_rev, values, q.recommended);
  }
  if (q.answerType === "single" && q.options && q.options.length > 0) {
    return optionChoiceActions(id, expect_rev, q.options.map(o => o.value), q.recommended);
  }
  return [];
}

/** Detail: question text, asker cue, options/recommended, CLI hint when needed. */
export function runQuestionDetail(q: QuestionRow, actions: Action[]): string {
  const parts: string[] = [clipCodePoints(q.text, 200), `${askerCue(q.askerKind)}.`];
  const opts = optionWords(q);
  if (opts) {
    parts.push(`Options: ${opts.map(o => clipCodePoints(o, OPTION_DETAIL_CLIP, true)).join(" / ")}.`);
  }
  if (q.recommended) parts.push(`Recommended: ${q.recommended}.`);
  // m1: CLI hint when no buttons, or when listed options exceed the buttons shown.
  if (actions.length === 0 || (opts !== null && opts.length > actions.length)) {
    parts.push(`Answer with: pacer answer ${q.id} "<your answer>"`);
  }
  return parts.join(" ");
}

/**
 * Asker task ids whose open person-answerer blocking (step/branch) question raises
 * a `question:q_` item — suppress the ordinary `question:<taskId>` twin (I6 / I-1 / I-4).
 * `blocks:nothing` and `answerer:orchestrator` questions do not suppress.
 * Never creates the workflow schema (ordinary task.ask/answer must stay schema-free).
 */
export function openBlockingPersonQuestionAskerIds(ctx: Ctx): Set<string> {
  try {
    if (!workflowSchemaPresent(ctx)) return new Set();
    const rows = taskDatabase(ctx).query<{ asker_task_id: string | null }, []>(
      `SELECT asker_task_id FROM workflow_questions
       WHERE status = 'open' AND answerer = 'person' AND blocks IN ('step', 'branch')
         AND asker_task_id IS NOT NULL`,
    ).all();
    return new Set(rows.map(r => r.asker_task_id!).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Drop ordinary task.answer attention items for askers covered by openBlockingPersonQuestionAskerIds. */
export function suppressOrdinaryQuestionItems<T extends { kind: string; taskId?: string }>(
  items: T[],
  askers: Set<string>,
): T[] {
  if (askers.size === 0) return items;
  return items.filter(i => !(i.kind === "question" && i.taskId && askers.has(i.taskId)));
}

/** Stable A–Z letter from a run id until Phase 6 assigns fixed letters. */
export function runAttentionLetter(runId: string): string {
  let h = 0;
  for (let i = 0; i < runId.length; i++) h = (h * 31 + runId.charCodeAt(i)) >>> 0;
  return String.fromCharCode(65 + (h % 26));
}

function unblocksFor(blocks: QuestionBlocks): AttentionUnblocks {
  if (blocks === "branch") return "branch";
  if (blocks === "nothing") return "nothing";
  return "run";
}

function questionPayload(q: QuestionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: q.id,
    text: q.text,
    answerType: q.answerType,
    blocks: q.blocks,
    rev: q.rev,
    askerKind: q.askerKind,
  };
  if (q.options) out.options = q.options;
  if (q.recommended) out.recommended = q.recommended;
  if (q.artifact) out.artifact = q.artifact;
  if (q.suggested) out.suggested = q.suggested;
  if (q.askerTaskId) out.askerTaskId = q.askerTaskId;
  if (q.branch) out.branch = q.branch;
  return out;
}

function runQuestionItem(ctx: Ctx, q: QuestionRow, run: RunRow): AttentionItem {
  const unblocks = unblocksFor(q.blocks);
  const at = q.createdAt || ctx.now;
  const actions = runQuestionActions(q);
  return {
    id: `question:${q.id}`,
    kind: "question",
    severity: unblocks === "nothing" ? "decide" : "blocked",
    repo: null,
    title: run.title || run.workflow,
    detail: runQuestionDetail(q, actions),
    raisedAt: at,
    since: at,
    notify: unblocks === "nothing" ? "all" : "important",
    actions,
    unblocks,
    run: {
      id: run.id,
      letter: runAttentionLetter(run.id),
      title: run.title || run.workflow,
      priority: "normal",
    },
    question: questionPayload(q),
  };
}

function attentionClock(ctx: Ctx, run: RunRow, kind = "default"): number {
  const spent = parseSpent(run.spent);
  const byKind = spent.attentionAtByKind?.[kind];
  if (typeof byKind === "number" && byKind > 0) return byKind;
  // Legacy scalar only when no per-kind map exists — never revive a cleared kind
  // via attentionAt while another kind's stamp remains (A-M5).
  if (!spent.attentionAtByKind
    && typeof spent.attentionAt === "number" && spent.attentionAt > 0) {
    return spent.attentionAt;
  }
  // Fall back to the run's last update when blocked/spent was first recorded.
  return run.updatedAt || ctx.now;
}

/**
 * Subject for attention titles: `Workflow "<title>"` when titled, otherwise
 * `A workflow run`. Never quotes the untitled fallback. Clips to the first
 * line, at most 60 code points, with an ellipsis when clipped.
 */
function clipTitleLine(line: string, maxCodePoints = 60): string {
  return clipCodePoints(line, maxCodePoints, true);
}

function workflowSubject(run: RunRow): string {
  const raw = typeof run.title === "string" ? run.title.trim() : "";
  if (!raw) return "A workflow run";
  const firstLine = raw.split(/\r\n|\r|\n/, 1)[0] ?? raw;
  const clipped = clipTitleLine(firstLine);
  return `Workflow "${clipped}"`;
}

function raiseBudgetParams(run: RunRow, which: "orchestrator" | "message"): Record<string, unknown> {
  const budget = parseBudget(run.budget);
  if (which === "message") {
    return {
      id: run.id,
      expect_rev: run.rev,
      message_turns: budget.messageTurns + 20,
    };
  }
  return {
    id: run.id,
    expect_rev: run.rev,
    orchestrator_turns: budget.orchestratorTurns + 20,
  };
}

/** A planner different from the current one so Switch planner is not a no-op. */
export function switchPlannerTarget(
  current: string | undefined,
  planners: readonly string[] = PLANNERS,
): string | null {
  const cur = current ?? "claude-code";
  return planners.find(p => p !== cur) ?? null;
}

function stopRunAction(run: RunRow): Action {
  return {
    label: "Stop run",
    op: "run.stop",
    params: { id: run.id, expect_rev: run.rev },
    style: "danger",
    confirm: "Stop this run?",
  };
}

function raisePlanningAction(run: RunRow): Action {
  return {
    label: "Add 20 planning steps",
    op: "run.set_budget",
    params: raiseBudgetParams(run, "orchestrator"),
    style: "primary",
  };
}

function raiseMessageAction(run: RunRow): Action {
  return {
    label: "Add 20 messages",
    op: "run.set_budget",
    params: raiseBudgetParams(run, "message"),
    style: "primary",
  };
}

function blockedFailureActions(run: RunRow): Action[] {
  const actions: Action[] = [
    { label: "Retry now", op: "run.retry_orchestrator", params: { id: run.id, expect_rev: run.rev } },
  ];
  const target = switchPlannerTarget(run.planner);
  if (target) {
    actions.push({
      label: `Switch to ${agentInfo(target).name}`,
      op: "run.set_planner",
      params: { id: run.id, expect_rev: run.rev, planner: target },
    });
  }
  actions.push(stopRunAction(run));
  return actions;
}

/** Attention items for live runs: blocked orchestrator, budget thresholds, and person questions. */
export function deriveWorkflowAttention(ctx: Ctx): AttentionItem[] {
  const items: AttentionItem[] = [];
  const liveById = new Map(liveRuns(ctx).map(r => [r.id, r]));
  for (const q of listOpenPersonQuestions(ctx)) {
    const run = liveById.get(q.runId) ?? getRun(ctx, q.runId);
    if (!run || (run.status !== "running" && run.status !== "waiting")) continue;
    items.push(runQuestionItem(ctx, q, run));
  }
  for (const run of liveRuns(ctx)) {
    // Child runs share the root's orchestrator/budget attention.
    if (run.parentRunId) continue;
    const budget = parseBudget(run.budget);
    const spent = parseSpent(run.spent);
    const subject = workflowSubject(run);
    if (run.orchestratorState === "blocked") {
      const budgetSpent = isBudgetBlocked(run);
      const unresolved = parseSpent(run.spent).blockedBy === "unresolved"
        || (!budgetSpent && !!run.reason?.includes("unresolved"));
      const kindKey = budgetSpent ? "budget_spent" : unresolved ? "unresolved_wake" : "orchestrator_failed";
      const at = attentionClock(ctx, run, kindKey);
      items.push({
        id: `${kindKey}:${run.id}`,
        kind: budgetSpent ? "question" : "orchestrator_failed",
        severity: budgetSpent ? "decide" : "blocked",
        repo: null,
        title: budgetSpent
          ? `${subject} used its planning budget`
          : unresolved
          ? `${subject} is waiting for a restart`
          : `${subject} stopped`,
        detail: budgetSpent
          ? "Add 20 planning steps."
          : unresolved
          ? "Nothing it did resolved what it was waiting for. Retry now."
          : "The planner failed several times in a row. Retry now.",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: budgetSpent
          ? [raisePlanningAction(run), stopRunAction(run)]
          : blockedFailureActions(run),
      });
      continue;
    }
    if (spent.orchestratorTurns >= budget.orchestratorTurns && budget.orchestratorTurns > 0) {
      const at = attentionClock(ctx, run, "budget_spent");
      items.push({
        id: `budget_spent:${run.id}`,
        kind: "question",
        severity: "decide",
        repo: null,
        title: `${subject} used its planning budget`,
        detail: "Add 20 planning steps.",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: [raisePlanningAction(run), stopRunAction(run)],
      });
    } else if (budget.orchestratorTurns > 0 && spent.orchestratorTurns / budget.orchestratorTurns >= 0.8) {
      const at = attentionClock(ctx, run, "budget_warn");
      items.push({
        id: `budget_warn:${run.id}`,
        // Same kind as the 100% question so view-model attentionStatus is warn, not Out of quota.
        kind: "question",
        severity: "problem",
        repo: null,
        title: `${subject} has used most of its planning budget`,
        detail: `Used ${spent.orchestratorTurns} of ${budget.orchestratorTurns} planning steps.`,
        raisedAt: at,
        since: at,
        notify: "all",
        actions: [raisePlanningAction(run)],
      });
    }
    if (spent.messageTurns >= budget.messageTurns && budget.messageTurns > 0) {
      const at = attentionClock(ctx, run, "budget_msg_spent");
      items.push({
        id: `budget_msg_spent:${run.id}`,
        kind: "question",
        severity: "decide",
        repo: null,
        title: `${subject} used its message budget`,
        detail: "Add 20 messages.",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: [raiseMessageAction(run), stopRunAction(run)],
      });
    } else if (budget.messageTurns > 0 && spent.messageTurns / budget.messageTurns >= 0.8) {
      const at = attentionClock(ctx, run, "budget_msg_warn");
      items.push({
        id: `budget_msg_warn:${run.id}`,
        kind: "question",
        severity: "problem",
        repo: null,
        title: `${subject} has used most of its message budget`,
        detail: `Used ${spent.messageTurns} of ${budget.messageTurns} messages.`,
        raisedAt: at,
        since: at,
        notify: "all",
        actions: [raiseMessageAction(run)],
      });
    }
  }
  return sortItems(items);
}

/** Budget / message attention for a run from the live derive path. */
export function getBudgetAttention(ctx: Ctx, runId: string): AttentionItem | null {
  return deriveWorkflowAttention(ctx).find(i =>
    i.id === `budget_spent:${runId}`
    || i.id === `budget_warn:${runId}`
    || i.id === `budget_msg_spent:${runId}`
    || i.id === `budget_msg_warn:${runId}`,
  ) ?? null;
}

/** Orchestrator-failed / unresolved-wake attention for a run from the live derive path. */
export function getOrchestratorAttention(ctx: Ctx, runId: string): AttentionItem | null {
  return deriveWorkflowAttention(ctx).find(i =>
    i.id === `orchestrator_failed:${runId}` || i.id === `unresolved_wake:${runId}`,
  ) ?? null;
}

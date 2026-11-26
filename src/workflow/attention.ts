// Workflow-run attention derived from live run state (D2.4 / round-2 I3): budget
// exhaustion and orchestrator failures, with actions that include expect_rev and
// concrete run.set_budget / run.set_planner params. since/raisedAt are stable via
// spent.attention_at (no orchestrator-attention.json / budget-attention.json).
// Phase 4 also raises /v3-only items for open person-answerer structured questions (D10).
import type { Ctx } from "../types";
import type { Action, AttentionItem, AttentionUnblocks } from "../attention/types";
import { notifyLevelForRun, runExternalCaller, sortItems } from "../attention/rules";
import { PLANNERS } from "../config/strategy";
import { agentInfo } from "../view-model/agents";
import {
  branchOwner,
  getRun,
  rootRunId,
  listOpenPersonQuestions,
  liveRuns,
  stepsOfRun,
  workflowSchemaPresent,
  type QuestionAskerKind,
  type QuestionBlocks,
  type QuestionRow,
  type RunRow,
} from "./store";
import { readTask, taskDatabase } from "../tasks/store";
import { isBudgetBlocked, parseBudget, parseSpent } from "./budget";
import { resolveRunLetters } from "./letters";
import { canSendBack, fanoutJoined, isHeldBranch, mergeConflictFor, reviewDueTask } from "./review";
import { stepRetriesSpent } from "./retries";
import { hasOpenWakeup, liveTurn, stepWakeRef } from "./wakeups";

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
const QUESTION_TITLE_CLIP = 80;
const FULL_QUESTION_CLIP = 200;
const RUN_DETAIL_CLIP = 80;
const ANSWER_CHAR_LIMIT = 2000;
const OPTION_BUTTON_CAP = 3;

/** Collapse newlines to spaces so title/detail stay one line before clipping. */
export function collapseNewlines(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Shared TS/Rust trim: space, tab, CR, LF, NBSP only (not JS trim's U+FEFF/U+0085).
 * Used after collapseNewlines so CR/LF are already spaces.
 */
export function trimSharedWhitespace(s: string): string {
  return s.replace(/^[\t\n\r \u00A0]+|[\t\n\r \u00A0]+$/g, "");
}

/** One-line question body for title/detail: collapse newlines, then shared trim. */
function collapsedQuestionText(text: string): string {
  return trimSharedWhitespace(collapseNewlines(text));
}

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

/** UI-3: capitalise yes/no button labels; params keep the validator spelling. */
function yesNoButtonLabel(answer: string): string {
  const lower = answer.toLowerCase();
  if (lower === "yes") return "Yes";
  if (lower === "no") return "No";
  return answer;
}

/** Run title for detail, or the workflow slug when untitled (never a run id). */
function runDetailSubject(run: Pick<RunRow, "title" | "workflow">): string {
  const raw = typeof run.title === "string"
    ? trimSharedWhitespace(collapseNewlines(run.title))
    : "";
  return clipCodePoints(raw || run.workflow, RUN_DETAIL_CLIP);
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
  const actions = questionAnswerActions(q);
  // A human step decides what the run does next (publishing included): every
  // one-click answer to it asks first, so no single key or click decides it.
  if (q.askerKind !== "human_step") return actions;
  const asked = clipCodePoints(collapsedQuestionText(q.text), FULL_QUESTION_CLIP, true);
  return actions.map(action => ({ ...action, confirm: `Answer "${String(action.params.answer)}" to: ${asked}` }));
}

function questionAnswerActions(q: QuestionRow): Action[] {
  const id = q.id;
  const expect_rev = q.rev;
  if (q.answerType === "yes_no") {
    const first = q.recommended && ["yes", "no"].includes(q.recommended.toLowerCase())
      ? q.recommended
      : "Yes";
    const second = complementaryYesNo(first);
    return [
      {
        label: yesNoButtonLabel(first),
        op: "question.answer",
        params: { id, expect_rev, answer: first },
        style: "primary",
      },
      {
        label: yesNoButtonLabel(second),
        op: "question.answer",
        params: { id, expect_rev, answer: second },
      },
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

/**
 * Title: the question itself (one line). When longer than 80 code points, clip to
 * 79 and append … so the tray/Dispatch line shows the text was truncated (I-1).
 */
export function runQuestionTitle(q: QuestionRow): string {
  const collapsed = collapsedQuestionText(q.text);
  if (Array.from(collapsed).length <= QUESTION_TITLE_CLIP) return collapsed;
  return clipCodePoints(collapsed, QUESTION_TITLE_CLIP - 1, true);
}

/**
 * Detail: first-button cue (when present), run title/slug, asker cue, Full question
 * when the title was clipped, options / recommended (newlines collapsed, clipped),
 * CLI hint last when needed (UI-1 / I-1 / I-3).
 */
export function runQuestionDetail(
  q: QuestionRow,
  actions: Action[],
  run: Pick<RunRow, "title" | "workflow">,
): string {
  const parts: string[] = [];
  if (actions.length > 0) {
    parts.push(`The first button answers "${actions[0]!.label}".`);
  }
  parts.push(`${runDetailSubject(run)}.`, `${askerCue(q.askerKind)}.`);
  const collapsed = collapsedQuestionText(q.text);
  if (Array.from(collapsed).length > QUESTION_TITLE_CLIP) {
    parts.push(`Full question: ${clipCodePoints(collapsed, FULL_QUESTION_CLIP, true)}.`);
  }
  const opts = optionWords(q);
  if (opts) {
    parts.push(`Options: ${opts.map(o => clipCodePoints(collapseNewlines(o), OPTION_DETAIL_CLIP, true)).join(" / ")}.`);
  }
  if (q.recommended) {
    parts.push(`Recommended: ${clipCodePoints(collapseNewlines(q.recommended), OPTION_DETAIL_CLIP, true)}.`);
  }
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

/** Prefer the stored Phase 6 letter; else the same resolveRunLetters map as the snapshot. */
export function attentionLetterForRun(
  run: { id: string; letter?: string | null; createdAt?: number },
  letters?: Map<string, string>,
): string {
  if (letters?.has(run.id)) return letters.get(run.id)!;
  const stored = typeof run.letter === "string" ? run.letter.trim() : "";
  if (stored) return stored;
  return resolveRunLetters([{
    id: run.id, letter: run.letter, createdAt: run.createdAt ?? 0,
  }]).get(run.id)!;
}

/** Letter for a lone run id via resolveRunLetters (same as snapshot for a single letterless row). */
export function runAttentionLetter(runId: string): string {
  return resolveRunLetters([{ id: runId, createdAt: 0 }]).get(runId)!;
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

function attentionRunRef(run: RunRow, letters?: Map<string, string>) {
  return {
    id: run.id,
    letter: attentionLetterForRun(run, letters),
    title: run.title || run.workflow,
    priority: (run.priority === "urgent" || run.priority === "background" ? run.priority : "normal") as "urgent" | "normal" | "background",
  };
}

function runQuestionItem(ctx: Ctx, q: QuestionRow, run: RunRow, letters?: Map<string, string>): AttentionItem {
  const unblocks = unblocksFor(q.blocks);
  const at = q.createdAt || ctx.now;
  const actions = runQuestionActions(q);
  const waitingOn = runExternalCaller(run);
  return {
    id: `question:${q.id}`,
    kind: "question",
    severity: unblocks === "nothing" ? "decide" : "blocked",
    repo: null,
    title: runQuestionTitle(q),
    detail: runQuestionDetail(q, actions, run),
    raisedAt: at,
    since: at,
    notify: notifyLevelForRun("question", run, ctx.now, { since: at, unblocks }),
    ...(waitingOn ? { waitingOn } : {}),
    actions,
    unblocks,
    run: attentionRunRef(run, letters),
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

/** One item per code step waiting for its verdict: the person can accept (merge
 *  into the run branch) or reject here; the planner is woken for the same. */
function reviewItems(ctx: Ctx, run: RunRow, letters: Map<string, string>): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const step of stepsOfRun(ctx, run.id)) {
    const task = reviewDueTask(ctx, step);
    if (!task) continue;
    const conflict = mergeConflictFor(ctx, run.id, task.id);
    const at = task.settledAt ?? step.startedAt;
    const name = step.branch ? `${step.stepId}/${step.branch}` : step.stepId;
    const root = run.parentRunId ? getRun(ctx, rootRunId(ctx, run.id)) ?? run : run;
    const stuck = !!conflict || root.orchestratorState === "blocked";
    const waitingOn = runExternalCaller(root);
    const verdict = (label: string, value: "accept" | "reject" | "send_back", extra: Partial<Action> & { note?: string } = {}): Action => ({
      label, op: "task.review",
      params: { id: task.id, verdict: value, expect_rev: task.rev, ...(extra.note ? { note: extra.note } : {}) },
      ...(extra.confirm ? { confirm: extra.confirm } : {}),
    });
    const sendable = !!conflict && canSendBack(ctx, task);
    const branch = branchOwner(ctx, run).branch;
    items.push({
      id: `run_review:${task.id}`,
      kind: "review",
      severity: stuck ? "blocked" : "decide",
      repo: null,
      taskId: task.id,
      title: clipCodePoints(
        conflict ? `Merge conflict in step "${name}"` : `Review the changes from step "${name}"`, QUESTION_TITLE_CLIP, true,
      ),
      detail: conflict
        ? `${runDetailSubject(root)}. Accepting hit a merge conflict, so nothing was merged. ${sendable ? "Send it back to resolve it, or merge the run branch in the task's worktree and commit" : "Merge the run branch in the task's worktree and commit"}, then accept.`
        : `${runDetailSubject(root)}. Accepting merges the changes into the run branch and the run continues. Uncommitted work is refused.`,
      gate: conflict
        ? { kind: "step_conflict", recordId: conflict, commands: [`git merge ${branch}`, "git commit", `pacer review ${task.id} --accept`] }
        : { kind: "step_review" },
      raisedAt: at,
      since: at,
      notify: notifyLevelForRun("question", root, ctx.now, { since: at, unblocks: stuck ? "run" : "nothing" }),
      ...(waitingOn ? { waitingOn } : {}),
      actions: [
        ...(sendable
          ? [{ ...verdict("Send back to resolve", "send_back", { note: `Merge ${branch} into your branch, resolve the conflicts and commit.` }), style: "primary" as const }]
          : []),
        {
          ...verdict("Accept", "accept", {
            confirm: conflict ? "Accept now? This merges the task's branch into the run branch." : "Accept and merge these changes into the run branch?",
          }),
          ...(sendable ? {} : { style: "primary" as const }),
        },
        { ...verdict("Reject", "reject", { confirm: "Reject these changes? They are not merged and the step fails." }), style: "danger" },
      ],
      unblocks: "run",
      run: attentionRunRef(root, letters),
    });
  }
  return items;
}

/** A conflict with no step task behind it (base update, adopted branch): the
 *  record names the way to resolve it. */
function branchConflictItems(ctx: Ctx, run: RunRow, letters: Map<string, string>): AttentionItem[] {
  return (run.conflict ?? []).filter(entry => /^(base|child):/.test(entry.taskId)).map(entry => {
    const record = entry.resolutionTaskId;
    const base = entry.taskId.startsWith("base:") ? entry.taskId.slice("base:".length) : null;
    const rev = readTask(ctx, record)?.rev;
    const accept: Action[] = rev === undefined ? [] : [{
      label: "Accept the resolution", op: "task.review", params: { id: record, verdict: "accept", expect_rev: rev },
      confirm: `Accept the merge you committed on pacer/${record}? This merges it into the run branch.`,
    }];
    return {
      id: `run_review:${record}`,
      kind: "review" as const,
      severity: "blocked" as const,
      repo: null,
      taskId: record,
      title: clipCodePoints(base ? `Merge conflict: update from ${base}` : "Merge conflict: sub-workflow changes", QUESTION_TITLE_CLIP, true),
      detail: `${runDetailSubject(run)}. ${base ? `Updating the run branch from ${base} conflicts` : "A sub-workflow's changes conflict with the run branch"}, and publishing waits. ${base ? "Try the update again after the branches change, or resolve" : "Resolve"} it by hand with the commands, run in the repository, then accept.`,
      raisedAt: run.updatedAt,
      since: run.updatedAt,
      notify: notifyLevelForRun("question", run, ctx.now, { since: run.updatedAt, unblocks: "run" }),
      gate: {
        kind: "branch_conflict" as const,
        recordId: record,
        commands: [
          `git worktree add ../resolve-${record} -b pacer/${record} ${run.branch}`,
          `git -C ../resolve-${record} merge ${entry.branch}`,
          `git -C ../resolve-${record} commit`,
          `pacer review ${record} --accept`,
        ],
      },
      actions: base
        ? [{ label: "Try the update again", op: "run.sync_base", params: { id: run.id, expect_rev: run.rev }, style: "primary" as const }, ...accept]
        : accept.map(action => ({ ...action, style: "primary" as const })),
      unblocks: "run" as const,
      run: attentionRunRef(run, letters),
    };
  });
}

/** A generated run whose own branch could not be moved to the run branch. */
function adoptionItems(ctx: Ctx, run: RunRow, letters: Map<string, string>): AttentionItem[] {
  return stepsOfRun(ctx, run.id).flatMap(step => {
    const result = step.result as { childRunId?: unknown; adoptError?: unknown } | undefined;
    if (step.status !== "waiting" || typeof result?.adoptError !== "string") return [];
    const root = run.parentRunId ? getRun(ctx, rootRunId(ctx, run.id)) ?? run : run;
    return [{
      id: `run_review:adopt:${String(result.childRunId)}`,
      kind: "orchestrator_failed" as const,
      severity: "blocked" as const,
      repo: null,
      title: "Code from a sub-workflow cannot reach the run branch",
      detail: `${runDetailSubject(root)}. pacer keeps trying, and the run waits until it works. Open the run to see where it stopped.`,
      raisedAt: step.startedAt,
      since: step.startedAt,
      notify: notifyLevelForRun("question", run, ctx.now, { since: step.startedAt, unblocks: "run" }),
      gate: {
        kind: "adoption" as const,
        technical: `Step ${step.stepId}: ${clipCodePoints(collapseNewlines(result.adoptError), FULL_QUESTION_CLIP, true)}`,
      },
      actions: [
        { label: "Open run", op: "ui.open", params: { view: "run", id: root.id }, style: "primary" as const },
        stopRunAction(run),
      ],
      unblocks: "run" as const,
      run: attentionRunRef(root, letters),
    }];
  });
}

/** One item per failed step that nobody is about to act on: the planner had its turn
 *  and left it, so the person can retry or skip it. A blocked or retrying planner has
 *  its own item (or retries by itself). */
function failedStepItems(ctx: Ctx, run: RunRow, letters: Map<string, string>): AttentionItem[] {
  const root = run.parentRunId ? getRun(ctx, rootRunId(ctx, run.id)) ?? run : run;
  if (root.orchestratorState === "blocked" || root.orchestratorState === "retrying" || liveTurn(ctx, root.id)) return [];
  const rows = stepsOfRun(ctx, run.id);
  return rows.flatMap(row => {
    if (row.status !== "failed") return [];
    if (rows.some(s => s.stepId === row.stepId && s.branch === row.branch && s.attempt > row.attempt)) return [];
    // A fan-out branch is actionable only while its join waits for it.
    if (row.branch !== undefined && (!isHeldBranch(row) || fanoutJoined(rows, row))) return [];
    const ref = stepWakeRef(row.runId, row.stepId, row.attempt, row.branch);
    if ((["step_failed", "step_invalid"] as const)
      .some(cause => hasOpenWakeup(ctx, root.id, cause, ref))) return [];
    const name = row.branch ? `${row.stepId}/${row.branch}` : row.stepId;
    const at = row.endedAt ?? row.startedAt;
    const waitingOn = runExternalCaller(root);
    const params = { id: run.id, step: row.stepId, expect_rev: run.rev };
    const skip: Action = {
      label: "Skip step", op: "step.skip", params, confirm: "Skip this step? The run continues as if it had finished.",
    };
    return [{
      id: `step_failed:${run.id}:${row.stepId}#${row.attempt}${row.branch ? `/${row.branch}` : ""}`,
      kind: "orchestrator_failed" as const,
      severity: "blocked" as const,
      repo: null,
      title: clipCodePoints(`Step "${name}" failed`, QUESTION_TITLE_CLIP, true),
      detail: `${runDetailSubject(root)}. ${clipCodePoints(collapseNewlines(row.error ?? "failed"), RUN_DETAIL_CLIP, true)}. Retry it, or skip it to continue.`,
      raisedAt: at,
      since: at,
      notify: notifyLevelForRun("question", root, ctx.now, { since: at, unblocks: "run" }),
      ...(waitingOn ? { waitingOn } : {}),
      actions: stepRetriesSpent(rows, row)
        ? [skip]
        : [{ label: "Retry step", op: "step.retry", params, style: "primary" as const }, skip],
      unblocks: "run" as const,
      run: attentionRunRef(root, letters),
    }];
  });
}

/** Attention items for live runs: blocked orchestrator, budget thresholds, and person questions. */
export function deriveWorkflowAttention(ctx: Ctx): AttentionItem[] {
  const items: AttentionItem[] = [];
  const live = liveRuns(ctx);
  const letters = resolveRunLetters(live);
  const liveById = new Map(live.map(r => [r.id, r]));
  for (const q of listOpenPersonQuestions(ctx)) {
    const run = liveById.get(q.runId) ?? getRun(ctx, q.runId);
    if (!run || (run.status !== "running" && run.status !== "waiting")) continue;
    items.push(runQuestionItem(ctx, q, run, letters));
  }
  for (const run of live) {
    items.push(
      ...reviewItems(ctx, run, letters), ...branchConflictItems(ctx, run, letters), ...adoptionItems(ctx, run, letters),
      ...failedStepItems(ctx, run, letters),
    );
    // Child runs share the root's orchestrator/budget attention.
    if (run.parentRunId) continue;
    const budget = parseBudget(run.budget);
    const spent = parseSpent(run.spent);
    const subject = workflowSubject(run);
    const waitingOn = runExternalCaller(run);
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
        notify: notifyLevelForRun(kindKey, run, ctx.now, { since: at }),
        ...(waitingOn ? { waitingOn } : {}),
        actions: budgetSpent
          ? [raisePlanningAction(run), stopRunAction(run)]
          : blockedFailureActions(run),
        run: attentionRunRef(run, letters),
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
        notify: notifyLevelForRun("budget_spent", run, ctx.now, { since: at }),
        ...(waitingOn ? { waitingOn } : {}),
        actions: [raisePlanningAction(run), stopRunAction(run)],
        run: attentionRunRef(run, letters),
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
        notify: notifyLevelForRun("budget_warn", run, ctx.now, { since: at }),
        actions: [raisePlanningAction(run)],
        run: attentionRunRef(run, letters),
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
        notify: notifyLevelForRun("budget_msg_spent", run, ctx.now, { since: at }),
        ...(waitingOn ? { waitingOn } : {}),
        actions: [raiseMessageAction(run), stopRunAction(run)],
        run: attentionRunRef(run, letters),
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
        notify: notifyLevelForRun("budget_msg_warn", run, ctx.now, { since: at }),
        actions: [raiseMessageAction(run)],
        run: attentionRunRef(run, letters),
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

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

import { buildRunTree, questionMatchesStep, stepTypeOf, WAITING_FOR_REVIEW, type TreeLine } from "../../view-model/run-tree";
export { buildRunTree, questionMatchesStep, type TreeLine };

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
      label: line.waitsOnYou ? "Waits on you" : line.awaitsReview ? "Waiting for review" : line.status,
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
  const reviewing = tree.some(line => line.awaitsReview);

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
    const timing = line.awaitsReview ? elapsedFor : line.status === "running" ? `running ${elapsedFor}`
      : line.status === "waiting" ? `waiting ${elapsedFor}`
      : "";
    const statusWord = line.waitsOnYou ? "waits on you" : line.awaitsReview ? WAITING_FOR_REVIEW : line.status;
    // The longer review words take room from the timing column, never from themselves.
    const w = flex(ctx.wide ? 52 : ctx.width - MARK, [{ weight: 1, min: 8 }, { fixed: reviewing ? 18 : 12 }, { fixed: reviewing ? 8 : 14 }]);
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

/** Runs list: attention queue of open person-answerable questions, then one line per run. */
import type { AttentionItem } from "../../attention/types";
import {
  displayRunLetter,
  runAge,
  runLettersForList,
  runPriorityLabel,
  runPriorityOf,
  runStatus,
  RUNS_EMPTY,
  RUNS_UNAVAILABLE,
  waitsOnLabel,
} from "../../view-model/runs";
import { cols, flex, span, statusSpans } from "../frame";
import type { Item } from "../state";
import { blank, empty, MARK } from "./common";
import { questionAnswerAct } from "./question-form";
import { runViewScreen } from "./run";
import type { Row, RunQuestion, RunSummary, ScreenCtx, ScreenView } from "./types";

const ANSWER_TYPES = new Set(["single", "multi", "text", "yes_no", "approve_revise"]);

/** Open run questions for the person, ranked like the attention queue (do not invent ranking). */
export function runAttentionQueue(s: { attention?: AttentionItem[] }): AttentionItem[] {
  return (s.attention ?? []).filter(a => a.run && a.kind === "question" && a.question);
}

function waitsOnFor(run: RunSummary, attention: AttentionItem[]): string {
  const hit = attention.find(a => a.run?.id === run.id && a.kind === "question");
  if (hit) return "you";
  if (run.status === "waiting") return "orchestrator";
  return "—";
}

function optionShape(raw: unknown): { value: string; note?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.value !== "string" || !o.value) return undefined;
  return { value: o.value, ...(typeof o.note === "string" ? { note: o.note } : {}) };
}

/** Fail closed: missing/malformed id, rev or answerType → no answer key.
 *  single/multi with no options still return a question so `a` can explain (N6). */
export function questionFromAttention(item: AttentionItem): RunQuestion | undefined {
  const q = item.question;
  if (!q || typeof q.id !== "string" || !q.id) return undefined;
  if (typeof q.rev !== "number" || !Number.isFinite(q.rev)) return undefined;
  if (typeof q.answerType !== "string" || !ANSWER_TYPES.has(q.answerType)) return undefined;
  let options: RunQuestion["options"];
  if (q.options !== undefined) {
    if (!Array.isArray(q.options)) return undefined;
    const parsed = q.options.map(optionShape);
    if (parsed.some(o => !o)) return undefined;
    options = parsed as NonNullable<RunQuestion["options"]>;
  }
  return {
    id: q.id,
    runId: item.run!.id,
    text: typeof q.text === "string" ? q.text : item.title,
    answerType: q.answerType,
    blocks: typeof q.blocks === "string" ? q.blocks : "step",
    status: "open",
    answerer: "person",
    rev: q.rev,
    ...(typeof q.stepId === "string" ? { stepId: q.stepId } : {}),
    ...(typeof q.attempt === "number" && Number.isFinite(q.attempt) ? { attempt: q.attempt } : {}),
    ...(typeof q.branch === "string" && q.branch ? { branch: q.branch } : {}),
    ...(options ? { options } : {}),
    ...(typeof q.recommended === "string" ? { recommended: q.recommended } : {}),
  };
}

function runListItem(ctx: ScreenCtx, run: RunSummary): Item {
  return {
    id: `run:${run.id}`,
    primary: { label: "Open", effect: { type: "run-view", id: run.id } },
    actions: [],
    keys: {},
  };
}

export function runsScreen(ctx: ScreenCtx): ScreenView {
  if (ctx.state.runView) return runViewScreen(ctx, ctx.state.runView);

  const attention = runAttentionQueue(ctx.s);
  const runs = ctx.data.runs?.value ?? [];
  const list: Row[] = [];
  const items: Item[] = [];

  if (ctx.data.runs?.error) {
    // Plain copy + glyph (UI-12 / UI-2): do not surface raw transport messages on the list.
    list.push({ line: statusSpans(ctx.theme, { label: "Couldn't refresh runs", tone: "bad", glyph: "✕" }) });
  }

  for (const item of attention) {
    const q = questionFromAttention(item);
    const answer = q ? questionAnswerAct({ question: q, supports: ctx.supports }) : undefined;
    const open: Item = {
      id: `runq:${item.id}`,
      primary: {
        label: "Open run",
        effect: { type: "run-view", id: item.run!.id },
      },
      actions: answer ? [answer] : [],
      keys: answer ? { a: answer } : {},
    };
    items.push(open);
    const letter = item.run!.letter || displayRunLetter({ id: item.run!.id });
    const w = flex(ctx.width - MARK, [{ fixed: 3 }, { weight: 1, min: 8 }, { fixed: 14 }]);
    list.push({
      item: open.id,
      line: cols([
        { content: letter, width: w[0]!, style: { bold: true, fg: "warn" } },
        { content: item.title, width: w[1]!, style: { bold: true } },
        { content: "Needs you", width: w[2]!, align: "right", style: { fg: "warn" } },
      ], 2, ctx.theme),
    });
  }

  if (attention.length && runs.length) list.push(blank());

  if (!ctx.supports("run.list")) {
    list.push(empty(RUNS_UNAVAILABLE));
    return { list, items, hints: ["6 Runs"] };
  }

  if (!runs.length && !attention.length) {
    list.push(empty(ctx.data.runs?.loading ? "Loading runs…" : RUNS_EMPTY));
    return { list, items, hints: ["6 Runs"] };
  }

  if (ctx.wide && runs.length) {
    const w = flex(ctx.width - MARK, [
      { fixed: 3 }, { weight: 1, min: 8 }, { fixed: 12 }, { fixed: 10 }, { fixed: 12 }, { fixed: 10 }, { fixed: 8 },
    ]);
    list.push({
      line: cols([
        { content: "", width: w[0]! },
        { content: "Run", width: w[1]!, style: { fg: "muted", bold: true } },
        { content: "Workflow", width: w[2]!, style: { fg: "muted", bold: true } },
        { content: "Status", width: w[3]!, style: { fg: "muted", bold: true } },
        { content: "Waits on", width: w[4]!, style: { fg: "muted", bold: true } },
        { content: "Priority", width: w[5]!, style: { fg: "muted", bold: true } },
        { content: "Age", width: w[6]!, align: "right", style: { fg: "muted", bold: true } },
      ], 2, ctx.theme),
    });
  }

  // Phase 6 letters: prefer stored; assign unique fallbacks across this list (not per-id alone).
  const letters = runLettersForList(runs);

  for (const run of runs) {
    const item = runListItem(ctx, run);
    items.push(item);
    const priority = runPriorityOf(run.priority);
    const dim = priority === "background";
    const extra = run as RunSummary & { paused_reason?: unknown; pausedReason?: unknown };
    const paused = run.status === "paused"
      || typeof extra.paused_reason === "string"
      || typeof extra.pausedReason === "string";
    const status = runStatus(paused ? "paused" : run.status);
    const waits = waitsOnLabel(waitsOnFor(run, attention));
    const letter = letters.get(run.id) ?? displayRunLetter(run);
    const age = runAge(run.createdAt, ctx.now);
    const title = run.title || run.workflow;
    const reason = paused
      ? (typeof extra.paused_reason === "string"
        ? extra.paused_reason
        : typeof extra.pausedReason === "string"
          ? extra.pausedReason
          : run.reason)
      : undefined;
    // Attention already listed this run as "Needs you"; keep the run row but mark it.
    const alsoNeedsYou = attention.some(a => a.run?.id === run.id);
    const displayTitle = alsoNeedsYou ? `${title} · also listed above` : title;
    if (ctx.wide) {
      const w = flex(ctx.width - MARK, [
        { fixed: 3 }, { weight: 1, min: 8 }, { fixed: 12 }, { fixed: 10 }, { fixed: 12 }, { fixed: 10 }, { fixed: 8 },
      ]);
      list.push({
        item: item.id,
        line: cols([
          { content: letter, width: w[0]!, style: { bold: true, fg: dim ? "muted" : "ink" } },
          { content: displayTitle, width: w[1]!, style: dim ? { bold: false, fg: "muted" } : { bold: true } },
          { content: run.workflow, width: w[2]!, style: { fg: "muted" } },
          { content: statusSpans(ctx.theme, status), width: w[3]! },
          { content: waits, width: w[4]!, style: { fg: "secondary" } },
          { content: runPriorityLabel(priority), width: w[5]!, style: { fg: dim ? "muted" : "secondary" } },
          { content: age, width: w[6]!, align: "right", style: { fg: "muted" } },
        ], 2, ctx.theme),
      });
      if (reason) {
        list.push({ item: item.id, cont: true, line: [span(`  ${reason}`, { fg: "warn" })] });
      }
    } else {
      const w = flex(ctx.width - MARK, [{ fixed: 3 }, { weight: 1, min: 6 }, { fixed: 10 }]);
      list.push({
        item: item.id,
        line: cols([
          { content: letter, width: w[0]!, style: { bold: true, fg: dim ? "muted" : "ink" } },
          { content: displayTitle, width: w[1]!, style: dim ? { bold: false, fg: "muted" } : { bold: true } },
          { content: statusSpans(ctx.theme, status), width: w[2]! },
        ], 2, ctx.theme),
      });
      list.push({
        item: item.id,
        cont: true,
        line: [span(`  ${run.workflow} · ${waits} · ${runPriorityLabel(priority)} · ${age}${reason ? ` · ${reason}` : ""}`, { fg: "muted" })],
      });
    }
  }

  // List-level Esc does nothing; ⏎ is already the primary — no duplicate hints.
  return { list, items, hints: [] };
}

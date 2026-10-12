import type { ClassifierConfig } from "../config/classifier";
import { KINDS } from "../config/strategy";
import { readLabels } from "../tasks/labels";
import { listTasks } from "../tasks/store";
import type { Ctx } from "../types";
import type { DecisionEntry } from "./types";

type Kind = (typeof KINDS)[number];

export interface TruthIndex {
  taskKind: Record<string, Kind>;
  difficulty: Record<string, { reliable: boolean; executor: string | null }>;
  resultCheck: Record<string, boolean>;
  guard: Record<string, boolean>;
}

function validKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Build benchmark labels from stored outcomes and append-ordered human labels. */
export function buildTruth(ctx: Ctx, entries: readonly DecisionEntry[], cfg: Pick<ClassifierConfig, "tiers"> = { tiers: {} }): TruthIndex {
  const index: TruthIndex = {
    taskKind: Object.create(null), difficulty: Object.create(null),
    resultCheck: Object.create(null), guard: Object.create(null),
  };
  const reviews = new Map<string, Record<string, unknown>>();
  const guards = new Map<string, DecisionEntry>();
  const verdicts = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.decision !== "guard" || !entry.acted_on) continue;
    guards.set(entry.state_hash, entry);
    guards.set(entry.id, entry);
  }

  // Replaying the append-only log makes later labels win, including equal timestamps.
  for (const label of readLabels(ctx)) {
    if (label.type === "task_review" && typeof label.task_id === "string") {
      reviews.set(label.task_id, label);
      continue;
    }
    if (typeof label.event_id !== "string") continue;
    const entry = guards.get(label.event_id);
    const eventId = entry?.state_hash ?? label.event_id;
    if (label.type === "guard_verdict" && typeof label.blocked === "boolean") {
      verdicts.set(eventId, label.blocked);
    } else if (label.type === "guard_override") {
      index.guard[eventId] = false;
    } else if (label.type === "guard_feedback" && typeof label.correct === "boolean") {
      // The guard question's true answer means execution work. Feedback judges
      // the final block/allow, which may differ from the classifier's answer.
      const blocked = verdicts.get(eventId);
      const execution = blocked ?? (typeof entry?.answer?.value === "boolean" ? entry.answer.value : undefined);
      if (execution !== undefined) index.guard[eventId] = label.correct ? execution : !execution;
    }
  }

  // No default list limit: historical tasks remain valid benchmark ground truth.
  for (const task of listTasks(ctx, Infinity)) {
    const review = reviews.get(task.id);
    const kind = validKind(review?.kind) ? review.kind : task.kind;
    if (validKind(kind)) index.taskKind[task.id] = kind;
    if (typeof review?.accepted === "boolean") index.resultCheck[task.id] = review.accepted;
    const result = task.result;
    if (result && result.executor !== null && cfg.tiers[result.executor] === "cheap" && ["done", "partial", "failed"].includes(result.status)) {
      index.difficulty[task.id] = {
        reliable: result.status === "done" && review?.accepted !== false,
        executor: result.executor,
      };
    }
  }
  return index;
}

/** Undefined means unlabelled; boolean false is a valid ground-truth value. */
export function truthFor(index: TruthIndex, entry: DecisionEntry): string | boolean | undefined {
  if (entry.decision === "guard") return index.guard[entry.state_hash];
  if (!entry.task_id) return undefined;
  switch (entry.decision) {
    case "task_kind": return index.taskKind[entry.task_id];
    case "difficulty": return index.difficulty[entry.task_id]?.reliable;
    case "result_check": return index.resultCheck[entry.task_id];
  }
}

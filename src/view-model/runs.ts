/** Shared run vocabulary for the TUI and app (UI-6 / UI-10). Framework-free. */
import type { Status } from "./words";
import { ago } from "./time";
import { resolveRunLetters } from "../workflow/letters";

export type RunPriority = "urgent" | "normal" | "background";
export type RunStatusId = "running" | "waiting" | "done" | "failed" | "stopped" | "paused";

export interface RunLetterSource {
  id: string;
  /** Fixed letter when the service/snapshot already assigned one. */
  letter?: string | null;
}

/** Same lone-run fallback as `runAttentionLetter` / Phase 6 `resolveRunLetters`. */
export function runLetter(runId: string): string {
  return resolveRunLetters([{ id: runId, createdAt: 0 }]).get(runId)!;
}

/** Prefer a stored letter; otherwise the Phase 6 resolveRunLetters fallback. */
export function displayRunLetter(run: RunLetterSource): string {
  const stored = typeof run.letter === "string" ? run.letter.trim() : "";
  if (stored.length >= 1 && /^[A-Za-z]+$/.test(stored)) return stored.toUpperCase();
  return runLetter(run.id);
}

/** Unique letters across a list: stored letters win; letterless rows get the next free A–Z/AA… */
export function runLettersForList<T extends { id: string; letter?: string | null; createdAt?: number }>(
  runs: T[],
): Map<string, string> {
  return resolveRunLetters(runs.map(r => ({
    id: r.id,
    letter: r.letter,
    createdAt: r.createdAt ?? 0,
  })));
}

const runStates: Record<string, Status> = {
  running: { label: "Running", tone: "info", glyph: "▶" },
  waiting: { label: "Waiting", tone: "warn", glyph: "…" },
  done: { label: "Done", tone: "good", glyph: "✓" },
  failed: { label: "Failed", tone: "bad", glyph: "✕" },
  stopped: { label: "Stopped", tone: "neutral", glyph: "■" },
  paused: { label: "Paused", tone: "warn", glyph: "Ⅱ" },
};

export function runStatus(status: string): Status {
  return Object.hasOwn(runStates, status) ? runStates[status]! : { label: status || "Unknown", tone: "neutral", glyph: "?" };
}

const priorities: Record<RunPriority, string> = {
  urgent: "Urgent",
  normal: "Normal",
  background: "Background",
};

export function runPriorityLabel(priority: string | null | undefined): string {
  if (priority === "urgent" || priority === "normal" || priority === "background") return priorities[priority];
  return priorities.normal;
}

export function runPriorityOf(priority: string | null | undefined): RunPriority {
  if (priority === "urgent" || priority === "background") return priority;
  return "normal";
}

/** Next priority when cycling with `P` (urgent → normal → background → urgent). */
export function nextRunPriority(priority: string | null | undefined): RunPriority {
  const order: RunPriority[] = ["urgent", "normal", "background"];
  const current = runPriorityOf(priority);
  return order[(order.indexOf(current) + 1) % order.length]!;
}

/** What the run is waiting on, in plain words (UI-12). */
export function waitsOnLabel(waitsOn: string | null | undefined): string {
  if (!waitsOn || waitsOn === "-") return "—";
  if (waitsOn === "you" || waitsOn === "person") return "You";
  if (waitsOn === "orchestrator" || waitsOn === "planner") return "Orchestrator";
  if (waitsOn === "executors") return "Executors";
  if (waitsOn === "nothing") return "Nothing";
  return waitsOn;
}

/** Why a run is paused, in plain words (UI-12). Unknown codes are never shown raw. */
export function pausedReasonLabel(reason: string | null | undefined): string {
  const labels: Record<string, string> = {
    "pacing: strict": "Paused by strict pacing",
    "pacing: emergency": "Paused by emergency pacing",
    person: "Paused by you",
    budget: "Turn budget spent",
  };
  return reason && Object.hasOwn(labels, reason) ? labels[reason]! : "Reason not available";
}

/**
 * First line of the run view: the orchestrator block.
 * Example: `planner at limit until 18:00`.
 */
export function orchestratorBlock(
  orch: { state?: string; planner?: string; reason?: string; next_wake_at?: number } | null | undefined,
  now: number,
  timeZone?: string,
): string {
  if (!orch) return "Orchestrator idle";
  const reason = typeof orch.reason === "string" ? orch.reason.trim() : "";
  if (reason) {
    if (/planner at limit/i.test(reason) && typeof orch.next_wake_at === "number" && orch.next_wake_at > 0) {
      const until = new Date(orch.next_wake_at * 1000).toLocaleTimeString("en-GB", {
        timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
      });
      return `planner at limit until ${until}`;
    }
    return reason;
  }
  if (orch.state === "turn") return "Orchestrator working";
  if (orch.state === "retrying") return "Orchestrator retrying";
  if (orch.state === "blocked") return "Orchestrator blocked";
  if (typeof orch.next_wake_at === "number" && orch.next_wake_at > now) {
    const until = new Date(orch.next_wake_at * 1000).toLocaleTimeString("en-GB", {
      timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    });
    return `Next wake ${until}`;
  }
  return "Orchestrator idle";
}

/** Step markers for the run tree (design Phase 8). */
export type StepMarker = "running" | "done" | "failed" | "waits_you" | "waits_others" | "stopped" | "unknown";

export function stepMarkerGlyph(marker: StepMarker, unicode = true): string {
  // Match runStatus glyphs (▶ / ✕ / ✓ / ■) so list and tree share one vocabulary (N4).
  const fancy: Record<StepMarker, string> = {
    running: "▶",
    done: "✓",
    failed: "✕",
    waits_you: "?",
    waits_others: "…",
    stopped: "■",
    unknown: "·",
  };
  const plain: Record<StepMarker, string> = {
    running: ">",
    done: "+",
    failed: "x",
    waits_you: "?",
    waits_others: "o",
    stopped: "#",
    unknown: ".",
  };
  return (unicode ? fancy : plain)[marker];
}

/** Human labels for question answerType / status (UI-12). */
export function answerTypeLabel(answerType: string): string {
  const labels: Record<string, string> = {
    single: "Single choice",
    multi: "Multiple choice",
    text: "Text",
    yes_no: "Yes / No",
    approve_revise: "Approve or revise",
  };
  return labels[answerType] ?? answerType;
}

export function questionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    open: "Open",
    answered: "Answered",
    dismissed: "Dismissed",
    expired: "Expired",
  };
  return labels[status] ?? status;
}

export function stepMarkerFor(input: {
  status: string;
  waitsOnYou?: boolean;
}): StepMarker {
  if (input.waitsOnYou) return "waits_you";
  if (input.status === "running") return "running";
  if (input.status === "done") return "done";
  if (input.status === "failed") return "failed";
  if (input.status === "stopped") return "stopped";
  if (input.status === "waiting") return "waits_others";
  return "unknown";
}

/** Relative age for a run row. Unknown/zero createdAt renders an em dash (not epoch "Nd ago"). */
export function runAge(createdAt: number, now: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return "—";
  return ago(createdAt, now);
}

/** Empty list copy (design Phase 8). */
export const RUNS_EMPTY = "No runs yet. Start one with `pacer run start`.";
/** Runs tab when the service does not offer `run.list`. */
export const RUNS_UNAVAILABLE = "Runs unavailable.";

export const CONFLICT_QUESTION = "This question changed; review it again.";

/** Plain failure and placeholder copy for the web Runs page and question form (UI-12). */
export const RUNS_UNAVAILABLE_DETAIL = "Update pacer to see runs here.";
export const RUNS_REFRESH_ERROR = "The list may be out of date. Reload the page to try again.";
export const RUN_DETAIL_ERROR = "Couldn't load this run's details.";
export const RUN_QUESTIONS_ERROR = "Couldn't load this run's questions.";
export const RUN_SEEN_ERROR = "Couldn't mark this run as seen.";
export const RUN_MESSAGES_ERROR = "Couldn't load the latest messages.";
export const RUN_MESSAGE_SEND_ERROR = "Couldn't send your message. It is still in the box; try again.";
export const RUN_ARTIFACT_ERROR = "The file could not be read.";
export const QUESTION_SUBMIT_ERROR = "Couldn't submit your answer. Try again.";
export const QUESTION_NO_OPTIONS = "This question has no options, so it can't be answered here. Answer it from a terminal with pacer.";
export const QUESTION_ANSWER_TOO_LONG = "These choices are too long to send together. Choose fewer.";

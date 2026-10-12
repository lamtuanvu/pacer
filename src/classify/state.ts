import { createHash } from "node:crypto";
import type { TaskRecord, TaskResult } from "../tasks/types";
import type { GuardInput } from "./hooks";
import type { DecisionName, Question } from "./types";

export const KIND_CRITERIA = {
  boilerplate: "Routine scaffolding or repetitive code",
  tests: "Writing or updating tests",
  docs: "Writing or updating documentation",
  rename: "Renaming symbols or files",
  migration: "Migrating data, APIs or dependencies",
  feature: "Adding or extending functionality",
  debug: "Investigating and fixing a bug",
  refactor: "Restructuring code while preserving behavior",
  performance: "Improving speed or resource usage",
  "unfamiliar-code": "Working in unfamiliar code requiring substantial exploration",
  research: "Read-only investigation or research",
  default: "None of the above, or unclear",
};

export const QUESTIONS: Record<DecisionName, Question> = {
  task_kind: { type: "choice", id: "task_kind", instructions: "Which kind of task is this?", criteria: KIND_CRITERIA },
  difficulty: { type: "score", id: "difficulty", instructions: "Can a mid-tier coding model complete this reliably? 1 = certainly", min: 0, max: 1 },
  guard: { type: "yesno", id: "guard", instructions: "Is this execution work (writing/changing code, running builds) rather than design, review or read-only research?" },
  result_check: { type: "yesno", id: "result_check", instructions: "Does this result satisfy the brief?" },
};

export function taskKindState(task: TaskRecord): string {
  return JSON.stringify({
    goal: task.brief.goal,
    scope: task.brief.scope,
    context: task.brief.context?.slice(0, 4000),
    constraints: task.brief.constraints,
    planner_kind: task.kind,
  });
}

export function difficultyState(task: TaskRecord, kind: string | null, repoFiles: number | null): string {
  return JSON.stringify({
    ...parseState(taskKindState(task)),
    kind,
    has_acceptance: Boolean(task.brief.acceptance),
    repo_files: repoFiles,
  });
}

export function guardState(input: GuardInput): string {
  return JSON.stringify({ subagent_type: input.subagentType, prompt: input.prompt.slice(0, 4000), model: input.model });
}

export function resultCheckState(task: TaskRecord, result: TaskResult): string {
  return JSON.stringify({
    goal: task.brief.goal,
    scope: task.brief.scope,
    status: result.status,
    report: result.report.slice(0, 2000),
    files: result.files.slice(0, 2000),
    acceptance: result.acceptance && {
      cmd: result.acceptance.cmd,
      passed: result.acceptance.passed,
      tail: result.acceptance.tail.slice(0, 1000),
    },
  });
}

export function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex").slice(0, 16);
}

export function guardEventId(input: GuardInput): string {
  return stateHash(guardState(input));
}

export function parseState(state: string): Record<string, unknown> {
  return JSON.parse(state);
}

export function withoutPlannerKind(state: string): string {
  const parsed = parseState(state);
  delete parsed.planner_kind;
  return JSON.stringify(parsed);
}

export function redactState(state: string, home: string): string {
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      const text = home ? value.split(home).join("~") : value;
      return text.length > 200 ? text.slice(0, 200) + "..." : text;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    }
    return value;
  };
  return JSON.stringify(redact(JSON.parse(state)));
}

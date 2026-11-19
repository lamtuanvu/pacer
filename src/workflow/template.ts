// Prompt templating for agent steps: `{{brief}}`, `{{branch}}` and
// `{{steps.<id>.result.<path>}}` are substituted (objects render as JSON, missing
// values as empty strings), and the standard step-result instruction is always
// appended so every agent knows how to report its result.

export function STEP_RESULT_INSTRUCTION(runId: string, stepId: string): string {
  return `When you finish, report your result with: pacer step result --json '<JSON object>'. This step is ${stepId} of run ${runId}. Report once, before you stop.`;
}

export type RenderScope = {
  brief: string;
  steps: Record<string, { result?: unknown }>;
  branch?: string;
  run: { id: string; stepId: string };
};

/** Walks `steps.<id>.result.<path…>` (numeric segments index arrays) and the two
 * scalar roots. Anything unknown resolves to undefined, which renders as empty. */
function lookup(expr: string, scope: RenderScope): unknown {
  const segments = expr.trim().split(".");
  if (segments[0] === "brief") return segments.length === 1 ? scope.brief : undefined;
  if (segments[0] === "branch") return segments.length === 1 ? scope.branch : undefined;
  if (segments[0] !== "steps" || segments.length < 2) return undefined;
  const step = scope.steps[segments[1]];
  if (!step) return undefined;
  let current: unknown = step.result;
  for (const segment of segments.slice(3)) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function render(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function renderPrompt(tpl: string, scope: RenderScope): string {
  const body = tpl.replace(/\{\{([^{}]*)\}\}/g, (_match, expr: string) => render(lookup(expr, scope)));
  const text = body.replace(/\s+$/, "");
  return text ? `${text}\n\n${STEP_RESULT_INSTRUCTION(scope.run.id, scope.run.stepId)}` : STEP_RESULT_INSTRUCTION(scope.run.id, scope.run.stepId);
}

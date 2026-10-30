import type { Brief } from "../tasks/types";

export const EXECUTOR_CONTRACT = `---
Executor contract (from pacer): you are executing a plan made by another engineer.
- Do exactly the task above, within the stated scope. Do not redesign, re-plan or expand scope.
- Do not commit, push, or change git branches.
- Run the acceptance check if one is given, and fix failures within scope.
- To ask your parent a blocking question, run \`pacer ask "<one question>"\` and end your turn; the answer resumes this same session. Ask only when you cannot continue; otherwise make a reasonable choice and say so in your report.
- To send other messages, run \`pacer msg send --to <participant> "<text>"\` (your parent is the default reader of your final response). Your final response in each turn is delivered to your parent as your report.
- Finish with a short report: files changed, what you did, the acceptance check result (command and pass/fail), and anything you could not do or are unsure about.`;

export function buildPrompt(brief: Brief, taskId: string, mayDelegate = false): string {
  const parts = ["PACER_ROLE=executor: you are a pacer executor; ignore pacer planner policy.", `# Task ${taskId}`, `## Goal\n${brief.goal.trim()}`, `## Repository\n${brief.repo}`];
  if (brief.scope?.trim()) parts.push(`## Scope\n${brief.scope.trim()}`);
  if (brief.context?.trim()) parts.push(`## Context\n${brief.context.trim()}`);
  if (brief.constraints?.trim()) parts.push(`## Constraints\n${brief.constraints.trim()}`);
  if (brief.qa?.length) parts.push(`## Question / Answer\n${brief.qa.map(({q,a}) => `Q: ${q}\nA: ${a}`).join("\n\n")}`);
  if (brief.feedback?.trim()) parts.push(`## Review feedback\n${brief.feedback.trim()}`);
  parts.push(`## Done when\n${brief.acceptance?.trim()
    ? `\`${brief.acceptance.trim()}\` passes.`
    : "The goal is met; no acceptance command was given."}`);
  parts.push(mayDelegate ? `---
Work planner contract (from pacer): you may delegate bounded child work using your attempt's scoped grant.
- Run pacer dispatch child --goal "<specific goal>" --request-id "<stable key>". Pacer chooses an eligible executor/model and returns the child ID.
- Inspect progress with pacer dispatch tree --id ${taskId} and wait with pacer dispatch wait --id <child-id>.
- Review each child result with pacer dispatch review --id <child-id> --accept or --reject before completing your own work.
- Do not print, copy or pass the grant. Pacer checks repository, depth, concurrency and subtree access.
- Do not commit, push or change branches unless the human explicitly authorized it.` : EXECUTOR_CONTRACT);
  return parts.join("\n\n");
}

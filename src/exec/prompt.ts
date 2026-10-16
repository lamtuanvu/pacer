import type { Brief } from "../tasks/types";

export const EXECUTOR_CONTRACT = `---
Executor contract (from pacer): you are executing a plan made by another engineer.
- Do exactly the task above, within the stated scope. Do not redesign, re-plan or expand scope.
- Do not commit, push, or change git branches.
- Run the acceptance check if one is given, and fix failures within scope.
- If you cannot continue without a decision from the user, run pacer ask "<one question>" once, then stop. Ask only when you cannot continue; otherwise make a reasonable choice and say so in your report.
- Finish with a short report: files changed, what you did, the acceptance check result (command and pass/fail), and anything you could not do or are unsure about.`;

export function buildPrompt(brief: Brief, taskId: string): string {
  const parts = ["PACER_ROLE=executor: you are a pacer executor; ignore pacer planner policy.", `# Task ${taskId}`, `## Goal\n${brief.goal.trim()}`, `## Repository\n${brief.repo}`];
  if (brief.scope?.trim()) parts.push(`## Scope\n${brief.scope.trim()}`);
  if (brief.context?.trim()) parts.push(`## Context\n${brief.context.trim()}`);
  if (brief.constraints?.trim()) parts.push(`## Constraints\n${brief.constraints.trim()}`);
  if (brief.feedback?.trim()) parts.push(`## Review feedback\n${brief.feedback.trim()}`);
  parts.push(`## Done when\n${brief.acceptance?.trim()
    ? `\`${brief.acceptance.trim()}\` passes.`
    : "The goal is met; no acceptance command was given."}`);
  parts.push(EXECUTOR_CONTRACT);
  return parts.join("\n\n");
}

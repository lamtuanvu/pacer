import { expect, test } from "bun:test";
import { renderPrompt, STEP_RESULT_INSTRUCTION } from "../src/workflow/template";

const scope = {
  brief: "Build the thing",
  steps: { draft: { result: { ok: true, items: ["a", "b"], note: "done" } }, empty: {} },
  branch: "lane-a",
  run: { id: "run_abcdefghij", stepId: "draft" },
};

test("substitutes brief, branch and step result paths", () => {
  const out = renderPrompt("Brief: {{brief}} / lane: {{branch}} / ok: {{steps.draft.result.ok}} / first: {{steps.draft.result.items.0}}", scope);
  expect(out).toContain("Brief: Build the thing / lane: lane-a / ok: true / first: a");
});

test("a missing value renders as an empty string", () => {
  const out = renderPrompt("a={{steps.nope.result.x}} b={{steps.empty.result}} c={{steps.draft.result.missing.deep}} d={{unknown}} e={{brief.sub}}", scope);
  expect(out).toContain("a= b= c= d= e=");
});

test("objects render as JSON", () => {
  expect(renderPrompt("{{steps.draft.result}}", scope)).toContain('{"ok":true,"items":["a","b"],"note":"done"}');
  expect(renderPrompt("{{steps.draft.result.items}}", scope)).toContain('["a","b"]');
});

test("appends the step result instruction exactly", () => {
  const instruction = STEP_RESULT_INSTRUCTION("run_abcdefghij", "draft");
  expect(instruction).toBe("When you finish, report your result with: pacer step result --json '<JSON object>'. This step is draft of run run_abcdefghij. Report once, before you stop.");
  const out = renderPrompt("Do the work", scope);
  expect(out).toContain(instruction);
  expect(out.endsWith(instruction)).toBe(true);
  expect(out).toMatch(/^Do the work\n\n/);
});

test("an empty template is just the instruction", () => {
  expect(renderPrompt("", scope)).toBe(STEP_RESULT_INSTRUCTION("run_abcdefghij", "draft"));
});

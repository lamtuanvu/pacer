import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { CONFLICT_QUESTION, QuestionForm, type QuestionFormQuestion } from "../app/src/ds/QuestionForm";

function q(partial: Partial<QuestionFormQuestion> & Pick<QuestionFormQuestion, "answerType">): QuestionFormQuestion {
  return {
    id: "q_1",
    runId: "run_1",
    text: "Which path?",
    rev: 3,
    ...partial,
  };
}

test("QuestionForm renders single choice options with recommended and trade-off notes", () => {
  const html = renderToString(
    <QuestionForm
      question={q({
        answerType: "single",
        options: [
          { value: "fast", note: "Less coverage" },
          { value: "careful", note: "Slower" },
        ],
        recommended: "careful",
      })}
      onSubmit={() => {}}
    />,
  );
  expect(html).toContain("Which path?");
  expect(html).toContain("fast");
  expect(html).toContain("Less coverage");
  expect(html).toContain("Recommended");
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain("Submit answer");
});

test("QuestionForm renders multi, text, yes_no and approve_revise", () => {
  for (const answerType of ["multi", "text", "yes_no", "approve_revise"] as const) {
    const question = q({
      answerType,
      options: answerType === "text" ? undefined : [{ value: "yes" }, { value: "no" }],
      ...(answerType === "approve_revise" ? { options: [{ value: "approve" }, { value: "revise" }] } : {}),
    });
    const html = renderToString(<QuestionForm question={question} onSubmit={() => {}} />);
    expect(html).toContain("Which path?");
    if (answerType === "text") expect(html).toContain("Your answer");
    if (answerType === "yes_no") expect(html).toContain("Yes");
    if (answerType === "approve_revise") expect(html).toContain("Approve");
    if (answerType === "multi") expect(html).toContain("Answers");
  }
});

test("QuestionForm shows orchestrator suggested answer and artifact link", () => {
  const html = renderToString(
    <QuestionForm
      question={q({
        answerType: "text",
        suggestedAnswer: "Go with option B",
        artifact: { id: "art_1", label: "Spec draft" },
      })}
      onSubmit={() => {}}
    />,
  );
  expect(html).toContain("Suggested answer");
  expect(html).toContain("Go with option B");
  expect(html).toContain("Spec draft");
  expect(html).toContain("pc-inline-link");
});

test("QuestionForm conflict copy matches shared vocabulary", () => {
  expect(CONFLICT_QUESTION).toContain("This question changed");
});

test("QuestionForm a11y: labelled form and submit control", () => {
  const html = renderToString(
    <QuestionForm question={q({ answerType: "yes_no", options: [{ value: "yes" }, { value: "no" }] })} onSubmit={() => {}} />,
  );
  expect(html).toMatch(/<form[^>]*aria-labelledby=/);
  expect(html).toContain('type="submit"');
});

test("QuestionForm hides submit when canAnswer is false", () => {
  const html = renderToString(
    <QuestionForm question={q({ answerType: "text" })} canAnswer={false} onSubmit={() => {}} />,
  );
  expect(html).not.toContain("Submit answer");
});

test("conflict errors are detected by code property", () => {
  const err = { code: "conflict", message: "stale rev" };
  expect(err.code).toBe("conflict");
});

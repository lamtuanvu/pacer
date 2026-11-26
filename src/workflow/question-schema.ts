// Zod bounds for structured workflow questions (Phase 4).
import { z } from "zod";
import { CoreError } from "../core/errors";

export const questionOptionSchema = z.strictObject({
  value: z.string().min(1),
  note: z.string().max(500).optional(),
});

export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const questionAnswerTypeSchema = z.enum([
  "single",
  "multi",
  "text",
  "yes_no",
  "approve_revise",
]);

export type QuestionAnswerType = z.infer<typeof questionAnswerTypeSchema>;

export const questionBlocksSchema = z.enum(["step", "branch", "nothing"]);

export type QuestionBlocks = z.infer<typeof questionBlocksSchema>;

export const questionInputSchema = z.strictObject({
  // Aligned with core task.ask (1–1000); structured asks share the same bound.
  text: z.string().min(1).max(1000),
  answerType: questionAnswerTypeSchema,
  options: z.array(questionOptionSchema).max(12).optional(),
  recommended: z.string().min(1).optional(),
  blocks: questionBlocksSchema,
  artifact: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.recommended !== undefined) {
    const values = (value.options ?? []).map(o => o.value);
    if (!values.includes(value.recommended)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommended"],
        message: "recommended must be one of the option values",
      });
    }
  }
  if ((value.answerType === "single" || value.answerType === "multi" || value.answerType === "approve_revise")
    && (value.options === undefined || value.options.length < 1)) {
    ctx.addIssue({
      code: "custom",
      path: ["options"],
      message: `${value.answerType} questions need at least one option`,
    });
  }
});

export type QuestionInput = z.infer<typeof questionInputSchema>;

/** Answer payload bounds: answer ≤ 2000 (core task.answer); note ≤ 4000. */
export const NOTE_MAX = 4000;
export const NOTE_TOO_LONG = "note must be at most 4000 characters";

/** Strip C0/C1 controls (keep tab/LF/CR) so notes stay text, not terminal noise. */
export function sanitizeAnswerNote(note: string): string {
  return note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

export const answerNoteSchema = z.string().max(NOTE_MAX, NOTE_TOO_LONG);

/** Answer payload bounds: answer ≤ 2000 (core task.answer); note ≤ 4000. */
export const questionAnswerInputSchema = z.strictObject({
  answer: z.string().min(1).max(2000),
  note: answerNoteSchema.optional(),
  expectRev: z.number().int(),
});

/** Validate answer text against the question's answerType / options. */
export function validateQuestionAnswer(
  answerType: QuestionAnswerType,
  answer: string,
  options?: Array<{ value: string }>,
): void {
  const values = (options ?? []).map(o => o.value);
  switch (answerType) {
    case "yes_no": {
      const normalized = answer.trim().toLowerCase();
      if (normalized !== "yes" && normalized !== "no") {
        throw new CoreError("invalid_input", "yes_no answers must be yes or no");
      }
      return;
    }
    case "single":
    case "approve_revise":
      if (values.length > 0 && !values.includes(answer)) {
        throw new CoreError("invalid_input", `answer must be one of: ${values.join(", ")}`);
      }
      return;
    case "multi": {
      const parts = answer.split(",").map(s => s.trim()).filter(Boolean);
      if (values.length > 0 && parts.some(p => !values.includes(p))) {
        throw new CoreError("invalid_input", `each multi answer must be one of: ${values.join(", ")}`);
      }
      return;
    }
    case "text":
      return;
  }
}

export type QuestionAnswerInput = z.infer<typeof questionAnswerInputSchema>;

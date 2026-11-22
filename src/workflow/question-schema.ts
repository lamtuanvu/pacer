// Zod bounds for structured workflow questions (Phase 4).
import { z } from "zod";

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
  text: z.string().min(1).max(4000),
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

/** Answer payload bounds: approve_revise may carry a note ≤ 4000. */
export const questionAnswerInputSchema = z.strictObject({
  answer: z.string().min(1),
  note: z.string().max(4000).optional(),
  expectRev: z.number().int(),
});

export type QuestionAnswerInput = z.infer<typeof questionAnswerInputSchema>;

/** Multi-answer encoding and client-side answer bounds (shared by form + overlay). */

/** Service `validateQuestionAnswer` splits multi answers on this separator (no escaping). */
export const MULTI_ANSWER_SEP = ",";

/** Cap aligned with `questionAnswerInputSchema` / `question.answer`. */
export const QUESTION_ANSWER_MAX = 2000;
export const QUESTION_NOTE_MAX = 4000;
/** Cap aligned with `run.answer` params. */
export const RUN_ANSWER_MAX = 4000;
/** Cap aligned with `msg.send` body (`z.string().max(1 << 20)`). */
export const MSG_BODY_MAX = 1 << 20;

/** Option values the service would trim then reject as mismatches. */
export function optionValueRejected(value: string): string | undefined {
  if (value.includes(MULTI_ANSWER_SEP)) {
    return `Option values cannot contain "${MULTI_ANSWER_SEP}".`;
  }
  if (value !== value.trim()) {
    return "Option values cannot have leading or trailing whitespace.";
  }
  return undefined;
}

/**
 * Encode multi-select picks the way the service decodes them: comma-separated,
 * in definition/option order (not toggle order). Options that contain the
 * separator or leading/trailing whitespace cannot round-trip — refuse them.
 */
export function encodeMultiAnswer(options: Array<{ value: string }>, selected: string[]): string {
  for (const value of selected) {
    const reason = optionValueRejected(value);
    if (reason) throw new Error(reason);
  }
  const selectedSet = new Set(selected);
  return options.map(o => o.value).filter(v => selectedSet.has(v)).join(MULTI_ANSWER_SEP);
}

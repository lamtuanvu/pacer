/** Structured question answer forms for the Runs screen (Phase 8 / Phase 4 types). */
import type { Act, AnswerFormSpec, Effect } from "../state";
import type { RunQuestion } from "./types";
import { CONFLICT_QUESTION } from "../../view-model/runs";
import { encodeMultiAnswer, RUN_ANSWER_MAX } from "./answer-encoding";

export { CONFLICT_QUESTION };
export {
  encodeMultiAnswer,
  MSG_BODY_MAX,
  MULTI_ANSWER_SEP,
  optionValueRejected,
  QUESTION_ANSWER_MAX,
  QUESTION_NOTE_MAX,
  RUN_ANSWER_MAX,
} from "./answer-encoding";

function answerEffect(q: RunQuestion, answer: string, note?: string): Effect {
  return {
    type: "action",
    action: {
      label: "Answer recorded",
      op: "question.answer",
      params: {
        id: q.id,
        answer,
        expect_rev: q.rev,
        ...(note !== undefined && note !== "" ? { note } : {}),
      },
    },
  };
}

export function formSpecForQuestion(q: RunQuestion): AnswerFormSpec {
  const recommended = q.recommended;
  const mode = (["yes_no", "single", "multi", "text", "approve_revise"] as const)
    .includes(q.answerType as AnswerFormSpec["mode"])
    ? q.answerType as AnswerFormSpec["mode"]
    : "text";
  if (mode === "yes_no") {
    return {
      title: q.text,
      mode,
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      ...(recommended ? { recommended } : {}),
      submit: (answer) => answerEffect(q, answer),
    };
  }
  if (mode === "approve_revise") {
    const values = q.options?.length ? q.options : [{ value: "approve" }, { value: "revise" }];
    return {
      title: q.text,
      mode,
      options: values.map(o => ({
        value: o.value,
        label: o.value.toLowerCase() === "approve" ? "Approve" : o.value.toLowerCase() === "revise" ? "Revise" : o.value,
        ...(o.note ? { note: o.note } : {}),
      })),
      ...(recommended ? { recommended } : {}),
      submit: (answer, note) => answerEffect(q, answer, note),
    };
  }
  if (mode === "single" || mode === "multi") {
    return {
      title: q.text,
      mode,
      options: (q.options ?? []).map(o => ({
        value: o.value,
        label: o.value,
        ...(o.note ? { note: o.note } : {}),
      })),
      ...(recommended ? { recommended } : {}),
      submit: (answer) => answerEffect(q, answer),
    };
  }
  return {
    title: q.text,
    mode: "text",
    options: [],
    ...(recommended ? { recommended } : {}),
    submit: (answer) => answerEffect(q, answer),
  };
}

/** Empty single/multi copy matches Review's CLI shape: id + quoted answer placeholder. */
export function emptyOptionsHint(questionId: string): string {
  return `This question has no options; answer it with pacer answer ${questionId} "<your answer>"`;
}

/** Build the `a` answer act for a structured run question, or a human step via `run.answer`. */
export function questionAnswerAct(input: {
  question?: RunQuestion;
  humanStep?: { runId: string; stepId: string; expectRev: number };
  supports: (op: string) => boolean;
}): Act | undefined {
  const { question, humanStep, supports } = input;
  if (question) {
    if (!supports("question.answer")) return undefined;
    if ((question.answerType === "single" || question.answerType === "multi")
      && !(question.options && question.options.length)) {
      // Offer `a` with a visible explanation instead of silently omitting the key.
      return {
        label: "Answer",
        effect: {
          type: "answer-form",
          form: {
            title: question.text,
            mode: question.answerType as "single" | "multi",
            options: [],
            emptyHint: emptyOptionsHint(question.id),
            submit: () => ({ type: "navigate", screen: "runs" }),
          },
        },
      };
    }
    return { label: "Answer", effect: { type: "answer-form", form: formSpecForQuestion(question) } };
  }
  if (humanStep && supports("run.answer")) {
    return {
      label: "Answer",
      effect: {
        type: "prompt",
        prompt: {
          title: "Answer this step",
          label: "Your answer",
          required: "Add an answer first.",
          maxLength: RUN_ANSWER_MAX,
          submit: value => ({
            type: "action",
            action: {
              label: "Answer recorded",
              op: "run.answer",
              params: { id: humanStep.runId, step: humanStep.stepId, answer: value, expect_rev: humanStep.expectRev },
            },
          }),
        },
      },
    };
  }
  return undefined;
}

/** Multi-select toggle helper (space); used by tests and the answer overlay. */
export function toggleMultiSelection(selected: string[], value: string): string[] {
  return selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value];
}

export function multiAnswerPayload(q: RunQuestion, selected: string[]): Record<string, unknown> {
  return { id: q.id, answer: encodeMultiAnswer(q.options ?? [], selected), expect_rev: q.rev };
}

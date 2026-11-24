/** One structured-question form for queue, run view and Live board (Phase 9a). */
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { CONFLICT_QUESTION } from "../../../src/view-model/runs";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Checkbox, Field, TextArea, TextInput } from "./Controls";
import { RadioChoices } from "./Patterns";
import { Pill } from "./Pill";

export { CONFLICT_QUESTION };

/** Cap aligned with `question.answer` / dashboard answer-encoding (UI-20: keep local). */
export const QUESTION_ANSWER_MAX = 2000;
export const QUESTION_NOTE_MAX = 4000;
const MULTI_ANSWER_SEP = ",";

/** Encode multi picks the way the service decodes them: option order, comma-separated. */
export function encodeMultiAnswer(options: Array<{ value: string }>, selected: string[]): string {
  const selectedSet = new Set(selected);
  return options.map(o => o.value).filter(v => selectedSet.has(v)).join(MULTI_ANSWER_SEP);
}

export type QuestionAnswerType = "single" | "multi" | "text" | "yes_no" | "approve_revise";

export interface QuestionFormQuestion {
  id: string;
  runId: string;
  text: string;
  answerType: QuestionAnswerType;
  rev: number;
  options?: { value: string; note?: string }[];
  recommended?: string;
  artifact?: { id: string; label?: string };
  suggestedAnswer?: string;
}

export interface QuestionFormProps {
  question: QuestionFormQuestion;
  /** When false, submit is omitted (ops catalog gate). */
  canAnswer?: boolean;
  busy?: boolean;
  /** After Reload remounts the form, parent sets this so focus moves to the question title. */
  focusTitle?: boolean;
  onSubmit: (input: { answer: string; note?: string; expect_rev: number }) => Promise<void> | void;
  /** Reload after conflict: parent refetches; form resets when question.id/rev change. */
  onConflict?: () => void;
}

function optionLabel(value: string, answerType: QuestionAnswerType): string {
  if (answerType === "yes_no") {
    if (value.toLowerCase() === "yes") return "Yes";
    if (value.toLowerCase() === "no") return "No";
  }
  if (answerType === "approve_revise") {
    if (value.toLowerCase() === "approve") return "Approve";
    if (value.toLowerCase() === "revise") return "Revise";
  }
  return value;
}

function defaultOptions(question: QuestionFormQuestion): { value: string; note?: string }[] {
  if (question.options?.length) return question.options;
  if (question.answerType === "yes_no") return [{ value: "yes" }, { value: "no" }];
  if (question.answerType === "approve_revise") return [{ value: "approve" }, { value: "revise" }];
  return [];
}

function isConflictError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "conflict";
}

export function QuestionForm({ question, canAnswer = true, busy = false, focusTitle = false, onSubmit, onConflict }: QuestionFormProps) {
  const baseId = useId();
  const options = defaultOptions(question);
  const [single, setSingle] = useState(question.recommended ?? "");
  const [multi, setMulti] = useState<string[]>(question.recommended ? [question.recommended] : []);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Key/reset contract: when the parent passes a fresh id or rev, clear conflict and draft answers.
  useEffect(() => {
    setSingle(question.recommended ?? "");
    setMulti(question.recommended ? [question.recommended] : []);
    setText("");
    setNote("");
    setError(null);
    setConflict(false);
    setSubmitting(false);
  }, [question.id, question.rev, question.recommended]);

  useEffect(() => {
    if (!conflict) return;
    reloadRef.current?.focus({ preventScroll: true });
  }, [conflict]);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle, question.id, question.rev]);

  const needsNote = question.answerType === "approve_revise" && single.toLowerCase() === "revise";
  const noteReady = !needsNote || note.trim().length > 0;
  const choiceValue = question.answerType === "multi" ? multi.join(",") : single;
  const canSubmit = (() => {
    if (!canAnswer || submitting || busy || conflict || !noteReady) return false;
    if (question.answerType === "text") return text.trim().length > 0;
    if (question.answerType === "multi") return multi.length > 0;
    if (question.answerType === "single" || question.answerType === "yes_no" || question.answerType === "approve_revise") {
      return single.length > 0;
    }
    return false;
  })();
  /** Visible reason when Submit is disabled for incomplete input (UI-13). */
  const submitHint = (() => {
    if (!canAnswer || submitting || busy || conflict) return null;
    if (needsNote && note.trim().length === 0) return "Add a revision note to submit";
    if (question.answerType === "text" && text.trim().length === 0) return "Write an answer to submit";
    if (question.answerType === "multi" && multi.length === 0) return "Choose at least one option";
    if (
      (question.answerType === "single" || question.answerType === "yes_no" || question.answerType === "approve_revise")
      && single.length === 0
    ) {
      return "Choose an option to submit";
    }
    return null;
  })();
  const submitHintId = submitHint ? `${baseId}-submit-hint` : undefined;

  const toggleMulti = (value: string) => {
    setMulti(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      let answer = "";
      if (question.answerType === "text") {
        answer = text.trim().slice(0, QUESTION_ANSWER_MAX);
      } else if (question.answerType === "multi") {
        // Cap the joined multi payload; never slice a single option value.
        answer = encodeMultiAnswer(options, multi).slice(0, QUESTION_ANSWER_MAX);
      } else {
        // Option values must match the server exactly — do not silently truncate them.
        answer = single;
      }
      const payload: { answer: string; note?: string; expect_rev: number } = {
        answer,
        expect_rev: question.rev,
      };
      if (needsNote || note.trim()) payload.note = note.trim().slice(0, QUESTION_NOTE_MAX);
      await onSubmit(payload);
    } catch (err) {
      if (isConflictError(err)) {
        setConflict(true);
        setError(CONFLICT_QUESTION);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const radioOptions = options.map(o => ({
    value: o.value,
    label: (
      <>
        {optionLabel(o.value, question.answerType)}
        {question.recommended === o.value ? <> <Pill tone="info">Recommended</Pill></> : null}
        {o.note ? <span className="pc-question-form__note">{o.note}</span> : null}
      </>
    ) as ComponentChildren,
  }));

  return (
    <form
      className="pc-question-form"
      aria-labelledby={`${baseId}-title`}
      onSubmit={event => { event.preventDefault(); void submit(); }}
    >
      <h2
        ref={titleRef}
        className="pc-question-form__title"
        id={`${baseId}-title`}
        tabIndex={-1}
        data-autofocus
      >
        {question.text}
      </h2>
      {question.suggestedAnswer ? (
        <Alert tone="info" title="Suggested answer" compact>
          <p>{question.suggestedAnswer}</p>
        </Alert>
      ) : null}
      {question.artifact ? (
        <p className="pc-question-form__artifact">
          <a className="pc-inline-link" href={`#/runs/${encodeURIComponent(question.runId)}?artifact=${encodeURIComponent(question.artifact.id)}`}>
            {question.artifact.label ?? "Open artifact"}
          </a>
        </p>
      ) : null}

      {(question.answerType === "single" || question.answerType === "yes_no" || question.answerType === "approve_revise") && (
        options.length
          ? <RadioChoices
            label="Answer"
            name={`${baseId}-choice`}
            value={single}
            options={radioOptions}
            onChange={setSingle}
            disabled={!canAnswer || submitting || busy || conflict}
            layout="options"
          />
          : <Alert tone="warning" title="No options" compact>
            <p>This question has no options; answer it with the CLI.</p>
          </Alert>
      )}

      {question.answerType === "multi" && (
        options.length
          ? <fieldset className="pc-question-form__multi" disabled={!canAnswer || submitting || busy || conflict}>
            <legend className="pc-field__label">Answers</legend>
            {options.map(o => (
              <Checkbox
                key={o.value}
                label={<>
                  {optionLabel(o.value, "multi")}
                  {question.recommended === o.value ? <> <Pill tone="info">Recommended</Pill></> : null}
                  {o.note ? <span className="pc-question-form__note">{o.note}</span> : null}
                </>}
                checked={multi.includes(o.value)}
                onChange={() => toggleMulti(o.value)}
              />
            ))}
          </fieldset>
          : <Alert tone="warning" title="No options" compact>
            <p>This question has no options; answer it with the CLI.</p>
          </Alert>
      )}

      {question.answerType === "text" && (
        <Field label="Your answer">
          <TextArea
            id={`${baseId}-text`}
            value={text}
            maxLength={QUESTION_ANSWER_MAX}
            required
            disabled={!canAnswer || submitting || busy || conflict}
            onInput={e => setText(e.currentTarget.value)}
          />
        </Field>
      )}

      {(question.answerType === "approve_revise" || needsNote) && (
        <Field label={needsNote ? "Revision note" : "Note (optional)"}>
          <TextInput
            id={`${baseId}-note`}
            value={note}
            maxLength={QUESTION_NOTE_MAX}
            required={needsNote}
            disabled={!canAnswer || submitting || busy || conflict}
            onInput={e => setNote(e.currentTarget.value)}
          />
        </Field>
      )}

      {error && (
        <Alert tone={conflict ? "warning" : "error"} title={conflict ? "This question changed" : "Could not submit"}>
          <p>{error}</p>
          {conflict && onConflict ? (
            <Button ref={reloadRef} type="button" variant="secondary" size="sm" onClick={() => onConflict()}>Reload</Button>
          ) : null}
        </Alert>
      )}

      {canAnswer && (
        <div className="pc-question-form__actions">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            busy={submitting || busy}
            disabled={!canSubmit}
            aria-describedby={submitHintId}
          >
            Submit answer
          </Button>
          {submitHint ? (
            <span id={submitHintId} className="pc-question-form__submit-hint">{submitHint}</span>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {choiceValue ? `Selected ${choiceValue}` : "No answer selected"}
          </span>
        </div>
      )}
    </form>
  );
}

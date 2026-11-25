/** Board 1: the conversation rail. Decisions with reasons, questions and messages to the planner, oldest first. */
import { useId, useRef, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { Field, TextArea } from "../../ds/Controls";
import { Pill } from "../../ds/Pill";
import { clock } from "../../../../src/view-model/time";
import { questionStatusLabel, RUN_MESSAGES_ERROR, RUN_MESSAGE_SEND_ERROR } from "../../../../src/view-model/runs";
import type { RailEntry } from "../../../../src/view-model/run-board";

const QUESTION_TONE: Record<string, "warn" | "good" | "neutral"> = { open: "warn", answered: "good" };

function when(at: number, now: number): string {
  return at > 0 ? clock(at, now) : "";
}

export function ConversationRail({ entries, now, canMessage, onSend, messagesError }: {
  entries: RailEntry[];
  now: number;
  /** The planner can take a message: the run has an orchestrator task and the service offers msg.send. */
  canMessage: boolean;
  onSend: (body: string) => Promise<void>;
  /** The message log could not be read, so entries may miss messages. */
  messagesError?: boolean;
}) {
  const id = useId();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    // The button disables while sending; keep keyboard focus in the message box instead of dropping it.
    box.current?.focus({ preventScroll: true });
    setBusy(true); setError(""); setSent("");
    try { await onSend(text); setBody(""); setSent("Message sent to the planner."); }
    catch (e) {
      console.warn("runs: message send failed", e);
      setError(RUN_MESSAGE_SEND_ERROR);
    }
    finally { setBusy(false); }
  };
  return (
    <section className="rv-section" aria-labelledby={`${id}-h`}>
      <h2 className="rv-title" id={`${id}-h`}>Conversation</h2>
      {messagesError ? <p className="rv-cap" role="status">{RUN_MESSAGES_ERROR}</p> : null}
      {entries.length === 0
        ? <p className="rv-cap">Nothing yet. Decisions, questions and your messages to the planner appear here.</p>
        : (
          <ol className="rv-rail" aria-label="Decisions, questions and messages">
            {entries.map(entry => (
              <li key={`${entry.kind}:${entry.id}`} className={`rv-rail-item${entry.kind === "question" && entry.status === "open" ? " rv-rail-item--you" : ""}`}>
                {entry.kind === "decision" && <>
                  <span className="rv-rail-kind">{entry.actor} decided{entry.stepId ? ` · ${entry.stepId}` : ""}{when(entry.at, now) ? ` · ${when(entry.at, now)}` : ""}</span>
                  <p className="rv-text"><strong>{entry.title}</strong></p>
                  {entry.reason ? <p className="rv-text">{entry.reason}</p> : null}
                </>}
                {entry.kind === "question" && <>
                  <span className="rv-rail-kind">Question{entry.stepId ? ` · ${entry.stepId}` : ""}{when(entry.at, now) ? ` · ${when(entry.at, now)}` : ""}</span>
                  <p className="rv-text">{entry.text}</p>
                  <span className="rv-row">
                    <Pill tone={QUESTION_TONE[entry.status] ?? "neutral"}>{questionStatusLabel(entry.status)}</Pill>
                    {entry.answer ? <span className="rv-text">Answer: {entry.answer}</span> : null}
                  </span>
                  {entry.note ? <p className="rv-cap">Note: {entry.note}</p> : null}
                </>}
                {entry.kind === "message" && <>
                  <span className="rv-rail-kind">{entry.mine ? "To the planner" : "From the planner"}{when(entry.at, now) ? ` · ${when(entry.at, now)}` : ""}</span>
                  <p className="rv-text">{entry.body}</p>
                </>}
              </li>
            ))}
          </ol>
        )}
      {canMessage && (
        <form className="rv-section" onSubmit={e => { e.preventDefault(); void send(); }}>
          <Field label="Message the planner" help="Only the planner reads this.">
            <TextArea ref={box} value={body} rows={3} maxLength={4000} onInput={e => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
          </Field>
          <div className="rv-row">
            <Button type="submit" size="sm" variant="secondary" disabled={busy || !body.trim()}>{busy ? "Sending…" : "Send to planner"}</Button>
            {!body.trim() && !busy ? <span className="rv-cap">Write a message to send it</span> : null}
          </div>
          <p className="rv-cap" role="status" aria-live="polite">{sent}</p>
          {error ? <p className="rv-cap" role="alert">{error}</p> : null}
        </form>
      )}
    </section>
  );
}

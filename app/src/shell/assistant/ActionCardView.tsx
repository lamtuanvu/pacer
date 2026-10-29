import { useState } from "preact/hooks";
import type { ActionCard } from "../../../../src/assistant/types";
import { Button, ButtonLink } from "../../ds/Button";
import { Field, TextArea, TextInput } from "../../ds/Controls";
import { cardFailure, cardParams, requestId } from "./model";

const VERBS: Record<string, string> = { retry: "Retry", stop: "Stop task", answer: "Send answer", submit: "Open New task", "delegation.pause": "Pause delegation", "delegation.resume": "Resume delegation" };

/** One proposal. The title and summary are drawn by the host; the assistant's own words sit apart, beneath. */
export function ActionCardView({ card, call, record, onRefresh, onNewTask }: {
  card: ActionCard;
  call: <T>(op: string, params: unknown) => Promise<T>;
  record: (state: "done" | "failed" | "dismissed" | "stale", result?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNewTask: (goal: string, repo: string) => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(card.result ?? null);
  const [state, setState] = useState(card.state);
  const settled = state === "done" || state === "dismissed";
  if (card.op === "navigate") return <div className="pc-aurora-card pc-aurora-card--link"><ButtonLink size="sm" href={card.href}>{card.title}</ButtonLink></div>;
  const run = async () => {
    setBusy(true);
    try {
      const params = cardParams(card, edits);
      if (card.op === "dispatch.submit") {
        onNewTask(String(params.goal ?? ""), String(params.repo ?? ""));
        await record("done", "Opened the New task composer.");
        setState("done"); setMessage("Opened the New task composer.");
        return;
      }
      await call(card.op, card.op === "delegation.resume" ? {} : card.op === "delegation.pause" ? params : { ...params, requestId: requestId() });
      await record("done", "Done.");
      setState("done"); setMessage("Done.");
    } catch (error) {
      const failure = cardFailure(error as { code?: string; message?: string });
      setState(failure.state); setMessage(failure.message);
      await record(failure.state, failure.message).catch(() => undefined);
    } finally { setBusy(false); }
  };
  const label = VERBS[card.op.replace(/^(dispatch|task)\./, "")] ?? card.title;
  return <div className="pc-aurora-card" data-state={state}>
    <p className="pc-aurora-card__summary">{card.summary}</p>
    {!settled && card.editable.map(field => <Field key={field.name} label={field.label}>
      {field.name === "text" || field.name === "goal"
        ? <TextArea value={edits[field.name] ?? field.value} onInput={event => setEdits({ ...edits, [field.name]: event.currentTarget.value })} rows={3} />
        : <TextInput value={edits[field.name] ?? field.value} onInput={event => setEdits({ ...edits, [field.name]: event.currentTarget.value })} />}
    </Field>)}
    {card.why && <blockquote className="pc-aurora-card__why"><span className="pc-aurora-card__why-label">The assistant's note</span>{card.why}</blockquote>}
    {message && <p className="pc-aurora-card__result" role="status">{message}</p>}
    {!settled && <div className="pc-aurora-reply__actions">
      {state === "stale"
        ? <Button size="sm" variant="primary" busy={busy} onClick={() => { setBusy(true); void onRefresh().then(() => { setState("pending"); setMessage(null); }).catch(() => setMessage("Could not refresh this card.")).finally(() => setBusy(false)); }}>Refresh card</Button>
        : <Button size="sm" variant="primary" busy={busy} onClick={() => void run()}>{label}</Button>}
      <Button size="sm" variant="quiet" disabled={busy} onClick={() => void record("dismissed").then(() => { setState("dismissed"); setMessage("Dismissed."); })}>Dismiss</Button>
    </div>}
  </div>;
}

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { Field, TextArea } from "../../ds/Controls";
import { Alert } from "../../ds/Alert";
import { EmptyState, Skeleton } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { Prose } from "../../ds/Prose";
import { autoReadIds, participantLabel, sendOutcome, sendRefusal, threadView, type ThreadMessage, type ThreadViewModel } from "../../model/thread";
import { useQuery, useTaskContext } from "../task-shared";
import { answerDelivered } from "../../model/task-answer";

export interface ComposerProps {
  value: string; onInput: (value: string) => void; onSend: () => void; onAnswer: () => void; busy: boolean;
  /** Set while sending cannot work (the task is closed, or a rule refuses you); the reason is shown beside the button. */
  disabledReason?: string; status?: string; error?: string;
}

/** A task's messages, oldest first, and the composer. Presentation only: the container below owns the data. */
export function ThreadView({ id, view, loading, error, notice, composer, announcement }: {
  id: string; view?: ThreadViewModel; loading?: boolean; error?: string; notice?: string | null; composer: ComposerProps; announcement: string;
}) {
  const base = `thread-${id}`, question = view?.openQuestion, disabled = !!composer.disabledReason || composer.busy;
  return <div className="pc-thread">
    {notice && <Alert tone="warning" title={notice} announce={false} />}
    {error ? <p role="alert">{error}</p>
      : !view ? loading && <Skeleton layout="rows" label="Loading messages…" />
      : view.empty ? <EmptyState title="No messages yet" />
      : <ol className="pc-thread__list" aria-label="Messages">{view.groups.map(group => <li key={group.key} className="pc-thread__group">
        <p className="pc-thread__sender">{group.sender}</p>
        {group.entries.map(entry => <article key={entry.id} className={entry.unread ? "pc-thread__message pc-thread__message--unread" : "pc-thread__message"} aria-label={`${group.sender}, ${entry.time}`}>
          <div className="pc-thread__meta"><time dateTime={entry.datetime}>{entry.time}</time>{entry.chip && <Pill>{entry.chip}</Pill>}{entry.unread && <Pill tone="info">New</Pill>}</div>
          <div className="pc-thread__body"><Prose text={entry.body} /></div>
        </article>)}
      </li>)}</ol>}
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    <form className="pc-thread__composer" onSubmit={event => { event.preventDefault(); if (!disabled) (question ? composer.onAnswer : composer.onSend)(); }}>
      <Field label={question ? "Your answer" : "Message"} error={composer.error}>
        <TextArea id={`${base}-body`} rows={3} value={composer.value} disabled={!!composer.disabledReason} onInput={event => composer.onInput(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      </Field>
      <div className="pc-thread__actions">
        {question && <Button type="submit" variant="primary" size="sm" disabled={disabled} busy={composer.busy} aria-describedby={composer.disabledReason ? `${base}-reason` : undefined}>Answer</Button>}
        <Button type={question ? "button" : "submit"} variant={question ? "secondary" : "primary"} size="sm" disabled={disabled} busy={!question && composer.busy}
          aria-describedby={composer.disabledReason ? `${base}-reason` : undefined} onClick={question ? composer.onSend : undefined}>Send</Button>
        {composer.disabledReason ? <span id={`${base}-reason`} className="muted">{composer.disabledReason}</span>
          : composer.status && <span className="muted">{composer.status}</span>}
      </div>
    </form>
  </div>;
}

const CLOSED = "This task is closed for messages.";

/** Loads the thread, marks messages to you read once shown, and sends from the composer. */
export function Thread({ id, closed, notice }: { id: string; closed: boolean; notice?: string | null }) {
  const { api, state } = useTaskContext();
  const log = useQuery<{ messages: ThreadMessage[] }>("msg.log", { task: id });
  const tasks = state.snapshot?.tasks;
  const titleOf = (task: string) => { const t = tasks?.find(item => item.id === task); return t && (t.title?.trim() || t.fullTitle?.trim() || t.goal); };
  const view = useMemo(() => log.data && threadView(log.data.messages, { now: Date.now() / 1000, titleOf }), [log.data, tasks]);
  const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState(""), [refused, setRefused] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const read = useRef(new Set<string>()), seen = useRef<string | null | undefined>(undefined), request = useRef<string>();
  useEffect(() => {
    const ids = view ? autoReadIds(view).filter(m => !read.current.has(m)) : [];
    if (!ids.length) return;
    ids.forEach(m => read.current.add(m));
    // A failed mark leaves the message unread; the next refetch offers it again.
    void api.call("msg.read", { ids }).catch(() => ids.forEach(m => read.current.delete(m)));
  }, [view && autoReadIds(view).join()]);
  useEffect(() => {
    if (!view) return;
    const latest = log.data!.messages.find(m => m.id === view.latest);
    // The first load is not news; later arrivals from others are announced.
    if (seen.current !== undefined && view.latest !== seen.current && latest && latest.from !== "human") setAnnouncement(`New message from ${participantLabel(latest.from, titleOf)}`);
    seen.current = view.latest;
  }, [view?.latest]);
  const send = async (answer: boolean) => {
    const body = value.trim();
    if (!body) { setError("Write a message first."); return; }
    setBusy(true); setError(""); setStatus("");
    request.current ??= crypto.randomUUID();
    try {
      const result = await api.call<{ delivery?: string }>("msg.send", { to: `task:${id}`, body, request_id: request.current,
        ...(answer && view?.openQuestion ? { kind: "answer", reply_to: view.openQuestion.id } : {}) });
      request.current = undefined;
      // A delivered answer settles the question; a held one leaves it open and unread.
      if (answer && view?.openQuestion && answerDelivered(result.delivery)) await api.call("msg.read", { ids: [view.openQuestion.id] }).catch(() => undefined);
      setValue(""); setStatus(sendOutcome(result.delivery)); log.reload();
    } catch (failure) {
      const refusal = sendRefusal(failure);
      if (refusal.blocking) setRefused(refusal.text); else setError(refusal.text);
    } finally { setBusy(false); }
  };
  const composer: ComposerProps = { value, busy, status, error, disabledReason: closed ? CLOSED : refused || undefined,
    // A changed body is a new request; reusing the id would be refused as a mismatch.
    onInput: next => { setValue(next); setError(""); request.current = undefined; },
    onSend: () => void send(false), onAnswer: () => void send(true) };
  return <ThreadView id={id} view={view} loading={log.loading} error={log.error && !log.data ? "Could not load messages." : undefined} notice={notice} composer={composer} announcement={announcement} />;
}

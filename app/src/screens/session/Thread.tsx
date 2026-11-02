import { useUniqueId as useId } from "../../ds/useUniqueId";
import { useWorkspaceKey, useWorkspaceState, useViewActive } from "../../workspace/state";
import type { ComponentChildren, RefObject } from "preact";
import { PendingSendFeedback, pendingThread, usePendingSend } from "./pending-send";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { Field, TextArea } from "../../ds/Controls";
import { Alert } from "../../ds/Alert";
import { EmptyState, Skeleton } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { Prose } from "../../ds/Prose";
import { autoReadIds, participantLabel, sendOutcome, threadView, type ThreadMessage, type ThreadViewModel } from "../../model/thread";
import { useQuery, useTaskContext } from "../task-shared";
import { answerDelivered } from "../../model/task-answer";

export interface ComposerProps {
  value: string; onInput: (value: string) => void; onSend: () => void; onAnswer: () => void; busy: boolean;
  /** Set while sending cannot work (the task is closed, or a rule refuses you); the reason is shown beside the button. */
  inputDisabled?: boolean; disabledReason?: string; status?: string; error?: string; inputRef?: RefObject<HTMLTextAreaElement>;
}

/** A task's messages, oldest first, and the composer. Presentation only: the container below owns the data. */
export function ThreadView({ id, view, loading, error, notice, composer, announcement, pending }: {
  id: string; view?: ThreadViewModel; loading?: boolean; error?: string; notice?: string | null; composer: ComposerProps; announcement: string; pending?: ComponentChildren;
}) {
  const base = useId(), question = view?.openQuestion, disabled = !!composer.disabledReason || composer.busy;
  return <div className="pc-thread">
    {notice && <Alert tone="warning" title={notice} announce={false} />}
    {error && <p role="alert">{error}</p>}
    {!view && !pending ? loading && <Skeleton layout="rows" label="Loading messages…" />
      : view?.empty && !pending ? <EmptyState title="No messages yet" />
      : <ol data-scroll-id={`thread:${id}`} className="pc-thread__list" aria-label="Messages">{(view?.groups ?? []).map(group => <li key={group.key} className="pc-thread__group">
        <p className="pc-thread__sender">{group.sender}</p>
        {group.entries.map(entry => <article key={entry.id} className={entry.unread ? "pc-thread__message pc-thread__message--unread" : "pc-thread__message"} aria-label={`${group.sender}, ${entry.time}`}>
          <div className="pc-thread__meta"><time dateTime={entry.datetime}>{entry.time}</time>{entry.chip && <Pill>{entry.chip}</Pill>}{entry.unread && <Pill tone="info">New</Pill>}</div>
          <div className="pc-thread__body"><Prose text={entry.body} /></div>
        </article>)}
      </li>)}{pending && <li className="pc-thread__group"><p className="pc-thread__sender">You</p>{pending}</li>}</ol>}
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    <form className="pc-thread__composer" onSubmit={event => { event.preventDefault(); if (!disabled) (question ? composer.onAnswer : composer.onSend)(); }}>
      <Field label={question ? "Your answer" : "Message"} error={composer.error}>
        <TextArea ref={composer.inputRef} id={`${base}-body`} rows={3} value={composer.value} aria-describedby={composer.disabledReason ? `${base}-reason` : undefined} data-focus-id={`thread-composer:${id}`} disabled={composer.inputDisabled || composer.disabledReason === CLOSED} onInput={event => composer.onInput(event.currentTarget.value)}
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
  const active = useViewActive();
  const log = useQuery<{ messages: ThreadMessage[] }>("msg.log", { task: id });
  const tasks = state.snapshot?.tasks;
  const titleOf = (task: string) => { const t = tasks?.find(item => item.id === task); return t && (t.title?.trim() || t.fullTitle?.trim() || t.goal); };
  const [value, setValue] = useWorkspaceState(useWorkspaceKey(id), "draft:thread", ""), [status, setStatus] = useState(""), [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const read = useRef(new Set<string>()), seen = useRef<string | null | undefined>(undefined);
  const pending = usePendingSend(api, (result, params) => {
    if (params.kind === "answer" && params.reply_to && answerDelivered(result.delivery)) void api.call("msg.read", { ids: [params.reply_to] }).catch(() => undefined);
    if (result.message) log.setData({ messages: [...(log.data?.messages ?? []).filter(m => m.id !== result.message!.id), result.message] });
    input.current?.focus();
    setStatus(result.delivery === "pending" ? "Message recorded; delivery is not confirmed yet." : sendOutcome(result.delivery)); log.reload();
  });
  const view = useMemo(() => log.data && threadView(pendingThread(log.data.messages, pending.item), { now: Date.now() / 1000, titleOf }), [log.data, tasks, pending.item]);
  useEffect(() => {
    const ids = view ? autoReadIds(view).filter(m => !read.current.has(m)) : [];
    if (!active || !state.connected || !ids.length) return;
    ids.forEach(m => read.current.add(m));
    // A failed mark leaves the message unread; the next refetch offers it again.
    void api.call("msg.read", { ids }).catch(() => ids.forEach(m => read.current.delete(m)));
  }, [view && autoReadIds(view).join(), active, state.connected]);
  useEffect(() => {
    if (!view) return;
    const latest = log.data!.messages.find(m => m.id === view.latest);
    // The first load is not news; later arrivals from others are announced.
    if (seen.current !== undefined && view.latest !== seen.current && latest && latest.from !== "human") setAnnouncement(`New message from ${participantLabel(latest.from, titleOf)}`);
    seen.current = view.latest;
  }, [view?.latest]);
  useEffect(() => { if (log.data) pending.reconcile(log.data.messages); }, [pending, log.data]);
  useEffect(() => { if (state.connected && pending.item?.status === "uncertain") void pending.check(); }, [pending, state.connected, state.connectionRevision]);
  const send = (answer: boolean) => {
    if (!state.connected || pending.item || closed) return;
    const body = value.trim();
    if (!body) { setError("Write a message first."); return; }
    const text = value;
    setValue(""); setError(""); setStatus("");
    void pending.start({ to: `task:${id}`, body, request_id: crypto.randomUUID(),
      ...(answer && view?.openQuestion ? { kind: "answer", reply_to: view.openQuestion.id } : {}) }, text);
  };
  const composer: ComposerProps = { inputRef: input, inputDisabled: closed, value, busy: !!pending.item, status, error, disabledReason: !state.connected ? "Reconnecting… Send when pacer reconnects." : closed ? CLOSED : undefined,
    onInput: next => { setValue(next); setError(""); }, onSend: () => send(false), onAnswer: () => send(true) };
  const feedback = pending.item && <PendingSendFeedback item={pending.item} offline={!state.connected || closed} onRetry={() => { if (state.connected && !closed) void pending.retry(); }} onCheck={() => void pending.check()}
    onDiscard={() => { const text = pending.discard(); if (text !== undefined) { setValue(current => current ? `${current}\n${text}` : text); input.current?.focus(); } }}/>;
  return <ThreadView id={id} view={view} loading={log.loading} error={log.error && !log.data ? "Could not load messages." : undefined} notice={notice} composer={composer} announcement={announcement} pending={feedback} />;
}

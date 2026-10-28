import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AssistantScope, TurnView } from "../../../../src/assistant/types";
import { ApiError } from "../../data/api";
import { keys } from "../../keys/instance";
import { AuroraAvatar, AuroraLauncher, AuroraSheet, Thinking } from "../../ds/AuroraSheet";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink, IconButton } from "../../ds/Button";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { TextInput } from "../../ds/Controls";
import { Prose } from "../../ds/Prose";
import { DensityContext } from "../../ds/Density";
import { TaskContext } from "../../screens/task-shared";
import { assistantEntry } from "../assistant-entry";
import { ActionCardView } from "./ActionCardView";
import { type ScopeChoice, defaultScope, parseFrames, requestId, scopeChoices } from "./model";

interface Status { available: boolean; configured: boolean; account?: string; reason?: string; hint?: string }
interface Pending { question: string; status: string; partial: string }

const SUGGESTIONS = ["What needs me today?", "Summarise today’s dispatch", "How much budget is left this week?"];
const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** Reads the per-turn SSE stream until it ends. Rejects when streaming is unavailable, so the caller can poll instead. */
async function follow(turnId: string, onFrame: (frame: ReturnType<typeof parseFrames>["frames"][number]) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/v3/assistant/turns/${encodeURIComponent(turnId)}/stream`, { credentials: "same-origin", signal });
  if (!response.ok || !response.body) throw new Error("no stream");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) { onFrame(frame); if ("done" in frame) done = true; }
  }
}

export default function AssistantHost({ route, narrow, repo, repoLabel, onNewTask }: {
  route: { name: string; id?: string }; narrow: boolean; repo: string | null; repoLabel: string | null; onNewTask: () => void;
}) {
  const context = useContext(TaskContext);
  const api = context?.api;
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [scopeValue, setScopeValue] = useState("dispatch");
  const turnRef = useRef<string | null>(null), abort = useRef<AbortController | null>(null), loaded = useRef(false);
  const taskId = route.name === "sessions" && route.id ? route.id : null;
  const choices: ScopeChoice[] = useMemo(() => scopeChoices({ taskId, repo, repoLabel }), [taskId, repo, repoLabel]);
  const scope: AssistantScope = (choices.find(c => c.value === scopeValue) ?? choices[choices.length - 1]!).scope;

  const refresh = useCallback(async () => {
    if (!api) return;
    try { const next = await api.call<Status>("assistant.status", {}); setStatus(next); assistantEntry.setAvailable(next.available); }
    catch { setStatus(null); assistantEntry.setAvailable(false); }
  }, [api]);
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 60_000); return () => clearInterval(t); }, [refresh]);

  const toggle = useCallback((next?: boolean) => setOpen(o => next ?? !o), []);
  useEffect(() => {
    if (!open) return;
    void refresh();
    setScopeValue(previous => defaultScope(choices, previous));
    if (loaded.current || !api) return;
    loaded.current = true;
    // History is kept in the service, so every window shows the same conversation.
    void api.call<{ conversations: { id: string }[] }>("assistant.conversations", { limit: 1 }).then(async list => {
      const id = list.conversations[0]?.id;
      if (!id) return;
      const conversation = await api.call<{ turns: TurnView[] }>("assistant.conversation", { id });
      setConversationId(id); setTurns(conversation.turns.filter(t => t.state !== "running"));
    }).catch(() => undefined);
  }, [open]);

  const send = useCallback(async (question: string, o: { newConversation?: boolean } = {}) => {
    const asked = question.trim();
    if (!asked || pending || !api) return;
    setNotice(null); setText("");
    if (o.newConversation) { setTurns([]); setConversationId(undefined); }
    setPending({ question: asked, status: "Thinking…", partial: "" });
    try {
      const started = await api.call<{ conversationId: string; turnId: string }>("assistant.ask", { ...(o.newConversation ? {} : { conversationId }), text: asked, scope, requestId: requestId() });
      setConversationId(started.conversationId); turnRef.current = started.turnId;
      abort.current = new AbortController();
      await follow(started.turnId, frame => {
        if ("status" in frame) setPending(p => p && { ...p, status: frame.status });
        else if ("delta" in frame) setPending(p => p && { ...p, partial: p.partial + frame.delta });
      }, abort.current.signal).catch(async () => {
        // No stream: read the turn until it settles.
        for (let i = 0; i < 180; i++) { const t = await api.call<TurnView>("assistant.turn", { turnId: started.turnId }); if (t.state !== "running") return; await new Promise(r => setTimeout(r, 700)); }
      });
      const turn = await api.call<TurnView>("assistant.turn", { turnId: started.turnId });
      setTurns(t => [...t, turn]);
    } catch (error) {
      setNotice(error instanceof ApiError ? (error.hint ? `${error.message} ${error.hint}` : error.message) : "The assistant could not be reached. Try again.");
    } finally { setPending(null); turnRef.current = null; abort.current = null; void refresh(); }
  }, [api, conversationId, pending, scope, refresh]);

  const stop = () => { if (turnRef.current) void api?.call("assistant.cancel", { turnId: turnRef.current }).catch(() => undefined); };
  const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => assistantEntry.listen(request => {
    setOpen(true);
    if (request.text) void sendRef.current(request.text, { newConversation: request.newConversation });
    else if (request.newConversation) { setTurns([]); setConversationId(undefined); }
  }), []);
  useEffect(() => {
    const off = keys.register({ keys: "Ctrl-j", label: "Ask pacer", scope: "global", allowInControl: false, run: () => toggle() });
    // The key registry ignores the Command key, so ⌘J is handled here.
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "j" && !event.defaultPrevented && status?.available !== false) { event.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { off(); window.removeEventListener("keydown", onKey); };
  }, [toggle, status?.available]);

  const available = status?.available === true;
  if (!api || (!available && !open)) return null;
  const hasCard = turns.some(t => t.cards.some(c => c.state === "pending" || c.state === "stale"));
  const account = status?.account ?? "";
  const pickerOptions = choices.map(c => ({ value: c.value, label: account ? `${c.label} · ${account}` : c.label }));
  const call = <T,>(op: string, params: unknown) => api.call<T>(op, params);
  return <DensityContext.Provider value={narrow ? "touch" : "compact"}><div className={narrow ? "pc-aurora-layer pc-aurora-layer--narrow" : "pc-aurora-layer"}>
    <AuroraSheet label="Assistant" open={open} generating={!!pending} narrow={narrow} expanded={hasCard} onClose={() => toggle(false)}
      header={narrow ? <Button size="sm" variant="quiet" onClick={() => toggle(false)}>Close</Button> : undefined}
      messages={<>
        {turns.map(turn => <TurnRows key={turn.id} turn={turn} call={call} onNewTask={goal => { saveDraft(goal, turn); onNewTask(); }} reload={async () => {
          const c = await api.call<{ turns: TurnView[] }>("assistant.conversation", { id: turn.conversationId }); setTurns(c.turns.filter(t => t.state !== "running"));
        }} />)}
        {pending && <>
          <div className="pc-aurora-msg">{pending.question}</div>
          <div className="pc-aurora-reply" aria-hidden="true"><AuroraAvatar /><div className="pc-aurora-reply__body">{pending.partial ? <Prose text={pending.partial} /> : <Thinking label={pending.status} />}</div></div>
        </>}
        {notice && <Alert tone="error" title="The assistant could not answer">{notice}</Alert>}
        {!available && status && <Alert tone="warning" title="The assistant is unavailable">{status.reason}{status.hint ? ` ${status.hint}` : ""}</Alert>}
      </>}
      suggestions={!turns.length && !pending && available ? SUGGESTIONS.map(s => <Button key={s} size="sm" className="pc-aurora-chip" onClick={() => void send(s)}>{s}</Button>) : undefined}
      composer={<form className="pc-aurora-composer" onSubmit={event => { event.preventDefault(); void send(text); }}>
        {(turns.length > 0 || !!conversationId) && <IconButton icon="plus" size="sm" variant="quiet" aria-label="New conversation" title="New conversation" disabled={!!pending} onClick={() => { setTurns([]); setConversationId(undefined); setNotice(null); }} />}
        <TextInput data-autofocus value={text} aria-label="Ask pacer" placeholder="Ask about your tasks, dispatch or budget" disabled={!available} onInput={event => setText(event.currentTarget.value)} />
        <ChoicePicker className="pc-aurora-scope" aria-label="Change context" value={choices.some(c => c.value === scopeValue) ? scopeValue : "dispatch"} options={pickerOptions} onValueChange={setScopeValue} />
        {pending
          ? <IconButton icon="end-session" size="sm" variant="secondary" aria-label="Stop answer" onClick={stop} />
          : <IconButton type="submit" icon="send" size="sm" variant={hasCard ? "secondary" : "primary"} aria-label="Send" disabled={!available || !text.trim()} />}
      </form>} />
    {!(narrow && open) && <AuroraLauncher open={open} shortcut={narrow ? undefined : isMac() ? "⌘J" : "Ctrl J"} onClick={() => toggle()} className={open ? "pc-aurora-launcher--open" : undefined} />}
  </div></DensityContext.Provider>;
}

/** A New task card carries its request to the composer through the composer's own saved draft. */
function saveDraft(goal: string, turn: TurnView): void {
  const card = turn.cards.find(c => c.op === "dispatch.submit");
  try {
    const key = "pacer.delegate.v2", saved = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...saved, goal, ...(typeof card?.params.repo === "string" ? { repo: card.params.repo } : {}) }));
  } catch { /* the composer opens empty */ }
}

function TurnRows({ turn, call, onNewTask, reload }: { turn: TurnView; call: <T>(op: string, params: unknown) => Promise<T>; onNewTask: (goal: string) => void; reload: () => Promise<void> }) {
  return <>
    <div className="pc-aurora-msg">{turn.question}</div>
    <div className="pc-aurora-reply"><AuroraAvatar /><div className="pc-aurora-reply__body">
      {turn.state === "done" && turn.answer ? <Prose text={turn.answer} />
        : turn.state === "cancelled" ? <p>Stopped.</p>
        : <p>{turn.error ?? "The assistant could not answer."}</p>}
      {turn.citations.length > 0 && <div className="pc-aurora-reply__actions">{turn.citations.map(c => <ButtonLink key={c.href} size="sm" href={c.href}>{c.label}</ButtonLink>)}</div>}
      {turn.cards.map(card => <ActionCardView key={card.id} card={card} call={call} onNewTask={goal => onNewTask(goal)}
        record={async (state, result) => { await call("assistant.card.record", { turnId: turn.id, cardId: card.id, state, ...(result ? { result } : {}) }); }}
        onRefresh={async () => { await call("assistant.card.refresh", { turnId: turn.id, cardId: card.id }); await reload(); }} />)}
    </div></div>
  </>;
}

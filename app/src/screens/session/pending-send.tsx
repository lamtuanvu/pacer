import { useMemo, useRef, useState } from "preact/hooks";
import { ApiError, type BrowserApi } from "../../data/api";
import { Button } from "../../ds/Button";
import { Prose } from "../../ds/Prose";
import { sendRefusal, type ThreadMessage } from "../../model/thread";

export interface SendParams { to: string; body: string; request_id: string; kind?: string; reply_to?: string; expect_rev?: number }
export interface SendResult { message?: ThreadMessage; delivery?: string; hold?: { reason?: string } }
export interface PendingItem { params: Readonly<SendParams>; text: string; status: "sending" | "checking" | "uncertain" | "failed"; error?: string; blocking?: boolean }
interface SendDeps {
  send: (params: Readonly<SendParams>) => Promise<SendResult>;
  log: (params: { task: string; limit: number; after?: string }) => Promise<{ messages: ThreadMessage[] }>;
  confirmed: (result: SendResult, params: Readonly<SendParams>) => void;
  changed?: () => void; timeoutMs?: number;
}
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Request timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}
const uncertain = (error: unknown) => !(error instanceof ApiError) || !error.status && ["offline", "timeout", "internal"].includes(error.code) || error.status === 408 || (error.status ?? 0) >= 500;

/** Hide the service's early stored copy until the pending row is settled. */
export const pendingThread = (messages: readonly ThreadMessage[], item?: PendingItem): readonly ThreadMessage[] =>
  item ? messages.filter(m => m.from !== "human" || m.requestId !== item.params.request_id) : messages;

/** Owns one immutable send, including its retry identity. Reads never replay a mutation. */
export class PendingSend {
  item?: PendingItem;
  constructor(private deps: SendDeps) {}
  private update(item: PendingItem | undefined) { this.item = item; this.deps.changed?.(); }
  private matches(message: ThreadMessage, item: PendingItem) {
    const p = item.params;
    return message.from === "human" && message.requestId === p.request_id && message.to === p.to
      && message.body === p.body && message.kind === (p.kind ?? "message") && message.replyTo === (p.reply_to ?? null);
  }
  private confirm(item: PendingItem, result: SendResult) {
    if (this.item !== item) return;
    this.update(undefined); this.deps.confirmed(result, item.params);
  }
  reconcile(messages: readonly ThreadMessage[]) {
    const item = this.item;
    if (!item) return;
    const message = messages.find(m => this.matches(m, item) && (m.status !== "pending" || item.status !== "sending"));
    // A stored pending message confirms acceptance, not delivery to the task.
    if (message) this.confirm(item, { message, delivery: message.status === "held" ? "held" : message.status === "pending" ? "pending" : "queued" });
  }
  async start(params: SendParams, text: string) {
    if (this.item) return;
    this.update({ params: Object.freeze({ ...params }), text, status: "sending" });
    await this.transmit(this.item!);
  }
  async retry() {
    if (this.item?.status !== "failed" || this.item.blocking) return;
    const item = { ...this.item, status: "sending" as const, error: undefined };
    this.update(item); await this.transmit(item);
  }
  discard(): string | undefined {
    if (!this.item || ["sending", "checking"].includes(this.item.status)) return;
    const text = this.item.text; this.update(undefined); return text;
  }
  private async transmit(item: PendingItem) {
    try {
      const response = this.deps.send(item.params);
      // A timed-out request may still settle; only the awaited attempt can confirm.
      void response.catch(() => undefined);
      const result = await within(response, this.deps.timeoutMs ?? 15_000);
      this.confirm(item, result);
    } catch (error) {
      if (this.item !== item) return;
      const refusal = sendRefusal(error);
      item.error = refusal.text; item.blocking = refusal.blocking;
      if (!refusal.blocking && uncertain(error)) await this.check();
      else this.update({ ...item, status: "failed" });
    }
  }

  async check() {
    const item = this.item;
    if (!item || item.status === "checking") return;
    item.status = "checking"; this.update(item);
    try {
      let after: string | undefined;
      for (;;) {
        const { messages } = await within(this.deps.log({ task: item.params.to.slice(5), limit: 1000, ...(after ? { after } : {}) }), this.deps.timeoutMs ?? 15_000);
        if (this.item !== item) return;
        this.reconcile(messages);
        if (this.item !== item) return;
        if (messages.length < 1000) break;
        const next = messages.at(-1)!.id;
        if (next === after) throw new Error("Thread did not advance");
        after = next;
      }
      this.update({ ...item, status: "failed" });
    } catch {
      if (this.item === item) this.update({ ...item, status: "uncertain", error: "Could not check whether this message was sent. Check status when connected." });
    }
  }
}

export function usePendingSend(api: BrowserApi, confirmed: SendDeps["confirmed"]) {
  const [, render] = useState(0), callback = useRef(confirmed);
  callback.current = confirmed;
  const pending = useMemo(() => new PendingSend({ send: params => api.call("msg.send", params), log: params => api.call("msg.log", params),
    confirmed: (result, params) => callback.current(result, params), changed: () => render(n => n + 1) }), [api]);
  return pending;
}

export function PendingSendFeedback({ item, sent, onRetry, onDiscard, onCheck, offline = false }: {
  item?: PendingItem; sent?: string; onRetry: () => void; onDiscard: () => void; onCheck: () => void; offline?: boolean;
}) {
  if (!item) return sent ? <article className="pc-thread__message" aria-label="Your answer"><div className="pc-thread__body"><Prose text={sent}/></div></article> : null;
  const working = item.status === "sending" || item.status === "checking";
  return <article className="pc-thread__message" aria-label="Your pending message">
    <div className="pc-thread__body"><Prose text={item.params.body}/></div>
    <p role="status" aria-live="polite">{item.status === "sending" ? "Sending" : item.status === "checking" ? "Checking whether this message was sent…" : item.error}</p>
    {!working && <div className="pc-thread__actions">
      {item.status === "failed" ? !item.blocking && <Button size="sm" disabled={offline} onClick={onRetry}>Retry</Button> : <Button size="sm" disabled={offline} onClick={onCheck}>Check status</Button>}
      <Button size="sm" onClick={onDiscard}>Discard</Button>
    </div>}
  </article>;
}

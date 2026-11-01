import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { PendingSend, PendingSendFeedback, pendingThread } from "../app/src/screens/session/pending-send";
import { ThreadView } from "../app/src/screens/session/Thread";
import { threadView } from "../app/src/model/thread";
import { ApiError } from "../app/src/data/api";
import type { ThreadMessage } from "../app/src/model/thread";

const params = { to: "task:t-1", body: "Hello", request_id: "r-1", expect_rev: 7 };
const message = (extra = {}): ThreadMessage => ({ id: "m-1", taskId: "t-1", rootId: "t-1", from: "human", to: params.to, kind: "message", body: params.body, requestId: "r-1", replyTo: null, status: "delivered", createdAt: 1, deliveredAt: 1, readAt: null, turnId: null, ...extra });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const draw = (send: PendingSend) => renderToString(<PendingSendFeedback item={send.item} onRetry={() => {}} onDiscard={() => {}} onCheck={() => {}}/>);

test("send immediately retains the text with visible polite Sending status until confirmed", async () => {
  const response = deferred<{ message: ThreadMessage; delivery: string }>();
  const confirmed: unknown[] = [];
  const send = new PendingSend({ send: () => response.promise, log: async () => ({ messages: [] }), confirmed: result => confirmed.push(result) });
  const work = send.start(params, " Hello ");
  expect(send.item?.text).toBe(" Hello ");
  expect(draw(send)).toContain('role="status" aria-live="polite">Sending');
  expect(draw(send)).toContain("Hello");
  expect(confirmed).toEqual([]);
  response.resolve({ message: message(), delivery: "live" });
  await work;
  expect(send.item).toBeUndefined();
  expect(confirmed).toHaveLength(1);
});

test("failure retains text and error; Retry reuses the exact original payload including revision", async () => {
  const sent: unknown[] = [];
  const send = new PendingSend({ send: async p => { sent.push({ ...p }); throw new ApiError("invalid_input", "Refused", undefined, 400); }, log: async () => ({ messages: [] }), confirmed: () => {} });
  await send.start(params, " Hello ");
  expect(draw(send)).toContain("The message was not sent");
  expect(draw(send)).toContain(">Retry</button>");
  expect(draw(send)).toContain(">Discard</button>");
  params.body = "Changed elsewhere";
  await send.retry();
  params.body = "Hello";
  expect(sent).toEqual([params, params]);
  expect(sent[0]).toEqual({ ...params, body: "Hello" });
  expect(send.discard()).toBe(" Hello ");
  expect(send.item).toBeUndefined();
});

test("uncertain send reads the whole thread before offering Retry and recognizes only its own request", async () => {
  const read = deferred<{ messages: ThreadMessage[] }>(), started = deferred<void>();
  let confirmed = 0;
  const send = new PendingSend({ send: async () => { throw new TypeError("Lost connection"); }, log: () => { started.resolve(); return read.promise; }, confirmed: () => confirmed++ });
  const work = send.start(params, params.body);
  await started.promise;
  expect(send.item?.status).toBe("checking");
  expect(draw(send)).not.toContain(">Retry</button>");
  read.resolve({ messages: [message({ from: "external:planner" }), message({ id: "m-2" })] });
  await work;
  expect(confirmed).toBe(1);
  expect(send.item).toBeUndefined();
});

test("failed reconciliation offers Check status, never Retry, until a successful absent read", async () => {
  let offline = true;
  const send = new PendingSend({ send: async () => { throw new ApiError("offline", "offline"); }, log: async () => { if (offline) throw new Error("offline"); return { messages: [] }; }, confirmed: () => {} });
  await send.start(params, params.body);
  expect(send.item?.status).toBe("uncertain");
  expect(draw(send)).toContain("Check status");
  expect(draw(send)).not.toContain(">Retry</button>");
  await send.retry();
  expect(send.item?.status).toBe("uncertain");
  offline = false;
  await send.check();
  expect(send.item?.status).toBe("failed");
  expect(draw(send)).toContain(">Retry</button>");
});

test("reconciliation pages past the first thousand messages and keeps held outcomes undelivered", async () => {
  const pages: unknown[] = [], results: unknown[] = [];
  const send = new PendingSend({ send: async () => { throw new Error("timeout"); }, log: async p => { pages.push(p); return { messages: p.after ? [message({ id: "m-z", status: "held" })] : Array.from({ length: 1000 }, (_, i) => message({ id: `m-${i}`, requestId: "other" })) }; }, confirmed: result => results.push(result.delivery) });
  await send.start(params, params.body);
  expect(pages).toEqual([{ task: "t-1", limit: 1000 }, { task: "t-1", limit: 1000, after: "m-999" }]);
  expect(results).toEqual(["held"]);
});

test("an event-backed thread read confirms once while the response is still pending", async () => {
  const response = deferred<{ message: ThreadMessage; delivery: string }>();
  let confirmed = 0;
  const send = new PendingSend({ send: () => response.promise, log: async () => ({ messages: [] }), confirmed: () => confirmed++ });
  const work = send.start(params, params.body);
  send.reconcile([message()]);
  expect(send.item).toBeUndefined();
  response.resolve({ message: message(), delivery: "live" });
  await work;
  expect(confirmed).toBe(1);
});

test("a send that never responds times out into reconciliation", async () => {
  const send = new PendingSend({ send: () => new Promise(() => {}), log: async () => ({ messages: [] }), confirmed: () => {}, timeoutMs: 1 });
  await send.start(params, params.body);
  expect(send.item?.status).toBe("failed");
});


test("an initially empty thread displays a pending send inside the messages list", () => {
  const html = renderToString(<ThreadView id="t-1" view={threadView([], { now: 1 })} announcement="" pending={<PendingSendFeedback item={{ params, text: params.body, status: "sending" }} onRetry={() => {}} onDiscard={() => {}} onCheck={() => {}}/>}
    composer={{ value: "", busy: true, onInput: () => {}, onSend: () => {}, onAnswer: () => {} }}/>);
  expect(html).toMatch(/<ol[^>]*aria-label="Messages"[\s\S]*Hello[\s\S]*Sending[\s\S]*<\/ol>/);
  expect(html).not.toContain("No messages yet");
});

test("a timed-out response is detached even before Retry", async () => {
  const response = deferred<{ message: ThreadMessage; delivery: string }>();
  const results: string[] = [];
  const send = new PendingSend({ send: () => response.promise, log: async () => { throw new Error("offline"); }, confirmed: result => results.push(result.delivery!), timeoutMs: 1 });
  await send.start(params, params.body);
  expect(send.item?.status).toBe("uncertain");
  response.resolve({ message: message(), delivery: "live" });
  await response.promise; await Promise.resolve();
  expect(send.item?.status).toBe("uncertain");
  expect(results).toEqual([]);
  send.reconcile([message()]);
  expect(send.item).toBeUndefined();
  expect(results).toEqual(["queued"]);
});

test("a stored pending message during send does not preempt the service delivery decision", async () => {
  const response = deferred<{ message: ThreadMessage; delivery: string }>();
  const results: string[] = [];
  const send = new PendingSend({ send: () => response.promise, log: async () => ({ messages: [] }), confirmed: result => results.push(result.delivery!) });
  const work = send.start(params, params.body);
  send.reconcile([message({ status: "pending" })]);
  expect(send.item?.status).toBe("sending");
  response.resolve({ message: message({ status: "pending" }), delivery: "held" });
  await work;
  expect(results).toEqual(["held"]);
});


test("the service's early stored message and local Sending render as one pending row", () => {
  const item = { params, text: params.body, status: "sending" as const };
  const question = message({ id: "q-1", from: "task:t-1", to: "human", kind: "question", body: "Question?", requestId: "q-request" });
  const answer = message({ kind: "answer", replyTo: "q-1", status: "pending" });
  const view = threadView(pendingThread([question, answer], item), { now: 1 });
  expect(view.openQuestion?.id).toBe("q-1");
  expect(view.groups.flatMap(g => g.entries).filter(e => e.body === params.body)).toHaveLength(0);
});

test("a status read that never responds releases checking into Check status", async () => {
  const send = new PendingSend({ send: async () => { throw new TypeError("offline"); }, log: () => new Promise(() => {}), confirmed: () => {}, timeoutMs: 1 });
  await send.start(params, params.body);
  expect(send.item?.status).toBe("uncertain");
  expect(draw(send)).toContain("Check status");
  expect(draw(send)).toContain("Discard");
});

test("a confirmed answer remains readable without a Sending marker", () => {
  const html = renderToString(<PendingSendFeedback sent="Use the small model" onRetry={() => {}} onDiscard={() => {}} onCheck={() => {}}/>);
  expect(html).toContain("Use the small model");
  expect(html).not.toContain("Sending");
  expect(html).not.toContain("Retry");
});

test("an HTTP timeout is reconciled before Retry", async () => {
  let reads = 0;
  const send = new PendingSend({ send: async () => { throw new ApiError("internal", "timeout", undefined, 408); }, log: async () => { reads++; return { messages: [] }; }, confirmed: () => {} });
  await send.start(params, params.body);
  expect(reads).toBe(1);
  expect(send.item?.status).toBe("failed");
});

for (const settle of ["resolve", "reject"] as const) test(`a timed-out attempt's late ${settle} cannot settle its Retry`, async () => {
  const first = deferred<{ delivery: string }>(), second = deferred<{ delivery: string }>();
  const results: string[] = [];
  let calls = 0;
  const send = new PendingSend({ send: () => ++calls === 1 ? first.promise : second.promise, log: async () => ({ messages: [] }), confirmed: result => results.push(result.delivery!), timeoutMs: 20 });
  await send.start(params, params.body);
  const retry = send.retry();
  if (settle === "resolve") first.resolve({ delivery: "stale" });
  else first.reject(new Error("stale rejection"));
  await Promise.resolve(); await Promise.resolve();
  expect(send.item?.status).toBe("sending");
  expect(results).toEqual([]);
  second.resolve({ delivery: "held" });
  await retry;
  expect(send.item).toBeUndefined();
  expect(results).toEqual(["held"]);
});

for (const reason of ["msg_node_closed", "msg_forbidden", "msg_live_unavailable", "msg_worktree_unavailable"]) test(`permanent refusal ${reason} offers Discard without Retry`, async () => {
  let calls = 0;
  const send = new PendingSend({ send: async () => { calls++; throw new ApiError("not_allowed", "Refused", undefined, 403, { reason }); }, log: async () => ({ messages: [] }), confirmed: () => {} });
  await send.start(params, params.body);
  expect(draw(send)).toContain(">Discard</button>");
  expect(draw(send)).not.toContain(">Retry</button>");
  expect(draw(send)).not.toContain("Check status");
  expect(draw(send)).toContain(send.item!.error!);
  await send.retry();
  expect(calls).toBe(1);
  expect(send.discard()).toBe(params.body);
});

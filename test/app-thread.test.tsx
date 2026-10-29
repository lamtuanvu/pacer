import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { ThreadView, type ComposerProps } from "../app/src/screens/session/Thread";
import { threadView, type ThreadMessage } from "../app/src/model/thread";
import { queryRevision } from "../app/src/screens/task-shared";
import { initialState, reduceStore } from "../app/src/data/store";
import { emptySnapshot } from "../src/link/envelope";

const noop = () => {};
const now = Date.UTC(2026, 9, 29, 10, 0) / 1000;
const task = "t-20261029-090000-aaaa";
const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({ id: "m1", taskId: task, rootId: `task:${task}`, from: "human", to: `task:${task}`, kind: "message", body: "Hi",
  replyTo: null, requestId: null, status: "delivered", createdAt: now - 60, deliveredAt: null, readAt: null, turnId: null, ...over });
const composer = (over: Partial<ComposerProps> = {}): ComposerProps => ({ value: "", onInput: noop, onSend: noop, onAnswer: noop, busy: false, ...over });
const render = (props: Partial<Parameters<typeof ThreadView>[0]>) => renderToString(<ThreadView id={task} composer={composer()} announcement="" {...props} />);

test("loading, empty and error states", () => {
  expect(render({ loading: true })).toContain("Loading messages…");
  expect(render({ view: threadView([], { now }) })).toContain("No messages yet");
  const failed = render({ error: "Could not load messages." });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Could not load messages.");
});

test("messages carry plain labels, chips only for non-plain kinds, a polite live region and named controls", () => {
  const view = threadView([msg({ id: "m1", body: "Use `t-20261029-090000-aaaa` please" }), msg({ id: "m2", from: `task:${task}`, to: "human", kind: "report", body: "Done" })], { now, titleOf: () => "Fix login", timeZone: "UTC" });
  const html = render({ view, announcement: "New message from Task: Fix login" });
  expect(html).toContain('aria-label="Messages"');
  expect(html).toContain(">You<");
  expect(html).toContain(">Task: Fix login<");
  expect(html).toContain(">Report<");
  expect(html).not.toContain('pc-pill--neutral">Message<');
  expect(html).toContain("<code>t-20261029-090000-aaaa</code>");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("New message from Task: Fix login");
  expect(html).toContain(">New<");
  expect(html).toMatch(/<time datetime="2026-10-29T09:59:00\.000Z"[^>]*>09:59<\/time>/);
  expect(html).toContain('<label for="thread-t-20261029-090000-aaaa-body">Message</label>');
  expect(html).toContain("<textarea");
  expect(html).not.toContain("msg_");
  expect(html).not.toContain("task:t-");
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(1);
  expect(html).toContain(">Send<");
  expect(html).not.toContain(">Answer<");
});

test("an open question to the human makes Answer the one primary action", () => {
  const view = threadView([msg({ id: "q", from: `task:${task}`, to: "human", kind: "question", body: "Which DB?" })], { now });
  const html = render({ view });
  expect(html).toContain(">Answer<");
  expect(html).toContain('<label for="thread-t-20261029-090000-aaaa-body">Your answer</label>');
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(1);
  expect(html).toMatch(/pc-btn--primary[^>]*>Answer</);
});

test("a closed or refused composer is disabled with a visible reason", () => {
  const view = threadView([msg({})], { now });
  const html = render({ view, composer: composer({ value: "Hello", disabledReason: "This task is closed for messages." }) });
  expect(html).toContain("This task is closed for messages.");
  expect(html).toMatch(/<button[^>]*disabled[^>]*aria-describedby="thread-t-20261029-090000-aaaa-reason"|<button[^>]*aria-describedby="thread-t-20261029-090000-aaaa-reason"[^>]*disabled/);
  expect(html).toContain('id="thread-t-20261029-090000-aaaa-reason"');
  // An empty body is explained on send rather than shown as an unexplained disabled button (UI-13).
  expect(render({ view })).not.toMatch(/<button[^>]*disabled[^>]*>Send</);
  const sent = render({ view, composer: composer({ value: "Hi", status: "Sent. The task is picking it up.", error: "This message is too long to send." }) });
  expect(sent).toContain("Sent. The task is picking it up.");
  expect(sent).toContain("This message is too long to send.");
  expect(sent).not.toMatch(/<button[^>]*disabled[^>]*>Send</);
});

test("liveness notices are plain copy", () => {
  expect(render({ view: threadView([], { now }), notice: "Stalled — needs a decision" })).toContain("Stalled — needs a decision");
});

test("thread queries refetch only on their own task's message events", () => {
  const start = reduceStore(reduceStore(initialState(), { type: "hello", hello: { pacer: "1", protocol: "3.0.0", ops: [], events: ["attention", "message"] } }), { type: "snapshot", snapshot: { ...emptySnapshot(), seq: 1 } as never });
  const before = queryRevision(start, "msg.log", { task });
  const other = reduceStore(start, { type: "event", event: { seq: 2, at: 1, type: "message" as never, data: { id: "x", taskId: "t-20261029-090000-bbbb" } } });
  expect(queryRevision(other, "msg.log", { task })).toBe(before);
  const mine = reduceStore(other, { type: "event", event: { seq: 3, at: 1, type: "message" as never, data: { id: "y", taskId: task } } });
  expect(queryRevision(mine, "msg.log", { task })).not.toBe(before);
});

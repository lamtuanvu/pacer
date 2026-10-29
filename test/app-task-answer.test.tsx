import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { MessageAnswer, TaskResultView } from "../app/src/screens/TaskResult";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { answerParams, legacyQuestionPending, messageQuestion } from "../app/src/model/task-answer";
import { actionRoute } from "../app/src/tray/model";
import { answerDeliveryWords, messageRefusalWords } from "../src/view-model/words";

const task = fixture as unknown as TaskDetail;
const asked = { ...task, state: "done" as const, messages: { unreadForHuman: 1, question: { id: "m-1", text: "Which provider?", at: 1 } } };
const draw = (child: any) => renderToString(<TaskContext.Provider value={{ api: { call: async () => ({}) } as any, state: initialState() }}>{child}</TaskContext.Provider>);

test("a question sent to the human gets the message composer", () => {
  expect(messageQuestion(asked)).toEqual(asked.messages.question);
  expect(messageQuestion({ ...asked, work: {} as TaskDetail["work"] })).toEqual(asked.messages.question);
  expect(messageQuestion({ ...asked, dismissed: true })).toBeUndefined();
  expect(messageQuestion({ ...asked, review: { accepted: true } as TaskDetail["review"] })).toBeUndefined();
  expect(messageQuestion({ ...asked, state: "stopped" })).toBeUndefined();
  expect(messageQuestion({ ...task, messages: { unreadForHuman: 2 } })).toBeUndefined();
});

test("a pacer ask question keeps the legacy composer only", () => {
  const legacy = { ...asked, state: "needs_input" as const, question: { text: "Which provider?", at: 1 } };
  expect(legacyQuestionPending(legacy)).toBe(true);
  expect(messageQuestion(legacy)).toBeUndefined();
  expect(messageQuestion({ ...legacy, question: { ...legacy.question, answer: "Stripe" } })).toEqual(asked.messages.question);
});

test("the answer is a msg.send reply to the question", () => {
  expect(answerParams("t-1", "m-1", "  Stripe \n", "r-1")).toEqual({ to: "task:t-1", kind: "answer", reply_to: "m-1", body: "Stripe", request_id: "r-1" });
});

test("the composer shows the question, a labelled answer box and one primary action", () => {
  const html = draw(<MessageAnswer task={asked} question={asked.messages.question} onSent={() => {}}/>);
  expect(html).toContain("Which provider?");
  expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Your answer<\/label>[\s\S]*<textarea[^>]*id="\1"/);
  expect(html.match(/pc-btn--primary/g)).toHaveLength(1);
  expect(html).toContain("Send answer");
  expect(html).toMatch(/<button[^>]*disabled/);
});

test("the composer replaces the managed-work hint and the review next step", () => {
  const html = draw(<TaskResultView task={{ ...asked, work: {} as TaskDetail["work"] }} question={<MessageAnswer task={asked} question={asked.messages.question} onSent={() => {}}/>} verdict={<button>Accept</button>}/>);
  expect(html).toContain("Send answer");
  expect(html).not.toContain("Use the Work tab");
  expect(html).not.toContain("<button>Accept</button>");
});

test("refusals and deliveries read as plain words", () => {
  expect(messageRefusalWords("msg_node_closed")).toBe("This task no longer takes messages.");
  expect(messageRefusalWords("msg_cap_reached")).toContain("Wait a minute");
  for (const reason of [undefined, "msg_unknown", 3]) expect(messageRefusalWords(reason)).toBe("The answer was not sent. Try again.");
  expect(answerDeliveryWords("turn_started")).toBe("Answer sent. The task is continuing.");
  expect(answerDeliveryWords("closed")).toContain("no longer takes messages");
  for (const text of [messageRefusalWords("msg_forbidden"), answerDeliveryWords("held"), answerDeliveryWords("no_session")]) expect(text).not.toMatch(/msg_|_/);
});

test("the tray opens the composer for an Answer action", () => {
  expect(actionRoute({ label: "Answer", op: "ui.open", params: { view: "task", id: "t-1", tab: "answer" } })).toBe("/sessions/t-1/answer");
  expect(actionRoute({ label: "Open task", op: "ui.open", params: { view: "task", id: "t-1" } })).toBe("/sessions/t-1");
});

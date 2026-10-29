import { expect, test } from "bun:test";
import { kindChip, livenessNotice, participantLabel, sendOutcome, sendRefusal, threadView, type ThreadMessage } from "../app/src/model/thread";
import { ApiError } from "../app/src/data/api";

const now = Date.UTC(2026, 9, 29, 10, 0) / 1000;
const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({ id: "m1", taskId: "t-20261029-090000-aaaa", rootId: "task:t-20261029-090000-aaaa", from: "human", to: "task:t-20261029-090000-aaaa",
  kind: "message", body: "Hi", replyTo: null, requestId: null, status: "delivered", createdAt: now - 60, deliveredAt: null, readAt: null, turnId: null, ...over });
const titles = (id: string) => ({ "t-20261029-090000-aaaa": "Fix login", "t-20261029-090000-bbbb": "Write docs" } as Record<string, string>)[id];

test("participants and kinds read as plain copy", () => {
  expect(participantLabel("human", titles)).toBe("You");
  expect(participantLabel("external:claude-code:abc", titles)).toBe("Planner");
  expect(participantLabel("broker", titles)).toBe("pacer");
  expect(participantLabel("task:t-20261029-090000-bbbb", titles)).toBe("Task: Write docs");
  expect(participantLabel("task:t-20261029-090000-cccc", titles)).toBe("Task");
  expect(participantLabel("weird", titles)).toBe("Someone else");
  expect(kindChip("message")).toBeNull();
  expect([kindChip("question"), kindChip("answer"), kindChip("report"), kindChip("nudge")]).toEqual(["Question", "Answer", "Report", "Reminder"]);
});

test("thread is oldest first, groups consecutive senders and marks unread messages to the human", () => {
  const view = threadView([
    msg({ id: "m3", from: "task:t-20261029-090000-aaaa", to: "human", kind: "question", body: "Which DB?", createdAt: now - 10 }),
    msg({ id: "m1", createdAt: now - 3600 }),
    msg({ id: "m2", createdAt: now - 3500, body: "And another" }),
    msg({ id: "m0", from: "task:t-20261029-090000-aaaa", to: "human", kind: "report", createdAt: now - 7200, status: "read", readAt: now - 7000 }),
  ], { now, titleOf: titles, timeZone: "UTC" });
  expect(view.groups.map(g => [g.sender, g.entries.map(e => e.id)])).toEqual([["Task: Fix login", ["m0"]], ["You", ["m1", "m2"]], ["Task: Fix login", ["m3"]]]);
  expect(view.groups[0]!.entries[0]).toMatchObject({ chip: "Report", unread: false, time: "08:00" });
  expect(view.groups[2]!.entries[0]).toMatchObject({ chip: "Question", unread: true });
  expect(view.unreadIds).toEqual(["m3"]);
  expect(view.openQuestion?.id).toBe("m3");
  expect(view.latest).toBe("m3");
  expect(view.empty).toBe(false);
});

test("a question is open only until it is answered and only when it is addressed to the human", () => {
  const q = msg({ id: "q", from: "task:t-20261029-090000-aaaa", to: "human", kind: "question" });
  expect(threadView([q, msg({ id: "a", kind: "answer", replyTo: "q", createdAt: now })], { now }).openQuestion).toBeNull();
  expect(threadView([{ ...q, to: "external:claude-code:x" }], { now }).openQuestion).toBeNull();
  expect(threadView([], { now })).toMatchObject({ empty: true, groups: [], unreadIds: [], openQuestion: null, latest: null });
});

test("refusals and delivery results map to plain copy, never reason codes", () => {
  const refused = (reason: string) => new ApiError("conflict", "x", undefined, 409, { reason });
  expect(sendRefusal(refused("msg_node_closed"))).toEqual({ text: "This task is closed for messages.", blocking: true });
  expect(sendRefusal(refused("msg_forbidden"))).toEqual({ text: "A messaging rule does not allow you to message this task.", blocking: true });
  expect(sendRefusal(refused("msg_cap_reached")).blocking).toBe(false);
  expect(sendRefusal(refused("msg_too_large")).text).toBe("This message is too long to send.");
  expect(sendRefusal(new Error("boom")).text).toBe("The message was not sent. Try again.");
  for (const reason of ["msg_node_closed", "msg_forbidden", "msg_cap_reached", "msg_too_large", "msg_live_unavailable", "msg_request_mismatch", "other"])
    expect(sendRefusal(refused(reason)).text).not.toContain("msg_");
  expect(sendOutcome("turn_started")).toBe("Sent. The task is picking it up.");
  expect(sendOutcome("queued")).toBe("Sent. The task reads it when its current step ends.");
  expect(sendOutcome("held")).toBe("Sent. A messaging rule holds it until you confirm.");
  expect(sendOutcome("something_new")).toBe("Sent.");
});

test("liveness shows a plain notice only when the task is stalled or waiting for the terminal", () => {
  expect(livenessNotice({ liveness: { stalled: true, reason: "nudges_exhausted" } })).toBe("Stalled — needs a decision");
  expect(livenessNotice({ liveBlocked: "viewer" })).toBe("Waiting for you to hand back the terminal");
  expect(livenessNotice({ liveness: { stalled: false, reason: "viewer" } })).toBe("Waiting for you to hand back the terminal");
  expect(livenessNotice({})).toBeNull();
  expect(livenessNotice(undefined)).toBeNull();
});

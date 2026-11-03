import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { renderDashboard } from "../src/dashboard/render";
import { Dashboard } from "../src/dashboard/controller";
import { PLAIN_THEME } from "../src/dashboard/theme";
import type { ApiClient } from "../src/api/client";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { Message } from "../src/messaging/types";
import type { TaskDetail } from "../src/dashboard/screens/types";
import type { ScreenCtx } from "../src/dashboard/screens/types";
import { threadRows } from "../src/dashboard/screens/thread";

const message = (id: string, kind: Message["kind"], from: string, to: string, body: string): Message => ({
  id, taskId: "t-0412", rootId: "t-0412", from, to, kind, body, replyTo: null,
  requestId: null, status: "delivered", createdAt: 1800000000, deliveredAt: 1800000000, readAt: null, turnId: null,
});
const s = () => structuredClone(fixture) as unknown as ClientSnapshot;

test("sessions render a plain, bounded thread with human sender copy", () => {
  const snap = s();
  const detail = { id: "t-0412", state: "done", messages: { value: [message("m1", "question", "task:t-0412", "human", "Can you check the result?")] } } as TaskDetail;
  const text = renderDashboard(snap, 120, 40, snap.at, { theme: PLAIN_THEME, state: { screen: "sessions", selected: { sessions: "session:t-0412" } },
    data: { details: new Map([["t-0412", { value: detail }]]) } });
  expect(text).toContain("THREAD");
  expect(text).toContain("Can you check the result?");
  expect(text).not.toContain("task:t-0412");
  expect(text).not.toContain("\x1b");
});

test("review detail shows task messages", () => {
  const snap = s();
  const detail = { id: "t-0412", state: "done", messages: { value: [message("m1", "report", "task:t-0412", "human", "Checks passed")] } } as TaskDetail;
  const text = renderDashboard(snap, 120, 40, snap.at, { theme: PLAIN_THEME,
    state: { screen: "review", selected: { review: "review:t-0412" } },
    data: { details: new Map([["t-0412", { value: detail }]]) } });
  expect(text).toContain("Checks passed");
});

test("the thread keeps the end of a long message", () => {
  const snap = s();
  const body = `${"Context ".repeat(45)}final instruction`;
  const messages = [message("m1", "message", "human", "task:t-0412", body)];
  const detail = { id: "t-0412", state: "done", messages: { value: messages } } as TaskDetail;
  const ctx = { s: snap, now: snap.at, theme: PLAIN_THEME, width: 60, timeZone: "UTC" } as ScreenCtx;
  const text = threadRows(ctx, detail, messages, 60).flatMap(row => row.line.map(part => part.text)).join(" ");
  expect(text).toContain("final instruction");
});

test("dashboard loads the selected task thread and sends an answer to its open question", async () => {
  const snap = s();
  const calls: { op: string; params: unknown }[] = [];
  const q = message("m-question", "question", "task:t-0412", "human", "What next?");
  let seq = 1;
  const client: ApiClient = { kind: "http", hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["task.get", "msg.log", "msg.send"], events: ["message"] }),
    snapshot: async () => ({ protocol: "3.0.0", seq, snapshot: snap }),
    call: async <T,>(op: string, params?: unknown) => { calls.push({ op, params });
      if (op === "task.get") return { id: "t-0412", state: "done" } as T;
      if (op === "msg.log") return { messages: [q] } as T;
      return { delivery: "queued" } as T;
    }, subscribe: () => () => {}, close: () => {} };
  const dash = new Dashboard({ client, theme: PLAIN_THEME, version: "test", cwd: "/tmp", now: () => snap.at,
    size: () => ({ width: 120, height: 40 }), write: () => {}, timeZone: "UTC" });
  dash.state = { ...dash.state, screen: "sessions", selected: { sessions: "session:t-0412" } };
  await dash.refresh(); await dash.settle();
  expect(calls.some(c => c.op === "msg.log" && (c.params as { task: string }).task === "t-0412")).toBe(true);
  await dash.key("y");
  expect(dash.state.overlay?.kind).toBe("prompt");
  await dash.key("O"); await dash.key("K"); await dash.key("enter"); await dash.settle();
  expect(calls).toContainEqual({ op: "msg.send", params: { to: "task:t-0412", body: "OK", kind: "answer", reply_to: "m-question" } });
  const before = calls.filter(c => c.op === "msg.log").length;
  seq++;
  snap.seq = seq;
  await dash.refresh(); await dash.settle();
  expect(calls.filter(c => c.op === "msg.log").length).toBeGreaterThan(before);
});

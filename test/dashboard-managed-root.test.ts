import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { reviewDetail, reviewItem } from "../src/dashboard/screens/review";
import type { AttentionItem } from "../src/attention/types";
import { PLAIN_THEME } from "../src/dashboard/theme";
import type { ScreenCtx, TaskDetail } from "../src/dashboard/screens/types";
import type { Act, Effect } from "../src/dashboard/state";
import { ApiError, type ApiClient } from "../src/api/client";
import { Dashboard } from "../src/dashboard/controller";
import type { ClientSnapshot } from "../src/view-model/snapshot";

const ctx = { supports: () => true, s: { tasks: [] }, theme: PLAIN_THEME, now: 100, width: 100 } as unknown as ScreenCtx;
const a = { taskId: "root", title: "My task", kind: "review", repo: null } as AttentionItem;
const root = (over: Partial<TaskDetail> = {}) => ({ id: "root", state: "done", rev: 9, executor: "codex", files: [], work: { rootId: "root", parentId: null, depth: 0, userStarted: true }, ...over }) as TaskDetail;
const submit = (act: Act | undefined, value: string): Effect => {
  if (act?.effect.type !== "prompt") throw new Error("expected a prompt");
  return act.effect.prompt.submit(value) as Effect;
};

test("TUI keeps Send back for a work root a person started, with the managed fallback", () => {
  const item = reviewItem(ctx, a, undefined, root());
  expect(item.keys.s).toBeDefined();
  expect(item.keys.r).toBeDefined();
  expect(submit(item.keys.s, "fix it")).toEqual({
    type: "action", action: { label: "Sent back", op: "task.review", params: { id: "root", expect_rev: 9, verdict: "send_back", note: "fix it" } },
    fallback: [
      { op: "dispatch.review", params: { id: "root", accepted: false, note: "fix it", expect_rev: 9 } },
      { op: "dispatch.retry", params: { id: "root", expect_rev: 9, requestId: "sendback-root-9", feedback: "fix it" } },
    ],
  });
  // Reject has no fallback: task.review already routes it to the work review.
  expect(submit(item.keys.r, "no")).not.toHaveProperty("fallback");
  const lines = reviewDetail(ctx, a, { value: root() }, 100).flatMap(row => row.line.map(span => span.text)).join(" ");
  expect(lines).toContain("Send back");
});

test("TUI answers a user-started root with task.answer, falling back to dispatch.answer", () => {
  const item = reviewItem(ctx, a, undefined, root({ state: "needs_input", question: { text: "Which format?" } }));
  expect(item.keys.a?.label).toBe("Answer");
  expect(submit(item.keys.a, "JSON")).toEqual({
    type: "action", action: { label: "Answer sent", op: "task.answer", params: { id: "root", expect_rev: 9, text: "JSON" } },
    fallback: [{ op: "dispatch.answer", params: { id: "root", expect_rev: 9, requestId: "answer-root-9", text: "JSON" } }],
  });
});

test("TUI work children keep the managed actions", () => {
  const child = root({ id: "kid", state: "needs_input", question: { text: "Which?" }, work: { rootId: "root", parentId: "root", depth: 1 },
    workTree: { nodes: [{ taskId: "kid", retryEligibility: { allowed: true } }] } as unknown as TaskDetail["workTree"] });
  const item = reviewItem(ctx, { ...a, taskId: "kid" }, undefined, child);
  expect(item.keys.s).toBeUndefined();
  expect(item.keys.a?.label).toBe("Answer work question");
  expect(submit(item.keys.a, "x")).toMatchObject({ action: { op: "dispatch.answer" } });
});

test("TUI controller runs the fallback steps when the service refuses task.*", async () => {
  const calls: { op: string; params: unknown }[] = [], frames: string[] = [];
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  const client: ApiClient = {
    kind: "http",
    hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["task.review", "task.get", "dispatch.review", "dispatch.retry"], events: [] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
    call: async <T,>(op: string, params?: unknown) => {
      calls.push({ op, params });
      if (op === "task.review") throw new ApiError("not_allowed", "Use dispatch.review for work results");
      if (op === "dispatch.review") return { task: { rev: 10 } } as T;
      return {} as T;
    },
    subscribe: () => () => {}, close: () => {},
  };
  const dash = new Dashboard({ client, theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp/repo", timeZone: "UTC", now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f) });
  await dash.refresh();
  await dash.run(submit(reviewItem(ctx, a, undefined, root()).keys.s, "fix it"));
  await dash.settle();
  expect(calls.filter(c => c.op !== "task.get").map(c => c.op)).toEqual(["task.review", "dispatch.review", "dispatch.retry"]);
  expect(calls.find(c => c.op === "dispatch.retry")?.params).toMatchObject({ expect_rev: 10, requestId: "sendback-root-9" });
  expect(frames.at(-1)).toContain("Sent back");
});

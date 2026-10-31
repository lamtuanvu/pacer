import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork, issueWorkGrant } from "../src/dispatch/work";

function setup() {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const top = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
  registerWork(ctx, top.id, { allowDelegation: true });
  return { ctx, top };
}

test("planner sends, the executor reads its inbox through its grant, then replies", async () => {
  const { ctx, top } = setup();
  const sent = await callOp(ctx, "msg.send", { to: `task:${top.id}`, body: "status?", request_id: "a" }, { spawnRunner: () => 1 }) as any;
  // A running managed work node reads its messages with its grant; no turn starts for it.
  expect(sent.delivery).toBe("pull");
  const exec = { ...ctx, env: { PACER_WORK_GRANT: issueWorkGrant(ctx, top.id, 1), PACER_ROLE: "executor" } };
  const inbox = await callOp(exec, "msg.inbox", {}) as any;
  expect(inbox.messages.map((m: any) => m.body)).toEqual(["status?"]);
  await callOp(exec, "msg.send", { to: "external:claude-code", body: "on it", kind: "answer", reply_to: sent.message.id });
  const waited = await callOp(ctx, "msg.wait", { reply_to: sent.message.id, timeout_s: 1 }) as any;
  expect(waited.messages[0].body).toBe("on it");
  const log = await callOp(ctx, "msg.log", { task: top.id }) as any;
  expect(log.messages.length).toBe(2);
  const tree = await callOp(ctx, "tree.status", { task: top.id }) as any;
  expect(tree.nodes[0].id).toBe(`task:${top.id}`);
});

test("refusals carry a reason", async () => {
  const { ctx, top } = setup();
  await expect(callOp(ctx, "msg.send", { to: `task:${top.id}`, body: "x".repeat(70000) })).rejects.toMatchObject({ code: "too_large" });
  await callOp(ctx, "msg.close", { task: top.id });
  await expect(callOp(ctx, "msg.send", { to: `task:${top.id}`, body: "x" })).rejects.toMatchObject({ code: "conflict", data: { reason: "msg_node_closed" } });
});

test("executors cannot read threads outside their tree", async () => {
  const { ctx, top } = setup();
  const other = createTask(ctx, { brief: { goal: "other", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, other.id, t => { t.origin = "human"; });
  const exec = { ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: top.id } };
  await expect(callOp(exec, "msg.log", { task: other.id })).rejects.toMatchObject({ code: "not_allowed" });
  await expect(callOp(exec, "tree.status", { task: other.id })).rejects.toMatchObject({ code: "not_allowed" });
  expect(((await callOp(exec, "msg.log", { task: top.id })) as any).messages).toEqual([]);
});

test("msg.wait with reply_to ignores unrelated reports and consumes what it returns", async () => {
  const { ctx, top } = setup();
  const other = createTask(ctx, { brief: { goal: "other", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, other.id, t => { t.origin = "external:claude-code"; });
  // A stale report from an unrelated task and an earlier one from the recipient.
  await callOp({ ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: other.id } }, "msg.send", { to: "external:claude-code", body: "stale", kind: "report" });
  const exec = { ...ctx, env: { PACER_WORK_GRANT: issueWorkGrant(ctx, top.id, 1), PACER_ROLE: "executor" } };
  await callOp(exec, "msg.send", { to: "external:claude-code", body: "old report", kind: "report" });
  const later = { ...ctx, now: ctx.now + 10 };
  const sent = await callOp(later, "msg.send", { to: `task:${top.id}`, body: "status?" }, { spawnRunner: () => 1 }) as any;
  const none = await callOp(later, "msg.wait", { reply_to: sent.message.id, timeout_s: 1 }) as any;
  expect(none).toMatchObject({ messages: [], timedOut: true });
  await callOp({ ...exec, now: ctx.now + 20 }, "msg.send", { to: "external:claude-code", body: "fresh report", kind: "report" });
  const waited = await callOp(later, "msg.wait", { reply_to: sent.message.id, timeout_s: 1 }) as any;
  expect(waited.messages.map((m: any) => m.body)).toEqual(["fresh report"]);
  const again = await callOp(later, "msg.wait", { reply_to: sent.message.id, timeout_s: 1 }) as any;
  expect(again.messages).toEqual([]);
  // The inbox does not consume; the unrelated messages are still unread.
  const inbox = await callOp(ctx, "msg.inbox", {}) as any;
  expect(inbox.messages.map((m: any) => m.body).sort()).toEqual(["old report", "stale"]);
  expect((await callOp(ctx, "msg.inbox", {}) as any).messages.length).toBe(2);
}, 15_000);

test("msg.wait without reply_to returns unread messages once", async () => {
  const { ctx, top } = setup();
  const exec = { ...ctx, env: { PACER_WORK_GRANT: issueWorkGrant(ctx, top.id, 1), PACER_ROLE: "executor" } };
  await callOp(exec, "msg.send", { to: "external:claude-code", body: "one" });
  expect(((await callOp(ctx, "msg.wait", { timeout_s: 1 })) as any).messages.map((m: any) => m.body)).toEqual(["one"]);
  expect(await callOp(ctx, "msg.wait", { timeout_s: 1 })).toMatchObject({ messages: [], timedOut: true });
}, 15_000);
test("only the parent, the tree origin or the human closes a node", async () => {
  const { ctx, top } = setup();
  const mk = (parent: string) => { const t = createTask(ctx, { brief: { goal: "c", repo: top.brief.repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 }); registerWork(ctx, t.id, {}, parent); updateTask(ctx, t.id, x => { x.state = "running"; }); return t; };
  const child = mk(top.id), grandchild = mk(child.id), sibling = mk(top.id);
  const peer = createTask(ctx, { brief: { goal: "p", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, peer.id, t => { t.origin = "human"; });
  const as = (id: string) => ({ ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } });
  const refused = { code: "not_allowed", data: { reason: "msg_forbidden", layer: "protocol" } };
  await expect(callOp(as(child.id), "msg.close", { task: top.id })).rejects.toMatchObject(refused);         // child -> parent
  await expect(callOp(as(sibling.id), "msg.close", { task: child.id })).rejects.toMatchObject(refused);     // sibling
  await expect(callOp(as(peer.id), "msg.close", { task: top.id })).rejects.toMatchObject(refused);          // top peer
  await expect(callOp({ ...ctx, env: {} }, "msg.close", { task: top.id })).rejects.toMatchObject(refused); // unknown local caller
  expect(await callOp(as(child.id), "msg.close", { task: grandchild.id })).toEqual({ task: grandchild.id, closed: true }); // parent
  expect(await callOp(ctx, "msg.close", { task: child.id })).toEqual({ task: child.id, closed: true });                  // tree origin
  expect(await callOp({ ...ctx, env: {} }, "msg.close", { task: peer.id }, { appAuthenticated: true })).toEqual({ task: peer.id, closed: true }); // human
});

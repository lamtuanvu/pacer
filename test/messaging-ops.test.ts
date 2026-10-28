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
  expect(sent.delivery).toBe("queued");
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

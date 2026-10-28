import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { main } from "../src/cli";
import { createTask, updateTask } from "../src/tasks/store";

test("pacer msg send, log and inbox", async () => {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => { x.origin = "external:claude-code"; x.state = "running"; });
  const sent = await main(["msg", "send", t.id, "status?", "--json"], ctx);
  expect(sent.code).toBe(0);
  expect(JSON.parse(sent.out).delivery).toBe("queued");
  const log = await main(["msg", "log", t.id], ctx);
  expect(log.out).toContain("status?");
  const inbox = await main(["msg", "inbox", "--json"], ctx);
  expect(JSON.parse(inbox.out).participant).toBe("external:claude-code");
});

test("pacer msg send accepts --to", async () => {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => { x.origin = "external:claude-code"; x.state = "running"; });
  const exec = { ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: t.id } };
  const sent = await main(["msg", "send", "--to", "external:claude-code", "done with step 1", "--json"], exec);
  expect(sent.code).toBe(0);
  expect(JSON.parse(sent.out).message.from).toBe(`task:${t.id}`);
});

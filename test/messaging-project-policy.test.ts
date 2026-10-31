import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { checkSend, effectivePolicy } from "../src/messaging/policy";
import { callOp } from "../src/api/ops";
import { COMMANDS } from "../src/commands/msg";

const key = "github.com/example/one";
function setup() {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.origin = "human"; t.repo = { key, label: "one", path: ctx.home, source: "local" } as typeof t.repo; });
  return { ctx, task: `task:${task.id}` };
}
const send = (to: string) => ({ from: "human", to, kind: "message" as const, bytes: 1, hasGrant: false });

test("project policy overrides a global deny only in its repo and follows tree > project > global > default", async () => {
  const { ctx, task } = setup();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nmessaging:\n  rules:\n    - {effect: deny, from_kind: human}\n");
  await callOp(ctx, "project.messaging.set", { repo: key, expect_rev: 0, rules: [{ effect: "allow", from_kind: "human" }] });
  expect(checkSend(ctx, send(task)).layer).toBe("project");
  expect((await callOp(ctx, "msg.policy", { check: { from: "human", to: task, kind: "message" } }) as { rules: { layer: string }[] }).rules[0]?.layer).toBe("project");
  expect(effectivePolicy(ctx, { root: task }).rules.map(r => r.layer)).toEqual(["project", "global", "default", "default", "default", "default", "default", "default"]);
  const other = createTask(ctx, { brief: { goal: "other", repo: ctx.home }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, other.id, t => { t.origin = "human"; t.repo = { ...t.repo!, key: "github.com/example/two" }; });
  expect(() => checkSend(ctx, send(`task:${other.id}`))).toThrow();
  updateTask(ctx, task.slice(5), t => { t.messaging = { rules: [{ effect: "deny", from_kind: "human" }] }; });
  expect(effectivePolicy(ctx, { root: task }).rules[0]?.layer).toBe("tree");
  expect(() => checkSend(ctx, send(task))).toThrow();
});

test("invalid project file falls back and msg.policy reports the error", async () => {
  const { ctx, task } = setup();
  writeFileSync(join(ctx.pacerHome, "project-messaging.json"), "bad json");
  expect(checkSend(ctx, send(task)).layer).toBe("default");
  expect((await callOp(ctx, "msg.policy", { task: task.slice(5) }) as { projectError: string }).projectError).toContain("Invalid project messaging");
});

test("set and remove round trip with revision conflicts and private file mode", async () => {
  const { ctx } = setup();
  expect(await callOp(ctx, "project.messaging.get", { repo: key })).toMatchObject({ rev: 0, rules: [] });
  const set = await callOp(ctx, "project.messaging.set", { repo: key, expect_rev: 0, rules: [{ effect: "deny", from_kind: "human" }], max_turns: 4 });
  expect(set).toMatchObject({ rev: 1, max_turns: 4 });
  expect(await callOp(ctx, "project.messaging.get", { repo: key })).toMatchObject({ rev: 1, rules: [{ effect: "deny", from_kind: "human" }] });
  await expect(callOp(ctx, "project.messaging.set", { repo: key, expect_rev: 0, rules: [] })).rejects.toMatchObject({ code: "conflict", data: { expected: 0, actual: 1 } });
  expect(statSync(join(ctx.pacerHome, "project-messaging.json")).mode & 0o777).toBe(0o600);
  expect(await callOp(ctx, "project.messaging.remove", { repo: key, expect_rev: 1 })).toMatchObject({ rev: 2, rules: [] });
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "project-messaging.json"), "utf8")).projects[key].rev).toBe(2);
});

test("CLI project policy reads, sets from a rules file, and removes with explicit revisions", async () => {
  const { ctx } = setup();
  const run = COMMANDS.find(c => c.name === "msg")!.run;
  const rulesFile = join(ctx.pacerHome, "rules.json");
  writeFileSync(rulesFile, JSON.stringify([{ effect: "deny", from_kind: "human" }]));
  expect((await run(["policy", "--project", key, "--set-file", rulesFile, "--expect-rev", "0"], ctx)).code).toBe(0);
  const shown = await run(["policy", "--project", key, "--json"], ctx);
  expect(JSON.parse(shown.out)).toMatchObject({ rev: 1, rules: [{ effect: "deny", from_kind: "human" }] });
  expect((await run(["policy", "--project", key, "--remove", "--expect-rev", "1"], ctx)).code).toBe(0);
  expect((await run(["policy", "--project", key, "--remove", "--expect-rev", "1"], ctx)).code).toBe(2);
});

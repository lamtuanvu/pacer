import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { cliDeps, main } from "../src/cli";
import { readTask } from "../src/tasks/store";
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

function cliSetup(env: Record<string, string>) {
  const ctx = fakeCtx({ env });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  return ctx;
}
async function withTTY<T>(tty: boolean, f: () => Promise<T>): Promise<T> {
  const prior = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  try { return await f(); } finally { if (prior) Object.defineProperty(process.stdin, "isTTY", prior); else delete (process.stdin as { isTTY?: boolean }).isTTY; }
}

test("pacer msg is the human only from an interactive terminal outside executor and planner sessions", async () => {
  const ctx = cliSetup({});
  const inbox = async () => JSON.parse((await main(["msg", "inbox", "--json"], ctx)).out).participant;
  expect(await withTTY(true, inbox)).toBe("human");
  expect(await withTTY(false, inbox)).toBe("external:local");
  const planner = cliSetup({ CODEX_THREAD_ID: "th" });
  expect(await withTTY(true, async () => JSON.parse((await main(["msg", "inbox", "--json"], planner)).out).participant)).toBe("external:codex:th");
  const local = await withTTY(false, () => main(["msg", "confirm", "m-1"], ctx));
  expect(local.code).toBe(2);
  expect(local.err).toContain("Only the human confirms held messages");
});

test("a pacer msg refusal prints the reason and the hint", async () => {
  const ctx = cliSetup({});
  const mk = () => createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const a = mk(), b = mk();
  for (const t of [a, b]) updateTask(ctx, t.id, x => { x.origin = "task:t-20261028-000000-0000"; x.state = "running"; });
  const exec = { ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: a.id } };
  const r = await main(["msg", "send", b.id, "hi"], exec);
  expect(r.code).toBe(2);
  expect(r.err).toContain("is not allowed");
  expect(r.err).toContain("(msg_forbidden)");
  expect(r.err).toContain("pacer msg policy --check --from");
});

test("pacer delegate records the same origin as pacer msg", async () => {
  const original = cliDeps.spawnRunner;
  cliDeps.spawnRunner = () => 1;
  try {
    for (const [env, tty, want] of [[{}, true, "human"], [{}, false, "external:local"], [{ CLAUDECODE: "1" }, true, "external:claude-code"], [{ PACER_PLANNER_SESSION: "claude-code:abc" }, false, "external:claude-code:abc"]] as const) {
      const ctx = cliSetup({ ...env });
      const r = await withTTY(tty, () => main(["delegate", "--goal", "g", "--repo", ctx.home, "--json"], ctx));
      expect(r.code).toBe(0);
      expect(readTask(ctx, JSON.parse(r.out).id)!.origin).toBe(want);
    }
  } finally { cliDeps.spawnRunner = original; }
});

test("the local TUI dashboard acts as the human from an interactive terminal", async () => {
  const { dashboardClient } = await import("../src/dashboard/client");
  const inbox = async (env: Record<string, string>) => {
    const client = await dashboardClient(cliSetup(env), true);
    try { return (await client.call<{ participant: string }>("msg.inbox", {})).participant; } finally { client.close(); }
  };
  expect(await withTTY(true, () => inbox({}))).toBe("human");
  expect(await withTTY(false, () => inbox({}))).toBe("external:local");
  expect(await withTTY(true, () => inbox({ CLAUDECODE: "1" }))).toBe("external:claude-code");
});

test("task.delegate records the in-process caller's participant as the origin", async () => {
  const { callOp } = await import("../src/api/ops");
  const ctx = cliSetup({});
  const delegate = async (deps: { participant?: string }) =>
    readTask(ctx, (await callOp(ctx, "task.delegate", { goal: "g", repo: tmpDir(), executor: "codex" }, { ...deps, spawnRunner: () => 1 }) as { task_id: string }).task_id)!.origin;
  expect(await delegate({ participant: "human" })).toBe("human");
  expect(await delegate({})).toBe("external:local");
});

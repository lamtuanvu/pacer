import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { watchCommand } from "../src/commands/watch";
import { createTask, updateTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx();
  ctx.env.PACER_API = "inprocess";
  const task = createTask(ctx, { brief: { goal: "Watch this", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const log = join(ctx.pacerHome, "watch.log");
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(log, "first\n");
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.runnerPid = process.pid;
    t.attempts = [{ executor: "codex", model: null, startedAt: ctx.now, endedAt: ctx.now, exitCode: 0, timedOut: false, limitHit: false, log }];
  });
  return { ctx, task, log };
}

test("watch streams new output once and drains bounded log chunks before settling", async () => {
  const { ctx, task, log } = fixture();
  const output: string[] = [];
  const timer = setTimeout(() => {
    appendFileSync(log, "x".repeat(300_000) + "last\n");
    updateTask(ctx, task.id, t => { t.state = "done"; });
  }, 40);
  try {
    const result = await watchCommand([task.id, "--json"], ctx, { write: s => output.push(s), pollMs: 10 });
    expect(result.code).toBe(0);
    const events = output.join("").trim().split("\n").map(s => JSON.parse(s));
    expect(events.filter(e => e.type === "state").map(e => e.state)).toEqual(["running", "done"]);
    expect(events.filter(e => e.type === "output").map(e => e.text).join("")).toBe("first\n" + "x".repeat(300_000) + "last\n");
    expect(events.at(-1)).toMatchObject({ type: "settled", task_id: task.id, state: "done" });
  } finally { clearTimeout(timer); }
});

test("watch times out without stopping the task", async () => {
  const { ctx, task } = fixture();
  const output: string[] = [];
  const result = await watchCommand([task.id, "--timeout", "1", "--json"], ctx, { write: s => output.push(s), pollMs: 10 });
  expect(result.code).toBe(2);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ type: "timeout", task_id: task.id });
  expect(readTask(ctx, task.id)?.state).toBe("running");
});

test("interrupt stops observing without stopping the task", async () => {
  const { ctx, task } = fixture();
  const controller = new AbortController();
  const output: string[] = [];
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    const result = await watchCommand([task.id, "--json"], ctx, { write: s => output.push(s), signal: controller.signal, pollMs: 10 });
    expect(result.code).toBe(130);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ type: "interrupted" });
    expect(readTask(ctx, task.id)?.state).toBe("running");
  } finally { clearTimeout(timer); }
});

test("settled tasks print outcome and review guidance", async () => {
  const { ctx, task } = fixture();
  updateTask(ctx, task.id, t => { t.state = "partial"; });
  const output: string[] = [];
  const result = await watchCommand([task.id], ctx, { write: s => output.push(s) });
  expect(result.code).toBe(0);
  expect(output.join("")).toContain("first\n");
  expect(output.join("")).toContain(`pacer review ${task.id}`);
});

test("watch rejects invalid arguments and unknown tasks", async () => {
  const ctx = fakeCtx();
  for (const args of [[], ["id", "extra"], ["id", "--timeout"], ["id", "--timeout", "0"], ["id", "--timeout", "3001"], ["id", "--timeout", "1.5"], ["id", "--wat"]]) {
    expect((await main(["watch", ...args], ctx)).code).toBe(2);
  }
  const result = await watchCommand(["t-missing", "--json"], ctx, { write: () => {} });
  expect(result.code).toBe(2);
  expect(result.err).toContain("unknown task");
});

test("watch preserves separate stdout/stderr offsets and reports needs-input guidance", async () => {
  const { ctx, task } = fixture();
  const dir = join(ctx.pacerHome, "run");
  mkdirSync(dir);
  writeFileSync(join(dir, "stdout"), "out\n");
  writeFileSync(join(dir, "stderr"), "err\n");
  updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.question = { text: "Which branch?", at: ctx.now };
    t.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: ctx.home, logFile: join(dir, "stdout") };
  });
  const output: string[] = [];
  expect((await watchCommand([task.id, "--json"], ctx, { write: s => output.push(s) })).code).toBe(0);
  const events = output.map(s => JSON.parse(s));
  expect(events.filter(e => e.type === "output")).toMatchObject([
    { stream: "stdout", offset: 0, next: 4, text: "out\n" },
    { stream: "stderr", offset: 0, next: 4, text: "err\n" },
  ]);
  expect(events.at(-1)).toMatchObject({ state: "needs_input", question: { text: "Which branch?" }, next: `pacer answer ${task.id} "<answer>"` });
});

test("CLI SIGINT emits an interrupted event and leaves execution alone", async () => {
  const { ctx, task } = fixture();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "watch", task.id, "--json"], {
    env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_API: "inprocess" },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    while (!text.includes('"type":"state"')) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("watch exited before its initial state");
      text += new TextDecoder().decode(chunk.value);
    }
    child.kill("SIGINT");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(await child.exited).toBe(130);
    expect(JSON.parse(text.trim().split("\n").at(-1)!)).toMatchObject({ type: "interrupted", task_id: task.id });
    expect(readTask(ctx, task.id)?.state).toBe("running");
  } finally { clearTimeout(deadline); child.kill(); }
});

test("watch resets offsets when automatic rerouting switches the output source", async () => {
  const { ctx, task, log } = fixture();
  writeFileSync(log, "first attempt: " + "a".repeat(1000));
  const second = join(ctx.pacerHome, "second.log");
  writeFileSync(second, "second attempt\n");
  const output: string[] = [];
  let switched = false;
  const result = await watchCommand([task.id, "--json"], ctx, { pollMs: 10, write: s => {
    output.push(s);
    const event = JSON.parse(s);
    if (event.type === "output" && !switched) {
      switched = true;
      updateTask(ctx, task.id, t => {
        t.state = "done";
        t.attempts.push({ ...t.attempts[0], executor: "cursor", log: second });
      });
    }
  } });
  expect(result.code).toBe(0);
  const events = output.map(s => JSON.parse(s)).filter(e => e.type === "output");
  expect(events.map(e => e.text)).toEqual(["first attempt: " + "a".repeat(1000), "second attempt\n"]);
  expect(events[1].offset).toBe(0);
  expect(events[1].source).not.toBe(events[0].source);
});

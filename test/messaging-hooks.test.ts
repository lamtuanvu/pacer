import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { ask } from "../src/core/tasks";
import { io } from "../src/install/stdin";
import { pendingFor, promptHook, stopHook } from "../src/messaging/hooks";
import { getLiveness } from "../src/messaging/liveness-store";
import * as store from "../src/messaging/store";
import { createTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";

const ME = "external:claude-code:s1";
function setup(yaml = "") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n${yaml}`);
  const send = (to: string, body: string, kind: "message" | "question" = "message") =>
    store.insertMessage(ctx, { taskId: "t-20261029-000000-aaaa", rootId: "task:t-20261029-000000-aaaa", from: "task:t-20261029-000000-aaaa", to, kind, body, replyTo: null, requestId: null }).message;
  return { ctx, send };
}
const input = { session_id: "s1", stop_hook_active: false };

test("Stop blocks with pending messages and lists them", async () => {
  const { ctx, send } = setup();
  const m = send(ME, "please review the diff");
  const q = send("external:claude-code", "which provider?", "question");
  const out = JSON.parse(await stopHook(ctx, "claude-code", input));
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("2 message(s) waiting");
  expect(out.reason).toContain(`- task:t-20261029-000000-aaaa (message, ${m.id}): please review the diff`);
  expect(out.reason).toContain(`(question, ${q.id}): which provider?`);
  expect(out.reason).toContain("pacer msg read");
});

test("Stop releases after stop_release_after blocks of the same set and escalates; a new message resets", async () => {
  const { ctx, send } = setup();
  send(ME, "one");
  expect(JSON.parse(await stopHook(ctx, "claude-code", input)).decision).toBe("block");
  expect(JSON.parse(await stopHook(ctx, "claude-code", input)).decision).toBe("block");
  expect(await stopHook(ctx, "claude-code", input)).toBe("");
  expect(getLiveness(ctx, ME)?.escalatedAt).toBe(ctx.now);
  send(ME, "two");
  expect(JSON.parse(await stopHook(ctx, "claude-code", input)).decision).toBe("block");
  expect(getLiveness(ctx, ME)?.hookBlocks).toBe(1);
});

test("Stop allows and clears the block count when nothing is pending", async () => {
  const { ctx, send } = setup();
  const m = send(ME, "one");
  await stopHook(ctx, "claude-code", input);
  store.markRead(ctx, ME, [m.id]);
  expect(await stopHook(ctx, "claude-code", input)).toBe("");
  expect(getLiveness(ctx, ME)?.hookBlocks ?? 0).toBe(0);
});

describe("read questions", () => {
  const mk = (ctx: Ctx, origin = ME) => {
    const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    updateTask(ctx, t.id, x => { x.origin = origin; x.state = "running"; });
    return t.id;
  };
  const asked = async (ctx: Ctx, id: string, text: string) => {
    await ask(ctx, id, text);
    const q = store.thread(ctx, id).filter(m => m.kind === "question").at(-1)!;
    store.markRead(ctx, q.to, [q.id]);
    return q;
  };
  // pacer answer and dispatch.answer on a live run record the answer on the task only, and the task runs on.
  const answerLive = (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.question!.answer = "no"; t.question!.answeredAt = ctx.now; t.state = "running"; });
  const pending = (ctx: Ctx) => pendingFor(ctx, ME).map(m => m.id);

  test("a question waits until it is answered by a linked message", async () => {
    const { ctx } = setup();
    const id = mk(ctx);
    const q = await asked(ctx, id, "which way?");
    expect(pending(ctx)).toEqual([q.id]);
    store.insertMessage(ctx, { taskId: id, rootId: `task:${id}`, from: ME, to: `task:${id}`, kind: "answer", body: "left", replyTo: q.id, requestId: null });
    expect(pending(ctx)).toEqual([]);
    expect(await stopHook(ctx, "claude-code", input)).toBe("");
  });

  test("an asked question answered only on the task stays answered after later questions, restarts and settling", async () => {
    const { ctx } = setup();
    const id = mk(ctx);
    await asked(ctx, id, "commit?");
    answerLive(ctx, id);
    expect(pending(ctx)).toEqual([]);
    ctx.now += 60;
    const second = await asked(ctx, id, "push?");
    expect(pending(ctx)).toEqual([second.id]);
    answerLive(ctx, id);
    updateTask(ctx, id, t => { t.state = "partial"; });
    expect(pending(ctx)).toEqual([]);
    // The managed dispatch.answer restart and a new message turn drop the task's question.
    updateTask(ctx, id, t => { delete t.question; });
    expect(pending(ctx)).toEqual([]);
  });

  test("an asked question whose task was retried no longer waits", async () => {
    const { ctx } = setup();
    const id = mk(ctx);
    await asked(ctx, id, "which way?");
    updateTask(ctx, id, t => { t.state = "needs_input"; t.retriedBy = "t-20261029-000000-ffff"; });
    expect(pending(ctx)).toEqual([]);
  });

  test("a question sent as a message waits for a linked answer even when the task has no open question", async () => {
    const { ctx } = setup();
    const id = mk(ctx);
    const q = store.insertMessage(ctx, { taskId: id, rootId: `task:${id}`, from: `task:${id}`, to: ME, kind: "question", body: "which way?", replyTo: null, requestId: null }).message;
    store.markRead(ctx, ME, [q.id]);
    updateTask(ctx, id, t => { t.state = "done"; });
    expect(pending(ctx)).toEqual([q.id]);
  });

  test("questions from a closed task no longer wait, in the private and generic inbox", async () => {
    const closes: ((t: TaskRecord) => void)[] = [
      t => { t.state = "stopped"; }, t => { t.dismissed = true; }, t => { t.msgClosed = true; },
      t => { t.review = { accepted: true, kind: null, note: null, at: 1 }; },
    ];
    for (const close of closes) for (const origin of [ME, "external:claude-code"]) {
      const { ctx } = setup();
      const asking = mk(ctx, origin), messaging = mk(ctx, origin);
      await asked(ctx, asking, "which way?");
      const q = store.insertMessage(ctx, { taskId: messaging, rootId: `task:${messaging}`, from: `task:${messaging}`, to: origin, kind: "question", body: "and then?", replyTo: null, requestId: null }).message;
      store.markRead(ctx, origin, [q.id]);
      expect(pending(ctx)).toHaveLength(2);
      updateTask(ctx, asking, close);
      updateTask(ctx, messaging, close);
      expect(pending(ctx)).toEqual([]);
    }
  });
});

test("off and inject_only allow", async () => {
  for (const mode of ["off", "inject_only"]) {
    const { ctx, send } = setup(`messaging:\n  hooks: {stop: ${mode}}\n`);
    send(ME, "one");
    expect(await stopHook(ctx, "claude-code", input)).toBe("");
  }
});

test("executor sessions are never blocked", async () => {
  const { ctx, send } = setup();
  send(ME, "one");
  expect(await stopHook({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } }, "claude-code", input)).toBe("");
});

test("malformed stdin fails open through the CLI", async () => {
  const { ctx, send } = setup();
  send("external:claude-code", "one");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "messaging: [broken\n");
  const original = io.readStdin;
  io.readStdin = async () => "{not json";
  try {
    for (const sub of ["stop", "prompt"]) {
      const r = await main(["msg", "hook", sub, "--planner", "claude-code"], ctx);
      expect(r.code).toBe(0);
    }
  } finally { io.readStdin = original; }
});

test("the prompt hook injects context for claude-code and codex and prints nothing when idle", async () => {
  const { ctx, send } = setup();
  expect(await promptHook(ctx, "claude-code", input)).toBe("");
  send(ME, "status?");
  const out = JSON.parse(await promptHook(ctx, "claude-code", input));
  expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(out.hookSpecificOutput.additionalContext).toContain("status?");
  send("external:codex:th", "codex please");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {claude-code: {}, codex: {}}\n");
  const text = await promptHook(ctx, "codex", { session_id: "th" });
  expect(text).toContain("codex please");
  expect(() => JSON.parse(text)).toThrow();
});

test("hooks of an agent kind that is not the configured planner neither inject nor block", async () => {
  const { ctx, send } = setup("messaging:\n  hooks: {stop: block}\n");
  send("external:codex:th", "codex please");
  expect(await promptHook(ctx, "codex", { session_id: "th" })).toBe("");
  expect(await stopHook(ctx, "codex", { session_id: "th", stop_hook_active: false })).toBe("");
  expect(store.pendingFor(ctx, "external:codex:th")).toHaveLength(1);
});

test("rendering is bounded to 20 messages and 8 KiB", async () => {
  const { ctx, send } = setup();
  for (let i = 0; i < 30; i++) send(ME, "x".repeat(1000));
  const out = JSON.parse(await stopHook(ctx, "claude-code", input));
  expect(out.reason).toContain("30 message(s) waiting");
  expect(out.reason.length).toBeLessThan(8192 + 600);
  expect(out.reason.match(/^- /gm)!.length).toBeLessThanOrEqual(20);
});

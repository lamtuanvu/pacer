import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { io } from "../src/install/stdin";
import { promptHook, stopHook } from "../src/messaging/hooks";
import { getLiveness } from "../src/messaging/liveness-store";
import * as store from "../src/messaging/store";
import { fakeCtx } from "./helpers";

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
  const text = await promptHook(ctx, "codex", { session_id: "th" });
  expect(text).toContain("codex please");
  expect(() => JSON.parse(text)).toThrow();
});

test("rendering is bounded to 20 messages and 8 KiB", async () => {
  const { ctx, send } = setup();
  for (let i = 0; i < 30; i++) send(ME, "x".repeat(1000));
  const out = JSON.parse(await stopHook(ctx, "claude-code", input));
  expect(out.reason).toContain("30 message(s) waiting");
  expect(out.reason.length).toBeLessThan(8192 + 600);
  expect(out.reason.match(/^- /gm)!.length).toBeLessThanOrEqual(20);
});

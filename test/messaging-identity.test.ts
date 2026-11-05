import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { io } from "../src/install/stdin";
import { plannerParticipant } from "../src/messaging/participants";
import { plannerSessionId, sessionHook } from "../src/messaging/identity";
import { fakeCtx, tmpDir } from "./helpers";

test("planner identity uses session environment and sanitizes ids", () => {
  expect(plannerParticipant({ PACER_PLANNER_SESSION: "claude-code:abc" })).toBe("external:claude-code:abc");
  expect(plannerParticipant({ CODEX_THREAD_ID: "t1" })).toBe("external:codex:t1");
  expect(plannerParticipant({ CLAUDECODE: "1" })).toBe("external:claude-code");
  expect(plannerSessionId("claude-code", "a/b c")).toBe("external:claude-code:a-b-c");
  expect(plannerSessionId("codex", "x".repeat(120))).toBe(`external:codex:${"x".repeat(96)}`);
  expect(plannerSessionId("codex", undefined)).toBe("external:codex");
});

test("SessionStart appends planner identity and preserves status hook output", async () => {
  const dir = tmpDir();
  const file = join(dir, "env");
  writeFileSync(file, "existing=1\n");
  const ctx = fakeCtx({ env: { CLAUDE_ENV_FILE: file } });
  const original = io.readStdin;
  io.readStdin = async () => JSON.stringify({ session_id: "abc", cwd: "/tmp" });
  try {
    const status = await main(["status", "--hook", "claude-code"], ctx);
    const result = await main(["msg", "hook", "session", "--planner", "claude-code"], ctx);
    expect(result.code).toBe(0);
    expect(result.out).toBe(status.out);
    expect(readFileSync(file, "utf8")).toBe("existing=1\nexport PACER_PLANNER_SESSION='claude-code:abc'\n");
  } finally { io.readStdin = original; }
});

test("SessionStart skips executor env writes and fails open on an unwritable file", async () => {
  const dir = tmpDir();
  const file = join(dir, "env");
  const original = io.readStdin;
  io.readStdin = async () => JSON.stringify({ session_id: "abc", cwd: "/tmp" });
  try {
    const executor = fakeCtx({ env: { CLAUDE_ENV_FILE: file, PACER_ROLE: "executor" } });
    expect((await main(["msg", "hook", "session", "--planner", "claude-code"], executor)).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    const bad = fakeCtx({ env: { CLAUDE_ENV_FILE: dir } });
    const status = await main(["status", "--hook", "claude-code"], bad);
    expect((await main(["msg", "hook", "session", "--planner", "claude-code"], bad)).out).toBe(status.out);
  } finally { io.readStdin = original; }
});

test("SessionStart does not export an identity for a different configured planner", async () => {
  const dir = tmpDir(), file = join(dir, "env");
  writeFileSync(file, "existing=1\n");
  const ctx = fakeCtx({ env: { CLAUDE_ENV_FILE: file } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {claude-code: {}, codex: {}}\n");
  expect(await sessionHook(ctx, "claude-code", { session_id: "abc" }, async () => "status")).toEqual({ out: "status" });
  expect(readFileSync(file, "utf8")).toBe("existing=1\n");
});

// The hook runs as the CLI entry module. Importing cli.ts from inside it waited on cli.ts's own
// top-level await, so every Claude Code session start hung until the hook timeout.
test("SessionStart from the CLI entry exits with the status hook output", async () => {
  const dir = tmpDir();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const run = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: dir,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "abc", cwd: dir })),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: home, PACER_HOME: join(home, ".pacer"), PACER_PORT: "1", PACER_NO_UPDATE_CHECK: "1", TZ: process.env.TZ ?? "UTC" },
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    clearTimeout(timer);
    return { code, out, signal: proc.signalCode };
  };
  const status = await run(["status", "--hook", "claude-code"]);
  const session = await run(["msg", "hook", "session", "--planner", "claude-code"]);
  expect(session.signal).toBeNull();
  expect(session.code).toBe(0);
  expect(session.out).toBe(status.out);
}, 40_000);

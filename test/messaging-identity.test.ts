import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { io } from "../src/install/stdin";
import { plannerParticipant } from "../src/messaging/participants";
import { plannerSessionId } from "../src/messaging/identity";
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

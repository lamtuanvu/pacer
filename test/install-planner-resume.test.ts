import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { RESUME_ALLOWED_TOOLS, RESUME_DENIED_TOOLS, resumeArgv, resumeCaller, type PlannerReach, type ResumeSpawn } from "../src/install/planner-resume";
import type { PlannerKind } from "../src/messaging/identity";
import { readActivity } from "../src/activity/log";


/** A PATH with stand-in planner CLIs, so binary resolution succeeds without the real ones. */
const BIN = tmpDir();
for (const name of ["claude", "codex"]) { writeFileSync(join(BIN, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(BIN, name), 0o755); }
const planCtx = (o: Parameters<typeof fakeCtx>[0] = {}) => fakeCtx({ ...o, env: { PATH: BIN, ...(o?.env ?? {}) } });
const CLAUDE_FLAGS = ["-p", "--restricted", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", "Bash,Read,Grep,Glob",
  "--strict-mcp-config", "--allowedTools", ...RESUME_ALLOWED_TOOLS, "--disallowedTools", ...RESUME_DENIED_TOOLS];

const UNKNOWN = "opencode" as unknown as PlannerKind;
const calls: ResumeSpawn[] = [];
// A pid no process has, so no resume lock is held between calls.
const recorder = (o: ResumeSpawn) => { calls.push(o); return 2147483646; };
const noPid = (o: ResumeSpawn) => { calls.push(o); return undefined; };
const boom = (o: ResumeSpawn) => { calls.push(o); throw new Error("spawn refused"); };
const activity = (ctx: ReturnType<typeof fakeCtx>) => readActivity(ctx, {}).entries;

test("builds the Claude Code argv", () => {
  expect(resumeArgv("claude-code", "a1b2", "review task t-1")).toEqual(["claude", "--resume=a1b2", ...CLAUDE_FLAGS, "--", "review task t-1"]);
});

test("builds the Codex argv", () => {
  expect(resumeArgv("codex", "th-9", "review task t-1")).toEqual(["codex", "exec", "resume", "--", "th-9", "review task t-1"]);
});

test("a session id that could inject flags is refused", () => {
  for (const session of ["-x", "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "a b", "a:b", `.${"a".repeat(128)}`]) {
    expect(resumeArgv("claude-code", session, "review")).toBeNull();
    expect(resumeArgv("codex", session, "review")).toBeNull();
  }
  expect(resumeArgv("claude-code", `a${"b".repeat(127)}`, "review")).not.toBeNull();
});

test("a prompt that starts with a dash stays after --", () => {
  expect(resumeArgv("claude-code", "a1b2", "-x")).toEqual(["claude", "--resume=a1b2", ...CLAUDE_FLAGS, "--", "-x"]);
  expect(resumeArgv("codex", "th-9", "-")).toEqual(["codex", "exec", "resume", "--", "th-9", "-"]);
});

test("an injected session id is unavailable and records nothing", async () => {
  calls.length = 0;
  const ctx = planCtx();
  const out = await resumeCaller(ctx, { kind: "claude-code", session: "--dangerously-skip-permissions", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder });
  expect(out).toBe("unavailable");
  expect(calls).toEqual([]);
  expect(existsSync(join(ctx.pacerHome, "runs"))).toBe(false);
  expect(activity(ctx)).toEqual([]);
});

test("refuses while the caller is alive", async () => {
  calls.length = 0;
  const ctx = planCtx();
  const out = await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => true, spawn: recorder });
  expect(out).toBe("unavailable");
  expect(calls).toEqual([]);
  expect(existsSync(join(ctx.pacerHome, "runs"))).toBe(false);
});

test("spawns in the caller's cwd with an argument vector", async () => {
  calls.length = 0;
  const ctx = planCtx(), cwd = tmpDir();
  const reach: PlannerReach = { kind: "claude-code", session: "a1b2", cwd };
  expect(await resumeCaller(ctx, reach, "review task t-1", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("resumed");
  expect(await resumeCaller(ctx, reach, "again", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("resumed");
  expect(calls.map(c => c.argv)).toEqual([
    [join(BIN, "claude"), "--resume=a1b2", ...CLAUDE_FLAGS, "--", "review task t-1"],
    [join(BIN, "claude"), "--resume=a1b2", ...CLAUDE_FLAGS, "--", "again"],
  ]);
  for (const c of calls) expect(c.cwd).toBe(cwd);
  expect(calls[0]!.env.PACER_PLANNER_SESSION).toBe("claude-code:a1b2");
  expect(calls[0]!.env.PACER_HOST_SOCKET).toBeUndefined();
  expect(calls[0]!.env.HOME).toBe(ctx.home);
  expect(calls[0]!.env.PACER_HOME).toBe(ctx.pacerHome);
  expect(calls.map(c => c.log)).toEqual([
    join(ctx.pacerHome, "runs", "caller-a1b2", "1.log"),
    join(ctx.pacerHome, "runs", "caller-a1b2", "2.log"),
  ]);
  for (const log of calls.map(c => c.log)) expect(existsSync(log)).toBe(true);
  expect(readActivity(ctx, {}).entries[0]).toMatchObject({ kind: "message", level: "info", text: "caller resumed for t-1", taskId: "t-1" });
});

test("the resumed environment names the task it was resumed for", async () => {
  calls.length = 0;
  const ctx = planCtx();
  const reach: PlannerReach = { kind: "claude-code", session: "a1b2", cwd: tmpDir() };
  expect(await resumeCaller(ctx, reach, "review", { task: "t-42", isAlive: async () => false, spawn: recorder })).toBe("resumed");
  expect(calls[0]!.env.PACER_CALLER_RESUME).toBe("t-42");
});

test("executor state and secrets stay out of the resumed environment", async () => {
  calls.length = 0;
  const ctx = planCtx({ env: {
    PACER_ROLE: "executor", PACER_TASK_ID: "t-9", PACER_WORK_GRANT: "grant", PACER_RUN_DIR: "/run/x",
    PACER_REPORT_TOKEN: "rep", PACER_TRANSCRIPT_REPORT: "/run/x/report", PACER_AUTH_TOKEN: "auth",
    PACER_HOST_SOCKET: "/sock", PACER_INTERNAL_TOKEN: "core-secret", PACER_HOST_SOCKET_KEY: "owner-key",
    CLAUDE_CODE_SESSION_ID: "other", CODEX_THREAD_ID: "other-thread",
    PACER_ADMISSION_ID: "adm", PACER_ADMISSION_SIGNATURE: "sig", PACER_COMPLETION_NONCE: "nonce", CLAUDE_CODE_PLUGIN_DIRS: "/plugins",
  } });
  expect(await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("resumed");
  const env = calls[0]!.env;
  for (const k of ["PACER_ROLE", "PACER_TASK_ID", "PACER_WORK_GRANT", "PACER_RUN_DIR", "PACER_REPORT_TOKEN",
    "PACER_TRANSCRIPT_REPORT", "PACER_AUTH_TOKEN", "PACER_HOST_SOCKET", "PACER_INTERNAL_TOKEN",
    "PACER_HOST_SOCKET_KEY", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID",
    "PACER_ADMISSION_ID", "PACER_ADMISSION_SIGNATURE", "PACER_COMPLETION_NONCE", "CLAUDE_CODE_PLUGIN_DIRS"]) expect(env[k]).toBeUndefined();
  expect(env.PACER_PLANNER_SESSION).toBe("claude-code:a1b2");
  expect(env.PACER_PORT).toBe(ctx.env.PACER_PORT);
});

test("an unusable cwd is unavailable and records nothing", async () => {
  calls.length = 0;
  const ctx = planCtx();
  const missing = join(tmpDir(), "nope");
  expect(await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: missing }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("unavailable");
  expect(await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: "relative/dir" }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("unavailable");
  expect(calls).toEqual([]);
  expect(existsSync(join(ctx.pacerHome, "runs"))).toBe(false);
  expect(activity(ctx)).toEqual([]);
});

test("a spawn without a pid records nothing", async () => {
  calls.length = 0;
  const ctx = planCtx();
  const out = await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: noPid });
  expect(out).toBe("unavailable");
  expect(calls).toHaveLength(1);
  expect(activity(ctx)).toEqual([]);
  expect(readFileSync(calls[0]!.log, "utf8")).toMatch(/spawn/i);
});

test("a throwing spawner is unavailable and records nothing", async () => {
  calls.length = 0;
  const ctx = planCtx();
  const out = await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: boom });
  expect(out).toBe("unavailable");
  expect(activity(ctx)).toEqual([]);
  expect(readFileSync(calls[0]!.log, "utf8")).toMatch(/spawn refused/);
});

test("unknown planner kinds are unavailable", async () => {
  calls.length = 0;
  expect(resumeArgv(UNKNOWN, "a1b2", "review")).toBeNull();
  expect(resumeArgv("claude-code", "", "review")).toBeNull();
  const ctx = planCtx();
  const out = await resumeCaller(ctx, { kind: UNKNOWN, session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder });
  expect(out).toBe("unavailable");
  expect(calls).toEqual([]);
});

test("a second resume waits while the first resumed turn still runs", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  try {
    calls.length = 0;
    const ctx = planCtx(), reach: PlannerReach = { kind: "claude-code", session: "lock1", cwd: tmpDir() };
    const live = (o: ResumeSpawn) => { calls.push(o); return child.pid; };
    expect(await resumeCaller(ctx, reach, "review", { task: "t-1", isAlive: async () => false, spawn: live })).toBe("resumed");
    expect(await resumeCaller(ctx, reach, "review", { task: "t-1", isAlive: async () => false, spawn: live })).toBe("busy");
    child.kill(); await child.exited;
    expect(await resumeCaller(ctx, reach, "review", { task: "t-1", isAlive: async () => false, spawn: live })).toBe("resumed");
    expect(calls).toHaveLength(2);
  } finally { child.kill(); }
});

test("a planner CLI missing from the login PATH is unavailable", async () => {
  calls.length = 0;
  const ctx = fakeCtx({ env: { PATH: tmpDir() } });
  expect(await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("unavailable");
  expect(calls).toHaveLength(0);
});

test("the resumed turn may only read and record a decision", () => {
  const argv = resumeArgv("claude-code", "a1b2", "review")!;
  const allowed = argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"));
  expect(allowed).toEqual(["Bash(pacer review:*)", "Bash(pacer msg inbox:*)", "Bash(pacer msg read:*)", "Bash(pacer msg send:*)",
    "Bash(pacer msg log:*)", "Bash(pacer tasks:*)", "Bash(pacer wait:*)", "Bash(pacer task request-review:*)", "Read", "Grep", "Glob"]);
  expect(allowed.some(t => t === "Bash(pacer:*)" || t.includes("delegate"))).toBe(false);
  for (const flag of ["--strict-mcp-config", "mcp__*", "Agent", "Edit", "Write"]) expect(argv).toContain(flag);
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  expect(argv).toContain("--restricted");
  expect(argv).not.toContain("--setting-sources");
  expect(argv[argv.indexOf("--tools") + 1]).toBe("Bash,Read,Grep,Glob");
});

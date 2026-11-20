import { expect, spyOn, test, afterEach } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { CallerReach } from "../src/messaging/caller-reach";
import * as callerReach from "../src/messaging/caller-reach";
import * as callerPing from "../src/exec/orca/caller-ping";
import * as plannerResume from "../src/install/planner-resume";
import { setResumeEnabled } from "../src/serve/caller-wake";
import * as caller_wake from "../src/serve/caller-wake";
import { createTask, updateTask } from "../src/tasks/store";
import { join } from "node:path";

afterEach(() => setResumeEnabled(true));
import { callerWake } from "../src/serve/caller-wake";

test("an orca reach is pinged through pingOrcaCaller", async () => {
  const ctx = fakeCtx();
  const reach: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "orca", handle: "handle-1" }, at: 1 };
  const spy = spyOn(callerPing, "pingOrcaCaller").mockResolvedValue("sent");
  try {
    const result = await callerWake(ctx, reach, "text-1");
    expect(spy).toHaveBeenCalledWith(ctx, "handle-1", "text-1");
    expect(result).toBe("sent");
  } finally {
    spy.mockRestore();
  }
});

test("a non-orca reach is unavailable", async () => {
  const ctx = fakeCtx();
  const tmux: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "tmux", pane: "%1" }, at: 1 };
  const uncontrolled: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "uncontrolled" }, at: 1 };
  const spy = spyOn(callerPing, "pingOrcaCaller").mockResolvedValue("sent");
  try {
    expect(await callerWake(ctx, tmux, "t")).toBe("unavailable");
    expect(await callerWake(ctx, uncontrolled, "t")).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("an error becomes unavailable", async () => {
  const ctx = fakeCtx();
  const reach: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "orca", handle: "handle-1" }, at: 1 };
  const spy = spyOn(callerPing, "pingOrcaCaller").mockRejectedValue(new Error("boom"));
  try {
    expect(await callerWake(ctx, reach, "t")).toBe("unavailable");
  } finally {
    spy.mockRestore();
  }
});

const claudeReach = (): CallerReach => ({ participant: "external:claude-code:s1", session: "s1", cwd: tmpDir(), terminal: { kind: "uncontrolled" }, at: 1 });

/** Resume with its preconditions met, unless a test overrides one. */
async function resumeWith(o: { reach?: CallerReach; wrote?: boolean; admitted?: boolean; open?: boolean; alive?: "alive" | "gone" | "unknown" } = {}) {
  const reach = o.reach ?? claudeReach();
  const wrote = spyOn(caller_wake.resumeGuards, "executorWroteCallerCwd").mockReturnValue(o.wrote ?? false);
  const admitted = spyOn(caller_wake.resumeGuards, "plannerAdmitted").mockResolvedValue(o.admitted ?? true);
  const open = spyOn(caller_wake.resumeGuards, "plannerOpenInCwd").mockResolvedValue(o.open ?? false);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue(o.alive ?? "gone");
  const resumeSpy = spyOn(plannerResume, "resumeCaller").mockResolvedValue("resumed");
  try {
    const out = await callerWake(fakeCtx(), reach, "text", "resume", "task-9");
    return { out, calls: resumeSpy.mock.calls, isAlive: resumeSpy.mock.calls[0]?.[3].isAlive, aliveSpy };
  } finally { wrote.mockRestore(); admitted.mockRestore(); open.mockRestore(); aliveSpy.mockRestore(); resumeSpy.mockRestore(); }
}

test("a closed Claude Code caller is resumed with its session and the task id", async () => {
  const reach = claudeReach();
  const { out, calls } = await resumeWith({ reach });
  expect(out).toBe("resumed");
  expect(calls[0]![1]).toEqual({ kind: "claude-code", session: "s1", cwd: reach.cwd });
  expect(calls[0]![3].task).toBe("task-9");
  expect(calls[0]![2]).toStartWith(caller_wake.RESUME_PREAMBLE);
});

test("a planner reopened in the caller folder makes the resume wait", async () => {
  const { out, calls } = await resumeWith({ open: true });
  expect(out).toBe("busy");
  expect(calls).toHaveLength(0);
});

test("a Claude Code process working in the caller folder counts as open", async () => {
  const cwd = tmpDir(), other = tmpDir();
  const run = (cwdOfClaude: string) => async (argv: string[]) => argv[0] === "ps"
    ? { code: 0, stdout: "  101 /usr/bin/zsh /usr/bin/zsh -l\n  202 /opt/homebrew/bin/claude claude\n", stderr: "" }
    : { code: 0, stdout: `p202\nfcwd\nn${cwdOfClaude}\n`, stderr: "" };
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: run(cwd) as never }, cwd)).toBe(true);
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: run(other) as never }, cwd)).toBe(false);
  // A process list that cannot be read fails safe: treat the planner as possibly open.
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: (async () => ({ code: 1, stdout: "", stderr: "" })) as never }, cwd)).toBe(true);
});

test("a session reopened by id, from a subfolder, through npm, or with a fresh transcript counts as open", async () => {
  const cwd = tmpDir(), sub = join(cwd, "pkg");
  require("node:fs").mkdirSync(sub);
  const ps = (line: string, lsofDir: string | null) => (async (argv: string[]) => argv[0] === "ps"
    ? { code: 0, stdout: `${line}\n`, stderr: "" }
    : lsofDir === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `p1\nn${lsofDir}\n`, stderr: "" }) as never;
  const other = tmpDir();
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: ps("  7 /opt/homebrew/bin/claude claude --resume s1", other) }, cwd, "s1")).toBe(true);
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: ps("  7 /opt/homebrew/bin/claude claude --resume s1", other) }, cwd, "claude-code:s1")).toBe(true);
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: ps("  7 /opt/homebrew/bin/claude claude", sub) }, cwd, "s1")).toBe(true);
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: ps("  7 node node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", cwd) }, cwd, "s1")).toBe(true);
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: ps("  7 /opt/homebrew/bin/claude claude", null) }, cwd, "s1")).toBe(true);
  expect(await caller_wake.plannerOpenInCwd({ ...fakeCtx(), run: ps("  7 /opt/homebrew/bin/claude claude", other) }, cwd, "s1")).toBe(false);
  const ctx = fakeCtx(), project = join(ctx.home, ".claude", "projects", "-x");
  require("node:fs").mkdirSync(project, { recursive: true });
  require("node:fs").writeFileSync(join(project, "s1.jsonl"), "{}\n");
  expect(await caller_wake.plannerOpenInCwd({ ...ctx, run: ps("  1 /usr/bin/zsh zsh", other) }, cwd, "s1")).toBe(true);
});

test("another in-place task of the same caller also blocks the resume", () => {
  const ctx = fakeCtx(), callerCwd = tmpDir(), elsewhere = tmpDir();
  const own = createTask(ctx, { brief: { goal: "a", repo: elsewhere }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, own.id, x => { x.state = "done"; x.origin = "external:claude-code:s1"; x.placement = { requested: "new", mode: "new" } as typeof x.placement; });
  expect(caller_wake.executorWroteCallerCwd(ctx, own.id, callerCwd)).toBe(false);
  const sibling = createTask(ctx, { brief: { goal: "b", repo: callerCwd }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, sibling.id, x => { x.state = "running"; x.origin = "external:claude-code:s1"; x.placement = { requested: "current", mode: "current" } as typeof x.placement; });
  expect(caller_wake.executorWroteCallerCwd(ctx, own.id, callerCwd)).toBe(true);
});

test("resume is refused for Codex and unknown planners, an executor-written checkout, and an exhausted planner", async () => {
  for (const participant of ["external:codex:th-9", "external:opencode:x"])
    expect((await resumeWith({ reach: { ...claudeReach(), participant } })).out).toBe("unavailable");
  expect((await resumeWith({ wrote: true })).out).toBe("unavailable");
  expect((await resumeWith({ admitted: false })).out).toBe("unavailable");
  expect((await resumeWith({ reach: { ...claudeReach(), session: undefined } })).out).toBe("unavailable");
});

test("the generic Claude Code participant is resumed by the session its reach recorded", async () => {
  const { out, calls } = await resumeWith({ reach: { ...claudeReach(), participant: "external:claude-code" } });
  expect(out).toBe("resumed");
  expect(calls[0]![1].session).toBe("s1");
});

test("switching resume off falls through to notification", async () => {
  setResumeEnabled(false);
  expect((await resumeWith()).out).toBe("unavailable");
});

test("the executor-written check covers the task's worktree and an in-place run", () => {
  const ctx = fakeCtx(), shared = tmpDir(), elsewhere = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo: shared }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.placement = { requested: "current", mode: "current" } as typeof x.placement; });
  expect(caller_wake.executorWroteCallerCwd(ctx, t.id, shared)).toBe(true);
  expect(caller_wake.executorWroteCallerCwd(ctx, t.id, elsewhere)).toBe(false);
  updateTask(ctx, t.id, x => { x.placement = { requested: "new", mode: "new" } as typeof x.placement; x.worktree = join(shared, "wt"); });
  expect(caller_wake.executorWroteCallerCwd(ctx, t.id, shared)).toBe(true);
  expect(caller_wake.executorWroteCallerCwd(ctx, "missing", elsewhere)).toBe(true);
});

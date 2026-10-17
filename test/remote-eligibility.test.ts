import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { remoteExclusion } from "../src/remote/eligibility";
import { route } from "../src/core/routing";
import { runTask } from "../src/tasks/runner";
import { createTask, updateTask } from "../src/tasks/store";
import type { Status } from "../src/engine/status";
import { fakeCtx } from "./helpers";

const strategy = (repos: Record<string, string> = { "github.com/o/r": "~/src/r" }) => validateStrategy({
  accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code",
  hosts: { box: { ssh: "box-ssh", repos } },
  pacing: { policy: "priority", order: ["codex@box", "codex"] },
  routing: [{ default: ["codex@box", "codex"] }],
}, "test");
const task = { repo: "/repo", placement: "new" as const };
const origin = async () => ({ code: 0, stdout: "git@github.com:O/R.git\n", stderr: "" });

test("remote exclusions carry exact reasons", async () => {
  const ctx = fakeCtx({ run: origin }), s = strategy();
  expect(await remoteExclusion(ctx, s, "codex@box", task, { reachable: async () => false })).toBe("host box unreachable");
  expect(await remoteExclusion(ctx, strategy({}), "codex@box", task, { reachable: async () => true })).toBe("repo not set up on box (add hosts.box.repos.github.com/o/r)");
  expect(await remoteExclusion(ctx, s, "codex@box", { ...task, placement: "current" }, { reachable: async () => true })).toBe("remote runners need a new worktree");
  expect(await remoteExclusion(ctx, s, "codex@box", task, { reachable: async () => true, running: () => 2 })).toBe("box busy (2/2)");
});

test("eligible remote and local runners have no exclusion", async () => {
  const ctx = fakeCtx({ run: origin }), s = strategy();
  expect(await remoteExclusion(ctx, s, "codex@box", task, { reachable: async () => true, running: () => 1 })).toBeNull();
  expect(await remoteExclusion(ctx, s, "codex", task, { reachable: async () => { throw Error("must not probe local"); } })).toBeNull();
});

test("missing and noncanonical origins are excluded", async () => {
  for (const stdout of ["", "/local/repo"]) {
    const ctx = fakeCtx({ run: async () => ({ code: stdout ? 0 : 128, stdout, stderr: "" }) });
    expect(await remoteExclusion(ctx, strategy(), "codex@box", task, { reachable: async () => true })).toBe("repo not set up on box (add hosts.box.repos.<key>)");
  }
});

test("reachability is cached in memory and on disk for sixty seconds", async () => {
  const ctx = fakeCtx({ now: 1000 });
  let probes = 0;
  ctx.run = async argv => {
    if (argv[0] !== "ssh") return origin();
    probes++;
    return { code: 255, stdout: "", stderr: "offline" };
  };
  expect(await remoteExclusion(ctx, strategy(), "codex@box", task)).toBe("host box unreachable");
  expect(await remoteExclusion({ ...ctx, now: 1059 }, strategy(), "codex@box", task)).toBe("host box unreachable");
  expect(probes).toBe(1);
  const cache = JSON.parse(readFileSync(join(ctx.pacerHome, "cache/hosts.json"), "utf8"));
  const other = fakeCtx({ now: 1059, run: ctx.run });
  mkdirSync(join(other.pacerHome, "cache"), { recursive: true });
  writeFileSync(join(other.pacerHome, "cache/hosts.json"), JSON.stringify(cache));
  expect(await remoteExclusion(other, strategy(), "codex@box", task)).toBe("host box unreachable");
  expect(probes).toBe(1);
  await remoteExclusion({ ...ctx, now: 1060 }, strategy(), "codex@box", task);
  expect(probes).toBe(2);
});

test("busy host counts only running tasks with the stored host alias", async () => {
  const ctx = fakeCtx({ run: origin });
  for (const [state, host] of [["running", "box"], ["running", "box"], ["done", "box"], ["running", "other"]] as const) {
    const t = createTask(ctx, { brief: { goal: "other", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, t.id, t => { t.state = state; t.run = { dir: "r", attempt: 1, executor: `codex@${host}`, startedAt: 1, mode: "new", workdir: "w", logFile: "l", ...{ host } }; });
  }
  expect(await remoteExclusion(ctx, strategy(), "codex@box", task, { reachable: async () => true })).toBe("Codex busy (2/2)");
});

test("route without a task checks reachability only", async () => {
  const ctx = fakeCtx({ run: async argv => ({ code: argv[0] === "ssh" ? 0 : 127, stdout: "", stderr: "" }) });
  const result = await route(ctx, null, strategy({}));
  expect(result.ranked.map(r => r.id)).toContain("codex@box");
  const down = await route(fakeCtx(), null, strategy());
  expect(down.excluded).toContainEqual({ id: "codex@box", account: "codex", reason: "host box unreachable" });
});

test("runner falls back from an unreachable remote and records the reason in the attempt log", async () => {
  const ctx = fakeCtx(), s = strategy();
  const t = createTask(ctx, { brief: { goal: "work", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const log = join(ctx.home, "attempt.log"), calls: string[] = [];
  const st: Status = { generatedAt: ctx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: false,
    providers: ["codex@box", "codex"].map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })), executors: { ranked: [], excluded: [] } };
  const result = await runTask(ctx, t.id, {
    loadStrategy: () => s, computeStatus: async () => st, verifyRepo: async () => ({ files: "" }),
    runAttempt: async (_ctx, cfg) => {
      calls.push(cfg.id); writeFileSync(log, "agent output\n");
      return { exec: { code: 0, stdout: "done", stderr: "", timedOut: false }, report: "done",
        attempt: { executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log } };
    },
  });
  expect(calls).toEqual(["codex"]);
  expect(result.state).toBe("done");
  expect(result.attempts.map(a => a.executor)).toEqual(["codex"]);
  expect(readFileSync(result.attempts[0].log, "utf8")).toContain("host box unreachable");
  expect(result.result?.report).toContain("host box unreachable");
});

test("host cache hides SSH usernames and invalidates changed SSH targets", async () => {
  let up = true, probes = 0;
  const ctx = fakeCtx({ run: async argv => {
    if (argv[0] !== "ssh") return origin();
    probes++;
    return { code: up ? 0 : 255, stdout: "", stderr: "" };
  } });
  const s = strategy(); s.hosts.box.ssh = "private-user@box-ssh";
  expect(await remoteExclusion(ctx, s, "codex@box", task)).toBeNull();
  expect(readFileSync(join(ctx.pacerHome, "cache/hosts.json"), "utf8")).not.toContain("private-user");
  up = false; s.hosts.box.ssh = "other-target";
  expect(await remoteExclusion(ctx, s, "codex@box", task)).toBe("host box unreachable");
  expect(probes).toBe(2);
});

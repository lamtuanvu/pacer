import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { callOp } from "../src/api/ops";
import type { Job } from "../src/jobs/registry";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx(), ssh: string[][] = [];
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code",
    hosts: { devbox: { ssh: "devbox", repos: { "github.com/o/r": "~/src/r" } } },
    routing: [{ default: ["codex"] }],
  }));
  ctx.run = async argv => {
    if (argv[0] === "ssh") ssh.push(argv);
    return { code: 0, stderr: "", stdout: argv.includes("get-url") ? "https://github.com/o/r.git" : argv.includes("rev-parse") ? "abc123" : "" };
  };
  const task = (state: "done" | "running", received: boolean) => {
    const t = createTask(ctx, { brief: { goal: "cleanup", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, t.id, t => {
      t.state = state; t.review = { accepted: true, at: ctx.now, kind: null, note: null };
      t.run = { host: "devbox", mode: "new", remoteWorktree: `~/.pacer-remote/worktrees/${t.id}`, remoteDir: `~/.pacer-remote/runs/${t.id}/1`, remoteBranch: `pacer/${t.id}`, transferredHead: received ? "abc123" : undefined,
        workdir: "unused", dir: "unused", attempt: 1, executor: "codex@devbox", startedAt: 1, logFile: "unused" };
    });
    return t.id;
  };
  return { ctx, ssh, task };
}

test("cleanup dry run includes removable, active and untransferred branches without SSH", async () => {
  const { ctx, ssh, task } = fixture();
  const accepted = task("done", true), running = task("running", false), kept = task("done", false);
  const result = await callOp(ctx, "host.clean", { alias: "devbox", dry_run: true }) as { worktrees: unknown[] };
  expect(result.worktrees).toEqual(expect.arrayContaining([
    { branch: `pacer/${accepted}`, state: "done", fate: "will remove" },
    { branch: `pacer/${running}`, state: "running", fate: "in use" },
    { branch: `pacer/${kept}`, state: "done", fate: "kept" },
  ]));
  expect(result.worktrees).toHaveLength(3);
  expect(ssh).toEqual([]);
  const { job } = await callOp(ctx, "host.clean", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("passed");
  expect(ssh).toHaveLength(2);
  expect(ssh.every(a => !a.at(-1)!.includes(`pacer/${running}`))).toBe(true);
  expect(ssh.find(a => a.at(-1)!.includes(kept))?.at(-1)).toEndWith("''");
});

test("host terminal sends SSH argv to the terminal opener", async () => {
  const { ctx } = fixture(), calls: unknown[] = [];
  expect(await callOp(ctx, "host.terminal", { alias: "devbox" }, { openInTerminal: async (_ctx, options) => {
    calls.push(options); return { opened: true, target: "terminal", command: "ssh devbox" };
  } })).toEqual({ opened: true, target: "terminal", command: "ssh devbox" });
  expect(calls).toEqual([{ argv: ["ssh", "devbox"], title: "SSH devbox" }]);
});

test("host removal names a disabled configured executor reference", async () => {
  const { ctx } = fixture();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code",
    hosts: { devbox: { ssh: "devbox" } }, runners: { "codex@devbox": { enabled: false } }, routing: [{ default: ["codex"] }],
  }));
  await expect(callOp(ctx, "host.remove", { alias: "devbox" })).rejects.toMatchObject({ code: "conflict", message: "devbox is used by codex@devbox" });
});

test("cleanup job reports remote removal failures", async () => {
  const { ctx, task } = fixture(), run = ctx.run;
  task("done", true);
  ctx.run = async (...args) => args[0][0] === "ssh" ? { code: 255, stdout: "", stderr: "unreachable" } : run(...args);
  const { job } = await callOp(ctx, "host.clean", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps[0]).toMatchObject({ state: "failed", detail: expect.stringContaining("remote cleanup failed") });
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { runDir } from "../src/exec/direct";
import { superviseTask } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { startRun } from "../src/supervisor/run";
import { resetHandoverState } from "../src/tasks/handover";
import { registerWork, issueWorkGrant, authorizeWorkGrant } from "../src/dispatch/work";
import { issueEnforcementToken, authorizeEnforcementToken } from "../src/dispatch/enforcement-token";
import { dispatchDatabase } from "../src/dispatch/store";
import { readActivity } from "../src/activity/log";
import { currentVersion } from "../src/update/version";
import { fakeCtx, tmpDir } from "./helpers";

const DEAD = 2 ** 22 + 12345;
const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, cursor: {} } }, "/x");
const deps = { loadStrategy: () => strategy, computeStatus: async () => { throw new Error("a handed-over resume must not rank executors"); }, verifyRepo: async () => ({ files: "(no changes)" }) };
afterEach(() => resetHandoverState());

function handedOver(script: string) {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "cursor", timeoutS: 600 });
  const dir = runDir(ctx, t.id, 1), startedAt = Date.now() / 1000;
  startRun({ dir, argv: ["sh", "-c", script], cwd: repo, env: { PATH: process.env.PATH } });
  updateTask(ctx, t.id, x => {
    x.state = "running"; x.executor = "cursor"; x.backend = "direct"; x.attemptStartedAt = startedAt; x.runnerPacer = "0.13.0";
    x.run = { dir, attempt: 1, executor: "cursor", startedAt, mode: "current", workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.cursor.log`) };
    x.handover = { protocol: 1, pacer: "0.13.0", identity: { pid: DEAD, bootId: "old", birth: "1" }, state: "handed-over", committedAt: ctx.now };
  });
  return { ctx, id: t.id, dir };
}

test("the sweep starts a replacement at once, but only once per handover", async () => {
  const { ctx, id } = handedOver("sleep 5");
  updateTask(ctx, id, x => { x.resumeSpawnedAt = ctx.now - 5; });
  const spawned: string[] = [];
  const spawn = (_c: unknown, task: string) => { spawned.push(task); return 1; };
  await superviseTask(ctx, id, spawn);
  expect(spawned).toEqual([id]);
  expect(readTask(ctx, id)?.handover?.replacementAt).toBe(ctx.now);
  await superviseTask({ ...ctx, now: ctx.now + 5 }, id, spawn);
  expect(spawned).toEqual([id]);
  await superviseTask({ ...ctx, now: ctx.now + 60 }, id, spawn);
  expect(spawned).toEqual([id, id]);
});

test("a handed-over strict task keeps one attempt, its guard token and its grant across a version bump", async () => {
  const { ctx, id } = handedOver("sleep 1.5; echo resumed-output");
  registerWork(ctx, id, { allowDelegation: true });
  const token = issueEnforcementToken(ctx, id, 1), grant = issueWorkGrant(ctx, id, 1);
  const running = runTask(ctx, id, deps);
  await Bun.sleep(500);
  const mid = readTask(ctx, id)!;
  expect(mid.state).toBe("running");
  expect(mid.attempts).toHaveLength(0);
  expect(mid.run?.attempt).toBe(1);
  expect(mid.runnerPacer).toBe(currentVersion());
  expect(mid.handover).toMatchObject({ pacer: currentVersion(), identity: { pid: process.pid } });
  expect(mid.handover?.state).toBeUndefined();
  expect(() => authorizeEnforcementToken(ctx, token)).not.toThrow();
  expect(() => authorizeWorkGrant(ctx, grant)).not.toThrow();
  const done = await running;
  expect(done.attempts).toHaveLength(1);
  expect(done.result?.report).toContain("resumed-output");
  expect(done.handover).toBeUndefined();
  const kinds = dispatchDatabase(ctx).query<{ kind: string }, [string]>("SELECT kind FROM work_events WHERE task_id=?").all(id).map(r => r.kind);
  expect(kinds).not.toContain("enforcement.checked");
  expect(readActivity(ctx, { taskId: id }).entries.map(e => e.text)).toContain(`Reattached on v${currentVersion()}`);
});

test("a guard failure written before the handover is recorded once after it", async () => {
  const { ctx, id } = handedOver("sleep 0.5");
  registerWork(ctx, id);
  dispatchDatabase(ctx).query("INSERT INTO work_decisions(task_id,attempt,data) VALUES(?,?,?)").run(id, 1, "{}");
  issueEnforcementToken(ctx, id, 1);
  const markerDir = join(ctx.pacerHome, "guard-failures"), marker = join(markerDir, `${id}-1`);
  mkdirSync(markerDir, { recursive: true, mode: 0o700 }); writeFileSync(marker, "", { mode: 0o600 });
  await runTask(ctx, id, deps);
  const lost = dispatchDatabase(ctx).query<{ kind: string }, [string]>("SELECT kind FROM work_events WHERE task_id=? AND kind='enforcement.lost'").all(id);
  expect(lost).toHaveLength(1);
  expect(existsSync(marker)).toBe(false);
});

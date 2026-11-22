import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pumpOnce, defaultPumpDeps, type PumpDeps } from "../src/link/pump";
import { readLatest } from "../src/link/store";
import { latestPath } from "../src/link/paths";
import { reduce } from "../src/link/envelope";
import { writeJsonAtomic } from "../src/fsutil";
import { selfCommand, type SpawnRunner } from "../src/tasks/api";
import { updateTask, readTask } from "../src/tasks/store";
import { reserveDispatch } from "../src/dispatch/runtime";
import { runDecision, ladderEngine } from "../src/dispatch/engines";
import { candidate, request } from "./fixtures/dispatch";
import { getWork } from "../src/dispatch/work";
import { boundedJson, dispatchDatabase } from "../src/dispatch/store";
import { defaultEngineDeps, startRun } from "../src/workflow/engine";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Status } from "../src/engine/status";
import { fakeCtx, tmpDir } from "./helpers";

/**
 * Live P2 hang: background-worker pumpOnce called drainQueue(ctx) with no spawn,
 * so queued fanout branches were relaunched as `background-worker.ts _run` and
 * sat forever in kevent (never handling _run). Service selfCommand must be used.
 */

function writeStrategy(ctx: ReturnType<typeof fakeCtx>) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "planner: claude-code",
    "accounts:",
    "  claude: { kind: claude }",
    "  codex: { kind: codex }",
    "runners:",
    "  claude-code: { agent: claude-code, account: claude, max_tasks: 8 }",
    "  codex: { agent: codex, account: codex, max_tasks: 8 }",
    "execution:",
    "  local_max_tasks: 2",
    "",
  ].join("\n"));
}

function setRootMaxConcurrent(ctx: ReturnType<typeof fakeCtx>, rootId: string, n: number) {
  const work = getWork(ctx, rootId)!;
  dispatchDatabase(ctx).query("UPDATE work_nodes SET options=? WHERE task_id=?")
    .run(boundedJson({ ...work.options, maxConcurrent: n }), rootId);
}

function pumpDeps(ctx: ReturnType<typeof fakeCtx>): PumpDeps {
  return {
    ...defaultPumpDeps,
    status: async () => ({
      generatedAt: ctx.now,
      strategy: "test",
      planner: "claude-code",
      mode: "normal",
      disabled: false,
      calendarPace: false,
      providers: [],
      executors: { ranked: [], excluded: [] },
      paused: null,
      modeHold: null,
    } as unknown as Status),
    publish: async (c, events) => {
      let latest = readLatest(c);
      for (const event of events) latest = reduce(latest, event, c.now);
      writeJsonAtomic(latestPath(c), latest);
      return { seq: latest.seq, transports: ["outbox"], errors: [] };
    },
  };
}

describe("pump drain uses service selfCommand for queued fanout branches", () => {
  test("selfCommand under background-worker argv is not the cli _run entry", () => {
    const worker = selfCommand(
      [process.execPath, join(import.meta.dir, "../src/serve/background-worker.ts")],
      process.execPath,
    );
    const service = selfCommand(
      [process.execPath, join(import.meta.dir, "../src/cli.ts")],
      process.execPath,
    );
    expect(worker[1]).toContain("background-worker");
    expect(service[1]).toContain("cli.ts");
    expect(worker[1]).not.toBe(service[1]);
  });

  test("pumpOnce drains a queued work-node fanout branch via opts.spawnRunner (real reservation path)", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const def: WorkflowDef = {
      id: "t/pump-fan",
      version: 1,
      steps: {
        fan: {
          type: "fanout",
          branches: ["x", "y", "z"],
          each: { type: "agent", kind: "tests", prompt: "T {{branch}}" },
          join: "all",
        },
        done: { type: "end" },
      },
      edges: [{ from: "fan", to: "done" }],
      entry: "fan",
    };
    addDefinition(ctx, def, "source");
    const initialSpawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, initialSpawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    setRootMaxConcurrent(ctx, rootId, 2);
    const branches = stepsOfRun(ctx, run.id).filter(s => s.stepId === "fan" && s.branch);
    expect(branches).toHaveLength(3);
    const ids = branches.map(b => b.taskId!);

    // Real reserveDispatch: two running leave the third blocked (admission path).
    const c = candidate("runner", 50);
    const preview = await runDecision(request([c]), ladderEngine);
    expect(reserveDispatch(ctx, ids[0]!, c, preview)).toBe(true);
    updateTask(ctx, ids[0]!, t => { t.state = "running"; });
    expect(reserveDispatch(ctx, ids[1]!, c, preview)).toBe(true);
    updateTask(ctx, ids[1]!, t => { t.state = "running"; });
    expect(reserveDispatch(ctx, ids[2]!, c, preview)).toBe(false);

    // Free a slot and park z as the live hang did: waiting_retry, nextAt past.
    updateTask(ctx, ids[0]!, t => { t.state = "done"; });
    updateTask(ctx, ids[2]!, t => {
      t.state = "queued";
      t.queue = {
        reason: "waiting_retry",
        detail: "Waiting for dispatch capacity or dependencies",
        since: ctx.now,
        position: 1,
        nextAt: ctx.now - 1,
      };
      delete t.executor;
      delete t.runnerPid;
    });

    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => {
      launches.push(id);
      return 4242;
    };

    await pumpOnce(ctx, pumpDeps(ctx), { spawnRunner: spawn });

    expect(launches).toContain(ids[2]!);
    expect(readTask(ctx, ids[2]!)!.state).toBe("running");
    expect(readTask(ctx, ids[2]!)!.runnerPid).toBe(4242);
  });
});

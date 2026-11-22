import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { liveSnapshot } from "../src/api/events";
import { computeStatus } from "../src/engine/status";
import { createTask, updateTask } from "../src/tasks/store";
import { addDefinition, getRun } from "../src/workflow/store";
import { defaultEngineDeps, startRun } from "../src/workflow/engine";
import type { SpawnRunner } from "../src/tasks/api";
import type { WorkflowDef } from "../src/workflow/schema";
import { buildRustProbe, closeRustProbe, readModelCtx, rustSnapshot } from "./read-model-rust-helpers";
import { tmpDir } from "./helpers";

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

function writeStrategy(ctx: ReturnType<typeof readModelCtx>) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "planner: claude-code",
    "providers:",
    "  claude-code: {}",
    "  codex: {}",
    "execution:",
    "  local_max_tasks: 4",
    "",
  ].join("\n"));
}

const chain: WorkflowDef = {
  id: "t/c3-rust-parity",
  version: 1,
  steps: {
    one: { type: "agent", kind: "research", prompt: "One" },
    done: { type: "end" },
  },
  edges: [{ from: "one", to: "done" }],
  entry: "one",
};

describe("I10: TS-vs-Rust parity with workflow-root + orchestrate", () => {
  test("snapshot.machine.used and task.list page/next match", async () => {
    const ctx = readModelCtx();
    writeStrategy(ctx);
    addDefinition(ctx, chain, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;

    const orch = createTask(ctx, {
      brief: { goal: "orch parity", repo: tmpDir() },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, orch.id, t => { t.state = "running"; t.executor = "claude-code"; });

    const ordinary = createTask(ctx, {
      brief: { goal: "ordinary parity", repo: tmpDir() },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, ordinary.id, t => { t.state = "running"; t.executor = "codex"; });

    const { loadStrategy } = await import("../src/config/strategy");
    const statusFn = async (c: typeof ctx) => computeStatus(c, loadStrategy(c));
    const ts = await liveSnapshot(ctx, { status: statusFn });
    expect(ts.snapshot.tasks.every(t => t.kind !== "workflow-root" && t.kind !== "orchestrate")).toBe(true);
    expect(ts.snapshot.tasks.some(t => t.id === rootId)).toBe(false);
    expect(ts.snapshot.machine.used).toBeGreaterThanOrEqual(2);

    const rust = await rustSnapshot(ctx, ts, { status: statusFn }, 3) as {
      snapshot: { machine: { used: number }; tasks: { id: string; kind?: string | null }[] };
    };
    expect(rust.snapshot.machine.used).toBe(ts.snapshot.machine.used);
    expect(rust.snapshot.tasks.every(t => t.kind !== "workflow-root" && t.kind !== "orchestrate")).toBe(true);

    const list = (await callOp(ctx, "task.list", { limit: 50 })) as {
      tasks: { id: string; kind?: string | null }[];
      next: string | null;
    };
    expect(list.tasks.every(t => t.kind !== "workflow-root" && t.kind !== "orchestrate")).toBe(true);
    expect(list.tasks.some(t => t.id === rootId)).toBe(false);
    expect(list.tasks.some(t => t.id === orch.id)).toBe(false);
    expect(list.tasks.some(t => t.id === ordinary.id)).toBe(true);
  });
});

// Orchestrate tasks are hidden from snapshot.tasks but must still occupy local
// machine.used. Regression: snapshotTasks drops kind "orchestrate" before
// buildReadModel, so counting them from the filtered list always saw 0.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { buildReadModel, readModelContext } from "../src/api/read-model";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { createTask, listActiveAndRecentTasks, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

function writeStrategy(ctx: ReturnType<typeof fakeCtx>) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    [
      "planner: claude-code",
      "providers:",
      "  claude-code: {}",
      "  codex: {}",
      "hosts:",
      "  devbox:",
      "    ssh: devbox",
      "    max_tasks: 3",
      "",
    ].join("\n"),
  );
}

describe("snapshot.machine.used counts hidden local orchestrate tasks", () => {
  test("callOp snapshot.get: local orchestrate counts, stays off tasks list; remote does not", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();

    const orch = createTask(ctx, {
      brief: { goal: "orchestrate capacity", repo },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, orch.id, t => {
      t.state = "running";
      t.executor = "claude-code";
    });

    const local = createTask(ctx, {
      brief: { goal: "ordinary local", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, local.id, t => {
      t.state = "running";
      t.executor = "codex";
    });

    const remote = createTask(ctx, {
      brief: { goal: "ordinary remote", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, remote.id, t => {
      t.state = "running";
      t.executor = "codex@devbox";
      t.run = { host: "devbox" } as never;
    });

    const result = (await callOp(ctx, "snapshot.get", {})) as {
      snapshot: { machine: { used: number }; tasks: { id: string; kind?: string | null }[] };
    };
    const { snapshot } = result;

    expect(snapshot.tasks.some(t => t.id === orch.id)).toBe(false);
    expect(snapshot.tasks.every(t => t.kind !== "orchestrate")).toBe(true);
    expect(snapshot.tasks.some(t => t.id === local.id)).toBe(true);
    expect(snapshot.tasks.some(t => t.id === remote.id)).toBe(true);
    // Local orchestrate + local ordinary; remote host-bound task must not count.
    expect(snapshot.machine.used).toBeGreaterThanOrEqual(2);
  });

  test("pump-shaped buildReadModel(snapshotTasks(...)) also counts store orchestrate", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const orch = createTask(ctx, {
      brief: { goal: "orch pump path", repo },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, orch.id, t => {
      t.state = "running";
      t.executor = "claude-code";
    });

    const strategy = loadStrategy(ctx);
    const status = await computeStatus({ ...ctx, readOnly: true }, strategy);
    const context = await readModelContext(ctx);
    // Same call shape as src/link/pump.ts (~439): filtered snapshotTasks list.
    const model = buildReadModel(ctx, {
      status,
      strategy,
      tasks: snapshotTasks(ctx, listActiveAndRecentTasks(ctx)),
      setup: context.setup,
      hosts: Object.values(strategy.hosts),
      signedIn: context.accounts,
    });
    expect(snapshotTasks(ctx, listActiveAndRecentTasks(ctx)).every(t => t.kind !== "orchestrate")).toBe(true);
    expect(model.machine.used).toBeGreaterThanOrEqual(1);
  });
});

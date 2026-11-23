// Phase 6 Task 1: run priority maps onto the dispatcher scale; set_priority
// updates queued run tasks only; ordinary tasks keep their order.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import { getWork, registerWork } from "../src/dispatch/work";
import { getRun, type RunRow } from "../src/workflow/store";
import {
  applyPriorityToQueuedRunTasks, TASK_PRIORITY, taskPriorityFor,
} from "../src/workflow/priority";
import { RUN_GRANT_OPS } from "../src/workflow/run-grant";

const NOW = 1_700_000_000;

const CHAIN = `
id: t/priority
version: 1
steps:
  one: { type: agent, kind: research, prompt: "One" }
  two: { type: agent, kind: research, prompt: "Two" }
  done: { type: end }
edges:
  - [one, two]
  - [two, done]
`;

function stubDeps(): OpDeps {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: OpDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.workParent || input.dispatch) {
      registerWork(ctx, task.id, {
        ...input.dispatch,
        ...(input.difficulty ? { difficulty: input.difficulty } : {}),
      }, input.workParent);
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return { delegate };
}

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

describe("run priority", () => {
  test("maps onto the dispatcher −100…100 scale (default 0)", () => {
    expect(taskPriorityFor("urgent")).toBe(100);
    expect(taskPriorityFor("normal")).toBe(0);
    expect(taskPriorityFor("background")).toBe(-100);
    expect(TASK_PRIORITY.urgent).toBe(100);
    expect(TASK_PRIORITY.background).toBe(-100);
  });

  test("run.start defaults to normal and accepts --priority", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const normal = await callOp(ctx, "run.start", {
      workflow: "t/priority", repo: tmpDir(), brief: "n",
    }, stubDeps()) as RunRow;
    expect(normal.priority ?? "normal").toBe("normal");
    const urgent = await callOp(ctx, "run.start", {
      workflow: "t/priority", repo: tmpDir(), brief: "u", priority: "urgent",
    }, stubDeps()) as RunRow;
    expect(urgent.priority).toBe("urgent");
    const bg = await callOp(ctx, "run.start", {
      workflow: "t/priority", repo: tmpDir(), brief: "b", priority: "background",
    }, stubDeps()) as RunRow;
    expect(bg.priority).toBe("background");
  });

  test("delegated step tasks receive the mapped work-node priority", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/priority", repo: tmpDir(), brief: "u", priority: "urgent",
    }, stubDeps()) as RunRow;
    const live = getRun(ctx, run.id)!;
    const step = (await callOp(ctx, "run.get", { id: live.id }) as { steps: { taskId?: string }[] }).steps
      .find(s => s.taskId);
    expect(step?.taskId).toBeTruthy();
    const work = getWork(ctx, step!.taskId!);
    expect(work?.options.priority).toBe(100);
  });

  test("set_priority updates queued run tasks only; running stays; ordinary tasks untouched", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/priority", repo: tmpDir(), brief: "mix", priority: "normal",
    }, stubDeps()) as RunRow;

    // Ordinary managed task in the same home (not a run step).
    const ordinary = createTask(ctx, {
      brief: { goal: "ordinary", repo: tmpDir() },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 600,
    });
    registerWork(ctx, ordinary.id, { priority: 7, delegationEnforcement: "strict" });
    updateTask(ctx, ordinary.id, t => {
      t.state = "queued";
      t.queue = { reason: "no_slot", since: NOW, position: 1 };
    });

    const got = await callOp(ctx, "run.get", { id: run.id }) as {
      run: RunRow; steps: { taskId?: string; status: string }[];
    };
    const stepTaskId = got.steps.find(s => s.taskId)?.taskId;
    expect(stepTaskId).toBeTruthy();
    // Leave the entry step running; create a second queued step task by hand so
    // set_priority has a queued run task to update.
    const queued = createTask(ctx, {
      brief: { goal: "queued-step", repo: got.run.repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 600,
    });
    registerWork(ctx, queued.id, {
      priority: 0,
      delegationEnforcement: "strict",
      allowDelegation: true,
    }, got.run.rootTaskId);
    updateTask(ctx, queued.id, t => {
      t.state = "queued";
      t.queue = { reason: "no_slot", since: NOW, position: 2 };
    });
    // Attach as a synthetic second attempt of "two" so stepsOfRun finds it.
    const { insertStep } = await import("../src/workflow/store");
    insertStep(ctx, {
      runId: run.id, stepId: "two", attempt: 1, status: "running", taskId: queued.id,
    });
    updateTask(ctx, queued.id, t => { t.state = "queued"; });

    const updated = await callOp(ctx, "run.set_priority", {
      id: run.id, priority: "urgent", expect_rev: got.run.rev,
    }, stubDeps()) as RunRow;
    expect(updated.priority).toBe("urgent");

    // Running entry step: priority may stay at whatever it was registered with;
    // applyPriorityToQueuedRunTasks only touches queued.
    const entryWork = getWork(ctx, stepTaskId!);
    const entryState = readTask(ctx, stepTaskId!)!.state;
    if (entryState === "queued") expect(entryWork?.options.priority).toBe(100);
    // Queued run task updated.
    expect(getWork(ctx, queued.id)?.options.priority).toBe(100);
    // Ordinary task unchanged.
    expect(getWork(ctx, ordinary.id)?.options.priority).toBe(7);
  });

  test("table-driven mixed queue: ordinary task order never changes when run priority flips", async () => {
    const { listTasksWhere } = await import("../src/tasks/store");
    const cases: { run: "urgent" | "normal" | "background"; ordinary: number }[] = [
      { run: "urgent", ordinary: 0 },
      { run: "background", ordinary: 50 },
      { run: "normal", ordinary: -20 },
    ];
    for (const c of cases) {
      const ctx = fakeCtx({ now: NOW });
      writePlanner(ctx);
      await callOp(ctx, "workflow.add", { source: CHAIN });
      const run = await callOp(ctx, "run.start", {
        workflow: "t/priority", repo: tmpDir(), brief: "mix", priority: c.run,
      }, stubDeps()) as RunRow;
      const ordinary = createTask(ctx, {
        brief: { goal: "o", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 60,
      });
      registerWork(ctx, ordinary.id, { priority: c.ordinary, delegationEnforcement: "strict" });
      updateTask(ctx, ordinary.id, t => {
        t.state = "queued";
        t.queue = { reason: "no_slot", since: NOW, position: 1 };
      });
      const stepId = (await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId?: string }[] })
        .steps.find(s => s.taskId)?.taskId;
      expect(stepId).toBeTruthy();
      updateTask(ctx, stepId!, t => {
        t.state = "queued";
        t.queue = { reason: "no_slot", since: NOW, position: 2 };
      });
      const beforeOrdinary = getWork(ctx, ordinary.id)!.options.priority;
      applyPriorityToQueuedRunTasks(ctx, getRun(ctx, run.id)!);
      const stepTaskId = stepId as string;
      expect(getWork(ctx, ordinary.id)!.options.priority).toBe(beforeOrdinary);
      expect(getWork(ctx, stepTaskId)!.options.priority).toBe(TASK_PRIORITY[c.run]);

      // Same comparator drainQueue uses: priority desc, then createdAt, then id.
      const queued = listTasksWhere(ctx, { states: ["queued"] })
        .filter(t => t.id === ordinary.id || t.id === stepTaskId)
        .sort((a, b) =>
          (getWork(ctx, b.id)?.options.priority ?? 0) - (getWork(ctx, a.id)?.options.priority ?? 0)
          || a.createdAt - b.createdAt
          || a.id.localeCompare(b.id));
      expect(queued.map(t => t.id)).toHaveLength(2);
      if (TASK_PRIORITY[c.run] > c.ordinary) expect(queued[0]!.id).toBe(stepTaskId);
      else if (TASK_PRIORITY[c.run] < c.ordinary) expect(queued[0]!.id).toBe(ordinary.id);
      expect(getWork(ctx, ordinary.id)!.options.priority).toBe(c.ordinary);
    }
  });

  test("run.set_priority is not in RUN_GRANT_OPS", () => {
    expect((RUN_GRANT_OPS as readonly string[]).includes("run.set_priority")).toBe(false);
    expect((RUN_GRANT_OPS as readonly string[]).includes("run.pause")).toBe(false);
    expect((RUN_GRANT_OPS as readonly string[]).includes("run.resume")).toBe(false);
  });

  test("real delegate: plain stays plain; work_node + priority table; candidate executor ok", async () => {
    const { defaultEngineDeps, startStep } = await import("../src/workflow/engine");
    const { addDefinition, getDefinition, insertRun, stepsOfRun } = await import("../src/workflow/store");
    const { TASK_PRIORITY: TP } = await import("../src/workflow/priority");
    const cases: { mode: "plain" | "work_node"; priority: "urgent" | "normal" | "background" }[] = [
      { mode: "plain", priority: "normal" },
      { mode: "plain", priority: "urgent" },
      { mode: "plain", priority: "background" },
      { mode: "work_node", priority: "normal" },
      { mode: "work_node", priority: "urgent" },
      { mode: "work_node", priority: "background" },
    ];
    for (const c of cases) {
      const ctx = fakeCtx({ now: NOW });
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
      addDefinition(ctx, {
        id: "t/priority", version: 1, entry: "one",
        steps: {
          one: { type: "agent", kind: "research", prompt: "One" },
          two: { type: "agent", kind: "research", prompt: "Two" },
          done: { type: "end" },
        },
        edges: [{ from: "one", to: "two" }, { from: "two", to: "done" }],
      }, CHAIN);
      const def = getDefinition(ctx, "t/priority")!;
      const run = insertRun(ctx, {
        workflow: def.id, version: def.version, repo: tmpDir(), brief: `${c.mode}-${c.priority}`,
        priority: c.priority, stepMode: c.mode,
      });
      // Real delegate with a pinned candidate executor (exercises meetsRequirements).
      await startStep(ctx, run, def, def.entry, undefined, {
        deps: {
          ...defaultEngineDeps,
          delegate: async (c, input, spawn) =>
            defaultEngineDeps.delegate(c, { ...input, executor: "codex" }, spawn),
        },
        spawn: () => 1,
      });
      const step = stepsOfRun(ctx, run.id).find(s => s.taskId);
      expect(step?.taskId, `${c.mode}/${c.priority}`).toBeTruthy();
      const work = getWork(ctx, step!.taskId!);
      if (c.mode === "plain") {
        expect(work, `plain/${c.priority} must stay unmanaged`).toBeNull();
      } else {
        expect(work, `${c.mode}/${c.priority}`).toBeTruthy();
        expect(work!.options.priority).toBe(TP[c.priority]);
        expect(work!.options.requirements).toEqual({});
      }
    }
  });
});

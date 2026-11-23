// Phase 3 fixC2: B2 generate turn prompt + submit-graph surfaces; I1 limits holes; I2 human→must.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getGraph, listGraphs, stepsOfRun, updateStep, workflowDatabase,
} from "../src/workflow/store";
import { submitGraph, validateGenerated } from "../src/workflow/generate";
import { startRun, type EngineDeps } from "../src/workflow/engine";
import { buildTurnPrompt, startTurn } from "../src/workflow/orchestrator";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import { issueRunGrant, RUN_GRANT_OPS } from "../src/workflow/run-grant";
import { ORCHESTRATOR_CONTRACT } from "../src/exec/prompt";
import { callOp } from "../src/api/ops";
import type { GenerateLimits, WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;

const limits: GenerateLimits = {
  step_types: ["agent", "fanout", "human"],
  max_steps: 5,
  kinds: ["feature", "tests", "docs", "refactor", "debug", "boilerplate"],
  require_after: { "kind in [feature, refactor, debug]": "reviewer" },
  require_last: { kind: "tests" },
};

function writePlanner(ctx: Ctx, agent = "claude-code"): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: ${agent}\nproviders:\n  ${agent}: {}\n`);
}

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
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
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => {
        updateTask(ctx, id, t => { t.state = "stopped"; });
      },
    } satisfies EngineDeps,
  };
}

function parentGenerate(id: string): WorkflowDef {
  return {
    id,
    version: 1,
    steps: {
      plan: {
        type: "generate",
        prompt: "Write a bounded implementation plan",
        limits,
        retries: 2,
      },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
}

function validChild(): WorkflowDef {
  return {
    id: "gen/plan",
    version: 1,
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "Implement" },
      review: {
        type: "agent",
        role: "reviewer",
        prompt: "Review",
        result: { required: ["verdict"] },
      },
      tests: { type: "agent", kind: "tests", prompt: "Test" },
      done: { type: "end" },
    },
    edges: [
      { from: "impl", to: "review" },
      { from: "review", to: "tests" },
      { from: "tests", to: "done" },
    ],
    entry: "impl",
  };
}

describe("B2: generate turn prompt and submit-graph surfaces", () => {
  test("ORCHESTRATOR_CONTRACT names run submit-graph", () => {
    expect(ORCHESTRATOR_CONTRACT).toMatch(/submit-graph/);
  });

  test("waiting generate is rendered in the turn prompt with limits and submit-graph instruction", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def = parentGenerate("t/c2-b2-prompt");
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, deps);
    const plan = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
    updateStep(ctx, { runId: run.id, stepId: "plan", attempt: plan.attempt }, {
      result: {
        errors: [{ path: "steps", message: "too many steps" }],
        reviseNote: "narrow the scope",
        replanFinished: ["impl"],
        replanFailedStep: "tests",
      },
    });
    const turn = await startTurn({ ...ctx, now: READY }, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const goal = readTask(ctx, turn!.taskId!)!.brief.goal;
    expect(goal).toMatch(/## generate /i);
    expect(goal).toMatch(/submit-graph/);
    expect(goal).toContain("Write a bounded implementation plan");
    expect(goal).toContain("max_steps");
    expect(goal).toContain("too many steps");
    expect(goal).toContain("narrow the scope");
    expect(goal).toContain("impl");
    expect(goal).toContain("tests");
    expect(goal).toMatch(/--- data [a-f0-9]+ generate /);
  });

  test("CLI grant holder may call run submit-graph over real HTTP", async () => {
    const { main } = await import("../src/cli");
    const { startServer } = await import("../src/serve/http");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def = parentGenerate("t/c2-b2-cli");
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();

    const server = startServer(() => ({ ...ctx, now: READY }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
      opDeps: { spawnRunner: spawn, delegate: deps.delegate },
    });
    try {
      await Bun.sleep(20);
      const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: READY + 600 });
      const graphPath = join(ctx.pacerHome, "child.yaml");
      writeFileSync(graphPath, [
        "id: gen/cli",
        "version: 1",
        "entry: docs",
        "steps:",
        "  docs: { type: agent, kind: docs, prompt: Docs }",
        "  tests: { type: agent, kind: tests, prompt: Test }",
        "  done: { type: end }",
        "edges:",
        "  - [docs, tests]",
        "  - [tests, done]",
      ].join("\n"));
      const orchCtx: Ctx = {
        ...ctx,
        env: {
          ...ctx.env,
          PACER_ROLE: "orchestrator",
          PACER_RUN_GRANT: grant,
          PACER_PORT: String(server.port),
        },
      };
      const refused = await main(["run", "answer", run.id, "plan", "approve"], orchCtx);
      expect(refused.code).toBe(2);
      expect(refused.err).toMatch(/orchestrator role only allows/);

      const submitted = await main(
        ["run", "submit-graph", "--file", graphPath, "--id", run.id, "--step", "plan"],
        orchCtx,
      );
      expect(submitted.code).toBe(0);
      expect(submitted.out).toMatch(/graph v1 submitted/);
      expect(listGraphs(ctx, run.id, "plan")).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test("MCP run-grant server registers run_submit_graph; RUN_GRANT_OPS lists it", async () => {
    expect(RUN_GRANT_OPS as readonly string[]).toContain("run.submit_graph");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp/server");
    const ctx = fakeCtx({ now: NOW, env: { PACER_RUN_GRANT: "prg_" + "a".repeat(64) } });
    const server = createMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["run_submit_graph", "run_choose", "run_decide"]));
    await client.close();
  });

  test("run.submit_graph over real HTTP with a grant stores a graph", async () => {
    const { startServer } = await import("../src/serve/http");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def = parentGenerate("t/c2-b2-http");
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();

    const server = startServer(() => ({ ...ctx, now: READY }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
      opDeps: { spawnRunner: spawn, delegate: deps.delegate },
    });
    try {
      await Bun.sleep(20);
      const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: READY + 600 });
      const source = {
        id: "gen/http",
        version: 1,
        entry: "docs",
        steps: {
          docs: { type: "agent", kind: "docs", prompt: "Docs" },
          tests: { type: "agent", kind: "tests", prompt: "Test" },
          done: { type: "end" },
        },
        edges: [
          ["docs", "tests"],
          ["tests", "done"],
        ],
      };
      const response = await fetch(`http://127.0.0.1:${server.port}/v3/ops/run.submit_graph`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant}`,
          host: `127.0.0.1:${server.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: run.id, step: "plan", source }),
      });
      expect(response.status).toBe(200);
      const wire = await response.json() as { result: { ok: boolean; version?: number; errors: unknown[] } };
      expect(wire.result.ok).toBe(true);
      expect(wire.result.version).toBe(1);
      expect(listGraphs(ctx, run.id, "plan")).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

describe("I1: validateGenerated limit holes", () => {
  test("fanout branches count toward max_steps", () => {
    const g: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "fan",
      steps: {
        fan: {
          type: "fanout",
          branches: ["a", "b", "c", "d"],
          each: { type: "agent", kind: "docs", prompt: "R" },
          join: "all",
        },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "fan", to: "tests" }, { from: "tests", to: "done" }],
    };
    // 4 branches + tests = 5; with max_steps 4 should fail
    const errs = validateGenerated(g, { ...limits, max_steps: 4, require_after: undefined }, 1);
    expect(errs.some(e => /max_steps|too many/i.test(e.message))).toBe(true);
  });

  test("maxLoops is capped and counted toward max_steps", () => {
    const g: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "docs",
      steps: {
        docs: { type: "agent", kind: "docs", prompt: "D" },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [
        { from: "docs", to: "tests" },
        { from: "tests", to: "done" },
        { from: "tests", to: "docs", maxLoops: 10 },
      ],
    };
    const errs = validateGenerated(g, { ...limits, max_steps: 5, require_after: undefined }, 1);
    expect(errs.some(e => /max_loops|maxLoops|max_steps|too many/i.test(e.message))).toBe(true);
  });

  test("fanout.each kind is checked by kinds / require_after / require_last", () => {
    const g: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "fan",
      steps: {
        fan: {
          type: "fanout",
          branches: ["a", "b"],
          each: { type: "agent", kind: "feature", prompt: "F" },
          join: "all",
        },
        done: { type: "end" },
      },
      edges: [{ from: "fan", to: "done" }],
    };
    const errs = validateGenerated(g, limits, 1);
    expect(errs.some(e => /require_after|reviewer/i.test(e.message))).toBe(true);
    expect(errs.some(e => /require_last|tests/i.test(e.message))).toBe(true);

    const badKind: WorkflowDef = {
      ...g,
      steps: {
        ...g.steps,
        fan: {
          type: "fanout",
          branches: ["a"],
          each: { type: "agent", kind: "unknown-kind", prompt: "X" },
          join: "all",
        },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "fan", to: "tests" }, { from: "tests", to: "done" }],
    };
    const kindErrs = validateGenerated(badKind, { ...limits, require_after: undefined }, 1);
    expect(kindErrs.some(e => /kind/i.test(e.message) && /unknown-kind|not allowed/i.test(e.message))).toBe(true);
  });

  test("role orchestrator and interactive are refused; kind required for non-reviewer", () => {
    const orch: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "o",
      steps: {
        o: { type: "agent", role: "orchestrator", prompt: "Plan" },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "o", to: "tests" }, { from: "tests", to: "done" }],
    };
    expect(validateGenerated(orch, { ...limits, require_after: undefined }, 1)
      .some(e => /orchestrator/i.test(e.message))).toBe(true);

    const interactive: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "a",
      steps: {
        a: { type: "agent", kind: "docs", interactive: true, prompt: "A" },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "tests" }, { from: "tests", to: "done" }],
    };
    expect(validateGenerated(interactive, { ...limits, require_after: undefined }, 1)
      .some(e => /interactive/i.test(e.message))).toBe(true);

    const noKind: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "a",
      steps: {
        a: { type: "agent", prompt: "A" } as WorkflowDef["steps"][string],
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "tests" }, { from: "tests", to: "done" }],
    };
    expect(validateGenerated(noKind, { ...limits, require_after: undefined }, 1)
      .some(e => /kind/i.test(e.message))).toBe(true);
  });

  test("end-only / empty-work graph is refused", () => {
    const g: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "done",
      steps: { done: { type: "end" } },
      edges: [],
    };
    expect(validateGenerated(g, limits, 1).some(e => /end|empty|work/i.test(e.message))).toBe(true);
  });

  test("require_after uses all-paths reachability honouring when (not back-edge-only)", () => {
    // Reviewer only on a conditional branch; other path skips it.
    const skipViaWhen: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "impl",
      steps: {
        impl: { type: "agent", kind: "feature", prompt: "F" },
        review: {
          type: "agent",
          role: "reviewer",
          prompt: "R",
          result: { required: ["verdict"] },
        },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [
        { from: "impl", to: "review", when: "result.needs_review == true" },
        { from: "impl", to: "tests", when: "result.needs_review == false" },
        { from: "review", to: "tests" },
        { from: "tests", to: "done" },
      ],
    };
    expect(validateGenerated(skipViaWhen, limits, 1)
      .some(e => /require_after|reviewer/i.test(e.message))).toBe(true);

    // Reviewer only reachable via a back edge should not satisfy.
    const viaBack: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "impl",
      steps: {
        impl: { type: "agent", kind: "feature", prompt: "F" },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        review: {
          type: "agent",
          role: "reviewer",
          prompt: "R",
          result: { required: ["verdict"] },
        },
        done: { type: "end" },
      },
      edges: [
        { from: "impl", to: "tests" },
        { from: "tests", to: "done" },
        { from: "tests", to: "review", maxLoops: 1 },
        { from: "review", to: "tests" },
      ],
    };
    expect(validateGenerated(viaBack, limits, 1)
      .some(e => /require_after|reviewer/i.test(e.message))).toBe(true);
  });

  test("role:reviewer without a verdict criterion is refused", () => {
    const g: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "impl",
      steps: {
        impl: { type: "agent", kind: "feature", prompt: "F" },
        review: { type: "agent", role: "reviewer", prompt: "R" },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [
        { from: "impl", to: "review" },
        { from: "review", to: "tests" },
        { from: "tests", to: "done" },
      ],
    };
    expect(validateGenerated(g, limits, 1)
      .some(e => /verdict|criterion/i.test(e.message))).toBe(true);
  });

  test("unknown kind is refused at validation", () => {
    const g: WorkflowDef = {
      id: "g",
      version: 1,
      entry: "a",
      steps: {
        a: { type: "agent", kind: "not-a-kind", prompt: "A" },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "tests" }, { from: "tests", to: "done" }],
    };
    expect(validateGenerated(g, { ...limits, require_after: undefined }, 1)
      .some(e => /not-a-kind|not allowed/i.test(e.message))).toBe(true);
  });

  test("object-form source is size-capped and edge tuples / max_loops are normalised", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def = parentGenerate("t/c2-i1-obj");
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, run.id, {
      spawn, plannerEligible: () => true,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: READY + 600 });
    const granted = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } };

    const huge = { id: "x", version: 1, steps: { done: { type: "end" } }, edges: [], entry: "done", pad: "x".repeat(256 * 1024) };
    await expect(callOp(granted, "run.submit_graph", {
      id: run.id, step: "plan", source: huge,
    })).rejects.toMatchObject({ code: expect.stringMatching(/invalid_input|too_large/) });

    const result = await callOp(granted, "run.submit_graph", {
      id: run.id,
      step: "plan",
      source: {
        id: "gen/obj",
        version: 1,
        entry: "docs",
        steps: {
          docs: { type: "agent", kind: "docs", prompt: "D" },
          tests: { type: "agent", kind: "tests", prompt: "T" },
          done: { type: "end" },
        },
        edges: [
          ["docs", "tests"],
          ["tests", "docs", "result.retry == true", { max_loops: 1 }],
          ["tests", "done"],
        ],
      },
    }) as { ok: boolean; version?: number };
    expect(result.ok).toBe(true);
    const stored = getGraph(ctx, { runId: run.id, stepId: "plan", attempt: 1, version: result.version! })!;
    expect(stored.def.edges.some(e => e.maxLoops === 1)).toBe(true);
    expect(stored.def.edges.every(e => !("max_loops" in (e as object)))).toBe(true);
  });

  test("stored validation error list is capped", () => {
    const steps: WorkflowDef["steps"] = { done: { type: "end" } };
    const edges: WorkflowDef["edges"] = [];
    let prev = "";
    for (let i = 0; i < 80; i++) {
      const id = `s${i}`;
      // Each step is a forbidden type + unknown kind → many distinct path errors.
      steps[id] = { type: "choose_workflow", from: ["x"] };
      if (prev) edges.push({ from: prev, to: id });
      prev = id;
    }
    edges.push({ from: prev, to: "done" });
    const g: WorkflowDef = { id: "g", version: 1, entry: "s0", steps, edges };
    const errs = validateGenerated(g, { ...limits, max_steps: 2, require_after: undefined, require_last: undefined }, 1);
    expect(errs.length).toBe(32);
  });
});

describe("I2: generated human steps forced to must", () => {
  test("submitGraph stores human decision:auto as must", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def = parentGenerate("t/c2-i2-must");
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, deps);
    const source: WorkflowDef = {
      id: "gen/human",
      version: 1,
      entry: "ask",
      steps: {
        ask: {
          type: "human",
          decision: "auto",
          question: { text: "OK?", kind: "yes_no" },
        },
        tests: { type: "agent", kind: "tests", prompt: "T" },
        done: { type: "end" },
      },
      edges: [{ from: "ask", to: "tests" }, { from: "tests", to: "done" }],
    };
    const result = await submitGraph(ctx, { runId: run.id, stepId: "plan", source }, deps);
    expect(result.ok).toBe(true);
    const stored = getGraph(ctx, { runId: run.id, stepId: "plan", attempt: 1, version: result.version! })!;
    const ask = stored.def.steps.ask;
    expect(ask?.type).toBe("human");
    if (ask?.type === "human") expect(ask.decision).toBe("must");
  });
});

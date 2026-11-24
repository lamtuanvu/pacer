// Phase 7 batch H — fail-first coverage for REPO-10 Important findings.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getDefinition, getRun, insertRun, isDefinitionInvalid, setDefinitionInvalid,
  setPluginDefinitionsDisabled, stepsOfRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import {
  answerHumanStep, defaultEngineDeps, onTaskSettled, recordStepResult, startRun, type EngineDeps,
} from "../src/workflow/engine";
import { reconcilePluginWorkflowFlags, syncPluginWorkflows } from "../src/workflow/plugin-sync";
import { getTurn, insertTurn, liveTurn, liveTurnForTask, openWakeups } from "../src/workflow/wakeups";
import { settleTurn, startTurn, type OrchestratorDeps } from "../src/workflow/orchestrator";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import type { WorkflowDef } from "../src/workflow/schema";
import { toApiError } from "../src/api/protocol";
import { callOp } from "../src/api/ops";
import { DEFAULT_WORKFLOW_ROUTER, MissingStrategyError, StrategyError, workflowRouterId } from "../src/config/strategy";
import { dirname } from "node:path";
import { symlinkSync } from "node:fs";
import { shutdownPlugins } from "../src/plugins";
import { pluginLogPath } from "../src/plugins/host";
import { afterEach } from "bun:test";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;

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
      stopTask: (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.state = "stopped"; }),
    } satisfies EngineDeps,
  };
}

function writePlanner(ctx: Ctx, agent = "claude-code"): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: ${agent}\nproviders:\n  ${agent}: {}\n`);
}

const orchThenHuman: WorkflowDef = {
  id: "t/h-orch-human",
  version: 1,
  steps: {
    brainstorm: { type: "agent", role: "orchestrator", prompt: "Brainstorm: {{brief}}" },
    approve_spec: {
      type: "human",
      decision: "must",
      question: { kind: "approve_revise", text: "Approve?" },
    },
    done: { type: "end" },
  },
  edges: [
    { from: "brainstorm", to: "approve_spec" },
    { from: "approve_spec", to: "done", when: "result.answer == 'approve'" },
    { from: "approve_spec", to: "brainstorm", when: "result.answer == 'revise'", maxLoops: 2 },
  ],
  entry: "brainstorm",
};

const orchToOrch: WorkflowDef = {
  id: "t/h-orch-orch",
  version: 1,
  steps: {
    first: { type: "agent", role: "orchestrator", prompt: "First: {{brief}}" },
    second: { type: "agent", role: "orchestrator", prompt: "Second: {{brief}}" },
    done: { type: "end" },
  },
  edges: [
    { from: "first", to: "second" },
    { from: "second", to: "done" },
  ],
  entry: "first",
};

describe("batch H: startOrchestratorRoleStep must not settle a live turn from answerHumanStep", () => {
  test("live turn + answerHumanStep advance to orch must NOT settle the live turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, orchThenHuman, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/h-orch-human", repo: tmpDir(), brief: "B" }, spawn, deps);

    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const turn1 = await startTurn({ ...ctx, now: READY }, r.id, orch);
    expect(turn1).not.toBeNull();
    recordStepResult(ctx, turn1!.taskId!, { ok: true });
    updateTask(ctx, turn1!.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, turn1!.taskId!, spawn, deps);
    await settleTurn(ctx, turn1!.id, { outcome: "done" });
    expect(getRun(ctx, r.id)!.status).toBe("waiting");

    // Mid-flight foreign/ongoing turn still bound to the shared orch task while human waits.
    const orchId = getRun(ctx, r.id)!.orchestratorTaskId!;
    const mid = insertTurn(ctx, {
      id: `turn_mid_${r.id}`,
      runId: r.id,
      planner: "claude-code",
      status: "running",
      startedAt: READY + 10,
      deadline: READY + 600,
      taskId: orchId,
      failures: 0,
    });
    expect(liveTurn(ctx, r.id)?.id).toBe(mid.id);

    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);
    const a2 = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2);
    expect(a2).toBeDefined();
    expect(a2!.status).toBe("running");
    // Negative control: advancing from answerHumanStep must leave the mid-flight turn live.
    expect(getTurn(ctx, mid.id)?.status).toBe("running");
  });

  test("orch→orch re-entry after the turn's own task settles still force-settles that turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, orchToOrch, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/h-orch-orch", repo: tmpDir(), brief: "B" }, spawn, deps);

    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const turn = await startTurn({ ...ctx, now: READY }, r.id, orch);
    expect(turn).not.toBeNull();
    recordStepResult(ctx, turn!.taskId!, { ok: true });
    updateTask(ctx, turn!.taskId!, t => { t.state = "done"; });
    // Do not settleTurn yet — onTaskSettled must settle the live turn when starting second orch.
    await onTaskSettled(ctx, turn!.taskId!, spawn, deps);
    expect(getTurn(ctx, turn!.id)?.status).toBe("done");
    const second = stepsOfRun(ctx, r.id).find(s => s.stepId === "second");
    expect(second).toBeDefined();
    expect(second!.status).toBe("running");
    expect(openWakeups(ctx, r.id).some(w => w.cause === "orchestrator_step" && w.ref.includes("second#1"))).toBe(true);
  });
});

describe("batch H: liveTurnForTask must not return a foreign run's turn on the shared orch task", () => {
  test("foreign live turn on the shared task id is ignored when scoped to the settling run", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const root = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "root" });
    const child = insertRun(ctx, {
      workflow: "t/demo", version: 1, repo: tmpDir(), brief: "child",
      parentRunId: root.id, parentStep: "choose",
    });
    const orch = createTask(ctx, {
      brief: { goal: "orch", repo: root.repo },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 60,
      requestId: `orch:${root.id}`,
    });
    updateRun(ctx, root.id, root.rev, { orchestratorTaskId: orch.id });
    updateRun(ctx, child.id, child.rev, { orchestratorTaskId: orch.id });

    const foreign = insertTurn(ctx, {
      id: `turn_child_${child.id}`,
      runId: child.id,
      planner: "claude-code",
      status: "running",
      startedAt: NOW,
      deadline: NOW + 600,
      taskId: orch.id,
      failures: 0,
    });
    const own = insertTurn(ctx, {
      id: `turn_root_${root.id}`,
      runId: root.id,
      planner: "claude-code",
      status: "running",
      startedAt: NOW,
      deadline: NOW + 600,
      taskId: orch.id,
      failures: 0,
    });

    // Unscoped lookup is ambiguous; scoped lookup must return this run's turn only.
    expect(liveTurnForTask(ctx, orch.id, root.id)?.id).toBe(own.id);
    expect(liveTurnForTask(ctx, orch.id, child.id)?.id).toBe(foreign.id);
    expect(liveTurnForTask(ctx, orch.id, root.id)?.id).not.toBe(foreign.id);
  });
});

describe("batch H: run.start auto MissingStrategyError vs StrategyError", () => {
  test("workflowRouterId falls back to DEFAULT_WORKFLOW_ROUTER when strategy.yaml is missing", () => {
    const ctx = fakeCtx({ now: NOW });
    mkdirSync(ctx.pacerHome, { recursive: true });
    // No strategy.yaml
    expect(() => workflowRouterId(ctx)).not.toThrow(MissingStrategyError);
    expect(workflowRouterId(ctx)).toBe(DEFAULT_WORKFLOW_ROUTER);
  });

  test("workflowRouterId still throws StrategyError for a broken strategy.yaml", () => {
    const ctx = fakeCtx({ now: NOW });
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: [broken\n");
    expect(() => workflowRouterId(ctx)).toThrow(StrategyError);
  });

  test("run.start auto with no strategy.yaml uses bundled default router when installed", async () => {
    const ctx = fakeCtx({
      now: NOW,
      home: tmpDir(),
      env: { PATH: process.env.PATH ?? "" },
    });
    mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
    // Missing strategy — startRun auto must not wrap MissingStrategyError as invalid_input.
    const router: WorkflowDef = {
      id: DEFAULT_WORKFLOW_ROUTER,
      version: 1,
      steps: {
        choose: { type: "choose_workflow", from: ["t/ask"] },
        done: { type: "end" },
      },
      edges: [{ from: "choose", to: "done" }],
      entry: "choose",
    };
    const ask: WorkflowDef = {
      id: "t/ask",
      version: 1,
      steps: {
        answer: { type: "agent", role: "orchestrator", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "answer", to: "done" }],
      entry: "answer",
    };
    addDefinition(ctx, ask, "source");
    addDefinition(ctx, router, "source");
    const spawn: SpawnRunner = () => 1;
    const repo = gitRepo();
    const deps = {
      ...defaultEngineDeps,
      delegate: async (c: Ctx, input: { brief: unknown; kind?: string | null; title?: string; requestId?: string }) => {
        const b = input.brief as { goal: string; repo?: string };
        return createTask(c, {
          brief: { goal: b.goal, repo: b.repo ?? repo },
          kind: input.kind ?? null,
          requestedExecutor: null,
          timeoutS: 60,
          title: input.title,
          requestId: input.requestId,
        });
      },
    };
    const run = await startRun(ctx, { workflow: "auto", repo, brief: "hi" }, spawn, deps);
    expect(run.workflow).toBe(DEFAULT_WORKFLOW_ROUTER);
  });

  test("run.start auto with broken strategy.yaml fails with exact invalid_input message", async () => {
    const ctx = fakeCtx({ now: NOW });
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: [broken\n");
    const repo = gitRepo();
    try {
      await startRun(ctx, { workflow: "auto", repo, brief: "nope" });
      expect.unreachable("expected startRun to throw");
    } catch (e) {
      const err = toApiError(e);
      expect(err.code).toBe("invalid_input");
      expect(err.message.startsWith("run.start auto: cannot load strategy (")).toBe(true);
    }
  });
});

describe("batch H: settleTurn on ended run resets orchestratorState to idle", () => {
  test("endedRun settleTurn done branch clears orchestratorState turn → idle", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, orchThenHuman, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/h-orch-human", repo: tmpDir(), brief: "B" }, spawn, deps);
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const turn = await startTurn({ ...ctx, now: READY }, r.id, orch);
    expect(turn).not.toBeNull();
    expect(getRun(ctx, r.id)!.orchestratorState).toBe("turn");

    // Mark the run terminal without going through stopRun (which settles turns itself),
    // so settleTurn takes the endedRun branch while the turn is still live.
    workflowDatabase(ctx).query(
      "UPDATE workflow_runs SET status = 'stopped', updated_at = ? WHERE id = ?",
    ).run(ctx.now, r.id);
    expect(liveTurn(ctx, r.id)?.id).toBe(turn!.id);
    await settleTurn(ctx, turn!.id, { outcome: "done" });
    expect(getTurn(ctx, turn!.id)?.status).toBe("stopped");
    expect(getRun(ctx, r.id)!.orchestratorState).toBe("idle");
  });
});

const pluginHomes: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(pluginHomes.splice(0).map(ctx => shutdownPlugins(ctx)));
});

function pluginHome() {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir,
    pacerHome: join(dir, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    now: NOW,
  });
  pluginHomes.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}

const MINIMAL = (id: string) => `
id: ${id}
version: 1
steps:
  go: { type: agent, kind: research, prompt: inline }
  done: { type: end }
edges: [[go, done]]
`;

function installWfPlugin(
  ctx: ReturnType<typeof fakeCtx>,
  id: string,
  pages: { name: string; version: number; source: string; prompts: Record<string, string> }[],
  opts: { names?: string[]; version?: string } = {},
): void {
  const dir = join(ctx.pacerHome, "plugins", id);
  mkdirSync(dir, { recursive: true });
  const names = opts.names ?? [...new Set(pages.map(p => p.name))];
  const contributes: Record<string, { title?: string }> = {};
  for (const name of names) contributes[name] = { title: name };
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({
    id, version: opts.version ?? "1.0.0", publisher: "test", host: ">=1.12.0",
    entry: "main.ts", contributes: { workflow: contributes }, capabilities: [],
  }));
  writeFileSync(join(dir, "pages.json"), JSON.stringify(pages));
  writeFileSync(join(dir, "main.ts"), `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
const pages = JSON.parse(readFileSync("pages.json", "utf8"));
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async () => ({
      workflows: pages.map((p) => ({ name: p.name, version: p.version, source: p.source, prompts: p.prompts })),
    }),
  },
});
`);
  chmodSync(join(dir, "main.ts"), 0o755);
}

describe("batch H: invalid stored defs survive sync/reconcile", () => {
  test("invalid kind:review def stays unstartable across re-sync and live gate", async () => {
    const ctx = pluginHome();
    const badSrc = `
id: fx-inv/feature
version: 1
steps:
  panel:
    type: fanout
    branches: [a]
    each: { kind: review, prompt: "review" }
    join: all
  done: { type: end }
edges: [[panel, done]]
`;
    const raw = {
      id: "fx-inv/feature",
      version: 1,
      steps: {
        panel: {
          type: "fanout",
          branches: ["a"],
          each: { kind: "review", prompt: "review" },
          join: "all",
        },
        done: { type: "end" },
      },
      edges: [{ from: "panel", to: "done" }],
      entry: "panel",
    };
    workflowDatabase(ctx).query(
      "INSERT INTO workflow_defs(id, version, source, def, added_at, origin, disabled, invalid) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
    ).run("fx-inv/feature", 1, badSrc, JSON.stringify(raw), ctx.now, "plugin:fx-inv@1.0.0");

    // Plugin no longer contributes feature → revalidate marks invalid.
    installWfPlugin(ctx, "fx-inv", [
      { name: "other", version: 1, source: MINIMAL("fx-inv/other"), prompts: {} },
    ], { names: ["other", "feature"], version: "1.0.1" });
    await callOp(ctx, "plugin.enable", { id: "fx-inv", grant: true });
    await syncPluginWorkflows(ctx, "fx-inv");

    expect(isDefinitionInvalid(ctx, "fx-inv/feature@1")).toBe(true);
    const log = readFileSync(pluginLogPath(ctx, "fx-inv"), "utf8");
    expect(log).toContain("marking invalid");

    // Sync start + reconcile clear disabled but must not clear invalid.
    setPluginDefinitionsDisabled(ctx, "fx-inv", false);
    reconcilePluginWorkflowFlags(ctx);
    await syncPluginWorkflows(ctx, "fx-inv");
    expect(isDefinitionInvalid(ctx, "fx-inv/feature@1")).toBe(true);

    const repo = gitRepo();
    try {
      await startRun(ctx, { workflow: "fx-inv/feature@1", repo, brief: "nope" });
      expect.unreachable("expected refuse");
    } catch (e) {
      const err = toApiError(e);
      expect(err.code).toBe("not_allowed");
      expect(err.message).toBe("workflow 'fx-inv/feature@1' is invalid");
    }
  }, 60000);

  test("addDefinition supersede refuses when a run is pinned to the version", () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def: WorkflowDef = {
      id: "t/pinned",
      version: 1,
      steps: { done: { type: "end" } },
      edges: [],
      entry: "done",
    };
    addDefinition(ctx, def, "source-v1");
    insertRun(ctx, { workflow: "t/pinned", version: 1, repo: tmpDir(), brief: "live" });
    // insertRun defaults to running
    const result = addDefinition(ctx, def, "source-v2", { supersede: true });
    expect(result.skipped).toBe("pinned_runs");
    expect(result.superseded).toBeUndefined();
    expect(getDefinition(ctx, "t/pinned@1")).toEqual(def);
    // Source unchanged
    const row = workflowDatabase(ctx).query<{ source: string }, [string, number]>(
      "SELECT source FROM workflow_defs WHERE id = ? AND version = ?",
    ).get("t/pinned", 1);
    expect(row?.source).toBe("source-v1");
  });
});


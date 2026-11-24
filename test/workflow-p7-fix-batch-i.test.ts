// Phase 7 batch I — fail-first coverage for review follow-ups.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { shutdownPlugins } from "../src/plugins";
import { listTasksWhere, readTask, updateTask, createTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import {
  addDefinition, getRun, isDefinitionInvalid, workflowDatabase,
} from "../src/workflow/store";
import { defaultEngineDeps, startRun, stopRun, type EngineDeps } from "../src/workflow/engine";
import { settleTurn, startTurn } from "../src/workflow/orchestrator";
import {
  backfillInvalidFromDisabledMarker, reconcilePluginWorkflowFlags, syncPluginWorkflows,
} from "../src/workflow/plugin-sync";
import { liveTurn } from "../src/workflow/wakeups";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import type { WorkflowDef } from "../src/workflow/schema";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function pluginHome(): Ctx {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir,
    pacerHome: join(dir, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    now: NOW,
  });
  contexts.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writePlanner(ctx);
  return ctx;
}

describe("batch I: patchRun skips orch settle while live turn exists; turn settle terminalizes", () => {
  test("orch task is terminalized once the leftover live turn settles (no queued leak)", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, {
      id: "t/i-stop-live",
      version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    } satisfies WorkflowDef, "source");
    const repo = gitRepo();
    const deps: EngineDeps = {
      ...defaultEngineDeps,
      delegate: async (c, input) => {
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
      // Leave the orch task non-terminal so stop keeps the turn live (stop pending).
      stopTask: () => { throw new Error("stop busy"); },
    };
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/i-stop-live", repo, brief: "live" }, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const orchId = getRun(ctx, r.id)!.orchestratorTaskId!;
    expect(orchId).toBe(turn!.taskId!);
    // Requeue orch so I4 queue-count would leak if never terminalized.
    updateTask(ctx, orchId, t => {
      t.state = "queued";
      delete t.result;
      delete t.settledAt;
    });

    await stopRun(ctx, r.id, getRun(ctx, r.id)!.rev, deps);
    expect(getRun(ctx, r.id)!.status).toBe("stopped");
    expect(liveTurn(ctx, r.id)).not.toBeNull();
    expect(readTask(ctx, orchId)!.state).toBe("queued");
    expect(
      listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.id === orchId && t.kind === "orchestrate"),
    ).toHaveLength(1);

    // Settling the leftover turn must terminalize the orch task (I4).
    await settleTurn(ctx, turn!.id, { outcome: "done" });
    expect(liveTurn(ctx, r.id)).toBeNull();
    expect(readTask(ctx, orchId)!.state).toBe("stopped");
    expect(
      listTasksWhere(ctx, { states: ["queued", "running"] }).filter(t => t.id === orchId),
    ).toHaveLength(0);
  });
});

describe("batch I: disabled=1 invalid-era rows backfill into invalid on sync", () => {
  test("sync/reconcile promote disabled-because-invalid rows to invalid before clearing disabled", async () => {
    const ctx = pluginHome();
    const badSrc = `
id: fx-old/feature
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
      id: "fx-old/feature",
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
    // Simulate pre-invalid-column build: schema-invalid def marked only via disabled=1.
    workflowDatabase(ctx).query(
      "INSERT INTO workflow_defs(id, version, source, def, added_at, origin, disabled, invalid) VALUES (?, ?, ?, ?, ?, ?, 1, 0)",
    ).run("fx-old/feature", 1, badSrc, JSON.stringify(raw), ctx.now, "plugin:fx-old@1.0.0");
    expect(isDefinitionInvalid(ctx, "fx-old/feature@1")).toBe(false);

    expect(backfillInvalidFromDisabledMarker(ctx, "fx-old")).toBe(1);
    expect(isDefinitionInvalid(ctx, "fx-old/feature@1")).toBe(true);

    // Install a live plugin that no longer contributes feature; reconcile must not
    // leave the row startable after clearing disabled.
    const dir = join(ctx.pacerHome, "plugins", "fx-old");
    mkdirSync(dir, { recursive: true });
    const otherSrc = `
id: fx-old/other
version: 1
steps:
  go: { type: agent, kind: research, prompt: "ok" }
  done: { type: end }
edges: [[go, done]]
`;
    writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({
      id: "fx-old", version: "1.0.1", publisher: "test", host: ">=1.12.0",
      entry: "main.ts", contributes: { workflow: { other: { title: "other" } } }, capabilities: [],
    }));
    writeFileSync(join(dir, "pages.json"), JSON.stringify([
      { name: "other", version: 1, source: otherSrc, prompts: {} },
    ]));
    writeFileSync(join(dir, "main.ts"), `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { serve } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
const pages = JSON.parse(readFileSync("pages.json", "utf8"));
await serve({
  manifest,
  handlers: {
    "workflow.definitions": ({ after }) => {
      const i = after ? pages.findIndex((p: { name: string }) => p.name === after) + 1 : 0;
      const page = pages[i];
      if (!page) return { entries: [] };
      return { entries: [page], next: pages[i + 1]?.name };
    },
  },
});
`);
    chmodSync(join(dir, "main.ts"), 0o755);

    // Reset invalid to simulate upgrade path again through reconcile/sync.
    workflowDatabase(ctx).query(
      "UPDATE workflow_defs SET disabled = 1, invalid = 0 WHERE id = ? AND version = ?",
    ).run("fx-old/feature", 1);
    expect(isDefinitionInvalid(ctx, "fx-old/feature@1")).toBe(false);

    await callOp(ctx, "plugin.enable", { id: "fx-old", grant: true });
    reconcilePluginWorkflowFlags(ctx);
    expect(isDefinitionInvalid(ctx, "fx-old/feature@1")).toBe(true);

    await syncPluginWorkflows(ctx, "fx-old");
    expect(isDefinitionInvalid(ctx, "fx-old/feature@1")).toBe(true);

    const repo = gitRepo();
    try {
      await callOp(ctx, "run.start", { workflow: "fx-old/feature@1", repo, brief: "nope" });
      expect.unreachable("expected refuse");
    } catch (e) {
      const err = toApiError(e);
      expect(err.code).toBe("not_allowed");
      expect(err.message).toBe("workflow 'fx-old/feature@1' is invalid");
    }
  }, 60000);
});

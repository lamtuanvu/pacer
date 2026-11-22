// Phase 2 Task 3 / API-5b: the per-turn `prg_` run grant — hashed at rest, scoped
// to one run, fail-closed at the HTTP gate, never an executor (SEC-5, API-5b).
// Batch D1: real executorEnv → connectClient → HTTP gate path (no SpawnRunner stub).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { authorizeWorkOperation } from "../src/core/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { appendActivity } from "../src/activity/log";
import { createTask, updateTask } from "../src/tasks/store";
import { startServer } from "../src/serve/http";
import { isExecutorSession, isOrchestratorSession } from "../src/install/role";
import { executorEnv } from "../src/exec/process";
import { connectClient } from "../src/api/client";
import { callOp } from "../src/api/ops";
import { callerParticipant } from "../src/messaging/participants";
import {
  issueRunGrant,
  revokeOrphanRunGrants,
  revokeRunGrant,
  revokeRunGrantsForRun,
  verifyRunGrant,
  RUN_GRANT_OPS,
} from "../src/workflow/run-grant";
import { insertRun, insertStep, rootRunId, updateRun } from "../src/workflow/store";
import { insertTurn } from "../src/workflow/wakeups";
import { stopLiveTurnsForRun } from "../src/workflow/orchestrator";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { ApiError } from "../src/api/client-types";

const NOW = 1_700_000_000;

function withGrant(ctx: Ctx, bearer: string): Ctx {
  return { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer, PACER_ROLE: undefined } };
}

function setupRun(ctx: Ctx) {
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  // A running orchestrator task keeps recoverOrphanTurns from settling this turn at serve start.
  const orch = createTask(ctx, { brief: { goal: "orch", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, orch.id, t => { t.state = "running"; });
  insertTurn(ctx, {
    id: "turn_grant1",
    runId: run.id,
    planner: "claude-code",
    status: "running",
    startedAt: NOW,
    deadline: NOW + 1200,
    taskId: orch.id,
  });
  return { run, task, turnId: "turn_grant1" };
}

describe("the prg_ run grant", () => {
  test("is a prg_ token, hashed at rest, bound to one run and turn", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 600 });
    expect(bearer).toMatch(/^prg_[0-9a-f]{64}$/);
    const row = dispatchDatabase(ctx).query<{ hash: string; task_id: string; conversation_id: string; kind: string; expires: number; revoked: number }, []>(
      "SELECT * FROM work_grants WHERE kind='run'",
    ).get()!;
    expect(row).toMatchObject({ task_id: turnId, conversation_id: run.id, kind: "run", expires: NOW + 600, revoked: 0 });
    expect(row.hash).not.toBe(bearer);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(dispatchDatabase(ctx).query("SELECT * FROM work_grants").all())).not.toContain(bearer);
    expect(verifyRunGrant(ctx, bearer)).toEqual({ runId: run.id, turnId });
  });

  test("verify returns null when unknown, expired or revoked", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 10 });
    expect(verifyRunGrant({ ...ctx, now: NOW + 9 }, bearer)).toEqual({ runId: run.id, turnId });
    expect(verifyRunGrant({ ...ctx, now: NOW + 10 }, bearer)).toBeNull();
    expect(verifyRunGrant(ctx, `prg_${"0".repeat(64)}`)).toBeNull();
    expect(verifyRunGrant(ctx, `prg_${"g".repeat(64)}`)).toBeNull();
    expect(verifyRunGrant(ctx, `pwg_${"0".repeat(64)}`)).toBeNull();
    revokeRunGrant(ctx, turnId);
    expect(verifyRunGrant(ctx, bearer)).toBeNull();
  });

  test("authorizeWorkOperation allows task.review on its own run's step task only", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, task, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 600 });
    const granted = withGrant(ctx, bearer);
    expect(() => authorizeWorkOperation(granted, "task.review", { id: task.id, verdict: "accept" })).not.toThrow();

    const ordinary = createTask(ctx, { brief: { goal: "other", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    expect(() => authorizeWorkOperation(granted, "task.review", { id: ordinary.id, verdict: "accept" })).toThrow(/outside this run grant/);

    const other = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "other" });
    const otherTask = createTask(ctx, { brief: { goal: "x", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    insertStep(ctx, { runId: other.id, stepId: "ask", attempt: 1, taskId: otherTask.id, status: "running" });
    expect(() => authorizeWorkOperation(granted, "task.review", { id: otherTask.id, verdict: "accept" })).toThrow(/outside this run grant/);
  });

  test("refuses ops outside RUN_GRANT_OPS and fails after deadline or revoke", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 30 });
    const granted = withGrant(ctx, bearer);
    for (const name of ["run.start", "task.delegate", "run.set_budget", "dispatch.child"]) {
      expect(() => authorizeWorkOperation(granted, name, { id: run.id }), name).toThrow(/not allowed by this run grant/);
    }
    expect(RUN_GRANT_OPS).toContain("task.review");
    expect(() => authorizeWorkOperation({ ...granted, now: NOW + 31 }, "task.review", { id: "t-x", verdict: "accept" })).toThrow(/Expired or revoked/);
    const live = issueRunGrant(ctx, { runId: run.id, turnId: "turn_grant1", deadline: NOW + 600 });
    // Re-issuing for the same turn; revoke clears every grant for that turn.
    revokeRunGrant(ctx, turnId);
    expect(() => authorizeWorkOperation(withGrant(ctx, live), "run.decide", { id: run.id })).toThrow(/Expired or revoked/);
    revokeRunGrantsForRun(ctx, run.id);
    revokeOrphanRunGrants(ctx);
  });

  test("a prg_ caller is never an executor session", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 600 });
    expect(isExecutorSession(withGrant(ctx, bearer))).toBe(false);
    expect(isExecutorSession({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } })).toBe(true);
  });

  test("the bearer never appears in activity or under the test home", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, task, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 600 });
    appendActivity(ctx, { kind: "config", level: "info", text: `reviewed ${task.id} for ${run.id}` });
    authorizeWorkOperation(withGrant(ctx, bearer), "task.review", { id: task.id, verdict: "accept" });
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else {
          const text = readFileSync(path, "utf8");
          if (text.includes(bearer)) found.push(path);
        }
      }
    };
    walk(ctx.home);
    expect(found).toEqual([]);
  });
});

describe("HTTP gate for prg_", () => {
  test("unknown, expired or revoked prg_ gets 403 and a live one is not the operator", async () => {
    const base = fakeCtx({ now: NOW });
    mkdirSync(base.pacerHome, { recursive: true });
    writeFileSync(join(base.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
    const { run, turnId } = setupRun(base);
    const expired = issueRunGrant({ ...base, now: NOW - 100 }, { runId: run.id, turnId: "turn_exp", deadline: NOW - 50 });
    const revoked = issueRunGrant(base, { runId: run.id, turnId: "turn_rev", deadline: NOW + 3600 });
    revokeRunGrant(base, "turn_rev");
    const server = startServer(() => ({ ...base, now: NOW }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
    });
    const call = async (bearer: string, path = "/v3/ops/task.review") => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, host: `127.0.0.1:${server.port}` },
        body: JSON.stringify({ id: "t-none", verdict: "accept" }),
      });
      return { status: response.status, text: await response.text() };
    };
    try {
      await Bun.sleep(20);
      const live = issueRunGrant(base, { runId: run.id, turnId, deadline: NOW + 3600 });
      for (const bearer of [expired, revoked, `prg_${"0".repeat(64)}`]) {
        const response = await call(bearer);
        expect(response.status, bearer.slice(0, 12)).toBe(403);
        expect(response.text).toBe("forbidden\n");
      }
      // A live grant passes the gate (not the raw forbidden body); the core then refuses the unknown task.
      const allowed = await call(live);
      expect(allowed.status).not.toBe(401);
      expect(allowed.text).not.toBe("forbidden\n");
      // Non-ops routes stay closed.
      expect((await call(live, "/v3/snapshot")).status).toBe(403);
      // Ops outside RUN_GRANT_OPS are 403 at the serve gate (not the operator shortcut).
      expect((await call(live, "/v3/ops/routing.status")).status).toBe(403);
      expect((await call(live, "/v3/ops/run.start")).status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});

describe("orchestrator grant end-to-end (executorEnv → connectClient → HTTP)", () => {
  test("keeps orchestrator role, uses prg_ as HTTP bearer, and scopes step.result", async () => {
    const base = fakeCtx({ now: NOW });
    mkdirSync(base.pacerHome, { recursive: true });
    writeFileSync(join(base.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
    // Operator token on disk must not be used when a run grant is present.
    writeFileSync(join(base.pacerHome, "token"), "operator-secret-token-should-not-leak\n");

    const run = insertRun(base, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
    const orchTask = createTask(base, {
      brief: { goal: "orchestrate", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
    });
    updateTask(base, orchTask.id, t => { t.state = "running"; });
    insertStep(base, { runId: run.id, stepId: "plan", attempt: 1, taskId: orchTask.id, status: "running" });
    insertTurn(base, {
      id: "turn_e2e1", runId: run.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 1200, taskId: orchTask.id,
    });

    const server = startServer(() => ({ ...base, now: NOW }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
    });
    try {
      // Issue after serve start so start-up recovery cannot race the grant away.
      await Bun.sleep(20);
      const bearer = issueRunGrant(base, { runId: run.id, turnId: "turn_e2e1", deadline: NOW + 3600 });
      const launchBase = {
        ...base.env,
        PACER_PORT: String(server.port),
        PACER_ROLE: "orchestrator",
        PACER_RUN_GRANT: bearer,
        PACER_RUN_ID: run.id,
        PACER_TURN_ID: "turn_e2e1",
        PACER_TASK_ID: orchTask.id,
        PACER_AUTH_TOKEN: "operator-should-strip",
        PACER_WORK_GRANT: `pwg_${"a".repeat(64)}`,
        PACER_API: "inprocess",
      };
      const env = executorEnv(launchBase, { HOME: base.home }, orchTask.id, [], { runGrant: bearer });
      expect(env.PACER_ROLE).toBe("orchestrator");
      expect(env.PACER_RUN_GRANT).toBe(bearer);
      // Without the explicit opt-in, a polluted base must not become an orchestrator agent.
      const scrubbed = executorEnv(launchBase, { HOME: base.home }, orchTask.id);
      expect(scrubbed.PACER_ROLE).toBe("executor");
      expect(scrubbed.PACER_RUN_GRANT).toBeUndefined();
      expect(env.PACER_WORK_GRANT).toBeUndefined();
      expect(env.PACER_AUTH_TOKEN).toBeUndefined();
      expect(env.PACER_API).toBeUndefined();
      expect(isOrchestratorSession({ ...base, env })).toBe(true);
      expect(isExecutorSession({ ...base, env })).toBe(false);

      const client = await connectClient({ ...base, env }, { protocol: 3, allowFallback: false });
      expect(client.kind).toBe("http");
      try {
        // Allowed at the gate: task.review reaches the core (may still fail on task state).
        await expect(client.call("task.review", { id: orchTask.id, verdict: "accept", expect_rev: 1 }))
          .rejects.toBeInstanceOf(ApiError);
        // Disallowed at the serve gate (plain 403 → ApiError not_allowed / internal).
        const routingErr = await client.call("routing.status", {}).catch(e => e);
        expect(routingErr).toBeInstanceOf(ApiError);
        expect(String((routingErr as ApiError).message)).toMatch(/403|forbidden|not_allowed/i);
        const startErr = await client.call("run.start", { workflow: "t/x", repo: tmpDir(), brief: "no" }).catch(e => e);
        expect(startErr).toBeInstanceOf(ApiError);
        expect(String((startErr as ApiError).message)).toMatch(/403|forbidden|not_allowed/i);
      } finally {
        client.close();
      }

      // step.result is in-process (CLI path) with the same executorEnv identity.
      const stepCtx = { ...base, env };
      const recorded = await callOp(stepCtx, "step.result", { result: { ok: true } }) as { result: unknown };
      expect(recorded.result).toEqual({ ok: true });

      // Reviews are attributed to the orchestrator, not human.
      expect(callerParticipant(stepCtx, { appAuthenticated: false, participant: "orchestrator" }).id).toBe("orchestrator");
    } finally {
      await server.stop();
    }
  });

  test("I6: step.result over HTTP with prg_ derives task from the turn (no PACER_TASK_ID)", async () => {
    const base = fakeCtx({ now: NOW });
    mkdirSync(base.pacerHome, { recursive: true });
    writeFileSync(join(base.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
    const run = insertRun(base, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
    const orchTask = createTask(base, {
      brief: { goal: "orchestrate", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
    });
    updateTask(base, orchTask.id, t => { t.state = "running"; });
    insertStep(base, { runId: run.id, stepId: "plan", attempt: 1, taskId: orchTask.id, status: "running" });
    insertTurn(base, {
      id: "turn_i6", runId: run.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 1200, taskId: orchTask.id,
    });
    const server = startServer(() => ({ ...base, now: NOW }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
    });
    try {
      await Bun.sleep(20);
      const bearer = issueRunGrant(base, { runId: run.id, turnId: "turn_i6", deadline: NOW + 3600 });
      // Serve request ctx has the grant but no PACER_TASK_ID (I6).
      const client = await connectClient({
        ...base,
        env: {
          ...base.env,
          PACER_PORT: String(server.port),
          PACER_RUN_GRANT: bearer,
          PACER_ROLE: "orchestrator",
        },
      }, { protocol: 3, allowFallback: false });
      try {
        const recorded = await client.call("step.result", { result: { ok: true, via: "http" } }) as { result: unknown };
        expect(recorded.result).toEqual({ ok: true, via: "http" });
      } finally {
        client.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("RUN_GRANT_OPS lists only implemented ops and never run.answer", () => {
    expect(RUN_GRANT_OPS).toContain("run.decide");
    expect(RUN_GRANT_OPS).toContain("step.result");
    expect(RUN_GRANT_OPS).toContain("step.skip");
    expect(RUN_GRANT_OPS).toContain("step.retry");
    expect(RUN_GRANT_OPS as readonly string[]).not.toContain("run.answer");
    expect(RUN_GRANT_OPS as readonly string[]).not.toContain("question.answer");
    expect(RUN_GRANT_OPS as readonly string[]).toContain("run.submit_graph");
  });

  test("child-run targets are inside the root grant via rootRunId", () => {
    const ctx = fakeCtx({ now: NOW });
    const root = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "root" });
    const child = insertRun(ctx, {
      workflow: "t/child", version: 1, repo: tmpDir(), brief: "child",
      parentRunId: root.id, parentStep: "pick",
    });
    expect(rootRunId(ctx, child.id)).toBe(root.id);
    insertTurn(ctx, {
      id: "turn_child", runId: root.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 1200,
    });
    const bearer = issueRunGrant(ctx, { runId: root.id, turnId: "turn_child", deadline: NOW + 600 });
    const granted = withGrant(ctx, bearer);
    const childTask = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    insertStep(ctx, { runId: child.id, stepId: "a", attempt: 1, taskId: childTask.id, status: "running" });
    expect(() => authorizeWorkOperation(granted, "task.review", { id: childTask.id, verdict: "accept" })).not.toThrow();
    expect(() => authorizeWorkOperation(granted, "run.decide", { id: child.id, step: "a", choice: "x", reason: "y" })).not.toThrow();
  });

  test("grants for terminal runs verify as null and stopLiveTurnsForRun revokes", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
    insertTurn(ctx, {
      id: "turn_term", runId: run.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 1200,
    });
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId: "turn_term", deadline: NOW + 600 });
    expect(verifyRunGrant(ctx, bearer)).toEqual({ runId: run.id, turnId: "turn_term" });
    stopLiveTurnsForRun(ctx, run.id, "stopped");
    expect(verifyRunGrant(ctx, bearer)).toBeNull();
    updateRun(ctx, run.id, run.rev, { status: "stopped" });
    const again = issueRunGrant(ctx, { runId: run.id, turnId: "turn_term2", deadline: NOW + 600 });
    expect(verifyRunGrant(ctx, again)).toBeNull();
  });

  test("SEC-5: prg_ bearer never appears in argv scrub lists or activity", () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 600 });
    appendActivity(ctx, { kind: "config", level: "info", text: `turn ${turnId}` });
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else if (readFileSync(path, "utf8").includes(bearer)) found.push(path);
      }
    };
    walk(ctx.home);
    expect(found).toEqual([]);
    // Scrub lists include PACER_RUN_GRANT (source-level contract).
    const workspace = readFileSync(new URL("../src/terminal/workspace.ts", import.meta.url), "utf8");
    const history = readFileSync(new URL("../src/tasks/history.ts", import.meta.url), "utf8");
    const orca = readFileSync(new URL("../src/plugins/executor-orca.ts", import.meta.url), "utf8");
    expect(workspace).toContain("PACER_RUN_GRANT");
    expect(history).toContain("PACER_RUN_GRANT");
    expect(orca).toMatch(/PACER_RUN_GRANT/);
  });

  test("SEC-5: createTerminal launchEnv strips PACER_RUN_GRANT and PACER_WORK_GRANT for shell and action", async () => {
    const { createTerminal } = await import("../src/terminal/workspace");
    const priorProcess = { work: process.env.PACER_WORK_GRANT, run: process.env.PACER_RUN_GRANT };
    process.env.PACER_WORK_GRANT = "from-process-work";
    process.env.PACER_RUN_GRANT = "from-process-run";
    try {
      const ctx = fakeCtx({
        now: NOW,
        env: {
          ...process.env,
          PACER_WORK_GRANT: "from-ctx-work",
          PACER_RUN_GRANT: "from-ctx-run",
          SHELL: "/bin/sh",
        },
      });
      for (const kind of ["shell", "action"] as const) {
        let spawned: Record<string, string | undefined> = {};
        const start = (spec: { env: Record<string, string | undefined> }) => {
          spawned = spec.env;
          return { pid: 99999999 };
        };
        if (kind === "shell") {
          await createTerminal(ctx, { requestId: "scrub-shell", kind: "shell", cwd: ctx.home }, { start });
        } else {
          await createTerminal(
            ctx,
            {
              requestId: "scrub-action",
              kind: "action",
              title: "Scrub",
              argv: ["true"],
              env: { PACER_WORK_GRANT: "from-extra-work", PACER_RUN_GRANT: "from-extra-run", KEEP: "yes" },
            },
            { start },
          );
          expect(spawned.KEEP).toBe("yes");
        }
        expect(spawned.PACER_WORK_GRANT).toBeUndefined();
        expect(spawned.PACER_RUN_GRANT).toBeUndefined();
      }
    } finally {
      if (priorProcess.work === undefined) delete process.env.PACER_WORK_GRANT;
      else process.env.PACER_WORK_GRANT = priorProcess.work;
      if (priorProcess.run === undefined) delete process.env.PACER_RUN_GRANT;
      else process.env.PACER_RUN_GRANT = priorProcess.run;
    }
  });

  test("SEC-5: Orca executor.run never receives a prg_ bearer in call params or argv", async () => {
    const ctx = fakeCtx({ now: NOW });
    const { run, turnId } = setupRun(ctx);
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: NOW + 600 });
    const calls: { method: string; params: unknown }[] = [];
    const { makeOrcaBackend } = await import("../src/plugins/executor-orca");
    const backend = makeOrcaBackend(
      {
        loadExecution: () => ({ localMaxTasks: 2, backend: "orca" } as never),
        sleep: async () => {},
      },
      {
        call: async (_c, _plugin, method, params) => {
          calls.push({ method, params });
          throw new Error("orca should not be called with a run grant");
        },
      },
    );
    const task = createTask(ctx, {
      brief: { goal: "orch", repo: tmpDir() },
      kind: "orchestrate",
      requestedExecutor: "claude-code",
      timeoutS: 60,
    });
    const outcome = await backend.runAttempt(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer, PACER_ROLE: "orchestrator" } },
      { id: "claude-code", model: "x", via: "cli" } as never,
      task,
    );
    expect(calls).toEqual([]);
    const blob = JSON.stringify({ calls, outcome, report: outcome.report });
    expect(blob).not.toContain(bearer);
    expect(blob).not.toMatch(/prg_[A-Za-z0-9]/);
  });
});

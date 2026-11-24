// Phase 6 Task 3: wider messaging route for run participants (ADR 0011 amendment).
import { expect, test, describe } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { checkSend, effectivePolicy } from "../src/messaging/policy";
import { relation } from "../src/messaging/participants";
import { sendMessage } from "../src/messaging/send";
import { startTurnIfIdle } from "../src/messaging/turns";
import * as msgStore from "../src/messaging/store";
import type { TaskRecord } from "../src/tasks/types";
import {
  insertRun, insertStep, getRun, updateRun,
} from "../src/workflow/store";
import {
  parseSpent, serializeBudget, serializeSpent, budgetAllowsMessage,
} from "../src/workflow/budget";
import { callOp } from "../src/api/ops";
import { runIdForParticipant } from "../src/messaging/run-route";

const send = (from: string, to: string, hasGrant = false) =>
  ({ from, to, kind: "message" as const, bytes: 10, hasGrant });

const reason = (f: () => unknown) => {
  try { f(); return "allowed"; }
  catch (e) { return (e as CoreError).data?.reason; }
};

const errMsg = (f: () => unknown) => {
  try { f(); return "allowed"; }
  catch (e) { return (e as CoreError).message; }
};

function writeStrategy(ctx: ReturnType<typeof fakeCtx>, extra = "") {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    `planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n${extra}`,
  );
}

/** Nest under distinct tops so ordinary relation is "none" and run_peer can widen. */
function nestUnderTop(ctx: ReturnType<typeof fakeCtx>, childId: string, repo: string): void {
  const top = createTask(ctx, { brief: { goal: "top", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
  registerWork(ctx, top.id, { allowDelegation: true });
  registerWork(ctx, childId, {}, top.id);
}

describe("run participant messaging route", () => {
  test("run participant → another run's executor is allowed and counted", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repoA = tmpDir();
    const repoB = tmpDir();
    const sender = insertRun(ctx, {
      workflow: "t/a", version: 1, repo: repoA, brief: "a",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const receiver = insertRun(ctx, {
      workflow: "t/b", version: 1, repo: repoB, brief: "b",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const fromTask = createTask(ctx, { brief: { goal: "from", repo: repoA }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const toTask = createTask(ctx, { brief: { goal: "to", repo: repoB }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    nestUnderTop(ctx, fromTask.id, repoA);
    nestUnderTop(ctx, toTask.id, repoB);
    insertStep(ctx, { runId: sender.id, stepId: "a", attempt: 1, branch: "", taskId: fromTask.id, status: "running" });
    insertStep(ctx, { runId: receiver.id, stepId: "b", attempt: 1, branch: "", taskId: toTask.id, status: "running" });
    updateTask(ctx, toTask.id, t => {
      t.state = "done";
      t.result = { ...t.result, executor: "claude-code", backend: "direct" } as TaskRecord["result"];
    });

    expect(relation(ctx, `task:${fromTask.id}`, `task:${toTask.id}`)).toBe("run_peer");
    expect(reason(() => checkSend(ctx, send(`task:${fromTask.id}`, `task:${toTask.id}`)))).toBe("allowed");
    const verdict = checkSend(ctx, send(`task:${fromTask.id}`, `task:${toTask.id}`));
    expect(verdict.layer).toBe("default");

    const first = await sendMessage(
      { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: fromTask.id } },
      { to: `task:${toTask.id}`, body: "cross-run hi" },
      { spawnRunner: (() => 1) as never },
    );
    if (first.delivery !== "turn_started") {
      expect(startTurnIfIdle(ctx, toTask.id, (() => 1) as never)).toBe("turn_started");
    }
    expect(parseSpent(getRun(ctx, sender.id)!.spent).messageTurns).toBe(1);
    expect(budgetAllowsMessage(ctx, sender.id)).toBe(true);
  });

  test("ordinary session → another tree's child refused with today's exact text", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const mk = () => createTask(ctx, { brief: { goal: "g", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    const top = mk();
    updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
    registerWork(ctx, top.id, { allowDelegation: true });
    const a = mk();
    registerWork(ctx, a.id, {}, top.id);
    const user = mk();
    updateTask(ctx, user.id, t => { t.origin = "human"; });

    const message = errMsg(() => checkSend(ctx, send(`task:${a.id}`, `task:${user.id}`)));
    expect(message).toBe(
      `Messaging from task:${a.id} to task:${user.id} (none) is not allowed: no rule matched`,
    );
    expect(reason(() => checkSend(ctx, send(`task:${a.id}`, `task:${user.id}`)))).toBe("msg_forbidden");
  });

  test("a project rule narrowing run_peer wins over the default allow", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const key = "github.com/example/route";
    const sender = insertRun(ctx, { workflow: "t/a", version: 1, repo, brief: "a" });
    const receiver = insertRun(ctx, { workflow: "t/b", version: 1, repo, brief: "b" });
    const fromTask = createTask(ctx, { brief: { goal: "from", repo }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const toTask = createTask(ctx, { brief: { goal: "to", repo }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    // Distinct tops so relation is run_peer; stamp project key on the recipient root
    // (effectivePolicy reads repo from the recipient tree root).
    const topFrom = createTask(ctx, { brief: { goal: "top-from", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    const topTo = createTask(ctx, { brief: { goal: "top-to", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    for (const id of [topFrom.id, topTo.id]) {
      updateTask(ctx, id, t => {
        t.origin = "external:claude-code";
        t.state = "running";
        t.repo = { key, label: "route", path: repo, source: "local" } as typeof t.repo;
      });
      registerWork(ctx, id, { allowDelegation: true });
    }
    registerWork(ctx, fromTask.id, {}, topFrom.id);
    registerWork(ctx, toTask.id, {}, topTo.id);
    updateTask(ctx, fromTask.id, t => {
      t.repo = { key, label: "route", path: repo, source: "local" } as typeof t.repo;
    });
    updateTask(ctx, toTask.id, t => {
      t.repo = { key, label: "route", path: repo, source: "local" } as typeof t.repo;
    });
    insertStep(ctx, { runId: sender.id, stepId: "a", attempt: 1, branch: "", taskId: fromTask.id, status: "running" });
    insertStep(ctx, { runId: receiver.id, stepId: "b", attempt: 1, branch: "", taskId: toTask.id, status: "running" });

    await callOp(ctx, "project.messaging.set", {
      repo: key, expect_rev: 0,
      rules: [{ effect: "deny", relation: ["run_peer"] }],
    });
    expect(relation(ctx, `task:${fromTask.id}`, `task:${toTask.id}`)).toBe("run_peer");
    expect(reason(() => checkSend(ctx, send(`task:${fromTask.id}`, `task:${toTask.id}`)))).toBe("msg_forbidden");
    const e = (() => { try { checkSend(ctx, send(`task:${fromTask.id}`, `task:${toTask.id}`)); } catch (err) { return err as CoreError; } })()!;
    expect(e.data).toMatchObject({ reason: "msg_forbidden", layer: "project" });
  });

  test("rate caps still apply on the run_peer route", () => {
    const ctx = fakeCtx({ now: 1_700_000_000 });
    writeStrategy(ctx, "messaging:\n  rules:\n    - {effect: allow, relation: [run_peer], limits: {per_minute: 1}}\n");
    const repoA = tmpDir();
    const repoB = tmpDir();
    const sender = insertRun(ctx, { workflow: "t/a", version: 1, repo: repoA, brief: "a" });
    const receiver = insertRun(ctx, { workflow: "t/b", version: 1, repo: repoB, brief: "b" });
    const fromTask = createTask(ctx, { brief: { goal: "from", repo: repoA }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const toTask = createTask(ctx, { brief: { goal: "to", repo: repoB }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    nestUnderTop(ctx, fromTask.id, repoA);
    nestUnderTop(ctx, toTask.id, repoB);
    insertStep(ctx, { runId: sender.id, stepId: "a", attempt: 1, branch: "", taskId: fromTask.id, status: "running" });
    insertStep(ctx, { runId: receiver.id, stepId: "b", attempt: 1, branch: "", taskId: toTask.id, status: "running" });

    expect(relation(ctx, `task:${fromTask.id}`, `task:${toTask.id}`)).toBe("run_peer");
    expect(reason(() => checkSend(ctx, send(`task:${fromTask.id}`, `task:${toTask.id}`)))).toBe("allowed");
    msgStore.insertMessage(ctx, {
      taskId: toTask.id, rootId: `task:${toTask.id}`,
      from: `task:${fromTask.id}`, to: `task:${toTask.id}`,
      kind: "message", body: "prior", replyTo: null, requestId: null, status: "pending",
    });
    const e = (() => { try { checkSend(ctx, send(`task:${fromTask.id}`, `task:${toTask.id}`)); } catch (err) { return err as CoreError; } })()!;
    expect(e.data?.reason).toBe("msg_cap_reached");
  });

  test("non-participant cannot forge a marker; resolve only from stored rows", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const receiver = insertRun(ctx, { workflow: "t/b", version: 1, repo: tmpDir(), brief: "b" });
    const parent = createTask(ctx, { brief: { goal: "p", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    updateTask(ctx, parent.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
    registerWork(ctx, parent.id, { allowDelegation: true });
    const outsider = createTask(ctx, { brief: { goal: "out", repo }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    registerWork(ctx, outsider.id, {}, parent.id);
    const toTask = createTask(ctx, { brief: { goal: "to", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    insertStep(ctx, { runId: receiver.id, stepId: "b", attempt: 1, branch: "", taskId: toTask.id, status: "running" });
    expect(relation(ctx, `task:${outsider.id}`, `task:${toTask.id}`)).toBe("none");
    expect(reason(() => checkSend(ctx, send(`task:${outsider.id}`, `task:${toTask.id}`)))).toBe("msg_forbidden");
  });

  test("engine-owned orchestrate is not a run_peer target", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const orch = createTask(ctx, { brief: { goal: "orch", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600 });
    const other = createTask(ctx, { brief: { goal: "ex", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const runA = insertRun(ctx, {
      workflow: "t/a", version: 1, repo: tmpDir(), brief: "a",
      orchestratorTaskId: orch.id,
    });
    const runB = insertRun(ctx, { workflow: "t/b", version: 1, repo: tmpDir(), brief: "b" });
    insertStep(ctx, { runId: runB.id, stepId: "b", attempt: 1, branch: "", taskId: other.id, status: "running" });
    expect(getRun(ctx, runA.id)?.orchestratorTaskId).toBe(orch.id);
    expect(runIdForParticipant(ctx, `task:${orch.id}`)).toBeNull();
    expect(relation(ctx, `task:${orch.id}`, `task:${other.id}`)).not.toBe("run_peer");
  });

  test("participant name orchestrator never forges from PACER_TASK_ID", () => {
    const ctx = fakeCtx({ env: { PACER_TASK_ID: "t-forged0001" } });
    writeStrategy(ctx);
    const stepTask = createTask(ctx, {
      brief: { goal: "s", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600,
    });
    // Even if PACER_TASK_ID matches a real step task, the bare name "orchestrator" is not a participant.
    const run = insertRun(ctx, { workflow: "t/a", version: 1, repo: tmpDir(), brief: "a" });
    insertStep(ctx, { runId: run.id, stepId: "a", attempt: 1, branch: "", taskId: stepTask.id, status: "running" });
    ctx.env.PACER_TASK_ID = stepTask.id;
    expect(runIdForParticipant(ctx, "orchestrator")).toBeNull();
    expect(runIdForParticipant(ctx, `task:${stepTask.id}`)).toBe(run.id);
  });

  test("terminal-run participant is not a run_peer", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repoA = tmpDir();
    const repoB = tmpDir();
    const sender = insertRun(ctx, { workflow: "t/a", version: 1, repo: repoA, brief: "a" });
    const receiver = insertRun(ctx, { workflow: "t/b", version: 1, repo: repoB, brief: "b" });
    const fromTask = createTask(ctx, { brief: { goal: "from", repo: repoA }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const toTask = createTask(ctx, { brief: { goal: "to", repo: repoB }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    nestUnderTop(ctx, fromTask.id, repoA);
    nestUnderTop(ctx, toTask.id, repoB);
    insertStep(ctx, { runId: sender.id, stepId: "a", attempt: 1, branch: "", taskId: fromTask.id, status: "running" });
    insertStep(ctx, { runId: receiver.id, stepId: "b", attempt: 1, branch: "", taskId: toTask.id, status: "running" });
    updateRun(ctx, receiver.id, getRun(ctx, receiver.id)!.rev, { status: "done" });
    expect(runIdForParticipant(ctx, `task:${toTask.id}`)).toBeNull();
    expect(relation(ctx, `task:${fromTask.id}`, `task:${toTask.id}`)).toBe("none");
  });

  test("same-tree run participants keep sibling (run_peer is additive)", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const run = insertRun(ctx, { workflow: "t/a", version: 1, repo, brief: "a" });
    const top = createTask(ctx, { brief: { goal: "top", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
    registerWork(ctx, top.id, { allowDelegation: true });
    const a = createTask(ctx, { brief: { goal: "a", repo }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const b = createTask(ctx, { brief: { goal: "b", repo }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    registerWork(ctx, a.id, {}, top.id);
    registerWork(ctx, b.id, {}, top.id);
    insertStep(ctx, { runId: run.id, stepId: "a", attempt: 1, branch: "", taskId: a.id, status: "running" });
    insertStep(ctx, { runId: run.id, stepId: "b", attempt: 1, branch: "", taskId: b.id, status: "running" });
    expect(relation(ctx, `task:${a.id}`, `task:${b.id}`)).toBe("sibling");
    // Narrowing sibling still requires a grant (default rule), not widened by run_peer.
    expect(reason(() => checkSend(ctx, send(`task:${a.id}`, `task:${b.id}`)))).toBe("msg_forbidden");
    expect(reason(() => checkSend(ctx, send(`task:${a.id}`, `task:${b.id}`, true)))).toBe("allowed");
  });

  test("fail closed when workflow tables are absent", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const mk = () => createTask(ctx, { brief: { goal: "g", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    const top = mk();
    updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
    registerWork(ctx, top.id, { allowDelegation: true });
    const a = mk();
    registerWork(ctx, a.id, {}, top.id);
    const user = mk();
    updateTask(ctx, user.id, t => { t.origin = "human"; });
    expect(relation(ctx, `task:${a.id}`, `task:${user.id}`)).toBe("none");
    expect(reason(() => checkSend(ctx, send(`task:${a.id}`, `task:${user.id}`)))).toBe("msg_forbidden");
  });

  test("byte-for-byte ordinary default routes unchanged (sibling still needs grant)", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const repo = tmpDir();
    const mk = () => createTask(ctx, { brief: { goal: "g", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    const top = mk();
    updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
    registerWork(ctx, top.id, { allowDelegation: true });
    const a = mk();
    registerWork(ctx, a.id, {}, top.id);
    const b = mk();
    registerWork(ctx, b.id, {}, top.id);
    expect(reason(() => checkSend(ctx, send(`task:${a.id}`, `task:${b.id}`)))).toBe("msg_forbidden");
    expect(reason(() => checkSend(ctx, send(`task:${a.id}`, `task:${b.id}`, true)))).toBe("allowed");
    expect(effectivePolicy(ctx).rules.filter(r => r.layer === "default")).toHaveLength(7);
  });
});

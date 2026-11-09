import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { assertCallerCanInvoke, TASK_REVIEW_REFUSAL } from "../src/api/caller-policy";
import { callOp } from "../src/api/ops";
import { handleV2 } from "../src/api/http";
import { runStdio } from "../src/api/stdio";
import { createMcpServer } from "../src/mcp/server";
import { startServer } from "../src/serve/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { main } from "../src/cli";
import type { Ctx } from "../src/types";

/** A plain executor session: delegated, but holding no work grant. */
function executor(ctx: Ctx): Ctx {
  return { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } };
}

/** A managed executor session whose running parent task owns a valid attempt-bound grant. */
function grantedExecutor(ctx: Ctx, parentId: string): { ctx: Ctx; grant: string } {
  const grant = issueWorkGrant(ctx, parentId, 1);
  return { grant, ctx: { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: grant } } };
}

/** A running managed root that may delegate children, a child under it, and an unrelated plain task. */
function work() {
  const ctx = fakeCtx();
  const parent = createTask(ctx, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, parent.id, { allowDelegation: true });
  updateTask(ctx, parent.id, t => { t.state = "running"; });
  const child = createTask(ctx, { brief: { goal: "child", repo: parent.brief.repo }, kind: "debug", requestedExecutor: null, timeoutS: 60 });
  registerWork(ctx, child.id, {}, parent.id);
  const plain = createTask(ctx, { brief: { goal: "plain", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 60 });
  return { ctx, parent, child, plain };
}

test("executor is denied task.review on its own task for every verdict", () => {
  const { ctx: base, parent } = work();
  const ctx = executor(base);
  for (const verdict of ["accept", "reject", "send_back"]) {
    expect(() => assertCallerCanInvoke(ctx, "task.review", { id: parent.id, verdict }))
      .toThrow(expect.objectContaining({ code: "not_allowed" }));
  }
});

test("an executor without a work grant cannot review anything with task.review", () => {
  const { ctx: base, parent, child, plain } = work();
  const ctx = executor(base);
  for (const id of [parent.id, child.id, plain.id])
    expect(() => assertCallerCanInvoke(ctx, "task.review", { id, verdict: "accept" }))
      .toThrow(expect.objectContaining({ code: "not_allowed" }));
  expect(() => assertCallerCanInvoke(ctx, "task.review", { id: child.id, verdict: "accept" })).toThrow(TASK_REVIEW_REFUSAL);
});

test("an executor with a valid child work grant can review that child, but never its own task", () => {
  const { ctx: base, parent, child, plain } = work();
  const { ctx } = grantedExecutor(base, parent.id);
  // The child it dispatched is in scope for an accept or reject review.
  for (const verdict of ["accept", "reject"]) {
    expect(() => assertCallerCanInvoke(ctx, "task.review", { id: child.id, verdict })).not.toThrow();
  }
  // send_back and retry are never verdicts an executor may pass, even on a granted child.
  for (const verdict of ["send_back", "retry"]) {
    expect(() => assertCallerCanInvoke(ctx, "task.review", { id: child.id, verdict }))
      .toThrow(expect.objectContaining({ code: "not_allowed" }));
  }
  // Its own task and unrelated tasks stay out of scope.
  expect(() => assertCallerCanInvoke(ctx, "task.review", { id: parent.id, verdict: "accept" })).toThrow(expect.objectContaining({ code: "not_allowed" }));
  expect(() => assertCallerCanInvoke(ctx, "task.review", { id: plain.id, verdict: "accept" })).toThrow(expect.objectContaining({ code: "not_allowed" }));
});

test("an executor cannot use task.review with send_back or retry even on a granted child", () => {
  const { ctx: base, parent, child } = work();
  const { ctx } = grantedExecutor(base, parent.id);
  // send_back and retry are dispatched onward (per pacer dispatch retry / pacer dispatch answer),
  // never authorized by a child review grant.
  for (const verdict of ["send_back", "retry"]) {
    expect(() => assertCallerCanInvoke(ctx, "task.review", { id: child.id, verdict }))
      .toThrow(expect.objectContaining({ code: "not_allowed" }));
  }
});

test("a stale grant no longer authorizes a review", () => {
  const { ctx: base, parent, child } = work();
  const { ctx } = grantedExecutor(base, parent.id);
  updateTask(base, parent.id, t => { t.state = "done"; });
  expect(() => assertCallerCanInvoke(ctx, "task.review", { id: child.id, verdict: "accept" })).toThrow(expect.objectContaining({ code: "not_allowed" }));
});

test("planner and human callers can review without restriction", () => {
  const { ctx: base, parent } = work();
  for (const ctx of [base, { ...base, env: { ...base.env, PACER_ROLE: "planner" } }]) {
    for (const verdict of ["accept", "reject", "send_back", "retry"]) {
      expect(() => assertCallerCanInvoke(ctx, "task.review", { id: parent.id, verdict, note: "again", executor: "x" })).not.toThrow();
    }
  }
});

test("task.hand_back is denied to executors", () => {
  const { ctx: base, parent } = work();
  const ctx = executor(base);
  expect(() => assertCallerCanInvoke(ctx, "task.hand_back", { id: parent.id })).toThrow(expect.objectContaining({ code: "not_allowed" }));
  // A human handing a task back is unaffected.
  expect(() => assertCallerCanInvoke(base, "task.hand_back", { id: parent.id })).not.toThrow();
});

/** A settled plain task in a usable strategy home, for driving the `pacer review` CLI. */
function cliFixture() {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "worktrees", "x"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const task = createTask(ctx, { brief: { goal: "own", repo: tmpDir() }, kind: "debug", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex#codex", model: null, files: "", report: "", backend: "direct" };
  });
  return { ctx, task };
}

test("pacer review CLI refuses an executor reviewing its own task", async () => {
  const { ctx: base, task } = cliFixture();
  expect((await main(["review", task.id, "--reject"], base)).code).toBe(0);
  expect(readTask(base, task.id)?.review).toMatchObject({ accepted: false });

  const exec = executor(base);
  const result = await main(["review", task.id, "--reject"], exec);
  expect(result.code).toBe(2);
  expect(result.err).toContain("cannot review their own task");
  expect(readTask(exec, task.id)?.review).toMatchObject({ accepted: false }); // unchanged
});

test("pacer review CLI lets an executor review a child under its own grant", async () => {
  const { ctx: base, parent, child } = work();
  const { ctx } = grantedExecutor(base, parent.id);
  updateTask(base, child.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex#codex", model: null, files: "", report: "", backend: "direct" };
  });
  const result = await main(["review", child.id, "--reject"], ctx);
  expect(result.code).toBe(0);
  expect(readTask(ctx, child.id)?.review).toMatchObject({ accepted: false });
  // Its own task stays out of scope even through the CLI.
  expect((await main(["review", parent.id, "--reject"], ctx)).code).toBe(2);
});

/** A settled (done) reviewable child under a running parent whose grant the executor holds. */
function grantedChild() {
  const { ctx: base, parent, child, plain } = work();
  const { ctx } = grantedExecutor(base, parent.id);
  updateTask(base, child.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex#codex", model: null, files: "", report: "", backend: "direct" };
  });
  return { base, parent, child, plain, ctx };
}

test("callOp refuses an executor reviewing its own task with no grant, and allows a child under a grant", async () => {
  // The shared dispatch gate every transport goes through: refused for an own, grant-less review.
  const { ctx: base, parent } = work();
  const exec = executor(base);
  for (const verdict of ["accept", "reject"]) {
    await expect(callOp(exec, "task.review", { id: parent.id, verdict }))
      .rejects.toThrow(expect.objectContaining({ code: "not_allowed", message: TASK_REVIEW_REFUSAL }));
  }
  // Allowed only for a child in grant scope, with accept or reject.
  for (const verdict of ["accept", "reject"]) {
    const granted = grantedChild();
    const res = await callOp(granted.ctx, "task.review", { id: granted.child.id, expect_rev: readTask(granted.ctx, granted.child.id)!.rev, verdict }) as { task: { review?: { accepted: boolean } } };
    expect(res.task.review?.accepted).toBe(verdict === "accept");
  }
  // Its own task stays refused even holding a valid grant.
  const granted = grantedChild();
  await expect(callOp(granted.ctx, "task.review", { id: granted.parent.id, verdict: "accept" }))
    .rejects.toThrow(expect.objectContaining({ code: "not_allowed", message: TASK_REVIEW_REFUSAL }));
});

test("HTTP v3 task.review refuses an executor's own task and allows a child under a grant", async () => {
  const op = (execCtx: Ctx, params: Record<string, unknown>) =>
    handleV2(new Request("http://localhost/v3/ops/task.review", { method: "POST", body: JSON.stringify(params) }), { getCtx: () => execCtx });

  const { ctx: base, parent } = work();
  const refused = await op(executor(base), { id: parent.id, verdict: "accept" });
  expect(refused.status).toBe(403);
  expect((await refused.json()).error.message).toContain("cannot review their own task");

  const granted = grantedChild();
  const allowed = await op(granted.ctx, { id: granted.child.id, expect_rev: readTask(granted.ctx, granted.child.id)!.rev, verdict: "reject" });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).result.task.review).toMatchObject({ accepted: false });
});

/** A granted executor behind a real local service, so grant-routed transports can reach it over HTTP. */
async function grantedService() {
  const base = fakeCtx();
  mkdirSync(base.pacerHome, { recursive: true });
  writeFileSync(join(base.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const parent = createTask(base, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(base, parent.id, { allowDelegation: true });
  updateTask(base, parent.id, t => { t.state = "running"; });
  const child = createTask(base, { brief: { goal: "child", repo: parent.brief.repo }, kind: "debug", requestedExecutor: null, timeoutS: 60 });
  registerWork(base, child.id, {}, parent.id);
  const grant = issueWorkGrant(base, parent.id, 1);
  updateTask(base, child.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex#codex", model: null, files: "", report: "", backend: "direct" };
  });
  const grantCtx: Ctx = { ...base, env: { ...base.env, PACER_WORK_GRANT: grant, PACER_ROLE: "executor", PACER_PORT: "" } };
  const server = startServer(() => grantCtx, { port: 0, listener: false, pumpMs: 0 });
  grantCtx.env = { ...grantCtx.env, PACER_PORT: String(server.port) };
  return { base, parent, child, grant, grantCtx, server };
}

test("stdio JSON-RPC task.review refuses an executor's own task (no grant) and allows a child under a grant", async () => {
  const rpc = async (execCtx: Ctx, params: Record<string, unknown>) => {
    const out: any[] = [];
    await runStdio(execCtx, (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } });
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.review", params });
    })(), line => out.push(JSON.parse(line)));
    return out;
  };

  const { ctx: base, parent } = work();
  const refused = await rpc(executor(base), { id: parent.id, verdict: "accept" });
  const err = refused.find(r => r?.id === 2);
  expect(err.error.data.code).toBe("not_allowed");
  expect(err.error.message).toContain("cannot review their own task");

  const svc = await grantedService();
  try {
    // With a grant, stdio forwards the op over HTTP; the shared gate still allows only the child.
    const allowed = await rpc(svc.grantCtx, { id: svc.child.id, expect_rev: readTask(svc.grantCtx, svc.child.id)!.rev, verdict: "reject" });
    const ok = allowed.find(r => r?.id === 2);
    expect(ok.result?.task?.review).toMatchObject({ accepted: false });
    expect(readTask(svc.base, svc.child.id)?.review).toMatchObject({ accepted: false });
  } finally {
    await svc.server.stop();
  }
});

test("MCP task_review refuses an executor (no grant) reviewing its own task", async () => {
  const { ctx: base, parent } = work();
  const server = createMcpServer(() => executor(base));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(ct);
  try {
    const r = await client.callTool({ name: "task_review", arguments: { task_id: parent.id, verdict: "accept" } }) as any;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("cannot review their own task");
  } finally {
    await client.close();
  }
});

test("MCP task_review lets a granted executor review its child over the scoped HTTP path", async () => {
  const svc = await grantedService();
  const mcp = createMcpServer(() => svc.grantCtx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(ct);
  try {
    // In grant mode task_review dispatches the scoped dispatch.review op to the service.
    const r = await client.callTool({ name: "task_review", arguments: { task_id: svc.child.id, accepted: true, expect_rev: readTask(svc.grantCtx, svc.child.id)!.rev } }) as any;
    expect(r.isError ?? false).toBe(false);
    expect(readTask(svc.base, svc.child.id)?.review).toMatchObject({ accepted: true });
  } finally {
    await client.close();
    await svc.server.stop();
  }
});
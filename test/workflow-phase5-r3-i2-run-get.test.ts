import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { runCmd } from "../src/commands/run";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { getRun, insertRun, workflowDatabase } from "../src/workflow/store";
import { ensureRunBranch } from "../src/workflow/branch";
import { insertTurn } from "../src/workflow/wakeups";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

function writePlanner(ctx: Ctx) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function grantCtx(ctx: Ctx, bearer: string, port?: number): Ctx {
  return {
    ...ctx,
    env: {
      ...ctx.env,
      PACER_RUN_GRANT: bearer,
      PACER_ROLE: "orchestrator",
      ...(port !== undefined ? { PACER_PORT: String(port) } : {}),
    },
  };
}

async function seededGrantRun(ctx: Ctx) {
  writePlanner(ctx);
  workflowDatabase(ctx);
  const repo = gitRepo();
  const run = insertRun(ctx, {
    workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain",
  });
  await ensureRunBranch(ctx, run);
  const { setPublishOptIn } = await import("../src/workflow/store");
  setPublishOptIn(ctx, run.id, "draft");
  const orch = createTask(ctx, {
    brief: { goal: "orch", repo }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
  });
  updateTask(ctx, orch.id, t => { t.state = "running"; });
  insertTurn(ctx, {
    id: "turn_r3i2", runId: run.id, planner: "claude-code", status: "running",
    startedAt: NOW, deadline: NOW + 1200, taskId: orch.id,
  });
  const bearer = issueRunGrant(ctx, { runId: run.id, turnId: "turn_r3i2", deadline: NOW + 3600 });
  return { run: getRun(ctx, run.id)!, bearer, repo };
}

test("R3-I2: run.get accepts a grant for its own run and refuses foreign/unknown with the same text", async () => {
  const ctx = fakeCtx({ now: NOW, run: realRun });
  const { run, bearer } = await seededGrantRun(ctx);
  const granted = grantCtx(ctx, bearer);

  const own = await callOp(granted, "run.get", { id: run.id }) as { run: { id: string; rev: number } };
  expect(own.run.id).toBe(run.id);
  expect(own.run.rev).toBe(run.rev);

  const other = insertRun(ctx, { workflow: "t/other", version: 1, repo: tmpDir(), brief: "x" });
  let foreignMsg = "";
  let unknownMsg = "";
  try {
    await callOp(granted, "run.get", { id: other.id });
  } catch (error) {
    foreignMsg = error instanceof Error ? error.message : String(error);
  }
  try {
    await callOp(granted, "run.get", { id: "run_zzzzzzzzzz" });
  } catch (error) {
    unknownMsg = error instanceof Error ? error.message : String(error);
  }
  expect(foreignMsg).toBe(unknownMsg);
  expect(foreignMsg.length).toBeGreaterThan(0);
});

test("R3-I2: runCmd sync with PACER_RUN_GRANT reaches run.get then sync_base over HTTP", async () => {
  const ctx = fakeCtx({ now: NOW, run: realRun });
  const { run, bearer } = await seededGrantRun(ctx);
  const server = startServer(() => ({ ...ctx, now: NOW }), {
    port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
  });
  try {
    await Bun.sleep(20);
    const granted = grantCtx(ctx, bearer, server.port);
    const out = await runCmd(["sync", run.id, "--json"], granted, {});
    const text = `${out.err}\n${out.out}`;
    expect(text).not.toMatch(/person-only workflow operations/i);
    expect(text).not.toMatch(/Unable to connect/i);
    // Sync of an already-branched run against local main should succeed (code 0) or
    // report a real sync conflict (code 1) — never the old person-only refusal (code 2).
    expect([0, 1]).toContain(out.code);
  } finally {
    await server.stop();
  }
});

test("R3-I2/F5: MCP run_get tool returns the grant's own run", async () => {
  const ctx = fakeCtx({ now: NOW, run: realRun });
  const { run, bearer } = await seededGrantRun(ctx);
  // Grant MCP tools forward over HTTP (allowFallback:false) — need a live serve.
  const http = startServer(() => ({ ...ctx, now: NOW }), {
    port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
  });
  try {
    await Bun.sleep(20);
    const granted = grantCtx(ctx, bearer, http.port);
    const { createMcpServer } = await import("../src/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createMcpServer(() => granted);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain("run_get");
    expect(names).toContain("run_sync_base");
    expect(names).toContain("run_publish");

    const tool = await client.callTool({ name: "run_get", arguments: { id: run.id } });
    expect(tool.isError).toBeFalsy();
    const text = (tool.content as { type: string; text?: string }[])
      .map(c => c.text ?? "").join("\n");
    const parsed = JSON.parse(text) as { run: { id: string; rev: number } };
    expect(parsed.run.id).toBe(run.id);
    expect(parsed.run.rev).toBe(run.rev);
    await client.close();
  } finally {
    await http.stop();
  }
});

test("R3-I2/F5: runCmd publish with PACER_RUN_GRANT reaches run.get then publish over HTTP", async () => {
  const ctx = fakeCtx({ now: NOW, run: realRun });
  const { run, bearer } = await seededGrantRun(ctx);
  const bodyFile = join(tmpDir(), "body.md");
  writeFileSync(bodyFile, "publish body\n");
  const server = startServer(() => ({ ...ctx, now: NOW }), {
    port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
  });
  try {
    await Bun.sleep(20);
    const granted = grantCtx(ctx, bearer, server.port);
    const out = await runCmd(
      ["publish", run.id, "--draft", "--title", "t", "--body-file", bodyFile, "--json"],
      granted,
      {},
    );
    const text = `${out.err}\n${out.out}`;
    expect(text).not.toMatch(/person-only workflow operations/i);
    expect(text).not.toMatch(/Unable to connect/i);
    // Draft publish of a branched run may succeed (0) or hit a real gate —
    // never the old person-only refusal from run.get.
    expect([0, 1, 2]).toContain(out.code);
    if (out.code === 2) {
      expect(text).not.toMatch(/person-only/i);
    }
  } finally {
    await server.stop();
  }
});

test("run.get returns the decision log with reasons to the person, and withholds it from a run grant", async () => {
  const { recordDecision } = await import("../src/workflow/store");
  const ctx = fakeCtx({ now: NOW, run: realRun });
  const { run, bearer } = await seededGrantRun(ctx);
  recordDecision(ctx, { runId: run.id, stepId: "plan", attempt: 1, actor: "person", kind: "choose", choice: "revise", reason: "Take the UX note." });
  const person = await callOp(ctx, "run.get", { id: run.id }) as { decisions?: Array<{ choice: string; reason: string; actor: string }> };
  expect(person.decisions?.map(d => [d.actor, d.choice, d.reason])).toEqual([["person", "revise", "Take the UX note."]]);
  const granted = await callOp(grantCtx(ctx, bearer), "run.get", { id: run.id }) as { decisions?: unknown };
  expect(granted.decisions).toBeUndefined();
});

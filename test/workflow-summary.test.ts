// Phase 6 Task 4: since you last looked (run.seen + summary).
import { expect, test, describe } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { callOp } from "../src/api/ops";
import { issueRunGrant } from "../src/workflow/run-grant";
import {
  answerQuestionRecord, escalateQuestionRecord, insertQuestion, insertRun, getRun,
  replaceRunConflicts, setRunConflict, setRunPrUrl, updateRun, withdrawOpenQuestionsForRun,
} from "../src/workflow/store";
import { openWakeups, insertTurn } from "../src/workflow/wakeups";
import { SUMMARY_MAX_BYTES, needsReturnedSummary } from "../src/workflow/summary";
import { buildTurnPrompt, buildHandoverPrompt } from "../src/workflow/orchestrator";
import { runCmd } from "../src/commands/run";
import { serializeSpent } from "../src/workflow/budget";
import { applyPacingToLiveRuns, type PacingMode } from "../src/workflow/pacing";
import type { Ctx } from "../src/types";
import type { WorkflowDef } from "../src/workflow/schema";

/** Open → cause change → run.seen yields exactly one returned wake. */
async function expectOneReturnedWake(ctx: Ctx, runId: string): Promise<void> {
  const before = openWakeups(ctx, runId).filter(w => w.cause === "returned").length;
  await callOp(ctx, "run.seen", { id: runId });
  expect(openWakeups(ctx, runId).filter(w => w.cause === "returned")).toHaveLength(before + 1);
}

const NOW = 1_700_000_000;

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
}

const tinyDef: WorkflowDef = {
  id: "t/sum",
  version: 1,
  entry: "done",
  steps: { done: { type: "end" } },
  edges: [],
};

describe("since you last looked", () => {
  test("no returned wake when nothing changed", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "b" });
    // First open: no prior last_seen and no changes beyond create — still a first look.
    // Stamp last_seen equal to updated_at so a re-open without further change is quiet.
    updateRun(ctx, run.id, run.rev, { lastSeenAt: run.updatedAt });
    const stamped = getRun(ctx, run.id)!;
    expect(needsReturnedSummary(stamped)).toBe(false);
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(0);
  });

  test("one returned wake per return when something changed", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "b" });
    // Simulate prior look, then a later change.
    run = updateRun(ctx, run.id, run.rev, { lastSeenAt: NOW - 100 });
    ctx.now = NOW + 10;
    run = updateRun(ctx, run.id, run.rev, { title: "moved" });
    expect(needsReturnedSummary(run)).toBe(true);

    await callOp(ctx, "run.seen", { id: run.id });
    const wakes = openWakeups(ctx, run.id).filter(w => w.cause === "returned");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.byPerson).toBe(true);
    expect(wakes[0]!.ref).toBe(`seen:${run.updatedAt}`);

    // Second open before any further change: no additional wake.
    ctx.now = NOW + 20;
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(1);
  });

  test("summary is capped at 4 KiB and data-fenced in later prompts", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "brief body" });
    insertTurn(ctx, {
      id: "turn_sum1", runId: run.id, planner: "claude-code",
      status: "running", startedAt: NOW, deadline: NOW + 1000, failures: 0,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn_sum1", deadline: NOW + 1000 });
    const grantCtx = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant } };
    // Op schema matches the store cap: oversized bodies are refused (not silently truncated).
    await expect(callOp(grantCtx, "run.decide", {
      id: run.id, kind: "summary", summary: "x".repeat(SUMMARY_MAX_BYTES + 1),
    })).rejects.toThrow(/4 KiB|4096|Summary exceeds/i);
    const body = "x".repeat(SUMMARY_MAX_BYTES);
    const updated = await callOp(grantCtx, "run.decide", {
      id: run.id, kind: "summary", summary: body,
    }) as { summary?: string; summaryAt?: number };
    expect(Buffer.byteLength(updated.summary ?? "", "utf8")).toBe(SUMMARY_MAX_BYTES);
    run = getRun(ctx, run.id)!;
    expect(run.summaryAt).toBe(NOW);

    const prompt = buildTurnPrompt(ctx, run, [], tinyDef, []);
    expect(prompt).toContain("since you last looked");
    expect(prompt).toMatch(/--- data [0-9a-f]+ since you last looked ---/);
    expect(prompt).toContain(run.summary!.slice(0, 40));

    const handover = buildHandoverPrompt(ctx, run, [], tinyDef, []);
    expect(handover).toMatch(/--- data [0-9a-f]+ since you last looked ---/);
  });

  test("run.seen is person-only; run grant cannot call it", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "b" });
    insertTurn(ctx, {
      id: "turn_seen1", runId: run.id, planner: "claude-code",
      status: "running", startedAt: NOW, deadline: NOW + 1000, failures: 0,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn_seen1", deadline: NOW + 1000 });
    const refused = await callOp(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant } },
      "run.seen",
      { id: run.id },
    ).then(() => null, (e: unknown) => e as CoreError);
    expect(refused?.code).toBe("not_allowed");

    const exec = await callOp(
      { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: "t-20260101-000000-0001" } },
      "run.seen",
      { id: run.id },
    ).then(() => null, (e: unknown) => e as CoreError);
    expect(exec?.code).toBe("not_allowed");
  });

  test("CLI run seen calls the op", async () => {
    const ctx = fakeCtx({ now: NOW });
    ctx.env.PACER_API = "inprocess";
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, { lastSeenAt: NOW - 50 });
    ctx.now = NOW + 5;
    run = updateRun(ctx, run.id, run.rev, { title: "changed" });
    const r = await runCmd(["seen", run.id], ctx);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${run.id}  seen`);
    expect(openWakeups(ctx, run.id).some(w => w.cause === "returned")).toBe(true);
  });

  test("CLI run decide --json summary stores via run.decide (≤4 KiB, UTF-8)", async () => {
    const ctx = fakeCtx({ now: NOW });
    ctx.env.PACER_API = "inprocess";
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "brief body" });
    insertTurn(ctx, {
      id: "turn_sum_cli", runId: run.id, planner: "claude-code",
      status: "running", startedAt: NOW, deadline: NOW + 1000, failures: 0,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn_sum_cli", deadline: NOW + 1000 });
    // Multi-byte prefix + pad to exactly SUMMARY_MAX_BYTES (op schema == store cap).
    const prefix = "café ";
    const pad = "x".repeat(SUMMARY_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
    const body = prefix + pad;
    expect(Buffer.byteLength(body, "utf8")).toBe(SUMMARY_MAX_BYTES);
    // Positional id + --json without id in the payload (odd form).
    const payload = JSON.stringify({ kind: "summary", summary: body });
    const r = await runCmd(
      ["decide", run.id, "--json", payload],
      { ...ctx, env: { ...ctx.env, PACER_API: "inprocess", PACER_RUN_GRANT: grant } },
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { summary?: string };
    expect(Buffer.byteLength(out.summary ?? "", "utf8")).toBe(SUMMARY_MAX_BYTES);
    const stored = getRun(ctx, run.id)!;
    expect(stored.summary).toBe(out.summary);
    expect(stored.summaryAt).toBe(NOW);
    const prompt = buildTurnPrompt(ctx, stored, [], tinyDef, []);
    expect(prompt).toMatch(/--- data [0-9a-f]+ since you last looked ---/);
    expect(prompt).toContain(stored.summary!.slice(0, 20));
  });

  test("fresher summary suppresses another returned wake", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, { lastSeenAt: NOW - 100 });
    ctx.now = NOW + 1;
    run = updateRun(ctx, run.id, run.rev, { title: "changed" });
    ctx.now = NOW + 2;
    run = updateRun(ctx, run.id, run.rev, { summary: "already told you", summaryAt: ctx.now });
    expect(needsReturnedSummary(run)).toBe(false);
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(0);
  });

  test("post-turn bookkeeping does not re-trigger a returned wake", async () => {
    // open → summary turn → reopen immediately: no turn; real change → one turn.
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, { lastSeenAt: NOW - 50 });
    ctx.now = NOW + 1;
    run = updateRun(ctx, run.id, run.rev, { title: "real change" }); // bumps meaningful_at
    const stamp = run.meaningfulAt!;
    expect(needsReturnedSummary(run)).toBe(true);
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(1);

    // Summary write + orchestrator bookkeeping bump updated_at but not meaningful_at.
    ctx.now = NOW + 2;
    run = getRun(ctx, run.id)!;
    run = updateRun(ctx, run.id, run.rev, { summary: "looked", summaryAt: ctx.now });
    ctx.now = NOW + 3;
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "idle", nextWakeAt: null, spent: serializeSpent({ orchestratorTurns: 1, messageTurns: 0 }),
    });
    expect(run.meaningfulAt).toBe(stamp);
    expect(run.updatedAt).toBe(NOW + 3);
    expect(needsReturnedSummary(run)).toBe(false);
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(1);

    // A later real change wakes once more.
    ctx.now = NOW + 4;
    run = updateRun(ctx, getRun(ctx, run.id)!.id, getRun(ctx, run.id)!.rev, { title: "again" });
    expect(needsReturnedSummary(run)).toBe(true);
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(2);
  });

  test("conflict / pr_url / question paths bump meaningful_at; pacing and bookkeeping do not", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);

    const openSeen = (brief: string) => {
      let run = insertRun(ctx, { workflow: "t/sum", version: 1, repo: tmpDir(), brief });
      // Quiet baseline: last look matches the create stamp.
      run = updateRun(ctx, run.id, run.rev, { lastSeenAt: run.meaningfulAt ?? run.updatedAt });
      return run;
    };

    // Conflict set → one wake.
    let run = openSeen("conflict");
    ctx.now = (run.meaningfulAt ?? run.updatedAt) + 1;
    setRunConflict(ctx, run.id, {
      taskId: "t1", branch: "main", resolutionTaskId: "t1-fix",
    });
    await expectOneReturnedWake(ctx, run.id);

    // Conflict clear → one wake.
    run = getRun(ctx, run.id)!;
    updateRun(ctx, run.id, run.rev, { lastSeenAt: run.meaningfulAt ?? run.updatedAt });
    ctx.now = (getRun(ctx, run.id)!.meaningfulAt ?? ctx.now) + 1;
    replaceRunConflicts(ctx, run.id, []);
    await expectOneReturnedWake(ctx, run.id);

    // PR URL → one wake.
    run = openSeen("pr");
    ctx.now = (run.meaningfulAt ?? run.updatedAt) + 1;
    setRunPrUrl(ctx, run.id, "https://example.com/pr/1");
    await expectOneReturnedWake(ctx, run.id);

    // Question insert → one wake.
    run = openSeen("q-ins");
    ctx.now = (run.meaningfulAt ?? run.updatedAt) + 1;
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "done", attempt: 1, askerKind: "orchestrator",
      text: "Pick?", answerType: "yes_no", blocks: "nothing", answerer: "person",
    });
    await expectOneReturnedWake(ctx, run.id);

    // Answer → one wake.
    run = getRun(ctx, run.id)!;
    updateRun(ctx, run.id, run.rev, { lastSeenAt: run.meaningfulAt ?? run.updatedAt });
    ctx.now = (getRun(ctx, run.id)!.meaningfulAt ?? ctx.now) + 1;
    answerQuestionRecord(ctx, q.id, { answer: "yes", expectRev: q.rev, answeredBy: "person" });
    await expectOneReturnedWake(ctx, run.id);

    // Escalate → one wake.
    run = openSeen("q-esc");
    ctx.now = (run.meaningfulAt ?? run.updatedAt) + 1;
    const q2 = insertQuestion(ctx, {
      runId: run.id, stepId: "done", attempt: 1, askerKind: "executor",
      text: "Esc?", answerType: "text", blocks: "step", answerer: "orchestrator",
    });
    // Insert already bumped; re-stamp seen, then escalate.
    run = getRun(ctx, run.id)!;
    updateRun(ctx, run.id, run.rev, { lastSeenAt: run.meaningfulAt ?? run.updatedAt });
    ctx.now = (getRun(ctx, run.id)!.meaningfulAt ?? ctx.now) + 1;
    escalateQuestionRecord(ctx, q2.id, { suggested: "try this", expectRev: q2.rev, by: "orchestrator" });
    await expectOneReturnedWake(ctx, run.id);

    // Withdraw → one wake.
    run = openSeen("q-wd");
    ctx.now = (run.meaningfulAt ?? run.updatedAt) + 1;
    insertQuestion(ctx, {
      runId: run.id, stepId: "done", attempt: 1, askerKind: "orchestrator",
      text: "Bye?", answerType: "yes_no", blocks: "nothing", answerer: "person",
    });
    run = getRun(ctx, run.id)!;
    updateRun(ctx, run.id, run.rev, { lastSeenAt: run.meaningfulAt ?? run.updatedAt });
    ctx.now = (getRun(ctx, run.id)!.meaningfulAt ?? ctx.now) + 1;
    expect(withdrawOpenQuestionsForRun(ctx, run.id).length).toBeGreaterThan(0);
    await expectOneReturnedWake(ctx, run.id);

    // Pacing pause/resume flips: no wake.
    run = openSeen("pace");
    const stamp = getRun(ctx, run.id)!.meaningfulAt;
    ctx.now = (stamp ?? ctx.now) + 1;
    await applyPacingToLiveRuns(ctx, async (): Promise<PacingMode> => "emergency");
    expect(getRun(ctx, run.id)!.pausedReason).toBe("pacing: emergency");
    expect(getRun(ctx, run.id)!.meaningfulAt).toBe(stamp);
    await applyPacingToLiveRuns(ctx, async (): Promise<PacingMode> => "normal");
    expect(getRun(ctx, run.id)!.pausedReason).toBeUndefined();
    expect(getRun(ctx, run.id)!.meaningfulAt).toBe(stamp);
    await callOp(ctx, "run.seen", { id: run.id });
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "returned")).toHaveLength(0);
  });
});

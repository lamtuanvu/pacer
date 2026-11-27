// An answer to a blocking question reaches a live interactive planner turn through
// the message lane. Exactly one of that delivery or a later turn carries it, and the
// lane never starts a planner turn of its own. Real engine, tick, ops and session
// viewer hub; only delegation and process launch are faked.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { callOp } from "../src/api/ops";
import type { DelegateInput, SpawnRunner } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunRef, TaskState } from "../src/tasks/types";
import type { RunState } from "../src/supervisor/run";
import { liveTick } from "../src/messaging/live";
import { sendMessage } from "../src/messaging/send";
import { analyzeLiveness, buildSnapshot } from "../src/messaging/liveness";
import * as store from "../src/messaging/store";
import { FrameType, wire } from "../src/session/framing";
import { ViewerHub, type DeliveryTiming } from "../src/session/viewers";
import { addDefinition, getRun, stepsOfRun, workflowDatabase } from "../src/workflow/store";
import { recordStepResult, startRun, stopRun, type EngineDeps } from "../src/workflow/engine";
import { advanceRuns } from "../src/workflow/tick";
import { askQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import { recoverOrphanTurns } from "../src/workflow/orchestrator";
import { liveTurn, openWakeups } from "../src/workflow/wakeups";
import type { WorkflowDef } from "../src/workflow/schema";

const PASTE_START = "\x1b[200~";
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A session socket served by the real viewer hub, recording what reaches the PTY and publishing `session.state` as the host does. */
function fakeSession(dir: string, o: { modern?: boolean; timing?: Partial<DeliveryTiming> } = {}) {
  const sock = join(mkdtempSync("/tmp/pl-"), "s.sock");
  writeFileSync(join(dir, "session.sock.path"), sock);
  const input: Buffer[] = [], events: string[] = [];
  const published = (viewers: number, controller: string | null) =>
    writeFileSync(join(dir, "session.state"), JSON.stringify({ viewers, controller, cols: 120, rows: 40 }));
  const hub = new ViewerHub(() => wire(FrameType.snapshot, {}), () => null, fn => fn(), kind => events.push(kind), published,
    { input: b => { input.push(Buffer.from(b)); }, resize() {}, release: label => events.push(`release:${label}`) },
    o.modern ? { pacer: "0.0.0", versions: [1, 2] } : undefined, o.timing);
  const server = createServer(s => hub.add(s));
  servers.push(server);
  const ready = new Promise<void>(r => server.listen(sock, r));
  return { ready, input, events, hub, sock };
}

function world() {
  const ctx = fakeCtx({ now: 1_700_000_000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  workflowDatabase(ctx);
  const byRequest = new Map<string, string>();
  const delegate: EngineDeps["delegate"] = async (c, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(c, prior)!;
    const task = createTask(c, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task.id);
    return task;
  };
  const deps: EngineDeps = { delegate, stopTask: (c, id) => { updateTask(c, id, t => { t.state = "stopped"; }); } };
  const spawn: SpawnRunner = () => 4242;
  const repo = tmpDir();
  const tick = async (seconds = 31) => {
    ctx.now += seconds;
    await advanceRuns(ctx, spawn, deps, { skipDefaultPacing: true, pacingMode: "normal" });
  };
  const install = (def: WorkflowDef) => { addDefinition(ctx, def, `id: ${def.id}\n`); return def; };
  const start = async (def: WorkflowDef) => startRun(ctx, { workflow: def.id, repo, brief: "B" }, spawn, deps);
  const rows = (runId: string, stepId: string) => stepsOfRun(ctx, runId).filter(s => s.stepId === stepId);
  const row = (runId: string, stepId: string) => rows(runId, stepId).sort((a, b) => b.attempt - a.attempt)[0]!;
  const finish = (taskId: string, state: TaskState = "done") => updateTask(ctx, taskId, t => {
    t.state = state;
    t.result = { status: state as "done", executor: "claude-code", model: null, files: "", report: "", backend: "direct" };
  });
  /** The run's live orchestrator turn, started by the tick. */
  const turn = async (runId: string) => {
    if (!liveTurn(ctx, runId)) await tick();
    const live = liveTurn(ctx, runId);
    if (!live) throw new Error(`no live turn: ${JSON.stringify(getRun(ctx, runId))}`);
    return live;
  };
  const grantCtx = (runId: string): Ctx => {
    const live = liveTurn(ctx, runId)!;
    const bearer = issueRunGrant(ctx, { runId, turnId: live.id, deadline: live.deadline });
    return { ...ctx, env: { ...ctx.env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: bearer, PACER_TASK_ID: live.taskId! } };
  };
  const person = (name: string, params: Record<string, unknown>) =>
    callOp(ctx, name, params, { spawnRunner: spawn, delegate });
  const agent = (c: Ctx, name: string, params: Record<string, unknown>) =>
    callOp(c, name, params, { spawnRunner: spawn, delegate });
  return { ctx, deps, spawn, repo, tick, install, start, rows, row, finish, turn, grantCtx, person, agent };
}

const state = (s: Partial<RunState> & { status?: string } = {}): RunState => ({
  pid: 1, startedAt: 1, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: 2, interactive: true,
  report: { status: (s.status ?? "turn-ended") as never, summary: "s", at: 1000 }, ...(s.controller ? { controller: s.controller } : {}), ...s,
});

const brainstorm: WorkflowDef = {
  id: "t/live", version: 1, entry: "brainstorm",
  steps: {
    brainstorm: { type: "agent", role: "orchestrator", interactive: true, prompt: "Brainstorm {{brief}}" },
    // Keeps the run live after the planner reports, so its turn settles as any turn does.
    sign: { type: "human", question: { text: "Sign?", kind: "approve_revise" } },
    done: { type: "end" },
  },
  edges: [{ from: "brainstorm", to: "sign" }, { from: "sign", to: "done" }],
};

const WORKING: Partial<RunState> & { status?: string } = { status: "running" };

/** A run whose interactive planner turn is live on a real viewer hub. */
async function live() {
  const w = world();
  w.install(brainstorm);
  const run = await w.start(brainstorm);
  const turn = await w.turn(run.id);
  const taskId = turn.taskId!;
  const dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), JSON.stringify({ reportToken: "x" }));
  const ref: RunRef = { dir, attempt: 1, executor: "claude-code", startedAt: 1, mode: "current", workdir: w.repo, logFile: "/dev/null" };
  updateTask(w.ctx, taskId, t => { t.state = "running"; t.run = ref; t.attempts = []; });
  const session = fakeSession(dir);
  await session.ready;
  let mtime = 1000;
  /** The agent ends a response: its Stop hook writes a newer turn-ended report. */
  const ended = () => {
    mtime += 10;
    const path = join(dir, "session-status.json");
    writeFileSync(path, JSON.stringify({ status: "turn-ended", summary: "s", at: mtime }));
    utimesSync(path, mtime, mtime);
  };
  ended();
  /** One poll of the supervisor's live message driver. */
  const poll = async (o: Partial<RunState> & { status?: string } = {}) => {
    const s = state(o);
    await liveTick(w.ctx, readTask(w.ctx, taskId)!, ref, s, { submitDelayMs: 0, readState: () => s });
  };
  const ask = (text = "Which database?") => askQuestion(w.grantCtx(run.id), {
    text, answerType: "text", blocks: "step", stepId: "brainstorm",
  });
  const answer = (q: { id: string; rev: number }, value: string) =>
    w.person("question.answer", { id: q.id, answer: value, expect_rev: q.rev });
  const typed = () => Buffer.concat(session.input).toString();
  const deliveries = () => typed().split(PASTE_START).length - 1;
  const wake = (id: string) => workflowDatabase(w.ctx).query<{ turn_id: string | null; done_at: number | null }, [string]>(
    "SELECT turn_id, done_at FROM workflow_wakeups WHERE cause = 'question' AND ref = ?").get(id)!;
  const turns = () => workflowDatabase(w.ctx).query<{ status: string; reason: string | null; failures: number }, []>(
    "SELECT status, reason, failures FROM workflow_turns ORDER BY seq").all();
  const pending = () => store.pendingFor(w.ctx, `task:${taskId}`);
  /** The next turn's prompt, after the first one is over. */
  const nextPrompt = async () => {
    for (let i = 0; i < 40 && (!liveTurn(w.ctx, run.id) || liveTurn(w.ctx, run.id)!.id === turn.id); i++) await w.tick(61);
    const next = liveTurn(w.ctx, run.id);
    if (!next || next.id === turn.id) throw new Error(`no new turn: ${JSON.stringify(turns())}`);
    return readTask(w.ctx, next.taskId!)!.brief.goal;
  };
  return { w, run, turn, taskId, dir, session, ref, ended, poll, ask, answer, typed, deliveries, wake, turns, pending, nextPrompt };
}

/** No message turn was started outside the engine for the planner task. */
function noRogueTurn(t: Awaited<ReturnType<typeof live>>) {
  expect(readTask(t.w.ctx, t.taskId)!.pendingTurn).toBeUndefined();
  expect(t.pending()).toEqual([]);
}

test("an answer given during a live interactive planner turn is typed into it once", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  // The agent is still working: nothing is typed and the answer stays owed.
  await t.poll(WORKING);
  expect(t.deliveries()).toBe(0);
  expect(t.wake(q.id).done_at).toBeNull();
  await t.poll();
  expect(t.deliveries()).toBe(1);
  expect(t.typed()).toContain("sqlite");
  expect(t.typed()).toContain("Answers to your questions");
  expect(t.wake(q.id).done_at).not.toBeNull();
  t.ended();
  await t.poll();
  await t.poll();
  expect(t.deliveries()).toBe(1);
  // The planner reports no message to anyone for the delivery.
  expect(store.inbox(t.w.ctx, "human")).toEqual([]);
  recordStepResult(t.w.ctx, t.taskId, { ok: true });
  t.w.finish(t.taskId);
  await t.w.tick();
  await t.w.tick();
  expect(t.turns()).toEqual([{ status: "done", reason: null, failures: 0 }]);
  expect(readTask(t.w.ctx, t.taskId)!.liveTurn).toBeUndefined();
  noRogueTurn(t);
});

test("several answers are each delivered once, together or after the next response", async () => {
  const t = await live();
  const [a, b] = [await t.ask("A?"), await t.ask("B?")];
  await t.answer(a, "alpha");
  await t.answer(b, "beta");
  await t.poll();
  expect(t.deliveries()).toBe(1);
  expect(t.typed()).toContain("alpha");
  expect(t.typed()).toContain("beta");
  const c = await t.ask("C?");
  await t.answer(c, "gamma");
  // The agent has not answered the typed message yet.
  await t.poll();
  expect(t.deliveries()).toBe(1);
  t.ended();
  await t.poll();
  await t.poll();
  expect(t.deliveries()).toBe(2);
  expect(t.typed().split("alpha")).toHaveLength(2);
  expect(t.typed()).toContain("gamma");
  for (const q of [a, b, c]) expect(t.wake(q.id).done_at).not.toBeNull();
  expect(openWakeups(t.w.ctx, t.run.id)).toEqual([]);
});

test("nothing is typed while a viewer holds the terminal; it goes once they release it", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll({ controller: "viewer-1" });
  expect(t.deliveries()).toBe(0);
  expect(readTask(t.w.ctx, t.taskId)!.liveBlocked).toBe("viewer");
  expect(t.wake(q.id).done_at).toBeNull();
  await t.poll();
  expect(t.deliveries()).toBe(1);
  expect(readTask(t.w.ctx, t.taskId)!.liveBlocked).toBeUndefined();
});

test("an answer never delivered by the deadline starts a new turn that carries it, uncounted", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll({ controller: "viewer-1" });
  await t.w.tick(7300);
  expect(t.turns()[0]).toEqual({ status: "stopped", reason: "deadline after an answer", failures: 0 });
  expect(await t.nextPrompt()).toContain("sqlite");
  expect(t.deliveries()).toBe(0);
  noRogueTurn(t);
});

test("a deadline after a delivered answer is not a planner failure either", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll();
  await t.w.tick(7300);
  expect(t.turns()[0]).toMatchObject({ status: "stopped", failures: 0 });
  expect(getRun(t.w.ctx, t.run.id)!.orchestratorState).not.toBe("retrying");
  expect(await t.nextPrompt()).toContain("sqlite");
});

test("a deadline with the question still open stays a failed turn", async () => {
  const t = await live();
  await t.ask();
  await t.w.tick(7300);
  expect(t.turns()[0]).toMatchObject({ status: "failed", reason: "deadline", failures: 1 });
});

test("a planner that ends its turn before delivery gets the answer in the next turn", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll({ controller: "viewer-1" });
  t.w.finish(t.taskId);
  await t.w.tick();
  expect(t.turns()[0]).toMatchObject({ status: "done" });
  expect(await t.nextPrompt()).toContain("sqlite");
  noRogueTurn(t);
});

test("input that may have reached the planner is not typed again; an unfinished turn passes it on", async () => {
  for (const finished of [true, false]) {
    const t = await live();
    const q = await t.ask();
    await t.answer(q, "sqlite");
    // As after a crash between typing and recording: the message is claimed, the answer still owed.
    await t.poll({ controller: "viewer-1" });
    store.claimPending(t.w.ctx, `task:${t.taskId}`, `${t.taskId}#live.1`);
    await t.poll();
    expect(t.deliveries()).toBe(0);
    if (finished) recordStepResult(t.w.ctx, t.taskId, { ok: true });
    t.w.finish(t.taskId);
    await t.w.tick();
    if (finished) {
      await t.w.tick();
      expect(t.wake(q.id).done_at).not.toBeNull();
      expect(t.turns()).toHaveLength(1);
      expect(openWakeups(t.w.ctx, t.run.id).filter(w => w.cause === "question")).toEqual([]);
    } else expect(await t.nextPrompt()).toContain("sqlite");
    noRogueTurn(t);
  }
});

test("after a restart that ends the turn, the next turn carries an undelivered answer", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll({ controller: "viewer-1" });
  updateTask(t.w.ctx, t.taskId, x => { x.state = "failed"; delete x.runnerPid; });
  await recoverOrphanTurns(t.w.ctx, {}, {});
  await t.w.tick();
  expect(await t.nextPrompt()).toContain("sqlite");
  noRogueTurn(t);
});

test("stopping the planner task keeps the answer for the next turn", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll({ controller: "viewer-1" });
  t.w.finish(t.taskId, "stopped");
  await t.w.tick();
  expect(t.turns()[0]).toMatchObject({ status: "failed", reason: "stopped" });
  noRogueTurn(t);
  expect(await t.nextPrompt()).toContain("sqlite");
});

test("stopping the run consumes the queued answer and starts nothing", async () => {
  const t = await live();
  const q = await t.ask();
  await t.answer(q, "sqlite");
  await t.poll({ controller: "viewer-1" });
  expect(t.pending()).toHaveLength(1);
  await stopRun(t.w.ctx, t.run.id, getRun(t.w.ctx, t.run.id)!.rev, t.w.deps);
  await t.w.tick();
  await t.w.tick();
  noRogueTurn(t);
  expect(liveTurn(t.w.ctx, t.run.id)).toBeNull();
});

test("no message starts a planner turn outside the engine, and none is typed after the turn", async () => {
  const t = await live();
  recordStepResult(t.w.ctx, t.taskId, { ok: true });
  // The terminal can outlive the engine turn for a moment.
  workflowDatabase(t.w.ctx).query("UPDATE workflow_turns SET status = 'done' WHERE id = ?").run(t.turn.id);
  await sendMessage(t.w.ctx, { to: `task:${t.taskId}`, body: "late note" }, { appAuthenticated: true, spawnRunner: t.w.spawn });
  await t.poll();
  expect(t.deliveries()).toBe(0);
  t.w.finish(t.taskId);
  const sent = await sendMessage(t.w.ctx, { to: `task:${t.taskId}`, body: "later note" }, { appAuthenticated: true, spawnRunner: t.w.spawn });
  expect(sent.delivery).toBe("queued");
  expect(readTask(t.w.ctx, t.taskId)!.pendingTurn).toBeUndefined();
  expect(store.turnsForTask(t.w.ctx, t.taskId)).toBe(0);
});

test("a planner waiting for its answer is not nudged or stopped as stalled", async () => {
  const t = await live();
  updateTask(t.w.ctx, t.taskId, x => { x.progress = { phase: "idle", gitObserved: true } as never; });
  const stalled = () => analyzeLiveness(buildSnapshot(t.w.ctx), t.w.ctx.now + 36_000).some(s => s.node === `task:${t.taskId}`
    && ["idle_run", "silent_prompt", "no_progress"].includes(s.reason));
  expect(stalled()).toBe(true);
  const q = await t.ask();
  expect(stalled()).toBe(false);
  await t.answer(q, "sqlite");
  expect(stalled()).toBe(false);
  await t.poll();
  expect(stalled()).toBe(true);
});

// A continuation turn passes fresh project policy admission, as a new attempt does (ADR 0015).
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { policyGateFixture } from "./fixtures/policy-host";
import { tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { sendMessage } from "../src/messaging/send";
import * as store from "../src/messaging/store";

/** A task that finished on codex with a resumable session, under a policy plugin that allows everything so far. */
function settled() {
  const f = policyGateFixture({ verdict: "allow" });
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"), JSON.stringify({ ...f.config, providers: { "claude-code": {}, codex: {}, cursor: {} } }));
  const t = createTask(f.ctx, { brief: { goal: "the original brief", repo: f.repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(f.ctx, t.id, x => {
    x.origin = "human"; x.state = "done";
    x.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" } };
    x.attempts = [{ executor: "codex", model: null, startedAt: f.ctx.now, endedAt: f.ctx.now + 1, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    x.result = { status: "done", executor: "codex", model: null, files: "", report: "first report", backend: "direct" };
  });
  const spawned: string[] = [];
  const spawn = (_c: unknown, id: string) => { spawned.push(id); return 1; };
  /** The plugin's verdict for the next decisions; `route` applies only to route decisions for this task. */
  const policy = (verdict: unknown, route?: unknown) => writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ verdict, delay: 0, ...(route ? { byTask: { [t.id]: route } } : {}) }));
  const send = (body: string) => sendMessage(f.ctx, { to: `task:${t.id}`, body }, { appAuthenticated: true, spawnRunner: spawn });
  const decisions = () => f.calls().map(line => JSON.parse(line) as { decision: string; input: Record<string, unknown> });
  return { ...f, id: t.id, spawned, policy, send, decisions };
}

test("a still-admitted executor resumes its own session after delegate and route admission", async () => {
  const f = settled();
  const r = await f.send("also handle X");
  expect(r.delivery).toBe("turn_started");
  expect(r.hold).toBeUndefined();
  const t = readTask(f.ctx, f.id)!;
  expect(t.pendingTurn).toMatchObject({ executor: "codex", session: { id: "sid-1", source: "header" } });
  expect(t.pendingTurn?.replay).toBeUndefined();
  expect(f.spawned).toEqual([f.id]);
  const calls = f.decisions();
  expect(calls.map(c => c.decision)).toEqual(["delegate", "route"]);
  expect(calls[0]!.input).toMatchObject({ goal: "the original brief", requestedExecutor: "codex" });
  expect(calls[1]!.input).toEqual({ taskId: f.id, candidates: ["codex", "cursor"] });
});

test("an executor policy now excludes reroutes the turn to an admitted one that replays the thread", async () => {
  const f = settled();
  f.policy({ verdict: "allow" }, { verdict: "amend", amend: { exclude: ["codex"] } });
  const r = await f.send("also handle X");
  expect(r.delivery).toBe("turn_started");
  const t = readTask(f.ctx, f.id)!;
  expect(t.pendingTurn).toMatchObject({ executor: "cursor", replay: true });
  expect(t.pendingTurn?.session).toBeUndefined();
  expect(t.requestedExecutor).toBe("cursor");
  expect(f.spawned).toEqual([f.id]);
});

test("a policy veto holds the turn: messages stay pending, the task keeps its result, and the sender learns why", async () => {
  const f = settled();
  f.policy({ verdict: "veto", reason: "repository frozen" });
  const r = await f.send("also handle X");
  expect(r.delivery).toBe("held");
  expect(r.hold).toEqual({ reason: "repository frozen", plugin: "fx-policy" });
  expect(f.spawned).toEqual([]);
  const t = readTask(f.ctx, f.id)!;
  expect(t.state).toBe("done");
  expect(t.pendingTurn).toBeUndefined();
  expect(t.result?.report).toBe("first report");
  expect(store.pendingFor(f.ctx, `task:${f.id}`).map(m => m.body)).toEqual(["also handle X"]);
  const held = store.inbox(f.ctx, "human").filter(m => m.from === `task:${f.id}`);
  expect(held.map(m => m.body)).toEqual([expect.stringContaining("[held] Messages to task")]);
  expect(held[0]!.body).toContain("repository frozen");
  // Once policy allows again, the next message delivers both.
  f.policy({ verdict: "allow" });
  expect((await f.send("and Y")).delivery).toBe("turn_started");
  expect(readTask(f.ctx, f.id)!.pendingTurn).toMatchObject({ executor: "codex", session: { id: "sid-1", source: "header" } });
});

test("no admitted executor holds the turn with the excluding plugin named", async () => {
  const f = settled();
  f.policy({ verdict: "allow" }, { verdict: "amend", amend: { exclude: ["codex", "cursor"] } });
  const r = await f.send("also handle X");
  expect(r.delivery).toBe("held");
  expect(r.hold).toEqual({ reason: "No executor is admitted for this task's next turn (excluded by plugin fx-policy)", plugin: "fx-policy" });
  expect(readTask(f.ctx, f.id)!.state).toBe("done");
  expect(store.pendingFor(f.ctx, `task:${f.id}`)).toHaveLength(1);
});

test("task.answer under a veto falls back to the legacy retry, which policy refuses as it refuses a new delegation", async () => {
  const f = settled();
  // The legacy answer starts from the asking executor's checkout.
  for (const argv of [["init", "-q"], ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]]) Bun.spawnSync(["git", "-C", f.repo, ...argv]);
  updateTask(f.ctx, f.id, x => { x.state = "needs_input"; x.question = { text: "which file?", at: f.ctx.now }; x.run!.workdir = f.repo; });
  f.policy({ verdict: "veto", reason: "repository frozen" });
  const { answer } = await import("../src/core/tasks");
  const { defaultRun } = await import("../src/ctx");
  const err = await answer({ ...f.ctx, run: defaultRun }, f.id, "same.txt", {}, { spawnRunner: () => 1, appAuthenticated: true }).catch(e => e);
  expect(err).toMatchObject({ code: "not_allowed", message: "repository frozen", hint: "plugin fx-policy" });
  const t = readTask(f.ctx, f.id)!;
  expect(t.state).toBe("needs_input");
  expect(t.question?.answer).toBeUndefined();
  expect(t.retriedBy).toBeUndefined();
  // The refused answer never reaches a later turn, and no held report is sent for it.
  expect(store.pendingFor(f.ctx, `task:${f.id}`)).toEqual([]);
  expect(store.inbox(f.ctx, "human").filter(m => m.from === `task:${f.id}`)).toEqual([]);
});

test("message events stay v3-only, and the app names a policy hold's reason", async () => {
  const { toV2Event } = await import("../src/api/v2-compat");
  expect(toV2Event({ seq: 1, at: 1, type: "message", data: { kind: "message", id: "m-1", value: {} } })).toBeNull();
  const { answerDeliveryWords } = await import("../src/view-model/words");
  expect(answerDeliveryWords("held", { reason: "repository frozen" })).toBe("Answer held, not delivered yet: project policy holds this task (repository frozen). The question stays open.");
  expect(answerDeliveryWords("held")).toContain("a messaging rule needs your confirmation first");
});

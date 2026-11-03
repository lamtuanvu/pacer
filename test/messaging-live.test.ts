import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { readActivity } from "../src/activity/log";
import { writeProjectStrategy } from "../src/config/project-strategies";
import { loadStrategy } from "../src/config/strategy";
import { resolvePolicyRepo } from "../src/core/project-policy";
import { projectReferences } from "../src/engine/project-routing";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import type { RunState } from "../src/supervisor/run";
import { sendMessage } from "../src/messaging/send";
import { liveTick } from "../src/messaging/live";
import { FrameType, wire } from "../src/session/framing";
import { ViewerHub } from "../src/session/viewers";
import * as store from "../src/messaging/store";

const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A session socket served by the real viewer hub, recording what reaches the PTY. */
function fakeSession(dir: string) {
  const sock = join(mkdtempSync("/tmp/pl-"), "s.sock");
  writeFileSync(join(dir, "session.sock.path"), sock);
  const input: Buffer[] = [], events: string[] = [];
  const hub = new ViewerHub(() => wire(FrameType.snapshot, {}), () => null, fn => fn(), kind => events.push(kind), () => {},
    { input: b => { input.push(Buffer.from(b)); }, resize() {}, release: label => events.push(`release:${label}`) });
  const server = createServer(s => hub.add(s));
  servers.push(server);
  const ready = new Promise<void>(r => server.listen(sock, r));
  return { ready, input, events, hub, sock };
}

function setup(o: { mode?: "conversation" | "task"; takeover?: boolean; repo?: string } = {}) {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "g", repo: o.repo ?? tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const dir = tmpDir();
  const conversation = (o.mode ?? "conversation") === "conversation";
  writeFileSync(join(dir, "interactive.json"), JSON.stringify({ reportToken: "x", ...(conversation ? { interactionMode: "conversation" } : {}) }));
  const run: RunRef = { dir, attempt: 1, executor: "claude-code", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null",
    ...(conversation ? { interactionMode: "conversation" as const } : {}), ...(o.takeover ? { takeover: true } : {}) };
  updateTask(ctx, t.id, x => {
    x.state = "running"; x.run = run; x.origin = "external:claude-code";
    if (conversation) { x.interactionMode = "conversation"; x.conversation = { activity: "idle" }; }
    x.attempts = [];
  });
  status(dir, "turn-ended", 1000);
  return { ctx, id: t.id, dir, run };
}

function status(dir: string, s: string, mtime: number) {
  const path = join(dir, "session-status.json");
  writeFileSync(path, JSON.stringify({ status: s, summary: "s", at: mtime }));
  utimesSync(path, mtime, mtime);
}

const state = (s: Partial<RunState> & { status?: string } = {}): RunState => ({
  pid: 1, startedAt: 1, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: 2, interactive: true,
  report: { status: (s.status ?? "turn-ended") as never, summary: "s", at: 1000 }, ...(s.controller ? { controller: s.controller } : {}), ...s,
});
const deps = { submitDelayMs: 0, readState: () => state() };

test("a message to a live conversation is sent as live and typed in while idle with no controller", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  const r = await sendMessage(ctx, { to: `task:${id}`, body: "please also check Y" }, { appAuthenticated: true });
  expect(r.delivery).toBe("live");
  // Working: nothing is typed.
  await liveTick(ctx, readTask(ctx, id)!, run, state({ status: "running" }), deps);
  expect(session.input.length).toBe(0);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  const bytes = Buffer.concat(session.input).toString();
  expect(bytes.startsWith(PASTE_START)).toBe(true);
  expect(bytes.endsWith(`${PASTE_END}\r`)).toBe(true);
  expect(session.input.at(-1)!.toString()).toBe("\r");
  const body = bytes.slice(PASTE_START.length, bytes.length - PASTE_END.length - 1);
  expect(body).toContain("please also check Y");
  expect(body).not.toContain("runs headless");
  expect(session.events).toContain("control-taken");
  expect(session.events).toContain("control-released");
  expect(session.hub.controller).toBeNull();
  const t = readTask(ctx, id)!;
  expect(t.liveTurn?.id).toBe(`${id}#live.1`);
  expect(t.liveTurn?.statusAt).toBe(1000);
  expect(store.pendingFor(ctx, `task:${id}`).length).toBe(0);
  expect(store.turnsForTask(ctx, id)).toBe(1);
  // In flight: a second message waits for the turn to end.
  await sendMessage(ctx, { to: `task:${id}`, body: "and Z" }, { appAuthenticated: true });
  const before = session.input.length;
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(session.input.length).toBe(before);
});

test("a 40 KiB body is written to a file and only a short prompt is typed", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "x".repeat(40 * 1024) }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  const bytes = Buffer.concat(session.input).toString();
  expect(bytes.length).toBeLessThan(1024);
  const path = /"([^"]+\.md)"/.exec(bytes)![1]!;
  expect(path.startsWith(dir)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("x".repeat(40 * 1024));
});

test("a failed large-message rename leaves the message pending for a clean retry", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "x".repeat(40 * 1024) }, { appAuthenticated: true });
  const path = join(dir, `messages-${id}_live.1.md`);
  mkdirSync(path);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
  expect(session.input).toHaveLength(0);
  rmSync(path, { recursive: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(readFileSync(path, "utf8")).toContain("x".repeat(40 * 1024));
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
});

test("a resumed agent or takeover during admission leaves live messages pending", async () => {
  for (const change of ["resumed", "takeover"] as const) {
    const { ctx, id, dir, run } = setup();
    const session = fakeSession(dir);
    await session.ready;
    await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
    const readState = () => {
      if (change === "takeover") updateTask(ctx, id, t => { t.takeover = { state: "driving" } as typeof t.takeover; });
      return state({ status: change === "resumed" ? "running" : "turn-ended" });
    };
    await liveTick(ctx, readTask(ctx, id)!, run, state(), { ...deps, readState });
    expect(session.input).toHaveLength(0);
    expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
  }
});

test("an agent that resumes while pacer takes control gets nothing typed and no hand-back notice", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  let reads = 0;
  // Idle when the claim is made; running by the time control is held.
  await liveTick(ctx, readTask(ctx, id)!, run, state(), { ...deps, readState: () => state({ status: reads++ ? "running" : "turn-ended" }) });
  expect(reads).toBe(2);
  expect(session.input).toHaveLength(0);
  for (let i = 0; i < 50 && session.hub.controller; i++) await Bun.sleep(10);
  expect(session.hub.controller).toBeNull();
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
  expect(readTask(ctx, id)!.liveBlocked).toBeUndefined();
});

test("concurrent live ticks claim one turn and type once", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "once" }, { appAuthenticated: true });
  await Promise.all([1, 2, 3].map(() => liveTick(ctx, readTask(ctx, id)!, run, state(), deps)));
  expect(session.input.filter(b => b.toString() === "\r")).toHaveLength(1);
  expect(readTask(ctx, id)!.liveTurn?.id).toBe(`${id}#live.1`);
});

test("a live delivery that project policy now refuses is held once with its reason and stays pending", async () => {
  const { ctx, id, dir, run } = setup({ repo: gitRepo() });
  ctx.run = realRun;
  const session = fakeSession(dir);
  await session.ready;
  // Admitted at send time; then the repository's project selection drops the session's executor.
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {claude-code: {}, codex: {}, cursor: {}}\n");
  const repo = await resolvePolicyRepo(ctx, readTask(ctx, id)!.brief.repo);
  updateTask(ctx, id, t => { t.repo = repo; });
  await writeProjectStrategy(ctx, repo.key, projectReferences(loadStrategy(ctx), ["cursor"]), 0);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(session.input).toHaveLength(0);
  expect(store.pendingFor(ctx, `task:${id}`).map(m => m.body)).toEqual(["hi"]);
  const reports = store.inbox(ctx, "human").filter(m => m.from === `task:${id}` && m.body.includes("[held]"));
  expect(reports).toHaveLength(1);
  expect(reports[0]!.body).toContain("project policy allows");
  expect(readActivity(ctx).entries.filter(e => e.text.startsWith(`Messages to task ${id} are held`))).toHaveLength(1);
});

test("a viewer holding control blocks delivery and leaves the messages pending", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state({ controller: "app:me" }), deps);
  expect(session.input.length).toBe(0);
  expect(readTask(ctx, id)!.liveBlocked).toBe("viewer");
  expect(store.pendingFor(ctx, `task:${id}`).length).toBe(1);
  // Handed back: delivered, and the block clears.
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(session.input.length).toBeGreaterThan(0);
  expect(readTask(ctx, id)!.liveBlocked).toBeUndefined();
});

test("a socket failure releases the claimed messages and records the error", async () => {
  const { ctx, id, dir, run } = setup();
  writeFileSync(join(dir, "session.sock.path"), join(mkdtempSync("/tmp/pl-"), "missing.sock"));
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  const t = readTask(ctx, id)!;
  expect(store.pendingFor(ctx, `task:${id}`).map(m => m.body)).toEqual(["hi"]);
  expect(t.liveTurn).toBeUndefined();
  expect(t.liveError?.message).toBeTruthy();
  expect(store.turnsForTask(ctx, id)).toBe(0);
});

test("turn completion sends exactly one report and clears the live turn", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  const turn = readTask(ctx, id)!.liveTurn!.id;
  // The old turn-ended status does not finish the turn.
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(readTask(ctx, id)!.liveTurn).toBeDefined();
  writeFileSync(join(dir, "transcript-report.md"), "Checked Y; all good.");
  status(dir, "turn-ended", 2000);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  const reports = store.inbox(ctx, "external:claude-code").filter(m => m.kind === "report");
  const human = store.inbox(ctx, "human").filter(m => m.kind === "report");
  expect([...reports, ...human].length).toBe(2);
  expect(reports.map(m => [m.body, m.requestId])).toEqual([["Checked Y; all good.", `report:${turn}`]]);
  expect(human.map(m => m.requestId)).toEqual([`report:${turn}:human`]);
  expect(readTask(ctx, id)!.liveTurn).toBeUndefined();
  expect(store.lastTurnEndedAt(ctx, id)).not.toBeNull();
});

test("a running interactive delegated task is driven live; a takeover run never is", async () => {
  const live = setup({ mode: "task" });
  const s1 = fakeSession(live.dir);
  await s1.ready;
  const r = await sendMessage(live.ctx, { to: `task:${live.id}`, body: "hi" }, { appAuthenticated: true });
  expect(r.delivery).toBe("live");
  await liveTick(live.ctx, readTask(live.ctx, live.id)!, live.run, state(), deps);
  expect(s1.input.length).toBeGreaterThan(0);

  const take = setup({ mode: "task", takeover: true });
  const s2 = fakeSession(take.dir);
  await s2.ready;
  expect((await sendMessage(take.ctx, { to: `task:${take.id}`, body: "hi" }, { appAuthenticated: true })).delivery).toBe("queued");
  await liveTick(take.ctx, readTask(take.ctx, take.id)!, take.run, state(), deps);
  expect(s2.input.length).toBe(0);
  expect(store.pendingFor(take.ctx, `task:${take.id}`).length).toBe(1);
});

test("an ended conversation is live_unavailable and keeps the message pending", async () => {
  const { ctx, id } = setup();
  updateTask(ctx, id, t => { t.state = "done"; t.conversation = { activity: "ended" }; });
  const r = await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  expect(r.delivery).toBe("live_unavailable");
  expect(store.pendingFor(ctx, `task:${id}`).length).toBe(1);
});

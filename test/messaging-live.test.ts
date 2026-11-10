import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { readActivity } from "../src/activity/log";
import { ask } from "../src/core/tasks";
import { killTree } from "../src/exec/process";
import { writeProjectStrategy } from "../src/config/project-strategies";
import { loadStrategy } from "../src/config/strategy";
import { resolvePolicyRepo } from "../src/core/project-policy";
import { projectReferences } from "../src/engine/project-routing";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import { readRun, type RunState } from "../src/supervisor/run";
import { sendMessage } from "../src/messaging/send";
import { liveTick, typeIntoSession, PACER_CONTROLLER } from "../src/messaging/live";
import { FrameType, wire } from "../src/session/framing";
import { ViewerHub, type DeliveryTiming } from "../src/session/viewers";
import { createConnection } from "node:net";
import * as store from "../src/messaging/store";

const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
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

test("pacer's own control, as the session host records it, does not block live delivery", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  const seen: Array<[string | null | undefined, string | null]> = [];
  // The run's wrapper process is not real here; everything else, including the controller, comes from the run dir.
  const readState = (d: string) => { const s = { ...readRun(d), alive: true }; seen.push([s.controller, session.hub.controller]); return s; };
  await liveTick(ctx, readTask(ctx, id)!, run, state(), { ...deps, readState });
  const [recorded, held] = seen.at(-1)!;
  expect(held).toBe(PACER_CONTROLLER);
  expect(recorded).toBe(held);
  expect(Buffer.concat(session.input).toString()).toContain("hi");
  expect(readTask(ctx, id)!.liveTurn?.id).toBe(`${id}#live.1`);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
});

test("another viewer's label as controller at the in-control check still blocks typing", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  let reads = 0;
  const readState = (d: string) => {
    const s = { ...readRun(d), alive: true };
    return reads++ ? { ...s, controller: "cli:pacer t-1" } : s;
  };
  await liveTick(ctx, readTask(ctx, id)!, run, state(), { ...deps, readState });
  expect(session.input).toHaveLength(0);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
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

// ADR 0023: on a 1.2 host pacer types through a delivery window; a 1.1 host keeps take and release.
const FAST = { quietMs: 30, windowMs: 1000, timeoutMs: 200 };
const clients: import("node:net").Socket[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.destroy(); });
async function viewer(session: { sock: string; hub: ViewerHub }, hello: Record<string, unknown>) {
  const socket = createConnection(session.sock);
  clients.push(socket);
  await new Promise<void>(r => socket.once("connect", () => r()));
  const before = session.hub.size;
  socket.write(wire(FrameType.hello, { v: 1, ...hello }));
  for (let i = 0; i < 200 && session.hub.size === before; i++) await Bun.sleep(5);
  const write = (bytes: Buffer) => new Promise<void>(r => socket.write(bytes, () => r()));
  return {
    type: async (text: string) => { await write(wire(FrameType.input, Buffer.from(text))); await Bun.sleep(20); },
    take: async () => { await write(wire(FrameType.take, {})); await Bun.sleep(20); },
  };
}

test("typeIntoSession on a 1.1 host takes and releases control, and a refusal names the controller", async () => {
  const session = fakeSession(tmpDir());
  await session.ready;
  expect(await typeIntoSession(session.sock, "hi", deps, () => true)).toEqual({ kind: "typed" });
  expect(session.events).toEqual(expect.arrayContaining(["control-taken", "control-released"]));
  const app = await viewer(session, { label: "Pacer desktop", client: "app" });
  await app.take();
  expect(session.hub.controller).toBe("app:Pacer desktop");
  const before = session.input.length;
  expect(await typeIntoSession(session.sock, "again", deps, () => true)).toEqual({ kind: "refused", controller: "app:Pacer desktop" });
  expect(session.input).toHaveLength(before);
});

test("typeIntoSession on a 1.2 host delivers through a granted window while app panes are open, without taking control", async () => {
  const session = fakeSession(tmpDir(), { modern: true, timing: FAST });
  await session.ready;
  const old = await viewer(session, { label: "Pacer desktop", client: "app", versions: [1, 1] });
  await old.take();
  await viewer(session, { label: "pane", client: "app", versions: [1, 2] });
  expect(await typeIntoSession(session.sock, "hi", deps, () => true)).toEqual({ kind: "typed" });
  expect(Buffer.concat(session.input).toString()).toBe(`${PASTE_START}hi${PASTE_END}\r`);
  expect(session.events).not.toContain("control-taken");
  expect(session.hub.controller).toBeNull();
});

test("typeIntoSession on a 1.2 host reports pending human input by client, and a changed run as busy", async () => {
  const session = fakeSession(tmpDir(), { modern: true, timing: FAST });
  await session.ready;
  const pane = await viewer(session, { label: "pane", client: "app", versions: [1, 2] });
  await pane.type("half a line");
  expect(await typeIntoSession(session.sock, "hi", deps, () => true)).toEqual({ kind: "pending", reason: "unsent input in the agent from pane" });
  await pane.type("\r");
  await Bun.sleep(40);
  expect(await typeIntoSession(session.sock, "hi", deps, () => false)).toEqual({ kind: "busy" });
  expect(session.input.map(b => b.toString())).toEqual(["half a line", "\r"]);
});

test("live messages on a 1.2 host retry after pending human input and never set liveBlocked", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir, { modern: true, timing: FAST });
  await session.ready;
  const human = await viewer(session, { label: "iTerm", versions: [1, 2] });
  await human.type("draft");
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(session.input.map(b => b.toString())).toEqual(["draft"]);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
  expect(readTask(ctx, id)!.liveBlocked).toBeUndefined();
  expect(readTask(ctx, id)!.liveError?.message).toContain("unsent input in the agent from iTerm");
  await human.type("\r");
  await Bun.sleep(40);
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(session.input.at(-1)!.toString()).toBe("\r");
  expect(Buffer.concat(session.input).toString()).toContain("hi");
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
  expect(readTask(ctx, id)!.liveBlocked).toBeUndefined();
  expect(readTask(ctx, id)!.liveError).toBeUndefined();
});

test("typeIntoSession on a 1.2 host submits its paste even when Enter comes after windowMs; held human input follows it", async () => {
  const session = fakeSession(tmpDir(), { modern: true, timing: { quietMs: 30, windowMs: 60, timeoutMs: 200 } });
  await session.ready;
  const human = await viewer(session, { label: "iTerm", versions: [1, 2] });
  const typing = typeIntoSession(session.sock, "hi", { ...deps, submitDelayMs: 150 }, () => true);
  for (let i = 0; i < 100 && !session.input.length; i++) await Bun.sleep(5);
  await human.type("held");
  expect(await typing).toEqual({ kind: "typed" });
  expect(session.input.map(b => b.toString())).toEqual([`${PASTE_START}hi${PASTE_END}`, "\r", "held"]);
});

test("typeIntoSession on a 1.2 host: a guard slower than windowMs gets the window expired unused; the paste is dropped and nothing was typed", async () => {
  const session = fakeSession(tmpDir(), { modern: true, timing: { quietMs: 30, windowMs: 50, timeoutMs: 200 } });
  await session.ready;
  const human = await viewer(session, { label: "iTerm", versions: [1, 2] });
  const slowGuard = () => { Bun.sleepSync(80); return true; };
  expect(await typeIntoSession(session.sock, "hi", deps, slowGuard)).toEqual({ kind: "pending", reason: "the delivery window expired before any input was typed" });
  await human.type("mine");
  expect(session.input.map(b => b.toString())).toEqual(["mine"]);
  expect(session.hub.active).toBe("cli:iTerm");
});

test("a live delivery whose window expired unused during a slow guard leaves the messages pending and retries them", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir, { modern: true, timing: { quietMs: 30, windowMs: 50, timeoutMs: 200 } });
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  let reads = 0;
  // The second read is typeIntoSession's guard, run after the grant.
  const slow = { ...deps, readState: () => { if (++reads === 2) Bun.sleepSync(80); return state(); } };
  await liveTick(ctx, readTask(ctx, id)!, run, state(), slow);
  expect(session.input).toHaveLength(0);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
  expect(readTask(ctx, id)!.liveTurn).toBeUndefined();
  expect(readTask(ctx, id)!.liveError?.message).toBe("Not delivered: the delivery window expired before any input was typed");
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(Buffer.concat(session.input).toString()).toContain("hi");
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
  expect(readTask(ctx, id)!.liveTurn?.id).toBe(`${id}#live.1`);
});

test("a live delivery that fails after input was attempted is not re-queued or retyped and records the error", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir, { modern: true, timing: { quietMs: 30, windowMs: 1000, timeoutMs: 200, maxWindowMs: 60 } });
  await session.ready;
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  const slow = { ...deps, submitDelayMs: 150 };
  await liveTick(ctx, readTask(ctx, id)!, run, state(), slow);
  const typed = session.input.length;
  expect(Buffer.concat(session.input).toString()).toContain("hi");
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
  const t = readTask(ctx, id)!;
  expect(t.liveTurn).toBeUndefined();
  expect(t.liveError?.message).toContain("not resent");
  await liveTick(ctx, readTask(ctx, id)!, run, state(), slow);
  expect(session.input).toHaveLength(typed);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
  // A later message gets a fresh turn and does not carry the ambiguous one with it.
  await sendMessage(ctx, { to: `task:${id}`, body: "next" }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(Buffer.concat(session.input.slice(typed)).toString()).toContain("next");
  expect(store.claimedMessages(ctx, readTask(ctx, id)!.liveTurn!.id).map(m => m.body)).toEqual(["next"]);
});

test("a 1.1 host refusing control blocks live delivery as viewer", async () => {
  const { ctx, id, dir, run } = setup();
  const session = fakeSession(dir);
  await session.ready;
  const app = await viewer(session, { label: "Pacer desktop", client: "app" });
  await app.take();
  await sendMessage(ctx, { to: `task:${id}`, body: "hi" }, { appAuthenticated: true });
  await liveTick(ctx, readTask(ctx, id)!, run, state(), deps);
  expect(session.input).toHaveLength(0);
  expect(readTask(ctx, id)!.liveBlocked).toBe("viewer");
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
});

// pacer msg send --answer must resolve a waiting question exactly like pacer answer: type it into the running
// session at once. An agent's session waits on its question and reads nothing else, so no between-turns poll
// or later turn would ever deliver a pending answer.

const wrappers: number[] = [];
afterEach(() => { for (const pid of wrappers.splice(0)) killTree(pid, "SIGKILL"); });

/** A delegated interactive run whose agent waits on its question: an owned live wrapper, a hub as the session host, and the question `pacer ask` recorded. */
async function questionRun() {
  const ctx = fakeCtx();
  const created = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "debug", requestedExecutor: "codex", timeoutS: 600 });
  const dir = tmpDir();
  const script = join(dir, "run.sh");
  writeFileSync(join(dir, "interactive.json"), "{}");
  writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  wrappers.push(proc.pid);
  writeFileSync(join(dir, "pid"), String(proc.pid));
  const session = fakeSession(dir);
  await session.ready;
  for (let i = 0; i < 100 && !readRun(dir).alive; i++) await Bun.sleep(25);
  expect(readRun(dir).alive).toBe(true);
  updateTask(ctx, created.id, t => {
    t.state = "running";
    t.origin = "external:claude-code";
    t.run = { dir, attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: t.brief.repo, logFile: "/dev/null" };
    t.attempts = [];
  });
  status(dir, "needs-input", 1000);
  await ask(ctx, created.id, "Switch the worktree to the base commit and commit on top?");
  const question = store.thread(ctx, created.id).find(m => m.kind === "question")!;
  return { ctx, id: created.id, dir, question, session };
}

const REPLY = "Yes: switch to the base commit and commit on top of it; leave the branch name alone.";

test("an answer to a question a live run waits on is typed into the running session at once", async () => {
  const { ctx, id, question, session } = await questionRun();
  const r = await sendMessage(ctx, { to: `task:${id}`, body: REPLY, kind: "answer", replyTo: question.id }, { participant: "human" });
  expect(r.delivery).toBe("live");
  expect(readTask(ctx, id)!.question?.answer).toBe(REPLY);
  expect(Buffer.concat(session.input).toString()).toContain(REPLY);
  // Consumed on delivery: no later between-turns poll types it again.
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(0);
  const before = session.input.length;
  await liveTick(ctx, readTask(ctx, id)!, readTask(ctx, id)!.run!, state(), deps);
  expect(session.input.length).toBe(before);
  expect(store.turnsForTask(ctx, id)).toBe(0);
});

test("a reply the waiting live session cannot accept is an error: the question stays open, nothing is typed and no delivery is claimed", async () => {
  const { ctx, id, question, session } = await questionRun();
  const app = await viewer(session, { label: "Pacer desktop", client: "app" });
  await app.take();
  const error = await sendMessage(ctx, { to: `task:${id}`, body: REPLY, kind: "answer", replyTo: question.id }, { participant: "human" })
    .then(() => null, (e: unknown) => e as Error);
  expect(error?.message).toContain("controlled from Pacer desktop");
  expect(error?.message).toContain("nothing was typed");
  expect(readTask(ctx, id)!.question?.answer).toBeUndefined();
  expect(session.input).toHaveLength(0);
  expect(store.pendingFor(ctx, `task:${id}`)).toHaveLength(1);
});

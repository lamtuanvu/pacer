import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskSendBridge } from "../src/api/task-send-bridge";
import { killTree } from "../src/exec/process";
import { FrameType, wire } from "../src/session/framing";
import { ViewerHub } from "../src/session/viewers";
import { readRun } from "../src/supervisor/run";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { LiveWorker, TaskRecord } from "../src/tasks/types";
import type { Ctx } from "../src/types";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const CALLER = { USER: "alice", ORCA_TERMINAL_HANDLE: "term_planner" };
const servers: Server[] = [], wrappers: number[] = [], homes: string[] = [], hubs: ViewerHub[] = [];
afterEach(() => {
  for (const h of hubs.splice(0)) h.destroy();
  for (const s of servers.splice(0)) s.close();
  for (const pid of wrappers.splice(0)) killTree(pid, "SIGKILL");
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const make = (ctx: Ctx, goal: string, patch: (t: TaskRecord) => void = () => {}) => {
  const t = createTask(ctx, { brief: { goal, repo: ctx.home }, kind: null, requestedExecutor: "codex", timeoutS: 600 });
  updateTask(ctx, t.id, x => { x.state = "running"; patch(x); });
  return t.id;
};

/** A running built-in interactive run whose session host this process serves, as `test/send.test.ts` does. */
async function builtinRun(ctx: Ctx, id: string) {
  const dir = tmpDir(), script = join(dir, "run.sh");
  writeFileSync(join(dir, "interactive.json"), "{}");
  writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  wrappers.push(proc.pid);
  writeFileSync(join(dir, "pid"), String(proc.pid));
  const sock = join(mkdtempSync("/tmp/pl-"), "s.sock");
  writeFileSync(join(dir, "session.sock.path"), sock);
  const input: Buffer[] = [];
  const hub = new ViewerHub(() => wire(FrameType.snapshot, {}), () => null, fn => fn(), () => {},
    (viewers, controller) => writeFileSync(join(dir, "session.state"), JSON.stringify({ viewers, controller, cols: 120, rows: 40 })),
    { input: b => { input.push(Buffer.from(b)); }, resize() {} });
  hubs.push(hub);
  const server = createServer(s => hub.add(s));
  servers.push(server);
  await new Promise<void>(r => server.listen(sock, r));
  updateTask(ctx, id, t => { t.run = { dir, attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null" }; });
  const until = Date.now() + 5000;
  while (!readRun(dir).alive && Date.now() < until) await Bun.sleep(25);
  return () => Buffer.concat(input).toString();
}

function clone(home: string) {
  const copy = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "ts-")));
  cpSync(home, copy, { recursive: true });
  homes.push(copy);
  return copy;
}

async function exchange(home: string, requests: { id: number; params: unknown }[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...CALLER,
      ...(forward ? { PACER_FORWARD_OPS: "task.send" } : {}),
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const lines = [{ jsonrpc: "2.0", id: 0, method: "hello", params: { protocol: 3 } },
      ...requests.map(r => ({ jsonrpc: "2.0", id: r.id, method: "task.send", params: r.params }))];
    await child.stdin.write(lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = new Map<number, { result?: unknown; error?: unknown }>();
    for (const line of stdout.trim().split("\n")) {
      const reply = JSON.parse(line);
      if (typeof reply.id === "number") replies.set(reply.id, reply);
    }
    const markers = stderr.split("\n").filter(line => /^native task\.send \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : requests.map(r => `native task.send ${r.id}`));
    return replies;
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

test("the probe accepts a lane that can take live input and refuses one that cannot", async () => {
  const term = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";
  const live: LiveWorker = { backend: "orca", worker: "ctx_live", terminal: term, executor: "codex", agent: "codex", incarnation: "inc-1", since: 1 };
  const ctx = fakeCtx({ run: fakeRun([]).run });
  const withLive = make(ctx, "live", t => { t.live = live; });
  const without = make(ctx, "no live");
  const direct = make(ctx, "direct", t => { t.live = { ...live, backend: "direct" }; });
  expect(await taskSendBridge(ctx, { kind: "probe", id: withLive })).toBeNull();
  await expect(taskSendBridge(ctx, { kind: "probe", id: without })).rejects.toThrow("this task has no live terminal to send into");
  await expect(taskSendBridge(ctx, { kind: "probe", id: direct })).rejects.toThrow("the direct backend cannot deliver live input");
  await expect(taskSendBridge(ctx, { kind: "probe", id: "t-20261110-000000-ffff" })).rejects.toThrow("unknown task t-20261110-000000-ffff");
  await expect(taskSendBridge(ctx, { kind: "other", id: withLive })).rejects.toThrow("kind must be probe or send");
});

test("the bridge send types through Core with the caller Rust named and returns the task record", async () => {
  const term = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";
  const shown = raw(JSON.stringify({ ok: true, result: { terminal: { handle: term, incarnationId: "inc-1", connected: true, writable: true, agentIdentity: "codex" } } }));
  const f = fakeRun([
    [["orca", "orchestration", "worker-show"], raw(JSON.stringify({ ok: true, result: { worker: { state: "running" } } }))],
    [["orca", "terminal", "show"], shown],
    [["orca", "terminal", "send"], raw(JSON.stringify({ ok: true, result: {} }))],
  ]);
  const ctx = fakeCtx({ run: f.run });
  const id = make(ctx, "live", t => {
    t.interactionMode = "conversation";
    t.live = { backend: "orca", worker: "ctx_live", terminal: term, executor: "codex", agent: "codex", incarnation: "inc-1", since: 1 };
  });
  const rev = readTask(ctx, id)!.rev;
  const result = await taskSendBridge(ctx, { kind: "send", id, text: "go with plan B", force: false, by: "client:app#w1", expectRev: rev }) as TaskRecord;
  expect(f.calls).toContainEqual(["orca", "terminal", "send", "--terminal", term, "--text", "go with plan B", "--enter", "--json"]);
  expect(result.id).toBe(id);
  expect(result.driving).toEqual({ by: "client:app#w1", at: ctx.now });
  expect(readTask(ctx, id)!.driving).toEqual({ by: "client:app#w1", at: ctx.now });
});

test.skipIf(!front)("native task.send refuses exactly as TypeScript and delivers through the Core bridge", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const noLive = make(ctx, "no live worker");
  const leased = make(ctx, "leased, no live worker", t => { t.driving = { by: "someone-else", at: Date.now() / 1000 }; });
  const done = make(ctx, "settled", t => { t.state = "done"; });
  const waiting = make(ctx, "waiting", t => { t.state = "needs_input"; t.question = { text: "A or B?", at: ctx.now }; });
  const stale = make(ctx, "stale");
  const staleRev = readTask(ctx, stale)!.rev + 1;
  const live = make(ctx, "built-in run");
  const typed = await builtinRun(ctx, live);
  const refusals = [
    { id: 1, params: { id: noLive, text: "hi" } },
    { id: 2, params: { id: leased, text: "hi" } },
    { id: 3, params: { id: done, text: "hi" } },
    { id: 4, params: { id: waiting, text: "hi" } },
    { id: 5, params: { id: stale, text: "hi", expect_rev: staleRev } },
    { id: 6, params: { id: "t-20261110-000000-ffff", text: "hi" } },
    { id: 7, params: { id: noLive, text: "   " } },
    { id: 8, params: { id: "", text: "x".repeat(4001), expect_rev: 0 } },
    { id: 9, params: { id: noLive, text: "😀".repeat(2001) } },
  ];
  const [native, forwarded] = [await exchange(clone(ctx.home), refusals, false), await exchange(clone(ctx.home), refusals, true)];
  for (const { id } of refusals) {
    const [n, f] = [native.get(id), forwarded.get(id)];
    expect(f?.error, `request ${id}`).toBeDefined();
    expect(n?.error, `request ${id}`).toEqual(f!.error);
  }
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(id => (native.get(id)?.error as { data?: { code?: string } })?.data?.code))
    .toEqual(["unavailable", "unavailable", "conflict", "conflict", "conflict", "unknown_task", "invalid_input", "invalid_input", "invalid_input"]);

  const before = typed().length;
  const delivered = (await exchange(clone(ctx.home), [{ id: 10, params: { id: live, text: "go with plan B" } }], false)).get(10);
  expect(delivered?.error).toBeUndefined();
  expect(delivered?.result).toMatchObject({ id: live, state: "running", driving: { by: "alice@term_planner" } });
  expect(typed().slice(before)).toContain("go with plan B");
}, 60000);

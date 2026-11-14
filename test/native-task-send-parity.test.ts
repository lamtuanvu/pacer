import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskSendBridge } from "../src/api/task-send-bridge";
import { killTree } from "../src/exec/process";
import { FrameType, wire } from "../src/session/framing";
import { ViewerHub } from "../src/session/viewers";
import { readRun } from "../src/supervisor/run";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { Ctx } from "../src/types";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";
import { closedPort, pinnedEnv, REAL_SERVICE_PORT } from "./pinned-port";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const CALLER = { USER: "alice", ORCA_TERMINAL_HANDLE: "term_planner" };
/** Every process this file spawns, and their descendants, call this port instead of the real service on 4317. */
const PORT = await closedPort();
const servers: Server[] = [], wrappers: number[] = [], homes: string[] = [], hubs: ViewerHub[] = [];
afterEach(() => {
  for (const h of hubs.splice(0)) h.destroy();
  for (const s of servers.splice(0)) s.close();
  for (const pid of wrappers.splice(0)) killTree(pid, "SIGKILL");
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("spawned processes are pinned to a closed port, never the real service's", async () => {
  expect(PORT).not.toBe(REAL_SERVICE_PORT);
  expect(pinnedEnv({ PACER_PORT: String(REAL_SERVICE_PORT) }, PORT).PACER_PORT).toBe(String(PORT));
  expect(() => pinnedEnv({}, REAL_SERVICE_PORT)).toThrow("pinned away from 4317");
  expect(() => pinnedEnv({}, 0)).toThrow("pinned away from 4317");
  const probe = await fetch(`http://127.0.0.1:${PORT}/health`).then(() => "answered", () => "refused");
  expect(probe).toBe("refused");
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
  writeFileSync(script, "#!/bin/sh\nprintf %s \"$PACER_PORT\" > \"$1/port.tmp\" && mv \"$1/port.tmp\" \"$1/port\"\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], { detached: true, env: pinnedEnv(process.env, PORT), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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
  while ((!readRun(dir).alive || !existsSync(join(dir, "port"))) && Date.now() < until) await Bun.sleep(25);
  expect(readFileSync(join(dir, "port"), "utf8")).toBe(String(PORT));
  return () => Buffer.concat(input).toString();
}

function clone(home: string) {
  const copy = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "ts-")));
  cpSync(home, copy, { recursive: true });
  homes.push(copy);
  return copy;
}

type Reply = { result?: unknown; error?: unknown };
type Output = { stdout: string; stderr: string };

async function exchange(home: string, requests: { id: number; params: unknown }[], forward: boolean,
  env: Record<string, string> = {}, whileOpen?: (output: Output) => Promise<void>) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: pinnedEnv({
      HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...CALLER,
      ...(forward ? { PACER_FORWARD_OPS: "task.send" } : {}), ...env,
    }, PORT),
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const output: Output = { stdout: "", stderr: "" };
    const pump = async (stream: ReadableStream<Uint8Array>, key: keyof Output) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output[key] += decoder.decode(chunk, { stream: true });
    };
    const reading = Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
    const lines = [{ jsonrpc: "2.0", id: 0, method: "hello", params: { protocol: 3 } },
      ...requests.map(r => ({ jsonrpc: "2.0", id: r.id, method: "task.send", params: r.params }))];
    child.stdin.write(lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    await child.stdin.flush();
    await whileOpen?.(output);
    await child.stdin.end();
    const [code] = await Promise.all([child.exited, reading]);
    expect(code, output.stderr).toBe(0);
    const replies = new Map<number, Reply>();
    for (const line of output.stdout.trim().split("\n")) {
      const reply = JSON.parse(line);
      if (typeof reply.id === "number") replies.set(reply.id, reply);
    }
    const markers = output.stderr.split("\n").filter(line => /^native task\.send \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : requests.map(r => `native task.send ${r.id}`));
    return replies;
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

const replied = (output: Output, id: number) => output.stdout.split("\n").some(line => line.startsWith(`{"jsonrpc":"2.0","id":${id},`));

/**
 * Sends `requests` while another process holds task `id`'s shared lock, and releases it only after the front door
 * has dispatched them and nothing has answered; the holder then applies `change` to the task, as a racing writer would.
 */
async function underLock(home: string, id: string, change: "run" | "unlease", requests: { id: number; params: unknown }[], forward: boolean) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lock-")));
  homes.push(dir);
  const [locked, go] = [join(dir, "locked"), join(dir, "go")];
  const holder = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/task-lock-holder.ts"), join(home, ".pacer"), id, change, locked, go], {
    env: pinnedEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, PORT), stdout: "ignore", stderr: "pipe",
  });
  try {
    const until = Date.now() + 10_000;
    while (!existsSync(locked)) {
      if (holder.exitCode !== null || Date.now() > until) throw new Error(`lock holder failed: ${await new Response(holder.stderr).text()}`);
      await Bun.sleep(10);
    }
    expect(readFileSync(locked, "utf8")).toBe(String(PORT));
    return await exchange(home, requests, forward, {}, async output => {
      const dispatched = Date.now() + 10_000;
      while (!forward && !output.stderr.includes(`native task.send ${requests[0]!.id}\n`) && Date.now() < dispatched) await Bun.sleep(10);
      await Bun.sleep(forward ? 1500 : 300);
      for (const r of requests) expect(replied(output, r.id), `request ${r.id} answered while the task was locked`).toBe(false);
      writeFileSync(go, "");
      expect(await holder.exited).toBe(0);
    });
  } finally {
    if (holder.exitCode === null) { holder.kill("SIGKILL"); await holder.exited; }
  }
}

test("the bridge refuses an enforcement identity before reading the request, and anything but a send", async () => {
  const f = fakeRun([]);
  const ctx = fakeCtx({ run: f.run });
  const id = make(ctx, "live", t => {
    t.live = { backend: "orca", worker: "ctx_live", terminal: "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d", executor: "codex", agent: "codex", incarnation: "inc-1", since: 1 };
  });
  const record = readTask(ctx, id);
  const enforced = { ...ctx, env: { PACER_ENFORCEMENT_TOKEN: "pet_x" } };
  for (const request of [{ kind: "send", id, text: "hi", force: false, by: "client:app" }, { kind: "probe" }, null]) {
    await expect(taskSendBridge(enforced, request)).rejects.toMatchObject({ code: "not_allowed", message: "Enforcement identity only reports a native child denial" });
  }
  expect(f.calls).toEqual([]);
  expect(readTask(ctx, id)).toEqual(record);
  await expect(taskSendBridge(ctx, { kind: "probe", id })).rejects.toThrow("kind must be send");
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

  const send = [{ id: 10, params: { id: live, text: "go with plan B" } }];
  const before = typed().length;
  for (const forward of [false, true]) {
    const delivered = (await exchange(clone(ctx.home), send, forward)).get(10);
    expect(delivered?.error, forward ? "forwarded" : "native").toBeUndefined();
    expect(delivered?.result).toMatchObject({ id: live, state: "running", driving: { by: "alice@term_planner" } });
  }
  expect(typed().slice(before).split("go with plan B").length - 1).toBe(2);
}, 60000);

test.skipIf(!front)("native task.send refuses an enforcement identity exactly as TypeScript, before its params and without effects", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const live = make(ctx, "built-in run");
  const typed = await builtinRun(ctx, live);
  const record = readTask(ctx, live);
  const requests = [
    { id: 1, params: { id: live, text: "go with plan B" } },
    { id: 2, params: { id: live, text: "go with plan B", force: true } },
    { id: 3, params: { id: "", text: "", expect_rev: 0 } },
    { id: 4, params: { id: "t-20261110-000000-ffff", text: "hi" } },
  ];
  const enforced = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  const before = typed().length;
  const [nativeHome, forwardedHome] = [clone(ctx.home), clone(ctx.home)];
  const native = await exchange(nativeHome, requests, false, enforced);
  const forwarded = await exchange(forwardedHome, requests, true, enforced);
  for (const { id } of requests) {
    const [n, f] = [native.get(id), forwarded.get(id)];
    expect(f?.error, `request ${id}`).toMatchObject({ message: "Enforcement identity only reports a native child denial", data: { code: "not_allowed" } });
    expect(n?.error, `request ${id}`).toEqual(f!.error);
  }
  expect(typed().slice(before)).toBe("");
  for (const home of [nativeHome, forwardedHome]) expect(readTask(fakeCtx({ home }), live)).toEqual(record);
}, 60000);

test.skipIf(!front)("native task.send decides its refusals under the shared task lock, as TypeScript does", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const settling = make(ctx, "done until the racing writer reopens it", t => { t.state = "done"; });
  const next = readTask(ctx, settling)!.rev + 1;
  const reopened = [
    { id: 1, params: { id: settling, text: "hi" } },
    { id: 2, params: { id: settling, text: "hi", expect_rev: next } },
  ];
  const [native, forwarded] = [
    await underLock(clone(ctx.home), settling, "run", reopened, false),
    await underLock(clone(ctx.home), settling, "run", reopened, true),
  ];
  for (const { id } of reopened) {
    expect(forwarded.get(id)?.error, `request ${id}`).toMatchObject({ message: "this task has no live terminal to send into", data: { code: "unavailable" } });
    expect(native.get(id)?.error, `request ${id}`).toEqual(forwarded.get(id)!.error);
  }

  const leased = make(ctx, "leased until the racing writer releases it", t => { t.driving = { by: "someone-else", at: Date.now() / 1000 }; });
  const typed = await builtinRun(ctx, leased);
  const send = [{ id: 3, params: { id: leased, text: "go with plan B" } }];
  const before = typed().length;
  const sent = [await underLock(clone(ctx.home), leased, "unlease", send, false), await underLock(clone(ctx.home), leased, "unlease", send, true)];
  for (const replies of sent) {
    expect(replies.get(3)?.error).toBeUndefined();
    expect(replies.get(3)?.result).toMatchObject({ id: leased, state: "running", driving: { by: "alice@term_planner" } });
  }
  expect(typed().slice(before).split("go with plan B").length - 1).toBe(2);
}, 60000);

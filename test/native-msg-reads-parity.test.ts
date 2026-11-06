import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { claimPending, insertMessage, markRead } from "../src/messaging/store";
import { getWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { createSession } from "../src/serve/app-auth";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = ["msg.inbox", "msg.log", "msg.read"];
const FORWARD = OPS.join(",");

function seed() {
  const ctx = fakeCtx();
  const brief = (goal: string) => ({ brief: { goal, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const root = createTask(ctx, brief("root")), other = createTask({ ...ctx, now: ctx.now + 1 }, brief("other"));
  const child = createTask({ ...ctx, now: ctx.now + 2 }, brief("child"));
  updateTask(ctx, child.id, t => { t.origin = `task:${root.id}`; });
  const leaf = createTask({ ...ctx, now: ctx.now + 3 }, brief("leaf"));
  getWork(ctx, leaf.id);
  dispatchDatabase(ctx).query("INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options) VALUES(?,?,?,?,?)").run(leaf.id, child.id, root.id, 2, "{}");
  let at = ctx.now + 10;
  const send = (to: string, task: string | null, body: string, o: { kind?: "message" | "question" | "report"; status?: "held"; replyTo?: string } = {}) =>
    insertMessage({ ...ctx, now: (at += 1.25) }, { taskId: task, rootId: `task:${root.id}`, from: "human", to, kind: o.kind ?? "message", body,
      replyTo: o.replyTo ?? null, requestId: null, ...(o.status ? { status: o.status } : {}) }).message;
  const ids: string[] = [];
  for (const to of ["external:local", "external:codex:abc", `task:${child.id}`, `task:${leaf.id}`, "human"]) {
    for (const [n, body] of ["plain", "quote \" and \\ slash", "ctl \u0001\b\t\n\u2028 😀 é", "</script>"].entries()) {
      const m = send(to, n % 2 ? child.id : root.id, `${to} ${body}`, { kind: n === 3 ? "question" : "message" });
      ids.push(m.id);
    }
    ids.push(send(to, other.id, `${to} held`, { status: "held" }).id);
  }
  // Integral timestamps, a delivered message and one already read.
  insertMessage({ ...ctx, now: Math.floor(at) + 100 }, { taskId: leaf.id, rootId: `task:${root.id}`, from: `task:${child.id}`, to: "external:local", kind: "report", body: "integral", replyTo: ids[0]!, requestId: "r-1" });
  claimPending({ ...ctx, now: at + 200 }, `task:${child.id}`, "turn-1");
  markRead({ ...ctx, now: at + 300 }, "external:local", [ids[1]!]);
  return { ctx, root, other, child, leaf, ids };
}

/** Short real paths: the cwd rules compare resolved paths, and serve binds a Unix socket under the home. */
function clone(home: string) {
  const copy = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pm-")));
  cpSync(home, copy, { recursive: true });
  return copy;
}

const env = (home: string, extra: Record<string, string>, forward: boolean) => ({
  HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...extra, ...(forward ? { PACER_FORWARD_OPS: FORWARD } : {}),
});

/** Message rows after the run; receipt times differ between runs, so only their presence is compared. */
function rows(home: string) {
  const db = new Database(join(home, ".pacer/state/tasks.db"));
  try {
    return db.query<Record<string, unknown>, []>("SELECT id,recipient,status,read_at FROM messages ORDER BY id").all()
      .map(row => ({ ...row, read_at: row.read_at === null ? null : "set" }));
  } finally { db.close(); }
}

async function stdio(home: string, extra: Record<string, string>, cwd: string, requests: string[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: env(home, extra, forward), cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[0]!).result.protocol).toBe("3.0.0");
    const markers = stderr.split("\n").filter(line => /^native msg\.\S+ \d+$/.test(line));
    return { lines: lines.slice(1), markers };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

/** Receipt times come from each run's clock; every other byte must match. */
const receipts = (line: string) => line.replace(/"readAt":\d+(?:\.\d{1,3})?(?=[,}])/g, '"readAt":"<time>"');
const rpc = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const raw = (id: number, method: string, params: string) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${params}}`;

test.skipIf(!front)("stdio msg.inbox, msg.log and msg.read match the TypeScript core byte for byte", async () => {
  const { ctx, root, other, child, leaf, ids } = seed();
  const ownWorktree = join(ctx.pacerHome, "worktrees", "repo", child.id, "src");
  const orcaWorktree = join(ctx.home, "orca", "workspaces", "ws", `pacer-${child.id}-codex`);
  mkdirSync(ownWorktree, { recursive: true });
  mkdirSync(orcaWorktree, { recursive: true });
  const reads = (base: number) => [
    rpc(base, "msg.inbox", {}), rpc(base + 1, "msg.inbox", { unread_only: false }), rpc(base + 2, "msg.inbox", { limit: 2 }),
    raw(base + 3, "msg.inbox", '{"limit":2.0,"unread_only":false}'), raw(base + 4, "msg.inbox", "null"),
    rpc(base + 5, "msg.log", { task: root.id }), rpc(base + 6, "msg.log", { task: child.id, limit: 1 }),
    rpc(base + 7, "msg.log", { task: child.id, after: ids[1] }), rpc(base + 8, "msg.log", { task: leaf.id }),
    rpc(base + 9, "msg.log", { task: other.id }), rpc(base + 10, "msg.log", { task: "t-20990101-000000-ffff" }),
  ];
  const invalid = (base: number) => [
    rpc(base, "msg.inbox", []), rpc(base + 1, "msg.inbox", { limit: 0, unread_only: "x", bogus: 1, other: 2 }),
    raw(base + 2, "msg.inbox", '{"limit":1e300}'), raw(base + 3, "msg.inbox", '{"limit":1.5}'), rpc(base + 4, "msg.inbox", { limit: null }),
    rpc(base + 5, "msg.log", {}), rpc(base + 6, "msg.log", { task: "t-20260101-000000-ABCD", after: "x".repeat(65), x: 1 }),
    rpc(base + 7, "msg.log", { task: root.id, after: "😀".repeat(64) }), rpc(base + 8, "msg.log", { task: root.id, after: "😀".repeat(65) }),
    rpc(base + 9, "msg.read", {}), rpc(base + 10, "msg.read", { ids: [] }), rpc(base + 11, "msg.read", { ids: [1, "x".repeat(65)], z: 1 }),
    rpc(base + 12, "msg.read", { ids: Array(501).fill("m") }),
  ];
  const writes = (base: number) => [
    rpc(base, "msg.read", { ids: [...ids, ids[0], "missing"] }), rpc(base + 1, "msg.read", { ids: [ids[0]] }),
    rpc(base + 2, "msg.inbox", {}), rpc(base + 3, "msg.inbox", { unread_only: false }),
  ];
  const scenarios: { name: string; env: Record<string, string>; cwd: string; native: boolean; caller: string }[] = [
    { name: "local", env: {}, cwd: ctx.home, native: true, caller: "external:local" },
    { name: "planner", env: { PACER_PLANNER_SESSION: "codex:abc" }, cwd: ctx.home, native: true, caller: "external:codex:abc" },
    { name: "executor", env: { PACER_ROLE: "executor", PACER_TASK_ID: leaf.id }, cwd: ctx.home, native: true, caller: `task:${leaf.id}` },
    { name: "worktree", env: { PACER_TASK_ID: child.id }, cwd: ownWorktree, native: true, caller: `task:${child.id}` },
    { name: "anonymous executor", env: { PACER_ROLE: "executor" }, cwd: ctx.home, native: true, caller: "Executor identity is unknown" },
    { name: "orca worktree", env: {}, cwd: orcaWorktree, native: false, caller: "external:local" },
  ];
  for (const scenario of scenarios) {
    const requests = [...reads(2), ...invalid(20), ...writes(40)];
    const nativeHome = clone(ctx.home), forwardHome = clone(ctx.home);
    try {
      const cwd = (home: string) => scenario.cwd.split(ctx.home).join(home);
      const native = await stdio(nativeHome, scenario.env, cwd(nativeHome), requests, false);
      const forwarded = await stdio(forwardHome, scenario.env, cwd(forwardHome), requests, true);
      expect(native.lines.map(receipts), scenario.name).toEqual(forwarded.lines.map(receipts));
      expect(rows(nativeHome), scenario.name).toEqual(rows(forwardHome));
      expect(forwarded.markers, scenario.name).toEqual([]);
      const expected = scenario.native ? requests.map(request => { const r = JSON.parse(request); return `native ${r.method} ${r.id}`; }) : [];
      expect(native.markers, scenario.name).toEqual(expected);
      const first = JSON.parse(native.lines[0]!);
      expect(first.result?.participant ?? first.error?.message, scenario.name).toBe(scenario.caller);
      // Executors read only their own tree: `other` is a separate root.
      const otherLog = JSON.parse(native.lines[9]!);
      if (scenario.caller.startsWith("task:")) expect(otherLog.error?.message, scenario.name).toBe("That task is outside your tree");
      else if (scenario.caller.startsWith("external:")) expect(otherLog.result?.messages?.length, scenario.name).toBeGreaterThan(0);
    } finally {
      rmSync(nativeHome, { recursive: true, force: true });
      rmSync(forwardHome, { recursive: true, force: true });
    }
  }
  // The fixture exercises real data rather than empty results.
  const sample = await stdio(ctx.home, {}, ctx.home, [rpc(2, "msg.inbox", { unread_only: false }), rpc(3, "msg.log", { task: leaf.id, after: "" })], false);
  const [inbox, log] = sample.lines.map(line => JSON.parse(line).result);
  expect(inbox.participant).toBe("external:local");
  expect(inbox.messages.map((m: { body: string }) => m.body)).toContain("integral");
  expect(inbox.messages.some((m: { status: string }) => m.status === "held")).toBe(false);
  expect(log.messages.map((m: { body: string }) => m.body)).toEqual(["integral"]);
}, 120000);

async function serve(home: string, forward: boolean) {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: env(home, {}, forward), cwd: home, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "", ready = false;
  for (let n = 0; n < 1000 && !ready; n++) {
    try {
      token = readFileSync(join(home, ".pacer/token"), "utf8").trim();
      ready = (await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!ready) await Bun.sleep(20);
  }
  if (!ready) { child.kill("SIGTERM"); await child.exited; throw new Error(`serve did not start: ${await stderr}`); }
  return {
    post: async (op: string, body: string, headers: Record<string, string>) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body, signal: AbortSignal.timeout(10000) });
      return `${response.status} ${await response.text()}`;
    },
    bearer: { Authorization: `Bearer ${token}` },
    app: { Cookie: "", Origin: base, "X-Pacer-Client": "app" },
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native msg\./.test(line)); },
  };
}

test.skipIf(!front)("HTTP msg reads resolve cookie, bearer and TUI session callers like the TypeScript core", async () => {
  const { ctx, root, child, ids } = seed();
  const live = { ...ctx, now: Date.now() / 1000 };
  const cookie = createSession(live), session = createSession(live);
  const runs = [false, true].map(() => clone(ctx.home));
  try {
    const results: { bodies: string[]; markers: string[] }[] = [];
    for (const [index, home] of runs.entries()) {
      const server = await serve(home, index === 1);
      const app = { ...server.app, Cookie: `pacer_session=${cookie}` };
      const tui = { ...server.bearer, "X-Pacer-Session": session };
      const stale = { ...server.bearer, "X-Pacer-Session": "f".repeat(64) };
      const bodies: string[] = [];
      for (const headers of [server.bearer, stale, tui, app]) {
        bodies.push(await server.post("msg.inbox", "{}", headers));
        bodies.push(await server.post("msg.inbox", '{"unread_only":false,"limit":3}', headers));
        bodies.push(await server.post("msg.log", JSON.stringify({ task: child.id }), headers));
        bodies.push(await server.post("msg.inbox", '{"bogus":1}', headers));
      }
      bodies.push(await server.post("msg.read", JSON.stringify({ ids: [ids[0], ids[1]] }), server.bearer));
      bodies.push(await server.post("msg.read", JSON.stringify({ ids: ids.slice(20, 24) }), tui));
      bodies.push(await server.post("msg.read", JSON.stringify({ ids: ids.slice(20, 24) }), app));
      bodies.push(await server.post("msg.inbox", "{}", app));
      bodies.push(await server.post("msg.log", JSON.stringify({ task: root.id, limit: 2 }), app));
      results.push({ bodies, markers: await server.stop() });
    }
    expect(results[0]!.bodies.map(receipts)).toEqual(results[1]!.bodies.map(receipts));
    expect(rows(runs[0]!)).toEqual(rows(runs[1]!));
    expect(results[1]!.markers).toEqual([]);
    // Human read receipts republish task attention in TypeScript, so they stay forwarded.
    expect(results[0]!.markers).toEqual([...Array(16).fill(0).map((_, n) => `native ${["msg.inbox", "msg.inbox", "msg.log", "msg.inbox"][n % 4]}`),
      "native msg.read", "native msg.inbox", "native msg.log"]);
    const parse = (body: string) => JSON.parse(body.slice(4));
    expect(parse(results[0]!.bodies[0]!).result.participant).toBe("external:local");
    expect(parse(results[0]!.bodies[4]!).result.participant).toBe("external:local");
    expect(parse(results[0]!.bodies[8]!).result.participant).toBe("human");
    expect(parse(results[0]!.bodies[12]!).result.participant).toBe("human");
    expect(parse(results[0]!.bodies[17]!).result.read).toBe(4);
  } finally {
    for (const home of runs) rmSync(home, { recursive: true, force: true });
  }
}, 120000);

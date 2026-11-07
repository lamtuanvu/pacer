import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { insertMessage } from "../src/messaging/store";
import { getWork } from "../src/dispatch/work";
import { createSession } from "../src/serve/app-auth";
import type { TaskRecord } from "../src/tasks/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = ["msg.send", "msg.confirm", "msg.close", "msg.wait"];
const STRATEGY = `planner: claude-code
providers: {claude-code: {}, codex: {}}
messaging:
  rules:
    - {limits: {confirm: true}, from_kind: launched, to_kind: external, effect: allow}
`;

function seed() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  const mk = (goal: string, n: number, patch: (t: TaskRecord) => void) => {
    const t = createTask({ ...ctx, now: ctx.now + n }, { brief: { goal, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, t.id, x => { x.state = "done"; patch(x); });
    return t.id;
  };
  const root = mk("root", 0, t => { t.origin = "external:local"; });
  const child = mk("child", 1, t => { t.origin = `task:${root}`; });
  const asker = mk("asker", 2, t => { t.origin = "external:local"; t.question = { text: "which?", at: ctx.now }; });
  const closed = mk("closed", 3, t => { t.msgClosed = true; });
  const cleaned = mk("cleaned", 4, t => { t.worktree = join(ctx.home, "gone"); t.run = { executor: "codex" } as TaskRecord["run"]; });
  // The TypeScript turn check creates the dispatch tables; seed them so both stores start alike.
  getWork(ctx, root);
  let at = ctx.now + 10;
  const put = (from: string, to: string, kind: "message" | "question" | "report", body: string, o: { task?: string; replyTo?: string; held?: boolean } = {}) =>
    insertMessage({ ...ctx, now: (at += 1.5) }, { taskId: o.task ?? root, rootId: `task:${root}`, from, to, kind, body, replyTo: o.replyTo ?? null,
      requestId: null, ...(o.held ? { status: "held" as const } : {}) }).message.id;
  const question = put(`task:${asker}`, "external:local", "question", "which one?", { task: asker });
  const original = put("external:local", `task:${root}`, "message", "please report");
  put(`task:${root}`, "external:local", "report", "done it");
  put("human", "external:local", "message", "ping");
  put("human", `task:${child}`, "message", "child ping", { task: child });
  put(`task:${child}`, "human", "report", "to the human", { task: child });
  const held = put(`task:${child}`, "external:local", "message", "held for you", { task: child, held: true });
  return { ctx, root, child, asker, closed, cleaned, question, original, held };
}

function clone(home: string) {
  const copy = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "mw-")));
  cpSync(home, copy, { recursive: true });
  return copy;
}

const env = (home: string, extra: Record<string, string>, forward: boolean) => ({
  HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS.join(",") } : {}),
});

/** Message ids are random and times come from each run's clock; everything else must match. */
function normalizer() {
  const ids = new Map<string, string>();
  return (text: string) => text
    .replace(/m-\d{14}-[0-9a-f]{8}/g, id => ids.get(id) ?? (ids.set(id, `m#${ids.size}`), `m#${ids.size - 1}`))
    .replace(/"(createdAt|readAt|deliveredAt|answeredAt|updatedAt|settledAt|at)":\d+(?:\.\d+)?(?=[,}])/g, '"$1":"<time>"');
}

function state(home: string) {
  const norm = normalizer();
  const db = new Database(join(home, ".pacer/state/tasks.db"));
  try {
    const messages = db.query<Record<string, unknown>, []>("SELECT * FROM messages ORDER BY rowid").all()
      .map(row => norm(JSON.stringify({ ...row, created_at: typeof row.created_at, read_at: row.read_at === null ? null : "set" })));
    const tasks = db.query<{ record: string }, []>("SELECT record FROM tasks ORDER BY id").all().map(({ record }) => {
      const t = JSON.parse(record) as TaskRecord & { rev: number };
      return norm(JSON.stringify({ id: t.id, rev: t.rev, state: t.state, question: t.question ?? null, msgClosed: t.msgClosed ?? null }));
    });
    const schema = db.query<Record<string, unknown>, []>("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    const outbox = join(home, ".pacer/link/outbox.jsonl");
    const events = existsSync(outbox) ? readFileSync(outbox, "utf8").trim().split("\n").filter(Boolean)
      .map(line => { const e = JSON.parse(line).envelope; return `${e.type}:${e.data?.kind ?? ""}`; }).sort() : [];
    return { messages, tasks, schema, events };
  } finally { db.close(); }
}

async function stdio(home: string, extra: Record<string, string>, requests: string[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: env(home, extra, forward), cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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

const rpc = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const raw = (id: number, method: string, params: string) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${params}}`;
/** The core answers concurrently, so responses are compared in request order. */
const byId = (lines: string[]) => [...lines].sort((a, b) => JSON.parse(a).id - JSON.parse(b).id);

test.skipIf(!front)("stdio msg.send, msg.confirm, msg.close and msg.wait match the TypeScript core", async () => {
  const s = seed();
  const requests = [
    rpc(2, "msg.send", { to: "external:codex:abc", body: "hi there" }),
    rpc(3, "msg.send", { to: "human", body: "  for you \u2028 " }),
    rpc(4, "msg.send", { to: `task:${s.root}`, body: "quote \" and \\ 😀 é" }),
    rpc(5, "msg.send", { to: `task:${s.child}`, body: "q?", kind: "question" }),
    rpc(6, "msg.send", { to: "external:local", body: "to a planner", kind: "report" }),
    rpc(7, "msg.send", { to: `task:${s.closed}`, body: "x" }),
    rpc(8, "msg.send", { to: `task:${s.cleaned}`, body: "x" }),
    rpc(9, "msg.send", { to: "task:t-20990101-000000-ffff", body: "x" }),
    rpc(10, "msg.send", { to: "human", body: "x", kind: "nudge" }),
    rpc(11, "msg.send", { to: "human", body: "x", kind: "answer" }),
    rpc(12, "msg.send", { to: "human", body: " \n\t\u00a0" }),
    rpc(13, "msg.send", {}),
    rpc(14, "msg.send", { to: "bogus", body: "", kind: "x", reply_to: "r".repeat(65), request_id: "", extra: 1 }),
    raw(15, "msg.send", "null"), raw(16, "msg.send", "[]"),
    rpc(17, "msg.send", { to: "human", body: "x".repeat(70000) }),
    rpc(18, "msg.send", { to: "human", body: "once", request_id: "r-1" }),
    rpc(19, "msg.send", { to: "human", body: "once", request_id: "r-1" }),
    rpc(20, "msg.send", { to: "human", body: "twice", request_id: "r-1" }),
    rpc(21, "msg.send", { to: `task:${s.asker}`, body: "the left one", kind: "answer", reply_to: s.question, request_id: "a-1" }),
    rpc(22, "msg.send", { to: `task:${s.asker}`, body: "the left one", kind: "answer", reply_to: s.question, request_id: "a-1" }),
    rpc(23, "msg.confirm", { id: s.held }), rpc(24, "msg.confirm", {}), rpc(25, "msg.confirm", { id: 1, x: 1 }),
    rpc(26, "msg.close", { task: s.root }), rpc(27, "msg.close", { task: "t-20990101-000000-ffff" }), rpc(28, "msg.close", { task: "bad" }),
    rpc(29, "msg.close", { task: s.asker }), rpc(30, "msg.send", { to: `task:${s.asker}`, body: "after close" }),
    rpc(31, "msg.wait", { reply_to: s.original, timeout_s: 1 }), rpc(32, "msg.wait", {}),
    rpc(33, "msg.wait", { timeout_s: 0 }), rpc(34, "msg.wait", { timeout_s: 3001, reply_to: 5 }), rpc(35, "msg.wait", { bogus: true }),
    rpc(36, "msg.wait", { timeout_s: 2 }), rpc(37, "msg.send", { to: "human", body: "while waiting" }),
    rpc(38, "msg.send", { to: "human", body: "x", request_id: "😀".repeat(128) }),
    rpc(39, "msg.send", { to: "human", body: "x", request_id: "😀".repeat(129) }),
  ];
  const scenarios: { name: string; env: Record<string, string>; caller: string }[] = [
    { name: "local", env: {}, caller: "external:local" },
    { name: "executor", env: { PACER_ROLE: "executor", PACER_TASK_ID: s.child }, caller: `task:${s.child}` },
  ];
  for (const scenario of scenarios) {
    const nativeHome = clone(s.ctx.home), forwardHome = clone(s.ctx.home);
    try {
      const native = await stdio(nativeHome, scenario.env, requests, false);
      const forwarded = await stdio(forwardHome, scenario.env, requests, true);
      const norm = [normalizer(), normalizer()];
      expect(byId(native.lines).map(norm[0]!), scenario.name).toEqual(byId(forwarded.lines).map(norm[1]!));
      expect(state(nativeHome), scenario.name).toEqual(state(forwardHome));
      expect(forwarded.markers, scenario.name).toEqual([]);
      const ops = requests.map(request => JSON.parse(request)).filter(r => OPS.includes(r.method));
      expect(native.markers, scenario.name).toEqual(ops.map(r => `native ${r.method} ${r.id}`));
      // A blocking wait does not hold back the requests after it.
      const order = native.lines.map(line => JSON.parse(line).id);
      expect(order.indexOf(37), scenario.name).toBeLessThan(order.indexOf(36));
      const results = Object.fromEntries(byId(native.lines).map(line => { const r = JSON.parse(line); return [r.id, r.result ?? r.error]; }));
      expect(results[32].participant ?? results[32].message, scenario.name).toBe(scenario.caller);
      if (scenario.name === "local") {
        expect(results[2].data.code).toBe("not_allowed");
        expect(results[3].delivery).toBe("pull");
        expect(results[4].delivery).toBe("no_session");
        expect(results[19].duplicate).toBe(true);
        expect(results[20].message).toBe("That request id was already used for a different message");
        expect(results[22].duplicate).toBe(true);
        expect(results[26]).toEqual({ task: s.root, closed: true });
        expect(results[29]).toEqual({ task: s.asker, closed: true });
        expect(results[31].messages.map((m: { body: string }) => m.body)).toEqual(["done it"]);
        expect(results[36].timedOut).toBe(true);
      } else {
        expect(results[6].delivery).toBe("held");
      }
    } finally {
      rmSync(nativeHome, { recursive: true, force: true });
      rmSync(forwardHome, { recursive: true, force: true });
    }
  }
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
    post: async (op: string, body: unknown, headers: Record<string, string>) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      return `${response.status} ${await response.text()}`;
    },
    bearer: { Authorization: `Bearer ${token}` },
    app: { Cookie: "", Origin: base, "X-Pacer-Client": "app" },
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native msg\./.test(line)); },
  };
}

test.skipIf(!front)("HTTP message writes resolve bearer, cookie and TUI session callers like the TypeScript core", async () => {
  const s = seed();
  const live = { ...s.ctx, now: Date.now() / 1000 };
  const cookie = createSession(live), session = createSession(live);
  const runs = [false, true].map(() => clone(s.ctx.home));
  try {
    const results: { bodies: string[]; markers: string[] }[] = [];
    for (const [index, home] of runs.entries()) {
      const server = await serve(home, index === 1);
      const app = { ...server.app, Cookie: `pacer_session=${cookie}` };
      const tui = { ...server.bearer, "X-Pacer-Session": session };
      const bodies: string[] = [];
      bodies.push(await server.post("msg.confirm", { id: s.held }, server.bearer));
      bodies.push(await server.post("msg.confirm", { id: s.held }, app));
      bodies.push(await server.post("msg.confirm", { id: s.held }, tui));
      bodies.push(await server.post("msg.send", { to: `task:${s.root}`, body: "from the human" }, app));
      bodies.push(await server.post("msg.send", { to: "external:codex:abc", body: "tui note", request_id: "t-1" }, tui));
      bodies.push(await server.post("msg.send", { to: "human", body: "bearer note" }, server.bearer));
      bodies.push(await server.post("msg.send", '{"to":"human"', server.bearer));
      bodies.push(await server.post("msg.wait", { timeout_s: 1 }, app));
      bodies.push(await server.post("msg.wait", { reply_to: s.original, timeout_s: 1 }, server.bearer));
      bodies.push(await server.post("msg.close", { task: s.child }, server.bearer));
      bodies.push(await server.post("msg.close", { task: s.root }, app));
      bodies.push(await server.post("msg.send", { to: `task:${s.root}`, body: "after close" }, app));
      results.push({ bodies, markers: await server.stop() });
    }
    const norm = [normalizer(), normalizer()];
    expect(results[0]!.bodies.map(norm[0]!)).toEqual(results[1]!.bodies.map(norm[1]!));
    const [native, forwarded] = runs.map(state);
    expect(native!.messages).toEqual(forwarded!.messages);
    expect(native!.tasks).toEqual(forwarded!.tasks);
    expect(native!.schema).toEqual(forwarded!.schema);
    expect(results[1]!.markers).toEqual([]);
    expect(results[0]!.markers).toEqual(["msg.confirm", "msg.confirm", "msg.confirm", "msg.send", "msg.send", "msg.send",
      "msg.wait", "msg.wait", "msg.close", "msg.close", "msg.send"].map(op => `native ${op}`));
    const parse = (body: string) => JSON.parse(body.slice(4));
    expect(parse(results[0]!.bodies[0]!).error.code).toBe("not_allowed");
    expect(parse(results[0]!.bodies[1]!).result.delivery).toBe("pull");
    expect(parse(results[0]!.bodies[3]!).result.message.from).toBe("human");
    expect(parse(results[0]!.bodies[7]!).result.participant).toBe("human");
    expect(parse(results[0]!.bodies[10]!).result).toEqual({ task: s.root, closed: true });
  } finally {
    for (const home of runs) rmSync(home, { recursive: true, force: true });
  }
}, 120000);

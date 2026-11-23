import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskDatabase } from "../src/tasks/store";
import { closedPort, fakeCtx, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = [
  "session.create", "session.resume", "session.end", "session.prepare", "session.draft.create", "session.file.read", "session.attachment.prepare",
  "session.agent.create", "session.agent.list", "session.agent.get", "session.agent.end", "session.agent.retry", "session.agent.resume",
  "task.attach", "task.session", "task.takeover", "task.hand_back",
].join(",");

const TASK = "t-20231114-010203-abcd";
const PLAIN = "t-20231114-010203-beef";
const UUID = "6f1c2a4e-9b7d-4c3e-8a21-0d5e7f9b1c2a";

function home() {
  // The service's plugin socket path must fit in 103 bytes.
  const dir = mkdtempSync("/tmp/nsl-");
  mkdirSync(join(dir, ".pacer"), { recursive: true });
  return dir;
}

function seed(dir: string, id: string, fields: Record<string, unknown>, rev = 3) {
  const pacerHome = join(dir, ".pacer");
  const record = JSON.stringify({ id, rev, state: "stopped", brief: { goal: "Talk", repo: "/r" }, createdAt: 1, attempts: [], ...fields });
  taskDatabase(fakeCtx({ pacerHome, home: dir })).query("INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES(?,?,'stopped',1,1,?,0)").run(id, rev, record);
}

const environment = (dir: string, forward: boolean, extra: Record<string, string> = {}) => ({
  HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1",
  PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
});

const request = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

/** Replies in request order, with the request indexes the front door marked as native. */
async function stdio(dir: string, requests: string[], forward: boolean, extra: Record<string, string> = {}) {
  const child = Bun.spawn([front!, "api", "--stdio"], { cwd: dir, env: pinnedPort(environment(dir, forward, extra)), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n").slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id);
    const marked = stderr.split("\n").flatMap(line => /^native (?:session|task)\.\S+ (\d+)$/.exec(line)?.[1] ?? []).map(Number);
    return { lines, marked };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

async function serve(dir: string, forward: boolean) {
  const port = closedPort();
  const env = pinnedPort(environment(dir, forward), port);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let n = 0; n < 2000 && !token && child.exitCode === null; n++) {
    try {
      const candidate = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
      if ((await fetch(`${base}/v2/hello`, { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) })).ok) token = candidate;
    } catch { /* the service is still starting */ }
    if (!token) await Bun.sleep(20);
  }
  if (!token) { child.kill("SIGKILL"); throw new Error(`service did not start: ${await stderr}`); }
  const post = async (op: string, body: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Connection: "close", ...headers }, body, keepalive: false, signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.text() };
  };
  const raw = (path: string, init: RequestInit) => fetch(base + path, init);
  const stop = async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    return stderr;
  };
  return { post, raw, stop, token };
}

const INVALID: [string, unknown][] = [
  ["session.create", {}], ["session.create", undefined], ["session.create", null], ["session.create", [1]], ["session.create", "text"],
  ["session.create", { request_id: "a b", draftId: "x", request: "", repo: "", executor: "", workspace: { mode: "bad" }, attachments: ["x", 1] }],
  ["session.create", { workspace: 1, attachments: {} }], ["session.create", { workspace: {} }], ["session.create", { workspace: { mode: "new", base: 1 } }],
  ["session.create", { workspace: { mode: "current", path: "" } }], ["session.create", { workspace: null, executor: "😀".repeat(257) }],
  ["session.create", { request: "😀".repeat(100001), executor: "😀".repeat(256) }], ["session.create", { draftId: "123e4567-e89b-12d3-a456-4266-4174000" }],
  ["session.resume", {}], ["session.resume", { id: "a b", expect_rev: 0 }], ["session.end", { id: TASK, expect_rev: -1 }], ["session.end", { expect_rev: "1" }],
  ["session.prepare", {}], ["session.prepare", { repo: "", executor: 1 }], ["session.draft.create", "x"], ["session.draft.create", [1]],
  ["session.file.read", {}], ["session.file.read", { id: TASK, attempt: 0, reference: "" }], ["session.file.read", { id: TASK, attempt: "1", reference: "x".repeat(4097) }],
  ["session.attachment.prepare", { id: TASK, attachmentId: "x" }], ["session.attachment.prepare", {}],
  ["session.agent.create", { x: 1 }], ["session.agent.create", { task_id: "t", request_id: "r r", executor: "", request: "" }],
  ["session.agent.list", { task_id: "a b", x: 1 }], ["session.agent.list", { x: 1 }], ["session.agent.list", 5],
  ["session.agent.get", { z: 1 }], ["session.agent.get", { task_id: TASK, id: "x" }],
  ["session.agent.end", { task_id: "t", id: "x", expect_rev: 0, q: 1 }], ["session.agent.retry", {}], ["session.agent.resume", { task_id: "t", id: UUID, expect_rev: "2" }],
  ["task.attach", { id: TASK, target: "x" }], ["task.attach", {}], ["task.session", {}], ["task.session", { id: "a b" }], ["task.takeover", { id: 1 }], ["task.hand_back", null],
];

test.skipIf(!front)("params errors match forced forwarding byte for byte on stdio and HTTP", async () => {
  const dir = home();
  const requests = INVALID.map(([op, params], index) => request(index + 2, op, params));
  const native = await stdio(dir, requests, false);
  const forwarded = await stdio(dir, requests, true);
  expect(native.lines).toEqual(forwarded.lines);
  expect(native.marked).toEqual(INVALID.map((_, index) => index + 2));
  expect(forwarded.marked).toEqual([]);
  expect(native.lines.every(line => JSON.parse(line).error?.data?.code === "invalid_input")).toBe(true);

  const replies = async (forward: boolean) => {
    const service = await serve(dir, forward);
    try {
      const out = [];
      for (const [op, params] of INVALID) out.push(await service.post(op, params === undefined ? "null" : JSON.stringify(params)));
      return out;
    } finally { await service.stop(); }
  };
  expect(await replies(false)).toEqual(await replies(true));
}, 120000);

test.skipIf(!front)("an enforcement identity is refused natively before the schema", async () => {
  const dir = home();
  const requests = [request(2, "session.create", "bad"), request(3, "session.draft.create", {}), request(4, "task.session", { id: TASK }), request(5, "session.agent.list", { x: 1 })];
  const env = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  const native = await stdio(dir, requests, false, env);
  expect(native.lines).toEqual((await stdio(dir, requests, true, env)).lines);
  expect(native.marked).toEqual([2, 3, 4, 5]);
  expect(native.lines.every(line => JSON.parse(line).error?.data?.code === "not_allowed")).toBe(true);
}, 60000);

test.skipIf(!front)("record refusals match forced forwarding", async () => {
  const dir = home();
  seed(dir, TASK, { interactionMode: "conversation", state: "stopped", run: { attempt: 2, workdir: "/nowhere" } });
  seed(dir, PLAIN, { interactionMode: "headless", run: { attempt: 1, host: "m1", workdir: "/nowhere" } });
  const requests = [
    request(2, "session.end", { id: "t-20231114-010203-ffff", expect_rev: 1 }), request(3, "session.end", { id: "request", expect_rev: 1 }),
    request(4, "session.end", { id: PLAIN, expect_rev: 3 }), request(5, "session.end", { id: TASK, expect_rev: 9 }),
    request(6, "session.attachment.prepare", { id: "t-20231114-010203-ffff", attachmentId: UUID }), request(7, "session.attachment.prepare", { id: PLAIN, attachmentId: UUID }),
    request(8, "session.attachment.prepare", { id: TASK, attachmentId: UUID }),
    request(9, "session.file.read", { id: "t-20231114-010203-ffff", attempt: 1, reference: "a" }), request(10, "session.file.read", { id: TASK, attempt: 1, reference: "a" }),
    request(11, "session.file.read", { id: PLAIN, attempt: 1, reference: "a" }),
  ];
  const native = await stdio(dir, requests, false);
  expect(native.lines).toEqual((await stdio(dir, requests, true)).lines);
  expect(native.marked).toEqual(requests.map((_, index) => index + 2));
  expect(native.lines.map(line => JSON.parse(line).error.data.code)).toEqual(
    ["unknown_task", "unknown_task", "not_allowed", "conflict", "unknown_task", "not_allowed", "conflict", "unknown_task", "conflict", "not_allowed"]);
}, 60000);

test.skipIf(!front)("session.draft.create is answered natively and writes the shared draft table", async () => {
  const dir = home();
  const replies = await stdio(dir, [request(2, "session.draft.create", {}), request(3, "session.draft.create", null), request(4, "session.draft.create", { ignored: true })], false);
  expect(replies.marked).toEqual([2, 3, 4]);
  const ids = replies.lines.map(line => JSON.parse(line).result.id as string);
  expect(new Set(ids).size).toBe(3);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const db = new Database(join(dir, ".pacer/state/tasks.db"));
  try {
    const rows = db.query("SELECT id, created, task FROM attachment_drafts").all() as { id: string; created: number; task: string | null }[];
    expect(rows.map(row => row.id).sort()).toEqual([...ids].sort());
    for (const row of rows) { expect(row.task).toBeNull(); expect(Math.abs(row.created - Date.now() / 1000)).toBeLessThan(60); }
  } finally { db.close(); }
}, 60000);

/** Requests Rust admits. Every reply comes from Core, through the bridge on HTTP and unchanged on stdio. */
const ADMITTED: [string, unknown][] = [
  ["session.agent.list", {}], ["session.agent.list", { task_id: "t-20231114-010203-ffff" }], ["session.agent.get", { task_id: TASK, id: UUID }],
  ["session.agent.end", { task_id: TASK, id: UUID, expect_rev: 1 }], ["session.agent.retry", { task_id: "t-20231114-010203-ffff", id: UUID, expect_rev: 1 }],
  ["session.agent.resume", { task_id: TASK, id: UUID, expect_rev: 1 }],
  ["session.prepare", { repo: "/definitely/not/a/repo" }], ["session.resume", { id: PLAIN, expect_rev: 3 }], ["session.resume", { id: TASK, expect_rev: 9 }],
  ["session.file.read", { id: TASK, attempt: 2, reference: "a\u0001b" }], ["session.file.read", { id: TASK, attempt: 2, reference: "missing.txt" }],
  ["task.session", { id: "t-20231114-010203-ffff" }], ["task.attach", { id: "t-20231114-010203-ffff", target: "here" }],
  ["task.takeover", { id: PLAIN }], ["task.hand_back", { id: PLAIN }],
];

const seeded = () => {
  const dir = home();
  seed(dir, TASK, { interactionMode: "conversation", state: "stopped", run: { attempt: 2, workdir: "/nowhere" } });
  seed(dir, PLAIN, { interactionMode: "headless", run: { attempt: 1, workdir: "/nowhere" } });
  return dir;
};

test.skipIf(!front)("admitted requests reply as forced forwarding does on stdio", async () => {
  const requests = ADMITTED.map(([op, params], index) => request(index + 2, op, params));
  const dir = seeded();
  const native = await stdio(dir, requests, false);
  expect(native.lines).toEqual((await stdio(dir, requests, true)).lines);
  expect(native.marked).toEqual(ADMITTED.map((_, index) => index + 2));
}, 90000);

test.skipIf(!front)("admitted requests cross the HTTP bridge with forced-forward replies and the caller's identity", async () => {
  const dir = seeded();
  const headers = { "X-Pacer-Client": "pacer-app/1.2.3", "X-Pacer-Client-Instance": "window-1" };
  const replies = async (forward: boolean) => {
    const service = await serve(dir, forward);
    const out = [];
    try { for (const [op, params] of ADMITTED) out.push(await service.post(op, JSON.stringify(params), headers)); }
    finally { var stderr = await service.stop(); }
    return { out, stderr };
  };
  const native = await replies(false), forwarded = await replies(true);
  expect(native.out).toEqual(forwarded.out);
  for (const op of new Set(ADMITTED.map(([name]) => name))) {
    expect(native.stderr).toContain(`native ${op}`);
    expect(forwarded.stderr).not.toContain(`native ${op}`);
  }
}, 120000);

test.skipIf(!front)("inputs only JavaScript reads exactly stay with Core", async () => {
  const dir = seeded();
  const requests = [
    `{"jsonrpc":"2.0","id":2,"method":"session.end","params":{"id":"${TASK}","expect_rev":1.5}}`,
    `{"jsonrpc":"2.0","id":3,"method":"session.end","params":{"id":"${TASK}","expect_rev":9007199254740993}}`,
    `{"jsonrpc":"2.0","id":4,"method":"session.file.read","params":{"id":"${TASK}","attempt":1e400,"reference":"a"}}`,
    `{"jsonrpc":"2.0","id":5,"method":"session.agent.list","params":{"b":1,"a":2}}`,
    `{"jsonrpc":"2.0","id":6,"method":"session.agent.list","params":{"2":1}}`,
    `{"jsonrpc":"2.0","id":7,"method":"session.agent.list","params":{"__proto__":1}}`,
    request(8, "session.create", { attachments: new Array(21).fill("x") }),
    `{"jsonrpc":"2.0","id":9,"method":"session.prepare","params":{"repo":"\\ud800"}}`,
  ];
  const native = await stdio(dir, requests, false);
  expect(native.lines).toEqual((await stdio(dir, requests, true)).lines);
  expect(native.marked).toEqual([]);
}, 60000);

test.skipIf(!front)("the public listener never exposes the private bridge", async () => {
  const service = await serve(home(), false);
  try {
    const body = JSON.stringify({ request: { op: "session.agent.list", params: {} } });
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${service.token}` }] as Record<string, string>[])
      expect((await service.raw("/_internal/session-lifecycle", { method: "POST", headers, body })).status).toBe(404);
  } finally { await service.stop(); }
}, 60000);

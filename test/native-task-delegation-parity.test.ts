import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { Ctx } from "../src/types";
import { closedPort, fakeCtx, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "task.delegate,task.retry,task.retry_all,task.answer,task.ask,doctor.fix.delegate";
const MISSING = "t-20261119-000000-abcd";
const EXECUTOR_ERROR = "PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.";

type Case = [method: string, params: unknown];

const baseEnv = (home: string) => ({
  HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
});

function clone(home: string) {
  const copy = realpathSync(mkdtempSync("/tmp/ptd-"));
  cpSync(home, copy, { recursive: true });
  return copy;
}

/** One stdio session; returns each reply's raw line and the request ids the front door answered itself. */
async function stdio(home: string, cases: Case[], forward: boolean, extra: Record<string, string> = {}) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: pinnedPort({ ...baseEnv(home), ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) }),
  });
  try {
    const lines = [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }),
      ...cases.map(([method, params], index) => JSON.stringify({ jsonrpc: "2.0", id: index + 2, method, ...(params === undefined ? {} : { params }) }))];
    await child.stdin.write(lines.join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const raw = new Map<number, string>();
    for (const line of stdout.trim().split("\n")) raw.set(JSON.parse(line).id as number, line);
    const native = stderr.split("\n").flatMap(line => {
      const match = /^native (\S+) (\d+)$/.exec(line);
      return match && OPS.split(",").includes(match[1]!) ? [Number(match[2])] : [];
    });
    return { replies: cases.map((_, index) => raw.get(index + 2)!), native };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

/** Runs `cases` natively and with every op forced to Core; returns the native result after comparing raw bytes. */
async function same(home: string, cases: Case[], extra: Record<string, string> = {}) {
  const [nativeHome, forwardedHome] = [clone(home), clone(home)];
  try {
    const native = await stdio(nativeHome, cases, false, extra);
    const forwarded = await stdio(forwardedHome, cases, true, extra);
    expect(forwarded.native).toEqual([]);
    cases.forEach(([method, params], index) => expect(native.replies[index], `${method} ${JSON.stringify(params)}`).toBe(forwarded.replies[index]!));
    return native;
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardedHome, { recursive: true, force: true });
  }
}

const all = (cases: Case[]) => cases.map((_, index) => index + 2);
const errorOf = (line: string) => JSON.parse(line).error as { message: string; data: { code: string } };

function seeded() {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const make = (goal: string, patch: (t: TaskRecord) => void) => {
    const t = createTask(ctx, { brief: { goal, repo: ctx.home }, kind: null, requestedExecutor: "codex", timeoutS: 600 });
    updateTask(ctx, t.id, patch);
    return t.id;
  };
  return { ctx, make };
}

const PARAM_ERRORS: Case[] = [
  ["task.delegate", {}], ["task.delegate", undefined], ["task.delegate", null], ["task.delegate", [1]], ["task.delegate", "text"],
  ["task.delegate", { goal: "", repo: "" }],
  ["task.delegate", { grant: 1, interactive: "y", timeout_min: 0, worktree_reason: "r".repeat(201), worktree: "x", worktree_base: "x", executor: 1, kind: "x", context: 1, constraints: 1,
    acceptance_timeout_min: 121, acceptance_pipefail: "y", acceptance: 1, scope: 1, repo: 1, goal: 1, source: "x", request_id: "", title: "   ", model: "", difficulty: "x", group: "-bad" }],
  ["task.delegate", { goal: "g", repo: "/r", title: "t".repeat(61), model: "m".repeat(257), request_id: "r".repeat(129), timeout_min: 241, acceptance_timeout_min: 0, group: "g".repeat(41) }],
  ["task.delegate", { goal: "g", repo: "/r", title: "😀".repeat(61), group: 5, kind: null, worktree: null }],
  ["task.retry", {}], ["task.retry", { id: "", expect_rev: 0, executor: "", from_panel: 1 }], ["task.retry", { id: "x".repeat(129), expect_rev: -1, executor: "e".repeat(129) }],
  ["task.retry", { id: "t", expect_rev: "1" }], ["task.retry", { id: 5, expect_rev: null }],
  ["task.retry_all", {}], ["task.retry_all", { ids: [] }], ["task.retry_all", { ids: "x" }], ["task.retry_all", { ids: [1, ""], executor: "", from_panel: "y" }],
  ["task.retry_all", { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }], ["task.retry_all", { ids: [...Array.from({ length: 101 }, () => "a"), 1] }],
  ["task.answer", {}], ["task.answer", { id: "", text: "", expect_rev: 0 }], ["task.answer", { id: "t", text: "😀".repeat(2001) }], ["task.answer", { id: "t", text: 1, expect_rev: "1" }],
  ["task.ask", {}], ["task.ask", { id: "", text: "" }], ["task.ask", { id: "t", text: "q".repeat(1001) }], ["task.ask", { id: 1, text: null }],
  ["doctor.fix.delegate", {}], ["doctor.fix.delegate", { check: "", scope: "x" }], ["doctor.fix.delegate", { check: "c".repeat(257), scope: 1 }], ["doctor.fix.delegate", null],
];

test.skipIf(!front)("params errors match forced forwarding byte for byte over stdio", async () => {
  const { ctx } = seeded();
  const result = await same(ctx.home, PARAM_ERRORS);
  expect(result.native).toEqual(all(PARAM_ERRORS));
  for (const reply of result.replies) expect(errorOf(reply).data.code).toBe("invalid_input");
}, 60000);

test("the TypeScript operation gives the reference text for the refusals Rust reproduces", async () => {
  const ctx: Ctx = fakeCtx({ env: { PACER_ROLE: "executor" } });
  const code = (op: string, params: unknown) => callOp(ctx, op, params).then(() => null, (e: CoreError) => [e.code, e.message]);
  for (const [op, params] of [["task.delegate", { goal: "g", repo: ctx.home }], ["task.retry", { id: MISSING }], ["task.retry_all", { ids: [MISSING] }], ["doctor.fix.delegate", { check: "c", scope: "fix" }]] as const)
    expect(await code(op, params)).toEqual(["not_allowed", EXECUTOR_ERROR]);
  expect(await code("task.answer", { id: MISSING, text: "a" })).toEqual(["not_allowed", "executors cannot delegate onward"]);
  expect(await code("task.ask", { id: MISSING, text: "q" })).toEqual(["not_allowed", "pacer ask works only inside a delegated task"]);
});

test.skipIf(!front)("executor and enforcement identities are refused as TypeScript refuses them, without effects", async () => {
  const { ctx, make } = seeded();
  const running = make("running", t => { t.state = "running"; });
  const before = readTask(ctx, running);
  const cases: Case[] = [
    ["task.delegate", { goal: "g", repo: ctx.home }], ["task.retry", { id: running }], ["task.retry_all", { ids: [running, "nope"] }],
    ["doctor.fix.delegate", { check: "Strategy", scope: "fix" }], ["task.answer", { id: running, text: "a" }], ["task.ask", { id: running, text: "q" }],
  ];
  const executor = await same(ctx.home, cases, { PACER_ROLE: "executor" });
  expect(executor.native).toEqual(all(cases));
  expect(executor.replies.map(reply => errorOf(reply).data.code)).toEqual(Array(6).fill("not_allowed"));
  expect(errorOf(executor.replies[0]!).message).toBe(EXECUTOR_ERROR);

  const invalid: Case[] = [...cases, ["task.delegate", "not an object"], ["task.ask", {}]];
  const enforced = await same(ctx.home, invalid, { PACER_ENFORCEMENT_TOKEN: "pet_x" });
  expect(enforced.native).toEqual(all(invalid));
  for (const reply of enforced.replies) expect(errorOf(reply).message).toBe("Enforcement identity only reports a native child denial");
  expect(readTask(ctx, running)).toEqual(before);
}, 60000);

test.skipIf(!front)("task.ask record refusals match, and a question that can be recorded runs in Core", async () => {
  const { ctx, make } = seeded();
  const asked = make("asked", t => { t.state = "running"; t.question = { text: "A or B?", at: 1 }; });
  const settled = make("settled", t => { t.state = "done"; });
  const running = make("running", t => { t.state = "running"; });
  const as = (id: string) => ({ PACER_ROLE: "executor", PACER_TASK_ID: id });

  const refused: [string, Case, string, string][] = [
    [asked, ["task.ask", { id: asked, text: "again" }], "conflict", "already asked; stop and wait for the answer"],
    [settled, ["task.ask", { id: settled, text: "late" }], "conflict", "task is not running"],
    [MISSING, ["task.ask", { id: MISSING, text: "who" }], "unknown_task", `unknown task ${MISSING}`],
    ["nope", ["task.ask", { id: "nope", text: "who" }], "unknown_task", "unknown task nope"],
    [running, ["task.ask", { id: running, text: "😀".repeat(501) }], "invalid_input", "question must contain 1–1000 characters"],
    [settled, ["task.ask", { id: running, text: "not mine" }], "not_allowed", "pacer ask works only inside a delegated task"],
  ];
  for (const [own, request, code, message] of refused) {
    const result = await same(ctx.home, [request], as(own));
    expect(result.native).toEqual([2]);
    expect(errorOf(result.replies[0]!)).toMatchObject({ message, data: { code } });
  }

  const home = clone(ctx.home);
  try {
    const result = await stdio(home, [["task.ask", { id: running, text: "A or B?" }]], false, as(running));
    expect(result.native).toEqual([]);
    expect(JSON.parse(result.replies[0]!).result).toMatchObject({ id: running, question: { text: "A or B?" } });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!front)("ids that cannot name a task are answered natively; well-formed ids and admitted requests reach Core", async () => {
  const { ctx } = seeded();
  const refused: Case[] = [
    ["task.retry", { id: "nope" }], ["task.answer", { id: "nope", text: "a" }],
    ["task.answer", { id: MISSING, text: "😀".repeat(1001) }],
    ["task.retry_all", { ids: ["b", "a", "b"] }],
  ];
  const result = await same(ctx.home, refused);
  expect(result.native).toEqual(all(refused));
  expect(JSON.parse(result.replies[3]!).result).toEqual({ retried: [], skipped: [{ id: "b", reason: "unknown task b" }, { id: "a", reason: "unknown task a" }] });

  const routed: Case[] = [
    ["task.retry", { id: MISSING }], ["task.answer", { id: MISSING, text: "a" }], ["task.retry_all", { ids: ["nope", MISSING] }],
    ["task.delegate", { goal: "g", repo: join(ctx.home, "missing-repo") }],
    ["task.delegate", { goal: "", repo: "", base: "not a ref.." }], ["task.delegate", { goal: "", repo: "", messaging: 1 }],
    ["task.delegate", { goal: "g", repo: "/r", timeout_min: 1.5, kind: "x" }], ["task.retry", { id: "", expect_rev: 1.5 }],
    ["doctor.fix.delegate", { check: "No such check", scope: "investigate" }],
  ];
  expect((await same(ctx.home, routed)).native).toEqual([]);
}, 120000);

async function serve(home: string, forward: boolean) {
  const port = closedPort();
  const env = pinnedPort({ ...baseEnv(home), ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) }, port);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let n = 0; n < 500 && !token; n++) {
    try {
      const candidate = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
      const response = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) });
      if (response.ok) token = candidate;
    } catch {}
    if (!token) await Bun.sleep(20);
  }
  expect(token).not.toBe("");
  const post = async (op: string, body: string) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(20000) });
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
  };
  const stop = async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    return stderr;
  };
  return { post, stop };
}

test.skipIf(!front)("HTTP replies match forced forwarding, including bodies serde_json cannot represent", async () => {
  const cases: { op: string; body: string; native?: true }[] = [
    { op: "task.delegate", body: "{}", native: true },
    { op: "task.delegate", body: "null", native: true },
    { op: "task.retry", body: '{"id":"nope"}', native: true },
    { op: "task.retry_all", body: '{"ids":["b","a","b"]}', native: true },
    { op: "task.answer", body: '{"id":"nope","text":"a"}', native: true },
    { op: "task.ask", body: '{"id":"nope","text":"q"}', native: true },
    { op: "doctor.fix.delegate", body: '{"check":"","scope":"x"}', native: true },
    { op: "task.retry", body: `{"id":"${MISSING}"}` },
    { op: "task.answer", body: `{"id":"${MISSING}","text":"a"}` },
    { op: "task.delegate", body: '{"goal":"","repo":"","timeout_min":1.5}' },
    { op: "task.answer", body: String.raw`{"id":"nope","text":"\ud800"}` },
    { op: "task.retry", body: '{"id":"nope","expect_rev":1e400}' },
    { op: "task.retry_all", body: "{" },
  ];
  const run = async (forward: boolean) => {
    const home = mkdtempSync("/tmp/ptd-");
    mkdirSync(join(home, ".pacer"), { mode: 0o700 });
    const service = await serve(home, forward);
    try {
      const replies = [];
      for (const { op, body } of cases) replies.push(await service.post(op, body));
      return { replies, stderr: await service.stop() };
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.replies).toEqual(forwarded.replies);
  const markers = (stderr: string) => stderr.split("\n").filter(line => /^native (task\.(delegate|retry|retry_all|answer|ask)|doctor\.fix\.delegate)$/.test(line));
  expect(markers(native.stderr)).toEqual(cases.filter(c => c.native).map(c => `native ${c.op}`));
  expect(markers(forwarded.stderr)).toEqual([]);
}, 120000);

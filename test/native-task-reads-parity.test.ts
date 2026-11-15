import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function exchange(home: string, requests: string[], forward: boolean, forwardOps = "activity.list,task.log") {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: forwardOps } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(request => JSON.parse(request).method as string));
    const markers = stderr.split("\n").filter(line => {
      const match = /^native (\S+) \d+$/.exec(line);
      return match != null && ops.has(match[1]!);
    });
    expect(markers).toEqual(forward ? [] : requests.map((request, index) => `native ${JSON.parse(request).method} ${index + 2}`));
    return replies.slice(1);
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

test.skipIf(!front)("activity.list and task.log match forced forwarding with exact native traces", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const activity = join(ctx.pacerHome, "state/activity.jsonl");
  writeFileSync(activity, Array.from({ length: 101 }, (_, n) => JSON.stringify({ id: `row-${n}`, at: n, kind: "config", level: "info", text: `row ${n}` })).join("\n") + "\n", { mode: 0o600 });
  const task = createTask(ctx, { brief: { goal: "read parity", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const run = join(ctx.pacerHome, "runs", task.id);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  writeFileSync(join(run, "stdout"), "0123456789".repeat(11), { mode: 0o600 });
  writeFileSync(join(run, "stderr"), "abcdefghij", { mode: 0o600 });
  updateTask(ctx, task.id, t => { t.run = { ...t.run, dir: run } as typeof t.run; t.state = "running"; });
  const request = (id: number, method: string, params: string) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${params}}`;
  const cases: [string, string][] = [
    ["activity.list", '{"limit":2.0}'], ["activity.list", '{"limit":1e2}'],
    ["activity.list", '{"limit":2.0,"before":"row-99"}'],
    ["activity.list", '{"limit":0}'], ["activity.list", '{"limit":1.5}'],
    ["activity.list", '{"limit":501}'], ["activity.list", '{"limit":null}'],
    ["activity.list", '{"limit":9007199254740992}'],
    ["activity.list", '{"limit":-9007199254740992}'],
    ["activity.list", '{"before":"missing"}'], ["activity.list", '{"before":""}'],
    ["activity.list", '{"repo":""}'], ["activity.list", '{"kinds":["bogus"]}'],
    ["activity.list", '{"kinds":["config"],"limit":2}'],
    ["activity.list", JSON.stringify({ taskId: "😀".repeat(128) })],
    ["activity.list", JSON.stringify({ taskId: "😀".repeat(129) })],
    ["task.log", `{"id":"${task.id}","stdout":2.0,"stderr":2.0}`],
    ["task.log", `{"id":"${task.id}","stdout":1e2}`],
    ["task.log", `{"id":"${task.id}","stdout":9007199254740991}`],
    ["task.log", `{"id":"${task.id}","stdout":9007199254740992}`],
    ["task.log", `{"id":"${task.id}","stdout":-9007199254740992}`],
    ["task.log", `{"id":"${task.id}","stdout":0.5}`],
    ["task.log", `{"id":"${task.id}","stderr":2.0}`],
    ["task.log", `{"id":"${task.id}","stderr":1e2}`],
    ["task.log", `{"id":"${task.id}","stderr":-1}`],
    ["task.log", `{"id":"${task.id}","stdout":null}`],
    ["task.log", '{"id":"missing"}'], ["task.log", '{}'],
    ["task.log", '{"id":""}'],
    ["task.log", JSON.stringify({ id: "😀".repeat(129) })],
    ["task.log", JSON.stringify({ id: "😀".repeat(128) })],
  ];
  let seed = 577;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const activityLimits: unknown[] = [undefined, null, true, "2", -1, 0, 1, 2, 500, 501, 0.5];
  const offsets: unknown[] = [undefined, null, false, "2", -1, 0, 2, 100, 0.5, 9_007_199_254_740_991, 9_007_199_254_740_992];
  const cursors: unknown[] = [undefined, "", "missing", "row-99", "row-50", 2];
  for (let i = 0; i < 32; i++) {
    if (i % 2 === 0) {
      cases.push(["activity.list", JSON.stringify({ limit: activityLimits[next() % activityLimits.length], before: cursors[next() % cursors.length],
        kinds: [undefined, ["config"], ["bogus"], "config"][next() % 4] })]);
    } else {
      cases.push(["task.log", JSON.stringify({ id: task.id, stdout: offsets[next() % offsets.length], stderr: offsets[next() % offsets.length] })]);
    }
  }
  const requests = cases.map(([op, params], index) => request(index + 2, op, params));
  const files = [activity, join(run, "stdout"), join(run, "stderr"), join(ctx.pacerHome, "tasks", `${task.id}.json`)];
  const before = files.map(path => readFileSync(path).toString("base64"));
  const native = await exchange(ctx.home, requests, false);
  const forwarded = await exchange(ctx.home, requests, true);
  expect(native).toEqual(forwarded);
  expect(native[0]?.result?.entries).toHaveLength(2);
  expect(native[1]?.result?.entries).toHaveLength(100);
  expect(native[2]?.result?.entries).toHaveLength(2);
  const offset2 = cases.findIndex(([op, params]) => op === "task.log" && params.includes('"stdout":2.0'));
  const offset100 = cases.findIndex(([op, params]) => op === "task.log" && params.includes('"stdout":1e2'));
  expect(native[offset2]?.result?.stdout).toStartWith("234");
  expect(native[offset100]?.result?.stdout).toStartWith("012");
  expect(files.map(path => readFileSync(path).toString("base64"))).toEqual(before);

  for (const [receipt, done] of [
    ["0x10", true], ["0x" + "f".repeat(400), false], ["0x", false],
    ["\uFEFF0b101\uFEFF", true], ["\u20280o77\u2029", true],
    ["\u00A02\u3000", true], ["\u00852", false],
  ] as const) {
    writeFileSync(join(run, "exit"), receipt);
    const requests = [request(2, "task.log", JSON.stringify({ id: task.id }))];
    const actual = await exchange(ctx.home, requests, false);
    expect(actual).toEqual(await exchange(ctx.home, requests, true));
    expect(actual[0]?.result?.done, receipt.slice(0, 20)).toBe(done);
  }
  writeFileSync(activity, [
    '{"id":"finite-exp","at":1e2,"kind":"config","level":"info","text":"finite"}',
    '{"id":"huge-exp","at":1e400,"kind":"config","level":"info","text":"not finite"}',
    '{"id":"finite-dec","at":2.0,"kind":"config","level":"info","text":"finite"}',
    '{"id":"string-at","at":"2","kind":"config","level":"info","text":"not a number"}',
    '{"id":"null-at","at":null,"kind":"config","level":"info","text":"not a number"}',
  ].join("\n") + "\n");
  const activityRequest = [request(2, "activity.list", "{}")];
  const activityNative = await exchange(ctx.home, activityRequest, false);
  expect(activityNative).toEqual(await exchange(ctx.home, activityRequest, true));
  expect(activityNative[0]?.result?.entries.map((entry: { id: string }) => entry.id)).toEqual(["finite-dec", "finite-exp"]);
}, 60000);

test.skipIf(!front)("task.prune and task.restore match forced forwarding with exact native traces", async () => {
  const seed = fakeCtx();
  mkdirSync(join(seed.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(seed.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {}\ntask_retention_days: 14\n", { mode: 0o600 });
  const old = { ...seed, now: seed.now - 30 * 86400 };
  const task = createTask(old, { brief: { goal: "retention parity", repo: seed.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(old, task.id, t => { t.state = "done"; t.dismissed = true; });
  writeFileSync(join(seed.pacerHome, "tasks", `${task.id}.log`), "0123456789".repeat(1000), { mode: 0o600 });
  writeFileSync(join(seed.pacerHome, "tasks", `${task.id}.brief.md`), "brief", { mode: 0o600 });
  const clone = () => {
    const home = mkdtempSync(join(tmpdir(), "pacer-retention-parity-"));
    cpSync(seed.home, home, { recursive: true });
    return home;
  };
  const normalize = (value: unknown, home: string) =>
    JSON.parse(JSON.stringify(value).split(home).join("$HOME").split(home.replaceAll("\\", "/")).join("$HOME"));
  const compare = async (requests: string[]) => {
    const nativeHome = clone(), forwardHome = clone();
    try {
      const forwardOps = "task.prune,task.restore";
      const native = await exchange(nativeHome, requests, false, forwardOps);
      const forwarded = await exchange(forwardHome, requests, true, forwardOps);
      expect(normalize(native, nativeHome)).toEqual(normalize(forwarded, forwardHome));
      return native;
    } finally {
      rmSync(nativeHome, { recursive: true, force: true });
      rmSync(forwardHome, { recursive: true, force: true });
    }
  };
  const request = (id: number, method: string, params: string) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${params}}`;
  const dry = await compare([request(2, "task.prune", '{"dry_run":true}')]);
  expect(dry[0]?.result?.dryRun).toBe(true);
  expect(dry[0]?.result?.tasks?.[0]?.id).toBe(task.id);
  expect(dry[0]?.result?.bytesSaved).toBeGreaterThan(0);

  const bad = await compare([
    request(2, "task.prune", '{"dry_run":"yes"}'),
    request(3, "task.restore", "{}"),
    request(4, "task.restore", '{"id":""}'),
    request(5, "task.restore", '{"id":"missing"}'),
  ]);
  expect(bad.map(reply => reply.error?.data?.code)).toEqual(["invalid_input", "invalid_input", "invalid_input", "unknown_task"]);

  const prune = await compare([request(2, "task.prune", "{}")]);
  expect(prune[0]?.result?.tasks?.[0]?.id).toBe(task.id);
  expect(prune[0]?.result?.dryRun).toBe(false);

  const archived = clone();
  try {
    await exchange(archived, [request(2, "task.prune", "{}")], false, "task.prune,task.restore");
    const restore = await (async () => {
      const nativeHome = mkdtempSync(join(tmpdir(), "pacer-retention-parity-"));
      const forwardHome = mkdtempSync(join(tmpdir(), "pacer-retention-parity-"));
      cpSync(archived, nativeHome, { recursive: true });
      cpSync(archived, forwardHome, { recursive: true });
      try {
        const requests = [request(2, "task.restore", JSON.stringify({ id: task.id }))];
        const native = await exchange(nativeHome, requests, false, "task.prune,task.restore");
        const forwarded = await exchange(forwardHome, requests, true, "task.prune,task.restore");
        expect(normalize(native, nativeHome)).toEqual(normalize(forwarded, forwardHome));
        return native;
      } finally {
        rmSync(nativeHome, { recursive: true, force: true });
        rmSync(forwardHome, { recursive: true, force: true });
      }
    })();
    expect(restore[0]?.result).toMatchObject({ task_id: task.id, state: "done" });
    expect(restore[0]?.result?.archived).toBeUndefined();
  } finally {
    rmSync(archived, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(!front)("task.list SQL history filters preserve native parity on 1000 tasks", async () => {
  const ctx = fakeCtx();
  const tasks = Array.from({ length: 1000 }, (_, n) => {
    const t = createTask({ ...ctx, now: ctx.now - 2000 + n }, {
      brief: { goal: `history ${n}`, repo: ctx.home }, kind: null, requestedExecutor: "codex", timeoutS: 60,
      repo: { key: n % 2 ? "repo-a" : "repo-b", path: ctx.home, label: "repo" },
    });
    updateTask(ctx, t.id, row => {
      if (n % 11 === 0) delete row.repo;
      row.state = n % 5 === 0 ? "running" : "done";
      if (n % 5 === 0) row.question = { text: "help", at: ctx.now };
      if (n % 3 === 0) row.executor = "claude-code";
    });
    return t;
  }).sort((a, b) => b.id.localeCompare(a.id));
  writeFileSync(join(ctx.pacerHome, "state/repos.json"), JSON.stringify({ [ctx.home]: { key: "repo-legacy", path: ctx.home, lastUsed: ctx.now } }));
  const cases = [
    { limit: 2, repo: "repo-legacy" },
    { limit: 2 }, { limit: 10, repo: "repo-a" }, { limit: 3, executor: "codex" },
    { limit: 4, states: ["needs_input"] }, { limit: 4, states: ["running"] },
    { limit: 5, before: tasks[400]!.id },
    { limit: 3, before: tasks[300]!.id, repo: "repo-a", executor: "codex", states: ["done"] },
    { limit: 2, since: ctx.now - 1500 }, { repo: "missing" }, { states: [] },
    {}, { all: true }, { all: true, before: tasks[400]!.id },
    { limit: 20, before: tasks[19]!.id }, { since: ctx.now + 1 },
  ];
  const requests = cases.map((params, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "task.list", params }));
  const native = await exchange(ctx.home, requests, false, "task.list");
  expect(native).toEqual(await exchange(ctx.home, requests, true, "task.list"));
  expect(native[0]?.result?.tasks).toHaveLength(2);
  expect(native[1]?.result?.next).toBe(tasks[1]!.id);
  expect(native[11]?.result?.tasks.map((task: { id: string }) => task.id)).toEqual(tasks.slice(0, 20).map(task => task.id));
  expect(native[11]?.result?.next).toBe(tasks[19]!.id);
  expect(native[14]?.result?.tasks.map((task: { id: string }) => task.id)).toEqual(tasks.slice(20, 40).map(task => task.id));
  expect(native[15]?.result?.tasks).toEqual([]);
}, 120000);

test.skipIf(!front)("task.list selective and empty filters preserve native/forwarded parity", async () => {
  const ctx = fakeCtx();
  const root = join(ctx.home, "repo"), alias = join(ctx.home, "worktree");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(alias, "sub"), { recursive: true });
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "state/repos.json"), JSON.stringify({ [root]: { path: root, key: "registered", lastUsed: ctx.now } }));
  writeFileSync(join(ctx.pacerHome, "state/repo-paths.json"), JSON.stringify({ [alias]: root }));
  const ids: string[] = [];
  for (let i = 0; i < 16; i++) {
    const task = createTask({ ...ctx, now: ctx.now + i }, {
      brief: { goal: `list parity ${i}`, repo: join(i % 2 ? root : alias, "sub") },
      kind: null, requestedExecutor: "requested", timeoutS: 60,
    });
    ids.push(task.id);
    updateTask(ctx, task.id, t => {
      t.state = i % 2 ? "running" : "done";
      if (i % 3 === 0) t.question = { text: "question", at: ctx.now };
      if (i % 3 === 1) t.question = { text: "question", at: ctx.now, answer: "" };
      if (i % 4 === 0) t.executor = "assigned";
      if (i % 4 === 1) t.attempts = [{ executor: "attempt", startedAt: ctx.now, endedAt: ctx.now } as typeof t.attempts[number]];
      if (i % 4 === 2) { t.executor = "assigned"; t.result = { executor: "result" } as typeof t.result; }
      if (i % 5 === 0) t.repo = { key: "cached", path: root, label: "cached" };
    });
  }
  const cases: Record<string, unknown>[] = [];
  for (const repo of [undefined, "registered", "cached", "missing"])
    for (const states of [undefined, [], ["running"], ["needs_input"], ["done", "needs_input"]])
      for (const executor of [undefined, "result", "assigned", "attempt", "requested", "missing"])
        cases.push({ repo, states, executor, limit: 3, since: ctx.now + 2, before: ids[14] });
  cases.push({ since: ctx.now + 16 }, { since: ctx.now + 15 }, { before: ids[0] }, { executor: "" });
  // Keep each exchange below pipe backpressure limits on every supported platform.
  for (let offset = 0; offset < cases.length; offset += 20) {
    const batch = cases.slice(offset, offset + 20);
    const requests = batch.map((params, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "task.list", params }));
    const native = await exchange(ctx.home, requests, false, "task.list");
    const forwarded = await exchange(ctx.home, requests, true, "task.list");
    for (let i = 0; i < batch.length; i++) expect(native[i], JSON.stringify(batch[i])).toEqual(forwarded[i]);
  }
}, 60000);

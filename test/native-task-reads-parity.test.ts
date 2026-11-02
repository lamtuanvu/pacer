import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function exchange(home: string, requests: string[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: "activity.list,task.log" } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const markers = stderr.split("\n").filter(line => /^native (activity\.list|task\.log) \d+$/.test(line));
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

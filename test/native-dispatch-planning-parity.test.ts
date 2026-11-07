import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { dispatchDatabase } from "../src/dispatch/store";
import type { Ctx } from "../src/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "dispatch.models,dispatch.refresh,dispatch.enforcement.consent";

const rawLines = new WeakMap<object, string[]>();
/** `native` lists the request indexes the front door must answer itself; `null` means all of them. */
async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, native: number[] | null = null) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    const replies = lines.map(line => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(request => JSON.parse(request).method as string));
    const markers = stderr.split("\n").filter(line => {
      const match = /^native (\S+) \d+$/.exec(line);
      return match != null && ops.has(match[1]!);
    });
    const expected = forward ? [] : requests.map((request, index) => ({ request, index }))
      .filter(({ index }) => native === null || native.includes(index))
      .map(({ request, index }) => `native ${JSON.parse(request).method} ${index + 2}`);
    expect(markers).toEqual(expected);
    const result = replies.slice(1).sort((a, b) => a.id - b.id);
    rawLines.set(result, lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id));
    return result;
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
const wire = (replies: object) => rawLines.get(replies)!;
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

const STRATEGY = `planner: codex
accounts:
  codex: {kind: codex}
  claude: {kind: claude}
runners:
  codex: {models: [{id: gpt-5, tier: medium, strengths: [code, review]}, {id: o3, tools: true, context: 200000}]}
  claude-code#claude: {}
dispatch:
  discovery: {enabled: true, runners: [codex], models: [o9, gpt-5, late]}
`;

function seed(ctx: Ctx, strategy = STRATEGY) {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), strategy);
  const db = dispatchDatabase(ctx);
  const insert = db.query("INSERT INTO work_observations(id,at,data) VALUES(?,?,?)");
  const codex = { runner: "codex", account: "codex" };
  const exact = (id: string) => ({ ...codex, binding: { kind: "exact", id } });
  const rows: [number, unknown][] = [
    [100, { source: "plugin:a", scope: codex, method: "models", state: "known", observedAt: 100, expiresAt: 4e9,
      value: { models: [{ id: "gpt-5" }, { strengths: ["fast"], id: "o9", tier: "frontier", context: 1000 }, { id: "zz" }] } }],
    [50, { source: "status", scope: exact("gpt-5"), method: "capabilities", state: "known", observedAt: 50.5, expiresAt: 4e9, value: { tools: false, context: 128000 } }],
    [60, { expiresAt: 4e9, observedAt: 60, state: "known", method: "capabilities", scope: exact("gpt-5"), source: "status", value: { tools: true } }],
    [70, { source: "status", scope: { runner: "claude-code", account: "claude", binding: { kind: "executor-default" } }, method: "actual-model", state: "known", observedAt: 70, expiresAt: 4e9, value: { model: "sonnet" } }],
    [80, { source: "status", scope: exact("o9"), method: "capabilities", state: "known", observedAt: 80, expiresAt: 4e9, value: { context: 5 } }],
    [81, { source: "status", scope: exact("o3"), method: "capabilities", state: "known", observedAt: 81, expiresAt: 4e9 }],
    [90, { source: "old", scope: codex, method: "models", state: "known", observedAt: 1, expiresAt: 10, value: { models: [{ id: "expired" }] } }],
    [91, { source: "bad", scope: codex, method: "models", state: "known", observedAt: 1, expiresAt: 4e9, extra: 1 }],
    [92, "{not json"],
    [93, { source: "future", scope: codex, method: "models", state: "known", observedAt: 3.9e9, expiresAt: 4e9, value: { models: [{ id: "late" }] } }],
    [94, { source: "err", scope: codex, method: "models", state: "error", observedAt: 2, expiresAt: 4e9, value: { models: [{ id: "o9" }] } }],
    [95, { source: "usage", scope: codex, method: "usage", state: "known", observedAt: 3, expiresAt: 4e9,
      value: { windows: [{ pool: "5h", usedPct: 12.5, hoursLeft: 0.25 }], cost: 0, healthy: true, unmetered: false } }],
    [96, { source: "bad", scope: codex, method: "capabilities", state: "known", observedAt: 1, expiresAt: 4e9, value: { context: 1.5 } }],
    [97, { source: "bad", scope: { ...codex, binding: { kind: "exact" } }, method: "capabilities", state: "known", observedAt: 1, expiresAt: 4e9 }],
  ];
  rows.forEach(([at, data], i) => insert.run(`o${i}`, at, typeof data === "string" ? data : JSON.stringify(data)));
  db.query("INSERT INTO work_refresh(scope,attempted,retry_at,failures) VALUES('all',1,3999999999.25,2),('codex',1,1,0)").run();
}

test.skipIf(!front)("dispatch.models and dispatch.refresh match forced forwarding byte for byte", async () => {
  const ctx = fakeCtx();
  seed(ctx);
  const cases: [string, unknown][] = [
    ["dispatch.models", {}], ["dispatch.models", undefined], ["dispatch.models", { extra: 1 }], ["dispatch.models", null], ["dispatch.models", [1]],
    ["dispatch.refresh", {}], ["dispatch.refresh", { force: false }], ["dispatch.refresh", { runner: "nope" }],
    ["dispatch.refresh", { runner: "" }], ["dispatch.refresh", { runner: 5, force: "yes" }], ["dispatch.refresh", { runner: "x".repeat(129) }],
    ["dispatch.refresh", { runner: null }], ["dispatch.refresh", "text"],
  ];
  const requests = cases.map(([op, params], index) => request(index + 2, op, params));
  const native = await exchange(ctx.home, requests, false);
  const forwarded = await exchange(ctx.home, requests, true);
  expect(native).toEqual(forwarded);
  expect(wire(native)).toEqual(wire(forwarded));
  const models = native[0].result;
  expect(models.models.map((m: { binding: { id?: string } }) => m.binding.id ?? "default")).toEqual(["gpt-5", "o3", "default", "o9"]);
  expect(models.models[0].provenance).toBe("mixed");
  expect(models.models[2].actualModel).toBe("sonnet");
  expect(models.observedAt).toBe(3.9e9);
  expect(native[5].result).toEqual({ state: "backoff", retryAt: 3999999999.25, observations: 0 });
  expect(native[7].error.data.code).toBe("invalid_input");
}, 60000);

test.skipIf(!front)("caller identities, a missing strategy and a due refresh follow the TypeScript route", async () => {
  const ctx = fakeCtx();
  seed(ctx);
  const requests = [request(2, "dispatch.models", {}), request(3, "dispatch.refresh", {}), request(4, "dispatch.enforcement.consent", { account: "a", granted: true })];
  for (const env of [{ PACER_ROLE: "executor" }, { PACER_ENFORCEMENT_TOKEN: "pet_x" }] as Record<string, string>[]) {
    const native = await exchange(ctx.home, requests, false, env);
    expect(wire(native)).toEqual(wire(await exchange(ctx.home, requests, true, env)));
    expect(native.every(reply => reply.error?.data?.code === "not_allowed")).toBe(true);
  }
  const empty = fakeCtx();
  const missing = [request(2, "dispatch.models", {})];
  expect(wire(await exchange(empty.home, missing, false))).toEqual(wire(await exchange(empty.home, missing, true)));
  const endpoint = fakeCtx();
  const connection = (models: string) => `{api: openai-compatible, base_url: "http://127.0.0.1:9", key: none, models: [${models}]}`;
  seed(endpoint, `planner: codex
accounts:
  codex: {kind: codex}
  ep: {kind: endpoint, connection: ${connection("{id: m1, context: 8192, output: 512, tools: true}, {id: m2, context: 4096, output: 512, tools: false}")}}
  ep3: {kind: endpoint, connection: ${connection("{id: m3, context: 2048, output: 256, tools: true}")}}
runners:
  codex: {}
  opencode#ep: {models: [{id: pacer-ep/m2, tier: small}, {id: pacer-ep/m1, tools: false}]}
  opencode#ep3: {}
`);
  const models = await exchange(endpoint.home, missing, false);
  expect(wire(models)).toEqual(wire(await exchange(endpoint.home, missing, true)));
  expect(models[0].result.models.map((m: { tools?: boolean; context?: number }) => [m.tools, m.context])).toEqual([[undefined, undefined], [false, 4096], [false, 8192], [true, 2048]]);
  // A due refresh reads status and observation plugins, so it stays with TypeScript; the backoff answer is native.
  const due = [request(2, "dispatch.refresh", { runner: "codex" }), request(3, "dispatch.refresh", { force: true }), request(4, "dispatch.refresh", {})];
  const routed = await exchange(ctx.home, due, false, {}, [2]);
  expect(routed[0].result.state).not.toBe("backoff");
  expect(routed[2].result.state).toBe("backoff");
}, 60000);

const SCHEDULE = '{"x":1,"attempts":{"k":{"failures":2,"nextEligibleAt":1793041848.698,"lastCostPct":1.0,"big":12345678901234567890,"tiny":1e-7,"huge":1e21,"note":"é\\u0001\\u2028"}},"consent":{"b":"declined","7":"granted","a":"declined"}}';

test.skipIf(!front)("dispatch.enforcement.consent writes the same schedule as TypeScript", async () => {
  const homes = [fakeCtx(), fakeCtx()].map(ctx => {
    mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
    writeFileSync(join(ctx.pacerHome, "state", "certification-schedule.json"), SCHEDULE);
    return ctx.pacerHome;
  });
  const requests = [
    request(2, "dispatch.enforcement.consent", { account: "a", granted: true }),
    request(3, "dispatch.enforcement.consent", { account: "c-1", granted: false, extra: 1 }),
    request(4, "dispatch.enforcement.consent", { account: "__proto__", granted: true }),
    request(5, "dispatch.enforcement.consent", { account: "12", granted: true }),
    request(6, "dispatch.enforcement.consent", { account: "", granted: "yes" }),
    request(7, "dispatch.enforcement.consent", { account: "x".repeat(129) }),
    request(8, "dispatch.enforcement.consent", null),
  ];
  const native = await exchange(join(homes[0]!, ".."), requests, false);
  const forwarded = await exchange(join(homes[1]!, ".."), requests, true);
  expect(wire(native)).toEqual(wire(forwarded));
  const schedule = (home: string) => readFileSync(join(home, "state", "certification-schedule.json"), "utf8");
  expect(schedule(homes[0]!)).toBe(schedule(homes[1]!));
  expect(JSON.parse(schedule(homes[0]!)).consent.a).toBe("granted");

  // Shapes the object spread would coerce, and text serde rejects, stay with TypeScript.
  for (const text of ['{"consent":"ab"}', '{"consent":{"a":"granted"},"attempts":{"n":1e400}}', '{"s":"\\ud800"}']) {
    for (const home of homes) writeFileSync(join(home, "state", "certification-schedule.json"), text);
    const one = [request(2, "dispatch.enforcement.consent", { account: "z", granted: true })];
    expect(wire(await exchange(join(homes[0]!, ".."), one, false, {}, []))).toEqual(wire(await exchange(join(homes[1]!, ".."), one, true)));
    expect(schedule(homes[0]!)).toBe(schedule(homes[1]!));
  }
  // Text both runtimes reject reads as an empty schedule.
  for (const text of ["[1,2]", "null", "{broken"]) {
    for (const home of homes) writeFileSync(join(home, "state", "certification-schedule.json"), text);
    const one = [request(2, "dispatch.enforcement.consent", { account: "z", granted: false })];
    const native = text === "{broken" ? [] : null;
    expect(wire(await exchange(join(homes[0]!, ".."), one, false, {}, native))).toEqual(wire(await exchange(join(homes[1]!, ".."), one, true)));
    expect(schedule(homes[0]!)).toBe(schedule(homes[1]!));
  }
}, 60000);

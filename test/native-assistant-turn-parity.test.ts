import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantTurnBridge } from "../src/api/assistant-turn-bridge";
import { toApiError } from "../src/api/errors";
import { callOp } from "../src/api/ops";
import { runStdio } from "../src/api/stdio";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
import { front, makeHome, type Home, type Reply, serve, stdio, tsOwner } from "./native-plugin-door";

// Native `assistant.ask` and `assistant.cancel`: Rust answers the caller policy and the params with
// TypeScript's bytes, then the sealed `assistant-turn` bridge runs the turn in Core, beside the live-turn
// map and the answer stream. The front door is compared with forced forwarding over stdio and HTTP.

const NOW = 1_700_000_000;
const KEY = "fixture-private-key";
const TOKEN = "a".repeat(64);
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "native-at-")); dirs.push(dir); return dir; };

let binary: string;
const cargoEnv = () => ({ ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(tmpdir(), "pacer-native-as") });
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { env: cargoEnv() });
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], { env: cargoEnv() }).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
const native = (op: string, params: unknown, env: Record<string, string> = {}) =>
  JSON.parse(execFileSync(driver(), [], { input: `${JSON.stringify({ op, params, home: fresh(), now: NOW, env })}\n` }).toString());

const scope = { kind: "dispatch" };
const ask = (extra: object) => ({ text: "hi", scope, requestId: "r", ...extra });
const emoji = "\u{1F600}";
const ASK_REFUSALS: unknown[] = [
  null, {}, [], "x", 1,
  { text: "", scope, requestId: "" },
  { conversationId: 1, text: 1, scope: 1, requestId: 1 },
  { conversationId: "", text: "a".repeat(4001), scope: null, requestId: "r".repeat(129) },
  ask({ conversationId: null }),
  ask({ text: emoji.repeat(4001) }), ask({ requestId: emoji.repeat(129) }),
  ...[{}, { kind: "nope" }, { kind: 1 }, [], "dispatch", true].map(s => ask({ scope: s })),
  ...[0, 91, 1.5, "x", null, 1e300, -1e300, 9007199254740992].map(days => ask({ scope: { kind: "dispatch", days } })),
  ...[undefined, "", "i".repeat(129), 1].map(id => ask({ scope: { kind: "task", id } })),
  ...[undefined, "", "i".repeat(4097), null].map(repo => ask({ scope: { kind: "repo", repo } })),
];
const CANCEL_REFUSALS: unknown[] = [null, {}, [], { turnId: "" }, { turnId: 1 }, { turnId: emoji.repeat(129) }];
const REFUSALS: [string, unknown][] = [...ASK_REFUSALS.map(p => ["assistant.ask", p] as [string, unknown]), ...CANCEL_REFUSALS.map(p => ["assistant.cancel", p] as [string, unknown])];

async function reference(op: string, params: unknown, env: Record<string, string> = {}) {
  const home = fresh();
  try { return { result: await callOp(fakeCtx({ pacerHome: home, home, now: NOW, env }), op, params) }; }
  catch (error) { return { error: toApiError(error) }; }
}

test("native ask and cancel refuse params with TypeScript's issue text and order", async () => {
  for (const [op, params] of REFUSALS) {
    const expected = await reference(op, params);
    expect(expected.error?.code, JSON.stringify(params)).toBe("invalid_input");
    expect(JSON.stringify(native(op, params)), `${op} ${JSON.stringify(params)}`).toBe(JSON.stringify(expected));
  }
}, 600_000);

test("the caller policy comes before the params and work grants stay with the core", async () => {
  for (const op of ["assistant.ask", "assistant.cancel"]) {
    const environments: Record<string, string>[] = [{ PACER_ROLE: "executor" }, { PACER_ENFORCEMENT_TOKEN: "x", PACER_ROLE: "executor" }];
    for (const env of environments) {
      const expected = await reference(op, [], env);
      expect(expected.error?.code).toBe("not_allowed");
      expect(JSON.stringify(native(op, [], env))).toBe(JSON.stringify(expected));
    }
    expect(native(op, {}, { PACER_WORK_GRANT: "pwg_x" })).toEqual({ forwarded: true });
  }
}, 120_000);

test("valid params need a door's Core channel", () => {
  for (const [op, params] of [
    ["assistant.ask", ask({ conversationId: "c", text: emoji.repeat(4000), requestId: emoji.repeat(128), extra: 1 })],
    ["assistant.ask", ask({ scope: { kind: "dispatch", days: 90.0, extra: 1 } })],
    ["assistant.ask", ask({ scope: { kind: "task", id: "t" } })],
    ["assistant.ask", ask({ scope: { kind: "repo", repo: "/r" } })],
    ["assistant.cancel", { turnId: emoji.repeat(128), extra: 1 }],
  ] as [string, unknown][]) {
    expect(native(op, params), JSON.stringify(params)).toMatchObject({ error: { code: "unavailable", message: "assistant turn bridge unavailable" } });
  }
}, 120_000);

test("the bridge runs only the two turn operations, with Core's own answers", async () => {
  const home = fresh(), ctx = fakeCtx({ pacerHome: home, home, now: NOW, env: {} });
  for (const request of [undefined, null, [], "x", {}, { op: "assistant.delete", params: {} }, { op: "assistant.tool", params: {} }, { op: "task.get", params: { id: "x" } }])
    await expect(assistantTurnBridge(ctx, request), JSON.stringify(request)).rejects.toMatchObject({ code: "invalid_input" });
  expect(await assistantTurnBridge(ctx, { op: "assistant.cancel", params: { turnId: "missing" } })).toEqual({ cancelled: false });
  await expect(assistantTurnBridge(ctx, { op: "assistant.ask", params: ask({}) })).rejects.toMatchObject({
    code: "not_allowed", message: "The assistant is not set up.", hint: "Choose an account in Settings › Assistant.",
  });
  const executor = { ...ctx, env: { PACER_ROLE: "executor" } };
  await expect(assistantTurnBridge(executor, { op: "assistant.cancel", params: { turnId: "t" } })).rejects.toMatchObject({ code: "not_allowed" });
});

test("the stdio bridge needs the synchronization key and refuses a work-grant caller", async () => {
  const home = fresh(), ctx = fakeCtx({ pacerHome: home, home, now: NOW, env: {} });
  const request = { op: "assistant.cancel", params: { turnId: "missing" } };
  const exchange = async (caller: typeof ctx, params: unknown, key: string | null = KEY) => {
    async function* input() { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.assistant.turn", params }); }
    const out: any[] = [];
    await runStdio(caller, input(), line => out.push(JSON.parse(line)), { nativeConfigKey: key ?? undefined });
    return out;
  };
  const granted = { ...ctx, env: { PACER_WORK_GRANT: "pwg_x" } };
  for (const out of [await exchange(ctx, { key: "incorrect", request }), await exchange(ctx, { request }), await exchange(ctx, { key: KEY, request }, null), await exchange(granted, { key: KEY, request })]) {
    expect(out).toMatchObject([{ id: 1, error: { code: -32601, data: { code: "unknown_op" } } }]);
    expect(JSON.stringify(out)).not.toContain(KEY);
  }
  expect(await exchange(ctx, { key: KEY, request })).toMatchObject([{ id: 1, result: { cancelled: false } }]);
});

test("the HTTP bridge needs the service bearer and caps the body", async () => {
  const home = fresh(), ctx = fakeCtx({ pacerHome: home, home, now: NOW, env: {} });
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
  try {
    const post = (body: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => fetch(`http://127.0.0.1:${s.port}/_internal/assistant-turn`, {
      method: "POST", headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json", ...headers }, body,
    });
    const request = JSON.stringify({ request: { op: "assistant.cancel", params: { turnId: "missing" } } });
    expect((await post(request, {})).status).toBe(401);
    expect((await post(request, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(await (await post(request)).json()).toEqual({ result: { cancelled: false } });
    expect(await (await post("{")).json()).toMatchObject({ error: { code: "invalid_input" } });
    expect(await (await post(JSON.stringify({ pad: "x".repeat(256 * 1024) }))).json()).toMatchObject({ error: { code: "too_large" } });
  } finally { s.stop(); }
});

// ---- Through the front door ---------------------------------------------------------------------

/** An OpenAI-compatible endpoint holding chat completions until released. */
function endpoint() {
  let arrived!: () => void, release!: () => void;
  const inFlight = new Promise<void>(resolve => { arrived = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [{ id: "m1" }] });
    arrived();
    await released;
    return Response.json({ choices: [{ message: { content: "Fixture answer." } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  } });
  return { server, inFlight, release };
}

function configured(h: Home, port: number) {
  writeFileSync(join(h.state, "strategy.yaml"), `planner: claude-code
accounts:
  claude-code: {kind: claude}
  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:${port}/v1", key: none, models: [{id: m1, context: 100000, output: 1000, tools: false}]}}
runners:
  claude-code: {}
  opencode#ep: {model: m1}
`, { mode: 0o600 });
}

type Call = (op: string, params: unknown) => Promise<Reply>;
const RUNNING = { text: "What is running?", scope: { kind: "dispatch", days: 7 } };

async function settled(call: Call, turnId: string) {
  for (const deadline = Date.now() + 30_000; ;) {
    const turn = await call("assistant.turn", { turnId });
    if (turn.json.result?.state !== "running" || Date.now() > deadline) return turn.json.result;
    await Bun.sleep(50);
  }
}

/** Refusals and idle answers, on a home where the assistant is not set up. */
async function idle(call: Call) {
  const out: string[] = [];
  for (const [op, params] of [...REFUSALS.slice(0, 12), ...REFUSALS.slice(-3), ["assistant.ask", ask({})], ["assistant.cancel", { turnId: "missing" }]] as [string, unknown][])
    out.push((await call(op, params)).text);
  return out;
}

test.skipIf(!front)("stdio and HTTP answer idle requests like forced forwarding", async () => {
  const FORWARD = "assistant.ask,assistant.cancel";
  const [nativeHome, forwardHome, nativeHttp, forwardHttp] = [makeHome(), makeHome(), makeHome(), makeHome()];
  try {
    const native = await stdio(nativeHome), forced = await stdio(forwardHome, FORWARD);
    const replies = await idle((op, params) => native.call(op, params)), expected = await idle((op, params) => forced.call(op, params));
    expect(replies).toEqual(expected);
    const [nativeLog, forcedLog] = [await native.stop(), await forced.stop()];
    expect(nativeLog).toContain("native assistant.ask");
    expect(nativeLog).toContain("native assistant.cancel");
    expect(forcedLog).not.toContain("native assistant.");
    const door = await serve(nativeHttp), forcedDoor = await serve(forwardHttp, FORWARD);
    expect(await idle(door.call)).toEqual(await idle(forcedDoor.call));
    const [doorLog, forcedDoorLog] = [await door.stop(), await forcedDoor.stop()];
    expect(doorLog).toContain("native assistant.ask");
    expect(forcedDoorLog).not.toContain("native assistant.");
  } finally { for (const h of [nativeHome, forwardHome, nativeHttp, forwardHttp]) h.done(); }
}, 180_000);

test.skipIf(!front)("over HTTP a native ask streams its answer and a native cancel stops the live turn", async () => {
  const h = makeHome(), chat = endpoint();
  configured(h, chat.server.port!);
  const door = await serve(h, "", tsOwner);
  try {
    expect((await door.call("assistant.settings.set", { runner: "opencode#ep", account: "ep", expect_rev: 1 })).json.error).toBeUndefined();
    const first = await door.call("assistant.ask", { ...RUNNING, requestId: "http-1" });
    const turnId = first.json.result?.turnId;
    expect(turnId, first.line).toBeString();
    // The same requestId is the same turn; another question waits for it.
    expect((await door.call("assistant.ask", { ...RUNNING, requestId: "http-1" })).json.result).toEqual(first.json.result);
    expect((await door.call("assistant.ask", { ...RUNNING, requestId: "http-2" })).json.error).toMatchObject({ code: "conflict", message: "The assistant is still answering. Wait for it, or cancel the answer." });
    await Promise.race([chat.inFlight, Bun.sleep(30_000)]);
    expect((await door.call("assistant.cancel", { turnId })).json).toEqual({ result: { cancelled: true } });
    expect((await door.call("assistant.cancel", { turnId })).json).toEqual({ result: { cancelled: false } });
    expect(await settled(door.call, turnId)).toMatchObject({ state: "cancelled" });

    chat.release();
    const next = await door.call("assistant.ask", { ...RUNNING, requestId: "http-3" });
    const nextId = next.json.result?.turnId;
    expect(nextId, next.line).toBeString();
    const token = await Bun.file(join(h.state, "token")).text();
    const stream = await fetch(`http://127.0.0.1:${door.port}/v3/assistant/turns/${nextId}/stream`, { headers: { authorization: `Bearer ${token.trim()}` }, signal: AbortSignal.timeout(30_000) });
    const frames = await stream.text();
    expect(frames).toContain("Fixture answer.");
    expect(frames).toContain('"state":"done"');
    expect(await settled(door.call, nextId)).toMatchObject({ state: "done", answer: "Fixture answer." });
    expect(await door.stop()).toContain("native assistant.cancel");
  } finally { await door.stop(); chat.server.stop(true); h.done(); }
}, 180_000);

test.skipIf(!front)("over stdio a native ask and cancel reach the turn in that connection's Core", async () => {
  const h = makeHome(), chat = endpoint();
  configured(h, chat.server.port!);
  const door = await stdio(h, "", tsOwner);
  const call: Call = (op, params) => door.call(op, params);
  try {
    expect((await call("assistant.settings.set", { runner: "opencode#ep", account: "ep", expect_rev: 1 })).json.error).toBeUndefined();
    const first = await call("assistant.ask", { ...RUNNING, requestId: "stdio-1" });
    const turnId = first.json.result?.turnId;
    expect(turnId, first.line).toBeString();
    await Promise.race([chat.inFlight, Bun.sleep(30_000)]);
    expect((await call("assistant.cancel", { turnId })).json.result).toEqual({ cancelled: true });
    expect(await settled(call, turnId)).toMatchObject({ state: "cancelled" });
    chat.release();
    const log = await door.stop();
    expect(log).toContain("native assistant.ask");
    expect(log).toContain("native assistant.cancel");
  } finally { chat.release(); chat.server.stop(true); h.done(); }
}, 180_000);

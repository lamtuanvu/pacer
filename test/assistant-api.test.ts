import { describe, expect, test } from "bun:test";
import { callOp } from "../src/api/ops";
import { handleV2 } from "../src/api/http";
import { helloBody } from "../src/api/protocol";
import { v2Hello } from "../src/api/v2-compat";
import { ask, cancel, refreshCard, type AssistantDeps } from "../src/assistant/service";
import { getTurn, readSettings, writeSettings } from "../src/assistant/store";
import { askCommand, equivalentCommand } from "../src/commands/ask";
import type { Strategy } from "../src/config/strategy";
import type { Status } from "../src/engine/status";
import { fakeCtx } from "./helpers";

const strategy = () => ({ planner: { agent: "claude-code", account: "claude" }, accounts: { ep: { kind: "endpoint", model: null, connection: { api: "openai-compatible", base_url: "http://x/v1", key: "none", models: [{ id: "m1" }] } } }, runners: {}, dispatch: { reservePct: 0 } }) as unknown as Strategy;
const status = async () => ({ mode: "normal", planner: "claude-code", accounts: [{ name: "ep", kind: "endpoint", verdict: "OK", usedPct: 1, pacePct: null, resetsAt: null, window: null, stale: false, capturedAt: null }] }) as unknown as Status;
const usage = { input: 10, output: 5, coverage: "measured" as const };
const ID = "t-20261028-101010-ab12";
function setup(over: AssistantDeps = {}) {
  const ctx = fakeCtx();
  writeSettings(ctx, { runner: null, account: "ep", expect_rev: readSettings(ctx).rev });
  let rev = 3;
  const deps: AssistantDeps = { strategy, status, keys: async () => [], read: async () => ({ tasks: [] }), cards: { task: (_c, id) => id === ID ? { rev, title: "ota: stale plan", state: "failed" } : null, managed: () => true }, respond: async () => ({ message: "ok", usage }), ...over };
  return { ctx, deps, bump: () => { rev++; } };
}
const settle = async (ctx: ReturnType<typeof fakeCtx>, id: string) => { for (let i = 0; i < 300; i++) { const t = getTurn(ctx, id); if (t && t.state !== "running") return t; await Bun.sleep(5); } throw new Error("unsettled"); };
const scope = { kind: "dispatch" as const, days: 7 };
const rid = () => `r-${crypto.randomUUID()}`;
const proposeRetry = (): AssistantDeps["respond"] => { let n = 0; return async () => n++ === 0 ? { message: "", toolCalls: [{ id: "c", name: "propose_action", arguments: { op: "dispatch.retry", params: { id: ID }, why: "w" } }], usage } : { message: "Suggested.", usage }; };

describe("limits", () => {
  test("the input cap holds before every call: old tool results are dropped first", async () => {
    const sizes: number[] = []; let round = 0;
    const { ctx, deps } = setup({ read: async () => ({ tasks: Array.from({ length: 200 }, (_, i) => ({ id: `t-${i}`, title: "x".repeat(80), state: "failed" })) }), respond: async (_c, p: any) => { sizes.push(JSON.stringify(p.messages).length); return round++ < 3 ? { message: "", toolCalls: [{ id: `c${round}`, name: "tasks_list", arguments: {} }], usage } : { message: "done", usage }; } });
    writeSettings(ctx, { runner: null, account: "ep", limits: { maxInputTokens: 2000 }, expect_rev: readSettings(ctx).rev });
    const t = await settle(ctx, (await ask(ctx, { text: "q", scope, requestId: rid() }, deps)).turnId);
    expect(t.answer).toBe("done");
    expect(Math.max(...sizes) / 4).toBeLessThanOrEqual(2000 + 50);
  });
  test("cancel ends the turn at once, even while the backend is still working", async () => {
    const { ctx, deps } = setup({ respond: async () => { await Bun.sleep(400); return { message: "late", usage }; } });
    const s = await ask(ctx, { text: "q", scope, requestId: rid() }, deps);
    const t0 = Date.now();
    cancel(ctx, s.turnId);
    const t = await settle(ctx, s.turnId);
    expect(t.state).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(300);
    // The slot is free again.
    const next = await ask(ctx, { text: "q2", scope, requestId: rid() }, { ...deps, respond: async () => ({ message: "ok", usage }) });
    expect((await settle(ctx, next.turnId)).state).toBe("done");
  });
  test("cancel aborts the backend call so it stops spending", async () => {
    let aborted = false;
    const { ctx, deps } = setup({ respond: async (_c, _p, _d, signal) => { await new Promise<void>(resolve => signal?.addEventListener("abort", () => { aborted = true; resolve(); })); return { message: "never", usage }; } });
    const s = await ask(ctx, { text: "q", scope, requestId: rid() }, deps);
    await Bun.sleep(10);
    cancel(ctx, s.turnId);
    expect((await settle(ctx, s.turnId)).state).toBe("cancelled");
    expect(aborted).toBe(true);
  });
  test("concurrent asks cannot both run, and a repeated requestId returns the first turn", async () => {
    const { ctx, deps } = setup({ respond: async () => { await Bun.sleep(30); return { message: "ok", usage }; } });
    const id = rid();
    const [a, b] = await Promise.all([ask(ctx, { text: "q", scope, requestId: id }, deps), ask(ctx, { text: "q", scope, requestId: id }, deps)]);
    expect(b).toEqual(a);
    const results = await Promise.allSettled([ask(ctx, { text: "x", scope, requestId: rid() }, deps), ask(ctx, { text: "y", scope, requestId: rid() }, deps)]);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(2); // the first turn still holds the slot
    await settle(ctx, a.turnId);
  });
  test("the stored question is redacted", async () => {
    const { ctx, deps } = setup({ keys: async () => ["super-secret-key-1"] });
    const s = await ask(ctx, { text: "is super-secret-key-1 safe?", scope, requestId: rid() }, deps);
    expect(getTurn(ctx, s.turnId)!.question).not.toContain("super-secret");
    await settle(ctx, s.turnId);
  });
});

describe("cards over the ops", () => {
  test("a plain task retry offers no feedback field it would drop", async () => {
    const { ctx, deps } = setup({ respond: proposeRetry(), cards: { task: () => ({ rev: 1, title: "t", state: "failed" }), managed: () => false } });
    const t = await settle(ctx, (await ask(ctx, { text: "retry it", scope, requestId: rid() }, deps)).turnId);
    expect(t.cards[0]).toMatchObject({ op: "task.retry", editable: [] });
  });
  test("recording a decision updates the card, and a stale card refreshes to the task's current revision", async () => {
    const { ctx, deps, bump } = setup({ respond: proposeRetry() });
    const t = await settle(ctx, (await ask(ctx, { text: "retry it", scope, requestId: rid() }, deps)).turnId);
    const card = t.cards[0]!;
    expect(card.params.expect_rev).toBe(3);
    await callOp(ctx, "assistant.card.record", { turnId: t.id, cardId: card.id, state: "stale", result: "changed" });
    expect(getTurn(ctx, t.id)!.cards[0]).toMatchObject({ state: "stale", result: "changed" });
    bump();
    const fresh = refreshCard(ctx, t.id, card.id, deps);
    expect(fresh).toMatchObject({ state: "pending", params: { id: ID, expect_rev: 4 } });
    await expect(callOp(ctx, "assistant.card.record", { turnId: t.id, cardId: "nope", state: "done" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("history and settings ops", () => {
  test("delete removes text but not usage, and settings need the current revision", async () => {
    const { ctx, deps } = setup();
    const s = await ask(ctx, { text: "q", scope, requestId: rid() }, deps);
    await settle(ctx, s.turnId);
    expect((await callOp(ctx, "assistant.conversations", {}) as any).conversations).toHaveLength(1);
    expect(await callOp(ctx, "assistant.delete", {})).toEqual({ deleted: 1 });
    expect((await callOp(ctx, "assistant.conversations", {}) as any).conversations).toHaveLength(0);
    expect(((await callOp(ctx, "assistant.status", {})) as any).today.turns).toBe(1);
    await expect(callOp(ctx, "assistant.delete", { id: "conv-none" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callOp(ctx, "assistant.settings.set", { account: null, runner: null, expect_rev: 99 })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("protocol surface", () => {
  test("v3 announces the assistant ops and event; v2 sees neither", () => {
    expect(helloBody().events).toContain("assistant");
    expect(helloBody().ops).toContain("assistant.ask");
    expect(v2Hello().ops.some(op => op.startsWith("assistant."))).toBe(false);
    expect(v2Hello().events).not.toContain("assistant");
  });
  test("the per-turn stream is v3 only, refuses executors, replays frames and reports an unknown turn", async () => {
    const { ctx, deps } = setup();
    const s = await ask(ctx, { text: "q", scope, requestId: rid() }, deps);
    await settle(ctx, s.turnId);
    const get = (path: string, c = ctx) => handleV2(new Request(`http://127.0.0.1${path}`), { getCtx: () => c });
    const ok = await get(`/v3/assistant/turns/${s.turnId}/stream`);
    expect(ok.headers.get("content-type")).toBe("text/event-stream");
    const body = await ok.text();
    expect(body).toContain('"delta":"ok"');
    expect(body).toContain('"done":{"state":"done"}');
    expect((await get(`/v2/assistant/turns/${s.turnId}/stream`)).status).toBe(404);
    expect((await get(`/v3/assistant/turns/${s.turnId}/stream`, { ...ctx, env: { PACER_ROLE: "executor" } })).status).toBe(403);
    expect(await (await get("/v3/assistant/turns/turn-unknown/stream")).text()).toContain("no longer streaming");
  });
});

describe("pacer ask", () => {
  test("prints the answer and sources, and prints proposals as commands without running anything", async () => {
    const { ctx, deps } = setup({ respond: proposeRetry() });
    // The command calls the ops directly, so give them the same injected service through the real settings.
    const asked = await ask(ctx, { text: "retry it", scope, requestId: rid() }, deps);
    const turn = await settle(ctx, asked.turnId);
    expect(equivalentCommand(turn.cards[0]!)).toBe(`pacer retry ${ID}`);
    expect(equivalentCommand({ ...turn.cards[0]!, op: "dispatch.answer", params: { id: ID, text: "it's fine" } })).toBe(`pacer answer ${ID} 'it'\\''s fine'`);
    expect(equivalentCommand({ ...turn.cards[0]!, op: "delegation.pause", params: { for: "2h" } })).toBe("pacer pause 2h");
  });
  test("rejects bad scopes and bad usage with exit code 2", async () => {
    const ctx = fakeCtx();
    expect((await askCommand(["q", "--scope", "nope"], ctx)).code).toBe(2);
    expect((await askCommand([], ctx)).code).toBe(2);
    expect((await askCommand(["a", "b"], ctx)).code).toBe(2);
    expect(await askCommand(["q", "--scope", "task:t-1"], ctx)).toMatchObject({ code: 2, err: "The assistant is not set up." });
  });
});

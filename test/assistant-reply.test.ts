import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED } from "../plugins/bundled";
import { createCallAuthority } from "../src/plugins/authority";
import { answerCapability, pluginLogPath } from "../src/plugins/host";
import { bundledPluginSpawn, pluginRegistry } from "../src/plugins/index";
import type { BundledPlugin } from "../src/plugins/types";
import {
  ASSISTANT_BACKENDS, ASSISTANT_MAX_DEADLINE_MS, CAPABILITIES, CAPABILITY_METHODS, EXTENSION_METHODS,
  NOTIFICATIONS, PLUGIN_PROTOCOL_VERSION, assistantReplyParams, assistantReplyResult, capabilityOf, manifestSchema,
} from "../src/plugins/protocol";
import { admit, ask, cancel, candidates, replyProvider, runAssistantTool, subscribeTurn, type AssistantDeps, type StreamFrame } from "../src/assistant/service";
import { DIGEST_MAX_CHARS, buildDigest } from "../src/assistant/digest";
import { createRedactor } from "../src/assistant/redact";
import { getTurn, readSettings, writeSettings } from "../src/assistant/store";
import { assistantTurnFor, openAssistantTurn, type AssistantToolState } from "../src/assistant/turn-tools";
import type { AssistantLimits, AssistantScope } from "../src/assistant/types";
import type { Strategy } from "../src/config/strategy";
import type { Status } from "../src/engine/status";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// Phase 1A of docs/specs/2026-11-17-assistant-backends-design.md: the turn-level plugin method,
// the tool capability that answers only under it, `assistant.delta`, routing, and `backend`.

const KEY = ["sk", "-reply-test-key"].join("");
const scope: AssistantScope = { kind: "dispatch", days: 7 };
const usage = { input: 12, output: 3, coverage: "measured" as const };

const strategy = () => ({
  planner: { agent: "claude-code", account: "claude" },
  accounts: { ep: { kind: "endpoint", model: null, connection: { api: "openai-compatible", base_url: "http://x/v1", key: "none", models: [{ id: "m1" }] } } },
  runners: {}, dispatch: { reservePct: 0 },
}) as unknown as Strategy;
const status = async () => ({
  mode: "normal", planner: "claude-code",
  accounts: [{ name: "ep", kind: "endpoint", verdict: "OK", usedPct: 10, pacePct: null, resetsAt: null, window: null, stale: false, capturedAt: null }],
}) as unknown as Status;
/** The read pipeline the digest and the tools share: a snapshot with counts, and one cached budget. */
const read = async (_ctx: Ctx, op: string) => op === "snapshot.get"
  ? { snapshot: { counts: { open: 3 }, attention: [{ id: "a1", title: "Needs you" }], mode: "normal", pause: null, planner: "claude-code" } }
  : { mode: "normal", planner: "claude-code", paused: null, accounts: [{ name: "ep", verdict: "OK", usedPct: 42, pacePct: 55, resetsAt: 1_795_000_000, window: "monthly", stale: false }] };

/** The test-only plugin that serves `assistant.reply` for the `pacer` backend. */
const fake: BundledPlugin = {
  manifest: manifestSchema.parse({
    id: "fx-reply", version: "1.0.0", publisher: "test", host: ">=1.11.0",
    contributes: { assistant: { backend: "pacer", reply: true } }, capabilities: [{ name: "assistant.tool" }],
  }),
  main: async () => ({ handlers: {} }),
};

async function finished(ctx: Ctx, turnId: string) {
  for (let i = 0; i < 800; i++) {
    const t = getTurn(ctx, turnId);
    if (t && t.state !== "running") return t;
    await Bun.sleep(10);
  }
  throw new Error("turn did not finish");
}
const req = () => `r-${crypto.randomUUID()}`;
/** Ask on the reply path: the host loop must never run, so a fallback is a loud failure. */
const noLoop: AssistantDeps["respond"] = async () => { throw new Error("the assistant.respond loop must not run"); };

function setup(o: { fake?: boolean; limits?: Partial<AssistantLimits>; respond?: AssistantDeps["respond"] } = {}) {
  const ctx = fakeCtx();
  if (o.fake !== false) pluginRegistry(ctx, {
    bundled: [...BUNDLED, fake],
    spawnBundled: (c, id) => id === "fx-reply"
      ? { argv: [process.execPath, join(import.meta.dir, "fixtures", "assistant-reply", "peer.ts")], cwd: c.home, env: {} }
      : bundledPluginSpawn(c, id),
  });
  writeSettings(ctx, { runner: null, account: "ep", expect_rev: readSettings(ctx).rev, ...(o.limits ? { limits: o.limits } : {}) });
  const deps: AssistantDeps = {
    strategy: () => strategy(), status, keys: async () => [KEY], read, cards: { task: () => null },
    respond: o.respond ?? noLoop,
  };
  return { ctx, deps };
}

describe("the turn-level plugin interface", () => {
  test("assistant.reply is strict, 1.11.0, and capped at the host's deadline ceiling", () => {
    expect(PLUGIN_PROTOCOL_VERSION).toBe("1.11.0");
    expect(EXTENSION_METHODS["assistant.reply"]!.deadlineMs).toBe(ASSISTANT_MAX_DEADLINE_MS);
    const valid = {
      conversationId: "c-1", turnId: "t-1", account: "ep", backend: "pacer", model: "m1",
      system: "You are the pacer assistant.", digest: "Scope: dispatch, last 7 days.",
      tools: [{ name: "snapshot", description: "d", parameters: { type: "object" } }],
      history: [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "hello" }],
      message: "what needs me?", limits: { maxInputTokens: 32_000, maxOutputTokens: 8_000, maxToolRounds: 6, deadlineMs: 120_000 },
    };
    expect(assistantReplyParams.safeParse(valid).success).toBe(true);
    expect(assistantReplyParams.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(assistantReplyParams.safeParse({ ...valid, backend: "local" }).success).toBe(false);
    expect(assistantReplyParams.safeParse({ ...valid, limits: { ...valid.limits, deadlineMs: 120_001 } }).success).toBe(false);
    expect(assistantReplyParams.safeParse({ ...valid, history: [{ role: "tool", content: "x" }] }).success).toBe(false);
    expect(ASSISTANT_BACKENDS).toEqual(["pacer", "executor"]);
    const result = { message: "three things", session: "s-1", usage };
    expect(assistantReplyResult.safeParse(result).success).toBe(true);
    expect(assistantReplyResult.safeParse({ ...result, usage: { ...usage, coverage: "exact" } }).success).toBe(false);
    expect(assistantReplyResult.safeParse({ ...result, extra: 1 }).success).toBe(false);
  });

  test("assistant.delta belongs to the assistant point, is strict, and ui.invalidate keeps its own point", () => {
    const delta = NOTIFICATIONS["assistant.delta"]!;
    expect(delta.point).toBe("assistant");
    expect(delta.params.safeParse({ turnId: "t-1", kind: "text", text: "hello" }).success).toBe(true);
    expect(delta.params.safeParse({ turnId: "t-1", kind: "activity", text: "Reading tasks…" }).success).toBe(true);
    expect(delta.params.safeParse({ turnId: "t-1", kind: "voice", text: "x" }).success).toBe(false);
    expect(delta.params.safeParse({ turnId: "t-1", kind: "text", text: "x", extra: 1 }).success).toBe(false);
    expect(delta.params.safeParse({ kind: "text", text: "x" }).success).toBe(false);
    expect(NOTIFICATIONS["ui.invalidate"]!.point).toBe("ui");
  });

  test("assistant.tool is a declared capability with a strict method", () => {
    expect(CAPABILITIES).toContain("assistant.tool");
    expect(capabilityOf("capability.assistant.tool")).toBe("assistant.tool");
    const def = CAPABILITY_METHODS["capability.assistant.tool"]!;
    expect(def.params.safeParse({ turnId: "t-1", name: "snapshot", params: {} }).success).toBe(true);
    expect(def.params.safeParse({ turnId: "t-1", name: "snapshot" }).success).toBe(false);
    expect(def.result.safeParse({ name: "snapshot", content: "<data/>", ok: true }).success).toBe(true);
    expect(def.result.safeParse({ name: "snapshot", content: "<data/>" }).success).toBe(false);
  });

  test("a manifest needs host >=1.11.0 for assistant.tool or contributes.assistant.reply", () => {
    const base = { id: "fx", version: "1.0.0", publisher: "p", host: "^1", capabilities: [] as { name: string }[] };
    expect(manifestSchema.safeParse({ ...base, capabilities: [{ name: "assistant.tool" }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, host: ">=1.11.0", capabilities: [{ name: "assistant.tool" }] }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, contributes: { assistant: { reply: true } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, host: ">=1.11.0", contributes: { assistant: { reply: true } } }).success).toBe(true);
    // An empty contribution (every existing assistant manifest) and a named backend stay valid anywhere.
    expect(manifestSchema.safeParse({ ...base, contributes: { assistant: {} } }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, contributes: { assistant: { backend: "executor" } } }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, contributes: { assistant: { reply: false } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, contributes: { assistant: { other: 1 } } }).success).toBe(false);
  });
});

describe("capability.assistant.tool authority", () => {
  const manifest = manifestSchema.parse({ id: "fx-tool", version: "1.0.0", publisher: "test", host: ">=1.11.0", contributes: { assistant: { reply: true } }, capabilities: [{ name: "assistant.tool" }] });
  const undeclared = manifestSchema.parse({ id: "fx-bare", version: "1.0.0", publisher: "test", host: ">=1.11.0", contributes: { assistant: { reply: true } }, capabilities: [] });
  const ctx = fakeCtx();
  const state = (max = 2): AssistantToolState => ({ cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max } });
  const turn = (turnId: string, rounds = 2) => ({ turnId, scope, read, redactor: createRedactor([KEY], ctx.home), cards: { task: () => null }, state: state(rounds) });
  const params = { turnId: "t-1", name: "snapshot", params: {} };
  const grant = () => createCallAuthority(ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 10_000, grants: ["assistant.tool"] });
  const call = (authority: ReturnType<typeof grant>, over: object = {}) =>
    answerCapability(ctx, { id: "fx-tool", manifest }, "capability.assistant.tool", { ...params, ...over }, authority) as Promise<{ name: string; content: string; ok: boolean }>;

  test("is refused with no owning call, and for a plugin that did not declare the capability", async () => {
    await expect(answerCapability(ctx, { id: "fx-tool", manifest }, "capability.assistant.tool", params)).rejects.toThrow(/scoped capability requires an active owning call/);
    await expect(call(grant())).rejects.toThrow(/no assistant reply call is in progress/);
    await expect(answerCapability(ctx, { id: "fx-bare", manifest: undeclared }, "capability.assistant.tool", params)).rejects.toThrow(/did not declare assistant.tool/);
  });

  test("runs only for its own turn, only while the reply call lives, and only within the round budget", async () => {
    const authority = grant();
    await expect(call(authority)).rejects.toThrow(/no assistant reply call is in progress/);
    const close = openAssistantTurn(authority, turn("t-1"));
    expect(assistantTurnFor(authority)?.turnId).toBe("t-1");
    const out = await call(authority);
    expect(out).toMatchObject({ name: "snapshot", ok: true });
    expect(out.content).toStartWith('<data tool="snapshot">');
    expect(out.content).toContain('"open":3');
    await expect(call(authority, { turnId: "t-2" })).rejects.toThrow(/names another turn/);
    // Budget of two rounds: the third call in the same turn is refused.
    await call(authority);
    await expect(call(authority)).rejects.toThrow(/tool-call budget/);
    // The reply call ended: its context is gone, and so is its authority.
    close();
    expect(assistantTurnFor(authority)).toBeNull();
    await expect(call(authority)).rejects.toThrow(/no assistant reply call is in progress/);
    await authority.revoke();
    await expect(call(authority)).rejects.toThrow(/owning plugin call expired/);
  });

  test("a capability call that names no owning call is refused before its params are read", async () => {
    await expect(answerCapability(ctx, { id: "fx-tool", manifest }, "capability.assistant.tool", 42)).rejects.toThrow(/scoped capability requires an active owning call/);
  });
});

describe("the shared tool function", () => {
  test("the assistant.respond loop feeds back exactly what runAssistantTool returns", async () => {
    const calls: any[] = [];
    let round = 0;
    const { ctx, deps } = setup({
      fake: false,
      respond: async (_c, params) => {
        calls.push(params);
        return round++ === 0
          ? { message: "", toolCalls: [{ id: "c1", name: "task_get", arguments: { id: "t-20261028-101010-ab12" } }], usage }
          : { message: "It failed.", usage };
      },
    });
    const redactor = createRedactor([KEY], ctx.home);
    const direct = await runAssistantTool(ctx, { id: "c1", name: "task_get", arguments: { id: "t-20261028-101010-ab12" } },
      { read, scope, redactor, cards: { task: () => null }, state: { cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max: 6 } } });
    expect(direct.content).toStartWith('<data tool="task_get">');
    const started = await ask(ctx, { text: "why did it fail?", scope, requestId: req() }, deps);
    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("done");
    expect(turn.answer).toBe("It failed.");
    // The loop and the capability end in the same function, so the message it feeds back is byte-identical.
    expect(calls[1].messages.at(-1)).toEqual({ role: "tool", toolCallId: "c1", content: direct.content });
  });

  test("propose_action becomes a card through the shared function, and the budget stops a late call", async () => {
    const ctx = fakeCtx();
    const redactor = createRedactor([KEY], ctx.home);
    const state: AssistantToolState = { cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max: 1 } };
    const cards = { task: (_c: Ctx, id: string) => (id === "t-1" ? { rev: 7, title: "Fix it", state: "failed" } : null) };
    const proposal = { op: "dispatch.retry", params: { id: "t-1" }, why: "It failed twice." };
    const first = await runAssistantTool(ctx, { id: "c1", name: "propose_action", arguments: proposal }, { read, scope, redactor, cards, state });
    expect(first).toEqual({ content: "The proposal is shown to the user as a card. It has not run.", ok: true });
    expect(state.cards).toHaveLength(1);
    expect(state.toolLog).toEqual([{ name: "propose_action", op: "dispatch.retry" }]);
    await expect(runAssistantTool(ctx, { id: "c2", name: "snapshot", arguments: {} }, { read, scope, redactor, cards, state }))
      .rejects.toThrow(/tool-call budget/);
    expect(state.rounds.used).toBe(1);
  });
});

describe("the host-built digest", () => {
  test("summarizes scope, counts and the chosen account's cached budget through the read pipeline", async () => {
    const ctx = fakeCtx();
    const redactor = createRedactor([KEY], ctx.home);
    const digest = await buildDigest(ctx, { read, scope, redactor, account: "ep" });
    expect(digest).toContain("Scope: dispatch, last 7 days.");
    expect(digest).toContain('"open":3');
    expect(digest).toContain("Budget: ep: verdict OK, used 42%, pace 55%, window monthly, resets 1795000000.");
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    const wide = await buildDigest(ctx, {
      read: async () => ({ snapshot: { counts: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, i])) } }),
      scope, redactor, account: "ep",
    });
    expect(wide.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(wide.endsWith("…")).toBe(true);
  });
});

describe("a turn answered by a plugin", () => {
  test("routes to the plugin that provides assistant.reply and runs its tool through the capability", async () => {
    const { ctx, deps } = setup({ respond: noLoop });
    expect(replyProvider(ctx, "pacer")).toBe("fx-reply");
    const started = await ask(ctx, { text: "tool", scope, requestId: req() }, deps);
    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("done");
    expect(turn.answer).toStartWith('<data tool="snapshot">');
    expect(turn.answer).toContain('"open":3');
    expect(turn.usage).toEqual(usage);
    expect(turn.answer).not.toContain(KEY);
  });

  test("forwards assistant.delta to the turn's stream although the plugin has no UI surface", async () => {
    const { ctx, deps } = setup({ respond: noLoop });
    expect(fake.manifest.contributes.ui).toBeUndefined();
    const started = await ask(ctx, { text: "tool", scope, requestId: req() }, deps);
    const frames: StreamFrame[] = [];
    expect(subscribeTurn(started.turnId, frame => frames.push(frame))).not.toBeNull();
    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("done");
    expect(frames).toContainEqual({ status: "Reading tasks…" });
    // The backend streamed, so its text is not replayed as one more delta; the stored answer is final.
    expect(frames.filter(frame => "delta" in frame)).toEqual([{ delta: "Streamed hello. " }]);
    expect(turn.answer).toStartWith('<data tool="snapshot">');
    expect(turn.answer).toContain('"open":3');
    expect(turn.answer).toEndWith("\n</data>");
    expect(frames.some(frame => "delta" in frame && frame.delta.includes("dropped"))).toBe(false);
    expect(frames.at(-1)).toEqual({ done: { state: "done" } });
  });

  test("caps tool rounds at the turn's maxToolRounds", async () => {
    const { ctx, deps } = setup({ respond: noLoop, limits: { maxToolRounds: 2 } });
    const started = await ask(ctx, { text: "rounds", scope, requestId: req() }, deps);
    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("done");
    expect(turn.answer).toStartWith("ran=2 ");
    expect(turn.answer).toContain("That turn has used its tool-call budget.");
  });

  test("refuses a tool call for another turn, and one after its reply call ended", async () => {
    const { ctx, deps } = setup({ respond: noLoop });
    const first = await ask(ctx, { text: "tool", scope, requestId: req() }, deps);
    const turnOne = await finished(ctx, first.turnId);
    expect(turnOne.state).toBe("done");
    const second = await ask(ctx, { text: `stale ${first.turnId}`, conversationId: first.conversationId, scope, requestId: req() }, deps);
    const turnTwo = await finished(ctx, second.turnId);
    expect(turnTwo.answer).toContain("that tool call names another turn");

    // A call made after the reply returned: the host dropped the token with the call, and the
    // turn context with it (the unit tests above exercise the context directly).
    const third = await ask(ctx, { text: "delayed", conversationId: first.conversationId, scope, requestId: req() }, deps);
    expect((await finished(ctx, third.turnId)).state).toBe("done");
    const log = pluginLogPath(ctx, "fx-reply");
    let written = "";
    for (let i = 0; i < 100 && !written.includes("delayed:"); i++) {
      await Bun.sleep(20);
      written = existsSync(log) ? readFileSync(log, "utf8") : "";
    }
    expect(written).toMatch(/delayed: (capability token has no active pending request|scoped capability requires an active owning call)/);
  });

  test("cancel aborts the reply and discards its answer", async () => {
    const { ctx, deps } = setup({ respond: noLoop });
    const started = await ask(ctx, { text: "slow", scope, requestId: req() }, deps);
    await Bun.sleep(200);
    expect(cancel(ctx, started.turnId)).toEqual({ cancelled: true });
    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("cancelled");
    expect(turn.answer).toBeNull();
    expect(cancel(ctx, started.turnId)).toEqual({ cancelled: false });
  });

  test("the deadline stops a backend that will not answer, with a plain error", async () => {
    const { ctx, deps } = setup({ respond: noLoop, limits: { deadlineMs: 1000 } });
    const started = await ask(ctx, { text: "slow", scope, requestId: req() }, deps);
    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("error");
    expect(turn.answer).toBeNull();
    expect(turn.error).not.toContain("late");
    expect(turn.error).not.toContain(KEY);
  });

  test("keeps today's assistant.respond loop when no plugin provides assistant.reply", async () => {
    const { ctx, deps } = setup({ fake: false });
    expect(replyProvider(ctx, "pacer")).toBeNull();
    const started = await ask(ctx, { text: "anything", scope, requestId: req() }, { ...deps, respond: async () => ({ message: "from the loop", usage }) });    const turn = await finished(ctx, started.turnId);
    expect(turn.state).toBe("done");
    expect(turn.answer).toBe("from the loop");
    expect(turn.usage).toEqual(usage);
  });
});

describe("backend choice", () => {
  test("admission refuses a stored executor backend that no plugin serves", async () => {
    const { ctx, deps } = setup({ respond: noLoop });
    expect((await admit(ctx, deps)).ok).toBe(true);
    writeSettings(ctx, { runner: null, account: "ep", backend: "executor", expect_rev: readSettings(ctx).rev });
    const refused = await admit(ctx, deps);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("No plugin answers the assistant's executor backend.");
    expect(refused.hint).toContain("Settings › Assistant");
    // The fake serves the pacer backend only, so it does not rescue a stored executor choice.
    expect(replyProvider(ctx, "executor")).toBeNull();
  });

  test("settings keep the stored backend when a save omits it, and read it back as pacer when absent", async () => {
    const { ctx } = setup({ respond: noLoop });
    writeSettings(ctx, { runner: null, account: "ep", backend: "executor", expect_rev: readSettings(ctx).rev });
    expect(readSettings(ctx).backend).toBe("executor");
    writeSettings(ctx, { runner: null, account: "ep", expect_rev: readSettings(ctx).rev });
    expect(readSettings(ctx).backend).toBe("executor");
    writeSettings(ctx, { runner: null, account: "ep", backend: "pacer", expect_rev: readSettings(ctx).rev });
    expect(readSettings(ctx).backend).toBe("pacer");
    // A row written before `backend` existed reads as pacer.
    const bare = fakeCtx();
    writeSettings(bare, { runner: null, account: "ep", expect_rev: readSettings(bare).rev });
    expect(readSettings(bare).backend).toBe("pacer");
  });

  test("candidates name the backend and say they are available", async () => {
    const { ctx, deps } = setup({ respond: noLoop });
    const rows = candidates(ctx, deps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account: "ep", backend: "pacer", available: true, isPlanner: false });
    expect(rows[0]).not.toHaveProperty("reason");
  });
});

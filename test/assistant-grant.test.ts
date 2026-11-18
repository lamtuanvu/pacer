import { describe, expect, test } from "bun:test";
import { BUNDLED } from "../plugins/bundled";
import { admit, ask, assistantGrantFor, cancel } from "../src/assistant/service";
import { getTurn, readSettings, writeSettings } from "../src/assistant/store";
import { createRedactor } from "../src/assistant/redact";
import { assistantTurnById, assistantTurnFor, openAssistantTurn, openAssistantTurnFor, type AssistantToolState, type AssistantToolTurn } from "../src/assistant/turn-tools";
import type { AssistantScope } from "../src/assistant/types";
import { authorizeWorkOperation } from "../src/core/work";
import { callOp } from "../src/api/ops";
import { answerCapability } from "../src/plugins/host";
import { createCallAuthority } from "../src/plugins/authority";
import { manifestSchema } from "../src/plugins/protocol";
import { bundledPluginSpawn, pluginRegistry } from "../src/plugins/index";
import type { BundledPlugin } from "../src/plugins/types";
import type { Status } from "../src/engine/status";
import type { Strategy } from "../src/config/strategy";
import { dispatchDatabase } from "../src/dispatch/store";
import {
  authorizeAssistantGrant, authorizeWorkGrant, issueAssistantGrant, issueWorkGrant, registerWork, revokeAssistantGrants,
} from "../src/dispatch/work";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// Phase 1B of docs/specs/2026-11-17-assistant-backends-design.md §2–§3: the per-turn `pag_`
// assistant grant, its own kind in the grant store, and the turn it dies with.

const NOW = 1_700_000_000;
const TURN = "turn-0123456789ab";
const CONVERSATION = "c-1";
const scope: AssistantScope = { kind: "dispatch", days: 7 };
const ctx = (now = NOW) => fakeCtx({ now });
const grantRow = (c: Ctx) =>
  dispatchDatabase(c).query<{ hash: string; task_id: string; conversation_id: string; expires: number; revoked: number; kind: string }, [string]>(
    "SELECT * FROM work_grants WHERE kind=?").get("assistant");
const assistantGrants = (c: Ctx) => dispatchDatabase(c).query<{ task_id: string; revoked: number }, []>("SELECT task_id,revoked FROM work_grants WHERE kind='assistant'").all();

describe("the assistant grant", () => {
  test("is a pag_ token, hashed at rest, bound to one turn of one conversation", () => {
    const c = ctx();
    const token = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 120 });
    expect(token).toMatch(/^pag_[0-9a-f]{64}$/);
    const row = grantRow(c)!;
    expect(row).toMatchObject({ task_id: TURN, conversation_id: CONVERSATION, expires: NOW + 120, revoked: 0, kind: "assistant" });
    // Only the hash is stored: the raw token appears nowhere in the store.
    expect(row.hash).not.toBe(token);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(dispatchDatabase(c).query("SELECT * FROM work_grants").all())).not.toContain(token);
    expect(authorizeAssistantGrant(c, token)).toEqual({ turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 120 });
  });

  test("refuses an unknown, expired or revoked token", () => {
    const c = ctx();
    const token = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 10 });
    // Live until its deadline, dead at it.
    expect(authorizeAssistantGrant({ ...c, now: NOW + 9 }, token).expiresAt).toBe(NOW + 10);
    expect(() => authorizeAssistantGrant({ ...c, now: NOW + 10 }, token)).toThrow(/Expired or revoked assistant grant/);
    expect(() => authorizeAssistantGrant(c, `pag_${"0".repeat(64)}`)).toThrow(/Expired or revoked assistant grant/);
    expect(() => authorizeAssistantGrant(c, `pag_${"g".repeat(64)}`)).toThrow(/Invalid assistant grant/);
    expect(() => authorizeAssistantGrant(c, `PAG_${"0".repeat(64)}`)).toThrow(/Invalid assistant grant/);
    expect(() => authorizeAssistantGrant(c, `pwg_${"0".repeat(64)}`)).toThrow(/Invalid assistant grant/);
    revokeAssistantGrants(c, TURN);
    expect(() => authorizeAssistantGrant(c, token)).toThrow(/Expired or revoked assistant grant/);
    // Revoking again after another issue for the same turn still leaves nothing live.
    const again = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 60 });
    expect(authorizeAssistantGrant(c, again).turnId).toBe(TURN);
    revokeAssistantGrants(c, TURN);
    expect(() => authorizeAssistantGrant(c, token)).toThrow(/Expired or revoked assistant grant/);
    expect(() => authorizeAssistantGrant(c, again)).toThrow(/Expired or revoked assistant grant/);
  });

  test("revokes only that turn's assistant grants, and the two kinds never answer for each other", () => {
    const c = ctx();
    const other = issueAssistantGrant(c, { turnId: "turn-other", conversationId: CONVERSATION, expiresAt: NOW + 60 });
    const mine = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 60 });
    const task = createTask(c, { brief: { goal: "g", repo: "/r" }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    registerWork(c, task.id, { allowDelegation: true });
    updateTask(c, task.id, t => { t.state = "running"; });
    const work = issueWorkGrant(c, task.id, 1);
    revokeAssistantGrants(c, TURN);
    expect(() => authorizeAssistantGrant(c, mine)).toThrow(/Expired or revoked/);
    expect(authorizeAssistantGrant(c, other).turnId).toBe("turn-other");
    expect(authorizeWorkGrant(c, work).taskId).toBe(task.id);
    expect(() => authorizeWorkGrant(c, mine)).toThrow(/Invalid work grant/);
    expect(() => authorizeAssistantGrant(c, work)).toThrow(/Invalid assistant grant/);
    // A row's kind, not just its prefix, decides which identity it can answer as.
    dispatchDatabase(c).query("UPDATE work_grants SET kind='assistant' WHERE task_id=?").run(task.id);
    expect(() => authorizeWorkGrant(c, work)).toThrow(/Expired or revoked work grant/);
    dispatchDatabase(c).query("UPDATE work_grants SET kind='work' WHERE task_id=?").run(TURN);
    expect(() => authorizeAssistantGrant(c, mine)).toThrow(/Expired or revoked assistant grant/);
  });

  test("refuses to issue a grant with no turn or no future deadline", () => {
    const c = ctx();
    expect(() => issueAssistantGrant(c, { turnId: "", conversationId: CONVERSATION, expiresAt: NOW + 1 })).toThrow(/one turn of one conversation/);
    expect(() => issueAssistantGrant(c, { turnId: TURN, conversationId: "", expiresAt: NOW + 1 })).toThrow(/one turn of one conversation/);
    expect(() => issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW })).toThrow(/must expire after now/);
    expect(() => issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW - 1 })).toThrow(/must expire after now/);
    expect(dispatchDatabase(c).query<{ n: number }, []>("SELECT count(*) AS n FROM work_grants").get()!.n).toBe(0);
  });
});

// Only the executor backend's CLI reaches the tools outside the plugin call, so only that turn's
// backend is handed a grant. The test plugin serves `assistant.reply` for it end to end.
const KEY = ["sk", "-grant-test-key"].join("");
const strategy = () => ({
  planner: { agent: "claude-code", account: "claude" },
  accounts: { ep: { kind: "endpoint", model: null, connection: { api: "openai-compatible", base_url: "http://x/v1", key: "none", models: [{ id: "m1" }] } } },
  runners: {}, dispatch: { reservePct: 0 },
}) as unknown as Strategy;
const status = async () => ({
  mode: "normal", planner: "claude-code",
  accounts: [{ name: "ep", kind: "endpoint", verdict: "OK", usedPct: 10, pacePct: null, resetsAt: null, window: null, stale: false, capturedAt: null }],
}) as unknown as Status;
const read = async (_c: Ctx, op: string) => op === "snapshot.get"
  ? { snapshot: { counts: { open: 3 }, attention: [], mode: "normal", pause: null, planner: "claude-code" } }
  : { mode: "normal", planner: "claude-code", paused: null, accounts: [] };

const fakeExecutor: BundledPlugin = {
  manifest: manifestSchema.parse({
    id: "fx-reply", version: "1.0.0", publisher: "test", host: ">=1.11.0",
    contributes: { assistant: { backend: "executor", reply: true } }, capabilities: [{ name: "assistant.tool" }],
  }),
  main: async () => ({ handlers: {} }),
};

function setup(backend: "pacer" | "executor", respond: unknown) {
  // No opencode here: the fake plugin answers itself, and the host's issued ask-mode pins resolve nothing.
  const base = fakeCtx(), c = { ...base, which: (name: string) => name === "opencode" ? null : base.which(name) } as typeof base;
  pluginRegistry(c, {
    bundled: backend === "executor" ? [...BUNDLED.filter(p => p.manifest.id !== "assistant-executor"), fakeExecutor] : BUNDLED.filter(p => p.manifest.id !== "assistant-executor"),
    spawnBundled: (home, id) => id === "fx-reply"
      ? { argv: [process.execPath, new URL("./fixtures/assistant-reply/peer.ts", import.meta.url).pathname], cwd: home.home, env: {} }
      : bundledPluginSpawn(home, id),
  });
  writeSettings(c, { runner: null, account: "ep", backend, expect_rev: readSettings(c).rev });
  const deps = {
    strategy: () => strategy(), status, keys: async () => [KEY], read, cards: { task: () => null },
    respond: respond as never,
      selfTest: () => ({ ok: true }),
  };
  return { ctx: c, deps };
}

async function finished(c: Ctx, turnId: string) {
  for (let i = 0; i < 3000; i++) {
    const turn = getTurn(c, turnId);
    if (turn && turn.state !== "running") return turn;
    await Bun.sleep(5);
  }
  throw new Error("turn did not finish");
}

describe("a turn's assistant grant", () => {
  test("is issued when an executor-backend turn starts and revoked when it ends", async () => {
    const { ctx: c, deps } = setup("executor", async () => { throw new Error("the executor backend answers with assistant.reply"); });
    expect((await admit(c, deps)).ok).toBe(true);
    const started = await ask(c, { text: "what needs me?", scope, requestId: `r-${crypto.randomUUID()}` }, deps);
    let token: string | null = null;
    for (let i = 0; i < 3000 && !token; i++) { token = assistantGrantFor(started.turnId); if (!token) await Bun.sleep(2); }
    expect(token).toMatch(/^pag_[0-9a-f]{64}$/);
    expect(authorizeAssistantGrant(c, token!)).toMatchObject({ turnId: started.turnId, conversationId: started.conversationId });
    expect(assistantTurnById(started.turnId)?.turnId).toBe(started.turnId);
    const turn = await finished(c, started.turnId);
    expect(turn.state).toBe("done");
    // The turn is over: the grant is revoked, and so is the tool context it could have reached.
    expect(assistantGrantFor(started.turnId)).toBeNull();
    expect(() => authorizeAssistantGrant(c, token!)).toThrow(/Expired or revoked assistant grant/);
    expect(assistantTurnById(started.turnId)).toBeNull();
    expect(assistantGrants(c).every(row => row.revoked === 1)).toBe(true);
  }, 30_000);

  test("is revoked the moment its turn is cancelled", async () => {
    const { ctx: c, deps } = setup("executor", async () => { throw new Error("the executor backend answers with assistant.reply"); });
    const started = await ask(c, { text: "slow", scope, requestId: `r-${crypto.randomUUID()}` }, deps);
    let token: string | null = null;
    for (let i = 0; i < 3000 && !token; i++) { token = assistantGrantFor(started.turnId); if (!token) await Bun.sleep(2); }
    expect(token).toMatch(/^pag_[0-9a-f]{64}$/);
    expect(cancel(c, started.turnId)).toEqual({ cancelled: true });
    expect(assistantGrantFor(started.turnId)).toBeNull();
    expect(() => authorizeAssistantGrant(c, token!)).toThrow(/Expired or revoked assistant grant/);
    expect(assistantGrants(c).every(row => row.revoked === 1)).toBe(true);
    expect((await finished(c, started.turnId)).state).toBe("cancelled");
  }, 30_000);

  test("is never issued for a turn the pacer backend answers", async () => {
    const { ctx: c, deps } = setup("pacer", async () => ({ message: "hello", usage: { input: 1, output: 1, coverage: "measured" as const } }));
    const started = await ask(c, { text: "hi", scope, requestId: `r-${crypto.randomUUID()}` }, deps);
    expect(await finished(c, started.turnId)).toMatchObject({ state: "done", answer: "hello" });
    expect(assistantGrantFor(started.turnId)).toBeNull();
    expect(assistantGrants(c)).toEqual([]);
    expect(assistantTurnById(started.turnId)).toBeNull();
  }, 30_000);
});

describe("the assistant-turn identity", () => {
  const withGrant = (c: Ctx, token: string) => ({ ...c, env: { ...c.env, PACER_ASSISTANT_GRANT: token } });

  test("runs assistant.tool for its own live turn and refuses every other operation", () => {
    const c = ctx();
    const token = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 60 });
    const granted = withGrant(c, token);
    expect(() => authorizeWorkOperation(granted, "assistant.tool", { turnId: TURN, name: "snapshot", params: {} })).not.toThrow();
    // The executor refusals in ops.ts and caller-policy.ts stay as they are; this identity is not
    // an executor session, so it reaches only what this branch allows.
    for (const op of ["assistant.status", "assistant.ask", "assistant.turn", "assistant.delete", "assistant.settings.set", "task.get", "task.delegate", "task.review", "snapshot.get", "msg.send", "dispatch.child", "plugin.enable", "files.search"]) {
      expect(() => authorizeWorkOperation(granted, op, { turnId: TURN }), op).toThrow(/assistant grant runs assistant\.tool only/);
    }
    // Another turn's id is another grant's business.
    expect(() => authorizeWorkOperation(granted, "assistant.tool", { turnId: "turn-another", name: "snapshot" })).toThrow(/belongs to another turn/);
    expect(() => authorizeWorkOperation(granted, "assistant.tool", { name: "snapshot" })).toThrow(/turnId is required/);
    expect(() => authorizeWorkOperation(granted, "assistant.tool", { turnId: 42 })).toThrow(/turnId is required/);
    expect(() => authorizeWorkOperation(granted, "assistant.tool", {})).toThrow(/turnId is required/);
  });

  test("fails closed: an unknown, expired or revoked grant is refused, never the operator", () => {
    const c = ctx();
    for (const token of [`pag_${"0".repeat(64)}`, "pag_forged", `pwg_${"0".repeat(64)}`]) {
      const refused = withGrant(c, token);
      for (const op of ["assistant.tool", "assistant.status", "task.get", "snapshot.get", "dispatch.child"]) {
        expect(() => authorizeWorkOperation(refused, op, { turnId: TURN }), `${token.slice(0, 8)} ${op}`).toThrow(/assistant grant/);
      }
    }
    const live = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 5 });
    const expired = withGrant({ ...c, now: NOW + 5 }, live);
    for (const op of ["assistant.tool", "snapshot.get"]) expect(() => authorizeWorkOperation(expired, op, { turnId: TURN }), op).toThrow(/Expired or revoked assistant grant/);
    revokeAssistantGrants(c, TURN);
    const revoked = withGrant(c, live);
    for (const op of ["assistant.tool", "snapshot.get"]) expect(() => authorizeWorkOperation(revoked, op, { turnId: TURN }), op).toThrow(/Expired or revoked assistant grant/);
  });

  test("leaves a caller with no assistant grant exactly where it was", () => {
    const c = ctx();
    expect(() => authorizeWorkOperation(c, "assistant.tool", { turnId: TURN })).not.toThrow();
    expect(() => authorizeWorkOperation(c, "snapshot.get", {})).not.toThrow();
    expect(() => authorizeWorkOperation(c, "task.get", { id: "t-1" })).not.toThrow();
    // An enforcement identity still answers only for its own denial, and an assistant grant cannot stand in for it.
    expect(() => authorizeWorkOperation({ ...c, env: { ...c.env, PACER_ENFORCEMENT_TOKEN: "pet_x" } }, "dispatch.enforcement.denied", {})).not.toThrow();
    expect(() => authorizeWorkOperation({ ...c, env: { ...c.env, PACER_ENFORCEMENT_TOKEN: "pet_x", PACER_ASSISTANT_GRANT: `pag_${"0".repeat(64)}` } }, "dispatch.enforcement.denied", {}))
      .toThrow(/assistant grant/);
    // A work grant keeps its own list; an assistant grant never widens it.
    const task = createTask(c, { brief: { goal: "g", repo: "/r" }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    registerWork(c, task.id, { allowDelegation: true });
    updateTask(c, task.id, t => { t.state = "running"; });
    const work = issueWorkGrant(c, task.id, 1);
    const executor = { ...c, env: { ...c.env, PACER_WORK_GRANT: work, PACER_ROLE: "executor" } };
    expect(() => authorizeWorkOperation(executor, "assistant.tool", { turnId: TURN })).toThrow(/not allowed by this work grant|is not allowed/);
    expect(() => authorizeWorkOperation(executor, "task.get", { id: task.id })).not.toThrow();
  });
});

describe("the assistant.tool op", () => {
  const manifest = manifestSchema.parse({
    id: "fx-tool", version: "1.0.0", publisher: "test", host: ">=1.11.0",
    contributes: { assistant: { reply: true } }, capabilities: [{ name: "assistant.tool" }],
  });
  const granted = (c: Ctx, token: string) => ({ ...c, env: { ...c.env, PACER_ASSISTANT_GRANT: token } });
  const openTurn = (c: Ctx, turnId: string, rounds = 6) => {
    const state: AssistantToolState = { cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max: rounds } };
    const turn: AssistantToolTurn = { turnId, scope, read, redactor: createRedactor([KEY], c.home), cards: { task: () => null }, state };
    return { state, turn, close: openAssistantTurnFor(turnId, turn) };
  };

  test("runs the host's tool pipeline for its own turn, and closes with the turn", async () => {
    const c = ctx();
    const token = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 60 });
    const { state, close } = openTurn(c, TURN);
    const out = await callOp(granted(c, token), "assistant.tool", { turnId: TURN, name: "snapshot", params: {} }) as { name: string; content: string; ok: boolean };
    expect(out.name).toBe("snapshot");
    expect(out.ok).toBe(true);
    expect(out.content).toStartWith('<data tool="snapshot">');
    expect(state.toolLog).toEqual([{ name: "snapshot", ok: true, args: {} }]);
    // Another turn's tool call is refused even with a live grant, and a ended turn's context is gone.
    await expect(callOp(granted(c, token), "assistant.tool", { turnId: "turn-another", name: "snapshot" })).rejects.toMatchObject({ code: "not_allowed" });
    close();
    await expect(callOp(granted(c, token), "assistant.tool", { turnId: TURN, name: "snapshot" })).rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("has ended") });
  });

  test("charges one shared round budget with capability.assistant.tool", async () => {
    const c = ctx();
    const token = issueAssistantGrant(c, { turnId: TURN, conversationId: CONVERSATION, expiresAt: NOW + 60 });
    const { state, turn, close } = openTurn(c, TURN, 2);
    const authority = createCallAuthority(c, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 10_000, grants: ["assistant.tool"] });
    const closeAuthority = openAssistantTurn(authority, turn);
    const capability = () => answerCapability(c, { id: "fx-tool", manifest }, "capability.assistant.tool",
      { turnId: TURN, name: "snapshot", params: {} }, authority) as Promise<{ ok: boolean }>;
    const op = () => callOp(granted(c, token), "assistant.tool", { turnId: TURN, name: "snapshot", params: {} }) as Promise<{ ok: boolean }>;
    // One counter, whichever path asks: the op, then the capability, then neither has a round left.
    expect((await op()).ok).toBe(true);
    expect((await capability()).ok).toBe(true);
    expect(state.rounds).toEqual({ used: 2, max: 2 });
    await expect(op()).rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("budget") });
    await expect(capability()).rejects.toThrow(/tool-call budget/);
    // The turn ends: both paths lose the context together.
    close();
    closeAuthority();
    expect(assistantTurnById(TURN)).toBeNull();
    expect(assistantTurnFor(authority)).toBeNull();
  });

  test("is refused to an executor session and to a work grant", async () => {
    const c = ctx();
    const { close } = openTurn(c, TURN);
    // The executor refusals in ops.ts and caller-policy.ts stay as they are: an executor session
    // cannot use the assistant at all, and a work grant's allow-list has no assistant op in it.
    await expect(callOp({ ...c, env: { ...c.env, PACER_ROLE: "executor" } }, "assistant.tool", { turnId: TURN, name: "snapshot", params: {} }))
      .rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("executors cannot use the assistant") });
    const task = createTask(c, { brief: { goal: "g", repo: "/r" }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    registerWork(c, task.id, { allowDelegation: true });
    updateTask(c, task.id, t => { t.state = "running"; });
    const work = issueWorkGrant(c, task.id, 1);
    const executor = { ...c, env: { ...c.env, PACER_WORK_GRANT: work, PACER_ROLE: "executor" } };
    await expect(callOp(executor, "assistant.tool", { turnId: TURN, name: "snapshot", params: {} }))
      .rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("not allowed by this work grant") });
    close();
  });
});

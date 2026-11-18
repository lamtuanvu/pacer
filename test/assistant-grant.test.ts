import { describe, expect, test } from "bun:test";
import { BUNDLED } from "../plugins/bundled";
import { admit, ask, assistantGrantFor } from "../src/assistant/service";
import { getTurn, readSettings, writeSettings } from "../src/assistant/store";
import { assistantTurnById } from "../src/assistant/turn-tools";
import type { AssistantScope } from "../src/assistant/types";
import { bundledPluginSpawn, pluginRegistry } from "../src/plugins/index";
import { manifestSchema } from "../src/plugins/protocol";
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
  const c = fakeCtx();
  pluginRegistry(c, {
    bundled: backend === "executor" ? [...BUNDLED, fakeExecutor] : BUNDLED,
    spawnBundled: (home, id) => id === "fx-reply"
      ? { argv: [process.execPath, new URL("./fixtures/assistant-reply/peer.ts", import.meta.url).pathname], cwd: home.home, env: {} }
      : bundledPluginSpawn(home, id),
  });
  writeSettings(c, { runner: null, account: "ep", backend, expect_rev: readSettings(c).rev });
  const deps = {
    strategy: () => strategy(), status, keys: async () => [KEY], read, cards: { task: () => null },
    respond: respond as never,
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

  test("is never issued for a turn the pacer backend answers", async () => {
    const { ctx: c, deps } = setup("pacer", async () => ({ message: "hello", usage: { input: 1, output: 1, coverage: "measured" as const } }));
    const started = await ask(c, { text: "hi", scope, requestId: `r-${crypto.randomUUID()}` }, deps);
    expect(await finished(c, started.turnId)).toMatchObject({ state: "done", answer: "hello" });
    expect(assistantGrantFor(started.turnId)).toBeNull();
    expect(assistantGrants(c)).toEqual([]);
    expect(assistantTurnById(started.turnId)).toBeNull();
  }, 30_000);
});

import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp, parseOpParams} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {CoreError} from "../src/core/errors";
import {assistantDatabase, conversationTurns, getTurn, readSettings, updateCard} from "../src/assistant/store";
import {assistantStatus, candidates, deleteConversations, listHistory, refreshCard, READS_SUMMARY, saveSettings} from "../src/assistant/service";
import {fakeCtx} from "./helpers";

let binary: string;
/** Cargo never leaves a `target/` in the worktree: the project's own target dir, else a temporary one. */
const cargoEnv = () => ({ ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(tmpdir(), "pacer-native-as") });
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { env: cargoEnv() });
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], { env: cargoEnv() }).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}

const NOW = 1_700_000_000;
const TASK = "t-20231114-010203-abcd";
const STRATEGY = 'accounts:\n  claude: {kind: claude, source: default}\n  cl: {kind: claude, home: "~/cl"}\n  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:1/v1", key: none, models: [{id: m1, name: Model One, context: 1000, output: 100, tools: true}, {id: m2, context: 1000, output: 100, tools: false}]}}\n  bare: {kind: endpoint, usage: unmetered}\n  local: {kind: endpoint, usage: unmetered, model: local/x, connection: {api: openai-compatible, base_url: "http://127.0.0.1:2/v1", key: none, models: [{id: lx, context: 10, output: 5, tools: true}]}}\nplanner: claude-code#claude\nrunners: {"opencode#ep": {model: pacer-ep/m2}}\nrouting: [{default: [opencode#ep]}]\n';
/** The named Claude account's config folder must exist for its ask adapter to qualify. */
const clHome = (home: string) => mkdirSync(join(home, "cl"), {recursive: true});

const SETTINGS_SETUP: SetupData = {
  strategy: STRATEGY,
  dirs: ["cl"],
  sql: [`INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,'opencode#ep','ep',NULL,'{"turnsPerDay":3}','{"conversations":200,"days":30}',4)`],
};
const UNUSABLE_LIMITS: SetupData = {
  sql: [`INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,'opencode#ep','ep',NULL,'{"turnsPerDay":0}','{"conversations":200,"days":30}',4)`],
};
const UNUSABLE_RETENTION: SetupData = {
  sql: [`INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,'opencode#ep','ep',NULL,'{"turnsPerDay":3}','not json',4)`],
};
const UNTITLED: SetupData = {
  sql: [
    `INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES('c-a','Alpha',1699990000,1699999000.5)`,
    `INSERT INTO assistant_turns(id,conversation_id,seq,at,question,answer,state,error,account,scope,cards,citations) VALUES('turn-1','c-a',1,1699999000.5,'How?','Like it.','done',NULL,'ep','{"kind":"dispatch","days":7}','[{"id":"card-1","op":"dispatch.retry","params":{"id":"${TASK}","expect_rev":1},"title":"Retry","summary":"s","editable":[],"why":"because","state":"stale","result":"old"}]','[]')`,
    `INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES('${TASK}',3,'done',1,1,'{"id":"${TASK}","rev":3,"state":"done"}',0)`,
  ],
};
const CARD = {id: "card-1", op: "dispatch.retry", params: {id: TASK, expect_rev: 1, note: "x\u0007 é ✓ \u2028"}, title: "Retry", summary: "s", editable: [{name: "note", label: "Note", value: "x"}], why: "because", state: "stale", result: "old", href: "#/tasks/x"};
// Array-index keys come first after JSON.parse; the stored text keeps the original order.
const CARDS = `[${JSON.stringify(CARD)},{"id":"card-2","op":"navigate","params":{"b":1,"2":true,"1":null},"title":"Go","summary":"","editable":[],"why":"","state":"pending"}]`;

const db = (home: string) => assistantDatabase(fakeCtx({pacerHome: home, home}));
const strategy = (home: string) => writeFileSync(join(home, "strategy.yaml"), STRATEGY);
const settings = (account: string | null, limits = '{"turnsPerDay":3}', retention = '{"conversations":200,"days":30}', backend: string | null = null) => (home: string) =>
  db(home).query("INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,'opencode#ep',?,?,?,?,4)").run(account, backend, limits, retention);
function history(home: string) {
  db(home).exec(`
    INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES('c-a','Alpha',1699990000,1699999000.5),('c-b','Beta',1699000000,1699500000),('c-old','Old',1690000000,1690000000);
    INSERT INTO assistant_turns(id,conversation_id,seq,at,question,answer,state,error,account,scope,cards,citations) VALUES
      ('turn-1','c-a',1,1699999000.5,'How?','Like ${TASK}.','done',NULL,'ep','{"kind":"dispatch","days":7}','${CARDS.replaceAll("'", "''")}','[{"label":"${TASK}","href":"#/tasks/${TASK}"}]'),
      ('turn-2','c-a',2,1699999100,'Next',NULL,'running',NULL,NULL,'{"kind":"task","id":"${TASK}"}','[]','[]'),
      ('turn-3','c-b',1,1699500000,'Old?',NULL,'error','boom','ep','{"repo":"/r","kind":"repo"}','[]','[]');
    INSERT INTO assistant_usage VALUES('turn-1','c-a',1699999000.5,'ep',100,50,10,NULL,'measured'),('turn-2','c-a',1699999100,NULL,0,0,NULL,NULL,'unknown'),('turn-x','c-gone',1699990000,'ep',5,6,NULL,7,'partial');
    INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES('${TASK}',3,'done',1,1,'{"id":"${TASK}","rev":3,"state":"done","brief":{"goal":"Fix the flaky test"}}',0);
  `);
}
const all = (...steps: ((home: string) => void)[]) => (home: string) => { for (const step of steps) step(home); };

function dump(home: string) {
  const path = join(home, "state/tasks.db");
  if (!existsSync(path)) return null;
  // Read-only handles cannot open a closed WAL database without its -shm file.
  const sqlite = new Database(path);
  try {
    const tables = ["assistant_settings", "assistant_conversations", "assistant_turns", "assistant_usage"];
    return Object.fromEntries(tables.map(t => [t, sqlite.query(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  } finally { sqlite.close(); }
}

/**
 * E3: after the ops' TS handlers became `nativeOnly`, the reference is the same TypeScript
 * functions and schemas those handlers called, behind the same caller policy and Zod parsing.
 */
async function reference(ctx: ReturnType<typeof fakeCtx>, op: string, params: unknown): Promise<unknown> {
  // The reference mirrors the old handlers' zod-parsed params; each case supplies a valid shape.
  const p: any = parseOpParams(ctx, op, params);
  switch (op) {
    case "assistant.settings.get": return readSettings(ctx);
    case "assistant.settings.set": return saveSettings(ctx, p);
    case "assistant.conversations": return {conversations: listHistory(ctx, p)};
    case "assistant.conversation": return {id: p.id, turns: conversationTurns(ctx, p.id)};
    case "assistant.turn": {
      const turn = getTurn(ctx, p.turnId);
      if (!turn) throw new CoreError("not_found", "Unknown turn.");
      return turn;
    }
    case "assistant.delete": return deleteConversations(ctx, p.id);
    case "assistant.card.record": return updateCard(ctx, p.turnId, p.cardId, {state: p.state, ...(p.result !== undefined ? {result: p.result} : {})});
    case "assistant.card.refresh": return refreshCard(ctx, p.turnId, p.cardId);
    // B4-2: the public handlers are nativeOnly, so compare against the functions they used.
    case "assistant.status": return assistantStatus(ctx);
    case "assistant.candidates": return {accounts: candidates(ctx), reads: READS_SUMMARY};
    default: return callOp(ctx, op, p);
  }
}

/** The bundled `assistant-executor` reply plugin, as the native door's registry snapshot sees it. */
const PLUGIN_ENTRIES = [{
  id: "assistant-executor",
  manifest: {contributes: {assistant: {backend: "executor", reply: true}}},
  bundled: true, grant: {}, state: "ready", error: null, pid: null, served: [], protocol: null, restarts: 0,
}];
/** Read-only `computeStatus` parts: no live usage source is touched (no EXHAUSTED/reserve cases here). */
const STATUS_PARTS = {accounts: [{name: "ep", verdict: "UNKNOWN", usedPct: null}], mode: "normal"};

type SetupData = {strategy?: string; dirs?: string[]; sql?: string[]};
type Golden = {file: "settings" | "history" | "cards"; setup: SetupData};
type Case = [op: string, params: unknown, setup?: (home: string) => void, env?: Record<string, string>, golden?: Golden];

/** E3: freeze a case for the Rust golden replay. `UPDATE_M3_GOLDENS=1` writes the fixture. */
function record(golden: Golden | undefined, op: string, params: unknown, env: Record<string, string>, expected: unknown, codeOnly: boolean) {
  if (!golden || process.env.UPDATE_M3_GOLDENS !== "1") return;
  const path = join(import.meta.dir, "fixtures/m3/assistant", `${golden.file}.json`);
  const all = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as unknown[] : [];
  all.push({op, params, setup: golden.setup, env, expected, ...(codeOnly ? {codeOnly: true} : {})});
  mkdirSync(join(import.meta.dir, "fixtures/m3/assistant"), {recursive: true});
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
}

async function compare([op, params, setup, env = {}, golden]: Case) {
  const rs = mkdtempSync(join(tmpdir(), "native-as-")), ts = mkdtempSync(join(tmpdir(), "native-as-"));
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env});
  let expected: unknown;
  try { expected = {result: await reference(ctx, op, params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const input = `${JSON.stringify({
    op, params, home: rs, now: NOW, env,
    ...(op === "assistant.status" || op === "assistant.candidates"
      ? {pluginEntries: PLUGIN_ENTRIES, statusParts: STATUS_PARTS} : {}),
  })}\n`;
  const actual = JSON.parse(execFileSync(driver(), [], {input}).toString());
  const label = `${op} ${JSON.stringify(params)} ${JSON.stringify(env)}`;
  expect(actual, `${label} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`).toEqual(expected);
  expect(JSON.stringify(actual), `${label}: bytes`).toBe(JSON.stringify(expected));
  expect(dump(rs), `${label}: tables`).toEqual(dump(ts));
  record(golden, op, params, env, expected, false);
}

/**
 * S0 Q1: Rust keeps the `internal` code and uses its own message. Freeze those messages here and in
 * `test/fixtures/m3/assistant/*.json`; the Rust goldens replay them.
 */
const INTERNAL: Record<string, string> = {
  settings: "assistant settings are unreadable: limits.turnsPerDay is outside 1..=1000",
  conversations: "assistant settings are unreadable: retention is not valid JSON",
  cards: `task ${TASK} has no title or goal`,
};

async function compareCode([op, params, setup, env = {}, golden]: Case, message: string) {
  const rs = mkdtempSync(join(tmpdir(), "native-as-")), ts = mkdtempSync(join(tmpdir(), "native-as-"));
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env});
  let expected: unknown;
  try { expected = {result: await reference(ctx, op, params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const actual = JSON.parse(execFileSync(driver(), [], {input: `${JSON.stringify({op, params, home: rs, now: NOW, env})}\n`}).toString());
  const label = `${op} ${JSON.stringify(params)}`;
  expect(actual.error?.code, `${label}: code`).toBe((expected as {error?: {code: string}}).error?.code);
  expect(actual.error?.message, `${label}: frozen Rust message`).toBe(message);
  expect(dump(rs), `${label}: tables`).toEqual(dump(ts));
  record(golden, op, params, env, {error: {code: actual.error.code, message}}, true);
}

async function forwarded([op, params, setup, env = {}]: Case) {
  const rs = mkdtempSync(join(tmpdir(), "native-as-"));
  setup?.(rs);
  const input = `${JSON.stringify({op, params, home: rs, now: NOW, env})}\n`;
  expect(JSON.parse(execFileSync(driver(), [], {input}).toString()), `${op} ${JSON.stringify(params)}`).toEqual({forwarded: true});
}

const base = {runner: null, account: null, expect_rev: 1};

test("native assistant settings, history and cards match TypeScript results, errors and tables", async () => {
  const cases: Case[] = [
    ["assistant.settings.get", {}],
    ["assistant.settings.get", null],
    ["assistant.settings.get", {extra: 1}, settings("ep", '{"deadlineMs":5000.0,"maxInputTokens":1000,"x":1}')],
    ["assistant.settings.get", []],
    ["assistant.settings.set", base],
    ["assistant.settings.set", {...base, limits: {}, retention: {days: 7}}],
    ["assistant.settings.set", {...base, runner: "opencode#ep", account: "ep", limits: {maxOutputTokens: 100, turnsPerDay: 1000}}, strategy],
    ["assistant.settings.set", {...base, account: "local"}, strategy],
    ["assistant.settings.set", {...base, account: "bare"}, strategy],
    ["assistant.settings.set", {...base, account: "claude"}, strategy],
    ["assistant.settings.set", {...base, account: "missing"}, strategy],
    ["assistant.settings.set", {...base, expect_rev: 4, retention: {conversations: 1}}, settings("ep")],
    ["assistant.settings.set", {...base, expect_rev: 3}, settings("ep")],
    ["assistant.settings.set", {...base, expect_rev: 2}],
    ["assistant.settings.set", {}],
    ["assistant.settings.set", {runner: 1, account: true, expect_rev: 1.5, limits: [], retention: null}],
    ["assistant.settings.set", {...base, expect_rev: -1e300, limits: {maxInputTokens: 1e300, maxToolRounds: -1e300, turnsPerDay: "x", deadlineMs: null}}],
    ["assistant.settings.set", {runner: "", account: "a".repeat(65), expect_rev: 0}],
    // `backend` is additive: a valid value is stored, anything else is one zod issue, absent keeps the stored choice.
    ["assistant.settings.set", {...base, backend: "pacer"}, strategy],
    ["assistant.settings.set", {...base, backend: "executor"}, strategy],
    ["assistant.settings.set", {...base, backend: "x"}, strategy],
    ["assistant.settings.set", {...base, backend: 5}, strategy],
    ["assistant.settings.set", {...base, backend: null}, strategy],
    // The executor backend qualifies any account with an ask-mode adapter (opencode, Claude Code, Codex).
    ["assistant.settings.set", {runner: null, account: "cl", expect_rev: 4, backend: "executor"}, all(settings("ep"), strategy, clHome), {}, {file: "settings", setup: SETTINGS_SETUP}],
    ["assistant.settings.set", {runner: null, account: "claude", expect_rev: 4, backend: "executor"}, all(settings("ep"), strategy), {}, {file: "settings", setup: SETTINGS_SETUP}],
    ["assistant.settings.set", {runner: null, account: "bare", expect_rev: 4, backend: "executor"}, all(settings("ep"), strategy), {}, {file: "settings", setup: SETTINGS_SETUP}],
    ["assistant.settings.set", {runner: null, account: "nope", expect_rev: 4, backend: "executor"}, all(settings("ep"), strategy), {}, {file: "settings", setup: SETTINGS_SETUP}],
    ["assistant.settings.set", "x"],
    ["assistant.settings.get", {}, settings("ep", '{"turnsPerDay":3}', '{"conversations":200,"days":30}', "executor")],
    ["assistant.settings.get", {}, settings("ep", '{"turnsPerDay":3}', '{"conversations":200,"days":30}', "garbage")],
    ["assistant.status", {}],
    ["assistant.status", {}, all(settings(null), history)],
    ["assistant.status", {}, all(settings("gone"), strategy, history)],
    ["assistant.status", {x: 1}],
    ["assistant.conversations", {}, history],
    ["assistant.conversations", {before: 1699999000.5, limit: 1}, history],
    ["assistant.conversations", {before: 1e300}, all(settings(null, "{}", '{"conversations":1}'), history)],
    ["assistant.conversations", {before: "x", limit: 0}],
    ["assistant.conversations", {limit: 101.5}],
    ["assistant.conversation", {id: "c-a"}, history],
    ["assistant.conversation", {id: "c-b"}, history],
    ["assistant.conversation", {id: "nope"}, history],
    ["assistant.conversation", {id: ""}],
    ["assistant.turn", {turnId: "turn-1"}, history],
    ["assistant.turn", {turnId: "turn-3"}, history],
    ["assistant.turn", {turnId: "nope"}, history],
    ["assistant.turn", {turnId: "\u{1F600}".repeat(129)}],
    ["assistant.delete", {id: "c-a"}, history],
    ["assistant.delete", {id: "nope"}, history],
    ["assistant.delete", {}, history],
    ["assistant.delete", {id: null}],
    ["assistant.card.record", {turnId: "turn-1", cardId: "card-1", state: "done", result: "Retried ✓"}, history],
    ["assistant.card.record", {turnId: "turn-1", cardId: "card-2", state: "dismissed"}, history],
    ["assistant.card.record", {turnId: "turn-1", cardId: "card-9", state: "failed"}, history],
    ["assistant.card.record", {turnId: "nope", cardId: "card-1", state: "stale"}, history],
    ["assistant.card.record", {turnId: "turn-1", cardId: "card-1", state: "x", result: "a".repeat(501)}],
    ["assistant.card.refresh", {turnId: "turn-1", cardId: "card-1"}, history],
    ["assistant.card.refresh", {turnId: "turn-1", cardId: "card-2"}, history],
    ["assistant.card.refresh", {turnId: "turn-1", cardId: "card-9"}, history],
    ["assistant.card.refresh", {turnId: "nope", cardId: "card-1"}, history],
    ["assistant.card.refresh", {turnId: 1}],
    // Caller policy refuses before the params are read.
    ["assistant.settings.get", [], undefined, {PACER_ROLE: "executor"}],
    ["assistant.delete", {}, history, {PACER_ENFORCEMENT_TOKEN: "x", PACER_ROLE: "executor"}],
  ];
  for (const item of cases) await compare(item);
}, 600_000);

test("native assistant status and candidates match TypeScript without a reply plugin", async () => {
  const cases: Case[] = [
    ["assistant.status", {}],
    ["assistant.status", {}, all(settings(null), history)],
    ["assistant.status", {}, all(settings("ep"), strategy, history)],
    // A missing strategy keeps Rust's own message in the reason (S0 Q1), so it is not byte-compared here.
    ["assistant.status", {}, all(settings("ep", '{"turnsPerDay":3}', '{"conversations":200,"days":30}', "executor"), strategy, history)],
    // A missing strategy keeps Rust's own error text (S0 Q1), so it is not byte-compared here.
    ["assistant.candidates", {}, strategy],
  ];
  for (const item of cases) await compare(item);
});

test("native assistant leaves work grants and unregistered ops to the core", async () => {
  const unusable = settings("ep", '{"turnsPerDay":0}');
  // Work grants are process-wide and stay with the core (C16).
  await forwarded(["assistant.turn", {turnId: "turn-1"}, history, {PACER_WORK_GRANT: "pwg_x"}]);
  // The forwarded TypeScript reference reports the schema failure itself.
  const home = mkdtempSync(join(tmpdir(), "native-as-"));
  unusable(home);
  await expect(reference(fakeCtx({pacerHome: home, home, now: NOW, env: {}}), "assistant.settings.get", {})).rejects.toThrow();
  // assistant.tool needs a live turn's tool context in the core, and assistant.selftest its agent CLI.
  // assistant.ask and assistant.cancel are covered by test/native-assistant-turn-parity.test.ts.
  for (const op of ["assistant.tool", "assistant.selftest"]) {
    expect(() => execFileSync(driver(), [], {input: `${JSON.stringify({op, params: {turnId: "turn-1", name: "snapshot", params: {}}, home, now: NOW})}\n`, stdio: ["pipe", "pipe", "ignore"]}), op).toThrow();
  }
});

/** E3: the TypeScript suite also reads the frozen goldens, so deleting `src/` later is safe. */
test("frozen M3 assistant goldens drive the native registry", async () => {
  const apply = (home: string, setup: SetupData) => {
    if (setup.strategy) writeFileSync(join(home, "strategy.yaml"), setup.strategy);
    for (const folder of setup.dirs ?? []) mkdirSync(join(home, folder), {recursive: true});
    for (const sql of setup.sql ?? []) db(home).exec(sql);
  };
  for (const file of ["settings", "history", "cards"] as const) {
    const cases = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/m3/assistant", `${file}.json`), "utf8")) as Array<Record<string, any>>;
    for (const c of cases) {
      const home = mkdtempSync(join(tmpdir(), "native-as-golden-"));
      apply(home, c.setup);
      const actual = JSON.parse(execFileSync(driver(), [], {input: `${JSON.stringify({op: c.op, params: c.params, home, now: NOW, env: c.env ?? {}})}\n`}).toString());
      const label = `${file} ${c.op} ${JSON.stringify(c.params)}`;
      if (c.codeOnly) {
        expect(actual.error.code, label).toBe(c.expected.error.code);
        expect(actual.error.message, label).toBe(c.expected.error.message);
      } else {
        expect(actual, label).toEqual(c.expected);
      }
    }
  }
});

test("unusable settings and untitled cards are native internal errors", async () => {
  const untitled = (home: string) => {
    history(home);
    db(home).run(`UPDATE tasks SET record='{"id":"${TASK}","rev":3,"state":"done"}'`);
  };
  await compareCode(["assistant.settings.get", {}, settings("ep", '{"turnsPerDay":0}'), {}, {file: "settings", setup: UNUSABLE_LIMITS}], INTERNAL.settings);
  await compareCode(["assistant.conversations", {}, settings("ep", '{"turnsPerDay":3}', "not json"), {}, {file: "history", setup: UNUSABLE_RETENTION}], INTERNAL.conversations);
  await compareCode(["assistant.card.refresh", {turnId: "turn-1", cardId: "card-1"}, untitled, {}, {file: "cards", setup: UNTITLED}], INTERNAL.cards);
});

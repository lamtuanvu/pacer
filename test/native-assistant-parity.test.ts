import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {assistantDatabase} from "../src/assistant/store";
import {fakeCtx} from "./helpers";

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}

const NOW = 1_700_000_000;
const TASK = "t-20231114-010203-abcd";
const STRATEGY = 'accounts:\n  claude: {kind: claude}\n  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:1/v1", key: none, models: [{id: m1, name: Model One, context: 1000, output: 100, tools: true}, {id: m2, context: 1000, output: 100, tools: false}]}}\n  bare: {kind: endpoint, usage: unmetered}\n  local: {kind: endpoint, usage: unmetered, model: local/x, connection: {api: openai-compatible, base_url: "http://127.0.0.1:2/v1", key: none, models: [{id: lx, context: 10, output: 5, tools: true}]}}\nplanner: claude-code#claude\nrunners: {"opencode#ep": {model: pacer-ep/m2}}\nrouting: [{default: [opencode#ep]}]\n';
const CARD = {id: "card-1", op: "dispatch.retry", params: {id: TASK, expect_rev: 1, note: "x\u0007 é ✓ \u2028"}, title: "Retry", summary: "s", editable: [{name: "note", label: "Note", value: "x"}], why: "because", state: "stale", result: "old", href: "#/tasks/x"};
// Array-index keys come first after JSON.parse; the stored text keeps the original order.
const CARDS = `[${JSON.stringify(CARD)},{"id":"card-2","op":"navigate","params":{"b":1,"2":true,"1":null},"title":"Go","summary":"","editable":[],"why":"","state":"pending"}]`;

const db = (home: string) => assistantDatabase(fakeCtx({pacerHome: home, home}));
const strategy = (home: string) => writeFileSync(join(home, "strategy.yaml"), STRATEGY);
const settings = (account: string | null, limits = '{"turnsPerDay":3}', retention = '{"conversations":200,"days":30}') => (home: string) =>
  db(home).query("INSERT INTO assistant_settings VALUES(1,'opencode#ep',?,?,?,4)").run(account, limits, retention);
function history(home: string) {
  db(home).exec(`
    INSERT INTO assistant_conversations VALUES('c-a','Alpha',1699990000,1699999000.5),('c-b','Beta',1699000000,1699500000),('c-old','Old',1690000000,1690000000);
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

type Case = [op: string, params: unknown, setup?: (home: string) => void, env?: Record<string, string>];

async function compare([op, params, setup, env = {}]: Case) {
  const rs = mkdtempSync(join(tmpdir(), "native-as-")), ts = mkdtempSync(join(tmpdir(), "native-as-"));
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env});
  let expected: unknown;
  try { expected = {result: await callOp(ctx, op, params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const input = `${JSON.stringify({op, params, home: rs, now: NOW, env})}\n`;
  const actual = JSON.parse(execFileSync(driver(), [], {input}).toString());
  const label = `${op} ${JSON.stringify(params)} ${JSON.stringify(env)}`;
  expect(actual, `${label} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`).toEqual(expected);
  expect(JSON.stringify(actual), `${label}: bytes`).toBe(JSON.stringify(expected));
  expect(dump(rs), `${label}: tables`).toEqual(dump(ts));
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
    ["assistant.settings.set", "x"],
    ["assistant.candidates", {}, strategy],
    ["assistant.status", {}],
    ["assistant.status", {}, all(settings(null), history)],
    ["assistant.status", {}, all(settings("gone"), strategy, history)],
    ["assistant.status", {}, all(settings("ep"), strategy, history)],
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

test("native assistant leaves cached-status admission and TypeScript-only inputs to the core", async () => {
  const unusable = settings("ep", '{"turnsPerDay":0}');
  const cases: Case[] = [
    ["assistant.status", {}, all(settings("ep", "{}"), strategy, history)],
    ["assistant.status", {}, settings("ep")],
    ["assistant.candidates", {}],
    ["assistant.settings.set", {...base, account: "ep"}],
    ["assistant.settings.get", {}, unusable],
    ["assistant.settings.set", base, unusable],
    ["assistant.conversations", {}, unusable],
    ["assistant.status", {}, unusable],
    ["assistant.turn", {turnId: "turn-1"}, history, {PACER_WORK_GRANT: "pwg_x"}],
    // taskTitle throws on a record without a title or goal; only TypeScript reproduces that error.
    ["assistant.card.refresh", {turnId: "turn-1", cardId: "card-1"}, all(history, home => db(home).run("UPDATE tasks SET record=json_remove(record,'$.brief')"))],
  ];
  for (const item of cases) await forwarded(item);
  // The forwarded TypeScript reference reports the schema failure itself.
  const home = mkdtempSync(join(tmpdir(), "native-as-"));
  unusable(home);
  await expect(callOp(fakeCtx({pacerHome: home, home, now: NOW, env: {}}), "assistant.settings.get", {})).rejects.toThrow();
  // assistant.ask and assistant.cancel are not registered natively.
  for (const op of ["assistant.ask", "assistant.cancel"]) {
    expect(() => execFileSync(driver(), [], {input: `${JSON.stringify({op, params: {}, home, now: NOW})}\n`, stdio: ["pipe", "pipe", "ignore"]}), op).toThrow();
  }
});

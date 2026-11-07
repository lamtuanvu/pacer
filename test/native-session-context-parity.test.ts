import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {taskDatabase} from "../src/tasks/store";
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
const DRAFT = "6f1c2a4e-9b7d-4c3e-8a21-0d5e7f9b1c2a";
const SCHEMA = `CREATE TABLE IF NOT EXISTS attachment_drafts (id TEXT PRIMARY KEY, created REAL NOT NULL, task TEXT);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, draft TEXT NOT NULL, batch TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, task TEXT, state TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attachments_draft ON attachments(draft);`;

const db = (home: string) => taskDatabase(fakeCtx({pacerHome: home, home}));
const task = (fields: Record<string, unknown>, rev = 3) => (home: string) => {
  const record = JSON.stringify({id: TASK, rev, state: "running", brief: {goal: "Talk", repo: "/r"}, createdAt: 1, attempts: [], ...fields});
  db(home).query("INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES(?,?,'running',1,1,?,0)").run(TASK, rev, record);
};
const conversation = (fields: Record<string, unknown> = {}, rev?: number) => task({interactionMode: "conversation", ...fields}, rev);
const draft = (created: number, owner: string | null) => (home: string) => {
  db(home).exec(SCHEMA);
  db(home).query("INSERT INTO attachment_drafts VALUES(?,?,?)").run(DRAFT, created, owner);
};
const files = (home: string) => db(home).exec(`
  INSERT INTO attachments VALUES('a-3','${DRAFT}','b1','zeta ✓ é.png','image/png',2048,NULL,'ready');
  INSERT INTO attachments VALUES('a-1','${DRAFT}','b1','notes.txt','text/plain',0,'${TASK}','ready');
  INSERT INTO attachments VALUES('a-2','${DRAFT}','b2','partial.bin','application/octet-stream',9,NULL,'uploading');
  INSERT INTO attachments VALUES('a-4','other','b1','foreign.txt','text/plain',1,NULL,'ready');`);
const all = (...steps: ((home: string) => void)[]) => (home: string) => { for (const step of steps) step(home); };

function schema(home: string) {
  const path = join(home, "state/tasks.db");
  if (!existsSync(path)) return null;
  const sqlite = new Database(path);
  try {
    return sqlite.query("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'attachment%' ORDER BY name").all();
  } finally { sqlite.close(); }
}

type Case = [params: unknown, setup?: (home: string) => void, env?: Record<string, string>];

async function compare([params, setup, env = {}]: Case) {
  const rs = mkdtempSync(join(tmpdir(), "native-sc-")), ts = mkdtempSync(join(tmpdir(), "native-sc-"));
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env});
  let expected: unknown;
  try { expected = {result: await callOp(ctx, "session.context", params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const input = `${JSON.stringify({op: "session.context", params, home: rs, now: NOW, env})}\n`;
  const actual = execFileSync(driver(), [], {input}).toString().trimEnd();
  const label = `${JSON.stringify(params)} ${JSON.stringify(env)}`;
  expect(actual, `${label}: bytes`).toBe(JSON.stringify(expected));
  expect(schema(rs), `${label}: schema`).toEqual(schema(ts));
  return expected;
}

test("native session.context matches TypeScript results, errors and attachment schema", async () => {
  const cases: Case[] = [
    // Operation schema.
    [null],
    [[]],
    ["x"],
    [{}],
    [{id: 1}],
    [{id: null}],
    [{id: ""}],
    [{id: "a b"}],
    [{id: "é"}],
    [{id: "a".repeat(128)}],
    [{id: "a".repeat(129)}],
    // Enforcement identities are refused before the schema; an empty token is no identity.
    [{id: TASK}, conversation(), {PACER_ENFORCEMENT_TOKEN: "token"}],
    [5, undefined, {PACER_ENFORCEMENT_TOKEN: "token"}],
    [{id: TASK}, conversation(), {PACER_ENFORCEMENT_TOKEN: ""}],
    // Task lookup and conversation gate.
    [{id: TASK}],
    [{id: "request"}],
    [{id: TASK, extra: true}, task({})],
    [{id: TASK}, task({interactionMode: "headless"})],
    // Conversations without a draft read no attachment tables.
    [{id: TASK}, conversation()],
    [{id: TASK}, conversation({}, 9007199254740991)],
    [{id: TASK}, conversation({sessionDraftId: ""})],
    [{id: TASK}, conversation({sessionDraftId: null})],
    [{id: TASK}, conversation({sessionDraftId: 0})],
    // Draft lookup, expiry and listing.
    [{id: TASK}, conversation({sessionDraftId: DRAFT})],
    [{id: TASK}, conversation({sessionDraftId: 7})],
    [{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(NOW - 86400, null), files)],
    [{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(NOW - 86399.5, null), files)],
    [{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(NOW - 86400, ""), files)],
    [{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(1, TASK), files)],
    [{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(1, "t-other"))],
    [{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(NOW + 10, null), files)],
  ];
  for (const testCase of cases) await compare(testCase);
  expect(await compare([{id: TASK}, all(conversation({sessionDraftId: DRAFT}), draft(1, TASK), files)])).toEqual({result: {draftId: DRAFT, rev: 3, attachments: [
    {id: "a-3", name: "zeta ✓ é.png", mime: "image/png", size: 2048},
    {id: "a-1", name: "notes.txt", mime: "text/plain", size: 0},
  ]}});
}, 600_000);

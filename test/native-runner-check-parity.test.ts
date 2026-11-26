import {beforeAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import type {RunnerCheckDeps} from "../src/core/runner-check";
import {fakeCtx} from "./helpers";
import {assertIsolatedEnv, isolatedEnv} from "./isolated-port";

const NOW = 1_700_000_000;
const root = join(import.meta.dir, "..");
let driver = "";
beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], {cwd: root});
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {cwd: root}).toString());
  driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
}, 600_000);

const STRATEGY = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\n";

/** The case snapshot both doors decide on: TS gets stub deps derived from it,
 *  Rust gets the same object through `runnerCheckCase`. */
interface Case {
  agent: string;
  account: string;
  kind: string;
  usage: string;
  found?: boolean;
  install_hint?: string;
  signedIn?: boolean | null;
  signInReason?: string | null;
  row?: Record<string, unknown> | null;
  provider?: string | null;
  models?: {source: string; offered: boolean | null; closest: string[]; note?: string};
  testError?: string | null;
}
const baseCase = (over: Partial<Case> = {}): Case => ({
  agent: "codex", account: "codex", kind: "codex", usage: "quota",
  found: true, install_hint: "install codex", signedIn: true,
  row: {usedPct: 3, window: "weekly", error: null, hint: null, capturedAt: 1, stale: false},
  models: {source: "none", offered: null, closest: []},
  testError: null, ...over,
});

function caseValue(id: string, c: Case) {
  const agent = c.agent;
  return {
    id, now: NOW,
    runner: {id, agent, model: "gpt-5", account: c.account, host: null},
    account: {name: c.account, kind: c.kind, usage: c.usage, provider: c.provider ?? null, source: "opencode"},
    found: {found: c.found !== false, install_hint: c.install_hint ?? "install"},
    status: c.signedIn == null ? null : {signedIn: c.signedIn},
    signInReason: c.signInReason ?? null,
    row: c.row ?? null,
    models: c.models ?? {source: "none", offered: null, closest: []},
    testError: c.testError ?? false,
    refreshed: null,
    env: {},
    raw: {},
  };
}

function depsFor(id: string, c: Case): RunnerCheckDeps {
  const value = caseValue(id, c);
  const models = () => {
    const m = value.models;
    let listed: {id: string}[] | null = null;
    if (m.offered === true) listed = [{id: "gpt-5"}];
    else if (m.offered === false && m.closest.length) listed = [{id: m.closest[0]}];
    else if (m.offered === false) listed = [];
    return {runner: id, source: m.source, models: listed, fetchedAt: NOW, note: m.note};
  };
  return {
    detectAgents: async () => [{agent: value.runner.agent, found: value.found.found,
      version: "1.0", path: "/bin/codex", install_hint: value.found.install_hint}],
    listAccounts: async () => value.status ? [{name: c.account, signedIn: value.status.signedIn}] : [],
    checkLimits: async () => value.row ? [{...value.row, account: c.account}] : [],
    availableModels: async () => models(),
    runTestTask: async () => { if (value.testError) throw Error(String(value.testError)); },
  } as any;
}

function home(strategy: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "native-runner-check-"));
  if (strategy !== null) writeFileSync(join(dir, "strategy.yaml"), strategy, {mode: 0o600});
  return dir;
}

const driverEnv = isolatedEnv({...process.env});
const run = (input: {env: Record<string, string>} & Record<string, unknown>) => {
  assertIsolatedEnv(input.env);
  return JSON.parse(execFileSync(driver, [], {input: JSON.stringify(input) + "\n", env: driverEnv}).toString());
};

/** Job ids, pids and timestamps are process-local; normalize them away. */
function normalize(value: any): any {
  if (!value?.result || typeof value.result !== "object") return value;
  const {id: _id, pid: _pid, startedAt: _startedAt, endedAt: _endedAt, ...job} = value.result;
  return {...value, result: job};
}

async function compare(params: unknown, c: Case | null = null, strategy: string | null = STRATEGY, extra: Record<string, string> = {}, targetId?: string) {
  const env = isolatedEnv(extra);
  const rs = home(strategy), ts = home(strategy);
  const id = (params as any)?.id ?? "codex";
  let expected: unknown;
  try {
    expected = {result: await callOp(fakeCtx({pacerHome: ts, home: ts, now: NOW, env}), "runner.check", params,
      c ? {runnerCheck: depsFor(id, c)} : {})};
  } catch (error) { expected = {error: toApiError(error)}; }
  const actual = run({op: "runner.check", params, home: rs, now: NOW, env,
    runnerCheckCase: c ? caseValue(targetId ?? id, c) : null});
  const label = JSON.stringify(params);
  expect(JSON.stringify(normalize(actual)).replaceAll(rs, "$HOME"), label).toBe(
    JSON.stringify(normalize(expected)).replaceAll(ts, "$HOME"));
  const rsFile = join(rs, "state", "runner-checks.json");
  const tsFile = join(ts, "state", "runner-checks.json");
  expect(existsSync(rsFile), `${label}: no native check result`).toBe(existsSync(tsFile));
  if (existsSync(rsFile) && existsSync(tsFile)) {
    expect(JSON.parse(readFileSync(rsFile, "utf8")), label).toEqual(JSON.parse(readFileSync(tsFile, "utf8")));
  }
}

test("runner.check refuses invalid params and unknown runners like TypeScript", async () => {
  for (const params of [{}, null, [], "x", {id: 1}, {id: ""}, {id: "x".repeat(129)}, {id: "😀".repeat(65)}, {id: "😀".repeat(128)}, {id: "😀".repeat(129)}, {id: "e\u0301".repeat(65)},
    {id: "cursor"}, {id: "cursor", test: false}, {id: "nope", extra: 1}])
    await compare(params);
  await compare({id: "cursor"}, null, STRATEGY, {PACER_ENFORCEMENT_TOKEN: "t"});
}, 120_000);

test("runner.check starts a native job for every configured runner", async () => {
  for (const params of [{id: "codex"}, {id: "codex", test: false}, {id: "codex", test: true}, {id: "claude-code"}]) {
    const agent = params.id === "claude-code" ? "claude-code" : "codex";
    const kind = params.id === "claude-code" ? "claude" : "codex";
    await compare(params, baseCase({agent, account: kind, kind}));
  }
  await compare({id: "codex#codex@local"}, baseCase(), STRATEGY, {}, "codex");
}, 120_000);

test("runner.check steps differ by case and persist the same result", async () => {
  await compare({id: "codex"}, baseCase({found: false, install_hint: "install codex"}));
  await compare({id: "codex"}, baseCase({signedIn: false, signInReason: "signed out — run codex login"}));
  await compare({id: "codex"}, baseCase({row: {usedPct: 3, window: "weekly", error: "usage unavailable", hint: null, capturedAt: 1, stale: false}}));
  const withModel = STRATEGY.replace("codex: {}", "codex: {model: gpt-5}");
  await compare({id: "codex"}, baseCase({models: {source: "opencode", offered: false, closest: ["gpt-5-mini"]}}), withModel);
  await compare({id: "codex"}, baseCase({testError: "test task failed"}));
}, 120_000);

test("prototype ids and unreadable strategies keep TypeScript's errors", async () => {
  for (const id of ["constructor", "__proto__", "toString"]) await compare({id});
  await compare({id: "nope"}, null, "planner: [\n");
  await compare({id: "codex"}, null, null);
}, 120_000);

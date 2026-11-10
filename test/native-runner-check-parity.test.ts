import {beforeAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
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

async function compare(params: unknown, extra: Record<string, string> = {}) {
  const env = isolatedEnv(extra);
  const rs = home(STRATEGY), ts = home(STRATEGY);
  let expected: unknown;
  try { expected = {result: await callOp(fakeCtx({pacerHome: ts, home: ts, now: NOW, env}), "runner.check", params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const actual = run({op: "runner.check", params, home: rs, now: NOW, env});
  expect(JSON.stringify(actual).replaceAll(rs, "$HOME"), JSON.stringify(params)).toBe(JSON.stringify(expected).replaceAll(ts, "$HOME"));
  expect(existsSync(join(rs, "state", "runner-checks.json")), `${JSON.stringify(params)}: no check result`).toBe(false);
}

function forwarded(params: unknown, strategy: string | null = STRATEGY) {
  const dir = home(strategy);
  expect(run({op: "runner.check", params, home: dir, now: NOW, env: isolatedEnv({})}), JSON.stringify(params)).toEqual({forwarded: true});
  expect(existsSync(join(dir, "jobs")), `${JSON.stringify(params)}: no native job`).toBe(false);
}

test("runner.check refuses invalid params and unknown runners like TypeScript", async () => {
  for (const params of [{}, null, [], "x", {id: 1}, {id: ""}, {id: "x".repeat(129)}, {id: "😀".repeat(65)}, {id: "😀".repeat(128)}, {id: "😀".repeat(129)}, {id: "e\u0301".repeat(65)},
    {id: "cursor"}, {id: "cursor", test: false}, {id: "nope", extra: 1}])
    await compare(params);
  await compare({id: "codex"}, {PACER_ENFORCEMENT_TOKEN: "t"});
}, 120_000);

test("runner.check forwards every configured runner's check job to TypeScript", () => {
  for (const params of [{id: "codex"}, {id: "codex", test: false}, {id: "codex", test: true}, {id: "claude-code"}, {id: "codex#codex@local"}])
    forwarded(params);
  for (const id of ["constructor", "__proto__", "toString"]) forwarded({id});
  forwarded({id: "nope"}, "planner: [\n");
  forwarded({id: "codex"}, null);
});

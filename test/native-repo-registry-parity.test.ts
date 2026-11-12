import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {createTask} from "../src/tasks/store";
import {fakeCtx, realRun} from "./helpers";

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
const normalize = (value: unknown, path: string) => JSON.parse(JSON.stringify(value ?? null).replaceAll(path, "$HOME"));
const read = (home: string, file: string) => existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").replaceAll(home, "$HOME") : null;
const events = (home: string) => (read(home, "link/outbox.jsonl") ?? "").trim().split("\n").filter(Boolean).map(line => {
  const {envelope} = JSON.parse(line);
  if (envelope.type === "entity" && envelope.data.kind === "activity") { delete envelope.data.id; delete envelope.data.value.id; }
  return envelope;
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {cwd, stdio: "ignore"});

type Step = {op: string; params: unknown; now?: number; sleepMs?: number};
type Setup = (home: string) => void;

/** Runs the same steps against TypeScript and the native driver on twin homes. */
async function compare(steps: Step[], setup?: Setup, files = ["state/repos.json", "project-strategies.json"]) {
  const rs = mkdtempSync(join(tmpdir(), "native-rr-")), ts = mkdtempSync(join(tmpdir(), "native-rr-"));
  setup?.(rs); setup?.(ts);
  const expected: unknown[] = [];
  for (const step of steps) {
    if (step.sleepMs) await Bun.sleep(step.sleepMs);
    const ctx = fakeCtx({pacerHome: ts, home: ts, now: step.now ?? NOW, env: {}, run: realRun});
    try { expected.push({result: await callOp(ctx, step.op, step.params)}); } catch (error) { expected.push({error: toApiError(error)}); }
  }
  const input = steps.map(step => JSON.stringify({op: step.op, params: step.params, home: rs, now: step.now ?? NOW, sleepMs: step.sleepMs})).join("\n") + "\n";
  const actual = execFileSync(driver(), [], {input}).toString().trim().split("\n").map(line => JSON.parse(line));
  const label = JSON.stringify(steps);
  expect(normalize(actual, rs), label).toEqual(normalize(expected, ts));
  for (const file of files) expect(read(rs, file), `${label}: ${file}`).toBe(read(ts, file));
  expect(normalize(events(rs), rs), `${label}: events`).toEqual(normalize(events(ts), ts));
}

const STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\n";
/** Two checkouts (one with branches), one missing checkout and a label collision. */
function registry(home: string) {
  mkdirSync(join(home, "state"), {recursive: true});
  writeFileSync(join(home, "strategy.yaml"), STRATEGY);
  const app = join(home, "app"), tool = join(home, "tool");
  for (const repo of [app, tool]) { mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); git(repo, "commit", "-q", "--allow-empty", "-m", "x"); }
  git(app, "branch", "feature"); git(app, "checkout", "-q", "-b", "work");
  writeFileSync(join(home, "state/repos.json"), JSON.stringify({
    [app]: {key: "github.com/acme/app", path: app, lastUsed: 1_699_999_000.25},
    [tool]: {key: "gitlab.com/acme/app", path: tool, lastUsed: 1_699_999_500},
    [join(home, "gone")]: {key: "github.com/acme/gone", path: join(home, "gone"), lastUsed: 1_600_000_000},
  }));
}
const policies = (home: string) => writeFileSync(join(home, "strategy.yaml"), STRATEGY) ?? writeFileSync(join(home, "project-strategies.json"), JSON.stringify({version: 1, projects: {
  "github.com/acme/app": {executors: ["codex#codex@local"], rev: 2.0},
  "github.com/acme/elsewhere": {rev: 1, executors: ["cursor#cursor@local", "codex#codex@local"]},
  "local:0123456789ab": {rev: 4, executors: null},
}}));
const both = (...setups: Setup[]) => (home: string) => setups.forEach(s => s(home));

test("native repo.list matches TypeScript listings, branches, stale filtering and pruning", async () => {
  const list = {op: "repo.list", params: {}};
  await compare([list]);
  await compare([list], registry);
  // A refreshed probe hides the missing checkout; pruning waits for the per-minute throttle.
  await compare([list, {...list, sleepMs: 300}, {...list, now: NOW + 60}], registry);
  // A recent task keeps the missing checkout listed and unpruned.
  await compare([list, {...list, sleepMs: 300, now: NOW + 60}], both(registry, home => {
    createTask(fakeCtx({pacerHome: home, home, now: NOW}), {brief: {goal: "g", repo: join(home, "gone")}, kind: null, requestedExecutor: null, timeoutS: 60});
  }));
  for (const params of [{x: 1}, "x", [], {a: 1, b: 2}]) await compare([{op: "repo.list", params}]);
}, 600_000);

test("native project.strategy matches TypeScript results, file bytes and publication", async () => {
  const app = "github.com/acme/app";
  const steps: [Step[], Setup?][] = [
    [[{op: "project.strategy.list", params: {}}], registry],
    [[{op: "project.strategy.list", params: {}}], both(registry, policies)],
    [[{op: "project.strategy.list", params: {}}], policies],
    [[{op: "project.strategy.get", params: {repo: app}}], registry],
    [[{op: "project.strategy.get", params: {repo: app}}], both(registry, policies)],
    [[{op: "project.strategy.get", params: {repo: "local:0123456789ab"}}], both(registry, policies)],
    [[{op: "project.strategy.get", params: {repo: "gitlab.com/acme/app"}}], both(registry, policies)],
    [[{op: "project.strategy.get", params: {repo: "github.com/acme/unknown"}}], registry],
    [[{op: "project.strategy.get", params: {repo: "checkout"}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["cursor", "codex#codex@local"], expect_rev: 0}}, {op: "project.strategy.get", params: {repo: app}}, {op: "project.strategy.list", params: {}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["cursor"], expect_rev: 2}}], both(registry, policies)],
    [[{op: "project.strategy.set", params: {repo: "github.com/acme/elsewhere", executors: ["codex"], expect_rev: 1}}], both(registry, policies)],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["cursor"], expect_rev: 1}}], both(registry, policies)],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["unknown"], expect_rev: 0}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["claude-code"], expect_rev: 0}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["codex", "codex#codex@local"], expect_rev: 0}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["codex"], expect_rev: 9007199254740991}}], registry],
    [[{op: "project.strategy.remove", params: {repo: app, expect_rev: 2}}, {op: "project.strategy.list", params: {}}], both(registry, policies)],
    [[{op: "project.strategy.remove", params: {repo: "github.com/acme/elsewhere", expect_rev: 0}}], both(registry, policies)],
    [[{op: "project.strategy.remove", params: {repo: app, expect_rev: 0}}], registry],
    // Operation schema errors.
    [[{op: "project.strategy.list", params: {x: 1}}], registry],
    [[{op: "project.strategy.get", params: {}}], registry],
    [[{op: "project.strategy.get", params: {repo: ""}}], registry],
    [[{op: "project.strategy.get", params: {repo: "a".repeat(4097)}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: [], expect_rev: 0}}], registry],
    [[{op: "project.strategy.set", params: {repo: app, executors: ["", 1, "x".repeat(129)], expect_rev: 0.5, z: 1}}], registry],
    [[{op: "project.strategy.set", params: {b: 1, a: 2}}], registry],
    [[{op: "project.strategy.remove", params: {repo: app, expect_rev: -1}}], registry],
    [[{op: "project.strategy.remove", params: {repo: app, expect_rev: "1"}}], registry],
  ];
  for (const [list, setup] of steps) await compare(list, setup);
}, 600_000);

test("native repository ops forward Core-only inputs", () => {
  const home = mkdtempSync(join(tmpdir(), "native-rr-"));
  registry(home);
  const run = (op: string, params: unknown) => JSON.parse(execFileSync(driver(), [], {input: JSON.stringify({op, params, home, now: NOW}) + "\n"}).toString());
  // Absolute checkouts and broken policy files resolve natively; unusual registries, special policy
  // files and strategies whose errors carry runtime text keep TypeScript's reader and errors.
  expect(run("project.strategy.get", {repo: join(home, "app")})).not.toHaveProperty("forwarded");
  expect(run("repo.add", {path: join(home, "app")})).not.toHaveProperty("forwarded");
  expect(run("project.strategy.list", {})).not.toHaveProperty("forwarded");
  writeFileSync(join(home, "project-strategies.json"), "{broken");
  expect(run("project.strategy.list", {}).error.message).toBe("Invalid project strategies");
  rmSync(join(home, "project-strategies.json"));
  execFileSync("mkfifo", [join(home, "project-strategies.json")]);
  expect(run("project.strategy.list", {})).toEqual({forwarded: true});
  rmSync(join(home, "project-strategies.json"));
  writeFileSync(join(home, "strategy.yaml"), "planner: [");
  expect(run("project.strategy.list", {})).toEqual({forwarded: true});
  writeFileSync(join(home, "strategy.yaml"), STRATEGY);
  writeFileSync(join(home, "state/repos.json"), JSON.stringify({"/x": {key: "k", path: "relative"}}));
  expect(run("repo.list", {})).toEqual({forwarded: true});
  expect(run("repo.add", {path: join(home, "app")})).toEqual({forwarded: true});
});

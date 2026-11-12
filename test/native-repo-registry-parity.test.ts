import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {createTask} from "../src/tasks/store";
import {fakeCtx, realRun} from "./helpers";
import {type Case, differential, front, home as frontHome, put, rows, serve} from "./native-repo-front-door";

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

/** Unusual registries (section 1a) beside a missing checkout, so the last listing prunes. */
const odd = (repos: (home: string) => unknown, aliases?: (home: string) => unknown) => (home: string) => {
  mkdirSync(join(home, "state"), {recursive: true});
  writeFileSync(join(home, "strategy.yaml"), STRATEGY);
  for (const name of ["app", "tool"]) mkdirSync(join(home, name));
  const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(join(home, "state/repos.json"), text(repos(home)));
  if (aliases) writeFileSync(join(home, "state/repo-paths.json"), text(aliases(home)));
};
const at = (home: string, name: string, lastUsed: unknown = 1, more = "") => `{"key":"github.com/acme/${name}","path":${JSON.stringify(join(home, name))},"lastUsed":${typeof lastUsed === "string" ? lastUsed : JSON.stringify(lastUsed)}${more}}`;

test("native repo.list prunes unusual registries at the same time and to the same bytes as TypeScript", async () => {
  const list = {op: "repo.list", params: {}};
  const prune: Step[] = [list, {...list, sleepMs: 300}, {...list, now: NOW + 60}];
  const setups: Setup[] = [
    odd(home => `[${at(home, "app", 3)},${at(home, "gone", 5)},${at(home, "tool", 4)}]`),
    odd(home => `{${JSON.stringify(join(home, "tool"))}:${at(home, "tool", "1e400", ',"extra":{"n":[1.0,-0,1e21]}')},"10":${at(home, "gone", '"7"')},"__proto__":${at(home, "app", "true")},"2":${at(home, "tool", "[2]")}}`),
    odd(home => `{"x":${at(home, "app")},}`),
    odd(home => `{"a":${at(home, "app", "null")},"b":${at(home, "gone", '""')}}`, home => `"${home}"`),
  ];
  for (const setup of setups) await compare(prune, setup);
  // A recent task's checkout resolves through a numeric alias to the missing entry's key, which keeps it.
  await compare(prune, both(odd(home => `{"2":${at(home, "gone")},"x":${at(home, "app", 2)}}`, home => `{${JSON.stringify(join(home, "wt"))}:2}`), home => {
    createTask(fakeCtx({pacerHome: home, home, now: NOW}), {brief: {goal: "g", repo: join(home, "wt", "x")}, kind: null, requestedExecutor: null, timeoutS: 60});
  }));
}, 600_000);

test("native prune takes the repos lock that the unlocked TypeScript prune ignores", async () => {
  const list = {op: "repo.list", params: {}};
  const steps: Step[] = [list, {...list, sleepMs: 300, now: NOW + 60}];
  const setup = odd(home => `[${at(home, "app", 3)},${at(home, "gone", 5)}]`);
  const locked = (home: string) => { setup(home); mkdirSync(join(home, "orca")); writeFileSync(join(home, "orca/repos.lock"), ""); };
  const ts = mkdtempSync(join(tmpdir(), "native-rr-")), rs = mkdtempSync(join(tmpdir(), "native-rr-"));
  locked(ts); locked(rs);
  const before = read(rs, "state/repos.json");
  const expected: unknown[] = [];
  for (const step of steps) {
    if (step.sleepMs) await Bun.sleep(step.sleepMs);
    expected.push({result: await callOp(fakeCtx({pacerHome: ts, home: ts, now: step.now ?? NOW, env: {}, run: realRun}), step.op, step.params)});
  }
  // TypeScript rewrote the registry while another writer held the lock.
  expect(read(ts, "state/repos.json")).not.toBe(before);
  expect(existsSync(join(ts, "orca/repos.lock"))).toBe(true);
  const child = Bun.spawn([driver()], {stdin: "pipe", stdout: "pipe"});
  child.stdin.write(steps.map(step => JSON.stringify({op: step.op, params: step.params, home: rs, now: step.now ?? NOW, sleepMs: step.sleepMs})).join("\n") + "\n");
  child.stdin.end();
  await Bun.sleep(3000);
  // The native prune waits for the lock instead.
  expect(child.exitCode).toBeNull();
  expect(read(rs, "state/repos.json")).toBe(before);
  rmSync(join(rs, "orca/repos.lock"));
  const actual = (await new Response(child.stdout).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(await child.exited).toBe(0);
  expect(normalize(actual, rs)).toEqual(normalize(expected, ts));
  expect(read(rs, "state/repos.json")).toBe(read(ts, "state/repos.json"));
}, 60_000);

const listing = (transport: "stdio" | "http"): Case[] => rows(transport).map(row => ({name: row.name, seed: row.seed, steps: [{op: "repo.list", native: row.list, feed: row.feed}]}));

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`section 1a registries list over ${transport} like forced forwarding`, async () => {
    const cases = listing(transport);
    const {out} = await differential(transport, cases, "repo.list");
    cases.forEach((c, i) => { if (c.steps[0]!.native) expect(out[i]!.reply, c.name).not.toContain('"error"'); });
    const keys = (name: string) => JSON.parse(out[cases.findIndex(c => c.name === name)]!.reply.replace(/^200 /, "")).result.map((repo: {key: string}) => repo.key);
    expect(keys("integer index keys enumerate first")).toEqual(["github.com/acme/c", "github.com/acme/a", "github.com/acme/seven", "github.com/acme/b", "github.com/acme/e1", "github.com/acme/d"]);
    expect(keys("lastUsed converts with ToNumber")).toEqual(["github.com/acme/a", "github.com/acme/b", "github.com/acme/d", "github.com/acme/c"]);
    expect(keys("infinite lastUsed")).toEqual(["github.com/acme/a", "github.com/acme/c", "github.com/acme/b"]);
  }, 180_000);
}

/** One unusual registry (array-like index keys, an own `__proto__` entry, infinite lastUsed) behind the other registry readers. */
const ODD_SEED = {
  repos: '{"__proto__":{"key":"github.com/acme/added","path":"$H/added","lastUsed":1e400},"7":{"key":"github.com/acme/a","path":"$H/r/a","lastUsed":"2"}}',
  aliases: '{"$H/r/a-wt":7}',
  strategies: '{"version":1,"projects":{"github.com/acme/added":{"executors":["codex#codex@local"],"rev":1}}}',
};
const READERS = (native: boolean) => [
  {op: "project.strategy.list", native},
  {op: "project.strategy.get", params: {repo: "github.com/acme/a"}, native},
  {op: "issue.search", params: {repo: "github.com/acme/added", query: "bug"}, native},
  {op: "issue.search", params: {repo: "github.com/acme/nope", query: "bug"}, native},
  {op: "project.strategy.get", params: {repo: "$H/added-wt"}, native},
  {op: "repo.list", native},
];

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`issue.search and project.strategy read an unusual registry over ${transport} like forced forwarding`, async () => {
    const cases: Case[] = [
      {name: "ported registry", seed: ODD_SEED, steps: READERS(true)},
      {name: "forwarded registry", seed: {...ODD_SEED, repos: '{"7":{"key":"github.com/acme/a","path":"$H/r/a","lastUsed":"2"},"/x":null}'}, steps: READERS(false)},
    ];
    const {out, gh} = await differential(transport, cases, "repo.list,issue.search,project.strategy.list,project.strategy.get");
    expect(out[2]!.reply).toContain('"issues":[{"number":1');
    expect(out[3]!.reply).toContain('"error"');
    expect(gh.trim().split("\n")).toHaveLength(1);
  }, 180_000);
}

test.skipIf(!front)("native repo.add and forwarded repo.remove serialize on the repos lock over an unusual registry", async () => {
  for (let round = 0; round < 6; round++) {
    const dir = frontHome(), real = realpathSync(dir), state = join(dir, ".pacer", "state");
    const entry = (name: string, lastUsed: number) => ({key: `github.com/acme/${name}`, path: join(real, "r", name), lastUsed});
    const initial = `{"__proto__":${JSON.stringify(entry("a", 3))},"7":${JSON.stringify(entry("b", 5))}}`;
    put(join(state, "repos.json"), initial);
    put(join(state, "repo-paths.json"), JSON.stringify({[join(real, "r", "b-wt")]: 7}));
    const server = await serve(dir, "repo.remove");
    // Even rounds remove an existing entry; odd rounds race the removal of the entry being added.
    const target = round % 2 === 0 ? "github.com/acme/b" : "github.com/acme/added";
    const [removed, added] = await Promise.all([server.post("repo.remove", {key: target}), server.post("repo.add", {path: "$H/added-wt"})]);
    const markers = (await server.stop()).split("\n").filter(line => /^native repo\./.test(line));
    expect(markers).toEqual(["native repo.add"]);
    expect(removed).toBe('200 {"result":{"removed":true}}');
    expect(added.startsWith("200 ")).toBe(true);
    const final = readFileSync(join(state, "repos.json"), "utf8").replace(/("lastUsed":)\d{10}(\.\d+)?/, "$1<now>");
    const aliases = readFileSync(join(state, "repo-paths.json"), "utf8");
    const main = `${JSON.stringify(join(real, "added"))}:{"key":"github.com/acme/added","path":${JSON.stringify(join(real, "added"))},"lastUsed":<now>}`;
    const a = `"__proto__":${JSON.stringify(entry("a", 3))}`, b = `"7":${JSON.stringify(entry("b", 5))}`;
    // TypeScript's removal keeps the numeric alias: it compares the value 7 with the name "7".
    const both = JSON.stringify({[join(real, "r", "b-wt")]: 7, [join(real, "added-wt")]: join(real, "added")});
    const serial = round % 2 === 0
      ? [[`{${a},${main}}`, both]]
      : [[`{${b},${a},${main}}`, both], [`{${b},${a}}`, JSON.stringify({[join(real, "r", "b-wt")]: 7})]];
    expect(serial).toContainEqual([final, aliases]);
  }
}, 180_000);

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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import type { ProviderStatus } from "../src/engine/rank";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, withLoginIndicators } from "./helpers";
import { front, git, serve } from "./native-repo-front-door";

// Parity for the native `mode.hold` without `until`, `routing.route` with `repo` or a
// least-loaded balance, and `task.retry_options` under a project policy. The driver receives the
// usage-broker parts TypeScript sees from `computeStatus`; the front door is compared with forced
// forwarding on twin homes.

const root = resolve(import.meta.dir, "..");
const NOW = 1_700_000_000.5;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const fresh = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };

// Checkouts outside every home, so the twins register identical paths.
const shared = fresh("pacer-residue-repos-");
const APP = join(shared, "app"), PLAIN = join(shared, "plain"), KEY = "github.com/acme/app";
mkdirSync(APP);
mkdirSync(PLAIN);
git(APP, "init", "-q", "-b", "main");
git(APP, "commit", "-q", "--allow-empty", "-m", "x");
git(APP, "remote", "add", "origin", "https://github.com/acme/app.git");

const LOCAL = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n  codex: {max_tasks: 2}\n  cursor: {max_tasks: 4}\n";
const LEAST = `${LOCAL}pacing:\n  balance: least-loaded\n`;
const REMOTE = `${LOCAL}  codex@devbox: {}\nhosts:\n  devbox: {ssh: devbox, repos: {}, paused: true}\n`;
const policy = (executors: string[] | null) => JSON.stringify({ version: 1, projects: { [KEY]: { rev: 3, executors } } });
const STRICT = policy(["codex#codex@local", "cursor#cursor@local"]);
const REGISTRY = JSON.stringify({ [APP]: { key: KEY, path: APP, lastUsed: 1 } });

type Seed = { strategy: string; policy?: string; registered?: boolean; tasks?: (ctx: Ctx) => void };

/** A home whose data directory is `pacerHome`; the driver and the reference use one directory for both. */
function seed(s: Seed, pacerHome = (home: string) => home): Ctx {
  const home = fresh("pacer-residue-seed-");
  const ctx = withLoginIndicators(fakeCtx({ home, pacerHome: pacerHome(home), now: NOW }));
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), s.strategy);
  if (s.policy !== undefined) writeFileSync(join(ctx.pacerHome, "project-strategies.json"), s.policy);
  if (s.registered) writeFileSync(join(ctx.pacerHome, "state/repos.json"), REGISTRY);
  s.tasks?.(ctx);
  return ctx;
}

function task(ctx: Ctx, kind: string | null, patch: (row: any) => void = () => {}): string {
  const t = createTask(ctx, { brief: { goal: "Goal", repo: APP }, kind, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, row => { row.state = "failed"; patch(row); });
  return t.id;
}
const running = (executor: string, n: number) => (ctx: Ctx) => {
  for (let i = 0; i < n; i++) task(ctx, null, row => { row.state = "running"; row.executor = executor; });
};

type Parts = { accounts: any[]; providers: ProviderStatus[] };
async function parts(ctx: Ctx, mutate: (p: Parts) => void = () => {}): Promise<Parts> {
  const status = await computeStatus(ctx, loadStrategy(ctx));
  const out = structuredClone({ accounts: status.accounts, providers: status.providers }) as Parts;
  mutate(out);
  return out;
}
const byId = (p: Parts) => Object.fromEntries(p.providers.map(provider => [provider.id, provider]));
/** Codex joins cursor's band: eligible and on pace. */
const eligibleCodex = (p: Parts) => {
  Object.assign(byId(p).codex!, { verdict: "OK", eligibility: {
    state: "eligible", reasons: [], evaluatedAt: NOW, validUntil: null, evidenceAgeS: null, availability: "ready", budget: "not_required", spendingRisk: "unknown",
  } });
};

type Case = { name: string; op: string; params: unknown; ctx: Ctx; parts: Parts; forwarded?: boolean };
const FILES = ["state/mode-hold.json", "state/repos.json"];

async function scenarios(): Promise<Case[]> {
  const cases: Case[] = [];
  const add = async (name: string, ctx: Ctx, op: string, params: unknown, p?: Parts, forwarded = false) =>
    cases.push({ name, op, params, ctx, parts: p ?? await parts(ctx), forwarded });

  const local = seed({ strategy: LOCAL });
  await add("hold until the planner account resets", local, "mode.hold", { mode: "strict" }, await parts(local, p => {
    p.accounts = [{ name: "codex", resetsAt: NOW + 60 }, { name: "claude", resetsAt: NOW + 7200 }];
  }));
  await add("an integral reset is written without a fraction", local, "mode.hold", { mode: "strict" }, await parts(local, p => {
    p.accounts = [{ name: "claude", resetsAt: 1_700_007_200 }];
  }));
  await add("hold for a week without a reset", local, "mode.hold", { mode: "relaxed", extra: 1 }, await parts(local, p => { p.accounts = []; }));
  await add("hold past the planner reset", local, "mode.hold", { mode: "emergency" }, await parts(local, p => {
    p.accounts = [{ name: "claude", resetsAt: NOW - 1 }];
  }));
  await add("null resetsAt reads as a week", local, "mode.hold", { mode: "normal" }, await parts(local, p => {
    p.accounts = [{ name: "claude", resetsAt: null }];
  }));
  for (const params of [{ mode: "strict", until: NOW + 30 }, { mode: "normal", until: 1_700_000_100 }, { mode: "x", until: "y" }, { mode: "normal", until: null }, [], null]) {
    await add(`hold params ${JSON.stringify(params)}`, local, "mode.hold", params);
  }

  const strict = seed({ strategy: LOCAL, policy: STRICT, registered: true });
  await add("route by repository alias", strict, "routing.route", { repo: KEY, kind: "tests" });
  await add("route by absolute checkout", strict, "routing.route", { repo: APP });
  await add("unregistered path without identity under a strict policy", strict, "routing.route", { repo: PLAIN });
  await add("unknown repository key", strict, "routing.route", { repo: "github.com/acme/none/x" }, undefined, true);
  await add("relative path forwards", strict, "routing.route", { repo: "app" }, undefined, true);
  await add("route params", strict, "routing.route", { kind: "nope", goal: 1, repo: "" });
  await add("null kind", strict, "routing.route", { kind: null, other: true });
  await add("excluded policy executor", strict, "routing.route", { repo: KEY }, await parts(strict, p => {
    byId(p).codex!.installed = false;
    byId(p).cursor!.unavailableReason = "Host offline";
  }));
  const open = seed({ strategy: LOCAL, policy: policy(null) });
  await add("project inheriting global routing", open, "routing.route", { repo: APP });
  await add("unregistered absolute checkout without a policy", seed({ strategy: LOCAL }), "routing.route", { repo: PLAIN });

  const least = seed({ strategy: LEAST, tasks: running("cursor", 3) });
  await add("least-loaded spreads one band", least, "routing.route", {}, await parts(least, eligibleCodex));
  await add("least-loaded with a kind", least, "routing.route", { kind: "docs" }, await parts(least, eligibleCodex));
  await add("least-loaded keeps near-limit bands apart", least, "routing.route", {}, await parts(least, p => { eligibleCodex(p); byId(p).codex!.verdict = "NEAR_LIMIT"; }));
  await add("least-loaded leaves uncertain fallbacks apart", least, "routing.route", {});
  const leastPolicy = seed({ strategy: LEAST, policy: STRICT, registered: true, tasks: running("codex", 1) });
  await add("least-loaded within a project policy", leastPolicy, "routing.route", { repo: KEY }, await parts(leastPolicy, eligibleCodex));
  await add("host runner forwards (F1)", seed({ strategy: REMOTE }), "routing.route", {}, undefined, true);

  {
    const ctx = seed({ strategy: LOCAL, policy: STRICT, registered: true });
    const id = task(ctx, "tests", row => { row.executor = "codex"; });
    await add("retry within the project policy", ctx, "task.retry_options", { id });
    await add("retry with a policy executor down", ctx, "task.retry_options", { id }, await parts(ctx, p => { byId(p).cursor!.unavailableReason = "Host offline"; }));
    const stored = task(ctx, null, row => { row.executor = "claude-code"; row.repo = { key: KEY, path: APP, label: "app" }; });
    await add("retry uses the stored repository", ctx, "task.retry_options", { id: stored });
    const unverified = task(ctx, null, row => { row.brief.repo = PLAIN; });
    await add("retry refuses an unverified repository under a strict policy", ctx, "task.retry_options", { id: unverified });
  }
  {
    const ctx = seed({ strategy: LOCAL, policy: policy(null) });
    const id = task(ctx, null, row => { row.brief.repo = PLAIN; row.executor = "codex"; });
    await add("retry with a policy that names no executors", ctx, "task.retry_options", { id });
  }
  {
    const ctx = seed({ strategy: LOCAL, policy: "{not json" });
    await add("unreadable policy forwards", ctx, "task.retry_options", { id: task(ctx, null) }, undefined, true);
  }
  return cases;
}

const reference = `
import {mock} from "bun:test";
const statusPath = ${JSON.stringify(join(root, "src/engine/status.ts"))};
const actual = {...await import(statusPath)};
let injected;
mock.module(statusPath, () => ({...actual, computeStatus: async (...args) => ({...await actual.computeStatus(...args), ...injected})}));
const {callOp} = await import(${JSON.stringify(join(root, "src/api/ops.ts"))});
const {toApiError} = await import(${JSON.stringify(join(root, "src/api/errors.ts"))});
const {defaultRun} = await import(${JSON.stringify(join(root, "src/ctx.ts"))});
const run = (argv, ...rest) => argv[0] === "git" ? defaultRun(argv, ...rest) : Promise.resolve({code: 127, stdout: "", stderr: "not available in tests"});
const out = [];
for (const c of await new Response(Bun.stdin.stream()).json()) {
  injected = c.parts;
  const ctx = {home: c.home, pacerHome: c.home, now: c.now, env: {PATH: "/usr/bin:/bin"}, which: () => "/usr/bin/fake", run};
  try { out.push({result: await callOp(ctx, c.op, c.params)}); } catch (error) { out.push({error: toApiError(error)}); }
}
process.stdout.write(JSON.stringify(out) + "\\n", () => process.exit(0));
`;

async function run(argv: string[], input: string, env: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(argv, { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
  await child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(`${argv[0]} exited ${code}: ${stderr}`);
  return stdout;
}

let driver = "";
beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], { cwd: root }).toString());
  driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
}, 900_000);

const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

test("Rust answers held modes, repository and least-loaded routes and policy retry options like TypeScript", async () => {
  const cases = await scenarios();
  const twins = cases.map(c => ["ts", "rs"].map(side => {
    const dir = fresh(`pacer-residue-${side}-`);
    cpSync(c.ctx.home, dir, { recursive: true });
    return dir;
  }) as [string, string]);
  const isolated = fresh("pacer-residue-reference-");
  const expected = JSON.parse(await run([process.execPath, "-e", reference],
    JSON.stringify(cases.map((c, i) => ({ op: c.op, params: c.params, home: twins[i]![0], now: NOW, parts: c.parts }))),
    { PATH: process.env.PATH, TZ: process.env.TZ, HOME: isolated, PACER_HOME: join(isolated, ".pacer") }));
  const input = cases.map((c, i) => JSON.stringify({ op: c.op, params: c.params, home: twins[i]![1], now: NOW, env: { PATH: "/usr/bin:/bin" }, brokerParts: c.parts }) + "\n").join("");
  const actual = (await run([driver], input, { PATH: process.env.PATH, TZ: process.env.TZ, HOME: isolated })).trim().split("\n").map(line => JSON.parse(line));
  expect(actual).toHaveLength(cases.length);
  cases.forEach((c, i) => {
    const [ts, rs] = twins[i]!;
    if (c.forwarded) {
      expect(`${c.name}: ${JSON.stringify(actual[i])}`).toBe(`${c.name}: {"forwarded":true}`);
      return;
    }
    expect(`${c.name}: ${JSON.stringify(actual[i])}`).toBe(`${c.name}: ${JSON.stringify(expected[i])}`);
    for (const file of FILES) expect(`${c.name}: ${file} ${read(join(rs, file))}`).toBe(`${c.name}: ${file} ${read(join(ts, file))}`);
  });
  // The matrix must reach every behavior it claims to.
  const text = JSON.stringify(expected);
  for (const fragment of [
    `"until":${NOW + 7200}`, `"until":${NOW + 7 * 86400}`, '"until":1700007200}', '"until":1700000100}', "mode hold until must be a future unix timestamp",
    `"policy":{"source":"project","repoKey":"${KEY}","rev":3`, "Cannot establish repository identity for project routing",
    " · load 3/4", " · load 0/2", " · load 1/2", '"state":"down"', "Host offline", "Invalid option: expected one of",
  ]) expect(text).toContain(fragment);
}, 300_000);

// Front door: native answers against forced forwarding on twin homes, over stdio and HTTP.
const core = JSON.stringify([process.execPath, join(root, "src/cli.ts")]);
const OPS = "mode.hold,routing.route,task.retry_options";
type Step = { op: string; params: unknown; native: boolean };

/** Twin homes differ in their paths and in the moment each one reads its status. */
const normalize = (text: string, dir: string) => text.replaceAll(dir, "<home>")
  .replace(/"(evaluatedAt|validUntil|checkedAt|at|updatedAt|fetchedAt)":[\d.e+-]+/g, '"$1":<t>')
  .replace(/"until":\s*(\d+(\.\d+)?)/g, (_, n) => `"until":${Math.abs(Number(n) - (Date.now() / 1000 + 7 * 86400)) < 600 ? "<week>" : n}`);

async function stdio(dir: string, steps: Step[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: "/usr/bin:/bin", PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
    },
  });
  try {
    child.stdin.write([{ method: "hello", params: { protocol: 3 } }, ...steps.map(s => ({ method: s.op, params: s.params }))]
      .map((request, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...request }) + "\n").join(""));
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const markers = stderr.split("\n").filter(line => OPS.split(",").some(op => line.startsWith(`native ${op} `)));
    const replies = stdout.trim().split("\n").map(line => ({ id: JSON.parse(line).id as number, line })).sort((a, b) => a.id - b.id);
    return { replies: replies.slice(1).map(reply => normalize(reply.line, dir)), markers };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

async function http(dir: string, steps: Step[], forward: boolean) {
  const server = await serve(dir, forward ? OPS : null);
  const replies: string[] = [];
  try { for (const step of steps) replies.push(normalize(await server.post(step.op, step.params), dir)); }
  catch (error) { await server.stop(); throw error; }
  const markers = (await server.stop()).split("\n").filter(line => OPS.split(",").some(op => line === `native ${op}`));
  return { replies, markers };
}

/** `seed` builds the home under `<dir>/.pacer`; replies and the held mode must match forced forwarding. */
async function compare(transport: "stdio" | "http", s: Seed, steps: (ctx: Ctx) => Step[]) {
  const ctx = seed(s, home => join(home, ".pacer"));
  const list = steps(ctx);
  const twins = ["native", "forward"].map(side => { const dir = fresh(`pacer-residue-${transport}-${side}-`); cpSync(ctx.home, dir, { recursive: true }); return dir; });
  const [native, forwarded] = await Promise.all(twins.map((dir, i) => (transport === "stdio" ? stdio : http)(dir, list, i === 1)));
  list.forEach((step, i) => expect(`${step.op} ${JSON.stringify(step.params)}: ${native!.replies[i]}`).toBe(`${step.op} ${JSON.stringify(step.params)}: ${forwarded!.replies[i]}`));
  expect(native!.markers).toEqual(list.flatMap((step, i) => step.native ? [transport === "stdio" ? `native ${step.op} ${i + 2}` : `native ${step.op}`] : []));
  expect(forwarded!.markers).toEqual([]);
  const [held, forwardedHeld] = twins.map(dir => normalize(read(join(dir, ".pacer/state/mode-hold.json")) ?? "none", dir));
  expect(held, "mode-hold.json").toBe(forwardedHeld!);
  return native!.replies;
}

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`${transport}: a host runner keeps routing.route forwarded (F1)`, async () => {
    const replies = await compare(transport, { strategy: REMOTE }, () => [
      { op: "routing.route", params: {}, native: false },
      { op: "routing.route", params: { kind: "tests" }, native: false },
    ]);
    expect(replies[0]).toContain("devbox paused");
  }, 180_000);

  test.skipIf(!front)(`${transport}: routes by repository and project policy natively`, async () => {
    const replies = await compare(transport, { strategy: LOCAL, policy: STRICT, registered: true }, () => [
      { op: "routing.route", params: { repo: KEY, kind: "tests" }, native: true },
      { op: "routing.route", params: { repo: APP }, native: true },
      { op: "routing.route", params: { repo: PLAIN }, native: true },
      { op: "routing.route", params: { repo: "app" }, native: false },
      { op: "routing.route", params: { kind: "nope", repo: "" }, native: true },
    ]);
    expect(replies[0]).toContain(`"policy":{"source":"project","repoKey":"${KEY}"`);
    expect(replies[2]).toContain("Cannot establish repository identity for project routing");
  }, 180_000);

  test.skipIf(!front)(`${transport}: least-loaded routes, held modes and policy retry options answer natively`, async () => {
    let id = "";
    const replies = await compare(transport, { strategy: LEAST, policy: STRICT, registered: true, tasks: running("claude-code", 2) }, ctx => {
      id = task(ctx, "tests", row => { row.executor = "codex"; });
      return [
        { op: "routing.route", params: {}, native: true },
        { op: "routing.route", params: { repo: KEY }, native: true },
        { op: "task.retry_options", params: { id }, native: true },
        { op: "mode.hold", params: { mode: "x" }, native: true },
        { op: "mode.hold", params: { mode: "strict" }, native: true },
      ];
    });
    expect(replies[0]).toContain('"ranked":[]');
    expect(replies[2]).toContain('"id":"cursor"');
    expect(replies[2]).not.toContain('"id":"claude-code"');
    expect(replies[4]).toContain('"until":<week>');
  }, 180_000);
}

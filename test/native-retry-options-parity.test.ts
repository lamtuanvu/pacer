import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import type { ProviderStatus } from "../src/engine/rank";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, withLoginIndicators } from "./helpers";

// Parity for the native `task.retry_options`: the Rust read model receives the
// same usage-broker readings (`accounts` + `providers`) that TypeScript sees
// from `computeStatus`, and both must emit byte-identical JSON.

const root = resolve(import.meta.dir, "..");
const target = process.env.CARGO_TARGET_DIR ?? join(root, ".work", "target-read-model");
const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
type Parts = { accounts: unknown[]; providers: ProviderStatus[] };
type Case = { name: string; home: string; pacerHome: string; now: number; id: string; parts: Parts };

const ACCOUNTS = (home: string) => `planner: codex#work
accounts:
  work: {kind: codex, home: ${join(home, "work")}}
  personal: {kind: codex, home: ${join(home, "personal")}}
  claude: {kind: claude}
  cursor: {kind: cursor}
runners:
  codex#work: {}
  codex#personal: {}
  claude-code: {}
  cursor: {enabled: false}
routing:
  - kinds: [tests]
    executors: [codex#personal, cursor, claude-code, codex#personal, codex#work]
  - default: [claude-code, codex#work, codex#personal]
pacing: {policy: priority, order: [claude-code, codex#personal]}
`;
const CAPPED = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n  codex: {}\n  cursor: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex, claude-code]\nexecution:\n  local_max_tasks: 1\n";
const BROKEN = "planner: [unterminated\n";
const PROVIDERS = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\nrouting:\n  - kinds: [docs]\n    executors: [cursor, codex]\n  - default: [codex, cursor, claude-code]\n";

function ctxFor(strategy: string | ((home: string) => string) | null): Ctx {
  const ctx = withLoginIndicators(fakeCtx());
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  if (strategy !== null) writeFileSync(join(ctx.pacerHome, "strategy.yaml"), typeof strategy === "string" ? strategy : strategy(ctx.home));
  if (strategy !== null && strategy !== BROKEN) loadStrategy(ctx);
  return ctx;
}

function task(ctx: Ctx, kind: string | null, patch: (row: any) => void = () => {}): string {
  const t = createTask(ctx, { brief: { goal: "Goal", repo: ctx.home }, kind, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, row => { row.state = "failed"; patch(row); });
  return t.id;
}

async function parts(ctx: Ctx, mutate: (providers: Record<string, ProviderStatus>) => void = () => {}): Promise<Parts> {
  let status;
  try { status = await computeStatus(ctx, loadStrategy(ctx)); } catch { return { accounts: [], providers: [] }; }
  const out = structuredClone({ accounts: status.accounts, providers: status.providers }) as Parts;
  mutate(Object.fromEntries(out.providers.map(p => [p.id, p])));
  return out;
}

const decision = (state: "ineligible" | "uncertain", now: number) => ({
  state, reasons: [{ code: state === "ineligible" ? "budget_exhausted" : "evidence_stale", evidenceIds: ["e-1"] }],
  evaluatedAt: now - 30, validUntil: now + 600, evidenceAgeS: 30,
  availability: "ready", budget: state === "ineligible" ? "exhausted" : "unknown", spendingRisk: "not_observed",
});

async function scenarios(): Promise<Case[]> {
  const cases: Case[] = [];
  const add = async (name: string, ctx: Ctx, id: string, p: Parts | Promise<Parts>) =>
    cases.push({ name, home: ctx.home, pacerHome: ctx.pacerHome, now: ctx.now, id, parts: await p });

  {
    const ctx = ctxFor(ACCOUNTS);
    const id = task(ctx, "tests", row => { row.result = { executor: "codex#work" }; });
    task(ctx, null, row => { row.state = "running"; row.executor = "claude-code"; });
    await add("kind rule skips the executor that ran; busy, disabled and unknown ids", ctx, id, parts(ctx));
    await add("injected signed-out and blocked readings", ctx, id, parts(ctx, p => {
      p["codex#personal"].signedOutReason = "Signed out of Codex";
      p["claude-code"].blockedReason = "paused";
    }));
    const other = task(ctx, null, row => { row.attempts = [{ executor: "codex#personal", startedAt: 1, endedAt: 2 }]; });
    await add("default rule skips the planner and the last attempt's executor", ctx, other, parts(ctx));
  }
  {
    const ctx = ctxFor(PROVIDERS);
    const docs = task(ctx, "docs", row => { row.executor = "claude-code"; });
    const general = task(ctx, "review", row => { row.executor = "agy"; });
    await add("providers form kind rule", ctx, docs, parts(ctx));
    await add("unknown kind falls back to the default rule", ctx, general, parts(ctx));
    await add("injected unavailable, broken and missing readings", ctx, general, parts(ctx, p => {
      p.codex.unavailableReason = "Host offline";
      p.cursor.brokenReason = "exit 2";
      p["claude-code"].installed = false;
    }));
    await add("injected ineligible and uncertain eligibility", ctx, general, parts(ctx, p => {
      p.codex.eligibility = decision("ineligible", ctx.now) as any;
      p.cursor.eligibility = decision("uncertain", ctx.now) as any;
    }));
    await add("injected exhausted verdict without eligibility", ctx, general, parts(ctx, p => { p.codex.verdict = "EXHAUSTED"; }));
    await add("providers absent from the reading", ctx, general, Promise.resolve({ accounts: [], providers: [] }));
    await add("unknown task", ctx, "t-20261010-190000-dead", parts(ctx));
    await add("malformed task id", ctx, "nope", parts(ctx));
  }
  {
    const ctx = ctxFor(CAPPED);
    const docs = task(ctx, "docs", row => { row.executor = "cursor"; });
    const review = task(ctx, "review", row => { row.executor = "cursor"; });
    await add("accounts-form default planner and kind rule", ctx, docs, parts(ctx));
    await add("kind without a rule or default rule", ctx, review, parts(ctx));
  }
  for (const [name, running] of [
    ["needs_input work on a capped machine", (row: any) => { row.executor = "codex"; row.question = { text: "Which branch?", askedAt: 1 }; }],
    ["running work reaches the local task cap", (row: any) => { row.executor = "claude-code"; }],
  ] as const) {
    const ctx = ctxFor(CAPPED);
    const docs = task(ctx, "docs", row => { row.executor = "cursor"; });
    task(ctx, null, row => { row.state = "running"; running(row); });
    await add(name, ctx, docs, parts(ctx));
  }
  {
    const ctx = ctxFor(null);
    const id = task(ctx, null, row => { row.executor = "claude-code"; });
    await add("missing strategy yields no options", ctx, id, parts(ctx));
  }
  {
    const ctx = ctxFor(BROKEN);
    const id = task(ctx, null);
    await add("unloadable strategy yields no options", ctx, id, parts(ctx));
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
const {toApiError} = await import(${JSON.stringify(join(root, "src/api/protocol.ts"))});
const out = [];
for (const c of await new Response(Bun.stdin.stream()).json()) {
  injected = c.parts;
  const ctx = {home: c.home, pacerHome: c.pacerHome, now: c.now, env: {}, which: () => "/usr/bin/fake", run: async () => ({code: 127, stdout: "", stderr: "not available in tests"})};
  try { out.push({result: await callOp(ctx, "task.retry_options", {id: c.id})}); }
  catch (error) { const e = toApiError(error); out.push({error: {code: e.code, message: e.message}}); }
}
process.stdout.write(JSON.stringify(out) + "\\n", () => process.exit(0));
`;

async function run(argv: string[], input: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(argv, { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
  await child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(`${argv[0]} exited ${code}: ${stderr}`);
  return stdout;
}

let cases: Case[] = [];
const isolated = mkdtempSync(join(tmpdir(), "pacer-retry-reference-"));
beforeAll(async () => {
  cases = await scenarios();
  await run(["cargo", "build", "-q", "--locked", "-p", "pacer-read-model", "--example", "retry_options_probe"], "", { ...process.env, CARGO_TARGET_DIR: target });
}, 600_000);
afterAll(() => { for (const home of [isolated, ...cases.map(c => c.home)]) rmSync(home, { recursive: true, force: true }); });

test("Rust retry options match TypeScript byte for byte with injected broker readings", async () => {
  const expected = JSON.parse(await run([process.execPath, "-e", reference], JSON.stringify(cases), { PATH: process.env.PATH, TZ: process.env.TZ, HOME: isolated, PACER_HOME: join(isolated, ".pacer") }));
  const probe = join(resolve(root, target), "debug", "examples", "retry_options_probe");
  const actual = (await run([probe], cases.map(c => JSON.stringify(c) + "\n").join(""))).trim().split("\n");
  expect(actual).toHaveLength(cases.length);
  cases.forEach((c, i) => expect(`${c.name}: ${actual[i]}`).toBe(`${c.name}: ${JSON.stringify(expected[i])}`));
  // The matrix must exercise every state and reason family it claims to.
  const text = JSON.stringify(expected);
  for (const fragment of ['"reason":"busy"', '"state":"disabled"', '"reason":"not configured"', '"reason":"available"', "signed out", "Signed out of Codex", '"state":"blocked"', "Host offline", '"reason":"exit 2"', "not installed", '"reason":"planner"', '"code":"unknown_task"', '"result":[]', '"state":"exhausted"']) {
    expect(text).toContain(fragment);
  }
}, 120_000);

const core = JSON.stringify([process.execPath, join(root, "src/cli.ts")]);
async function exchange(home: string, params: unknown, forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: "task.retry_options" } : {}),
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n"
      + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.retry_options", params }) + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const native = stderr.split("\n").some(line => line === "native task.retry_options 2");
    return { reply: stdout.trim().split("\n")[1], native };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

async function compare(ctx: Ctx, params: unknown, expectNative: boolean) {
  const homes = ["native", "forward"].map(name => mkdtempSync(join(tmpdir(), `pacer-retry-${name}-`)));
  try {
    for (const home of homes) cpSync(ctx.home, home, { recursive: true });
    const native = await exchange(homes[0], params, false);
    const forwarded = await exchange(homes[1], params, true);
    expect(forwarded.native).toBe(false);
    expect(native.native).toBe(expectNative);
    expect(native.reply).toBe(forwarded.reply);
    return JSON.parse(native.reply);
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}

test.skipIf(!front)("front door serves task.retry_options natively and matches forced forwarding", async () => {
  const ctx = ctxFor(PROVIDERS);
  try {
    const id = task(ctx, "docs", row => { row.executor = "claude-code"; });
    task(ctx, null, row => { row.state = "running"; row.executor = "codex"; });
    const reply = await compare(ctx, { id }, true);
    expect(reply.result.map((r: { id: string }) => r.id)).toEqual(["cursor", "codex"]);
    await compare(ctx, { id: "t-20261010-190000-dead" }, true);
    for (const params of [{}, { id: 7 }, { id: "" }, { id: "x".repeat(129) }, []]) await compare(ctx, params, true);
  } finally {
    rmSync(ctx.home, { recursive: true, force: true });
  }
}, 180_000);

test.skipIf(!front)("project policy, remote runners and unloadable strategies stay forwarded", async () => {
  const policy = ctxFor(PROVIDERS);
  const remote = ctxFor("planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\nrunners:\n  claude-code: {}\n  codex@devbox: {}\n");
  const broken = ctxFor(BROKEN);
  const missing = ctxFor(null);
  try {
    const id = task(policy, null);
    writeFileSync(join(policy.pacerHome, "project-strategies.json"), "{}");
    await compare(policy, { id }, false);
    await compare(remote, { id: task(remote, null) }, false);
    await compare(broken, { id: task(broken, null) }, false);
    await compare(missing, { id: task(missing, null) }, false);
  } finally {
    for (const ctx of [policy, remote, broken, missing]) rmSync(ctx.home, { recursive: true, force: true });
  }
}, 180_000);

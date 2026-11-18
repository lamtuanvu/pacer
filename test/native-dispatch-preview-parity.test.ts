import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadStrategy } from "../src/config/strategy";
import { pause } from "../src/core/pause";
import { dispatchSettingsHash } from "../src/dispatch/learning";
import { dispatchDatabase } from "../src/dispatch/store";
import { orcaWorktreeName } from "../src/exec/orca/names";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, withLoginIndicators } from "./helpers";
import { git } from "./native-repo-front-door";
import { closedPort, spawnPinned } from "./port-isolation";

// Parity for the native `dispatch.preview` and `dispatch.explain` with the ladder engine. The driver
// receives the usage-broker parts and the dispatch parts (`_internal.dispatch.parts`) TypeScript computes
// for the same home and must answer with the same bytes; the front door is compared with forced
// forwarding on twin homes over stdio, HTTP and MCP.

const root = resolve(import.meta.dir, "..");
const NOW = 1_800_000_000.25;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const fresh = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };

// Checkouts and executables outside every home, so the twins see identical paths.
const shared = fresh("pacer-preview-repos-");
const APP = join(shared, "app"), PLAIN = join(shared, "plain"), KEY = "github.com/acme/app";
mkdirSync(APP);
mkdirSync(PLAIN);
git(APP, "init", "-q", "-b", "main");
git(APP, "commit", "-q", "--allow-empty", "-m", "x");
git(APP, "remote", "add", "origin", "https://github.com/acme/app.git");

/** Executables answering `--version`; with `codexFails` codex exits 1. */
function executables(dir: string, codexFails = false): string {
  mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  script("claude", 'echo "2.1.281 (Claude Code)"');
  script("codex", codexFails ? 'echo "codex: broken install" >&2; exit 1' : 'echo "codex-cli 0.164.0"');
  script("cursor-agent", 'echo "2026.11.01-abc"');
  script("opencode", 'echo "1.2.3"');
  return dir;
}
const BIN = executables(join(shared, "bin")), BROKEN = executables(join(shared, "broken"), true);

const LADDER = `planner: claude-code
accounts:
  claude: {kind: claude}
  work: {kind: claude, source: pacer, home: ~/claude-work}
  codex: {kind: codex}
  cursor: {kind: cursor}
  ep: {kind: endpoint, usage: unmetered}
execution:
  launch_mode: headless
runners:
  claude-code#work: {models: [{id: opus, tier: frontier}]}
  codex: {models: [{id: gpt-x, tier: medium}], max_tasks: 2}
  cursor: {models: [{id: mid, tier: medium}]}
  opencode#ep: {model: vendor/m}
`;
const LEARNING = `${LADDER}dispatch:\n  learning: {enabled: true, minSamples: 20, maxAgeDays: 90}\n`;
const PLUGIN = `${LADDER}dispatch:\n  engine: plugin:acme\n  engineFallback: ladder\n`;
const REMOTE = `${LADDER}  codex@devbox: {}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n`;
const POLICY = JSON.stringify({ version: 1, projects: { [KEY]: { rev: 3, executors: ["codex#codex@local", "cursor#cursor@local", "opencode#ep@local"] } } });
const REGISTRY = JSON.stringify({ [APP]: { key: KEY, path: APP, lastUsed: 1 } });

type Seed = { strategy: string; policy?: string; registered?: boolean; setup?: (ctx: Ctx) => void };

/** A home whose data directory is `pacerHome`. */
function seed(s: Seed, pacerHome = (home: string) => home): Ctx {
  const home = fresh("pacer-preview-seed-");
  const ctx = withLoginIndicators(fakeCtx({ home, pacerHome: pacerHome(home), now: NOW }));
  mkdirSync(join(home, "claude-work"));
  writeFileSync(join(home, "claude-work", ".claude.json"), '{"oauthAccount":{}}');
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), s.strategy);
  if (s.policy !== undefined) writeFileSync(join(ctx.pacerHome, "project-strategies.json"), s.policy);
  if (s.registered) writeFileSync(join(ctx.pacerHome, "state/repos.json"), REGISTRY);
  s.setup?.(ctx);
  return ctx;
}

const running = (executor: string) => (ctx: Ctx) => {
  const t = createTask(ctx, { brief: { goal: "Goal", repo: APP }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, row => { row.state = "running"; row.executor = executor; });
};
/** Twenty human reviews each (codex always accepted, cursor once in three) of the models both runners report. */
const reviews = (ctx: Ctx) => {
  running("cursor")(ctx);
  dispatchDatabase(ctx);
  const strategy = loadStrategy(ctx), db = new Database(join(ctx.pacerHome, "state", "tasks.db"));
  for (const [runner, model] of [["codex", "gpt-x"], ["cursor", "mid"]]) {
    db.query("INSERT INTO work_observations VALUES (?,?,?)").run(`actual-${runner}`, 1_700_000_000, JSON.stringify({ source: "runner",
      scope: { runner, account: runner, binding: { kind: "exact", id: model } }, method: "actual-model", state: "known",
      observedAt: 1_700_000_000, expiresAt: 1_900_000_000, value: { model } }));
  }
  const insert = db.query("INSERT INTO work_reviews VALUES (?,?,?,?,?)");
  for (let i = 0; i < 20; i++) {
    for (const [runner, model, accepted] of [["codex", "gpt-x", true], ["cursor", "mid", i % 3 === 0]] as const) {
      insert.run(`${runner}-${i}`, 1, NOW - 100 - i, "human", JSON.stringify({ repo: APP, kind: "debug", difficulty: "standard", runner, model,
        settings: dispatchSettingsHash(strategy, runner), accepted, at: NOW - 100 - i, provenance: "human" }));
    }
  }
  db.close();
};
const TASK = "t-20261114-000000-abcd";
/** The slot the session holds, as a preview ("Cursor busy (1/1)") and an explanation word it. */
const SESSION_SLOT = /Cursor (is )?busy \(1\/1/;
/** A `starting` cursor session: it holds a slot, and only Core probes agent sessions. */
const agentSession = (createdAt: number) => (ctx: Ctx) => {
  const db = new Database(join(ctx.pacerHome, "state", "tasks.db"));
  db.run("CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, record TEXT NOT NULL)");
  const record = { id: "s1", task_id: TASK, ordinal: 1, executor: "cursor", request: "r", cwd: APP, createdAt, rev: 1, attempt: 1, state: "starting", attempts: [] };
  db.query("INSERT INTO agent_sessions VALUES (?,?,?,?,?)").run("s1", TASK, "r1", "{}", JSON.stringify(record));
  db.close();
};
const hostSeen = (at: number) => (ctx: Ctx) => {
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "cache", "hosts.json"), JSON.stringify({ devbox: { alias: "devbox", reachable: true, at, failures: 0 } }));
};

const ready = { verdict: "OK", stale: false, eligibility: { state: "eligible", reasons: [], evaluatedAt: NOW, validUntil: null, evidenceAgeS: null, availability: "ready", budget: "not_required", spendingRisk: "unknown" } };
const measured = { stale: false, capturedAt: NOW - 30 };
const week = (usedPct: number) => [{ name: "weekly", usedPct, resetsAt: NOW + 86400, stale: false, rolled: false }];
/** Eligible executors; codex and the endpoint have measured capacity. Keys `account:<name>` patch accounts. */
const EVERYONE = { "claude-code#work": ready, codex: { ...ready, windows: week(40) }, cursor: ready, "opencode#ep": ready, "account:codex": measured, "account:ep": measured };
const DOWN = { "claude-code#work": { installed: false }, codex: { unavailableReason: "Host offline" }, cursor: { installed: false }, "opencode#ep": { unavailableReason: "Host offline" } };

type Case = {
  name: string; op: "dispatch.preview" | "dispatch.explain"; params: unknown; ctx: Ctx;
  patch?: Record<string, object>; bin?: string; certify?: string[]; env?: Record<string, string>; forwarded?: boolean;
};

const goal = (extra: object = {}) => ({ repo: APP, goal: "Fix the flaky login test", ...extra });
const explain = (extra: object = {}) => goal({ kind: "debug", via: "dispatch", ...extra });

function scenarios(): Case[] {
  const cases: Case[] = [];
  const add = (name: string, ctx: Ctx, op: Case["op"], params: unknown, more: Partial<Case> = {}) => cases.push({ name, op, params, ctx, ...more });
  const P = "dispatch.preview", E = "dispatch.explain";

  const home = seed({ strategy: LADDER, registered: true, setup: running("codex") });
  // Before any preview, no `--version` result is cached in the reference process.
  add("explain before any version check is unverified", home, E, explain(), { patch: EVERYONE });
  add("strict preview: certified claude, unsupported codex, cursor and opencode", home, P, goal({ kind: "debug" }), { patch: EVERYONE, certify: ["claude-code#work"] });
  add("strict preview: uncertified claude", home, P, goal({ kind: "debug" }), { patch: EVERYONE });
  add("strict preview: codex --version fails", home, P, goal({ kind: "review" }), { patch: EVERYONE, bin: BROKEN });
  add("cooperative preview", home, P, goal({ kind: "debug", delegationEnforcement: "cooperative" }), { patch: EVERYONE });
  add("cooperative preview with requirements and preferences", home, P, goal({ delegationEnforcement: "cooperative",
    requirements: { minTier: "frontier", tools: true, context: 200000 }, preferences: { models: ["opus"], strengths: ["debugging"] }, model: "gpt-x" }), { patch: EVERYONE });
  add("a frontier requirement nothing allowed meets", home, P, goal({ requirements: { minTier: "frontier" } }), { patch: EVERYONE });
  const tight = { ...EVERYONE, codex: { ...ready, windows: week(95) }, "opencode#ep": { installed: false } };
  add("ladder falls back to a usable executor", home, P, goal({ kind: "debug", delegationEnforcement: "cooperative" }), { patch: tight });
  add("explain the usable fallback", home, E, explain({ delegationEnforcement: "cooperative" }), { patch: tight });
  add("nothing available queues", home, P, goal({ delegationEnforcement: "cooperative" }), { patch: DOWN });
  add("default status readings", home, P, goal({ delegationEnforcement: "cooperative" }));
  add("preview by repository key", home, P, { repo: KEY, goal: "g", delegationEnforcement: "cooperative" }, { patch: EVERYONE });
  add("preview registers an unregistered checkout", home, P, { repo: PLAIN, goal: "g", delegationEnforcement: "cooperative" }, { patch: EVERYONE });
  add("explain after the version check, certified claude", home, E, explain(), { patch: EVERYONE, certify: ["claude-code#work"] });
  add("explain cooperative", home, E, explain({ delegationEnforcement: "cooperative", difficulty: "complex" }), { patch: EVERYONE });
  add("explain with planner delegation allowed", home, E, explain({ delegationEnforcement: "cooperative", allowDelegation: true }), { patch: EVERYONE });
  add("explain with an executor override", home, E, explain({ executor: "codex", delegationEnforcement: "cooperative" }), { patch: EVERYONE });
  add("explain with an excluded override", home, E, explain({ executor: "cursor" }), { patch: DOWN });
  add("explain the delegate route", home, E, goal({ kind: "debug" }), { patch: EVERYONE });
  add("explain the delegate route with an override", home, E, goal({ kind: "debug", executor: "opencode#ep" }), { patch: EVERYONE });
  add("explain a strategy draft", home, E, explain({ strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "fail" } } } }), { patch: DOWN });
  add("explain an invalid strategy draft", home, E, explain({ strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "bogus" } } } }));
  add("explain an unknown kind", home, E, explain({ kind: "nope" }));
  add("explain an unknown executor", home, E, explain({ executor: "nope" }));

  const policy = seed({ strategy: LADDER, policy: POLICY, registered: true });
  add("strict preview within a project policy", policy, P, goal({ kind: "debug" }), { patch: EVERYONE });
  add("explain within a project policy", policy, E, explain({ delegationEnforcement: "cooperative" }), { patch: EVERYONE });
  add("project policy refuses an unverified checkout", policy, P, { repo: PLAIN, goal: "g" }, { patch: EVERYONE });

  const learned = seed({ strategy: LEARNING, registered: true, setup: reviews });
  add("learned fit on: preview", learned, P, goal({ kind: "debug", delegationEnforcement: "cooperative" }), { patch: EVERYONE });
  add("learned fit on: explain", learned, E, explain({ delegationEnforcement: "cooperative" }), { patch: EVERYONE });
  const unlearned = seed({ strategy: LADDER, registered: true, setup: reviews });
  add("learned fit off: preview", unlearned, P, goal({ kind: "debug", delegationEnforcement: "cooperative" }), { patch: EVERYONE });
  add("learning without a history store", seed({ strategy: LEARNING, registered: true }), E, explain({ delegationEnforcement: "cooperative" }), { patch: EVERYONE });

  const paused = seed({ strategy: LADDER, registered: true, setup: ctx => { pause(ctx, { for: "2h", reason: "maintenance" }); } });
  add("explain while paused", paused, E, explain({ delegationEnforcement: "cooperative" }), { patch: EVERYONE });

  // Forwarded: TypeScript answers.
  add("plugin engine forwards", seed({ strategy: PLUGIN, registered: true }), P, goal({ delegationEnforcement: "cooperative" }), { forwarded: true });
  add("plugin engine explain forwards", seed({ strategy: PLUGIN, registered: true }), E, explain(), { forwarded: true });
  add("explain without a kind forwards", home, E, goal({ via: "dispatch" }), { forwarded: true });
  add("relative repository forwards", home, P, { repo: "app", goal: "g" }, { forwarded: true });
  add("explain with a relative repository forwards", home, E, explain({ repo: "app" }), { forwarded: true });
  add("host runner with cached reachability forwards", seed({ strategy: REMOTE, registered: true, setup: hostSeen(NOW - 10) }), P,
    goal({ delegationEnforcement: "cooperative" }), { forwarded: true });
  add("work-grant caller on explain forwards", home, E, explain(), { forwarded: true, env: { PACER_WORK_GRANT: "grant" } });
  const sessions = seed({ strategy: LADDER, registered: true, setup: agentSession(NOW - 10) });
  add("a live agent session keeps preview forwarded", sessions, P, goal({ kind: "debug", delegationEnforcement: "cooperative" }), { forwarded: true });
  add("a live agent session keeps explain forwarded", sessions, E, explain({ delegationEnforcement: "cooperative" }), { forwarded: true });
  add("unloadable strategy forwards", seed({ strategy: "planner: [\n" }), P, goal(), { forwarded: true });
  add("conversation explain forwards", home, E, goal({ kind: "debug", interactionMode: "conversation" }), { forwarded: true });
  add("input only TypeScript describes forwards", home, P, goal({ requirements: { tools: ["shell"] } }), { forwarded: true });
  add("refused input forwards", home, P, { repo: APP, goal: "" }, { forwarded: true });
  return cases;
}

const reference = `
import {mock} from "bun:test";
import {existsSync} from "node:fs";
import {join} from "node:path";
const statusPath = ${JSON.stringify(join(root, "src/engine/status.ts"))};
const actual = {...await import(statusPath)};
let injected = null;
mock.module(statusPath, () => ({...actual, computeStatus: async (...args) => ({...await actual.computeStatus(...args), ...injected})}));
const {callOp} = await import(${JSON.stringify(join(root, "src/api/ops.ts"))});
const {toApiError} = await import(${JSON.stringify(join(root, "src/api/errors.ts"))});
const {defaultRun} = await import(${JSON.stringify(join(root, "src/ctx.ts"))});
const {loadStrategy} = await import(${JSON.stringify(join(root, "src/config/strategy.ts"))});
const {draftStrategy} = await import(${JSON.stringify(join(root, "src/strategy/service.ts"))});
const {dispatchPartsFor} = await import(${JSON.stringify(join(root, "src/api/dispatch-parts-bridge.ts"))});
const {certifyExecutor, resolveEnforcementTarget} = await import(${JSON.stringify(join(root, "src/dispatch/enforcement.ts"))});
const out = [];
for (const c of await new Response(Bun.stdin.stream()).json()) {
  const which = name => existsSync(join(c.bin, name)) ? join(c.bin, name) : null;
  const ctx = {home: c.home, pacerHome: c.home, now: c.now, env: {PATH: c.bin + ":/usr/bin:/bin", ...c.env}, which, run: defaultRun};
  const ro = {...ctx, readOnly: true}, draft = c.params?.strategyDraft;
  injected = null;
  let statusParts = null, dispatchParts = null;
  try {
    const strategy = draft ? draftStrategy(ro, draft) : loadStrategy(ctx);
    for (const runner of c.certify) await certifyExecutor(ctx, await resolveEnforcementTarget(ctx, strategy, runner, c.repo), async () => ({attempted: true, blocked: true, childStarted: false}));
    if (!c.forwarded) {
      const parts = actual.statusBrokerParts(await actual.computeStatus(ro, strategy, {cacheOnly: true}));
      for (const provider of parts.providers) Object.assign(provider, c.patch[provider.id] ?? {});
      for (const account of parts.accounts) Object.assign(account, c.patch["account:" + account.name] ?? {});
      injected = {accounts: parts.accounts, providers: parts.providers};
      statusParts = parts;
      const runners = Object.keys(strategy.runners), extra = draft ? {draft} : {};
      dispatchParts = {
        guards: await dispatchPartsFor(ctx, {kind: "dispatch.executor-guards", runners, ...extra}),
        enforcement: await dispatchPartsFor(ctx, {kind: "dispatch.enforcement-exclusions", repo: c.repo, runners, cached: c.op === "dispatch.explain", ...extra}),
      };
    }
  } catch {}
  let reply;
  try { reply = {result: await callOp(ctx, c.op, c.params)}; } catch (error) { reply = {error: toApiError(error)}; }
  out.push({reply, statusParts, dispatchParts});
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
/**
 * Every entry under `dir` with its size and modification time. Any WAL reader takes read marks in the
 * `-shm` index, so that file keeps only its size.
 */
function tree(dir: string, prefix = ""): string[] {
  let names: string[];
  try { names = readdirSync(join(dir, prefix)).sort(); } catch { return []; }
  return names.flatMap(name => {
    const path = join(prefix, name), st = lstatSync(join(dir, path));
    return st.isDirectory() ? [`${path}/`, ...tree(dir, path)] : [`${path} ${st.size}${name.endsWith("-shm") ? "" : ` ${st.mtimeMs}`}`];
  });
}

test("Rust previews and explains ladder dispatch like TypeScript", async () => {
  const cases = scenarios();
  const twins = cases.map(c => ["ts", "rs"].map(side => {
    const dir = fresh(`pacer-preview-${side}-`);
    cpSync(c.ctx.home, dir, { recursive: true });
    return dir;
  }) as [string, string]);
  const isolated = fresh("pacer-preview-reference-");
  const expected = JSON.parse(await run([process.execPath, "-e", reference], JSON.stringify(cases.map((c, i) => ({
    op: c.op, params: c.params, home: twins[i]![0], now: NOW, bin: c.bin ?? BIN, env: c.env ?? {}, patch: c.patch ?? {},
    certify: c.certify ?? [], repo: APP, forwarded: !!c.forwarded,
  }))), { PATH: process.env.PATH, TZ: process.env.TZ, HOME: isolated, PACER_HOME: join(isolated, ".pacer") }));
  const before = twins.map(([, rs]) => tree(rs));
  const input = cases.map((c, i) => JSON.stringify({ op: c.op, params: c.params, home: twins[i]![1], now: NOW,
    env: { PATH: `${c.bin ?? BIN}:/usr/bin:/bin`, ...c.env }, statusParts: expected[i].statusParts, dispatchParts: expected[i].dispatchParts }) + "\n").join("");
  const actual = (await run([driver], input, { PATH: process.env.PATH, TZ: process.env.TZ, HOME: isolated })).trim().split("\n").map(line => JSON.parse(line));
  expect(actual).toHaveLength(cases.length);
  cases.forEach((c, i) => {
    const [ts, rs] = twins[i]!;
    if (c.forwarded) {
      expect(`${c.name}: ${JSON.stringify(actual[i])}`).toBe(`${c.name}: {"forwarded":true}`);
      return;
    }
    const { bridge, ...reply } = actual[i];
    expect(`${c.name}: ${JSON.stringify(reply)}`).toBe(`${c.name}: ${JSON.stringify(expected[i].reply)}`);
    expect(`${c.name}: ${read(join(rs, "state/repos.json"))}`).toBe(`${c.name}: ${read(join(ts, "state/repos.json"))}`);
    // Explain writes nothing: no file is created, grown or touched.
    if (c.op === "dispatch.explain") expect(`${c.name}: ${tree(rs).join("\n")}`).toBe(`${c.name}: ${before[i]!.join("\n")}`);
    // Previews check versions; explanations read only the cached ones.
    const enforcement = (bridge as { kind?: string; cached?: boolean }[]).filter(b => b.kind === "dispatch.enforcement-exclusions");
    for (const request of enforcement) expect(`${c.name}: cached ${request.cached}`).toBe(`${c.name}: cached ${c.op === "dispatch.explain"}`);
  });
  // The matrix must reach every behavior it claims to.
  const text = JSON.stringify(expected.map((e: { reply: unknown }) => e.reply));
  for (const fragment of [
    '"code":"enforcement_unverified"', "Codex tool-result observation is not implemented", "Cursor has not proven", "OpenCode permission denial",
    "Could not verify codex version", "Native subagent control has not been verified", '"learnedFit":', "usable-fallback", '"outcome":"override"',
    '"code":"paused"', "Invalid strategy draft", 'Unknown kind \\"nope\\"', 'Unknown executor \\"nope\\"', "Cannot establish repository identity",
    '"engine":{"id":"ladder","version":"1"}', '"requestId":"', '"strategyHash":"', "Cursor busy (1/1)",
  ]) expect(text).toContain(fragment);
  // Every forwarded case still has a TypeScript answer.
  cases.forEach((c, i) => { if (c.forwarded) expect(`${c.name}: ${JSON.stringify(expected[i].reply).slice(0, 10)}`).toMatch(/: \{"(result|error)"/); });
  // Core counts the live session's slot.
  cases.forEach((c, i) => { if (c.name.startsWith("a live agent session")) expect(`${c.name}: ${JSON.stringify(expected[i].reply)}`).toMatch(SESSION_SLOT); });
}, 300_000);

// Front door: native answers against forced forwarding on twin homes.
const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(root, "src/cli.ts")]);
const OPS = "dispatch.preview,dispatch.explain";
type Step = { op: string; params: unknown; native: boolean };

/**
 * Previews read the usage readings Core has cached, which its background refresh fills at a moment of its
 * choosing. A route Core answers first (always forwarded) reads every account and fills them.
 */
const WARM = ["routing.route", {}] as const;

const env = (dir: string, port: string, forward: boolean) => ({
  HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: core, PACER_PORT: port,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", TZ: process.env.TZ ?? "UTC",
  PACER_FORWARD_OPS: forward ? `${WARM[0]},${OPS}` : WARM[0],
});

/** Twin homes differ in their paths and in the moment each one answers; MCP text repeats the reply as escaped JSON. */
const TIMES = "lastUsed|now|deadline|evaluatedAt|validUntil|checkedAt|at|updatedAt|fetchedAt|observedAt|expiresAt|until|since";
const normalize = (text: string, dir: string) => text.replaceAll(dir, "<home>")
  .replace(new RegExp(`(\\\\?"(?:${TIMES})\\\\?":\\s*)[\\d.e+-]+`, "g"), "$1<t>")
  .replace(/(\\?"(?:requestId|observationRevision|inputHash|revision)\\?":\s*\\?")[0-9a-f]+/g, "$1<id>");

/** Lockstep JSON-RPC: Core answers forwarded requests concurrently, so each waits for the one before. */
async function stdio(dir: string, steps: Step[], forward: boolean, cwd = dir) {
  const child = spawnPinned([front!, "api", "--stdio"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: env(dir, closedPort(), forward) });
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    let buffered = "";
    const reply = async (id: number) => {
      for (;;) {
        const at = buffered.indexOf("\n");
        if (at >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          if (JSON.parse(line).id === id) return line;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`stdio closed: ${await stderr}`);
        buffered += new TextDecoder().decode(value);
      }
    };
    const replies: string[] = [];
    for (const [i, request] of [{ method: "hello", params: { protocol: 3 } }, ...steps.map(s => ({ method: s.op, params: s.params }))].entries()) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...request }) + "\n");
      replies.push(normalize(await reply(i + 1), dir));
    }
    await child.stdin.end();
    expect(await child.exited, await stderr).toBe(0);
    const markers = (await stderr).split("\n").filter(line => OPS.split(",").some(op => line.startsWith(`native ${op} `)));
    return { replies: replies.slice(1), markers };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

async function serve(dir: string, forward: boolean, cwd = dir) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", port], { cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: env(dir, port, forward) });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "", up = false;
  for (let n = 0; n < 1000 && !up; n++) {
    try {
      token = readFileSync(join(dir, ".pacer/token"), "utf8").trim();
      up = (await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!up) await Bun.sleep(20);
  }
  if (!up) { child.kill("SIGTERM"); await child.exited; throw new Error(`serve did not start: ${await stderr}`); }
  // The service refreshes every account after its first usage loop; previews in between read a cache being replaced.
  const usageLoop = () => { try { return JSON.parse(readFileSync(join(dir, ".pacer/state/background-worker.json"), "utf8")).loops?.usage; } catch { return undefined; } };
  for (let n = 0; n < 1500 && !usageLoop(); n++) await Bun.sleep(20);
  if (!usageLoop()) { child.kill("SIGTERM"); await child.exited; throw new Error(`no usage loop: ${await stderr}`); }
  return {
    port,
    post: async (op: string, body: unknown) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      return normalize(`${response.status} ${await response.text()}`, dir);
    },
    markers: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => OPS.split(",").some(op => line === `native ${op}`)); },
  };
}

async function http(dir: string, steps: Step[], forward: boolean, cwd = dir) {
  const server = await serve(dir, forward, cwd);
  const replies: string[] = [];
  try { for (const step of steps) replies.push(await server.post(step.op, step.params)); }
  catch (error) { await server.markers(); throw error; }
  return { replies, markers: await server.markers() };
}

/** `pacer mcp` (the TypeScript MCP server) reaching the front door's HTTP service. */
async function mcp(dir: string, steps: Step[], forward: boolean, cwd = dir) {
  const server = await serve(dir, forward, cwd);
  const replies: string[] = [];
  try {
    await server.post(...WARM);
    const child = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "mcp"], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...env(dir, server.port, false), PACER_PLANNER_SESSION: "claude-code" } });
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...steps.map((step, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { name: "dispatch_preview", arguments: step.params } })),
    ];
    const reader = child.stdout.getReader();
    let buffered = "";
    const line = async () => {
      while (!buffered.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("mcp closed");
        buffered += new TextDecoder().decode(value);
      }
      const at = buffered.indexOf("\n"), text = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      return text;
    };
    child.stdin.write(JSON.stringify(frames[0]) + "\n" + JSON.stringify(frames[1]) + "\n");
    await line();
    for (const frame of frames.slice(2)) {
      child.stdin.write(JSON.stringify(frame) + "\n");
      replies.push(normalize(await line(), dir));
    }
    child.stdin.end();
    child.kill("SIGTERM");
    await child.exited;
  } catch (error) { await server.markers(); throw error; }
  return { replies, markers: await server.markers() };
}


/** `seed` builds the home under `<dir>/.pacer` with executables in `<dir>/bin`; the front door runs in `<dir>/<cwd>`. */
async function compare(transport: "stdio" | "http" | "mcp", s: Seed, list: Step[], bin = BIN, cwd = "") {
  const steps = transport === "mcp" ? list : [{ op: WARM[0], params: WARM[1], native: false }, ...list];
  const ctx = seed(s, home => join(home, ".pacer"));
  cpSync(bin, join(ctx.home, "bin"), { recursive: true });
  const twins = ["native", "forward"].map(side => { const dir = fresh(`pacer-preview-${transport}-${side}-`); cpSync(ctx.home, dir, { recursive: true }); return dir; });
  const [native, forwarded] = await Promise.all(twins.map((dir, i) => ({ stdio, http, mcp })[transport](dir, steps, i === 1, join(dir, cwd))));
  steps.forEach((step, i) => expect(`${step.op} ${JSON.stringify(step.params)}: ${native!.replies[i]}`).toBe(`${step.op} ${JSON.stringify(step.params)}: ${forwarded!.replies[i]}`));
  expect(native!.markers).toEqual(steps.flatMap((step, i) => step.native ? [transport === "stdio" ? `native ${step.op} ${i + 2}` : `native ${step.op}`] : []));
  expect(forwarded!.markers).toEqual([]);
  const [registry, forwardedRegistry] = twins.map(dir => normalize(read(join(dir, ".pacer/state/repos.json")) ?? "none", dir));
  expect(registry, "repos.json").toBe(forwardedRegistry!);
  return native!.replies.slice(steps.length - list.length);
}

const P = "dispatch.preview", E = "dispatch.explain";
// Core's background certification check may cache the planner binary's version at any time, so
// explanations follow a preview, which checks every version first.
const FRONT: Step[] = [
  { op: P, params: goal({ kind: "debug" }), native: true },
  { op: P, params: goal({ delegationEnforcement: "cooperative" }), native: true },
  { op: P, params: { repo: KEY, goal: "g", kind: "docs" }, native: true },
  { op: P, params: { repo: PLAIN, goal: "g", delegationEnforcement: "cooperative" }, native: true },
  { op: E, params: explain(), native: true },
  { op: E, params: goal({ kind: "debug" }), native: true },
  { op: E, params: explain({ executor: "codex", delegationEnforcement: "cooperative" }), native: true },
  { op: E, params: explain({ strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "fail" } } } }), native: true },
  { op: E, params: explain({ kind: "nope" }), native: true },
  { op: E, params: goal({ via: "dispatch" }), native: false },
  { op: P, params: { repo: "app", goal: "g" }, native: false },
  { op: P, params: { repo: APP, goal: "" }, native: false },
];

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`${transport}: previews and explains ladder dispatch natively`, async () => {
    const replies = await compare(transport, { strategy: LADDER, registered: true, setup: running("codex") }, FRONT);
    expect(replies[0]).toContain("Codex tool-result observation is not implemented");
    expect(replies[2]).toContain('"task":{"kind":"docs"');
  }, 180_000);

  test.skipIf(!front)(`${transport}: a failing --version, a project policy and learned fit`, async () => {
    const replies = await compare(transport, { strategy: LEARNING, policy: POLICY, registered: true, setup: reviews }, [
      { op: P, params: goal({ kind: "debug" }), native: true },
      { op: E, params: explain({ delegationEnforcement: "cooperative" }), native: true },
      { op: P, params: { repo: PLAIN, goal: "g" }, native: true },
    ], BROKEN);
    expect(replies[0]).toContain("Could not verify codex version");
    expect(replies[2]).toContain("Cannot establish repository identity");
  }, 180_000);

  test.skipIf(!front)(`${transport}: a plugin engine, a host runner and an unloadable strategy stay forwarded`, async () => {
    for (const strategy of [PLUGIN, REMOTE, "planner: [\n"]) {
      await compare(transport, { strategy, registered: true, setup: hostSeen(Date.now() / 1000 - 10) }, [
        { op: P, params: goal({ delegationEnforcement: "cooperative" }), native: false },
        { op: E, params: explain(), native: false },
      ]);
    }
  }, 180_000);
}

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`${transport}: a live agent session keeps preview and explain forwarded`, async () => {
    const replies = await compare(transport, { strategy: LADDER, registered: true, setup: agentSession(Date.now() / 1000) }, [
      { op: P, params: goal({ kind: "debug", delegationEnforcement: "cooperative" }), native: false },
      { op: E, params: explain({ delegationEnforcement: "cooperative" }), native: false },
    ]);
    for (const reply of replies) expect(reply).toMatch(SESSION_SLOT);
  }, 180_000);

  test.skipIf(!front)(`${transport}: an explain from an executor session stays forwarded`, async () => {
    const provider = Object.keys(loadStrategy(seed({ strategy: LADDER })).providers)[0]!;
    for (const cwd of [`.pacer/worktrees/app/${TASK}`, `orca/workspaces/acme/pacer-${TASK}-${orcaWorktreeName(provider)}`]) {
      const replies = await compare(transport, { strategy: LADDER, registered: true, setup: ctx => { mkdirSync(join(ctx.home, cwd), { recursive: true }); } }, [
        { op: E, params: explain({ delegationEnforcement: "cooperative" }), native: false },
        { op: E, params: goal({ kind: "debug" }), native: false },
      ], BIN, cwd);
      for (const reply of replies) expect(`${cwd}: ${reply}`).toContain("Route explanations are not available to executor sessions");
    }
  }, 180_000);
}

test.skipIf(!front)("mcp: dispatch_preview through the native front door", async () => {
  const replies = await compare("mcp", { strategy: LADDER, registered: true, setup: running("codex") }, [
    { op: P, params: goal({ kind: "debug" }), native: true },
    { op: P, params: goal({ delegationEnforcement: "cooperative" }), native: true },
    { op: P, params: { repo: "app", goal: "g" }, native: false },
  ]);
  expect(replies[0]).toContain("Cursor has not proven");
  expect(replies[2]).toContain('"isError":true');
}, 180_000);

/**
 * What a preview or explanation could write: the registry, caches, strategies and the dispatch tables.
 * The service's own background work (activity, link outbox, checkpoints) is not compared.
 */
function writable(home: string): string {
  const pacer = join(home, ".pacer");
  const files = ["state/repos.json", "state/repo-paths.json", "project-strategies.json", "strategy.yaml"].map(name => `${name} ${read(join(pacer, name))}`);
  const db = new Database(join(pacer, "state", "tasks.db"), { readonly: true });
  try {
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const rows = ["tasks", "enforcement_certificates", "work_reviews", "work_observations", "work_reservations", "work_learning_exclusions", "work_learning_reset"]
      .map(table => `${table} ${tables.has(table) ? JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY 1`).all()) : "absent"}`);
    return [...files, ...tree(join(pacer, "cache")), ...tree(join(pacer, "strategies")), ...rows].join("\n");
  } finally { db.close(); }
}

test.skipIf(!front)("http: explain writes no file or database row", async () => {
  const ctx = seed({ strategy: LEARNING, registered: true, setup: reviews }, home => join(home, ".pacer"));
  cpSync(BIN, join(ctx.home, "bin"), { recursive: true });
  const server = await serve(ctx.home, false);
  try {
    expect(await server.post(P, goal({ kind: "debug" }))).toStartWith("200 ");
    const before = writable(ctx.home);
    for (const params of [explain(), goal({ kind: "debug" }), explain({ executor: "codex" }), explain({ strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "fail" } } } })]) {
      expect(await server.post(E, params)).toStartWith("200 ");
    }
    expect(writable(ctx.home)).toBe(before);
    expect(before).toContain('work_reviews [{"task_id":"codex-0"');
  } finally {
    expect(await server.markers()).toEqual(["native dispatch.preview", ...Array(4).fill("native dispatch.explain")]);
  }
}, 180_000);

import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {UPGRADE_REFUSAL} from "../src/api/caller-policy";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {fakeCtx} from "./helpers";
import {closedPort, isolatedEnv} from "./isolated-port";

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
const FILE = "discovery/state.json";
const LATER_S = 7 * 24 * 3600;
const normalize = (value: unknown, path: string) => JSON.parse(JSON.stringify(value).replaceAll(path, "$HOME"));
// discovery.respond later reads the wall clock (Date.now), not ctx.now.
const clock = (text: string | null) => text?.replace(/\b\d{10}\b/g, n => Math.abs(Number(n) - Math.floor(Date.now() / 1000) - LATER_S) < 30 ? "LATER" : n) ?? null;
const events = (path: string) => {
  if (!existsSync(join(path, "link/outbox.jsonl"))) return [];
  return readFileSync(join(path, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => {
    const entry = JSON.parse(line);
    if (entry.envelope.type === "entity" && entry.envelope.data.kind === "activity") { delete entry.envelope.data.id; delete entry.envelope.data.value.id; }
    return entry.envelope;
  });
};
function rust(op: string, params: unknown, home: string, env: Record<string, string>, raw?: string) {
  const input = `{"op":${JSON.stringify(op)},"params":${raw ?? JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000,"env":${JSON.stringify(env)}}\n`;
  return JSON.parse(execFileSync(driver(), [], {input}).toString());
}
const state = (text: string) => (home: string) => { mkdirSync(join(home, "discovery"), {recursive: true}); writeFileSync(join(home, FILE), text, {mode: 0o600}); };
async function compare(op: string, params: unknown, setup?: (home: string) => void, env: Record<string, string> = {}, raw?: string) {
  const rs = mkdtempSync(join(tmpdir(), "native-dd-")), ts = mkdtempSync(join(tmpdir(), "native-dd-"));
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: 1_700_000_000, env});
  let expected: unknown;
  try { expected = {result: await callOp(ctx, op, params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const actual = rust(op, params, rs, env, raw);
  const label = `${op} ${raw ?? JSON.stringify(params)}`;
  expect(normalize(actual, rs), `${label} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`).toEqual(normalize(expected, ts));
  const read = (path: string) => existsSync(join(path, FILE)) ? readFileSync(join(path, FILE), "utf8") : null;
  expect(clock(read(rs)), `${label}: ${FILE}`).toBe(clock(read(ts)));
  expect(normalize(events(rs), rs), `${label}: events`).toEqual(normalize(events(ts), ts));
}

const ID = "abcdefghijklmnopqrstuvwxyz", OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const NET = "0123456789abcdef0123456789abcdef", MUTED = "fedcba9876543210fedcba9876543210";
const found = {
  rev: 4, networksRev: 2, enabled: true,
  networks: {[NET]: {label: "Home", advertise: null, discoveryId: ID, muted: false, aliases: ["x"]}, [MUTED]: {label: "Café ☕", advertise: true, discoveryId: OTHER, muted: true}},
  silenced: {[OTHER]: "forever"},
  seen: {
    [ID]: {discoveryId: ID, name: "peer \"one\"", version: "1.2.3", hints: "", network: NET, firstSeen: 1, lastSeen: 5},
    [OTHER]: {discoveryId: OTHER, name: "peer two", version: "1.0.0", hints: "", network: MUTED, firstSeen: 1, lastSeen: 6, promptedAt: 6},
    cccccccccccccccccccccccccc: {discoveryId: "cccccccccccccccccccccccccc", name: "gone", version: "1", hints: "", network: "11111111111111111111111111111111", firstSeen: 1, lastSeen: 2},
  },
  prompts: [1, 2], unknown: {kept: [true, null, "\u0001"]},
};
const pretty = state(JSON.stringify(found, null, 2) + "\n");
const compact = state(JSON.stringify(found));

test("native discovery.set and discovery.respond match TypeScript results, file bytes and publication", async () => {
  const cases: [string, unknown, ((home: string) => void)?, Record<string, string>?, string?][] = [
    ["discovery.set", {enabled: false}],
    ["discovery.set", {enabled: true}],
    ["discovery.set", {enabled: true, expect_rev: 0}],
    ["discovery.set", {enabled: false, expect_rev: 2}, pretty],
    ["discovery.set", {enabled: true, expect_rev: 2, extra: 1}, compact],
    ["discovery.set", {enabled: true, expect_rev: 1}, pretty],
    ["discovery.set", {enabled: true}, state(`{"seen":{"z":1},"enabled":"no","corrupt":true,"rev":7,"rev":9,"extra":[]}`)],
    ["discovery.set", {enabled: false}, state(`{"enabled":false}`)],
    ["discovery.set", {enabled: true}, state("[]")],
    ["discovery.set", {enabled: false, expect_rev: 0}, state("null")],
    ["discovery.set", {enabled: true, expect_rev: 1}, state("7")],
    ["discovery.respond", {discoveryId: ID, action: "later"}, pretty],
    ["discovery.respond", {discoveryId: ID, action: "ignore"}, compact],
    ["discovery.respond", {discoveryId: OTHER, action: "later"}, pretty],
    ["discovery.respond", {discoveryId: ID, action: "mute-network"}, pretty],
    ["discovery.respond", {discoveryId: OTHER, action: "mute-network"}, pretty],
    ["discovery.respond", {discoveryId: "cccccccccccccccccccccccccc", action: "mute-network"}, compact],
    ["discovery.respond", {discoveryId: "dddddddddddddddddddddddddd", action: "later"}, pretty],
    ["discovery.respond", {discoveryId: ID, action: "ignore"}],
    ["discovery.respond", {discoveryId: ID, action: "later"}, state("[1]")],
    // Operation schema errors.
    ["discovery.set", {}],
    ["discovery.set", null, undefined, undefined, "null"],
    ["discovery.set", "x"],
    ["discovery.set", {enabled: 1, expect_rev: -1.5}],
    ["discovery.set", {enabled: true, expect_rev: 1e300, x: 1}],
    ["discovery.set", {enabled: true, expect_rev: -9007199254740992}],
    ["discovery.set", {enabled: true, expect_rev: null}],
    ["discovery.set", {enabled: true, expect_rev: "1"}],
    ["discovery.respond", {}],
    ["discovery.respond", [], undefined, undefined, "[]"],
    ["discovery.respond", {discoveryId: "A", action: 5}],
    ["discovery.respond", {discoveryId: 5, action: "nope"}],
    ["discovery.respond", {discoveryId: ID.toUpperCase(), action: "later"}, pretty],
    ["discovery.respond", {discoveryId: `${ID}\n`, action: "later"}, pretty],
    // Enforcement identities are refused before params; executors are not (CLI policy only).
    ["discovery.set", "x", undefined, {PACER_ENFORCEMENT_TOKEN: "t"}],
    ["discovery.respond", {discoveryId: ID, action: "later"}, pretty, {PACER_ROLE: "executor"}],
  ];
  for (const [op, params, setup, env, raw] of cases) await compare(op, params, setup, env, raw);
}, 600_000);

test("native desktop.reconcile matches TypeScript results and errors", async () => {
  const valid = {candidateId: "c-1", expectRevision: 0, requestId: "r_1"};
  const cases: [string, unknown, Record<string, string>?, string?][] = [
    ["desktop.reconcile.status", {}],
    ["desktop.reconcile.status", null, undefined, "null"],
    ["desktop.reconcile.status", {a: 1}],
    ["desktop.reconcile.status", {a: 1, b: 2}],
    ["desktop.reconcile.status", "x"],
    ["desktop.reconcile.status", [], undefined, "[]"],
    ["desktop.reconcile.request", valid],
    ["desktop.reconcile.cancel", {...valid, expectRevision: 9007199254740991, candidateId: "A".repeat(128)}],
    ["desktop.reconcile.request", {}],
    ["desktop.reconcile.request", {candidateId: "a", requestId: "b", expectRevision: -1.5}],
    ["desktop.reconcile.request", {candidateId: "-", requestId: 5, expectRevision: 1e300, z: 1}],
    ["desktop.reconcile.cancel", {candidateId: "a".repeat(129), requestId: "", expectRevision: -9007199254740992}],
    ["desktop.reconcile.cancel", {candidateId: null, requestId: true, expectRevision: "0"}],
    ["desktop.reconcile.cancel", {...valid, expectRevision: -1, y: 1, x: 2}],
    ["desktop.reconcile.request", "x", {PACER_ROLE: "executor"}],
    ["desktop.reconcile.status", {}, {PACER_ROLE: "executor"}],
    ["desktop.reconcile.cancel", valid, {PACER_ENFORCEMENT_TOKEN: "t"}],
    ["desktop.reconcile.status", "x", {PACER_ENFORCEMENT_TOKEN: "t"}],
    ["desktop.reconcile.request", valid, {PACER_ENFORCEMENT_TOKEN: ""}],
  ];
  for (const [op, params, env, raw] of cases) await compare(op, params, undefined, env, raw);
}, 600_000);

test("native discovery leaves pairing and non-canonical state files to TypeScript", async () => {
  const forwarded = (op: string, params: unknown, setup?: (home: string) => void) => {
    const home = mkdtempSync(join(tmpdir(), "native-dd-"));
    setup?.(home);
    expect(rust(op, params, home, {}), `${op} ${JSON.stringify(params)}`).toEqual({forwarded: true});
  };
  forwarded("discovery.respond", {discoveryId: ID, action: "pair"}, pretty);
  forwarded("discovery.respond", {discoveryId: ID, action: "pair"});
  for (const text of ["{", "{\"rev\":1.5}", "{\"rev\":\"1\"}", "{\"networks\":[]}", "{\"x\":{\"10\":1}}", "{\"__proto__\":{}}", "{\"x\":\"\\ud800\"}", "{\"rev\":1e400}"]) {
    forwarded("discovery.set", {enabled: true}, state(text));
  }
  forwarded("discovery.respond", {discoveryId: ID, action: "mute-network"}, state(JSON.stringify({...found, seen: {[ID]: {network: "toString"}}})));
  forwarded("discovery.respond", {discoveryId: ID, action: "later"}, state(JSON.stringify({...found, seen: {[ID]: "x"}})));
  // TypeScript turns a numeric key's position and a fractional number into different bytes.
  const ts = mkdtempSync(join(tmpdir(), "native-dd-"));
  state("{\"x\":{\"b\":1,\"10\":2.50}}")(ts);
  await callOp(fakeCtx({pacerHome: ts, home: ts, now: 1_700_000_000, env: {}}), "discovery.set", {enabled: true});
  expect(readFileSync(join(ts, FILE), "utf8")).toContain("\"x\": {\n    \"10\": 2.5,\n    \"b\": 1\n  }");
});

/** `PACER_TEST_NATIVE_FRONT_DOOR` is either a binary path or `1` (build the test-ops front door). */
let frontBinary = "";
function frontDoor() {
  const value = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
  if (!value) return "";
  if (value !== "1" && existsSync(value)) return value;
  if (!frontBinary) {
    const env = isolatedEnv({...process.env, PACER_PORT: process.env.PACER_PORT ?? String(closedPort())});
    execFileSync("cargo", ["build", "-q", "-p", "pacer", "--locked", "--features", "test-ops"], {stdio: "inherit", env});
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {env}).toString());
    frontBinary = join(metadata.target_directory, "debug/pacer");
  }
  return frontBinary;
}

const ORCA_TASK = "t-20261028-100000-aaaa";
const REQUEST = {candidateId: "c-1", expectRevision: 0, requestId: "r_1"};

/** One stdio front door started from an Orca task worktree; native or forced-forward. */
async function orcaLane(forward: boolean) {
  const binary = frontDoor();
  const root = mkdtempSync(join(tmpdir(), "native-r1-"));
  const home = join(root, "home"), pacerHome = join(home, ".pacer");
  const lane = join(root, "orca/workspaces/ws", `pacer-${ORCA_TASK}-claude-code`, "src");
  mkdirSync(pacerHome, {recursive: true, mode: 0o700});
  mkdirSync(lane, {recursive: true});
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n", {mode: 0o600});
  const env = isolatedEnv({
    HOME: home, PACER_HOME: pacerHome, PATH: process.env.PATH ?? "/usr/bin:/bin",
    PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
    ...(forward ? {PACER_FORWARD_OPS: "desktop.reconcile.request"} : {}),
  });
  const child = Bun.spawn([binary, "api", "--stdio"], {cwd: lane, env, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffered = "";
  const line = async () => {
    while (!buffered.includes("\n")) {
      const {value, done} = await reader.read();
      if (done) throw new Error(`stdio closed: ${await stderr}`);
      buffered += new TextDecoder().decode(value);
    }
    const at = buffered.indexOf("\n"), out = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return out;
  };
  try {
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "hello", params: {protocol: 3}}) + "\n");
    expect(JSON.parse(await line()).result?.protocol).toBe("3.0.0");
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 2, method: "desktop.reconcile.request", params: REQUEST}) + "\n");
    await child.stdin.flush();
    const reply = await line();
    child.stdin.end();
    await child.exited;
    return {reply, stderr: await stderr};
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    rmSync(root, {recursive: true, force: true});
  }
}

test.skipIf(!process.env.PACER_TEST_NATIVE_FRONT_DOOR)("an Orca lane refuses desktop.reconcile.request natively and when forwarded", async () => {
  const [native, forwarded] = await Promise.all([orcaLane(false), orcaLane(true)]);
  expect(native.reply, `native=${native.reply} forwarded=${forwarded.reply}`).toBe(forwarded.reply);
  expect(JSON.parse(native.reply).error).toMatchObject({
    code: -32000, message: UPGRADE_REFUSAL, data: {code: "not_allowed"},
  });
  expect(native.stderr).toContain("native desktop.reconcile.request");
  expect(forwarded.stderr).not.toContain("native desktop.reconcile.request");
}, 240_000);

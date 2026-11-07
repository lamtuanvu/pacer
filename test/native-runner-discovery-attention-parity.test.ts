import {beforeAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {snapshotProbeParts} from "../src/api/snapshot-probe-bridge";
import {loadStrategy} from "../src/config/strategy";
import {resetNetworkForTests, resetRadioForTests} from "../src/discovery";
import {computeStatus} from "../src/engine/status";
import {clearIdentityCache, setIdentityPlatformForTests} from "../src/identity/store";
import type {Ctx} from "../src/types";
import {fakeCtx} from "./helpers";

const NOW = 1_700_000_000;
const root = join(import.meta.dir, "..");
let driver = "";
beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], {cwd: root});
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {cwd: root}).toString());
  driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
}, 600_000);

const STRATEGY = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n  codex: {}\n";
const ID = "abcdefghijklmnopqrstuvwxyz", OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY = createHash("sha256").update("pacer-network/v2\0mac:aa:bb:cc:dd:ee:ff\0Home:Net").digest("hex").slice(0, 32);
const ALIAS = "0123456789abcdef0123456789abcdef";
const PROBE: Record<string, string> = {
  "/sbin/route -n get default": "   route to: default\ngateway: 192.168.1.1\n  interface: en0\n",
  "/usr/sbin/ipconfig getsummary en0": "<dictionary> {\n  SSID : Home:Net\n}\n",
  "/usr/sbin/arp -n 192.168.1.1": "? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n",
  "/usr/bin/nmcli -t -f active,ssid dev wifi": "no:Other\nyes:Home\\:Net\n",
  ...Object.fromEntries(["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"].flatMap(ip => [
    [`${ip} route show default`, "default via 192.168.1.1 dev eth0 proto dhcp metric 100\n"],
    [`${ip} neigh show 192.168.1.1`, "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n"],
  ])),
};

type Options = {setup?: (home: string) => void; env?: Record<string, string>; probe?: Record<string, string>; bridge?: (ctx: Ctx) => Promise<Record<string, unknown>>; files?: string[]};
const write = (path: string, text: string) => (home: string) => { mkdirSync(join(home, path, ".."), {recursive: true}); writeFileSync(join(home, path), text, {mode: 0o600}); };
const all = (...steps: ((home: string) => void)[]) => (home: string) => steps.forEach(step => step(home));
const strategy = (text = STRATEGY) => write("strategy.yaml", text);
const ctxFor = (home: string, o: Options) => fakeCtx({pacerHome: home, home, now: NOW, env: o.env ?? {}, run: async argv => {
  const key = argv.join(" ");
  return o.probe && Object.hasOwn(o.probe, key) ? {code: 0, stdout: o.probe[key], stderr: ""} : {code: 127, stdout: "", stderr: "not available in tests"};
}});
// Plugin lifecycle entities come from the TypeScript bridges (usage broker, endpoint sync), which the driver stubs.
// Wall-clock fields (askedAt), reset discovery ids and generated machine names are the only nondeterministic bytes.
const stable = (text: string, home: string) => text.replaceAll(home, "$HOME")
  .replace(/"name":"pacer-[a-z0-9]{4}"/g, '"name":"MACHINE"')
  .replace(/\b\d{10}\b/g, n => Math.abs(Number(n) - Date.now() / 1000) < 60 ? "NOW" : n)
  .replace(/"discoveryId": "([a-z2-7]{26})"/g, (match, id) => id === ID || id === OTHER ? match : `"discoveryId": "RESET"`);
const events = (home: string) => existsSync(join(home, "link/outbox.jsonl"))
  ? readFileSync(join(home, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).envelope).filter(e => e.data?.kind !== "plugin").map(e => { if (e.data?.kind === "activity") { delete e.data.id; delete e.data.value.id; } return e; })
  : [];

async function compare(op: string, params: unknown, o: Options = {}) {
  const rs = mkdtempSync(join(tmpdir(), "native-rda-")), ts = mkdtempSync(join(tmpdir(), "native-rda-"));
  o.setup?.(rs); o.setup?.(ts);
  setIdentityPlatformForTests("linux"); clearIdentityCache(); resetNetworkForTests(); resetRadioForTests();
  let expected: unknown;
  try { expected = {result: await callOp(ctxFor(ts, o), op, params)}; } catch (error) { expected = {error: toApiError(error)}; }
  clearIdentityCache(); resetNetworkForTests();
  const bridge = o.bridge ? JSON.parse(JSON.stringify(await o.bridge(ctxFor(rs, o)))) : {};
  const input = {op, params, home: rs, now: NOW, env: o.env ?? {}, identityPlatform: "linux", probeOutputs: o.probe ?? {}, ...bridge};
  const actual = JSON.parse(execFileSync(driver, [], {input: JSON.stringify(input) + "\n"}).toString());
  const label = `${op} ${JSON.stringify(params)}`;
  expect(stable(JSON.stringify(actual), rs), label).toBe(stable(JSON.stringify(expected), ts));
  for (const file of o.files ?? []) {
    const read = (home: string) => existsSync(join(home, file)) ? stable(readFileSync(join(home, file), "utf8"), home) : null;
    expect(read(rs), `${label}: ${file}`).toBe(read(ts));
  }
  expect(stable(JSON.stringify(events(rs)), rs), `${label}: events`).toBe(stable(JSON.stringify(events(ts)), ts));
  return expected as {result?: unknown; error?: {code: string}};
}

function forwarded(op: string, params: unknown, setup: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "native-rda-"));
  setup(home);
  const input = {op, params, home, now: NOW, env: {}, probeOutputs: PROBE};
  expect(JSON.parse(execFileSync(driver, [], {input: JSON.stringify(input) + "\n"}).toString()), `${op} ${JSON.stringify(params)}`).toEqual({forwarded: true});
}

test("runner.block and runner.unblock rewrite blocked.json like TypeScript", async () => {
  const blocked = write("blocked.json", '{"old":{"until":1,"reason":"x"},"keep":{"until":null,"reason":"y","extra":1.0},"bad":5}');
  const files = ["blocked.json"];
  for (const params of [{id: "codex", for: "2h", reason: "busy"}, {id: "codex"}, {id: "codex", for: "90s", reason: "  "}, {id: "codex", for: "0m"}, {id: "codex", for: "1.5h"},
    {id: "zzz", for: "1h"}, {}, {id: "codex", for: 5}, null, "x", {id: "codex", for: `${"9".repeat(400)}d`}])
    await compare("runner.block", params, {setup: all(strategy(), blocked), files});
  for (const params of [{id: "codex"}, {id: "codex", extra: 1}, {id: "zzz"}, {id: ""}, [], {}])
    await compare("runner.unblock", params, {setup: all(strategy(), blocked), files});
  await compare("runner.block", {id: "codex"}, {setup: strategy(), env: {PACER_ENFORCEMENT_TOKEN: "t"}, files});
}, 120_000);

test("runner.list composes blocks, breaks and broker eligibility like TypeScript", async () => {
  const bridge = async (ctx: Ctx) => { const st = await computeStatus(ctx, loadStrategy(ctx)); return {brokerParts: {accounts: st.accounts, providers: st.providers}}; };
  const broken = write("broken.json", '{"codex":{"until":1800000000,"reason":"bad cli"}}');
  for (const [params, setup] of [[{}, strategy()], [{a: 1}, all(strategy(), broken)], [null, all(strategy(), write("blocked.json", '{"codex":{"until":null,"reason":"Paused"}}'))], ["x", strategy()]] as const)
    await compare("runner.list", params, {setup, bridge});
}, 120_000);

test("runner.add declares runners and routing like TypeScript; check jobs and terminals stay forwarded", async () => {
  const files = ["strategy.yaml"];
  const block = strategy(`${STRATEGY}routing:\n  - kinds: [tests]\n    executors: [codex]\n  - default: [codex]\n`);
  const hosts = strategy(`${STRATEGY}hosts:\n  box: {ssh: box}\n`);
  for (const [params, setup] of [
    [{agent: "cursor", test: false}, strategy()],
    [{agent: "cursor", test: false, kinds: ["docs"], max_tasks: 2}, strategy()],
    [{agent: "cursor", test: false, kinds: ["docs"], rank: 0, model: "m"}, block],
    [{agent: "cursor", test: false, kinds: ["tests"]}, block],
    [{agent: "cursor", test: false, rank: 9}, block],
    [{agent: "codex", test: false}, strategy()],
    [{agent: "codex", account: "codex", test: false}, strategy()],
    [{agent: "claude-code", account: "codex", test: false}, strategy()],
    [{agent: "cursor", host: "nope", test: false}, hosts],
    [{agent: "cursor", test: false, kinds: ["docs", "docs"]}, strategy()],
  ] as const) await compare("runner.add", params, {setup, files});
  for (const params of [{agent: "cursor"}, {agent: "cursor", test: true}, {interactive: "runner-add"}, {agent: "nope", test: false}, {agent: "cursor", test: false, rank: -1}])
    forwarded("runner.add", params, strategy());
  forwarded("runner.add", {agent: "cursor", test: false}, strategy("planner: ["));
}, 120_000);

test("discovery reads and network.set use the Rust network probe with TypeScript bytes", async () => {
  const file = "discovery/state.json";
  const state = (value: unknown) => write(file, JSON.stringify(value, null, 2) + "\n");
  const known = state({rev: 4, networksRev: 2, enabled: true, extra: "kept",
    networks: {[KEY]: {label: "Home", advertise: true, discoveryId: ID, muted: true}, [ALIAS]: {label: "Office", advertise: null, discoveryId: OTHER, muted: false}},
    silenced: {[OTHER]: "forever", [ID]: NOW + 99_999_999},
    seen: {[ID]: {discoveryId: ID, name: "peer \"one\"", version: "1.2.3", hints: "", network: KEY, firstSeen: 1, lastSeen: 5}, [OTHER]: {discoveryId: OTHER, network: ALIAS, firstSeen: 1, lastSeen: 6}},
    prompts: []});
  const aliased = state({rev: 1, networksRev: 1, enabled: true, networks: {[ALIAS]: {label: "Office", advertise: false, discoveryId: OTHER, muted: false, aliases: ["x", KEY]}}, silenced: {}, seen: {}, prompts: []});
  const corrupt = write(file, "[]");
  const files = [file];
  for (const [probe, setup] of [[PROBE, undefined], [PROBE, known], [PROBE, aliased], [{}, known], [PROBE, corrupt]] as const) {
    await compare("discovery.list", {}, {probe, setup, files});
    await compare("discovery.network.get", null, {probe, setup, files});
  }
  await compare("discovery.list", [], {probe: PROBE});
  for (const params of [{network: KEY, advertise: false, expect_rev: 2}, {network: KEY, muted: false, resetId: true, expect_rev: 2}, {network: ALIAS, advertise: true, muted: true, expect_rev: 2},
    {network: KEY, resetId: false, expect_rev: 2}, {network: KEY, expect_rev: 1}, {network: "f".repeat(32), expect_rev: 2}, {network: "x", muted: 1}, {network: KEY, expect_rev: -1}])
    await compare("discovery.network.set", params, {probe: PROBE, setup: known, files});
  await compare("discovery.network.set", {network: KEY, expect_rev: 0}, {probe: PROBE, setup: corrupt, files});
  await compare("discovery.network.set", {network: KEY, expect_rev: 0}, {probe: PROBE, files});
  forwarded("discovery.list", {}, state({networks: {[KEY]: null}}));
  forwarded("discovery.network.get", {}, write(file, "{"));
  forwarded("discovery.network.set", {network: KEY, expect_rev: 0}, state({seen: {[ID]: {discoveryId: ID}}}));
}, 120_000);

test("attention.dismiss and attention.snooze apply the store to the raised items like TypeScript", async () => {
  const bridge = async (ctx: Ctx) => ({snapshotParts: await snapshotProbeParts(ctx)});
  const prompted = write("discovery/state.json", JSON.stringify({rev: 1, networksRev: 0, enabled: true, networks: {}, silenced: {}, prompts: [],
    seen: {[ID]: {discoveryId: ID, name: "peer", version: "1", hints: "", network: KEY, firstSeen: NOW - 500, lastSeen: NOW - 100, promptedAt: NOW - 100}}}));
  const stored = write("state/attention.json", JSON.stringify({"old:x": {since: 1}, [`discovery:${ID}`]: {since: NOW - 50, dismissedSince: NOW - 50}, "setup:gone": {since: 3, dismissedSince: 3}}));
  const files = ["state/attention.json"];
  const base = all(strategy(), prompted);
  let raised = 0;
  for (const id of [`discovery:${ID}`, "setup:planner", "setup:service", "setup:link", "setup:executor", "setup:usage", "setup:first", "setup:missing", "account_signin:codex", "executor_down:codex", "planner_quota:claude-code"]) {
    for (const setup of [base, all(base, stored)]) {
      const snoozed = await compare("attention.snooze", {id, for: "4h"}, {setup, bridge, files});
      if (snoozed.result) raised++;
      await compare("attention.dismiss", {id}, {setup, bridge, files});
    }
  }
  expect(raised).toBeGreaterThan(1);
  await compare("attention.dismiss", {id: "setup:gone"}, {setup: all(base, stored), bridge, files});
  for (const params of [{id: ""}, {id: "x", for: "2h"}, {}, "x", {id: "x".repeat(257)}])
    await compare("attention.snooze", params, {setup: base, bridge, files});
  forwarded("attention.dismiss", {id: "failed:t-1"}, base);
  forwarded("attention.snooze", {id: "discovery-network:abc", for: "1h"}, base);
  forwarded("attention.snooze", {id: `discovery:${ID}`, for: "1h"}, all(base, write("state/attention.json", "[]")));
  forwarded("attention.dismiss", {id: "setup:usage"}, strategy("planner: ["));
}, 180_000);

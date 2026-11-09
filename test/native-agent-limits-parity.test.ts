import {afterAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {defaultRun} from "../src/ctx";
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
const NOW = 1_700_000_000.5;
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, {recursive: true, force: true}); });
const fresh = (prefix: string) => { const home = realpathSync(mkdtempSync(join(tmpdir(), prefix))); homes.push(home); return home; };

type Step = {op: string; params: unknown; env?: Record<string, string>};

function native(steps: Step[], home: string, path = "/usr/bin:/bin") {
  const input = steps.map(step => JSON.stringify({op: step.op, params: step.params, home, now: NOW, env: {PATH: path, ...step.env}})).join("\n") + "\n";
  return execFileSync(driver(), [], {input, env: {...process.env, PATH: path}}).toString().trim().split("\n").map(line => JSON.parse(line));
}

/** `which` searches `path` the way the core process searches its own startup `PATH`. */
async function reference(steps: Step[], home: string, path = "/usr/bin:/bin") {
  const replies: unknown[] = [];
  for (const step of steps) {
    const ctx = fakeCtx({pacerHome: home, home, now: NOW, env: {PATH: path, ...step.env}, run: defaultRun, which: bin => Bun.which(bin, {PATH: path})});
    try { replies.push({result: await callOp(ctx, step.op, step.params)}); } catch (error) { replies.push({error: toApiError(error)}); }
  }
  return replies;
}

function fakeAgents(home: string) {
  const bin = join(home, "bin");
  mkdirSync(bin, {recursive: true});
  for (const [name, version] of [["claude", "2.1.0 (Claude Code)"], ["cursor-agent", "2026.01.01"]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '${version}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return `${bin}:/usr/bin:/bin`;
}

const detect = (params: unknown = {}, env?: Record<string, string>): Step => ({op: "agent.detect", params, env});

test("native agent.detect answers a fresh detection cache with TypeScript's rows", async () => {
  const home = fresh("native-agent-");
  const path = fakeAgents(home);
  await reference([detect()], home, path);
  expect(readdirSync(join(home, "cache")).filter(name => name.startsWith("agent-detect-"))).toHaveLength(1);
  const steps = [detect(), detect(null), detect({extra: true})];
  const expected = await reference(steps, home, path);
  expect(native(steps, home, path)).toEqual(expected);
  // A different PATH, a host target or an expired entry misses the cache, so the plugin host detects.
  expect(native([detect()], home)).toEqual([{forwarded: true}]);
  expect(native([detect({host: "box"})], home, path)).toEqual([{forwarded: true}]);
  const later = JSON.stringify({op: "agent.detect", params: {}, home, now: NOW + 3600, env: {PATH: path}}) + "\n";
  expect(execFileSync(driver(), [], {input: later, env: {...process.env, PATH: path}}).toString().trim()).toBe('{"forwarded":true}');
}, 600_000);

test("native agent.detect validates params like TypeScript", async () => {
  const home = fresh("native-agent-");
  const steps = [detect([]), detect("x"), detect({host: 1}), detect({host: ""}), detect({host: "x".repeat(129)}), detect({}, {PACER_ENFORCEMENT_TOKEN: "t"})];
  expect(native(steps, home)).toEqual(await reference(steps, home));
}, 600_000);

const refresh = (params: unknown = {}, env?: Record<string, string>): Step => ({op: "limits.refresh", params, env});
const UNSUPPORTED = "planner: cursor\naccounts:\n  cursor: {kind: cursor}\n  \"7\": {kind: endpoint, url: https://example.test/v1, usage: reactive}\n  free: {kind: endpoint, url: https://example.test, usage: unmetered}\nrunners:\n  cursor: {}\n";

test("native limits.refresh matches TypeScript for accounts without a refresh source", async () => {
  const ts = fresh("native-limits-ts-"), rs = fresh("native-limits-rs-");
  writeFileSync(join(ts, "strategy.yaml"), UNSUPPORTED);
  cpSync(ts, rs, {recursive: true});
  const steps = [
    refresh(), refresh(null), refresh({account: "cursor"}), refresh({account: "7", extra: 1}), refresh({account: "nope"}),
    refresh({account: 1}), refresh({account: ""}), refresh({account: "x".repeat(129)}), refresh([]), refresh({}, {PACER_ENFORCEMENT_TOKEN: "t"}),
  ];
  expect(native(steps, rs)).toEqual(await reference(steps, ts));
}, 600_000);

test("accounts a provider must read keep limits.refresh forwarded", () => {
  const home = fresh("native-limits-");
  writeFileSync(join(home, "strategy.yaml"), "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n");
  expect(native([refresh(), refresh({account: "claude"}), refresh({account: "constructor"}), refresh({account: "cursor"})], home))
    .toEqual([{forwarded: true}, {forwarded: true}, {forwarded: true}, {result: {accounts: [{account: "cursor", capability: "unavailable", outcome: "unsupported", capturedAt: null, source: null, error: null}]}}]);
  writeFileSync(join(home, "strategy.yaml"), "planner: [\n");
  expect(native([refresh()], home)).toEqual([{forwarded: true}]);
}, 600_000);

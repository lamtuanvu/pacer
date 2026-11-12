import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { closedPort, pinnedEnv, spawnPinned } from "./pinned-port";
import golden from "./fixtures/config-writes-goldens.json";

// Native planner and task backend config.set against the same requests forced through
// PACER_FORWARD_OPS to the TypeScript core, over stdio and HTTP.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

type Case = { params: Record<string, unknown>; env?: Record<string, string>; strategy?: string };
const EXECUTOR = { PACER_ROLE: "executor" };
const LEGACY = "planner: claude-code\nproviders: {claude-code: {}}\n";
const NATIVE: Case[] = [
  // HTTP runs each group in order on one home: the unchanged install precedes the skip that changes the planner.
  { params: { key: "planner", value: "claude-code", integrations: "install" } },
  { params: { key: "planner", value: "codex", integrations: "skip" } },
  { params: { key: "planner", value: "codex" } },
  { params: { key: "planner", value: "codex", integrations: "skip" }, env: EXECUTOR },
  { params: { key: "planner", value: "codex", integrations: "install" }, env: EXECUTOR },
  { params: { key: "planner", value: "Not A Runner", integrations: "install" } },
  { params: { key: "planner", value: "codex#missing", integrations: "install" } },
  { params: { key: "execution.backend", value: "direct" } },
  { params: { key: "execution.backend", value: "elsewhere" } },
  { params: { key: "execution.backend", value: "orca" }, env: { PACER_BACKEND: "direct" } },
  { params: { key: "execution.backend", value: "direct" }, env: { PACER_BACKEND: "orca" } },
  { params: { key: "execution.backend", value: "elsewhere" }, env: { PACER_BACKEND: "orca" } },
  // TypeScript refuses with "planner account not found" before it would install.
  { params: { key: "planner", value: "codex", integrations: "install" }, strategy: LEGACY },
];
const FORWARDED: Case[] = [
  { params: { key: "planner", value: "codex", integrations: "install" } },
  { params: { key: "execution.backend", value: "orca" } },
];

function home(initial = golden.initial): string {
  const dir = tmpDir(), pacer = join(dir, ".pacer");
  mkdirSync(pacer, { recursive: true, mode: 0o700 });
  writeFileSync(join(pacer, "strategy.yaml"), initial, { mode: 0o600 });
  mkdirSync(join(dir, "bin"));
  for (const bin of ["claude", "codex", "cursor-agent", "opencode", "orca"]) {
    writeFileSync(join(dir, "bin", bin), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "bin", bin), 0o755);
  }
  return dir;
}
function environment(dir: string, forward: boolean, extra: Record<string, string> = {}, port?: number) {
  return pinnedEnv({ HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_ORCA_USER_DATA: join(dir, "orca"),
    PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: "config.set" } : {}) }, port);
}
const markers = (stderr: string) => stderr.split("\n").filter(line => /^native config\.set(?: \S+)?$/.test(line));
const strategy = (dir: string) => readFileSync(join(dir, ".pacer", "strategy.yaml"), "utf8");
const events = (dir: string) => {
  const path = join(dir, ".pacer", "link", "outbox.jsonl");
  if (!existsSync(path)) return [];
  // The TypeScript core publishes asynchronously, so compare the events without ids, clocks, interleaving
  // or the core's own plugin lifecycle. Each twin home has its own machine identity on Linux.
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line).envelope)
    .filter(event => event.type !== "entity" || event.data.kind !== "plugin")
    .map(event => JSON.stringify(event)
      .replace(/"(id|at)":"?\d+(\.\d+)?(-[0-9a-f]+)?"?/g, '"$1":"<now>"')
      .replace(/"machineId":"[a-z2-7]+"/g, '"machineId":"<machine>"')).sort();
};

async function stdio(c: Case, forward: boolean) {
  const dir = home(c.strategy);
  const child = spawnPinned([front!, "api", "--stdio"], { cwd: dir, env: environment(dir, forward, c.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const hello = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } });
    await child.stdin.write(`${hello}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "config.set", params: c.params })}\n`);
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    return { reply: JSON.parse(lines[1]!.replaceAll(dir, "<home>")), markers: markers(stderr), strategy: strategy(dir), events: events(dir) };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

async function http(cases: (Case | { body: string })[], env: Record<string, string> | undefined, forward: boolean, initial?: string) {
  const dir = home(initial), port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", String(port)], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: environment(dir, forward, env, port) });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let token = "", ready = false;
    for (let n = 0; n < 1000 && !ready; n++) {
      try {
        token = readFileSync(join(dir, ".pacer/token"), "utf8").trim();
        ready = (await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
      } catch {}
      if (!ready) await Bun.sleep(20);
    }
    if (!ready) throw new Error(`serve did not start: ${await stderr}`);
    const replies: string[] = [];
    for (const c of cases) {
      const response = await fetch(`${base}/v3/ops/config.set`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: "body" in c ? c.body : JSON.stringify(c.params), signal: AbortSignal.timeout(20000) });
      replies.push(`${response.status} ${(await response.text()).replaceAll(dir, "<home>")}`);
    }
    // Let the forwarded core flush its asynchronous publications before reading the outbox.
    await Bun.sleep(300);
    child.kill("SIGTERM");
    await child.exited;
    return { replies, markers: markers(await stderr).length, strategy: strategy(dir), events: events(dir) };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

test.skipIf(!front)("stdio planner and backend config.set match forced forwarding with native markers", async () => {
  for (const c of NATIVE) {
    const native = await stdio(c, false), forwarded = await stdio(c, true);
    const label = JSON.stringify(c);
    expect(native.markers, label).toEqual(["native config.set 2"]);
    expect(forwarded.markers, label).toEqual([]);
    expect({ ...native, markers: [] }, label).toEqual({ ...forwarded, markers: [] });
  }
}, 180_000);

test.skipIf(!front)("stdio changed planner installs and Orca without PACER_BACKEND stay forwarded", async () => {
  for (const c of FORWARDED) {
    const unforced = await stdio(c, false), forced = await stdio(c, true);
    expect(unforced.markers, JSON.stringify(c)).toEqual([]);
    expect(unforced.reply, JSON.stringify(c)).toEqual(forced.reply);
  }
}, 120_000);

test.skipIf(!front)("HTTP planner and backend config.set match forced forwarding with native markers", async () => {
  const groups = new Map<string, Case[]>();
  for (const c of NATIVE) {
    const group = JSON.stringify([c.env ?? {}, c.strategy ?? null]);
    groups.set(group, [...(groups.get(group) ?? []), c]);
  }
  for (const [group, cases] of groups) {
    const [env, initial] = JSON.parse(group);
    const native = await http(cases, env, false, initial ?? undefined), forwarded = await http(cases, env, true, initial ?? undefined);
    expect(native.markers, group).toBe(cases.length);
    expect(forwarded.markers, group).toBe(0);
    expect({ ...native, markers: 0 }, group).toEqual({ ...forwarded, markers: 0 });
  }
  const forwardedOnly = await http(FORWARDED, undefined, false);
  expect(forwardedOnly.markers).toBe(0);
}, 180_000);

test.skipIf(!front)("HTTP config.set bodies serde rejects reach the TypeScript core", async () => {
  // A UTF-8 BOM and an unpaired surrogate escape: JSON to TextDecoder and JSON.parse, not to serde_json.
  const bodies = [{ body: '\uFEFF{"key":"pacing.policy","value":"even"}' }, { body: '{"key":"pacing.policy","value":"\\ud800"}' }];
  const native = await http(bodies, undefined, false), forwarded = await http(bodies, undefined, true);
  expect(native.markers).toBe(0);
  expect(native.replies[0]).toStartWith("200 ");
  expect(native.replies[1]).not.toContain("body is not JSON");
  expect(native).toEqual(forwarded);
}, 120_000);

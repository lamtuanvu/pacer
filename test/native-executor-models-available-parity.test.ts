import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closedPort, isolatedEnv } from "./isolated-port";

// Native executor.models.available (and runner.set's OpenCode discovery) against the same requests
// forced through PACER_FORWARD_OPS to the TypeScript core, over stdio and HTTP, on twin homes. The
// stand-in OpenCode is test/fixtures/bin/opencode. Build with `cargo build -p pacer --features
// test-ops` and run with PACER_TEST_NATIVE_FRONT_DOOR=<abs path>.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const fixtures = join(import.meta.dir, "fixtures", "bin");
const OPS = ["executor.models.available", "runner.set"];

const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  acme:
    kind: endpoint
    usage: unmetered
    connection:
      api: openai-compatible
      base_url: https://api.example.com
      key: none
      models:
        - {id: a, name: Model A, context: 64000, output: 32000, tools: true}
        - {id: b, context: 128000, output: 8000, tools: false}
${["fresh", "odd", "stale", "fail", "empty", "lone", "miss", "hang"].map(n => `  oc-${n}: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}`).join("\n")}
  oc-nullcat: {kind: endpoint, source: opencode, provider: nullcat, usage: unmetered}
runners:
  claude-code: {}
  codex: {}
  opencode#acme: {model: pacer-acme/a}
${["fresh", "odd", "stale", "fail", "empty", "lone", "miss", "hang"].map(n => `  opencode#oc-${n}: {model: acme/a}`).join("\n")}
  opencode#oc-nullcat: {model: nullcat/a}
routing:
  - default: [codex, opencode#acme, opencode#oc-fresh]
`;

const CATALOG = JSON.stringify({ fetchedAt: 1, providers: {
  acme: { models: [{ id: "a", name: "Acme A", context: 200000, outputLimit: null, toolCall: true, costIn: null, costOut: 2.5, release: "2026-01-02" }, { id: "c", name: null }] },
  nullcat: { models: [null, { id: "a" }] },
} });
const SEEDED = Math.floor(Date.now() / 1000) - 5;

interface Setup { mode?: "list" | "empty" | "fail" | "hang"; models?: string }
type Step = [op: string, params: unknown, native: boolean, setup?: Setup, contains?: string];

function cachePath(home: string, runner: string) {
  return join(home, ".pacer", "cache", "available-models", `${createHash("sha256").update(runner).digest("hex")}.json`);
}

function makeHome(): string {
  // host.sock must fit SUN_LEN; bun test's TMPDIR is too deep for the native front door.
  const home = realpathSync(mkdtempSync("/tmp/nema-"));
  mkdirSync(join(home, ".pacer", "cache", "available-models"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "work"));
  writeFileSync(join(home, ".pacer", "strategy.yaml"), STRATEGY, { mode: 0o600 });
  writeFileSync(join(home, ".pacer", "cache", "models.json"), CATALOG);
  const seed = (runner: string, text: string) => writeFileSync(cachePath(home, runner), text, { mode: 0o600 });
  seed("opencode#oc-fresh", JSON.stringify({ runner: "opencode#oc-fresh", source: "opencode", models: [{ id: "acme/a", name: "A" }, { id: "acme/zz" }], fetchedAt: SEEDED, provider: "acme" }));
  seed("opencode#oc-odd", `{"runner":"opencode#oc-odd","source":"opencode","models":["acme/a",{"id":"acme/b","x":{"2":1,"1":2.0}}],"fetchedAt":${SEEDED}.25,"provider":"acme","extra":[1e2,true]}`);
  seed("opencode#oc-stale", JSON.stringify({ runner: "opencode#oc-stale", source: "opencode", models: [{ id: "acme/old" }], fetchedAt: SEEDED - 3600, provider: "acme" }));
  seed("opencode#oc-lone", `{"runner":"opencode#oc-lone","source":"opencode","models":[{"id":"acme/\\ud800"}],"fetchedAt":${SEEDED}}`);
  configure(home, { mode: "list", models: "acme/a\nacme/b\nacme/c\nother/x\n" });
  return home;
}

function configure(home: string, setup: Setup) {
  const state = join(home, ".fake-opencode");
  mkdirSync(state, { recursive: true });
  if (setup.mode) writeFileSync(join(state, "mode"), setup.mode);
  if (setup.models !== undefined) writeFileSync(join(state, "models"), setup.models);
}

/** Fresh discoveries stamp the clock; seeded stamps are shared by both homes. */
const normalize = (home: string, text: string) => text.replaceAll(home, "$HOME")
  .replace(/"fetchedAt":(\d+(\.\d+)?)/g, (all, n) => Number(n) >= SEEDED - 3600 && Number(n) < SEEDED + 1 ? all : '"fetchedAt":"<now>"');

/** The listing caches (bytes and modes), the strategy and every OpenCode call with its env and cwd. */
function disk(home: string) {
  const dir = join(home, ".pacer", "cache", "available-models");
  const caches = readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    return `${name} ${(statSync(path).mode & 0o777).toString(8)} ${normalize(home, readFileSync(path, "utf8"))}`;
  });
  const calls = join(home, ".fake-opencode", "calls.log");
  return {
    dirMode: (statSync(dir).mode & 0o777).toString(8),
    caches,
    strategy: readFileSync(join(home, ".pacer", "strategy.yaml"), "utf8"),
    catalog: readFileSync(join(home, ".pacer", "cache", "models.json"), "utf8"),
    opencode: existsSync(calls) ? normalize(home, readFileSync(calls, "utf8")) : "",
  };
}

function env(home: string, forward: boolean, port = closedPort()) {
  return isolatedEnv({ HOME: home, PACER_HOME: join(home, ".pacer"), PATH: `${fixtures}:/usr/bin:/bin`, PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
    PACER_FAKE_OPENCODE_PROBE: "door-env", ...(forward ? { PACER_FORWARD_OPS: OPS.join(",") } : {}) }, port);
}

function lines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  return (async () => {
    const reader = stream.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) { onLine(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    }
  })();
}
const markerOf = (line: string) => /^native (executor\.models\.available|runner\.set)( \d+)?$/.test(line) ? line.replace(/ \d+$/, "") : null;

interface Door { call(op: string, params: unknown): Promise<string>; markers: string[]; stop(): Promise<void> }

async function stdio(home: string, forward: boolean): Promise<Door> {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: env(home, forward), cwd: join(home, "work"), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, (line: string) => void>(), markers: string[] = [];
  // Both doors number requests alike, so replies compare as exact bytes.
  const out = lines(child.stdout, line => { const id = JSON.parse(line).id; pending.get(id)?.(line); pending.delete(id); });
  const err = lines(child.stderr, line => { const marker = markerOf(line); if (marker) markers.push(marker); });
  let next = 1;
  const call = (method: string, params: unknown) => new Promise<string>(resolve => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    child.stdin.flush();
  });
  expect(JSON.parse(await call("hello", { protocol: 3 })).result.protocol).toBe("3.0.0");
  return {
    call: (op, params) => call(op, params),
    markers,
    stop: async () => { child.stdin.end(); await child.exited; await Promise.all([out, err]); },
  };
}

async function http(home: string, forward: boolean): Promise<Door> {
  const port = closedPort();
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: env(home, forward, port), cwd: join(home, "work"), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const markers: string[] = [], log: string[] = [];
  const err = lines(child.stderr, line => { log.push(line); const marker = markerOf(line); if (marker) markers.push(marker); });
  const base = `http://127.0.0.1:${port}`;
  let token = "", ready = false;
  for (let n = 0; n < 1500 && !ready; n++) {
    try {
      token = readFileSync(join(home, ".pacer/token"), "utf8").trim();
      ready = (await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!ready) await Bun.sleep(20);
  }
  if (!ready) { child.kill("SIGTERM"); await child.exited; throw new Error(`serve did not start: ${log.join("\n")}`); }
  return {
    call: async (op, params) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(params), signal: AbortSignal.timeout(120_000) });
      return `${response.status} ${await response.text()}`;
    },
    markers,
    stop: async () => { child.kill("SIGTERM"); await child.exited; await err; },
  };
}

async function settle(markers: string[], count: number) {
  for (let n = 0; n < 100 && markers.length < count; n++) await Bun.sleep(10);
}

const available = (runner: unknown, extra: Record<string, unknown> = {}) => ({ runner, ...extra });
const STEPS: Step[] = [
  ["executor.models.available", available("codex"), true],
  ["executor.models.available", available("opencode#acme"), true],
  ["executor.models.available", available("acme"), true],
  ["executor.models.available", available("opencode#oc-fresh"), true],
  ["executor.models.available", available("opencode#oc-odd"), true],
  ["executor.models.available", available("opencode#oc-stale"), true],
  ["executor.models.available", available("opencode#oc-stale"), true],
  ["executor.models.available", available("opencode#oc-fresh", { refresh: true }), true],
  ["executor.models.available", available("opencode#oc-fail"), true, { mode: "fail" }],
  // A listing that fails or is empty saves the model with a "could not be checked" warning.
  ["runner.set", { id: "opencode#oc-fail", model: "acme/zz" }, true, undefined, "acme/zz could not be checked: opencode could not list models for acme"],
  ["executor.models.available", available("opencode#oc-empty"), true, { mode: "empty" }],
  ["runner.set", { id: "opencode#oc-empty", model: "acme/zz" }, true, undefined, "acme/zz could not be checked: opencode lists no models for acme; check opencode auth list"],
  ["executor.models.available", available("opencode#oc-empty"), true, { mode: "list", models: "other/x\n" }],
  ["executor.models.available", available("opencode#oc-empty", { refresh: false }), true, { mode: "list", models: "\ufeffacme/x \r\nacme/a\n" }],
  ["executor.models.available", available("missing"), true],
  ["executor.models.available", available("constructor"), false],
  ["executor.models.available", {}, true],
  ["executor.models.available", available("codex", { refresh: "yes" }), true],
  ["executor.models.available", available("opencode#oc-lone"), false],
  ["executor.models.available", available("opencode#oc-nullcat"), false, { models: "nullcat/a\n" }],
  ["runner.set", { id: "opencode#oc-miss", model: "acme/nope" }, true, { models: "acme/a\nacme/b\nacme/c\n" }],
  ["runner.set", { id: "opencode#oc-miss", model: "acme/c" }, true],
];

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`executor.models.available over ${transport} matches forced forwarding byte for byte`, async () => {
    const homes = [makeHome(), makeHome()] as const;
    const start = transport === "stdio" ? stdio : http;
    const doors = [await start(homes[0], false), await start(homes[1], true)] as const;
    const expected: string[] = [];
    try {
      for (const [op, params, native, setup, contains] of STEPS) {
        const label = `${transport} ${op} ${JSON.stringify(params)}`;
        if (setup) homes.forEach(home => configure(home, setup));
        const replies = await Promise.all([0, 1].map(async i => normalize(homes[i]!, await doors[i]!.call(op, params))));
        expect(replies[0], label).toBe(replies[1]!);
        if (contains) expect(replies[0], label).toContain(contains);
        expect(disk(homes[0]), `${label}: disk`).toEqual(disk(homes[1]));
        if (native) expected.push(`native ${op}`);
        await settle(doors[0].markers, expected.length);
        expect(doors[0].markers, `${label}: trace`).toEqual(expected);
      }
      expect(doors[1].markers).toEqual([]);
      const state = disk(homes[0]);
      // stale, refresh, fail and runner.set, empty and runner.set, two acme listings, nullcat
      // (TypeScript), runner.set's discovery once cached.
      expect(state.opencode.split("\n").filter(Boolean)).toEqual(Array(10).fill("args=models pwd=$HOME/work cwd=$HOME/work probe=door-env"));
      expect(state.dirMode).toBe("700");
      expect(state.caches.every(line => / 600 /.test(line))).toBe(true);
      expect(readFileSync(cachePath(homes[0], "opencode#oc-stale"), "utf8")).toMatch(
        /^\{"runner":"opencode#oc-stale","source":"opencode","models":\[\{"id":"acme\/a","name":"Acme A","context":200000,"tools":true,"costIn":null,"costOut":2.5,"release":"2026-01-02"\},\{"id":"acme\/b"\},\{"id":"acme\/c","name":null\}\],"fetchedAt":\d+(\.\d+)?,"provider":"acme"\}$/);
      expect(existsSync(cachePath(homes[0], "opencode#oc-fail"))).toBe(false);
    } finally {
      await Promise.all(doors.map(door => door.stop()));
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    }
  }, 240_000);
}

test.skipIf(!front)("an OpenCode listing that outlives 90 seconds is killed with its process group on both paths", async () => {
  const homes = [makeHome(), makeHome()] as const;
  homes.forEach(home => configure(home, { mode: "hang" }));
  const doors = [await http(homes[0], false), await http(homes[1], true)] as const;
  try {
    const started = Date.now();
    const replies = await Promise.all([0, 1].map(async i => normalize(homes[i]!, await doors[i]!.call("executor.models.available", available("opencode#oc-hang")))));
    expect(Date.now() - started).toBeLessThan(100_000);
    expect(replies[0]).toBe(replies[1]!);
    expect(replies[0]).toContain('"note":"opencode could not list models for acme"');
    expect(doors[0].markers).toEqual(["native executor.models.available"]);
    for (const home of homes) {
      const pid = Number(readFileSync(join(home, ".fake-opencode", "grandchild.pid"), "utf8"));
      let alive = true;
      for (let n = 0; n < 100 && alive; n++) {
        try { process.kill(pid, 0); await Bun.sleep(50); } catch { alive = false; }
      }
      expect(alive, `grandchild ${pid} in ${home}`).toBe(false);
      expect(existsSync(cachePath(home, "opencode#oc-hang"))).toBe(false);
    }
  } finally {
    await Promise.all(doors.map(door => door.stop()));
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}, 240_000);

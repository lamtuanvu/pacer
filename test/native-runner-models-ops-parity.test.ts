import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closedPort, isolatedEnv } from "./isolated-port";

// Native runner.models.* and dispatch.tierTargets.* against the same requests forced through
// PACER_FORWARD_OPS to the TypeScript core, over stdio and HTTP, on twin homes. Build with
// `cargo build -p pacer --features test-ops` and run with PACER_TEST_NATIVE_FRONT_DOOR=<abs path>.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = ["runner.models.get", "runner.models.set", "runner.models.set_many", "dispatch.tierTargets.get", "dispatch.tierTargets.set"];

const EP = Array.from({ length: 64 }, (_, i) => i);
const STRATEGY = `# Runner models and tier targets fixture
planner: claude-code
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
        - {id: a, context: 64000, output: 32000, tools: true}
        - {id: b, context: 64000, output: 32000, tools: true}
        - {id: xa, context: 64000, output: 32000, tools: true}
  oc: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
  oc-miss: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
${EP.map(i => `  ep${i}: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "https://ep.example.com", key: none, models: [{id: m, context: 1000, output: 100, tools: true}]}}`).join("\n")}
runners:
  claude-code: {}
  # The default executor
  codex: {model: gpt-5}
  opencode#acme:
    model: pacer-acme/a # chosen default
    models:
      - id: pacer-acme/a
        tier: small
  opencode#oc: {model: acme/a}
  opencode#oc-miss: {model: acme/a}
${EP.map(i => `  opencode#ep${i}: {model: pacer-ep${i}/m}`).join("\n")}
routing:
  - default: [codex, opencode#acme, opencode#oc, opencode#oc-miss]
`;
const DISPATCH_BLOCK = `${STRATEGY}dispatch:
  # Difficulty mapping
  tierTargets:
    simple: small
    complex: frontier
  engine: ladder
`;
const LEGACY = `# starter shape
planner: claude-code # planning account
providers:
  # Claude budget
  claude-code: {usage: quota}
  codex: {usage: quota, allow_paid: false} # no paid fallback
# Keep pacing layout
pacing: {policy: priority, order: [codex]}
routing:
  - default: [codex]
`;
const LEGACY_TRAILING = LEGACY.replace("{usage: quota}\n", "{usage: quota}   \n").replace("# Keep pacing layout\n", "# Keep pacing layout  \n");
const FLOW = `planner: claude-code
accounts: {claude: {kind: claude}, codex: {kind: codex}, acme: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "https://api.example.com", key: none, models: [{id: a, context: 1, output: 1, tools: true}, {id: b, context: 1, output: 1, tools: true}]}}}
runners:
  "codex": {model: gpt-5, models: [{id: gpt-5, tier: small}, {id: gpt-6, tier: frontier, strengths: [code]}]}
  'opencode#acme': {models: [{id: pacer-acme/a, tier: small}], model: pacer-acme/a, max_tasks: 2}
  claude-code: {}
dispatch: {engine: ladder, tierTargets: {complex: frontier}}
routing: [{default: [codex, opencode#acme]}]
`;

type Step = [op: string, params: unknown];
interface Case { name: string; strategy?: string | null; setup?: (home: string) => void; steps: Step[]; native: boolean }

function makeHome(): string {
  // host.sock must fit SUN_LEN; bun test's TMPDIR is too deep for the native front door.
  const home = realpathSync(mkdtempSync("/tmp/nrm-")), bin = join(home, "bin");
  mkdirSync(join(home, ".pacer"), { mode: 0o700 });
  mkdirSync(bin);
  // Stand-in OpenCode: logs each call and lists two acme models.
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "$*" >> "${join(home, "opencode-calls.log")}"\nprintf 'acme/a\\nacme/b\\n'\n`);
  chmodSync(join(bin, "opencode"), 0o755);
  return home;
}

/** A fresh inode for every write, so stamp-based caches never serve a stale read. */
function put(path: string, content: string | null) {
  rmSync(path, { recursive: true, force: true });
  if (content === null) return;
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

function reset(home: string, c: Case) {
  const pacer = join(home, ".pacer"), strategy = join(pacer, "strategy.yaml");
  put(strategy, c.strategy === undefined ? STRATEGY : c.strategy);
  put(`${strategy}.pre-accounts.bak`, null);
  put(join(home, "opencode-calls.log"), null);
  for (const path of [join(pacer, "active"), join(pacer, "strategies"), join(pacer, "x.yaml"), join(home, "outside")]) put(path, null);
  const cache = join(pacer, "cache", "available-models");
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const runner = "opencode#oc";
  put(join(cache, `${createHash("sha256").update(runner).digest("hex")}.json`),
    JSON.stringify({ runner, source: "opencode", models: [{ id: "acme/a" }, { id: "acme/b" }, { id: "acme/zy" }], fetchedAt: Date.now() / 1000, provider: "acme" }));
  c.setup?.(home);
}

const read = (path: string) => {
  try { return readFileSync(path, "utf8"); } catch (error) { return `<${(error as NodeJS.ErrnoException).code}>`; }
};
const fileBytes = (home: string, ...path: string[]) => read(join(home, ...path));
/** The active strategy file as `strategyPath` builds it, with Node's `path.join`. */
const strategyFile = (home: string) => {
  const active = join(home, ".pacer", "active");
  const name = existsSync(active) ? readFileSync(active, "utf8").trim() : "";
  return name ? join(home, ".pacer", "strategies", `${name}.yaml`) : join(home, ".pacer", "strategy.yaml");
};
/** What a step changes on disk: the strategy, its migration backup and OpenCode calls. */
const disk = (home: string) => ({
  strategy: fileBytes(home, ".pacer", "strategy.yaml"),
  backup: fileBytes(home, ".pacer", "strategy.yaml.pre-accounts.bak"),
  opencode: fileBytes(home, "opencode-calls.log"),
  // A named active strategy, and the file Rust's `Path::join` would pick for an absolute name.
  named: read(strategyFile(home)),
  outside: fileBytes(home, "outside", "evil.yaml"),
});
const revision = (home: string) => createHash("sha256").update(read(strategyFile(home))).digest("hex");
const withRevision = (home: string, params: unknown) => JSON.parse(JSON.stringify(params ?? null).replaceAll("$REV", revision(home)));
const outbox = (home: string) => {
  const path = join(home, ".pacer", "link", "outbox.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
};
/** Each run's clock and home path differ; everything else must match. */
const normalize = (home: string, text: string) => text.replaceAll(home, "$HOME")
  .replace(/"(at|ts)":\d+(\.\d+)?/g, '"$1":"<time>"')
  .replace(/"id":"\d+(\.\d+)?-[0-9a-f]{4}"/g, '"id":"<activity>"')
  .replace(/"machineId":"[a-z0-9]+"/g, '"machineId":"<machine>"');
const envelopes = (home: string, lines: string[]) => lines.map(line => JSON.parse(line).envelope)
  .filter(envelope => envelope.type === "config" || (envelope.type === "entity" && envelope.data?.kind === "activity"))
  .map(envelope => normalize(home, JSON.stringify(envelope)));
/** The runners and strategy `config` events a home's outbox holds, as its SSE stream sends them. */
const configEvents = (home: string) => outbox(home).map(line => JSON.parse(line).envelope)
  .filter(envelope => envelope.type === "config" && /^(runners|strategy)$/.test(envelope.data?.area))
  .map(envelope => normalize(home, JSON.stringify(envelope.data)));
const isSubsequence = (part: string[], whole: string[]) => {
  let i = 0;
  for (const item of whole) if (item === part[i]) i++;
  return i === part.length;
};

function env(home: string, forward: boolean, port = closedPort()) {
  return isolatedEnv({ HOME: home, PACER_HOME: join(home, ".pacer"), PATH: `${join(home, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
    ...(forward ? { PACER_FORWARD_OPS: OPS.join(",") } : {}) }, port);
}

/** Collects complete lines from a child stream as they arrive. */
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
const markerOf = (line: string) => /^native (runner\.models\.\S+|dispatch\.tierTargets\.\S+)( \d+)?$/.test(line) ? line : null;

interface Door { call(op: string, params: unknown): Promise<string>; markers: string[]; events: string[]; ended?: () => boolean; stop(): Promise<void> }

async function stdio(home: string, forward: boolean): Promise<Door> {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: env(home, forward), cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, (line: string) => void>(), markers: string[] = [];
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
    call: async (op, params) => { const line = await call(op, params); const { id: _, ...reply } = JSON.parse(line); return JSON.stringify(reply); },
    markers, events: [],
    stop: async () => { child.stdin.end(); await child.exited; await Promise.all([out, err]); },
  };
}

async function http(home: string, forward: boolean): Promise<Door> {
  const port = closedPort();
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: env(home, forward, port), cwd: home, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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
  const auth = { Authorization: `Bearer ${token}` };
  // SSE: keep the runners and strategy config events only; other publications depend on timing.
  const events: string[] = [], abort = new AbortController();
  let ended = false;
  const stream = await fetch(base + "/v3/events", { headers: auth, signal: abort.signal });
  expect(stream.ok).toBe(true);
  const sse = (async () => {
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { ended = true; break; }
        buffer += decoder.decode(value, { stream: true });
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1], data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event === "config" && /"area":"(runners|strategy)"/.test(data ?? "")) events.push(normalize(home, data!));
        }
      }
    } catch {}
  })();
  return {
    call: async (op, params) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(params), signal: AbortSignal.timeout(30000) });
      return `${response.status} ${await response.text()}`;
    },
    markers, events, ended: () => ended,
    stop: async () => { abort.abort(); await sse; child.kill("SIGTERM"); await child.exited; await err; },
  };
}

async function settle(markers: string[], count: number) {
  for (let n = 0; n < 100 && markers.length < count; n++) await Bun.sleep(10);
}

/** Runs every case on a native and a forced-forward door over twin homes. */
async function compare(transport: "stdio" | "http", cases: Case[]) {
  const homes = [makeHome(), makeHome()] as const;
  const start = transport === "stdio" ? stdio : http;
  const doors = [await start(homes[0], false), await start(homes[1], true)] as const;
  const expectedMarkers: string[] = [];
  try {
    for (const c of cases) {
      homes.forEach(home => reset(home, c));
      for (const [op, params] of c.steps) {
        const label = `${transport} ${c.name}: ${op} ${JSON.stringify(params).slice(0, 300)}`;
        const before = homes.map(home => outbox(home).length);
        const replies = await Promise.all([0, 1].map(async i => normalize(homes[i]!, await doors[i]!.call(op, withRevision(homes[i]!, params)))));
        expect(replies[0], label).toBe(replies[1]!);
        expect(disk(homes[0]), `${label}: disk`).toEqual(disk(homes[1]));
        expect(envelopes(homes[0], outbox(homes[0]).slice(before[0])), `${label}: events`).toEqual(envelopes(homes[1], outbox(homes[1]).slice(before[1])));
        if (c.native) expectedMarkers.push(`native ${op}`);
      }
      await settle(doors[0].markers, expectedMarkers.length);
      expect(doors[0].markers.map(marker => marker.replace(/ \d+$/, "")), `${transport} ${c.name}: trace`).toEqual(expectedMarkers);
    }
    expect(doors[1].markers).toEqual([]);
    if (transport === "http") {
      // Each door's stream tails its own home's outbox, which the steps above compared. The forwarded
      // door's stream can drop an event under load (a pre-existing forwarded-path loss), so it must
      // only never invent or reorder one; the native door must deliver every event.
      const expected = homes.map(configEvents);
      expect(expected[0]!.length).toBeGreaterThan(0);
      for (let deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (doors.every((door, i) => door.events.length >= expected[i]!.length)) break;
        await Bun.sleep(20);
      }
      expect(doors[0].events, `native SSE (stream ended: ${doors[0].ended?.()})`).toEqual(expected[0]!);
      expect(isSubsequence(doors[1].events, expected[1]!),
        `forwarded SSE ${JSON.stringify(doors[1].events)} (stream ended: ${doors[1].ended?.()}) against ${JSON.stringify(expected[1])}`).toBe(true);
    }
    return homes.map(disk);
  } finally {
    await Promise.all(doors.map(door => door.stop()));
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}

const set = (id: string, defaultModel: string, models: unknown[] = [], expectedRevision = "$REV") =>
  ({ id, expectedRevision, default: defaultModel, models });
const entry = (id: string, defaultModel: string, models: unknown[] = []) => ({ id, default: defaultModel, models });
const epEntries = (count: number) => Array.from({ length: count }, (_, i) =>
  entry(`opencode#ep${i}`, `pacer-ep${i}/m`, [{ id: `pacer-ep${i}/m`, tier: i % 2 ? "medium" : "small" }]));

const refusals: Step[] = [
  ["runner.models.get", { id: "codex" }],
  ["runner.models.get", { id: "opencode#acme" }],
  ["runner.models.get", { id: "acme" }],
  ["runner.models.get", { id: "zzz" }],
  ["runner.models.get", { id: "", extra: 1 }],
  ["runner.models.get", []],
  ["dispatch.tierTargets.get", {}],
  ["dispatch.tierTargets.get", { ignored: true }],
  ["dispatch.tierTargets.get", "x"],
  ["runner.models.set", set("codex", "gpt-6", [], "stale")],
  ["runner.models.set", set("claude-code", "x")],
  ["runner.models.set", set("zzz", "x")],
  ["runner.models.set", set("opencode#acme", "pacer-acme/nope")],
  ["runner.models.set", set("opencode#acme", "pacer-acme/x", [{ id: "pacer-acme/a", tier: "small" }])],
  ["runner.models.set", set("opencode#acme", "pacer-acme/a", [{ id: "pacer-acme/a", tier: "small" }, { id: "pacer-acme/a", tier: "medium" }])],
  ["runner.models.set", set("opencode#acme", "pacer-acme/a", [{ id: "pacer-acme/a", tier: "small" }, { id: "pacer-acme/zz", tier: "small" }])],
  ["runner.models.set", set("codex", "", [{ id: "", tier: "huge", strengths: [""], tools: 1, context: -1.5, x: 1 }, 7])],
  ["runner.models.set", { id: "codex", expectedRevision: "", default: 3, models: "x", y: 1 }],
  ["runner.models.set", { id: "x".repeat(129), expectedRevision: "$REV", default: "m", models: Array.from({ length: 257 }, (_, i) => ({ id: `m${i}`, tier: "small", strengths: Array.from({ length: 65 }, () => "s") })) }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: epEntries(64).concat([entry("codex", "x")]) }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [] }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "a"), entry("codex", "b")] }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "gpt-6"), entry("opencode#acme", "pacer-acme/nope")] }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "gpt-6"), entry("claude-code", "x")] }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "gpt-6"), entry("zzz", "x")] }],
  ["runner.models.set_many", { expectedRevision: "stale", runners: [entry("codex", "gpt-6")] }],
  ["runner.models.set_many", { runners: [1, { id: "" }] }],
  ["dispatch.tierTargets.set", { expectedRevision: "stale", targets: {} }],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "frontier" } }],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "huge", complex: null, a: 1, b: 2 } }],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { complex: "small", x: 1 } }],
  ["dispatch.tierTargets.set", { targets: null }],
  ["dispatch.tierTargets.set", { expectedRevision: 1 }],
];

const saves: Step[] = [
  ["runner.models.set", set("opencode#acme", "pacer-acme/b", [{ id: "pacer-acme/b", tier: "medium", strengths: [] }, { strengths: ["code", "docs"], id: "pacer-acme/a", tier: "small", tools: true, context: 1000 }])],
  ["runner.models.get", { id: "acme" }],
  ["runner.models.set", set("codex", "gpt-6", [{ id: "gpt-6", tier: "frontier" }, { id: "gpt-5", tier: "unknown" }])],
  ["runner.models.set", set("codex", "gpt-5")],
  ["runner.models.set", set("codex", "gpt-5")],
  ["runner.models.set", set("opencode#oc", "acme/b", [{ id: "acme/b", tier: "small" }])],
  ["runner.models.set", set("opencode#oc", "acme/zz")],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("opencode#acme", "pacer-acme/xa")] }],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: epEntries(64) }],
  ["runner.models.get", { id: "opencode#ep63" }],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { standard: "frontier", simple: "medium" } }],
  ["dispatch.tierTargets.get", {}],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "small", standard: "small", complex: "small" } }],
  ["dispatch.tierTargets.get", {}],
];

const tierBlock: Step[] = [
  ["dispatch.tierTargets.get", {}],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "medium", complex: "frontier" } }],
  ["runner.models.set", set("codex", "gpt-6", [{ id: "gpt-6", tier: "medium", strengths: ["fast"] }])],
];


const unloadable: Step[] = [
  ["runner.models.get", { id: "codex" }],
  ["runner.models.set", set("codex", "gpt-6")],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "gpt-6")] }],
  ["dispatch.tierTargets.get", {}],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: {} }],
];

/** Steps on a strategy named by `active`; `$REV` is the revision of the file Node's `path.join` names. */
const named: Step[] = [
  ["runner.models.get", { id: "codex" }],
  ["runner.models.set", set("codex", "gpt-9", [{ id: "gpt-9", tier: "small" }])],
  ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "gpt-8")] }],
  ["dispatch.tierTargets.get", {}],
  ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "medium" } }],
];
const NODE_JOINED = STRATEGY.replace("codex: {model: gpt-5}", "codex: {model: node-joined}");
const writeNamed = (home: string, name: string) => {
  writeFileSync(join(home, ".pacer", "active"), name);
  mkdirSync(dirname(strategyFile(home)), { recursive: true });
  writeFileSync(strategyFile(home), NODE_JOINED);
};

const cases: Case[] = [
  { name: "reads and refusals", steps: refusals, native: true },
  { name: "saves", steps: saves, native: true },
  { name: "existing dispatch block", strategy: DISPATCH_BLOCK, steps: tierBlock, native: true },
  // The runner is listed through `opencode models` and cached; each case starts without that cache.
  { name: "a runner only OpenCode lists", steps: [["runner.models.set", set("opencode#oc-miss", "acme/b")]], native: true },
  { name: "set_many with a runner only OpenCode lists", steps: [["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("codex", "gpt-6"), entry("opencode#oc-miss", "acme/nope")] }]], native: true },
  { name: "legacy strategy migrates with its backup", strategy: LEGACY, steps: [["runner.models.set", set("codex", "gpt-6", [{ id: "gpt-6", tier: "small" }])]], native: true },
  { name: "legacy strategy with trailing whitespace", strategy: LEGACY_TRAILING, steps: [["runner.models.set", set("codex", "gpt-6")]], native: true },
  { name: "flow and quoted layouts", strategy: FLOW, steps: [
    ["runner.models.get", { id: "codex" }],
    ["runner.models.set", set("codex", "gpt-6", [{ id: "gpt-6", tier: "medium" }])],
    ["runner.models.set_many", { expectedRevision: "$REV", runners: [entry("acme", "pacer-acme/b"), entry("codex", "gpt-7", [{ id: "gpt-7", tier: "small", strengths: ["a", "b"] }])] }],
    ["dispatch.tierTargets.get", {}],
    ["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "medium" } }],
  ], native: true },
  { name: "legacy tier targets", strategy: LEGACY, steps: [["dispatch.tierTargets.set", { expectedRevision: "$REV", targets: { simple: "medium" } }]], native: true },
  { name: "missing strategy", strategy: null, steps: unloadable, native: false },
  { name: "YAML syntax error", strategy: "planner: [\n", steps: unloadable, native: false },
  { name: "schema-invalid strategy", strategy: "planner: nobody\n", steps: unloadable, native: false },
  { name: "a named active strategy", setup: home => writeNamed(home, "work\n"), steps: named, native: true },
  // Rust's `Path::join` reads an absolute name itself; Node joins it under strategies/.
  { name: "an absolute active name", setup: home => {
    mkdirSync(join(home, "outside"));
    writeFileSync(join(home, "outside", "evil.yaml"), STRATEGY.replace("codex: {model: gpt-5}", "codex: {model: rust-joined}"));
    writeNamed(home, join(home, "outside", "evil"));
  }, steps: named, native: false },
  // With strategies/ present, Rust's `strategies/../x.yaml` reaches the same file; only the path check forwards.
  { name: "an active name with ..", setup: home => { mkdirSync(join(home, ".pacer", "strategies")); writeNamed(home, "../x"); }, steps: named, native: false },
];

for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`runner models and tier targets over ${transport} match forced forwarding`, async () => {
    const [native] = await compare(transport, cases);
    expect(native!.opencode).toBe("<ENOENT>");
  }, 240_000);
}

/** Two clients saving against the same revision: one commits, the other is refused. */
for (const transport of ["stdio", "http"] as const) {
  test.skipIf(!front)(`two concurrent ${transport} clients on one revision: one save wins`, async () => {
    const home = makeHome();
    reset(home, { name: "concurrent", steps: [], native: true });
    const start = transport === "stdio" ? stdio : http;
    const doors = transport === "stdio" ? [await stdio(home, false), await stdio(home, false)] : await (async () => { const door = await start(home, false); return [door, door]; })();
    try {
      const rev = revision(home);
      const replies = await Promise.all([
        doors[0]!.call("runner.models.set", set("codex", "gpt-6", [], rev)),
        doors[1]!.call("dispatch.tierTargets.set", { expectedRevision: rev, targets: { simple: "medium" } }),
      ]);
      const won = replies.filter(reply => !reply.includes("Executor settings changed elsewhere."));
      expect(won.length, replies.join("\n")).toBe(1);
      expect(replies.join("\n")).toContain("Reload saved settings, then reapply your changes.");
      const text = fileBytes(home, ".pacer", "strategy.yaml");
      expect(text.includes("codex: {model: gpt-6}") !== text.includes("dispatch: { tierTargets:"), text).toBe(true);
      await settle(doors[0]!.markers, 1);
      expect(new Set([...doors[0]!.markers, ...(doors[1] === doors[0] ? [] : doors[1]!.markers)].map(marker => marker.replace(/ \d+$/, ""))))
        .toEqual(new Set(["native runner.models.set", "native dispatch.tierTargets.set"]));
    } finally {
      await Promise.all([...new Set(doors)].map(door => door.stop()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
}

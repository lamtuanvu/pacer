import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import { tmpDir, withLoginIndicators } from "./helpers";
import { closedPort, spawnPinned } from "./port-isolation";

// Native job.*, strategy.preview and executor.setup.{models,connect} against
// the same requests forced through PACER_FORWARD_OPS to the TypeScript core.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "job.list,job.get,job.cancel,strategy.preview,executor.setup.models,executor.setup.connect";

const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  cursor: {kind: cursor}
runners:
  claude-code: {}
  codex: {}
  cursor: {}
routing:
  - kinds: [tests]
    executors: [codex, claude-code]
  - default: [claude-code, codex, cursor]
pacing: {policy: priority, order: [claude-code, codex, cursor]}
`;
/** A saved strategy without the cursor account, as a draft source whose accounts differ. */
const LEAN = STRATEGY.replace("  cursor: {kind: cursor}\n", "").replace("  cursor: {}\n", "").replaceAll(", cursor]", "]");

async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, expectNative = !forward) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[0]!).result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(r => JSON.parse(r).method as string));
    const markers = stderr.split("\n").filter(line => { const m = /^native (\S+) \d+$/.exec(line); return m != null && ops.has(m[1]!); });
    expect(markers).toEqual(expectNative ? requests.map((r, i) => `native ${JSON.parse(r).method} ${i + 2}`) : []);
    // Broker-bound replies may complete after later requests; only each process's own clock differs.
    return lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id).map(line => line.replace(/"endedAt":1[7-9]\d{8}(\.\d+)?/g, '"endedAt":"<now>"'));
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const requests = (cases: [string, unknown][]) => cases.map(([op, params], i) => request(i + 2, op, params));

const NOW = Math.floor(Date.now() / 1000);
const job = (id: string, state: string, startedAt: number, cancellable: boolean, extra: Record<string, unknown> = {}) => ({
  id, kind: "host.check", target: id.startsWith("h") ? "host-a" : "host-b", state,
  steps: [{ name: "Connect", state: "passed", detail: "ok" }, { name: "Probe", state: "running", detail: "key secret-value for me@example.com" }, { name: "Clean", state: "pending" }],
  startedAt, pid: 999999, cancellable, ...extra,
});
function home(): string {
  const dir = tmpDir(), pacer = join(dir, ".pacer"), jobs = join(pacer, "state", "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  writeFileSync(join(pacer, "strategy.yaml"), STRATEGY);
  mkdirSync(join(pacer, "strategies"));
  writeFileSync(join(pacer, "strategies", "lean.yaml"), LEAN);
  // Installed agent CLIs, so the usage broker ranks the runners.
  mkdirSync(join(dir, "bin"));
  for (const bin of ["claude", "codex", "cursor-agent"]) { writeFileSync(join(dir, "bin", bin), "#!/bin/sh\nexit 1\n"); chmodSync(join(dir, "bin", bin), 0o755); }
  withLoginIndicators({ home: dir } as Ctx);
  const put = (value: object) => writeFileSync(join(jobs, `${(value as { id: string }).id}.json`), JSON.stringify(value), { mode: 0o600 });
  put(job("h-old", "passed", NOW - 200000, false, { endedAt: NOW - 190000 }));
  put(job("h-run", "running", NOW - 30, true, { error: { code: "x", message: "Bearer abc.def at a@b.io", hint: "token=zzz" } }));
  put(job("h-fixed", "running", NOW - 30, false));
  put(job("b-done", "passed", NOW - 30, true, { endedAt: NOW - 10 }));
  put(job("b-new", "running", NOW - 5.25, true));
  writeFileSync(join(jobs, "h-run.json.1234.tmp"), "{");
  mkdirSync(join(pacer, "cache"), { recursive: true });
  const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), toolCall: true, input: ["text", "image"], output: ["text"], context: 200000, outputLimit: 32000, costIn: 1.25, costOut: 10, release: "2025-03-01", ...extra });
  writeFileSync(join(pacer, "cache", "models.json"), JSON.stringify({ fetchedAt: NOW, providers: {
    acme: { id: "acme", name: "Acme", env: ["ACME_KEY"], api: null, models: [model("zeta"), model("alpha-coder", { context: 64000 }), model("beta", { release: null, context: null }), model("embed", { output: ["vector"] }), model("gamma", { toolCall: false })] },
    "volcengine-coding-plan": { id: "volcengine-coding-plan", name: "Volc", env: [], api: null, models: [model("doubao", { costIn: 0, costOut: 0 })] },
    free: { id: "free", name: "Free", env: [], api: null, models: [model("f1", { costIn: 0, costOut: null }), model("f2", { costIn: null, costOut: null })] },
  } }));
  return dir;
}
const files = (dir: string) => {
  const jobs = join(dir, ".pacer", "state", "jobs");
  return Object.fromEntries(readdirSync(jobs).sort().map(name => [name, readFileSync(join(jobs, name), "utf8").replace(/"endedAt":1[7-9]\d{8}(\.\d+)?/g, '"endedAt":"<now>"')]));
};
const events = (dir: string) => {
  const path = join(dir, ".pacer", "link", "outbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.stringify(JSON.parse(line).envelope).replace(/"endedAt":1[7-9]\d{8}(\.\d+)?/g, '"endedAt":"<now>"'));
};

test.skipIf(!front)("job.list, job.get and job.cancel match forced forwarding, files and events", async () => {
  const cases: [string, unknown][] = [
    ["job.get", { id: "h-old" }], ["job.list", {}], ["job.get", { id: "h-old" }], ["job.list", { target: "host-a" }],
    ["job.list", { target: "" }], ["job.list", { target: 5, x: 1 }], ["job.list", null], ["job.list", []],
    ["job.get", { id: "b-new" }], ["job.get", { id: "../etc" }], ["job.get", { id: "nope" }], ["job.get", {}],
    ["job.get", { id: "x".repeat(129) }], ["job.get", { id: 7 }],
    ["job.cancel", { id: "h-fixed" }], ["job.cancel", { id: "b-done" }], ["job.cancel", { id: "h-run" }],
    ["job.cancel", { id: "h-run" }], ["job.cancel", { id: "b-new" }], ["job.cancel", { id: "missing" }],
    ["job.cancel", { id: "a b" }], ["job.list", {}],
  ];
  const homes = [home(), home()];
  const env = { ACME_API_KEY: "secret-value" };
  const native = await exchange(homes[0]!, requests(cases), false, env);
  const forwarded = await exchange(homes[1]!, requests(cases), true, env);
  expect(native).toEqual(forwarded);
  expect(files(homes[0]!)).toEqual(files(homes[1]!));
  expect(events(homes[0]!)).toEqual(events(homes[1]!));
  expect(events(homes[0]!).join("\n")).toContain("[redacted]");
  expect(JSON.parse(native[1]!).result.map((j: { id: string }) => j.id)).toEqual(["b-new", "b-done", "h-fixed", "h-run"]);
  expect(JSON.parse(native[16]!).result.state).toBe("cancelled");
}, 60000);

test.skipIf(!front)("job files only TypeScript parses forward", async () => {
  const dir = home();
  writeFileSync(join(dir, ".pacer", "state", "jobs", "broken.json"), "{not json");
  const cases = requests([["job.get", { id: "broken" }], ["job.cancel", { id: "broken" }]]);
  expect(await exchange(dir, cases, false, {}, false)).toEqual(await exchange(dir, cases, true));
  writeFileSync(join(dir, ".pacer", "state", "jobs", "null.json"), "null");
  const list = requests([["job.list", {}], ["job.cancel", { id: "null" }]]);
  expect(await exchange(dir, list, false, {}, false)).toEqual(await exchange(dir, list, true));
}, 60000);

test.skipIf(!front)("strategy.preview over the usage broker matches forced forwarding", async () => {
  const dir = home();
  const draft = (extra: Record<string, unknown>) => ({ draft: { from: "default", ...extra } });
  const cases: [string, unknown][] = [
    ["strategy.preview", draft({ set: { "pacing.order": ["cursor", "codex", "claude-code"] } })],
    ["strategy.preview", draft({ set: { "pacing.policy": "nope" } })],
    ["strategy.preview", draft({ set: { routing: [{ kinds: ["docs"], executors: ["cursor"] }, { default: ["codex", "cursor"] }] } })],
    ["strategy.preview", draft({ unset: ["pacing.order"], description: "d" })],
    ["strategy.preview", draft({ set: { "pacing.bogus": 1 } })],
    ["strategy.preview", draft({ set: { "__proto__.x": 1 } })],
    ["strategy.preview", draft({ set: [] })],
    ["strategy.preview", { draft: { from: "gone" } }],
    ["strategy.preview", { draft: { from: "" } }],
    ["strategy.preview", {}],
    ["strategy.preview", null],
  ];
  const native = await exchange(dir, requests(cases), false);
  const forwarded = await exchange(dir, requests(cases), true);
  expect(native).toEqual(forwarded);
  expect(JSON.parse(native[0]!).result.ok).toBe(true);
  expect(JSON.parse(native[0]!).result.ranking.current.length).toBeGreaterThan(0);
  // Drafts that change provider inputs rank over the draft's own usage-broker parts.
  const providers = requests(PROVIDER_DRAFTS);
  const changed = await exchange(dir, providers, false);
  expect(changed).toEqual(await exchange(dir, providers, true));
  expect(JSON.parse(changed[2]!).result.ranking.draft).not.toContain("cursor");
}, 120000);

/** Valid drafts whose provider rows differ from the active strategy's: they forwarded before the draft parts. */
const PROVIDER_DRAFTS: [string, unknown][] = [
  ["strategy.preview", { draft: { from: "default", set: { "pacing.planner_reserve": 40 } } }],
  ["strategy.preview", { draft: { from: "default", set: { planner: "codex" } } }],
  ["strategy.preview", { draft: { from: "lean" } }],
  ["strategy.preview", { draft: { from: "lean", set: { "pacing.order": ["codex", "claude-code"], "pacing.behind_threshold": 5 } } }],
  ["strategy.preview", { draft: { from: "lean", set: { "pacing.policy": "nope" } } }],
];

async function serve(dir: string, forward: boolean) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", port], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: { HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, PACER_PORT: port,
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) } });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "", ready = false;
  for (let n = 0; n < 1000 && !ready; n++) {
    try {
      token = readFileSync(join(dir, ".pacer/token"), "utf8").trim();
      ready = (await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!ready) await Bun.sleep(20);
  }
  if (!ready) { child.kill("SIGTERM"); await child.exited; throw new Error(`serve did not start: ${await stderr}`); }
  return {
    post: async (op: string, body: unknown) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      return `${response.status} ${await response.text()}`;
    },
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native strategy\.preview$/.test(line)); },
  };
}

test.skipIf(!front)("strategy.preview with provider-input drafts over HTTP matches forced forwarding", async () => {
  const results: { bodies: string[]; markers: string[] }[] = [];
  for (const forward of [false, true]) {
    const server = await serve(home(), forward);
    const bodies: string[] = [];
    try { for (const [op, params] of PROVIDER_DRAFTS) bodies.push(await server.post(op, params)); }
    finally { results.push({ bodies, markers: await server.stop() }); }
  }
  expect(results[0]!.bodies).toEqual(results[1]!.bodies);
  expect(results[0]!.markers).toHaveLength(PROVIDER_DRAFTS.length);
  expect(results[1]!.markers).toEqual([]);
  expect(results[0]!.bodies[2]).toStartWith("200 ");
}, 120000);

test.skipIf(!front)("strategy.preview without a loadable current strategy matches forced forwarding", async () => {
  const dir = home(), path = join(dir, ".pacer", "strategy.yaml");
  const cases = requests([["strategy.preview", { draft: { from: "default", set: { "pacing.order": ["codex"] } } }], ["strategy.preview", { draft: { from: "default" } }]]);
  const current = (text: string | null) => { rmSync(path, { recursive: true, force: true }); if (text !== null) writeFileSync(path, text); };
  for (const text of [null, "planner: nobody\n", "- a\n- b\n", `${STRATEGY}terminal: {open: "x {cmd} '"}\n`]) {
    current(text);
    const native = await exchange(dir, cases, false);
    expect(native, String(text)).toEqual(await exchange(dir, cases, true));
    expect(JSON.parse(native[0]!).error.data).toEqual({ code: "invalid_input", hint: "Use strategy.list to choose a strategy and strategy.preview to validate a draft." });
  }
  // YAML syntax and read errors carry the runtime's own text.
  for (const text of ["planner: [\n", ""]) {
    current(text);
    expect(await exchange(dir, cases, false, {}, false), text).toEqual(await exchange(dir, cases, true));
  }
  current(null);
  mkdirSync(path);
  expect(await exchange(dir, cases, false, {}, false)).toEqual(await exchange(dir, cases, true));
}, 120000);

test.skipIf(!front)("executor.setup.models from a fresh catalog and executor.setup.connect match forced forwarding", async () => {
  const dir = home();
  const cases: [string, unknown][] = [
    ["executor.setup.models", { provider: "acme", group: "catalog" }],
    ["executor.setup.models", { provider: "acme", group: "signed_in", extra: 1 }],
    ["executor.setup.models", { provider: "volcengine-coding-plan", group: "catalog" }],
    ["executor.setup.models", { provider: "free", group: "catalog" }],
    ["executor.setup.models", { provider: "", group: "cloud" }],
    ["executor.setup.models", { group: 5 }],
    ["executor.setup.models", null],
    ["executor.setup.connect", { provider: "acme" }],
    ["executor.setup.connect", { provider: "acme.v2_x-1", key: "sk-unused" }],
    ["executor.setup.connect", { provider: "-acme", key: "" }],
    ["executor.setup.connect", { provider: 1, key: 2 }],
    ["executor.setup.connect", {}],
  ];
  // Native only while OpenCode is not installed: with it, the catalog is narrowed to what it serves (TypeScript).
  const noOpencode = { PATH: `${join(dir, "bin")}:/usr/bin:/bin` };
  const native = await exchange(dir, requests(cases), false, noOpencode);
  const forwarded = await exchange(dir, requests(cases), true, noOpencode);
  expect(native).toEqual(forwarded);
  expect(JSON.parse(native[0]!).result.pick.id).toBe("alpha-coder");
  const withOpencode = tmpDir();
  writeFileSync(join(withOpencode, "opencode"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(withOpencode, "opencode"), 0o755);
  const listed = requests([["executor.setup.models", { provider: "acme", group: "catalog" }]]);
  expect(await exchange(dir, listed, false, { PATH: `${withOpencode}:/usr/bin:/bin` }, false)).toEqual(native.slice(0, 1));
  const enforced = requests([["job.list", {}], ["strategy.preview", { draft: { from: "default" } }], ["executor.setup.connect", { provider: "acme" }]]);
  const env = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  expect(await exchange(dir, enforced, false, env)).toEqual(await exchange(dir, enforced, true, env));
}, 60000);

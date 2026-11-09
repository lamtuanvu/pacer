import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import { tmpDir, withLoginIndicators } from "./helpers";

// Native account.remove, endpoint account.add/edit/adopt and the
// account.usage.check, account.models and account.test refusals against the
// same requests forced through PACER_FORWARD_OPS to the TypeScript core.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "account.add,account.edit,account.adopt,account.remove,account.models,account.test,account.usage.check";

const model = (id: string) => `{id: ${id}, context: 1000, output: 100, tools: true}`;
const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  work: {kind: codex, home: ~/.codex-work}
  shared: {kind: codex, home: "~"}
  passive: {kind: codex, home: ~/.passive, usage: reactive}
  ep: {kind: endpoint, usage: metered, budget: {weekly_tokens: 1000}, connection: {api: openai-compatible, base_url: "https://ep.test/v1", key: "env:EP_KEY", models: [${model("m1")}, ${model("m2")}]}}
  fk: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "https://fk.test/v1", key: file, models: [${model("f1")}]}}
  ext: {kind: endpoint, usage: unmetered, model: acme/m1}
  spare: {kind: endpoint, usage: unmetered}
runners:
  claude-code: {}
  codex: {}
  opencode#ext: {}
routing:
  - kinds: [docs]
    executors: [codex]
  - default: [claude-code, codex]
`;

async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, expectNative = !forward) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_ORCA_USER_DATA: join(home, "orca"), PACER_DEBUG_NATIVE: "1", EP_KEY: "sk-ep-secret-value",
      ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout + stderr).not.toContain("sk-ep-secret-value");
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[0]!).result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(r => JSON.parse(r).method as string));
    const markers = stderr.split("\n").filter(line => { const m = /^native (\S+) \d+$/.exec(line); return m != null && ops.has(m[1]!); });
    expect(markers).toEqual(expectNative ? requests.map((r, i) => `native ${JSON.parse(r).method} ${i + 2}`) : []);
    return lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id).map(line => line.replaceAll(home, "<home>"));
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const requests = (cases: [string, unknown][]) => cases.map(([op, params], i) => request(i + 2, op, params));

function home(): string {
  const dir = tmpDir(), pacer = join(dir, ".pacer");
  mkdirSync(join(pacer, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pacer, "strategy.yaml"), STRATEGY);
  writeFileSync(join(pacer, "secrets", "fk.key"), "file-key-value", { mode: 0o600 });
  mkdirSync(join(dir, ".codex-work"));
  writeFileSync(join(dir, ".codex-work", "auth.json"), "{}");
  mkdirSync(join(dir, ".codex"));
  mkdirSync(join(dir, ".config", "opencode"), { recursive: true });
  writeFileSync(join(dir, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { acme: { options: { baseURL: "https://acme.test/v1" }, models: { m1: {}, m2: {} } } } }));
  mkdirSync(join(dir, "bin"));
  for (const bin of ["claude", "codex", "opencode"]) { writeFileSync(join(dir, "bin", bin), "#!/bin/sh\nexit 1\n"); chmodSync(join(dir, "bin", bin), 0o755); }
  withLoginIndicators({ home: dir } as Ctx);
  return dir;
}
const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
const files = (dir: string) => {
  const pacer = join(dir, ".pacer"), evidence = join(pacer, "state", "evidence");
  return {
    strategy: read(join(pacer, "strategy.yaml")),
    state: read(join(pacer, "endpoints", "state.json")),
    opencode: read(join(dir, ".config", "opencode", "opencode.json")),
    work: existsSync(join(dir, ".codex-work")),
    evidence: existsSync(evidence) ? Object.fromEntries(readdirSync(evidence).filter(name => name.endsWith(".json")).sort()
      .map(name => [name, readFileSync(join(evidence, name), "utf8").replace(/"retiredAt":[\d.]+/, '"retiredAt":"<now>"')])) : {},
  };
};
const events = (dir: string) => {
  const path = join(dir, ".pacer", "link", "outbox.jsonl");
  if (!existsSync(path)) return [];
  // The TypeScript core publishes asynchronously, so compare the events without ids, clocks or interleaving.
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.stringify(JSON.parse(line).envelope)
    .replace(/"(id|at)":"?\d+\.\d+(-[0-9a-f]+)?"?/g, '"$1":"<now>"').replace(/"id":"<now>","value"/, '"value"')).sort();
};

const endpoint = (name: string, extra: Record<string, unknown> = {}) => ({ name, kind: "endpoint", base_url: `https://${name}.test/v1`,
  key_source: "none", models: [{ id: "x1", context: 2000, output: 200, tools: false, name: "X One" }], usage: "unmetered", test: false, ...extra });

test.skipIf(!front)("account writes and refusals match forced forwarding, files and events", async () => {
  const cases: [string, unknown][] = [
    ["account.remove", { name: "claude" }],
    ["account.remove", { name: "nope" }],
    ["account.remove", { name: "ep", delete_home: true }],
    ["account.remove", { name: "shared", delete_home: true }],
    ["account.remove", { name: "work", delete_home: true }],
    ["account.add", endpoint("new1")],
    ["account.add", endpoint("new2", { key_source: "env", env_var: "NEW2_KEY", usage: "metered", weekly_tokens: 5000 })],
    ["account.add", endpoint("ep")],
    ["account.add", endpoint("new3", { key_source: "file" })],
    ["account.add", endpoint("Bad_Name")],
    ["account.edit", { name: "ep", usage: "unmetered" }],
    ["account.edit", { name: "fk", base_url: "https://fk2.test/v1", models: [{ id: "f2", context: 10, output: 5, tools: true }] }],
    ["account.edit", { name: "ext" }],
    ["account.edit", { name: "claude", usage: "metered" }],
    ["account.adopt", { name: "ext", key_source: "env", env_var: "EXT_KEY" }],
    ["account.adopt", { name: "ep", key_source: "none" }],
    ["account.adopt", { name: "spare", key_source: "none" }],
    ["account.usage.check", { account: "nope" }],
    ["account.usage.check", { account: "spare" }],
    ["account.usage.check", { account: "claude" }],
    ["account.usage.check", { account: "passive", consent: true }],
    ["account.models", { name: "claude" }],
    ["account.models", {}],
    ["account.models", { name: "new2" }],
    ["account.test", { name: "codex" }],
    ["account.remove", { name: "new1" }],
    ["account.remove", { name: "spare" }],
  ];
  const homes = [home(), home()];
  const native = await exchange(homes[0]!, requests(cases), false);
  const forwarded = await exchange(homes[1]!, requests(cases), true);
  expect(native).toEqual(forwarded);
  expect(files(homes[0]!)).toEqual(files(homes[1]!));
  expect(events(homes[0]!)).toEqual(events(homes[1]!));
  expect(JSON.parse(native[4]!).result).toEqual({ removed: true });
  expect(files(homes[0]!).work).toBe(false);
  expect(JSON.parse(native[5]!).result.state).toBe("not_tested");
  expect(JSON.parse(native[6]!).result.state).toBe("key_missing");
  expect(JSON.parse(native[14]!).result.runner.model).toBe("pacer-ext/m1");
  expect(JSON.parse(native[25]!).error.data.code).toBe("conflict");
  expect(Object.keys(files(homes[0]!).evidence)).toHaveLength(2);
}, 120000);

test.skipIf(!front)("legacy strategies migrate before native account writes", async () => {
  const legacy = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n";
  const cases: [string, unknown][] = [["account.add", endpoint("new1")]];
  const removal: [string, unknown][] = [["account.remove", { name: "codex" }]];
  for (const steps of [cases, removal]) {
    const homes = [home(), home()];
    for (const dir of homes) writeFileSync(join(dir, ".pacer", "strategy.yaml"), legacy);
    const native = await exchange(homes[0]!, requests(steps), false);
    if (steps === cases) expect(native[0]).toContain('"migrated"');
    expect(native).toEqual(await exchange(homes[1]!, requests(steps), true));
    expect(files(homes[0]!)).toEqual(files(homes[1]!));
    expect(readdirSync(join(homes[0]!, ".pacer")).filter(name => name.includes("bak")))
      .toEqual(readdirSync(join(homes[1]!, ".pacer")).filter(name => name.includes("bak")));
  }
}, 60000);

test.skipIf(!front)("account inputs only TypeScript owns stay forwarded", async () => {
  const cases: [string, unknown][] = [
    ["account.remove", { name: "../work" }],
    ["account.remove", { name: "constructor" }],
    ["account.remove", null],
    ["account.add", { name: "x", kind: "endpoint" }],
    ["account.add", endpoint("tested", { test: true, base_url: "http://127.0.0.1:1/v1" })],
    ["account.edit", { name: "ep", models: [] }],
    ["account.adopt", { name: "ext" }],
    ["account.usage.check", { account: 5 }],
    ["account.models", { name: "ep", key: "sk-supplied" }],
    ["account.models", { base_url: "http://127.0.0.1:1/v1" }],
    ["account.test", {}],
  ];
  const homes = [home(), home()];
  const native = await exchange(homes[0]!, requests(cases), false, {}, false);
  const forwarded = await exchange(homes[1]!, requests(cases), true);
  expect(native).toEqual(forwarded);
  expect(files(homes[0]!)).toEqual(files(homes[1]!));
  expect(native.join("\n")).not.toContain("sk-supplied");
  const broken = home();
  writeFileSync(join(broken, ".pacer", "strategy.yaml"), "accounts: [unclosed\n");
  const loads = requests([["account.remove", { name: "work" }], ["account.edit", { name: "ep" }], ["account.test", { name: "ep" }]]);
  expect(await exchange(broken, loads, false, {}, false)).toEqual(await exchange(broken, loads, true));
}, 120000);

test.skipIf(!front)("an enforcement identity is refused natively", async () => {
  const dir = home();
  const enforced = requests([["account.remove", { name: "work" }], ["account.models", {}], ["account.add", endpoint("new1")]]);
  const env = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  expect(await exchange(dir, enforced, false, env)).toEqual(await exchange(dir, enforced, true, env));
  expect(read(join(dir, ".pacer", "strategy.yaml"))).toBe(STRATEGY);
}, 60000);

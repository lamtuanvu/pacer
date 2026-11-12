import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closedPort, isolatedEnv } from "./isolated-port";

// runner.set with a string model from the native front door against the same
// requests forced through PACER_FORWARD_OPS=runner.set, over stdio and HTTP.
// Build with `cargo build -p pacer --features test-ops` and run with
// PACER_TEST_NATIVE_FRONT_DOOR=<abs path>/target/debug/pacer.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

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
        - {id: a, context: 64000, output: 32000, tools: true}
        - {id: b, context: 64000, output: 32000, tools: true}
        - {id: xa, context: 64000, output: 32000, tools: true}
        - {id: "x😁", context: 64000, output: 32000, tools: true}
        - {id: "模型", context: 64000, output: 32000, tools: true}
  beta:
    kind: endpoint
    usage: unmetered
    connection:
      api: openai-compatible
      base_url: https://beta.example.com
      key: none
      models:
        - {id: one, context: 64000, output: 32000, tools: true}
  oc-fresh: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
  oc-null: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
  oc-stale: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
  oc-odd: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
  oc-miss: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
runners:
  claude-code: {}
  codex: {}
  opencode#acme: {model: pacer-acme/a}
  opencode#beta: {model: pacer-beta/one}
  opencode#oc-fresh: {model: acme/a}
  opencode#oc-null: {model: acme/a}
  opencode#oc-stale: {model: acme/a}
  opencode#oc-odd: {model: acme/a}
  opencode#oc-miss: {model: acme/a}
routing:
  - kinds: [docs]
    executors: [opencode#oc-null]
  - default: [opencode#acme, opencode#beta, opencode#oc-fresh, opencode#oc-stale, opencode#oc-odd, opencode#oc-miss, codex]
`;

// [params, served natively]
const CASES: [Record<string, unknown>, boolean][] = [
  [{ id: "codex", model: "gpt-x" }, true],
  [{ id: "opencode#acme", model: "pacer-acme/b" }, true],
  [{ id: "opencode#acme", model: "pacer-acme/x😀" }, true],
  [{ id: "acme", model: "pacer-acme/模形" }, true],
  [{ id: "opencode#acme", model: "pacer-acme/nope", rank: 1 }, true],
  [{ id: "missing", model: "x" }, true],
  [{ id: "claude-code", model: "x" }, true],
  [{ id: "opencode#acme", model: "pacer-acme/a", rank: 1.5 }, true],
  [{ id: "opencode#beta", model: "pacer-beta/one" }, true],
  [{ id: "opencode#oc-fresh", model: "acme/b" }, true],
  [{ id: "opencode#oc-fresh", model: "acme/zz" }, true],
  [{ id: "opencode#oc-null", enabled: false, model: "acme/q" }, true],
  [{ id: "opencode#oc-stale", model: "acme/c" }, false],
  [{ id: "opencode#oc-odd", model: "acme/x" }, false],
  [{ id: "opencode#oc-miss", model: "acme/nope" }, false],
];

function home(): string {
  // host.sock must fit SUN_LEN; bun test's TMPDIR is too deep for the native front door.
  const dir = mkdtempSync("/tmp/prm-"), pacer = join(dir, ".pacer"), bin = join(dir, "bin");
  mkdirSync(pacer, { mode: 0o700 });
  mkdirSync(bin);
  writeFileSync(join(pacer, "strategy.yaml"), STRATEGY, { mode: 0o600 });
  // Stand-in OpenCode: logs each call and lists three acme models.
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "$*" >> "${join(dir, "opencode-calls.log")}"\nprintf 'acme/a\\nacme/b\\nacme/c\\nother/x\\n'\n`);
  chmodSync(join(bin, "opencode"), 0o755);
  const now = Date.now() / 1000;
  const seed = (runner: string, value: unknown) => {
    const cache = join(pacer, "cache", "available-models");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    writeFileSync(join(cache, `${createHash("sha256").update(runner).digest("hex")}.json`), JSON.stringify(value), { mode: 0o600 });
  };
  const listing = (runner: string, models: unknown, fetchedAt: number, extra: Record<string, unknown> = {}) =>
    seed(runner, { runner, source: "opencode", models, fetchedAt, provider: "acme", ...extra });
  listing("opencode#acme", [{ id: "stale" }], now - 3600);
  listing("opencode#beta", [{ id: "cached/one" }, { id: "cached/two" }], now);
  listing("opencode#oc-fresh", [{ id: "acme/a" }, { id: "acme/b", name: "B" }, { id: "acme/zy" }, { id: "acme/z" }], now);
  listing("opencode#oc-null", null, now, { note: "seeded note" });
  listing("opencode#oc-stale", [{ id: "acme/a" }], now - 601);
  listing("opencode#oc-odd", ["acme/a", "acme/b"], now);
  return dir;
}
function env(dir: string, forward: boolean, port = closedPort()) {
  return isolatedEnv({ HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
    PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: "runner.set" } : {}) }, port);
}
function state(dir: string) {
  const cache = join(dir, ".pacer", "cache", "available-models");
  const calls = join(dir, "opencode-calls.log");
  return {
    strategy: readFileSync(join(dir, ".pacer", "strategy.yaml"), "utf8"),
    caches: existsSync(cache) ? readdirSync(cache).filter(name => name.endsWith(".json")).sort() : [],
    opencode: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}
const markers = (stderr: string) => stderr.split("\n").filter(line => /^native runner\.set( \d+)?$/.test(line));

async function stdio(dir: string, forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], { cwd: dir, env: env(dir, forward), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const requests = CASES.map(([params], i) => JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "runner.set", params }));
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].result?.protocol).toBe("3.0.0");
    return { replies: lines.slice(1).sort((a, b) => a.id - b.id), markers: markers(stderr) };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

async function http(dir: string, forward: boolean) {
  const port = closedPort();
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { cwd: dir, env: env(dir, forward, port), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let token = "";
    for (let n = 0; n < 500 && !token; n++) {
      try {
        const candidate = readFileSync(join(dir, ".pacer", "token"), "utf8").trim();
        if ((await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) })).ok) token = candidate;
      } catch {}
      if (!token) await Bun.sleep(20);
    }
    expect(token).not.toBe("");
    const replies = [];
    for (const [params] of CASES) {
      const response = await fetch(`${base}/v3/ops/runner.set`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(params), signal: AbortSignal.timeout(60_000) });
      replies.push({ status: response.status, body: await response.json() });
    }
    return { replies, child, stderr };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  }
}

function checkReplies(replies: unknown[]) {
  const reply = (i: number) => replies[i] as { result?: any; error?: any; body?: any };
  const result = (i: number) => reply(i).result ?? reply(i).body?.result;
  const error = (i: number) => {
    const r = reply(i);
    return r.error ? { code: r.error.data.code, message: r.error.message, hint: r.error.data.hint } : r.body?.error;
  };
  expect(result(0)).toEqual({ id: "codex", warnings: [] });
  expect(result(1)).toEqual({ id: "opencode#acme", warnings: [] });
  // UTF-16 ranking: x😁 shares the high surrogate of x😀.
  expect(error(2)).toMatchObject({ code: "invalid_input", message: "pacer-acme/x😀 is not offered by acme", hint: "Available: pacer-acme/x😁, pacer-acme/xa, pacer-acme/a" });
  expect(error(3)).toMatchObject({ code: "invalid_input", message: "pacer-acme/模形 is not offered by acme", hint: "Available: pacer-acme/模型, pacer-acme/a, pacer-acme/b" });
  expect(error(4)).toMatchObject({ code: "invalid_input", message: "pacer-acme/nope is not offered by acme" });
  expect(error(5)).toMatchObject({ code: "invalid_input", message: "unknown runner" });
  expect(error(6)).toMatchObject({ code: "not_allowed", message: "cannot edit the planner runner" });
  expect(error(7)?.code).toBe("invalid_input");
  // A fresh OpenCode listing cache is served even for a connection account.
  expect(error(8)).toMatchObject({ code: "invalid_input", message: "pacer-beta/one is not offered by beta", hint: "Available: cached/one, cached/two" });
  expect(result(9)).toEqual({ id: "opencode#oc-fresh", warnings: [] });
  expect(error(10)).toMatchObject({ code: "invalid_input", message: "acme/zz is not offered by acme", hint: "Available: acme/zy, acme/z, acme/a" });
  expect(result(11)).toEqual({ id: "opencode#oc-null", warnings: ["routing rule 'docs' has no enabled executor left", "acme/q could not be checked: seeded note"] });
  expect(result(12)).toEqual({ id: "opencode#oc-stale", warnings: [] });
  expect(error(13)?.code).toBe("internal");
  expect(error(14)).toMatchObject({ code: "invalid_input", message: "acme/nope is not offered by acme", hint: "Available: acme/a, acme/b, acme/c" });
}

test.skipIf(!front)("runner.set model checks over stdio match forced forwarding, strategy bytes and OpenCode calls", async () => {
  const dirs = [home(), home()];
  try {
    const native = await stdio(dirs[0]!, false);
    const forwarded = await stdio(dirs[1]!, true);
    expect(native.replies).toEqual(forwarded.replies);
    checkReplies(native.replies);
    expect(state(dirs[0]!)).toEqual(state(dirs[1]!));
    expect(state(dirs[0]!).opencode).toBe("models\nmodels\n");
    expect(state(dirs[0]!).strategy).toContain("opencode#oc-stale: {model: acme/c}");
    expect(state(dirs[0]!).strategy).toContain("codex: {model: gpt-x}");
    expect(native.markers).toEqual(CASES.flatMap(([, served], i) => served ? [`native runner.set ${i + 2}`] : []));
    expect(forwarded.markers).toEqual([]);
  } finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test.skipIf(!front)("runner.set model checks over HTTP match forced forwarding, strategy bytes and OpenCode calls", async () => {
  const dirs = [home(), home()];
  try {
    const native = await http(dirs[0]!, false);
    const forwarded = await http(dirs[1]!, true);
    expect(native.replies).toEqual(forwarded.replies);
    checkReplies(native.replies);
    expect(native.replies.map(r => r.status)).toEqual([200, 200, 400, 400, 400, 400, 403, 400, 400, 200, 400, 200, 200, 500, 400]);
    expect(state(dirs[0]!)).toEqual(state(dirs[1]!));
    expect(state(dirs[0]!).opencode).toBe("models\nmodels\n");
    expect(markers(await native.stderr)).toEqual(CASES.flatMap(([, served]) => served ? ["native runner.set"] : []));
    expect(markers(await forwarded.stderr)).toEqual([]);
  } finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

/**
 * Front-door harness for the native repository registry ops: the same requests run natively and
 * forced through PACER_FORWARD_OPS to the TypeScript core, over stdio or HTTP, on twin homes.
 * Replies and both registry files (bytes, modes, file types) must match after every step.
 */
import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { closedPort, spawnPinned } from "./port-isolation";

export const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const FILES = ["repos.json", "repo-paths.json", "../project-strategies.json"];

/** `$H` in seeds and params names the home's real path. */
export type Step = { op: string; params?: unknown; native: boolean; feed?: string };
export type Seed = { repos?: string | Uint8Array; aliases?: string | Uint8Array; strategies?: string; setup?: (state: string, dir: string) => void };
export type Case = { name: string; seed: Seed; steps: Step[] };
type Outcome = { reply: string; files: (string | null)[] };

const env = (dir: string, port: string, forward: string | null) => ({
  HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: core, PACER_PORT: port,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...(forward ? { PACER_FORWARD_OPS: forward } : {}),
});

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

/**
 * Four plain folders under `r/`, a GitHub checkout `added` with a linked worktree `added-wt`,
 * and a `gh` that logs its arguments and finds one issue.
 */
export function home(): string {
  const dir = tmpDir();
  mkdirSync(join(dir, ".pacer", "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".pacer", "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  for (const name of ["a", "b", "c", "d"]) mkdirSync(join(dir, "r", name), { recursive: true });
  const added = join(dir, "added");
  mkdirSync(added);
  git(added, "init", "-q", "-b", "main");
  git(added, "commit", "-q", "--allow-empty", "-m", "x");
  git(added, "remote", "add", "origin", "https://github.com/acme/added.git");
  git(added, "worktree", "add", "-q", join(dir, "added-wt"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, "gh.log")}'\necho '[{"number":1,"title":"bug","labels":[],"url":"https://github.com/acme/added/issues/1","state":"OPEN"}]'\n`);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  return dir;
}

// TypeScript caches each registry by inode, mtime, ctime and size: every seed gets a new
// inode and a later mtime.
let stamp = 1_800_000_000;
export function put(path: string, bytes: string | Uint8Array) {
  writeFileSync(`${path}.seed`, bytes);
  renameSync(`${path}.seed`, path);
  stamp += 10;
  utimesSync(path, stamp, stamp);
}

const expand = (bytes: string | Uint8Array, dir: string) => Buffer.from(Buffer.from(bytes).toString("latin1").replaceAll("$H", realpathSync(dir)), "latin1");
const params = (value: unknown, dir: string) => value === undefined ? {} : { params: JSON.parse(JSON.stringify(value).replaceAll("$H", realpathSync(dir))) };

function seed(dir: string, s: Seed) {
  const state = join(dir, ".pacer", "state");
  for (const name of FILES) rmSync(join(state, name), { recursive: true, force: true });
  if (s.repos !== undefined) put(join(state, "repos.json"), expand(s.repos, dir));
  if (s.aliases !== undefined) put(join(state, "repo-paths.json"), expand(s.aliases, dir));
  if (s.strategies !== undefined) put(join(state, "../project-strategies.json"), expand(s.strategies, dir));
  s.setup?.(state, dir);
}

function describe(path: string, dir: string): string | null {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isSymbolicLink()) return `symlink ${readlinkSync(path).replaceAll(dir, "<home>")}`;
  if (st.isDirectory()) return "directory";
  if (st.isFIFO()) return "fifo";
  const mode = (st.mode & 0o777).toString(8);
  try { return clean(`${mode} ${readFileSync(path).toString("latin1")}`, dir); } catch { return `${mode} unreadable`; }
}
const snapshot = (dir: string) => FILES.map(name => describe(join(dir, ".pacer", "state", name), dir));

/**
 * Twin homes differ in their paths, temporary file names and the time `repo.add` stamps;
 * seeds keep `lastUsed` below ten digits so only those stamps read as `<now>`.
 */
export const clean = (text: string, dir: string) => text.replaceAll(realpathSync(dir), "<home>").replaceAll(dir, "<home>")
  .replace(/\.\d+\.[0-9a-f-]{36}\.tmp/g, ".<tmp>").replace(/("lastUsed":)\d{10}(\.\d+)?(?!\d)/g, "$1<now>");

/** Feeds a FIFO registry once the core opens it, so a forwarded request can finish. */
function feed(dir: string, name: string, text: string) {
  const writer = Bun.spawn(["sh", "-c", 'printf "%s" "$1" > "$2"', "sh", text, join(dir, ".pacer", "state", name)], { stdout: "ignore", stderr: "ignore" });
  return writer.exited;
}

const nativeMarkers = (stderr: string, cases: Case[]) => {
  const ops = new Set(cases.flatMap(c => c.steps.map(s => s.op)));
  return stderr.split("\n").filter(line => line.startsWith("native ") && ops.has(line.split(" ")[1]!));
};

/** Stdio in lockstep: one request, its reply, then the next step or seed. */
async function stdio(dir: string, forward: string | null, cases: Case[]) {
  const child = spawnPinned([front!, "api", "--stdio"], { cwd: dir, env: env(dir, closedPort(), forward), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffered = "";
  const line = async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdio closed: ${await stderr}`);
      buffered += new TextDecoder().decode(value);
    }
    const at = buffered.indexOf("\n"), out = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return out;
  };
  const send = (value: object) => { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } });
    expect(JSON.parse(await line()).result?.protocol).toBe("3.0.0");
    const out: Outcome[] = [];
    let id = 1;
    for (const c of cases) {
      seed(dir, c.seed);
      for (const step of c.steps) {
        send({ jsonrpc: "2.0", id: ++id, method: step.op, ...params(step.params, dir) });
        const fed = step.feed ? feed(dir, step.feed, "{}") : undefined;
        out.push({ reply: clean(await line(), dir), files: snapshot(dir) });
        await fed;
      }
    }
    child.stdin.end();
    await child.exited;
    return { out, markers: nativeMarkers(await stderr, cases) };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

export async function serve(dir: string, forward: string | null) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", port], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: env(dir, port, forward) });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "", ready = false;
  for (let n = 0; n < 1000 && !ready; n++) {
    try {
      token = readFileSync(join(dir, ".pacer/token"), "utf8").trim();
      ready = (await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!ready) await Bun.sleep(20);
  }
  if (!ready) { child.kill("SIGTERM"); await child.exited; throw new Error(`serve did not start: ${await stderr}`); }
  return {
    post: async (op: string, body: unknown) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(params(body, dir).params ?? {}), signal: AbortSignal.timeout(20000) });
      return `${response.status} ${clean(await response.text(), dir)}`;
    },
    stop: async () => { child.kill("SIGTERM"); await child.exited; return await stderr; },
  };
}

async function http(dir: string, forward: string | null, cases: Case[]) {
  const server = await serve(dir, forward);
  const out: Outcome[] = [];
  try {
    for (const c of cases) {
      seed(dir, c.seed);
      for (const step of c.steps) out.push({ reply: await server.post(step.op, step.params), files: snapshot(dir) });
    }
  } catch (error) { await server.stop(); throw error; }
  return { out, markers: nativeMarkers(await server.stop(), cases) };
}

/**
 * Runs the cases natively and with `forward` forced to the core on twin homes, expects equal
 * outcomes and a native marker for exactly the steps marked native. Returns the native outcomes
 * and the `gh` log of each home.
 */
export async function differential(transport: "stdio" | "http", cases: Case[], forward: string) {
  const run = async (forced: boolean) => {
    const dir = home();
    const result = await (transport === "stdio" ? stdio : http)(dir, forced ? forward : null, cases);
    let gh = "";
    try { gh = clean(readFileSync(join(dir, "gh.log"), "utf8"), dir); } catch {}
    return { ...result, gh };
  };
  const [native, forwarded] = await Promise.all([run(false), run(true)]);
  const steps = cases.flatMap(c => c.steps.map(step => ({ name: c.name, step })));
  steps.forEach(({ name, step }, i) => expect(native.out[i], `${name}: ${step.op}`).toEqual(forwarded.out[i]!));
  expect(native.gh).toBe(forwarded.gh);
  expect(native.markers).toEqual(steps.flatMap(({ step }, i) => step.native ? [transport === "stdio" ? `native ${step.op} ${i + 2}` : `native ${step.op}`] : []));
  expect(forwarded.markers).toEqual([]);
  return { out: native.out, gh: native.gh };
}

const E = (name: string, lastUsed = "1", more = "") => `{"key":"github.com/acme/${name}","path":"$H/r/${name}","lastUsed":${lastUsed}${more}}`;
const obj = (...pairs: [string, string][]) => `{${pairs.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
const REG = obj(["$H/r/a", E("a", "3")], ["$H/r/b", E("b", "5.25", ',"extra":{"pinned":true,"n":[1.0,-0,1e21]}')], ["$H/r/c", E("c", "4")]);
const ALIASES = obj(["$H/r/a-wt", '"$H/r/a"']);
const deep = (levels: number) => obj(["$H/r/a", E("a", "1", `,"d":${"[".repeat(levels)}${"]".repeat(levels)}`)]);
const invalidUtf8 = Buffer.concat([Buffer.from(obj(["$H/r/a", E("a", "1", ',"x":"')])), Buffer.from([0xff, 0xfe]), Buffer.from('"}}')]);

/** A section 1a row: a seeded registry and whether `repo.list` and `repo.add` stay native. */
export type Row = { name: string; seed: Seed; list: boolean; add: boolean; feed?: string };

export const ROWS: Row[] = [
  // Section 1a "port" rows.
  { name: "TypeScript-written registry", seed: { repos: REG, aliases: ALIASES }, list: true, add: true },
  { name: "top-level array registry and numeric aliases", seed: { repos: `[${E("a", "3")},${E("b", "5")}]`, aliases: obj(["$H/r/a-wt", "0"], ["$H/added", "1"]) }, list: true, add: true },
  { name: "string aliases spread to index keys", seed: { repos: REG, aliases: '"/srv/é"' }, list: true, add: true },
  { name: "array aliases", seed: { repos: REG, aliases: '["$H/r/a",null]' }, list: true, add: true },
  { name: "scalar registries", seed: { repos: "5", aliases: "null" }, list: true, add: true },
  { name: "boolean registries", seed: { repos: "false", aliases: "true" }, list: true, add: true },
  { name: "trailing comma and a byte order mark", seed: { repos: `{"$H/r/a":${E("a")},}`, aliases: "\uFEFF" + ALIASES }, list: true, add: true },
  { name: "NaN literal and truncated aliases", seed: { repos: obj(["$H/r/a", E("a", "NaN")]), aliases: '{"$H/r/a-wt":"' }, list: true, add: true },
  { name: "invalid UTF-8 reads lossily", seed: { repos: invalidUtf8, aliases: ALIASES }, list: true, add: true },
  { name: "infinite lastUsed", seed: { repos: obj(["$H/r/a", E("a", "1e400")], ["$H/r/b", E("b", "-1e400")], ["$H/r/c", E("c", "7")]) }, list: true, add: true },
  { name: "integer index keys enumerate first", seed: { repos: obj(["$H/r/b", E("b")], ["10", E("a")], ["2", E("c")], ["4294967295", E("d")]), aliases: obj(["$H/r/b-wt", '"$H/r/b"'], ["5", '"2"']) }, list: true, add: true },
  { name: "__proto__ is an own key", seed: { repos: obj(["__proto__", E("a", "2")], ["$H/r/b", E("b")]), aliases: obj(["__proto__", '"x"'], ["$H/added", '"$H/r/b"']) }, list: true, add: true },
  { name: "alias values convert like property keys", seed: { repos: obj(["1", E("a")], ["1,2", E("b")], ["[object Object]", E("c")], ["Infinity", E("d")]), aliases: obj(["$H/added", "[1,2]"], ["$H/x", "null"], ["$H/y", "true"], ["$H/z", '{"a":1}'], ["$H/v", "1.0"], ["$H/t", "1e400"]) }, list: true, add: true },
  { name: "a null alias falls back to the root", seed: { repos: REG, aliases: obj(["$H/added", "null"]) }, list: true, add: true },
  { name: "lastUsed converts with ToNumber", seed: { repos: obj(["$H/r/a", E("a", '"0x10"')], ["$H/r/b", E("b", '" 7 "')], ["$H/r/c", E("c", "true")], ["$H/r/d", E("d", "[3]")]) }, list: true, add: true },
  { name: "null and empty lastUsed are zero", seed: { repos: obj(["$H/r/a", E("a", "null")], ["$H/r/b", E("b", '""')], ["$H/r/c", E("c", "[]")]) }, list: true, add: true },
  { name: "every lastUsed missing", seed: { repos: obj(["$H/r/a", '{"key":"github.com/acme/a","path":"$H/r/a"}'], ["$H/r/b", '{"key":"github.com/acme/b","path":"$H/r/b"}']) }, list: true, add: true },
  { name: "nesting at the reader limit", seed: { repos: deep(127) }, list: true, add: true },
  { name: "registry directory", seed: { setup: state => mkdirSync(join(state, "repos.json")) }, list: true, add: false },
  { name: "aliases directory", seed: { repos: REG, setup: state => mkdirSync(join(state, "repo-paths.json")) }, list: true, add: false },
  // Rows that stay forwarded.
  { name: "string registry", seed: { repos: '"ab"' }, list: false, add: false },
  { name: "null entry", seed: { repos: obj(["$H/r/a", E("a")], ["$H/r/b", "null"]) }, list: false, add: false },
  { name: "numeric key", seed: { repos: obj(["$H/r/a", '{"key":5,"path":"$H/r/a","lastUsed":1}']) }, list: false, add: false },
  { name: "entry without a path", seed: { repos: obj(["$H/r/a", '{"key":"k","lastUsed":1}']) }, list: false, add: false },
  { name: "relative path (Q4)", seed: { repos: obj(["$H/r/a", '{"key":"k","path":"r/a","lastUsed":1}']) }, list: false, add: false },
  { name: "lastUsed with its own toString", seed: { repos: obj(["$H/r/a", E("a", '{"toString":1}')], ["$H/r/b", E("b")]) }, list: false, add: false },
  { name: "NaN beside numbers", seed: { repos: obj(["$H/r/a", E("a", '"x"')], ["$H/r/b", E("b")], ["$H/r/c", E("c", "2")]) }, list: false, add: false },
  { name: "relative alias value (Q4)", seed: { repos: REG, aliases: obj(["$H/r/a-wt", '"r/a"']) }, list: false, add: false },
  { name: "alias naming a registry key that is not a path (Q4)", seed: { repos: obj(["__proto__", E("a")], ["10", E("b")]), aliases: obj(["$H/added", '"__proto__"'], ["$H/r/b-wt", '"10"']) }, list: false, add: false },
  { name: "alias naming an inherited property", seed: { repos: REG, aliases: obj(["$H/added", '"constructor"']) }, list: false, add: false },
  { name: "alias whose toString is data", seed: { repos: REG, aliases: obj(["$H/added", '{"toString":1}']) }, list: false, add: false },
  { name: "lone surrogate", seed: { repos: obj(["$H/r/\ud800", E("a")]) }, list: false, add: false },
  { name: "nesting past the reader limit (Q5)", seed: { repos: deep(128) }, list: false, add: false },
  { name: "FIFO registry", seed: { setup: state => execFileSync("mkfifo", [join(state, "repos.json")]) }, list: false, add: false, feed: "repos.json" },
];

// The service pump also reads the registry, so a FIFO registry is exercised over stdio only.
export const rows = (transport: "stdio" | "http") => ROWS.filter(row => transport === "stdio" || !row.feed);

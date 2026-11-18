import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { closedPort, spawnPinned } from "./port-isolation";

// Native repo.remove against the same requests forced through PACER_FORWARD_OPS to the
// TypeScript core, over stdio and HTTP, on twin homes: replies, both registry files (bytes,
// modes, file types and symlink targets) and the pump's repo entity events.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const FILES = ["repos.json", "repo-paths.json"];

type Seed = { repos?: string | Uint8Array; aliases?: string | Uint8Array; setup?: (state: string, dir: string) => void };
type Case = { seed: Seed; params: unknown; native: boolean; feed?: string };

const env = (dir: string, port: string, forward: string | null) => ({
  HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: "/usr/bin:/bin", PACER_CORE_ARGV: core, PACER_PORT: port,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...(forward ? { PACER_FORWARD_OPS: forward } : {}),
});

function home(): string {
  const dir = tmpDir();
  mkdirSync(join(dir, ".pacer", "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".pacer", "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return dir;
}

// TypeScript caches each registry by inode, mtime, ctime and size: every seed gets a new
// inode and a later mtime.
let stamp = 1_800_000_000;
function put(path: string, bytes: string | Uint8Array) {
  writeFileSync(`${path}.seed`, bytes);
  renameSync(`${path}.seed`, path);
  stamp += 10;
  utimesSync(path, stamp, stamp);
}

function seed(dir: string, s: Seed) {
  const state = join(dir, ".pacer", "state");
  for (const name of [...FILES, "../../real.json", "../../nowhere.json"]) rmSync(join(state, name), { recursive: true, force: true });
  if (s.repos !== undefined) put(join(state, "repos.json"), s.repos);
  if (s.aliases !== undefined) put(join(state, "repo-paths.json"), s.aliases);
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
const snapshot = (dir: string) => [...FILES.map(name => join(dir, ".pacer", "state", name)), join(dir, "real.json"), join(dir, "nowhere.json")]
  .map(path => describe(path, dir));
// A forwarded write onto a directory names its random temporary file.
const clean = (text: string, dir: string) => text.replaceAll(realpathSync(dir), "<home>").replaceAll(dir, "<home>").replace(/\.\d+\.[0-9a-f-]{36}\.tmp/g, ".<tmp>");

/** Feeds a FIFO registry once the core opens it, so a forwarded request can finish. */
function feed(dir: string, name: string, text: string) {
  const writer = Bun.spawn(["sh", "-c", 'printf "%s" "$1" > "$2"', "sh", text, join(dir, ".pacer", "state", name)], { stdout: "ignore", stderr: "ignore" });
  return writer.exited;
}

const reg = (entries: Record<string, unknown>) => JSON.stringify(entries);
const TS_WRITTEN = reg({
  "/srv/app": { key: "github.com/acme/app", path: "/srv/app", lastUsed: 1_731_380_000.123456 },
  "/srv/tool": { key: "local:0123456789ab", path: "/srv/tool", lastUsed: 1_731_390_000.5, extra: { pinned: true } },
  "/srv/app-copy": { key: "github.com/acme/app", path: "/srv/app-copy", lastUsed: 1e21 },
});
const ALIASES = reg({ "/srv/app-wt": "/srv/app", "/srv/tool-wt": "/srv/tool", "/srv/copy-wt": "/srv/app-copy" });
const deep = (levels: number) => `{"/a":{"key":"k","d":${"[".repeat(levels)}${"]".repeat(levels)}}}`;
const key = (value: string) => ({ key: value });
const invalidUtf8 = new Uint8Array([...Buffer.from('{"/a'), 0xff, ...Buffer.from('":{"key":"k","path":"/a","lastUsed":1}}')]);

const CASES: Case[] = [
  // Section 1b "port" rows.
  { seed: { repos: TS_WRITTEN, aliases: ALIASES }, params: key("github.com/acme/app"), native: true },
  { seed: { repos: TS_WRITTEN, aliases: ALIASES }, params: key("absent"), native: true },
  { seed: { repos: '{"/b":{"key":"x"},"10":{"key":"one"},"2":{"key":"y"},"4294967295":{"key":"z"}}', aliases: '{"/z":"10","5":"2"}' }, params: key("one"), native: true },
  { seed: { repos: '{"__proto__":{"key":"one","path":"/p"},"/b":{"key":"two","x":1}}', aliases: '{"__proto__":"__proto__","/q":"/b"}' }, params: key("two"), native: true },
  { seed: { repos: '{"/a":{"key":"k","path":"/a","lastUsed":1e400,"n":-0,"m":9007199254740993,"e":1e21,"s":1e-7,"x":[1.0,-1e-400]},"/a":{"key":"k","lastUsed":2.5}}' }, params: key("zzz"), native: true },
  { seed: { repos: '[{"key":"one","path":"/a"},{"key":"two"},5,"s"]', aliases: '["/a","0",1,"0"]' }, params: key("one"), native: true },
  { seed: { repos: '"ab\u{1F600}"' }, params: key("one"), native: true },
  { seed: { repos: "5", aliases: "7" }, params: key("one"), native: true },
  { seed: { repos: "false", aliases: "false" }, params: key("one"), native: true },
  { seed: { repos: "null", aliases: "null" }, params: key("one"), native: true },
  { seed: { repos: '{"a":{"key":"one"}}', aliases: '"bc"' }, params: key("one"), native: true },
  { seed: { repos: '{"/a":{"key":"one"}}', aliases: '{"/x":1,"/y":null,"/z":true,"/w":{"a":1},"/v":["/a"],"/u":"/a","/t":1e400}' }, params: key("one"), native: true },
  { seed: { repos: "\uFEFF" + TS_WRITTEN, aliases: '{"/x":"/srv/app",}' }, params: key("github.com/acme/app"), native: true },
  { seed: { repos: invalidUtf8, aliases: "{" }, params: key("zzz"), native: true },
  { seed: { repos: deep(127) }, params: key("zzz"), native: true },
  // Maintainer decision Q3: symlinks are followed and unreadable files read as {}.
  { seed: { setup: (state, dir) => { put(join(dir, "real.json"), TS_WRITTEN); symlinkSync(join(dir, "real.json"), join(state, "repos.json")); symlinkSync(join(dir, "nowhere.json"), join(state, "repo-paths.json")); } }, params: key("local:0123456789ab"), native: true },
  { seed: { repos: TS_WRITTEN, aliases: ALIASES, setup: state => chmodSync(join(state, "repos.json"), 0) }, params: key("local:0123456789ab"), native: true },
  { seed: { repos: TS_WRITTEN, aliases: ALIASES, setup: state => chmodSync(join(state, "repo-paths.json"), 0) }, params: key("github.com/acme/app"), native: true },
  // Params: Zod strips unknown keys and reads a null params object as {}.
  { seed: { repos: TS_WRITTEN, aliases: ALIASES }, params: { key: "local:0123456789ab", extra: 1 }, native: true },
  { seed: {}, params: null, native: true },
  { seed: {}, params: {}, native: true },
  { seed: {}, params: { key: 1 }, native: true },
  { seed: {}, params: { key: null }, native: true },
  { seed: {}, params: { key: "" }, native: true },
  { seed: {}, params: [], native: true },
  { seed: {}, params: "x", native: true },
  // Rows that stay forwarded.
  { seed: { repos: '[null]' }, params: key("one"), native: false },
  { seed: { repos: '{"/a":{"key":"one"},"/b":null}' }, params: key("one"), native: false },
  { seed: { repos: '{"a":{"key":"one"}}', aliases: '"ab"' }, params: key("one"), native: false },
  { seed: { repos: '"\\ud800"' }, params: key("one"), native: false },
  { seed: { repos: TS_WRITTEN, aliases: '{"/x\\udc00":"/srv/app"}' }, params: key("github.com/acme/app"), native: false },
  { seed: { repos: deep(128) }, params: key("zzz"), native: false },
  { seed: { repos: TS_WRITTEN, setup: state => mkdirSync(join(state, "repo-paths.json")) }, params: key("github.com/acme/app"), native: false },
  { seed: { aliases: ALIASES, setup: (state, dir) => { mkdirSync(join(dir, "real.json")); symlinkSync(join(dir, "real.json"), join(state, "repos.json")); } }, params: key("one"), native: false },
  { seed: { aliases: ALIASES, setup: state => execFileSync("mkfifo", [join(state, "repos.json")]) }, params: key("github.com/acme/app"), native: false, feed: "repos.json" },
];

type Reply = { reply: string; files: (string | null)[] };

/** Stdio in lockstep: one request, its reply, then the next case's seed. */
async function stdio(dir: string, forward: boolean, cases: Case[]) {
  const child = spawnPinned([front!, "api", "--stdio"], { cwd: dir, env: env(dir, closedPort(), forward ? "repo.remove" : null), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
    const out: Reply[] = [];
    for (const [i, c] of cases.entries()) {
      seed(dir, c.seed);
      send({ jsonrpc: "2.0", id: i + 2, method: "repo.remove", ...(c.params === undefined ? {} : { params: c.params }) });
      const fed = c.feed ? feed(dir, c.feed, "{}") : undefined;
      out.push({ reply: clean(await line(), dir), files: snapshot(dir) });
      await fed;
    }
    child.stdin.end();
    await child.exited;
    const markers = (await stderr).split("\n").filter(text => /^native repo\.remove /.test(text));
    return { out, markers };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

async function serve(dir: string, forward: string | null) {
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
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      return `${response.status} ${clean(await response.text(), dir)}`;
    },
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(text => /^native repo\./.test(text)); },
  };
}

async function http(dir: string, forward: boolean, cases: Case[]) {
  const server = await serve(dir, forward ? "repo.remove" : null);
  const out: Reply[] = [];
  try {
    for (const c of cases) {
      seed(dir, c.seed);
      out.push({ reply: await server.post("repo.remove", c.params), files: snapshot(dir) });
    }
  } catch (error) { await server.stop(); throw error; }
  return { out, markers: await server.stop() };
}

test.skipIf(!front)("repo.remove over stdio matches forced forwarding: replies, file bytes and forwarding rows", async () => {
  const [native, forwarded] = await Promise.all([stdio(home(), false, CASES), stdio(home(), true, CASES)]);
  CASES.forEach((c, i) => expect(native.out[i], JSON.stringify(c.params) + " " + String(c.seed.repos ?? "")).toEqual(forwarded.out[i]!));
  expect(native.markers).toEqual(CASES.flatMap((c, i) => c.native ? [`native repo.remove ${i + 2}`] : []));
  expect(forwarded.markers).toEqual([]);
  // The ported rows rewrite TypeScript-written registries natively.
  expect(native.out[0]!.files[0]).toBe(`600 ${reg({ "/srv/tool": { key: "local:0123456789ab", path: "/srv/tool", lastUsed: 1_731_390_000.5, extra: { pinned: true } } })}`);
  expect(native.out[0]!.files[1]).toBe(`600 ${reg({ "/srv/tool-wt": "/srv/tool" })}`);
  const symlinked = native.out[15]!.files;
  expect(symlinked.slice(0, 2)).toEqual([`600 ${reg({ "/srv/app": JSON.parse(TS_WRITTEN)["/srv/app"], "/srv/app-copy": JSON.parse(TS_WRITTEN)["/srv/app-copy"] })}`, "600 {}"]);
  expect(symlinked[2]!.endsWith(` ${TS_WRITTEN}`)).toBe(true);
  expect(symlinked[3]).toBeNull();
}, 180000);

// The service pump also reads the registry, so a FIFO registry is exercised over stdio only.
const HTTP_CASES = CASES.filter(c => !c.feed);

test.skipIf(!front)("repo.remove over HTTP matches forced forwarding: replies, file bytes and forwarding rows", async () => {
  const [native, forwarded] = await Promise.all([http(home(), false, HTTP_CASES), http(home(), true, HTTP_CASES)]);
  HTTP_CASES.forEach((c, i) => expect(native.out[i], JSON.stringify(c.params) + " " + String(c.seed.repos ?? "")).toEqual(forwarded.out[i]!));
  expect(native.markers).toEqual(HTTP_CASES.filter(c => c.native).map(() => "native repo.remove"));
  expect(forwarded.markers).toEqual([]);
  expect(native.out[19]!.reply).toBe('400 {"error":{"code":"invalid_input","message":"key: Invalid input: expected string, received undefined"}}');
}, 180000);

test.skipIf(!front)("a symlinked state directory is written through like TypeScript", async () => {
  const run = async (forward: boolean) => {
    const dir = home(), real = join(dir, "real-state");
    rmSync(join(dir, ".pacer", "state"), { recursive: true });
    mkdirSync(real, { mode: 0o755 });
    put(join(real, "repos.json"), TS_WRITTEN);
    put(join(real, "repo-paths.json"), ALIASES);
    symlinkSync(real, join(dir, ".pacer", "state"));
    const { out, markers } = await stdio(dir, forward, [{ seed: {}, params: key("github.com/acme/app"), native: !forward }]);
    return { out, markers, mode: (lstatSync(real).mode & 0o777).toString(8), link: describe(join(dir, ".pacer", "state"), dir), files: FILES.map(name => describe(join(real, name), dir)) };
  };
  const [native, forwarded] = await Promise.all([run(false), run(true)]);
  expect(native.markers).toEqual(["native repo.remove 2"]);
  expect({ ...native, markers: [] }).toEqual({ ...forwarded, markers: [] });
  expect(native.mode).toBe("700");
  expect(native.link).toBe("symlink <home>/real-state");
}, 60000);

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
function checkout(dir: string, name: string) {
  const repo = join(dir, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  return execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"]).toString().trim();
}
const repoEvents = (dir: string) => {
  const path = join(dir, ".pacer", "link", "outbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map(text => JSON.parse(text).envelope)
    .filter(envelope => envelope.type === "entity" && envelope.data.kind === "repo").map(envelope => clean(JSON.stringify(envelope), dir));
};
async function until(check: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (check()) return true;
  return check();
}

test.skipIf(!front)("the pump publishes the same repo removal event after native and forwarded removal", async () => {
  const run = async (forward: boolean) => {
    const dir = home();
    const app = checkout(dir, "app"), tool = checkout(dir, "tool");
    put(join(dir, ".pacer", "state", "repos.json"), reg({
      [app]: { key: "github.com/acme/app", path: app, lastUsed: 1_731_380_000.25 },
      [tool]: { key: "github.com/acme/tool", path: tool, lastUsed: 1_731_390_000.75 },
    }));
    const server = await serve(dir, forward ? "repo.remove" : null);
    try {
      expect(await until(() => repoEvents(dir).length === 2, 30000)).toBe(true);
      const reply = await server.post("repo.remove", key("github.com/acme/app"));
      expect(await until(() => repoEvents(dir).length === 3, 30000)).toBe(true);
      return { reply, events: repoEvents(dir), files: snapshot(dir), markers: await server.stop() };
    } catch (error) { await server.stop(); throw error; }
  };
  const [native, forwarded] = await Promise.all([run(false), run(true)]);
  expect(native.markers).toEqual(["native repo.remove"]);
  expect(forwarded.markers).toEqual([]);
  expect({ ...native, markers: [] }).toEqual({ ...forwarded, markers: [] });
  expect(JSON.parse(native.events[2]!)).toEqual({ type: "entity", data: { kind: "repo", id: "github.com/acme/app", removed: true } });
}, 120000);

test.skipIf(!front)("native repo.remove and forwarded repo.add serialize on the shared repos lock", async () => {
  for (let round = 0; round < 6; round++) {
    const dir = home();
    const app = checkout(dir, "app"), tool = checkout(dir, "tool"), added = checkout(dir, "added");
    const state = join(dir, ".pacer", "state");
    const initial = reg({
      [app]: { key: "github.com/acme/app", path: app, lastUsed: 1_731_380_000.25 },
      [tool]: { key: "github.com/acme/tool", path: tool, lastUsed: 1_731_390_000.75 },
    });
    put(join(state, "repos.json"), initial);
    put(join(state, "repo-paths.json"), reg({ [`${app}-wt`]: app }));
    const server = await serve(dir, "repo.add");
    // Even rounds remove an existing entry; odd rounds race the removal of the entry being added.
    const target = round % 2 === 0 ? "github.com/acme/app" : `local:${createHash("sha256").update(added).digest("hex").slice(0, 12)}`;
    const [removedReply, addedReply] = await Promise.all([server.post("repo.remove", key(target)), server.post("repo.add", { path: added })]);
    const markers = await server.stop();
    expect(removedReply).toBe('200 {"result":{"removed":true}}');
    expect(addedReply.startsWith("200 ")).toBe(true);
    expect(markers.filter(text => text.startsWith("native repo.remove"))).toHaveLength(1);
    expect(markers.filter(text => text.startsWith("native repo.add"))).toEqual([]);
    const final = JSON.parse(readFileSync(join(state, "repos.json"), "utf8"));
    const addedEntry = final[added];
    const base = JSON.parse(initial);
    const serial = round % 2 === 0
      ? [{ [tool]: base[tool], [added]: addedEntry }]
      : [{ [app]: base[app], [tool]: base[tool], [added]: addedEntry }, { [app]: base[app], [tool]: base[tool] }];
    expect(serial.map(order => JSON.stringify(order))).toContain(JSON.stringify(final));
    if (addedEntry) expect(typeof addedEntry.lastUsed).toBe("number");
    expect(readFileSync(join(state, "repo-paths.json"), "utf8")).toBe(round % 2 === 0 ? "{}" : reg({ [`${app}-wt`]: app }));
  }
}, 180000);

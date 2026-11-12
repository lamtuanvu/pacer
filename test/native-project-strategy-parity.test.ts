import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Native project.strategy.* and strategy.preview against the same requests forced through
// PACER_FORWARD_OPS to the TypeScript core, over stdio and HTTP, on twin homes.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = ["project.strategy.list", "project.strategy.get", "project.strategy.set", "project.strategy.remove", "strategy.preview"];
const APP = "github.com/acme/app", OTHER = "github.com/acme/other";
const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  cursor: {kind: cursor}
runners:
  claude-code: {}
  codex: {}
  cursor: {}
`;
/** A schema-invalid strategy outside every test home, for absolute active names. */
const OUTSIDE = realpathSync(mkdtempSync("/tmp/nps-abs-"));
writeFileSync(join(OUTSIDE, "work.yaml"), "planner: nobody\n");
afterAll(() => rmSync(OUTSIDE, { recursive: true, force: true }));
const POLICY = JSON.stringify({ version: 1, projects: { [APP]: { rev: 2, executors: ["codex#codex@local"] }, [OTHER]: { rev: 1, executors: null } } });

type Content = string | Uint8Array | { dir: true } | { mode: number; text: string } | null;
type Step = [op: string, params: unknown];
interface Case { name: string; strategy?: Content; active?: string; policy?: Content; steps: Step[]; native: boolean }

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

function makeHome(): string {
  const home = realpathSync(mkdtempSync("/tmp/nps-"));
  mkdirSync(join(home, ".pacer"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".pacer", "strategy.yaml"), STRATEGY);
  const checkout = join(home, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "remote", "add", "origin", "https://github.com/acme/tool.git");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "x");
  return home;
}

/** A fresh inode for every write, so stamp-based caches never serve a stale read. */
function put(path: string, content: Content) {
  if (existsSync(path)) chmodSync(path, 0o700);
  rmSync(path, { recursive: true, force: true });
  if (content === null) return;
  if (typeof content === "object" && "dir" in content) { mkdirSync(path); return; }
  const text = typeof content === "object" && "mode" in content ? content.text : content;
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
  if (typeof content === "object" && "mode" in content) chmodSync(path, content.mode);
}

function reset(home: string, c: Case) {
  const pacer = join(home, ".pacer");
  put(join(pacer, "strategy.yaml"), c.strategy === undefined ? STRATEGY : c.strategy);
  put(join(pacer, "active"), c.active ?? null);
  put(join(pacer, "project-strategies.json"), c.policy === undefined ? POLICY : c.policy);
}

const fileBytes = (home: string, ...path: string[]) => {
  try { return readFileSync(join(home, ".pacer", ...path), "utf8").replaceAll(home, "$HOME"); } catch (error) { return `<${(error as NodeJS.ErrnoException).code}>`; }
};
const policyBytes = (home: string) => fileBytes(home, "project-strategies.json");
/** An absolute checkout registers before the strategy loads, in both runtimes. */
const registryBytes = (home: string) => ["repos.json", "repo-paths.json"].map(file => normalize(home, fileBytes(home, "state", file)));
const outbox = (home: string) => {
  const path = join(home, ".pacer", "link", "outbox.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
};
/** Each run's clock and home path differ; everything else must match. */
const normalize = (home: string, text: string) => text.replaceAll(home, "$HOME")
  .replace(/"(at|ts|lastUsed|createdAt|updatedAt)":\d+(\.\d+)?/g, '"$1":"<time>"')
  .replace(/"id":"\d+(\.\d+)?-[0-9a-f]{4}"/g, '"id":"<activity>"')
  .replace(/"machineId":"[a-z0-9]+"/g, '"machineId":"<machine>"');
/** What the operations publish; serve also publishes plugin, budget and mode updates on its own clock. */
const envelopes = (home: string, lines: string[]) => lines.map(line => JSON.parse(line).envelope)
  .filter(envelope => envelope.type === "config" || (envelope.type === "entity" && envelope.data?.kind === "activity"))
  .map(envelope => normalize(home, JSON.stringify(envelope)));
const withCheckout = (home: string, params: unknown) => JSON.parse(JSON.stringify(params ?? null).replaceAll("$CHECKOUT", join(home, "checkout")));

function env(home: string, forward: boolean) {
  return { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
    ...(forward ? { PACER_FORWARD_OPS: OPS.join(",") } : {}) };
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
const markerOf = (line: string) => /^native (project\.strategy\.\S+|strategy\.preview)( \d+)?$/.test(line) ? line : null;

interface Door { call(op: string, params: unknown): Promise<string>; markers: string[]; stop(): Promise<void> }

async function stdio(home: string, forward: boolean): Promise<Door> {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: env(home, forward), cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, (line: string) => void>(), markers: string[] = [];
  const out = lines(child.stdout, line => { const id = JSON.parse(line).id; pending.get(id)?.(line); pending.delete(id); });
  const err = lines(child.stderr, line => { const marker = markerOf(line); if (marker) markers.push(marker); });
  let next = 1;
  const call = (method: string, params: unknown) => new Promise<string>(resolve => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    child.stdin.flush();
  });
  expect(JSON.parse(await call("hello", { protocol: 3 })).result.protocol).toBe("3.0.0");
  return {
    call: async (op, params) => { const line = await call(op, params); const { id: _, ...reply } = JSON.parse(line); return JSON.stringify(reply); },
    markers,
    stop: async () => { child.stdin.end(); await child.exited; await Promise.all([out, err]); },
  };
}

async function http(home: string, forward: boolean): Promise<Door & { events: string[] }> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: env(home, forward), cwd: home, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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
  // SSE: keep the project-strategies config events only; other publications depend on timing.
  const events: string[] = [], abort = new AbortController();
  const stream = await fetch(base + "/v3/events", { headers: auth, signal: abort.signal });
  expect(stream.ok).toBe(true);
  const sse = (async () => {
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1], data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event === "config" && data?.includes("project-strategies")) events.push(normalize(home, data));
        }
      }
    } catch {}
  })();
  return {
    call: async (op, params) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(params), signal: AbortSignal.timeout(20000) });
      return `${response.status} ${await response.text()}`;
    },
    markers, events,
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
    // Activity entries carry machineId once the home has an identity; create it first so the stamp doesn't depend on timing.
    for (const door of doors) expect(await door.call("machine.get", {})).toContain('"id":');
    for (const c of cases) {
      homes.forEach(home => reset(home, c));
      for (const [op, params] of c.steps) {
        const label = `${transport} ${c.name}: ${op} ${JSON.stringify(params)}`;
        const before = homes.map(home => outbox(home).length);
        const replies = await Promise.all([0, 1].map(async i => normalize(homes[i]!, await doors[i]!.call(op, withCheckout(homes[i]!, params)))));
        expect(replies[0], label).toBe(replies[1]!);
        expect(policyBytes(homes[0]), `${label}: bytes`).toBe(policyBytes(homes[1]));
        expect(registryBytes(homes[0]), `${label}: registry`).toEqual(registryBytes(homes[1]));
        expect(envelopes(homes[0], outbox(homes[0]).slice(before[0])), `${label}: events`).toEqual(envelopes(homes[1], outbox(homes[1]).slice(before[1])));
        if (c.native) expectedMarkers.push(`native ${op}`);
      }
      await settle(doors[0].markers, expectedMarkers.length);
      expect(doors[0].markers.map(marker => marker.replace(/ \d+$/, "")), `${transport} ${c.name}: trace`).toEqual(expectedMarkers);
    }
    expect(doors[1].markers).toEqual([]);
    if (transport === "http") {
      const [native, forwarded] = doors as unknown as [{ events: string[] }, { events: string[] }];
      await Bun.sleep(200);
      expect(native.events).toEqual(forwarded.events);
      expect(native.events.length).toBeGreaterThan(0);
    }
  } finally {
    await Promise.all(doors.map(door => door.stop()));
    for (const home of homes) { put(join(home, ".pacer", "project-strategies.json"), null); put(join(home, ".pacer", "strategy.yaml"), null); rmSync(home, { recursive: true, force: true }); }
  }
}

const preview: Step = ["strategy.preview", { draft: { from: "default", set: { "pacing.order": ["codex"] } } }];
const writes: Step[] = [
  ["project.strategy.list", {}],
  ["project.strategy.get", { repo: APP }],
  ["project.strategy.get", { repo: "github.com/acme/unknown" }],
  ["project.strategy.set", { repo: APP, executors: ["cursor", "codex#codex@local"], expect_rev: 2 }],
  ["project.strategy.remove", { repo: OTHER, expect_rev: 1 }],
  ["project.strategy.set", { repo: APP, executors: ["cursor"], expect_rev: 0 }],
  ["project.strategy.set", { repo: "$CHECKOUT", executors: ["codex"], expect_rev: 0 }],
  ["project.strategy.list", {}],
];

/** Strategy states: missing and schema-invalid strategies are native; Bun and Node texts forward. */
const strategyCases: Case[] = [
  { name: "valid strategy", steps: writes, native: true },
  { name: "missing strategy", strategy: null, steps: [...writes, preview], native: true },
  { name: "schema-invalid planner", strategy: "planner: nobody\n", steps: [...writes, preview], native: true },
  { name: "top level not a mapping", strategy: "- a\n- b\n", steps: [...writes, preview], native: true },
  // The Rust YAML reader reports an empty document as a syntax error, so it keeps Bun's reading.
  { name: "empty strategy", strategy: "", steps: [...writes, preview], native: false },
  { name: "invalid terminal template", strategy: `${STRATEGY}terminal: {open: "x {cmd} '"}\n`, steps: [...writes, preview], native: true },
  { name: "active strategy missing", active: "work\n", steps: [...writes, preview], native: true },
  { name: "active name path.join normalizes", active: "x/../work", steps: [...writes, preview], native: false },
  // Rust's Path::join would replace the home with an absolute name; path.join keeps it inside.
  { name: "absolute active name, no file", active: "/nonexistent-pacer-test/work", steps: [...writes, preview], native: false },
  { name: "absolute active name, file outside home", active: join(OUTSIDE, "work"), steps: [...writes, preview], native: false },
  { name: "YAML syntax error", strategy: "planner: [\n", steps: [...writes, preview], native: false },
  { name: "strategy is a directory", strategy: { dir: true }, steps: [...writes, preview], native: false },
  { name: "unreadable strategy", strategy: { mode: 0o000, text: STRATEGY }, steps: [...writes, preview], native: false },
  { name: "strategy is not UTF-8", strategy: new Uint8Array([...Buffer.from("planner: claude-code\n# "), 0xff, 0x0a]), steps: [...writes, preview], native: false },
];

/** Strategy YAML shapes: the Rust reader and Bun.YAML agree on the native ones; Bun reads the forwarded ones differently, or may. */
const yamlCorpus: [string, string, boolean][] = [
  ["tab indentation", "\tplanner: nobody\n", false],
  ["tab inside a quoted scalar", "planner: \"no\tbody\"\n", false],
  ["tab-indented valid strategy", STRATEGY.replace("  claude:", "\tclaude:"), false],
  ["two documents", "a: 1\n---\nb: 2\n", false],
  ["valid first document", `${STRATEGY}---\nb: 2\n`, false],
  ["document end then content", "planner: nobody\n...\nb: 2\n", false],
  ["document end", "planner: nobody\n...\n", false],
  ["empty documents first", "---\n---\nplanner: nobody\n", false],
  ["CR line breaks, two documents", "a: 1\r---\rb: 2\r", false],
  ["CRLF two documents", "a: 1\r\n---\r\nb: 2\r\n", false],
  ["%YAML directive", "%YAML 1.2\n---\nplanner: nobody\n", false],
  ["merge key", "base: &b {planner: nobody}\n<<: *b\n", false],
  ["quoted merge key", "\"<<\": {planner: nobody}\n", false],
  ["__proto__ account", STRATEGY.replace("accounts:\n", "accounts:\n  __proto__: {kind: claude}\n"), false],
  ["block indicator in a flow mapping", "{a: |}\n", false],
  ["folded indicator in a flow sequence", "planner: [>]\n", false],
  ["bare tag in a flow mapping", "{a: !}\n", false],
  ["aliased mapping in a valid strategy", `${STRATEGY.replace("codex: {kind: codex}", "codex: &k {kind: codex}")}x: *k\n`, false],
  ["comment only", "# nothing\n", false],
  ["leading document start", "---\nplanner: nobody\n", true],
  ["document start with a comment", "--- # c\nplanner: nobody\n", true],
  ["BOM", "\ufeffplanner: nobody\n", true],
  ["BOM valid strategy", `\ufeff${STRATEGY}`, true],
  ["CRLF", "planner: nobody\r\naccounts: {}\r\n", true],
  ["CR line breaks", "planner: nobody\raccounts: 1\r", true],
  ["CRLF valid strategy", STRATEGY.replaceAll("\n", "\r\n"), true],
  ["flow top level", "{planner: nobody, accounts: {}}", true],
  ["flow trailing comma", "{planner: nobody,}\n", true],
  ["literal block scalar", "planner: |\n  nobody\n", true],
  ["folded block scalar", "planner: >-\n  no\n  body\n", true],
  ["!!str tag", "planner: !!str 1\n", true],
  ["YAML 1.1 scalars", "planner: yes\naccounts: 0o17\nrunners: .inf\nhosts: ~\n", true],
  ["top-level scalar", "nobody\n", true],
  ["duplicate keys", "planner: a\nplanner: nobody\n", true],
  ["non-string keys", "1: a\ntrue: b\naccounts: {0x10: {kind: claude}}\n", true],
  ["NEL inside a scalar", "planner: no\u0085body\n", true],
  ["nesting 200 deep", `planner: ${"[".repeat(200)}${"]".repeat(200)}\n`, true],
];
const yamlCases: Case[] = yamlCorpus.map(([name, text, native]) => ({ name: `YAML ${name}`, strategy: text, steps: [["project.strategy.list", {}], preview], native }));

const policy = (value: unknown) => JSON.stringify(value);
const entry = (executors: unknown, rev: unknown = 1) => ({ rev, executors });
const reads: Step[] = [
  ["project.strategy.list", {}],
  ["project.strategy.get", { repo: APP }],
  ["project.strategy.set", { repo: APP, executors: ["cursor"], expect_rev: 1 }],
  ["project.strategy.remove", { repo: APP, expect_rev: 2 }],
];
/** project-strategies.json inputs: Zod schema, parseRunnerId references and projectKey keys. */
const policyCorpus: [string, Content][] = [
  ["version 1.0", "{\"version\":1.0,\"projects\":{\"github.com/acme/app\":{\"rev\":1.0,\"executors\":[\"codex#codex@local\"]}}}"],
  ["version string", policy({ version: "1", projects: {} })],
  ["version 2", policy({ version: 2, projects: {} })],
  ["rev 0", policy({ version: 1, projects: { [APP]: entry(null, 0) } })],
  ["rev 1.5", policy({ version: 1, projects: { [APP]: entry(null, 1.5) } })],
  ["rev 2^53", "{\"version\":1,\"projects\":{\"github.com/acme/app\":{\"rev\":9007199254740992,\"executors\":null}}}"],
  ["rev max safe", "{\"version\":1,\"projects\":{\"github.com/acme/app\":{\"rev\":9007199254740991,\"executors\":null}}}"],
  ["rev -1", policy({ version: 1, projects: { [APP]: entry(null, -1) } })],
  ["rev 1e400", "{\"version\":1,\"projects\":{\"github.com/acme/app\":{\"rev\":1e400,\"executors\":null}}}"],
  ["rev string", policy({ version: 1, projects: { [APP]: entry(null, "1") } })],
  ["duplicate executors", policy({ version: 1, projects: { [APP]: entry(["codex#codex@local", "codex#codex@local"]) } })],
  ["empty executors", policy({ version: 1, projects: { [APP]: entry([]) } })],
  ["remote host reference", policy({ version: 1, projects: { [APP]: entry(["codex#codex@box-1", "cursor#cursor@local"]) } })],
  ...["codex", "codex#codex", "codex@local", "nope#a@local", "codex#A@local", "codex#a@local@x", "codex#a#b@local", "codex#-a@local", "codex#a@", "", "claude#claude@local"]
    .map((reference): [string, Content] => [`reference ${JSON.stringify(reference)}`, policy({ version: 1, projects: { [APP]: entry([reference]) } })]),
  ["reference not a string", policy({ version: 1, projects: { [APP]: entry([1]) } })],
  ["local key", policy({ version: 1, projects: { "local:0123456789ab": entry(null) } })],
  ...["local:0123456789AB", "local:0123456789a", "GitHub.com/a/b", "github.com/a/b.git", "a_b.com/x/y", "github.com/a/b/c", "github.com//b", "-x.com/a/b", "__proto__", "constructor"]
    .map((key): [string, Content] => [`key ${JSON.stringify(key)}`, policy({ version: 1, projects: { [key]: entry(null) } })]),
  ["key with underscores", policy({ version: 1, projects: { "github.com/a_b/c_d": entry(null) } })],
  ["__proto__ project key", "{\"version\":1,\"projects\":{\"__proto__\":{\"rev\":1,\"executors\":null}}}"],
  ["__proto__ entry field", "{\"version\":1,\"projects\":{\"github.com/acme/app\":{\"rev\":1,\"executors\":null,\"__proto__\":{}}}}"],
  ["__proto__ top-level field", "{\"version\":1,\"projects\":{},\"__proto__\":{}}"],
  ["__proto__ instead of projects", "{\"version\":1,\"__proto__\":{}}"],
  ["duplicate keys", "{\"version\":2,\"projects\":{\"github.com/acme/app\":{\"rev\":5,\"executors\":null}},\"version\":1,\"projects\":{\"github.com/acme/app\":{\"executors\":null,\"rev\":1}}}"],
  ["extra top-level field", policy({ version: 1, projects: {}, x: 1 })],
  ["missing projects", policy({ version: 1 })],
  ["projects array", policy({ version: 1, projects: [] })],
  ["entry missing executors", policy({ version: 1, projects: { [APP]: { rev: 1 } } })],
  ["entry extra field", policy({ version: 1, projects: { [APP]: { rev: 1, executors: null, note: "x" } } })],
  ["entry null", policy({ version: 1, projects: { [APP]: null } })],
  ["lone surrogate key", "{\"version\":1,\"projects\":{\"github.com/acme/\\ud800\":{\"rev\":1,\"executors\":null}}}"],
  ["deep nesting", `{"version":1,"projects":{},"x":${"[".repeat(300)}${"]".repeat(300)}}`],
  ["BOM", "\ufeff" + POLICY],
  ["invalid UTF-8 in a string", new Uint8Array([...Buffer.from("{\"version\":1,\"projects\":{\"github.com/acme/"), 0xff, ...Buffer.from("\":{\"rev\":1,\"executors\":null}}}")])],
  ["invalid UTF-8 outside strings", new Uint8Array([...Buffer.from(POLICY), 0xff])],
  // JSON.parse accepts these where Zod never looks: an own __proto__ project and an overwritten duplicate.
  ...[["lone surrogate", "\"\\ud800\""], ["nesting 300 deep", `${"[".repeat(300)}${"]".repeat(300)}`], ["1e400", "1e400"]]
    .flatMap(([what, value]): [string, Content][] => [
      [`__proto__ project ${what}`, `{"version":1,"projects":{"__proto__":${value},"${APP}":{"rev":1,"executors":null}}}`],
      [`overwritten version ${what}`, `{"version":${value},"version":1,"projects":{"${APP}":{"rev":1,"executors":null}}}`],
    ]),
  ["__proto__ project invalid UTF-8", new Uint8Array([...Buffer.from("{\"version\":1,\"projects\":{\"__proto__\":\"x"), 0xff, 0xe2, 0x82, ...Buffer.from(`","${APP}":{"rev":1,"executors":null}}}`)])],
  ["overwritten entry invalid UTF-8", new Uint8Array([...Buffer.from(`{"version":1,"projects":{"${APP}":"`), 0xff, ...Buffer.from(`","${APP}":{"rev":1,"executors":null}}}`)])],
  ["executors 1e400", `{"version":1,"projects":{"${APP}":{"rev":1,"executors":1e400}}}`],
  ["lone surrogate top-level key", `{"version":1,"projects":{},"\\udc00":1}`],
  ["lone surrogate entry field", `{"version":1,"projects":{"${APP}":{"rev":1,"executors":null,"\\ud800":1}}}`],
  ["deep entry field", `{"version":1,"projects":{"${APP}":{"rev":1,"executors":${"[".repeat(300)}${"]".repeat(300)}}}}`],
  ["trailing comma", "{\"version\":1,\"projects\":{},}"],
  ["empty file", ""],
  ["null", "null"],
  ["array", "[]"],
  ["unreadable file", { mode: 0o000, text: POLICY }],
  ["directory", { dir: true }],
];
const policyCases: Case[] = policyCorpus.map(([name, content]) => ({ name: `policy ${name}`, policy: content, steps: reads, native: true }));

test.skipIf(!front)("stdio project.strategy.* and strategy.preview with broken strategies match forced forwarding", async () => {
  await compare("stdio", [...strategyCases, ...yamlCases]);
}, 300000);

test.skipIf(!front)("HTTP project.strategy.* and strategy.preview with broken strategies match forced forwarding", async () => {
  await compare("http", [...strategyCases, ...yamlCases]);
}, 300000);

test.skipIf(!front)("stdio project-strategies.json validation corpus matches forced forwarding", async () => {
  await compare("stdio", policyCases);
}, 300000);

test.skipIf(!front)("HTTP project-strategies.json validation corpus matches forced forwarding", async () => {
  await compare("http", policyCases);
}, 300000);

test.skipIf(!front)("concurrent native and forwarded project.strategy.set on one key conflict with the same text", async () => {
  const home = makeHome();
  const doors = [await stdio(home, false), await stdio(home, true)] as const;
  try {
    put(join(home, ".pacer", "project-strategies.json"), POLICY);
    const set = (i: number, rev: number) => doors[i]!.call("project.strategy.set", { repo: APP, executors: ["cursor"], expect_rev: rev });
    // Each side loses once against a committed write from the other.
    expect(JSON.parse(await set(0, 2)).result.rev).toBe(3);
    const forwardedLoss = await set(1, 2);
    expect(JSON.parse(await set(1, 3)).result.rev).toBe(4);
    const nativeLoss = await set(0, 3);
    expect(nativeLoss).toBe(forwardedLoss);
    expect(JSON.parse(nativeLoss).error).toEqual({ code: -32000, message: "Project strategy changed in another client",
      data: { code: "conflict", hint: "Reload the project strategy and review your changes." } });
    // Simultaneous writers: exactly one wins under the shared lock; the other reports the same conflict.
    for (let rev = 4; rev < 14; rev++) {
      const replies = await Promise.all([set(0, rev), set(1, rev)]);
      const wins = replies.filter(reply => JSON.parse(reply).result?.rev === rev + 1);
      expect(wins.length, replies.join("\n")).toBe(1);
      expect(replies.find(reply => !wins.includes(reply))).toBe(forwardedLoss);
    }
    expect(JSON.parse(readFileSync(join(home, ".pacer", "project-strategies.json"), "utf8")).projects[APP].rev).toBe(14);
    await settle(doors[0].markers, 12);
    expect(doors[0].markers.length).toBe(12);
    expect(doors[1].markers).toEqual([]);
  } finally {
    await Promise.all(doors.map(door => door.stop()));
    rmSync(home, { recursive: true, force: true });
  }
}, 120000);

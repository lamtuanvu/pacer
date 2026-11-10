import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import { createSession } from "../src/serve/app-auth";
import { fakeCtx, tmpDir, withLoginIndicators } from "./helpers";
import { closedPort, pinnedEnv, spawnPinned } from "./pinned-port";

// Native setup.init, strategy.build and executor.setup.candidates against the
// same requests forced through PACER_FORWARD_OPS to the TypeScript core.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "setup.init,strategy.build,executor.setup.candidates";
const NOW = Math.floor(Date.now() / 1000);

const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  cursor: {kind: cursor}
  acme-work: {kind: endpoint, source: opencode, provider: acme, usage: metered}
runners:
  claude-code: {}
  codex: {}
  cursor: {}
routing:
  - default: [codex, cursor]
terminal: {open: "fake-term {cmd}"}
`;

// A local Ollama tags endpoint for setup.init detection.
const ollama = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => new URL(req.url).pathname === "/api/tags"
  ? Response.json({ models: [{ name: "" }, { name: "qwen3:8b" }] }) : new Response("no", { status: 404 }) });
afterAll(() => ollama.stop(true));

// The same endpoint answering with chunked transfer coding (split chunks, an extension and a trailer).
const chunkedOllama = Bun.listen<{ request: string }>({ hostname: "127.0.0.1", port: 0, socket: {
  open(socket) { socket.data = { request: "" }; },
  data(socket, data) {
    socket.data.request += data.toString();
    if (!socket.data.request.includes("\r\n\r\n")) return;
    const json = JSON.stringify({ models: [{ name: "" }, { name: "chunked:7b" }] });
    const chunks = [json.slice(0, 5), json.slice(5, 21), json.slice(21)]
      .map((part, i) => `${Buffer.byteLength(part).toString(16)}${i === 1 ? ";ext=1" : ""}\r\n${part}\r\n`).join("");
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunks}0\r\nX-Trailer: t\r\n\r\n`);
  },
} });
afterAll(() => chunkedOllama.stop(true));

// An OpenAI-compatible model server for the local candidates probe.
let modelRequests = 0;
const models = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => {
  modelRequests++;
  return new URL(req.url).pathname === "/v1/models" ? Response.json({ data: [{ id: "fixture-a" }, { id: "fixture-b" }] }) : new Response("no", { status: 404 });
} });
afterAll(() => models.stop(true));

const DEAD = [closedPort(), closedPort()] as const;
// Keeps every run off the machine's pacer service, Ollama and LM Studio (the front door is built with test-ops).
const isolated = { OLLAMA_HOST: `127.0.0.1:${DEAD[0]}`, PACER_TEST_LOCAL_SERVER_PORTS: `${DEAD[0]},${DEAD[1]}` };

function bin(dir: string, name: string, script: string) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
}

async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, expectNative = !forward) {
  const child = spawnPinned([front!, "api", "--stdio"], {
    cwd: home,
    env: pinnedEnv({ HOME: home, PACER_HOME: join(home, ".pacer"), PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...isolated, ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) }, closedPort()),
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
    return lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id).map(line => JSON.parse(line));
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
// The plugin host can miss its local probe deadline under heavy load; that note reflects timing, not parity.
const probeDeadline = (replies: unknown) => /Could not check local model servers: (plugin call passed its absolute deadline|owning plugin call ended)/.test(JSON.stringify(replies));
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const requests = (cases: [string, unknown][]) => cases.map(([op, params], i) => request(i + 2, op, params));

const events = (dir: string) => {
  const path = join(dir, ".pacer", "link", "outbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.stringify(JSON.parse(line).envelope)
    .replace(/"at":\d+(\.\d+)?/g, '"at":"<now>"').replace(/"\d+(\.\d+)?-[0-9a-f]{4}"/g, '"<id>"'));
};
const files = (dir: string, sub: string) => {
  const path = join(dir, ".pacer", sub);
  return existsSync(path) ? Object.fromEntries(readdirSync(path, { withFileTypes: true }).filter(e => e.isFile() && !e.name.endsWith(".lock"))
    .map(e => e.name).sort().map(name => [name, readFileSync(join(path, name), "utf8")])) : {};
};

function home(strategy = true): string {
  const dir = tmpDir();
  mkdirSync(join(dir, ".pacer"), { recursive: true });
  if (strategy) writeFileSync(join(dir, ".pacer", "strategy.yaml"), STRATEGY);
  for (const name of ["claude", "codex", "cursor-agent"]) bin(dir, name, "exit 1");
  bin(dir, "fake-term", `printf '%s\\n' "$@" >> "${join(dir, "terminal.log")}"`);
  withLoginIndicators({ home: dir } as Ctx);
  return dir;
}

test.skipIf(!front)("setup.init creates or edits the strategy like forced forwarding", async () => {
  const fresh = (extra = "") => {
    const dir = home(false);
    for (const name of ["opencode", "ollama", "arkcli"]) bin(dir, name, "exit 1");
    bin(dir, "lms", `echo '[{"type":"embedding","modelKey":"e"},{"type":"llm","modelKey":"plain"},{"type":"llm","modelKey":"tools","trainedForToolUse":true}]'`);
    if (extra) writeFileSync(join(dir, ".pacer", "strategy.yaml"), extra);
    return dir;
  };
  const env = { OLLAMA_HOST: `127.0.0.1:${ollama.port}` };
  const cases: [string, unknown][] = [
    ["setup.init", { planner: "agy" }], ["setup.init", { planner: "codex@devbox" }], ["setup.init", { planner: "" }],
    ["setup.init", { planner: 5 }], ["setup.init", {}], ["setup.init", null], ["setup.init", { planner: "x".repeat(129) }], ["setup.init", { planner: "😀".repeat(128) }],
  ];
  // The TypeScript core rejects overlapping edits of one setting, so each write gets its own exchange.
  const writes: [string, unknown][] = [["setup.init", { planner: "codex#work" }], ["setup.init", { planner: "cursor@local" }], ["setup.init", { planner: "codex" }]];
  for (const [label, prepare] of [["new", () => fresh()], ["existing", () => fresh(STRATEGY)]] as const) {
    const homes = [prepare(), prepare()];
    const native = [await exchange(homes[0]!, requests(cases), false, env)];
    const forwarded = [await exchange(homes[1]!, requests(cases), true, env)];
    for (const write of writes) {
      native.push(await exchange(homes[0]!, requests([write]), false, env));
      forwarded.push(await exchange(homes[1]!, requests([write]), true, env));
    }
    const local = (value: unknown, dir: string) => JSON.parse(JSON.stringify(value).replaceAll(dir, "$HOME"));
    expect(local(native, homes[0]!), label).toEqual(local(forwarded, homes[1]!));
    const strategies = (dir: string) => Object.fromEntries(Object.entries(files(dir, "")).filter(([name]) => name.startsWith("strategy.yaml")));
    expect(strategies(homes[0]!), label).toEqual(strategies(homes[1]!));
    expect(Object.keys(strategies(homes[0]!)).length, label).toBeGreaterThan(0);
    expect(events(homes[0]!), label).toEqual(events(homes[1]!));
  }
}, 120000);

test.skipIf(!front)("setup.init reads a chunked Ollama /api/tags response like forced forwarding", async () => {
  const env = { OLLAMA_HOST: `127.0.0.1:${chunkedOllama.port}` };
  const homes = [home(false), home(false)];
  for (const dir of homes) for (const name of ["opencode", "ollama", "arkcli", "lms"]) bin(dir, name, "exit 1");
  const write = requests([["setup.init", { planner: "codex" }]]);
  const native = await exchange(homes[0]!, write, false, env);
  const forwarded = await exchange(homes[1]!, write, true, env);
  const local = (value: unknown, dir: string) => JSON.parse(JSON.stringify(value).replaceAll(dir, "$HOME"));
  expect(local(native, homes[0]!)).toEqual(local(forwarded, homes[1]!));
  const strategy = (dir: string) => readFileSync(join(dir, ".pacer", "strategy.yaml"), "utf8");
  expect(strategy(homes[0]!)).toEqual(strategy(homes[1]!));
  expect(strategy(homes[1]!)).toContain("chunked:7b");
  expect(events(homes[0]!)).toEqual(events(homes[1]!));
}, 120000);

// Answers only when the query OLLAMA_HOST carried reaches /api/tags.
const queried: string[] = [];
const tagsFor = (name: string) => (req: Request) => {
  const url = new URL(req.url);
  queried.push(`${name} ${url.pathname}${url.search}`);
  return url.pathname === "/api/tags" && url.search === "?token=abc" ? Response.json({ models: [{ name: `${name}:1` }] }) : new Response("no", { status: 401 });
};
const query = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: tagsFor("query") });
afterAll(() => query.stop(true));
let v6: ReturnType<typeof Bun.serve> | null = null;
try { v6 = Bun.serve({ port: 0, hostname: "::1", fetch: tagsFor("v6") }); } catch { /* no IPv6 loopback */ }
afterAll(() => v6?.stop(true));
// Sends a complete Content-Length response and leaves the connection open.
const keptOpen = Bun.listen<{ request: string }>({ hostname: "127.0.0.1", port: 0, socket: {
  open(socket) { socket.data = { request: "" }; },
  data(socket, data) {
    socket.data.request += data.toString();
    if (!socket.data.request.includes("\r\n\r\n")) return;
    const json = JSON.stringify({ models: [{ name: "kept:1" }] });
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: keep-alive\r\n\r\n${json}`);
  },
} });
afterAll(() => keptOpen.stop(true));
const large = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ models: [{ name: "large:1" }], padding: "x".repeat(5 << 20) }) });
afterAll(() => large.stop(true));

test.skipIf(!front)("setup.init resolves every OLLAMA_HOST form like forced forwarding", async () => {
  const forms: [string, string | null][] = [
    [`127.0.0.1:${query.port}?token=abc`, "query:1"],
    [`http://127.0.0.1:${query.port}/some/path?token=abc#frag`, "query:1"],
    [`  HTTP://127.0.0.1:${query.port}/?token=abc  `, "query:1"],
    [`http://127.0.0.1:${query.port}`, null],
    [`127.0.0.1:${query.port}#?token=abc`, null],
    [`http://user:pw@127.0.0.1:${query.port}?token=abc`, "query:1"],
    [`http://127.0.0.1:${keptOpen.port}`, "kept:1"],
    [`127.0.0.1:${large.port}`, "large:1"],
    ...(v6 ? [[`http://[::1]:${v6.port}?token=abc`, "v6:1"], [`[::1]:${v6.port}?token=abc`, "v6:1"]] as [string, string][] : []),
    [`https://127.0.0.1:${query.port}?token=abc`, null],
    [`ftp://127.0.0.1:${query.port}?token=abc`, null],
    ["http://127.0.0.1:notaport", null],
    ["http://[::1", null],
    [`127.0.0.1:${DEAD[0]}?token=abc`, null],
  ];
  const local = (value: unknown, dir: string) => JSON.parse(JSON.stringify(value).replaceAll(dir, "$HOME"));
  const strategy = (dir: string) => readFileSync(join(dir, ".pacer", "strategy.yaml"), "utf8");
  const write = requests([["setup.init", { planner: "codex" }]]);
  for (const [host, model] of forms) {
    const homes = [home(false), home(false)];
    for (const dir of homes) for (const name of ["opencode", "ollama", "arkcli", "lms"]) bin(dir, name, "exit 1");
    const env = { OLLAMA_HOST: host };
    const before = queried.length;
    const native = await exchange(homes[0]!, write, false, env);
    const forwarded = await exchange(homes[1]!, write, true, env);
    expect(local(native, homes[0]!), host).toEqual(local(forwarded, homes[1]!));
    expect(strategy(homes[0]!), host).toEqual(strategy(homes[1]!));
    expect(strategy(homes[0]!).match(/ollama\/[^\s",}]+/)?.[0] ?? null, host).toBe(model && `ollama/${model}`);
    expect(events(homes[0]!), host).toEqual(events(homes[1]!));
    if (host.includes(`:${query.port}`) && model) expect(queried.slice(before), host).toEqual(["query /api/tags?token=abc", "query /api/tags?token=abc"]);
  }
}, 300000);

test.skipIf(!front)("strategy.build writes the same intent files, prompt and terminal hand-off as forced forwarding", async () => {
  const request_id = "00000000-0000-4000-8000-000000000001";
  const cases: [string, unknown][] = [
    ["strategy.build", { agent: "cursor", from: "default", brief: "Help 😀", request_id }],
    ["strategy.build", { agent: "cursor", from: "default", brief: "Help 😀", request_id }],
    ["strategy.build", { agent: "cursor", brief: "changed", request_id }],
    ["strategy.build", { brief: "😀".repeat(1001) }],
    ["strategy.build", { brief: "😀".repeat(2001) }],
    ["strategy.build", { agent: "nope", from: "", worktree: "", request_id: "x" }],
    ["strategy.build", { from: "gone", request_id: "00000000-0000-4000-8000-000000000002" }],
    ["strategy.build", null],
  ];
  const homes = [home(), home()];
  const native = await exchange(homes[0]!, requests(cases), false);
  const forwarded = await exchange(homes[1]!, requests(cases), true);
  // The prompt embeds the live status clock; compare everything else exactly.
  const stable = (text: string) => text.replace(/Current status:\n[\s\S]*?\n\nUse the pacer MCP/g, "Current status:\n<status>\n\nUse the pacer MCP");
  const normalize = (value: unknown) => JSON.parse(stable(JSON.stringify(value)).replace(/Current status:\\n[\s\S]*?\\n\\nUse the pacer MCP/g, "Current status:\\n<status>\\n\\nUse the pacer MCP")
    .replace(/[0-9a-f-]{36}\.sh/g, "<script>.sh"));
  expect(normalize(native)).toEqual(normalize(forwarded));
  const sessions = homes.map(dir => Object.fromEntries(Object.entries(files(dir, "link/sessions")).map(([name, text]) => [name.replace(/^\d{13}-[0-9a-f]{4}/, "<generated>"), stable(text)])));
  expect(normalize(sessions[0])).toEqual(normalize(sessions[1]));
  expect(Object.keys(sessions[0]!)).toEqual([`${request_id}.json`, `${request_id}.md`, "<generated>.md"]);
  expect(events(homes[0]!)).toEqual(events(homes[1]!));
  expect(native[0].result).toMatchObject({ opened: true, target: "terminal" });
  expect(native[0].result.command).toStartWith("cursor-agent --force --trust --sandbox disabled -- ");
  expect(native[1]).toEqual({ ...native[0], id: 3 });
  const logs = homes.map(dir => readFileSync(join(dir, "terminal.log"), "utf8").trim().split("\n").length);
  expect(logs[0]).toBe(logs[1]!);
  const enforced = requests([["strategy.build", {}], ["executor.setup.candidates", {}], ["setup.init", { planner: "codex" }]]);
  const env = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  expect(await exchange(homes[0]!, enforced, false, env)).toEqual(await exchange(homes[0]!, enforced, true, env));
}, 120000);

test.skipIf(!front)("executor.setup.candidates from a fresh catalog matches forced forwarding", async () => {
  const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), toolCall: true, input: ["text"], output: ["text"], context: 200000, outputLimit: 32000, costIn: 1.25, costOut: 10, release: "2025-03-01", ...extra });
  const catalog = (dir: string, fetchedAt: number) => {
    mkdirSync(join(dir, ".pacer", "cache"), { recursive: true });
    writeFileSync(join(dir, ".pacer", "cache", "models.json"), JSON.stringify({ fetchedAt, providers: {
      acme: { id: "acme", name: "Acme", env: [], api: null, models: [model("a1")] },
      "volcengine-coding-plan": { id: "volcengine-coding-plan", name: "Volc", env: [], api: null, models: [model("v", { costIn: 0, costOut: 0 })] },
      free: { id: "free", name: "Free", env: [], api: null, models: [model("f", { costIn: 0, costOut: null })] },
      ollama: { id: "ollama", name: "Ollama", env: [], api: null, models: [model("o")] },
      empty: { id: "empty", name: "Empty", env: [], api: null, models: [] },
    } }));
  };
  const signed = (dir: string, script: string) => {
    bin(dir, "opencode", script);
    mkdirSync(join(dir, ".config", "opencode"), { recursive: true });
    writeFileSync(join(dir, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { custom: { name: "Custom", options: { apiKey: "secret" } }, acme: {} } }));
  };
  const cases = requests([["executor.setup.candidates", {}], ["executor.setup.candidates", { extra: 1 }], ["executor.setup.candidates", null], ["executor.setup.candidates", 5]]);
  const scenarios: [string, (dir: string) => void][] = [
    ["signed in", dir => signed(dir, `echo '[{"id":"acme","name":"Acme Co"},{"id":"free"},{"name":"x"},"bad",{"id":"custom"}]'`)],
    ["sign-in failure", dir => signed(dir, "exit 3")],
    ["no opencode", () => {}],
  ];
  const servers: [string, string][] = [["serving", `${models.port},${DEAD[1]}`], ["absent", `${DEAD[0]},${DEAD[1]}`]];
  for (const [variant, ports] of servers) for (const [label, setup] of scenarios) {
    const dir = home();
    catalog(dir, NOW);
    setup(dir);
    const before = modelRequests;
    const env = { PACER_TEST_LOCAL_SERVER_PORTS: ports };
    let native: any[] = [], forwarded: any[] = [];
    for (let attempt = 0; attempt < 3 && (attempt === 0 || probeDeadline([native, forwarded])); attempt++) {
      native = await exchange(dir, cases, false, env);
      forwarded = await exchange(dir, cases, true, env);
    }
    expect(native, `${variant} ${label}`).toEqual(forwarded);
    const local = native[0].result.candidates.filter((c: { group: string }) => c.group === "local");
    expect(local, `${variant} ${label}`).toEqual(variant === "serving"
      ? [{ group: "local", provider: "ollama", name: "Ollama", base_url: `http://127.0.0.1:${models.port}/v1`, models: 2, added: null, usage: { usage: "unmetered", known: true } }] : []);
    expect(modelRequests > before, `${variant} ${label}`).toBe(variant === "serving");
  }
  const stale = home();
  catalog(stale, NOW - 90000);
  const one = requests([["executor.setup.candidates", {}]]);
  expect(await exchange(stale, one, false, {}, false)).toEqual(await exchange(stale, one, true));
}, 120000);

async function serve(dir: string, forward: boolean) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", String(port)], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: pinnedEnv({ HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
      ...isolated, PACER_TEST_LOCAL_SERVER_PORTS: `${models.port},${DEAD[1]}`, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) }, port) });
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
    post: async (op: string, body: unknown, headers: Record<string, string>) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      return `${response.status} ${await response.text()}`;
    },
    bearer: { Authorization: `Bearer ${token}` },
    app: (cookie: string) => ({ Cookie: `pacer_session=${cookie}`, Origin: base, "X-Pacer-Client": "app" }),
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native (strategy|executor|setup)\./.test(line)); },
  };
}

test.skipIf(!front)("HTTP callers reach the setup effects bridge like the TypeScript core", async () => {
  const results: { bodies: string[]; markers: string[]; sessions: string[] }[] = [];
  for (const forward of [false, true]) {
    const dir = home();
    bin(dir, "opencode", `echo '[{"id":"acme"}]'`);
    mkdirSync(join(dir, ".pacer", "cache"), { recursive: true });
    writeFileSync(join(dir, ".pacer", "cache", "models.json"), JSON.stringify({ fetchedAt: NOW, providers: { acme: { id: "acme", name: "Acme", env: [], api: null, models: [{ id: "a1", name: "A1", toolCall: true, input: ["text"], output: ["text"], context: 200000, outputLimit: 32000, costIn: 1, costOut: 2, release: "2025-03-01" }] } } }));
    const cookie = createSession(fakeCtx({ home: dir, now: Date.now() / 1000 }));
    const server = await serve(dir, forward);
    const candidates = async () => {
      let body = "";
      for (let attempt = 0; attempt < 3 && (attempt === 0 || probeDeadline(body)); attempt++) body = await server.post("executor.setup.candidates", {}, server.bearer);
      return body;
    };
    const bodies = [
      await server.post("strategy.build", { agent: "codex", request_id: "00000000-0000-4000-8000-00000000000a" }, server.bearer),
      await server.post("strategy.build", { agent: "opencode", request_id: "00000000-0000-4000-8000-00000000000b" }, server.app(cookie)),
      await server.post("strategy.build", { brief: 5 }, server.app(cookie)),
      await candidates(),
      await server.post("setup.init", { planner: "codex" }, server.app(cookie)),
    ];
    const markers = (await server.stop()).filter((line, i, all) => line !== "native executor.setup.candidates" || all[i - 1] !== line);
    results.push({ bodies: bodies.map(body => body.replaceAll(dir, "$HOME")), markers, sessions: Object.keys(files(dir, "link/sessions")) });
  }
  const norm = (body: string) => body.replace(/Current status:\\n[\s\S]*?\\n\\nUse the pacer MCP/g, "<status>").replace(/[0-9a-f-]{36}\.sh/g, "<script>.sh")
    .replace(/"terminalId":"[^"]+"/g, '"terminalId":"<id>"');
  expect(results[0]!.bodies.map(norm)).toEqual(results[1]!.bodies.map(norm));
  expect(results[0]!.bodies[3]).toContain(`"base_url":"http://127.0.0.1:${models.port}/v1","models":2`);
  expect(results[0]!.sessions).toEqual(results[1]!.sessions);
  expect(results[1]!.markers).toEqual([]);
  expect(results[0]!.markers).toEqual(["strategy.build", "strategy.build", "strategy.build", "executor.setup.candidates", "setup.init"].map(op => `native ${op}`));
}, 120000);

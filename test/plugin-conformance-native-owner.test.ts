import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertPingReceipts, type CaseContext, type ConformanceCase } from "../conformance/cases";
import { HostError, type HostClient } from "../conformance/host";
import { CASES, type FrontDoor, runCase } from "../conformance/run";
import { front, freePort } from "./native-plugin-door";

// A representative conformance subset against the Rust front door with the native process owner,
// over a self-owned `api --stdio` connection and over a flag-on `serve`. The full CASES list stays
// on the TypeScript host (plugin-conformance.test.ts).

const tsHost = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")];
const ownerEnv = {
  PACER_CORE_ARGV: JSON.stringify(tsHost), PACER_NATIVE_PLUGIN_HOST: "1", PACER_FORWARD_OPS: "",
  PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
};

/** A conformance client over a flag-on `pacer serve`: ops are HTTP posts, errors keep their code. */
class ServeSession implements HostClient {
  readonly events: { type: string; data: unknown }[] = [];
  readonly stderr: string[] = [];
  private child?: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private base = "";
  private token = "";
  constructor(private readonly argv: string[], private readonly env: Record<string, string>) {}

  get pid() { return this.child?.pid; }

  /** Public event subscription is not part of this subset; `subscribe` is accepted and ignored. */
  async start(): Promise<this> {
    const port = freePort();
    const child = this.child = Bun.spawn([...this.argv, "serve", "--port", String(port)], { env: { ...this.env, PACER_PORT: String(port) }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stderr) this.stderr.push(decoder.decode(chunk, { stream: true })); })();
    this.base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        this.token = readFileSync(join(this.env.PACER_HOME!, "token"), "utf8").trim();
        if ((await fetch(`${this.base}/v3/hello`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(500) })).ok) break;
      } catch { /* Wait for this serve only. */ }
      if (child.exitCode !== null || i > 750) { child.kill("SIGKILL"); throw Error(`serve did not start:\n${this.stderr.join("")}`); }
      await Bun.sleep(20);
    }
    if (!existsSync(join(this.env.PACER_HOME!, "run", "host.sock"))) throw Error("flag-on serve did not bind run/host.sock");
    return this;
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    // Serve's handshake is `GET /v3/hello`, not an operation.
    if (method === "hello") {
      const response = await fetch(`${this.base}/v3/hello`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new HostError("internal", `hello answered ${response.status}`);
      return await response.json() as T;
    }
    const response = await fetch(`${this.base}/v3/ops/${method}`, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(30000) });
    const body = await response.json() as { result?: T; error?: { code?: string; message: string } };
    if (body.error) throw new HostError(body.error.code ?? "internal", body.error.message);
    return body.result as T;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    if (await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung")]) === "hung") child.kill("SIGKILL");
    await child.exited;
  }
}

type Door = { label: string; argv: string[]; door: FrontDoor };
const doors: Door[] = front ? [
  { label: "stdio owner", argv: [front], door: { env: ownerEnv, homePrefix: "s-" } },
  { label: "serve owner", argv: [front], door: { env: ownerEnv, homePrefix: "h-", session: (argv, env) => new ServeSession(argv, env) } },
] : [];
const tsDoor: Door = { label: "typescript", argv: tsHost, door: { homePrefix: "t-" } };

/** Owner sockets bind under the home, so every home sits directly in a short /tmp root of this run's own. */
const root = mkdtempSync("/tmp/pcn-");
// A flag-on serve's Core can still be writing its home for a moment after serve exits.
afterAll(async () => { await Bun.sleep(1000); rmSync(root, { recursive: true, force: true }); });

const PID_NULL = "known: flag-on plugin.doctor reports pid null for owner-supervised children (ADR 0027, ledger row 22)";
const ROUTED_HTTP = "routed: for any owner call without host resources, such as a diagnostic ping, Core auto-issues a granted manifest's exact net.http hosts and exact fs.read paths (autoIssueFromManifest), so the owner serves them; TypeScript refuses every scoped capability outside an owning call";
const ROUTED_OBSERVATIONS = "routed: the owner admits the observation bootstrap call, but no task or activity event reaches the plugin's callback until the owner runs observation generations";
const ROUTED_MESSAGE = "routed: the owner refuses with the Rust broker's message (`capability is not granted to the owning call: … was not issued`), TypeScript with `scoped capability requires an active owning call`";

/** Subset of CASES, by name, with the reason a case is expected to fail on the owner doors. */
const SUBSET: Record<string, string | null> = {
  "lazy start: list starts nothing, doctor starts the process": PID_NULL,
  "capability denial: undeclared calls are refused, declared ones answer": ROUTED_HTTP,
  "serialisation: one call at a time unless reentrant": PID_NULL,
  "logs: stderr lands in the plugin log file, never on stdout": null,
  "shutdown: closing the host terminates its plugins": null,
  "observations: task callback task reads work without public subscribe": ROUTED_OBSERVATIONS,
  "observations: activity callback task reads work without public subscribe": ROUTED_OBSERVATIONS,
};
const subset = CASES.filter(c => Object.hasOwn(SUBSET, c.name));
test("the native owner subset names existing conformance cases", () => expect(subset.map(c => c.name).sort()).toEqual(Object.keys(SUBSET).sort()));

const listed = async (h: HostClient) => (await h.call<{ plugins: { id: string; state: string; pid: number | null }[] }>("plugin.list")).plugins;
const doctor = async (h: HostClient, id: string) => (await h.call<{ reports: { ok: boolean; pid: number | null; error: string | null }[] }>("plugin.doctor", { id })).reports[0]!;

/**
 * The two PID_NULL cases with every pid check replaced by what the owner reports instead, and the
 * observations cases' bootstrap call without their event assertions (ROUTED_OBSERVATIONS).
 */
const OWNER_VARIANTS: (ConformanceCase & { reason?: string | null })[] = [
  { name: "lazy start without pids: list starts nothing, doctor makes the plugin ready", async run(t) {
    t.install("good");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    assert((await listed(h)).find(p => p.id === "fx-good")?.state === "idle", "the plugin is idle before the first call");
    const r = await doctor(h, "fx-good");
    assert(r.ok && r.pid === null, `doctor starts the plugin; the owner's pid is not reported (got ${JSON.stringify(r)})`);
    assert((await listed(h)).find(p => p.id === "fx-good")?.state === "ready", "the plugin is ready after the first call");
  } },
  ...([["fx-serial", "serial"], ["fx-reentrant", "barrier"]] as const).map(([id, probe]): ConformanceCase => ({
    name: `serialisation without pids: ${id} ${probe === "serial" ? "runs one call at a time" : "overlaps two calls"}`, async run(t) {
      t.install(id === "fx-serial" ? "serial" : "reentrant", { fixture: { pingProbe: probe, ...(probe === "barrier" ? { barrierTimeoutMs: 3000 } : {}) } });
      const h = await t.host();
      await h.call("plugin.enable", { id, grant: true });
      assert((await doctor(h, id)).ok, `${id} warmup succeeds`);
      const reports = await Promise.all([doctor(h, id), doctor(h, id)]);
      if (probe === "barrier") {
        const peak = Math.max(...readFileSync(join(t.pluginsDir, id, "ping-receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).active as number));
        assert(peak === 2, `${id} overlaps the two calls (receipts peak at ${peak} active; errors: ${reports.map(report => report.error).join()})`);
      }
      assert(reports.every(report => report.ok), `${id} both measured calls finish (got ${reports.map(report => report.error).join()})`);
      // The receipts are the measured event order; the plugin log lines are covered by the logs case.
      assertPingReceipts(readFileSync(join(t.pluginsDir, id, "ping-receipts.jsonl"), "utf8"), probe === "barrier");
    },
  })),
  { name: "observation bootstrap: plugin.doctor answers the sealed observation call", async run(t) {
    t.install("observations");
    writeFileSync(join(t.home, ".pacer", "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nplugins:\n  config:\n    fx-observations:\n      types: [task]\n");
    const h = await t.host({ subscribe: false });
    await h.call("plugin.enable", { id: "fx-observations", grant: true });
    const r = await doctor(h, "fx-observations");
    assert(r.ok, `the owner answers the observation bootstrap (got ${r.error})`);
  } },
];

const cases = (reason: string | null) => !front ? test.skip : reason ? test.failing : test;
for (const { label, argv, door } of doors) {
  for (const c of subset) {
    const reason = SUBSET[c.name]!;
    cases(reason)(`native owner conformance (${label}): ${c.name}${reason ? ` [${reason.split(":")[0]}]` : ""}`, () => runCase(c, argv, root, door), 60000);
  }
  for (const c of OWNER_VARIANTS) {
    cases(c.reason ?? null)(`native owner conformance (${label}): ${c.name}${c.reason ? ` [${c.reason.split(":")[0]}]` : ""}`, () => runCase(c, argv, root, door), 60000);
  }
}

// Capabilities relayed from a plugin child during a diagnostic ping. A ping issues no read, write,
// spawn or HTTP resources, so the TypeScript host refuses each scoped capability and nothing reaches
// the filesystem, a process or the network; config.get answers.
type Outcome = { ok: boolean; error: string | null; result: unknown };
let outcome: Outcome | undefined;
let httpHits = 0;
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { httpHits++; return new Response("{}"); } });
afterAll(() => listener.stop(true));

function relayCase(label: string, capability: string, declared: string[] | ((home: string) => string[]), method: string, params: (home: string) => Record<string, unknown>): ConformanceCase {
  return { name: `capability relay: ${label}`, async run(t: CaseContext) {
    mkdirSync(join(t.home, "data"), { recursive: true });
    writeFileSync(join(t.home, "data", "x.txt"), "fixture\n");
    const scopes = typeof declared === "function" ? declared(t.home) : declared;
    const dir = t.install("good", { manifest: { id: "fx-relay", host: "^1.6", capabilities: [{ name: "log" }, { name: capability, ...(scopes.length ? { scopes } : {}) }] }, fixture: { callCapability: method, capabilityParams: params(t.home), capabilityResultFile: "capability-result.json" } });
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-relay", grant: true });
    const report = await doctor(h, "fx-relay");
    const resultFile = join(dir, "capability-result.json");
    outcome = { ok: report.ok, error: report.error?.replaceAll(t.home, "<HOME>") ?? null, result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null };
    assert(!existsSync(join(t.home, "out", "x.txt")), "nothing is written");
  } };
}

const RELAY: [ConformanceCase, string | null][] = [
  [relayCase("config.get", "config.get", [], "config.get", () => ({})), null],
  [relayCase("fs.read", "fs.read", ["${HOME}/data/**"], "fs.read", home => ({ path: join(home, "data", "x.txt") })), ROUTED_MESSAGE],
  [relayCase("fs.read exact path", "fs.read", home => [join(home, "data", "x.txt")], "fs.read", home => ({ path: join(home, "data", "x.txt") })), ROUTED_HTTP],
  [relayCase("fs.write", "fs.write", ["${HOME}/out/**"], "fs.write", home => ({ path: join(home, "out", "x.txt"), text: "written" })), ROUTED_MESSAGE],
  [relayCase("fs.beginWrite transfer", "fs.write", ["${HOME}/out/**"], "fs.beginWrite", home => ({ path: join(home, "out", "x.txt"), bytes: 7 })), ROUTED_MESSAGE],
  [relayCase("process.spawn", "process.spawn", ["fx-tool"], "process.spawn", () => ({ argv: ["fx-tool"], timeoutMs: 1000 })), ROUTED_MESSAGE],
  [relayCase("net.http", "net.http", ["127.0.0.1"], "net.http", () => ({ url: `http://127.0.0.1:${listener.port}/`, method: "GET", timeoutMs: 2000 })), ROUTED_HTTP],
];

for (const [c, reason] of RELAY) {
  cases(reason)(`native owner conformance: ${c.name} matches the TypeScript host${reason ? ` [${reason.split(":")[0]}]` : ""}`, async () => {
    const seen: Record<string, Outcome> = {}, hits: Record<string, number> = {};
    for (const { label, argv, door } of [tsDoor, ...doors]) {
      outcome = undefined;
      const before = httpHits;
      await runCase(c, argv, root, door);
      seen[label] = outcome!;
      hits[label] = httpHits - before;
    }
    console.log(`${c.name}: ${JSON.stringify({ seen, hits })}`);
    expect(seen.typescript!.ok).toBe(c.name === "capability relay: config.get");
    expect(Object.fromEntries(doors.map(({ label }) => [label, { outcome: seen[label], hits: hits[label] }])))
      .toEqual(Object.fromEntries(doors.map(({ label }) => [label, { outcome: seen.typescript, hits: 0 }])));
  }, 90000);
}

// A diagnostic ping writes stderr covering the TypeScript log rules: `\r` stripped, empty lines kept,
// the 4096 UTF-16 unit cut (a surrogate pair cut in half becomes U+FFFD) and a dropped line over 1 MiB.
const STDERR_TEXT = ["crlf\r", "", "é😀 text", `${"x".repeat(4095)}😀tail`, "y".repeat(5000), "z".repeat(1024 * 1024 + 1), "end"].map(line => `${line}\n`).join("");
let logLines: string[] = [];
const stderrLogCase: ConformanceCase = { name: "plugin log: every stderr line in the TypeScript format", async run(t) {
  t.install("good", { fixture: { pingStderr: STDERR_TEXT } });
  const h = await t.host();
  await h.call("plugin.enable", { id: "fx-good", grant: true });
  assert((await doctor(h, "fx-good")).ok, "ping ok");
  const log = join(t.home, ".pacer", "logs", "plugins", "fx-good.log");
  const read = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  for (const end = Date.now() + 5000; Date.now() < end && !read().includes("] end\n");) await t.sleep(20);
  logLines = read().split("\n").map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "<time> "));
} };

(front ? test : test.skip)("native owner conformance: stderr log lines match the TypeScript host", async () => {
  const seen: Record<string, string[]> = {};
  for (const { label, argv, door } of [tsDoor, ...doors]) {
    logLines = [];
    await runCase(stderrLogCase, argv, root, door);
    seen[label] = logLines;
  }
  expect(seen.typescript).toContain("<time> [stderr] end");
  expect(seen.typescript).toContain("<time> [stderr] dropped a line over 1 MiB");
  for (const { label } of doors) expect({ label, lines: seen[label] }).toEqual({ label, lines: seen.typescript! });
}, 90000);

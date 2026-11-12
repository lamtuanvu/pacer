import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { installFixture } from "../conformance/install";
import { installKeychainStub } from "../scripts/live/keychain";
import { registerWork } from "../src/dispatch/work";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo } from "./helpers";
import { front, freePort, frontEnv, type Home, type Reply, stdio } from "./native-plugin-door";
import { closedPort } from "./pinned-port";

// The flag-on consumer matrix: every consumer op runs on the Rust front door with the native
// process owner (PACER_NATIVE_PLUGIN_HOST=1), with the TypeScript owner (=0), and fully forwarded
// (PACER_FORWARD_OPS=*), and must leave identical replies, activity and stores.

type Mode = { label: string; forward: string; nativeHost: "0" | "1"; transport: "http" | "stdio"; attach?: boolean };
const httpOn: Mode = { label: "http on", forward: "", nativeHost: "1", transport: "http" };
const httpOff: Mode = { label: "http off", forward: "", nativeHost: "0", transport: "http" };
const httpForward: Mode = { label: "http forward", forward: "*", nativeHost: "0", transport: "http" };
const stdioOff: Mode = { label: "stdio off", forward: "", nativeHost: "0", transport: "stdio" };
const stdioOwn: Mode = { label: "stdio on owned", forward: "", nativeHost: "1", transport: "stdio" };
const stdioAttached: Mode = { label: "stdio on attached", forward: "", nativeHost: "1", transport: "stdio", attach: true };
const stdioOffServed: Mode = { label: "stdio off beside serve", forward: "", nativeHost: "0", transport: "stdio", attach: true };

const ARK_PLAN = { items: [{ product: "coding-plan", subscribed: true, periods: [{ label: "weekly", percent: 42, reset_at: "2026-11-16T00:00:00Z" }] }] };
const CODEX_EVENT = { timestamp: "2026-11-10T03:00:00Z", payload: { rate_limits: { primary: { used_percent: 25, window_minutes: 10080, resets_in_seconds: 3600 }, credits: { has_credits: true, balance: "12.5" } } } };
const STRATEGY = (chat: number) => `planner: claude-code
accounts:
  claude-code: {kind: claude}
  codex: {kind: codex}
  plan: {kind: endpoint, usage: quota, quota_source: arkcli}
  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:${chat}/v1", key: none, models: [{id: m1, context: 1000, output: 100, tools: false}]}}
runners:
  claude-code: {}
  codex: {}
  opencode#plan: {model: plan/m}
  opencode#ep: {model: m1}
terminal: {open: "fake-term {cmd}"}
`;

const script = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

/**
 * One fixture home, rebuilt at the same /tmp path for every mode: integration previews hash
 * absolute paths, so equal paths keep their revisions comparable without rewriting them.
 */
function matrixHome(root: string, chat: number): Home {
  const home = join(root, "h");
  rmSync(home, { recursive: true, force: true });
  const state = join(home, ".pacer"), bin = join(home, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  installKeychainStub(bin, join(home, "keychain"));
  symlinkSync(process.execPath, join(bin, "bun"));
  script(bin, "arkcli", `echo "$*" >> "$HOME/arkcli.log"\ncat <<'EOF'\n${JSON.stringify(ARK_PLAN)}\nEOF`);
  script(bin, "codex", `case "$1" in --version) echo "codex-cli 0.50.0";; *) echo "codex $*" >> "$HOME/codex.log"; exit 1;; esac`);
  script(bin, "claude", `case "$1" in --version) echo "2.1.0 (Claude Code)";; *) echo "claude $*" >> "$HOME/claude.log"; exit 1;; esac`);
  script(bin, "osascript", `printf '%s|' "$@" >> "$HOME/notify.log"; echo >> "$HOME/notify.log"`);
  script(bin, "fake-term", `printf '%s\\n' "$@" >> "$HOME/terminal.log"`);
  for (const stub of ["launchctl", "systemctl"]) script(bin, stub, "exit 1");
  writeFileSync(join(state, "strategy.yaml"), STRATEGY(chat), { mode: 0o600 });
  writeFileSync(join(state, "settings.json"), JSON.stringify({ notifications: "all" }), { mode: 0o600 });
  const sessions = join(home, ".codex", "sessions", "2026", "11", "10");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-matrix.jsonl"), JSON.stringify(CODEX_EVENT) + "\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  const plugin = installFixture("ui", join(state, "plugins"));
  return { home, state, plugin, done: () => rmSync(home, { recursive: true, force: true }) };
}

function matrixEnv(h: Home, mode: Mode, port: number, extra: Record<string, string> = {}) {
  return frontEnv(h, mode.forward, { nativeHost: mode.nativeHost, env: {
    PATH: `${join(h.home, "bin")}:/usr/bin:/bin`, PACER_PORT: String(port),
    PACER_TEST_LOCAL_SERVER_PORTS: `${closedPort()},${closedPort()}`, OLLAMA_HOST: `127.0.0.1:${closedPort()}`,
    ...extra,
  } });
}

type Door = { call(op: string, params: unknown): Promise<Reply>; stderr(): string };
type Running = Door & { stop(): Promise<string> };

async function httpDoor(h: Home, mode: Mode, extra: Record<string, string> = {}, cwd?: string): Promise<Running & { port: number }> {
  const port = freePort();
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: matrixEnv(h, mode, port, extra), cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let text = "";
  const logs = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) text += decoder.decode(chunk, { stream: true });
    return text;
  })();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let i = 0; ; i++) {
    try {
      token = readFileSync(join(h.state, "token"), "utf8").trim();
      if ((await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok) break;
    } catch { /* Wait for this child only. */ }
    if (child.exitCode !== null || i > 750) { child.kill("SIGKILL"); throw Error(`serve did not start:\n${await logs}`); }
    await Bun.sleep(20);
  }
  return {
    port,
    async call(op, params) {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
      const line = await response.text();
      return { line, text: line.slice(1, -1), json: JSON.parse(line) };
    },
    stderr: () => text,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        if (await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung")]) === "hung") child.kill("SIGKILL");
        await child.exited;
      }
      return await logs;
    },
  };
}

/** Serve's first background usage refresh runs 3 s after start; waiting for it keeps provider calls countable. */
async function usageRefreshSettled<T extends Running>(h: Home, door: T): Promise<T> {
  const deadline = Date.now() + 20000;
  while (!existsSync(join(h.home, "arkcli.log")) || !existsSync(join(h.state, "state", "codex-cursors.json"))) {
    if (Date.now() > deadline) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(500);
  return door;
}

/** The door for one mode; an attached stdio door first starts a serve with the same flag, which owns run/host.sock flag-on. */
async function openDoor(h: Home, mode: Mode, extra: Record<string, string> = {}, cwd?: string): Promise<Running> {
  if (mode.transport === "http") return await usageRefreshSettled(h, await httpDoor(h, mode, extra, cwd));
  const owner = mode.attach ? await usageRefreshSettled(h, await httpDoor(h, mode.nativeHost === "1" ? httpOn : httpOff, extra)) : undefined;
  if (owner) expect(existsSync(join(h.state, "run", "host.sock"))).toBe(mode.nativeHost === "1");
  const env = matrixEnv(h, mode, owner?.port ?? closedPort(), extra);
  const door = await stdio(h, mode.forward, { nativeHost: mode.nativeHost, env });
  let text = "";
  return {
    call: (op, params) => door.call(op, params),
    stderr: () => text,
    async stop() {
      text = await door.stop();
      return text + (owner ? await owner.stop() : "");
    },
  };
}

/** Epoch seconds, elapsed seconds and pace figures the clock decides, never the fixture. */
const CLOCK_KEYS = /"(\w*(?:At|Until)|\w*AgeS|at|ts|now|mtime|mtimeMs|ageS|durationSeconds|durationMs|uptimeS|latencyMs|elapsedMs|pace|pacePct|delta|activeHoursLeft)": ?-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
/** Kernel and process identities, random record ids, and the evidence counter serve's background ticks advance. */
const IDENTITY_KEYS = /"(pid|inode|ino|id|machineId|turnId|conversationId|jobId|job|requestId|evidenceRevision)":(?:\d+|"[^"]*")/g;

/** Integration backups are named after the local wall clock second they were taken. */
const BACKUP_STAMP = /pacer-bak-\d{8}-\d{6}/g;

/** Status text phrases the clock decides: evidence ages and the pace position in the window. */
const STATUS_AGES = /observed \d+[smhd] ago|\(pace \d+%, \d+ active-h left\)/g;

function maskClockValues(text: string) {
  return text.replace(CLOCK_KEYS, '"$1":"<clock>"').replace(BACKUP_STAMP, "pacer-bak-<clock>").replace(STATUS_AGES, "<age>");
}
function maskProcessAndRecordIds(text: string) {
  return text.replace(IDENTITY_KEYS, '"$1":"<id>"');
}
/** Normalized reply text: the same envelope bytes once clock values and generated ids are masked. */
function replyText(h: Home, reply: Reply) {
  return maskProcessAndRecordIds(maskClockValues(reply.text.replaceAll(h.home, "<HOME>")));
}
/** Activity lines keep kind, level, text and links; id, time and machine are generated. */
function activityLines(h: Home) {
  const path = join(h.state, "state", "activity.jsonl");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map(line => { const { id: _id, at: _at, machineId: _machine, ...rest } = JSON.parse(line); return JSON.stringify(rest).replaceAll(h.home, "<HOME>"); })
    .join("\n");
}
/** A persisted store's bytes with clock values and file identities masked. */
function storeBytes(h: Home, path: string) {
  const file = join(h.state, path);
  return existsSync(file) ? maskProcessAndRecordIds(maskClockValues(readFileSync(file, "utf8").replaceAll(h.home, "<HOME>"))) : "<absent>";
}
function fileTree(h: Home, dir: string) {
  const root = join(h.home, dir), out: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path, name)); return; }
    out.push(`${relative(h.home, path)}\n${readFileSync(path, "utf8").replaceAll(h.home, "<HOME>")}`);
  };
  walk(root);
  return maskClockValues(out.join("\n---\n"));
}
const fileText = (h: Home, path: string) => existsSync(join(h.home, path)) ? readFileSync(join(h.home, path), "utf8").replaceAll(h.home, "<HOME>") : "<absent>";

type Observation = Record<string, string>;
/** Stops the door, runs `between` on the stopped home, and opens the same mode again. */
type Restart = (between?: () => void) => Promise<void>;
type Scenario = (door: Door, h: Home, observe: (key: string, value: string) => void, restart: Restart) => Promise<void>;
type Run = { mode: Mode; observed: Observation; stderr: string };

async function runModes(name: string, modes: Mode[], scenario: Scenario, stores: string[] = [], extra: Record<string, string> = {}) {
  const root = `/tmp/pom-${name}`;
  const runs: Run[] = [];
  const chat = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: chatCompletion });
  try {
    for (const mode of modes) {
      const h = matrixHome(root, chat.port!);
      const observed: Observation = {};
      const observe = (key: string, value: string) => { observed[key] = value; };
      let current = await openDoor(h, mode, extra), stderr = "";
      const door: Door = { call: (op, params) => current.call(op, params), stderr: () => stderr + current.stderr() };
      const restart: Restart = async between => {
        stderr += await current.stop();
        between?.();
        current = await openDoor(h, mode, extra);
      };
      try { await scenario(door, h, observe, restart); }
      finally { stderr += await current.stop(); }
      observe("activity", activityLines(h));
      for (const store of stores) observe(store, storeBytes(h, store));
      runs.push({ mode, observed, stderr });
    }
  } finally {
    chat.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
  const dump = process.env.PACER_MATRIX_DUMP;
  if (dump) {
    mkdirSync(dump, { recursive: true });
    writeFileSync(join(dump, `${name}.json`), JSON.stringify(runs, null, 2));
  }
  return runs;
}

/** Keys whose differences are expected for one mode, with the reason recorded beside the row. */
type Known = Partial<Record<string, string[]>>;

function expectIdentical(runs: Run[], known: Known = {}) {
  const [reference, ...others] = runs;
  const verdicts: string[] = [];
  for (const run of others) {
    const skip = new Set(known[run.mode.label] ?? []);
    for (const key of Object.keys(reference!.observed)) {
      if (skip.has(key)) continue;
      expect(run.observed[key], `${key}: ${run.mode.label} vs ${reference!.mode.label}`).toBe(reference!.observed[key]);
    }
    verdicts.push(`${run.mode.label}=${reference!.mode.label} (${Object.keys(reference!.observed).length - skip.size} keys)`);
  }
  return verdicts;
}

function chatCompletion(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/chat/completions")) {
    return Response.json({ choices: [{ message: { content: "Fixture answer." } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  }
  return Response.json({ data: [{ id: "m1" }] });
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(100);
  }
}

const USAGE_STORES = ["cache/arkcli-usage-plan.json", "state/codex-cursors.json", "plugin-settings.json"];

const usage: Scenario = async (door, h, observe) => {
  const before = fileText(h, "arkcli.log").replace("<absent>", "");
  observe("limits.refresh plan", replyText(h, await door.call("limits.refresh", { account: "plan" })));
  observe("limits.refresh codex", replyText(h, await door.call("limits.refresh", { account: "codex" })));
  observe("limits.refresh all", replyText(h, await door.call("limits.refresh", {})));
  observe("arkcli argv", fileText(h, "arkcli.log").slice(before.length));
  const check = await door.call("account.usage.check", { account: "codex" });
  observe("account.usage.check", replyText(h, check));
  const job = check.json.result?.id ?? check.json.result?.job?.id;
  if (job) {
    const settled = await poll(() => door.call("job.get", { id: job }), reply => ["done", "failed", "cancelled"].includes(reply.json.result?.state));
    observe("account.usage.check job", replyText(h, settled));
  }
  observe("account.list", replyText(h, await door.call("account.list", {})));
  observe("limits.check", replyText(h, await door.call("limits.check", {})));
  observe("routing.status", replyText(h, await door.call("routing.status", {})));
  observe("plugin.settings.set", replyText(h, await door.call("plugin.settings.set", { plugin: "fx-ui", values: { required: true }, expect_rev: 0 })));
};

test.skipIf(!front)("usage consumers: limits.refresh, account.usage.check, account.list and status parts", async () => {
  const runs = await runModes("usage", [httpOff, httpOn, httpForward], usage, USAGE_STORES);
  for (const run of runs) expect(run.observed["limits.refresh plan"], run.mode.label).toContain('"outcome":"updated"');
  console.log(expectIdentical(runs).join("\n"));
}, 240000);

const HOST_SOCKET_CHECK = /,\{"name":"Plugin host socket","level":"info","detail":"[^"]*"\}/g;

/** Doctor output without the flag-on Plugin host socket check, which is observed on its own. */
function doctorText(h: Home, reply: Reply, observe: (key: string, value: string) => void, key: string) {
  const text = linkLatencyMasked(replyText(h, reply));
  observe(`${key} host socket check`, (text.match(HOST_SOCKET_CHECK) ?? []).join("").replace(/owner pid \d+/, "owner pid <pid>"));
  return text.replace(HOST_SOCKET_CHECK, "");
}

const doctorSetup: Scenario = async (door, h, observe) => {
  observe("doctor.run", doctorText(h, await door.call("doctor.run", {}), observe, "doctor.run"));
  observe("setup.check", replyText(h, await door.call("setup.check", {})));
  observe("setup.health", doctorText(h, await door.call("setup.health", { trigger: "manual" }), observe, "setup.health"));
};

/** The Link check reports measured loopback latency; its name, level and remedy follow the measurement. */
function linkLatencyMasked(text: string) {
  const measured = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(measured);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if ((record.name === "Link" || record.name === "Link latency") && "level" in record) return { name: "Link", level: "<measured>" };
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, measured(child)]));
  };
  return JSON.stringify(measured(JSON.parse(`{${text}}`))).slice(1, -1);
}

/** ADR 0027: only a flag-on serve owns run/host.sock, so only its doctor reports the live socket. */
const FLAG_ON_DOCTOR_ADDITIONS = ["doctor.run host socket check", "setup.health host socket check"];
function expectHostSocketReported(runs: Run[]) {
  for (const run of runs) {
    const reported = run.observed["doctor.run host socket check"];
    if (run.mode.nativeHost === "1" && run.mode.transport === "http") expect(reported, run.mode.label).toContain("/.pacer/run/host.sock is live (owner pid <pid>)");
    else if (run.mode.nativeHost === "0") expect(reported, run.mode.label).toBe("");
  }
}

const PLANNER_STORES = ["install-manifest.json", "onboarding/skipped", "strategy.yaml"];

const planners: Scenario = async (door, h, observe) => {
  observe("agent.detect", replyText(h, await door.call("agent.detect", {})));
  const preview = await door.call("agent.preview", { agent: "claude-code" });
  observe("agent.preview", replyText(h, preview));
  const connect = await door.call("agent.connect", { agent: "claude-code", consent: true, preview_revision: preview.json.result?.revision });
  observe("agent.connect", replyText(h, connect));
  observe("integration files", fileTree(h, ".claude"));
  observe("agent.preview connected", replyText(h, await door.call("agent.preview", { agent: "claude-code" })));
  observe("doctor.run connected", doctorText(h, await door.call("doctor.run", {}), observe, "doctor.run connected"));
  observe("setup.check connected", replyText(h, await door.call("setup.check", {})));
  observe("agent.disconnect", replyText(h, await door.call("agent.disconnect", { agent: "claude-code" })));
  observe("integration files disconnected", fileTree(h, ".claude"));
  observe("onboarding.skip", replyText(h, await door.call("onboarding.skip", {})));
  observe("strategy.build", replyText(h, await door.call("strategy.build", { agent: "claude-code", request_id: "00000000-0000-4000-8000-00000000000a" })));
  const terminal = await poll(async () => fileText(h, "terminal.log"), text => text !== "<absent>", 15000);
  const scriptPath = terminal.trim().replace("<HOME>", h.home);
  observe("strategy.build terminal", maskTerminalScriptIds(terminal));
  observe("strategy.build script", existsSync(scriptPath) ? maskTerminalScriptIds(maskClockValues(readFileSync(scriptPath, "utf8").replaceAll(h.home, "<HOME>"))) : "<absent>");
};

/** Each terminal launch draws a random UUID for its script name, receipt directory and nonce. */
function maskTerminalScriptIds(text: string) {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}

test.skipIf(!front)("planner consumers: agent.detect, preview, connect, disconnect, onboarding.skip and strategy.build", async () => {
  const runs = await runModes("planners", [httpOff, httpOn, httpForward], planners, PLANNER_STORES);
  console.log(expectIdentical(runs, { "http on": ["doctor.run connected host socket check"] }).join("\n"));
}, 240000);

test.skipIf(!front)("doctor and setup consumers: doctor.run, setup.check and setup.health", async () => {
  const runs = await runModes("doctor", [httpOff, httpOn, httpForward], doctorSetup, ["state/setup-health.json"]);
  expectHostSocketReported(runs);
  console.log(expectIdentical(runs, { "http on": FLAG_ON_DOCTOR_ADDITIONS }).join("\n"));
}, 240000);

async function connectClaude(door: Door) {
  const preview = await door.call("agent.preview", { agent: "claude-code" });
  return await door.call("agent.connect", { agent: "claude-code", consent: true, preview_revision: preview.json.result?.revision });
}
const integrationLines = (stderr: string) => stderr.split("\n").filter(line => line.startsWith("pacer: integration")).join("\n");

const startupReconcile: Scenario = async (door, h, observe, restart) => {
  observe("agent.connect", replyText(h, await connectClaude(door)));
  observe("manifest after connect", storeBytes(h, "install-manifest.json"));
  observe("agent.connect again", replyText(h, await connectClaude(door)));
  observe("manifest after reconnect", storeBytes(h, "install-manifest.json"));
  await restart(() => unlinkSync(join(h.home, ".claude", "rules", "pacer.md")));
  observe("restored rules file", await poll(async () => fileText(h, ".claude/rules/pacer.md"), text => text !== "<absent>", 20000));
  observe("integration files after refresh", fileTree(h, ".claude"));
  observe("manifest after refresh", storeBytes(h, "install-manifest.json"));
  await restart(() => writeFileSync(join(h.home, ".claude", "skills", "pacer", "SKILL.md"), "edited by hand\n"));
  observe("conflict warning", await poll(async () => integrationLines(door.stderr()), text => text !== "", 20000));
  observe("integration files after conflict", fileTree(h, ".claude"));
};

let reconcileMemo: Promise<Run[]> | undefined;
const reconcileRuns = () => reconcileMemo ??= runModes("reconcile", [httpOff, httpOn, httpForward], startupReconcile, ["install-manifest.json"]);
/**
 * Routed (security boundary): the native owner writes every plugin frame with
 * plugin-host `process::frame`, which sorts object keys, so a planner echoing its prior
 * record back makes Core persist install-manifest.json with sorted keys.
 */
const PRIOR_ECHO_MANIFESTS = ["manifest after reconnect", "manifest after refresh", "install-manifest.json"];

test.skipIf(!front)("startup reconcile refreshes a deleted integration file and reports a hand-edited one", async () => {
  const runs = await reconcileRuns();
  for (const run of runs) expect(run.observed["restored rules file"], run.mode.label).not.toBe("<absent>");
  for (const run of runs) expect(run.observed["conflict warning"], run.mode.label).toContain("managed integration content changed");
  for (const run of runs) for (const key of PRIOR_ECHO_MANIFESTS) expect(JSON.parse(run.observed[key]!), `${run.mode.label} ${key}`).toEqual(JSON.parse(runs[0]!.observed[key]!));
  console.log(expectIdentical(runs, { "http on": PRIOR_ECHO_MANIFESTS }).join("\n"));
}, 240000);

(front ? test.failing : test.skip)("routed: flag-on planner reconnect and refresh keep install-manifest.json key order", async () => {
  const runs = await reconcileRuns();
  const [off, on] = runs;
  for (const key of PRIOR_ECHO_MANIFESTS) expect(on!.observed[key], key).toBe(off!.observed[key]);
}, 240000);

/** The delivery ledger keys each attention item by id and since; delivery times are the clock's. */
function ledgerKeys(h: Home) {
  const path = join(h.state, "state", "notified.json");
  if (!existsSync(path)) return "<absent>";
  return Object.keys(JSON.parse(readFileSync(path, "utf8"))).map(key => key.replace(/:[\d.]+$/, ":<clock>")).sort().join("\n");
}

const notifier: Scenario = async (_door, h, observe) => {
  const delivered = await poll(async () => fileText(h, "notify.log"), text => text !== "<absent>", 20000);
  await Bun.sleep(2000);
  observe("notifier first delivery", delivered === "<absent>" ? delivered : "delivered");
  observe("osascript argv", fileText(h, "notify.log").split("\n").filter(Boolean).sort().join("\n"));
  observe("notified ledger", ledgerKeys(h));
};

test.skipIf(!front)("notifier: serve delivers attention through pacer-notify's sealed osascript command", async () => {
  const runs = await runModes("notifier", [httpOff, httpOn, httpForward], notifier);
  for (const run of runs) expect(run.observed["notifier first delivery"], run.mode.label).toBe("delivered");
  console.log(expectIdentical(runs).join("\n"));
}, 240000);

const assistant: Scenario = async (door, h, observe) => {
  observe("assistant.settings.set", replyText(h, await door.call("assistant.settings.set", { runner: "opencode#ep", account: "ep", expect_rev: 1 })));
  observe("assistant.status", replyText(h, await door.call("assistant.status", {})));
  const ask = await door.call("assistant.ask", { text: "What is running?", scope: { kind: "dispatch", days: 7 }, requestId: "matrix-ask" });
  observe("assistant.ask", replyText(h, ask));
  const turnId = ask.json.result?.turnId;
  if (turnId) {
    const turn = await poll(() => door.call("assistant.turn", { turnId }), reply => reply.json.result && reply.json.result.state !== "running");
    observe("assistant.turn", replyText(h, turn));
  }
};

let assistantMemo: Promise<Run[]> | undefined;
const assistantRuns = () => assistantMemo ??= runModes("assistant", [httpOff, httpOn, httpForward], assistant);

test.skipIf(!front)("assistant: flag-off and forwarded turns answer from the fixture endpoint", async () => {
  const runs = await assistantRuns();
  for (const run of runs.filter(run => run.mode.nativeHost === "0")) expect(run.observed["assistant.turn"], run.mode.label).toContain("Fixture answer.");
  console.log(expectIdentical(runs.filter(run => run.mode.nativeHost === "0")).join("\n"));
  const on = runs.find(run => run.mode === httpOn)!;
  expect(on.observed["assistant.turn"]).toContain('"state":"error","error":"capability is not granted to the owning call: secret alias was not issued"');
}, 240000);

/**
 * Routed (secrets boundary): pacer-assistant resolves its endpoint key with
 * capability.secrets.resolve, and the native owner call carries no issued secret alias.
 */
(front ? test.failing : test.skip)("routed: flag-on assistant turn answers like flag-off", async () => {
  const runs = await assistantRuns();
  expectIdentical([runs.find(run => run.mode === httpOff)!, runs.find(run => run.mode === httpOn)!]);
}, 240000);

const refusal = (method: string) => `${method} needs credential bindings, which the native process owner bridge does not carry`;
/** PR 4 shapes the native owner bridge refuses by design (CHANGELOG known limits), keyed by observation. */
const KNOWN_REFUSED: Record<string, string> = {
  "account.models keyless": "endpoint.models",
  "account.models keyed": "endpoint.models",
  "account.test": "endpoint.test",
  "routing.route goal": "classifier.ask",
};

const endpoints: Scenario = async (door, h, observe) => {
  observe("runner.set", replyText(h, await door.call("runner.set", { id: "opencode#ep", max_tasks: 2 })));
  observe("opencode.json", storeBytes(h, "opencode/opencode.json"));
  const base = readFileSync(join(h.state, "strategy.yaml"), "utf8").match(/base_url: "([^"]+)"/)![1];
  observe("account.models keyless", replyText(h, await door.call("account.models", { name: "ep" })));
  observe("account.models keyed", replyText(h, await door.call("account.models", { base_url: base, key: "sk-matrix-fixture" })));
  observe("account.test", replyText(h, await door.call("account.test", { name: "ep" })));
  observe("routing.route goal", replyText(h, await door.call("routing.route", { goal: "fix the parser" })));
};

test.skipIf(!front)("PR 4 endpoint shapes: empty-binding launchEnv crosses, credential-bound calls stay refused", async () => {
  const runs = await runModes("endpoints", [httpOff, httpOn, httpForward], endpoints, ["strategy.yaml"]);
  const on = runs.find(run => run.mode === httpOn)!;
  for (const [key, method] of Object.entries(KNOWN_REFUSED)) expect(on.observed[key], key).toContain(refusal(method));
  expect(on.observed["opencode.json"]).not.toBe("<absent>");
  console.log(expectIdentical(runs, { "http on": Object.keys(KNOWN_REFUSED) }).join("\n"));
}, 240000);

/** Runner processes Core detaches for a retried task, as the preload probe recorded them. */
function runnerEnvs(log: string) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { socket: string | null; args: string[] })
    .filter(entry => entry.args[0] === "_run");
}
function killRunners(id: string) {
  for (const line of Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (pid && command.join(" ").includes(`_run ${id}`)) try { process.kill(Number(pid), "SIGKILL"); } catch { /* Already gone. */ }
  }
}

/** I1: what PACER_HOST_SOCKET a detached `_run` runner inherits from Core in each mode. */
async function runnerSocket(mode: Mode) {
  const root = `/tmp/pom-i1`;
  const h = matrixHome(root, closedPort());
  const repo = gitRepo();
  const log = join(h.home, "bun-processes");
  const probe = join(h.home, "socket-probe.cjs");
  writeFileSync(probe, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ socket: process.env.PACER_HOST_SOCKET ?? null, args: process.argv.slice(2) }) + "\\n");\n`);
  // Serve clears BUN_OPTIONS for its Core child; Bun still reads bunfig.toml from the working directory Core and its runners share.
  writeFileSync(join(h.home, "bunfig.toml"), `preload = [${JSON.stringify(probe)}]\n`);
  writeFileSync(join(h.home, ".codex", "auth.json"), "{}");
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state, now: Math.floor(Date.now() / 1000) });
  const { id } = createTask(ctx, { title: "Retry me", brief: { goal: "Retry me", repo }, kind: "feature", requestedExecutor: null, timeoutS: 3600 });
  registerWork(ctx, id, {});
  updateTask(ctx, id, record => {
    record.executor = "codex";
    record.attempts = [{ executor: "codex", model: null, startedAt: ctx.now - 600, endedAt: ctx.now - 120, exitCode: 1, timedOut: false, limitHit: false, log: join(h.state, "logs", `${id}.log`) }];
    record.state = "failed"; record.settledAt = ctx.now - 120;
    record.result = { status: "failed", executor: "codex", model: null, backend: "direct", files: "", report: "Failed.", acceptance: { cmd: "bun test", passed: false, tail: "1 failed" } };
  });
  const door = await openDoor(h, mode, { BUN_OPTIONS: `--preload ${probe}` }, h.home);
  try {
    const task = (await door.call("task.get", { id })).json.result;
    const retry = await door.call("dispatch.retry", { id, expect_rev: task?.rev ?? task?.task?.rev, requestId: `i1-${mode.label.replaceAll(" ", "-")}`, feedback: "Run the tests first" });
    expect(retry.json.error, retry.line).toBeUndefined();
    const runners = await poll(async () => runnerEnvs(log), entries => entries.length > 0, 60000);
    const settled = await poll(() => door.call("task.get", { id }), reply => reply.json.result?.state !== "running", 30000);
    const core = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.args[0] !== "_run") : [];
    return {
      runners: [...new Set(runners.map(entry => entry.socket?.replace(h.state, "<PACER_HOME>") ?? null))],
      core: [...new Set(core.map(entry => entry.socket?.replace(h.state, "<PACER_HOME>") ?? null))],
      task: settled.json.result?.state,
    };
  } finally {
    await door.stop();
    killRunners(id);
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(!front)("I1: a detached _run runner inherits the owner socket flag-on and none flag-off", async () => {
  const on = await runnerSocket(httpOn);
  const off = await runnerSocket(httpOff);
  const owned = await runnerSocket(stdioOwn);
  console.log(JSON.stringify({ on, off, owned }));
  expect(on.runners).toEqual(["<PACER_HOME>/run/host.sock"]);
  expect(off.runners).toEqual([null]);
  expect(owned.runners).toHaveLength(1);
  expect(owned.runners[0]).toMatch(/^<PACER_HOME>\/run\/s[0-9a-f]{12}\.sock$/);
}, 400000);

/** Stdio rows: flag-on self-owned against flag-off alone, and flag-on attached against flag-off beside a flag-off serve. */
async function stdioRows(name: string, scenario: Scenario, stores: string[], known: string[] = []) {
  const owned = await runModes(`${name}-owned`, [stdioOff, stdioOwn], scenario, stores);
  const attached = await runModes(`${name}-attached`, [stdioOffServed, stdioAttached], scenario, stores);
  expect(owned[1]!.stderr).toContain("native plugin owner own ");
  expect(attached[1]!.stderr).toContain(`native plugin owner attach ${attached[1]!.stderr.match(/attach (\S+host\.sock)/)?.[1] ?? "<missing>"}`);
  return [
    ...expectIdentical(owned, { [stdioOwn.label]: known }),
    ...expectIdentical(attached, { [stdioAttached.label]: known }),
  ];
}

test.skipIf(!front)("stdio rows: usage consumers self-owned and attached", async () => {
  console.log((await stdioRows("stdio-usage", usage, USAGE_STORES)).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: doctor and setup consumers self-owned and attached", async () => {
  console.log((await stdioRows("stdio-doctor", doctorSetup, ["state/setup-health.json"], FLAG_ON_DOCTOR_ADDITIONS)).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: planner consumers self-owned and attached", async () => {
  console.log((await stdioRows("stdio-planners", planners, PLANNER_STORES, ["doctor.run connected host socket check"])).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: PR 4 endpoint shapes self-owned and attached", async () => {
  console.log((await stdioRows("stdio-endpoints", endpoints, ["strategy.yaml"], Object.keys(KNOWN_REFUSED))).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: assistant turns fail flag-on with the routed secret alias error", async () => {
  const runs = [...await runModes("stdio-assistant-owned", [stdioOff, stdioOwn], assistant), ...await runModes("stdio-assistant-attached", [stdioOffServed, stdioAttached], assistant)];
  for (const run of runs) {
    if (run.mode.nativeHost === "0") expect(run.observed["assistant.turn"], run.mode.label).toContain('"answer":"Fixture answer."');
    else expect(run.observed["assistant.turn"], run.mode.label).toContain('"error":"capability is not granted to the owning call: secret alias was not issued"');
  }
}, 300000);

const reconnect: Scenario = async (door, h, observe) => {
  observe("agent.connect", replyText(h, await connectClaude(door)));
  observe("agent.connect again", replyText(h, await connectClaude(door)));
  observe("manifest after reconnect", storeBytes(h, "install-manifest.json"));
};
let stdioReconnectMemo: Promise<Run[]> | undefined;
const stdioReconnectRuns = () => stdioReconnectMemo ??= (async () => [
  ...await runModes("stdio-reconnect-owned", [stdioOff, stdioOwn], reconnect),
  ...await runModes("stdio-reconnect-attached", [stdioOffServed, stdioAttached], reconnect),
])();

test.skipIf(!front)("stdio rows: planner reconnect matches flag-off except the routed manifest key order", async () => {
  const runs = await stdioReconnectRuns();
  for (const [off, on] of [[runs[0]!, runs[1]!], [runs[2]!, runs[3]!]]) {
    expect(JSON.parse(on.observed["manifest after reconnect"]!), on.mode.label).toEqual(JSON.parse(off.observed["manifest after reconnect"]!));
  }
  console.log([
    ...expectIdentical(runs.slice(0, 2), { [stdioOwn.label]: ["manifest after reconnect"] }),
    ...expectIdentical(runs.slice(2), { [stdioAttached.label]: ["manifest after reconnect"] }),
  ].join("\n"));
}, 300000);

(front ? test.failing : test.skip)("routed: flag-on stdio planner reconnect keeps install-manifest.json key order", async () => {
  const runs = await stdioReconnectRuns();
  expect(runs[1]!.observed["manifest after reconnect"]).toBe(runs[0]!.observed["manifest after reconnect"]);
  expect(runs[3]!.observed["manifest after reconnect"]).toBe(runs[2]!.observed["manifest after reconnect"]);
}, 300000);

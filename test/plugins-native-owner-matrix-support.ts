import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { installFixture } from "../conformance/install";
import { installKeychainStub } from "../scripts/live/keychain";
import { front, freePort, frontEnv, type Home, type Reply, stdio } from "./native-plugin-door";
import { closedPort } from "./pinned-port";

// The flag-on consumer matrix: every consumer op runs on the Rust front door with the native
// process owner (PACER_NATIVE_PLUGIN_HOST=1), with the TypeScript owner (=0), and fully forwarded
// (PACER_FORWARD_OPS=*), and must leave identical replies, activity and stores.

export type Mode = { label: string; forward: string; nativeHost: "0" | "1"; transport: "http" | "stdio"; attach?: boolean };
export const httpOn: Mode = { label: "http on", forward: "", nativeHost: "1", transport: "http" };
export const httpOff: Mode = { label: "http off", forward: "", nativeHost: "0", transport: "http" };
export const httpForward: Mode = { label: "http forward", forward: "*", nativeHost: "0", transport: "http" };
export const stdioOff: Mode = { label: "stdio off", forward: "", nativeHost: "0", transport: "stdio" };
export const stdioOwn: Mode = { label: "stdio on owned", forward: "", nativeHost: "1", transport: "stdio" };
export const stdioAttached: Mode = { label: "stdio on attached", forward: "", nativeHost: "1", transport: "stdio", attach: true };
export const stdioOffServed: Mode = { label: "stdio off beside serve", forward: "", nativeHost: "0", transport: "stdio", attach: true };

export const ARK_PLAN = { items: [{ product: "coding-plan", subscribed: true, periods: [{ label: "weekly", percent: 42, reset_at: "2026-11-16T00:00:00Z" }] }] };
export const CODEX_EVENT = { timestamp: "2026-11-10T03:00:00Z", payload: { rate_limits: { primary: { used_percent: 25, window_minutes: 10080, resets_in_seconds: 3600 }, credits: { has_credits: true, balance: "12.5" } } } };
export const STRATEGY = (chat: number) => `planner: claude-code
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

export const script = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

/**
 * One fixture home, rebuilt at the same /tmp path for every mode: integration previews hash
 * absolute paths, so equal paths keep their revisions comparable without rewriting them.
 */
export function matrixHome(root: string, chat: number): Home {
  const home = join(root, "h");
  rmSync(home, { recursive: true, force: true });
  const state = join(home, ".pacer"), bin = join(home, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  installKeychainStub(bin, join(home, "keychain"));
  symlinkSync(process.execPath, join(bin, "bun"));
  script(bin, "arkcli", `echo "$*" >> "$HOME/arkcli.log"\ncat <<'EOF'\n${JSON.stringify(ARK_PLAN)}\nEOF`);
  // The app-server reads the host's request before failing: exiting first races the host's stdin write (EPIPE).
  script(bin, "codex", `case "$1" in --version) echo "codex-cli 0.50.0";; *) echo "codex $*" >> "$HOME/codex.log"; case "$*" in *app-server*) read -r _;; esac; exit 1;; esac`);
  script(bin, "claude", `case "$1" in --version) echo "2.1.0 (Claude Code)";; *) echo "claude $*" >> "$HOME/claude.log"; exit 1;; esac`);
  // pacer-notify delivers with osascript on macOS and notify-send on Linux.
  for (const notifier of ["osascript", "notify-send"]) script(bin, notifier, `printf '%s|' "$@" >> "$HOME/notify.log"; echo >> "$HOME/notify.log"`);
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

export function matrixEnv(h: Home, mode: Mode, port: number, extra: Record<string, string> = {}) {
  return frontEnv(h, mode.forward, { nativeHost: mode.nativeHost, env: {
    PATH: `${join(h.home, "bin")}:/usr/bin:/bin`, PACER_PORT: String(port),
    PACER_TEST_LOCAL_SERVER_PORTS: `${closedPort()},${closedPort()}`, OLLAMA_HOST: `127.0.0.1:${closedPort()}`,
    ...extra,
  } });
}

export type Door = { call(op: string, params: unknown): Promise<Reply>; stderr(): string };
export type Running = Door & { stop(): Promise<string> };

export async function httpDoor(h: Home, mode: Mode, extra: Record<string, string> = {}, cwd?: string): Promise<Running & { port: number }> {
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
      if ((await fetch(`${base}/v2/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok) break;
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
export async function usageRefreshSettled<T extends Running>(h: Home, door: T): Promise<T> {
  const deadline = Date.now() + 20000;
  while (!existsSync(join(h.home, "arkcli.log")) || !existsSync(join(h.state, "state", "codex-cursors.json"))) {
    if (Date.now() > deadline) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(500);
  return door;
}

/** The door for one mode; an attached stdio door first starts a serve with the same flag, which owns run/host.sock flag-on. */
export async function openDoor(h: Home, mode: Mode, extra: Record<string, string> = {}, cwd?: string): Promise<Running> {
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

/** Epoch seconds, elapsed seconds and pace figures the clock decides, never the fixture (`resetsAt` comes from the fixture plans). */
export const CLOCK_KEYS = /"((?!resetsAt")\w*(?:At|Until)|\w*AgeS|at|ts|now|mtime|mtimeMs|ageS|durationSeconds|durationMs|uptimeS|latencyMs|elapsedMs|pace|pacePct|delta|activeHoursLeft)": ?-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
/** Kernel and process identities, keys that only ever hold generated ids, and the evidence counter serve's background ticks advance. */
export const IDENTITY_KEYS = /"(pid|inode|ino|machineId|turnId|conversationId|jobId|job|requestId|evidenceRevision)":(?:\d+|"[^"]*")/g;
/**
 * Generated record ids by shape: job UUIDs, task ids `t-<local stamp>-<hex>`, assistant `turn-`/`conv-` ids, and
 * evidence fact ids (24 hex, hashed over the fact's clock stamps). Executor, provider and plugin ids stay visible.
 */
export const GENERATED_IDS = /"id":"(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|t-\d{8}-\d{6}-[0-9a-f]{4}|(?:turn|conv)-[0-9a-f]{8}-[0-9a-f]{3}|[0-9a-f]{24})"/g;

/** Integration backups are named after the local wall clock second they were taken. */
export const BACKUP_STAMP = /pacer-bak-\d{8}-\d{6}/g;

/** Status text phrases the clock decides: evidence ages and the pace position in the window. */
export const STATUS_AGES = /observed \d+[smhd] ago|\(pace \d+%, \d+ active-h left\)/g;

export function maskClockValues(text: string) {
  return text.replace(CLOCK_KEYS, '"$1":"<clock>"').replace(BACKUP_STAMP, "pacer-bak-<clock>").replace(STATUS_AGES, "<age>");
}
/** Eligibility reasons cite evidence facts by the same clock-hashed ids; mask each, keeping the count. */
export const EVIDENCE_REFS = /"evidenceIds":\[([^\]]*)\]/g;

export function maskProcessAndRecordIds(text: string) {
  return text.replace(IDENTITY_KEYS, '"$1":"<id>"').replace(GENERATED_IDS, '"id":"<id>"')
    .replace(EVIDENCE_REFS, (_, refs: string) => `"evidenceIds":[${refs.replace(/"[0-9a-f]{24}"/g, '"<id>"')}]`);
}
/** Normalized reply text: the same envelope bytes once clock values and generated ids are masked. */
export function replyText(h: Home, reply: Reply) {
  return maskProcessAndRecordIds(maskClockValues(reply.text.replaceAll(h.home, "<HOME>")));
}
/**
 * Activity lines keep kind, level, text and links; id, time and machine are generated.
 * Serve's background link pump logs budget_refreshed whenever its timer lands, so those lines are timing.
 */
export function activityLines(h: Home) {
  const path = join(h.state, "state", "activity.jsonl");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.kind !== "budget_refreshed")
    .map(({ id: _id, at: _at, machineId: _machine, ...rest }) => JSON.stringify(rest).replaceAll(h.home, "<HOME>"))
    .join("\n");
}
/** A persisted store's bytes with clock values and file identities masked. */
export function storeBytes(h: Home, path: string) {
  const file = join(h.state, path);
  return existsSync(file) ? maskProcessAndRecordIds(maskClockValues(readFileSync(file, "utf8").replaceAll(h.home, "<HOME>"))) : "<absent>";
}
export function fileTree(h: Home, dir: string) {
  const root = join(h.home, dir), out: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path, name)); return; }
    out.push(`${relative(h.home, path)}\n${readFileSync(path, "utf8").replaceAll(h.home, "<HOME>")}`);
  };
  walk(root);
  return maskClockValues(out.join("\n---\n"));
}
export const fileText = (h: Home, path: string) => existsSync(join(h.home, path)) ? readFileSync(join(h.home, path), "utf8").replaceAll(h.home, "<HOME>") : "<absent>";

export type Observation = Record<string, string>;
/** Stops the door, runs `between` on the stopped home, and opens the same mode again. */
export type Restart = (between?: () => void) => Promise<void>;
export type Scenario = (door: Door, h: Home, observe: (key: string, value: string) => void, restart: Restart) => Promise<void>;
export type Run = { mode: Mode; observed: Observation; stderr: string };

/** This file's own short /tmp root: owner sockets bind under each home, and every mode of a row reuses one path. */
let matrixRoot = "";
/** Call once from each test file; test files that share a process each get their own root. */
export function useMatrixRoot() {
  const root = mkdtempSync("/tmp/pom-");
  beforeAll(() => { matrixRoot = root; });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
}
/** A named directory under this file's root. */
export const matrixPath = (name: string) => join(matrixRoot, name);

export async function runModes(name: string, modes: Mode[], scenario: Scenario, stores: string[] = [], extra: Record<string, string> = {}) {
  const root = join(matrixRoot, name);
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
export type Known = Partial<Record<string, string[]>>;

export function expectIdentical(runs: Run[], known: Known = {}) {
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

export function chatCompletion(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/chat/completions")) {
    return Response.json({ choices: [{ message: { content: "Fixture answer." } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  }
  return Response.json({ data: [{ id: "m1" }] });
}

export async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(100);
  }
}

/** Distinct provider argv: serve's background usage refresh can join or skip an explicit refresh, so the call count is timing. */
export const distinctArgv = (log: string) => [...new Set(log.split("\n").filter(Boolean))].sort().join("\n");

export const USAGE_STORES = ["cache/arkcli-usage-plan.json", "state/codex-cursors.json", "plugin-settings.json"];

export const usage: Scenario = async (door, h, observe) => {
  const before = fileText(h, "arkcli.log").replace("<absent>", "");
  observe("limits.refresh plan", replyText(h, await door.call("limits.refresh", { account: "plan" })));
  observe("limits.refresh codex", replyText(h, await door.call("limits.refresh", { account: "codex" })));
  observe("limits.refresh all", replyText(h, await door.call("limits.refresh", {})));
  observe("arkcli argv", distinctArgv(fileText(h, "arkcli.log").slice(before.length)));
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

export const HOST_SOCKET_CHECK = /,\{"name":"Plugin host socket","level":"info","detail":"[^"]*"\}/g;

/** Doctor output without the flag-on Plugin host socket check, which is observed on its own. */
export function doctorText(h: Home, reply: Reply, observe: (key: string, value: string) => void, key: string) {
  const text = linkLatencyMasked(replyText(h, reply));
  observe(`${key} host socket check`, (text.match(HOST_SOCKET_CHECK) ?? []).join("").replace(/owner pid \d+/, "owner pid <pid>"));
  return text.replace(HOST_SOCKET_CHECK, "");
}

export const doctorSetup: Scenario = async (door, h, observe) => {
  observe("doctor.run", doctorText(h, await door.call("doctor.run", {}), observe, "doctor.run"));
  observe("setup.check", replyText(h, await door.call("setup.check", {})));
  observe("setup.health", doctorText(h, await door.call("setup.health", { trigger: "manual" }), observe, "setup.health"));
};

export const LINK_CHECKS = ["Link", "Link latency"];
export const isLinkRepair = (value: unknown) => !!value && typeof value === "object"
  && (value as Record<string, unknown>).kind === "remedy" && LINK_CHECKS.includes((value as Record<string, unknown>).check as string);
/**
 * The Link check reports measured loopback latency; its name, level and remedy follow the measurement,
 * and setup.health lists its remedy as a repair only while the measurement warns.
 */
export function linkLatencyMasked(text: string) {
  const measured = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter(item => !isLinkRepair(item)).map(measured);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (LINK_CHECKS.includes(record.name as string) && "level" in record) return { name: "Link", level: "<measured>" };
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, measured(child)]));
  };
  return JSON.stringify(measured(JSON.parse(`{${text}}`))).slice(1, -1);
}

/** ADR 0027: only a flag-on serve owns run/host.sock, so only its doctor reports the live socket. */
export const FLAG_ON_DOCTOR_ADDITIONS = ["doctor.run host socket check", "setup.health host socket check"];
export function expectHostSocketReported(runs: Run[]) {
  for (const run of runs) {
    const reported = run.observed["doctor.run host socket check"];
    if (run.mode.nativeHost === "1" && run.mode.transport === "http") expect(reported, run.mode.label).toContain("/.pacer/run/host.sock is live (owner pid <pid>)");
    else if (run.mode.nativeHost === "0") expect(reported, run.mode.label).toBe("");
  }
}

export const PLANNER_STORES = ["install-manifest.json", "onboarding/skipped", "strategy.yaml"];

export const planners: Scenario = async (door, h, observe) => {
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
export function maskTerminalScriptIds(text: string) {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}

export async function connectClaude(door: Door) {
  const preview = await door.call("agent.preview", { agent: "claude-code" });
  return await door.call("agent.connect", { agent: "claude-code", consent: true, preview_revision: preview.json.result?.revision });
}

export const assistant: Scenario = async (door, h, observe) => {
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

export const refusal = (method: string) => `${method} needs credential bindings, which the native process owner bridge does not carry`;
/** PR 4 shapes the native owner bridge refuses by design (CHANGELOG known limits), keyed by observation. */
export const KNOWN_REFUSED: Record<string, string> = {
  "account.models keyless": "endpoint.models",
  "account.models keyed": "endpoint.models",
  "account.test": "endpoint.test",
  "routing.route goal": "classifier.ask",
};

export const endpoints: Scenario = async (door, h, observe) => {
  observe("runner.set", replyText(h, await door.call("runner.set", { id: "opencode#ep", max_tasks: 2 })));
  observe("opencode.json", storeBytes(h, "opencode/opencode.json"));
  const base = readFileSync(join(h.state, "strategy.yaml"), "utf8").match(/base_url: "([^"]+)"/)![1];
  observe("account.models keyless", replyText(h, await door.call("account.models", { name: "ep" })));
  observe("account.models keyed", replyText(h, await door.call("account.models", { base_url: base, key: "sk-matrix-fixture" })));
  observe("account.test", replyText(h, await door.call("account.test", { name: "ep" })));
  observe("routing.route goal", replyText(h, await door.call("routing.route", { goal: "fix the parser" })));
};

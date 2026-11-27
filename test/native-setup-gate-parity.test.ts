import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/install/fsx";
import type { Check, Remedy } from "../src/install/doctor";
import { setupHealthRequired, writeSetupHealthPass } from "../src/install/setup-health-store";
import { checklistReply } from "../src/setup/check";
import type { SetupFacts } from "../src/setup/checklist";
import { writeJsonAtomic } from "../src/fsutil";
import { aggregateSetupHealth, fingerprintFromReport, shouldSkipFullWindow, type SetupHealthTrigger } from "../src/view-model/setup-health";
import { tmpDir } from "./helpers";
import { closedPort, pinnedEnv, spawnPinned } from "./pinned-port";

// The Rust checklist rules, gate and stored files against the TypeScript functions they replace,
// over the parts Core sends across the setup bridges.

const root = join(import.meta.dir, "..");
const NOW = 1_700_000_000.25;
const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
let driver: string | undefined;

function native(home: string, op: string, params: unknown, parts: unknown) {
  if (!driver) {
    const env = pinnedEnv(process.env);
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root, env });
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root, env }).toString());
    driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  const input = JSON.stringify({ op, params, home, now: NOW, bridgeResult: parts });
  return execFileSync(driver, [], { input: `${input}\n`, env: pinnedEnv(process.env) }).toString().trim();
}

type Facts = SetupFacts & { connected: boolean };
const AGENTS = [
  { id: "claude-code", name: "Claude Code", installed: true, cliInstalled: true },
  { id: "codex", name: "Codex", installed: false, cliInstalled: true },
  { id: "cursor", name: "Cursor", installed: false, cliInstalled: false },
  { id: "opencode", name: "OpenCode", installed: true, cliInstalled: false },
];
const READY: Facts = {
  version: "1.2.3", planner: "claude-code", signedIn: true, connected: true,
  service: { installed: true, running: true }, link: true, verdict: "OK", reviewed: true, skipped: false,
  executors: { ranked: [{ id: "codex" }, { id: "cursor#work" }], excluded: [] }, agents: AGENTS, errors: {},
};
const POLICY = { mode: "open", plugins: 2 } as const;

const FACTS: Record<string, Facts> = {
  ready: READY,
  "account planner": { ...READY, planner: "codex#work@local" },
  "signed out with a login command": { ...READY, signedIn: false, loginCommand: "claude auth login" },
  "no strategy": { ...READY, planner: null, connected: false, executors: undefined, verdict: undefined, reviewed: false, errors: { strategy: "strategy missing" } },
  "strategy error keeps the planner": { ...READY, errors: { strategy: "bad yaml" } },
  "service and link failures": { ...READY, service: { installed: false, running: false }, link: false, errors: { service: "launchctl failed", link: "refused" } },
  "connect error": { ...READY, connected: false, errors: { connect: "unsafe integration file" } },
  "integration changed": { ...READY, connected: false },
  "excluded executors": { ...READY, executors: { ranked: [], excluded: [{ id: "codex", reason: "signed out" }, { id: "cursor", reason: "blocked" }] } },
  "no executors": { ...READY, executors: { ranked: [], excluded: [] } },
  "unknown verdict": { ...READY, verdict: "UNKNOWN" },
  "skipped onboarding": { ...READY, reviewed: false, skipped: true },
  "nothing reviewed": { ...READY, reviewed: false },
  "no version": { ...READY, version: null },
};

for (const [name, facts] of Object.entries(FACTS)) {
  test(`setup.check reply matches TypeScript: ${name}`, () => {
    const wire = JSON.parse(JSON.stringify({ ...facts, policy: POLICY }));
    expect(native(tmpDir(), "setup.check", {}, wire)).toBe(JSON.stringify({ result: checklistReply(facts, NOW, POLICY) }));
  }, 120000);
}

const review = (agent: string): Remedy => ({ kind: "review", label: "Review changes", op: "agent.preview", params: { agent } });
const OK: Check[] = [
  { name: "Strategy", level: "ok", detail: "default" },
  { name: "Binary claude-code", level: "ok", detail: "claude installed" },
  { name: "Binary codex", level: "ok", detail: "codex installed" },
  { name: "Usage claude-code", level: "ok", detail: "OK" },
  { name: "Service", level: "ok", detail: "installed: true; running: true; healthy: true; binary matches current: true" },
  { name: "Install claude-code", level: "ok", detail: "installed files intact (configuration only; runtime unverified)", evidence: "configured" },
  { name: "Notifications", level: "ok", detail: "allowed" },
  { name: "Removable volume access", level: "warn", detail: "gone", remedy: { kind: "user", label: "Open settings" } },
];
const without = (name: string) => OK.filter(check => check.name !== name);

const CHECKS: Record<string, Check[]> = {
  clean: OK,
  "service down": [...without("Service"), { name: "Service", level: "warn", detail: "installed: true; running: false; healthy: false; binary matches current: false", fix: "pacer service restart", remedy: { kind: "auto", label: "Restart service", op: "service.install", consent: true } }],
  "missing binary": [...without("Binary codex"), { name: "Binary codex", level: "fail", detail: "codex missing", fix: "install codex or remove providers.codex" }],
  "shared agent repair": [...without("Install claude-code"),
    { name: "Install claude-code", level: "warn", detail: "missing or changed: /tmp/x", remedy: review("claude-code") },
    { name: "Skill claude-code", level: "warn", detail: "/tmp/skill", remedy: { kind: "auto", label: "Update files", op: "agent.connect", params: { agent: "claude-code" }, consent: true } },
    { name: "Claude hook configuration", level: "warn", detail: "SessionStart missing", evidence: "configured", remedy: review("codex") }],
  "usage readings": [...without("Usage claude-code"),
    { name: "Usage claude-code", level: "warn", detail: "stale usage", remedy: { kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "main" } } },
    { name: "Usage codex", level: "warn", detail: "UNKNOWN", remedy: { kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "main" } } }],
  "agent remedies": [...OK,
    { name: "Planner check codex", level: "warn", detail: "TypeError: spawn ENOENT at /opt/someone/bin --flag", remedy: { kind: "agent", label: "Ask an agent", op: "doctor.fix.delegate", params: { check: "Planner check codex" } } },
    { name: "Integration freshness codex", level: "warn", detail: "installed: false; refreshed", remedy: { kind: "internal", label: "Restart pacer", op: "service.install" } },
    { name: "Legacy guard", level: "warn", detail: "legacy subagent_guard.py present" }],
  "notifications off": [...without("Notifications"), { name: "Notifications", level: "warn", detail: "not allowed", remedy: { kind: "user", label: "Allow notifications", url: "x-apple.systempreferences:notifications" } }],
  "no remedy": [...OK, { name: "Orca", level: "warn", detail: "tasks use the direct backend" }],
  "no service check": without("Service"),
  "no binaries": OK.filter(check => !check.name.startsWith("Binary ")),
};

const VERSION = "1.2.3";
const HASHES = { "claude-code": sha256("one"), "codex#work": sha256("two") };

interface Scenario { trigger?: SetupHealthTrigger; facts?: Facts; skipped?: boolean; required?: boolean }

function typescriptGate(dir: string, checks: Check[], s: Scenario, replyDuration: number) {
  const facts = s.facts ?? READY;
  const forced = s.trigger === "update" || !!s.required;
  const trigger = s.trigger === "update" || (forced && s.trigger !== "manual") ? "update" : (s.trigger ?? "startup");
  const previousText = existsSync(join(dir, "setup-health.json")) ? JSON.parse(readFileSync(join(dir, "setup-health.json"), "utf8")) : null;
  const report = aggregateSetupHealth({
    checks: checks.filter(check => !check.name.startsWith("Removable volume ")),
    checklist: checklistReply(facts, NOW, POLICY), trigger, checkedAt: NOW, durationSeconds: replyDuration, notificationsSkipped: !!s.skipped,
  });
  const versions = { appVersion: VERSION, serviceVersion: VERSION, integrationHashes: HASHES };
  const fingerprint = fingerprintFromReport(report, versions);
  writeSetupHealthPass({ pacerHome: dir }, { fingerprint, trigger, outcome: report.outcome, durationSeconds: report.durationSeconds });
  const skipFullWindow = !forced && shouldSkipFullWindow(previousText?.fingerprint ?? null, versions) && report.attentionCount === 0;
  return { ...report, fingerprint, skipFullWindow, planner: "claude-code", repairAvailable: true };
}

function gate(checks: Check[], s: Scenario, homes: { rust: string; ts: string }) {
  const doctor = { checks, planner: "claude-code", repairAvailable: true };
  const parts = JSON.parse(JSON.stringify({ doctor, facts: { ...(s.facts ?? READY), policy: POLICY }, version: VERSION, integrationHashes: HASHES }));
  if (s.required) writeFileSync(join(homes.rust, "setup-health.required"), "1\n");
  const line = native(homes.rust, "setup.health", s.trigger ? { trigger: s.trigger } : {}, parts);
  const reply = JSON.parse(line).result;
  writeJsonAtomic(join(homes.ts, "diagnostics", "doctor-latest.json"), { checkedAt: NOW, ...doctor });
  // The measured run time is the one input the two sides cannot share.
  expect(line).toBe(JSON.stringify({ result: typescriptGate(homes.ts, checks, s, reply.durationSeconds) }));
  for (const file of ["setup-health.json", "diagnostics/doctor-latest.json"]) {
    expect(readFileSync(join(homes.rust, file), "utf8")).toBe(readFileSync(join(homes.ts, file), "utf8"));
  }
  expect(setupHealthRequired({ pacerHome: homes.rust })).toBe(false);
  return reply;
}

const fresh = () => ({ rust: tmpDir(), ts: tmpDir() });

for (const [name, checks] of Object.entries(CHECKS)) {
  test(`setup.health reply and stored files match TypeScript: ${name}`, () => {
    gate(checks, {}, fresh());
    gate(checks, { trigger: "update", skipped: false }, fresh());
    gate(checks, { trigger: "manual", facts: FACTS["no executors"] }, fresh());
    gate(checks, { facts: FACTS["no strategy"] }, fresh());
    gate(checks, { facts: FACTS["service and link failures"] }, fresh());
  }, 120000);
}

test("setup.health honours skipped notifications from settings.json", () => {
  const homes = fresh();
  writeFileSync(join(homes.rust, "settings.json"), JSON.stringify({ setup: { notifications_skipped: true } }));
  const reply = gate(CHECKS["notifications off"]!, { skipped: true }, homes);
  expect(reply.steps[4]).toEqual({ id: "notifications", title: "Turn on notifications", state: "skipped", detail: "Skipped" });
}, 120000);

test("the full window is skipped only after a matching clean pass", () => {
  const homes = fresh();
  expect(gate(OK, {}, homes).skipFullWindow).toBe(false);
  expect(gate(OK, {}, homes).skipFullWindow).toBe(true);
  expect(gate(OK, { trigger: "manual" }, homes).skipFullWindow).toBe(true);
  expect(gate(OK, { trigger: "update" }, homes).skipFullWindow).toBe(false);
}, 120000);

test("a post-update stamp forces the update trigger once and is cleared", () => {
  const homes = fresh();
  gate(OK, {}, homes);
  const forced = gate(OK, { required: true }, homes);
  expect(forced.trigger).toBe("update");
  expect(forced.skipFullWindow).toBe(false);
  const manual = gate(OK, { required: true, trigger: "manual" }, homes);
  expect(manual.trigger).toBe("manual");
  expect(manual.skipFullWindow).toBe(false);
}, 120000);

test("a malformed last pass counts as no pass", () => {
  for (const text of ["{", "[]", JSON.stringify({ schema: 1, trigger: "startup", outcome: "ok", fingerprint: { schema: 1 } })]) {
    const homes = fresh();
    writeFileSync(join(homes.rust, "setup-health.json"), text);
    writeFileSync(join(homes.ts, "setup-health.json"), JSON.stringify({ fingerprint: null }));
    expect(gate(OK, {}, homes).skipFullWindow).toBe(false);
  }
}, 120000);

test("doctor.run stamps and stores the report as TypeScript does", () => {
  for (const doctor of [{ checks: OK, planner: "codex#work", repairAvailable: false }, { checks: without("Strategy") }]) {
    const [rust, ts] = [tmpDir(), tmpDir()];
    const line = native(rust, "doctor.run", {}, { doctor });
    const report = { checkedAt: NOW, ...doctor };
    expect(line).toBe(JSON.stringify({ result: report }));
    writeJsonAtomic(join(ts, "diagnostics", "doctor-latest.json"), report);
    expect(readFileSync(join(rust, "diagnostics/doctor-latest.json"), "utf8")).toBe(readFileSync(join(ts, "diagnostics/doctor-latest.json"), "utf8"));
  }
}, 120000);

test("a gate input Core cannot produce reports its error after storing the doctor report", () => {
  const dir = tmpDir();
  const failure = { code: "invalid_input", message: "unsafe integration file: manifest", hint: "Repair the install" };
  const reply = JSON.parse(native(dir, "setup.health", {}, { doctor: { checks: OK }, failure }));
  expect(reply.error.code).toBe("invalid_input");
  expect(reply.error.hint).toBe(failure.hint);
  expect(reply.error.message).toBe(failure.message);
  expect(existsSync(join(dir, "diagnostics/doctor-latest.json"))).toBe(true);
  expect(existsSync(join(dir, "setup-health.json"))).toBe(false);
}, 120000);

test("a last-pass path that is not a regular file refuses the gate's write", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "setup-health.json"));
  const reply = JSON.parse(native(dir, "setup.health", {}, { doctor: { checks: OK }, facts: { ...READY, policy: POLICY }, version: VERSION, integrationHashes: HASHES }));
  expect(reply.error.message).toBe(`unsafe integration file: ${join(dir, "setup-health.json")}`);
}, 120000);

// Door parity on the same `--seed ui` home: the native front door gathers the
// facts Rust uses, forced forwarding asks the TypeScript core for them.
const SEEDED_OPS = "setup.check,setup.health";
let frontBinary = front;
const CORE_ARGV = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

function seededDoorEnv(dir: string, forward: boolean) {
  const home = join(dir, "home");
  return pinnedEnv({
    HOME: home, PACER_HOME: home, PATH: `${home}/bin:/usr/bin:/bin`,
    PACER_CORE_ARGV: CORE_ARGV, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", LANG: "C",
    ...(forward ? { PACER_FORWARD_OPS: SEEDED_OPS } : {}),
  });
}

const normalizeDoor = (value: unknown, dir: string) => JSON.parse(
  JSON.stringify(value).replaceAll(dir, "$HOME")
    .replace(/"checkedAt":\d+(\.\d+)?/g, '"checkedAt":"<now>"')
    .replace(/"durationSeconds":\d+(\.\d+)?(e-?\d+)?/g, '"durationSeconds":"<elapsed>"')
    // Each side seeds its own home, so `installedAt` can differ by a second.
    .replace(/"[0-9a-f]{64}"/g, '"<hash>"'),
);

async function seededStdio(forward: boolean) {
  const { seedUi } = await import("../scripts/live/seed");
  const dir = mkdtempSync(join(tmpdir(), "m3-b64-stdio-"));
  try {
    seedUi(dir);
    const child = spawnPinned([frontBinary!, "api", "--stdio"], {
      cwd: join(dir, "home"), env: seededDoorEnv(dir, forward), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
      { jsonrpc: "2.0", id: 2, method: "setup.check", params: {} },
      { jsonrpc: "2.0", id: 3, method: "setup.health", params: { trigger: "manual" } },
    ];
    try {
      await child.stdin.write(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
      await child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
      return normalizeDoor(stdout.trim().split("\n").slice(1).map(line => JSON.parse(line)), dir);
    } finally {
      if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seededHttp(forward: boolean) {
  const { seedUi } = await import("../scripts/live/seed");
  const dir = mkdtempSync(join(tmpdir(), "m3-b64-http-"));
  try {
    seedUi(dir);
    const port = closedPort();
    const child = spawnPinned([frontBinary!, "serve", "--port", String(port)], {
      cwd: join(dir, "home"), env: seededDoorEnv(dir, forward), stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    let token = "", ready = false;
    for (let n = 0; n < 1000 && !ready; n++) {
      try {
        token = readFileSync(join(dir, "home", "token"), "utf8").trim();
        ready = (await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
      } catch { /* not ready */ }
      if (!ready) await Bun.sleep(20);
    }
    try {
      expect(ready).toBe(true);
      const bodies = [];
      for (const op of ["setup.check", "setup.health"]) {
        const response = await fetch(`${base}/v3/ops/${op}`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(op === "setup.check" ? {} : { trigger: "manual" }), signal: AbortSignal.timeout(30000),
        });
        bodies.push(await response.json());
      }
      return normalizeDoor(bodies, dir);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(!front)("seeded setup facts match forced forwarding over stdio and HTTP", async () => {
  if (!frontBinary) {
    const env = pinnedEnv(process.env);
    execFileSync("cargo", ["build", "-q", "-p", "pacer", "--features", "test-ops", "--locked"], { cwd: root, env });
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root, env }).toString());
    frontBinary = join(metadata.target_directory, "debug/pacer");
  }
  for (const door of [seededStdio, seededHttp]) {
    expect(await door(false)).toEqual(await door(true));
  }
}, 300000);

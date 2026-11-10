import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import { setupDoctorBridge } from "../src/api/setup-doctor-bridge";
import { createSession } from "../src/serve/app-auth";
import type { Ctx } from "../src/types";
import { keychainStubPath } from "./keychain-stub";
import { fakeCtx, tmpDir } from "./helpers";

// Native setup.health and doctor.run against the same requests forced through
// PACER_FORWARD_OPS to the TypeScript core, over the real stdio and HTTP front doors.

const root = join(import.meta.dir, "..");
const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "setup.health,doctor.run";
const STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\n  codex: {}\nrouting:\n  - default: [codex]\n";
let driver: string | undefined;

function nativeResult(home: string, op: string, params: unknown, bridge: { echo: true } | { result: unknown }) {
  if (!driver) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
    const metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
    );
    driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  const input = { op, params, home, now: 1_700_000_000, ...("echo" in bridge ? { bridgeEcho: true } : { bridgeResult: bridge.result }) };
  return JSON.parse(execFileSync(driver, [], { input: `${JSON.stringify(input)}\n` }).toString());
}

function bin(dir: string, name: string, script: string) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
}

/** A disposable home whose service manager stubs never reach the login session's launchd or systemd. */
function home(strategy = STRATEGY): string {
  const dir = tmpDir();
  mkdirSync(join(dir, ".pacer"), { recursive: true });
  writeFileSync(join(dir, ".pacer", "strategy.yaml"), strategy);
  for (const name of ["claude", "codex"]) bin(dir, name, "exit 1");
  bin(dir, "launchctl", `echo 'Could not find service' >&2\nexit 113`);
  bin(dir, "systemctl", `echo 'Unit pacer-serve.service could not be found.' >&2\nexit 4`);
  return dir;
}

async function freePort() {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  return port;
}

async function env(dir: string, forward: boolean, extra: Record<string, string> = {}) {
  return {
    HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: keychainStubPath(dir, `${join(dir, "bin")}:/usr/bin:/bin`),
    PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", PACER_PORT: String(await freePort()), LANG: "C", ...extra,
    ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
  };
}

const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

async function exchange(dir: string, cases: [string, unknown][], forward: boolean, extra: Record<string, string> = {}) {
  const requests = cases.map(([op, params], i) => request(i + 2, op, params));
  const child = Bun.spawn([front!, "api", "--stdio"], { cwd: dir, env: await env(dir, forward, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([request(1, "hello", { protocol: 3 }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].result?.protocol).toBe("3.0.0");
    const markers = stderr.split("\n").filter(line => /^native (setup\.health|doctor\.run) \d+$/.test(line));
    return { replies: lines.slice(1).sort((a, b) => a.id - b.id), markers };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

/**
 * Replies with this home, wall-clock times, the gate's run time and the measured link
 * latency (whose level is its own threshold) replaced; everything else compares exactly.
 */
function normalize(value: unknown, dir: string) {
  return JSON.parse(JSON.stringify(value).replaceAll(dir, "$HOME")
    .replace(/"checkedAt":\d+(\.\d+)?/g, '"checkedAt":"<now>"')
    .replace(/"durationSeconds":\d+(\.\d+)?(e-?\d+)?/g, '"durationSeconds":"<elapsed>"'), (_key, item) =>
    item && typeof item === "object" && item.name === "Link latency" && /^\/v2\/snapshot max [\d.]+ ms /.test(item.detail)
      ? { ...item, level: "<measured>", detail: item.detail.replace(/max [\d.]+ ms/, "max <ms> ms") } : item);
}

const stored = (dir: string) => normalize(JSON.parse(readFileSync(join(dir, ".pacer", "setup-health.json"), "utf8")), dir);

const ERRORS: [string, unknown][] = [
  ["setup.health", { trigger: "nope" }], ["setup.health", { trigger: null }], ["setup.health", "s"], ["setup.health", []],
  ["doctor.run", 5], ["doctor.run", "s"], ["doctor.run", []],
];

test("native setup.health and doctor.run reject invalid params like TypeScript", async () => {
  const dir = home();
  const ctx = fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), now: 1_700_000_000, which: () => null });
  for (const [op, params] of ERRORS) {
    let want: unknown;
    try { want = { result: await callOp(ctx, op, params) }; } catch (error) { want = { error: toApiError(error) }; }
    expect(want).toHaveProperty("error");
    expect(nativeResult(dir, op, params, { result: "unused" })).toEqual(want);
  }
}, 120000);

test("native requests carry the parsed params to Core", () => {
  for (const [params, parsed] of [[{}, {}], [null, {}], [{ trigger: "update", extra: 1 }, { trigger: "update" }], [{ trigger: "manual" }, { trigger: "manual" }]] as const) {
    expect(nativeResult(tmpDir(), "setup.health", params, { echo: true }).result).toEqual({ op: "setup.health", params: parsed });
  }
  for (const params of [{}, null, { extra: true }]) {
    expect(nativeResult(tmpDir(), "doctor.run", params, { echo: true }).result).toEqual({ op: "doctor.run", params: {} });
  }
}, 120000);

test("setup doctor bridge refuses other operations", async () => {
  const ctx = fakeCtx({ which: () => null });
  for (const body of [null, [], {}, { op: "setup.check" }, { op: "service.install", params: { consent: true } }]) {
    await expect(setupDoctorBridge(ctx, body)).rejects.toMatchObject({ code: "invalid_input" });
  }
});

test.skipIf(!front)("stdio doctor and health reports, errors and refusals match forced forwarding", async () => {
  const homes = [home(), home()];
  const runs: { replies: unknown[]; markers: string[] }[][] = [[], []];
  // Each gate run reads the previous run's fingerprint, so the runs go one exchange at a time.
  const steps: [string, unknown][][] = [
    [["doctor.run", {}], ["doctor.run", { extra: 1 }], ["doctor.run", null], ...ERRORS],
    [["setup.health", { trigger: "startup" }]], [["setup.health", {}]], [["setup.health", { trigger: "update", x: 1 }]], [["setup.health", null]],
  ];
  for (const [i, forward] of [false, true].entries()) {
    for (const cases of steps) runs[i]!.push(await exchange(homes[i]!, cases, forward));
    runs[i]!.push(await exchange(homes[i]!, [["doctor.run", {}], ["setup.health", {}]], forward, { PACER_ENFORCEMENT_TOKEN: "pet_x" }));
  }
  const [native, forwarded] = runs.map((list, i) => list.map(run => normalize(run.replies, homes[i]!)));
  expect(native).toEqual(forwarded);
  expect(stored(homes[0]!)).toEqual(stored(homes[1]!));
  expect(runs[1]!.flatMap(run => run.markers)).toEqual([]);
  expect(runs[0]!.slice(0, 5).map(run => run.markers)).toEqual([
    ["native doctor.run 2", "native doctor.run 3", "native doctor.run 4"],
    ["native setup.health 2"], ["native setup.health 2"], ["native setup.health 2"], ["native setup.health 2"],
  ]);
  const replies = forwarded as { result?: { checks?: unknown[]; steps?: unknown[] }; error?: { data?: { code?: string } } }[][];
  expect(replies[0]![0]!.result!.checks!.length).toBeGreaterThan(5);
  expect(replies[0]!.slice(3).map(reply => reply.error?.data?.code)).toEqual(ERRORS.map(() => "invalid_input"));
  expect(replies[1]![0]!.result!.steps!.length).toBe(5);
  expect(replies[5]!.map(reply => reply.error?.data?.code)).toEqual(["not_allowed", "not_allowed"]);
}, 180000);

async function serve(dir: string, forward: boolean) {
  const port = await freePort();
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: await env(dir, forward) });
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
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) as unknown }; } catch { return { status: response.status, body: text }; }
    },
    bearer: { Authorization: `Bearer ${token}` },
    app: (cookie: string) => ({ Cookie: `pacer_session=${cookie}`, Origin: base, "X-Pacer-Client": "app" }),
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native (setup\.health|doctor\.run)$/.test(line)); },
  };
}

test.skipIf(!front)("HTTP doctor and health reports, errors and refusals match forced forwarding", async () => {
  const results: { bodies: unknown[]; markers: string[]; stored: unknown }[] = [];
  for (const forward of [false, true]) {
    // Serve's startup usage refresh races the first Codex usage read, so this home has no Codex provider.
    const dir = home("planner: claude-code\nproviders:\n  claude-code: {usage: quota}\nrouting:\n  - default: [claude-code]\n");
    const cookie = createSession(fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), now: Date.now() / 1000 }));
    const server = await serve(dir, forward);
    const bodies = [
      await server.post("doctor.run", {}, server.bearer),
      await server.post("doctor.run", { extra: 1 }, server.app(cookie)),
      await server.post("setup.health", { trigger: "startup" }, server.app(cookie)),
      await server.post("setup.health", {}, server.bearer),
      await server.post("setup.health", { trigger: "nope" }, server.bearer),
      await server.post("doctor.run", 5, server.bearer),
      await server.post("doctor.run", {}, {}),
      await server.post("setup.health", {}, { Authorization: "Bearer wrong" }),
    ];
    results.push({ bodies: normalize(bodies, dir), markers: await server.stop(), stored: stored(dir) });
  }
  expect(results[0]!.bodies).toEqual(results[1]!.bodies);
  expect(results[0]!.stored).toEqual(results[1]!.stored);
  expect(results[1]!.markers).toEqual([]);
  expect(results[0]!.markers).toEqual(["doctor.run", "doctor.run", "setup.health", "setup.health"].map(op => `native ${op}`));
  const bodies = results[1]!.bodies as { status: number; body: { result?: { checks?: unknown[]; steps?: unknown[] } } }[];
  expect(bodies.slice(0, 4).map(b => b.status)).toEqual([200, 200, 200, 200]);
  expect(bodies[0]!.body.result!.checks!.length).toBeGreaterThan(5);
  expect(bodies[2]!.body.result!.steps!.length).toBe(5);
  expect(bodies.slice(4, 6).map(b => b.status)).toEqual([400, 400]);
  expect(bodies.slice(6).map(b => b.status)).toEqual([401, 401]);
}, 180000);

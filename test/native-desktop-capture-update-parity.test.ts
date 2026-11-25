import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import { captureBridge } from "../src/api/desktop-capture-bridge";
import { createSession } from "../src/serve/app-auth";
import type { Ctx } from "../src/types";
import { keychainStubPath } from "./keychain-stub";
import { fakeCtx, tmpDir } from "./helpers";
import { closedPort, pinnedEnv, spawnPinned } from "./pinned-port";

// Native desktop.capture.* and desktop.update.* against the same requests forced
// through PACER_FORWARD_OPS to the TypeScript core, over the real stdio and
// HTTP front doors. Capture is a Bridge-op family (like setup-doctor): Rust
// validates each param set, then the sealed bridge runs the real handler for
// the reply. Desktop update is fully native (DX1): the Rust runtime answers
// all eight ops with the TypeScript `unavailable` error when no connected
// desktop is registered, so native and forwarded doors match byte-for-byte.

const root = join(import.meta.dir, "..");
const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = [
  "desktop.capture.register", "desktop.capture.targets", "desktop.capture.request",
  "desktop.capture.claim", "desktop.capture.complete", "desktop.capture.result",
].join(",");
const STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\n  codex: {}\nrouting:\n  - default: [codex]\n";
let driver: string | undefined;

function nativeResult(home: string, op: string, params: unknown, bridge: { echo: true } | { result: unknown }) {
  if (!driver) {
    const env = pinnedEnv(process.env);
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root, env });
    const metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root, env }).toString(),
    );
    driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  const input = { op, params, home, now: 1_700_000_000, ...("echo" in bridge ? { bridgeEcho: true } : { bridgeResult: bridge.result }) };
  return JSON.parse(execFileSync(driver, [], { input: `${JSON.stringify(input)}\n`, env: pinnedEnv(process.env) }).toString());
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

/** The child environment; PACER_PORT is the test's own server port, or a closed one for stdio. */
function env(dir: string, forward: boolean, extra: Record<string, string> = {}, port = closedPort()) {
  return pinnedEnv({
    HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: keychainStubPath(dir, `${join(dir, "bin")}:/usr/bin:/bin`),
    PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", LANG: "C", ...extra,
    ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
  }, port);
}

const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

async function exchange(dir: string, cases: [string, unknown][], forward: boolean, extra: Record<string, string> = {}) {
  const requests = cases.map(([op, params], i) => request(i + 2, op, params));
  const child = spawnPinned([front!, "api", "--stdio"], { cwd: dir, env: env(dir, forward, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([request(1, "hello", { protocol: 3 }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].result?.protocol).toBe("3.0.0");
    const markers = stderr.split("\n").filter(line => /^native desktop\.(capture|update)\.\S+ \d+$/.test(line));
    return { replies: lines.slice(1).sort((a, b) => a.id - b.id), markers };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

const ERRORS: [string, unknown][] = [
  ["desktop.capture.register", { client_id: "", worker_token: "short" }],
  ["desktop.capture.register", { client_id: 5, worker_token: "a".repeat(64), extra: 1 }],
  ["desktop.capture.register", null],
  ["desktop.capture.targets", 5], ["desktop.capture.targets", "s"], ["desktop.capture.targets", []],
  ["desktop.capture.request", { client_id: "c", window: "other" }],
  ["desktop.capture.request", { client_id: "c", window: "main", mode: 5 }],
  ["desktop.capture.request", "s"],
  ["desktop.capture.request", null],
  ["desktop.capture.claim", { client_id: "c" }],
  ["desktop.capture.claim", { client_id: "c", worker_token: "z".repeat(64), windows: "x" }],
  // Zod 4.6.5 reports per-element issues AND the array `max(2)` size error
  // for an over-length array holding invalid elements. Rust mirrors both.
  ["desktop.capture.claim", { client_id: "c", worker_token: "a".repeat(64), windows: [
    { label: "main", window_id: "1", pid: 1 }, { label: "t", window_id: "2", pid: 3 },
    { label: "main", window_id: "3", pid: 4 },
  ] }],
  ["desktop.capture.complete", { request_id: "r", worker_token: "z", error: "nope" }],
  ["desktop.capture.result", {}],
];

test("native desktop capture and update ops reject invalid params like TypeScript", async () => {
  const dir = home();
  const ctx = fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), now: 1_700_000_000, which: () => null });
  for (const [op, params] of ERRORS) {
    let want: unknown;
    try { want = { result: await callOp(ctx, op, params) }; } catch (error) { want = { error: toApiError(error) }; }
    expect(want).toHaveProperty("error");
    expect(nativeResult(dir, op, params, { result: "unused" })).toEqual(want);
  }
}, 120000);

test("native requests carry the validated params to Core", () => {
  const dir = home();
  expect(nativeResult(dir, "desktop.capture.targets", {}, { echo: true }).result)
    .toEqual({ op: "desktop.capture.targets", params: {} });
  expect(nativeResult(dir, "desktop.capture.targets", null, { echo: true }).result)
    .toEqual({ op: "desktop.capture.targets", params: {} });
  expect(nativeResult(dir, "desktop.capture.targets", { x: 1 }, { echo: true }).result)
    .toEqual({ op: "desktop.capture.targets", params: {} });
  expect(nativeResult(dir, "desktop.capture.request", { client_id: "c", window: "main", window_id: "12" }, { echo: true }).result)
    .toEqual({ op: "desktop.capture.request", params: { client_id: "c", window: "main", mode: "window", window_id: "12" } });
  expect(nativeResult(dir, "desktop.capture.register", { client_id: "c", worker_token: "a".repeat(64), extra: 1 }, { echo: true }).result)
    .toEqual({ op: "desktop.capture.register", params: { client_id: "c", worker_token: "a".repeat(64) } });
});

test("desktop capture bridge refuses other operations; update is no longer a bridge", async () => {
  const ctx = fakeCtx({ which: () => null });
  for (const body of [null, [], {}, { op: "desktop.capture.nope" }, { op: "desktop.update.nope" }, { op: "setup.health" }, { op: "service.install", params: { consent: true } }]) {
    await expect(captureBridge(ctx, body)).rejects.toMatchObject({ code: "invalid_input" });
  }
});

test.skipIf(!front)("stdio desktop capture and update errors match forced forwarding", async () => {
  const homes = [home(), home()];
  const runs: { replies: unknown[]; markers: string[] }[][] = [[], []];
  const steps: [string, unknown][][] = [
    ERRORS,
    [["desktop.capture.targets", {}]],
    [["desktop.capture.targets", { x: 1 }]],
  ];
  for (const [i, forward] of [false, true].entries()) {
    for (const cases of steps) runs[i]!.push(await exchange(homes[i]!, cases, forward));
    runs[i]!.push(await exchange(homes[i]!, [["desktop.capture.targets", {}], ["desktop.capture.targets", { x: 1 }]], forward));
  }
  const [native, forwarded] = runs.map((list) => list.map(run => run.replies));
  expect(native).toEqual(forwarded);
  // The forwarded door runs every op through Core, so it carries no native
  // markers. Update is now fully native (DX1): `call_native_op` emits the
  // trace before parameter validation, so every dispatched update request —
  // valid or invalid — carries a marker. Capture is a bridge family: invalid
  // params are rejected before the trace, so only the valid (non-error)
  // capture requests carry a capture marker.
  expect(runs[1]!.flatMap(run => run.markers)).toEqual([]);
  expect(runs[0]![0]!.markers).toEqual([]);
  expect(runs[0]!.slice(1).map(run => run.markers)).toEqual([
    ["native desktop.capture.targets 2"],
    ["native desktop.capture.targets 2"],
    ["native desktop.capture.targets 2", "native desktop.capture.targets 3"],
  ]);
  const replies = forwarded as { result?: unknown; error?: { data?: { code?: string } } }[][];
  expect(replies[0]!.map(reply => reply.error?.data?.code)).toEqual(ERRORS.map(() => "invalid_input"));
  expect(replies[1]![0]!.result).toEqual([]);
  expect(replies[2]![0]!.result).toEqual([]);
}, 180000);

async function serve(dir: string, forward: boolean) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", String(port)], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: env(dir, forward, {}, port) });
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
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native desktop\.(capture|update)\.\S+$/.test(line)); },
  };
}

test.skipIf(!front)("HTTP desktop capture and update errors match forced forwarding", async () => {
  const results: { bodies: unknown[]; markers: string[] }[] = [];
  for (const forward of [false, true]) {
    // Serve's startup usage refresh races the first Codex usage read, so this home has no Codex provider.
    const dir = home("planner: claude-code\nproviders:\n  claude-code: {usage: quota}\nrouting:\n  - default: [claude-code]\n");
    const cookie = createSession(fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), now: Date.now() / 1000 }));
    const server = await serve(dir, forward);
    const bodies = [
      await server.post("desktop.capture.targets", {}, server.bearer),
      await server.post("desktop.capture.targets", { x: 1 }, server.app(cookie)),
      ...ERRORS.map(async ([op, params]) => await server.post(op, params, server.bearer)),
    ];
    results.push({ bodies: await Promise.all(bodies), markers: await server.stop() });
  }
  expect(results[0]!.bodies).toEqual(results[1]!.bodies);
  // The forwarded door runs every op through Core, so it carries no native
  // markers. Update is now fully native (DX1): `call_native_op` traces
  // before parameter validation, so every update row in ERRORS carries a
  // marker; capture is a bridge family, so only the two valid
  // desktop.capture.targets requests do. HTTP settle order is parallel, so
  // compare sorted marker sets.
  const sorted = (markers: string[]) => [...markers].sort();
  expect(sorted(results[1]!.markers)).toEqual([]);
  expect(sorted(results[0]!.markers)).toEqual(sorted([
    "native desktop.capture.targets", "native desktop.capture.targets",
  ]));
  const bodies = results[1]!.bodies as { status: number; body: { result?: unknown; error?: { code?: string } } }[];
  expect(bodies.slice(0, 2).map(b => b.status)).toEqual([200, 200]);
  expect(bodies.slice(0, 2).map(b => b.body.result)).toEqual([[], []]);
  expect(bodies.slice(2).map(b => b.status)).toEqual(ERRORS.map(() => 400));
  expect(bodies.slice(2).map(b => b.body.error?.code)).toEqual(ERRORS.map(() => "invalid_input"));
}, 180000);
